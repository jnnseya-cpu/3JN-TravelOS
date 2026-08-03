#!/usr/bin/env node
// ============================================================================
// 3JN Travel OS — LIVE ONE-SHOT TEST: Duffel flight HOLD (pay-later PNR)
// ============================================================================
// Proves the visa flight-hold path end to end against LIVE Duffel: search a real
// route → create a real pay-later HOLD order → confirm a real airline PNR and a
// hold-expiry come back. Run this BEFORE flipping DUFFEL auto-hold on in prod.
//
// SAFE BY DESIGN:
//   • It only creates a *pay-later HOLD* — it never pays, never issues a ticket,
//     and a Duffel hold order AUTO-EXPIRES at its payment_required_by at NO COST.
//   • Idempotency-Key is set, so a re-run against the same offer won't double-book.
//   • It picks the CHEAPEST holdable economy fare to minimise any exposure.
//
// USAGE (set the LIVE token in the env for this one command):
//   DUFFEL_TOKEN=duffel_live_xxx node scripts/live-test-duffel-hold.mjs \
//        [--from LHR] [--to DXB] [--depart 2026-09-15] [--return 2026-09-22]
//   Defaults: LHR→DXB, one-way, ~30 days out. --return adds a round trip.
//
// Exit 0 = a real PNR + hold expiry came back; 1 = failure; 2 = misconfig.
// ============================================================================

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };

const g = (s) => `\x1b[32m${s}\x1b[0m`, r = (s) => `\x1b[31m${s}\x1b[0m`, y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`, b = (s) => `\x1b[1m${s}\x1b[0m`;

const ymd = (d) => d.toISOString().slice(0, 10);
const inDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

const FROM = flag('--from', 'LHR').toUpperCase();
const TO = flag('--to', 'DXB').toUpperCase();
const DEPART = flag('--depart', inDays(30));
const RETURN = flag('--return', null);

if (!process.env.DUFFEL_TOKEN && !process.env.DUFFEL_API_KEY) {
  console.error(r('No DUFFEL_TOKEN / DUFFEL_API_KEY in the environment. Set the LIVE token and re-run:'));
  console.error(dim('  DUFFEL_TOKEN=duffel_live_xxx node scripts/live-test-duffel-hold.mjs'));
  process.exit(2);
}

// live-suppliers reads the token at import time, so the env MUST be set first.
const { issueVisaFlightHold, duffelMode } = await import('../backend/src/live-suppliers.js');

console.log(`\n${b('3JN — LIVE Duffel hold test')}  ${dim(`${FROM}→${TO}${RETURN ? '→' + FROM : ''}  depart ${DEPART}${RETURN ? '  return ' + RETURN : ''}`)}`);
const mode = duffelMode();
console.log(`  Duffel token mode: ${mode === 'live' ? g('LIVE') : mode === 'test' ? y('TEST (sandbox — PNR is a Duffel Airways ZZ test locator, not embassy-verifiable)') : r('OFF')}`);
if (mode === 'off') { console.error(r('\nDuffel is OFF — token missing or unusable. Aborting.')); process.exit(2); }

console.log(dim('\n  searching + placing a pay-later hold (this creates a REAL hold order that auto-expires at no cost)…'));
const t0 = Date.now();
let res;
try {
  res = await issueVisaFlightHold({
    originCode: FROM, destCode: TO, departDate: DEPART, returnDate: RETURN,
    travellers: 1,
    passengers: [{ fullName: 'Test Traveller', dob: '1990-01-01', gender: 'm', title: 'mr' }],
    contactEmail: 'ops@example.com', contactPhone: '+441234567890',
  });
} catch (e) {
  console.error(r(`\n❌ Threw: ${e?.message || e}`));
  process.exit(1);
}
const ms = Date.now() - t0;

if (!res?.ok) {
  console.error(r(`\n❌ Hold FAILED: ${res?.error || 'unknown'}${res?.status ? ` (status ${res.status})` : ''}  ${dim(`in ${ms}ms`)}`));
  if (res?.error === 'no-offers') console.error(dim('   No offers on that route/date — try a busier route or a different date (--from/--to/--depart).'));
  if (res?.error === 'no-holdable-offer') console.error(dim('   Offers exist but none are hold-eligible (pay-later) — try another route/carrier.'));
  process.exit(1);
}

console.log(`\n${g('✅ HOLD CREATED')}  ${dim(`in ${ms}ms`)}`);
console.log(`   Airline (provider) : ${b(res.provider || '—')}`);
console.log(`   PNR (providerRef)  : ${b(res.providerRef || r('MISSING'))}`);
console.log(`   Hold expires (held): ${b(res.heldUntil || '—')}`);
console.log(`   Duffel order id    : ${dim(res.orderId || '—')}`);
console.log(`   Fare (not charged) : ${dim(`${res.amount || '—'} ${res.currency || ''}`)}`);

const pnrOk = !!res.providerRef;
const heldOk = !!res.heldUntil;

console.log(`\n${b('Check in the Duffel dashboard:')}`);
console.log('  1. Orders → find order ' + b(res.orderId || '(id above)') + '.');
console.log('  2. Status should be ' + b('“awaiting payment” / on hold') + ' (NOT paid, NOT ticketed).');
console.log('  3. Booking reference matches the PNR above: ' + b(res.providerRef || '—') + '.');
console.log('  4. “Payment required by” matches the hold-expiry above — it will ' + b('auto-cancel at no cost') + ' after that.');
console.log(dim('  (No cleanup needed. If you want to release it now, cancel the on-hold order in the dashboard.)'));

if (pnrOk && heldOk && mode === 'live') { console.log(`\n${g('PASS — live Duffel hold returns a real PNR + expiry. Safe to enable auto-hold.')}\n`); process.exit(0); }
if (pnrOk && heldOk) { console.log(`\n${y('PASS (but token is TEST) — flip to a live duffel_live_… token to get embassy-verifiable PNRs.')}\n`); process.exit(0); }
console.log(`\n${r('PARTIAL — hold returned but PNR/expiry incomplete; check the order in the dashboard.')}\n`);
process.exit(1);
