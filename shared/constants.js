// Shared constants — the single source of truth for values used by BOTH the
// backend logic and the frontend display. Backend modules import these
// directly; the frontend receives them through the API (/api/context) and the
// /shared static mount, so the two never drift.
//
// Pure data only (no Node or browser APIs) so it is safe to import anywhere.

// ---- Commission & savings (3JN's headline economics) ----------------------
export const COMMISSION_RATE = 0.10;      // 10% final-payment fee
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
  { name: 'Elite', minPoints: 15000, discount: 0.10 },
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
  { key: 'nomad', name: 'Travel+ Nomad', pricePerMonth: 4.99 },
  { key: 'family', name: 'Travel+ Family', pricePerMonth: 12.99 },
  { key: 'executive', name: 'Travel+ Executive', pricePerMonth: 24.99 },
  { key: 'elite', name: 'Travel+ Elite', pricePerMonth: 49.99 },
].map((t) => ({ ...t, acuPerMonth: Math.round(t.pricePerMonth * MEMBERSHIP_ACU_FUND_RATE * ACU_PER_GBP) }));

export const TIER_ACU_ALLOWANCE = Object.fromEntries(
  MEMBERSHIP_TIERS.map((t) => [t.name.replace('Travel+ ', ''), t.acuPerMonth]),
);

// ---- Corporate travel accounts (monthly recurring) -------------------------
export const CORPORATE_PLANS = [
  { key: 'team', name: 'Corporate Team', pricePerMonth: 99, seats: 15 },
  { key: 'enterprise', name: 'Corporate Enterprise', pricePerMonth: 299, seats: 100 },
].map((p) => ({
  ...p,
  features: [
    'Staff travel booking', 'Travel policy control', 'Invoice management',
    'Approval workflows', 'Expense export', 'Cheapest compliant fare search',
    'Travel reporting dashboard',
  ],
}));

// ---- Reliability floor for "cheapest *reliable*" --------------------------
export const RELIABILITY_FLOOR = 70;
