// Bot Defence — blocks bot accounts at signup and login, and quarantines
// dormant bot accounts already inside.
//
// PRIME DIRECTIVE: real accounts are NEVER touched. Every heuristic here is
// deliberately conservative — it fires only on HIGH-CONFIDENCE machine
// signals, and the dormant sweep additionally requires ZERO activity: one
// booking, one ACU transaction, one review, one listing — any human trace —
// makes an account permanently immune. Non-Latin names (Arabic, Chinese,
// Cyrillic…) are always treated as human: we never judge scripts we can't
// read. False negatives are acceptable; false positives are not.

// Disposable/throwaway email domains — the classic bot signup fuel.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com',
  '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org',
  'yopmail.com', 'trashmail.com', 'getnada.com', 'dispostable.com',
  'throwawaymail.com', 'fakeinbox.com', 'maildrop.cc', 'mintemail.com',
  'mytemp.email', 'tempinbox.com', 'spamgourmet.com', 'mailnesia.com',
]);

const VOWELS = /[aeiouy]/i;
const NON_ASCII_LETTER = /[^\x00-\x7F]/;

// Does a display name look machine-generated? Conservative by design.
export function nameLooksBot(name) {
  const n = String(name || '').trim();
  const reasons = [];
  if (!n) return { bot: false, reasons }; // empty → platform default name, fine
  // Names containing non-ASCII letters are ALWAYS human — we do not judge
  // Arabic, Chinese, Cyrillic, accented European names, etc.
  if (NON_ASCII_LETTER.test(n)) return { bot: false, reasons };
  const digits = (n.match(/\d/g) || []).length;
  if (digits >= 4) reasons.push('name-heavy-digits');
  if (/(.)\1{4,}/.test(n)) reasons.push('name-repeated-run'); // 'aaaaa'
  const tokens = n.split(/[\s\-.']+/).filter(Boolean);
  for (const t of tokens) {
    if (t.length > 40) { reasons.push('name-token-overlong'); break; }
    // A ≥6-letter all-alpha token with NO vowel at all is keyboard mash
    // ('xkqzvbnt'). Real vowelless names exist but are short (Ng, Sng).
    if (/^[a-z]+$/i.test(t) && t.length >= 6 && !VOWELS.test(t)) { reasons.push('name-vowelless-mash'); break; }
  }
  // Alternating-case mash like 'xKjQwZvB' (4+ internal case flips, no spaces).
  if (tokens.length === 1 && /^(?:[a-z][A-Z]|[A-Z][a-z]){4,}/.test(n) && (n.match(/[a-z][A-Z]/g) || []).length >= 4) reasons.push('name-case-mash');
  return { bot: reasons.length > 0, reasons };
}

// Does an email look machine-generated? Only hard signals.
export function emailLooksBot(email) {
  const e = String(email || '').trim().toLowerCase();
  const reasons = [];
  if (!e) return { bot: false, reasons };
  const [local = '', domain = ''] = e.split('@');
  if (DISPOSABLE_DOMAINS.has(domain)) reasons.push('disposable-email-domain');
  if ((local.match(/\d/g) || []).length >= 10) reasons.push('email-digit-flood');
  if (/^[a-f0-9]{20,}$/.test(local)) reasons.push('email-hex-blob');
  return { bot: reasons.length > 0, reasons };
}

// The signup gate. Blocks ONLY on high-confidence combinations:
//   - honeypot filled (a human cannot see the field) → hard block
//   - disposable email domain → hard block
//   - machine-looking name AND a second signal (bot email / instant submit /
//     zero page interactions) → block
// A slightly odd name ALONE never blocks a real person.
export function botSignupVerdict({ name, email, honeypot, elapsedMs, interactions } = {}) {
  const reasons = [];
  if (String(honeypot || '').trim()) reasons.push('honeypot-filled');
  const em = emailLooksBot(email);
  if (em.reasons.includes('disposable-email-domain')) reasons.push('disposable-email-domain');
  const nm = nameLooksBot(name);
  if (nm.bot) {
    const second = em.bot
      || (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < 1500)
      || (Number.isFinite(interactions) && interactions === 0);
    if (second) reasons.push(...nm.reasons, ...(em.bot ? em.reasons : []), 'no-human-signal');
  }
  const block = reasons.length > 0;
  return {
    ok: !block,
    block,
    reasons,
    message: block
      ? 'This signup was blocked by our automated-account protection. If you are a real person, contact support@3jntravel.com and we will open your account personally.'
      : null,
  };
}

// Dormant-bot test for the sweep. `activity` is computed by the store from
// the REAL ledgers. Any activity at all → immune, categorically.
export function accountIsDormantBot(user, activity, { olderThanHours = 72, nowMs } = {}) {
  if (!user) return { flag: false, reasons: [] };
  // Exemptions before any heuristic: staff/demo/privileged accounts, hosts,
  // anyone with a filled travel profile (humans fill passports; bots don't).
  if (user.allAccess || (user.role && user.role !== 'consumer')) return { flag: false, reasons: [] };
  if (String(user.email || '').endsWith('@3jntravel.com')) return { flag: false, reasons: [] };
  if (user.host || user.travelProfile?.passportNumber || user.travelProfile?.fullLegalName) return { flag: false, reasons: [] };
  // ANY activity → real account → never touched.
  const active = activity && Object.values(activity).some((v) => Number(v) > 0);
  if (active) return { flag: false, reasons: [] };
  // Give brand-new accounts time to become active before judging dormancy.
  const created = new Date(user.createdAt || 0).getTime();
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!created || now - created < olderThanHours * 3600000) return { flag: false, reasons: [] };
  const nm = nameLooksBot(user.name);
  const em = emailLooksBot(user.email);
  if (!nm.bot && !em.bot) return { flag: false, reasons: [] }; // real-looking + dormant = just a quiet human
  return { flag: true, reasons: [...nm.reasons, ...em.reasons, 'zero-activity'] };
}
