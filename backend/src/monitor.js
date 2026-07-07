// Neural Price Guard — monitors prices after quote/booking and decides whether
// to rebook, adjust or refund where commercially/legally possible.
//
// In production this would re-poll suppliers on a schedule. For the prototype
// we simulate a market re-scan and compare to the booked baseline, then apply
// the rebooking/refund policy.

import { getBooking, logPriceEvent, recordPayment, db, pushNotification, recordAudit } from './store.js';

// A booking is eligible for an automatic refund-of-difference if the new price
// is at least this fraction lower (covers re-issue admin cost).
const REFUND_THRESHOLD = 0.03; // 3%

// Simulate a fresh market price for a booking. `drift` lets callers/tests force
// a direction; otherwise we derive a stable pseudo-drift from the booking id.
export function simulateMarketReprice(booking, drift) {
  const baseline = booking.priceGuard.baselineUSD;
  let factor;
  if (typeof drift === 'number') {
    factor = 1 + drift;
  } else {
    // Stable pseudo-random in [-12%, +8%] from booking id.
    let s = 0;
    for (let i = 0; i < booking.id.length; i++) s = (s * 31 + booking.id.charCodeAt(i)) % 1000;
    factor = 1 + ((s / 1000) * 0.2 - 0.12);
  }
  return Math.round(baseline * factor * 100) / 100;
}

// Run the price guard for a booking. Returns the decision + event.
export function runPriceGuard(bookingId, drift) {
  const booking = getBooking(bookingId);
  if (!booking) return { error: 'unknown-booking' };
  if (!booking.priceGuard.active) return { action: 'inactive' };

  const baseline = booking.priceGuard.baselineUSD;
  const newPrice = simulateMarketReprice(booking, drift);
  const deltaUSD = Math.round((newPrice - baseline) * 100) / 100;
  const pct = deltaUSD / baseline;

  let action = 'hold';
  let message = 'Price stable — no action needed.';
  let refundUSD = 0;

  if (pct <= -REFUND_THRESHOLD) {
    // Price dropped meaningfully — rebook at lower fare, refund difference.
    action = 'rebook-refund';
    refundUSD = Math.abs(deltaUSD);
    message = `Price dropped ${(Math.abs(pct) * 100).toFixed(1)}%. Rebooked at the lower fare — refunding the difference.`;
    booking.priceGuard.baselineUSD = newPrice; // new baseline after rebooking
    recordPayment(bookingId, { type: 'price-guard-refund', amount: -refundUSD, note: 'Auto refund of price difference' });
  } else if (pct >= 0.05) {
    // Price rose — reassure the customer their locked rate protected them.
    action = 'rate-locked';
    message = `Market price rose ${(pct * 100).toFixed(1)}% — your locked rate saved you the increase.`;
  }

  const event = {
    at: new Date(Date.UTC(2026, 5, 30)).toISOString(),
    baselineUSD: baseline,
    newPriceUSD: newPrice,
    deltaUSD,
    pct: Math.round(pct * 1000) / 10,
    action,
    refundUSD,
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
