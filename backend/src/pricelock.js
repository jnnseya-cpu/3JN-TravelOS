// Guaranteed Holiday Lock™ — the engine behind "Book today, pay monthly, price
// guaranteed."  PURE (no I/O) so every rule is unit-testable without Duffel/Stripe.
//
// The commercial reality (see the tour-operator model):
//   • The SELL price is fixed at booking and never rises — funded by a LOCK MARGIN
//     baked into the price (covers fare movement + financing cost), NOT by holding
//     a live airline seat for months (airlines don't allow that).
//   • Flights are secured one of two honest ways, decided per booking:
//       – ticket-at-deposit  — when the paid deposit already covers the flight's
//         net cost, 3JN buys the ticket now (price locked because it's bought;
//         the DEPOSIT funds it, so 3JN fronts nothing). This is the loveholidays
//         low-deposit model.
//       – lock-scheduled     — otherwise the price is locked but the ticket is
//         secured closer to departure (re-priced live within the margin, or by the
//         ops desk via a consolidator). 3JN's exposure is only the fare MOVEMENT,
//         bounded by the margin + non-refundable deposit — never the whole fare.
//   • AUTO_FRONT_CAP_GBP caps how much of 3JN's OWN cash may ever be committed
//     ahead of the customer's money. Default £0 = never front (zero credit risk):
//     a flight tickets at deposit only when the deposit covers it, else it waits.

const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// The lock margin (fraction) folded into an INSTALMENT sell price to fund the
// price guarantee (fare-risk buffer + financing cost). Configurable; a modest
// default keeps the price competitive while funding the guarantee.
// Default 0 (OFF) so launch prices stay competitive for a like-for-like market
// comparison and there is never a surprise jump at checkout. Set LOCK_MARGIN_PCT
// (e.g. 0.06) to fund the guarantee once you decide the pricing — ideally also
// reflected in the search/quote price so the displayed price is what's booked.
export function lockMarginPct() { return Math.max(0, Math.min(0.25, num(env.LOCK_MARGIN_PCT, 0))); }

// Ceiling on 3JN's OWN capital committed ahead of the customer paying for it.
// £0 (default) = never front — the safe launch posture with no credit facility.
export function autoFrontCapGbp() { return Math.max(0, num(env.AUTO_FRONT_CAP_GBP, 0)); }

const gbp2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Apply the lock margin to an option's sell price IN PLACE (total, USD, and a
// visible line) so the deposit, instalments, full-payment amount and document all
// reflect the guaranteed price. Only for instalment bookings — a pay-in-full
// customer needs no guarantee funded. Idempotent via option.pricing.lockMargin.
export function applyLockMargin(option, { hasInstalments, rateFromUSD = 0.79 } = {}) {
  if (!option || !hasInstalments) return option;
  const pct = lockMarginPct();
  if (pct <= 0) return option;
  option.pricing = option.pricing || {}; option.pricing.local = option.pricing.local || {};
  if (option.pricing.lockMargin) return option; // already applied
  const base = Number(option.pricing.local.total) || 0;
  const marginLocal = gbp2(base * pct);
  const marginUSD = gbp2((Number(option.totalUSD) || 0) * pct);
  option.pricing.local.total = gbp2(base + marginLocal);
  option.pricing.local.lockMargin = marginLocal;
  option.totalUSD = gbp2((Number(option.totalUSD) || 0) + marginUSD);
  option.pricing.lockMargin = { pct, local: marginLocal, usd: marginUSD };
  return option;
}

// The committed NET cost of the flight (what the supplier must be paid to ticket)
// in the booking's display currency. Prefers the real live amount; falls back to
// the USD-based figure. Used to decide whether a deposit covers the flight.
export function flightNetCostGbp(booking, rateFromUSD = 0.79) {
  const f = (booking?.option?.components || []).find((c) => c.type === 'flight');
  if (!f) return 0;
  const d = f.details || {};
  // Live Duffel amount is already in the offer currency; when that's the display
  // currency use it directly, otherwise convert the USD figure.
  const code = (booking?.option?.pricing?.code || 'GBP').toUpperCase();
  if (d.liveAmount != null && String(d.liveCurrency || '').toUpperCase() === code) return gbp2(d.liveAmount);
  const usd = Number(d.priceUSD || f.priceUSD || 0);
  return gbp2(usd * (rateFromUSD || 0.79));
}

// Total paid on a booking so far (deposit + instalments), in display currency.
export function paidToDate(booking) {
  return gbp2((booking?.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
}

// Decide how to secure the flight given what's been paid. Returns:
//   { action: 'ticket-now' } when the deposit already covers the flight net cost
//       (within the auto-front cap) — buy the ticket immediately.
//   { action: 'lock-scheduled', gapGbp } when it doesn't — lock the price, secure
//       later; gapGbp is the shortfall 3JN would have to front (only allowed up to
//       the front cap).
export function flightSecuringPlan(booking, { rateFromUSD = 0.79 } = {}) {
  const net = flightNetCostGbp(booking, rateFromUSD);
  const paid = paidToDate(booking);
  const cap = autoFrontCapGbp();
  const gap = gbp2(Math.max(0, net - paid));
  if (net <= 0) return { action: 'lock-scheduled', gapGbp: 0, netGbp: 0, paidGbp: paid };
  // Ticket now when the customer's money already covers the fare, OR the shortfall
  // is within the amount 3JN is permitted to front.
  if (gap <= cap + 0.01) return { action: 'ticket-now', gapGbp: gap, netGbp: net, paidGbp: paid };
  return { action: 'lock-scheduled', gapGbp: gap, netGbp: net, paidGbp: paid };
}

// Capital 3JN has AT RISK on a single booking: the committed supplier cost not yet
// covered by the customer's payments (only ever > 0 when a fare was fronted, or a
// lock-scheduled flight is being secured before the balance is in). The deposit is
// non-refundable, so real exposure is further reduced by it — reported separately.
export function bookingExposure(booking, { rateFromUSD = 0.79 } = {}) {
  const ful = booking?.fulfilment || {};
  const net = flightNetCostGbp(booking, rateFromUSD);
  const paid = paidToDate(booking);
  const ticketed = ful.ticketing === 'issued' || ful.ticketing === 'held';
  // Fronted = supplier cost we've committed beyond the customer's payments.
  const fronted = ticketed ? gbp2(Math.max(0, net - paid)) : 0;
  // Scheduled = a locked flight not yet secured; the fare-MOVEMENT risk (bounded by
  // the lock margin), not the whole fare, since the customer keeps paying.
  const scheduled = ful.ticketing === 'lock-scheduled' ? gbp2(net * lockMarginPct()) : 0;
  const depositHeld = gbp2((booking?.payments || []).filter((p) => p.type === 'deposit').reduce((s, p) => s + (Number(p.amount) || 0), 0));
  return {
    bookingId: booking?.id, ticketing: ful.ticketing || 'confirmed',
    netCostGbp: net, paidGbp: paid, frontedGbp: fronted, fareRiskGbp: scheduled,
    depositHeldGbp: depositHeld,
    atRiskGbp: gbp2(fronted + scheduled), // capital genuinely at risk right now
  };
}

// Portfolio roll-up across many bookings — what the operator watches so exposure
// is MANAGED, not hoped. `bookings` is the live booking list.
export function portfolioExposure(bookings, { rateFromUSD = 0.79 } = {}) {
  const rows = (Array.isArray(bookings) ? bookings : [])
    .filter((b) => b && b.instalment && b.status !== 'cancelled')
    .map((b) => bookingExposure(b, { rateFromUSD }));
  const sum = (k) => gbp2(rows.reduce((s, r) => s + (r[k] || 0), 0));
  return {
    bookings: rows.length,
    frontedGbp: sum('frontedGbp'),      // 3JN's own cash committed ahead of payment
    fareRiskGbp: sum('fareRiskGbp'),    // movement risk on lock-scheduled flights
    depositsHeldGbp: sum('depositHeldGbp'),
    atRiskGbp: sum('atRiskGbp'),
    // Net exposure after the non-refundable deposits that cushion a default.
    netAtRiskGbp: gbp2(Math.max(0, sum('atRiskGbp') - sum('depositHeldGbp'))),
    frontCapGbp: autoFrontCapGbp(),
    lockMarginPct: lockMarginPct(),
  };
}
