// 3JN Travel OS — Express server.
// Serves the premium frontend and the full JSON API that drives the pipeline.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectContext, listCurrencies } from './geo.js';
import { plan } from './planner.js';
import { instalmentPlan } from './pricing.js';
import {
  createUser, getUser, buyAcu, saveQuote, getQuote, createBooking,
  getBooking, listBookings, recordPayment, revenueSnapshot, addPoints,
  adminOverview, adminUsers, adminBookings, adminActivity,
  updateUser, seedAllRoles, ROLES,
  createApiKey, listApiKeys, revokeApiKey, useApiKey,
  adminAudit, saveDraft, getDraft,
  createPaymentLink, listPaymentLinks, settlePaymentLink, merchantSettlement,
  listApprovals, decideApproval,
  listNotifications, markNotificationsRead,
} from './store.js';
import { visaCheck, riskFeed } from './intelligence.js';
import { runPriceGuard } from './monitor.js';
import { submitReview, leaderboard } from './reviews.js';
import { whiteLabelPayout, REVENUE_STREAMS, SEARCH_TIERS } from './revenue.js';
import { gatewayStatus } from './ai-gateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Resolve the active user from a header (prototype "auth").
function currentUser(req) {
  const uid = req.headers['x-user-id'];
  return uid ? getUser(uid) : null;
}

// Wrap handlers so a thrown error always returns clean JSON — never the empty
// "{}" serialization failure the previous build suffered from.
const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error('[api error]', req.path, err);
    res.status(500).json({ error: 'internal', message: String(err.message || err) });
  }
};

// ---- Context / config -----------------------------------------------------
app.get('/api/context', safe((req, res) => {
  res.json({ context: detectContext(req), currencies: listCurrencies(), searchTiers: SEARCH_TIERS });
}));

// ---- Account / loyalty / ACU ---------------------------------------------
app.post('/api/account', safe((req, res) => {
  const user = createUser(req.body || {});
  res.json({ user });
}));

app.get('/api/account/:id', safe((req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'not-found' });
  res.json({ user, bookings: listBookings(user.id) });
}));

// Edit an account profile (name, email, bio, role, avatar).
app.patch('/api/account/:id', safe((req, res) => {
  const user = updateUser(req.params.id, req.body || {});
  if (!user) return res.status(404).json({ error: 'not-found' });
  res.json({ user });
}));

// Provision one account per role (consumer/business/merchant/partner/admin).
app.post('/api/accounts/seed-roles', safe((req, res) => {
  res.json({ roles: ROLES, accounts: seedAllRoles() });
}));

// One-click testing account, pre-loaded (the session's /debug/seed).
app.post('/api/account/test', safe((req, res) => {
  const user = createUser({ email: 'tester@3jntravel.com', name: 'Test Traveller' });
  addPoints(user.id, 1250 - user.points); // land in Voyager tier (~1,250 pts)
  res.json({ user: getUser(user.id), note: 'Voyager-tier test account provisioned.' });
}));

app.post('/api/account/:id/acu', safe((req, res) => {
  const result = buyAcu(req.params.id, (req.body || {}).pack);
  res.json(result);
}));

// ---- Plan: the core pipeline ---------------------------------------------
app.post('/api/plan', safe((req, res) => {
  const { text, searchTier, overrides, country, currencyCountry } = req.body || {};
  const context = detectContext(req, { country, currencyCountry });
  const user = currentUser(req);
  const result = plan({ text, context, user, searchTier, overrides });
  res.json(result);
}));

// ---- Quote: persist a chosen option + build instalments -------------------
app.post('/api/quote', safe((req, res) => {
  const { option, intent, months, depositPct } = req.body || {};
  if (!option) return res.status(400).json({ error: 'option-required' });
  const currency = { code: option.pricing.currency, symbol: option.pricing.symbol, rateFromUSD: option.pricing.local.total / option.pricing.lines.totalUSD };
  const instalment = instalmentPlan({
    totalLocal: option.pricing.local.total,
    currency,
    months: months || 3,
    depositPct: depositPct ?? 0.2,
    checkIn: intent?.dates?.checkIn,
  });
  const quote = saveQuote({ option, intent, instalment });
  res.json({ quote });
}));

// ---- Book: confirm + take deposit ----------------------------------------
app.post('/api/book', safe((req, res) => {
  const { quoteId, months, depositPct, paymentMethod } = req.body || {};
  const quote = getQuote(quoteId);
  if (!quote) return res.status(404).json({ error: 'quote-not-found' });
  const user = currentUser(req);

  let instalment = quote.instalment;
  if (months || depositPct != null) {
    const currency = { code: quote.option.pricing.currency, symbol: quote.option.pricing.symbol, rateFromUSD: 1 };
    instalment = instalmentPlan({
      totalLocal: quote.option.pricing.local.total,
      currency,
      months: months || quote.instalment.months,
      depositPct: depositPct ?? quote.instalment.depositPct,
      checkIn: quote.intent?.dates?.checkIn,
    });
  }

  const booking = createBooking({ quoteId, option: quote.option, instalment, userId: user?.id, paymentMethod });
  res.json({ booking, user: user ? getUser(user.id) : null });
}));

// ---- Pay an instalment ----------------------------------------------------
app.post('/api/book/:id/pay', safe((req, res) => {
  const { amount, index } = req.body || {};
  const booking = recordPayment(req.params.id, { type: 'instalment', amount, index });
  if (!booking) return res.status(404).json({ error: 'not-found' });
  if (booking.instalment?.schedule?.[index]) booking.instalment.schedule[index].status = 'paid';
  res.json({ booking });
}));

app.get('/api/book/:id', safe((req, res) => {
  const booking = getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'not-found' });
  res.json({ booking });
}));

// ---- Notifications --------------------------------------------------------
app.get('/api/notifications', safe((req, res) => {
  const user = currentUser(req);
  const items = listNotifications(user?.id);
  res.json({ notifications: items, unread: items.filter((n) => !n.read).length });
}));
app.post('/api/notifications/read', safe((req, res) => {
  const user = currentUser(req);
  res.json(markNotificationsRead(user?.id));
}));

// ---- Visa Centre + Risk Intelligence Feed ---------------------------------
app.get('/api/visa/check', safe((req, res) => {
  res.json(visaCheck(req.query.nationality, req.query.destination));
}));
app.get('/api/risk/:destination', safe((req, res) => {
  res.json(riskFeed(req.params.destination));
}));

// ---- Price guard ----------------------------------------------------------
app.post('/api/book/:id/price-guard', safe((req, res) => {
  const { drift } = req.body || {};
  const event = runPriceGuard(req.params.id, typeof drift === 'number' ? drift : undefined);
  res.json({ event, booking: getBooking(req.params.id) });
}));

// ---- Reviews & supplier scoring ------------------------------------------
app.post('/api/reviews', safe((req, res) => {
  const result = submitReview(req.body || {});
  res.json(result);
}));
app.get('/api/suppliers/leaderboard', safe((req, res) => {
  res.json({ leaderboard: leaderboard() });
}));

// ---- Merchant / white-label API key management ----------------------------
app.post('/api/merchant/keys', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  const result = createApiKey(user.id, req.body || {});
  if (!result.ok) return res.status(403).json(result);
  res.json(result); // includes the full secret ONCE
}));

app.get('/api/merchant/keys', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json({ keys: listApiKeys(user.id) });
}));

app.delete('/api/merchant/keys/:keyId', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json(revokeApiKey(user.id, req.params.keyId));
}));

// ---- White-label API revenue calculator ----------------------------------
app.get('/api/white-label/payout', safe((req, res) => {
  const volume = Number(req.query.volume) || 100000;
  res.json({ payout: whiteLabelPayout(volume), revenueStreams: REVENUE_STREAMS });
}));

// ---- Admin Super Control Centre ------------------------------------------
app.get('/api/admin/revenue', safe((req, res) => {
  res.json({ snapshot: revenueSnapshot(), revenueStreams: REVENUE_STREAMS });
}));

app.get('/api/admin/overview', safe((req, res) => {
  res.json({
    overview: adminOverview(),
    revenueStreams: REVENUE_STREAMS,
    leaderboard: leaderboard(),
    gateway: gatewayStatus(),
    activity: adminActivity(20),
  });
}));

app.get('/api/admin/users', safe((req, res) => {
  res.json({ users: adminUsers() });
}));

app.get('/api/admin/bookings', safe((req, res) => {
  res.json({ bookings: adminBookings() });
}));

app.get('/api/admin/audit', safe((req, res) => {
  res.json({ audit: adminAudit(Number(req.query.limit) || 50) });
}));

// ---- Autosave drafts ------------------------------------------------------
app.put('/api/drafts/:key', safe((req, res) => {
  const user = currentUser(req);
  const rec = saveDraft(user?.id, req.params.key, (req.body || {}).payload);
  res.json({ saved: true, savedAt: rec.savedAt });
}));
app.get('/api/drafts/:key', safe((req, res) => {
  const user = currentUser(req);
  res.json({ draft: getDraft(user?.id, req.params.key) });
}));

// ---- BitriPay Merchant Portal ---------------------------------------------
app.post('/api/bitripay/links', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  const result = createPaymentLink(user.id, req.body || {});
  if (!result.ok) return res.status(403).json(result);
  res.json(result);
}));
app.get('/api/bitripay/links', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json({ links: listPaymentLinks(user.id), settlement: merchantSettlement(user.id) });
}));
app.post('/api/bitripay/links/:id/settle', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json(settlePaymentLink(user.id, req.params.id));
}));

// ---- Business / Enterprise approvals --------------------------------------
app.get('/api/business/approvals', safe((req, res) => {
  res.json({ approvals: listApprovals(), bookings: adminBookings() });
}));
app.post('/api/business/approvals/:id', safe((req, res) => {
  res.json(decideApproval(req.params.id, (req.body || {}).decision));
}));

// ---- AI Gateway status (which provider handles which task) ----------------
app.get('/api/ai/status', safe((req, res) => {
  res.json({ gateway: gatewayStatus() });
}));

// ---- Public "white-label" partner endpoint (returns a package) -----------
// Demonstrates the API other businesses would integrate.
app.post('/api/v1/search', safe((req, res) => {
  const { text } = req.body || {};
  const partnerKey = req.headers['x-partner-key'];
  // Validate a real issued key if supplied; otherwise allow the public demo.
  const keyInfo = partnerKey ? useApiKey(partnerKey) : null;
  const context = detectContext(req, {});
  const result = plan({ text, context, user: null, searchTier: 'smart' });
  res.json({
    partner: keyInfo ? keyInfo.userId : (partnerKey ? 'invalid-or-revoked-key' : 'demo-partner'),
    environment: keyInfo ? keyInfo.environment : 'demo',
    authenticated: Boolean(keyInfo),
    revenueShare: '90% partner / 10% 3JN',
    result,
  });
}));

// ---- Static frontend ------------------------------------------------------
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');
const SHARED_DIR = path.join(__dirname, '..', '..', 'shared');
app.use(express.static(FRONTEND_DIR));
// Expose shared constants to the browser so frontend and backend never drift.
app.use('/shared', express.static(SHARED_DIR));

// SPA-ish fallback for the page routes.
app.get(['/how-it-works', '/api-portal', '/membership', '/console', '/admin', '/business'], (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`\n  3JN Travel OS running → http://localhost:${PORT}\n`);
  });
}

export { app };
