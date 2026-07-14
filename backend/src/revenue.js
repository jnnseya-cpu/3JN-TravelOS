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
import { ACU_ACTIONS, ACU_GBP, TIER_ACU_ALLOWANCE, ACU_PER_GBP } from '../../shared/constants.js';
export { ACU_ACTIONS, ACU_GBP, TIER_ACU_ALLOWANCE };

// The raw provider cost of a tier expressed in ACU (£1 = ACU_PER_GBP, USD→GBP at
// the 0.79 anchor). MEMBERS are charged this AT-COST rate (100%, no markup) —
// their subscription is the margin. NON-MEMBERS pay the full commercial 3–10×
// rate (the tier's `acu`). This is the "members at cost, top-up users at
// commercial" split.
function atCostAcu(aiCostUSD) {
  return Math.max(1, Math.ceil((aiCostUSD || 0) * 0.79 * ACU_PER_GBP));
}

// Search tiers are now composed from real agent actions, so the ACU cost is the
// sum of the actions that depth runs. AI cost (USD) is derived from ACU price.
function acuSum(actions) {
  return actions.reduce((s, a) => s + (ACU_ACTIONS[a] || 0), 0);
}
const GBP_TO_USD = 1 / 0.79; // platform anchor reciprocal (≈1.266) — consistent everywhere
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
  // MARGIN PROTECTION (business rule): the customer is charged 3–10× the raw
  // provider AI cost. Each tier's charge is the SUM of its metered agent actions
  // (ACU_ACTIONS) — which is already priced at ~3.3× the real provider cost
  // (smart's actions = 26 ACU = £0.26 vs the ~$0.10 provider cost → 3.3×), i.e.
  // the floor of the 3–10× band. The earlier flat 5/10/20 ACU override sold every
  // search BELOW cost (a loss); it has been removed so each search now clears the
  // margin floor. NB: at these prices a member's monthly ACU affords fewer
  // searches (e.g. nomad 50 ACU ≈ 2 smart searches) — top-ups cover the rest.
  smart: {
    ...tierFrom('Smart Search', 'standard', ['intent', 'flightSearch', 'hotelSearch']),
    aiCostUSD: 0.10, // real provider (LLM) cost
    acuMember: atCostAcu(0.10), // members: at cost (~8 ACU)
    agents: ['Flight Agent', 'Hotel Agent', 'Transfer Agent'],
  },
  deep: {
    ...tierFrom('Deep Savings Search', 'deep', ['intent', 'flightSearch', 'hotelSearch', 'visaCheck', 'priceMonitor', 'riskBriefing']),
    aiCostUSD: 0.22, // real provider cost
    acuMember: atCostAcu(0.22), // members: at cost (~18 ACU)
    agents: ['Flight Agent', 'Hotel Agent', 'Visa Agent', 'Transfer Agent', 'Price Negotiation Agent', 'Savings Agent'],
  },
  concierge: {
    ...tierFrom('Concierge Search', 'concierge', ['intent', 'flightSearch', 'hotelSearch', 'visaCheck', 'riskBriefing', 'chiefOfStaff', 'privateAviation']),
    aiCostUSD: 0.35, // real provider cost
    acuMember: atCostAcu(0.35), // members: at cost (~28 ACU)
    agents: ['Flight Agent', 'Hotel Agent', 'Visa Agent', 'Transfer Agent', 'Price Negotiation Agent', 'Savings Agent', 'Chief-of-Staff Agent', 'Private Aviation Agent'],
    // Tier 4 pairs the AI agents with a HUMAN travel expert — human time is
    // never funded speculatively, so access requires a real commitment.
    humanExpert: 'Human Travel Expert',
    requires: ['Refundable deposit', 'Subscription', 'Premium plan'],
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

// ---- Search Abuse Detection Engine (spec §15) -------------------------------
// Seven tracked signals scored 0–100. The gate throttles on an elevated score;
// the fraud engine (bookingRiskScore) covers the booking-time equivalents.
export const ABUSE_SIGNALS = [
  'Searches without booking', 'Repeated searches', 'Bot behaviour',
  'Multiple accounts', 'Excessive AI consumption', 'Chargebacks', 'Suspicious activity',
];
export function searchAbuseScore({ searchesWithoutBooking = 0, repeatedSearches = 0, botBehaviour = false, multipleAccounts = false, acuConsumedToday = 0, chargebacks = 0, suspiciousActivity = false } = {}) {
  let score = 0;
  score += Math.min(40, searchesWithoutBooking * 2); // volume with zero conversion
  score += Math.min(30, repeatedSearches * 3);       // same destination over and over
  if (botBehaviour) score += 20;                     // typing/mouse/timing anomalies
  if (multipleAccounts) score += 20;                 // device/IP fingerprint overlap
  score += Math.min(15, Math.floor(acuConsumedToday / 100) * 5); // AI burn rate
  score += Math.min(20, chargebacks * 10);
  if (suspiciousActivity) score += 15;
  score = Math.min(100, score);
  // Spec bands: 0–30 Normal · 31–60 Monitor · 61–80 Restrict · 81–100 Block.
  const band = score >= 81 ? 'Block' : score >= 61 ? 'Restrict' : score >= 31 ? 'Monitor' : 'Normal';
  // Gate action: Monitor keeps running (logged); Restrict throttles to cached;
  // Block refuses paid depth entirely until reviewed.
  const level = band === 'Block' ? 'block' : band === 'Restrict' ? 'throttle' : band === 'Monitor' ? 'monitor' : 'clear';
  return { score, band, level, signals: ABUSE_SIGNALS };
}

export function costProtectionGate({ tier = 'smart', user, hasDeposit = false, subscriptionActive = false, expectedBookingUSD = 0, advertisingCreditUSD = 0, recentSearches = 0, priorBookings = 0, intentStrong = null, searchesToday = 0, sameDestinationRepeats = 0, corporateContract = false, whiteLabelContract = false, hasPurchasedAcu = false, multipleAccounts = false }) {
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

  // Tier 4 Concierge (spec §7): AI agents + a Human Travel Expert. Human time
  // is never funded speculatively — the tier REQUIRES a deposit, an active
  // subscription, or a premium plan, regardless of ACU balance or expected
  // revenue. Without one, the search downgrades instead of running.
  if (tier === 'concierge') {
    const committed = hasDeposit || subscriptionActive || !!(user && user.membership?.active);
    if (!committed) {
      return {
        allowed: false, downgradeTo: 'free', tier, reason: 'concierge-requires-commitment', aiCostUSD: t.aiCostUSD,
        requirement: {
          orDepositGBP: 20, orSubscription: true, orPremiumPlan: true,
          message: 'Concierge Search pairs AI agents with a human travel expert, so it needs a commitment first: place a refundable £20 deposit, or use an active subscription/premium plan. Showing cached results instead.',
        },
      };
    }
  }

  // MARGIN PROTECTION for ALL free/promotional ACU (the 50-ACU signup starter,
  // referral rewards, bonuses, admin comps — anything NOT bought): it lets a user
  // TRY the cheap Smart search, but must never fund the more expensive Deep or
  // Concierge agents before the user has committed. "Committed" is a real signal
  // the platform will earn — a booking, a paid membership, a PURCHASED ACU top-up,
  // a search deposit, or a corporate/white-label contract — so free credit of any
  // kind (which cost the platform, not the user) can't run the premium AI. The
  // commitment test is "has money changed hands", never "does the user hold ACU".
  const committed = hasDeposit || subscriptionActive || hasPurchasedAcu || priorBookings > 0
    || corporateContract || whiteLabelContract || !!(user && user.membership?.active);
  const smartAcu = (SEARCH_TIERS.smart || {}).acu || 5;
  const hasStarterAcu = !!(user && user.acuBalance >= smartAcu);
  // Only bites when the user has the free starter ACU (can afford Smart) but has
  // NOT committed — then Deep downgrades to Smart. A user with no ACU falls
  // through to the normal funding checks below (which downgrade to cached/free).
  if (tier === 'deep' && !committed && hasStarterAcu) {
    return {
      allowed: false, downgradeTo: 'smart', tier, reason: 'free-starter-limited-to-smart', aiCostUSD: t.aiCostUSD,
      requirement: {
        message: 'Deep search uses premium AI agents, so it needs a commitment first — top up ACU, join a plan, or place a refundable deposit. Your free starter ACU runs the Smart search; showing that instead.',
      },
    };
  }

  // Abuse throttle (spec §15): the Search Abuse Detection Engine scores seven
  // signals 0–100 (Normal / Monitor / Restrict / Block). Restrict+ with zero
  // booking history downgrades to cached regardless of funding — the system is
  // not a free AI search machine.
  const abuse = searchAbuseScore({
    searchesWithoutBooking: priorBookings === 0 ? recentSearches : 0,
    repeatedSearches: sameDestinationRepeats,
    multipleAccounts, // farmed accounts from one IP get throttled to cached
  });
  if ((abuse.level === 'block' || abuse.level === 'throttle' || recentSearches > 20 || sameDestinationRepeats > 10) && priorBookings === 0) {
    return {
      allowed: false, downgradeTo: 'free', tier, reason: 'abuse-throttle', aiCostUSD: t.aiCostUSD, abuse,
      requirement: { message: 'To continue deep AI price hunting, please add ACUs or place a refundable booking deposit.' },
    };
  }

  // Expected 3JN revenue from a booking at this value = 10% commission.
  const expectedRevenueUSD = expectedBookingUSD * 0.10;
  const revenueCovers = expectedRevenueUSD >= t.aiCostUSD * REVENUE_TO_COST_MULTIPLE;
  const acuCovers = user && user.acuBalance >= t.acu;

  // FINAL PLATFORM RULE (LOCKED): no AI agent may execute a task unless funded
  // by 1) ACU balance, 2) search deposit, 3) active subscription, 4) supplier-
  // commission opportunity (expected revenue path), 5) expected 10% booking
  // revenue, 6) corporate contract, or 7) white-label contract. If none exist:
  // downgrade, request payment, or block.
  const fundingReasons = [];
  if (acuCovers) fundingReasons.push('acu-balance');
  if (hasDeposit) fundingReasons.push('search-deposit');
  if (subscriptionActive) fundingReasons.push('subscription');
  if (revenueCovers) fundingReasons.push('expected-booking-revenue');
  if (advertisingCreditUSD >= t.aiCostUSD) fundingReasons.push('advertising-revenue');
  if (corporateContract) fundingReasons.push('corporate-contract');
  if (whiteLabelContract) fundingReasons.push('white-label-contract');

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

// Priority search fees (Revenue Source 6) — speed is a product: standard runs
// on ACU economics; fast, urgent and emergency searches carry a flat cash fee.
export const PRIORITY_SEARCH_FEES = {
  standard: { feeGBP: 0, note: 'Free / standard queue' },
  fast: { feeGBP: 3, note: 'Fast search — jump the queue, results first' },
  urgent: { feeGBP: 10, note: 'Urgent search — immediate dedicated scan' },
  emergency: { feeGBP: 25, note: 'Emergency search — same-day travel, dedicated scan + human check' },
  // Legacy aliases (older clients used priority/urgent bands).
  priority: { feeGBP: 3, aliasOf: 'fast' },
};
export function prioritySearchFee(level = 'standard') {
  const t = PRIORITY_SEARCH_FEES[level] || PRIORITY_SEARCH_FEES.standard;
  const canonical = t.aliasOf || (PRIORITY_SEARCH_FEES[level] ? level : 'standard');
  return { level: canonical, feeGBP: t.feeGBP, note: t.note || PRIORITY_SEARCH_FEES[canonical].note };
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

// ---- The Real Positioning (LOCKED) -------------------------------------------
// 3JN never competes with free aggregators (Google Flights, Skyscanner, Kayak,
// Momondo, Trivago) on "we also search cheap flights" — they do that free.
// We do not sell SEARCH. We sell what they can't:
export const POSITIONING = {
  // USP #10 — the ultimate developer-ready positioning, at the top of the
  // business model. Never "Travel Booking Platform".
  category: 'The AI Travel Operating System',
  statement: '3JN Travel OS is not a travel search engine. It is an AI-powered Travel Operating System that continuously saves travellers money, optimises every component of their journey, negotiates better travel outcomes, manages trips end-to-end, and provides personalised travel intelligence before, during and after travel.',
  does: ['Plans', 'Optimises', 'Negotiates', 'Books', 'Protects', 'Tracks', 'Manages', 'Saves Money', 'Supports During Travel', 'Learns User Preferences'],
  usp: "Don't Search. Let AI Find, Negotiate and Build the Best Trip.",
  sells: ['Savings', 'Protection', 'Intelligence', 'Negotiation', 'Execution'],
  neverCompeteOn: 'free flight search (Google Flights / Skyscanner / Kayak / Momondo / Trivago)',
  customerWants: ['cheapest price', 'less risk', 'less time wasted', 'better travel experience', 'somebody to do the work'],
  deliver: 'decisions, not options — an advisor, not a search engine',
  // The most commercially powerful layer (strategic pack): the engine that
  // turns "search and compare" into managed execution across the lifecycle.
  dealExecutionEngine: ['Search', 'Negotiate', 'Package', 'Optimise', 'Monitor', 'Support', 'Continuously improve travel outcomes'],
  lifecycle: ['Idea', 'Discovery', 'Pricing', 'Booking', 'Payments', 'Support', 'Rebooking', 'Refunds', 'Loyalty', 'Repeat Travel Intelligence'],
  pillars: [
    { usp: 'AI Travel CFO', symbol: 'travelCFO (quantified date/airport/hotel-swap advice)' },
    { usp: 'Guaranteed Savings Engine', symbol: 'claimSavingsGuarantee (ACU refund if unbeaten)' },
    { usp: 'Travel Intelligence Score', symbol: 'travelIntelligenceScore (7 scores per trip)' },
    { usp: 'Global Travel Optimiser', symbol: 'buildPackages + decision.optimisedTogether (whole journey, one basket)' },
    { usp: 'AI Negotiation Layer', symbol: 'negotiation (net rates + perks: upgrades, breakfast, pickup, late checkout)' },
    { usp: 'Diaspora Travel Specialist', symbol: 'diaspora (Africa/Caribbean/South Asia/Middle East family journeys)' },
    { usp: 'Group Travel OS', symbol: 'groupOrigins + groupTravelFees (multi-origin groups, one booking, 4 stacked earners)' },
  ],
};
export const SAVINGS_GUARANTEE = 'If 3JN Travel OS cannot beat or match your current quote, we refund your search credits.';

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
export const GROUP_SEGMENTS = ['Churches', 'Schools', 'Sports teams', 'NGOs', 'Wedding groups', 'Conferences', 'Family reunions', 'Diaspora groups'];
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
  branding: 'Powered by 3JN Travel OS', // required on every white-label deployment
  setupFeeGBP: 1500,
  monthlySaasGBP: 199,
  acuUsage: 'metered at £1 = 100 ACU (standard rate)',
  bookingCommissionPct: 0.10, // booking revenue share — 3JN keeps 10% of partner-generated commission
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
  { key: 'search', endpoint: '/api/v1/search', name: 'Cheapest Fare API', pricePerCallGBP: 0.05 },
  { key: 'itinerary', endpoint: '/api/v1/itinerary', name: 'Itinerary API', pricePerCallGBP: 0.04 },
  { key: 'visa', endpoint: '/api/v1/visa-checklist', name: 'Visa API', pricePerCallGBP: 0.03 },
  { key: 'group', endpoint: '/api/v1/group-quote', name: 'Group Travel API', pricePerCallGBP: 0.08 },
  { key: 'savings', endpoint: '/api/v1/savings', name: 'Savings API', pricePerCallGBP: 0.05 },
  { key: 'hotels', endpoint: '/api/v1/hotels', name: 'Hotel Comparison API', pricePerCallGBP: 0.04 },
  { key: 'esim', endpoint: '/api/v1/esim', name: 'eSIM API', pricePerCallGBP: 0.02 },
];
// API billing modes (spec §14): pay-per-call, monthly bundles, enterprise.
export const API_BILLING = [
  { key: 'perCall', name: 'Per call', pricing: 'API_PRODUCTS pricePerCallGBP per request' },
  { key: 'monthly', name: 'Monthly', pricing: 'bundled call volume at a monthly rate (from £199/mo, aligned with white-label SaaS)' },
  { key: 'enterprise', name: 'Enterprise', pricing: 'custom volume, SLA and support — contact sales' },
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
