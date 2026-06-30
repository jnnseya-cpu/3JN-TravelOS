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
};

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
export function createUser({ email, name, referredByCode, role, avatar, bio } = {}) {
  const userId = id('usr');
  const referralCode = '3JN-' + userId.slice(-4).toUpperCase();
  const safeRole = ROLES.includes(role) ? role : 'consumer';
  const user = {
    id: userId,
    email: email || `${userId}@guest.3jn`,
    name: name || 'Guest Traveller',
    role: safeRole,
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
  if (!['merchant', 'partner', 'admin'].includes(u.role)) {
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
  if (!['merchant', 'partner', 'admin'].includes(u.role)) return { ok: false, error: 'role-not-permitted' };
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

export { db };
