// 3JN Assistant — booking-operator actions.
//
// The pricing + mutation logic that lets the AI Assistant do what a human
// booking operator does: change a travel date, add baggage, add a passenger,
// or cancel — always with a QUOTE the customer confirms before any money moves,
// and always applied to the real booking with an audit trail and a re-issued
// e-ticket. Kept pure (operates on a booking object) so it is easy to test; the
// stateful quote→confirm handoff and payment/notification live in store.js.
//
// Money rule (never weaken): a change is only ever charged AFTER the customer
// confirms the quoted amount. For a LIVE airline fare, the supplier fare
// difference is confirmed at re-issue and shown as its own line — 3JN never
// invents an airline price.

export const OPERATOR_FEES = {
  changeFeeGbp: 45,      // 3JN date/itinerary change service fee
  extraBagGbp: 40,       // per checked bag added after booking
  addPassengerGbp: 60,   // 3JN admin fee to add a traveller (fare quoted on top)
  shortNoticeGbp: 60,    // date change within 30 days of departure
  roomUpgradeGbp: 55,    // hotel room upgrade service fee (rate delta on top)
};
const GBP_TO_USD = 1 / 0.79; // platform anchor reciprocal (≈1.266) — consistent everywhere
const BOARD_UPGRADE = { 'Bed & breakfast': 0.06, 'Half board': 0.16, 'Full board': 0.26, 'All inclusive': 0.42 };

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function usdToGbp(usd) { return round2((Number(usd) || 0) / GBP_TO_USD); }
function firstOfType(booking, type) { return (booking.option?.components || []).find((c) => c.type === type); }

// Days until the first flight departs (or null if unknown).
function daysToDeparture(booking, todayISO) {
  const flight = (booking.option?.components || []).find((c) => c.type === 'flight');
  const dep = flight?.details?.outbound?.date;
  if (!dep || !todayISO) return null;
  const ms = new Date(`${dep}T00:00:00Z`) - new Date(`${todayISO}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

// Quote a change. `changes` = { kind: 'date'|'baggage'|'passenger', newDate?, bags?, passengers? }.
// Returns { ok, quote } where quote itemises every line and the total extra due.
export function quoteChange(booking, changes, { todayISO } = {}) {
  if (!booking) return { ok: false, error: 'no-booking' };
  const sym = booking.option?.pricing?.symbol || '£';
  const lines = [];
  const flight = (booking.option?.components || []).find((c) => c.type === 'flight');
  const isLive = !!flight?.live;

  const hotel = firstOfType(booking, 'hotel') || firstOfType(booking, 'host');

  if (changes.kind === 'date') {
    if (!changes.newDate) return { ok: false, error: 'no-date' };
    // A date change moves the WHOLE trip — flights, stay and transfers together.
    lines.push({ label: '3JN change service fee', amountGbp: OPERATOR_FEES.changeFeeGbp });
    const dtd = daysToDeparture(booking, todayISO);
    if (dtd != null && dtd <= 30) lines.push({ label: 'Short-notice change (within 30 days)', amountGbp: OPERATOR_FEES.shortNoticeGbp });
    if (flight) lines.push({ label: isLive ? 'Airline fare difference (confirmed at re-issue)' : 'Fare difference', amountGbp: 0, deferred: isLive });
    if (hotel?.live) lines.push({ label: 'Hotel rate difference (confirmed at re-issue)', amountGbp: 0, deferred: true });
  } else if (changes.kind === 'baggage') {
    const bags = Math.max(1, Number(changes.bags) || 1);
    lines.push({ label: `${bags} × extra checked bag`, amountGbp: round2(OPERATOR_FEES.extraBagGbp * bags) });
  } else if (changes.kind === 'passenger') {
    const pax = Math.max(1, Number(changes.passengers) || 1);
    lines.push({ label: `${pax} × add traveller (3JN admin fee)`, amountGbp: round2(OPERATOR_FEES.addPassengerGbp * pax) });
    lines.push({ label: isLive ? 'Additional airline fare (confirmed at re-issue)' : 'Additional fare', amountGbp: 0, deferred: isLive });
  } else if (changes.kind === 'nights') {
    if (!hotel) return { ok: false, error: 'no-hotel' };
    const n = Math.max(1, Number(changes.nights) || 1);
    const rooms = hotel.details?.rooms || 1;
    const nightlyGbp = usdToGbp(hotel.details?.nightlyUSD || (hotel.priceUSD / Math.max(1, hotel.details?.nights || 1)));
    lines.push({ label: `${n} extra night${n > 1 ? 's' : ''} × ${rooms} room${rooms > 1 ? 's' : ''} @ ${sym}${nightlyGbp}/night`, amountGbp: round2(nightlyGbp * n * rooms) });
  } else if (changes.kind === 'room') {
    if (!hotel) return { ok: false, error: 'no-hotel' };
    const nights = hotel.details?.nights || 1;
    const rooms = hotel.details?.rooms || 1;
    const nightlyGbp = usdToGbp(hotel.details?.nightlyUSD || (hotel.priceUSD / Math.max(1, nights)));
    lines.push({ label: 'Room upgrade service fee', amountGbp: OPERATOR_FEES.roomUpgradeGbp });
    lines.push({ label: `Upgraded room rate (+25% × ${nights} night${nights > 1 ? 's' : ''})`, amountGbp: round2(nightlyGbp * 0.25 * nights * rooms) });
  } else if (changes.kind === 'board') {
    if (!hotel) return { ok: false, error: 'no-hotel' };
    const upliftPct = BOARD_UPGRADE[changes.board] || 0.16;
    const nights = hotel.details?.nights || 1;
    const rooms = hotel.details?.rooms || 1;
    const nightlyGbp = usdToGbp(hotel.details?.nightlyUSD || (hotel.priceUSD / Math.max(1, nights)));
    lines.push({ label: `${changes.board || 'Board upgrade'} (${Math.round(upliftPct * 100)}% × ${nights} night${nights > 1 ? 's' : ''})`, amountGbp: round2(nightlyGbp * upliftPct * nights * rooms) });
  } else {
    return { ok: false, error: 'unknown-change' };
  }

  const totalExtraGbp = round2(lines.reduce((s, l) => s + (l.deferred ? 0 : l.amountGbp), 0));
  const hasDeferred = lines.some((l) => l.deferred);
  return {
    ok: true,
    quote: {
      kind: changes.kind, changes, symbol: sym, lines,
      totalExtraGbp, hasDeferred, isLive,
      description: describeChange(changes),
    },
  };
}

// Apply a confirmed change to the booking object (mutates it) and return a
// summary. Does NOT record payment/notifications — the store wraps that.
export function applyChange(booking, quote) {
  const changes = quote.changes;
  const flight = firstOfType(booking, 'flight');
  const hotel = firstOfType(booking, 'hotel') || firstOfType(booking, 'host');
  if (changes.kind === 'date') {
    // Move the whole trip: flight legs + any dated stay/transfer components.
    if (flight?.details?.outbound) flight.details.outbound.date = changes.newDate;
    if (flight?.details?.inbound && changes.newReturnDate) flight.details.inbound.date = changes.newReturnDate;
    for (const c of booking.option?.components || []) {
      if (c.details?.checkIn) c.details.checkIn = changes.newDate;
      if (c.details?.checkOut && changes.newReturnDate) c.details.checkOut = changes.newReturnDate;
      if (c.details?.date && c.type !== 'flight') c.details.date = changes.newDate;
    }
  } else if (changes.kind === 'baggage' && flight?.details) {
    const bags = Math.max(1, Number(changes.bags) || 1);
    flight.details.baggage = `${flight.details.baggage || 'Cabin bag'} + ${bags} added checked bag${bags > 1 ? 's' : ''}`;
  } else if (changes.kind === 'passenger') {
    if (booking.option?.travellers) booking.option.travellers.total = (booking.option.travellers.total || 1) + (Number(changes.passengers) || 1);
  } else if (changes.kind === 'nights' && hotel?.details) {
    hotel.details.nights = (hotel.details.nights || 1) + Math.max(1, Number(changes.nights) || 1);
  } else if (changes.kind === 'room' && hotel?.details) {
    hotel.details.roomType = changes.roomType || 'Upgraded room';
  } else if (changes.kind === 'board' && hotel?.details) {
    hotel.details.board = changes.board || 'Half board';
  }
  return { kind: changes.kind, description: describeChange(changes) };
}

// Quote a cancellation refund from the booking's refund policy + payments.
export function quoteCancellation(booking) {
  if (!booking) return { ok: false, error: 'no-booking' };
  const sym = booking.option?.pricing?.symbol || '£';
  const paid = (booking.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const rp = booking.refundPolicy || {};
  // Refundable percentage from the policy. The real structure is a time-banded
  // platformFallback.refundSchedule ([{window, refundPct}]) selected by days to
  // travel — NOT a flat refundablePct/tiers (which never existed on the object,
  // so every cancellation used to quote £0 even for a fully-flexible booking).
  let pct = 0;
  if (typeof rp.refundablePct === 'number') {
    pct = rp.refundablePct; // honour an explicit supplier-normalised value if present
  } else {
    const sched = rp.platformFallback?.refundSchedule || [];
    if (sched.length) {
      // Days to travel from the booking's travel date (check-in / outbound leg).
      const travelISO = rp.travelDate
        || booking.option?.dates?.checkIn
        || (booking.option?.components || []).map((c) => c.details?.checkIn || c.details?.date || c.details?.outbound?.date).find(Boolean)
        || null;
      const days = travelISO ? Math.floor((Date.parse(travelISO) - Date.now()) / 86400000) : 30;
      const idx = days >= 30 ? 0 : days >= 15 ? 1 : days >= 7 ? 2 : Math.min(3, sched.length - 1);
      pct = sched[idx]?.refundPct ?? 0;
    }
  }
  pct = Math.max(0, Math.min(100, pct));
  const refundGbp = round2(paid * (pct / 100));
  return { ok: true, quote: { kind: 'cancel', symbol: sym, paidGbp: round2(paid), refundablePct: pct, refundGbp, nonRefundableGbp: round2(paid - refundGbp) } };
}

function describeChange(changes) {
  if (changes.kind === 'date') return `move your trip to ${changes.newDate}`;
  if (changes.kind === 'baggage') return `add ${Math.max(1, Number(changes.bags) || 1)} checked bag(s)`;
  if (changes.kind === 'passenger') return `add ${Math.max(1, Number(changes.passengers) || 1)} traveller(s)`;
  if (changes.kind === 'nights') return `add ${Math.max(1, Number(changes.nights) || 1)} night(s) to your stay`;
  if (changes.kind === 'room') return 'upgrade your room';
  if (changes.kind === 'board') return `upgrade to ${changes.board || 'a better board basis'}`;
  return 'update your booking';
}
