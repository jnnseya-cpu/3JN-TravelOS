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
};

// ---- Users / loyalty / ACU wallet ----------------------------------------
export function createUser({ email, name, referredByCode } = {}) {
  const userId = id('usr');
  const referralCode = '3JN-' + userId.slice(-4).toUpperCase();
  const user = {
    id: userId,
    email: email || `${userId}@guest.3jn`,
    name: name || 'Guest Traveller',
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
    points: u.points,
    tier: tier.name,
    tierDiscount: tier.discount,
    acuBalance: u.acuBalance,
    referralCode: u.referralCode,
    referrals: u.referrals,
  };
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

function nowISO() {
  // Deterministic-friendly: callers don't depend on exact time, and Date.now is
  // unavailable in some sandboxes. Use a monotonic stamp.
  return new Date(Date.UTC(2026, 5, 30, 12, 0, counter % 60)).toISOString();
}
function round2(n) { return Math.round(n * 100) / 100; }

export { db };
