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

const SECRET = (typeof process !== 'undefined' && process.env && process.env.HUMAN_CHECK_SECRET) || '3jn-human-gate-v1';
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
const attempts = new Map(); // ip -> { count, windowStart }
const WINDOW_MS = 60 * 1000;
export const MAX_ATTEMPTS_PER_MINUTE = 10;
export function rateLimitAuth(ip, now = Date.now()) {
  const key = ip || 'unknown';
  const cur = attempts.get(key);
  if (!cur || now - cur.windowStart > WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now });
    return { ok: true, remaining: MAX_ATTEMPTS_PER_MINUTE - 1 };
  }
  cur.count += 1;
  if (cur.count > MAX_ATTEMPTS_PER_MINUTE) {
    return { ok: false, error: 'rate-limited', message: 'Too many attempts — wait a minute and try again.' };
  }
  return { ok: true, remaining: MAX_ATTEMPTS_PER_MINUTE - cur.count };
}

// Per-IP throttle for the EXPENSIVE live-supplier overlay on /api/plan. Each
// live search fans out to real Duffel/Viator/Mozio calls (paid quota, provider
// rate limits), so an unauthenticated caller must not be able to hammer it. A
// real user clicking through options stays well under this; a bot burning our
// supplier spend is stopped. Separate window/map from the auth limiter.
const liveSearches = new Map(); // ip -> { count, windowStart }
export const MAX_LIVE_SEARCHES_PER_MINUTE = 20;
export function rateLimitLiveSearch(ip, now = Date.now()) {
  const key = ip || 'unknown';
  const cur = liveSearches.get(key);
  if (!cur || now - cur.windowStart > WINDOW_MS) {
    liveSearches.set(key, { count: 1, windowStart: now });
    return { ok: true, remaining: MAX_LIVE_SEARCHES_PER_MINUTE - 1 };
  }
  cur.count += 1;
  if (cur.count > MAX_LIVE_SEARCHES_PER_MINUTE) {
    return { ok: false, error: 'rate-limited', message: 'Too many live searches — please wait a minute.' };
  }
  return { ok: true, remaining: MAX_LIVE_SEARCHES_PER_MINUTE - cur.count };
}
