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
export function priceBreakdown({ componentsUSD, marketRefUSD, currency, loyaltyPoints = 0 }) {
  const tier = tierForPoints(loyaltyPoints);
  const loyaltyDiscountUSD = componentsUSD * tier.discount;
  const netComponentsUSD = componentsUSD - loyaltyDiscountUSD;

  const commissionUSD = netComponentsUSD * COMMISSION_RATE;
  const totalUSD = netComponentsUSD + commissionUSD;

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
      totalUSD: round2(totalUSD),
      marketRefUSD: round2(marketRefUSD),
      savingsVsMarketUSD: round2(savingsVsMarketUSD),
    },
    local: {
      suppliers: conv(componentsUSD),
      loyaltyDiscount: conv(loyaltyDiscountUSD),
      commission: conv(commissionUSD),
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

// ---- Booking Protection (optional add-on) -----------------------------------
// £5–£50 scaled to trip value (~2%), covering: price-drop monitoring priority,
// booking mistake check, refund guidance, flight disruption support, document
// checklist review and visa deadline alerts.
export const PROTECTION_BENEFITS = [
  'Priority price-drop monitoring (instant rebook)',
  'Booking mistake check (names, dates, routes)',
  'Refund guidance end-to-end',
  'Flight disruption support (auto-rebooking priority)',
  'Document checklist review before travel',
  'Visa deadline alerts',
];
export function protectionFee(totalLocal) {
  const fee = Math.max(5, Math.min(50, Math.round(totalLocal * 0.02)));
  return { fee, benefits: PROTECTION_BENEFITS };
}
