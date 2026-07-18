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
// price guarantee (fare-risk buffer + financing cost). Applies ONLY to the
// monthly/locked plan — never the pay-now cash headline (that stays the
// competitive number) and never a pay-in-full / instant fare.
// Default 0.08 (8%) so the guarantee is FUNDED from launch: it matches the
// assumed fare-rise (fareRiseAssumptionPct) so a locked fare that moves is
// absorbed by the margin, not 3JN cash. Override with LOCK_MARGIN_PCT.
export function lockMarginPct() { return Math.max(0, Math.min(0.25, num(env.LOCK_MARGIN_PCT, 0.08))); }

// Ceiling on 3JN's OWN capital committed ahead of the customer paying for it.
// £0 (default) = never front — the safe launch posture with no credit facility.
export function autoFrontCapGbp() { return Math.max(0, num(env.AUTO_FRONT_CAP_GBP, 0)); }

// Assumed short-window airfare volatility — how much a locked fare could RISE
// between now and when ops secures it. This is the honest size of the price
// guarantee's downside: if the live fare at securing exceeds the locked price by
// more than the margin buffer, 3JN wears the difference (or, per the fare-rise
// clause, a capped, disclosed surcharge applies). Default 8% is a reasonable
// economy short-window figure; set FARE_RISE_ASSUMPTION_PCT from your own data.
export function fareRiseAssumptionPct() { return Math.max(0, Math.min(0.5, num(env.FARE_RISE_ASSUMPTION_PCT, 0.08))); }

const gbp2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Pure margin breakdown for a base (cash) total — no mutation. Used to build the
// instalment (locked) figures for DISPLAY without touching the pay-now cash price:
//   { pct, cashTotal, margin, lockedTotal }
// At LOCK_MARGIN_PCT=0 this is a no-op: margin 0, lockedTotal === cashTotal.
export function lockMarginOn(baseLocal) {
  const pct = lockMarginPct();
  const cashTotal = gbp2(baseLocal);
  const margin = gbp2(cashTotal * pct);
  return { pct, cashTotal, margin, lockedTotal: gbp2(cashTotal + margin) };
}

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
  // The price-guarantee downside on a locked (not-yet-secured) flight: the fare
  // could RISE before ops secures it. Money already collected to absorb that is
  // the lock margin; anything the assumed rise exceeds the margin is UNFUNDED —
  // real cash 3JN would wear (or recover via the capped fare-rise clause). With
  // LOCK_MARGIN_PCT=0 this is NOT zero — that was the old model's blind spot.
  const marginBuffer = gbp2(net * lockMarginPct());
  const assumedRise = gbp2(net * fareRiseAssumptionPct());
  const scheduled = ful.ticketing === 'lock-scheduled' ? gbp2(Math.max(0, assumedRise - marginBuffer)) : 0;
  const depositHeld = gbp2((booking?.payments || []).filter((p) => p.type === 'deposit').reduce((s, p) => s + (Number(p.amount) || 0), 0));
  return {
    bookingId: booking?.id, ticketing: ful.ticketing || 'confirmed',
    netCostGbp: net, paidGbp: paid, frontedGbp: fronted, fareRiskGbp: scheduled,
    marginBufferGbp: ful.ticketing === 'lock-scheduled' ? marginBuffer : 0,
    assumedRiseGbp: ful.ticketing === 'lock-scheduled' ? assumedRise : 0,
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
    marginBufferGbp: sum('marginBufferGbp'), // collected to absorb fare rises
    assumedRiseGbp: sum('assumedRiseGbp'),   // total assumed rise across locked flights
    frontCapGbp: autoFrontCapGbp(),
    lockMarginPct: lockMarginPct(),
    fareRiseAssumptionPct: fareRiseAssumptionPct(),
    // Is the price guarantee funded? True when the margin ≥ the assumed rise on
    // every locked flight (fareRiskGbp rolls up to ~0).
    guaranteeFunded: sum('fareRiskGbp') <= 0.01,
  };
}
