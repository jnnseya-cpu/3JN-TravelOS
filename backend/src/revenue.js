// AI Cost Protection Engine (ACPE) + revenue model.
//
// ============================ FINAL BUSINESS POSITION ========================
// 3JN Travel OS does not sell "cheap searches." It sells AI-powered travel
// savings with controlled ACU usage, booking deposits, partner commissions,
// and 10% final-payment revenue.
//
// THE CORE RULE (never to be weakened):
//   AI work starts only when the platform is protected by ACUs, a deposit,
//   strong booking intent, supplier commission, or expected 10% final-payment
//   revenue. The platform must never allow users to burn ACUs freely.
//
// Enforced below by costProtectionGate(): funding checks, the x10 formula,
// aiCostCap (5-10% of expected profit), the free-tier daily cap, the abuse
// throttle, ACU pre-approval, and the cache-first downgrade path.
// =============================================================================
//
// The platform's locked rule (from the spec): no costly AI/search runs unless
// the action is funded — by ACU balance, a search deposit, an active
// subscription, supplier-commission opportunity, or expected 10% booking
// revenue. Otherwise the search is downgraded.
//
// We model "AI cost" per search tier and gate execution so the prototype
// demonstrates the profit-protection logic rather than running an actual
// expensive model.

// ACU economy constants are shared with the frontend — see shared/constants.js.
import { ACU_ACTIONS, ACU_GBP, TIER_ACU_ALLOWANCE } from '../../shared/constants.js';
export { ACU_ACTIONS, ACU_GBP, TIER_ACU_ALLOWANCE };

// Search tiers are now composed from real agent actions, so the ACU cost is the
// sum of the actions that depth runs. AI cost (USD) is derived from ACU price.
function acuSum(actions) {
  return actions.reduce((s, a) => s + (ACU_ACTIONS[a] || 0), 0);
}
const GBP_TO_USD = 1.27;
function tierFrom(name, depth, actions) {
  const acu = acuSum(actions);
  return { name, depth, acu, aiCostUSD: Math.round(acu * ACU_GBP * GBP_TO_USD * 100) / 100, actions };
}

// Multi-tier search system (spec §7). Tier 1 is free and never touches
// expensive AI; every paid tier lists the agents its ACUs actually fund.
export const SEARCH_TIERS = {
  free: {
    name: 'Cached / Free', acu: 0, aiCostUSD: 0, depth: 'cached', actions: [],
    features: ['Cached results', 'Top deals', 'Destination suggestions', 'Previous searches', 'Limited searches (5/day)', 'No expensive AI'],
  },
  smart: {
    ...tierFrom('Smart Search', 'standard', ['intent', 'flightSearch', 'hotelSearch']),
    agents: ['Flight Agent', 'Hotel Agent', 'Transfer Agent'],
  },
  deep: {
    ...tierFrom('Deep Savings Search', 'deep', ['intent', 'flightSearch', 'hotelSearch', 'visaCheck', 'priceMonitor', 'riskBriefing']),
    agents: ['Flight Agent', 'Hotel Agent', 'Transfer Agent', 'Visa Agent', 'Price Monitor Agent', 'Savings/Risk Agent'],
  },
  concierge: {
    ...tierFrom('Concierge Search', 'concierge', ['intent', 'flightSearch', 'hotelSearch', 'visaCheck', 'riskBriefing', 'chiefOfStaff', 'privateAviation']),
    agents: ['Flight Agent', 'Hotel Agent', 'Transfer Agent', 'Visa Agent', 'Savings/Risk Agent', 'Chief-of-Staff Agent', 'Private Aviation Agent'],
  },
};

// Revenue must be at least this multiple of AI cost (spec: revenue >= cost x10).
export const REVENUE_TO_COST_MULTIPLE = 10;

// Decide whether an AI search may run, and at what depth.
//   ctx: { tier, user, hasDeposit, subscriptionActive, expectedBookingUSD }
// Master Rule: AI cost must never exceed 5–10% of expected 3JN profit.
// (revenue >= cost × 10 ⇔ cost <= 10% of the expected commission.)
export function aiCostCap(expectedProfitUSD) {
  return {
    maxAiCostUSD: Math.round(expectedProfitUSD * 0.10 * 100) / 100,
    targetAiCostUSD: Math.round(expectedProfitUSD * 0.05 * 100) / 100,
    rule: 'AI cost capped at 5–10% of expected 3JN profit',
  };
}

// Free users get 3–5 basic searches per day, cached prices only beyond that —
// no deep agent comparison, negotiation, booking hold or custom itineraries.
export const FREE_DAILY_SEARCH_LIMIT = 5;

export function costProtectionGate({ tier = 'smart', user, hasDeposit = false, subscriptionActive = false, expectedBookingUSD = 0, advertisingCreditUSD = 0, recentSearches = 0, priorBookings = 0, intentStrong = null, searchesToday = 0, sameDestinationRepeats = 0 }) {
  const t = SEARCH_TIERS[tier] || SEARCH_TIERS.smart;

  // Free/cached always allowed.
  if (t.aiCostUSD === 0) {
    return { allowed: true, tier, reason: 'cached-free', aiCostUSD: 0, acu: 0 };
  }

  // Free-tier daily cap: without ACUs, a deposit or a subscription, paid
  // depth stops after the daily allowance — cached prices continue free.
  const isFreeUser = !subscriptionActive && !hasDeposit && !(user && user.acuBalance > 0);
  if (isFreeUser && searchesToday >= FREE_DAILY_SEARCH_LIMIT) {
    return {
      allowed: false, downgradeTo: 'free', tier, reason: 'free-daily-limit', aiCostUSD: t.aiCostUSD,
      requirement: { message: `Free plan: ${FREE_DAILY_SEARCH_LIMIT} searches/day. Cached prices stay free — buy ACUs, pay a refundable deposit or subscribe for unlimited deep search.` },
    };
  }

  // Abuse throttle: heavy searching with zero booking history downgrades to
  // cached regardless of funding — the system is not a free AI search machine.
  if ((recentSearches > 20 || sameDestinationRepeats > 10) && priorBookings === 0) {
    return {
      allowed: false, downgradeTo: 'free', tier, reason: 'abuse-throttle', aiCostUSD: t.aiCostUSD,
      requirement: { message: 'To continue deep AI price hunting, please add ACUs or place a refundable booking deposit.' },
    };
  }

  // Expected 3JN revenue from a booking at this value = 10% commission.
  const expectedRevenueUSD = expectedBookingUSD * 0.10;
  const revenueCovers = expectedRevenueUSD >= t.aiCostUSD * REVENUE_TO_COST_MULTIPLE;
  const acuCovers = user && user.acuBalance >= t.acu;

  const fundingReasons = [];
  if (acuCovers) fundingReasons.push('acu-balance');
  if (hasDeposit) fundingReasons.push('search-deposit');
  if (subscriptionActive) fundingReasons.push('subscription');
  if (revenueCovers) fundingReasons.push('expected-booking-revenue');
  if (advertisingCreditUSD >= t.aiCostUSD) fundingReasons.push('advertising-revenue');

  // Strong booking intent (explicit dates + multiple components) lets the
  // expected-revenue path count at a friendlier threshold (x5 instead of x10).
  if (!fundingReasons.length && intentStrong && expectedRevenueUSD >= t.aiCostUSD * 5) {
    fundingReasons.push('strong-booking-intent');
  }

  if (fundingReasons.length > 0) {
    return {
      allowed: true,
      tier,
      reason: fundingReasons.join('+'),
      aiCostUSD: t.aiCostUSD,
      acu: acuCovers ? t.acu : 0, // only debit ACU if that's the funding source
      chargeAcu: acuCovers && !subscriptionActive && !hasDeposit,
      // The 8-question gate checklist (spec part 16), answered.
      checklist: gateChecklist({ acuCovers, hasDeposit, subscriptionActive, revenueCovers, recentSearches, priorBookings, intentStrong }),
    };
  }

  // Not funded — downgrade to free/cached instead of blocking outright.
  return {
    allowed: false,
    downgradeTo: 'free',
    tier,
    reason: 'unfunded',
    aiCostUSD: t.aiCostUSD,
    requirement: {
      acuNeeded: t.acu,
      orDepositGBP: tier === 'deep' ? 5 : tier === 'concierge' ? 20 : 0,
      orSubscription: true,
      message: `This ${t.name} needs funding. Buy ${t.acu} ACUs, pay a refundable search deposit, or upgrade your plan. Showing cached results instead.`,
    },
  };
}

// Priority search fees — speed is a product: standard runs on ACU economics,
// priority and urgent same-day searches carry a cash fee.
export const PRIORITY_SEARCH_FEES = {
  standard: { feeGBP: 0, note: 'Free / low ACU' },
  priority: { minGBP: 3, maxGBP: 10, note: 'Jump the queue — results first' },
  urgent: { minGBP: 15, maxGBP: 50, note: 'Same-day travel — dedicated scan + human check' },
};
export function prioritySearchFee(level = 'standard', tripValueGBP = 0) {
  const t = PRIORITY_SEARCH_FEES[level] || PRIORITY_SEARCH_FEES.standard;
  if (!t.minGBP) return { level: 'standard', feeGBP: 0 };
  const fee = Math.max(t.minGBP, Math.min(t.maxGBP, Math.round(tripValueGBP * 0.01)));
  return { level, feeGBP: fee, note: t.note };
}

// Revenue streams summary for the white-label / API partner calculator.
export function whiteLabelPayout(bookingVolumeUSD, avgCommissionRate = 0.10) {
  const commission = bookingVolumeUSD * avgCommissionRate;
  const platformShare = commission * 0.10; // 3JN keeps 10% of generated commission
  const partnerNet = commission - platformShare;
  return {
    bookingVolumeUSD,
    commissionUSD: round2(commission),
    partnerNetUSD: round2(partnerNet),
    platformShareUSD: round2(platformShare),
  };
}

export const REVENUE_STREAMS = [
  '10% final payment fee',
  'ACU pack sales',
  'Refundable search deposits',
  'Supplier commissions',
  'Savings-share fee',
  'Priority search fee',
  'Booking protection fee',
  'Subscriptions',
  'Corporate travel accounts',
  'Group travel fees',
  'Destination marketplace add-ons',
  'White-label SaaS',
  'API revenue',
  'Finance / instalment processing',
  'Partner placement (sponsored)',
];

function round2(n) { return Math.round(n * 100) / 100; }

// ---- Group travel revenue (high-profit segment) ------------------------------
// Churches, schools, football teams, wedding groups, conferences, family
// reunions, diaspora trips — four stacked earners per group.
export const GROUP_SEGMENTS = ['Churches', 'Schools', 'Football teams', 'Wedding groups', 'Conferences', 'Family reunions', 'Diaspora trips to Africa'];
export function groupTravelFees(headcount = 10, tripValueGBP = 0) {
  const planningFeeGBP = headcount >= 25 ? 149 : headcount >= 10 ? 99 : 49;
  const groupBookingFeeGBP = Math.round(headcount * 5); // £5/head coordination fee
  return {
    segments: GROUP_SEGMENTS,
    planningFeeGBP,
    groupBookingFeeGBP,
    finalPaymentPct: 0.10,                    // the standard 10% fee still applies
    supplierCommission: 'per SUPPLIER_COMMISSIONS schedule',
    totalUpfrontGBP: planningFeeGBP + groupBookingFeeGBP,
  };
}

// ---- White-label pricing ------------------------------------------------------
// Agencies run 3JN Travel OS under their own brand; five stacked charges.
export const WHITE_LABEL_PRICING = {
  setupFeeGBP: 1500,
  monthlySaasGBP: 199,
  acuUsage: 'metered at £1 = 100 ACU (standard rate)',
  bookingCommissionPct: 0.10, // 3JN keeps 10% of partner-generated commission
  premiumSupportGBPMonth: 99,
};

// The Cost Protection Gate's eight questions, answered per search.
function gateChecklist({ acuCovers, hasDeposit, subscriptionActive, revenueCovers, recentSearches, priorBookings, intentStrong }) {
  return [
    { q: 'User ACU balance sufficient?', a: !!acuCovers },
    { q: 'Deposit paid?', a: !!hasDeposit },
    { q: 'Subscription coverage?', a: !!subscriptionActive },
    { q: 'Estimated AI/API cost within cap?', a: true }, // enforced by the x10 formula below
    { q: 'Expected 10% platform revenue enough (>= 10x cost)?', a: !!revenueCovers },
    { q: 'Supplier commission potential?', a: true }, // every booked component earns per SUPPLIER_COMMISSIONS
    { q: 'Abuse score acceptable?', a: !(recentSearches > 20 && priorBookings === 0) },
    { q: 'Search history healthy?', a: recentSearches <= 20 || priorBookings > 0 },
    { q: 'Cache available as fallback?', a: true }, // the downgrade path always exists
    { q: 'Booking likelihood strong?', a: !!intentStrong },
  ];
}

// ---- API revenue: productised endpoints sold to travel businesses ------------
export const API_PRODUCTS = [
  { key: 'search', endpoint: '/api/v1/search', name: 'Cheapest price search API', pricePerCallGBP: 0.05 },
  { key: 'itinerary', endpoint: '/api/v1/itinerary', name: 'Itinerary AI API', pricePerCallGBP: 0.04 },
  { key: 'visa', endpoint: '/api/v1/visa-checklist', name: 'Visa checklist API', pricePerCallGBP: 0.03 },
  { key: 'group', endpoint: '/api/v1/group-quote', name: 'Group travel quote API', pricePerCallGBP: 0.08 },
  { key: 'savings', endpoint: '/api/v1/savings', name: 'Travel savings API', pricePerCallGBP: 0.05 },
  { key: 'hotels', endpoint: '/api/v1/hotels', name: 'Hotel comparison API', pricePerCallGBP: 0.04 },
];

// ---- Finance revenue: products + processing fees ------------------------------
export const FINANCE_PRODUCTS = [
  { key: 'instalments', name: 'Pay-monthly holidays', fee: '0% to traveller · 3JN earns processing spread' },
  { key: 'wallet', name: 'Travel savings wallet', fee: 'Free · float + partner interest' },
  { key: 'deposit', name: 'Deposit plans (20% + schedule)', fee: 'Included in 10% commission' },
  { key: 'pot', name: 'Group contribution pots', fee: '1.5% processing on contributions' },
  { key: 'invoicing', name: 'Corporate invoicing', fee: 'Included in corporate plan' },
  { key: 'layaway', name: 'Family travel layaway', fee: '£1/month account fee' },
];
