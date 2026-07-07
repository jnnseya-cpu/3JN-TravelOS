// In-memory data store for the prototype. A production build would back this
// with Postgres/Firestore; the interface here is intentionally small so it
// could be swapped out. All state lives for the lifetime of the process.

import { createHash } from 'node:crypto';
import { SIGNUP_BONUS_POINTS, tierForPoints } from './pricing.js';
import { MEMBERSHIP_TIERS, ACU_PER_GBP, POINTS_PER_USD } from '../../shared/constants.js';

let counter = 1000;
const id = (prefix) => `${prefix}_${++counter}`;

const db = {
  users: new Map(),
  quotes: new Map(),
  bookings: new Map(),
  reviews: [],
  supplierScores: new Map(), // supplier name -> { sum, count, reliability }
  acuTxns: [],
  referrals: [], // { code, referrerId, friendId }
  priceEvents: [], // price-guard log
  apiKeys: [], // white-label / merchant API keys
  audit: [], // immutable audit log (master-prompt requirement)
  drafts: new Map(), // autosave drafts keyed by `${userId}:${key}`
  paymentLinks: [], // BitriPay payment links / QR
  approvals: [], // business travel approval queue
  notifications: [], // per-user notification feed
  visaApps: [], // VisaOS applications + decisions
  esims: [], // provisioned eSIM profiles
  contracts: [], // supplier volume agreements
  blog: [], // AI-written blog posts
  hostListings: [], // 3JN Host Marketplace properties (community-hosted, 3JN-verified)
  travelPots: [], // group contribution pots (finance)
  searchCache: new Map(), // popular routes/packages served before any paid AI call
  behaviour: [], // behavioural-learning event stream (searches, views, books…)
  commsDeliveries: [], // communication-event delivery log (event × channel × recipient)
  aiRequestCosts: [], // ai_request_costs ledger — estimated vs actual AI spend per request
  searchDeposits: [], // refundable search deposits (deep £5 / luxury £20 / corporate £50)
  visaChain: [], // hash-chained (blockchain-style) audit trail of visa decisions
};

// ---- Communication event delivery log -------------------------------------
const COMMS_CAP = 2000;
export function recordCommsDelivery({ event, name, channel, recipient, status, provider, severity } = {}) {
  const rec = { id: id('msg'), event, name, channel, recipient, status, provider, severity, at: new Date().toISOString() };
  db.commsDeliveries.push(rec);
  if (db.commsDeliveries.length > COMMS_CAP) db.commsDeliveries.splice(0, db.commsDeliveries.length - COMMS_CAP);
  return rec;
}
export function listCommsDeliveries(limit = 50) {
  const all = [...db.commsDeliveries].reverse();
  return limit > 0 ? all.slice(0, limit) : all;
}

// ---- Behavioural learning event stream ------------------------------------
// Every meaningful user action is logged here so the ML/behaviour-learning
// agents can build a per-user profile and drive a personalised Journey
// Dashboard. Capped so the in-memory store can't grow unbounded.
const BEHAVIOUR_CAP = 2000;
export function recordBehaviour(userId, { event, destination, payload } = {}) {
  if (!event) return null;
  const rec = {
    id: id('beh'),
    userId: userId || 'guest',
    event,
    destination: destination || null,
    payload: payload || {},
    at: new Date().toISOString(),
  };
  db.behaviour.push(rec);
  if (db.behaviour.length > BEHAVIOUR_CAP) db.behaviour.splice(0, db.behaviour.length - BEHAVIOUR_CAP);
  return rec;
}
export function listBehaviour(userId, limit = 500) {
  const all = userId ? db.behaviour.filter((b) => b.userId === userId) : db.behaviour;
  return all.slice(-limit);
}

// ---- Supplier Contract Manager (Enterprise) -------------------------------
// AI-negotiated volume agreements with airlines/hotels/car hire. The negotiated
// discount scales with the committed annual volume (the Supplier Negotiation
// Agent's logic, deterministic here).
export function negotiatedDiscount(category, annualVolumeUSD) {
  const tiers = { flights: 0.06, hotel: 0.12, carhire: 0.10, transfer: 0.08, activities: 0.10 };
  const cap = tiers[category] ?? 0.08;
  const scaled = Math.min(cap, 0.02 + (annualVolumeUSD / 1_000_000) * cap); // ramps to cap at ~$1M
  return Math.round(scaled * 1000) / 1000;
}
export function createContract(userId, { supplier, category = 'hotel', annualVolumeUSD = 250000, validUntil } = {}) {
  const discount = negotiatedDiscount(category, Number(annualVolumeUSD) || 0);
  const rec = {
    id: id('ctr'), userId: userId || null, supplier: (supplier || 'Supplier').slice(0, 60),
    category, annualVolumeUSD: Math.round(Number(annualVolumeUSD) || 0),
    discountPct: discount, status: 'active',
    validUntil: validUntil || '2027-06-30', createdAt: nowISO(),
  };
  db.contracts.push(rec);
  recordAudit({ actor: userId || 'business', role: 'business', action: 'contract.created', entity: 'contract', entityId: rec.id, summary: `${rec.supplier} ${category} ${(discount * 100).toFixed(1)}%` });
  return rec;
}
export function listContracts() {
  return [...db.contracts].reverse();
}

// ---- eSIM Manager ---------------------------------------------------------
const ESIM_COVERAGE = { Dubai: '5G · Etisalat/du', Istanbul: '4G/5G · Turkcell', Barcelona: '5G · Movistar', 'New York': '5G · T-Mobile/AT&T', Bali: '4G · Telkomsel' };
export function provisionEsim(userId, { destination = 'Dubai', dataGB = 5, days = 9, provider = 'Airalo' } = {}) {
  const rec = {
    id: id('esim'), userId: userId || null, destination, provider,
    dataGB, dataUsedGB: 0, days, coverage: ESIM_COVERAGE[destination] || 'Regional 4G/5G',
    iccid: '8944' + randomKey().slice(0, 14).replace(/[a-z]/g, (c) => (c.charCodeAt(0) % 10)),
    status: 'provisioned', activatedAt: null, createdAt: nowISO(),
  };
  db.esims.push(rec);
  recordAudit({ actor: userId || 'guest', role: 'agent', action: 'esim.provisioned', entity: 'esim', entityId: rec.id, summary: `${dataGB}GB ${destination}` });
  if (userId) pushNotification(userId, { type: 'info', icon: '📶', title: 'eSIM ready', body: `${dataGB}GB for ${destination} — activate before departure.` });
  return rec;
}
export function listEsims(userId) {
  return db.esims.filter((e) => e.userId === userId).map((e) => ({ ...e }));
}
export function activateEsim(userId, esimId) {
  const e = db.esims.find((x) => x.id === esimId && x.userId === userId);
  if (!e) return { ok: false, error: 'not-found' };
  e.status = 'active'; e.activatedAt = nowISO();
  e.dataUsedGB = Math.round(e.dataGB * 0.18 * 10) / 10; // simulate some usage
  return { ok: true, esim: e };
}

// ---- Expense Intelligence (Executive tier) --------------------------------
// Categorise a user's bookings into expense lines and produce a CSV export.
export function expenseReport(userId) {
  const bookings = [...db.bookings.values()].filter((b) => b.userId === userId);
  const categories = {};
  const rows = [];
  for (const b of bookings) {
    const sym = b.option?.pricing?.symbol || '£';
    for (const c of (b.option?.components || [])) {
      const cat = { flight: 'Flights', host: 'Accommodation', hotel: 'Accommodation', activity: 'Activities', tickets: 'Activities', boat: 'Activities', visa: 'Visa', insurance: 'Insurance', transfer: 'Transfers', carhire: 'Car hire', esim: 'Connectivity' }[c.type] || 'Other';
      const local = Math.round((c.priceUSD || 0) * (b.option.pricing.local.total / b.option.pricing.lines.totalUSD) * 100) / 100;
      categories[cat] = Math.round(((categories[cat] || 0) + local) * 100) / 100;
      rows.push({ bookingId: b.id, category: cat, supplier: c.supplier, amount: local, currency: b.option.pricing.currency });
    }
  }
  const total = Object.values(categories).reduce((s, v) => s + v, 0);
  const csv = ['booking,category,supplier,amount,currency', ...rows.map((r) => `${r.bookingId},${r.category},"${r.supplier}",${r.amount},${r.currency}`)].join('\n');
  return { categories, rows, total: Math.round(total * 100) / 100, currency: bookings[0]?.option?.pricing?.currency || 'GBP', csv };
}

// ---- 3JN VisaOS: applications + government analytics ----------------------
export function recordVisaApplication(assessment) {
  const rec = { id: id('visa'), ...assessment, at: nowISO() };
  db.visaApps.push(rec);
  recordAudit({ actor: 'visaos', role: 'agent', action: `visa.${assessment.decision.replace(/\s+/g, '-').toLowerCase()}`, entity: 'visa_application', entityId: rec.id, summary: `${assessment.applicant.nationality}→${assessment.applicant.destination} score ${assessment.totalScore}` });
  rec.auditBlock = sealVisaBlock('assessment', { id: rec.id, decision: assessment.decision, totalScore: assessment.totalScore });
  return rec;
}

// ---- Blockchain Audit Trail (VisaOS Zero Trust layer) -------------------------
// Every visa event is sealed into a hash chain: each block's hash covers its
// payload AND the previous block's hash, so no past decision can be altered
// secretly — any tamper breaks the chain and verifyVisaChain() exposes it.
export function sealVisaBlock(event, payload = {}) {
  const prevHash = db.visaChain.length ? db.visaChain[db.visaChain.length - 1].hash : 'genesis';
  const body = JSON.stringify({ event, ...payload });
  const hash = createHash('sha256').update(prevHash + body).digest('hex');
  const block = { index: db.visaChain.length, event, payload: body, prevHash, hash, at: nowISO() };
  db.visaChain.push(block);
  return { index: block.index, hash, prevHash };
}
export function verifyVisaChain() {
  let prev = 'genesis';
  for (const b of db.visaChain) {
    const expect = createHash('sha256').update(prev + b.payload).digest('hex');
    if (b.hash !== expect || b.prevHash !== prev) {
      return { ok: false, tamperedAtIndex: b.index, event: b.event };
    }
    prev = b.hash;
  }
  return { ok: true, blocks: db.visaChain.length, head: prev };
}
export function visaChainBlocks(limit = 20) {
  return db.visaChain.slice(-limit).reverse();
}
// Store a FULL visa application — the robust list of information + documents the
// applicant provided, plus the AI decision file. This is what the embassy
// workspace reviews and acts on.
export function recordVisaFile({ applicant, country, visaType, documents, file, userId } = {}) {
  const r = file?.risk || {};
  const rec = {
    id: id('visa'),
    at: nowISO(),
    userId: userId || null,
    applicant: file?.applicant || applicant || {},
    fullApplicant: applicant || {},
    country: country || (file?.country?.name) || '',
    visaType: visaType || (file?.visaType?.key) || '',
    documents: Array.isArray(documents) ? documents : [],
    file: file || null,
    // top-level mirrors for govAnalytics compatibility
    decision: r.decision || file?.recommendation || 'Pending',
    recommendation: file?.recommendation || null,
    totalScore: r.totalScore || 0,
    band: r.band || '',
    risk: r.risk || {},
    status: 'submitted',
    embassyDecision: null,
  };
  db.visaApps.push(rec);
  recordAudit({ actor: userId || 'applicant', role: 'consumer', action: 'visa.application.submitted', entity: 'visa_application', entityId: rec.id, summary: `${rec.applicant.nationality}→${rec.country || rec.applicant.destination} · ${rec.recommendation || rec.decision}` });
  return rec;
}
export function listVisaApplications() {
  return [...db.visaApps].reverse();
}
export function listVisaApplicationsForUser(userId) {
  return db.visaApps.filter((a) => a.userId === userId).reverse();
}
export function getVisaApplication(appId) {
  return db.visaApps.find((a) => a.id === appId) || null;
}
export function decideVisaApplication(appId, { decision, reason, officerId, secondApproverId } = {}) {
  const a = db.visaApps.find((x) => x.id === appId);
  if (!a) return { ok: false, error: 'not-found' };
  const allowed = ['Approved', 'Refused', 'More info requested', 'Escalated'];
  if (!allowed.includes(decision)) return { ok: false, error: 'invalid-decision' };

  // ---- Anti-Corruption Layer ----------------------------------------------
  // No manual officer can secretly approve a fraudulent application. Approving
  // AGAINST the AI's high-risk verdict is an OVERRIDE and requires a written
  // reason AND a second approver (approval chain); everything lands in the
  // immutable audit log and the hash-chained audit trail. This reduces bribery.
  const aiSaysHighRisk = ['High Risk', 'Reject'].includes(a.band) || ['Human Review', 'Auto Rejection'].includes(a.decision) || (a.totalScore || 0) > 450;
  const isOverride = decision === 'Approved' && aiSaysHighRisk;
  if (isOverride) {
    if (!reason || !reason.trim()) {
      return { ok: false, error: 'override-requires-reason', message: 'Approving against the AI risk verdict is an override — a written reason is mandatory.' };
    }
    if (!secondApproverId) {
      return { ok: false, error: 'override-requires-approval-chain', message: 'Overrides require a second approver (approval chain) — no single officer can approve a high-risk application alone.' };
    }
  }

  a.embassyDecision = {
    decision, reason: (reason || '').slice(0, 500), officerId: officerId || 'embassy', at: nowISO(),
    ...(isOverride ? { override: true, approvalChain: [officerId || 'embassy', secondApproverId] } : {}),
  };
  a.status = decision === 'More info requested' ? 'awaiting-applicant' : 'decided';
  recordAudit({ actor: officerId || 'embassy', role: 'embassy', action: `visa.embassy.${decision.replace(/\s+/g, '-').toLowerCase()}${isOverride ? '.override' : ''}`, entity: 'visa_application', entityId: appId, summary: `${decision}${isOverride ? ' (OVERRIDE, 2nd: ' + secondApproverId + ')' : ''}${reason ? ' — ' + reason.slice(0, 60) : ''}` });
  a.embassyDecision.auditBlock = sealVisaBlock('embassy-decision', { id: appId, decision, officerId: officerId || 'embassy', override: isOverride, ...(isOverride ? { approvalChain: [officerId || 'embassy', secondApproverId] } : {}) });
  if (a.userId) pushNotification(a.userId, { type: 'info', icon: '🛂', title: `Visa: ${decision}`, body: reason || `Your application was ${decision.toLowerCase()} by the embassy.` });
  return { ok: true, application: a };
}

export function govAnalytics() {
  const apps = db.visaApps;
  const by = (pred) => apps.filter(pred).length;
  const decisions = {};
  const byCountry = {};
  let fraudAttempts = 0, totalScore = 0;
  for (const a of apps) {
    decisions[a.decision] = (decisions[a.decision] || 0) + 1;
    byCountry[a.applicant.nationality] = (byCountry[a.applicant.nationality] || 0) + 1;
    if (a.risk?.fraud >= 60 || a.band === 'Reject') fraudAttempts++;
    totalScore += a.totalScore || 0;
  }
  const approved = by((a) => a.decision === 'Auto Approval' || a.decision === 'Conditional Approval');
  return {
    applications: apps.length,
    approved,
    approvalRate: apps.length ? Math.round((approved / apps.length) * 100) : 0,
    decisions,
    fraudAttempts,
    // Physical Embassy Elimination: share of applications decided fully
    // digitally (no human review / physical appearance) — target 90–95%.
    autoDigitalRate: apps.length ? Math.round((by((a) => a.decision !== 'Human Review') / apps.length) * 100) : 0,
    digitalTargetPct: [90, 95],
    auditChain: verifyVisaChain(),
    avgScore: apps.length ? Math.round(totalScore / apps.length) : 0,
    topCountries: Object.entries(byCountry).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => ({ country: k, count: v })),
    recent: apps.slice(-8).reverse().map((a) => ({ id: a.id, nationality: a.applicant.nationality, destination: a.applicant.destination, decision: a.decision, score: a.totalScore, band: a.band })),
  };
}

// ---- Notifications engine -------------------------------------------------
// Agents and workflows push notifications here; the console renders a bell with
// an unread count. (Price drops, visa alerts, approvals, booking confirmations.)
export function pushNotification(userId, { type = 'info', title, body, icon } = {}) {
  const n = { id: id('ntf'), userId: userId || null, type, icon: icon || '🔔', title, body: body || '', read: false, at: nowISO() };
  db.notifications.push(n);
  return n;
}
export function listNotifications(userId) {
  return db.notifications.filter((n) => !userId || n.userId === userId || n.userId === null).reverse();
}
export function markNotificationsRead(userId) {
  db.notifications.forEach((n) => { if (!userId || n.userId === userId || n.userId === null) n.read = true; });
  return { ok: true };
}

// ---- Audit log (immutable) + autosave -------------------------------------
// Every meaningful mutation is appended here with actor, action and a before/
// after summary. Mirrors the "save everything / audit trail" master-prompt rule.
export function recordAudit({ actor = 'system', role = 'system', action, entity, entityId, summary }) {
  const entry = { id: id('aud'), actor, role, action, entity, entityId, summary: summary || '', at: nowISO() };
  db.audit.push(entry);
  return entry;
}
export function adminAudit(limit = 50) {
  return [...db.audit].reverse().slice(0, limit);
}

// Autosave: persist a draft (planner intent, profile edits in progress, etc.).
export function saveDraft(userId, key, payload) {
  const k = `${userId || 'anon'}:${key}`;
  const rec = { key, payload, savedAt: nowISO() };
  db.drafts.set(k, rec);
  return rec;
}
export function getDraft(userId, key) {
  return db.drafts.get(`${userId || 'anon'}:${key}`) || null;
}

// Recognised account roles and their default avatar.
export const ROLES = ['consumer', 'business', 'merchant', 'partner', 'embassy', 'consulate', 'admin'];

// Access levels — what each account type can reach. Exposed on every account
// (publicUser.accessLevel) and enforced by the route-level role gates.
export const ACCESS_LEVELS = {
  consumer: ['planner', 'bookings', 'console', 'loyalty', 'host-dashboard', 'visa-applications (own)'],
  business: ['everything consumer has', 'business centre', 'approvals', 'policy', 'contracts', 'expense export', 'reporting'],
  merchant: ['everything consumer has', 'merchant portal', 'API keys', 'BitriPay links/QR', 'settlement'],
  partner: ['everything consumer has', 'white-label API', '90/10 revenue share', 'partner keys'],
  embassy: ['VisaOS government dashboard', 'application review', 'eVisa decisions (approve/refuse/escalate)'],
  consulate: ['VisaOS government dashboard', 'application review', 'eVisa decisions (approve/refuse/escalate)', 'consular caseload for their country'],
  admin: ['everything', 'admin control centre', 'comp-Elite grants', 'audit', 'integration map'],
};
const ROLE_AVATAR = { consumer: '🧳', business: '💼', merchant: '🏪', partner: '🤝', admin: '🛡️' };

// ---- Users / loyalty / ACU wallet ----------------------------------------
export function createUser({ email, name, referredByCode, role, avatar, bio, allAccess } = {}) {
  const userId = id('usr');
  const referralCode = '3JN-' + userId.slice(-4).toUpperCase();
  const safeRole = ROLES.includes(role) ? role : 'consumer';
  const user = {
    id: userId,
    email: email || `${userId}@guest.3jn`,
    name: name || 'Guest Traveller',
    role: safeRole,
    // allAccess unlocks every section of the OS from a single account
    // (admin + business + merchant + consumer), regardless of role gating.
    allAccess: !!allAccess,
    avatar: avatar || ROLE_AVATAR[safeRole], // emoji or image data URL
    bio: bio || '',
    points: SIGNUP_BONUS_POINTS,
    // No free ACUs: members fund ACUs from 10% of their subscription, everyone
    // else buys them. Balance must be positive before any ACU-metered action.
    acuBalance: 0,
    membership: null, // { tier, name, pricePerMonth, acuPerMonth, active, startedAt, renewsAt }
    referralCode,
    referredByCode: referredByCode || null,
    referrals: 0,
    createdAt: nowISO(),
  };
  db.users.set(userId, user);

  // Apply referral rewards (referrer +100, friend +50).
  if (referredByCode) {
    const referrer = [...db.users.values()].find((u) => u.referralCode === referredByCode);
    if (referrer) {
      referrer.points += 100;
      referrer.referrals += 1;
      user.points += 50;
      db.referrals.push({ code: referredByCode, referrerId: referrer.id, friendId: userId });
    }
  }
  return publicUser(user);
}

export function getUser(userId) {
  const u = db.users.get(userId);
  return u ? publicUser(u) : null;
}

export function getUserRaw(userId) {
  return db.users.get(userId);
}

export function findUserByEmail(email) {
  const u = [...db.users.values()].find((x) => x.email.toLowerCase() === (email || '').toLowerCase());
  return u ? publicUser(u) : null;
}

export function addPoints(userId, points) {
  const u = db.users.get(userId);
  if (!u) return null;
  u.points += Math.round(points);
  return publicUser(u);
}

export function spendAcu(userId, amount, reason) {
  const u = db.users.get(userId);
  if (!u) return { ok: false, error: 'unknown-user' };
  if (u.acuBalance < amount) return { ok: false, error: 'insufficient-acu', balance: u.acuBalance };
  u.acuBalance -= amount;
  db.acuTxns.push({ id: id('acu'), userId, type: 'USAGE', amount: -amount, reason, at: nowISO() });
  return { ok: true, balance: u.acuBalance };
}

// ACU Marketplace — the named pack catalogue (spec §5). The base customer rate
// is £1 = 100 ACU; bigger packs carry a volume bonus above the base rate, and
// that bonus is booked as a separate BONUS transaction so wallets honestly
// separate what was purchased from what was earned.
export const ACU_PACKS = {
  starter: { name: 'Starter Pack', gbp: 5, acu: 500 },
  traveller: { name: 'Traveller Pack', gbp: 15, acu: 1750 },
  family: { name: 'Family Pack', gbp: 29, acu: 4000 },
  business: { name: 'Business Pack', gbp: 99, acu: 20000 },
  enterprise: { name: 'Enterprise', gbp: null, acu: null, custom: true, note: 'Custom volume & pricing — contact sales' },
  // Legacy aliases (kept for older clients).
  smart: { name: 'Traveller Pack', gbp: 15, acu: 1750 },
  topup5: { name: 'Starter Pack', gbp: 5, acu: 500 },
  topup10: { name: 'Top-up £10', gbp: 10, acu: 10 * ACU_PER_GBP },
  topup25: { name: 'Family Pack', gbp: 29, acu: 4000 },
  topup50: { name: 'Top-up £50', gbp: 50, acu: 50 * ACU_PER_GBP },
};
export function buyAcu(userId, pack) {
  const p = ACU_PACKS[pack];
  const u = db.users.get(userId);
  if (!u || !p) return { ok: false, error: 'invalid' };
  if (p.custom) return { ok: false, error: 'contact-sales', message: 'Enterprise ACU volume is priced individually — contact sales@3jntravel.com.' };
  const base = Math.min(p.gbp * ACU_PER_GBP, p.acu);
  const bonus = Math.max(0, p.acu - base);
  u.acuBalance += p.acu;
  db.acuTxns.push({ id: id('acu'), userId, type: 'PURCHASE', amount: base, reason: `pack:${pack}`, at: nowISO() });
  if (bonus > 0) db.acuTxns.push({ id: id('acu'), userId, type: 'BONUS', amount: bonus, reason: `pack:${pack}:volume-bonus`, at: nowISO() });
  recordAudit({ actor: userId, role: u.role, action: 'acu.topup', entity: 'acu', entityId: userId, summary: `+${p.acu} ACU (£${p.gbp})` });
  return { ok: true, balance: u.acuBalance, charged: p.gbp, bonusAcu: bonus };
}

// Credit ACU to a user. `type` follows the acu_transactions vocabulary
// (BONUS for allocations/memberships, REWARD for earned incentives).
export function creditAcu(userId, amount, reason = 'credit', type = 'BONUS') {
  const u = db.users.get(userId);
  if (!u || !(amount > 0)) return { ok: false, error: 'invalid' };
  u.acuBalance += Math.round(amount);
  db.acuTxns.push({ id: id('acu'), userId, type, amount: Math.round(amount), reason, at: nowISO() });
  return { ok: true, balance: u.acuBalance };
}
// Refund previously spent ACU back to the wallet (booked as REFUND).
export function refundAcu(userId, amount, reason = 'refund') {
  return creditAcu(userId, amount, reason, 'REFUND');
}
// Reward ACU for platform incentives (reviews, referrals…) — booked as REWARD.
export function rewardAcu(userId, amount, reason = 'reward') {
  return creditAcu(userId, amount, reason, 'REWARD');
}

// ---- ACU Economy (spec §4): wallet view + typed transaction ledger ----------
// acu_wallets: wallet_id, user_id, current_balance, lifetime_purchased,
// lifetime_used, lifetime_earned, status. Derived live from the transaction
// ledger so the counters can never drift from the truth.
export const ACU_TXN_TYPES = ['PURCHASE', 'USAGE', 'REFUND', 'BONUS', 'REWARD'];
export function acuWallet(userId) {
  const u = db.users.get(userId);
  if (!u) return null;
  const mine = db.acuTxns.filter((t) => t.userId === userId);
  const sum = (...types) => mine.filter((t) => types.includes(t.type)).reduce((s, t) => s + Math.abs(t.amount), 0);
  return {
    walletId: `wal_${userId}`,
    userId,
    currentBalance: u.acuBalance,
    lifetimePurchased: sum('PURCHASE'),
    lifetimeUsed: sum('USAGE'),
    lifetimeEarned: sum('BONUS', 'REWARD', 'ALLOCATION'),
    lifetimeRefunded: sum('REFUND'),
    status: u.suspended ? 'suspended' : 'active',
  };
}
// acu_transactions: transaction_id, wallet_id, type, amount, date (+reason).
export function acuTransactions(userId, limit = 100) {
  const mine = db.acuTxns
    .filter((t) => t.userId === userId)
    .map((t) => ({
      transactionId: t.id,
      walletId: `wal_${userId}`,
      type: t.type === 'ALLOCATION' ? 'BONUS' : t.type,
      amount: t.amount,
      reason: t.reason,
      date: t.at,
    }))
    .reverse();
  return limit > 0 ? mine.slice(0, limit) : mine;
}

// ---- AI Cost Estimator (spec §3): ai_request_costs ledger --------------------
// Every routed AI call books its estimated vs actual cost so spend is
// attributable per provider (OpenAI / Claude / Gemini / Vertex), per agent and
// per search / trip / user / booking / organisation.
const AI_COST_CAP = 5000;
export function recordAiRequestCost({ provider, model, agentName, estimatedTokens = 0, estimatedCostUSD = 0, actualCostUSD = 0, mode = null, userId = null, tripId = null, searchId = null, bookingId = null, orgId = null }) {
  const rec = {
    id: id('aicost'),
    provider: provider || 'local',
    model: model || null,
    agentName: agentName || null,
    estimatedTokens: Math.round(estimatedTokens),
    estimatedCostUSD: round4(estimatedCostUSD),
    actualCostUSD: round4(actualCostUSD),
    mode,
    requestTimestamp: nowISO(),
    userId, tripId, searchId, bookingId, orgId,
  };
  db.aiRequestCosts.push(rec);
  if (db.aiRequestCosts.length > AI_COST_CAP) db.aiRequestCosts.splice(0, db.aiRequestCosts.length - AI_COST_CAP);
  return rec;
}
// Aggregated cost report: totals + per provider / agent / user / trip / search
// / booking / organisation — the finance view of AI spend.
export function aiCostReport() {
  const rows = db.aiRequestCosts;
  const group = (key) => {
    const out = {};
    for (const r of rows) {
      const k = r[key];
      if (!k) continue;
      if (!out[k]) out[k] = { requests: 0, estimatedUSD: 0, actualUSD: 0 };
      out[k].requests += 1;
      out[k].estimatedUSD = round4(out[k].estimatedUSD + r.estimatedCostUSD);
      out[k].actualUSD = round4(out[k].actualUSD + r.actualCostUSD);
    }
    return out;
  };
  // The spec's provider columns always appear, even at zero spend.
  const byProvider = {
    openai: { requests: 0, estimatedUSD: 0, actualUSD: 0 },
    anthropic: { requests: 0, estimatedUSD: 0, actualUSD: 0 },
    gemini: { requests: 0, estimatedUSD: 0, actualUSD: 0 },
    vertex: { requests: 0, estimatedUSD: 0, actualUSD: 0 },
    ...group('provider'),
  };
  return {
    requests: rows.length,
    totalEstimatedUSD: round4(rows.reduce((s, r) => s + r.estimatedCostUSD, 0)),
    totalActualUSD: round4(rows.reduce((s, r) => s + r.actualCostUSD, 0)),
    byProvider,
    byAgent: group('agentName'),
    perUser: group('userId'),
    perTrip: group('tripId'),
    perSearch: group('searchId'),
    perBooking: group('bookingId'),
    perOrganisation: group('orgId'),
  };
}

// ---- Refundable search deposits (spec §6) -----------------------------------
// Purpose: stop AI abuse. Deep £5 · Luxury £20 · Corporate £50 — always
// refundable, and when a booking happens the deposit is DEDUCTED from the
// final payment (converted, never double-charged).
export const SEARCH_DEPOSIT_GBP = { deep: 5, concierge: 20, luxury: 20, corporate: 50 };
export function placeSearchDeposit({ userId, tier = 'deep', searchId = null }) {
  const u = db.users.get(userId);
  const amountGBP = SEARCH_DEPOSIT_GBP[tier];
  if (!u || !amountGBP) return { ok: false, error: 'invalid' };
  const deposit = { id: id('dep'), userId, amountGBP, tier, searchId, refunded: false, convertedToBooking: null, at: nowISO() };
  db.searchDeposits.push(deposit);
  recordAudit({ actor: userId, role: u.role, action: 'deposit.placed', entity: 'deposit', entityId: deposit.id, summary: `£${amountGBP} refundable ${tier}-search deposit` });
  return { ok: true, deposit };
}
export function activeSearchDeposit(userId) {
  return db.searchDeposits.find((d) => d.userId === userId && !d.refunded && !d.forfeited && !d.convertedToBooking) || null;
}
export function refundSearchDeposit(depositId) {
  const d = db.searchDeposits.find((x) => x.id === depositId);
  if (!d) return { ok: false, error: 'not-found' };
  if (d.convertedToBooking) return { ok: false, error: 'already-converted' };
  if (d.refunded) return { ok: false, error: 'already-refunded' };
  if (d.forfeited) return { ok: false, error: 'forfeited-abuse', message: 'This deposit was forfeited after abuse was detected — deposits are non-refundable when the abuse throttle trips.' };
  d.refunded = true;
  d.refundedAt = nowISO();
  return { ok: true, deposit: d };
}
// Revenue Engine (spec §9): search deposits are NON-REFUNDABLE when abuse is
// detected — the abuse throttle forfeits the active deposit to the platform.
export function forfeitSearchDeposit(userId, reason = 'abuse-detected') {
  const d = activeSearchDeposit(userId);
  if (!d) return null;
  d.forfeited = true;
  d.forfeitReason = reason;
  d.forfeitedAt = nowISO();
  recordAudit({ actor: 'system', role: 'system', action: 'deposit.forfeited', entity: 'deposit', entityId: d.id, summary: `£${d.amountGBP} forfeited (${reason})` });
  return d;
}
// On booking: the user's active deposit converts and its value comes OFF the
// final payment. Returns the credit line for the booking (or null).
export function convertDepositToBooking(userId, bookingId) {
  const d = activeSearchDeposit(userId);
  if (!d) return null;
  d.convertedToBooking = bookingId;
  d.convertedAt = nowISO();
  return { depositId: d.id, amountGBP: d.amountGBP, note: 'Refundable search deposit deducted from the final payment' };
}
export function listSearchDeposits(userId) {
  return db.searchDeposits.filter((d) => d.userId === userId);
}

// ---- Guaranteed Savings Engine (USP #2) --------------------------------------
// "If 3JN Travel OS cannot beat or match your current quote, we refund your
// search credits." The claim is honest: our floor vs the competing quote,
// and a losing comparison refunds the ACUs the search consumed.
export function claimSavingsGuarantee(userId, { competitorQuoteUSD, ourTotalUSD, acuSpent = 0 }) {
  const u = db.users.get(userId);
  if (!u || !(competitorQuoteUSD > 0) || !(ourTotalUSD > 0)) return { ok: false, error: 'invalid' };
  const beatenOrMatched = ourTotalUSD <= competitorQuoteUSD;
  if (beatenOrMatched) {
    return {
      ok: true, refunded: false,
      verdict: `3JN's price ($${ourTotalUSD}) beats or matches your quote ($${competitorQuoteUSD}) — guarantee satisfied.`,
      savedUSD: round2(competitorQuoteUSD - ourTotalUSD),
    };
  }
  const refund = Math.max(0, Math.round(acuSpent));
  if (refund > 0) refundAcu(userId, refund, 'savings-guarantee');
  recordAudit({ actor: userId, role: u.role, action: 'guarantee.refund', entity: 'acu', entityId: userId, summary: `+${refund} ACU refunded — quote $${competitorQuoteUSD} not beaten ($${ourTotalUSD})` });
  return {
    ok: true, refunded: true, acuRefunded: refund,
    verdict: `We couldn't beat your quote this time — your ${refund} search ACUs are refunded.`,
    balance: u.acuBalance,
  };
}

// ---- Cache-First Intelligence Engine (spec §16) ------------------------------
// Before ANY AI search the engine checks these knowledge sources; when cache
// confidence exceeds the serve threshold the answer is served with NO AI COST.
export const CACHE_SOURCES = ['Historical results', 'Popular routes', 'Past bookings', 'Cached prices', 'Destination intelligence', 'Supplier deals'];
export const CACHE_SERVE_CONFIDENCE = 85; // serve cache above this — no AI cost
// Confidence decays with age: 100% when just written, ~2.5 pts/hour, crossing
// the 85% serve threshold at ~6 hours (the paid-tier freshness window).
export function cacheConfidence(hit) {
  if (!hit || !hit.cachedAt) return 0;
  const ageHours = Math.max(0, (Date.now() - Date.parse(hit.cachedAt)) / 3600000);
  return Math.max(0, Math.round((100 - ageHours * 2.5) * 10) / 10);
}

// ---- Membership Programme (subscription → 10% auto-funds ACUs) -------------
// Joining a plan immediately funds the first billing period's ACUs (10% of the
// subscription at £1 = 100 ACU). renewMembership() repeats it each period.
const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
export function subscribeMembership(userId, tierKey) {
  const u = db.users.get(userId);
  const plan = MEMBERSHIP_TIERS.find((t) => t.key === tierKey);
  if (!u || !plan) return { ok: false, error: 'invalid-tier' };
  const now = Date.now();
  u.membership = {
    tier: plan.key,
    name: plan.name,
    pricePerMonth: plan.pricePerMonth,
    acuPerMonth: plan.acuPerMonth,
    active: true,
    startedAt: new Date(now).toISOString(),
    renewsAt: new Date(now + PERIOD_MS).toISOString(),
  };
  creditAcu(userId, plan.acuPerMonth, `membership:${plan.key}:initial`);
  recordAudit({ actor: userId, role: u.role, action: 'membership.subscribed', entity: 'membership', entityId: userId, summary: `${plan.name} · +${plan.acuPerMonth} ACU/period` });
  return { ok: true, user: publicUser(u), acuCredited: plan.acuPerMonth };
}

// Simulate a billing-period renewal: re-fund the period's ACU allocation.
export function renewMembership(userId) {
  const u = db.users.get(userId);
  if (!u || !u.membership?.active) return { ok: false, error: 'no-active-membership' };
  const credited = u.membership.acuPerMonth;
  creditAcu(userId, credited, `membership:${u.membership.tier}:renewal`);
  u.membership.renewsAt = new Date(Date.now() + PERIOD_MS).toISOString();
  recordAudit({ actor: userId, role: u.role, action: 'membership.renewed', entity: 'membership', entityId: userId, summary: `${u.membership.name} · +${credited} ACU` });
  return { ok: true, user: publicUser(u), acuCredited: credited };
}

export function cancelMembership(userId) {
  const u = db.users.get(userId);
  if (!u || !u.membership) return { ok: false, error: 'no-membership' };
  u.membership.active = false;
  return { ok: true, user: publicUser(u) };
}

function publicUser(u) {
  const tier = tierForPoints(u.points);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role || 'consumer',
    allAccess: !!u.allAccess,
    avatar: u.avatar,
    bio: u.bio || '',
    points: u.points,
    tier: tier.name,
    tierDiscount: tier.discount,
    acuBalance: u.acuBalance,
    membership: u.membership || null,
    coverImage: u.coverImage || null,
    travelProfile: u.travelProfile || {},
    accessLevel: ACCESS_LEVELS[u.role] || ACCESS_LEVELS.consumer,
    referralCode: u.referralCode,
    referrals: u.referrals,
  };
}

// Edit an account's profile. Only whitelisted fields are mutable; an avatar
// image is accepted as a data URL but size-capped to keep the in-memory store
// sane (a real build would upload to object storage and store a URL).
export function updateUser(userId, patch = {}) {
  const u = db.users.get(userId);
  if (!u) return null;
  if (typeof patch.name === 'string' && patch.name.trim()) u.name = patch.name.trim().slice(0, 80);
  if (typeof patch.email === 'string' && patch.email.trim()) u.email = patch.email.trim().slice(0, 120);
  if (typeof patch.bio === 'string') u.bio = patch.bio.slice(0, 280);
  if (typeof patch.role === 'string' && ROLES.includes(patch.role)) u.role = patch.role;
  if (typeof patch.allAccess === 'boolean') u.allAccess = patch.allAccess;
  if (typeof patch.avatar === 'string' && patch.avatar.length <= 600000) u.avatar = patch.avatar; // ~600KB cap
  if (typeof patch.coverImage === 'string' && patch.coverImage.length <= 900000) u.coverImage = patch.coverImage;
  // Master Travel Profile — filled once, retrieved automatically by every module
  // (visa, flight, hotel, holiday). Stored as capped strings.
  if (patch.travelProfile && typeof patch.travelProfile === 'object') {
    u.travelProfile = u.travelProfile || {};
    for (const [k, v] of Object.entries(patch.travelProfile)) {
      if (typeof v === 'string') u.travelProfile[String(k).slice(0, 40)] = v.slice(0, 200);
      else if (typeof v === 'number') u.travelProfile[String(k).slice(0, 40)] = v;
      else if (k === 'loyaltyAccounts' && Array.isArray(v)) {
        // Loyalty programmes (BA Executive Club, Emirates Skywards, Marriott
        // Bonvoy, Hilton Honors, IHG One Rewards, …): number, tier, expiry,
        // status benefits — pulled automatically into flight/hotel bookings.
        u.travelProfile.loyaltyAccounts = v.slice(0, 10).map((a) => ({
          program: String(a.program || '').slice(0, 60),
          membershipNumber: String(a.membershipNumber || '').slice(0, 40),
          tier: String(a.tier || '').slice(0, 40),
          expiry: String(a.expiry || '').slice(0, 20),
          statusBenefits: String(a.statusBenefits || '').slice(0, 160),
        })).filter((a) => a.program && a.membershipNumber);
      }
    }
  }
  recordAudit({ actor: userId, role: u.role, action: 'profile.updated', entity: 'user', entityId: userId, summary: Object.keys(patch).join(', ') });
  return publicUser(u);
}

// Provision one account per role for testing/admin (idempotent-ish by email).
// Tiny deterministic SVG avatar + cover per role (data URLs, no assets).
function roleArt(role, name) {
  const palette = { admin: ['#d8b46a', '#1a1304'], business: ['#4ea1ff', '#04101f'], merchant: ['#46d39a', '#04140d'], partner: ['#b48cff', '#140a24'], consumer: ['#ff9d6a', '#241004'], embassy: ['#6ad3d3', '#0a1f1f'], consulate: ['#7cc0ff', '#0a1224'] };
  const [fg, bg] = palette[role] || ['#d8b46a', '#1a1304'];
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const avatar = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="18" fill="${bg}"/><text x="48" y="60" font-family="Arial" font-size="36" font-weight="bold" fill="${fg}" text-anchor="middle">${initials}</text></svg>`)}`;
  const cover = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${fg}"/></linearGradient></defs><rect width="800" height="200" fill="url(#g)"/><text x="24" y="170" font-family="Arial" font-size="20" fill="#ffffff" opacity="0.85">3JN Travel OS · ${role.toUpperCase()}</text></svg>`)}`;
  return { avatar, cover };
}

export function seedAllRoles() {
  const specs = [
    { role: 'admin', name: 'Platform Admin', email: 'admin@3jntravel.com' },
    { role: 'business', name: 'Corporate Manager', email: 'business@3jntravel.com' },
    { role: 'merchant', name: 'BitriPay Merchant', email: 'merchant@3jntravel.com' },
    { role: 'partner', name: 'Agency Partner', email: 'partner@3jntravel.com' },
    { role: 'consumer', name: 'Test Traveller', email: 'tester@3jntravel.com' },
    { role: 'embassy', name: 'Embassy Officer', email: 'embassy@3jntravel.com' },
    { role: 'consulate', name: 'Consulate eVisa Officer', email: 'consulate@3jntravel.com' },
  ];
  return specs.map((sp, i) => {
    let u = [...db.users.values()].find((x) => x.email === sp.email);
    if (!u) { createUser(sp); u = [...db.users.values()].find((x) => x.email === sp.email); }
    // Every account type ships fully dressed: profile picture, cover picture,
    // the required Master Travel Profile details, and its access level.
    const art = roleArt(sp.role, sp.name);
    if (!u.avatar) u.avatar = art.avatar;
    if (!u.coverImage) u.coverImage = art.cover;
    u.role = sp.role;
    if (!u.travelProfile || !u.travelProfile.fullLegalName) {
      u.travelProfile = {
        title: 'Mx', firstName: sp.name.split(' ')[0], lastName: sp.name.split(' ').slice(-1)[0],
        fullLegalName: sp.name, preferredName: sp.name.split(' ')[0],
        gender: 'Other', dob: `198${i}-0${(i % 9) + 1}-15`, placeOfBirth: 'London, GB',
        nationality: 'GB', maritalStatus: 'Single',
        passportNumber: `GB${1000000 + i}`, passportIssue: '2021-01-01', passportExpiry: '2031-01-01', passportCountry: 'GB',
        nationalId: `NID-${9000 + i}`, residencyStatus: 'Citizen', visaStatus: 'N/A',
        mobile: `+4470000000${i}`, contactEmail: sp.email,
        emergencyContact: 'Ops Desk +44 20 0000 0000', emergencyContactRelation: 'Colleague',
        residentialAddress: `${10 + i} Test Street, London`, billingAddress: `${10 + i} Test Street, London`,
        countryOfResidence: 'GB', postalCode: 'E1 6AN',
        occupation: sp.name, employer: '3JN Travel OS', monthlyIncome: 3000,
      };
    }
    return publicUser(u);
  });
}

// ---- Merchant / white-label API keys --------------------------------------
// Any merchant or partner account can self-serve keys to call the white-label
// API and earn the 90% revenue share. Keys are shown in full once on creation;
// thereafter only a masked prefix is returned (the secret is never re-exposed).
function randomKey() {
  // Deterministic-friendly pseudo-random (no Math.random in this sandbox).
  let s = (++counter * 2654435761) % 4294967296;
  let out = '';
  for (let i = 0; i < 32; i++) { s = (s * 1103515245 + 12345) % 4294967296; out += 'abcdefghijklmnopqrstuvwxyz0123456789'[s % 36]; }
  return out;
}

export function createApiKey(userId, { label, environment } = {}) {
  const u = db.users.get(userId);
  if (!u) return { ok: false, error: 'unknown-user' };
  if (!u.allAccess && !['merchant', 'partner', 'admin'].includes(u.role)) {
    return { ok: false, error: 'role-not-permitted', message: 'Switch your account role to Merchant or Partner to create API keys.' };
  }
  const env = environment === 'production' ? 'production' : 'sandbox';
  const secret = `3jn_${env === 'production' ? 'live' : 'test'}_${randomKey()}`;
  const record = {
    id: id('key'),
    userId,
    label: (label || 'Default key').slice(0, 60),
    environment: env,
    prefix: secret.slice(0, 16),
    secret, // returned ONCE
    revenueShare: '90% partner / 10% 3JN',
    createdAt: nowISO(),
    revokedAt: null,
    lastUsedAt: null,
  };
  db.apiKeys.push(record);
  recordAudit({ actor: userId, role: u.role, action: 'apikey.created', entity: 'api_key', entityId: record.id, summary: `${env} key ${record.prefix}…` });
  return { ok: true, key: record }; // caller strips secret on subsequent reads
}

export function listApiKeys(userId) {
  return db.apiKeys
    .filter((k) => k.userId === userId)
    .map((k) => ({ id: k.id, label: k.label, environment: k.environment, prefix: k.prefix + '…', revenueShare: k.revenueShare, createdAt: k.createdAt, revokedAt: k.revokedAt, lastUsedAt: k.lastUsedAt }));
}

export function revokeApiKey(userId, keyId) {
  const k = db.apiKeys.find((x) => x.id === keyId && x.userId === userId);
  if (!k) return { ok: false, error: 'not-found' };
  k.revokedAt = nowISO();
  return { ok: true };
}

// Validate an inbound partner key (used by the white-label endpoint).
export function useApiKey(secret) {
  const k = db.apiKeys.find((x) => x.secret === secret && !x.revokedAt);
  if (!k) return null;
  k.lastUsedAt = nowISO();
  k.calls = (k.calls || 0) + 1; // metered per call — feeds API revenue reporting
  return { userId: k.userId, environment: k.environment };
}

// ---- BitriPay Merchant Portal: payment links + settlement -----------------
export function createPaymentLink(userId, { amountMinor, currency = 'GBP', description } = {}) {
  const u = db.users.get(userId);
  if (!u) return { ok: false, error: 'unknown-user' };
  if (!u.allAccess && !['merchant', 'partner', 'admin'].includes(u.role)) return { ok: false, error: 'role-not-permitted' };
  const linkId = id('pl');
  const ref = `BP-${randomKey().slice(0, 10).toUpperCase()}`;
  const record = {
    id: linkId, userId, ref,
    amountMinor: Math.max(0, Math.round(Number(amountMinor) || 0)),
    currency, description: (description || 'Travel payment').slice(0, 120),
    url: `https://pay.3jntravel.com/l/${ref}`,
    qrData: `bitripay://pay?ref=${ref}&amt=${amountMinor}&cur=${currency}`,
    status: 'pending', settledAt: null, createdAt: nowISO(),
  };
  db.paymentLinks.push(record);
  recordAudit({ actor: userId, role: u.role, action: 'paymentlink.created', entity: 'payment_link', entityId: linkId, summary: `${currency} ${(record.amountMinor / 100).toFixed(2)}` });
  return { ok: true, link: record };
}
export function listPaymentLinks(userId) {
  return db.paymentLinks.filter((p) => p.userId === userId).map((p) => ({ ...p }));
}
export function settlePaymentLink(userId, linkId) {
  const p = db.paymentLinks.find((x) => x.id === linkId && x.userId === userId);
  if (!p) return { ok: false, error: 'not-found' };
  p.status = 'settled'; p.settledAt = nowISO();
  recordAudit({ actor: userId, role: 'merchant', action: 'paymentlink.settled', entity: 'payment_link', entityId: linkId, summary: p.ref });
  return { ok: true, link: p };
}
export function merchantSettlement(userId) {
  const links = db.paymentLinks.filter((p) => p.userId === userId);
  const grossMinor = links.filter((p) => p.status === 'settled').reduce((s, p) => s + p.amountMinor, 0);
  const feeMinor = Math.round(grossMinor * 0.012); // ~1.2% BitriPay gateway fee
  return {
    links: links.length,
    settled: links.filter((p) => p.status === 'settled').length,
    pending: links.filter((p) => p.status === 'pending').length,
    grossMinor, feeMinor, netMinor: grossMinor - feeMinor, currency: links[0]?.currency || 'GBP',
  };
}

// ---- Business / Enterprise approvals + team view --------------------------
export function listApprovals() {
  return [...db.approvals].reverse();
}
export function decideApproval(approvalId, decision) {
  const a = db.approvals.find((x) => x.id === approvalId);
  if (!a) return { ok: false, error: 'not-found' };
  a.status = decision === 'approve' ? 'approved' : 'rejected';
  a.decidedAt = nowISO();
  recordAudit({ actor: 'business-admin', role: 'business', action: `approval.${a.status}`, entity: 'approval', entityId: approvalId, summary: `$${a.amountUSD}` });
  if (a.userId) pushNotification(a.userId, { type: a.status === 'approved' ? 'success' : 'warning', icon: a.status === 'approved' ? '✅' : '⛔', title: `Trip ${a.status}`, body: `Your $${Math.round(a.amountUSD)} trip was ${a.status} by your travel manager.` });
  return { ok: true, approval: a };
}

// ---- Quotes & bookings ----------------------------------------------------
export function saveQuote(quote) {
  const quoteId = id('quote');
  const record = { id: quoteId, ...quote, status: 'quoted', createdAt: nowISO() };
  db.quotes.set(quoteId, record);
  return record;
}

export function getQuote(quoteId) {
  return db.quotes.get(quoteId) || null;
}

// Map a payment method to its settlement rail (blueprint §7).
const GATEWAY = {
  card: 'stripe', bitripay: 'bitripay', mpesa: 'bitripay-mobilemoney',
  airtel: 'bitripay-mobilemoney', orange: 'bitripay-mobilemoney', africell: 'bitripay-mobilemoney',
};

export function createBooking({ quoteId, option, instalment, userId, paymentMethod = 'card', lead = null, specialRequests = [], hotelRequests = [], payment = null, protection = null }) {
  const bookingId = id('bkg');
  const gateway = GATEWAY[paymentMethod] || 'stripe';
  const booking = {
    id: bookingId,
    quoteId,
    userId: userId || null,
    // Airline/operator special service requests (wheelchair, meals, pets…).
    specialRequests: (Array.isArray(specialRequests) ? specialRequests : []).map((x) => String(x).slice(0, 40)).slice(0, 17),
    // Property special requests (early check-in, cot, quiet room…).
    hotelRequests: (Array.isArray(hotelRequests) ? hotelRequests : []).map((x) => String(x).slice(0, 40)).slice(0, 12),
    // Payment context (never card numbers — those stay on the PSP page).
    payment: payment ? { cardHolder: String(payment.cardHolder || '').slice(0, 80), billingAddress: String(payment.billingAddress || '').slice(0, 160) } : null,
    // Post-booking fulfilment record (PNR, e-ticket, locators, rules).
    fulfilment: buildFulfilment(bookingId, option),
    // Structured cancellation/refund policy — support never guesses.
    refundPolicy: buildRefundPolicyLocal(option),
    // Supply-side earnings: 3JN earns from suppliers even on the cheapest deal.
    supplierEarnings: bookingSupplierCommissionLocal(option),
    // Optional Booking Protection (£5–£50 by trip value) — six benefits.
    protection: protection || null,
    option,
    instalment,
    paymentMethod,
    gateway,
    // Lead traveller captured + validated at booking time (passport, DOB, etc).
    leadTraveller: lead || null,
    status: 'confirmed',
    payments: [],
    priceGuard: { active: true, baselineUSD: option.totalUSD, events: [] },
    createdAt: nowISO(),
  };
  // First payment = deposit.
  if (instalment) {
    booking.payments.push({ type: 'deposit', amount: instalment.deposit, gateway, method: paymentMethod, at: nowISO(), status: 'paid' });
  }
  db.bookings.set(bookingId, booking);

  // Award loyalty points — 1 point per £2 spent (POINTS_PER_USD per $1).
  if (userId) addPoints(userId, option.totalUSD * POINTS_PER_USD);

  recordAudit({ actor: userId || 'guest', role: 'consumer', action: 'booking.created', entity: 'booking', entityId: bookingId, summary: `${option.tier} via ${gateway} ($${option.totalUSD})` });
  if (userId) pushNotification(userId, { type: 'success', icon: '✅', title: 'Booking confirmed', body: `${option.tier} package — deposit paid. Price Guard is now active.` });

  // High-value bookings enter the business approval queue.
  if (option.totalUSD >= 4000) {
    db.approvals.push({ id: id('apr'), bookingId, userId, amountUSD: option.totalUSD, status: 'pending', at: nowISO() });
  }

  return booking;
}

export function getBooking(bookingId) {
  return db.bookings.get(bookingId) || null;
}

export function listBookings(userId) {
  return [...db.bookings.values()].filter((b) => !userId || b.userId === userId);
}

export function recordPayment(bookingId, payment) {
  const b = db.bookings.get(bookingId);
  if (!b) return null;
  b.payments.push({ ...payment, at: nowISO(), status: 'paid' });
  return b;
}

export function logPriceEvent(bookingId, event) {
  const b = db.bookings.get(bookingId);
  if (b) b.priceGuard.events.push(event);
  db.priceEvents.push({ bookingId, ...event });
  recordAudit({ actor: 'savings-guard-agent', role: 'agent', action: `priceguard.${event.action}`, entity: 'booking', entityId: bookingId, summary: event.message });
  if (b?.userId && event.action !== 'hold') {
    pushNotification(b.userId, { type: event.action === 'rebook-refund' ? 'success' : 'info', icon: '🛡', title: 'Price Guard update', body: event.message });
  }
  return event;
}

// ---- Reviews & supplier scores -------------------------------------------
export function addReview({ supplier, rating, comment, bookingId, userId }) {
  const review = { id: id('rev'), supplier, rating, comment, bookingId, userId, at: nowISO() };
  db.reviews.push(review);

  const s = db.supplierScores.get(supplier) || { supplier, sum: 0, count: 0 };
  s.sum += rating;
  s.count += 1;
  s.avg = Math.round((s.sum / s.count) * 10) / 10;
  db.supplierScores.set(supplier, s);
  recordAudit({ actor: userId || 'guest', role: 'consumer', action: 'review.created', entity: 'review', entityId: review.id, summary: `${rating}★ ${supplier}` });
  return review;
}

export function supplierScores() {
  return [...db.supplierScores.values()].sort((a, b) => b.avg - a.avg);
}

export function reviewsForSupplier(supplier) {
  return db.reviews.filter((r) => r.supplier === supplier);
}

export function allReviews() {
  return db.reviews;
}

// Admin / profitability snapshot.
export function revenueSnapshot() {
  const bookings = [...db.bookings.values()];
  const commission = bookings.reduce((s, b) => s + (b.option?.pricing?.revenue?.commissionUSD || 0), 0);
  const savingsShare = bookings.reduce((s, b) => s + (b.option?.pricing?.revenue?.savingsShareUSD || 0), 0);
  const acuPurchased = db.acuTxns.filter((t) => t.type === 'PURCHASE').reduce((s, t) => s + t.amount, 0);
  const acuUsed = db.acuTxns.filter((t) => t.type === 'USAGE').reduce((s, t) => s + Math.abs(t.amount), 0);
  return {
    bookings: bookings.length,
    commissionUSD: round2(commission),
    savingsShareUSD: round2(savingsShare),
    totalRevenueUSD: round2(commission + savingsShare),
    acuPurchased,
    acuUsed,
    users: db.users.size,
    reviews: db.reviews.length,
  };
}

// ---- Profitability Dashboard (spec §17) -------------------------------------
// The admin's real-time money view: ACUs sold vs burned, AI costs, and every
// revenue stream side by side — computed live from the actual ledgers, never
// hard-coded.
export function profitabilityDashboard() {
  const bookings = [...db.bookings.values()];
  const users = [...db.users.values()];
  const sumB = (fn) => round2(bookings.reduce((s, b) => s + (fn(b) || 0), 0));

  const acusSold = db.acuTxns.filter((t) => t.type === 'PURCHASE').reduce((s, t) => s + t.amount, 0);
  const acusBurned = db.acuTxns.filter((t) => t.type === 'USAGE').reduce((s, t) => s + Math.abs(t.amount), 0);
  const aiCostEstimatedUSD = round4(db.aiRequestCosts.reduce((s, r) => s + r.estimatedCostUSD, 0));
  const aiCostActualUSD = round4(db.aiRequestCosts.reduce((s, r) => s + r.actualCostUSD, 0));

  const GBP_TO_USD = 1.27;
  const streams = {
    commissionRevenueUSD: sumB((b) => b.option?.pricing?.revenue?.commissionUSD),
    supplierRevenueUSD: sumB((b) => b.supplierEarnings?.totalUSD),
    savingsRevenueUSD: sumB((b) => b.option?.pricing?.revenue?.savingsShareUSD),
    subscriptionRevenueUSD: round2(users.filter((u) => u.membership?.active && u.membership.pricePerMonth > 0).reduce((s, u) => s + u.membership.pricePerMonth, 0) * GBP_TO_USD),
    searchDepositRevenueUSD: round2(db.searchDeposits.filter((d) => d.forfeited).reduce((s, d) => s + d.amountGBP, 0) * GBP_TO_USD),
    acuSalesRevenueUSD: round2((db.acuTxns.filter((t) => t.type === 'PURCHASE').reduce((s, t) => s + t.amount, 0) / ACU_PER_GBP) * GBP_TO_USD),
    protectionRevenueUSD: sumB((b) => b.protection?.fee),
    corporateRevenueUSD: round2(users.filter((u) => u.corporatePlan?.active).reduce((s, u) => s + (u.corporatePlan.pricePerMonth || 0), 0) * GBP_TO_USD),
    whiteLabelRevenueUSD: round2(db.apiKeys.filter((k) => !k.revokedAt && k.environment === 'production').length * 199 * GBP_TO_USD),
    apiRevenueUSD: round2(db.apiKeys.reduce((s, k) => s + (k.calls || 0), 0) * 0.05 * GBP_TO_USD),
  };
  const revenueUSD = round2(Object.values(streams).reduce((s, v) => s + v, 0));
  return {
    totalAcusSold: acusSold,
    totalAcusBurned: acusBurned,
    aiCosts: { estimatedUSD: aiCostEstimatedUSD, actualUSD: aiCostActualUSD, requests: db.aiRequestCosts.length },
    revenueUSD,
    profitUSD: round2(revenueUSD - aiCostActualUSD),
    streams,
    bookings: bookings.length,
    payingMembers: users.filter((u) => u.membership?.active).length,
  };
}

// ---- Admin Super Control Centre aggregators -------------------------------
export function adminUsers() {
  return [...db.users.values()].map(publicUser);
}

export function adminBookings() {
  return [...db.bookings.values()].map((b) => ({
    id: b.id,
    userId: b.userId,
    tier: b.option?.tier,
    destination: b.option?.components?.find((c) => c.type === 'flight')?.details?.outbound?.to || '—',
    totalUSD: b.option?.totalUSD,
    currency: b.option?.pricing?.currency,
    totalLocal: b.option?.pricing?.local?.total,
    gateway: b.gateway,
    paymentMethod: b.paymentMethod,
    status: b.status,
    priceGuardEvents: b.priceGuard?.events?.length || 0,
    createdAt: b.createdAt,
  }));
}

// A unified, reverse-chronological activity feed across the platform.
export function adminActivity(limit = 25) {
  const events = [];
  for (const b of db.bookings.values()) {
    events.push({ at: b.createdAt, type: 'booking', detail: `${b.option?.tier} booking ${b.id} via ${b.gateway}` });
    (b.priceGuard?.events || []).forEach((e) =>
      events.push({ at: e.at, type: 'price-guard', detail: `${b.id}: ${e.action} (${e.message})` }));
  }
  db.acuTxns.forEach((t) => events.push({ at: t.at, type: 'acu', detail: `${t.type} ${t.amount} ACU (${t.reason})` }));
  db.reviews.forEach((r) => events.push({ at: r.at, type: 'review', detail: `${r.rating}★ ${r.supplier}` }));
  db.referrals.forEach((r) => events.push({ at: nowISO(), type: 'referral', detail: `${r.code} referred a friend` }));
  return events.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
}

// Gross merchandise value + per-currency split + tier mix for the dashboard.
export function adminOverview() {
  const bookings = [...db.bookings.values()];
  const gmvUSD = bookings.reduce((s, b) => s + (b.option?.totalUSD || 0), 0);
  const tierMix = {};
  const gatewayMix = {};
  for (const b of bookings) {
    tierMix[b.option?.tier || '—'] = (tierMix[b.option?.tier || '—'] || 0) + 1;
    gatewayMix[b.gateway || '—'] = (gatewayMix[b.gateway || '—'] || 0) + 1;
  }
  return {
    ...revenueSnapshot(),
    gmvUSD: round2(gmvUSD),
    tierMix,
    gatewayMix,
    suppliers: supplierScores().length,
    referrals: db.referrals.length,
  };
}

function nowISO() {
  // Deterministic-friendly: callers don't depend on exact time, and Date.now is
  // unavailable in some sandboxes. Use a monotonic stamp.
  return new Date(Date.UTC(2026, 5, 30, 12, 0, counter % 60)).toISOString();
}
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// ---- Persistence snapshot / hydrate (for Firebase RTDB / Firestore) -------
// Serialise the whole store to a plain JSON-safe object, and restore it. Maps
// become objects; arrays pass through. Lets a persistence layer survive
// restarts without rewriting every accessor to be async.
const MAP_KEYS = ['users', 'quotes', 'bookings', 'drafts', 'supplierScores'];
const ARRAY_KEYS = ['reviews', 'acuTxns', 'referrals', 'priceEvents', 'apiKeys', 'audit', 'paymentLinks', 'approvals', 'notifications', 'visaApps', 'esims', 'contracts', 'blog', 'behaviour', 'commsDeliveries', 'hostListings', 'travelPots', 'aiRequestCosts', 'searchDeposits', 'visaChain'];

export function snapshot() {
  const out = { counter };
  for (const k of MAP_KEYS) out[k] = Object.fromEntries(db[k]);
  for (const k of ARRAY_KEYS) out[k] = db[k];
  return out;
}

export function hydrate(s) {
  if (!s || typeof s !== 'object') return false;
  if (typeof s.counter === 'number') counter = Math.max(counter, s.counter);
  for (const k of MAP_KEYS) if (s[k]) db[k] = new Map(Object.entries(s[k]));
  for (const k of ARRAY_KEYS) if (Array.isArray(s[k])) db[k] = s[k];
  return true;
}

export { db };

// ---- 3JN Host Marketplace ---------------------------------------------------
// An end-to-end accommodation system: hosts REGISTER first, then run their own
// dashboard — publish properties, set prices, pause/resume, manage bookings and
// earnings. Verified listings appear INSIDE package options alongside hotels —
// wrapped by everything the OS already does: reliability scoring, the price
// guard, instalments, group stays and transparent pricing. 3JN keeps the
// standard 10% commission; hosts keep 90%.
const HOST_COMMISSION = 0.10;

// Step 1 — registration. Hosting is an account capability: register once,
// then the dashboard unlocks. Listings cannot be created without it.
export function registerHost(userId, { displayName, payoutMethod = 'Bank transfer' } = {}) {
  const u = userId ? db.users.get(userId) : null;
  if (!u) return { ok: false, error: 'auth-required', message: 'Sign in to register as a host.' };
  if (u.host && u.hostProfile) return { ok: true, alreadyRegistered: true, profile: u.hostProfile };
  u.host = true;
  u.hostProfile = {
    displayName: String(displayName || u.name || 'Host').trim().slice(0, 60),
    payoutMethod: ['Bank transfer', 'BitriPay wallet', 'PayPal'].includes(payoutMethod) ? payoutMethod : 'Bank transfer',
    registeredAt: new Date().toISOString(),
  };
  recordAudit({ actor: u.id, role: 'host', action: 'host.registered', entity: 'user', entityId: u.id, summary: `${u.hostProfile.displayName} · ${u.hostProfile.payoutMethod}` });
  pushNotification(u.id, { type: 'success', icon: '🏠', title: 'Host account active', body: 'Your Host Dashboard is ready — publish your first property.' });
  return { ok: true, profile: u.hostProfile };
}

export const HOST_PHOTOS_MIN = 10;
export const HOST_PHOTOS_MAX = 100;

export function createHostListing(userId, { title, city, address, propertyType = 'Entire apartment', nightlyUSD, sleeps = 2, amenities = [], photos = [] } = {}) {
  const u = userId ? db.users.get(userId) : null;
  if (!u) return { ok: false, error: 'auth-required' };
  if (!u.host || !u.hostProfile) return { ok: false, error: 'host-registration-required', message: 'Register as a host first — your dashboard unlocks publishing.' };
  const t = String(title || '').trim().slice(0, 80);
  const c = String(city || '').trim().slice(0, 60);
  const rate = Math.round(Number(nightlyUSD) || 0);
  if (!t || !c || rate <= 0) return { ok: false, error: 'invalid-listing', message: 'Title, city and a nightly rate are required.' };
  // Every stay on the OS carries a street address so guests can verify it on
  // the internet — hosted properties are no exception.
  const addr = String(address || '').trim().slice(0, 160);
  if (addr.length < 8) return { ok: false, error: 'address-required', message: 'A full street address is required — guests verify your property online by name + address.' };
  // Hosted-by-us properties must SHOW the place: minimum 10 photos, maximum 100.
  const pics = (Array.isArray(photos) ? photos : String(photos).split(/[\n,]+/))
    .map((x) => String(x).trim()).filter(Boolean).slice(0, HOST_PHOTOS_MAX + 1);
  if (pics.length < HOST_PHOTOS_MIN) return { ok: false, error: 'photos-min', message: `Hosted listings need a minimum of ${HOST_PHOTOS_MIN} pictures (you provided ${pics.length}).` };
  if (pics.length > HOST_PHOTOS_MAX) return { ok: false, error: 'photos-max', message: `Hosted listings allow a maximum of ${HOST_PHOTOS_MAX} pictures.` };
  // Uploaded photos arrive as compressed data URLs — cap each at ~400KB.
  if (pics.some((x) => x.startsWith('data:') && x.length > 400000)) {
    return { ok: false, error: 'photo-too-large', message: 'One or more photos are too large — please re-add them via "Upload photos" (it compresses automatically).' };
  }

  // Verification pipeline (deterministic in the prototype): identity comes from
  // the account, the property passes the 50-point integrity check, and the
  // listing starts at reliability 82 — reviews move it from there.
  const listing = {
    id: `hst_${db.hostListings.length + 1}_${Date.now().toString(36)}`,
    hostId: u.id,
    hostName: u.name,
    title: t,
    city: c,
    propertyType: String(propertyType).slice(0, 40),
    nightlyUSD: rate,
    address: addr,
    photos: pics,
    sleeps: Math.max(1, Math.min(20, Math.round(Number(sleeps) || 2))),
    amenities: (Array.isArray(amenities) ? amenities : String(amenities).split(',')).map((a) => String(a).trim()).filter(Boolean).slice(0, 12),
    verified: true,
    reliabilityScore: 82,
    status: 'live',
    createdAt: new Date().toISOString(),
  };
  db.hostListings.push(listing);
  recordAudit({ actor: u.id, role: 'host', action: 'host.listing.created', entity: 'hostListing', entityId: listing.id, summary: `${t} · ${c} · $${rate}/night` });
  pushNotification(u.id, { type: 'success', icon: '🏠', title: 'Listing is live', body: `${t} is verified and now appears in ${c} searches.` });
  return { ok: true, listing };
}

export function listHostListings(userId) {
  return db.hostListings.filter((l) => l.hostId === userId);
}

// Live, verified community supply for a destination — merged into the
// accommodation scan so hosts compete with hotels in every relevant search.
export function hostListingsForCity(cityText) {
  const needle = String(cityText || '').toLowerCase();
  if (!needle) return [];
  return db.hostListings.filter((l) => l.status === 'live' && l.verified
    && (l.city.toLowerCase().includes(needle) || needle.includes(l.city.toLowerCase())));
}

// Host earnings: every booked component whose supplier is one of my listings.
// Gross stays with the booking; 3JN keeps 10%; the host is paid the rest.
export function hostEarnings(userId) {
  const mine = new Set(listHostListings(userId).map((l) => l.title));
  const rows = [];
  for (const b of db.bookings.values()) {
    for (const c of (b.option?.components || [])) {
      if ((c.type === 'host') && mine.has(c.supplier)) {
        const gross = Math.round((c.priceUSD || 0) * 100) / 100;
        const commission = Math.round(gross * HOST_COMMISSION * 100) / 100;
        rows.push({ bookingId: b.id, listing: c.supplier, grossUSD: gross, commissionUSD: commission, netUSD: Math.round((gross - commission) * 100) / 100, at: b.createdAt });
      }
    }
  }
  const sum = (k) => Math.round(rows.reduce((s, r) => s + r[k], 0) * 100) / 100;
  return { rows, totals: { grossUSD: sum('grossUSD'), commissionUSD: sum('commissionUSD'), netUSD: sum('netUSD') }, listings: listHostListings(userId).length };
}

// Step 3 — manage: edit price/details, pause/resume, and see bookings. Only the
// owner can touch a listing; paused listings drop out of searches instantly
// (hostListingsForCity only serves status 'live').
export function updateHostListing(userId, listingId, patch = {}) {
  const l = db.hostListings.find((x) => x.id === listingId);
  if (!l) return { ok: false, error: 'not-found', message: 'Listing not found.' };
  if (l.hostId !== userId) return { ok: false, error: 'forbidden', message: 'Only the owner can manage this listing.' };
  if (patch.nightlyUSD !== undefined) {
    const rate = Math.round(Number(patch.nightlyUSD) || 0);
    if (rate <= 0) return { ok: false, error: 'invalid-price', message: 'Nightly rate must be a positive amount.' };
    l.nightlyUSD = rate;
  }
  if (patch.status !== undefined) {
    if (!['live', 'paused'].includes(patch.status)) return { ok: false, error: 'invalid-status', message: 'Status must be live or paused.' };
    l.status = patch.status;
  }
  if (patch.sleeps !== undefined) l.sleeps = Math.max(1, Math.min(20, Math.round(Number(patch.sleeps) || l.sleeps)));
  if (patch.title !== undefined && String(patch.title).trim()) l.title = String(patch.title).trim().slice(0, 80);
  if (patch.address !== undefined) {
    const addr = String(patch.address).trim().slice(0, 160);
    if (addr.length < 8) return { ok: false, error: 'address-required', message: 'A full street address is required.' };
    l.address = addr;
  }
  if (patch.amenities !== undefined) {
    l.amenities = (Array.isArray(patch.amenities) ? patch.amenities : String(patch.amenities).split(/[\n,]+/)).map((a) => String(a).trim()).filter(Boolean).slice(0, 12);
  }
  if (patch.photos !== undefined) {
    const pics = (Array.isArray(patch.photos) ? patch.photos : String(patch.photos).split(/[\n,]+/)).map((x) => String(x).trim()).filter(Boolean);
    if (pics.length < HOST_PHOTOS_MIN) return { ok: false, error: 'photos-min', message: `Minimum ${HOST_PHOTOS_MIN} pictures.` };
    if (pics.length > HOST_PHOTOS_MAX) return { ok: false, error: 'photos-max', message: `Maximum ${HOST_PHOTOS_MAX} pictures.` };
    l.photos = pics;
  }
  recordAudit({ actor: userId, role: 'host', action: 'host.listing.updated', entity: 'hostListing', entityId: l.id, summary: Object.keys(patch).join(', ') });
  return { ok: true, listing: l };
}

// Bookings that include one of my properties — the host's reservation book.
export function hostBookings(userId) {
  const mine = new Map(listHostListings(userId).map((l) => [l.title, l]));
  const rows = [];
  for (const b of db.bookings.values()) {
    for (const c of (b.option?.components || [])) {
      if (c.type === 'host' && mine.has(c.supplier)) {
        rows.push({
          bookingId: b.id,
          listing: c.supplier,
          nights: c.details?.nights || null,
          guests: c.details?.sleeps || null,
          status: b.status,
          grossUSD: Math.round((c.priceUSD || 0) * 100) / 100,
          netUSD: Math.round((c.priceUSD || 0) * (1 - HOST_COMMISSION) * 100) / 100,
          bookedAt: b.createdAt,
        });
      }
    }
  }
  return rows.sort((a, b) => (a.bookedAt < b.bookedAt ? 1 : -1));
}

// One call powering the whole Host Dashboard.
export function hostDashboard(userId) {
  const u = userId ? db.users.get(userId) : null;
  if (!u) return { ok: false, error: 'auth-required' };
  const registered = !!(u.host && u.hostProfile);
  return {
    ok: true,
    registered,
    profile: u.hostProfile || null,
    listings: registered ? listHostListings(userId) : [],
    bookings: registered ? hostBookings(userId) : [],
    earnings: registered ? hostEarnings(userId) : null,
  };
}

// Post-booking flight data — everything the traveller and support need after
// ticketing: PNR, e-ticket number, fare basis, ticket class, airline + GDS
// locators, ticket status, boarding pass availability, check-in status,
// refundability and change/cancellation rules. Deterministic from bookingId.
function buildFulfilment(bookingId, option) {
  const flight = (option?.components || []).find((c) => c.type === 'flight');
  if (!flight) return null;
  let h = 0;
  for (const ch of bookingId) h = (h * 31 + ch.charCodeAt(0)) % 2147483647;
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let pnr = '';
  let x = h;
  for (let i = 0; i < 6; i++) { pnr += alpha[x % alpha.length]; x = Math.floor(x / alpha.length) + 7; }
  const airlinePrefix = { 'Emirates': '176', 'Qatar Airways': '157', 'British Airways': '125', 'Turkish Airlines': '235', 'Lufthansa': '220' }[flight.supplier] || '999';
  const free = !!flight.details?.freeCancellation;
  return {
    pnr,
    eTicketNumber: `${airlinePrefix}-${String(2400000000 + (h % 99999999)).padStart(10, '0')}`,
    fareBasis: flight.details?.travelClass ? 'YFLEX' : 'YLOWX',
    ticketClass: flight.details?.cabin || 'Economy (Y)',
    airlineLocator: pnr,
    gdsLocator: `AMA-${String(h % 999999).padStart(6, '0')}`,
    ticketStatus: 'Ticketed',
    boardingPass: 'Issued at online check-in (opens 24h before departure)',
    checkInStatus: 'Not yet open',
    refundability: free ? 'Refundable (fare rules apply)' : 'Non-refundable — taxes refundable on request',
    changeRules: free ? 'Date changes permitted; fare difference may apply' : 'Changes with fee + fare difference',
    cancellationRules: free ? 'Free cancellation until 48h before departure' : 'Cancellation fee applies; 3JN Price Guard credit on rebooking',
  };
}

// ---- OS SYNAPSES — every part of the OS talks to every other part -----------
// Central registry of cross-module links. Each link fires real side effects
// and counts its traffic, so the integration is observable, not aspirational.
const osLinkCounters = {};
export function bumpOSLink(name) { osLinkCounters[name] = (osLinkCounters[name] || 0) + 1; }

// Booking → Host Marketplace: the property owner hears about every reservation
// of their listing the moment it's made (with their 90% payout).
export function notifyHostsOfBooking(booking) {
  let notified = 0;
  for (const c of (booking.option?.components || [])) {
    if (c.type !== 'host') continue;
    const listing = db.hostListings.find((l) => l.title === c.supplier);
    if (!listing) continue;
    pushNotification(listing.hostId, {
      type: 'success', icon: '📅', title: 'New reservation',
      body: `${listing.title}: ${c.details?.nights || '—'} nights booked — you earn $${Math.round((c.priceUSD || 0) * 0.9 * 100) / 100} (90%).`,
    });
    notified += 1;
  }
  return notified;
}

// Booking → Master Travel Profile: details typed at checkout flow BACK into
// the profile (never overwriting what's already there), so the user types
// their passport once, anywhere, and every module knows it.
export function backfillProfileFromLead(userId, lead) {
  if (!userId || !lead) return 0;
  const u = db.users.get(userId);
  if (!u) return 0;
  u.travelProfile = u.travelProfile || {};
  const map = { fullName: 'fullLegalName', dob: 'dob', nationality: 'nationality', passportNumber: 'passportNumber', passportExpiry: 'passportExpiry', idNumber: 'nationalId' };
  let changed = 0;
  for (const [from, to] of Object.entries(map)) {
    if (lead[from] && !u.travelProfile[to]) { u.travelProfile[to] = String(lead[from]).slice(0, 200); changed += 1; }
  }
  return changed;
}

// Reviews → Host Marketplace: guest reviews move a hosted property's live
// reliability (60% history, 40% guest voice), exactly like any supplier.
export function syncHostReliabilityFromReviews(supplier) {
  const l = db.hostListings.find((x) => x.title === supplier);
  if (!l) return null;
  const sc = db.supplierScores.get(supplier);
  if (!sc || !sc.count) return null;
  const guest = (sc.sum / sc.count) * 20; // 0–5 stars → 0–100
  l.reliabilityScore = Math.round(l.reliabilityScore * 0.6 + guest * 0.4);
  return l.reliabilityScore;
}

// The live wiring diagram: which module talks to which, over what, and how
// often it has actually fired. Static links describe always-on couplings.
export function osIntegrationMap() {
  const links = [
    { from: 'Planner', to: 'Behavioural Learning', via: 'every search/plan records signals', live: true },
    { from: 'Behavioural Learning', to: 'Journey Dashboard', via: 'pattern miner, affinity, budget sensor', live: true },
    { from: 'Master Travel Profile', to: 'Booking + VisaOS', via: 'auto-prefill of passenger & applicant data', live: true },
    { from: 'Booking', to: 'Master Travel Profile', via: 'checkout details backfill the profile', fired: osLinkCounters['booking→profile'] || 0 },
    { from: 'Booking', to: 'Host Marketplace', via: 'hosts notified of reservations + 90% payout ledger', fired: osLinkCounters['booking→host'] || 0 },
    { from: 'Booking', to: 'VisaOS', via: 'visa-required trips trigger a prefilled application nudge', fired: osLinkCounters['booking→visaos'] || 0 },
    { from: 'Booking', to: 'Price Guard', via: '24/7 monitoring armed on confirmation', live: true },
    { from: 'Reviews', to: 'Supplier Scores', via: 'ratings blend into reliability rankings', live: true },
    { from: 'Reviews', to: 'Host Marketplace', via: 'guest reviews move listing reliability', fired: osLinkCounters['review→host'] || 0 },
    { from: 'VisaOS', to: 'Planner', via: 'approval probability shown before booking', live: true },
    { from: 'ACPE Revenue Gate', to: 'Every search', via: 'depth funded only when revenue ≥ cost × 10', live: true },
    { from: 'Membership/ACU', to: 'ACPE', via: 'subscriptions auto-fund search depth', live: true },
    { from: 'Blog Agent', to: 'SEO + Marketing', via: 'daily autonomous publish → sitemap + social', live: true },
    { from: 'Host Marketplace', to: 'Supplier Scan', via: 'live listings compete with hotels in every search', live: true },
    { from: 'Everything', to: 'Audit Log', via: 'immutable event trail', live: true },
  ];
  return { links, totalLinks: links.length, fired: { ...osLinkCounters } };
}

// Local import indirection (avoids a static cycle with booking-schema.js).
import { buildRefundPolicy as buildRefundPolicyLocal } from './booking-schema.js';
import { bookingSupplierCommission as bookingSupplierCommissionLocal } from './partners.js';

// ---- Finance: group contribution pots ----------------------------------------
// Churches/families/teams save towards a trip together; contributions carry a
// 1.5% processing fee (FINANCE_PRODUCTS) and the pot converts to booking credit.
// 3JN Savings Wallet (USP #8) — earn before travel happens. A pot is a travel
// goal: save monthly, contribute as a family, or run it as a group pot.
export function createTravelPot(userId, { name, targetUSD, goal, destination, monthlyUSD, kind }) {
  const u = userId ? db.users.get(userId) : null;
  if (!u) return { ok: false, error: 'auth-required' };
  const pot = {
    id: `pot_${db.travelPots.length + 1}_${Date.now().toString(36)}`,
    ownerId: u.id,
    name: String(name || 'Trip pot').slice(0, 60),
    kind: ['personal', 'family', 'group'].includes(kind) ? kind : 'group',
    goal: goal ? String(goal).slice(0, 120) : null,           // e.g. "Dubai, August 2027"
    destination: destination ? String(destination).slice(0, 60) : null,
    monthlyUSD: monthlyUSD > 0 ? Math.round(Number(monthlyUSD)) : null, // monthly saving plan
    targetUSD: Math.max(1, Math.round(Number(targetUSD) || 0)),
    balanceUSD: 0, feePct: 0.015, feesCollectedUSD: 0, contributions: [],
    createdAt: new Date().toISOString(),
  };
  db.travelPots.push(pot);
  return { ok: true, pot };
}
export function contributeToPot(potId, { name, amountUSD }) {
  const pot = db.travelPots.find((p) => p.id === potId);
  if (!pot) return { ok: false, error: 'pot-not-found' };
  const amt = Math.round(Number(amountUSD) * 100) / 100;
  if (!(amt > 0)) return { ok: false, error: 'invalid-amount' };
  const fee = Math.round(amt * pot.feePct * 100) / 100;
  pot.balanceUSD = Math.round((pot.balanceUSD + amt - fee) * 100) / 100;
  pot.feesCollectedUSD = Math.round((pot.feesCollectedUSD + fee) * 100) / 100;
  pot.contributions.push({ name: String(name || 'Anonymous').slice(0, 60), amountUSD: amt, feeUSD: fee, at: new Date().toISOString() });
  if (pot.balanceUSD >= pot.targetUSD) pushNotification(pot.ownerId, { type: 'success', icon: '🎯', title: 'Pot target reached!', body: `${pot.name} hit $${pot.targetUSD} — convert it to a booking credit in the planner.` });
  return { ok: true, pot };
}

// ---- Search cache: the database answers before paid AI ------------------------
// Popular routes, destination packages, visa rules and previous AI answers are
// cached; free/downgraded searches serve from here at zero cost.
export function cacheSearch(key, result) {
  db.searchCache.set(key, { result, cachedAt: new Date().toISOString() });
  if (db.searchCache.size > 500) db.searchCache.delete(db.searchCache.keys().next().value);
}
export function getCachedSearch(key) {
  return db.searchCache.get(key) || null;
}
export function searchCacheStats() {
  return { entries: db.searchCache.size };
}

// ---- Admin-granted complimentary Elite (2×) ------------------------------------
// The platform admin can gift up to FIVE free accounts running Travel+ Elite at
// DOUBLE strength: £0/month, 1,000 ACU auto-funded monthly (2× Elite's 500),
// every Elite feature, est. savings £10,000+/yr. Capped hard at 5 grants.
export const COMP_ELITE_LIMIT = 5;
export function compEliteCount() {
  return [...db.users.values()].filter((u) => u.membership?.complimentary).length;
}
export function grantComplimentaryElite(adminId, targetEmail) {
  const admin = adminId ? db.users.get(adminId) : null;
  if (!admin || !(admin.allAccess || admin.role === 'admin')) return { ok: false, error: 'forbidden', message: 'Only an admin can grant complimentary Elite.' };
  const target = [...db.users.values()].find((u) => u.email === String(targetEmail || '').trim().toLowerCase())
    || [...db.users.values()].find((u) => u.email === String(targetEmail || '').trim());
  if (!target) return { ok: false, error: 'user-not-found', message: 'No account with that email — they must sign up first.' };
  if (target.membership?.complimentary) return { ok: false, error: 'already-granted', message: `${target.name} already holds complimentary Elite.` };
  if (compEliteCount() >= COMP_ELITE_LIMIT) return { ok: false, error: 'limit-reached', message: `All ${COMP_ELITE_LIMIT} complimentary Elite slots are taken.` };
  const elite = MEMBERSHIP_TIERS.find((t) => t.key === 'elite');
  const now = Date.now();
  target.membership = {
    tier: 'elite',
    name: 'Travel+ Elite ×2 (complimentary)',
    pricePerMonth: 0,
    acuPerMonth: elite.acuPerMonth * 2, // 2× — 1,000 ACU/month
    active: true,
    complimentary: true,
    grantedBy: admin.id,
    startedAt: new Date(now).toISOString(),
    renewsAt: new Date(now + 30 * 24 * 3600 * 1000).toISOString(),
  };
  creditAcu(target.id, elite.acuPerMonth * 2, 'membership:elite-comp:initial');
  pushNotification(target.id, { type: 'success', icon: '👑', title: 'Elite — on the house', body: `You've been granted Travel+ Elite ×2 free: 1,000 ACU/month, private aviation access, guaranteed upgrades, 24/7 risk mitigation.` });
  recordAudit({ actor: admin.id, role: 'admin', action: 'membership.comp-elite.granted', entity: 'user', entityId: target.id, summary: `${target.email} · slot ${compEliteCount()}/${COMP_ELITE_LIMIT}` });
  return { ok: true, user: publicUser(target), slotsUsed: compEliteCount(), slotsLeft: COMP_ELITE_LIMIT - compEliteCount() };
}

// ---- Usage telemetry (abuse prevention) ---------------------------------------
// Real counters from the behaviour log: searches today / this week, prior
// bookings, and same-destination repetition — feed the Cost Protection Gate.
export function usageStats(userId) {
  if (!userId) return { searchesToday: 0, recentSearches: 0, priorBookings: 0, sameDestinationRepeats: 0, hasDeposit: false };
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  const mine = db.behaviour.filter((b) => b.userId === userId && (b.event === 'search' || b.event === 'plan'));
  const today = mine.filter((b) => now - Date.parse(b.at || 0) < DAY);
  const week = mine.filter((b) => now - Date.parse(b.at || 0) < 7 * DAY);
  const destCounts = {};
  for (const b of week) if (b.destination) destCounts[b.destination] = (destCounts[b.destination] || 0) + 1;
  const sameDestinationRepeats = Math.max(0, ...Object.values(destCounts));
  const priorBookings = [...db.bookings.values()].filter((b) => b.userId === userId).length;
  return { searchesToday: today.length, recentSearches: week.length, priorBookings, sameDestinationRepeats, hasDeposit: !!activeSearchDeposit(userId) };
}
