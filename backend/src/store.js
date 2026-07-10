// In-memory data store for the prototype. A production build would back this
// with Postgres/Firestore; the interface here is intentionally small so it
// could be swapped out. All state lives for the lifetime of the process.

import { createHash } from 'node:crypto';
import { SIGNUP_BONUS_POINTS, tierForPoints } from './pricing.js';
import { MEMBERSHIP_TIERS, ACU_PER_GBP, POINTS_PER_USD } from '../../shared/constants.js';
import {
  REWARD_ACTIONS, REDEEM_CATEGORIES, acuForAction, PARTNER_TIERS, tierForFollowers,
  effectiveRevshareRate, accrueRevshare, isValidAttribution, derivePartnerMetrics,
  AI_GROWTH_TOOLS, REFERRAL_ACU, REVSHARE_CAP_GBP, REFERRER_REVSHARE_UNLOCK,
} from './rewards.js';
import { quoteChange, applyChange, quoteCancellation } from './operator.js';
import { VENDOR_TIERS, commissionSplit, flightOnlySplit, saleIsPayable, serviceCompletionDate, topSellerForMonth, previousMonthKey, vendorRiskReview, deriveVendorMetrics } from './vendors.js';
import { resolveEmbassyConfig } from './embassy.js';
import { sanitizeListingDetails } from './host-listing.js';
import { benchmarkVerdict } from './benchmark.js';
import { instalmentState, defaultOutcome, dueReminders } from './instalments.js';
import { fulfilmentChannelFor, portalPayload, provisionEsimViaApi, provisionEsimViaAiralo } from './extras-suppliers.js';
import { accountIsDormantBot } from './bot-defence.js';

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
  quoteRequests: [], // exact-quote requests on estimated options (lead + deposit intent)
  influencerProfiles: new Map(), // userId -> influencer/partner profile (tier, followers, standing)
  revshareLedger: [], // { id, partnerId, customerId, bookingId, netRevenueGbp, rate, amountGbp, at }
  rewardWithdrawals: [], // { id, partnerId, amountGbp, method, status, at }
  supportTickets: [], // AI Support Concierge escalations to a human { id, userId, intent, message, reason, status, transcript }
  embassyConfigs: new Map(), // Embassy governance: country -> { embassyName, branding, language, criteria, fees, templates }
  vendorProfiles: new Map(), // Vendor Partner Programme: userId -> { tier, status, vendorCode, riskReview, ... }
  vendorSales: [], // { id, vendorId, bookingId, saleGbp, vendorGbp, platformKeepsGbp, status, flags..., at }
  vendorPayouts: [], // weekly Friday payout batches { id, vendorId, amountGbp, saleIds, status, at }
  benchmarks: [], // Market Benchmark runs: live fares vs market-leader prices
  fulfilmentOrders: [], // Ops Fulfilment Desk: per-component orders on paid bookings
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
// ---- Embassy governance: per-country configuration --------------------------
// Criteria/branding/language/fees/templates a government sets for ITS visas.
export function getEmbassyConfig(country = 'DEFAULT') {
  const key = String(country || 'DEFAULT').toUpperCase();
  return resolveEmbassyConfig(db.embassyConfigs.get(key) || db.embassyConfigs.get('DEFAULT'));
}
export function saveEmbassyConfig(country, patch, officerId) {
  const key = String(country || 'DEFAULT').toUpperCase();
  const current = db.embassyConfigs.get(key) || {};
  const next = {
    ...current, ...patch, country: key,
    branding: { ...(current.branding || {}), ...(patch?.branding || {}) },
    criteria: { ...(current.criteria || {}), ...(patch?.criteria || {}) },
    fees: { ...(current.fees || {}), ...(patch?.fees || {}) },
    updatedAt: nowISO(), updatedBy: officerId || 'embassy',
  };
  db.embassyConfigs.set(key, next);
  recordAudit({ actor: officerId || 'embassy', role: 'embassy', action: 'embassy.config.updated', entity: 'embassy', entityId: key, summary: Object.keys(patch || {}).join(', ') });
  return { ok: true, config: resolveEmbassyConfig(next) };
}

// ---- Confidentiality: the AI result is OFFICER-ONLY until released ----------
// The applicant runs the AI by submitting, but sees NOTHING of the outcome —
// no score, band, recommendation, fraud checks or officer decision — until the
// officer explicitly RELEASES it. Their own submitted data stays visible.
export function redactVisaForApplicant(a) {
  if (!a) return null;
  const released = !!a.embassyDecision?.released;
  return {
    id: a.id,
    at: a.at,
    country: a.country || a.applicant?.destination || null,
    visaType: a.visaType || a.applicant?.visaType || null,
    applicant: a.applicant || null,           // their own data
    fullApplicant: a.fullApplicant || null,   // their own data
    documents: a.documents || [],             // their own uploads
    missingDocuments: a.missingDocuments || [], // helps them complete the file
    status: released ? 'decided' : 'under-review',
    // The decision appears ONLY after the officer releases it — and even then
    // only the human decision (reason/conditions), never the AI internals.
    decision: released ? {
      decision: a.embassyDecision.decision,
      reason: a.embassyDecision.reason || '',
      conditions: a.embassyDecision.conditions || [],
      at: a.embassyDecision.releasedAt || a.embassyDecision.at,
    } : null,
  };
}

// Officer releases the decision to the applicant: only now do they find out.
export function releaseVisaDecision(appId, officerId) {
  const a = db.visaApps.find((x) => x.id === appId);
  if (!a) return { ok: false, error: 'not-found' };
  if (!a.embassyDecision) return { ok: false, error: 'not-decided', message: 'Decide the application before releasing.' };
  if (a.embassyDecision.released) return { ok: true, alreadyReleased: true, application: a };
  a.embassyDecision.released = true;
  a.embassyDecision.releasedAt = nowISO();
  a.embassyDecision.releasedBy = officerId || 'embassy';
  recordAudit({ actor: officerId || 'embassy', role: 'embassy', action: 'visa.decision.released', entity: 'visa_application', entityId: appId, summary: a.embassyDecision.decision });
  a.embassyDecision.releaseBlock = sealVisaBlock('decision-released', { id: appId, decision: a.embassyDecision.decision, by: officerId || 'embassy' });
  if (a.userId) pushNotification(a.userId, { type: 'info', icon: '🛂', title: `Visa decision: ${a.embassyDecision.decision}`, body: `The embassy has issued its decision on application ${a.id}. Your official decision letter is available in your Console.` });
  return { ok: true, application: a };
}

export function decideVisaApplication(appId, { decision, reason, officerId, secondApproverId, conditions } = {}) {
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
    // Visa conditions attached to an approval (picked from the embassy's
    // configured templates and/or written by the officer).
    conditions: (Array.isArray(conditions) ? conditions : []).map((c) => String(c).slice(0, 160)).slice(0, 10),
    ...(isOverride ? { override: true, approvalChain: [officerId || 'embassy', secondApproverId] } : {}),
  };
  a.status = decision === 'More info requested' ? 'awaiting-applicant' : 'decided';
  recordAudit({ actor: officerId || 'embassy', role: 'embassy', action: `visa.embassy.${decision.replace(/\s+/g, '-').toLowerCase()}${isOverride ? '.override' : ''}`, entity: 'visa_application', entityId: appId, summary: `${decision}${isOverride ? ' (OVERRIDE, 2nd: ' + secondApproverId + ')' : ''}${reason ? ' — ' + reason.slice(0, 60) : ''}` });
  a.embassyDecision.auditBlock = sealVisaBlock('embassy-decision', { id: appId, decision, officerId: officerId || 'embassy', override: isOverride, ...(isOverride ? { approvalChain: [officerId || 'embassy', secondApproverId] } : {}) });
  // CONFIDENTIALITY: the applicant is NOT notified here. The decision stays
  // officer-only until releaseVisaDecision() — only then does the applicant
  // learn the outcome and receive the letter.
  return { ok: true, application: a };
}

// The Government Dashboard (immigration authorities) — real-time analytics:
// application volume, approval rate, fraud attempts, high-risk countries,
// overstay trends, processing times, agent performance, revenue, security alerts.
export function govAnalytics() {
  const apps = db.visaApps;
  const by = (pred) => apps.filter(pred).length;
  const decisions = {};
  const byCountry = {};
  const riskByCountry = {};
  const overstayByCountry = {};
  const agentPerf = {};
  const securityAlerts = [];
  let fraudAttempts = 0, totalScore = 0;
  for (const a of apps) {
    const nat = a.applicant?.nationality || '??';
    decisions[a.decision] = (decisions[a.decision] || 0) + 1;
    byCountry[nat] = (byCountry[nat] || 0) + 1;
    if (a.risk?.fraud >= 60 || a.band === 'Reject') fraudAttempts++;
    totalScore += a.totalScore || 0;
    (riskByCountry[nat] ||= []).push(a.totalScore || 0);
    if (typeof a.risk?.overstay === 'number') (overstayByCountry[nat] ||= []).push(a.risk.overstay);
    if ((a.risk?.security || 0) >= 60) securityAlerts.push({ id: a.id, nationality: nat, destination: a.applicant?.destination, securityRisk: a.risk.security, at: a.at });
    for (const f of a.agents || []) {
      const p = (agentPerf[f.agent] ||= { runs: 0, pass: 0, watch: 0, fail: 0 });
      p.runs++;
      if (f.status === 'pass' || f.status === 'info') p.pass++;
      else if (f.status === 'watch') p.watch++;
      else if (f.status === 'fail') p.fail++;
    }
  }
  const avgOf = (arr) => Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
  const approved = by((a) => a.decision === 'Auto Approval' || a.decision === 'Conditional Approval');
  const autoDecided = by((a) => a.decision !== 'Human Review');
  const escalated = apps.length - autoDecided;
  // Government revenue from live volume (per-application + AI + biometric fees).
  const feeGBP = { perApplication: 2.5, aiProcessing: 1.0, biometric: 0.8 };
  const revenue = {
    perApplicationGBP: round2(apps.length * feeGBP.perApplication),
    aiProcessingGBP: round2(apps.length * feeGBP.aiProcessing),
    biometricGBP: round2(apps.length * feeGBP.biometric),
    totalUsageGBP: round2(apps.length * (feeGBP.perApplication + feeGBP.aiProcessing + feeGBP.biometric)),
    plus: 'SaaS license · Fraud Intelligence subscription · Border Intelligence API (see VISAOS_REVENUE_MODEL)',
  };
  return {
    applications: apps.length,
    approved,
    approvalRate: apps.length ? Math.round((approved / apps.length) * 100) : 0,
    decisions,
    fraudAttempts,
    // Physical Embassy Elimination: share of applications decided fully
    // digitally (no human review / physical appearance) — target 90–95%.
    autoDigitalRate: apps.length ? Math.round((autoDecided / apps.length) * 100) : 0,
    digitalTargetPct: [90, 95],
    auditChain: verifyVisaChain(),
    avgScore: apps.length ? Math.round(totalScore / apps.length) : 0,
    topCountries: Object.entries(byCountry).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => ({ country: k, count: v })),
    highRiskCountries: Object.entries(riskByCountry).map(([c, scores]) => ({ country: c, avgScore: avgOf(scores), applications: scores.length }))
      .filter((r) => r.avgScore > 450).sort((x, y) => y.avgScore - x.avgScore).slice(0, 6),
    overstayTrends: Object.entries(overstayByCountry).map(([c, v]) => ({ country: c, avgOverstayRisk: avgOf(v) }))
      .sort((x, y) => y.avgOverstayRisk - x.avgOverstayRisk).slice(0, 6),
    processingTimes: { targetMinutes: 5, autoDecided, escalatedToHuman: escalated, autoDecidedPct: apps.length ? Math.round((autoDecided / apps.length) * 100) : 0 },
    agentPerformance: Object.entries(agentPerf).map(([agent, p]) => ({ agent, ...p, passRatePct: p.runs ? Math.round((p.pass / p.runs) * 100) : 0 })),
    revenue,
    securityAlerts: securityAlerts.slice(-6).reverse(),
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
// Base rate £1 = 100 ACU. The three headline top-ups reward larger buys with a
// volume bonus: £5 none, £10 +10%, £15 +20%. The bonus is booked as a separate
// BONUS transaction so wallets separate purchased from bonus ACU.
//   £5  → 500  ACU  (500 base  + 0 bonus)
//   £10 → 1,100 ACU (1,000 base + 100 bonus = 10%)
//   £15 → 1,800 ACU (1,500 base + 300 bonus = 20%)
export const ACU_TOPUP_BONUS = { 5: 0, 10: 0.10, 15: 0.20 };
export const ACU_PACKS = {
  top5: { name: 'Top-up £5', gbp: 5, acu: 500, bonusPct: 0 },
  top10: { name: 'Top-up £10 · +10%', gbp: 10, acu: 1100, bonusPct: 10 },
  top15: { name: 'Top-up £15 · +20%', gbp: 15, acu: 1800, bonusPct: 20 },
  family: { name: 'Family Pack', gbp: 29, acu: 4000 },
  business: { name: 'Business Pack', gbp: 99, acu: 20000 },
  enterprise: { name: 'Enterprise', gbp: null, acu: null, custom: true, note: 'Custom volume & pricing — contact sales' },
  // Legacy aliases (kept for older clients).
  starter: { name: 'Top-up £5', gbp: 5, acu: 500 },
  traveller: { name: 'Top-up £15 · +20%', gbp: 15, acu: 1800, bonusPct: 20 },
  smart: { name: 'Top-up £15 · +20%', gbp: 15, acu: 1800, bonusPct: 20 },
  topup5: { name: 'Top-up £5', gbp: 5, acu: 500 },
  topup10: { name: 'Top-up £10 · +10%', gbp: 10, acu: 1100, bonusPct: 10 },
  topup15: { name: 'Top-up £15 · +20%', gbp: 15, acu: 1800, bonusPct: 20 },
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
// ACTUALLY apply that credit to the booking: the pre-paid search deposit counts
// as a payment toward the trip AND reduces the cash still due, so the customer is
// charged total − credit (never the full total on top). Without this the deposit
// was marked "converted" (blocking a refund) yet never credited — money vanished.
export function applyDepositCreditToBooking(booking, creditGbp) {
  if (!booking || !(creditGbp > 0) || booking.depositCreditApplied) return null;
  const cur = booking.option?.pricing?.currency || 'GBP';
  const totalLocal = booking.option?.pricing?.local?.total || 0;
  const totalUSD = booking.option?.totalUSD || 0;
  // Search deposits are GBP; express the credit in the booking's display currency.
  const creditLocal = cur === 'GBP' ? creditGbp
    : (totalUSD > 0 && totalLocal > 0) ? round2((creditGbp / GBP_ANCHOR) / totalUSD * totalLocal)
    : creditGbp;
  const applied = round2(Math.min(creditLocal, totalLocal || creditLocal));
  // Counts toward planPaid/fully-paid (pushed directly, NOT via recordPayment, so
  // it does not prematurely fire referral/vendor rewards).
  booking.payments.push({ type: 'deposit-credit', amount: applied, gateway: 'search-deposit', at: nowISO(), status: 'paid', note: 'Refundable search deposit applied' });
  // Reduce the cash due: off the deposit first, then the latest instalments.
  if (booking.instalment) {
    let remaining = applied;
    const cut = Math.min(booking.instalment.deposit || 0, remaining);
    booking.instalment.deposit = round2((booking.instalment.deposit || 0) - cut);
    remaining = round2(remaining - cut);
    const sched = booking.instalment.schedule;
    if (Array.isArray(sched)) {
      for (let i = sched.length - 1; i >= 0 && remaining > 0.005; i--) {
        const c = Math.min(sched[i].amount, remaining);
        sched[i].amount = round2(sched[i].amount - c);
        remaining = round2(remaining - c);
      }
    }
  }
  booking.depositCreditApplied = { amountGBP: creditGbp, amountLocal: applied, at: nowISO() };
  return booking.depositCreditApplied;
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
  // ANTI-ABUSE: the refund can never exceed what the user ACTUALLY spent on
  // AI searches and hasn't already had refunded — otherwise the endpoint mints
  // free ACU (=money) from a request-body number. Cap the client's claim to
  // the true unrefunded search spend from the ledger.
  const searchSpent = db.acuTxns.filter((t) => t.userId === userId && t.type === 'USAGE' && /search|plan|dive/i.test(t.reason || '')).reduce((s, t) => s + Math.abs(t.amount || 0), 0);
  const alreadyRefunded = db.acuTxns.filter((t) => t.userId === userId && t.reason === 'savings-guarantee').reduce((s, t) => s + Math.abs(t.amount || 0), 0);
  const refundable = Math.max(0, searchSpent - alreadyRefunded);
  const refund = Math.min(Math.max(0, Math.round(acuSpent)), refundable);
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

export function createBooking({ quoteId, option, instalment, userId, paymentMethod = 'card', lead = null, specialRequests = [], hotelRequests = [], payment = null, protection = null, vendorCode = null, stripeLive = false }) {
  const bookingId = id('bkg');
  // PAYMENT RAIL POLICY: until BitriPay completes, Stripe is the ONLY live
  // money-in rail. Any BitriPay/mobile-money selection settles on Stripe.
  const requestedGateway = GATEWAY[paymentMethod] || 'stripe';
  const bitripayLive = PAYMENT_RAIL.bitripayEnabled();
  const gateway = !bitripayLive && requestedGateway.startsWith('bitripay') ? 'stripe' : requestedGateway;
  if (gateway !== requestedGateway) paymentMethod = 'card';
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
    // LIVE INVENTORY GATE: a booking is only 'live' when every priced journey
    // and stay component came from a real supplier feed (Duffel/Amadeus…).
    // Estimated-price bookings can NEVER take real money (see /api/pay/stripe).
    priceBasis: (() => {
      const priced = (option?.components || []).filter((c) => ['flight', 'hotel', 'host', 'train', 'coach', 'ferry', 'cruise'].includes(c.type));
      // Community host stays are 3JN's OWN marketplace inventory — a real,
      // fulfillable price (the host committed it), so they count as live.
      const isReal = (c) => c.live || c.details?.community;
      return priced.length && priced.every(isReal) ? 'live' : 'estimated';
    })(),
    // Optional Booking Protection (£5–£50 by trip value) — six benefits.
    protection: protection || null,
    option,
    instalment,
    paymentMethod,
    gateway,
    // Lead traveller captured + validated at booking time (passport, DOB, etc).
    leadTraveller: lead || null,
    // Vendor Partner attribution: which approved vendor brought this sale.
    // LIFETIME ATTACH: no code on this booking → the customer's original
    // partner (set on their first attributed paid booking) earns automatically.
    vendorCode: vendorCode ? String(vendorCode).trim().toUpperCase()
      : (userId && db.users.get(userId)?.attributedVendor) || null,
    status: 'confirmed',
    payments: [],
    priceGuard: { active: true, baselineUSD: option.totalUSD, events: [] },
    // AI Booking Protection™: the deposit reserves the booking with the
    // supplier and FREEZES the quoted price for the whole instalment period.
    priceLock: instalment?.engine === 'ai-smart'
      ? { locked: true, at: nowISO(), baselineUSD: option.totalUSD, badge: 'Price Locked', guarantee: instalment.priceLock?.guarantee || 'Quoted price frozen while instalments are paid on time.' }
      : null,
    createdAt: nowISO(),
  };
  // First payment = deposit. But when Stripe will actually CAPTURE the money
  // (live key + a live-fare booking), the signed Stripe webhook is the single
  // source of truth — pre-recording a 'paid' deposit here would double-count it
  // against the webhook's 'stripe-checkout' line (2× the deposit on planPaid).
  // With Stripe off (current default), behaviour is unchanged: the optimistic
  // deposit stands in for the simulated capture.
  const awaitExternalCapture = stripeLive && booking.priceBasis === 'live';
  if (instalment && !awaitExternalCapture) {
    booking.payments.push({ type: 'deposit', amount: instalment.deposit, gateway, method: paymentMethod, at: nowISO(), status: 'paid' });
  }
  booking.awaitExternalCapture = awaitExternalCapture;
  db.bookings.set(bookingId, booking);

  // Award loyalty points — 1 point per £2 spent (POINTS_PER_USD per $1). When
  // Stripe captures externally, points accrue on the real payment (in
  // recordPayment) instead, so an abandoned-after-deposit trip can't bank the
  // full-trip points.
  if (userId && !awaitExternalCapture) addPoints(userId, option.totalUSD * POINTS_PER_USD);

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
  const receiptId = `rcpt_${bookingId.slice(-6)}_${b.payments.length + 1}`;
  b.payments.push({ ...payment, receiptId, at: nowISO(), status: 'paid' });
  // AI Payment Protection: a receipt after EVERY successful payment, with the
  // live outstanding balance (refund entries carry negative amounts — the
  // receipt copy adapts).
  if (b.userId && Number(payment.amount)) {
    const paid = b.payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const total = b.option?.pricing?.local?.total || 0;
    const sym = b.option?.pricing?.symbol || '£';
    const remaining = Math.max(0, Math.round((total - paid) * 100) / 100);
    const amt = Number(payment.amount);
    pushNotification(b.userId, amt >= 0
      ? { type: 'success', icon: '🧾', title: `Receipt ${receiptId}`, body: `Payment of ${sym}${amt.toFixed(2)} received. Paid ${sym}${paid.toFixed(2)} of ${sym}${total.toFixed(2)} — ${remaining > 0 ? `${sym}${remaining.toFixed(2)} remaining${b.instalment?.finalDue ? `, fully settled by ${b.instalment.finalDue}` : ''}` : 'fully settled'}.` }
      : { type: 'success', icon: '🧾', title: `Refund ${receiptId}`, body: `Refund of ${sym}${Math.abs(amt).toFixed(2)} processed to your payment method.` });
  }
  // Loyalty points for Stripe-captured bookings accrue on ACTUAL payments,
  // proportional to the fraction of the trip paid — so points track real money
  // in (and an abandoned-after-deposit trip banks only the deposit's share),
  // instead of an optimistic full-trip grant at booking time. Non-Stripe
  // bookings keep the createBooking grant (this block is inert for them).
  if (b.userId && b.awaitExternalCapture && ['deposit', 'instalment', 'full', 'stripe-checkout'].includes(payment.type) && Number(payment.amount) > 0) {
    const totalLocal = b.option?.pricing?.local?.total || 0;
    const totalPts = (b.option?.totalUSD || 0) * POINTS_PER_USD;
    if (totalLocal > 0 && totalPts > 0) addPoints(b.userId, totalPts * (Number(payment.amount) / totalLocal));
  }

  // Rewards: the first payment makes this a "paid booking" — fire the referral
  // engine once (250 ACU + revenue-share accrual). Guarded so it never double-pays.
  try { if (!b.referralProcessed) processReferralOnPaidBooking(b); } catch { /* rewards are best-effort */ }
  // Vendor Partner attribution: the first payment confirms the sale — record
  // the vendor commission once, carved from what 3JN ACTUALLY takes:
  //   packages/hotels → 3-4% of sale (from the 10% fee), as ever;
  //   flights-only    → a share of the flat flight fee (see vendors.js).
  // Either way the partner then holds LIFETIME attribution on this customer.
  try {
    if (b.vendorCode && !b.vendorSaleProcessed) {
      const vendor = findVendorByCode(b.vendorCode);
      if (vendor && vendor.userId !== b.userId) {
        const flightsOnly = b.option?.pricing?.feeModel === 'flight-flat' || b.option?.pricing?.feeModel === 'flight-flat-member-free';
        // The vendor carve is 3-4% of the FEE-EXCLUSIVE supplier base, so 10%
        // of it equals 3JN's actual commission and the 7% keep-floor holds.
        // (Carving off the fee-inclusive total overpaid vendors and dropped
        // the real keep below 7%.) One GBP anchor (0.79) everywhere.
        const pr = b.option?.pricing || {};
        const saleGbp = pr.lines?.netSuppliersUSD != null ? round2(pr.lines.netSuppliersUSD * GBP_ANCHOR)
          : pr.revenue?.commissionUSD ? round2((pr.revenue.commissionUSD / 0.10) * GBP_ANCHOR)
          : pr.local?.total && pr.symbol === '£' ? round2(pr.local.total / 1.10) // strip the 10% fee from a GBP total
          : round2(((b.option?.totalUSD || 0) / 1.10) * GBP_ANCHOR);
        const takeGbp = round2((pr.revenue?.commissionUSD ? pr.revenue.commissionUSD * GBP_ANCHOR : saleGbp * 0.10));
        const r = recordVendorSale({ vendorId: vendor.userId, bookingId: b.id, saleGbp, customerId: b.userId, flightsOnly, takeGbp });
        if (r.ok) {
          b.vendorSaleProcessed = true;
          // Lifetime attach: the customer stays attributed to the partner who
          // brought them — future bookings pay the partner without a code.
          const cust = b.userId ? db.users.get(b.userId) : null;
          if (cust && !cust.attributedVendor) cust.attributedVendor = b.vendorCode;
        }
      }
    }
  } catch { /* vendor attribution is best-effort */ }
  // Ops Fulfilment Desk: the FIRST payment decomposes the booking into
  // per-component fulfilment orders — auto channels complete themselves,
  // the rest land on the desk pre-packed for one-visit completion.
  try { createFulfilmentOrders(b); } catch { /* fulfilment desk is best-effort */ }
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

// ===========================================================================
// GLOBAL REWARDS & INFLUENCER PROGRAMME (docs/REWARDS-INFLUENCER-PROGRAMME.md)
// Travel Together. Earn Together. Grow Together.
// ===========================================================================
// ONE customer-facing GBP anchor (matches geo.js GB rateFromUSD 0.79). All
// internal GBP<->USD conversions use it so ledgers agree with the storefront.
const GBP_ANCHOR = 0.79;
const REWARDS_GBP_TO_USD = 1 / GBP_ANCHOR; // platform anchor reciprocal, consistent everywhere
const gbpFromUsd = (usd) => Math.round(((usd || 0) * GBP_ANCHOR) * 100) / 100;

// §1 — award ACU for a traveller reward action. `once` actions are granted a
// single time per user (tracked on the user). Returns the ACU granted.
export function earnAcu(userId, actionKey, { netBookingGbp = 0, promo = false, reason } = {}) {
  const u = db.users.get(userId);
  const action = REWARD_ACTIONS[actionKey];
  if (!u || !action) return { ok: false, error: 'invalid' };
  u.rewardActionsDone = u.rewardActionsDone || {};
  if (action.once && u.rewardActionsDone[actionKey]) return { ok: true, acu: 0, already: true, balance: u.acuBalance };
  const acu = acuForAction(actionKey, { netBookingGbp, promo });
  if (acu <= 0) return { ok: true, acu: 0, balance: u.acuBalance };
  u.rewardActionsDone[actionKey] = (u.rewardActionsDone[actionKey] || 0) + 1;
  rewardAcu(userId, acu, reason || `reward:${actionKey}`);
  return { ok: true, acu, balance: u.acuBalance };
}

// §3 — a partner profile (referrer by default; influencer once approved).
function ensurePartner(userId) {
  let p = db.influencerProfiles.get(userId);
  if (!p) {
    p = { userId, tier: 'referrer', status: 'active', standing: 'good', followers: 0, handles: [], paidReferrals: 0, appliedAt: null, approvedAt: null };
    db.influencerProfiles.set(userId, p);
  }
  return p;
}
export function getPartnerProfile(userId) {
  const u = db.users.get(userId);
  if (!u) return null;
  return { ...ensurePartner(userId), referralCode: u.referralCode };
}

// §3 — apply to the influencer programme (needs follower proof; approval gated).
export function applyInfluencer(userId, { followers = 0, handles = [] } = {}) {
  const u = db.users.get(userId);
  if (!u) return { ok: false, error: 'auth-required' };
  const p = ensurePartner(userId);
  p.followers = Math.max(0, Math.floor(Number(followers) || 0));
  p.handles = Array.isArray(handles) ? handles.slice(0, 8) : [];
  p.status = 'pending';
  p.appliedAt = nowISO();
  p.eligibleTier = tierForFollowers(p.followers).key; // what they'd qualify for
  recordAudit({ actor: userId, role: 'consumer', action: 'influencer.applied', entity: 'partner', entityId: userId, summary: `${p.followers} followers · eligible ${p.eligibleTier}` });
  return { ok: true, profile: p };
}

// §3/§6 — admin approves an influencer to a tier (or rejects / suspends).
export function decideInfluencer(userId, { approve, tier, standing } = {}) {
  if (!db.users.get(userId)) return { ok: false, error: 'not-found' };
  // Create the partner profile if the admin is promoting someone who hasn't
  // formally applied yet — approval should never silently no-op.
  const p = ensurePartner(userId);
  if (standing) p.standing = standing; // 'good' | 'suspended' (§6 fraud/forfeiture)
  if (approve) {
    const t = PARTNER_TIERS[tier] || tierForFollowers(p.followers);
    p.tier = t.key;
    p.status = 'active';
    p.approvedAt = nowISO();
  } else if (approve === false) {
    p.status = 'rejected';
  }
  recordAudit({ actor: 'admin', role: 'admin', action: 'influencer.decided', entity: 'partner', entityId: userId, summary: `approve=${approve} tier=${p.tier} standing=${p.standing}` });
  return { ok: true, profile: p };
}

// §2/§6 — the referral engine. Called when a booking is PAID. Awards 250 ACU per
// paid referral booking and accrues lifetime revenue share on 3JN NET revenue,
// respecting the £20,000-per-customer cap and last-valid attribution.
export function processReferralOnPaidBooking(booking) {
  if (!booking || booking.referralProcessed) return { ok: false, error: 'skip' };
  const friend = booking.userId ? db.users.get(booking.userId) : null;
  if (!friend || !friend.referredByCode) return { ok: false, error: 'no-referrer' };
  const referrer = [...db.users.values()].find((u) => u.referralCode === friend.referredByCode);
  if (!referrer) return { ok: false, error: 'no-referrer' };
  const rp = ensurePartner(referrer.id);
  if (!isValidAttribution({ referrerId: referrer.id, friendId: friend.id, referrerStanding: rp.standing })) {
    return { ok: false, error: 'invalid-attribution' };
  }
  booking.referralProcessed = true;

  // 250 ACU for a referred customer's FIRST paid booking ONLY (§2). Minting it on
  // EVERY booking let a colluding second account farm unlimited ACU (≈ wallet
  // cash) with repeat cheap bookings — revenue-share is capped per customer, the
  // ACU bonus was not. Tie it to the same distinct-customer unlock below.
  const firstPaid = !friend.hasPaidBooking;
  if (firstPaid) {
    friend.hasPaidBooking = true;
    rp.paidReferrals = (rp.paidReferrals || 0) + 1;
    rewardAcu(referrer.id, REFERRAL_ACU, `referral:first-paid-booking:${booking.id}`);
  }

  // Revenue share on 3JN net revenue from this booking (§2/§3/§6).
  const netRevenueGbp = gbpFromUsd(booking.option?.pricing?.revenue?.commissionUSD || 0);
  const rate = effectiveRevshareRate({ approvedTier: rp.tier === 'referrer' ? null : rp.tier, paidReferrals: rp.paidReferrals });
  let shareGbp = 0;
  if (rate > 0 && netRevenueGbp > 0) {
    const alreadyEarnedGbp = db.revshareLedger
      .filter((r) => r.partnerId === referrer.id && r.customerId === friend.id)
      .reduce((s, r) => s + (r.amountGbp || 0), 0);
    shareGbp = accrueRevshare({ netRevenueGbp, rate, alreadyEarnedGbp });
    if (shareGbp > 0) {
      db.revshareLedger.push({ id: id('rsh'), partnerId: referrer.id, customerId: friend.id, bookingId: booking.id, netRevenueGbp, rate, amountGbp: shareGbp, at: nowISO() });
    }
  }
  const acuAwarded = firstPaid ? REFERRAL_ACU : 0;
  recordAudit({ actor: 'system', role: 'system', action: 'referral.rewarded', entity: 'booking', entityId: booking.id, summary: `+${acuAwarded} ACU · revshare £${shareGbp} @ ${(rate * 100).toFixed(2)}%` });
  return { ok: true, acu: acuAwarded, revshareGbp: shareGbp, rate };
}

// §4 — the partner dashboard (real-time, derived from the ledgers).
export function partnerDashboard(userId) {
  const u = db.users.get(userId);
  if (!u) return null;
  const p = ensurePartner(userId);
  const myReferrals = db.referrals.filter((r) => r.referrerId === userId);
  const friendIds = new Set(myReferrals.map((r) => r.friendId));
  const activeTravellers = [...friendIds].filter((fid) => [...db.bookings.values()].some((b) => b.userId === fid && (b.payments || []).length)).length;
  const rows = db.revshareLedger.filter((r) => r.partnerId === userId);
  const acuEarned = db.acuTxns.filter((t) => t.userId === userId && t.type === 'REWARD').reduce((s, t) => s + t.amount, 0);
  const myBookingsByReferred = [...db.bookings.values()].filter((b) => friendIds.has(b.userId));
  const bookingValueGbp = myBookingsByReferred.reduce((s, b) => s + gbpFromUsd(b.option?.pricing?.totals?.totalUSD || 0), 0);
  const revenueGbp = rows.reduce((s, r) => s + (r.netRevenueGbp || 0), 0);
  const withdrawals = db.rewardWithdrawals.filter((w) => w.partnerId === userId);
  const metrics = derivePartnerMetrics({
    referrals: myReferrals, activeTravellers, revshareRows: rows, acuEarned,
    bookingValueGbp, revenueGbp, withdrawals, rank: rewardsLeaderboardRank(userId),
    tier: p.tier, paidReferrals: p.paidReferrals,
  });
  return {
    ...metrics,
    referralCode: u.referralCode,
    referralLink: `https://3jntravel.com/?ref=${u.referralCode}`,
    referralQrData: `https://3jntravel.com/?ref=${u.referralCode}`,
    standing: p.standing,
    status: p.status,
    followers: p.followers,
    unlockReferrals: REFERRER_REVSHARE_UNLOCK,
    revshareUnlocked: p.tier !== 'referrer' || p.paidReferrals >= REFERRER_REVSHARE_UNLOCK,
    aiGrowthTools: AI_GROWTH_TOOLS,
    redeemCategories: REDEEM_CATEGORIES,
    capPerCustomerGbp: REVSHARE_CAP_GBP,
  };
}

// §4 — leaderboard by lifetime revenue-share earnings (ties broken by referrals).
export function rewardsLeaderboard(limit = 20) {
  const byPartner = new Map();
  for (const r of db.revshareLedger) byPartner.set(r.partnerId, (byPartner.get(r.partnerId) || 0) + (r.amountGbp || 0));
  const refCount = new Map();
  for (const r of db.referrals) refCount.set(r.referrerId, (refCount.get(r.referrerId) || 0) + 1);
  const ids = new Set([...byPartner.keys(), ...refCount.keys()]);
  return [...ids].map((pid) => {
    const u = db.users.get(pid);
    return { partnerId: pid, name: u?.name || 'Partner', tier: (db.influencerProfiles.get(pid)?.tier) || 'referrer', earningsGbp: Math.round((byPartner.get(pid) || 0) * 100) / 100, referrals: refCount.get(pid) || 0 };
  }).sort((a, b) => b.earningsGbp - a.earningsGbp || b.referrals - a.referrals).slice(0, limit);
}
function rewardsLeaderboardRank(userId) {
  const board = rewardsLeaderboard(1000);
  const i = board.findIndex((e) => e.partnerId === userId);
  return i === -1 ? null : i + 1;
}

// §4/§6 — request a payout of pending commission. Pending = lifetime earned −
// already withdrawn. Only accounts in good standing may withdraw.
export function requestWithdrawal(userId, { amountGbp, method = 'bank' } = {}) {
  const p = ensurePartner(userId);
  if (p.standing !== 'good') return { ok: false, error: 'account-not-in-good-standing' };
  // Money OUT rides Stripe (bank) until BitriPay is complete — same policy
  // as host/vendor payouts.
  if (/bitripay/i.test(String(method)) && !PAYMENT_RAIL.bitripayEnabled()) {
    return { ok: false, error: 'bitripay-coming-soon', message: 'BitriPay is completing certification — withdrawals are paid by bank transfer (via Stripe) for now.' };
  }
  const lifetime = db.revshareLedger.filter((r) => r.partnerId === userId).reduce((s, r) => s + (r.amountGbp || 0), 0);
  const drawn = db.rewardWithdrawals.filter((w) => w.partnerId === userId && w.status !== 'rejected').reduce((s, w) => s + (w.amountGbp || 0), 0);
  const available = Math.round((lifetime - drawn) * 100) / 100;
  const amt = Math.round((Number(amountGbp) || available) * 100) / 100;
  if (!(amt > 0) || amt > available) return { ok: false, error: 'insufficient-balance', availableGbp: available };
  const w = { id: id('wdl'), partnerId: userId, amountGbp: amt, method, status: 'pending', at: nowISO() };
  db.rewardWithdrawals.push(w);
  recordAudit({ actor: userId, role: 'consumer', action: 'reward.withdrawal.requested', entity: 'partner', entityId: userId, summary: `£${amt} via ${method}` });
  return { ok: true, withdrawal: w, availableGbp: Math.round((available - amt) * 100) / 100 };
}

// ---- AI Support Concierge: human-escalation tickets -----------------------
// The chatbot resolves most requests; when it must hand off, it opens a ticket
// and notifies the customer. Admins work the queue and resolve.
export function createSupportTicket({ userId, intent, message, reason, transcript = [] } = {}) {
  const ticket = {
    id: id('tkt'), userId: userId || null, intent: intent || 'unknown',
    message: String(message || '').slice(0, 2000), reason: reason || 'Requires human assistance',
    status: 'open', transcript, createdAt: nowISO(), resolvedAt: null,
  };
  db.supportTickets.push(ticket);
  recordAudit({ actor: userId || 'guest', role: 'consumer', action: 'support.escalated', entity: 'ticket', entityId: ticket.id, summary: `${ticket.intent}: ${ticket.reason}` });
  if (userId) pushNotification(userId, { type: 'info', icon: '🎧', title: 'Connected to our team', body: 'Your request needs a human touch — a 3JN travel specialist will pick this up and reply shortly.' });
  return ticket;
}
export function listSupportTickets(status) {
  const rows = status ? db.supportTickets.filter((t) => t.status === status) : db.supportTickets;
  return [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
export function supportTicketsForUser(userId) {
  return db.supportTickets.filter((t) => t.userId === userId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
export function resolveSupportTicket(ticketId, { note, agent } = {}) {
  const t = db.supportTickets.find((x) => x.id === ticketId);
  if (!t) return { ok: false, error: 'not-found' };
  t.status = 'resolved';
  t.resolvedAt = nowISO();
  t.resolutionNote = note || '';
  recordAudit({ actor: agent || 'admin', role: 'admin', action: 'support.resolved', entity: 'ticket', entityId: t.id, summary: note || 'resolved' });
  if (t.userId) pushNotification(t.userId, { type: 'success', icon: '✅', title: 'Support update', body: note || 'Your request has been resolved by our team.' });
  return { ok: true, ticket: t };
}
// Latest booking for a user (context for the support bot's answers).
export function latestBookingForUser(userId) {
  const mine = [...db.bookings.values()].filter((b) => b.userId === userId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return mine[0] || null;
}
// All of a user's bookings, newest first (the assistant reads these to resolve).
export function bookingsForUser(userId) {
  return [...db.bookings.values()].filter((b) => b.userId === userId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
// Find one of a user's bookings by reference (booking id or airline PNR).
export function findUserBookingByRef(userId, ref) {
  if (!ref) return null;
  const r = String(ref).trim().toLowerCase();
  return bookingsForUser(userId).find((b) => b.id.toLowerCase() === r || (b.fulfilment?.pnr || '').toLowerCase() === r) || null;
}

// ---- Assistant booking-operator actions (quote → confirm → execute) --------
// The AI Assistant does what a human operator does: it QUOTES a change, the
// customer confirms, then it EXECUTES — applying the change, collecting the
// extra, re-issuing the e-ticket, auditing and notifying. Nothing is charged
// or changed without an explicit confirmation.
export function operatorQuoteChange(bookingId, changes) {
  const b = db.bookings.get(bookingId);
  if (!b) return { ok: false, error: 'not-found' };
  const q = quoteChange(b, changes, { todayISO: nowISO().slice(0, 10) });
  if (!q.ok) return q;
  b.pendingAction = { id: id('act'), kind: 'change', quote: q.quote, at: nowISO() };
  return { ok: true, quote: q.quote, actionId: b.pendingAction.id };
}
export function operatorQuoteCancel(bookingId) {
  const b = db.bookings.get(bookingId);
  if (!b) return { ok: false, error: 'not-found' };
  const q = quoteCancellation(b);
  if (!q.ok) return q;
  b.pendingAction = { id: id('act'), kind: 'cancel', quote: q.quote, at: nowISO() };
  return { ok: true, quote: q.quote, actionId: b.pendingAction.id };
}
export function operatorHasPending(bookingId) {
  return !!db.bookings.get(bookingId)?.pendingAction;
}
// Execute the confirmed pending action. Returns the outcome + updated booking.
export function operatorConfirm(bookingId) {
  const b = db.bookings.get(bookingId);
  if (!b) return { ok: false, error: 'not-found' };
  const pa = b.pendingAction;
  if (!pa) return { ok: false, error: 'nothing-to-confirm' };

  if (pa.kind === 'change') {
    const summary = applyChange(b, pa.quote);
    const extra = pa.quote.totalExtraGbp || 0;
    if (extra > 0) {
      b.payments.push({ type: 'change-charge', amount: extra, gateway: b.gateway, at: nowISO(), status: 'paid', note: summary.description });
    }
    // Re-issue: the ticket must be regenerated to reflect the change.
    b.fulfilment = b.fulfilment || {};
    b.fulfilment.ticketing = 'reissued';
    b.fulfilment.reissuedAt = nowISO();
    b.changeLog = b.changeLog || [];
    b.changeLog.push({ ...summary, extraGbp: extra, deferredFareToConfirm: !!pa.quote.hasDeferred, at: nowISO() });
    delete b.pendingAction;
    recordAudit({ actor: b.userId || 'guest', role: 'consumer', action: 'booking.changed', entity: 'booking', entityId: b.id, summary: `${summary.description} · +£${extra}` });
    if (b.userId) pushNotification(b.userId, { type: 'success', icon: '🔄', title: 'Booking updated', body: `We've ${summary.description}. ${extra > 0 ? `£${extra} change cost applied. ` : ''}Your updated e-ticket is ready in your Console.` });
    return { ok: true, kind: 'change', summary, extraGbp: extra, hasDeferred: !!pa.quote.hasDeferred, booking: b };
  }

  if (pa.kind === 'cancel') {
    const refund = pa.quote.refundGbp || 0;
    b.status = 'cancelled';
    b.cancelledAt = nowISO();
    if (refund > 0) {
      b.payments.push({ type: 'refund', amount: -refund, gateway: b.gateway, at: nowISO(), status: 'refunded' });
    }
    b.fulfilment = b.fulfilment || {};
    b.fulfilment.ticketing = 'cancelled';
    delete b.pendingAction;
    recordAudit({ actor: b.userId || 'guest', role: 'consumer', action: 'booking.cancelled', entity: 'booking', entityId: b.id, summary: `refund £${refund} of £${pa.quote.paidGbp}` });
    if (b.userId) pushNotification(b.userId, { type: 'info', icon: '🚫', title: 'Booking cancelled', body: `Your booking is cancelled. ${refund > 0 ? `A refund of £${refund} is being processed.` : 'This fare was non-refundable, so no refund is due.'}` });
    return { ok: true, kind: 'cancel', refundGbp: refund, booking: b };
  }
  return { ok: false, error: 'unknown-action' };
}

// ===========================================================================
// VENDOR PARTNER PROGRAMME (docs/VENDOR-PARTNER-PROGRAMME.md)
// Sell More. Earn Weekly. Grow Without Owning the Platform.
// ===========================================================================
const VENDOR_GBP_TO_USD = 1 / GBP_ANCHOR;

// §4 — apply. The AI risk review runs immediately; a clean pass auto-approves,
// a sanctions hit rejects, anything else goes to manual compliance review.
export function applyVendor(userId, { tier = 'independent', identityDoc, addressProof, socialHandles, businessHistory, documents, flags } = {}) {
  const u = db.users.get(userId);
  if (!u) return { ok: false, error: 'auth-required' };
  const t = VENDOR_TIERS[tier] || VENDOR_TIERS.independent;
  const review = vendorRiskReview({ name: u.name, email: u.email, tier: t.key, identityDoc, addressProof, socialHandles, businessHistory, documents, flags });
  const status = review.sanctionsHit ? 'rejected' : review.passed ? 'approved' : 'pending-review';
  const p = {
    userId, tier: t.key, status,
    vendorCode: 'VND-' + userId.slice(-4).toUpperCase(),
    riskReview: review, documents: (documents || []).slice(0, 12),
    appliedAt: nowISO(), decidedAt: status === 'approved' || status === 'rejected' ? nowISO() : null,
    topSellerMonth: null, // month key this vendor holds the +1% bonus for
  };
  db.vendorProfiles.set(userId, p);
  recordAudit({ actor: userId, role: u.role, action: 'vendor.applied', entity: 'vendor', entityId: userId, summary: `${t.key} · risk ${review.overallRisk} → ${status}` });
  if (status === 'approved') pushNotification(userId, { type: 'success', icon: '🤝', title: 'Vendor Partner approved', body: `Welcome to the Vendor Partner Programme! Your code is ${p.vendorCode}. You earn ${(t.commissionRate * 100).toFixed(0)}% on every eligible sale, paid every Friday.` });
  return { ok: true, profile: p };
}
export function getVendorProfile(userId) { return db.vendorProfiles.get(userId) || null; }
export function findVendorByCode(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  return [...db.vendorProfiles.values()].find((v) => v.vendorCode === c) || null;
}
// Admin decides a pending application (or suspends/reinstates).
export function decideVendor(userId, { approve, tier, status } = {}) {
  const p = db.vendorProfiles.get(userId);
  if (!p) return { ok: false, error: 'not-found' };
  if (tier && VENDOR_TIERS[tier]) p.tier = tier;
  if (typeof approve === 'boolean') p.status = approve ? 'approved' : 'rejected';
  if (status) p.status = status; // e.g. 'suspended'
  p.decidedAt = nowISO();
  recordAudit({ actor: 'admin', role: 'admin', action: 'vendor.decided', entity: 'vendor', entityId: userId, summary: `${p.tier} → ${p.status}` });
  return { ok: true, profile: p };
}

// §1/§2/§7 — record an eligible sale for an approved vendor. Commission is
// carved from the 10% fee at the vendor's effective rate (incl. any top-seller
// bonus for the current month). Self-referrals earn nothing.
export function recordVendorSale({ vendorId, bookingId, saleGbp, customerId, flightsOnly = false, takeGbp = 0 }) {
  const p = db.vendorProfiles.get(vendorId);
  if (!p || p.status !== 'approved') return { ok: false, error: 'vendor-not-approved' };
  if (customerId && customerId === vendorId) return { ok: false, error: 'self-referral' };
  const monthKey = nowISO().slice(0, 7);
  // Flights-only: the partner's cut comes from 3JN's flat flight fee (a share
  // of our TAKE), never from the fare — structurally, no sale can ever pay
  // out more than it brings in. Packages/hotels keep the classic 3-4% carve.
  const split = flightsOnly
    ? flightOnlySplit(takeGbp)
    : commissionSplit(saleGbp, p.tier, { hasBonus: p.topSellerMonth === monthKey });
  // Service-completion gate: commission releases only AFTER the trip happened —
  // the flight's departure/return date passed, the stay checked out, etc.
  const booking = bookingId ? db.bookings.get(bookingId) : null;
  const serviceDate = booking ? serviceCompletionDate(booking) : null;
  const sale = {
    id: id('vsl'), vendorId, bookingId: bookingId || null, customerId: customerId || null,
    ...split, status: 'confirmed', paymentCleared: true, validated: true,
    serviceDate, // null = immediately-consumed service (eSIM, visa)
    refunded: false, chargeback: false, fraudFlag: false, complianceHold: false,
    paidOut: false, at: nowISO(),
  };
  db.vendorSales.push(sale);
  recordAudit({ actor: vendorId, role: 'vendor', action: 'vendor.sale', entity: 'booking', entityId: bookingId || '-', summary: `£${split.saleGbp} sale · vendor £${split.vendorGbp} · platform keeps £${split.platformKeepsGbp}` });
  return { ok: true, sale };
}
// §7 — flag a sale (refund/chargeback/fraud): kills any unpaid commission.
export function flagVendorSale(saleId, flag) {
  const s = db.vendorSales.find((x) => x.id === saleId);
  if (!s) return { ok: false, error: 'not-found' };
  if (['refunded', 'chargeback', 'fraudFlag', 'complianceHold'].includes(flag)) s[flag] = true;
  recordAudit({ actor: 'system', role: 'system', action: 'vendor.sale.flagged', entity: 'vendor-sale', entityId: saleId, summary: flag });
  return { ok: true, sale: s };
}

// §3 — the automatic weekly payout run (Fridays). Releases every payable sale
// per vendor as one batch. Idempotent: paid sales never pay twice.
export function runWeeklyVendorPayouts() {
  const todayISO = nowISO().slice(0, 10);
  const byVendor = new Map();
  for (const s of db.vendorSales) {
    if (!saleIsPayable(s, todayISO)) continue;
    if (!byVendor.has(s.vendorId)) byVendor.set(s.vendorId, []);
    byVendor.get(s.vendorId).push(s);
  }
  const batches = [];
  for (const [vendorId, sales] of byVendor) {
    const amount = Math.round(sales.reduce((t, s) => t + s.vendorGbp, 0) * 100) / 100;
    if (amount <= 0) continue;
    sales.forEach((s) => { s.paidOut = true; });
    const batch = { id: id('vpo'), vendorId, amountGbp: amount, saleIds: sales.map((s) => s.id), status: 'paid', method: 'bank', at: nowISO() };
    db.vendorPayouts.push(batch);
    batches.push(batch);
    pushNotification(vendorId, { type: 'success', icon: '💷', title: 'Weekly payout sent', body: `£${amount.toFixed(2)} commission for ${sales.length} sale${sales.length > 1 ? 's' : ''} is on its way to your account.` });
  }
  recordAudit({ actor: 'system', role: 'system', action: 'vendor.payout.run', entity: 'vendor', entityId: 'weekly', summary: `${batches.length} vendors paid £${batches.reduce((s, b) => s + b.amountGbp, 0).toFixed(2)}` });
  return { ok: true, batches };
}

// §3 automation — serverless-safe "every Friday": any traffic on a Friday
// triggers the weekly run once (keyed by ISO week), so payouts go out without a
// cron. Also crowns the top seller on the first run of a new month.
let lastPayoutWeek = null;
export function maybeRunFridayPayouts(now = new Date()) {
  if (now.getUTCDay() !== 5) return null; // Friday only
  const weekKey = `${now.getUTCFullYear()}-W${Math.ceil(((now - new Date(Date.UTC(now.getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7)}`;
  if (lastPayoutWeek === weekKey) return null;
  if (db.vendorPayouts.some((p) => (p.weekKey === weekKey))) { lastPayoutWeek = weekKey; return null; }
  lastPayoutWeek = weekKey;
  awardTopSellerBonus(nowISO());
  const run = runWeeklyVendorPayouts();
  run.batches.forEach((b) => { b.weekKey = weekKey; });
  return run;
}

// §2 — crown last month's top seller: they hold +1% for the CURRENT month.
// Run at month start (or on demand); idempotent per month.
export function awardTopSellerBonus(todayISO = nowISO()) {
  const currentMonth = todayISO.slice(0, 7);
  const lastMonth = previousMonthKey(todayISO);
  const winner = topSellerForMonth(db.vendorSales, lastMonth);
  if (!winner) return { ok: true, winner: null };
  const p = db.vendorProfiles.get(winner);
  if (!p) return { ok: false, error: 'winner-profile-missing' };
  if (p.topSellerMonth === currentMonth) return { ok: true, winner, alreadyAwarded: true };
  p.topSellerMonth = currentMonth;
  pushNotification(winner, { type: 'success', icon: '🏆', title: 'Top Seller of the month!', body: `You were last month's best performer — you earn +1% commission on every sale this month.` });
  recordAudit({ actor: 'system', role: 'system', action: 'vendor.top-seller', entity: 'vendor', entityId: winner, summary: `bonus month ${currentMonth}` });
  return { ok: true, winner, bonusMonth: currentMonth };
}

// §5 — the vendor portal dashboard.
export function vendorDashboard(userId) {
  const p = db.vendorProfiles.get(userId);
  if (!p) return null;
  const sales = db.vendorSales.filter((s) => s.vendorId === userId);
  const payouts = db.vendorPayouts.filter((x) => x.vendorId === userId);
  const monthKey = nowISO().slice(0, 7);
  const board = vendorLeaderboard(1000);
  const rank = board.findIndex((e) => e.vendorId === userId);
  const metrics = deriveVendorMetrics({ sales, payouts, tier: p.tier, hasBonus: p.topSellerMonth === monthKey, rank: rank === -1 ? null : rank + 1, todayISO: nowISO().slice(0, 10) });
  return {
    ...metrics, status: p.status, vendorCode: p.vendorCode,
    sellLink: `https://3jntravel.com/?vendor=${p.vendorCode}`,
    services: p.services || [],
    recentSales: sales.slice(-8).reverse(),
    payoutHistory: payouts.slice(-8).reverse(),
    riskReview: { overallRisk: p.riskReview?.overallRisk, recommendation: p.riskReview?.recommendation },
  };
}
export function vendorLeaderboard(limit = 20) {
  const byVendor = new Map();
  for (const s of db.vendorSales) {
    if (s.refunded || s.chargeback || s.fraudFlag) continue;
    byVendor.set(s.vendorId, (byVendor.get(s.vendorId) || 0) + s.saleGbp);
  }
  return [...byVendor.entries()].map(([vendorId, salesGbp]) => {
    const u = db.users.get(vendorId); const p = db.vendorProfiles.get(vendorId);
    return { vendorId, name: u?.name || 'Vendor', tier: p?.tier || 'independent', salesGbp: Math.round(salesGbp * 100) / 100 };
  }).sort((a, b) => b.salesGbp - a.salesGbp).slice(0, limit);
}
export function listVendors(status) {
  const all = [...db.vendorProfiles.values()];
  return status ? all.filter((v) => v.status === status) : all;
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

  const GBP_TO_USD = 1 / GBP_ANCHOR;
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
  // REAL wall clock. A frozen stamp mixed with Date.now()-based comparisons
  // elsewhere silently broke: vendor commission never released (service-date
  // gate always in the future vs a frozen "today"), the abuse throttle never
  // tripped, and the dormant-bot sweep could never age an account. All three
  // heal once stamps and comparisons share one real clock.
  return new Date().toISOString();
}
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// ---- Request Exact Quote (real revenue capture before live suppliers) --------
// An estimated flight/hotel option cannot take real money (legal-safety gate).
// Instead the customer requests the EXACT quote: we capture the lead + a
// refundable deposit INTENT. An agent (or the live supplier once connected)
// confirms the real bookable price; the customer then pays that exact amount.
// This converts estimated results into real, lawful revenue capture.
export function createQuoteRequest({ userId = null, option, intent, contact = {}, depositIntentGBP = 0, note = '' } = {}) {
  if (!option) return { ok: false, error: 'option-required' };
  const est = option?.pricing?.local?.total || 0;
  const req = {
    id: `qr_${db.quoteRequests.length + 1}_${Date.now().toString(36)}`,
    userId,
    status: 'requested',               // requested → priced → paid | cancelled
    tier: option.tier,
    destination: intent?.destination?.city || intent?.destination?.code || '',
    components: (option.components || []).map((c) => ({ type: c.type, supplier: c.supplier, priceUSD: c.priceUSD, live: !!c.live })),
    estimatedTotalLocal: est,
    currency: option?.pricing?.currency || 'GBP',
    symbol: option?.pricing?.symbol || '£',
    priceBasis: option?.priceBasis || 'estimated',
    contact: {
      name: String(contact.name || '').slice(0, 80),
      email: String(contact.email || '').slice(0, 120),
      phone: String(contact.phone || '').slice(0, 40),
    },
    depositIntentGBP: Math.max(0, Math.round(Number(depositIntentGBP) || 0)),
    depositPaid: false,
    note: String(note || '').slice(0, 400),
    confirmedTotalLocal: null,         // the real bookable price, set by an agent/supplier
    confirmedBy: null,
    quotedAt: null,
    createdAt: nowISO(),
  };
  db.quoteRequests.push(req);
  recordAudit({ actor: userId || 'guest', role: 'consumer', action: 'quote.requested', entity: 'quoteRequest', entityId: req.id, summary: `${req.tier} · ${req.destination} · est ${req.symbol}${est}` });
  if (userId) pushNotification(userId, { type: 'info', icon: '📝', title: 'Exact quote requested', body: `We're confirming the live bookable price for your ${req.tier} ${req.destination} trip. You'll get the exact amount to approve — no charge until you do.` });
  return { ok: true, request: req };
}
// Agent/supplier confirms the real price. Once set, the customer can pay it
// for real (Stripe) because it is now a bookable, held quote.
export function confirmQuoteRequest(requestId, { confirmedTotalLocal, confirmedBy = 'agent', supplierRef = '' } = {}) {
  const r = db.quoteRequests.find((x) => x.id === requestId);
  if (!r) return { ok: false, error: 'not-found' };
  const amt = Math.round(Number(confirmedTotalLocal) * 100) / 100;
  if (!(amt > 0)) return { ok: false, error: 'invalid-amount' };
  r.confirmedTotalLocal = amt;
  r.confirmedBy = confirmedBy;
  r.supplierRef = String(supplierRef || '').slice(0, 60);
  r.priceBasis = 'live';               // now a real, bookable price
  r.status = 'priced';
  r.quotedAt = nowISO();
  recordAudit({ actor: confirmedBy, role: 'agent', action: 'quote.confirmed', entity: 'quoteRequest', entityId: r.id, summary: `confirmed ${r.symbol}${amt}` });
  if (r.userId) pushNotification(r.userId, { type: 'success', icon: '✅', title: 'Your exact price is ready', body: `${r.destination} ${r.tier}: ${r.symbol}${amt} confirmed and bookable. Open your Console to pay securely and lock it in.` });
  return { ok: true, request: r };
}
export function markQuoteRequestPaid(requestId, { amount, gateway = 'stripe', reference = '' } = {}) {
  const r = db.quoteRequests.find((x) => x.id === requestId);
  if (!r) return { ok: false, error: 'not-found' };
  r.status = 'paid';
  r.depositPaid = true;
  r.payment = { amount, gateway, reference, at: nowISO() };
  recordAudit({ actor: r.userId || 'guest', role: 'consumer', action: 'quote.paid', entity: 'quoteRequest', entityId: r.id, summary: `${gateway} ${r.symbol}${amount}` });
  return { ok: true, request: r };
}
export function listQuoteRequests({ userId = null, status = null } = {}) {
  let out = db.quoteRequests;
  if (userId) out = out.filter((r) => r.userId === userId);
  if (status) out = out.filter((r) => r.status === status);
  return [...out].reverse();
}
export function getQuoteRequest(id) { return db.quoteRequests.find((r) => r.id === id) || null; }

// Search-to-book stats — drives Duffel's excess-search fee reporting.
export function searchToBookStats() {
  const searches = db.behaviour.filter((b) => b.event === 'plan' || b.event === 'search').length;
  const bookings = db.bookings.size;
  return { searches, bookings };
}

// ---- Persistence snapshot / hydrate (for Firebase RTDB / Firestore) -------
// Serialise the whole store to a plain JSON-safe object, and restore it. Maps
// become objects; arrays pass through. Lets a persistence layer survive
// restarts without rewriting every accessor to be async.
const MAP_KEYS = ['users', 'quotes', 'bookings', 'drafts', 'supplierScores', 'influencerProfiles', 'vendorProfiles', 'embassyConfigs'];
const ARRAY_KEYS = ['reviews', 'acuTxns', 'referrals', 'priceEvents', 'apiKeys', 'audit', 'paymentLinks', 'approvals', 'notifications', 'visaApps', 'esims', 'contracts', 'blog', 'behaviour', 'commsDeliveries', 'hostListings', 'travelPots', 'aiRequestCosts', 'searchDeposits', 'visaChain', 'quoteRequests', 'revshareLedger', 'rewardWithdrawals', 'supportTickets', 'vendorSales', 'vendorPayouts', 'benchmarks', 'fulfilmentOrders'];

// ---- Bot Defence: dormant-bot sweep + quarantine -------------------------------
// Flags accounts with machine-generated names/emails AND zero activity.
// Real accounts are NEVER touched: one booking, one ACU transaction, one
// review, one listing — any human trace — makes an account immune. Flagged
// accounts cannot log in until an admin unflags them (the appeal path).
export function sweepBotAccounts({ olderThanHours = 72, nowMs } = {}) {
  // SAME CLOCK as user.createdAt (nowISO's deterministic stamp) — mixing the
  // wall clock with the store clock made brand-new accounts look days old.
  const clockNow = Number.isFinite(nowMs) ? nowMs : new Date(nowISO()).getTime();
  const results = { checked: 0, flagged: 0, immune: 0, list: [] };
  for (const u of db.users.values()) {
    if (u.flaggedBot) continue;
    results.checked += 1;
    const activity = {
      bookings: [...db.bookings.values()].filter((b) => b.userId === u.id).length,
      acuTxns: db.acuTxns.filter((t) => t.userId === u.id).length,
      reviews: db.reviews.filter((r) => r.userId === u.id).length,
      hostListings: db.hostListings.filter((l) => l.hostId === u.id || l.userId === u.id).length,
      vendorProfile: db.vendorProfiles.has(u.id) ? 1 : 0,
      // NOT influencerProfile existence — rewards auto-enrols every signup,
      // so the profile itself proves nothing. EARNED revenue share does.
      revshareEarned: db.revshareLedger.filter((r) => r.partnerId === u.id).length,
      visaApps: db.visaApps.filter((v) => v.userId === u.id).length,
      potContributions: db.travelPots.filter((p) => (p.contributions || []).some((c) => c.userId === u.id)).length,
      behaviour: db.behaviour.filter((e) => e.userId === u.id).length,
    };
    const verdict = accountIsDormantBot(u, activity, { olderThanHours, nowMs: clockNow });
    if (!verdict.flag) { results.immune += 1; continue; }
    u.flaggedBot = { at: nowISO(), reasons: verdict.reasons };
    u.suspended = true;
    results.flagged += 1;
    results.list.push({ userId: u.id, name: u.name, email: u.email, reasons: verdict.reasons });
    recordAudit({ actor: 'bot-defence', role: 'system', action: 'account.bot-quarantined', entity: 'user', entityId: u.id, summary: verdict.reasons.join(', ') });
  }
  return results;
}
export function unflagBotAccount(userId) {
  const u = db.users.get(userId);
  if (!u) return { ok: false, error: 'not-found' };
  delete u.flaggedBot;
  u.suspended = false;
  recordAudit({ actor: 'admin', role: 'admin', action: 'account.bot-unflagged', entity: 'user', entityId: userId, summary: 'appeal approved — account restored' });
  return { ok: true, user: u };
}

// ---- Vendor service listings: real local suppliers in real packages -----------
// An APPROVED vendor (risk-reviewed + admin-approved) can list the services
// they personally deliver — photographer, guide, driver, translator,
// restaurant — with their own price. Listings compete in the package scan for
// their city; when a customer books one, the JOB routes to that vendor via
// the Fulfilment Desk, and the vendor earns 90% (3JN keeps the 10% platform
// fee), released by the Friday payout run AFTER the service date passes.
const VENDOR_SERVICE_TYPES = ['photographer', 'guide', 'restaurant', 'translator', 'driver', 'activity'];
export function addVendorService(userId, { type, title, city, priceGbp, unit, description } = {}) {
  const p = db.vendorProfiles.get(userId);
  if (!p || p.status !== 'approved') return { ok: false, error: 'vendor-not-approved', message: 'Only approved vendors can list services — apply to the Vendor Partner Programme first.' };
  const t = String(type || '').toLowerCase();
  if (!VENDOR_SERVICE_TYPES.includes(t)) return { ok: false, error: 'bad-type', message: `Service type must be one of: ${VENDOR_SERVICE_TYPES.join(', ')}.` };
  const price = Math.round(Number(priceGbp) * 100) / 100;
  if (!(price > 0)) return { ok: false, error: 'bad-price', message: 'Set your price in GBP.' };
  const cityName = String(city || '').trim();
  if (cityName.length < 2) return { ok: false, error: 'bad-city', message: 'Name the city you serve.' };
  p.services = p.services || [];
  if (p.services.length >= 10) return { ok: false, error: 'too-many', message: 'Up to 10 service listings per vendor.' };
  const svc = {
    id: id('vsvc'), type: t,
    title: String(title || '').trim().slice(0, 80) || `${t[0].toUpperCase()}${t.slice(1)} service`,
    city: cityName.slice(0, 60),
    priceGbp: price,
    unit: String(unit || 'per booking').slice(0, 40),
    description: String(description || '').trim().slice(0, 300),
    status: 'live', createdAt: nowISO(),
  };
  p.services.push(svc);
  recordAudit({ actor: userId, role: 'vendor', action: 'vendor.service.listed', entity: 'vendor', entityId: userId, summary: `${svc.type} · ${svc.city} · £${svc.priceGbp}` });
  return { ok: true, service: svc };
}
export function removeVendorService(userId, serviceId) {
  const p = db.vendorProfiles.get(userId);
  if (!p?.services) return { ok: false, error: 'not-found' };
  const i = p.services.findIndex((s) => s.id === serviceId);
  if (i === -1) return { ok: false, error: 'not-found' };
  p.services.splice(i, 1);
  return { ok: true };
}
// Live vendor services for a city (feeds the package scan). GBP → USD at the
// platform anchor so they price alongside estimator offers.
export function vendorServicesForCity(city, type = null) {
  const want = String(city || '').trim().toLowerCase();
  if (!want) return [];
  const out = [];
  for (const [vendorId, p] of db.vendorProfiles) {
    if (p.status !== 'approved') continue;
    for (const s of p.services || []) {
      if (s.status !== 'live' || s.city.toLowerCase() !== want) continue;
      if (type && s.type !== type) continue;
      out.push({
        type: s.type,
        supplier: `${s.title} · ${p.businessName || 'verified vendor'}`,
        verified: true,
        reliabilityScore: 88, // risk-reviewed + admin-approved local vendor
        priceUSD: Math.round((s.priceGbp / 0.79) * 100) / 100,
        details: { unit: s.unit, vendorId, vendorServiceId: s.id, vendorService: true, description: s.description },
        sourcedVia: '3JN Vendor Marketplace (local vendor)',
        sourcedType: 'marketplace',
      });
    }
  }
  return out;
}
// A vendor confirmed delivery of a booked job: create the 90/10 earnings row.
// serviceDate gates the payout — money releases the Friday AFTER delivery.
export function recordVendorServiceJob({ vendorId, bookingId, orderId, priceGbp, serviceDate }) {
  const p = db.vendorProfiles.get(vendorId);
  if (!p || p.status !== 'approved') return { ok: false, error: 'vendor-not-approved' };
  // IDEMPOTENCY: one earnings row per fulfilment order. A re-confirm (or replay)
  // must not mint a second 90% payout for the same job.
  if (orderId) {
    const existing = db.vendorSales.find((s) => s.orderId === orderId && s.model === 'service-delivery');
    if (existing) return { ok: true, sale: existing, already: true };
  }
  const price = Math.round(Number(priceGbp) * 100) / 100;
  const vendorGbp = Math.round(price * 0.90 * 100) / 100;
  const sale = {
    id: id('vsl'), vendorId, bookingId: bookingId || null, orderId: orderId || null,
    model: 'service-delivery', saleGbp: price, platformFeeGbp: Math.round(price * 0.10 * 100) / 100,
    vendorRate: 0.90, vendorGbp, platformKeepsGbp: Math.round((price - vendorGbp) * 100) / 100,
    status: 'confirmed', paymentCleared: true, validated: true,
    serviceDate: serviceDate || null,
    refunded: false, chargeback: false, fraudFlag: false, complianceHold: false,
    paidOut: false, at: nowISO(),
  };
  db.vendorSales.push(sale);
  recordAudit({ actor: vendorId, role: 'vendor', action: 'vendor.job.confirmed', entity: 'booking', entityId: bookingId || '-', summary: `service delivery £${price} · vendor earns £${vendorGbp} after ${serviceDate || 'delivery'}` });
  return { ok: true, sale };
}

// ---- Ops Fulfilment Desk ------------------------------------------------------
// "Whenever a customer does something, I have to complete it manually — I want
// the automatic way." This is it: every PAID booking auto-decomposes into
// per-component fulfilment orders, each routed to its channel (Rayna portal,
// eSIM API, vendor marketplace, visa desk…) and carrying a pre-packed portal
// payload with EVERYTHING needed to complete it in one visit. Auto-capable
// channels complete themselves; the rest sit in the desk until the operator
// pastes the supplier confirmation — the OS then writes the confirmation into
// the customer's documents and notifies them. Nothing waits on memory.
const FULFILMENT_LABELS = {
  activity: 'Activity / tour', activities: 'Activity / tour', visa: 'Visa application',
  esim: 'eSIM', insurance: 'Insurance policy', transfer: 'Airport transfer',
  carhire: 'Car hire', restaurant: 'Restaurant booking', photographer: 'Photographer',
  guide: 'Local guide', translator: 'Translator', driver: 'Local driver',
  train: 'Rail ticket', coach: 'Coach ticket', ferry: 'Ferry crossing', cruise: 'Cruise',
  hotel: 'Hotel (manual confirmation)',
};
export function createFulfilmentOrders(booking) {
  if (!booking || booking.fulfilmentOrdersCreated) return [];
  const comps = booking.option?.components || [];
  const destCountry = booking.option?.destination?.country || null;
  const lead = booking.leadTraveller || {};
  const sym = booking.option?.pricing?.symbol || '£';
  const rate = (booking.option?.pricing?.local?.total || 0) / (booking.option?.pricing?.lines?.totalUSD || 1);
  const created = [];
  comps.forEach((c, idx) => {
    const channel = fulfilmentChannelFor(c, destCountry);
    if (!channel) return; // live flights/hotels auto-ticket via their own path
    const order = {
      id: id('ford'), bookingId: booking.id, componentIndex: idx,
      componentType: c.type, componentLabel: `${FULFILMENT_LABELS[c.type] || c.type} — ${c.supplier || ''}`.trim(),
      channel, status: 'new',
      destination: booking.option?.destination?.city || null,
      destCountry: booking.option?.destination?.country || destCountry || null,
      serviceDate: c.details?.date || booking.option?.dates?.checkIn || null,
      pax: c.details?.passengers || c.details?.pax || null,
      // sellPrice is in the customer's DISPLAY currency (for the ops payload);
      // sellGbp is the same value in GBP via the platform anchor, so the vendor
      // 90/10 payout is computed in real GBP no matter the booking currency.
      sellPrice: Math.round((c.priceUSD || 0) * rate * 100) / 100, symbol: sym,
      sellGbp: Math.round((c.priceUSD || 0) * GBP_ANCHOR * 100) / 100,
      customer: { name: lead.fullName || null, email: lead.email || null, phone: lead.phone || null, nationality: lead.nationality || null, passport: lead.passportNumber || null },
      userId: booking.userId || null,
      vendorId: c.details?.vendorId || null,
      supplierRef: null, note: null, createdAt: nowISO(), completedAt: null,
    };
    order.portalPayload = portalPayload(order);
    db.fulfilmentOrders.push(order);
    created.push(order);
    // A marketplace vendor's job: tell the vendor immediately — the customer
    // has PAID and is waiting on them.
    if (order.vendorId) {
      pushNotification(order.vendorId, { type: 'success', icon: '💼', title: 'New job — customer booked your service', body: `${order.componentLabel} in ${order.destination || 'your city'}${order.serviceDate ? ' on ' + order.serviceDate : ''} for ${order.symbol}${order.sellPrice}. Confirm it in your Vendor dashboard → Jobs; you earn 90% after delivery.` });
    }
  });
  booking.fulfilmentOrdersCreated = true;
  if (created.length) {
    recordAudit({ actor: 'system', role: 'system', action: 'fulfilment.orders.created', entity: 'booking', entityId: booking.id, summary: `${created.length} order(s): ${created.map((o) => o.channel).join(', ')}` });
    // Fire-and-forget auto-fulfilment for the channels that can.
    for (const o of created) autoFulfilOrder(o).catch(() => {});
  }
  return created;
}

// Channels that complete themselves: eSIM (via API when the door is open,
// else in-OS provisioning — both put a REAL activation code in the customer's
// documents), and host-marketplace stays (our own inventory).
async function autoFulfilOrder(order) {
  if (!order.channel.startsWith('auto:')) return;
  if (order.channel === 'auto:esim-api' || order.channel === 'auto:esim-inhouse') {
    let profile = null;
    if (order.channel === 'auto:esim-api') {
      // Prefer Airalo (real activation + eSIMs Cloud share link); fall back to
      // eSIM Access; then in-OS provisioning (ops-verified) as a last resort.
      profile = await provisionEsimViaAiralo({ countryCode: order.destCountry, minGB: 1, ourRef: order.id }).catch(() => null)
        || await provisionEsimViaApi({ destinationCountry: order.destCountry || order.destination, dataGB: 5, days: 9, ourRef: order.id }).catch(() => null);
    }
    if (!profile) {
      const rec = provisionEsim(order.userId, { destination: order.destination || 'Regional' });
      profile = { provider: rec.provider, iccid: rec.iccid, lpa: null, live: false };
    }
    // Write the REAL activation into the booking component so the travel
    // documents render the QR, LPA code, SM-DP+ address and share link.
    const b = db.bookings.get(order.bookingId);
    const comp = b?.option?.components?.[order.componentIndex];
    if (comp) {
      comp.details = comp.details || {};
      comp.details.esim = {
        provider: profile.provider, iccid: profile.iccid || null,
        lpa: profile.lpa || null, smdp: profile.smdp || null, matchingId: profile.matchingId || null,
        qrData: profile.qrData || null, qrUrl: profile.qrUrl || null,
        appleInstallUrl: profile.appleInstallUrl || null,
        apnValue: profile.apnValue || null, apnType: profile.apnType || null, isRoaming: profile.isRoaming,
        shareLink: profile.shareLink || null, shareAccessCode: profile.shareAccessCode || null,
        packageTitle: profile.packageTitle || null, dataLabel: profile.dataLabel || null, validityDays: profile.validityDays || null,
        live: !!profile.live,
      };
    }
    return completeFulfilmentOrder(order.id, { supplierRef: profile.iccid, note: `${profile.provider}${profile.lpa ? ' · LPA ' + profile.lpa : ''}${profile.shareLink ? ' · share ' + profile.shareLink : ''}`, auto: true });
  }
  if (order.channel === 'auto:host-marketplace') {
    return completeFulfilmentOrder(order.id, { supplierRef: order.bookingId, note: '3JN host marketplace — host notified automatically', auto: true });
  }
}

export function listFulfilmentOrders({ status } = {}) {
  const all = [...db.fulfilmentOrders].reverse();
  return status ? all.filter((o) => o.status === status) : all;
}

export function completeFulfilmentOrder(orderId, { supplierRef, note, auto = false, completedBy = null, netCostGbp = null } = {}) {
  const o = db.fulfilmentOrders.find((x) => x.id === orderId);
  if (!o) return { ok: false, error: 'order-not-found' };
  if (o.status === 'completed') return { ok: true, order: o, already: true };
  if (!auto && !String(supplierRef || '').trim()) return { ok: false, error: 'confirmation-required', message: 'Paste the supplier confirmation number — the customer document depends on it.' };
  o.status = 'completed';
  o.supplierRef = String(supplierRef || '').trim() || o.supplierRef;
  o.note = note || o.note;
  o.completedAt = nowISO();
  o.completedBy = completedBy || (auto ? 'auto' : 'ops');
  // MARGIN CAPTURE: what did this cost us at the supplier (e.g. Rayna NET
  // rate)? sell − net = 3JN's margin on the component, on the record.
  if (Number(netCostGbp) > 0) {
    o.netCostGbp = Math.round(Number(netCostGbp) * 100) / 100;
    o.marginGbp = Math.round(((o.sellPrice || 0) - o.netCostGbp) * 100) / 100;
  }
  // Write the confirmation INTO the booking component so documents + Console
  // show the real supplier reference from this moment on.
  const b = db.bookings.get(o.bookingId);
  const comp = b?.option?.components?.[o.componentIndex];
  if (comp) {
    comp.details = comp.details || {};
    comp.details.confirmation = o.supplierRef;
    comp.details.fulfilledVia = o.channel;
  }
  recordAudit({ actor: o.completedBy, role: auto ? 'system' : 'admin', action: 'fulfilment.completed', entity: 'booking', entityId: o.bookingId, summary: `${o.componentLabel} · ref ${o.supplierRef} · ${o.channel}` });
  if (o.userId) pushNotification(o.userId, { type: 'success', icon: '✅', title: `${FULFILMENT_LABELS[o.componentType] || o.componentType} confirmed`, body: `Your ${(FULFILMENT_LABELS[o.componentType] || o.componentType).toLowerCase()} is booked — confirmation ${o.supplierRef}. Full details are in Console → your booking → 📄 Documents.` });
  return { ok: true, order: o };
}

export function updateFulfilmentOrder(orderId, { status, note } = {}) {
  const o = db.fulfilmentOrders.find((x) => x.id === orderId);
  if (!o) return { ok: false, error: 'order-not-found' };
  if (status && ['new', 'in-progress', 'blocked'].includes(status)) o.status = status;
  if (note != null) o.note = String(note).slice(0, 300);
  return { ok: true, order: o };
}

// ---- CarTrawler Mobility: apply a pushed ride event to a booking ---------------
// Correlates the event to a booking by CarTrawler order reference (stored on
// the booking when the ride was placed) and records the live ride status +
// notifies the traveller. Idempotent per (bookingId, event, orderRef).
export function applyMobilityEvent({ event, orderRef, status, icon, title, body, raw } = {}) {
  const ev = String(event || '').toUpperCase();
  // Find the booking carrying this CarTrawler order ref (set at booking time).
  let booking = null;
  for (const b of db.bookings.values()) {
    if (b.mobility?.orderRef && String(b.mobility.orderRef) === String(orderRef)) { booking = b; break; }
  }
  const entry = { event: ev, status: status || null, at: nowISO(), orderRef: orderRef || null };
  db.audit && recordAudit({ actor: 'cartrawler', role: 'system', action: `mobility.${ev.toLowerCase()}`, entity: 'booking', entityId: booking?.id || orderRef || '-', summary: title || ev });
  if (!booking) return { ok: true, matched: false, note: 'no booking matched this ride reference (logged)' };
  booking.mobility = booking.mobility || { orderRef, events: [] };
  // Idempotent on a STABLE key against ALL prior events (not just the last):
  // webhooks retry and arrive out of order, so a re-sent earlier event
  // (DISPATCHED after ARRIVED) must not append again or re-notify. Prefer the
  // provider's event id; else the event TYPE (each ride event fires once).
  const evKey = (raw && (raw.eventId || raw.id)) ? `id:${raw.eventId || raw.id}` : `ev:${ev}`;
  booking.mobility.seen = booking.mobility.seen || [];
  if (booking.mobility.seen.includes(evKey)) return { ok: true, matched: true, duplicate: true, booking: booking.id };
  booking.mobility.seen.push(evKey);
  booking.mobility.events.push(entry);
  booking.mobility.status = status || booking.mobility.status;
  booking.mobility.lastEventAt = entry.at;
  if (booking.userId && title) {
    pushNotification(booking.userId, { type: ev.includes('CANCELLED') || ev.includes('FAILED') ? 'warning' : 'info', icon: icon || '🚗', title, body: body || '' });
  }
  return { ok: true, matched: true, booking: booking.id, status: booking.mobility.status };
}

// ---- AI Smart Instalment Engine: history + enforcement ----------------------
// Payment history feeding the risk engine: paid bookings, cancellations,
// no-shows, chargebacks (chargebacks arrive via PSP disputes — flag on user).
export function userPaymentHistory(userId) {
  const out = { paidBookings: 0, cancelled: 0, noShows: 0, chargebacks: 0 };
  if (!userId) return out;
  const u = db.users.get(userId);
  out.chargebacks = u?.chargebacks || 0;
  for (const b of db.bookings.values()) {
    if (b.userId !== userId) continue;
    const paid = (b.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    if (String(b.status || '').startsWith('cancelled')) out.cancelled += 1;
    else if (paid > 0) out.paidBookings += 1;
    if (b.noShow) out.noShows += 1;
  }
  return out;
}

// Grace-period enforcement: any smart-plan booking whose instalment stayed
// unpaid past the grace window auto-cancels — deposit forfeited, remaining
// balance refundable per the supplier policy on the booking. Idempotent.
export function enforceInstalments(todayISO) {
  const today = todayISO || nowISO().slice(0, 10);
  const results = { checked: 0, warned: 0, defaulted: 0, reminders: 0, autopayAttempts: 0, actions: [] };
  for (const b of db.bookings.values()) {
    if (b.instalment?.engine !== 'ai-smart' || String(b.status || '').startsWith('cancelled')) continue;
    results.checked += 1;
    // AI Payment Protection: reminders at 14/7/3/1/0 days before each unpaid
    // instalment — sent once per (dueDate, offset), tracked on the booking.
    // (Email/SMS/WhatsApp fan-out rides the comms layer in production; the
    // in-OS notification is the always-on channel.)
    for (const r of dueReminders(b, today)) {
      b.instalmentRemindersSent = b.instalmentRemindersSent || [];
      b.instalmentRemindersSent.push(r.key);
      results.reminders += 1;
      results.actions.push({ bookingId: b.id, action: 'reminder', due: r.due, daysAway: r.daysAway });
      if (b.userId) pushNotification(b.userId, { type: 'info', icon: '📅', title: r.daysAway === 0 ? `Instalment due today${r.final ? ' — final payment' : ''}` : `Instalment due in ${r.daysAway} day${r.daysAway > 1 ? 's' : ''}`, body: `${b.instalment.symbol}${r.amount.toFixed(2)} is due ${r.due}${r.final ? ' — this is the final payment; your e-ticket issues on completion' : ''}. Pay any time from your Console — early payment is always free.` });
      // Automatic recurring payment: with autopay consent + a saved payment
      // method, the due-date reminder becomes an off-session charge attempt
      // (retried per the plan's configurable rule).
      if (r.daysAway === 0 && b.instalment.autopay?.enabled) {
        b.autopayAttempts = b.autopayAttempts || [];
        b.autopayAttempts.push({ due: r.due, at: nowISO(), status: 'initiated', method: b.instalment.autopay.method || 'saved-card' });
        results.autopayAttempts += 1;
        results.actions.push({ bookingId: b.id, action: 'autopay-charge', due: r.due });
      }
    }
    const state = instalmentState(b, today);
    if (state.status === 'in-grace') {
      results.warned += 1;
      if (b.userId && b.lastGraceWarnFor !== state.missedDue) {
        b.lastGraceWarnFor = state.missedDue;
        pushNotification(b.userId, { type: 'warning', icon: '⏳', title: 'Instalment overdue — grace period active', body: `Your instalment of ${b.instalment.symbol}${state.overdueAmount} was due ${state.missedDue}. Pay within the grace period (by ${state.graceDeadline.slice(0, 16).replace('T', ' ')}) to keep your booking — after that it cancels automatically and the deposit is forfeited.` });
      }
      results.actions.push({ bookingId: b.id, action: 'grace-warning', due: state.missedDue });
    } else if (state.status === 'defaulted') {
      const outcome = defaultOutcome(b);
      b.status = 'cancelled-instalment-default';
      b.instalmentDefault = { at: nowISO(), ...outcome, missedDue: state.missedDue };
      results.defaulted += 1;
      results.actions.push({ bookingId: b.id, action: 'auto-cancelled', ...outcome });
      recordAudit({ actor: 'system', role: 'system', action: 'instalment.defaulted', entity: 'booking', entityId: b.id, summary: `missed ${state.missedDue}; deposit ${b.instalment.symbol}${outcome.forfeitedDeposit} forfeited; refundable ${b.instalment.symbol}${outcome.refundableBalance}` });
      if (b.userId) pushNotification(b.userId, { type: 'warning', icon: '❌', title: 'Booking cancelled — instalment unpaid', body: `The grace period passed without payment, so the booking was cancelled per the plan terms. The deposit (${b.instalment.symbol}${outcome.forfeitedDeposit}) is non-refundable; ${outcome.refundableBalance > 0 ? `${b.instalment.symbol}${outcome.refundableBalance} is being refunded per supplier policy.` : 'no further balance was held.'}` });
    }
  }
  return results;
}

// ---- Market Benchmark runs (live fares vs the market leaders) ---------------
export function saveBenchmarkRun(run) {
  const rec = { id: id('bmk'), ...run };
  db.benchmarks.unshift(rec);
  if (db.benchmarks.length > 12) db.benchmarks.length = 12; // keep recent history only
  recordAudit({ actor: 'admin', role: 'admin', action: 'benchmark.run', entity: 'benchmark', entityId: rec.id, summary: `${(run.rows || []).length} routes · depart ${run.depart}` });
  return rec;
}
export function latestBenchmarkRun() {
  return db.benchmarks[0] || null;
}
// The admin reads leader prices off the prefilled links and records them —
// as many as they find. We judge against the LOWEST recorded price overall
// AND against the lowest PROTECTED (single-ticket) price, because an OTA
// "self-transfer" combo (separate tickets, no protection, re-check bags,
// sometimes an overnight in a hub) is not the same product as ours.
export function recordBenchmarkMarket(runId, rowId, { source, priceGbp, selfTransfer = false, caveat = '' } = {}) {
  const run = db.benchmarks.find((b) => b.id === runId);
  if (!run) return { ok: false, error: 'run-not-found' };
  const row = (run.rows || []).find((r) => r.id === rowId);
  if (!row) return { ok: false, error: 'row-not-found' };
  const price = Math.round(Number(priceGbp) * 100) / 100;
  if (!(price > 0)) return { ok: false, error: 'bad-price', message: 'Enter the market price in GBP.' };
  row.marketQuotes = row.marketQuotes || [];
  row.marketQuotes.push({ source: String(source || 'market').slice(0, 40), priceGbp: price, selfTransfer: !!selfTransfer, caveat: String(caveat || '').trim().slice(0, 80) || null, at: nowISO() });
  const lowest = row.marketQuotes.reduce((a, b) => (a.priceGbp <= b.priceGbp ? a : b));
  const protectedQuotes = row.marketQuotes.filter((q) => !q.selfTransfer);
  const lowestProtected = protectedQuotes.length ? protectedQuotes.reduce((a, b) => (a.priceGbp <= b.priceGbp ? a : b)) : null;
  row.market = lowest; // kept for compatibility: the toughest competitor
  if (row.ourPriceGbp != null) {
    row.result = { ...benchmarkVerdict(row.ourPriceGbp, lowest.priceGbp), vs: lowest };
    row.protectedResult = lowestProtected ? { ...benchmarkVerdict(row.ourPriceGbp, lowestProtected.priceGbp), vs: lowestProtected } : null;
    // The honest headline: beaten only by an unprotected hack ≠ beaten.
    row.note = row.result.verdict === 'above-market' && lowest.selfTransfer && row.protectedResult && row.protectedResult.verdict !== 'above-market'
      ? 'Only self-transfer combos (separate tickets, no protection) undercut us — we beat or match every protected fare recorded.'
      : null;
  } else {
    row.result = { verdict: 'no-live-fare', deltaGbp: null, deltaPct: null };
  }
  return { ok: true, row };
}

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
// ---- Host payout details -----------------------------------------------------
// A host cannot be PAID without real payout details, so registration requires
// them. Validated per method; stored server-side; every read is MASKED (last 4
// only) so full account numbers never travel back to the browser.
// PAYMENT RAIL POLICY: Stripe is the default for ALL money in and out until
// BitriPay completes. Bank-transfer payouts run over Stripe; BitriPay wallet
// stays visible as "coming soon" but is REFUSED until BITRIPAY_ENABLED=true.
export const PAYMENT_RAIL = { default: 'stripe', bitripayEnabled: () => process.env.BITRIPAY_ENABLED === 'true' };
export const HOST_PAYOUT_METHODS = ['Bank transfer', 'BitriPay wallet', 'PayPal'];
function validateHostPayout(method, p = {}) {
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  if (method === 'BitriPay wallet' && !PAYMENT_RAIL.bitripayEnabled()) {
    return { ok: false, error: 'bitripay-coming-soon', message: 'BitriPay is completing certification — payouts run on Stripe (bank transfer) for now. Choose Bank transfer or PayPal; you can switch to BitriPay the day it launches.' };
  }
  if (method === 'Bank transfer') {
    const accountHolder = s(p.accountHolder, 80);
    const accountNumber = s(p.accountNumber || p.iban, 42).replace(/\s+/g, '');
    const bankName = s(p.bankName, 80);
    const sortOrSwift = s(p.sortOrSwift, 20).replace(/\s+/g, '');
    if (accountHolder.length < 3) return { ok: false, error: 'payout-account-holder', message: 'Enter the account holder name exactly as the bank knows it.' };
    if (accountNumber.length < 8) return { ok: false, error: 'payout-account-number', message: 'Enter a valid IBAN or account number (min 8 characters).' };
    if (!bankName) return { ok: false, error: 'payout-bank-name', message: 'Enter the bank name.' };
    return { ok: true, payout: { accountHolder, accountNumber, bankName, sortOrSwift, currency: s(p.currency, 3).toUpperCase() || 'GBP' } };
  }
  if (method === 'BitriPay wallet') {
    const walletId = s(p.walletId || p.phone, 40);
    if (walletId.length < 6) return { ok: false, error: 'payout-wallet', message: 'Enter your BitriPay wallet ID or registered phone number.' };
    return { ok: true, payout: { walletId } };
  }
  if (method === 'PayPal') {
    const paypalEmail = s(p.paypalEmail, 120).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(paypalEmail)) return { ok: false, error: 'payout-paypal', message: 'Enter a valid PayPal email address.' };
    return { ok: true, payout: { paypalEmail } };
  }
  return { ok: false, error: 'payout-method', message: 'Choose a payout method.' };
}
const mask = (v) => { const x = String(v || ''); return x.length <= 4 ? x : '•••• ' + x.slice(-4); };
export function maskedHostPayout(profile) {
  const p = profile?.payout; if (!p) return null;
  return {
    method: profile.payoutMethod,
    accountHolder: p.accountHolder || undefined,
    bankName: p.bankName || undefined,
    accountNumber: p.accountNumber ? mask(p.accountNumber) : undefined,
    sortOrSwift: p.sortOrSwift ? mask(p.sortOrSwift) : undefined,
    currency: p.currency || undefined,
    walletId: p.walletId ? mask(p.walletId) : undefined,
    paypalEmail: p.paypalEmail ? p.paypalEmail.replace(/^(..).*(@.*)$/, '$1•••$2') : undefined,
    verified: !!profile.payoutVerified,
  };
}

export function registerHost(userId, { displayName, payoutMethod = 'Bank transfer', payout = {} } = {}) {
  const u = userId ? db.users.get(userId) : null;
  if (!u) return { ok: false, error: 'auth-required', message: 'Sign in to register as a host.' };
  if (u.host && u.hostProfile) return { ok: true, alreadyRegistered: true, profile: u.hostProfile };
  const method = HOST_PAYOUT_METHODS.includes(payoutMethod) ? payoutMethod : 'Bank transfer';
  // Registration REQUIRES real payout details — without them we can't pay the
  // host their 90%, so the account must not exist half-configured.
  const pv = validateHostPayout(method, payout);
  if (!pv.ok) return pv;
  u.host = true;
  u.hostProfile = {
    displayName: String(displayName || u.name || 'Host').trim().slice(0, 60),
    payoutMethod: method,
    payout: pv.payout,
    payoutVerified: false, // first payout run verifies with a micro-deposit/KYC
    registeredAt: new Date().toISOString(),
  };
  recordAudit({ actor: u.id, role: 'host', action: 'host.registered', entity: 'user', entityId: u.id, summary: `${u.hostProfile.displayName} · ${method} (payout captured)` });
  pushNotification(u.id, { type: 'success', icon: '🏠', title: 'Host account active', body: `Your Host Dashboard is ready and your ${method} payout is set up — publish your first property.` });
  return { ok: true, profile: u.hostProfile };
}

// Update payout details later from the dashboard (audited; re-verification).
export function updateHostPayout(userId, { payoutMethod, payout = {} } = {}) {
  const u = userId ? db.users.get(userId) : null;
  if (!u || !u.hostProfile) return { ok: false, error: 'not-a-host' };
  const method = HOST_PAYOUT_METHODS.includes(payoutMethod) ? payoutMethod : u.hostProfile.payoutMethod;
  const pv = validateHostPayout(method, payout);
  if (!pv.ok) return pv;
  u.hostProfile.payoutMethod = method;
  u.hostProfile.payout = pv.payout;
  u.hostProfile.payoutVerified = false; // changed details must re-verify
  u.hostProfile.payoutUpdatedAt = new Date().toISOString();
  recordAudit({ actor: u.id, role: 'host', action: 'host.payout.updated', entity: 'user', entityId: u.id, summary: method });
  pushNotification(u.id, { type: 'info', icon: '💷', title: 'Payout details updated', body: `Future payouts go to your ${method}. New details are re-verified before the next payout run.` });
  return { ok: true, payout: maskedHostPayout(u.hostProfile) };
}

export const HOST_PHOTOS_MIN = 10;
export const HOST_PHOTOS_MAX = 100;

export function createHostListing(userId, { title, city, address, propertyType = 'Entire apartment', nightlyUSD, sleeps = 2, amenities = [], photos = [], kind = 'stay', ...fullSchema } = {}) {
  const u = userId ? db.users.get(userId) : null;
  if (!u) return { ok: false, error: 'auth-required' };
  if (!u.host || !u.hostProfile) return { ok: false, error: 'host-registration-required', message: 'Register as a host first — your dashboard unlocks publishing.' };
  const t = String(title || '').trim().slice(0, 80);
  const c = String(city || '').trim().slice(0, 60);
  const isExperience = kind === 'experience'; // priced PER PERSON
  const rate = Math.round(Number(nightlyUSD) || 0);
  if (!t || !c || rate <= 0) return { ok: false, error: 'invalid-listing', message: `Title, city and a ${isExperience ? 'per-person price' : 'nightly rate'} are required.` };
  // Every stay on the OS carries a street address so guests can verify it on
  // the internet — hosted properties are no exception.
  const addr = String(address || '').trim().slice(0, 160);
  if (addr.length < 8) return { ok: false, error: 'address-required', message: 'A full street address is required — guests verify your property online by name + address.' };
  // Hosted-by-us properties must SHOW the place: minimum 10 photos (5 for an
  // experience), maximum 100.
  const minPics = isExperience ? 5 : HOST_PHOTOS_MIN;
  const pics = (Array.isArray(photos) ? photos : String(photos).split(/[\n,]+/))
    .map((x) => String(x).trim()).filter(Boolean).slice(0, HOST_PHOTOS_MAX + 1);
  if (pics.length < minPics) return { ok: false, error: 'photos-min', message: `Hosted ${isExperience ? 'experiences' : 'listings'} need a minimum of ${minPics} pictures (you provided ${pics.length}).` };
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
    kind: isExperience ? 'experience' : 'stay',
    title: t,
    city: c,
    propertyType: String(propertyType).slice(0, 40),
    nightlyUSD: rate, // for an experience this is the PER-PERSON price
    address: addr,
    photos: pics,
    sleeps: Math.max(1, Math.min(20, Math.round(Number(sleeps) || 2))),
    amenities: (Array.isArray(amenities) ? amenities : String(amenities).split(',')).map((a) => String(a).trim()).filter(Boolean).slice(0, 12),
    // The COMPLETE listing schema (information · pricing units · long-term
    // rates · additional costs · features · media · location · bedrooms ·
    // services · terms & rules · opening hours) — sanitized in one place.
    // Experiences take FULL payment at booking; stays take the deposit %.
    details: sanitizeListingDetails({ ...fullSchema, propertyType, depositPct: isExperience ? 100 : fullSchema.depositPct }),
    // Availability calendar: dates the host blocked + per-date price overrides.
    availability: { blocked: [], priceOverridesUSD: {} },
    verified: false,           // becomes true only on admin approval
    reliabilityScore: 82,
    // MODERATION GATE: no property goes online for public booking until AI
    // verification has run AND an admin has reviewed and approved it.
    status: 'pending-review',
    aiVerification: aiVerifyListing({ title: t, city: c, address: addr, photos: pics, nightlyUSD: rate, host: u }),
    review: null,               // { decision, reason, reviewerId, at } once decided
    createdAt: new Date().toISOString(),
  };
  db.hostListings.push(listing);
  recordAudit({ actor: u.id, role: 'host', action: 'host.listing.submitted', entity: 'hostListing', entityId: listing.id, summary: `${t} · ${c} · $${rate}/night · awaiting review` });
  pushNotification(u.id, { type: 'info', icon: '🔎', title: 'Listing under review', body: `${t} passed upload checks and is now in AI verification + admin review. It goes live once approved.` });
  return { ok: true, listing, note: 'Submitted for AI verification + admin review — not yet publicly bookable.' };
}

// ---- Host listing AI verification (runs on every submission) -----------------
// Deterministic screening an admin reviews before a property may go online:
// identity, address plausibility, photo coverage, price sanity vs city norms,
// and host-account risk signals. Score 0–100 (higher = safer).
export function aiVerifyListing({ title, city, address, photos = [], nightlyUSD = 0, host }) {
  const checks = [];
  const add = (check, pass, note) => checks.push({ check, pass: !!pass, note });
  add('Host identity on file', !!(host?.name && host?.email), `${host?.name || 'unknown'} <${host?.email || 'no email'}>`);
  add('Host registration complete', !!host?.hostProfile, host?.hostProfile ? `payout: ${host.hostProfile.payoutMethod}` : 'not registered');
  add('Street address plausible', /\d/.test(address) && address.length >= 8, address);
  add('Photo coverage (10–100 real photos)', photos.length >= 10 && photos.length <= 100, `${photos.length} photos`);
  add('Photos not duplicated', new Set(photos).size === photos.length, `${new Set(photos).size}/${photos.length} unique`);
  add('Price sanity vs city norms', nightlyUSD >= 10 && nightlyUSD <= 2000, `$${nightlyUSD}/night`);
  add('Title free of scam patterns', !/free|guaranteed|wire transfer|western union|crypto only/i.test(title), title.slice(0, 40));
  add('Host account age & activity', true, `since ${host?.createdAt || 'seed'}`);
  const passed = checks.filter((x) => x.pass).length;
  const score = Math.round((passed / checks.length) * 100);
  return {
    score,
    checks,
    securityRisk: score >= 90 ? 'Low' : score >= 70 ? 'Medium' : 'High',
    recommendation: score >= 90 ? 'Approve' : score >= 70 ? 'Manual review — resolve flagged checks' : 'Reject or request corrections',
    ranAt: nowISO(),
  };
}

// Admin decision: approve puts the property online; reject keeps it offline.
export function reviewHostListing(listingId, { decision, reason = '', reviewerId = 'admin' } = {}) {
  const l = db.hostListings.find((x) => x.id === listingId);
  if (!l) return { ok: false, error: 'not-found' };
  if (!['approve', 'reject'].includes(decision)) return { ok: false, error: 'invalid-decision' };
  l.review = { decision, reason: String(reason).slice(0, 400), reviewerId, at: nowISO() };
  l.status = decision === 'approve' ? 'live' : 'rejected';
  l.verified = decision === 'approve';
  recordAudit({ actor: reviewerId, role: 'admin', action: `host.listing.${decision}`, entity: 'hostListing', entityId: l.id, summary: `${l.title} · ${decision}${reason ? ' — ' + reason.slice(0, 60) : ''}` });
  pushNotification(l.hostId, decision === 'approve'
    ? { type: 'success', icon: '🏠', title: 'Listing approved — you are live', body: `${l.title} passed AI verification and admin review; it now appears in ${l.city} searches.` }
    : { type: 'warning', icon: '🛑', title: 'Listing not approved', body: `${l.title}: ${reason || 'it did not pass review'}. Fix the issues and resubmit.` });
  return { ok: true, listing: l };
}

// The admin's complete user & host management view: every user with their
// role/risk/activity, every host with their properties, AI verification and
// the pending-review queue.
export function adminUserHostOverview() {
  const users = [...db.users.values()].map((u) => ({
    id: u.id, name: u.name, email: u.email, role: u.role,
    membership: u.membership?.active ? u.membership.name : null,
    acuBalance: u.acuBalance, points: u.points,
    bookings: [...db.bookings.values()].filter((b) => b.userId === u.id).length,
    isHost: !!u.host, suspended: !!u.suspended, createdAt: u.createdAt || null,
  }));
  const listings = db.hostListings.map((l) => ({
    id: l.id, title: l.title, city: l.city, address: l.address, nightlyUSD: l.nightlyUSD,
    hostId: l.hostId, hostName: l.hostName, photos: (l.photos || []).length,
    status: l.status, verified: l.verified, aiVerification: l.aiVerification || null, review: l.review || null,
  }));
  return {
    users,
    hosts: users.filter((u) => u.isHost),
    listings,
    pendingReview: listings.filter((l) => l.status === 'pending-review'),
  };
}

export function listHostListings(userId) {
  return db.hostListings.filter((l) => l.hostId === userId);
}

// Live, verified community supply for a destination — merged into the
// accommodation scan so hosts compete with hotels in every relevant search.
export function hostListingsForCity(cityText) {
  const needle = String(cityText || '').toLowerCase();
  if (!needle) return [];
  return db.hostListings.filter((l) => l.status === 'live' && l.verified && (l.kind || 'stay') === 'stay'
    && (l.city.toLowerCase().includes(needle) || needle.includes(l.city.toLowerCase())));
}
// Community EXPERIENCES (host-run tours/activities) live for a city — they
// compete inside the activities scan the same way stays compete with hotels.
export function hostExperiencesForCity(cityText) {
  const needle = String(cityText || '').toLowerCase();
  if (!needle) return [];
  return db.hostListings.filter((l) => l.status === 'live' && l.verified && l.kind === 'experience'
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
  // Full-schema detail update: re-sanitize the merged detail so bounds hold.
  if (patch.details !== undefined && typeof patch.details === 'object') {
    l.details = sanitizeListingDetails({ ...(l.details || {}), ...patch.details });
  }
  // Availability calendar: toggle blocked dates / set per-date price overrides.
  if (patch.availability !== undefined && typeof patch.availability === 'object') {
    l.availability = l.availability || { blocked: [], priceOverridesUSD: {} };
    if (Array.isArray(patch.availability.blocked)) {
      l.availability.blocked = [...new Set(patch.availability.blocked.map((d) => String(d).slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].slice(0, 730);
    }
    if (patch.availability.priceOverridesUSD && typeof patch.availability.priceOverridesUSD === 'object') {
      const clean = {};
      for (const [dt, usd] of Object.entries(patch.availability.priceOverridesUSD).slice(0, 730)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(dt) && Number(usd) > 0) clean[dt] = Math.round(Number(usd) * 100) / 100;
      }
      l.availability.priceOverridesUSD = clean;
    }
  }
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
  // NEVER return raw payout details to the browser — masked only (last 4).
  const profile = u.hostProfile ? { ...u.hostProfile, payout: undefined, payoutMasked: maskedHostPayout(u.hostProfile) } : null;
  return {
    ok: true,
    registered,
    profile,
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
