// In-memory data store for the prototype. A production build would back this
// with Postgres/Firestore; the interface here is intentionally small so it
// could be swapped out. All state lives for the lifetime of the process.

import { SIGNUP_BONUS_POINTS, tierForPoints } from './pricing.js';

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
  behaviour: [], // behavioural-learning event stream (searches, views, books…)
};

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
  return rec;
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
    autoDigitalRate: apps.length ? Math.round((by((a) => a.decision !== 'Human Review') / apps.length) * 100) : 0,
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
export const ROLES = ['consumer', 'business', 'merchant', 'partner', 'admin'];
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
    acuBalance: 100, // small free allowance
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

export function buyAcu(userId, pack) {
  const PACKS = {
    starter: { acu: 500, gbp: 5 },
    traveller: { acu: 1750, gbp: 15 },
    family: { acu: 4000, gbp: 29 },
    business: { acu: 20000, gbp: 99 },
  };
  const p = PACKS[pack];
  const u = db.users.get(userId);
  if (!u || !p) return { ok: false, error: 'invalid' };
  u.acuBalance += p.acu;
  db.acuTxns.push({ id: id('acu'), userId, type: 'PURCHASE', amount: p.acu, reason: `pack:${pack}`, at: nowISO() });
  return { ok: true, balance: u.acuBalance, charged: p.gbp };
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
  recordAudit({ actor: userId, role: u.role, action: 'profile.updated', entity: 'user', entityId: userId, summary: Object.keys(patch).join(', ') });
  return publicUser(u);
}

// Provision one account per role for testing/admin (idempotent-ish by email).
export function seedAllRoles() {
  const specs = [
    { role: 'admin', name: 'Platform Admin', email: 'admin@3jntravel.com' },
    { role: 'business', name: 'Corporate Manager', email: 'business@3jntravel.com' },
    { role: 'merchant', name: 'BitriPay Merchant', email: 'merchant@3jntravel.com' },
    { role: 'partner', name: 'Agency Partner', email: 'partner@3jntravel.com' },
    { role: 'consumer', name: 'Test Traveller', email: 'tester@3jntravel.com' },
  ];
  return specs.map((s) => {
    const existing = [...db.users.values()].find((u) => u.email === s.email);
    if (existing) return publicUser(existing);
    return createUser(s);
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

export function createBooking({ quoteId, option, instalment, userId, paymentMethod = 'card' }) {
  const bookingId = id('bkg');
  const gateway = GATEWAY[paymentMethod] || 'stripe';
  const booking = {
    id: bookingId,
    quoteId,
    userId: userId || null,
    option,
    instalment,
    paymentMethod,
    gateway,
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

  // Award loyalty points (0.5 pt / $1).
  if (userId) addPoints(userId, option.totalUSD * 0.5);

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

// ---- Persistence snapshot / hydrate (for Firebase RTDB / Firestore) -------
// Serialise the whole store to a plain JSON-safe object, and restore it. Maps
// become objects; arrays pass through. Lets a persistence layer survive
// restarts without rewriting every accessor to be async.
const MAP_KEYS = ['users', 'quotes', 'bookings', 'drafts', 'supplierScores'];
const ARRAY_KEYS = ['reviews', 'acuTxns', 'referrals', 'priceEvents', 'apiKeys', 'audit', 'paymentLinks', 'approvals', 'notifications', 'visaApps', 'esims', 'contracts', 'blog', 'behaviour'];

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
