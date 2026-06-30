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
} from './store.js';
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

// ---- White-label API revenue calculator ----------------------------------
app.get('/api/white-label/payout', safe((req, res) => {
  const volume = Number(req.query.volume) || 100000;
  res.json({ payout: whiteLabelPayout(volume), revenueStreams: REVENUE_STREAMS });
}));

// ---- Admin / profitability snapshot --------------------------------------
app.get('/api/admin/revenue', safe((req, res) => {
  res.json({ snapshot: revenueSnapshot(), revenueStreams: REVENUE_STREAMS });
}));

// ---- AI Gateway status (which provider handles which task) ----------------
app.get('/api/ai/status', safe((req, res) => {
  res.json({ gateway: gatewayStatus() });
}));

// ---- Public "white-label" partner endpoint (returns a package) -----------
// Demonstrates the API other businesses would integrate.
app.post('/api/v1/search', safe((req, res) => {
  const { text } = req.body || {};
  const context = detectContext(req, {});
  const result = plan({ text, context, user: null, searchTier: 'smart' });
  res.json({
    partner: req.headers['x-partner-key'] || 'demo-partner',
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
app.get(['/how-it-works', '/api-portal', '/membership', '/console'], (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`\n  3JN Travel OS running → http://localhost:${PORT}\n`);
  });
}

export { app };
