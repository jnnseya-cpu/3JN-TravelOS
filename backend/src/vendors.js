// 3JN Travel OS — Vendor Partner Programme (docs/VENDOR-PARTNER-PROGRAMME.md).
//
// Sell More. Earn Weekly. Grow Without Owning the Platform.
//
// Pure, testable logic for the vendor commission model, the monthly top-seller
// bonus, weekly payout eligibility and the AI risk review. Stateful pieces
// (profiles, sales ledger, payout batches) live in store.js and call in here so
// the numbers can never drift between the portal, payouts and admin views.
//
// PROFITABILITY PROTECTION (never weaken): commission is carved out of the 10%
// platform fee, never on top of it. The platform ALWAYS keeps its minimum
// margin — independents 7% (6% in a bonus month), registered 6% (5% in a bonus
// month) — and commission is never paid on refunded/charged-back/fraudulent or
// self-dealt sales.

export const PLATFORM_FEE_RATE = 0.10; // 10% service fee on eligible sales

export const VENDOR_TIERS = {
  independent: {
    key: 'independent', name: 'Independent Vendor Partner',
    commissionRate: 0.03, bonusRate: 0.04, // +1% in a top-seller month
    requiresRegistration: false,
  },
  registered: {
    key: 'registered', name: 'Registered Travel Agent / Agency / Retailer',
    commissionRate: 0.04, bonusRate: 0.05,
    requiresRegistration: true,
    requiredDocs: [
      'Company registration certificate', 'Travel agency licence (where applicable)',
      'Tax registration', 'Business address', 'Director or owner ID',
      'Proof of professional activity', 'Bank account in business name',
      'Compliance declaration',
    ],
  },
};

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// The commission split for one eligible sale. `hasBonus` = seller holds this
// month's top-seller bonus. Returns every line so the ledger is transparent.
export function commissionSplit(saleGbp, tierKey, { hasBonus = false } = {}) {
  const tier = VENDOR_TIERS[tierKey] || VENDOR_TIERS.independent;
  const sale = Math.max(0, Number(saleGbp) || 0);
  const platformFeeGbp = round2(sale * PLATFORM_FEE_RATE);
  const rate = hasBonus ? tier.bonusRate : tier.commissionRate;
  const vendorGbp = round2(sale * rate);
  return {
    tier: tier.key, saleGbp: round2(sale), platformFeeGbp,
    vendorRate: rate, vendorGbp,
    platformKeepsGbp: round2(platformFeeGbp - vendorGbp),
    platformKeepsRate: round2(PLATFORM_FEE_RATE - rate),
    bonusApplied: hasBonus,
  };
}

// §3/§7 — is a recorded sale releasable in a weekly payout run?
// `todayISO` gates on SERVICE COMPLETION: commission on a flight releases only
// after the departure/return date has PASSED, a stay only after checkout, etc.
// A sale with no travel date (eSIM, visa service — consumed immediately) has no
// serviceDate and releases on the next run. This protects the platform from
// paying commission on trips that could still cancel, refund or charge back.
export function saleIsPayable(sale, todayISO) {
  if (!sale) return false;
  if (sale.status !== 'confirmed') return false;              // sale confirmed
  if (!sale.paymentCleared) return false;                     // payment cleared
  if (sale.refunded || sale.chargeback || sale.fraudFlag) return false;
  if (!sale.validated) return false;                          // booking validated
  if (sale.complianceHold) return false;                      // compliance passed
  if (sale.paidOut) return false;                             // not already paid
  if (sale.serviceDate && todayISO && sale.serviceDate >= todayISO) return false; // travel not completed yet
  return true;
}

// The date the SERVICE completes for a booking — the latest dated moment across
// every component: return/outbound flight date, stay checkout, transfer date…
// Null when nothing is dated (immediately-consumed services).
export function serviceCompletionDate(booking) {
  const dates = [];
  for (const c of booking?.option?.components || []) {
    const d = c.details || {};
    if (d.inbound?.date) dates.push(d.inbound.date);
    if (d.outbound?.date) dates.push(d.outbound.date);
    if (d.checkOut) dates.push(d.checkOut);
    else if (d.checkIn && d.nights) {
      const end = new Date(`${d.checkIn}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + Number(d.nights || 0));
      dates.push(end.toISOString().slice(0, 10));
    } else if (d.checkIn) dates.push(d.checkIn);
    if (d.date && !d.outbound) dates.push(d.date);
  }
  return dates.length ? dates.sort().pop() : null;
}

// §2 — pick the top seller of a month from the sales ledger (by eligible sale
// value). Returns the vendorId or null. Ties break on sale count then id.
export function topSellerForMonth(sales, monthKey) {
  const totals = new Map(); const counts = new Map();
  for (const s of sales) {
    if ((s.at || '').slice(0, 7) !== monthKey) continue;
    if (s.refunded || s.chargeback || s.fraudFlag) continue;
    totals.set(s.vendorId, (totals.get(s.vendorId) || 0) + (s.saleGbp || 0));
    counts.set(s.vendorId, (counts.get(s.vendorId) || 0) + 1);
  }
  let best = null;
  for (const [vid, tot] of totals) {
    if (!best || tot > best.tot || (tot === best.tot && (counts.get(vid) || 0) > best.count)) {
      best = { vid, tot, count: counts.get(vid) || 0 };
    }
  }
  return best ? best.vid : null;
}

// The previous calendar month key ("2026-06" for any date in July 2026).
export function previousMonthKey(dateISO) {
  const d = new Date(`${(dateISO || '').slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

// ---- §4 AI Risk Review ------------------------------------------------------
// Deterministic multi-signal screening (same philosophy as VisaOS/host review):
// each signal scores 0–100 from the application data; an overall risk above the
// threshold fails. Applicants may also be hard-failed by sanctions screening.
export const VENDOR_RISK_SIGNALS = [
  'Identity verification', 'Proof of address', 'Online footprint',
  'Social media credibility', 'Fraud risk signals', 'Previous business activity',
  'Reputation checks', 'Behavioural risk profile', 'Payment risk',
  'Travel-related compliance risk', 'Sanctions and blacklist screening',
  'Document authenticity',
];
export const VENDOR_RISK_THRESHOLD = 45; // overall risk above this → rejected

function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}

export function vendorRiskReview(application = {}) {
  const a = application;
  const rnd = seeded(`vendor-risk|${a.name || ''}|${a.email || ''}|${a.tier || ''}`);
  const provided = {
    identity: !!a.identityDoc, address: !!a.addressProof,
    socials: Array.isArray(a.socialHandles) && a.socialHandles.length > 0,
    business: !!a.businessHistory, docs: (a.documents || []).length,
  };
  const signals = VENDOR_RISK_SIGNALS.map((signal) => {
    let base = 12 + rnd() * 28; // deterministic residual risk 12–40
    if (signal === 'Identity verification' && !provided.identity) base += 45;
    if (signal === 'Proof of address' && !provided.address) base += 40;
    if ((signal === 'Online footprint' || signal === 'Social media credibility') && !provided.socials) base += 25;
    if (signal === 'Previous business activity' && !provided.business) base += 20;
    if (signal === 'Document authenticity' && a.tier === 'registered' && provided.docs < 4) base += 35;
    return { signal, risk: Math.min(100, Math.round(base)) };
  });
  const sanctionsHit = /sanction|blacklist/i.test(a.flags || '');
  // KYC hard gates: no identity or address evidence → can never auto-approve,
  // regardless of the averaged score. (Registered tier also needs its docs.)
  const kycIncomplete = !provided.identity || !provided.address
    || (a.tier === 'registered' && provided.docs < 4);
  const overall = Math.round(signals.reduce((s, x) => s + x.risk, 0) / signals.length);
  const passed = !sanctionsHit && !kycIncomplete && overall <= VENDOR_RISK_THRESHOLD;
  return {
    signals, overallRisk: overall, threshold: VENDOR_RISK_THRESHOLD,
    sanctionsHit, kycIncomplete, passed,
    recommendation: sanctionsHit ? 'REJECT — sanctions/blacklist hit'
      : kycIncomplete ? 'REFER — KYC incomplete (identity/address/registration docs required)'
      : passed ? 'APPROVE — risk within tolerance'
      : 'REFER — risk above threshold; manual compliance review required',
  };
}

// ---- §5/§7 portal metrics ---------------------------------------------------
export function deriveVendorMetrics({ sales = [], payouts = [], tier = 'independent', hasBonus = false, rank = null, todayISO = null } = {}) {
  const eligible = sales.filter((s) => !s.refunded && !s.chargeback && !s.fraudFlag);
  const earned = round2(eligible.reduce((s, x) => s + (x.vendorGbp || 0), 0));
  const paid = round2(payouts.filter((p) => p.status === 'paid').reduce((s, p) => s + (p.amountGbp || 0), 0));
  // Held until the trip completes (departure/checkout not yet passed).
  const held = round2(eligible.filter((s) => !s.paidOut && s.serviceDate && todayISO && s.serviceDate >= todayISO)
    .reduce((s, x) => s + (x.vendorGbp || 0), 0));
  const monthKey = (sales.map((s) => (s.at || '').slice(0, 7)).sort().pop()) || '';
  const thisMonth = eligible.filter((s) => (s.at || '').slice(0, 7) === monthKey);
  const t = VENDOR_TIERS[tier] || VENDOR_TIERS.independent;
  return {
    tier, tierName: t.name,
    commissionRatePct: round2((hasBonus ? t.bonusRate : t.commissionRate) * 100),
    topSellerBonusActive: hasBonus,
    totalSales: eligible.length,
    salesValueGbp: round2(eligible.reduce((s, x) => s + (x.saleGbp || 0), 0)),
    commissionEarnedGbp: earned,
    commissionPaidGbp: paid,
    pendingPayoutGbp: round2(Math.max(0, earned - paid - held)),
    heldUntilTravelGbp: held, // releases the first Friday after the trip completes
    thisMonthSalesGbp: round2(thisMonth.reduce((s, x) => s + (x.saleGbp || 0), 0)),
    leaderboardRank: rank,
    payoutDay: 'Friday (automatic, weekly)',
  };
}
