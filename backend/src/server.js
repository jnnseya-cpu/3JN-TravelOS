// 3JN Travel OS — Express server.
// Serves the premium frontend and the full JSON API that drives the pipeline.

import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { detectContext, listCurrencies } from './geo.js';
import { destinationsCatalog, findDestination } from './destinations.js';
import { plan } from './planner.js';
import { instalmentPlan, protectionFee } from './pricing.js';
import {
  createUser, getUser, buyAcu, saveQuote, getQuote, createBooking,
  getBooking, listBookings, recordPayment, revenueSnapshot, addPoints,
  adminOverview, adminUsers, adminBookings, adminActivity,
  updateUser, seedAllRoles, ROLES,
  createApiKey, listApiKeys, revokeApiKey, useApiKey,
  adminAudit, saveDraft, getDraft,
  createPaymentLink, listPaymentLinks, settlePaymentLink, merchantSettlement,
  listApprovals, decideApproval,
  listNotifications, markNotificationsRead, pushNotification,
  notifyHostsOfBooking, backfillProfileFromLead, syncHostReliabilityFromReviews, bumpOSLink, osIntegrationMap,
  recordVisaApplication, govAnalytics,
  recordVisaFile, listVisaApplications, listVisaApplicationsForUser, getVisaApplication, decideVisaApplication,
  findUserByEmail, provisionEsim, listEsims, activateEsim, expenseReport,
  createContract, listContracts, recordBehaviour,
  subscribeMembership, renewMembership, cancelMembership, spendAcu, creditAcu,
  createHostListing, listHostListings, hostEarnings,
  registerHost, updateHostListing, hostBookings, hostDashboard,
  grantComplimentaryElite, compEliteCount, COMP_ELITE_LIMIT, usageStats,
} from './store.js';
import { MEMBERSHIP_TIERS, ACU_PER_GBP, MEMBERSHIP_ACU_FUND_RATE } from '../../shared/constants.js';
import { track as trackBehaviour, learnProfile, journeyDashboard } from './learning.js';
import { visaCheck, riskFeed } from './intelligence.js';
import { assessVisa, approvalProbability } from './visaos.js';
import { visaFramework, buildChecklist, assessApplication, validateApplicant } from './visa-framework.js';
import { bookingSchema, bookingRequirements, validateBooking, bookingRiskScore } from './booking-schema.js';
import { liveShowcase } from './showcase.js';
import { architecture as commsArchitecture, renderEmail as commsRenderEmail, emit as commsEmit, EVENTS as COMMS_EVENTS } from './comms.js';
import { geocode, weather, fxRate, advisory, liveDataEnabled } from './live-data.js';
import { fetchLiveOffers, liveSuppliersConfigured, liveFlightsEnabled, liveHotelsEnabled, oagScheduleEnabled } from './live-suppliers.js';
import { scanMarketplaceAddons } from './suppliers.js';
import { runPriceGuard, runDisruptionGuard } from './monitor.js';
import { submitReview, leaderboard } from './reviews.js';
import { whiteLabelPayout, REVENUE_STREAMS, SEARCH_TIERS } from './revenue.js';
import { gatewayStatus } from './ai-gateway.js';
import { securityReport, opsDiagnostics, seoReport, marketingPlan, createPost, listPosts, getPost, ensureDailyPublish, startPublishingLoop } from './agents.js';
import { snapshot, hydrate } from './store.js';
import { initPersistence, isEnabled, load, save, scheduleSave } from './persistence.js';
import { initMailer, isMailerEnabled, sendMail, bookingEmail, MAIN_CONTACT } from './mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Payload limit: host property photos travel as compressed data URLs in JSON
// (10–100 images ≈ 100–150KB each after client-side compression), so the body
// cap is generous. Individual photos are size-capped again server-side.
app.use(express.json({ limit: '30mb' }));

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
app.get('/api/health', (req, res) => res.json({
  ok: true, service: '3jn-travel-os', persistence: isEnabled(), email: isMailerEnabled(),
  liveData: liveDataEnabled(), liveFlights: liveFlightsEnabled(), liveHotels: liveHotelsEnabled(),
  liveSchedules: oagScheduleEnabled(),
}));

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

// ---- Communication Event Architecture (admin only) ------------------------
// One event engine: 177 events × 15 categories fan out over email/in-app/sms/
// push/whatsapp; mandatory notices bypass opt-outs.
app.get('/api/comms/architecture', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ architecture: commsArchitecture() });
}));
app.post('/api/comms/preview', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const { event, company, vars } = req.body || {};
  if (!COMMS_EVENTS[event]) return res.status(400).json({ error: 'unknown-event' });
  res.json(commsRenderEmail(event, { company, vars: vars || {} }));
}));
app.post('/api/comms/test', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const user = currentUser(req);
  const { event, vars } = req.body || {};
  const result = commsEmit(event, { userId: user?.id, recipient: user?.email, vars: vars || { enterprise: 'Groupe Nseya', item: 'Sample', name: user?.name, actor: '3JN AI', amount: '£420', number: 'INV-1042', plan: 'Travel+ Family', project: 'Dubai 2026', task: 'Confirm visa', date: '12 Aug' } });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}));

// ---- Live showcase: real engine-computed numbers for the landing page ------
app.get('/api/showcase', safe((req, res) => {
  const context = detectContext(req, { country: req.query.country, currencyCountry: req.query.country });
  res.json({ showcase: liveShowcase(context), liveData: liveDataEnabled() });
}));

// Overlay live weather + travel advisory onto a deterministic risk feed.
async function enrichRiskLive(feed, destinationText) {
  if (!feed?.ok) return feed;
  try {
    const geo = await geocode(feed.destination.city || destinationText);
    if (geo) {
      const [wx, adv] = await Promise.all([weather(geo.lat, geo.lon), advisory(geo.countryCode)]);
      if (wx) {
        const wl = feed.layers.find((l) => l.layer === 'Weather');
        if (wl) wl.note = `${wx.tempC}°C, ${wx.condition.toLowerCase()}`;
        feed.weatherSource = 'live';
      }
      if (adv) {
        feed.riskScore = Math.round((5 - adv.score) / 5 * 100); // higher = safer
        feed.level = adv.level === 'Low' ? 'Low' : adv.level === 'Moderate' ? 'Moderate' : 'Elevated';
        feed.advisory = adv.message;
        feed.riskSource = 'live';
        feed.estimated = false;
      }
      if (geo.country) feed.destination.country = geo.country;
    }
  } catch { /* keep deterministic feed */ }
  if (!feed.riskSource) feed.riskSource = 'estimated';
  return feed;
}

// Overlay live weather + FX onto the personalised Journey Dashboard.
async function enrichJourneyLive(dash, fromCode) {
  try {
    const city = dash?.destination?.city;
    const geo = city ? await geocode(city) : null;
    if (geo) {
      const wx = await weather(geo.lat, geo.lon);
      if (wx) {
        const row = dash.rows.find((r) => /Weather/.test(r.label));
        if (row) { row.value = `${wx.tempC}°C, ${wx.condition.toLowerCase()}`; row.live = true; }
      }
      const curRow = dash.rows.find((r) => /Currency/.test(r.label));
      const m = curRow && curRow.label.match(/([A-Z]{3})→([A-Z]{3})/);
      if (m) {
        const rate = await fxRate(m[1], m[2]);
        if (rate) { curRow.value = `${rate.toFixed(2)} live`; curRow.live = true; }
      }
    }
  } catch { /* keep deterministic dashboard */ }
  return dash;
}

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
  creditAcu(user.id, 10000, 'full-access-demo'); // funded so every paid feature works
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
app.post('/api/plan', safe(async (req, res) => {
  const { text, searchTier, overrides, country, currencyCountry, preferences } = req.body || {};
  const context = detectContext(req, { country, currencyCountry });
  const user = currentUser(req);
  let result = plan({ text, context, user, searchTier, overrides, preferences: preferences || {} });

  // Live provider pricing overlay: when flight/hotel provider keys are present
  // and reachable, fetch real offers and rebuild the packages from them. Any
  // failure (no keys, outbound disabled, provider down) silently keeps the
  // deterministic estimate — we never present an unconverted or invented price.
  if (result.stage === 'options' && liveSuppliersConfigured()) {
    try {
      const live = await fetchLiveOffers(result.intent, result.intent.destination, result.origin);
      if ((live.flights && live.flights.length) || (live.hotels && live.hotels.length)) {
        result = plan({ text, context, user, searchTier, overrides, preferences: preferences || {}, live, usage: usageStats(user?.id) });
      }
    } catch { /* keep the estimated result */ }
  }

  // ACU enforcement: paid search tiers are funded by ACUs. A signed-in account
  // must hold enough ACU before a paid tier runs — members fund this from the
  // 10% of their subscription, everyone else tops up. The free/cached tier is
  // always allowed. Guests keep the demo via the cost-protection gate.
  if (result.stage === 'options' && result.cached) {
    // Served from the cache — no ACU is ever charged for a cached answer.
    result.acuCharged = 0;
  } else if (result.stage === 'options' && user && !user.allAccess) {
    const reqTier = SEARCH_TIERS[searchTier] || SEARCH_TIERS.smart;
    const cost = reqTier.acu || 0;
    // ACU PRE-APPROVAL: the user must approve the charge BEFORE the paid work
    // counts. No approval = no AI cost — we return the quote, not the results.
    if (cost > 0 && req.body?.approveAcu !== true) {
      return res.json({
        stage: 'acu-approval-required',
        tierName: reqTier.name,
        acuNeeded: cost,
        balance: user.acuBalance,
        why: `This ${reqTier.name} requires ${cost} ACU because we will compare live prices across suppliers, routes and dates${searchTier !== 'smart' ? ', run risk/visa agents and deep price levers' : ''}.`,
        approveWith: { approveAcu: true },
      });
    }
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
app.get('/api/journey', safe(async (req, res) => {
  const context = detectContext(req, { country: req.query.country, currencyCountry: req.query.country });
  const user = currentUser(req);
  const dash = journeyDashboard(user?.id, context);
  await enrichJourneyLive(dash, context.currency.code);
  res.json(dash);
}));

// The learned profile + ML agent tracks (insight / debugging view).
app.get('/api/learning/profile', safe((req, res) => {
  const user = currentUser(req);
  res.json({ profile: learnProfile(user?.id) });
}));

// ---- Booking data architecture: requirements + validation -----------------
// After the AI finds options and the traveller proceeds, the OS collects and
// validates the data needed to actually book (traveller profile, per-passenger
// PNR data, documents, entry rules, payment).
app.get('/api/booking/schema', safe((req, res) => {
  res.json(bookingSchema());
}));
app.post('/api/booking/requirements', safe((req, res) => {
  const { components, destination, nationality, passengers, holidayType, international } = req.body || {};
  res.json(bookingRequirements({ components, destination, nationality, passengers, holidayType, international: international !== false }));
}));
app.post('/api/booking/validate', safe((req, res) => {
  const { travellers, travelDate, nationality, destination, fraudSignals, international } = req.body || {};
  const validation = validateBooking({ travellers, travelDate, nationality, destination, international: international !== false });
  res.json({ ...validation, risk: bookingRiskScore(fraudSignals || {}) });
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
  const { quoteId, months, depositPct, paymentMethod, lead, specialRequests, hotelRequests, payment, protection } = req.body || {};
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

  const booking = createBooking({ quoteId, option: quote.option, instalment, userId: user?.id, paymentMethod, lead, specialRequests, hotelRequests, payment, protection: protection ? protectionFee(quote.option.pricing.local.total) : null });
  recordBehaviour(user?.id, {
    event: 'book',
    destination: quote.intent?.destination?.code || null,
    payload: { nights: quote.intent?.nights, party: quote.intent?.travellers?.total, month: quote.intent?.month, components: quote.intent?.components },
  });
  // ---- OS synapses: every part of the OS talks on every booking ----------
  // Booking → Host Marketplace: property owners hear about their reservations.
  if (notifyHostsOfBooking(booking) > 0) bumpOSLink('booking→host');
  // Booking → Master Travel Profile: checkout details flow back to the profile.
  if (backfillProfileFromLead(user?.id, lead) > 0) bumpOSLink('booking→profile');
  // Booking → VisaOS: a visa-required trip nudges a prefilled application.
  if (user && quote.intent?.destination?.city) {
    const v = visaCheck(lead?.nationality || 'GB', quote.intent.destination.city);
    if (v.ok && v.required) {
      pushNotification(user.id, {
        type: 'info', icon: '🛂', title: `Visa needed for ${v.destination.city}`,
        body: `${v.visaType} · ~${v.processingDays} days · $${v.costUSD}. Start in VisaOS — your Master Travel Profile prefills the application.`,
      });
      bumpOSLink('booking→visaos');
    }
  }

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
app.get('/api/risk/:destination', safe(async (req, res) => {
  const feed = riskFeed(req.params.destination);
  await enrichRiskLive(feed, req.params.destination);
  res.json(feed);
}));

// ---- 3JN VisaOS — AI visa decision engine ---------------------------------
app.post('/api/visaos/assess', safe((req, res) => {
  const assessment = assessVisa(req.body || {});
  recordVisaApplication(assessment);
  res.json({ assessment });
}));

// ---- Global Visa Intelligence Framework -----------------------------------
// Applicant schema, document checklists, country modules and the full
// decision-ready assessment (checklist → verification → fraud → risk → decision).
app.get('/api/visa/framework', safe((req, res) => {
  res.json(visaFramework());
}));
app.post('/api/visa/checklist', safe((req, res) => {
  const { country, visaType, applicant } = req.body || {};
  res.json(buildChecklist({ country, visaType, applicant: applicant || {} }));
}));
// Validate the applicant record against a destination's requirements — the
// UK 10-year-history / US social-handle / declaration-detail rules — before
// documents are even uploaded. Returns missing fields + completeness %.
app.post('/api/visa/validate-applicant', safe((req, res) => {
  const { applicant, country } = req.body || {};
  res.json({ report: validateApplicant(applicant || {}, country || null) });
}));
app.post('/api/visa/assess-application', safe((req, res) => {
  const { applicant, country, visaType, providedDocuments } = req.body || {};
  const file = assessApplication({ applicant: applicant || {}, country, visaType, providedDocuments });
  const user = currentUser(req);
  // Persist the FULL application (information + documents + decision file) so the
  // applicant and the embassy can both review exactly what was provided.
  const record = recordVisaFile({ applicant, country, visaType, documents: providedDocuments || [], file, userId: user?.id });
  res.json({ file, applicationId: record.id });
}));

// Applicant: my submitted applications (full info + documents I provided).
app.get('/api/visaos/my-applications', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json({ applications: listVisaApplicationsForUser(user.id) });
}));

// ---- Embassy / Government workspace (embassy or admin only) ----------------
app.get('/api/visaos/applications', safe((req, res) => {
  if (!requireRole(req, res, ['embassy', 'consulate', 'admin'])) return;
  res.json({ applications: listVisaApplications() });
}));
app.get('/api/visaos/applications/:id', safe((req, res) => {
  if (!requireRole(req, res, ['embassy', 'consulate', 'admin'])) return;
  const app = getVisaApplication(req.params.id);
  if (!app) return res.status(404).json({ error: 'not-found' });
  res.json({ application: app });
}));
app.post('/api/visaos/applications/:id/decide', safe((req, res) => {
  if (!requireRole(req, res, ['embassy', 'consulate', 'admin'])) return;
  const { decision, reason } = req.body || {};
  const result = decideVisaApplication(req.params.id, { decision, reason, officerId: currentUser(req)?.id });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}));

app.get('/api/visaos/probability', safe((req, res) => {
  res.json(approvalProbability(req.query.nationality, req.query.destination));
}));
app.get('/api/visaos/government', safe((req, res) => {
  res.json({ analytics: govAnalytics() });
}));

// ---- 3JN Host Marketplace ---------------------------------------------------
// End-to-end accommodation system: register first, then run your dashboard —
// publish properties, set prices, pause/resume, manage bookings and earnings.
// Verified listings appear in searches alongside hotels with 3JN reliability,
// the price guard and instalments wrapped around every stay. Hosts keep 90%.
app.post('/api/host/register', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required', message: 'Sign in to register as a host.' });
  res.json(registerHost(user.id, req.body || {}));
}));
app.get('/api/host/dashboard', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required', message: 'Sign in to open your Host Dashboard.' });
  res.json(hostDashboard(user.id));
}));
app.patch('/api/host/listings/:id', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required', message: 'Sign in to manage your listings.' });
  const result = updateHostListing(user.id, req.params.id, req.body || {});
  if (!result.ok) return res.status(result.error === 'forbidden' ? 403 : 400).json(result);
  res.json(result);
}));
app.get('/api/host/bookings', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required', message: 'Sign in to see your reservations.' });
  res.json({ bookings: hostBookings(user.id) });
}));
app.post('/api/host/listings', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required', message: 'Sign in to become a host.' });
  const result = createHostListing(user.id, req.body || {});
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}));
app.get('/api/host/listings', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required', message: 'Sign in to see your listings.' });
  res.json({ listings: listHostListings(user.id) });
}));
app.get('/api/host/earnings', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required', message: 'Sign in to see your hosting earnings.' });
  res.json(hostEarnings(user.id));
}));

// ---- Disruption Agent: monitors booked flights, rebooks automatically ------
app.post('/api/book/:id/disruption', safe((req, res) => {
  const force = req.body && 'force' in req.body ? !!req.body.force : null;
  res.json(runDisruptionGuard(req.params.id, force));
}));

// ---- Destination Marketplace add-ons: every trip is a basket ----------------
app.get('/api/marketplace/addons', safe((req, res) => {
  const destText = req.query.destination || 'Dubai';
  const dest = findDestination(destText) || { city: destText, code: destText };
  res.json({ addons: scanMarketplaceAddons(dest) });
}));

// ---- Admin: complimentary Elite x2 grants (max 5) ---------------------------
app.post('/api/admin/comp-elite', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const result = grantComplimentaryElite(currentUser(req).id, req.body?.email);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}));
app.get('/api/admin/comp-elite', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ slotsUsed: compEliteCount(), slotsLeft: COMP_ELITE_LIMIT - compEliteCount(), limit: COMP_ELITE_LIMIT });
}));

// ---- OS Integration Map — proof that every part talks to every other part --
app.get('/api/os/integration-map', safe((req, res) => {
  res.json(osIntegrationMap());
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
  // Reviews → Host Marketplace: guest voice moves listing reliability live.
  if (req.body?.supplier && syncHostReliabilityFromReviews(req.body.supplier) != null) bumpOSLink('review→host');
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
app.get('/api/blog', safe((req, res) => {
  ensureDailyPublish(); // autonomous daily publishing — lazy check on every read
  res.json({ posts: listPosts() });
}));
app.get('/api/blog/:slug', safe((req, res) => {
  const post = getPost(req.params.slug);
  if (!post) return res.status(404).json({ error: 'not-found' });
  res.json({ post });
}));
app.post('/api/blog/generate', safe((req, res) => res.json({ post: createPost(req.body || {}) })));

// ---- Public "white-label" partner endpoint (returns a package) -----------
// Demonstrates the API other businesses would integrate.
// Productised partner APIs (API_PRODUCTS catalogue prices each per call).
function partnerAuth(req) {
  const partnerKey = req.headers['x-partner-key'];
  const keyInfo = partnerKey ? useApiKey(partnerKey) : null;
  return { partner: keyInfo ? keyInfo.userId : (partnerKey ? 'invalid-or-revoked-key' : 'demo-partner'), authenticated: Boolean(keyInfo) };
}
app.post('/api/v1/itinerary', safe((req, res) => {
  const auth = partnerAuth(req);
  const r = plan({ text: req.body?.text || '', context: detectContext(req, {}), user: null, searchTier: 'smart' });
  res.json({ ...auth, product: 'itinerary-ai', itinerary: r.itinerary || null, stage: r.stage });
}));
app.post('/api/v1/visa-checklist', safe((req, res) => {
  const auth = partnerAuth(req);
  const { country, visaType, applicant } = req.body || {};
  res.json({ ...auth, product: 'visa-checklist', checklist: buildChecklist({ country, visaType, applicant: applicant || {} }) });
}));
app.post('/api/v1/group-quote', safe((req, res) => {
  const auth = partnerAuth(req);
  const r = plan({ text: req.body?.text || '', context: detectContext(req, {}), user: null, searchTier: 'smart' });
  res.json({ ...auth, product: 'group-quote', stage: r.stage, groupOrigins: r.intent?.groupOrigins || null, packages: r.stage === 'options' ? r.packages : null });
}));
app.post('/api/v1/savings', safe((req, res) => {
  const auth = partnerAuth(req);
  const r = plan({ text: req.body?.text || '', context: detectContext(req, {}), user: null, searchTier: 'deep' });
  res.json({ ...auth, product: 'travel-savings', stage: r.stage, priceDive: r.priceDive || null, farePrediction: r.farePrediction || null });
}));
app.post('/api/v1/hotels', safe((req, res) => {
  const auth = partnerAuth(req);
  const r = plan({ text: (req.body?.text || '') + ' hotel only', context: detectContext(req, {}), user: null, searchTier: 'smart' });
  const stays = r.stage === 'options' ? r.packages.options.map((o) => o.components.find((c) => c.type === 'hotel' || c.type === 'host')).filter(Boolean) : [];
  res.json({ ...auth, product: 'hotel-comparison', stage: r.stage, hotels: stays });
}));

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
  // Blog/SEO/Marketing agents publish autonomously every day.
  startPublishingLoop();
}

export { app };
export default app;
