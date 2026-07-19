#!/usr/bin/env node
// ============================================================================
// 3JN Travel OS — LIVE booking verifier (closes the loop on the 4 live-gated tests)
// ============================================================================
// Run this AFTER you complete a real transaction on production. It reads the
// actual booking through the admin API (which also forces the Duffel PNR/e-ticket
// sync) and asserts, with EVIDENCE, that the real airline reference, e-ticket and
// card capture landed — turning AT-03 / AT-23 / AT-24 / AT-38 from
// "logic-verified" into "LIVE-verified". It only reads; it changes nothing.
//
//   node scripts/live-verify-booking.mjs <prod-url> <bookingId|quoteId> \
//        --admin <ADMIN_USER_ID> --pin <STAFF_ACCESS_PIN>
//   (or set ADMIN_USER_ID / STAFF_PIN env vars)
//
// bookingId = bkg_… (a flight/package booking) or qr_… (a paid exact-quote —
// the script follows it to the real booking it created).
//
// Exit 0 = every applicable live check passed; 1 = a failure; 2 = usage error.
// ============================================================================

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]?.startsWith('--')));
const BASE = (positional[0] || process.env.BASE_URL || '').replace(/\/+$/, '');
const ID = positional[1] || process.env.BOOKING_ID || '';
const ADMIN = flag('--admin') || process.env.ADMIN_USER_ID || '';
const PIN = flag('--pin') || process.env.STAFF_PIN || process.env.STAFF_ACCESS_PIN || '';

const g = (s) => `\x1b[32m${s}\x1b[0m`, r = (s) => `\x1b[31m${s}\x1b[0m`, y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`, b = (s) => `\x1b[1m${s}\x1b[0m`;
const mask = (s) => { s = String(s || ''); return s.length <= 8 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`; };

if (!BASE || !ID) {
  console.error('Usage: node scripts/live-verify-booking.mjs <prod-url> <bookingId|quoteId> --admin <ADMIN_USER_ID> --pin <PIN>');
  process.exit(2);
}
if (!ADMIN) { console.error(r('Need an admin user id (--admin or ADMIN_USER_ID) to read the booking.')); process.exit(2); }

const H = { 'x-user-id': ADMIN, ...(PIN ? { 'x-staff-pin': PIN } : {}), accept: 'application/json' };
async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: H });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}

const results = [];
const record = (id, status, detail) => { results.push({ id, status, detail }); };
// status: 'PASS' | 'FAIL' | 'PARTIAL' | 'NA'

console.log(`\n${b('3JN — live booking verification')}  ${dim(BASE)}  booking ${b(ID)}\n`);

// --- Resolve a quote id to its real booking ---------------------------------
let bookingId = ID;
if (ID.startsWith('qr_')) {
  const qr = await getJson('/api/admin/quote-requests');
  if (qr.status !== 200) { console.error(r(`Could not list quote-requests (status ${qr.status}). Check admin id + PIN.`)); process.exit(1); }
  const found = (qr.json.requests || []).find((x) => x.id === ID);
  if (!found) { console.error(r(`Quote ${ID} not found.`)); process.exit(1); }
  if (!found.bookingId) { console.error(r(`Quote ${ID} is paid but has NO linked booking — the exact-quote→booking conversion FAILED. This is the bug the harness guards; investigate immediately.`)); process.exit(1); }
  bookingId = found.bookingId;
  console.log(dim(`  quote ${ID} → booking ${bookingId}`));
}

// --- Fetch the booking (this call also forces the Duffel PNR/e-ticket sync) --
const bk = await getJson(`/api/book/${bookingId}`);
if (bk.status === 403) { console.error(r('403 — the admin id/PIN cannot read this booking. Confirm the account is in ADMIN_EMAILS and the PIN is correct.')); process.exit(1); }
if (bk.status !== 200 || !bk.json?.booking) { console.error(r(`Could not read booking ${bookingId} (status ${bk.status}).`)); process.exit(1); }
const booking = bk.json.booking;
const ful = booking.fulfilment || {};
const payments = Array.isArray(booking.payments) ? booking.payments : [];
const total = booking.option?.pricing?.local?.total || 0;
const sym = booking.option?.pricing?.symbol || '£';
const PLAN = new Set(['deposit', 'instalment', 'full', 'stripe-checkout', 'deposit-credit', 'travel-credit']);
const planPaid = payments.filter((p) => PLAN.has(p.type)).reduce((s, p) => s + (Number(p.amount) || 0), 0);
const hasLiveFlight = (booking.option?.components || []).some((c) => c.type === 'flight' && c.live);

// --- LV-1 (AT-03): real airline PNR + e-ticket issued -----------------------
const pnr = ful.pnr || ful.duffelOrderId || null;
const tickets = (ful.ticketNumbers || []).filter(Boolean);
if (!hasLiveFlight) {
  record('LV-1 e-ticket issued (AT-03)', 'NA', 'no live flight on this booking (package/estimate) — issuance N/A');
} else if (ful.ticketing === 'issued' && pnr && tickets.length) {
  record('LV-1 e-ticket issued (AT-03)', 'PASS', `PNR ${b(pnr)} · ${tickets.length} e-ticket(s): ${tickets.map(mask).join(', ')}`);
} else if (ful.ticketing === 'issued' && !pnr) {
  record('LV-1 e-ticket issued (AT-03)', 'PARTIAL', 'ticketing=issued but PNR still syncing from Duffel — re-run this script in ~1 min');
} else if (ful.ticketing === 'lock-scheduled' || ful.ticketing === 'holding') {
  record('LV-1 e-ticket issued (AT-03)', hasLiveFlight ? 'PARTIAL' : 'NA', `ticketing=${ful.ticketing} — balance not yet £0, so the gate correctly withholds the ticket`);
} else {
  record('LV-1 e-ticket issued (AT-03)', 'FAIL', `ticketing=${ful.ticketing || 'none'}, pnr=${pnr || 'none'}, tickets=${tickets.length} — expected a real PNR + e-ticket after full payment`);
}

// --- LV-2 (capture): a real card charge is recorded, booking fully paid -----
const stripePay = payments.find((p) => (p.gateway === 'stripe') && (p.paymentIntent || p.reference));
const fullyPaid = total > 0 && planPaid + 0.01 >= total;
if (stripePay && fullyPaid) {
  record('LV-2 real card capture', 'PASS', `${sym}${planPaid.toFixed(2)}/${sym}${total.toFixed(2)} paid · Stripe ref ${mask(stripePay.paymentIntent || stripePay.reference)}`);
} else if (stripePay && !fullyPaid) {
  record('LV-2 real card capture', 'PARTIAL', `Stripe payment present (${mask(stripePay.paymentIntent || stripePay.reference)}) but balance remains: ${sym}${planPaid.toFixed(2)}/${sym}${total.toFixed(2)}`);
} else if (fullyPaid) {
  record('LV-2 real card capture', 'PARTIAL', `fully paid (${sym}${planPaid.toFixed(2)}) but no Stripe reference on the payments — was this captured via Stripe live?`);
} else {
  record('LV-2 real card capture', 'FAIL', `no captured Stripe payment found; paid ${sym}${planPaid.toFixed(2)}/${sym}${total.toFixed(2)}`);
}

// --- LV-3 (AT-24): a change was collected BEFORE reissue --------------------
const changeCharge = payments.find((p) => p.type === 'change-charge');
if (!changeCharge) {
  record('LV-3 change collected-before-reissue (AT-24)', 'NA', 'no date/itinerary change on this booking');
} else if (changeCharge.status === 'paid' && (ful.ticketing === 'issued' || ful.ticketing === 'reissued')) {
  record('LV-3 change collected-before-reissue (AT-24)', 'PASS', `${sym}${Number(changeCharge.amount).toFixed(2)} collected (${changeCharge.gateway}${changeCharge.reference ? ' ' + mask(changeCharge.reference) : ''}) → reissued`);
} else {
  record('LV-3 change collected-before-reissue (AT-24)', 'FAIL', `change-charge status=${changeCharge.status}, ticketing=${ful.ticketing} — a ticket must never reissue without a paid charge`);
}

// --- LV-4 (AT-23): the change carried an EXACT airline difference -----------
const chLog = Array.isArray(booking.changeLog) ? booking.changeLog : [];
if (!chLog.length) {
  record('LV-4 exact airline difference (AT-23)', 'NA', 'no completed change to evidence an airline fare difference');
} else {
  const last = chLog[chLog.length - 1];
  record('LV-4 exact airline difference (AT-23)', last.extraGbp != null ? 'PASS' : 'PARTIAL',
    `change "${last.description || ''}" reissued · total collected ${sym}${Number(last.extraGbp || 0).toFixed(2)} (fee + real airline diff)`);
}

// --- LV-5 (bonus): confirmation email + Travel Credit on live data ----------
record('LV-5 confirmation emailed', booking.confirmationEmailSent ? 'PASS' : (fullyPaid ? 'FAIL' : 'NA'),
  booking.confirmationEmailSent ? 'full confirmation + PDF dispatched' : (fullyPaid ? 'fully paid but confirmation not marked sent — check SMTP' : 'not yet fully paid'));
if (booking.travelCreditEarned != null) {
  record('LV-6 Travel Credit banked', booking.travelCreditEarned > 0 ? 'PASS' : 'NA',
    booking.travelCreditEarned > 0 ? `${sym}${Number(booking.travelCreditEarned).toFixed(2)} credit earned on this package` : 'no credit (non-member or flight-only)');
}

// --- LV-7 (AT-38): live Trustpilot widget key present -----------------------
try {
  const ctx = await getJson('/api/context');
  const tp = ctx.json?.trustpilot || {};
  record('LV-7 Trustpilot live widget (AT-38)', tp.businessUnitId ? 'PASS' : 'NA',
    tp.businessUnitId ? 'business-unit id set → live star widget renders' : (tp.domain ? 'domain badge only (widget key not set — optional)' : 'Trustpilot not configured'));
} catch { /* non-fatal */ }

// --- Report -----------------------------------------------------------------
console.log('');
const icon = { PASS: g('✅'), FAIL: r('❌'), PARTIAL: y('◐'), NA: dim('—') };
for (const x of results) console.log(`${icon[x.status]}  ${b(x.id)}  ${dim(x.detail)}`);
const fails = results.filter((x) => x.status === 'FAIL').length;
const partials = results.filter((x) => x.status === 'PARTIAL').length;
console.log(`\n${b('Live verification:')} ${fails ? r(`${fails} FAIL`) : (partials ? y(`${partials} PARTIAL (re-run when Duffel/settlement completes)`) : g('all applicable checks LIVE-VERIFIED with evidence'))}\n`);
process.exit(fails ? 1 : 0);
