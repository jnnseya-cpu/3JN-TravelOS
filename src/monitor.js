// Neural Price Guard — monitors prices after quote/booking and decides whether
// to rebook, adjust or refund where commercially/legally possible.
//
// In production this would re-poll suppliers on a schedule. For the prototype
// we simulate a market re-scan and compare to the booked baseline, then apply
// the rebooking/refund policy.

import { getBooking, logPriceEvent, recordPayment } from './store.js';

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
