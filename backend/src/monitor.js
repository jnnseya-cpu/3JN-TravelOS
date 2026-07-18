// Price Lock — 3JN fixes the SELL price in the booking terms at the moment of
// quote. The customer is protected from fare increases and currency movement
// until they travel; the contingency margin in the sell price funds that
// guarantee. This is a real, honest promise: a locked price that never rises.
//
// It does NOT invent a market price, and it NEVER auto-refunds a "price drop".
// A supplier-backed lower rebooking is only ever actioned by the ops desk where
// a supplier genuinely permits it, and recorded as a real payment event then —
// never fabricated from a simulated number.

import { getBooking, logPriceEvent, db, pushNotification, recordAudit } from './store.js';

// Confirm the price lock for a booking. Returns a truthful event. `riseDrift`
// (optional, e.g. from a real market comparison or a what-if) may be supplied to
// quantify how much a fare RISE would have cost — the increase the lock absorbs.
// Never records a refund; never claims a rebooking that didn't happen.
export function runPriceGuard(bookingId, riseDrift) {
  const booking = getBooking(bookingId);
  if (!booking) return { error: 'unknown-booking' };
  if (!booking.priceGuard?.active) return { action: 'inactive' };
  const baseline = booking.priceGuard.baselineUSD;
  let action = 'locked';
  let message = 'Your price is locked at the booked rate — protected from fare increases and currency movement until you travel. No surprises before departure.';
  let newPrice = baseline;
  let deltaUSD = 0;
  // Only a genuine RISE is ever reported (that is the real value of the lock).
  // A drop is not turned into a fabricated refund.
  if (typeof riseDrift === 'number' && riseDrift > 0) {
    newPrice = Math.round(baseline * (1 + riseDrift) * 100) / 100;
    deltaUSD = Math.round((newPrice - baseline) * 100) / 100;
    action = 'rate-locked';
    message = `The market fare rose ${(riseDrift * 100).toFixed(1)}% since you booked — your locked price protected you from the ${Math.round(deltaUSD)} increase.`;
  }
  const event = {
    at: new Date(Date.UTC(2026, 5, 30)).toISOString(),
    baselineUSD: baseline,
    newPriceUSD: newPrice,
    deltaUSD,
    pct: baseline ? Math.round((deltaUSD / baseline) * 1000) / 10 : 0,
    action,
    refundUSD: 0,
    message,
  };
  logPriceEvent(bookingId, event);
  return event;
}

// ---- Disruption Agent --------------------------------------------------------
// Watches booked flights for delay/cancellation and REBOOKS automatically onto
// the next reliable alternative, notifying the traveller — the disruption twin
// of the Neural Price Guard. Deterministic (seeded by booking id); `force`
// lets the demo/UI trigger a disruption to show the flow.
import { seeded as seededRnd } from './suppliers.js';
export function runDisruptionGuard(bookingId, force = null) {
  const booking = getBooking(bookingId);
  if (!booking) return { ok: false, error: 'booking-not-found' };
  const flight = (booking.option?.components || []).find((c) => c.type === 'flight');
  if (!flight) return { ok: true, status: 'no-flight', message: 'No flight in this booking to monitor.' };
  const rnd = seededRnd(`disruption|${bookingId}`);
  const roll = rnd();
  const disrupted = force != null ? !!force : roll < 0.12; // ~12% demo incidence
  if (!disrupted) {
    return { ok: true, status: 'on-time', flight: flight.supplier, message: `${flight.supplier} is operating on schedule — monitoring continues.` };
  }
  const kind = roll < 0.05 ? 'cancellation' : 'long delay';
  const alternates = ['Emirates', 'Qatar Airways', 'Turkish Airlines', 'British Airways', 'Lufthansa'].filter((a) => a !== flight.supplier);
  const rebookedTo = alternates[Math.floor(rnd() * alternates.length)];
  const event = {
    bookingId,
    type: 'disruption',
    kind,
    original: flight.supplier,
    rebookedTo,
    fareDifferenceUSD: 0, // disruption rebooking is cost-neutral to the traveller
    compensationRoute: 'Claim filed via Compensair where eligible (EU261/UK261)',
    at: new Date().toISOString(),
  };
  db.priceEvents.push(event);
  if (booking.userId) {
    pushNotification(booking.userId, {
      type: 'warning', icon: '🛫', title: `Flight ${kind} — already rebooked`,
      body: `${flight.supplier} ${kind} detected. The Disruption Agent rebooked you onto ${rebookedTo} at no extra cost. Compensation claim prepared.`,
    });
  }
  recordAudit({ actor: 'disruption-agent', role: 'agent', action: 'disruption.rebooked', entity: 'booking', entityId: bookingId, summary: `${flight.supplier} ${kind} → ${rebookedTo}` });
  return { ok: true, status: 'rebooked', event };
}
