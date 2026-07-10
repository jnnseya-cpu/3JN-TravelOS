// Pricing, commission, savings-share, loyalty, instalments and ACU costing.
//
// Everything internally is computed in USD then converted to the traveller's
// currency for presentation, so the maths stays consistent.

// Canonical economic constants live in shared/ so the frontend and backend
// share one source of truth. Re-exported here for existing call sites.
import {
  COMMISSION_RATE, SAVINGS_SHARE_RATE, SAVINGS_SHARE_MIN_USD, LOYALTY_TIERS, POINTS_PER_USD, SIGNUP_BONUS_POINTS,
  FLIGHT_ONLY_FEE_GBP, FLIGHT_ONLY_MEMBER_FREE,
} from '../../shared/constants.js';

export { COMMISSION_RATE, SAVINGS_SHARE_RATE, LOYALTY_TIERS, POINTS_PER_USD, SIGNUP_BONUS_POINTS, FLIGHT_ONLY_FEE_GBP };

export function tierForPoints(points = 0) {
  let tier = LOYALTY_TIERS[0];
  for (const t of LOYALTY_TIERS) if (points >= t.minPoints) tier = t;
  return tier;
}

export function usdToLocal(usd, currency) {
  return Math.round(usd * currency.rateFromUSD * 100) / 100;
}

export function formatMoney(localAmount, currency) {
  const n = Number(localAmount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency.symbol}${n}`;
}

// Build the transparent price breakdown for a package, in the traveller's
// currency. `componentsUSD` is the raw supplier subtotal. `marketRefUSD` is the
// public/expected price we compare against to surface savings.
// ---- Duffel pass-through fees (recovered ON TOP of 3JN commission) ----------
// Duffel charges us per confirmed order — these are OUR supplier costs, so we
// add them to the customer total on live Duffel flight bookings, preserving the
// full 10% margin. GBP fees convert to USD at the SINGLE platform anchor
// (0.79 GBP/USD → £1≈$1.266), not a separate ~1.27 rate, so every internal
// GBP↔USD conversion in the OS is consistent and reciprocal.
export const DUFFEL_FEES = {
  orderGBP: 2.20,            // per confirmed order
  managedContentPct: 0.01,  // 1% of total order value
  ancillaryGBP: 1.45,       // per paid ancillary
  excessSearchGBP: 0.004,   // per search beyond the 1500:1 search-to-book ratio
  searchToBookRatio: 1500,
};
const GBP_USD = 1 / 0.79; // platform anchor reciprocal (≈1.266), consistent everywhere
// Per-order Duffel cost we recover on a live flight booking.
export function duffelOrderFeesUSD({ orderValueUSD = 0, ancillaries = 0 } = {}) {
  const orderUSD = DUFFEL_FEES.orderGBP * GBP_USD;
  const managedUSD = orderValueUSD * DUFFEL_FEES.managedContentPct;
  const ancUSD = Math.max(0, ancillaries) * DUFFEL_FEES.ancillaryGBP * GBP_USD;
  const totalUSD = orderUSD + managedUSD + ancUSD;
  return {
    orderUSD: round2(orderUSD),
    managedContentUSD: round2(managedUSD),
    ancillariesUSD: round2(ancUSD),
    totalUSD: round2(totalUSD),
  };
}

export function priceBreakdown({ componentsUSD, marketRefUSD, currency, loyaltyPoints = 0, duffelOrder = false, ancillaries = 0, flightsOnly = false, memberActive = false, duffelOrderValueUSD = null }) {
  const tier = tierForPoints(loyaltyPoints);

  // TIERED TAKE-RATE: a flights-only booking pays a small FLAT fee (free for
  // active Travel+ members) instead of 10%, so our flight price stands level
  // with the metasearch sites. Packages/hotels/extras keep the 10% — that is
  // where the margin lives, invisible inside a bundle that beats DIY totals.
  // Convert with the platform's 0.79 GBP anchor (not the 1.27 card-fee rate)
  // so a £4.99 fee displays as EXACTLY £4.99 after the USD round-trip.
  const flightFlatUSD = memberActive && FLIGHT_ONLY_MEMBER_FREE ? 0 : FLIGHT_ONLY_FEE_GBP / 0.79;
  const grossCommissionUSD = flightsOnly ? flightFlatUSD : componentsUSD * COMMISSION_RATE;

  // LOYALTY DISCOUNT is funded ENTIRELY out of 3JN's commission and is CAPPED at
  // it — it is NEVER taken off the supplier-cost base. The full supplier cost is
  // always collected, so a package reaches break-even at the top tier but is
  // NEVER sold below what we pay the airline/hotel. (The old model discounted the
  // supplier base too, so an Elite 10% package actually sold at a ~1% LOSS while
  // still reporting a positive "commission".) The monthly membership fee funds
  // the giveaway. Flights-only takes no fare discount — active members already
  // fly fee-free, and there is no 10% margin to give back on a flat fee.
  const loyaltyDiscountUSD = flightsOnly ? 0 : Math.min(componentsUSD * tier.discount, grossCommissionUSD);
  const commissionUSD = grossCommissionUSD - loyaltyDiscountUSD; // what 3JN actually keeps
  const netComponentsUSD = componentsUSD; // supplier cost is always collected in full

  const feeModel = flightsOnly ? (grossCommissionUSD === 0 ? 'flight-flat-member-free' : 'flight-flat') : 'commission-10';
  const feeLabel = flightsOnly
    ? (grossCommissionUSD === 0 ? '3JN flight fee — FREE (Travel+ member)' : `3JN flight service fee (flat £${FLIGHT_ONLY_FEE_GBP.toFixed(2)})`)
    : '3JN commission (10%)';
  // Duffel pass-through — added ON TOP on a live Duffel order so our supplier
  // cost never erodes the margin. Zero on non-Duffel bookings. Customer price =
  // full supplier cost + our post-loyalty commission + Duffel fees.
  const preFeeTotalUSD = netComponentsUSD + commissionUSD;
  // Duffel's 1% managed-content fee applies to the FLIGHT ORDER VALUE only —
  // the amount that actually passes through Duffel — never to hotels or
  // activities riding in the same package. Pass-through at cost, no margin.
  const duffelBaseUSD = duffelOrderValueUSD != null ? duffelOrderValueUSD : preFeeTotalUSD;
  const duffelFees = duffelOrder ? duffelOrderFeesUSD({ orderValueUSD: duffelBaseUSD, ancillaries }) : { orderUSD: 0, managedContentUSD: 0, ancillariesUSD: 0, totalUSD: 0 };
  const duffelFeeUSD = duffelFees.totalUSD;
  const totalUSD = preFeeTotalUSD + duffelFeeUSD;

  const savingsVsMarketUSD = Math.max(0, marketRefUSD - totalUSD);
  // Savings-share model: "save more than £100 and we charge 10% of the saving"
  // — charged ONLY above the threshold; smaller savings are entirely the
  // customer's. Booking commission applies regardless.
  const savingsShareUSD = savingsVsMarketUSD > SAVINGS_SHARE_MIN_USD
    ? savingsVsMarketUSD * SAVINGS_SHARE_RATE
    : 0;

  const conv = (usd) => usdToLocal(usd, currency);

  return {
    currency: currency.code,
    symbol: currency.symbol,
    loyaltyTier: tier.name,
    loyaltyDiscountPct: tier.discount,
    feeModel,
    feeLabel,
    lines: {
      suppliersUSD: round2(componentsUSD),
      loyaltyDiscountUSD: round2(loyaltyDiscountUSD),
      netSuppliersUSD: round2(netComponentsUSD),
      // gross = the full 10% (or flat fee) shown on the receipt; commission = our
      // real take after the loyalty rebate. suppliers − loyaltyDiscount + gross
      // commission = total, and commission is what we actually keep.
      grossCommissionUSD: round2(grossCommissionUSD),
      commissionUSD: round2(commissionUSD),
      duffelFeeUSD: round2(duffelFeeUSD),
      totalUSD: round2(totalUSD),
      marketRefUSD: round2(marketRefUSD),
      savingsVsMarketUSD: round2(savingsVsMarketUSD),
    },
    duffelFees,
    local: {
      suppliers: conv(componentsUSD),
      loyaltyDiscount: conv(loyaltyDiscountUSD),
      grossCommission: conv(grossCommissionUSD),
      commission: conv(commissionUSD),
      duffelFee: conv(duffelFeeUSD),
      total: conv(totalUSD),
      marketRef: conv(marketRefUSD),
      savingsVsMarket: conv(savingsVsMarketUSD),
    },
    // 3JN's earnings on this package (internal — shown in admin/dev view).
    // savingsShare is NOT added to the customer total anywhere, so it is not
    // collected — reporting it as revenue overstated income. It stays visible
    // as an eligibility figure but revenue.totalUSD counts only what we
    // actually charge (the commission / flat fee). Re-enable when a REAL
    // observed market price (not the synthetic marketRef) backs the saving.
    revenue: {
      commissionUSD: round2(commissionUSD),
      savingsShareUSD: round2(savingsShareUSD),
      savingsShareCollected: false,
      totalUSD: round2(commissionUSD),
    },
    totals: {
      totalUSD: round2(totalUSD),
      totalLocal: conv(totalUSD),
    },
  };
}

// Deposit + instalment schedule. Deposit defaults to 20%, remainder split over
// `months` equal, interest-free payments ending before departure.
export function instalmentPlan({ totalLocal, currency, months = 3, depositPct = 0.2, checkIn }) {
  const deposit = round2(totalLocal * depositPct);
  const remainder = round2(totalLocal - deposit);
  const perMonth = round2(remainder / months);

  // Schedule monthly payments counting back from ~2 weeks before departure.
  const schedule = [];
  const depart = checkIn ? new Date(checkIn + 'T00:00:00Z') : null;
  for (let i = 0; i < months; i++) {
    let dueLabel = `Month ${i + 1}`;
    if (depart) {
      const due = new Date(depart);
      due.setUTCDate(due.getUTCDate() - 14 - (months - 1 - i) * 30);
      dueLabel = due.toISOString().slice(0, 10);
    }
    // Last instalment absorbs any rounding remainder.
    const amount = i === months - 1 ? round2(remainder - perMonth * (months - 1)) : perMonth;
    schedule.push({ due: dueLabel, amount, status: 'scheduled' });
  }

  return {
    currency: currency.code,
    symbol: currency.symbol,
    depositPct,
    deposit,
    remainder,
    months,
    interestRate: 0,
    schedule,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---- Booking Protection (Revenue Source 7, optional add-on) ------------------
// £5–£50 scaled to trip value (~2%), covering the five protection services:
// price-drop monitoring, refund support, travel alerts, disruption assistance
// and document validation (plus the booking mistake check).
export const PROTECTION_BENEFITS = [
  'Price-drop monitoring (priority instant rebook)',
  'Refund support end-to-end',
  'Travel alerts (visa deadlines, entry-rule changes)',
  'Disruption assistance (auto-rebooking priority)',
  'Document validation before travel',
  'Booking mistake check (names, dates, routes)',
];
export function protectionFee(totalLocal) {
  const fee = Math.max(5, Math.min(50, Math.round(totalLocal * 0.02)));
  return { fee, benefits: PROTECTION_BENEFITS };
}
