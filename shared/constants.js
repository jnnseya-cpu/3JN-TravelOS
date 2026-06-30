// Shared constants — the single source of truth for values used by BOTH the
// backend logic and the frontend display. Backend modules import these
// directly; the frontend receives them through the API (/api/context) and the
// /shared static mount, so the two never drift.
//
// Pure data only (no Node or browser APIs) so it is safe to import anywhere.

// ---- Commission & savings (3JN's headline economics) ----------------------
export const COMMISSION_RATE = 0.10;      // 10% final-payment fee
export const SAVINGS_SHARE_RATE = 0.10;   // 10% of value created vs market

// ---- Loyalty (1 point per $2 spent; 250-point signup bonus) ---------------
export const LOYALTY_TIERS = [
  { name: 'Explorer', minPoints: 0, discount: 0.02 },
  { name: 'Voyager', minPoints: 1000, discount: 0.05 },
  { name: 'Nomad', minPoints: 5000, discount: 0.08 },
  { name: 'Elite', minPoints: 15000, discount: 0.12 },
];
export const POINTS_PER_USD = 0.5;
export const SIGNUP_BONUS_POINTS = 250;

// ---- Membership plans (blueprint §3.1) ------------------------------------
export const MEMBERSHIP_TIERS = [
  { key: 'nomad', name: 'Travel+ Nomad', pricePerMonth: 4.99, acuPerMonth: 1500 },
  { key: 'family', name: 'Travel+ Family', pricePerMonth: 12.99, acuPerMonth: 4000 },
  { key: 'executive', name: 'Travel+ Executive', pricePerMonth: 24.99, acuPerMonth: 10000 },
  { key: 'elite', name: 'Travel+ Elite', pricePerMonth: 49.99, acuPerMonth: 30000 },
];

// ---- ACU economy (blueprint Appendix B + §12.2) ---------------------------
export const ACU_ACTIONS = {
  intent: 8,
  flightSearch: 15,
  hotelSearch: 12,
  priceMonitor: 3,
  visaCheck: 10,
  riskBriefing: 18,
  chiefOfStaff: 12,
  expense: 5,
  privateAviation: 25,
  coworking: 8,
};
export const ACU_GBP = 0.003;
export const TIER_ACU_ALLOWANCE = {
  Nomad: 1500, Family: 4000, Executive: 10000, Elite: 30000, Business: 50000,
};

// ---- Reliability floor for "cheapest *reliable*" --------------------------
export const RELIABILITY_FLOOR = 70;
