// AI Cost Protection Engine (ACPE) + revenue model.
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

export const SEARCH_TIERS = {
  free: { name: 'Cached / Free', acu: 0, aiCostUSD: 0, depth: 'cached', actions: [] },
  smart: tierFrom('Smart Search', 'standard', ['intent', 'flightSearch', 'hotelSearch']),
  deep: tierFrom('Deep Savings Search', 'deep', ['intent', 'flightSearch', 'hotelSearch', 'visaCheck', 'priceMonitor', 'riskBriefing']),
  concierge: tierFrom('Concierge Search', 'concierge', ['intent', 'flightSearch', 'hotelSearch', 'visaCheck', 'riskBriefing', 'chiefOfStaff', 'privateAviation']),
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

export function costProtectionGate({ tier = 'smart', user, hasDeposit = false, subscriptionActive = false, expectedBookingUSD = 0, advertisingCreditUSD = 0 }) {
  const t = SEARCH_TIERS[tier] || SEARCH_TIERS.smart;

  // Free/cached always allowed.
  if (t.aiCostUSD === 0) {
    return { allowed: true, tier, reason: 'cached-free', aiCostUSD: 0, acu: 0 };
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

  if (fundingReasons.length > 0) {
    return {
      allowed: true,
      tier,
      reason: fundingReasons.join('+'),
      aiCostUSD: t.aiCostUSD,
      acu: acuCovers ? t.acu : 0, // only debit ACU if that's the funding source
      chargeAcu: acuCovers && !subscriptionActive && !hasDeposit,
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
