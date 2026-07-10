// 3JN Travel OS — Global Rewards & Influencer Programme (config + pure logic).
//
// Travel Together. Earn Together. Grow Together.
//
// This module holds the PROGRAMME RULES (earning actions, influencer tiers,
// revenue-share maths, attribution/fraud guards) as pure, testable functions.
// The stateful pieces (ledgers, profiles, withdrawals) live in store.js and call
// into here so the numbers can never drift between UI, payouts and admin views.
//
// Profitability rule (never weaken): revenue share is a % of 3JN NET revenue
// (our commission margin AFTER refunds/chargebacks/taxes/supplier reversals),
// never of gross booking value — a payout can never exceed what 3JN earned. Each
// referred customer is capped at £20,000 lifetime, bounding total liability.

// ---- §1 Traveller Rewards: ACU earning actions ----------------------------
// amount: fixed ACU; or perGbp: ACU per £1 of net booking value. `once` = a
// one-time lifetime award. Amounts marked proposed in the spec doc — tune here.
export const REWARD_ACTIONS = {
  BOOK_TRIP: { key: 'BOOK_TRIP', label: 'Booked a trip', perGbp: 1 },
  COMPLETE_TRIP: { key: 'COMPLETE_TRIP', label: 'Completed a holiday', amount: 250 },
  REFER_FRIEND: { key: 'REFER_FRIEND', label: 'Referred a friend (paid booking)', amount: 250 },
  VERIFIED_REVIEW: { key: 'VERIFIED_REVIEW', label: 'Left a verified review', amount: 100 },
  UPLOAD_PHOTO: { key: 'UPLOAD_PHOTO', label: 'Uploaded a travel photo', amount: 50 },
  SHARE_ITINERARY: { key: 'SHARE_ITINERARY', label: 'Shared itinerary publicly', amount: 75 },
  PROMO_BOOKING: { key: 'PROMO_BOOKING', label: 'Booked during a promotion (2× earn)', amount: 0 },
  PROFILE_VERIFIED: { key: 'PROFILE_VERIFIED', label: 'Completed profile verification', amount: 200, once: true },
  PARTNER_SERVICE: { key: 'PARTNER_SERVICE', label: 'Used a partner service', amount: 100 },
  BIRTHDAY_MILESTONE: { key: 'BIRTHDAY_MILESTONE', label: 'Birthday / loyalty milestone', amount: 500 },
};

// Where ACUs can be redeemed (§1). Presentational catalogue.
export const REDEEM_CATEGORIES = [
  'Flight discounts', 'Hotel discounts', 'Holiday packages', 'Airport transfers',
  'Activities & attractions', 'Travel insurance', 'eSIM & roaming', 'Visa services',
  'Premium AI Travel Planner', 'AI Concierge services',
];

// Booking during a promotion earns a multiple of the normal earn (§1).
export const PROMO_MULTIPLIER = 2;

// Compute the ACU award for an action given optional booking value / promo flag.
export function acuForAction(actionKey, { netBookingGbp = 0, promo = false } = {}) {
  const a = REWARD_ACTIONS[actionKey];
  if (!a) return 0;
  let acu = a.amount || 0;
  if (a.perGbp) acu += a.perGbp * Math.max(0, netBookingGbp); // e.g. 1 ACU per £1 of net booking value
  if (promo) acu *= PROMO_MULTIPLIER;                         // promo bookings earn 2×
  return Math.round(acu);
}

// ---- §2/§3 Referral + Influencer tiers ------------------------------------
// Every user is a REFERRER by default. Passing 20 paid referrals unlocks a
// baseline 0.25% lifetime revenue share. Approved influencers get a tier with a
// higher share. rate = fraction of 3JN NET revenue per referred customer.
export const REVSHARE_CAP_GBP = 20000; // lifetime cap PER referred customer
export const REFERRER_REVSHARE_UNLOCK = 20; // paid referrals to unlock baseline share
export const REFERRAL_ACU = 250; // ACU per successful PAID referral booking

export const PARTNER_TIERS = {
  referrer: { key: 'referrer', name: 'Referrer', rate: 0.0025, minFollowers: 0, requiresApproval: false, unlockReferrals: REFERRER_REVSHARE_UNLOCK },
  rising: { key: 'rising', name: 'Rising Influencer', rate: 0.0025, minFollowers: 5000, requiresApproval: true, unlockReferrals: 0 },
  ambassador: { key: 'ambassador', name: 'Global Travel Ambassador', rate: 0.01, minFollowers: 10000, requiresApproval: true, unlockReferrals: 0 },
};

// The tier a partner qualifies for by followers (highest first). Approval is
// enforced by the caller — this only reports eligibility.
export function tierForFollowers(followers = 0) {
  if (followers >= PARTNER_TIERS.ambassador.minFollowers) return PARTNER_TIERS.ambassador;
  if (followers >= PARTNER_TIERS.rising.minFollowers) return PARTNER_TIERS.rising;
  return PARTNER_TIERS.referrer;
}

// The effective revenue-share rate for a partner right now.
//  - An approved influencer uses their approved tier's rate.
//  - Otherwise a plain referrer earns the baseline rate ONLY after unlocking
//    (>= 20 paid referrals); below that, 0 (they still earn 250 ACU/referral).
export function effectiveRevshareRate({ approvedTier = null, paidReferrals = 0 } = {}) {
  if (approvedTier && PARTNER_TIERS[approvedTier]) return PARTNER_TIERS[approvedTier].rate;
  return paidReferrals >= REFERRER_REVSHARE_UNLOCK ? PARTNER_TIERS.referrer.rate : 0;
}

// Accrue revenue share for ONE net-revenue event from a referred customer,
// respecting the per-customer £20,000 lifetime cap. `alreadyEarnedGbp` is what
// this partner has already earned FROM THIS customer.
// Returns the payable amount (GBP) for this event, never pushing past the cap.
export function accrueRevshare({ netRevenueGbp, rate, alreadyEarnedGbp = 0 }) {
  if (!(netRevenueGbp > 0) || !(rate > 0)) return 0;
  const remainingCap = Math.max(0, REVSHARE_CAP_GBP - alreadyEarnedGbp);
  if (remainingCap <= 0) return 0;
  const raw = netRevenueGbp * rate;
  return Math.round(Math.min(raw, remainingCap) * 100) / 100;
}

// ---- §6 Commission Protection --------------------------------------------
// Last-valid attribution within a window (days). A self-referral (referrer ===
// friend) is never valid. Returns whether a referral attribution should stand.
export const ATTRIBUTION_WINDOW_DAYS = 30;

export function isValidAttribution({ referrerId, friendId, referrerStanding = 'good' } = {}) {
  if (!referrerId || !friendId) return false;
  if (referrerId === friendId) return false;          // self-referral
  if (referrerStanding !== 'good') return false;       // suspended/forfeited
  return true;
}

// Net revenue after reversals: commission earned minus any refunded/charged-back
// /reversed portion. Never negative.
export function netRevenueAfterReversals({ grossCommissionGbp = 0, reversedGbp = 0 } = {}) {
  return Math.max(0, Math.round((grossCommissionGbp - reversedGbp) * 100) / 100);
}

// ---- §4 Partner dashboard: derive metrics from raw ledgers ----------------
// Pure aggregator — store.js feeds it the partner's referrals, revenue-share
// ledger rows, ACU earned and withdrawals; it returns the dashboard shape.
export function derivePartnerMetrics({
  referrals = [], activeTravellers = 0, revshareRows = [], acuEarned = 0,
  bookingValueGbp = 0, revenueGbp = 0, withdrawals = [], rank = null, tier = 'referrer',
  paidReferrals = 0,
} = {}) {
  // Reversed rows (cancelled/refunded bookings) are subtracted from lifetime via
  // netRevenueAfterReversals, and excluded from the monthly figure — a partner
  // does not keep commission on a booking that was cancelled.
  const grossLifetime = revshareRows.reduce((s, r) => s + (r.amountGbp || 0), 0);
  const reversedGbp = revshareRows.filter((r) => r.reversed).reduce((s, r) => s + (r.amountGbp || 0), 0);
  const lifetime = netRevenueAfterReversals({ grossCommissionGbp: grossLifetime, reversedGbp });
  const paid = withdrawals.filter((w) => w.status === 'paid').reduce((s, w) => s + (w.amountGbp || 0), 0);
  const pending = Math.round((lifetime - paid) * 100) / 100;
  const now = thisMonthKey(revshareRows);
  const monthly = revshareRows.filter((r) => !r.reversed && (r.at || '').slice(0, 7) === now).reduce((s, r) => s + (r.amountGbp || 0), 0);
  const conversion = referrals.length ? Math.round((paidReferrals / referrals.length) * 1000) / 10 : 0;
  return {
    tier,
    totalReferrals: referrals.length,
    paidReferrals,
    activeTravellers,
    lifetimeEarningsGbp: round2(lifetime),
    monthlyEarningsGbp: round2(monthly),
    pendingCommissionGbp: Math.max(0, pending),
    paidCommissionGbp: round2(paid),
    totalAcuEarned: Math.round(acuEarned),
    conversionRatePct: conversion,
    bookingValueGbp: round2(bookingValueGbp),
    revenueGeneratedGbp: round2(revenueGbp),
    leaderboardRank: rank,
    revshareRate: effectiveRevshareRate({ approvedTier: tier === 'referrer' ? null : tier, paidReferrals }),
    capPerCustomerGbp: REVSHARE_CAP_GBP,
    withdrawalHistory: withdrawals,
  };
}

// The most recent month present in the ledger (so "this month" is meaningful in
// tests/back-dated data); falls back to the latest row.
function thisMonthKey(rows) {
  if (!rows.length) return '0000-00';
  return rows.map((r) => (r.at || '').slice(0, 7)).sort().pop();
}
function round2(n) { return Math.round((n || 0) * 100) / 100; }

// ---- §5 AI Growth Engine: the partner toolkit (catalogue) -----------------
export const AI_GROWTH_TOOLS = [
  { key: 'social_post', label: 'AI social media post generator' },
  { key: 'travel_advert', label: 'AI travel advert creator' },
  { key: 'email_campaign', label: 'AI email campaign generator' },
  { key: 'landing_page', label: 'AI landing page builder' },
  { key: 'hashtags', label: 'AI hashtag generator' },
  { key: 'video_script', label: 'AI video script generator' },
  { key: 'perf_recommendations', label: 'AI performance recommendations' },
  { key: 'audience_optimisation', label: 'AI audience optimisation' },
  { key: 'campaign_analytics', label: 'AI campaign analytics' },
  { key: 'best_time', label: 'AI best posting time recommendations' },
];
