// Shared constants — the single source of truth for values used by BOTH the
// backend logic and the frontend display. Backend modules import these
// directly; the frontend receives them through the API (/api/context) and the
// /shared static mount, so the two never drift.
//
// Pure data only (no Node or browser APIs) so it is safe to import anywhere.

// ---- Commission & savings (3JN's headline economics) ----------------------
export const COMMISSION_RATE = 0.10;      // 10% final-payment fee
// BEDBANK / NET-RATE HOTEL MARGIN — the real profit engine. Contracted net (whole-
// sale) hotel rates sit ~20–40% below retail, so 3JN marks them up to a still-
// competitive retail price and keeps the spread. This applies ONLY to components
// flagged `netRate: true` (TBO/RateHawk bedbank); retail hotels keep the 10%. It
// lets flights stay a near-free hook while hotels carry the margin. No-op until
// net rates flow (Duffel Stays retail isn't net). Override with HOTEL_MARGIN_RATE.
export const HOTEL_MARGIN_RATE = 0.20;
// TIERED TAKE-RATE: flights-only bookings pay a small % service fee instead of
// 10% (a 10% flight loses every Skyscanner comparison → 10% of nothing).
// A flat fee left money on the table on high-value long-haul (3JN's core
// diaspora market) and over-charged cheap short-haul. So: 2% of the fare, with
// a £4.99 FLOOR (never below the Duffel order cost) and a £15 CAP (keeps
// big-ticket long-haul competitive — the traveller never pays a runaway fee).
// Hotels/packages/extras keep the 10% where the real margin lives. Free for
// active Travel+ members. The Duffel pass-through is separate and at cost.
export const FLIGHT_ONLY_FEE_RATE = 0.02;   // 2% of the flight value (non-members)
export const FLIGHT_ONLY_FEE_GBP = 4.99;    // floor — never below supplier/booking cost
export const FLIGHT_ONLY_FEE_CAP_GBP = 15;  // cap — stays competitive on long-haul
// GOLDEN RULE — every booking must EARN; 3JN never funds a membership. Members pay
// a small FLAT flight fee (no % markup), so a member flight is always profitable —
// cheaper than the non-member 2% on anything above the floor, but never £0/a loss.
export const FLIGHT_ONLY_MEMBER_FEE_GBP = 4.99;
export const FLIGHT_ONLY_MEMBER_FREE = false;
// GOLDEN-RULE PERK CAP: for every £1 of member perk 3JN gives (package discount +
// Travel Credit), it must keep at least £3 → perks may never exceed 25% of the
// gross margin on a booking (£4 gross − £1 perk = £3 kept = 3:1). This is a HARD
// cap enforced in pricing + credit, so the membership is structurally self-funding
// on every single booking, whatever the mix. Perks scale with margin: thin trips
// give little, fat-margin packages (bedbank) give the full headline savings.
export const MEMBER_PERK_MARGIN_SHARE = 0.25;
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

// ---- Loyalty → Travel Credit (members only, flat, no tiers) ----------------
// REDESIGNED: the old four-rung ladder (Explorer/Voyager/Nomad/Elite) overlapped
// confusingly with the membership discount. Replaced by ONE simple mechanic:
// Travel+ members earn a flat % of what they spend back as Travel Credit toward
// their next trip. No tiers, no thresholds. Members-only (recurring-revenue
// payers), so it never bleeds the thin flight margin.
export const TRAVEL_CREDIT_RATE = 0.03; // members earn 3% of booking value as credit
export const TRAVEL_CREDIT_MEMBERS_ONLY = true;
// LOYALTY_TIERS retained as a single neutral tier for back-compat with callers
// that still read a "tier" — it grants NO discount (discounts come from
// membership only now, so the two never stack or confuse).
export const LOYALTY_TIERS = [
  { name: 'Member', minPoints: 0, discount: 0 },
];
// Points ledger kept internally for history, but points no longer grant a
// discount — Travel Credit (in £) is the member reward shown to customers.
export const POINTS_PER_USD = 0.4;
export const SIGNUP_BONUS_POINTS = 0;

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
// billing period (the "20% of your plan funds your AI" rule) — members spend
// this on searches at the margin price and top up when it runs out.
export const MEMBERSHIP_ACU_FUND_RATE = 0.20;

// ---- Membership plans (blueprint §3.1) ------------------------------------
// Each plan auto-funds ACUs every billing period: 20% of the subscription,
// converted at £1 = 100 ACU. e.g. £12.99 → £2.598 → ~260 ACU / month.
// REDESIGNED: four overlapping tiers → TWO clear ones (plus a Free tier that isn't
// listed here). `discount` = the member package discount, funded from 3JN's
// commission and capped at it, so a booking is never sold below supplier cost.
// Members also pay no flight service fee and earn Travel Credit on every trip.
export const MEMBERSHIP_TIERS = [
  { key: 'plus', name: 'Travel+', pricePerMonth: 5.99, discount: 0.05 },
  { key: 'family', name: 'Travel+ Family', pricePerMonth: 11.99, discount: 0.07 },
].map((t) => ({
  ...t,
  acuPerMonth: Math.round(t.pricePerMonth * MEMBERSHIP_ACU_FUND_RATE * ACU_PER_GBP),
  // Membership is sold as a cheap ONE-OFF ANNUAL fee = 2× the old monthly price.
  // Travel is occasional, so a small once-a-year fee for the member perks
  // (fee-free flights, priority, savings, lounge, visa support) beats a recurring
  // monthly charge — the real usage revenue comes from ACU top-ups per search.
  pricePerYear: Math.round(t.pricePerMonth * 2 * 100) / 100,
  // 20% of the annual fee is credited back as ACU (£1 = 100 ACU).
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
