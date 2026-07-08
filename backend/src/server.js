// 3JN Travel OS — Express server.
// Serves the premium frontend and the full JSON API that drives the pipeline.

import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { detectContext, listCurrencies } from './geo.js';
import { destinationsCatalog, findDestination, resolveOrigin } from './destinations.js';
import { plan } from './planner.js';
import { instalmentPlan, protectionFee, DUFFEL_FEES } from './pricing.js';
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
  registerHost, updateHostListing, hostBookings, hostDashboard, updateHostPayout,
  grantComplimentaryElite, compEliteCount, COMP_ELITE_LIMIT, usageStats,
  acuWallet, acuTransactions, aiCostReport, recordAiRequestCost,
  placeSearchDeposit, refundSearchDeposit, listSearchDeposits, convertDepositToBooking, forfeitSearchDeposit, SEARCH_DEPOSIT_GBP,
  profitabilityDashboard, claimSavingsGuarantee, verifyVisaChain, visaChainBlocks,
  createTravelPot, contributeToPot, reviewHostListing, adminUserHostOverview,
  createQuoteRequest, confirmQuoteRequest, markQuoteRequestPaid, listQuoteRequests, getQuoteRequest,
  searchToBookStats,
  earnAcu, getPartnerProfile, applyInfluencer, decideInfluencer, partnerDashboard,
  rewardsLeaderboard, requestWithdrawal,
  createSupportTicket, listSupportTickets, supportTicketsForUser, resolveSupportTicket, latestBookingForUser,
  applyVendor, getVendorProfile, decideVendor, vendorDashboard, vendorLeaderboard,
  listVendors, runWeeklyVendorPayouts, awardTopSellerBonus, flagVendorSale, maybeRunFridayPayouts,
  getEmbassyConfig, saveEmbassyConfig, redactVisaForApplicant, releaseVisaDecision,
} from './store.js';
import { embassyProposal, visaDecisionLetter } from './embassy.js';
import { VENDOR_TIERS, PLATFORM_FEE_RATE, commissionSplit } from './vendors.js';
import { REWARD_ACTIONS, REDEEM_CATEGORIES, PARTNER_TIERS, AI_GROWTH_TOOLS, REVSHARE_CAP_GBP, REFERRER_REVSHARE_UNLOCK, REFERRAL_ACU } from './rewards.js';
import { supportRespond } from './chatbot.js';
import { assist } from './assistant.js';
import { bookingDocument } from './documents.js';
import { MEMBERSHIP_TIERS, ACU_PER_GBP, MEMBERSHIP_ACU_FUND_RATE } from '../../shared/constants.js';
import { track as trackBehaviour, learnProfile, journeyDashboard } from './learning.js';
import { visaCheck, riskFeed } from './intelligence.js';
import { assessVisa, approvalProbability, VISAOS_MANIFEST, AGENT_CHECKS, ZERO_TRUST, ANTI_CORRUPTION, DIGITAL_JOURNEY, VISAOS_REVENUE_MODEL, TRAVEL_OS_INTEGRATION } from './visaos.js';
import { visaFramework, buildChecklist, assessApplication, validateApplicant } from './visa-framework.js';
import { bookingSchema, bookingRequirements, validateBooking, bookingRiskScore } from './booking-schema.js';
import { liveShowcase } from './showcase.js';
import { architecture as commsArchitecture, renderEmail as commsRenderEmail, emit as commsEmit, EVENTS as COMMS_EVENTS } from './comms.js';
import { geocode, weather, fxRate, advisory, liveDataEnabled } from './live-data.js';
import { fetchLiveOffers, fetchLiveFlights, fetchLiveHotels, liveSuppliersConfigured, liveFlightsEnabled, liveHotelsEnabled, oagScheduleEnabled, validateDuffelOffer, duffelMode, duffelDiagnostic, createDuffelOrder, createDuffelHoldOrder, payDuffelOrder, duffelOrderPassengers } from './live-suppliers.js';
import { scanMarketplaceAddons } from './suppliers.js';
import { runPriceGuard, runDisruptionGuard } from './monitor.js';
import { submitReview, leaderboard } from './reviews.js';
import { whiteLabelPayout, REVENUE_STREAMS, SEARCH_TIERS, SAVINGS_GUARANTEE } from './revenue.js';
import { gatewayStatus, PROVIDER_TOKEN_RATES, aiMarginReport, MIN_AI_MARGIN } from './ai-gateway.js';
import { securityReport, opsDiagnostics, seoReport, marketingPlan, createPost, listPosts, getPost, ensureDailyPublish, startPublishingLoop } from './agents.js';
import { snapshot, hydrate } from './store.js';
import { initPersistence, isEnabled, load, save, scheduleSave } from './persistence.js';
import { initMailer, isMailerEnabled, sendMail, bookingEmail, MAIN_CONTACT } from './mailer.js';
import { issueHumanChallenge, verifyHumanCheck, verifyLightHuman, rateLimitAuth } from './human-verify.js';
import { stripeEnabled, createCheckoutSession, verifyStripeSignature } from './stripe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Payload limit: host property photos travel as compressed data URLs in JSON
// (10–100 images ≈ 100–150KB each after client-side compression), so the body
// cap is generous. Individual photos are size-capped again server-side.
app.use(express.json({
  limit: '30mb',
  // Keep the exact request bytes for webhook signature verification (Stripe
  // signs the raw payload — re-serialised JSON would never match).
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

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
// Also the serverless-safe scheduler tick: on Fridays the first request of the
// week triggers the automatic vendor payout run (+ monthly top-seller award).
app.use((req, res, next) => {
  try { maybeRunFridayPayouts(); } catch { /* payouts must never break a request */ }
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
// ---- Staff access PIN -------------------------------------------------------
// Set STAFF_ACCESS_PIN in the environment to lock every privileged role behind
// a second factor: privileged email login, demo sign-in AND every privileged
// API call must then carry the PIN (x-staff-pin header or body.staffPin).
// With the PIN unset the prototype behaviour is unchanged — set it in
// production BEFORE going live.
const PRIVILEGED_ROLES = new Set(['admin', 'business', 'merchant', 'partner', 'embassy', 'consulate']);
const staffPin = () => process.env.STAFF_ACCESS_PIN || '';
// Go-live switch: LIVE_MODE=true removes every demo/free-AI affordance —
// guests get cached results only, all AI actions are ACU-funded, and demo
// account surfaces fail closed unless the staff PIN is configured AND supplied.
const LIVE_MODE = () => process.env.LIVE_MODE === 'true';
function staffPinOk(req) {
  const pin = staffPin();
  if (!pin) return true; // gate not configured
  return req.headers['x-staff-pin'] === pin || (req.body && req.body.staffPin === pin);
}

function requireRole(req, res, roles) {
  const u = currentUser(req);
  if (u && (u.allAccess || roles.includes(u.role))) {
    // Privileged areas require the staff PIN when one is configured — even a
    // correct role/user id is not enough (ids are not secrets).
    if (roles.some((r) => PRIVILEGED_ROLES.has(r)) && !staffPinOk(req)) {
      res.status(403).json({ error: 'staff-pin-required', message: 'This area requires the staff access PIN.' });
      return false;
    }
    return true;
  }
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

// ---- Auto-ticketing: create the Duffel order after payment (issue the ticket)
// Is the booking fully paid (total covered by payments)? Instalment bookings
// are NOT fully paid until the final instalment lands.
function bookingFullyPaid(booking) {
  const total = booking.option?.pricing?.local?.total || 0;
  const paid = (booking.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  return total > 0 && paid + 0.01 >= total;
}
// The booking → ticket lifecycle (the model: WE book, WE issue the ticket).
//   • Pay in full  → issue the ticket now (Duffel order, instant).
//   • Instalments  → HOLD the fare now (Duffel hold order); issue the ticket
//     automatically when the final instalment is paid.
async function autoTicketFlight(booking) {
  const flight = (booking.option?.components || []).find((c) => c.type === 'flight' && c.live && c.details?.offerId);
  if (!flight || !liveFlightsEnabled()) return;
  const ful = () => (booking.fulfilment = booking.fulfilment || {});
  const passengers = duffelOrderPassengers(flight.details.offerPassengers || [], booking.lead || {});
  const fullyPaid = bookingFullyPaid(booking);

  // --- INSTALMENT: hold the fare (once), issue later on completion ----------
  if (!fullyPaid) {
    if (booking.fulfilment?.holdOrderId || booking.fulfilment?.ticketing === 'issued') return;
    const check = await validateDuffelOffer(flight.details.offerId);
    if (check.ok && (check.expired || check.live === false)) {
      ful().ticketing = 'failed'; booking.fulfilment.reason = 'offer-expired'; booking.fulfilment.needsRefund = true;
      if (booking.userId) pushNotification(booking.userId, { type: 'warning', icon: '⚠️', title: 'Fare expired', body: 'The fare expired before we could hold it — we are refunding your deposit. Please re-search.' });
      return;
    }
    const hold = await createDuffelHoldOrder({ offerId: flight.details.offerId, passengers });
    if (!hold.ok) { ful().ticketing = 'hold-failed'; booking.fulfilment.reason = hold.error; return; }
    ful();
    booking.fulfilment.ticketing = 'held';
    booking.fulfilment.holdOrderId = hold.order.id;
    booking.fulfilment.pnr = hold.order.bookingReference;
    booking.fulfilment.paymentRequiredBy = hold.order.paymentRequiredBy;
    booking.fulfilment.heldAt = new Date().toISOString();
    recordAudit({ actor: 'system', role: 'system', action: 'ticketing.held', entity: 'booking', entityId: booking.id, summary: `held ${hold.order.bookingReference} · pay by ${hold.order.paymentRequiredBy || 'n/a'}` });
    if (booking.userId) pushNotification(booking.userId, { type: 'success', icon: '🎟️', title: 'Seats held — pay monthly', body: `Your fare is reserved (ref ${hold.order.bookingReference}). Your e-ticket is issued automatically once your instalments are paid.` });
    return;
  }

  // --- FULLY PAID: issue the ticket ----------------------------------------
  let order;
  if (booking.fulfilment?.holdOrderId) {
    // Pay off the held order → issues the ticket.
    const pay = await payDuffelOrder({ orderId: booking.fulfilment.holdOrderId, amount: flight.details.liveAmount, currency: flight.details.liveCurrency || 'GBP' });
    order = pay.ok ? { ok: true, order: { id: booking.fulfilment.holdOrderId, bookingReference: pay.order.bookingReference || booking.fulfilment.pnr, ticketNumbers: pay.order.ticketNumbers } } : pay;
  } else {
    const check = await validateDuffelOffer(flight.details.offerId);
    if (check.ok && (check.expired || check.live === false)) {
      ful().ticketing = 'failed'; booking.fulfilment.reason = 'offer-expired-before-ticketing'; booking.fulfilment.needsRefund = true;
      if (booking.userId) pushNotification(booking.userId, { type: 'warning', icon: '⚠️', title: 'Refund being processed', body: 'The fare expired at the final step — refunding in full. Please re-search.' });
      return;
    }
    order = await createDuffelOrder({ offerId: flight.details.offerId, passengers, paymentAmount: check.amount || flight.details.liveAmount, paymentCurrency: check.currency || flight.details.liveCurrency || 'GBP' });
  }
  if (!order.ok) {
    ful().ticketing = 'failed'; booking.fulfilment.reason = order.error; booking.fulfilment.needsRefund = true;
    if (booking.userId) pushNotification(booking.userId, { type: 'warning', icon: '⚠️', title: 'Refund being processed', body: `We could not issue your ticket (${order.error}). Your payment is being refunded in full.` });
    recordAudit({ actor: 'system', role: 'system', action: 'ticketing.failed', entity: 'booking', entityId: booking.id, summary: order.error });
    return;
  }
  ful();
  booking.fulfilment.ticketing = 'issued';
  booking.fulfilment.duffelOrderId = order.order.id;
  booking.fulfilment.pnr = order.order.bookingReference;
  booking.fulfilment.ticketNumbers = order.order.ticketNumbers;
  booking.fulfilment.issuedAt = new Date().toISOString();
  recordAudit({ actor: 'system', role: 'system', action: 'ticketing.issued', entity: 'booking', entityId: booking.id, summary: `PNR ${order.order.bookingReference} · ${(order.order.ticketNumbers || []).length} e-ticket(s)` });
  if (booking.userId) pushNotification(booking.userId, { type: 'success', icon: '🎫', title: 'Ticket issued', body: `Your flight is ticketed — airline reference ${order.order.bookingReference}. E-tickets are in your Console and on their way by email.` });
  if (booking.lead?.email) {
    try { await sendMail({ to: booking.lead.email, subject: `Your ticket is confirmed — ${order.order.bookingReference}`, text: `Your flight is ticketed. Airline booking reference: ${order.order.bookingReference}. E-ticket(s): ${(order.order.ticketNumbers || []).join(', ')}.`, html: `<p>Your flight is ticketed.</p><p><strong>Airline booking reference:</strong> ${order.order.bookingReference}</p>` }); } catch {}
  }
}

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
// Human gate: signup and login are HUMAN-ONLY. Explicit signups (an email is
// provided) must pass the full check (honeypot + timing + interaction +
// signed challenge); guest auto-provisioning passes the light check. Bots and
// scripts are refused with a structured reason.
app.get('/api/auth/challenge', safe((req, res) => {
  res.json(issueHumanChallenge());
}));
app.post('/api/account', safe((req, res) => {
  const body = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
  const rl = rateLimitAuth(ip);
  if (!rl.ok) return res.status(429).json(rl);
  const check = body.humanCheck || {};
  const verdict = body.email ? verifyHumanCheck(check) : verifyLightHuman(check);
  if (!verdict.ok) return res.status(403).json({ ...verdict, human: false });
  delete body.humanCheck;
  const user = createUser(body);
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
// FULLY LOADED: each demo account ships with live data — memberships, ACU,
// bookings, pots, API keys, payment links, a published host listing and a
// populated visa queue — so every command centre demos end-to-end.
function fullyLoadDemoAccounts() {
  const byEmail = (e) => findUserByEmail(e);
  const loaded = [];
  const step = (label, fn) => { try { fn(); loaded.push(label); } catch (err) { console.warn('[demo-load]', label, err?.message); } };
  const ctx = { currency: { code: 'GBP', symbol: '£', rateFromUSD: 0.79 }, country: 'GB' };
  const bookFor = (userId, text, tier = 'smart') => {
    const r = plan({ text, context: ctx, user: getUser(userId), searchTier: tier, usage: usageStats(userId) });
    if (r.stage !== 'options') return null;
    const option = r.packages.options.find((o) => o.recommended) || r.packages.options[0];
    const quote = saveQuote({ option, intent: r.intent, instalment: instalmentPlan({ totalLocal: option.pricing.local.total, currency: ctx.currency, months: 3, depositPct: 0.2 }) });
    return createBooking({ quoteId: quote.id, option, instalment: quote.instalment, userId, paymentMethod: 'card', lead: { fullName: getUser(userId)?.name, email: getUser(userId)?.email } });
  };

  // Consumer — the flagship demo journey.
  const t = byEmail('tester@3jntravel.com');
  if (t && listBookings(t.id).length === 0) {
    step('consumer: Travel+ Family Saver membership', () => subscribeMembership(t.id, 'family'));
    step('consumer: Traveller ACU pack (1,750)', () => buyAcu(t.id, 'traveller'));
    step('consumer: loyalty points (Voyager)', () => addPoints(t.id, 1400));
    step('consumer: Dubai family booking', () => bookFor(t.id, 'All inclusive holiday to Dubai from London for 2 adults and 1 child in August, 7 nights', 'deep'));
    step('consumer: family savings pot', () => {
      const pot = createTravelPot(t.id, { name: 'Dubai 2027 family pot', targetUSD: 3000, goal: 'Dubai, August 2027', destination: 'Dubai', monthlyUSD: 250, kind: 'family' });
      if (pot.ok) contributeToPot(pot.pot.id, { name: 'Demo Family', amountUSD: 450 });
    });
    step('consumer: visa application on file', () => recordVisaApplication(assessVisa({ name: t.name, nationality: 'GB', destination: 'Dubai', purpose: 'tourism' })));
    step('consumer: eSIM provisioned', () => provisionEsim(t.id, { destination: 'Dubai', dataGB: 5, days: 7 }));
  }

  // Business — corporate demo.
  const b = byEmail('business@3jntravel.com');
  if (b && listBookings(b.id).length === 0) {
    step('business: Frequent Flyer membership', () => subscribeMembership(b.id, 'executive'));
    step('business: 5,000 ACU float', () => creditAcu(b.id, 5000, 'corporate-demo-float'));
    step('business: Paris team booking', () => bookFor(b.id, 'Flights and hotel to Paris from London for 3 adults, 2 nights', 'smart'));
  }

  // Merchant — BitriPay portal demo.
  const m = byEmail('merchant@3jntravel.com');
  if (m && listApiKeys(m.id).length === 0) {
    step('merchant: sandbox API key', () => createApiKey(m.id, { label: 'Demo sandbox key', environment: 'sandbox' }));
    step('merchant: payment link £420', () => createPaymentLink(m.id, { amountMinor: 42000, currency: 'GBP', description: 'Dubai excursion — demo invoice' }));
  }

  // Partner — white-label demo.
  const pn = byEmail('partner@3jntravel.com');
  if (pn && listApiKeys(pn.id).length === 0) {
    step('partner: production API key', () => createApiKey(pn.id, { label: 'White-label production key', environment: 'production' }));
  }

  // Host — marketplace demo with a published, photo-complete listing.
  let h = byEmail('host@3jntravel.com');
  if (!h) { step('host: account created', () => createUser({ name: 'Demo Host', email: 'host@3jntravel.com', role: 'consumer' })); h = byEmail('host@3jntravel.com'); }
  if (h && listHostListings(h.id).length === 0) {
    step('host: registered + listing published (12 photos)', () => {
      registerHost(h.id, { displayName: 'Demo Host', payoutMethod: 'BitriPay wallet', payout: { walletId: 'BTP-DEMO-884421' } });
      const demoListing = createHostListing(h.id, {
        title: 'The Palm Residence — Marina View Apartment',
        city: 'Dubai',
        address: '14 Palm Avenue, Dubai Marina, Dubai',
        propertyType: 'Entire apartment',
        nightlyUSD: 120, sleeps: 4,
        amenities: ['Full kitchen', 'Free WiFi', 'Pool', 'Washing machine', 'Self check-in', 'Workspace'],
        photos: Array.from({ length: 12 }, (_, i) => `https://picsum.photos/seed/3jn-demo-${i}/800/600`),
      });
      if (demoListing.ok) reviewHostListing(demoListing.listing.id, { decision: 'approve', reason: 'Demo listing — pre-approved', reviewerId: 'demo-admin' });
    });
  }

  // Embassy / consulate — a populated visa decision queue (safe + risky).
  const e1 = byEmail('embassy@3jntravel.com');
  if (e1 && listVisaApplications().length < 3) {
    step('visa queue: clean applicant', () => recordVisaApplication(assessVisa({ name: 'Amina Okafor', nationality: 'NG', destination: 'Paris', purpose: 'tourism' })));
    step('visa queue: conditional case', () => recordVisaApplication(assessVisa({ name: 'Jean Mbala', nationality: 'CD', destination: 'Dubai', purpose: 'business', fundsConsistent: false, homeTies: 'moderate' })));
    step('visa queue: high-risk case', () => recordVisaApplication(assessVisa({ name: 'Flagged Applicant', nationality: 'GB', destination: 'Dubai', purpose: 'tourism', documentsAuthentic: false, knownFraudNetwork: true })));
  }

  // Admin — funded and comped.
  const a = byEmail('admin@3jntravel.com');
  if (a && (getUser(a.id)?.acuBalance || 0) < 1000) {
    step('admin: 10,000 ACU + Concierge Elite', () => { creditAcu(a.id, 10000, 'admin-demo-float'); subscribeMembership(a.id, 'elite'); });
  }
  return loaded;
}
app.post('/api/accounts/seed-roles', safe((req, res) => {
  // Live mode: demo accounts fail closed — only staff with the PIN may seed.
  if (LIVE_MODE() && (!staffPin() || !staffPinOk(req))) {
    return res.status(403).json({ error: 'demo-disabled', message: 'Demo accounts are disabled in live mode.' });
  }
  const accounts = seedAllRoles();
  const demoLoaded = fullyLoadDemoAccounts();
  // Staff-PIN protection: with a PIN configured and absent from the request,
  // privileged demo accounts are listed but their sign-in identity is redacted
  // (a user id IS the session credential in this architecture).
  const unlocked = staffPinOk(req);
  // Include the fully-loaded HOST account (a consumer with hosting capability
  // and a published, pre-approved listing) alongside the role accounts.
  const host = findUserByEmail('host@3jntravel.com');
  const all = host ? [...accounts, host] : accounts;
  const rows = all.map((u) => {
    const full = getUser(u.id) || u;
    if (!unlocked && (PRIVILEGED_ROLES.has(full.role) || full.allAccess)) {
      return { ...full, id: null, pinRequired: true };
    }
    return full;
  });
  res.json({ roles: ROLES, accounts: rows, demoLoaded, staffPinConfigured: !!staffPin() });
}));

// One-click FULL-ACCESS account — a single account that can use every section of
// the OS (admin, business, merchant, consumer, VisaOS government).
app.post('/api/account/test', safe((req, res) => {
  // A full-access account IS an admin credential — behind the staff PIN when
  // one is configured, and fail-closed in live mode.
  if (LIVE_MODE() && !staffPin()) return res.status(403).json({ error: 'demo-disabled', message: 'Demo accounts are disabled in live mode.' });
  if (!staffPinOk(req)) return res.status(403).json({ error: 'staff-pin-required', message: 'Full-access demo accounts require the staff access PIN.' });
  const user = createUser({ name: 'Full-Access Traveller', role: 'admin', allAccess: true });
  addPoints(user.id, 1250 - user.points); // land in Voyager tier (~1,250 pts)
  creditAcu(user.id, 10000, 'full-access-demo'); // funded so every paid feature works
  res.json({ user: getUser(user.id), note: 'Full-access account provisioned — every section unlocked.' });
}));

app.post('/api/account/:id/acu', safe((req, res) => {
  const result = buyAcu(req.params.id, (req.body || {}).pack);
  res.json(result);
}));

// ---- ACU Economy (spec §4): wallet view + typed transaction ledger --------
app.get('/api/account/:id/wallet', safe((req, res) => {
  const wallet = acuWallet(req.params.id);
  if (!wallet) return res.status(404).json({ error: 'unknown-user' });
  res.json({ wallet, transactions: acuTransactions(req.params.id) });
}));

// ---- Refundable search deposits (spec §6): place / list / refund ----------
// Deep £5 · Luxury £20 · Corporate £50 — refundable; a booking converts the
// deposit and deducts it from the final payment.
app.post('/api/account/:id/deposit', safe((req, res) => {
  const result = placeSearchDeposit({ userId: req.params.id, tier: (req.body || {}).tier || 'deep', searchId: (req.body || {}).searchId || null });
  if (!result.ok) return res.status(400).json({ ...result, schedule: SEARCH_DEPOSIT_GBP });
  res.json({ ...result, schedule: SEARCH_DEPOSIT_GBP });
}));
app.get('/api/account/:id/deposits', safe((req, res) => {
  res.json({ deposits: listSearchDeposits(req.params.id), schedule: SEARCH_DEPOSIT_GBP });
}));
app.post('/api/deposits/:id/refund', safe((req, res) => {
  const result = refundSearchDeposit(req.params.id);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}));

// ---- AI Cost Estimator (spec §3): the finance view of AI spend -------------
app.get('/api/admin/ai-costs', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json(aiCostReport());
}));
// Minimum AI profit margin (business rule: never below 100%) — proves every
// metered AI action sells for at least 2× its provider cost.
app.get('/api/admin/ai-margin', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ minMarginPct: MIN_AI_MARGIN * 100, ...aiMarginReport(req.query.provider) });
}));

// Live-supplier status: is Duffel connected, and is it a TEST or LIVE key?
app.get('/api/admin/live-status', safe(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  // Live probe (opt-out with ?probe=0) tells us the REAL reason flights show
  // estimated: no token, test token, network can't reach Duffel, auth rejected,
  // or simply no offers on the probe route.
  const diag = req.query.probe === '0' ? null : await duffelDiagnostic();
  res.json({
    flights: { provider: 'Duffel', enabled: liveFlightsEnabled(), mode: duffelMode(), diagnostic: diag },
    hotels: { provider: 'Amadeus', enabled: liveHotelsEnabled() },
    schedules: { provider: 'OAG', enabled: oagScheduleEnabled() },
    note: duffelMode() === 'test'
      ? 'Duffel is in TEST mode — searches return test offers and no real tickets are issued. Switch to a live Duffel token to sell real fares.'
      : duffelMode() === 'live'
        ? (diag?.ok
          ? 'Duffel LIVE and reachable — real bookable fares are flowing. We hold the fare (instalments) or issue the e-ticket (paid in full) automatically.'
          : `Duffel LIVE token set, but the live probe did not return bookable fares: ${diag?.message || 'unknown'} — flights fall back to estimated until this clears.`)
        : 'Duffel not configured — flights are estimated.',
  });
}));

// ---- Profitability Dashboard (spec §17): real-time money view --------------
app.get('/api/admin/profitability', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const dash = profitabilityDashboard();
  const costs = aiCostReport();
  // ACU economics: what each AI provider costs us vs what ACUs earn.
  const GBP_TO_USD = 1.27;
  const acuRevenueUSD = dash.streams.acuSalesRevenueUSD || 0;
  const aiActualUSD = costs.totalActualUSD || 0;
  const grossProfitUSD = Math.round((acuRevenueUSD - aiActualUSD) * 100) / 100;
  res.json({
    ...dash,
    acuEconomics: {
      // Provider price list (USD per 1M tokens, blended) — the estimator basis.
      providerRatesUSDPerMTokens: PROVIDER_TOKEN_RATES,
      // What each provider has actually been asked to do (from the ledger).
      providerSpend: costs.byProvider,
      requests: costs.requests,
      aiCostEstimatedUSD: costs.totalEstimatedUSD,
      aiCostActualUSD: aiActualUSD,
      acuSalesRevenueUSD: acuRevenueUSD,
      grossProfitUSD,
      marginPct: acuRevenueUSD > 0 ? Math.round((grossProfitUSD / acuRevenueUSD) * 1000) / 10 : null,
      unitEconomics: {
        acuSellPriceGBP: 0.01,       // £1 = 100 ACU (customer rate)
        acuInternalCostGBP: 0.003,   // ACU_GBP — what 1 ACU costs to serve
        intrinsicMarginPct: 70,      // sell 1p, serve at 0.3p
        rule: 'Expected Revenue >= AI Cost x 10 (Cost Protection Gate) — AI never runs unfunded',
      },
    },
    duffelFees: (() => {
      // Search-to-book ratio drives Duffel's excess-search fee (£0.004 per
      // search beyond 1500 searches per confirmed booking).
      const stb = searchToBookStats();
      const searches = stb.searches;
      const bookings = stb.bookings;
      const allowance = bookings * DUFFEL_FEES.searchToBookRatio;
      const excess = Math.max(0, searches - allowance);
      return {
        schedule: DUFFEL_FEES,
        perOrderGBP: DUFFEL_FEES.orderGBP,
        managedContentPct: DUFFEL_FEES.managedContentPct,
        ancillaryGBP: DUFFEL_FEES.ancillaryGBP,
        searchToBook: { searches, bookings, ratio: bookings ? Math.round(searches / bookings) : searches, limit: DUFFEL_FEES.searchToBookRatio, excessSearches: excess, excessFeeGBP: Math.round(excess * DUFFEL_FEES.excessSearchGBP * 100) / 100 },
        note: 'All Duffel fees are recovered on top of the 10% commission on live flight bookings — margin protected.',
      };
    })(),
  });
}));

// ---- Admin: users, hosts & property moderation -----------------------------
app.get('/api/admin/users-hosts', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json(adminUserHostOverview());
}));
app.post('/api/admin/listings/:id/review', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const { decision, reason } = req.body || {};
  const result = reviewHostListing(req.params.id, { decision, reason, reviewerId: currentUser(req).id });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}));

// ---- Request Exact Quote (real revenue capture on estimated options) --------
// A customer on an estimated flight/hotel option requests the exact bookable
// price. We capture the lead + deposit intent; an agent (or the live supplier)
// confirms the real price; the customer then pays it for real.
app.post('/api/quote-request', safe((req, res) => {
  const { option, intent, contact, depositIntentGBP, note } = req.body || {};
  const user = currentUser(req);
  const result = createQuoteRequest({ userId: user?.id || null, option, intent, contact, depositIntentGBP, note });
  if (!result.ok) return res.status(400).json(result);
  // Notify the team by email so no lead is missed (no-op if email disabled).
  const r = result.request;
  sendMail({
    to: MAIN_CONTACT,
    subject: `New exact-quote request — ${r.destination} (${r.tier})`,
    text: `Lead: ${r.contact.name} <${r.contact.email}> ${r.contact.phone}
Trip: ${r.tier} to ${r.destination}
Estimated total: ${r.symbol}${r.estimatedTotalLocal}
Deposit intent: £${r.depositIntentGBP}
Note: ${r.note}
Request id: ${r.id}`,
    html: `<p><strong>${r.contact.name}</strong> &lt;${r.contact.email}&gt; ${r.contact.phone}</p><p>${r.tier} → ${r.destination}. Est ${r.symbol}${r.estimatedTotalLocal}. Deposit intent £${r.depositIntentGBP}.</p><p>${r.note || ''}</p><p>ID: ${r.id}</p>`,
  }).catch(() => {});
  res.json(result);
}));
app.get('/api/quote-requests', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json({ requests: listQuoteRequests({ userId: user.id }) });
}));
// Admin: see and price every quote request.
app.get('/api/admin/quote-requests', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ requests: listQuoteRequests({ status: req.query.status || null }) });
}));
app.post('/api/admin/quote-requests/:id/confirm', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const { confirmedTotalLocal, supplierRef } = req.body || {};
  const result = confirmQuoteRequest(req.params.id, { confirmedTotalLocal, confirmedBy: currentUser(req).id, supplierRef });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}));
// Pay a CONFIRMED quote for real (Stripe). The price is now bookable, so this
// is lawful real payment — the same rail flights use once Duffel is live.
app.post('/api/quote-request/:id/pay', safe(async (req, res) => {
  if (!stripeEnabled()) return res.status(400).json({ error: 'stripe-not-configured' });
  const qr = getQuoteRequest(req.params.id);
  if (!qr) return res.status(404).json({ error: 'not-found' });
  if (qr.status !== 'priced' || !(qr.confirmedTotalLocal > 0)) {
    return res.status(409).json({ error: 'not-yet-priced', message: 'This quote has not been confirmed with an exact bookable price yet.' });
  }
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const session = await createCheckoutSession({
    amountMinor: Math.round(qr.confirmedTotalLocal * 100),
    currency: qr.currency,
    description: `3JN Travel OS — ${qr.tier} to ${qr.destination} (confirmed quote)`,
    bookingId: qr.id,
    userId: qr.userId || '',
    customerEmail: qr.contact?.email,
    successUrl: `${origin}/console?quotePaid=1&qr=${qr.id}`,
    cancelUrl: `${origin}/console?quotePaid=0&qr=${qr.id}`,
  });
  if (!session.ok) return res.status(400).json(session);
  res.json(session);
}));

// ---- Guaranteed Savings Engine (USP #2) -------------------------------------
// "If we cannot beat or match your current quote, we refund your search
// credits." Compares the competing quote to our floor and refunds the ACUs.
app.post('/api/account/:id/savings-guarantee', safe((req, res) => {
  const { competitorQuoteUSD, ourTotalUSD, acuSpent } = req.body || {};
  const result = claimSavingsGuarantee(req.params.id, { competitorQuoteUSD, ourTotalUSD, acuSpent });
  if (!result.ok) return res.status(400).json(result);
  res.json({ ...result, guarantee: SAVINGS_GUARANTEE });
}));

// Lightweight "login" — look up an existing account by email (prototype: no
// password; a real build authenticates via Auth0/Firebase).
app.post('/api/login', safe((req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
  const rl = rateLimitAuth(ip);
  if (!rl.ok) return res.status(429).json(rl);
  // HUMAN-ONLY login: same full verification as signup.
  const verdict = verifyHumanCheck((req.body || {}).humanCheck || {});
  if (!verdict.ok) return res.status(403).json({ ...verdict, human: false });
  const email = ((req.body || {}).email || '').trim().toLowerCase();
  const user = findUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'not-found', message: 'No account with that email. Sign up instead.' });
  // Privileged accounts (admin, business, embassy…) can never be opened by
  // email alone: when the staff PIN is configured it must accompany the login.
  if ((PRIVILEGED_ROLES.has(user.role) || user.allAccess) && !staffPinOk(req)) {
    return res.status(403).json({ error: 'staff-pin-required', message: 'Staff accounts require the staff access PIN.' });
  }
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
  let result = plan({ text, context, user, searchTier, overrides, preferences: preferences || {}, usage: usageStats(user?.id) });

  // Live provider pricing overlay: when flight/hotel provider keys are present
  // and reachable, fetch real offers and rebuild the packages from them. Any
  // failure (no keys, outbound disabled, provider down) silently keeps the
  // deterministic estimate — we never present an unconverted or invented price.
  if (result.stage === 'options' && liveSuppliersConfigured()) {
    try {
      const intent = result.intent;
      const dest = intent.destination;
      let live;
      // MULTI-ORIGIN GROUP: fetch live fares for EACH party's own departure
      // city so every leg in the one booking is a real bookable fare.
      // NOTE: intent.groupOrigins is { parties, resolved } — an OBJECT, not an
      // array. Iterate .parties (with each party's resolved airport). The old
      // guard tested `.length`/`.map` on the object, so this branch never ran
      // and every party silently fell back to the estimator.
      const groupParties = intent.groupOrigins && Array.isArray(intent.groupOrigins.parties)
        ? intent.groupOrigins.parties : null;
      if (groupParties && groupParties.length && liveFlightsEnabled()) {
        const resolved = intent.groupOrigins.resolved || [];
        const groupFlights = await Promise.all(groupParties.map(async (party, idx) => {
          const origin = resolved[idx]?.origin || resolveOrigin(party.city) || result.origin;
          const partyIntent = { ...intent, travellers: { adults: party.count, children: 0, childAges: [], total: party.count } };
          const offers = await fetchLiveFlights(partyIntent, dest, origin).catch(() => null);
          return { partyIndex: idx, city: party.city, offers: (offers && offers.length) ? offers : null };
        }));
        const withOffers = groupFlights.filter((g) => g.offers);
        const hotels = liveHotelsEnabled() ? await fetchLiveHotels(intent, dest).catch(() => null) : null;
        live = { groupFlights: withOffers.length ? withOffers : null, hotels };
      } else {
        live = await fetchLiveOffers(intent, dest, result.origin);
      }
      const hasLive = (live.flights && live.flights.length) || (live.hotels && live.hotels.length) || (live.groupFlights && live.groupFlights.length);
      if (hasLive) {
        result = plan({ text, context, user, searchTier, overrides, preferences: preferences || {}, live, usage: usageStats(user?.id) });
      }
    } catch { /* keep the estimated result */ }
  }

  // LIVE MODE (go-live switch, LIVE_MODE=true): NO free AI, full stop. Guests
  // get cached results only; any fresh AI-computed search requires a signed-in
  // account whose ACUs fund it (the enforcement below). Staff allAccess demo
  // accounts are exempt so internal testing still works.
  if (LIVE_MODE() && result.stage === 'options' && !result.cached && !user) {
    return res.json({
      stage: 'topup-required',
      reason: 'account-required',
      tierName: (SEARCH_TIERS[searchTier] || SEARCH_TIERS.smart).name,
      acuNeeded: (SEARCH_TIERS[searchTier] || SEARCH_TIERS.smart).acu || 0,
      balance: 0,
      isMember: false,
      message: 'AI searches are funded by ACUs. Create a free account and top up (£5 = 500 ACU) to run live AI searches — cached results stay free.',
    });
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
    // Revenue Engine (spec §9): abuse detection forfeits the active search
    // deposit — deposits are refundable, EXCEPT when the abuse throttle trips.
    if (result.gate?.reason === 'abuse-throttle') {
      const forfeited = forfeitSearchDeposit(user.id, 'abuse-throttle');
      if (forfeited) {
        result.gate.requirement = {
          ...(result.gate.requirement || {}),
          depositForfeited: { depositId: forfeited.id, amountGBP: forfeited.amountGBP },
          message: `${result.gate.requirement?.message || ''} Your £${forfeited.amountGBP} search deposit was forfeited because abuse was detected.`.trim(),
        };
      }
    }
    // Tier 4 Concierge requires a real commitment (deposit / subscription /
    // premium plan) before AI + human-expert time runs — never ACU alone.
    if (searchTier === 'concierge' && result.gate?.reason === 'concierge-requires-commitment') {
      return res.json({
        stage: 'concierge-requires-commitment',
        tierName: reqTier.name,
        requirement: result.gate.requirement,
        depositTierGBP: 20,
        message: result.gate.requirement?.message,
      });
    }
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
      // AI Cost Estimator: every funded (non-cached) search books its cost
      // into the ai_request_costs ledger, attributed to the paying user.
      recordAiRequestCost({
        provider: 'anthropic', model: 'model-router',
        agentName: `search:${searchTier}`,
        estimatedTokens: cost * 120,
        estimatedCostUSD: reqTier.aiCostUSD,
        actualCostUSD: 0, // deterministic local engine — no external spend
        mode: 'local-fallback',
        userId: user.id,
        searchId: result.intent?.destination?.code ? `${searchTier}:${result.intent.destination.code}` : null,
      });
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
  const { quoteId, months, depositPct, paymentMethod, lead, specialRequests, hotelRequests, payment, protection, vendorCode } = req.body || {};
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

  const booking = createBooking({ quoteId, option: quote.option, instalment, userId: user?.id, paymentMethod, lead, specialRequests, hotelRequests, payment, protection: protection ? protectionFee(quote.option.pricing.local.total) : null, vendorCode });
  // Refundable search deposit (spec §6): a booking converts the user's active
  // deposit — its value comes OFF the final payment, never double-charged.
  if (user) {
    const depositCredit = convertDepositToBooking(user.id, booking.id);
    if (depositCredit) booking.depositCredit = depositCredit;
  }
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

// Branded travel document — e-ticket / itinerary / confirmation. Returns a
// self-contained, printable 3JN-branded HTML page (customer can Save as PDF).
app.get('/api/book/:id/document', safe((req, res) => {
  const booking = getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'not-found' });
  const user = currentUser(req);
  // Only the owner (or an admin) may fetch a booking document.
  if (booking.userId && user?.id !== booking.userId && !requireRole(req, res, ['admin'])) return;
  const html = bookingDocument(booking, { user, currencySymbol: booking.option?.pricing?.symbol });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

// ---- Stripe Checkout: live card payments -----------------------------------
// Credential-gated: without STRIPE_SECRET_KEY the simulated flow continues.
app.get('/api/pay/stripe/status', safe((req, res) => {
  res.json({ enabled: stripeEnabled() });
}));
// Create a hosted Checkout session for a booking's deposit (or full amount).
app.post('/api/pay/stripe/session', safe(async (req, res) => {
  if (!stripeEnabled()) return res.status(400).json({ error: 'stripe-not-configured', message: 'Card checkout is not configured yet — set STRIPE_SECRET_KEY.' });
  const { bookingId, kind } = req.body || {};
  const booking = getBooking(bookingId);
  if (!booking) return res.status(404).json({ error: 'booking-not-found' });
  // ---- LIVE INVENTORY GATE (legal-safety rule, never to be weakened) -------
  // Real money may ONLY be taken for LIVE supplier fares that can actually be
  // fulfilled at the shown price. An estimated-price booking gets a quote, a
  // deposit-free hold and honest labelling — never a real charge. Charging for
  // inventory we never held is a legal and reputational red line.
  // Override for Stripe TEST-mode demos only via ALLOW_TEST_PAYMENTS=true.
  const testMode = process.env.ALLOW_TEST_PAYMENTS === 'true' && String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test');
  if (booking.priceBasis !== 'live' && !testMode) {
    return res.status(409).json({
      error: 'payment-blocked-estimated-pricing',
      priceBasis: booking.priceBasis || 'estimated',
      message: 'This quote is estimated — live supplier fares are not connected yet, so we do not take real payment for it. Connect live inventory (Duffel/Amadeus) to enable secure card checkout at the exact bookable price.',
    });
  }
  // FRESH-FARE GUARD: a live Duffel flight offer expires and can reprice. Before
  // charging, re-validate it against Duffel. If it expired or moved, refuse and
  // ask the traveller to re-search — never charge a fare we can no longer ticket.
  const flightComp = (booking.option?.components || []).find((c) => c.type === 'flight' && c.details?.offerId && c.live);
  if (flightComp && liveFlightsEnabled()) {
    const check = await validateDuffelOffer(flightComp.details.offerId);
    if (check.ok && (check.expired || check.live === false)) {
      return res.status(409).json({ error: 'fare-expired', message: 'This live fare has expired since your search — please re-search so we quote and charge the current bookable price.' });
    }
    if (check.ok && typeof check.priceUSD === 'number') {
      const shown = flightComp.priceUSD || 0;
      const drift = shown > 0 ? Math.abs(check.priceUSD - shown) / shown : 0;
      if (drift > 0.02) {
        return res.status(409).json({ error: 'fare-changed', message: 'The airline price changed since your search — please re-search to see and confirm the current fare before paying.', wasUSD: shown, nowUSD: check.priceUSD });
      }
    }
  }
  const cur = booking.option?.pricing?.currency || 'GBP';
  const total = booking.instalment?.deposit && kind !== 'full'
    ? booking.instalment.deposit
    : booking.option?.pricing?.local?.total || 0;
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const user = currentUser(req);
  const session = await createCheckoutSession({
    amountMinor: Math.round(total * 100),
    currency: cur,
    description: `3JN Travel OS — ${booking.option?.tier || ''} package ${kind === 'full' ? '(full payment)' : '(deposit)'}`.trim(),
    bookingId: booking.id,
    userId: user?.id || booking.userId || '',
    customerEmail: user?.email,
    successUrl: `${origin}/console?paid=1&booking=${booking.id}`,
    cancelUrl: `${origin}/console?paid=0&booking=${booking.id}`,
  });
  if (!session.ok) return res.status(400).json(session);
  res.json(session);
}));
// Webhook: signature-verified; a forged event can never mark a booking paid.
app.post('/api/pay/stripe/webhook', safe((req, res) => {
  const sig = req.headers['stripe-signature'];
  const check = verifyStripeSignature(req.rawBody, sig);
  if (!check.ok) return res.status(400).json(check);
  const event = req.body || {};
  if (event.type === 'checkout.session.completed') {
    const meta = event.data?.object?.metadata || {};
    const amountMinor = event.data?.object?.amount_total || 0;
    if (meta.bookingId && String(meta.bookingId).startsWith('qr_')) {
      // A confirmed exact-quote was paid.
      markQuoteRequestPaid(meta.bookingId, { amount: amountMinor / 100, gateway: 'stripe', reference: event.data?.object?.id });
      if (meta.userId) pushNotification(meta.userId, { type: 'success', icon: '💳', title: 'Payment received', body: `Your ${(amountMinor / 100).toFixed(2)} payment is confirmed — your trip is booked at the exact quoted price.` });
    } else if (meta.bookingId) {
      const booking = recordPayment(meta.bookingId, { type: 'stripe-checkout', amount: amountMinor / 100, gateway: 'stripe', reference: event.data?.object?.id });
      if (booking && meta.userId) {
        pushNotification(meta.userId, { type: 'success', icon: '💳', title: 'Payment received', body: `Card payment of ${(amountMinor / 100).toFixed(2)} confirmed via Stripe — your booking is secured.` });
      }
      // AUTO-TICKETING: money is captured — now issue the flight ticket by
      // creating the Duffel order. Runs async; failure flags the booking for a
      // refund rather than leaving the traveller paid-but-unticketed.
      if (booking) autoTicketFlight(booking).catch((e) => console.error('[ticketing]', e?.message || e));
    }
  }
  res.json({ received: true });
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

// ---- Global Rewards & Influencer Programme --------------------------------
// Public programme catalogue — earning actions, redemption categories, tiers.
app.get('/api/rewards/catalog', safe((req, res) => {
  res.json({
    earnActions: Object.values(REWARD_ACTIONS),
    redeemCategories: REDEEM_CATEGORIES,
    tiers: Object.values(PARTNER_TIERS),
    aiGrowthTools: AI_GROWTH_TOOLS,
    referralAcu: REFERRAL_ACU,
    revshareCapGbp: REVSHARE_CAP_GBP,
    revshareUnlockReferrals: REFERRER_REVSHARE_UNLOCK,
  });
}));
// My partner dashboard (§4) — real-time, derived from the ledgers.
app.get('/api/rewards/me', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  const dash = partnerDashboard(user.id);
  if (!dash) return res.status(404).json({ error: 'not-found' });
  res.json({ dashboard: dash });
}));
// Apply to the influencer programme (§3).
app.post('/api/rewards/influencer/apply', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  const { followers, handles } = req.body || {};
  res.json(applyInfluencer(user.id, { followers, handles }));
}));
// Earn ACU for a user-triggerable action (share itinerary, upload photo, etc.).
// Booking/completion/referral awards fire automatically server-side.
const USER_EARN_ACTIONS = new Set(['SHARE_ITINERARY', 'UPLOAD_PHOTO', 'PROFILE_VERIFIED']);
app.post('/api/rewards/earn', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  const { action } = req.body || {};
  if (!USER_EARN_ACTIONS.has(action)) return res.status(400).json({ error: 'action-not-user-triggerable' });
  res.json(earnAcu(user.id, action));
}));
// Request a payout of pending commission (§4/§6).
app.post('/api/rewards/withdraw', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  const { amountGbp, method } = req.body || {};
  res.json(requestWithdrawal(user.id, { amountGbp, method }));
}));
// Public leaderboard (§4).
app.get('/api/rewards/leaderboard', safe((req, res) => {
  res.json({ leaderboard: rewardsLeaderboard(Number(req.query.limit) || 20) });
}));
// Admin: review & decide influencer applications (§3/§6).
app.get('/api/admin/rewards/influencers', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ leaderboard: rewardsLeaderboard(100) });
}));
app.post('/api/admin/rewards/influencer/:userId/decide', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const { approve, tier, standing } = req.body || {};
  res.json(decideInfluencer(req.params.userId, { approve, tier, standing }));
}));

// ---- Vendor Partner Programme ----------------------------------------------
// Public programme card: tiers, rates, examples, payout terms.
app.get('/api/vendors/programme', safe((req, res) => {
  res.json({
    platformFeePct: PLATFORM_FEE_RATE * 100,
    tiers: Object.values(VENDOR_TIERS).map((t) => ({
      key: t.key, name: t.name,
      commissionPct: Math.round(t.commissionRate * 100), bonusPct: Math.round(t.bonusRate * 100),
      platformKeepsPct: Math.round((PLATFORM_FEE_RATE - t.commissionRate) * 100),
      platformKeepsBonusPct: Math.round((PLATFORM_FEE_RATE - t.bonusRate) * 100),
      requiresRegistration: t.requiresRegistration, requiredDocs: t.requiredDocs || [],
      example: commissionSplit(1000, t.key),
    })),
    payouts: 'Automatic every Friday, after: sale confirmed · payment cleared · no refund/chargeback/fraud flag · booking validated · compliance passed.',
    topSellerBonus: '+1% for the following month — re-earned monthly.',
  });
}));
// Apply (AI risk review runs immediately; clean pass auto-approves).
app.post('/api/vendors/apply', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  const { tier, identityDoc, addressProof, socialHandles, businessHistory, documents } = req.body || {};
  res.json(applyVendor(user.id, { tier, identityDoc, addressProof, socialHandles, businessHistory, documents }));
}));
// My vendor portal (§5).
app.get('/api/vendors/me', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  const dash = vendorDashboard(user.id);
  if (!dash) return res.status(404).json({ error: 'not-a-vendor' });
  res.json({ dashboard: dash });
}));
app.get('/api/vendors/leaderboard', safe((req, res) => {
  res.json({ leaderboard: vendorLeaderboard(Number(req.query.limit) || 20) });
}));
// Admin: applications queue, decisions, weekly payout run, top-seller award.
app.get('/api/admin/vendors', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ vendors: listVendors(req.query.status) });
}));
app.post('/api/admin/vendors/:userId/decide', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const { approve, tier, status } = req.body || {};
  res.json(decideVendor(req.params.userId, { approve, tier, status }));
}));
app.post('/api/admin/vendors/payout-run', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json(runWeeklyVendorPayouts());
}));
app.post('/api/admin/vendors/top-seller', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json(awardTopSellerBonus());
}));
app.post('/api/admin/vendors/sales/:saleId/flag', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json(flagVendorSale(req.params.saleId, (req.body || {}).flag));
}));

// ---- AI Support Concierge (chatbot + human escalation) --------------------
// Answers customer requests; escalates to a human ONLY when required (explicit
// request, refund/dispute, complaint/safety, or low confidence). Uses the
// signed-in user's latest booking as context when available.
app.post('/api/support/chat', safe((req, res) => {
  const { message } = req.body || {};
  const user = currentUser(req);
  // Deep, system-aware agent: resolves with the user's REAL bookings, payments,
  // e-tickets, wallet, rewards and visa rules; escalates only when a human must
  // authorise an action — and hands the human a full diagnostic.
  const out = assist(message, user?.id);
  let ticket = null;
  if (out.escalate) {
    ticket = createSupportTicket({
      userId: user?.id, intent: out.intent, message, reason: out.reason,
      // Attach what the agent already established so the specialist starts warm.
      transcript: out.diagnostic ? [{ role: 'assistant-diagnostic', booking: out.diagnostic }] : [],
    });
  }
  res.json({
    reply: out.reply,
    intent: out.intent,
    resolved: out.resolved,
    escalated: out.escalate,
    reason: out.reason,
    ticketId: ticket?.id || null,
    handoff: out.escalate ? 'A 3JN travel specialist will follow up shortly.' : null,
  });
}));
// My support tickets (customer view).
app.get('/api/support/tickets', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json({ tickets: supportTicketsForUser(user.id) });
}));
// Admin queue: open escalations + resolve.
app.get('/api/admin/support/tickets', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ tickets: listSupportTickets(req.query.status) });
}));
app.post('/api/admin/support/tickets/:id/resolve', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const user = currentUser(req);
  res.json(resolveSupportTicket(req.params.id, { note: req.body?.note, agent: user?.name || 'admin' }));
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
  // The AI runs on submission, but its verdict is OFFICER-ONLY: the applicant
  // gets a receipt, never the score/band/recommendation. They learn the outcome
  // only when the officer RELEASES the decision.
  const assessment = assessVisa(req.body || {});
  const record = recordVisaApplication(assessment);
  res.json({
    ok: true, applicationId: record?.id || null, status: 'under-review',
    message: 'Application received. It is being reviewed by the embassy — you will be notified when a decision is issued.',
  });
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
  // Persist the FULL application (information + documents + decision file). The
  // full file is OFFICER-ONLY: the applicant receives a receipt plus their own
  // checklist feedback (what's missing) — never the AI verdict or fraud checks.
  const record = recordVisaFile({ applicant, country, visaType, documents: providedDocuments || [], file, userId: user?.id });
  res.json({
    ok: true, applicationId: record.id, status: 'under-review',
    received: (providedDocuments || []).length,
    missingDocuments: file?.checklist?.missing || record.missingDocuments || [],
    message: 'Application received and under embassy review. You will be notified when the decision is issued.',
  });
}));

// Applicant: my submitted applications — REDACTED (own data + status only; the
// AI result and officer decision appear only after the officer releases it).
app.get('/api/visaos/my-applications', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json({ applications: listVisaApplicationsForUser(user.id).map(redactVisaForApplicant) });
}));

// Officer: release the decision to the applicant (only now do they find out).
app.post('/api/visaos/applications/:id/release', safe((req, res) => {
  if (!requireRole(req, res, ['embassy', 'consulate', 'admin'])) return;
  const result = releaseVisaDecision(req.params.id, currentUser(req)?.id);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
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
  const { decision, reason, secondApproverId, conditions } = req.body || {};
  const result = decideVisaApplication(req.params.id, { decision, reason, secondApproverId, conditions, officerId: currentUser(req)?.id });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}));

// ---- Embassy governance: criteria, branding, language, fees, templates -----
// The embassy CONFIGURES how VisaOS works for its country; the AI proposes
// against those criteria; officers confirm/override with reasons + conditions.
app.get('/api/embassy/config', safe((req, res) => {
  if (!requireRole(req, res, ['embassy', 'consulate', 'admin'])) return;
  const country = req.query.country || currentUser(req)?.embassyCountry || 'DEFAULT';
  res.json({ config: getEmbassyConfig(country) });
}));
app.post('/api/embassy/config', safe((req, res) => {
  if (!requireRole(req, res, ['embassy', 'consulate', 'admin'])) return;
  const { country, ...patch } = req.body || {};
  res.json(saveEmbassyConfig(country || currentUser(req)?.embassyCountry || 'DEFAULT', patch, currentUser(req)?.id));
}));
// The AI proposal for one application, banded by THIS embassy's criteria.
app.get('/api/embassy/applications/:id/proposal', safe((req, res) => {
  if (!requireRole(req, res, ['embassy', 'consulate', 'admin'])) return;
  const application = getVisaApplication(req.params.id);
  if (!application) return res.status(404).json({ error: 'not-found' });
  const config = getEmbassyConfig(req.query.country || currentUser(req)?.embassyCountry || 'DEFAULT');
  res.json({ proposal: embassyProposal(application, config), templates: { refusalReasons: config.refusalReasons, approvalConditions: config.approvalConditions } });
}));
// Embassy-branded decision letter (in the embassy's configured language).
app.get('/api/visaos/applications/:id/letter', safe((req, res) => {
  const application = getVisaApplication(req.params.id);
  if (!application) return res.status(404).json({ error: 'not-found' });
  const user = currentUser(req);
  const isOfficer = user && (user.allAccess || ['embassy', 'consulate', 'admin'].includes(user.role));
  if (!isOfficer && application.userId !== user?.id) return res.status(403).json({ error: 'forbidden' });
  if (!application.embassyDecision) return res.status(409).json({ error: 'not-decided', message: 'No decision has been issued yet.' });
  // Applicants can only read the letter once the officer has RELEASED it.
  if (!isOfficer && !application.embassyDecision.released) {
    return res.status(409).json({ error: 'not-released', message: 'Your application is still under review — the decision has not been issued yet.' });
  }
  const config = getEmbassyConfig(application.country || application.applicant?.destination || 'DEFAULT');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(visaDecisionLetter(application, config));
}));
// Public visa fee card (the price the embassy set, by visa type).
app.get('/api/visa/fees', safe((req, res) => {
  const config = getEmbassyConfig(req.query.country || 'DEFAULT');
  res.json({ country: config.country, embassyName: config.embassyName, fees: config.fees });
}));

app.get('/api/visaos/probability', safe((req, res) => {
  res.json(approvalProbability(req.query.nationality, req.query.destination));
}));
app.get('/api/visaos/government', safe((req, res) => {
  if (!requireRole(req, res, ['embassy', 'consulate', 'admin'])) return;
  res.json({ analytics: govAnalytics() });
}));
// The module manifest: positioning, problems solved, SLA, promise and the
// per-agent forensic checklists — the GovTech sales sheet, from the engine.
app.get('/api/visaos/manifest', safe((req, res) => {
  res.json({ ...VISAOS_MANIFEST, agentChecks: AGENT_CHECKS, zeroTrust: ZERO_TRUST, antiCorruption: ANTI_CORRUPTION, digitalJourney: DIGITAL_JOURNEY, revenueModel: VISAOS_REVENUE_MODEL, travelOsIntegration: TRAVEL_OS_INTEGRATION });
}));
// Blockchain audit trail: tamper-evident hash chain of every visa event.
app.get('/api/visaos/audit-chain', safe((req, res) => {
  if (!requireRole(req, res, ['embassy', 'consulate', 'admin'])) return;
  res.json({ integrity: verifyVisaChain(), blocks: visaChainBlocks(Number(req.query.limit) || 20) });
}));

// ---- 3JN Host Marketplace ---------------------------------------------------
// End-to-end accommodation system: register first, then run your dashboard —
// publish properties, set prices, pause/resume, manage bookings and earnings.
// Verified listings appear in searches alongside hotels with 3JN reliability,
// the price guard and instalments wrapped around every stay. Hosts keep 90%.
app.post('/api/host/register', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required', message: 'Sign in to register as a host.' });
  const r = registerHost(user.id, req.body || {});
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
}));
// Update payout details from the dashboard (validated; re-verified before the
// next payout run; only masked details ever come back).
app.patch('/api/host/payout', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  const r = updateHostPayout(user.id, req.body || {});
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
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

app.post('/api/v1/esim', safe((req, res) => {
  const auth = partnerAuth(req);
  const r = plan({ text: `esim for ${req.body?.destination || req.body?.text || 'Dubai'}`, context: detectContext(req, {}), user: null, searchTier: 'smart' });
  const esims = r.stage === 'options' ? r.packages.options.flatMap((o) => o.components.filter((c) => c.type === 'esim')) : [];
  res.json({ ...auth, product: 'esim', stage: r.stage, esims });
}));

app.post('/api/v1/search', safe((req, res) => {
  const { text } = req.body || {};
  const partnerKey = req.headers['x-partner-key'];
  // Validate a real issued key if supplied; otherwise allow the public demo.
  const keyInfo = partnerKey ? useApiKey(partnerKey) : null;
  const context = detectContext(req, {});
  // A valid partner key = a white-label contract — funding source 7 of the
  // Final Platform Rule.
  const result = plan({ text, context, user: null, searchTier: 'smart', usage: { whiteLabelContract: Boolean(keyInfo) } });
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
