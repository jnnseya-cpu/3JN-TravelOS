// Shared constants — the single source of truth for values used by BOTH the
// backend logic and the frontend display. Backend modules import these
// directly; the frontend receives them through the API (/api/context) and the
// /shared static mount, so the two never drift.
//
// Pure data only (no Node or browser APIs) so it is safe to import anywhere.

// ---- Commission & savings (3JN's headline economics) ----------------------
export const COMMISSION_RATE = 0.10;      // 10% final-payment fee
// TIERED TAKE-RATE: flights-only bookings pay a small % service fee instead of
// 10% (a 10% flight loses every Skyscanner comparison → 10% of nothing).
// A flat fee left money on the table on high-value long-haul (3JN's core
// diaspora market) and over-charged cheap short-haul. So: 2% of the fare, with
// a £4.99 FLOOR (never below the Duffel order cost) and a £15 CAP (keeps
// big-ticket long-haul competitive — the traveller never pays a runaway fee).
// Hotels/packages/extras keep the 10% where the real margin lives. Free for
// active Travel+ members. The Duffel pass-through is separate and at cost.
export const FLIGHT_ONLY_FEE_RATE = 0.02;   // 2% of the flight value
export const FLIGHT_ONLY_FEE_GBP = 4.99;    // floor — never below supplier/booking cost
export const FLIGHT_ONLY_FEE_CAP_GBP = 15;  // cap — stays competitive on long-haul
export const FLIGHT_ONLY_MEMBER_FREE = true;
// Partners earn a share of what 3JN ACTUALLY takes on a flights-only booking
// (industry standard: affiliates get a % of the platform's commission, never
// of booking value) — plus lifetime attribution on the customer they brought.
// Trimmed 40% → 30% now the flight fee scales up to £15: 3JN keeps 70% of the
// larger take while partners still earn more per ticket on high-value fares.
export const FLIGHT_ONLY_PARTNER_SHARE = 0.30;
export const SAVINGS_SHARE_RATE = 0.10;   // 10% of value created vs market
// The savings-share only triggers when the AI creates REAL value: savings must
// exceed £100 (≈ $127 at the platform's 0.79 GBP anchor) before the 10% share
// is charged. Below that, the customer keeps 100% of the saving.
export const SAVINGS_SHARE_MIN_USD = 127;

// ---- Loyalty (1 point per $2 spent; 250-point signup bonus) ---------------
export const LOYALTY_TIERS = [
  { name: 'Explorer', minPoints: 0, discount: 0 },
  { name: 'Voyager', minPoints: 1000, discount: 0.03 },
  { name: 'Nomad', minPoints: 5000, discount: 0.06 },
  { name: 'Elite', minPoints: 15000, discount: 0.08 },
];
// 1 loyalty point per £2 spent — the engine prices in USD, so at the platform's
// 0.79 GBP/USD anchor £2 ≈ $2.53 → 0.4 points per USD (was 0.5/USD, which
// under-delivered the "£2" promise shown on the site).
export const POINTS_PER_USD = 0.4;
export const SIGNUP_BONUS_POINTS = 250;

// ---- ACU economy (blueprint Appendix B + §12.2) ---------------------------
export const ACU_ACTIONS = {
  intent: 6,
  flightSearch: 12,
  hotelSearch: 8,
  priceMonitor: 3,
  visaCheck: 10,
  riskBriefing: 18,
  chiefOfStaff: 12,
  expense: 5,
  privateAviation: 25,
  coworking: 8,
};
// Internal cost basis: what 1 ACU costs 3JN to serve (drives the AI-cost gate).
export const ACU_GBP = 0.003;
// Customer-facing sale/allocation rate: £1 buys 100 ACUs (members + top-ups).
export const ACU_PER_GBP = 100;
// Share of every membership subscription that is auto-converted to ACUs each
// billing period (the "10% of your plan funds your AI" rule).
export const MEMBERSHIP_ACU_FUND_RATE = 0.10;

// ---- Membership plans (blueprint §3.1) ------------------------------------
// Each plan auto-funds ACUs every billing period: 10% of the subscription,
// converted at £1 = 100 ACU. e.g. £12.99 → £1.299 → ~130 ACU / month.
export const MEMBERSHIP_TIERS = [
  // `discount` = the members' fee/package discount (the "Discounted fees" benefit),
  // funded from 3JN's commission and capped at it, so a booking is never sold
  // below supplier cost. It applies even before a member earns any loyalty points.
  { key: 'nomad', name: 'Travel+ Smart Traveller', pricePerMonth: 4.99, discount: 0.03 },
  { key: 'family', name: 'Travel+ Family Saver', pricePerMonth: 12.99, discount: 0.05 },
  { key: 'executive', name: 'Travel+ Frequent Flyer', pricePerMonth: 24.99, discount: 0.06 },
  { key: 'elite', name: 'Travel+ Concierge Elite', pricePerMonth: 49.99, discount: 0.08 },
].map((t) => ({
  ...t,
  acuPerMonth: Math.round(t.pricePerMonth * MEMBERSHIP_ACU_FUND_RATE * ACU_PER_GBP),
  // Membership is sold as a cheap ONE-OFF ANNUAL fee = 2× the old monthly price.
  // Travel is occasional, so a small once-a-year fee for the member perks
  // (fee-free flights, priority, savings, lounge, visa support) beats a recurring
  // monthly charge — the real usage revenue comes from ACU top-ups per search.
  pricePerYear: Math.round(t.pricePerMonth * 2 * 100) / 100,
  // 10% of the annual fee is credited back as ACU (£1 = 100 ACU).
  acuPerYear: Math.round(t.pricePerMonth * 2 * MEMBERSHIP_ACU_FUND_RATE * ACU_PER_GBP),
}));

export const TIER_ACU_ALLOWANCE = Object.fromEntries(
  MEMBERSHIP_TIERS.map((t) => [t.name.replace('Travel+ ', ''), t.acuPerMonth]),
);

// 3JN Travel+ membership benefits (USP #9) — recurring revenue instead of
// one-off users. Every paid tier carries these seven benefit families.
export const TRAVEL_PLUS_BENEFITS = [
  'Priority searches', 'Travel alerts', 'Price monitoring', 'Discounted fees',
  'Premium support', 'Lounge offers', 'Visa support',
];

// Subscription catalogue (Revenue Source 8) — the seven plans, spanning the
// free tier, the four Travel+ memberships and the two corporate accounts.
export const SUBSCRIPTION_PLANS = [
  { key: 'free', name: 'Free', pricePerMonth: 0, engine: 'cached search tier' },
  ...MEMBERSHIP_TIERS.map((t) => ({ key: t.key, name: t.name.replace('Travel+ ', ''), pricePerMonth: t.pricePerMonth, engine: 'MEMBERSHIP_TIERS' })),
  { key: 'business', name: 'Business Travel', pricePerMonth: 99, engine: 'CORPORATE_PLANS (Team)' },
  { key: 'enterprise', name: 'Enterprise', pricePerMonth: 299, engine: 'CORPORATE_PLANS (Enterprise)' },
];

// ---- Corporate travel platform (spec §10: separate SaaS module) ------------
// Earns three ways per account: the monthly subscription, the standard 10%
// per-booking fee, and metered ACU usage.
export const CORPORATE_PLANS = [
  { key: 'team', name: 'Corporate Team', pricePerMonth: 99, seats: 15 },
  { key: 'enterprise', name: 'Corporate Enterprise', pricePerMonth: 299, seats: 100 },
].map((p) => ({
  ...p,
  features: [
    'Travel policies', 'Approval workflows', 'Expense management',
    'Invoice management', 'Employee travel profiles', 'Budget controls',
    'Department tracking', 'Travel analytics dashboard',
    'Staff travel booking', 'Cheapest compliant fare search',
  ],
  revenueStreams: ['Monthly subscription', '10% per-booking fee', 'Metered ACU usage'],
}));

// ---- Reliability floor for "cheapest *reliable*" --------------------------
export const RELIABILITY_FLOOR = 70;
