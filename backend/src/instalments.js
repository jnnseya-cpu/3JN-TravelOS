// AI Smart Instalment Payment Engine — "Flexible. Fair. Protected."
//
// Core principles (docs/INSTALMENT-ENGINE.md):
//   - Lower deposit + more instalments the further ahead the booking is made;
//     higher deposit + fewer instalments last-minute.
//   - Final payment is ALWAYS due no later than 7 days before departure.
//   - Deposits are strictly NON-REFUNDABLE once the booking is confirmed —
//     they secure the booking, lock the fare and cover processing costs.
//   - The customer may pay the remaining balance at ANY time without penalty.
//   - A missed instalment starts an AI-managed grace period; still unpaid
//     after grace → the booking auto-cancels and the deposit is forfeited.
//     Any refundable balance (excluding the deposit) follows supplier rules.
//   - The AI risk engine adjusts deposit, instalment count and eligibility
//     per customer before a plan is offered.

const round2 = (n) => Math.round(n * 100) / 100;

export const FINAL_PAYMENT_DAYS = 7; // hard rule: settled ≥7 days pre-departure
export const INSTALMENT_GRACE_HOURS = Number(process.env.INSTALMENT_GRACE_HOURS) || 48;
export const SUPPLIER_MIN_DEPOSIT_PCT = 0.10; // no plan may dip below this

// The ten date-banded plans. `schedule` entries are [daysBeforeDeparture, pct];
// the deposit is charged at booking. Percentages per band sum to exactly 100%.
export const INSTALMENT_TIERS = [
  { minDays: 181, maxDays: Infinity, name: 'Ultimate Flex', depositPct: 0.10, schedule: [[150, 0.15], [120, 0.15], [90, 0.15], [60, 0.15], [30, 0.15], [7, 0.15]] },
  { minDays: 121, maxDays: 180, name: 'Premium Flex', depositPct: 0.15, schedule: [[90, 0.20], [60, 0.20], [30, 0.20], [7, 0.25]] },
  { minDays: 91, maxDays: 120, name: 'Smart Plan', depositPct: 0.20, schedule: [[60, 0.25], [30, 0.25], [7, 0.30]] },
  { minDays: 61, maxDays: 90, name: 'Easy Plan', depositPct: 0.30, schedule: [[30, 0.30], [7, 0.40]] },
  { minDays: 46, maxDays: 60, name: 'Express Plan', depositPct: 0.40, schedule: [[21, 0.30], [7, 0.30]] },
  { minDays: 31, maxDays: 45, name: 'Quick Plan', depositPct: 0.50, schedule: [[14, 0.25], [7, 0.25]] },
  { minDays: 22, maxDays: 30, name: 'Priority Plan', depositPct: 0.60, schedule: [[7, 0.40]] },
  { minDays: 15, maxDays: 21, name: 'Last-Minute Flex', depositPct: 0.75, schedule: [[7, 0.25]] },
  { minDays: 8, maxDays: 14, name: 'Rapid Plan', depositPct: 0.90, schedule: [[7, 0.10]] },
  { minDays: 0, maxDays: 7, name: 'Instant Booking', depositPct: 1.00, schedule: [] },
];

export function daysUntil(departISO, todayISO) {
  const d = new Date(String(departISO) + 'T00:00:00Z');
  const t = new Date(String(todayISO) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || Number.isNaN(t.getTime())) return null;
  return Math.round((d - t) / 86400000);
}

export function tierForDeparture(departISO, todayISO) {
  const days = daysUntil(departISO, todayISO);
  if (days == null || days < 0) return null;
  return INSTALMENT_TIERS.find((t) => days >= t.minDays && days <= t.maxDays) || null;
}

// ---- AI Risk-Based Instalment Engine ----------------------------------------
// Deterministic scoring over the signals the spec names: payment history,
// identity verification, chargeback/fraud flags, booking value, destination &
// supplier risk, time to departure, product type, cancellations/no-shows.
// Higher score = higher risk. Bands drive automatic plan adjustments.
export function assessInstalmentRisk({
  user = null,
  history = { paidBookings: 0, cancelled: 0, noShows: 0, chargebacks: 0 },
  totalGbp = 0,
  daysToDeparture = 0,
  destRisk = 'normal', // 'normal' | 'elevated' (advisory / high-fraud corridor)
  productTypes = [],
} = {}) {
  const factors = [];
  let score = 0;
  const add = (pts, why) => { score += pts; factors.push({ points: pts, factor: why }); };

  if (!user) add(25, 'No account — guest checkout has no payment history');
  else {
    if ((history.paidBookings || 0) === 0) add(15, 'First booking with 3JN');
    if ((history.paidBookings || 0) >= 3 && !(history.cancelled || history.noShows)) add(-10, 'Trusted repeat customer — 3+ paid bookings, clean record');
    const idComplete = !!(user.travelProfile?.fullLegalName && (user.travelProfile?.passportNumber || user.travelProfile?.dob));
    if (idComplete) add(-5, 'Identity details verified on profile');
    else add(10, 'Identity not yet verified');
  }
  if ((history.chargebacks || 0) > 0) add(30, 'Previous chargeback on record');
  const cancels = (history.cancelled || 0) + (history.noShows || 0);
  if (cancels > 0) add(Math.min(30, cancels * 15), `${cancels} previous cancellation/no-show${cancels > 1 ? 's' : ''}`);
  if (totalGbp > 5000) add(15, 'High-value booking (>£5,000)');
  else if (totalGbp > 2000) add(8, 'Elevated booking value (>£2,000)');
  if (daysToDeparture <= 21) add(10, 'Short runway to departure');
  if (destRisk === 'elevated') add(10, 'Destination/supplier risk elevated');
  if (productTypes.includes('cruise') || productTypes.includes('visa')) add(5, 'Product carries strict supplier penalties');

  const band = score >= 60 ? 'declined' : score >= 40 ? 'high' : score >= 20 ? 'medium' : 'low';
  const trusted = score <= 5 && (history.paidBookings || 0) >= 3;
  const adjustments = {
    // Deposit moves with risk, subject to the supplier minimum floor.
    depositDelta: band === 'high' ? 0.15 : band === 'medium' ? 0.05 : trusted ? -0.05 : 0,
    // High risk also caps how many instalments we extend.
    maxInstalments: band === 'high' ? 2 : band === 'medium' ? 4 : Infinity,
    requireIdCheck: band === 'high' || band === 'declined',
    declined: band === 'declined',
  };
  return { score, band, trusted, factors, adjustments };
}

// ---- Plan builder ------------------------------------------------------------
// Returns null when departure is unknown/past. For 0–7 days (or a declined risk
// band) the plan is 'Instant Booking': 100% at booking, no instalments.
export function buildSmartInstalmentPlan({ totalLocal, currency, departISO, todayISO, risk = null }) {
  const today = todayISO || new Date().toISOString().slice(0, 10);
  const tier = tierForDeparture(departISO, today);
  if (!tier || !(totalLocal > 0)) return null;
  const days = daysUntil(departISO, today);

  const declined = !!risk?.adjustments?.declined;
  const effectiveTier = declined ? INSTALMENT_TIERS[INSTALMENT_TIERS.length - 1] : tier;

  // Risk-adjusted deposit: never below the supplier minimum, never above 100%.
  let depositPct = Math.min(1, Math.max(SUPPLIER_MIN_DEPOSIT_PCT, effectiveTier.depositPct + (risk?.adjustments?.depositDelta || 0)));
  if (declined) depositPct = 1;

  // Risk-capped instalment count: keep the LAST maxN entries (closest to
  // departure — the 7-day final payment is sacred). The dropped percentages
  // are redistributed across the remaining instalments, NOT ballooned into
  // the deposit — fewer, larger instalments is the risk lever.
  let entries = [...effectiveTier.schedule];
  const maxN = risk?.adjustments?.maxInstalments ?? Infinity;
  if (entries.length > maxN) entries = entries.slice(entries.length - maxN);

  const depart = new Date(String(departISO) + 'T00:00:00Z');
  const deposit = round2(totalLocal * depositPct);
  const remainder = round2(totalLocal - deposit);
  // Allocate the REMAINDER across the kept instalments proportionally to
  // their tier weights — so a risk-adjusted deposit or a capped schedule can
  // never over- or under-allocate; the plan always sums to the total.
  const weightSum = entries.reduce((s, [, p]) => s + p, 0) || 1;
  const schedule = [];
  let allocated = 0;
  entries.forEach(([daysBefore, pct], i) => {
    const due = new Date(depart);
    due.setUTCDate(due.getUTCDate() - daysBefore);
    const last = i === entries.length - 1;
    // The final instalment absorbs rounding so the plan sums to the total exactly.
    const amount = last ? round2(remainder - allocated) : round2(remainder * (pct / weightSum));
    allocated = round2(allocated + amount);
    schedule.push({
      due: due.toISOString().slice(0, 10),
      daysBefore, pct,
      amount,
      final: last,
      status: 'scheduled',
    });
  });

  const finalDue = schedule.length ? schedule[schedule.length - 1].due : null;
  return {
    engine: 'ai-smart',
    plan: declined ? 'Instant Booking (instalments unavailable)' : effectiveTier.name,
    daysToDeparture: days,
    currency: currency.code,
    symbol: currency.symbol,
    depositPct: round2(depositPct),
    deposit,
    depositNonRefundable: true,
    remainder,
    months: schedule.length, // back-compat with older UI copy
    interestRate: 0,
    schedule,
    finalDue,
    finalRule: `Balance fully settled no later than ${FINAL_PAYMENT_DAYS} days before departure`,
    payEarlyAnytime: true,
    graceHours: INSTALMENT_GRACE_HOURS,
    risk: risk ? { band: risk.band, score: risk.score, requireIdCheck: risk.adjustments.requireIdCheck, factors: risk.factors.map((f) => f.factor) } : null,
  };
}

// ---- Instalment state machine -------------------------------------------------
// Cumulative view: how much SHOULD have been paid by `today` vs how much HAS
// been. Drives dunning: on-track → due → in-grace → defaulted.
export function instalmentState(booking, todayISO) {
  const inst = booking?.instalment;
  if (!inst || inst.engine !== 'ai-smart') return { status: 'not-smart-plan' };
  const today = todayISO || new Date().toISOString().slice(0, 10);
  const paid = (booking.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const total = round2(inst.deposit + inst.schedule.reduce((s, x) => s + x.amount, 0));
  if (paid + 0.01 >= total) return { status: 'settled', paid, total };

  let dueSoFar = inst.deposit;
  let earliestUnpaidDue = null;
  for (const item of inst.schedule) {
    if (item.due <= today) {
      dueSoFar = round2(dueSoFar + item.amount);
      if (paid + 0.01 < dueSoFar && !earliestUnpaidDue) earliestUnpaidDue = item.due;
    }
  }
  const overdueAmount = round2(Math.max(0, dueSoFar - paid));
  if (overdueAmount <= 0.01) {
    const next = inst.schedule.find((s) => s.due > today);
    return { status: 'on-track', paid, total, nextDue: next || null };
  }
  // Overdue: inside or past the grace window?
  const graceDeadline = new Date(new Date(earliestUnpaidDue + 'T00:00:00Z').getTime() + inst.graceHours * 3600000);
  const now = new Date(today + 'T00:00:00Z');
  const inGrace = now <= graceDeadline;
  return {
    status: inGrace ? 'in-grace' : 'defaulted',
    paid, total, overdueAmount,
    missedDue: earliestUnpaidDue,
    graceDeadline: graceDeadline.toISOString(),
  };
}

// Refund maths on default/cancellation: the deposit is forfeited by rule; the
// balance beyond the deposit is refundable per supplier cancellation policy
// (the booking's structured refundPolicy governs what actually returns).
export function defaultOutcome(booking) {
  const inst = booking?.instalment;
  const paid = (booking?.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const deposit = inst?.deposit || 0;
  return {
    forfeitedDeposit: round2(Math.min(paid, deposit)),
    refundableBalance: round2(Math.max(0, paid - deposit)),
    rule: 'Deposit is non-refundable; the remaining balance follows the supplier cancellation policy on this booking.',
  };
}
