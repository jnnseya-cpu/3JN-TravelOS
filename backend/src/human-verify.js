// Human verification — blocks non-human (bot/script) signup and login.
//
// Design constraints: must survive serverless (no instance state required for
// the challenge itself → stateless HMAC token), zero external services (no
// third-party CAPTCHA keys), and deterministic testability.
//
// Layers (all must pass):
//   1. Honeypot        — hidden "website" field; humans never fill it, bots do.
//   2. Timing          — forms submitted faster than a human can type are bots.
//   3. Challenge       — server-issued arithmetic question, HMAC-signed and
//                        time-boxed; the answer proves an interactive session.
//   4. Interaction     — count of real key/pointer events on the form.
//   5. Rate limiting   — per-IP attempt ceiling (best-effort per instance).

import { createHmac } from 'node:crypto';

const HUMAN_SECRET_ENV = (typeof process !== 'undefined' && process.env && process.env.HUMAN_CHECK_SECRET) || null;
const SECRET = HUMAN_SECRET_ENV || '3jn-human-gate-v1';
// The committed fallback is PUBLIC (in source), so its HMAC tokens are forgeable.
// A stable secret must be shared across serverless instances, so it has to come
// from the environment. Warn loudly in production if it's missing so the operator
// sets HUMAN_CHECK_SECRET (the gate still functions; this is defense-in-depth).
if (!HUMAN_SECRET_ENV && typeof process !== 'undefined' && (process.env?.NODE_ENV === 'production' || process.env?.LIVE_MODE === 'true')) {
  console.warn('[human-verify] HUMAN_CHECK_SECRET is not set — the anti-bot gate is using a PUBLIC fallback key and its tokens are forgeable. Set HUMAN_CHECK_SECRET before taking real traffic.');
}
const CHALLENGE_TTL_MS = 10 * 60 * 1000; // a challenge is valid for 10 minutes
export const MIN_FORM_MS = 1200;         // no human completes the form faster
export const MIN_INTERACTIONS = 3;       // real keystrokes / pointer events

function sign(a, b, expiresAt) {
  return createHmac('sha256', SECRET).update(`${a}|${b}|${expiresAt}`).digest('hex');
}

// Issue a stateless human challenge: simple arithmetic a human answers in a
// second, signed so the server can verify without storing anything.
export function issueHumanChallenge(now = Date.now()) {
  // Derive digits from the clock (no Math.random needed; uniqueness per ms).
  const a = 2 + (now % 7);
  const b = 3 + (Math.floor(now / 1000) % 6);
  const expiresAt = now + CHALLENGE_TTL_MS;
  return {
    question: `${a} + ${b}`,
    a, b, expiresAt,
    token: sign(a, b, expiresAt),
    note: 'Answer the sum and return token + expiresAt with your signup/login.',
  };
}

// Full verification for explicit signup/login. Returns { ok } or { ok:false, error, message }.
export function verifyHumanCheck(check = {}, now = Date.now()) {
  const fail = (error, message) => ({ ok: false, error, message });
  // 1. Honeypot: the hidden field must come back EMPTY.
  if (check.website) return fail('bot-honeypot', 'Automated signup detected.');
  // 2. Timing: sub-human form completion.
  if (!(Number(check.elapsedMs) >= MIN_FORM_MS)) return fail('bot-timing', 'Form submitted faster than humanly possible. Please try again.');
  // 3. Interaction: a human touched keys / pointer while filling the form.
  if (!(Number(check.interactions) >= MIN_INTERACTIONS)) return fail('bot-no-interaction', 'No human interaction detected on the form.');
  // 4. Challenge: signed arithmetic, unexpired, answered correctly.
  const { a, b, expiresAt, token, answer } = check;
  if (!token || !expiresAt) return fail('challenge-missing', 'Human challenge missing — fetch /api/auth/challenge first.');
  if (Number(expiresAt) < now) return fail('challenge-expired', 'Human challenge expired — refresh and try again.');
  if (sign(Number(a), Number(b), Number(expiresAt)) !== token) return fail('challenge-invalid', 'Human challenge token invalid.');
  if (Number(answer) !== Number(a) + Number(b)) return fail('challenge-wrong', 'Human challenge answered incorrectly.');
  return { ok: true };
}

// Light verification for guest auto-provisioning (mid-checkout): no challenge,
// but honeypot + page-level timing + interactions still block curl-bots.
export function verifyLightHuman(check = {}) {
  if (check.website) return { ok: false, error: 'bot-honeypot', message: 'Automated request detected.' };
  if (!(Number(check.elapsedMs) >= MIN_FORM_MS)) return { ok: false, error: 'bot-timing', message: 'Automated request detected (timing).' };
  if (!(Number(check.interactions) >= MIN_INTERACTIONS)) return { ok: false, error: 'bot-no-interaction', message: 'Automated request detected (no interaction).' };
  return { ok: true };
}

// Best-effort per-IP rate limiting (per warm instance).
//
// SCOPE (honest): this is an in-memory, PER-INSTANCE limiter. On serverless it
// resets on cold start and is not shared across concurrent instances, so it is
// a real speed-bump against casual brute-force / supplier-spend abuse but NOT a
// hard perimeter — put a shared/edge rate limit (e.g. the platform firewall) in
// front for scale/attack conditions. Limits are env-tunable so you can tighten
// them without a deploy.
const WINDOW_MS = 60 * 1000;
// EVICTION: previously these Maps only ever grew — an entry per distinct IP was
// created and never removed, so a spray of unique source IPs on a long-lived
// warm instance was an unbounded-memory (slow-DoS) vector. We now sweep expired
// entries so memory stays bounded to the active window.
const MAX_TRACKED_IPS = 50000;
function bump(map, key, max, now) {
  key = key || 'unknown';
  // Opportunistic sweep of expired windows (cheap; keeps the Map bounded).
  if (map.size > 256) {
    for (const [k, v] of map) { if (now - v.windowStart > WINDOW_MS) map.delete(k); }
  }
  // Hard cap as a backstop against a pathological unique-IP flood.
  if (map.size > MAX_TRACKED_IPS && !map.has(key)) {
    return { ok: false, error: 'rate-limited', message: 'Service is busy — please try again shortly.' };
  }
  const cur = map.get(key);
  if (!cur || now - cur.windowStart > WINDOW_MS) {
    map.set(key, { count: 1, windowStart: now });
    return { ok: true, remaining: max - 1 };
  }
  cur.count += 1;
  if (cur.count > max) return { ok: false, error: 'rate-limited', message: 'Too many attempts — wait a minute and try again.' };
  return { ok: true, remaining: max - cur.count };
}

const attempts = new Map(); // ip -> { count, windowStart }
export const MAX_ATTEMPTS_PER_MINUTE = Math.max(1, Number(process.env.RATE_LIMIT_AUTH_PER_MIN) || 10);
export function rateLimitAuth(ip, now = Date.now()) {
  return bump(attempts, ip, MAX_ATTEMPTS_PER_MINUTE, now);
}

// Per-IP throttle for the EXPENSIVE live-supplier overlay on /api/plan. Each
// live search fans out to real Duffel/Viator/Mozio calls (paid quota, provider
// rate limits), so an unauthenticated caller must not be able to hammer it. A
// real user clicking through options stays well under this; a bot burning our
// supplier spend is stopped. Separate window/map from the auth limiter.
const liveSearches = new Map(); // ip -> { count, windowStart }
export const MAX_LIVE_SEARCHES_PER_MINUTE = Math.max(1, Number(process.env.RATE_LIMIT_LIVE_SEARCH_PER_MIN) || 20);
export function rateLimitLiveSearch(ip, now = Date.now()) {
  const r = bump(liveSearches, ip, MAX_LIVE_SEARCHES_PER_MINUTE, now);
  if (!r.ok && r.message?.startsWith('Too many attempts')) r.message = 'Too many live searches — please wait a minute.';
  return r;
}
