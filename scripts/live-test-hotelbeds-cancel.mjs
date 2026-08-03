#!/usr/bin/env node
// ============================================================================
// 3JN Travel OS — LIVE ONE-SHOT TEST: Hotelbeds free-cancellation BOOK → CANCEL
// ============================================================================
// Proves the visa hotel path end to end against LIVE Hotelbeds: search → book a
// FREE-CANCELLATION room → immediately CANCEL it → confirm a £0 cancellation
// charge. Run this BEFORE enabling VISA_AUTO_HOTEL in prod.
//
// SAFE BY DESIGN:
//   • Books FREE-CANCELLATION rates ONLY, then cancels IMMEDIATELY (well inside
//     the free window) → the cancellation charge should be 0.
//   • If the booking succeeds but the cancel fails, the script LOUDLY prints the
//     reference so you can cancel it by hand before its deadline (don't ignore it).
//
// ⚠️ This creates a REAL booking on your live Hotelbeds account for a few seconds.
//    Run it ONCE; each run books + cancels one room.
//
// USAGE (set the LIVE keys in the env for this one command):
//   HOTELBEDS_API_KEY=xxx HOTELBEDS_SECRET=yyy \
//     node scripts/live-test-hotelbeds-cancel.mjs [--dest DXB] [--nights 1] [--maxUSD 200]
//   Defaults: dest DXB, check-in ~30 days out, 1 night.
//
// Exit 0 = booked then cancelled with £0 charge; 1 = failure (may need manual
// cleanup — reference is printed); 2 = misconfig.
// ============================================================================

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };

const g = (s) => `\x1b[32m${s}\x1b[0m`, r = (s) => `\x1b[31m${s}\x1b[0m`, y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`, b = (s) => `\x1b[1m${s}\x1b[0m`;

const ymd = (d) => d.toISOString().slice(0, 10);
const inDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

const DEST = flag('--dest', 'DXB').toUpperCase();
const NIGHTS = Math.max(1, Number(flag('--nights', '1')) || 1);
const MAX_USD = flag('--maxUSD', null) != null ? Number(flag('--maxUSD', null)) : null;
const CHECKIN = flag('--checkin', inDays(30));
const CHECKOUT = (() => { const d = new Date(`${CHECKIN}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + NIGHTS); return ymd(d); })();

const hasKeys = (process.env.HOTELBEDS_API_KEY || process.env.HOTELBEDS_HOTEL_API_KEY) && (process.env.HOTELBEDS_SECRET || process.env.HOTELBEDS_HOTEL_SECRET);
if (!hasKeys) {
  console.error(r('Hotelbeds keys missing. Set BOTH the key and secret (used to build the X-Signature) and re-run:'));
  console.error(dim('  HOTELBEDS_API_KEY=xxx HOTELBEDS_SECRET=yyy node scripts/live-test-hotelbeds-cancel.mjs'));
  process.exit(2);
}

// live-suppliers reads the keys at import time, so the env MUST be set first.
const { issueVisaHotelReservation, cancelHotelbedsBooking, hotelbedsBookingDetail, hotelbedsHotelsEnabled } = await import('../backend/src/live-suppliers.js');

console.log(`\n${b('3JN — LIVE Hotelbeds book→cancel test')}  ${dim(`dest ${DEST}  ${CHECKIN}→${CHECKOUT} (${NIGHTS}n)${MAX_USD != null ? '  ≤$' + MAX_USD : ''}`)}`);
if (!hotelbedsHotelsEnabled()) { console.error(r('\nHotelbeds not enabled (need API key AND secret). Aborting.')); process.exit(2); }

// --- 1. BOOK a free-cancellation room --------------------------------------
console.log(dim('\n  [1/2] searching + booking a FREE-CANCELLATION room…'));
let bk;
try {
  bk = await issueVisaHotelReservation({ destCode: DEST, checkIn: CHECKIN, checkOut: CHECKOUT, nights: NIGHTS, adults: 1, guestName: 'Test Traveller', maxRoomUSD: MAX_USD });
} catch (e) { console.error(r(`\n❌ Booking threw: ${e?.message || e}`)); process.exit(1); }

if (!bk?.ok) {
  console.error(r(`\n❌ Booking FAILED: ${bk?.error || 'unknown'}`));
  if (bk?.error === 'no-availability') console.error(dim('   No Hotelbeds availability for that destination code / dates — try another --dest (e.g. BCN, LON, DXB) or dates.'));
  if (bk?.error === 'no-free-cancellation-rate-within-deposit') console.error(dim('   Availability exists but no FREE-CANCELLATION rate within the price cap — raise --maxUSD or drop it.'));
  process.exit(1);
}
console.log(`  ${g('✅ BOOKED')}  provider ${b(bk.provider || '—')}  ref ${b(bk.reference || bk.providerRef)}  free-cancel by ${b(bk.cancelBy || '—')}  net ${dim(`${bk.net || '—'} ${bk.currency || ''}`)}`);
const REF = bk.hotelbedsRef || bk.providerRef || bk.reference;

// --- 2. CANCEL it immediately (inside the free window) ----------------------
console.log(dim('\n  [2/2] cancelling immediately (inside the free-cancel window → expect £0 charge)…'));
let cx;
try {
  cx = await cancelHotelbedsBooking(REF);
} catch (e) { cx = { ok: false, error: e?.message || String(e) }; }

if (!cx?.ok) {
  console.error(r(`\n❌ CANCEL FAILED: ${cx?.error || 'unknown'}${cx?.status ? ` (status ${cx.status})` : ''}`));
  console.error(r(`\n⚠️  ACTION NEEDED: the booking ${b(REF)} is LIVE and was NOT cancelled.`));
  console.error(r(`   Cancel it by hand in the Hotelbeds dashboard BEFORE ${bk.cancelBy || 'its free-cancel deadline'} or you'll be charged for the room.`));
  process.exit(1);
}

const charge = Number(cx.cancellationCharge) || 0;
console.log(`  ${g('✅ CANCELLED')}  ref ${b(cx.reference)}  status ${b(cx.status)}  charge ${charge > 0 ? r(`${charge} ${cx.currency}`) : g(`0 ${cx.currency || ''}`)}`);

// --- Optional: confirm the supplier now reports it CANCELLED ----------------
try {
  const det = await hotelbedsBookingDetail(REF);
  if (det?.ok && det.booking) console.log(dim(`  supplier record status: ${det.booking.status || '(unknown)'}`));
} catch { /* non-fatal */ }

console.log(`\n${b('Check in the Hotelbeds dashboard:')}`);
console.log('  1. Bookings → find reference ' + b(REF) + ' (client ref JNN-VISA).');
console.log('  2. It should show status ' + b('CANCELLED') + '.');
console.log('  3. Cancellation charge should be ' + b('0') + ' (it was cancelled inside the free window).');
console.log('  4. Confirm no invoice/settlement line is raised for the room.');

if (charge === 0) { console.log(`\n${g('PASS — live Hotelbeds book+cancel works with £0 charge. Safe to enable VISA_AUTO_HOTEL.')}\n`); process.exit(0); }
console.log(`\n${y(`PARTIAL — cancelled but a ${charge} ${cx.currency} charge was applied. The booked rate may not have been truly free-cancellation for these dates; review before enabling auto-hotel.`)}\n`);
process.exit(1);
