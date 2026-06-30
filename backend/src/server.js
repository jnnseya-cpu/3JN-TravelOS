// 3JN Travel OS — Express server.
// Serves the premium frontend and the full JSON API that drives the pipeline.

import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { detectContext, listCurrencies } from './geo.js';
import { destinationsCatalog } from './destinations.js';
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
  recordVisaApplication, govAnalytics,
  findUserByEmail, provisionEsim, listEsims, activateEsim, expenseReport,
  createContract, listContracts, recordBehaviour,
  subscribeMembership, renewMembership, cancelMembership, spendAcu,
} from './store.js';
import { MEMBERSHIP_TIERS, ACU_PER_GBP, MEMBERSHIP_ACU_FUND_RATE } from '../../shared/constants.js';
import { track as trackBehaviour, learnProfile, journeyDashboard } from './learning.js';
import { visaCheck, riskFeed } from './intelligence.js';
import { assessVisa, approvalProbability } from './visaos.js';
import { runPriceGuard } from './monitor.js';
import { submitReview, leaderboard } from './reviews.js';
import { whiteLabelPayout, REVENUE_STREAMS, SEARCH_TIERS } from './revenue.js';
import { gatewayStatus } from './ai-gateway.js';
import { securityReport, opsDiagnostics, seoReport, marketingPlan, createPost, listPosts, getPost } from './agents.js';
import { snapshot, hydrate } from './store.js';
import { initPersistence, isEnabled, load, save, scheduleSave } from './persistence.js';
import { initMailer, isMailerEnabled, sendMail, bookingEmail, MAIN_CONTACT } from './mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Avatar/data-URL payloads can be ~600KB — lift the JSON limit accordingly.
app.use(express.json({ limit: '1mb' }));

// CORS — allows the Vercel-hosted frontend to call this API directly (or via a
// rewrite proxy). Lock CORS_ORIGIN to your domain in production.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-user-id, x-country, x-partner-key');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health check for Cloud Run / Firebase / load balancers.
app.get('/api/health', (req, res) => res.json({ ok: true, service: '3jn-travel-os', persistence: isEnabled(), email: isMailerEnabled() }));

// Persist the store to Firebase RTDB shortly after any successful mutation
// (debounced). No-op when persistence is disabled (offline / no credentials).
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.on('finish', () => { if (res.statusCode < 400) scheduleSave(snapshot); });
  }
  next();
});

// Resolve the active user from a header (prototype "auth").
function currentUser(req) {
  const uid = req.headers['x-user-id'];
  return uid ? getUser(uid) : null;
}

// Role guard for privileged endpoints (admin / business / partner consoles).
// Returns true if the caller may proceed; otherwise sends a 403 JSON and returns
// false so the handler can `if (!requireRole(...)) return;`. allAccess accounts
// (the Full-Access demo profile) bypass the role check by design.
function requireRole(req, res, roles) {
  const u = currentUser(req);
  if (u && (u.allAccess || roles.includes(u.role))) return true;
  res.status(403).json({
    error: 'forbidden',
    message: u
      ? `This area requires a ${roles.join(' or ')} account. Your role is ${u.role}.`
      : `Sign in with a ${roles.join(' or ')} account to access this area.`,
  });
  return false;
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
  res.json({
    context: detectContext(req),
    currencies: listCurrencies(),
    searchTiers: SEARCH_TIERS,
    membershipTiers: MEMBERSHIP_TIERS,
    acu: { perGbp: ACU_PER_GBP, fundRate: MEMBERSHIP_ACU_FUND_RATE },
  });
}));

// ---- Destination Marketplace ----------------------------------------------
app.get('/api/destinations', safe((req, res) => {
  const ctx = detectContext(req, { country: req.query.country, currencyCountry: req.query.country });
  const cur = ctx.currency;
  const catalog = destinationsCatalog().map((d) => ({ ...d, fromLocal: Math.round(d.fromUSD * cur.rateFromUSD), currency: cur.code, symbol: cur.symbol }));
  res.json({ destinations: catalog, addOns: ['Tours', 'Local drivers', 'Photographers', 'Guides', 'Restaurant bookings', 'Event tickets', 'Airport pickup', 'Translators', 'eSIM data', 'Travel insurance'] });
}));

// ---- Contact form → emails info@3jntravel.com (reply-to sender) -----------
app.post('/api/contact', safe(async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!email || !message) return res.status(400).json({ error: 'email-and-message-required' });
  const r = await sendMail({
    to: MAIN_CONTACT,
    replyTo: email,
    subject: `Contact form — ${name || email}`,
    text: `From: ${name || ''} <${email}>\n\n${message}`,
    html: `<p><strong>From:</strong> ${name || ''} &lt;${email}&gt;</p><p>${String(message).replace(/</g, '&lt;')}</p>`,
  });
  res.json({ sent: r.ok, queued: !r.ok && r.skipped ? 'email-disabled' : undefined });
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

// One-click FULL-ACCESS account — a single account that can use every section of
// the OS (admin, business, merchant, consumer, VisaOS government).
app.post('/api/account/test', safe((req, res) => {
  const user = createUser({ name: 'Full-Access Traveller', role: 'admin', allAccess: true });
  addPoints(user.id, 1250 - user.points); // land in Voyager tier (~1,250 pts)
  res.json({ user: getUser(user.id), note: 'Full-access account provisioned — every section unlocked.' });
}));

app.post('/api/account/:id/acu', safe((req, res) => {
  const result = buyAcu(req.params.id, (req.body || {}).pack);
  res.json(result);
}));

// Lightweight "login" — look up an existing account by email (prototype: no
// password; a real build authenticates via Auth0/Firebase).
app.post('/api/login', safe((req, res) => {
  const email = ((req.body || {}).email || '').trim().toLowerCase();
  const user = findUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'not-found', message: 'No account with that email. Sign up instead.' });
  res.json({ user });
}));

// ---- Membership Programme: subscribe / renew / cancel --------------------
// Joining a plan auto-funds the period's ACUs (10% of the subscription at
// £1 = 100 ACU). Requires a signed-in account.
app.post('/api/membership/subscribe', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required', message: 'Sign in to join a membership plan.' });
  const result = subscribeMembership(user.id, (req.body || {}).tier);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}));
app.post('/api/membership/renew', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  const result = renewMembership(user.id);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}));
app.post('/api/membership/cancel', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  const result = cancelMembership(user.id);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}));

// Firebase Auth bridge — verified identity comes from Firebase on the client;
// here we get-or-create the matching backend account by email so loyalty,
// bookings, etc. attach to it. (A hardened build verifies the Firebase ID token
// server-side with firebase-admin; the public client config can't be forged for
// app data because all app state lives behind this account record.)
app.post('/api/auth/firebase', safe((req, res) => {
  const { email, name } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email-required' });
  const existing = findUserByEmail(email.trim().toLowerCase());
  const user = existing || createUser({ email: email.trim().toLowerCase(), name: name || undefined });
  res.json({ user, created: !existing });
}));

// ---- eSIM Manager ---------------------------------------------------------
app.get('/api/esims', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json({ esims: listEsims(user.id) });
}));
app.post('/api/esims', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json({ esim: provisionEsim(user.id, req.body || {}) });
}));
app.post('/api/esims/:id/activate', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json(activateEsim(user.id, req.params.id));
}));

// ---- Expense Intelligence -------------------------------------------------
app.get('/api/expense', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json({ report: expenseReport(user.id) });
}));

// ---- Plan: the core pipeline ---------------------------------------------
app.post('/api/plan', safe((req, res) => {
  const { text, searchTier, overrides, country, currencyCountry } = req.body || {};
  const context = detectContext(req, { country, currencyCountry });
  const user = currentUser(req);
  const result = plan({ text, context, user, searchTier, overrides });

  // ACU enforcement: paid search tiers are funded by ACUs. A signed-in account
  // must hold enough ACU before a paid tier runs — members fund this from the
  // 10% of their subscription, everyone else tops up. The free/cached tier is
  // always allowed. Guests keep the demo via the cost-protection gate.
  if (result.stage === 'options' && user) {
    const reqTier = SEARCH_TIERS[searchTier] || SEARCH_TIERS.smart;
    const cost = reqTier.acu || 0;
    if (cost > 0) {
      const spend = spendAcu(user.id, cost, `search:${reqTier.name}`);
      if (!spend.ok) {
        return res.json({
          stage: 'topup-required',
          reason: 'insufficient-acu',
          tierName: reqTier.name,
          acuNeeded: cost,
          balance: typeof spend.balance === 'number' ? spend.balance : user.acuBalance,
          isMember: !!user.membership?.active,
          message: `${reqTier.name} costs ${cost} ACU. Your balance is ${typeof spend.balance === 'number' ? spend.balance : user.acuBalance} ACU. Top up to continue, or run a free cached search.`,
        });
      }
      result.acuCharged = cost;
      result.acuBalance = spend.balance;
    }
  }

  // Behavioural learning: log the search so the Journey Dashboard + ML agents
  // learn from what this user actually looks for (guests included).
  const i = result.intent;
  recordBehaviour(user?.id, {
    event: result.stage === 'options' ? 'plan' : 'search',
    destination: i?.destination?.code || null,
    payload: {
      tier: searchTier,
      party: i?.travellers?.total,
      nights: i?.nights,
      month: i?.month,
      components: i?.components,
      query: typeof text === 'string' ? text.slice(0, 140) : undefined,
    },
  });
  res.json(result);
}));

// ---- Behavioural learning + personalised Journey Dashboard ----------------
// Lightweight client telemetry: destination views, dwell, chip taps, etc.
app.post('/api/track', safe((req, res) => {
  const { event, destination, payload } = req.body || {};
  if (!event) return res.status(400).json({ error: 'event-required' });
  const user = currentUser(req);
  recordBehaviour(user?.id, { event, destination, payload });
  res.json({ ok: true });
}));

// The personalised Journey Dashboard that powers the hero panel — driven by the
// user's learned behaviour, not a hard-coded example.
app.get('/api/journey', safe((req, res) => {
  const context = detectContext(req, { country: req.query.country, currencyCountry: req.query.country });
  const user = currentUser(req);
  res.json(journeyDashboard(user?.id, context));
}));

// The learned profile + ML agent tracks (insight / debugging view).
app.get('/api/learning/profile', safe((req, res) => {
  const user = currentUser(req);
  res.json({ profile: learnProfile(user?.id) });
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
  recordBehaviour(currentUser(req)?.id, {
    event: 'quote',
    destination: intent?.destination?.code || null,
    payload: { nights: intent?.nights, party: intent?.travellers?.total, month: intent?.month, components: intent?.components },
  });
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
  recordBehaviour(user?.id, {
    event: 'book',
    destination: quote.intent?.destination?.code || null,
    payload: { nights: quote.intent?.nights, party: quote.intent?.travellers?.total, month: quote.intent?.month, components: quote.intent?.components },
  });
  // Fire-and-forget confirmation email (no-op if email disabled or guest email).
  if (user?.email) {
    const { subject, html, text } = bookingEmail(quote.option, booking);
    sendMail({ to: user.email, subject, html, text }).catch(() => {});
  }
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

// ---- 3JN VisaOS — AI visa decision engine ---------------------------------
app.post('/api/visaos/assess', safe((req, res) => {
  const assessment = assessVisa(req.body || {});
  recordVisaApplication(assessment);
  res.json({ assessment });
}));
app.get('/api/visaos/probability', safe((req, res) => {
  res.json(approvalProbability(req.query.nationality, req.query.destination));
}));
app.get('/api/visaos/government', safe((req, res) => {
  res.json({ analytics: govAnalytics() });
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

// ---- White-label API revenue calculator (admin / partner only) -----------
app.get('/api/white-label/payout', safe((req, res) => {
  if (!requireRole(req, res, ['admin', 'partner'])) return;
  const volume = Number(req.query.volume) || 100000;
  res.json({ payout: whiteLabelPayout(volume), revenueStreams: REVENUE_STREAMS });
}));

// ---- Admin Super Control Centre (admin only) -----------------------------
// These expose platform-wide PII and financials, so every route is role-gated.
app.get('/api/admin/revenue', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ snapshot: revenueSnapshot(), revenueStreams: REVENUE_STREAMS });
}));

app.get('/api/admin/overview', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({
    overview: adminOverview(),
    revenueStreams: REVENUE_STREAMS,
    leaderboard: leaderboard(),
    gateway: gatewayStatus(),
    activity: adminActivity(20),
  });
}));

app.get('/api/admin/users', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ users: adminUsers() });
}));

app.get('/api/admin/bookings', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ bookings: adminBookings() });
}));

app.get('/api/admin/audit', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
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

// ---- Business / Enterprise approvals (business / admin only) --------------
app.get('/api/business/approvals', safe((req, res) => {
  if (!requireRole(req, res, ['business', 'admin'])) return;
  res.json({ approvals: listApprovals(), bookings: adminBookings() });
}));
app.post('/api/business/approvals/:id', safe((req, res) => {
  if (!requireRole(req, res, ['business', 'admin'])) return;
  res.json(decideApproval(req.params.id, (req.body || {}).decision));
}));

// ---- Supplier Contract Manager (business / admin only) --------------------
app.get('/api/business/contracts', safe((req, res) => {
  if (!requireRole(req, res, ['business', 'admin'])) return;
  res.json({ contracts: listContracts() });
}));
app.post('/api/business/contracts', safe((req, res) => {
  if (!requireRole(req, res, ['business', 'admin'])) return;
  const user = currentUser(req);
  res.json({ contract: createContract(user?.id, req.body || {}) });
}));

// ---- AI Gateway status (which provider handles which task) ----------------
app.get('/api/ai/status', safe((req, res) => {
  res.json({ gateway: gatewayStatus() });
}));

// ---- Enterprise AI agents: Security, Ops, SEO, Marketing ------------------
app.get('/api/agents/security', safe((req, res) => res.json({ report: securityReport() })));
app.get('/api/agents/ops', safe((req, res) => res.json({ report: opsDiagnostics({ persistence: isEnabled(), email: isMailerEnabled() }) })));
app.get('/api/agents/seo', safe((req, res) => res.json({ report: seoReport() })));
app.get('/api/agents/marketing', safe((req, res) => res.json({ report: marketingPlan() })));

// ---- Blog (AI-written, hyperlinked, shareable) ---------------------------
app.get('/api/blog', safe((req, res) => res.json({ posts: listPosts() })));
app.get('/api/blog/:slug', safe((req, res) => {
  const post = getPost(req.params.slug);
  if (!post) return res.status(404).json({ error: 'not-found' });
  res.json({ post });
}));
app.post('/api/blog/generate', safe((req, res) => res.json({ post: createPost(req.body || {}) })));

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

// ---- SEO: robots.txt + dynamic sitemap.xml --------------------------------
app.get('/robots.txt', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const staticUrls = ['/', '/how-it-works', '/membership', '/visaos', '/marketplace', '/blog', '/api-portal'];
  const blogUrls = listPosts().map((p) => `/blog/${p.slug}`);
  const urls = [...staticUrls, ...blogUrls]
    .map((u) => `  <url><loc>${base}${u}</loc><changefreq>weekly</changefreq></url>`)
    .join('\n');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
});

// Any unmatched /api/* route returns JSON (never HTML) so the frontend's JSON
// parsing never breaks on an error page.
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'not-found', path: req.path });
});

// ---- Static frontend ------------------------------------------------------
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');
const SHARED_DIR = path.join(__dirname, '..', '..', 'shared');
app.use(express.static(FRONTEND_DIR));
// Expose shared constants to the browser so frontend and backend never drift.
app.use('/shared', express.static(SHARED_DIR));

// SPA-ish fallback for the page routes.
app.get(['/how-it-works', '/api-portal', '/membership', '/console', '/admin', '/business', '/visaos', '/marketplace', '/blog', '/blog/:slug'], (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// Global error handler — any error reaching here (e.g. malformed JSON body,
// payload too large) returns JSON for /api so the frontend never sees HTML.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled]', req.path, err?.message || err);
  if (req.path.startsWith('/api') || req.path.startsWith('/shared')) {
    return res.status(err.status || 500).json({ error: 'internal', message: String(err?.message || err) });
  }
  res.status(500).send('Internal Server Error');
});

// Initialise Firebase RTDB persistence (credential-gated; no-op offline). Load
// any saved state into the in-memory store, then keep it flushed.
if (process.env.NODE_ENV !== 'test') {
  initMailer();
  const p = initPersistence({});
  if (p.enabled) {
    load().then((snap) => {
      if (snap && hydrate(snap)) console.log('[persist] restored store from Firebase RTDB');
    });
    // Belt-and-braces periodic flush (covers long-lived Cloud Run instances).
    const flushEvery = setInterval(() => save(snapshot()), 15000);
    if (flushEvery.unref) flushEvery.unref();
    const flush = () => { save(snapshot()).finally(() => process.exit(0)); };
    process.on('SIGTERM', flush);
    process.on('SIGINT', flush);
  }
}

// Start a listener for local dev and Cloud Run / containers. Skip when running
// under Firebase Functions (FUNCTION_TARGET set) — there the function wrapper
// owns the lifecycle — during tests, and whenever this module is imported rather
// than run directly (e.g. the Vercel handler or a test importing `app`).
const PORT = process.env.PORT || 3000;
const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry && process.env.NODE_ENV !== 'test' && !process.env.FUNCTION_TARGET && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n  3JN Travel OS running → http://localhost:${PORT}\n`);
  });
}

export { app };
export default app;
