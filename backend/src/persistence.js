// Persistence layer — Firebase Realtime Database (RTDB).
//
// Optional and credential-gated: it only activates when Application Default
// Credentials are present (Firebase Functions / Cloud Run, or a local service
// account via GOOGLE_APPLICATION_CREDENTIALS). Without credentials it stays
// disabled, so the offline prototype and the test suite run unchanged with the
// in-memory store.
//
// The whole store is snapshotted to a single `/3jnos` node. This is the
// simplest durable persistence for the current synchronous store; a production
// build would move hot records to per-document Firestore writes (see
// docs/AI-OS-ARCHITECTURE.md §9–10).

import admin from 'firebase-admin';

export const DEFAULT_DB_URL =
  'https://studio-1885689950-9b056-default-rtdb.europe-west1.firebasedatabase.app/';

let ref = null;
let enabled = false;
let saveTimer = null;

function hasCredentials() {
  return !!(
    process.env.FIREBASE_SERVICE_ACCOUNT ||          // explicit key (Vercel/any host)
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.K_SERVICE ||          // Cloud Run
    process.env.FUNCTION_TARGET ||    // Firebase Functions
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT
  );
}

export function initPersistence({ databaseURL } = {}) {
  const url = databaseURL || process.env.FIREBASE_DATABASE_URL || DEFAULT_DB_URL;
  if (!hasCredentials()) return { enabled: false, reason: 'no-credentials' };
  try {
    if (!admin.apps.length) {
      // On GCP, ADC is automatic. Elsewhere (e.g. Vercel), pass a service
      // account JSON via FIREBASE_SERVICE_ACCOUNT (a secret env var).
      const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
      const opts = { databaseURL: url };
      if (sa) opts.credential = admin.credential.cert(JSON.parse(sa));
      admin.initializeApp(opts);
    }
    ref = admin.database().ref('3jnos');
    enabled = true;
    return { enabled: true, url };
  } catch (err) {
    console.warn('[persist] init failed, staying in-memory:', err?.message || err);
    return { enabled: false, reason: String(err?.message || err) };
  }
}

export function isEnabled() { return enabled; }

export async function load() {
  if (!enabled) return null;
  try {
    const snap = await ref.get();
    return snap.exists() ? snap.val() : null;
  } catch (err) {
    console.warn('[persist] load failed:', err?.message || err);
    return null;
  }
}

export async function save(data) {
  if (!enabled) return false;
  try {
    // JSON round-trip strips `undefined` (RTDB rejects it) and Map artefacts.
    await ref.set(JSON.parse(JSON.stringify(data)));
    return true;
  } catch (err) {
    console.warn('[persist] save failed:', err?.message || err);
    return false;
  }
}

// Debounced write-through: schedule a save shortly after a mutation so bursts
// of requests collapse into one write.
export function scheduleSave(getData, ms = 2000) {
  if (!enabled || saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await save(getData());
  }, ms);
}
