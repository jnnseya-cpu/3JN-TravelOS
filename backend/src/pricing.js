// Pricing, commission, savings-share, loyalty, instalments and ACU costing.
//
// Everything internally is computed in USD then converted to the traveller's
// currency for presentation, so the maths stays consistent.

// Canonical economic constants live in shared/ so the frontend and backend
// share one source of truth. Re-exported here for existing call sites.
import {
  COMMISSION_RATE, SAVINGS_SHARE_RATE, SAVINGS_SHARE_MIN_USD, LOYALTY_TIERS, POINTS_PER_USD, SIGNUP_BONUS_POINTS,
} from '../../shared/constants.js';

export { COMMISSION_RATE, SAVINGS_SHARE_RATE, LOYALTY_TIERS, POINTS_PER_USD, SIGNUP_BONUS_POINTS };

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
// full 10% margin. GBP fees are converted to USD internally at £1≈$1.27.
export const DUFFEL_FEES = {
  orderGBP: 2.20,            // per confirmed order
  managedContentPct: 0.01,  // 1% of total order value
  ancillaryGBP: 1.45,       // per paid ancillary
  excessSearchGBP: 0.004,   // per search beyond the 1500:1 search-to-book ratio
  searchToBookRatio: 1500,
};
const GBP_USD = 1.27;
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

export function priceBreakdown({ componentsUSD, marketRefUSD, currency, loyaltyPoints = 0, duffelOrder = false, ancillaries = 0 }) {
  const tier = tierForPoints(loyaltyPoints);
  const loyaltyDiscountUSD = componentsUSD * tier.discount;
  const netComponentsUSD = componentsUSD - loyaltyDiscountUSD;

  const commissionUSD = netComponentsUSD * COMMISSION_RATE;
  // Duffel pass-through — added ON TOP of commission on a live Duffel order so
  // our supplier cost never erodes the 10% margin. Zero on non-Duffel bookings.
  const preFeeTotalUSD = netComponentsUSD + commissionUSD;
  const duffelFees = duffelOrder ? duffelOrderFeesUSD({ orderValueUSD: preFeeTotalUSD, ancillaries }) : { orderUSD: 0, managedContentUSD: 0, ancillariesUSD: 0, totalUSD: 0 };
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
    lines: {
      suppliersUSD: round2(componentsUSD),
      loyaltyDiscountUSD: round2(loyaltyDiscountUSD),
      netSuppliersUSD: round2(netComponentsUSD),
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
      commission: conv(commissionUSD),
      duffelFee: conv(duffelFeeUSD),
      total: conv(totalUSD),
      marketRef: conv(marketRefUSD),
      savingsVsMarket: conv(savingsVsMarketUSD),
    },
    // 3JN's earnings on this package (internal — shown in admin/dev view).
    revenue: {
      commissionUSD: round2(commissionUSD),
      savingsShareUSD: round2(savingsShareUSD),
      totalUSD: round2(commissionUSD + savingsShareUSD),
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
