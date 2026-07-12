// Persistence layer — durable shared store for serverless hosts.
//
// On a serverless host (Vercel / Cloud Run / Firebase Functions) every request
// may hit a DIFFERENT instance, each with its own in-memory store. Without an
// external database those instances can't see each other's data — accounts,
// quotes and bookings "vanish", the admin sees no users, and quotes aren't found
// at checkout. This module is that external database, and it now supports TWO
// backends so at least one is easy to enable on any host:
//
//   1. Vercel KV / Upstash Redis (REST) — the EASIEST: add the Vercel KV (or
//      Upstash) integration in one click and it injects KV_REST_API_URL +
//      KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/TOKEN). No service-account
//      JSON. Storage only (Firebase is still used for sign-in tokens if present).
//   2. Firebase Realtime Database — set FIREBASE_SERVICE_ACCOUNT (+ optional
//      FIREBASE_DATABASE_URL). Also enables server-side Firebase sign-in
//      verification for the owner-admin login.
//
// Whichever is configured is used automatically (Firebase preferred when both
// are present, because it also does auth). With neither configured the store
// stays in-memory (fine for local dev / tests; NOT safe for multi-instance
// production — the app surfaces that loudly).

import admin from 'firebase-admin';

export const DEFAULT_DB_URL =
  'https://studio-1885689950-9b056-default-rtdb.europe-west1.firebasedatabase.app/';

const STORE_KEY = '3jnos';

let backend = null;      // 'firebase' | 'kv' | null
let ref = null;          // firebase ref when backend === 'firebase'
let saveTimer = null;
let lastInitError = null; // last Firebase init error (for diagnostics)

// ---- Vercel KV / Upstash Redis (REST) -------------------------------------
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
function kvConfigured() { return !!(KV_URL && KV_TOKEN && typeof fetch === 'function'); }
// Run a single Redis command via the Upstash REST protocol: POST the command as
// a JSON array, get back { result }. Used for GET/SET of the whole store JSON.
async function kvCommand(cmd) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`kv ${r.status}`);
  const d = await r.json();
  if (d && d.error) throw new Error(String(d.error));
  return d ? d.result : null;
}

// ---- Firebase credential detection ----------------------------------------
function hasFirebaseCredentials() {
  return !!(
    process.env.FIREBASE_SERVICE_ACCOUNT ||          // explicit key (Vercel/any host)
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.K_SERVICE ||          // Cloud Run
    process.env.FUNCTION_TARGET ||    // Firebase Functions
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT
  );
}

// Always try to initialise firebase-admin when credentials exist — even if KV is
// the storage backend — so server-side Firebase SIGN-IN verification works.
function tryInitFirebaseApp(url) {
  if (admin.apps.length) return true;
  if (!hasFirebaseCredentials()) return false;
  try {
    const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
    const opts = { databaseURL: url };
    if (sa) {
      const parsed = typeof sa === 'string' ? JSON.parse(sa) : sa;
      // COMMON VERCEL PITFALL: the private_key's newlines arrive as the literal
      // two characters backslash-n instead of real line breaks, which makes the
      // JWT signing fail and every DB/auth call error out. Normalise them so a
      // correctly-pasted-but-escaped key still works.
      if (parsed && typeof parsed.private_key === 'string') {
        parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      }
      opts.credential = admin.credential.cert(parsed);
    }
    admin.initializeApp(opts);
    return true;
  } catch (err) {
    // Loud: credentials are set but invalid — this is the usual reason "nothing
    // persists" even though the env vars exist.
    console.error('[persist] FIREBASE INIT FAILED (check FIREBASE_SERVICE_ACCOUNT is valid JSON):', err?.message || err);
    lastInitError = String(err?.message || err);
    return false;
  }
}

export function initPersistence({ databaseURL } = {}) {
  const url = databaseURL || process.env.FIREBASE_DATABASE_URL || DEFAULT_DB_URL;
  const firebaseReady = tryInitFirebaseApp(url);
  // Prefer Firebase for STORAGE when its credentials are present (it also does
  // auth); otherwise use KV/Upstash if configured.
  if (firebaseReady) {
    try {
      ref = admin.database().ref(STORE_KEY);
      backend = 'firebase';
      console.log('[persist] backend: Firebase RTDB');
      return { enabled: true, backend, url };
    } catch (err) {
      console.warn('[persist] firebase RTDB unavailable, trying KV:', err?.message || err);
    }
  }
  if (kvConfigured()) {
    backend = 'kv';
    console.log('[persist] backend: Vercel KV / Upstash Redis');
    return { enabled: true, backend };
  }
  backend = null;
  return { enabled: false, reason: 'no-store-configured' };
}

export function isEnabled() { return backend !== null; }
export function persistenceBackend() { return backend; }
export function persistenceInitError() { return lastInitError; }

// LIVE round-trip test: write a value and read it back through the real backend,
// returning the ACTUAL error if it fails. Turns "nothing persists" into a
// precise reason (bad credentials, wrong DB URL, permission denied, unreachable).
export async function persistenceSelfTest() {
  if (!backend) {
    return { ok: false, backend: null, reason: lastInitError || 'no-store-configured',
      hint: 'Set the Vercel KV / Upstash integration (KV_REST_API_URL + KV_REST_API_TOKEN) OR a valid FIREBASE_SERVICE_ACCOUNT + FIREBASE_DATABASE_URL.' };
  }
  const token = `t${Date.now()}`;
  try {
    if (backend === 'firebase') {
      const probe = ref.child('__healthcheck');
      await probe.set({ token, at: new Date().toISOString() });
      const got = await probe.get();
      const back = got.exists() ? got.val() : null;
      return { ok: back?.token === token, backend, roundTrip: back?.token === token };
    }
    // kv
    await kvCommand(['SET', '3jnos:__healthcheck', token]);
    const back = await kvCommand(['GET', '3jnos:__healthcheck']);
    return { ok: back === token, backend, roundTrip: back === token };
  } catch (err) {
    return { ok: false, backend, error: String(err?.message || err),
      hint: backend === 'firebase'
        ? 'Firebase is initialised but the database write failed — check FIREBASE_DATABASE_URL points to the right RTDB (correct region) and RTDB rules allow the service account.'
        : 'KV/Upstash write failed — check KV_REST_API_URL/TOKEN are current.' };
  }
}

// Can the server VERIFY a Firebase sign-in token? True once firebase-admin has
// initialised (FIREBASE_SERVICE_ACCOUNT valid). Admin login via Firebase needs
// this; the prototype PIN login does not.
export function firebaseAdminReady() { return admin.apps.length > 0; }

export async function verifyFirebaseIdToken(idToken) {
  if (!idToken || !admin.apps.length) return null;
  try { return await admin.auth().verifyIdToken(String(idToken)); }
  catch { return null; }
}

export async function load() {
  if (!backend) return null;
  try {
    if (backend === 'firebase') {
      const snap = await ref.get();
      return snap.exists() ? snap.val() : null;
    }
    // kv
    const v = await kvCommand(['GET', STORE_KEY]);
    return v ? JSON.parse(v) : null;
  } catch (err) {
    console.warn('[persist] load failed:', err?.message || err);
    return null;
  }
}

export async function save(data) {
  if (!backend) return false;
  try {
    // JSON round-trip strips `undefined` (stores reject it) and Map artefacts.
    const clean = JSON.parse(JSON.stringify(data));
    if (backend === 'firebase') { await ref.set(clean); return true; }
    await kvCommand(['SET', STORE_KEY, JSON.stringify(clean)]);
    return true;
  } catch (err) {
    console.warn('[persist] save failed:', err?.message || err);
    return false;
  }
}

// MERGING write: never deletes records it doesn't include, so two serverless
// instances writing concurrently merge their accounts/bookings instead of
// clobbering each other. `flat` comes from store.flatSnapshot():
// { 'users/<id>': {...}, audit: [...], counter: N, … }.
//  - Firebase: ref.update() merges path-keyed leaves natively.
//  - KV: load the latest whole store, apply the leaves, write it back (a tight
//    read-modify-write; the request middleware already hydrated first).
export async function saveMerge(flat) {
  if (!backend) return false;
  try {
    const clean = JSON.parse(JSON.stringify(flat));
    if (backend === 'firebase') { await ref.update(clean); return true; }
    // kv merge
    const cur = (await load()) || {};
    for (const [k, v] of Object.entries(clean)) {
      const slash = k.indexOf('/');
      if (slash > 0) {
        const coll = k.slice(0, slash);
        const id = k.slice(slash + 1);
        if (!cur[coll] || typeof cur[coll] !== 'object' || Array.isArray(cur[coll])) cur[coll] = {};
        cur[coll][id] = v;
      } else {
        cur[k] = v; // arrays + counter are written whole
      }
    }
    await kvCommand(['SET', STORE_KEY, JSON.stringify(cur)]);
    return true;
  } catch (err) {
    console.warn('[persist] merge-save failed:', err?.message || err);
    return false;
  }
}

// Debounced write-through: schedule a save shortly after a mutation so bursts
// of requests collapse into one write (long-lived hosts only).
export function scheduleSave(getData, ms = 2000) {
  if (!backend || saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await save(getData());
  }, ms);
}
