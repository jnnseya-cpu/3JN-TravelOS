// Field-level PII encryption AT REST (AES-256-GCM).
//
// The crown-jewel personal data — passport number, date of birth, national ID,
// home/billing address, phone — is encrypted before it is written to the durable
// store (Firebase / KV) and decrypted immediately after it is read back. The
// IN-MEMORY store stays plaintext, so every engine (booking, ticketing, visa,
// documents) works unchanged; only the data at rest is ciphertext, so a leaked
// database dump is useless without the key.
//
// Key management:
//   • The 32-byte key is derived (scrypt) from the DATA_ENCRYPTION_KEY env secret.
//   • With NO key set, encryption is a NO-OP — dev/test run on plaintext, and a
//     production/LIVE deploy is warned loudly. Set the key before real customer data.
//   • Encrypted values are tagged `enc:v1:` so decryption is idempotent and any
//     LEGACY plaintext already in the store still loads (it migrates to ciphertext
//     the next time that record is written). Rotating away the key later must be
//     deliberate — data written under a key cannot be read without it.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const RAW_KEY = (typeof process !== 'undefined' && process.env && (process.env.DATA_ENCRYPTION_KEY || process.env.PII_ENCRYPTION_KEY)) || null;
const KEY = RAW_KEY ? scryptSync(RAW_KEY, '3jn-pii-salt-v1', 32) : null;
const PREFIX = 'enc:v1:';

export function piiEncryptionEnabled() { return !!KEY; }

if (!KEY && typeof process !== 'undefined' && (process.env?.NODE_ENV === 'production' || process.env?.LIVE_MODE === 'true')) {
  console.warn('[pii] DATA_ENCRYPTION_KEY is not set — passport / DOB / national-ID / address data is stored in PLAINTEXT at rest. Set DATA_ENCRYPTION_KEY before taking real customer data.');
}

// Encrypt one scalar value → `enc:v1:<base64(iv|tag|ciphertext)>`. Idempotent
// (already-encrypted / empty / non-key input passes through).
export function encField(v) {
  if (KEY == null || v == null || v === '') return v;
  const s = String(v);
  if (s.startsWith(PREFIX)) return s;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
// Decrypt an `enc:v1:` value; anything else (legacy plaintext, no key) is returned
// unchanged. A tamper / wrong-key failure returns the raw value rather than throwing.
export function decField(v) {
  if (KEY == null || typeof v !== 'string' || !v.startsWith(PREFIX)) return v;
  try {
    const raw = Buffer.from(v.slice(PREFIX.length), 'base64');
    const d = createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch { return v; }
}

// The encrypted fields. NOTE: the account's PRIMARY email (user.email) is a lookup
// key and is deliberately NOT encrypted; the sensitive identity/contact fields are.
const PROFILE_PII = [
  'passportNumber', 'nationalId', 'dob', 'passportExpiry', 'passportIssue',
  'residentialAddress', 'billingAddress', 'mobile', 'secondaryPhone',
  'emergencyContact', 'alienRegistrationNumber', 'knownTravelerNumber',
  'redressNumber', 'placeOfBirth', 'postalCode',
];
const TRAVELLER_PII = ['passportNumber', 'dob', 'passportExpiry'];

function mapObj(o, fields, fn) {
  if (o && typeof o === 'object') for (const f of fields) if (o[f] != null && typeof o[f] !== 'object') o[f] = fn(o[f]);
}
function userPII(u, fn) { if (u?.travelProfile) mapObj(u.travelProfile, PROFILE_PII, fn); }
function bookingPII(b, fn) {
  if (!b || typeof b !== 'object') return;
  mapObj(b.leadTraveller, TRAVELLER_PII, fn);
  if (Array.isArray(b.travellers)) b.travellers.forEach((t) => mapObj(t, TRAVELLER_PII, fn));
}

// Walk a stored snapshot and apply `fn` to every PII field. Handles BOTH the
// nested shape ({ users: { id: {...} }, bookings: {...} }) written by save() and
// the path-keyed shape ({ 'users/id': {...} }) written by saveMerge().
function walk(obj, fn) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.users && typeof obj.users === 'object' && !Array.isArray(obj.users)) for (const u of Object.values(obj.users)) userPII(u, fn);
  if (obj.bookings && typeof obj.bookings === 'object' && !Array.isArray(obj.bookings)) for (const b of Object.values(obj.bookings)) bookingPII(b, fn);
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('users/')) userPII(v, fn);
    else if (k.startsWith('bookings/')) bookingPII(v, fn);
  }
  return obj;
}

// Encrypt/decrypt a snapshot on a CLONE — never mutate the caller's object (the
// in-memory store must stay plaintext). No key → identity.
export function encryptSnapshot(data) { return KEY ? walk(JSON.parse(JSON.stringify(data)), encField) : data; }
export function decryptSnapshot(data) { return (KEY && data) ? walk(JSON.parse(JSON.stringify(data)), decField) : data; }
