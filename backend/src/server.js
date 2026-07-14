// 3JN Travel OS — Express server.
// Serves the premium frontend and the full JSON API that drives the pipeline.

import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { detectContext, listCurrencies } from './geo.js';
import { destinationsCatalog, findDestination, resolveOrigin, originForCountry } from './destinations.js';
import { inspireDestinations, INSPIRE_WINDOWS } from './inspire.js';
import { plan } from './planner.js';
import { instalmentPlan, protectionFee, DUFFEL_FEES } from './pricing.js';
import { buildSmartInstalmentPlan, assessInstalmentRisk, daysUntil, INSTALMENT_TIERS, INSTALMENT_GRACE_HOURS, planPaid } from './instalments.js';
import {
  createUser, getUser, markEmailVerified, buyAcu, ACU_PACKS, saveQuote, getQuote, createBooking,
  getBooking, listBookings, recordPayment, revenueSnapshot, addPoints,
  adminOverview, adminUsers, adminBookings, adminActivity, adminAdjustAcu, adminSetMembership,
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
  createContract, listContracts, recordBehaviour, recordAudit,
  subscribeMembership, renewMembership, cancelMembership, spendAcu, creditAcu,
  createHostListing, listHostListings, hostEarnings,
  registerHost, updateHostListing, hostBookings, hostDashboard, updateHostPayout,
  grantComplimentaryElite, compEliteCount, COMP_ELITE_LIMIT, usageStats,
  acuWallet, acuTransactions, aiCostReport, recordAiRequestCost,
  placeSearchDeposit, refundSearchDeposit, listSearchDeposits, convertDepositToBooking, applyDepositCreditToBooking, forfeitSearchDeposit, SEARCH_DEPOSIT_GBP,
  profitabilityDashboard, claimSavingsGuarantee, verifyVisaChain, visaChainBlocks,
  createTravelPot, contributeToPot, reviewHostListing, adminUserHostOverview,
  createQuoteRequest, confirmQuoteRequest, markQuoteRequestPaid, listQuoteRequests, getQuoteRequest, claimStripeEvent,
  searchToBookStats,
  earnAcu, applyInfluencer, decideInfluencer, partnerDashboard,
  rewardsLeaderboard, requestWithdrawal,
  createSupportTicket, listSupportTickets, supportTicketsForUser, resolveSupportTicket,
  applyVendor, decideVendor, vendorDashboard, vendorLeaderboard,
  addVendorService, removeVendorService, recordVendorServiceJob,
  listVendors, runWeeklyVendorPayouts, awardTopSellerBonus, flagVendorSale, maybeRunFridayPayouts,
  getEmbassyConfig, saveEmbassyConfig, redactVisaForApplicant, releaseVisaDecision,
  saveBenchmarkRun, latestBenchmarkRun, recordBenchmarkMarket,
  userPaymentHistory, enforceInstalments,
  listFulfilmentOrders, completeFulfilmentOrder, updateFulfilmentOrder,
  sweepBotAccounts, unflagBotAccount, applyMobilityEvent,
  createDeal, updateDeal, setDealActive, deleteDeal, getDeal, publicDeal,
  listDeals, listDealsAdmin, dealTotalGBP, buildDealOption, createDealFulfilment,
} from './store.js';
import { supplierDoors, viatorEnabled, viatorActivitiesForScan, mozioEnabled, mozioTransfersForScan, cartrawlerEnabled, cartrawlerWebhookSecret, cartrawlerWebhookOptions, cartrawlerWebhookInspect, cartrawlerWebhookUpdate, CARTRAWLER_EVENT_STATUS } from './extras-suppliers.js';
import { botSignupVerdict } from './bot-defence.js';
import { runFlightBenchmark, DEFAULT_BENCHMARK_ROUTES } from './benchmark.js';
import { embassyProposal, visaDecisionLetter } from './embassy.js';
import { VENDOR_TIERS, PLATFORM_FEE_RATE, commissionSplit } from './vendors.js';
import { REWARD_ACTIONS, REDEEM_CATEGORIES, PARTNER_TIERS, AI_GROWTH_TOOLS, REVSHARE_CAP_GBP, REFERRER_REVSHARE_UNLOCK, REFERRAL_ACU } from './rewards.js';
import { assist } from './assistant.js';
import { bookingDocument, includedServices } from './documents.js';
import { MEMBERSHIP_TIERS, ACU_PER_GBP, MEMBERSHIP_ACU_FUND_RATE } from '../../shared/constants.js';
import { learnProfile, journeyDashboard } from './learning.js';
import { visaCheck, riskFeed } from './intelligence.js';
import { assessVisa, approvalProbability, VISAOS_MANIFEST, AGENT_CHECKS, ZERO_TRUST, ANTI_CORRUPTION, DIGITAL_JOURNEY, VISAOS_REVENUE_MODEL, TRAVEL_OS_INTEGRATION } from './visaos.js';
import { visaFramework, buildChecklist, assessApplication, validateApplicant } from './visa-framework.js';
import { bookingSchema, bookingRequirements, validateBooking, bookingRiskScore } from './booking-schema.js';
import { liveShowcase } from './showcase.js';
import { architecture as commsArchitecture, renderEmail as commsRenderEmail, emit as commsEmit, EVENTS as COMMS_EVENTS } from './comms.js';
import { geocode, weather, fxRate, advisory, liveDataEnabled } from './live-data.js';
import { fetchLiveOffers, fetchLiveFlights, fetchLiveHotels, fetchMarketFares, marketDataEnabled, liveSuppliersConfigured, liveFlightsEnabled, lccFlightsEnabled, liveHotelsEnabled, oagScheduleEnabled, validateDuffelOffer, validateTequilaOffer, duffelMode, duffelDiagnostic, createDuffelOrder, createDuffelHoldOrder, payDuffelOrder, duffelOrderPassengers, duffelStaysEnabled, bookDuffelStay } from './live-suppliers.js';
import { scanMarketplaceAddons } from './suppliers.js';
import { runPriceGuard, runDisruptionGuard } from './monitor.js';
import { submitReview, leaderboard } from './reviews.js';
import { whiteLabelPayout, REVENUE_STREAMS, SEARCH_TIERS, SAVINGS_GUARANTEE, prioritySearchFee, PRIORITY_SEARCH_FEES, groupTravelFees, GROUP_SEGMENTS } from './revenue.js';
import { createSponsoredPlacement, listSponsoredPlacements, setSponsoredPlacementActive, removeSponsoredPlacement, sponsoredPlacementsFor, sponsoredPlacementRevenueGBP } from './store.js';
import { PLACEMENT_SECTIONS as PLACEMENT_SECTIONS_LIST } from './partners.js';
import { gatewayStatus, PROVIDER_TOKEN_RATES, aiMarginReport, MIN_AI_MARGIN } from './ai-gateway.js';
import { securityReport, opsDiagnostics, seoReport, marketingPlan, createPost, listPosts, getPost, ensureDailyPublish, startPublishingLoop } from './agents.js';
import { snapshot, flatSnapshot, hydrate, hydrateMerge } from './store.js';
import { initPersistence, isEnabled, persistenceBackend, persistenceInitError, persistenceSelfTest, load, save, saveMerge, scheduleSave, verifyFirebaseIdToken, firebaseAdminReady } from './persistence.js';
import { initMailer, isMailerEnabled, sendMail, bookingEmail, MAIN_CONTACT } from './mailer.js';
import { issueHumanChallenge, verifyHumanCheck, verifyLightHuman, rateLimitAuth, rateLimitLiveSearch } from './human-verify.js';
import { stripeEnabled, createCheckoutSession, createRefund, verifyStripeSignature, stripeDiagnostic, retrieveCheckoutSession } from './stripe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Trust exactly ONE proxy hop (Vercel / Cloud Run / the agent proxy sit directly
// in front). This makes req.ip the real client address that the platform appends
// to X-Forwarded-For, instead of whatever a caller stuffs into that header.
// Without this, X-Forwarded-For is fully attacker-controlled — defeating the
// per-IP auth rate limiter AND the anti-farming starter-ACU cap (rotate a fake
// IP per request → unlimited accounts, each with 50 free ACU).
app.set('trust proxy', 1);
// The real client IP for rate-limiting / anti-farming. req.ip honours the single
// trusted proxy hop above; never read X-Forwarded-For directly (spoofable).
const clientIp = (req) => req.ip || req.socket?.remoteAddress || null;
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

// LIVE persistence round-trip test — writes then reads a value through the real
// backend and returns the ACTUAL reason if it fails (bad service-account JSON,
// wrong DB URL, permissions, unreachable). Public + unauthenticated on purpose
// so it can be checked from a browser during setup; it exposes no secrets and no
// user data. e.g. open /api/persistence-test
app.get('/api/persistence-test', async (req, res) => {
  try {
    const result = await persistenceSelfTest();
    res.json({ ...result, serverless: IS_SERVERLESS, initError: persistenceInitError() });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Build marker — lets an operator confirm WHICH build is actually live (deploys
// can lag or silently fail). If /api/health shows an older `build` than the code
// you just pushed, your deployment is STALE — redeploy.
const BUILD_TAG = '2026-07-14-profile-save-visible-v78';
// Health check for Cloud Run / Firebase / load balancers.
app.get('/api/health', (req, res) => res.json({
  ok: true, service: '3jn-travel-os', build: BUILD_TAG,
  persistence: isEnabled(), persistenceBackend: persistenceBackend(),
  serverless: IS_SERVERLESS, email: isMailerEnabled(),
  liveData: liveDataEnabled(), liveFlights: liveFlightsEnabled(), liveHotels: liveHotelsEnabled(),
  liveSchedules: oagScheduleEnabled(),
}));

// Admin-login PRECHECK — visit in a browser to diagnose why admin login fails,
// WITHOUT being admin and WITHOUT a terminal. Reveals only yes/no config states
// (never any secret value). e.g. /api/auth/precheck?email=admin@3jntravel.com
app.get('/api/auth/precheck', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  const firebaseVerifyReady = firebaseAdminReady();
  const staffPinConfigured = Boolean(staffPin());
  const adminEmailsConfigured = String(process.env.ADMIN_EMAILS || '').trim().length > 0;
  // Whether a given email is on the admin allowlist is a SECRET (it would let an
  // attacker enumerate the owner addresses to target). Only reveal the per-email
  // allowlist verdict when the caller proves the staff PIN (header or ?pin=).
  // Without it, report only the environment's general readiness — never which
  // specific email is (or isn't) an admin.
  const pinProven = staffPinConfigured && (req.headers['x-staff-pin'] === staffPin() || req.query.pin === staffPin());
  const emailAllowlisted = email && pinProven ? isOwnerEmail(email) : null;
  // Plain-English verdict so a non-technical operator knows the exact fix.
  let readyForAdminLogin = firebaseVerifyReady && staffPinConfigured && adminEmailsConfigured;
  const problems = [];
  if (!firebaseVerifyReady) problems.push('FIREBASE_SERVICE_ACCOUNT is missing or invalid — the server cannot verify your sign-in (you would see "could not be verified").');
  if (!adminEmailsConfigured) problems.push('ADMIN_EMAILS is not set — no email can become admin.');
  else if (email && pinProven && !emailAllowlisted) problems.push(`${email} is NOT in ADMIN_EMAILS — this email will log in as a normal customer, not admin.`);
  if (!staffPinConfigured) problems.push('STAFF_ACCESS_PIN is not set — the second factor is missing, so privileged login is denied.');
  res.json({
    firebaseVerifyReady, persistence: isEnabled(), mailerReady: isMailerEnabled(),
    staffPinConfigured, adminEmailsConfigured, emailAllowlisted, liveMode: LIVE_MODE(),
    readyForAdminLogin: (email && pinProven) ? (readyForAdminLogin && emailAllowlisted === true) : readyForAdminLogin,
    verdict: problems.length ? problems : ['All admin-login prerequisites are set. If login still fails, the Firebase user (email+password) may not exist, or your browser is running a cached old version — hard-refresh.'],
  });
});

// Persist the store to Firebase RTDB shortly after any successful mutation
// (debounced). No-op when persistence is disabled (offline / no credentials).
// Also the serverless-safe scheduler tick: on Fridays the first request of the
// week triggers the automatic vendor payout run (+ monthly top-seller award).
// Startup readiness: until the persisted store has loaded, block MUTATING
// requests and suppress saves. A write that lands before hydrate() replaces the
// collections would be silently erased, and an early save would persist an empty
// store over good data. Reads may proceed. Tests run on a fresh store (ready).
let storeReady = process.env.NODE_ENV === 'test';
// A promise that RESOLVES the moment the initial Firebase load settles. Mutating
// requests await THIS (bounded) instead of being turned away with a 503 — the
// load takes ~1-2s, so the user just waits a beat rather than seeing "the
// service is loading, please retry". Set by initPersistence below; a resolved
// promise by default (tests / no persistence → nothing to wait for).
let storeReadyPromise = Promise.resolve();
// Resolve when ready, or after `ms`, whichever comes first — so a genuinely
// hung load can never wedge every write forever (we then fail soft below).
function waitForStoreReady(ms = 8000) {
  if (storeReady) return Promise.resolve(true);
  return Promise.race([
    storeReadyPromise.then(() => true),
    new Promise((r) => setTimeout(() => r(storeReady), ms)),
  ]);
}
// The in
// On a serverless host the instance FREEZES the moment it sends a response, so a
// debounced/background save (setTimeout) never runs and the write is lost — the
// account/booking vanishes and the user is logged out on the next request. When
// serverless, flush to Firebase SYNCHRONOUSLY before the response is sent so the
// write always completes. Long-lived hosts keep the efficient debounced save.
// Detect a serverless / freeze-between-requests host so we flush SYNCHRONOUSLY
// before responding (a debounced save is lost when the instance freezes → the
// #1 cause of "my payment/ACU/profile didn't save"). Covers the common
// providers; FORCE_SERVERLESS_PERSIST=true is a manual override for any host not
// auto-detected (safe to set anywhere — it only makes saves synchronous). When
// a durable store is configured but we can't tell the host is long-lived, we
// DEFAULT to the safe synchronous path rather than risk silent data loss.
const IS_SERVERLESS = !!(
  process.env.FORCE_SERVERLESS_PERSIST === 'true' ||
  process.env.VERCEL || process.env.K_SERVICE || process.env.FUNCTION_TARGET ||
  process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_EXECUTION_ENV || process.env.LAMBDA_TASK_ROOT ||
  process.env.NETLIFY || process.env.FLY_APP_NAME || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT ||
  process.env.DENO_DEPLOYMENT_ID || process.env.CF_PAGES || process.env.NOW_REGION
);
// SERVERLESS persistence path (read-modify-write + rehydrate). Gated on real
// detection: forcing it on a host whose durable store is stale/empty makes the
// pre-handler LOAD overwrite working in-memory accounts (a lockout). The
// synchronous SAVE below is what prevents write-loss; it does NOT require the
// risky pre-handler load, so it is applied on its own condition.
app.use(async (req, res, next) => {
  try { maybeRunFridayPayouts(); } catch { /* payouts must never break a request */ }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    // Don't turn the user away while the store loads — WAIT for it (bounded).
    // The load settles in ~1-2s; awaiting it here means the write just proceeds
    // a beat later instead of failing with "the service is loading". Only if the
    // load is genuinely stuck past the timeout do we fall back to the 503.
    if (!storeReady) {
      await waitForStoreReady();
      if (!storeReady) return res.status(503).json({ error: 'starting-up', message: 'The service is loading — please retry in a moment.' });
    }
    // KNOWN-GOOD serverless path: read-modify-write. Hydrate the latest store
    // before mutating (so this instance sees other instances' changes and never
    // clobbers them), then flush synchronously before the response.
    if (IS_SERVERLESS && isEnabled()) {
      try { const snap = await load(); if (snap) hydrate(snap); } catch { /* keep memory */ }
      // Snapshot the store BEFORE the handler runs. Many POSTs are effectively
      // read-only (search, telemetry, chat, checkout-session creation) — if the
      // handler changed nothing, we must NOT do a Firebase write, or every such
      // request pays a full-store save it doesn't need (cost + amplifiable DoS).
      let beforeStr = '';
      try { beforeStr = JSON.stringify(flatSnapshot()); } catch { beforeStr = ''; }
      const origJson = res.json.bind(res);
      res.json = (body) => {
        let flat = null, afterStr = '';
        if (res.statusCode < 400) {
          try { flat = flatSnapshot(); afterStr = JSON.stringify(flat); } catch { flat = null; }
        }
        if (res.statusCode < 400 && flat && afterStr !== beforeStr) {
          // Something actually changed — MERGING write (never deletes records
          // other instances added), flushed synchronously before the response.
          Promise.race([saveMerge(flat).catch(() => {}), new Promise((r) => setTimeout(r, 4000))])
            .finally(() => origJson(body));
        } else {
          // Nothing changed (or an error response) — skip the write entirely.
          origJson(body);
        }
        return res;
      };
    } else {
      res.on('finish', () => { if (res.statusCode < 400) scheduleSave(snapshot); });
    }
  }
  next();
});

// Serverless freshness: a warm instance hydrates its store once at cold start and
// never re-reads Firebase, so data created/updated on ANOTHER instance is invisible
// here — a signed-in user looks "not found" (403 / logout), and a newly registered
// customer never appears in the admin lists. Keep every instance fresh: re-hydrate
// from Firebase when this instance can't find the caller's account, OR periodically
// (every few seconds) so cross-instance changes converge quickly.
let rehydrating = false;
let lastRehydrateAt = 0;
app.use(async (req, res, next) => {
  const uid = req.headers['x-user-id'];
  if (IS_SERVERLESS && isEnabled() && storeReady && !rehydrating) {
    const missingCaller = uid && !getUser(uid);
    const stale = Date.now() - lastRehydrateAt > 5000;
    if (missingCaller || stale) {
      rehydrating = true;
      try { const snap = await load(); if (snap) hydrate(snap); } catch { /* keep serving from memory */ }
      lastRehydrateAt = Date.now();
      rehydrating = false;
    }
  }
  next();
});

// Resolve the active user from a header (prototype "auth").
// Overlay admin role from the ADMIN_EMAILS allowlist. This is computed from the
// environment on EVERY request, so an allowlisted owner is admin consistently on
// every (stateless / serverless) instance — even if a stored role change hasn't
// propagated across instances. The env allowlist is the source of truth for owner
// admin; it never DEMOTES (only promotes), so normal roles are untouched.
function applyOwnerRole(user, pinOk = false) {
  // Promote an ADMIN_EMAILS owner to admin when a SECOND factor is present:
  //  - the request carries the valid staff PIN (pinOk) — STATELESS, so it works
  //    on every serverless instance the moment the PIN is supplied (this is the
  //    reliable path; the frontend persists the PIN and sends it on every call), OR
  //  - the account is emailVerified (set only by the Firebase bridge / PIN
  //    elevation) — a durable flag for a verified owner.
  // The email alone is never enough, and an owner-email account can't be forged:
  // public signup and profile email-edits both refuse owner emails, and the
  // Firebase bridge requires a verified token. When no STAFF_ACCESS_PIN is
  // configured, staffPinOk() is true by design (dev/prototype) and the allowlist
  // promotes on its own — matching the original robust behaviour.
  if (user && isOwnerEmail(user.email) && user.role !== 'admin' && (pinOk || user.emailVerified)) {
    return { ...user, role: 'admin' };
  }
  return user;
}
function currentUser(req) {
  const uid = req.headers['x-user-id'];
  const u = uid ? getUser(uid) : null;
  return applyOwnerRole(u, staffPinOk(req));
}

// A booking with NO owner (userId null) must not be readable by an anonymous
// caller — its passport/passenger PII would leak by id enumeration. The creator
// already holds the object from the POST response; anything else needs admin.
// (The app always provisions a user before booking, so this only blocks abuse.)
function ownerlessBookingBlocked(req, res, booking) {
  if (booking.userId) return false; // owned bookings use the normal owner check
  const user = currentUser(req);
  if (user && (user.allAccess || user.role === 'admin')) return false;
  res.status(403).json({ error: 'not-your-booking' });
  return true;
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
// ADMIN_EMAILS is the ONLY way to mint a real admin in production (public signup
// can never self-elevate). Any email in this comma-separated allowlist IS an admin
// on every request (env-based, so it's consistent across serverless instances).
// The two factors are the allowlist (env, not user-settable) + an authenticated
// session for that email (Firebase password), so knowing the email alone is never
// enough. e.g.  ADMIN_EMAILS=info@3jntravel.com,ops@3jntravel.com
const isOwnerEmail = (email) => {
  const list = String(process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const e = String(email || '').trim().toLowerCase();
  return !!e && list.includes(e);
};
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
    // correct role/user id is not enough (ids are not secrets). An allowlisted
    // OWNER (ADMIN_EMAILS) is exempt: their env-allowlist + authenticated session
    // is already the second factor, so they don't also need the PIN (this is what
    // kept the owner locked out of admin API calls).
    if (roles.some((r) => PRIVILEGED_ROLES.has(r)) && !isOwnerEmail(u.email) && !staffPinOk(req)) {
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

// Escape a string for safe interpolation into outbound HTML email.
function htmlEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// OWNERSHIP GUARD: the caller must be the account identified by `ownerId`,
// or an all-access/admin. Returns the caller on success; writes a 401/403 and
// returns null otherwise. Used on every endpoint that reads/mutates data keyed
// by a user id in the URL (ids are enumerable — they are NOT secrets).
function requireOwner(req, res, ownerId) {
  const u = currentUser(req);
  if (!u) { res.status(401).json({ error: 'auth-required' }); return null; }
  if (u.id !== ownerId && !u.allAccess && u.role !== 'admin') {
    res.status(403).json({ error: 'not-yours', message: 'You can only access your own account data.' });
    return null;
  }
  return u;
}

// Wrap handlers so a thrown error always returns clean JSON — never the empty
// "{}" serialization failure the previous build suffered from.
const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error('[api error]', req.path, err);
    // Log the detail server-side, but never leak internal field names / code
    // shape to the client in production — a generic message only. Dev/test keep
    // the detail for debugging.
    const detail = process.env.NODE_ENV === 'production' ? undefined : String(err.message || err);
    res.status(500).json({ error: 'internal', ...(detail ? { message: detail } : {}) });
  }
};

// ---- Auto-ticketing: create the Duffel order after payment (issue the ticket)
// Is the booking fully paid (total covered by payments)? Instalment bookings
// are NOT fully paid until the final instalment lands.
function bookingFullyPaid(booking) {
  const total = booking.option?.pricing?.local?.total || 0;
  // Count ONLY plan-funding payments (deposit/instalment/full) — a booking
  // change-charge must NOT push a still-owed instalment plan to "fully paid" and
  // release the ticket/room/deal early.
  const paid = planPaid(booking);
  return total > 0 && paid + 0.01 >= total;
}
// Email the FULL branded booking document (the same printable, "Save as PDF"
// record shown in the Console) once a booking is paid IN FULL — on top of the
// Console copy. Idempotent (claims a flag before the await), so a redelivered
// webhook or a repeated call sends it exactly once. Fires only on a COMPLETED
// booking: fully paid, or a pay-in-full booking with no outstanding instalment.
async function emailBookingConfirmation(booking) {
  if (!booking || booking.confirmationEmailSent) return;
  const completed = bookingFullyPaid(booking) || (!booking.instalment && booking.pointsAwarded);
  if (!completed) return;
  const lead = booking.leadTraveller || booking.lead || {};
  // Prefer the traveller's own email; fall back to the account owner's email so a
  // booking made without a captured traveller email STILL gets its confirmation
  // PDF (the customer is signed in, so we always have an address to reach them).
  const to = lead.email || booking.lead?.email || (booking.userId ? getUser(booking.userId)?.email : null);
  if (!to) return;
  booking.confirmationEmailSent = true; // claim before await → send-once
  try {
    const sym = booking.option?.pricing?.symbol || '£';
    const html = bookingDocument(booking, { user: null, currencySymbol: sym });
    const ref = booking.fulfilment?.pnr || booking.id;
    await sendMail({
      to,
      subject: `Your 3JN booking confirmation — ${ref}`,
      text: `Your ${booking.option?.tier || ''} trip is confirmed and paid in full (3JN reference ${booking.id}). Your full booking document — flights, stay, transfers and everything included — is in this email and in your Console. Open it and use your browser's Print → "Save as PDF" to keep a PDF copy.`,
      html,
    });
    recordAudit({ actor: 'system', role: 'system', action: 'booking.confirmation-emailed', entity: 'booking', entityId: booking.id, summary: `full document emailed to ${to}` });
  } catch (e) { booking.confirmationEmailSent = false; console.error('[confirm-email]', e?.message || e); }
}
// Ticketing failed AFTER money was captured. Actually refund the customer (not
// just tell them we did — there was no refund code before), and ALWAYS raise an
// ops ticket so a human reconciles if the auto-refund can't fire (e.g. multiple
// PaymentIntents from instalments, or Stripe unreachable). Never silently strand
// a paid, unticketed customer.
async function failTicketingWithRefund(booking, reason) {
  const ful = (booking.fulfilment = booking.fulfilment || {});
  ful.ticketing = 'failed'; ful.reason = reason; ful.needsRefund = true;
  let refunded = false;
  if (stripeEnabled() && booking.stripePaymentIntent) {
    const r = await createRefund({ paymentIntentId: booking.stripePaymentIntent }).catch(() => ({ ok: false }));
    if (r.ok) {
      refunded = true; ful.refundId = r.refundId; ful.refundedAt = new Date().toISOString();
      try { recordPayment(booking.id, { type: 'refund', amount: -((r.amount || 0) / 100), gateway: 'stripe', reference: `refund:${r.refundId}` }); } catch {}
    }
  }
  try { createSupportTicket({ userId: booking.userId, intent: 'ops-refund', message: `Ticketing FAILED for booking ${booking.id} (${reason}). ${refunded ? `Auto-refund issued (${ful.refundId}).` : 'AUTO-REFUND DID NOT FIRE — refund the customer manually and check for partial/instalment captures.'}`, reason: 'ticketing-failed' }); } catch {}
  recordAudit({ actor: 'system', role: 'system', action: 'ticketing.failed', entity: 'booking', entityId: booking.id, summary: `${reason}${refunded ? ' · refunded' : ' · ops-refund-queued'}` });
  if (booking.userId) pushNotification(booking.userId, { type: 'warning', icon: '⚠️', title: 'Refund in progress', body: `We couldn't issue your ticket (${reason}). ${refunded ? 'Your payment has been refunded in full.' : 'Our team is processing your full refund now — you will get a confirmation shortly.'}` });
}

// The passenger manifest is short of the number of seats on the fare (a group
// or family flight where not every traveller's name was captured). NEVER
// fabricate names — a ticket issued as "Guest2 Traveller" is a denied-boarding
// at the airport. Instead HOLD the booking for ops, ask the customer for the
// missing traveller details, and let a human complete the manifest before any
// ticket is issued. No refund: the booking is valid, it just needs names.
async function failManifestToOps(booking, offerCount, manifestCount) {
  const ful = (booking.fulfilment = booking.fulfilment || {});
  if (ful.ticketing === 'manifest-hold') return; // idempotent
  ful.ticketing = 'manifest-hold';
  ful.reason = `manifest-incomplete:${manifestCount}/${offerCount}`;
  ful.manifestHeldAt = new Date().toISOString();
  try { createSupportTicket({ userId: booking.userId, intent: 'ops-manifest', message: `Booking ${booking.id} is paid but the passenger manifest is incomplete (${manifestCount} of ${offerCount} names). Collect the full traveller list from the customer, complete the manifest, then release for ticketing. DO NOT issue with placeholder names.`, reason: 'manifest-incomplete' }); } catch {}
  recordAudit({ actor: 'system', role: 'system', action: 'ticketing.manifest-hold', entity: 'booking', entityId: booking.id, summary: `${manifestCount}/${offerCount} names — held for ops` });
  if (booking.userId) pushNotification(booking.userId, { type: 'info', icon: '📝', title: 'One more step — traveller names', body: `Your booking is secured. We just need the full name (as on passport) for every traveller before we can issue tickets. Please add them in your Console or reply to our team — your seats are held.` });
}

// The booking → ticket lifecycle (the model: WE book, WE issue the ticket).
//   • Pay in full  → issue the ticket now (Duffel order, instant).
//   • Instalments  → HOLD the fare now (Duffel hold order); issue the ticket
//     automatically when the final instalment is paid.
async function autoTicketFlight(booking) {
  // Kiwi Tequila (LCC) fares have a bookingToken instead of a Duffel offerId.
  // They are ticketed by the OPS DESK through Kiwi's booking flow — money is
  // captured only after check_flights re-validation, and the customer is told
  // exactly what happens next. Never silent, never fabricated.
  const lccFlight = (booking.option?.components || []).find((c) => c.type === 'flight' && c.live && c.details?.bookingToken && !c.details?.offerId);
  if (lccFlight) {
    const ful = (booking.fulfilment = booking.fulfilment || {});
    if (ful.ticketing === 'issued' || ful.ticketing === 'ops-queue') return;
    ful.source = 'kiwi-tequila';
    ful.bookingToken = lccFlight.details.bookingToken;
    ful.opsDeepLink = lccFlight.details.deepLink || null;
    // DEPOSIT / INSTALMENT: never release the ticket on a part-payment. Reserve
    // the fare and HOLD — the ops desk issues the ticket ONLY once the balance is
    // paid in full. (The final instalment re-fires this handler, and by then
    // bookingFullyPaid is true, so it falls through to the ops-queue below.)
    if (!bookingFullyPaid(booking)) {
      if (ful.ticketing === 'ops-hold') return; // idempotent
      ful.ticketing = 'ops-hold';
      ful.heldAt = new Date().toISOString();
      recordAudit({ actor: 'system', role: 'system', action: 'ticketing.deposit-hold', entity: 'booking', entityId: booking.id, summary: `${lccFlight.supplier} — held on deposit, ticket issues on full payment` });
      if (booking.userId) pushNotification(booking.userId, { type: 'info', icon: '🎟️', title: 'Seats reserved — pay the balance to ticket', body: `Your ${lccFlight.supplier} fare is reserved at the price you locked. Your e-ticket is issued the moment the balance is paid in full — that protects both your seat and your price.` });
      return;
    }
    // FULLY PAID: queue the ops desk to issue the ticket.
    ful.ticketing = 'ops-queue';
    ful.queuedAt = new Date().toISOString();
    createSupportTicket({
      userId: booking.userId, intent: 'ops-ticketing',
      message: `Issue LCC ticket for booking ${booking.id} — ${lccFlight.supplier}, paid IN FULL · token ${String(lccFlight.details.bookingToken).slice(0, 24)}…`,
      reason: 'LCC fare (Kiwi Tequila) — ticket via Kiwi booking flow',
    });
    recordAudit({ actor: 'system', role: 'system', action: 'ticketing.ops-queued', entity: 'booking', entityId: booking.id, summary: `${lccFlight.supplier} via Kiwi Tequila — ops desk issues` });
    if (booking.userId) pushNotification(booking.userId, { type: 'success', icon: '🎟️', title: 'Booking confirmed — ticket on its way', body: `Your ${lccFlight.supplier} fare is confirmed at the charged price. Our ops desk is issuing the ticket now — your airline reference arrives shortly (normally under an hour).` });
    return;
  }
  const flight = (booking.option?.components || []).find((c) => c.type === 'flight' && c.live && c.details?.offerId);
  if (!flight || !liveFlightsEnabled()) return;
  const ful = () => (booking.fulfilment = booking.fulfilment || {});
  // CONCURRENCY CLAIM: two redelivered webhooks can enter here at the same time;
  // the async createDuffelOrder means both could pass an 'issued' check that is
  // only set AFTER the await → double order/charge. Claim the booking
  // SYNCHRONOUSLY (before any await) so only the first proceeds.
  const stage = booking.fulfilment?.ticketing;
  if (stage === 'issued' || stage === 'issuing') return;
  // BUILD the passenger manifest and REFUSE to fabricate names — a group ticket
  // issued with placeholder names ("Guest2 Traveller") means denied boarding.
  const offerPax = flight.details.offerPassengers || [];
  const manifest = Array.isArray(booking.travellers) && booking.travellers.length ? booking.travellers : (booking.leadTraveller ? [booking.leadTraveller] : []);
  if (offerPax.length > 1 && manifest.filter((t) => t && String(t.fullName || '').trim()).length < offerPax.length) {
    await failManifestToOps(booking, offerPax.length, manifest.length);
    return;
  }
  // Booking contact for Duffel (required): the account owner's email + profile
  // mobile, so even a booking with no traveller phone still tickets.
  const acct = booking.userId ? getUser(booking.userId) : null;
  const contactEmail = booking.leadTraveller?.email || booking.lead?.email || acct?.email || '';
  const contactPhone = booking.leadTraveller?.phone || booking.lead?.phone || acct?.travelProfile?.mobile || acct?.travelProfile?.secondaryPhone || '';
  const passengers = duffelOrderPassengers(offerPax, booking.leadTraveller || booking.lead || {}, { departureDate: flight.details.outbound?.date, travellers: booking.travellers, contactEmail, contactPhone });
  const fullyPaid = bookingFullyPaid(booking);

  // --- INSTALMENT: hold the fare (once), issue later on completion ----------
  if (!fullyPaid) {
    if (booking.fulfilment?.holdOrderId || booking.fulfilment?.ticketing === 'issued' || booking.fulfilment?.ticketing === 'holding') return;
    ful().ticketing = 'holding'; // claim before the await
    const check = await validateDuffelOffer(flight.details.offerId);
    if (check.ok && (check.expired || check.live === false)) {
      await failTicketingWithRefund(booking, 'offer-expired-before-hold');
      return;
    }
    const hold = await createDuffelHoldOrder({ offerId: flight.details.offerId, passengers, idempotencyKey: `hold:${booking.id}` });
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
  // IDEMPOTENCY: Stripe legitimately re-delivers checkout.session.completed. If
  // the ticket is already issued, stop — otherwise we'd create a SECOND Duffel
  // order (double ticket + double charge), or re-pay an already-paid hold order
  // and wrongly flag a correctly-ticketed booking for refund.
  if (booking.fulfilment?.ticketing === 'issued') return;
  let order;
  if (booking.fulfilment?.holdOrderId) {
    // Pay off the held order → issues the ticket.
    const pay = await payDuffelOrder({ orderId: booking.fulfilment.holdOrderId, amount: flight.details.liveAmount, currency: flight.details.liveCurrency || 'GBP', idempotencyKey: `pay:${booking.id}` });
    order = pay.ok ? { ok: true, order: { id: booking.fulfilment.holdOrderId, bookingReference: pay.order.bookingReference || booking.fulfilment.pnr, ticketNumbers: pay.order.ticketNumbers } } : pay;
  } else {
    const check = await validateDuffelOffer(flight.details.offerId);
    if (check.ok && (check.expired || check.live === false)) {
      await failTicketingWithRefund(booking, 'offer-expired-before-ticketing');
      return;
    }
    order = await createDuffelOrder({ offerId: flight.details.offerId, passengers, paymentAmount: check.amount || flight.details.liveAmount, paymentCurrency: check.currency || flight.details.liveCurrency || 'GBP', idempotencyKey: `order:${booking.id}` });
  }
  if (!order.ok) {
    await failTicketingWithRefund(booking, order.error || 'ticket-issue-failed');
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

// AUTO-BOOK the hotel via Duffel Stays once payment is captured — the hotel
// equivalent of autoTicketFlight. Idempotent; on any failure it hands the room
// to the ops desk (support ticket) so a paid stay is never left unbooked.
async function autoBookStays(booking) {
  const hotel = (booking.option?.components || []).find((c) => c.type === 'hotel' && c.live && c.details?.staysSearchResultId);
  if (!hotel || !duffelStaysEnabled()) return;
  const ful = (booking.fulfilment = booking.fulfilment || {});
  if (ful.stayStatus === 'booked') return; // idempotent — webhooks redeliver
  // DEPOSIT / INSTALMENT: don't commit the room on a part-payment. Reserve only;
  // the room is actually booked once the balance is paid in full (the final
  // instalment re-fires this handler with bookingFullyPaid === true).
  if (!bookingFullyPaid(booking)) {
    if (ful.stayStatus !== 'reserved') {
      ful.stayStatus = 'reserved';
      recordAudit({ actor: 'system', role: 'system', action: 'stays.deposit-hold', entity: 'booking', entityId: booking.id, summary: `${hotel.supplier} — reserved on deposit, books on full payment` });
    }
    return;
  }
  const lead = booking.leadTraveller || booking.lead || {};
  // Build the FULL guest list — Duffel Stays rejects a room booked for fewer
  // guests than the rate was quoted for. Use every named traveller on the
  // booking (a family/group stay), falling back to the lead when that's all we
  // have. Names are split into given/family the same way the flight manifest is.
  const toGuest = (t) => {
    const parts = String(t?.fullName || '').trim().split(/\s+/).filter(Boolean);
    return { given_name: parts[0] || 'Guest', family_name: parts.slice(1).join(' ') || (parts[0] ? parts[0] : 'Traveller') };
  };
  const named = (Array.isArray(booking.travellers) && booking.travellers.length ? booking.travellers : [lead]).filter((t) => t && String(t.fullName || '').trim());
  const guests = (named.length ? named : [lead]).map(toGuest);
  const r = await bookDuffelStay({
    searchResultId: hotel.details.staysSearchResultId,
    guests, email: lead.email, phone: lead.phone,
    maxAmountUSD: hotel.priceUSD || null,
  }).catch((e) => ({ ok: false, error: e?.message || 'exception' }));
  if (r.ok) {
    ful.stayStatus = 'booked';
    ful.stayReference = r.reference;
    ful.stayBookingId = r.bookingId;
    hotel.details.confirmation = r.reference;
    hotel.details.fulfilledVia = 'auto:stays-api';
    recordAudit({ actor: 'system', role: 'system', action: 'stays.booked', entity: 'booking', entityId: booking.id, summary: `hotel ref ${r.reference} · ${hotel.supplier}` });
    if (booking.userId) pushNotification(booking.userId, { type: 'success', icon: '🏨', title: 'Hotel confirmed', body: `${hotel.supplier} is booked — confirmation ${r.reference}. Details are in your Console.` });
    if (lead.email) { try { await sendMail({ to: lead.email, subject: `Your hotel is confirmed — ${r.reference}`, text: `${hotel.supplier} is booked. Confirmation: ${r.reference}.`, html: `<p>${htmlEsc(hotel.supplier)} is booked.</p><p><strong>Confirmation:</strong> ${htmlEsc(r.reference)}</p>` }); } catch {} }
  } else {
    // Fail SAFE: hand the paid room to the ops desk to complete on Duffel.
    ful.stayStatus = 'ops-fallback';
    ful.stayError = r.error;
    try { createSupportTicket({ userId: booking.userId, intent: 'ops-hotel', message: `Book hotel for booking ${booking.id} — Duffel Stays auto-book failed (${r.error}). Complete it manually on the Duffel dashboard (search result ${hotel.details.staysSearchResultId}).`, reason: 'stays-auto-book-failed' }); } catch {}
    recordAudit({ actor: 'system', role: 'system', action: 'stays.ops-fallback', entity: 'booking', entityId: booking.id, summary: `auto-book failed (${r.error}) → ops desk` });
    if (booking.userId) pushNotification(booking.userId, { type: 'info', icon: '🏨', title: 'Hotel being confirmed', body: 'Your payment is secured — our team is finalising your hotel booking now and your confirmation will appear shortly.' });
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
    // Commercial storefront switch: when LIVE_MODE is on, the customer-facing
    // site leads with the curated Deals catalogue and hides the AI estimator
    // planner/marketplace (so no fabricated trip is ever shown). Staff keep
    // full access. stripeReady tells the UI whether card checkout is available.
    liveMode: LIVE_MODE(),
    stripeReady: stripeEnabled(),
    // One-glance supplier status so an operator can see WHY trips are estimated
    // without a terminal: is Duffel connected, are live flights/hotels flowing?
    suppliers: {
      duffelMode: duffelMode(),           // 'live' | 'test' | 'off'
      flightsLive: liveFlightsEnabled(),
      hotelsLive: liveHotelsEnabled(),
      stripe: stripeEnabled() ? (String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live') ? 'live' : 'test') : 'off',
      stripeWebhook: !!process.env.STRIPE_WEBHOOK_SECRET,
    },
    // Plain-English self-diagnosis of a config that would silently block testing
    // or sales — surfaced to the operator so a misconfig never wastes their time.
    configWarning: (() => {
      const dm = duffelMode(); // 'live' | 'test' | 'off'
      if (LIVE_MODE() && dm === 'test') return { severity: 'blocker', code: 'livemode-with-test-token', message: 'LIVE_MODE is ON but your Duffel token is a TEST key — so Duffel (flights AND hotels) is switched OFF and EVERY trip shows as an unpayable estimate. To TEST end-to-end: set LIVE_MODE=false and keep the test token. To SELL for real: use a live duffel_live_… token.' };
      if (dm === 'off') return { severity: 'warn', code: 'no-duffel', message: 'No Duffel token set — flights and hotels are estimates only (no bookable price). Set DUFFEL_TOKEN to enable live inventory.' };
      if (!stripeEnabled()) return { severity: 'warn', code: 'no-stripe', message: 'Stripe is not configured — card checkout is unavailable. Set STRIPE_SECRET_KEY (and STRIPE_WEBHOOK_SECRET so tickets issue and the PDF sends after payment).' };
      if (stripeEnabled() && !process.env.STRIPE_WEBHOOK_SECRET) return { severity: 'warn', code: 'no-webhook', message: 'Stripe is on but STRIPE_WEBHOOK_SECRET is not set — a payment would capture but the ticket would never issue and no confirmation PDF would send. Add the webhook secret.' };
      return null;
    })(),
  });
}));

// ---- Inspire Me: "I don't know where to go" -------------------------------
// The traveller describes what they want in plain English; the OS returns the 3
// CHEAPEST matching destinations (country + city) for each of the next
// 30/60/120/180 days. Origin-aware, distance-derived estimates — a real fare is
// confirmed when they run the full search on the chosen destination + date.
app.post('/api/inspire', safe((req, res) => {
  const body = req.body || {};
  const context = detectContext(req, { country: body.country, currencyCountry: body.country });
  const cur = context.currency || { code: 'GBP', symbol: '£', rateFromUSD: 0.79 };
  // Departure airport: from a named city if given, else the traveller's country.
  // Coerce to string so a numeric/object `origin` can't throw in resolveOrigin.
  const originResolved = (body.origin != null && body.origin !== '') ? resolveOrigin(String(body.origin)) : null;
  const countryOrigin = originForCountry(context.country) || { airport: 'LHR', city: 'London' };
  const originCode = (originResolved?.airport) || countryOrigin.airport || 'LHR';
  const originCity = originResolved?.city || countryOrigin.city || 'your city';
  const pax = Math.max(1, Math.min(9, Math.round(Number(body.travellers) || 1)));
  const result = inspireDestinations({ text: body.text, originCode, travellers: pax, perPerson: !!body.perPerson });
  // Convert USD → the traveller's currency and stamp a real best-departure date
  // (nudged to a cheaper mid-week day) per option.
  const now = new Date();
  const stampDate = (offsetDays) => {
    const d = new Date(now.getTime() + offsetDays * 86400000);
    const day = d.getUTCDay();
    if (day === 0) d.setUTCDate(d.getUTCDate() + 2); // Sun → Tue
    else if (day === 6) d.setUTCDate(d.getUTCDate() + 3); // Sat → Tue
    return d.toISOString().slice(0, 10);
  };
  const windows = {};
  for (const w of INSPIRE_WINDOWS) {
    windows[w] = (result.windows[w] || []).map((o) => ({
      code: o.code, city: o.city, country: o.country, countryName: o.countryName,
      tags: o.tags, matchedTags: o.matchedTags, travellers: o.travellers,
      fromLocal: Math.round(o.fromUSD * cur.rateFromUSD),
      perSeatLocal: Math.round(o.perSeatUSD * cur.rateFromUSD),
      bestDate: stampDate(o.offsetDays),
    }));
  }
  res.json({ windows, windowsOrder: INSPIRE_WINDOWS, currency: cur, matchedTags: result.matchedTags, originCity, originCode });
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
  // Clearly-LABELLED sponsored placements for the destination-pages section
  // (never reorders the catalogue — a separate marked strip).
  res.json({ destinations: catalog, sponsored: sponsoredPlacementsFor('destination pages'), addOns: ['Tours', 'Local drivers', 'Photographers', 'Guides', 'Restaurant bookings', 'Event tickets', 'Airport pickup', 'Translators', 'eSIM data', 'Travel insurance'] });
}));

// ---- Sponsored placements (labelled supplier ads — a real revenue stream) ---
// Admin creates/pauses placements; they surface as a clearly-marked "Sponsored"
// strip in curated sections. HARD RULE (enforced in store): a placement never
// overrides the reliability floor or reorders the cheapest-reliable pick.
app.get('/api/admin/placements', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ placements: listSponsoredPlacements(), sections: PLACEMENT_SECTIONS_LIST, monthlyRevenueGBP: sponsoredPlacementRevenueGBP() });
}));
app.post('/api/admin/placements', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const { partner, section, destination, feeGBPMonth } = req.body || {};
  const r = createSponsoredPlacement({ partner, section, destination, feeGBPMonth });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
}));
app.patch('/api/admin/placements/:id', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const r = setSponsoredPlacementActive(req.params.id, req.body?.active !== false);
  if (!r.ok) return res.status(404).json(r);
  res.json(r);
}));
app.delete('/api/admin/placements/:id', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const r = removeSponsoredPlacement(req.params.id);
  if (!r.ok) return res.status(404).json(r);
  res.json(r);
}));

// ---- Priority search (paid fast/urgent/emergency scan tiers) ----------------
app.get('/api/search/priority-tiers', safe((req, res) => {
  const ctx = detectContext(req);
  const tiers = Object.entries(PRIORITY_SEARCH_FEES)
    .filter(([, t]) => !t.aliasOf)
    .map(([level, t]) => ({ level, feeGBP: t.feeGBP, feeLocal: Math.round(t.feeGBP / 0.79 * ctx.currency.rateFromUSD), note: t.note }));
  res.json({ tiers, currency: ctx.currency.code, symbol: ctx.currency.symbol });
}));
// Create a Stripe checkout for a paid priority-search tier (credential-gated).
app.post('/api/search/priority-checkout', safe(async (req, res) => {
  const fee = prioritySearchFee(req.body?.level);
  if (!fee.feeGBP) return res.json({ ok: true, level: fee.level, feeGBP: 0, note: 'Standard search is free — no payment needed.' });
  if (!stripeEnabled()) return res.status(400).json({ error: 'stripe-not-configured', level: fee.level, feeGBP: fee.feeGBP });
  const user = currentUser(req);
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const session = await createCheckoutSession({
    amountMinor: Math.round(fee.feeGBP * 100), currency: 'GBP',
    description: `3JN priority search — ${fee.level} (${fee.note})`,
    bookingId: `pri_${fee.level}`, userId: user?.id || '', customerEmail: user?.email,
    successUrl: `${origin}/?priority=${fee.level}&paid=1`, cancelUrl: `${origin}/?priority=0`,
  });
  if (!session.ok) return res.status(400).json(session);
  res.json({ ...session, level: fee.level, feeGBP: fee.feeGBP });
}));

// ---- Group travel quote (churches, schools, teams, diaspora groups) ---------
app.post('/api/group/quote', safe((req, res) => {
  const headcount = Math.max(1, Math.min(2000, Number(req.body?.headcount) || 10));
  const tripValueGBP = Math.max(0, Number(req.body?.tripValueGBP) || 0);
  const fees = groupTravelFees(headcount, tripValueGBP);
  const ctx = detectContext(req);
  res.json({
    headcount, tripValueGBP, segments: GROUP_SEGMENTS,
    ...fees,
    currency: ctx.currency.code, symbol: ctx.currency.symbol,
    contact: MAIN_CONTACT,
  });
}));

// ---- Contact form → emails info@3jntravel.com (reply-to sender) -----------
app.post('/api/contact', safe(async (req, res) => {
  // Each call emails the business inbox — rate-limit per IP so it can't be used
  // as an email bomb, and cap every field so a huge payload can't be relayed.
  const rl = rateLimitAuth(clientIp(req));
  if (!rl.ok) return res.status(429).json(rl);
  let { name, email, message } = req.body || {};
  if (!email || !message) return res.status(400).json({ error: 'email-and-message-required' });
  name = String(name || '').slice(0, 80);
  email = String(email).slice(0, 120);
  message = String(message).slice(0, 4000);
  const r = await sendMail({
    to: MAIN_CONTACT,
    replyTo: email,
    subject: `Contact form — ${name || email}`,
    text: `From: ${name || ''} <${email}>\n\n${message}`,
    html: `<p><strong>From:</strong> ${htmlEsc(name || '')} &lt;${htmlEsc(email)}&gt;</p><p>${htmlEsc(String(message))}</p>`,
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
app.post('/api/account', safe(async (req, res) => {
  const body = req.body || {};
  const ip = clientIp(req);
  const rl = rateLimitAuth(ip);
  if (!rl.ok) return res.status(429).json(rl);
  const check = body.humanCheck || {};
  const verdict = body.email ? verifyHumanCheck(check) : verifyLightHuman(check);
  if (!verdict.ok) return res.status(403).json({ ...verdict, human: false });
  // BOT DEFENCE: machine-generated names/emails, honeypot hits and disposable
  // domains are refused at the door. Conservative on purpose — a slightly
  // unusual name alone never blocks a real person.
  const bot = botSignupVerdict({ name: body.name, email: body.email, honeypot: check.website, elapsedMs: check.elapsedMs, interactions: check.interactions });
  if (bot.block) {
    recordAudit({ actor: 'bot-defence', role: 'system', action: 'signup.blocked', entity: 'user', entityId: body.email || '-', summary: bot.reasons.join(', ') });
    return res.status(403).json({ error: 'bot-suspected', reasons: bot.reasons, message: bot.message });
  }
  delete body.humanCheck;
  // Public signup can NEVER mint a privileged account — role/allAccess are
  // granted only through admin paths. Force a plain consumer.
  delete body.role; delete body.allAccess;
  delete body.emailVerified; // only the Firebase bridge / PIN elevation may set this
  delete body.signupIp; // caller can't spoof the anti-farming IP
  // An owner/admin email may only enter through the verified Firebase sign-in
  // bridge. Refuse to mint an owner-email account here so nobody can squat the
  // owner's address (which the admin overlay keys on) via unauthenticated signup.
  if (isOwnerEmail(body.email)) {
    return res.status(403).json({ error: 'use-admin-login', message: 'This email is reserved. Please sign in with your password on the admin login.' });
  }
  const user = createUser({ ...body, signupIp: ip }); // ip → per-IP starter-ACU cap
  await sendWelcomeEmail(user); // AWAIT: complete the send before the serverless freeze
  res.json({ user });
}));

// Welcome email on first registration. MUST be AWAITED by the caller before the
// response is sent: on a serverless host the instance freezes the moment the
// response goes out, which would kill an un-awaited (fire-and-forget) SMTP send
// before it completes — the classic "welcome email never arrives" bug. The
// transporter timeouts above bound the wait, so a slow/dead SMTP can't hang
// signup. Skips placeholder guest addresses and no-ops when SMTP isn't set.
async function sendWelcomeEmail(user) {
  try {
    const to = user?.email;
    if (!to || /@guest\.3jn$/i.test(to)) return { ok: false, skipped: true };
    const name = (user.name || 'traveller').split(' ')[0];
    return await sendMail({
      to,
      subject: 'Welcome to 3JN Travel OS ✈️',
      text: `Hi ${name}, welcome to 3JN Travel OS! Your account is ready — search flights, hotels and packages, earn loyalty points, and manage everything in your Console. Questions? Just reply to this email. — The 3JN team`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;background:#0a1020;color:#eef2fb;padding:26px;border-radius:12px">
        <h2 style="color:#d8b46a;margin:0 0 6px">Welcome to 3JN Travel OS ✈️</h2>
        <p>Hi ${htmlEsc(name)}, your account is ready.</p>
        <p style="color:#9aa6c4">Search flights, hotels and complete packages, earn loyalty points on every trip, and manage it all from your Console.</p>
        <p style="color:#6b7799;font-size:12px">Questions? Just reply to this email or contact info@3jntravel.com.<br/>Powered by Artificial Intelligence · Built for Better Travel.</p>
      </div>`,
    });
  } catch { return { ok: false }; /* welcome email is best-effort */ }
}

// OWNERSHIP: an account holds passport/PII — only the owner (or an all-access
// admin) may read it, and never another user's raw bookings.
app.get('/api/account/:id', safe(async (req, res) => {
  // FRESHNESS (must run BEFORE the auth check): a brand-new sign-in — or a profile
  // autosave — may have landed on ANOTHER serverless instance moments ago. If we
  // resolve the caller from THIS instance's memory first, a freshly-created
  // customer is wrongly seen as unauthenticated (401) and their console comes up
  // empty ("I signed in but can't reach my console"). Hydrate the latest store up
  // front, then resolve the caller, so cross-instance lag can't 401 a real user or
  // show a stale/empty profile. One load serves both the auth check and the read.
  if (IS_SERVERLESS && isEnabled()) {
    try { const snap = await load(); if (snap) hydrate(snap); } catch { /* serve from memory */ }
  }
  const caller = currentUser(req);
  if (!caller) return res.status(401).json({ error: 'auth-required' });
  if (caller.id !== req.params.id && !caller.allAccess && caller.role !== 'admin') {
    return res.status(403).json({ error: 'not-your-account' });
  }
  const stored = getUser(req.params.id);
  if (!stored) return res.status(404).json({ error: 'not-found' });
  // Overlay admin from the env allowlist so loading the site while signed in as
  // the owner reliably lands in admin — consistent on every serverless instance
  // (the staff PIN in the request is the stateless second factor).
  const user = applyOwnerRole(stored, staffPinOk(req));
  res.json({ user, bookings: listBookings(stored.id) });
}));

// Edit an account profile (name, email, bio, avatar, travel profile).
// OWNERSHIP: only the signed-in account itself (or an all-access admin) may
// edit — the Master Travel Profile holds passport data. Role changes are
// stripped here; roles are granted through admin paths only.
app.patch('/api/account/:id', safe((req, res) => {
  const caller = currentUser(req);
  if (!caller) return res.status(401).json({ error: 'auth-required' });
  if (caller.id !== req.params.id && !caller.allAccess && caller.role !== 'admin') {
    return res.status(403).json({ error: 'not-your-account', message: 'You can only edit your own profile.' });
  }
  const body = { ...(req.body || {}) };
  // Self-edits can NEVER change privilege — strip role AND allAccess (leaving
  // allAccess was a privilege-escalation hole: {allAccess:true} = instant admin).
  if (!caller.allAccess && caller.role !== 'admin') { delete body.role; delete body.allAccess; }
  // Nobody may set their email to an ADMIN_EMAILS owner address via a profile
  // edit — that would forge an owner-email account and (with the PIN) reach the
  // admin overlay. Owner emails only ever enter through the Firebase bridge.
  if (body.email && isOwnerEmail(body.email) && !isOwnerEmail(caller.email)) {
    return res.status(403).json({ error: 'reserved-email', message: 'That email address is reserved.' });
  }
  const user = updateUser(req.params.id, body);
  if (!user) return res.status(404).json({ error: 'not-found' });
  res.json({ user });
}));

// Provision one account per role (consumer/business/merchant/partner/admin).
// FULLY LOADED: each demo account ships with live data — memberships, ACU,
// bookings, pots, API keys, payment links, a published host listing and a
// populated visa queue — so every command centre demos end-to-end.
// A demo booking is a SHOWCASE FIXTURE, not a real customer transaction — the
// "Test Traveller" account. It must present as a fully-paid, confirmed, ticketed
// journey (with documents) INDEPENDENT of live supplier/payment keys, so the demo
// shows what a completed booking really looks like instead of an empty estimate.
// (Real customer bookings still correctly take no money on an estimate — this
// override applies ONLY to seeded demo accounts.)
function completeDemoBooking(booking) {
  if (!booking) return booking;
  const total = booking.option?.pricing?.local?.total || 0;
  booking.priceBasis = 'confirmed';        // a demo fixture we stand behind → payable
  booking.status = 'confirmed';
  booking.payments = [{ type: 'full', amount: total, gateway: 'demo', method: 'card', at: booking.createdAt || new Date().toISOString(), status: 'paid' }];
  booking.pointsAwarded = true;            // points seeded separately; don't double-count
  booking.awaitExternalCapture = false;
  const tail = String(booking.id).replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase() || 'DEMO01';
  booking.fulfilment = {
    ...(booking.fulfilment || {}),
    source: 'demo', demo: true,
    ticketing: 'issued',
    pnr: '3JN' + tail.slice(0, 3),
    ticketNumbers: ['SAMPLE-' + tail],     // clearly a sample e-ticket, not a real airline number
    issuedAt: booking.createdAt || new Date().toISOString(),
  };
  return booking;
}

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
    const booking = createBooking({ quoteId: quote.id, option, instalment: quote.instalment, userId, paymentMethod: 'card', lead: { fullName: getUser(userId)?.name, email: getUser(userId)?.email } });
    // Present the seeded demo journey as a completed, paid, ticketed booking.
    return completeDemoBooking(booking);
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
      // Stripe is the live payout rail until BitriPay ships, so the demo host
      // registers with bank details (paid out via Stripe).
      registerHost(h.id, { displayName: 'Demo Host', payoutMethod: 'Bank transfer', payout: { accountHolder: 'Demo Host', accountNumber: 'GB29DEMO60161331926819', bankName: 'Demo Bank UK', sortOrSwift: '601613', currency: 'GBP' } });
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
  // Fail closed whenever a staff PIN is configured (production always sets one)
  // OR we're in live mode — seeding demo identities into a live store must
  // require the PIN, not just live mode. Only a pure local dev box with no PIN
  // and not live may seed freely.
  if ((LIVE_MODE() || staffPin()) && (!staffPin() || !staffPinOk(req))) {
    return res.status(403).json({ error: 'demo-disabled', message: 'Demo accounts require the staff access PIN.' });
  }
  const accounts = seedAllRoles();
  const demoLoaded = fullyLoadDemoAccounts();
  // Staff-PIN protection: privileged demo identities are ONLY revealed when a
  // PIN is configured AND supplied. Critically, "no PIN configured" must NOT
  // unlock them — otherwise any anonymous caller would receive a working admin
  // id (the id IS the session credential in this architecture).
  const unlocked = !!staffPin() && staffPinOk(req);
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
  // A full-access account IS an admin credential, so this fails CLOSED: it needs
  // a configured staff PIN that is also supplied. Without a PIN set, "no gate"
  // must mean DENY (never mint an anonymous admin), regardless of LIVE_MODE.
  if (!staffPin() || !staffPinOk(req)) {
    return res.status(403).json({ error: 'staff-pin-required', message: 'Full-access demo accounts require the staff access PIN (set STAFF_ACCESS_PIN).' });
  }
  const user = createUser({ name: 'Full-Access Traveller', role: 'admin', allAccess: true });
  addPoints(user.id, 1250 - user.points); // land in Voyager tier (~1,250 pts)
  creditAcu(user.id, 10000, 'full-access-demo'); // funded so every paid feature works
  res.json({ user: getUser(user.id), note: 'Full-access account provisioned — every section unlocked.' });
}));

app.post('/api/account/:id/acu', safe(async (req, res) => {
  if (!requireOwner(req, res, req.params.id)) return;
  const pack = (req.body || {}).pack;
  // SEC-4: an ACU top-up is a PURCHASE. When Stripe is live it must be paid for
  // through Checkout — the wallet is credited only by the signed webhook. Never
  // hand out ACU (which unlock paid features and discounts) for free in
  // production. Offline/prototype (no Stripe) keeps the simulated instant credit.
  if (stripeEnabled()) {
    const p = ACU_PACKS[pack];
    if (!p) return res.status(400).json({ ok: false, error: 'invalid' });
    if (p.custom) return res.status(400).json({ ok: false, error: 'contact-sales', message: 'Enterprise ACU volume is priced individually — contact sales@3jntravel.com.' });
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const user = currentUser(req);
    const session = await createCheckoutSession({
      amountMinor: Math.round(p.gbp * 100), currency: 'gbp',
      description: `3JN Travel OS — ${p.name} (${p.acu} ACU)`,
      userId: req.params.id, customerEmail: user?.email,
      metadata: { kind: 'acu', pack, userId: req.params.id },
      successUrl: `${origin}/console?acu=1`, cancelUrl: `${origin}/console?acu=0`,
    });
    if (!session.ok) return res.status(400).json(session);
    return res.json({ ok: true, checkout: session.url, requiresPayment: true });
  }
  const result = buyAcu(req.params.id, pack);
  res.json(result);
}));

// ---- ACU Economy (spec §4): wallet view + typed transaction ledger --------
app.get('/api/account/:id/wallet', safe((req, res) => {
  if (!requireOwner(req, res, req.params.id)) return;
  const wallet = acuWallet(req.params.id);
  if (!wallet) return res.status(404).json({ error: 'unknown-user' });
  res.json({ wallet, transactions: acuTransactions(req.params.id) });
}));

// ---- Refundable search deposits (spec §6): place / list / refund ----------
// Deep £5 · Luxury £20 · Corporate £50 — refundable; a booking converts the
// deposit and deducts it from the final payment.
app.post('/api/account/:id/deposit', safe(async (req, res) => {
  if (!requireOwner(req, res, req.params.id)) return;
  const tier = (req.body || {}).tier || 'deep';
  const searchId = (req.body || {}).searchId || null;
  // A search deposit is real money that later comes OFF the booking total, so if
  // it is never charged the platform simply collects less on the trip (a loss).
  // Live mode: take it through Checkout and record it only on the signed webhook.
  if (stripeEnabled()) {
    const amountGBP = SEARCH_DEPOSIT_GBP[tier];
    if (!amountGBP) return res.status(400).json({ ok: false, error: 'invalid', schedule: SEARCH_DEPOSIT_GBP });
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const user = currentUser(req);
    const session = await createCheckoutSession({
      amountMinor: Math.round(amountGBP * 100), currency: 'gbp',
      description: `3JN Travel OS — refundable ${tier} search deposit`,
      userId: req.params.id, customerEmail: user?.email,
      metadata: { kind: 'deposit', tier, userId: req.params.id, searchId: searchId || '' },
      successUrl: `${origin}/?deposit=1`, cancelUrl: `${origin}/?deposit=0`,
    });
    if (!session.ok) return res.status(400).json(session);
    return res.json({ ok: true, checkout: session.url, requiresPayment: true, schedule: SEARCH_DEPOSIT_GBP });
  }
  const result = placeSearchDeposit({ userId: req.params.id, tier, searchId });
  if (!result.ok) return res.status(400).json({ ...result, schedule: SEARCH_DEPOSIT_GBP });
  res.json({ ...result, schedule: SEARCH_DEPOSIT_GBP });
}));
app.get('/api/account/:id/deposits', safe((req, res) => {
  if (!requireOwner(req, res, req.params.id)) return;
  res.json({ deposits: listSearchDeposits(req.params.id), schedule: SEARCH_DEPOSIT_GBP });
}));
app.post('/api/deposits/:id/refund', safe(async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  // A deposit belongs to a user — only its owner (or admin) may refund it.
  const dep = listSearchDeposits(user.id).find((d) => d.id === req.params.id);
  if (!dep && !user.allAccess && user.role !== 'admin') return res.status(403).json({ error: 'not-yours' });
  const result = refundSearchDeposit(req.params.id);
  if (!result.ok) return res.status(400).json(result);
  // SECURITY (pre-launch B2): the deposit was really captured through Stripe, so
  // a "refund" must return the money — not merely mark the record refunded. When
  // the deposit carries a Stripe PaymentIntent, issue the real refund. If Stripe
  // rejects it, roll the flag back so the deposit isn't silently "refunded" with
  // no money moved (the owner/support can retry).
  if (stripeEnabled() && result.deposit?.paymentIntent) {
    const refund = await createRefund({ paymentIntentId: result.deposit.paymentIntent, amountMinor: Math.round((result.deposit.amountGBP || 0) * 100) }).catch(() => ({ ok: false }));
    if (!refund.ok) {
      result.deposit.refunded = false; result.deposit.refundedAt = null;
      return res.status(502).json({ ok: false, error: 'refund-failed', message: 'We could not process the refund with the card gateway. Please try again or contact support.' });
    }
    result.deposit.stripeRefundId = refund.refundId || refund.id || null;
  }
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
    lccFlights: {
      provider: 'Kiwi Tequila', enabled: lccFlightsEnabled(),
      note: lccFlightsEnabled()
        ? 'LCC door OPEN — Ryanair/Jet2/Wizz fares flow live on regional routes (EMA, etc.).'
        : 'Kiwi Tequila is now INVITATION-ONLY (B2B partnerships). Alternatives: Duffel already carries easyJet/Vueling LCC content; for bookable Ryanair/Jet2 apply to Travelfusion (sales-led) or Ryanair\'s approved-OTA programme. The adapter activates the moment any partner key lands in TEQUILA_API_KEY.',
    },
    marketData: {
      provider: 'Travelpayouts (Aviasales)', enabled: marketDataEnabled(),
      note: marketDataEnabled()
        ? 'Market-data door OPEN — real cached fares (incl. Ryanair/Jet2) calibrate estimates and auto-fill the Market Benchmark.'
        : 'SELF-SERVE and free: sign up at travelpayouts.com, copy the API token (Tools → API), set TRAVELPAYOUTS_TOKEN. Gives real market prices incl. Ryanair/Jet2 for estimate calibration and automatic benchmark quotes (cached market data — never charged as live).',
    },
    hotels: { provider: 'Amadeus', enabled: liveHotelsEnabled() },
    schedules: { provider: 'OAG', enabled: oagScheduleEnabled() },
    note: duffelMode() === 'test'
      ? (LIVE_MODE()
        ? 'Duffel token is a TEST key and LIVE_MODE is on — its sandbox "Duffel Airways" (ZZ) fares are HIDDEN from customers, so flights show as estimates. Set a real duffel_live_… token to sell real fares.'
        : 'Duffel is in TEST mode — searches return sandbox "Duffel Airways" offers for internal testing and no real tickets are issued. Switch to a live Duffel token (and LIVE_MODE=true) to sell real fares.')
      : duffelMode() === 'live'
        ? (diag?.ok
          ? 'Duffel LIVE and reachable — real bookable fares are flowing. We hold the fare (instalments) or issue the e-ticket (paid in full) automatically.'
          : `Duffel LIVE token set, but the live probe did not return bookable fares: ${diag?.message || 'unknown'} — flights fall back to estimated until this clears.`)
        : 'Duffel not configured — flights are estimated.',
  });
}));

// ---- One-click LAUNCH READINESS self-test (admin) -------------------------
// Answers "am I ready to test / go live?" in plain English, from the SERVER —
// so a non-technical operator never needs a terminal. Actively probes Duffel
// and Stripe (reachability + key validity), reports Firebase/email/config, and
// returns a ready/not-ready verdict per capability with a human next-step.
app.get('/api/admin/selftest', safe(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const [duffel, stripe] = await Promise.all([
    duffelDiagnostic().catch((e) => ({ ok: false, reason: 'exception', message: e?.message || 'probe failed' })),
    stripeDiagnostic().catch((e) => ({ ok: false, reason: 'exception', message: e?.message || 'probe failed' })),
  ]);
  const liveMode = process.env.LIVE_MODE === 'true';
  const staffPinSet = Boolean(staffPin());
  const persistence = isEnabled();
  const email = isMailerEnabled();
  const testPayments = process.env.ALLOW_TEST_PAYMENTS === 'true';

  const check = (ok, label, detail, fix = null) => ({ ok, label, detail, fix });
  const hotelsLive = duffelStaysEnabled() || liveHotelsEnabled();
  const checks = [
    check(duffel.ok, 'Flights (Duffel) can sell real fares',
      duffel.message,
      duffel.ok ? null : 'Set a valid DUFFEL_TOKEN and make sure this host can reach api.duffel.com.'),
    check(hotelsLive, 'Hotels can be booked',
      duffelStaysEnabled() ? 'Duffel Stays is ON (uses your existing Duffel token) — hotels auto-book on payment, like flights.'
        : liveHotelsEnabled() ? 'Amadeus hotels are connected.'
        : 'No live hotel source — hotels show ESTIMATED prices and cannot be booked for real payment, so a package may show flight-only.',
      hotelsLive ? null : 'Duffel Stays uses the DUFFEL_TOKEN you already have — just make sure DUFFEL_STAYS is not set to "false" (or add AMADEUS_CLIENT_ID + AMADEUS_CLIENT_SECRET).'),
    check(stripe.ok && stripe.webhookSet, 'Card payments fulfil end-to-end',
      stripe.ok ? (stripe.webhookSet ? stripe.message : 'Stripe key works, but STRIPE_WEBHOOK_SECRET is missing — payments would capture but never issue the ticket.') : stripe.message,
      stripe.ok && stripe.webhookSet ? null : (!stripe.ok ? 'Set STRIPE_SECRET_KEY and make sure this host can reach api.stripe.com.' : 'Add STRIPE_WEBHOOK_SECRET (from your Stripe webhook endpoint) and redeploy.')),
    check(persistence, 'Data is shared + survives a restart',
      persistence ? `Durable store is ON (${persistenceBackend() === 'kv' ? 'Vercel KV / Upstash Redis' : 'Firebase RTDB'}) — accounts/quotes/bookings are shared across instances and saved.` : 'NO durable store — on a serverless host each instance is isolated, so users/quotes "vanish", admin sees no users, and checkout can\'t find the quote.',
      persistence ? null : 'Turn on EITHER: (easiest) the Vercel KV / Upstash integration → it sets KV_REST_API_URL + KV_REST_API_TOKEN; OR set FIREBASE_SERVICE_ACCOUNT + FIREBASE_DATABASE_URL.'),
    check(email, 'Customers get confirmation emails',
      email ? 'Email is configured — ticket/refund confirmations send.' : 'No email transport — confirmations are logged only, not sent.',
      email ? null : 'Set SMTP_PASS (and SMTP_FROM); host/port default to Hostinger:465.'),
    check(staffPinSet, 'Staff areas are protected',
      staffPinSet ? 'STAFF_ACCESS_PIN is set — admin/embassy areas require it.' : 'No staff PIN — privileged login fails closed, but set one so your team can get in.',
      staffPinSet ? null : 'Set STAFF_ACCESS_PIN to a long random value.'),
  ];
  const readyToTest = duffel.ok && (stripe.ok || testPayments);
  const readyToGoLive = duffel.mode === 'live' && stripe.mode === 'live' && stripe.ok && stripe.webhookSet && persistence && staffPinSet && liveMode;

  res.json({
    generatedAt: new Date().toISOString(),
    mode: { liveMode, duffel: duffel.mode, stripe: stripe.mode, testPayments },
    probes: { duffel, stripe },
    checks,
    verdict: {
      readyToTest,
      readyToGoLive,
      summary: readyToGoLive
        ? 'LIVE-READY — every capability is green in live mode. You can advertise.'
        : readyToTest
          ? 'READY TO TEST — run one booking end-to-end (search → pay with a test card → confirm the ticket), then a cancellation to confirm the refund. Not yet in full live mode.'
          : `NOT READY — ${checks.filter((c) => !c.ok).map((c) => c.label).join('; ') || 'see checks'}.`,
    },
  });
}));

// Send a real test email so the operator can confirm confirmations actually
// ARRIVE in an inbox — one click, no SMTP debugging. Defaults to the admin's own
// address; accepts an explicit `to` for sending to a personal inbox.
app.post('/api/admin/test-email', safe(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  if (!isMailerEnabled()) {
    return res.json({ ok: false, reason: 'not-configured', message: 'Email is not configured yet — set SMTP_PASS (and SMTP_FROM) so confirmations can send.' });
  }
  const admin = currentUser(req);
  const to = String((req.body || {}).to || admin?.email || '').trim();
  if (!to || /@guest\.3jn$/.test(to)) {
    return res.json({ ok: false, reason: 'no-recipient', message: 'No real email address to send to — add an email to your account or pass one in.' });
  }
  const when = new Date().toISOString();
  const r = await sendMail({
    to,
    subject: '3JN Travel OS — test email ✅',
    text: `This is a 3JN Travel OS test email sent at ${when}. If you received it, your customer confirmations (tickets, refunds) will send correctly.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;background:#0a1020;color:#eef2fb;padding:24px;border-radius:12px"><h2 style="color:#d8b46a;margin:0 0 8px">3JN Travel OS</h2><p>✅ Your email is working. Customer confirmations (tickets, refunds) will send correctly.</p><p style="color:#6b7799;font-size:12px">Test sent ${when}.</p></div>`,
  }).catch((e) => ({ ok: false, error: e?.message || 'send-failed' }));
  if (r.ok) return res.json({ ok: true, to, message: `Test email sent to ${to} — check the inbox (and spam). If it arrives, confirmations are working.` });
  return res.json({ ok: false, reason: 'send-failed', to, message: `Email is configured but the send failed: ${r.error || 'unknown error'}. Check the SMTP credentials/host.` });
}));

// ---- Market Benchmark: prove live fares against the market leaders ---------
// Runs real routes through the SAME live Duffel search + checkout pricing the
// customer gets, and hands the admin prefilled Skyscanner/Google Flights/Kayak
// links for the identical route + dates. The admin records the leader's price
// and gets an honest verdict: unbeatable / competitive / above-market.
app.get('/api/benchmark/flights', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ enabled: liveFlightsEnabled(), mode: duffelMode(), defaults: DEFAULT_BENCHMARK_ROUTES, lastRun: latestBenchmarkRun() });
}));
app.post('/api/benchmark/flights', safe(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const { routes, depart, ret, adults } = req.body || {};
  const out = await runFlightBenchmark({
    routes: Array.isArray(routes) && routes.length ? routes : undefined,
    depart, ret, adults,
  });
  if (!out.ok) return res.json(out);
  const saved = saveBenchmarkRun(out.run);
  res.json({ ok: true, run: saved });
}));
app.post('/api/benchmark/flights/market', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const { runId, rowId, source, priceGbp, selfTransfer, caveat } = req.body || {};
  res.json(recordBenchmarkMarket(runId, rowId, { source, priceGbp, selfTransfer, caveat }));
}));

// ---- Bot Defence: dormant-bot sweep + appeal ---------------------------------
app.post('/api/admin/bot-sweep', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json(sweepBotAccounts({ olderThanHours: Number(req.body?.olderThanHours) || 72 }));
}));
app.post('/api/admin/bot-sweep/:userId/unflag', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json(unflagBotAccount(req.params.userId));
}));

// ---- CarTrawler Mobility: ride-event webhook receiver + admin config --------
// CarTrawler PUSHES ride lifecycle events (ORDER_CREATED → CAR_DISPATCHED →
// CAR_ARRIVED → SERVICE_COMPLETED …) here. We validate an inbound shared
// secret (never trust an unauthenticated status change), map the event to a
// customer-facing status on the booking, and notify the traveller live.
app.post('/api/webhooks/cartrawler', safe((req, res) => {
  const secret = cartrawlerWebhookSecret();
  // FAIL CLOSED when the door is OPEN: if CarTrawler is live but no secret is
  // configured, refuse — otherwise anyone could flip a real ride's status. When
  // CarTrawler is disabled (dev/test), there is no real ride to hijack, so the
  // event is processed as a harmless simulation.
  if (secret) {
    const got = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (got !== secret) return res.status(401).json({ error: 'bad-webhook-secret' });
  } else if (cartrawlerEnabled()) {
    return res.status(503).json({ error: 'webhook-secret-unconfigured', message: 'CarTrawler is live but CARTRAWLER_WEBHOOK_SECRET is not set — inbound events are refused until it is.' });
  }
  const body = req.body || {};
  const event = String(body.event || body.eventType || body.state || '').toUpperCase();
  const orderRef = body.orderRef || body.orderId || body.reference || body.order?.id || null;
  const map = CARTRAWLER_EVENT_STATUS[event] || null;
  const result = applyMobilityEvent({
    event, orderRef,
    status: map?.status, icon: map?.icon, title: map?.title, body: map?.body, raw: body,
  });
  res.json({ received: true, ...result });
}));
app.get('/api/admin/cartrawler/webhooks', safe(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const [options, inspect] = await Promise.all([cartrawlerWebhookOptions(), cartrawlerWebhookInspect()]);
  res.json({ enabled: cartrawlerEnabled(), options, inspect });
}));
app.patch('/api/admin/cartrawler/webhooks', safe(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const out = await cartrawlerWebhookUpdate(req.body?.webhooks || {});
  res.json(out || { error: 'cartrawler-not-configured' });
}));

// ---- Ops Fulfilment Desk + Supplier Doors -----------------------------------
// The "automatic way" around manual supplier portals (Rayna, etc.): paid
// bookings decompose into channel-routed orders with pre-packed payloads; the
// operator completes each in one visit; the OS confirms to the customer.
app.get('/api/admin/fulfilment', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ orders: listFulfilmentOrders({ status: req.query.status || undefined }), doors: supplierDoors() });
}));
app.post('/api/admin/fulfilment/:id/complete', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json(completeFulfilmentOrder(req.params.id, { supplierRef: req.body?.supplierRef, note: req.body?.note }));
}));
app.post('/api/admin/fulfilment/:id', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json(updateFulfilmentOrder(req.params.id, { status: req.body?.status, note: req.body?.note }));
}));

// ---- Profitability Dashboard (spec §17): real-time money view --------------
app.get('/api/admin/profitability', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const dash = profitabilityDashboard();
  const costs = aiCostReport();
  // ACU economics: what each AI provider costs us vs what ACUs earn.
  const GBP_TO_USD = 1 / 0.79; // platform anchor reciprocal (≈1.266) — consistent everywhere
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
app.get('/api/admin/users-hosts', safe(async (req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  // FRESHNESS: on serverless this instance may hold only the accounts created on
  // IT. Pull the latest store from Firebase before answering so the admin always
  // sees EVERY user, not just this instance's. If persistence is disabled there
  // is nothing to pull — surface that so the operator knows why the list is thin.
  if (IS_SERVERLESS && isEnabled()) {
    try { const snap = await load(); if (snap) hydrate(snap); } catch { /* serve from memory */ }
  }
  res.json({ ...adminUserHostOverview(), persistence: isEnabled(), serverless: IS_SERVERLESS });
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
  // Emails the team inbox — rate-limit per IP so it can't be weaponised as an
  // email bomb / lead-spam flood.
  const rl = rateLimitAuth(clientIp(req));
  if (!rl.ok) return res.status(429).json(rl);
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

// ============================================================================
// Curated Deals Catalogue — the real, bookable products for commercial launch
// ============================================================================
// Public: browse active deals + view one.
app.get('/api/deals', safe((req, res) => {
  res.json({
    deals: listDeals({ activeOnly: true, category: req.query.category || null, featured: req.query.featured === '1' ? true : null }),
    stripeReady: stripeEnabled(),
  });
}));
app.get('/api/deals/:id', safe((req, res) => {
  const d = getDeal(req.params.id);
  if (!d || !d.active) return res.status(404).json({ error: 'not-found' });
  res.json({ deal: publicDeal(d), stripeReady: stripeEnabled() });
}));

// Buy a curated deal. Creates a real, 'confirmed' booking then either returns a
// Stripe checkout URL (self-serve card payment) or — when Stripe isn't live yet
// — records a reservation the ops team collects payment for and fulfils. Either
// way the order is REAL and lands in the fulfilment desk once paid.
app.post('/api/deals/:id/checkout', safe(async (req, res) => {
  const deal = getDeal(req.params.id);
  if (!deal || !deal.active) return res.status(404).json({ error: 'not-found', message: 'This deal is no longer available.' });
  if (deal.slots != null && deal.sold >= deal.slots) return res.status(409).json({ error: 'sold-out', message: 'This deal has just sold out.' });
  const body = req.body || {};
  const pax = Math.max(1, Math.min(30, Math.round(Number(body.pax) || 1)));
  const user = currentUser(req);
  const lead = body.lead && typeof body.lead === 'object' ? {
    fullName: String(body.lead.fullName || body.lead.name || user?.name || '').slice(0, 80),
    email: String(body.lead.email || user?.email || '').slice(0, 120),
    phone: String(body.lead.phone || '').slice(0, 40),
  } : { fullName: user?.name || '', email: user?.email || '', phone: '' };
  if (!lead.email) return res.status(400).json({ error: 'contact-required', message: 'A contact email is required to book.' });
  const option = buildDealOption(deal, pax);
  const kind = body.kind === 'deposit' && deal.depositGBP ? 'deposit' : 'full';
  const booking = createBooking({ option, userId: user?.id || null, lead, sourceDealId: deal.id, stripeLive: stripeEnabled() });
  const payNowGBP = kind === 'deposit' && deal.depositGBP ? deal.depositGBP : (option.pricing.local.total);

  if (stripeEnabled()) {
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const session = await createCheckoutSession({
      amountMinor: Math.round(payNowGBP * 100),
      currency: 'GBP',
      description: `3JN Travel — ${deal.title}${kind === 'deposit' ? ' (deposit)' : ''}`.slice(0, 200),
      bookingId: booking.id,
      userId: user?.id || '',
      customerEmail: lead.email,
      successUrl: `${origin}/console?paid=1&booking=${booking.id}&amt=${encodeURIComponent(payNowGBP)}&session={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/?dealCancelled=1`,
    });
    if (!session.ok) return res.status(400).json(session);
    return res.json({ ok: true, mode: 'stripe', booking, url: session.url, amountGBP: payNowGBP });
  }

  // No card gateway yet → take it as a RESERVATION and hand it to the team, who
  // collect payment (bank transfer / agent) and confirm. Nothing is fulfilled
  // until payment is recorded, so this never gives product away for free.
  booking.status = 'reserved-awaiting-payment';
  createSupportTicket({
    userId: user?.id || null,
    intent: 'deal-reservation',
    message: `New reservation for "${deal.title}" (${pax} pax, £${option.pricing.local.total}). Contact ${lead.fullName || ''} <${lead.email}> ${lead.phone || ''}. Collect payment then confirm. Booking ${booking.id}.${deal.fulfilmentNote ? ' How to fulfil: ' + deal.fulfilmentNote : ''}`,
    reason: 'deal-reservation',
  });
  sendMail({
    to: MAIN_CONTACT,
    subject: `New deal reservation — ${deal.title}`,
    text: `${lead.fullName || ''} <${lead.email}> ${lead.phone || ''}\n${deal.title} · ${pax} pax · £${option.pricing.local.total}\nBooking ${booking.id}. Collect payment and confirm.`,
    html: `<p><strong>${htmlEsc(lead.fullName || '')}</strong> &lt;${htmlEsc(lead.email)}&gt; ${htmlEsc(lead.phone || '')}</p><p>${htmlEsc(deal.title)} · ${pax} pax · £${option.pricing.local.total}</p><p>Booking ${booking.id}. Collect payment and confirm.</p>`,
  }).catch(() => {});
  res.json({ ok: true, mode: 'reservation', booking, amountGBP: payNowGBP, message: 'Reservation received — our team will contact you to confirm and take payment.' });
}));

// Admin: manage the catalogue.
app.get('/api/admin/deals', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ deals: listDealsAdmin() });
}));
app.post('/api/admin/deals', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const result = createDeal(req.body || {}, currentUser(req).id);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}));
app.patch('/api/admin/deals/:id', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const result = updateDeal(req.params.id, req.body || {}, currentUser(req).id);
  if (!result.ok) return res.status(result.error === 'not-found' ? 404 : 400).json(result);
  res.json(result);
}));
app.post('/api/admin/deals/:id/active', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const result = setDealActive(req.params.id, !!(req.body || {}).active, currentUser(req).id);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
}));
app.delete('/api/admin/deals/:id', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const result = deleteDeal(req.params.id, currentUser(req).id);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
}));

// ---- Guaranteed Savings Engine (USP #2) -------------------------------------
// "If we cannot beat or match your current quote, we refund your search
// credits." Compares the competing quote to our floor and refunds the ACUs.
app.post('/api/account/:id/savings-guarantee', safe((req, res) => {
  if (!requireOwner(req, res, req.params.id)) return;
  const { competitorQuoteUSD, ourTotalUSD, acuSpent } = req.body || {};
  const result = claimSavingsGuarantee(req.params.id, { competitorQuoteUSD, ourTotalUSD, acuSpent });
  if (!result.ok) return res.status(400).json(result);
  res.json({ ...result, guarantee: SAVINGS_GUARANTEE });
}));

// Lightweight "login" — look up an existing account by email (prototype: no
// password; a real build authenticates via Auth0/Firebase).
app.post('/api/login', safe((req, res) => {
  // SECURITY (pre-launch B3): passwordless email login is a DEMO affordance only.
  // In LIVE_MODE it is DISABLED — production authenticates exclusively through the
  // Firebase bridge (/api/auth/firebase), which proves the user actually OWNS the
  // address. Without this gate, anyone who knew a customer's email could open their
  // account with only the human-check. The frontend already prefers Firebase when
  // it's configured; this closes the fallback in production.
  if (LIVE_MODE()) {
    return res.status(403).json({ error: 'password-login-disabled', message: 'Please sign in with your verified account (Continue with Google or your email + password).' });
  }
  const ip = clientIp(req);
  const rl = rateLimitAuth(ip);
  if (!rl.ok) return res.status(429).json(rl);
  // HUMAN-ONLY login: same full verification as signup.
  const verdict = verifyHumanCheck((req.body || {}).humanCheck || {});
  if (!verdict.ok) return res.status(403).json({ ...verdict, human: false });
  const email = ((req.body || {}).email || '').trim().toLowerCase();
  const user = findUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'not-found', message: 'No account with that email. Sign up instead.' });
  // BOT DEFENCE: quarantined accounts cannot log in until an admin restores
  // them (the appeal path keeps a mistaken flag recoverable in one click).
  if (user.flaggedBot || user.suspended) {
    return res.status(403).json({ error: 'account-quarantined', message: 'This account is on hold by our automated-account protection. If you are a real person, contact support@3jntravel.com and we will restore it personally.' });
  }
  // Privileged accounts (admin, business, embassy…) can NEVER be opened by email
  // alone. Fail CLOSED: the staff PIN must be CONFIGURED and supplied — an unset
  // PIN must mean DENY, not open (otherwise a default deployment hands out admin).
  // An allowlisted owner email counts as privileged too (and is elevated below).
  const wantsAdmin = isOwnerEmail(email);
  if ((wantsAdmin || PRIVILEGED_ROLES.has(user.role) || user.allAccess) && (!staffPin() || !staffPinOk(req))) {
    return res.status(403).json({ error: 'staff-pin-required', message: 'Staff accounts require the staff access PIN.' });
  }
  // An allowlisted owner who has just proven the staff PIN has satisfied the
  // second factor — record the verification so the owner-admin overlay applies
  // (the overlay requires emailVerified, which public signup can never set). The
  // owner-email account itself can only exist via the Firebase bridge (public
  // signup rejects owner emails), so this can't promote an attacker's account.
  if (wantsAdmin && staffPin() && staffPinOk(req)) markEmailVerified(user.id);
  res.json({ user: applyOwnerRole(getUser(user.id) || user, staffPinOk(req)) });
}));

// ---- Membership Programme: subscribe / renew / cancel --------------------
// Joining a plan auto-funds the period's ACUs (10% of the subscription at
// £1 = 100 ACU). Requires a signed-in account.
// SEC-4: a membership is a paid subscription. When Stripe is live, joining or
// renewing must go through Checkout and is only activated by the signed webhook
// — otherwise anyone could self-grant a plan (and its monthly ACU) for free.
async function membershipCheckout(req, res, tierKey, mode, billing = 'monthly') {
  const user = currentUser(req);
  const plan = MEMBERSHIP_TIERS.find((t) => t.key === tierKey);
  if (!plan) return res.status(400).json({ ok: false, error: 'invalid-tier' });
  const yearly = billing === 'yearly';
  const price = yearly ? plan.pricePerYear : plan.pricePerMonth;
  if (!(price > 0)) { // a free tier — no payment needed
    const r = mode === 'renew' ? renewMembership(user.id) : subscribeMembership(user.id, tierKey, billing);
    return r.ok ? res.json(r) : res.status(400).json(r);
  }
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const session = await createCheckoutSession({
    amountMinor: Math.round(price * 100), currency: 'gbp',
    description: `3JN Travel+ — ${plan.name} (${yearly ? 'yearly · 2 months free' : 'monthly'})`,
    userId: user.id, customerEmail: user.email,
    metadata: { kind: 'membership', tier: plan.key, mode, billing: yearly ? 'yearly' : 'monthly', userId: user.id },
    successUrl: `${origin}/console?membership=1`, cancelUrl: `${origin}/console?membership=0`,
  });
  if (!session.ok) return res.status(400).json(session);
  return res.json({ ok: true, checkout: session.url, requiresPayment: true });
}
app.post('/api/membership/subscribe', safe(async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required', message: 'Sign in to join a membership plan.' });
  const billing = (req.body || {}).billing === 'yearly' ? 'yearly' : 'monthly';
  if (stripeEnabled()) return membershipCheckout(req, res, (req.body || {}).tier, 'subscribe', billing);
  const result = subscribeMembership(user.id, (req.body || {}).tier, billing);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}));
app.post('/api/membership/renew', safe(async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  if (stripeEnabled()) {
    if (!user.membership?.tier) return res.status(400).json({ ok: false, error: 'no-active-membership' });
    return membershipCheckout(req, res, user.membership.tier, 'renew', user.membership.billing || 'monthly');
  }
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

// Firebase Auth bridge — get-or-create the backend account for a Firebase user.
// SECURITY: the email is taken ONLY from a server-VERIFIED Firebase ID token,
// never the request body — otherwise this is a "log in as any email" oracle
// (full account takeover). Fails closed when the token can't be verified.
app.post('/api/auth/firebase', safe(async (req, res) => {
  const { idToken, name } = req.body || {};
  const decoded = await verifyFirebaseIdToken(idToken);
  if (!decoded || !decoded.email) return res.status(401).json({ error: 'unverified', message: 'Sign-in could not be verified — please try again.' });
  const email = String(decoded.email).trim().toLowerCase();
  const existing = findUserByEmail(email);
  if (existing && (existing.flaggedBot || existing.suspended)) {
    return res.status(403).json({ error: 'account-quarantined', message: 'This account is on hold by our automated-account protection. Contact support@3jntravel.com to restore it.' });
  }
  // An allowlisted owner email is (or becomes) an admin. An allowlisted owner
  // signing in with a VERIFIED Firebase token is authenticated by two strong
  // factors already — the email is on the ADMIN_EMAILS allowlist AND they proved
  // the account's password to Firebase — so no separate staff PIN is required
  // (that would be a third factor on a login that's already secure, and it's what
  // made owner sign-in brittle). The staff PIN stays MANDATORY only for OTHER
  // privileged accounts opened via this bridge (e.g. passwordless demo identities
  // that aren't on the allowlist).
  const wantsAdmin = isOwnerEmail(email);
  const fbVerified = decoded.email_verified === true; // Firebase confirmed they own the address
  const pinProven = !!(staffPin() && staffPinOk(req));
  // An OWNER email needs a real second factor beyond merely claiming the address:
  // a Firebase-VERIFIED email (e.g. Google sign-in) OR the staff PIN. This blocks
  // an attacker who created a Firebase account claiming the owner address without
  // verifying it (email_verified=false) from gaining admin.
  if (wantsAdmin && !fbVerified && !pinProven) {
    return res.status(403).json({ error: 'owner-verify-required', message: 'Owner admin needs a Firebase-verified email (use Continue with Google) or the staff access PIN.' });
  }
  const existingPrivNonOwner = !wantsAdmin && existing && (PRIVILEGED_ROLES.has(existing.role) || existing.allAccess);
  if (existingPrivNonOwner && !pinProven) {
    return res.status(403).json({ error: 'staff-pin-required', message: 'Staff accounts require the staff access PIN.' });
  }
  // Verified email still passes the bot name/disposable-domain checks on signup.
  if (!existing) {
    const bot = botSignupVerdict({ name, email });
    if (bot.block) return res.status(403).json({ error: 'bot-suspected', reasons: bot.reasons, message: bot.message });
  }
  const created = existing || createUser({ email, name: name || decoded.name || undefined, emailVerified: fbVerified, signupIp: clientIp(req) });
  if (!existing) await sendWelcomeEmail(created); // AWAIT so it survives the serverless freeze
  // Record durable verification only when Firebase actually verified the address.
  // A PIN-only owner still becomes admin below (stateless, via the PIN in the request).
  if (fbVerified) markEmailVerified(created.id);
  // Overlay admin from the env allowlist (consistent across serverless instances).
  const user = applyOwnerRole(getUser(created.id) || created, pinProven);
  res.json({ user, created: !existing });
}));

// Elevate the ALREADY signed-in account to admin by proving the staff PIN. This
// is the reliable in-app path when the login-time PIN prompt didn't appear — the
// user is signed in (x-user-id), so we just verify the PIN and that their email
// is on the ADMIN_EMAILS allowlist, then flip the role. Same two factors as
// login (allowlisted email + staff PIN); neither alone is enough.
app.post('/api/account/elevate', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required', message: 'Sign in first, then unlock with your staff PIN.' });
  if (!isOwnerEmail(user.email)) {
    return res.status(403).json({ error: 'not-an-owner', message: 'This account is not on the admin allowlist (ADMIN_EMAILS).' });
  }
  if (!staffPin() || !staffPinOk(req)) {
    return res.status(403).json({ error: 'staff-pin-required', message: 'Incorrect staff access PIN.' });
  }
  // PIN + allowlisted email proven — record verification so the owner-admin
  // overlay applies to this account from here on (across serverless instances).
  markEmailVerified(user.id);
  recordAudit({ actor: user.id, role: 'admin', action: 'account.elevated', entity: 'user', entityId: user.id, summary: `${user.email} unlocked admin via staff PIN` });
  res.json({ user: applyOwnerRole(getUser(user.id) || user, staffPinOk(req)) });
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
  // A non-string `text` (a client posting a number/array/object) must be a clean
  // 400, not a 500 from `text.trim()` deep in the parser.
  if (text != null && typeof text !== 'string') return res.status(400).json({ error: 'text-must-be-string' });
  const context = detectContext(req, { country, currencyCountry });
  const user = currentUser(req);
  let result = plan({ text, context, user, searchTier, overrides, preferences: preferences || {}, usage: usageStats(user?.id) });

  // Live provider pricing overlay: when flight/hotel provider keys are present
  // and reachable, fetch real offers and rebuild the packages from them. Any
  // failure (no keys, outbound disabled, provider down) silently keeps the
  // deterministic estimate — we never present an unconverted or invented price.
  // ABUSE GUARD: the overlays below make real external calls (paid Duffel/Viator/
  // Mozio live fares + the Aviasales market reference). Throttle them per client
  // IP so an unauthenticated caller can't hammer /api/plan to burn our supplier
  // quota / spend. The deterministic estimate above is unaffected — only the
  // expensive fetches are gated. One budget check per request; when exceeded we
  // skip the external overlays and serve the estimate.
  // DIAGNOSTIC: capture WHY a search ends up estimated instead of live, so the
  // silent fallback (below) is never a mystery to the operator. Attached to the
  // response as `liveOverlay`.
  const liveOverlay = { attempted: false, applied: false, reason: null, flightsFound: 0, hotelsFound: 0, duffelMode: duffelMode() };
  const liveBudget = rateLimitLiveSearch(clientIp(req));
  if (result.stage !== 'options') {
    liveOverlay.reason = 'not-options-stage';
  } else if (!liveSuppliersConfigured()) {
    liveOverlay.reason = 'no-supplier-keys';
  } else if (!liveBudget.ok) {
    liveOverlay.reason = 'live-search-rate-limited';
  }
  if (result.stage === 'options' && liveSuppliersConfigured() && liveBudget.ok) {
    liveOverlay.attempted = true;
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
          const rp = resolved[idx] || {};
          const origin = rp.origin || resolveOrigin(party.city) || result.origin;
          const partyIntent = { ...intent, travellers: { adults: rp.adults ?? party.count, children: rp.children || 0, childAges: rp.childAges || [], total: party.count } };
          const offers = await fetchLiveFlights(partyIntent, dest, origin).catch(() => null);
          return { partyIndex: idx, city: party.city, offers: (offers && offers.length) ? offers : null };
        }));
        const withOffers = groupFlights.filter((g) => g.offers);
        const hotels = liveHotelsEnabled() ? await fetchLiveHotels(intent, dest).catch(() => null) : null;
        live = { groupFlights: withOffers.length ? withOffers : null, hotels };
      } else {
        live = await fetchLiveOffers(intent, dest, result.origin);
      }
      // LIVE Viator tours when activities are requested and the door is open.
      if (viatorEnabled() && (result.intent?.components || []).includes('activities') && dest?.city) {
        const acts = await viatorActivitiesForScan({ destinationCity: dest.city, date: intent.dates?.checkIn, pax: intent.travellers?.total }).catch(() => null);
        if (acts && acts.length) live = { ...live, activities: acts };
      }
      // LIVE Mozio airport transfers when a transfer is requested and the door is open.
      if (mozioEnabled() && (result.intent?.components || []).includes('transfer') && dest?.city) {
        const trs = await mozioTransfersForScan({ destAirport: dest.airport, destCity: dest.city, dateTimeISO: intent.dates?.checkIn ? `${intent.dates.checkIn}T12:00:00` : undefined, pax: intent.travellers?.total }).catch(() => null);
        if (trs && trs.length) live = { ...live, transfers: trs };
      }
      liveOverlay.flightsFound = (live.flights?.length || 0) + (live.groupFlights?.length || 0);
      liveOverlay.hotelsFound = live.hotels?.length || 0;
      const hasLive = (live.flights && live.flights.length) || (live.hotels && live.hotels.length) || (live.groupFlights && live.groupFlights.length) || (live.activities && live.activities.length) || (live.transfers && live.transfers.length);
      if (hasLive) {
        result = plan({ text, context, user, searchTier, overrides, preferences: preferences || {}, live, usage: usageStats(user?.id) });
        liveOverlay.applied = true;
        liveOverlay.reason = 'live-applied';
      } else {
        // Suppliers ARE connected but returned NOTHING for this exact route/date
        // (common in Duffel's TEST sandbox, which has limited inventory) — so the
        // trip stays estimated and unpayable. This is the usual "everything is an
        // estimate even though keys are set" cause.
        liveOverlay.reason = 'suppliers-returned-no-offers';
      }
    } catch (e) {
      // A live fetch threw (network/auth/provider error). Keep the estimate, but
      // record the reason so it isn't invisible.
      liveOverlay.reason = 'live-fetch-error';
      liveOverlay.error = String(e?.message || e).slice(0, 200);
    }
  }
  if (result && typeof result === 'object') result.liveOverlay = liveOverlay;

  // REAL MARKET REFERENCE (Aviasales cache incl. Ryanair/Jet2): when our fare
  // is still estimated, show what the market actually charges on this route —
  // honest context beside our estimate, and it feeds the Price check box.
  if (result.stage === 'options' && result.journey && result.priceSource?.flights !== 'live' && marketDataEnabled() && liveBudget.ok) {
    try {
      const fares = await fetchMarketFares(result.intent, result.intent.destination, result.origin);
      if (fares && fares.length) {
        const cheapest = fares.reduce((a, b) => (a.priceGbp <= b.priceGbp ? a : b));
        result.marketLive = {
          source: 'Aviasales market data (7-day cache)',
          minGbp: cheapest.priceGbp,
          maxGbp: Math.max(...fares.map((f) => f.priceGbp)),
          cheapestCarrier: cheapest.carrier,
          cheapestStops: cheapest.stopLabel,
          sampled: fares.length,
        };
      }
    } catch { /* market reference is best-effort */ }
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
  if (result.stage === 'options' && result.cached && req.body?.approveAcu !== true) {
    // Served from the cache — no ACU is ever charged for a cached answer.
    // EXCEPTION: `approveAcu === true` means the user is completing an ACU
    // approval they were prompted for — and that prompt only ever appears for a
    // NON-cached (fresh) result. The first (approval-required) call already ran
    // plan() and cached its output, so this second call now finds it "cached".
    // Treating that as free lost every charge behind an approval. So a cache hit
    // that arrives WITH an approval is the round-trip artifact — fall through and
    // charge it. A genuine popular-cache hit never carries approveAcu (no prompt
    // was shown), so it stays free.
    result.acuCharged = 0;
  } else if (result.stage === 'options' && user && !user.allAccess) {
    const reqTier = SEARCH_TIERS[searchTier] || SEARCH_TIERS.smart;
    // MEMBERS pay the AT-COST rate (their subscription is the margin); NON-MEMBERS
    // (top-up only) pay the full 3–10× commercial rate.
    const isMember = !!user.membership?.active;
    const cost = (isMember && reqTier.acuMember ? reqTier.acuMember : reqTier.acu) || 0;
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
  // Clearly-LABELLED sponsored deals for the searched destination (a marked
  // strip only — never mixed into or reordering the ranked package options).
  if (result.stage === 'options' && result.intent?.destination?.city) {
    result.sponsored = sponsoredPlacementsFor('recommended deals', result.intent.destination.city);
  }
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
  if (components != null && !Array.isArray(components)) return res.status(400).json({ error: 'components-must-be-array' });
  res.json(bookingRequirements({ components: components || [], destination, nationality, passengers, holidayType, international: international !== false }));
}));
app.post('/api/booking/validate', safe((req, res) => {
  const { travellers, travelDate, nationality, destination, fraudSignals, international } = req.body || {};
  if (travellers != null && !Array.isArray(travellers)) return res.status(400).json({ error: 'travellers-must-be-array' });
  const validation = validateBooking({ travellers: travellers || [], travelDate, nationality, destination, international: international !== false });
  res.json({ ...validation, risk: bookingRiskScore(fraudSignals || {}) });
}));

// ---- Quote: persist a chosen option + AI Smart Instalment plan -------------
// The AI selects the plan from departure date + risk profile (spec: AI Smart
// Instalment Payment Engine). Manual months/deposit overrides are ignored —
// the customer may always pay MORE, earlier, without penalty.
function smartPlanForRequest(req, option, intent) {
  const currency = { code: option.pricing.currency, symbol: option.pricing.symbol, rateFromUSD: option.pricing.local.total / (option.pricing.lines?.totalUSD || option.pricing.local.total) };
  const user = currentUser(req);
  const departISO = intent?.dates?.checkIn;
  const totalGbp = option.pricing.currency === 'GBP' ? option.pricing.local.total : (option.pricing.lines?.totalUSD || 0) * 0.79;
  const risk = assessInstalmentRisk({
    user,
    history: userPaymentHistory(user?.id),
    totalGbp,
    daysToDeparture: departISO ? (daysUntil(departISO, new Date().toISOString().slice(0, 10)) ?? 0) : 0,
    productTypes: (option.components || []).map((c) => c.type),
  });
  const plan = departISO ? buildSmartInstalmentPlan({
    totalLocal: option.pricing.local.total,
    currency,
    departISO,
    todayISO: new Date().toISOString().slice(0, 10),
    risk,
  }) : null;
  // No departure date / past date → fall back to the legacy 3-month split so a
  // quote is never blocked; real bookings always carry a checkIn.
  return plan || instalmentPlan({ totalLocal: option.pricing.local.total, currency, months: 3, depositPct: 0.2, checkIn: departISO });
}
// A well-formed option must carry a pricing block with a positive local total and
// a components array — otherwise the pricing/quote/booking engines dereference
// undefined and 500. Guard at the edge so malformed input is a clean 400 and
// never persists a garbage booking.
function isValidOption(o) {
  return !!(o && typeof o === 'object' && !Array.isArray(o)
    && o.pricing && typeof o.pricing === 'object'
    && o.pricing.local && Number(o.pricing.local.total) > 0
    && Array.isArray(o.components));
}
app.post('/api/quote', safe((req, res) => {
  const { option, intent } = req.body || {};
  if (!isValidOption(option)) return res.status(400).json({ error: 'invalid-option', message: 'A valid priced option (pricing.local.total + components[]) is required.' });
  const instalment = smartPlanForRequest(req, option, intent);
  const quote = saveQuote({ option, intent, instalment });
  recordBehaviour(currentUser(req)?.id, {
    event: 'quote',
    destination: intent?.destination?.code || null,
    payload: { nights: intent?.nights, party: intent?.travellers?.total, month: intent?.month, components: intent?.components },
  });
  res.json({ quote });
}));

// ---- AI Smart Instalments: public plan preview + admin enforcement ---------
// Preview: which plan does a departure date get, with the caller's own risk
// profile applied? Powers the "how would I pay?" view before any quote.
app.get('/api/instalments/preview', safe((req, res) => {
  const departISO = String(req.query.depart || '');
  const total = Number(req.query.total) || 1000;
  const user = currentUser(req);
  const risk = assessInstalmentRisk({ user, history: userPaymentHistory(user?.id), totalGbp: total, daysToDeparture: daysUntil(departISO, new Date().toISOString().slice(0, 10)) ?? 0 });
  const plan = buildSmartInstalmentPlan({ totalLocal: total, currency: { code: 'GBP', symbol: '£' }, departISO, risk });
  if (!plan) return res.status(400).json({ error: 'bad-departure-date', message: 'Pass ?depart=YYYY-MM-DD (a future date) and optional ?total=.' });
  res.json({ plan, tiers: INSTALMENT_TIERS.map((t) => ({ band: t.maxDays === Infinity ? `${t.minDays}+ days` : `${t.minDays}–${t.maxDays} days`, name: t.name, depositPct: t.depositPct, instalments: t.schedule.length })), graceHours: INSTALMENT_GRACE_HOURS });
}));
// Enforcement sweep: reminders (14/7/3/1/0 days), autopay charges, grace
// warnings + auto-cancel of defaulted plans. Run by the admin (or a scheduler
// in production).
app.post('/api/admin/instalments/enforce', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json(enforceInstalments(req.body?.today));
}));
// Autopay consent: the customer opts into automatic recurring instalment
// charges (off-session charging activates when a payment method is saved
// with the PSP; consent is recorded either way).
app.post('/api/book/:id/autopay', safe((req, res) => {
  const user = currentUser(req);
  const booking = getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'booking-not-found' });
  if (!user || (booking.userId && booking.userId !== user.id && !user.allAccess)) return res.status(403).json({ error: 'not-your-booking' });
  if (booking.instalment?.engine !== 'ai-smart') return res.status(400).json({ error: 'no-smart-plan' });
  const enabled = req.body?.enabled !== false;
  booking.instalment.autopay = { ...booking.instalment.autopay, enabled, method: req.body?.method || booking.instalment.autopay?.method || 'saved-card', consentAt: enabled ? new Date().toISOString() : null };
  recordAudit({ actor: user.id, role: 'consumer', action: 'instalment.autopay', entity: 'booking', entityId: booking.id, summary: enabled ? 'autopay enabled' : 'autopay disabled' });
  res.json({ ok: true, autopay: booking.instalment.autopay });
}));

// ---- Book: confirm + take deposit ----------------------------------------
app.post('/api/book', safe((req, res) => {
  const { quoteId, option: bodyOption, intent: bodyIntent, months, depositPct, paymentMethod, lead, travellers, specialRequests, hotelRequests, payment, protection, vendorCode } = req.body || {};
  let quote = getQuote(quoteId);
  // SERVERLESS RESILIENCE: the quote may have been saved on a DIFFERENT instance
  // (or persistence isn't configured), so getQuote misses and the customer hits
  // "quote not found" and can't pay. The client still holds the full option from
  // /api/quote — fall back to it and re-save the quote on this instance. Payment
  // integrity is unaffected: an estimated price can never be charged, and a live
  // price is re-validated against the real supplier fare at checkout (loss floor).
  if (!quote) {
    if (isValidOption(bodyOption)) {
      quote = saveQuote({ option: bodyOption, intent: bodyIntent || {}, instalment: smartPlanForRequest(req, bodyOption, bodyIntent || {}) });
    } else {
      return res.status(404).json({ error: 'quote-not-found', message: 'Your quote expired — please re-run the search and try again.' });
    }
  }
  // Guard the quote's option too: a malformed option (from a stale/tampered
  // client) must be a clean 400 BEFORE we create/persist a booking — otherwise a
  // garbage booking is stored and only the confirmation email throws (500), or an
  // anonymous caller silently banks an orphan booking.
  if (!isValidOption(quote.option)) return res.status(400).json({ error: 'invalid-option', message: 'This quote is incomplete — please re-run the search.' });
  const user = currentUser(req);

  // The AI-selected plan from the quote stands — the schedule is re-derived
  // fresh at booking time so a quote left open for days still books on the
  // CURRENT date band (a 95-days-out quote booked at 89 days is an Easy Plan,
  // not a stale Smart Plan). Manual months/deposit overrides are not accepted;
  // paying more, earlier is always allowed.
  const instalment = smartPlanForRequest(req, quote.option, quote.intent);

  const booking = createBooking({ quoteId, option: quote.option, instalment, userId: user?.id, paymentMethod, lead, travellers, specialRequests, hotelRequests, payment, protection: protection ? protectionFee(quote.option.pricing.local.total) : null, vendorCode, stripeLive: stripeEnabled() });
  // Refundable search deposit (spec §6): a booking converts the user's active
  // deposit — its value comes OFF the final payment, never double-charged.
  if (user) {
    const depositCredit = convertDepositToBooking(user.id, booking.id);
    if (depositCredit) {
      booking.depositCredit = depositCredit;
      // Actually apply it — reduce the cash due and count it as paid (previously
      // the deposit was marked converted but never credited).
      applyDepositCreditToBooking(booking, depositCredit.amountGBP);
    }
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
  // Paid IN FULL at booking (no instalment plan) → also email the full booking
  // document (PDF-ready). Instalment bookings get it when the balance clears.
  emailBookingConfirmation(booking).catch((e) => console.error('[confirm-email]', e?.message || e));
  res.json({ booking, user: user ? getUser(user.id) : null });
}));

// ---- Pay an instalment ----------------------------------------------------
// OWNERSHIP + AMOUNT INTEGRITY: only the booking owner (or admin) may pay, the
// index must be a real unpaid scheduled instalment, and the amount is taken
// from the SCHEDULE — never a client number (a £0.01 "payment" must not clear
// an instalment or fire referral/vendor rewards).
app.post('/api/book/:id/pay', safe(async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  const target = getBooking(req.params.id);
  if (!target) return res.status(404).json({ error: 'not-found' });
  if (target.userId && target.userId !== user.id && !user.allAccess && user.role !== 'admin') {
    return res.status(403).json({ error: 'not-your-booking' });
  }
  // LEGAL-SAFETY: an ESTIMATED quote is never a bookable price and must never be
  // charged — the exact bookable amount is confirmed first (quote-request flow),
  // which flips the booking to a live basis. Refuse to take money on an estimate.
  if (target.priceBasis && target.priceBasis !== 'live' && target.priceBasis !== 'confirmed') {
    return res.status(409).json({ error: 'estimate-not-payable', message: 'This is an indicative quote — we confirm the exact bookable price before any payment is taken.' });
  }
  const index = Number((req.body || {}).index);
  const item = target.instalment?.schedule?.[index];
  if (!item) return res.status(400).json({ error: 'bad-instalment-index' });
  if (item.status === 'paid') return res.json({ booking: target, already: true });
  // SECURITY (pre-launch B1): when a real card gateway is live, an instalment
  // must actually be CAPTURED through Stripe Checkout — never self-recorded here.
  // Otherwise this endpoint would mark instalments "paid" (and, on the final one,
  // release the ticket/room) without any money changing hands. The signed webhook
  // (meta.bookingId + meta.instalmentIndex) is the single source of truth that
  // records the payment and marks the schedule item, exactly like the deposit.
  if (stripeEnabled()) {
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const sym = target.option?.pricing?.symbol || '£';
    const session = await createCheckoutSession({
      amountMinor: Math.round(Number(item.amount) * 100),
      currency: target.option?.pricing?.code || 'GBP',
      description: `3JN Travel — instalment ${index + 1} (${target.option?.tier || 'booking'})`.slice(0, 200),
      bookingId: target.id,
      userId: user.id,
      customerEmail: user.email || undefined,
      metadata: { instalmentIndex: String(index) },
      successUrl: `${origin}/console?paid=1&booking=${target.id}&amt=${encodeURIComponent(item.amount)}&session={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/console?instalmentCancelled=1`,
    });
    if (!session.ok) return res.status(400).json(session);
    // Remember the session so the return-from-Stripe reconcile can confirm this
    // exact instalment payment without depending on the webhook.
    target.pendingCheckout = { sessionId: session.sessionId, kind: 'instalment', instalmentIndex: index, at: new Date().toISOString() };
    return res.json({ requiresPayment: true, checkout: session.url, amount: item.amount, symbol: sym });
  }
  const booking = recordPayment(req.params.id, { type: 'instalment', amount: item.amount, index });
  if (booking.instalment?.schedule?.[index]) booking.instalment.schedule[index].status = 'paid';
  // BALANCE CLEARED → FULFIL. Tickets/rooms/deals are held on a deposit and only
  // released once the fare is paid IN FULL. The final instalment lands here (not
  // via the Stripe webhook), so this is where we release fulfilment — otherwise a
  // fully-paid instalment booking would stay held forever.
  if (bookingFullyPaid(booking)) {
    if (booking.sourceDealId && !booking.dealFulfilmentCreated) {
      createDealFulfilment(booking);
      if (booking.userId) pushNotification(booking.userId, { type: 'success', icon: '🎟️', title: 'Balance paid — booking confirmed', body: 'Your package is now paid in full — our team is finalising your booking with the supplier and will email your documents shortly.' });
    }
    autoTicketFlight(booking).catch((e) => console.error('[ticketing]', e?.message || e));
    autoBookStays(booking).catch((e) => console.error('[stays]', e?.message || e));
    // Balance cleared → email the full booking document (PDF-ready), on top of
    // the Console copy.
    emailBookingConfirmation(booking).catch((e) => console.error('[confirm-email]', e?.message || e));
  }
  res.json({ booking });
}));

app.get('/api/book/:id', safe((req, res) => {
  const booking = getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'not-found' });
  // OWNERSHIP: bookings carry passport + passenger PII — owner or admin only.
  if (ownerlessBookingBlocked(req, res, booking)) return;
  const user = currentUser(req);
  if (booking.userId && (!user || (booking.userId !== user.id && !user.allAccess && user.role !== 'admin'))) {
    return res.status(403).json({ error: 'not-your-booking' });
  }
  res.json({ booking });
}));

// Console → booking → 📄 Documents: the structured document vault — the SAME
// per-service confirmation cards as the printed document (single source of
// truth), so "full instructions in your Console" is literally true.
app.get('/api/book/:id/documents', safe((req, res) => {
  const booking = getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'not-found' });
  if (ownerlessBookingBlocked(req, res, booking)) return;
  const user = currentUser(req);
  if (booking.userId && user?.id !== booking.userId && !requireRole(req, res, ['admin'])) return;
  const ful = booking.fulfilment || {};
  // Ticketing status must reflect REALITY — never default to 'confirmed'. A
  // booking with no fulfilment and no full payment is pending, not confirmed.
  const paid = planPaid(booking);
  const total = booking.option?.pricing?.local?.total || 0;
  const isPaidInFull = total > 0 && paid + 0.01 >= total;
  const ticketingState = ful.ticketing || (isPaidInFull ? 'confirmed' : 'pending');
  res.json({
    bookingId: booking.id,
    status: booking.status,
    ticketing: ticketingState,
    // Surface WHY ticketing isn't 'issued' (and the refund state) so a failed /
    // held / ops-queued booking explains itself instead of just reading 'failed'.
    reason: ful.reason || null,
    needsRefund: !!ful.needsRefund,
    refunded: !!ful.refundId,
    refundId: ful.refundId || null,
    pnr: ful.pnr || null,
    ticketNumbers: (ful.ticketNumbers || []).filter(Boolean).length ? ful.ticketNumbers : (ful.eTicketNumber ? [ful.eTicketNumber] : []),
    services: includedServices(booking),
  });
}));

// Branded travel document — e-ticket / itinerary / confirmation. Returns a
// self-contained, printable 3JN-branded HTML page (customer can Save as PDF).
app.get('/api/book/:id/document', safe((req, res) => {
  const booking = getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'not-found' });
  if (ownerlessBookingBlocked(req, res, booking)) return;
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
  // A CURATED deal is 'confirmed': a real, admin-committed price 3JN will honour
  // and fulfil, so it is payable exactly like a live fare (no invented estimate).
  if (booking.priceBasis !== 'live' && booking.priceBasis !== 'confirmed' && !testMode) {
    return res.status(409).json({
      error: 'payment-blocked-estimated-pricing',
      priceBasis: booking.priceBasis || 'estimated',
      message: 'This quote is estimated — live supplier fares are not connected yet, so we do not take real payment for it. Connect live inventory (Duffel/Amadeus) to enable secure card checkout at the exact bookable price.',
    });
  }
  // FRESH-FARE GUARD: a live flight offer expires and can reprice. Before
  // charging, re-validate it with its provider (Duffel or Kiwi Tequila). If it
  // expired or moved, refuse and ask the traveller to re-search — never charge
  // a fare we can no longer ticket.
  const flightComp = (booking.option?.components || []).find((c) => c.type === 'flight' && (c.details?.offerId || c.details?.bookingToken) && c.live);
  let validatedFlightUSD = 0; // the airline's freshly-confirmed fare (trusted), used by the loss floor
  if (flightComp && liveFlightsEnabled()) {
    // Re-price with the REAL party split (adults + children), not the combined
    // headcount — passing total-as-adults reprices a family as all-adults and
    // wrongly trips the "fare changed" guard, blocking a legitimate checkout.
    const party = booking.option?.travellers || {};
    const revAdults = party.adults || party.total || 1;
    const revChildren = party.children || 0;
    const check = flightComp.details.offerId
      ? await validateDuffelOffer(flightComp.details.offerId)
      : await validateTequilaOffer(flightComp.details.bookingToken, { adults: revAdults, children: revChildren });
    // FAIL CLOSED: if we could not reach the provider to re-validate a LIVE fare
    // (network/5xx → ok:false, reason 'unreachable'), do NOT charge and hope —
    // block checkout and ask the traveller to retry, rather than capture money
    // against a fare we could not confirm is still ticketable.
    if (!check.ok && check.reason === 'unreachable') {
      return res.status(503).json({ error: 'fare-unverifiable', message: 'We could not confirm this live fare with the airline just now — please try again in a moment. No payment was taken.' });
    }
    if (check.ok && (check.expired || check.live === false)) {
      return res.status(409).json({ error: 'fare-expired', message: 'This live fare has expired since your search — please re-search so we quote and charge the current bookable price.' });
    }
    if (check.ok && check.priceChanged) {
      return res.status(409).json({ error: 'fare-changed', message: 'The airline price changed since your search — please re-search to see and confirm the current fare before paying.' });
    }
    if (check.ok && typeof check.priceUSD === 'number') {
      validatedFlightUSD = check.priceUSD;
      const shown = flightComp.priceUSD || 0;
      const drift = shown > 0 ? Math.abs(check.priceUSD - shown) / shown : 0;
      if (drift > 0.02) {
        return res.status(409).json({ error: 'fare-changed', message: 'The airline price changed since your search — please re-search to see and confirm the current fare before paying.', wasUSD: shown, nowUSD: check.priceUSD });
      }
      // ANTI-TAMPER (loss floor): the option (incl. pricing) is client-supplied,
      // so verify the booking total covers at least the airline's REAL validated
      // fare — the one number we trust. A tampered total below supplier cost
      // would have us pay the airline more than we collect. Uses the trusted
      // Duffel amount, not the client's pricing lines.
      const totalUSD = booking.option?.pricing?.lines?.totalUSD || 0;
      if (totalUSD > 0 && totalUSD < check.priceUSD * 0.98) {
        return res.status(409).json({ error: 'price-integrity', message: 'This quote no longer reflects the current bookable fare — please re-search so we charge the correct price.' });
      }
    }
  }
  const cur = booking.option?.pricing?.currency || 'GBP';
  // "Full" settles the OUTSTANDING balance (total − already paid), not the whole
  // price again — otherwise a customer who paid a deposit and then chose to
  // settle in full would be charged the full total on top of the deposit.
  const fullTotal = booking.option?.pricing?.local?.total || 0;
  const paidSoFar = (booking.payments || [])
    .filter((p) => ['deposit', 'instalment', 'full', 'stripe-checkout', 'deposit-credit'].includes(p.type) && Number(p.amount) > 0)
    .reduce((s, p) => s + Number(p.amount), 0);
  const total = kind === 'full'
    ? Math.max(0, Math.round((fullTotal - paidSoFar) * 100) / 100)
    : (booking.instalment?.deposit || fullTotal);
  if (total <= 0) return res.status(409).json({ error: 'nothing-to-pay', message: 'This booking is already fully settled.' });
  // ---- GENERAL LOSS FLOOR (all components, not just the flight) -------------
  // The whole option — including pricing.local.total — is client-supplied, so
  // the amount we actually charge must cover the REAL summed supplier cost of
  // every LIVE component (flight + hotel + transfer + activity). Without this a
  // caller could keep truthful component prices (so the room/seat still books)
  // but tamper pricing.local.total down to ~nothing and have us pay the supplier
  // far more than we collect. The trusted numbers are the validated flight fare
  // and each live component's priceUSD (the same figure autoBookStays caps the
  // room at). We floor the FULL total (the deposit + instalments must cover cost
  // too), converting supplier USD → the charging currency at a trusted rate.
  const liveComps = (booking.option?.components || []).filter((c) => c.live && Number(c.priceUSD) > 0);
  let supplierCostUSD = liveComps.reduce((s, c) => s + Number(c.priceUSD), 0);
  if (flightComp && validatedFlightUSD > 0) {
    // Prefer the freshly validated airline fare over the client's flight priceUSD.
    supplierCostUSD = supplierCostUSD - (Number(flightComp.priceUSD) || 0) + validatedFlightUSD;
  }
  if (supplierCostUSD > 0) {
    let usdToCur = cur === 'USD' ? 1 : await fxRate('USD', cur).catch(() => null);
    if (!usdToCur && cur === 'GBP') usdToCur = 0.79; // platform anchor fallback (£1≈$1.266)
    // Only enforce when we have a trusted rate; never block a legit booking on a
    // transient FX outage for an exotic currency (the flight floor above still ran).
    if (usdToCur) {
      const floorLocal = supplierCostUSD * usdToCur * 0.98;
      if (fullTotal > 0 && fullTotal < floorLocal) {
        return res.status(409).json({ error: 'price-integrity', message: 'This quote no longer reflects the current bookable price — please re-search so we charge the correct amount.' });
      }
    }
  }
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const user = currentUser(req);
  const session = await createCheckoutSession({
    amountMinor: Math.round(total * 100),
    currency: cur,
    description: `3JN Travel OS — ${booking.option?.tier || ''} package ${kind === 'full' ? '(full payment)' : '(deposit)'}`.trim(),
    bookingId: booking.id,
    userId: user?.id || booking.userId || '',
    customerEmail: user?.email,
    // `amt` feeds the Meta Pixel Purchase event on the success page — the
    // authoritative payment record is still the signed Stripe webhook.
    successUrl: `${origin}/console?paid=1&booking=${booking.id}&amt=${encodeURIComponent(total)}&session={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/console?paid=0&booking=${booking.id}`,
  });
  if (!session.ok) return res.status(400).json(session);
  // Remember the session so the return-from-Stripe reconcile can confirm payment
  // without depending on the webhook (deposit or full).
  booking.pendingCheckout = { sessionId: session.sessionId, kind: kind === 'full' ? 'full' : 'deposit', at: new Date().toISOString() };
  res.json(session);
}));

// ---- Reconcile a Checkout return WITHOUT the webhook ----------------------
// On return from Stripe (/console?paid=1&booking=…), the app calls this to
// verify the session DIRECTLY with Stripe and record the payment if it's paid.
// This makes payment recording robust to a missing/delayed/misconfigured
// webhook — the #1 reason a paid booking gets stuck at "awaiting payment".
// Idempotent: the session id is the payment reference, the same one the webhook
// uses, so a later webhook (or a repeat reconcile) can never double-charge/-point.
app.post('/api/pay/stripe/reconcile', safe(async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  const booking = getBooking((req.body || {}).bookingId);
  if (!booking) return res.status(404).json({ error: 'not-found' });
  if (booking.userId && booking.userId !== user.id && !user.allAccess && user.role !== 'admin') {
    return res.status(403).json({ error: 'not-your-booking' });
  }
  // Prefer the session id from the return URL ({CHECKOUT_SESSION_ID}) — it needs
  // NO stored state, so it survives a serverless instance change. Fall back to
  // the session stored on the booking if the URL didn't carry one.
  const sessionId = (req.body || {}).sessionId || booking.pendingCheckout?.sessionId;
  if (!sessionId || !stripeEnabled()) return res.json({ booking, reconciled: false });
  const s = await retrieveCheckoutSession(sessionId).catch(() => ({ ok: false }));
  if (!s.ok) return res.json({ booking, reconciled: false, error: s.error });
  if (!s.paid) return res.json({ booking, reconciled: false, pending: true });
  // SECURITY: the Stripe session must actually belong to THIS booking (its
  // metadata carries the bookingId we set at creation) — so a caller can't point
  // a paid session for booking A at booking B.
  if (s.metadata?.bookingId && s.metadata.bookingId !== booking.id) {
    return res.status(409).json({ error: 'session-booking-mismatch' });
  }
  const amount = (s.amountTotal || 0) / 100;
  const idxRaw = s.metadata?.instalmentIndex ?? booking.pendingCheckout?.instalmentIndex;
  const idx = idxRaw != null && idxRaw !== '' ? Number(idxRaw) : null;
  const isInst = Number.isInteger(idx);
  // ROBUST + SELF-DIAGNOSING: recording the payment is the ONE step that must not
  // fail silently. If it throws we must NOT return an opaque 500 ("network:
  // internal") — the money moved at Stripe, so the customer needs a clear reason,
  // and we need the actual cause without server-log access. Catch it and return
  // the detail so the frontend can show exactly what went wrong.
  let updated;
  try {
    updated = recordPayment(booking.id, {
      // Match the webhook exactly (type + reference = session id) so dedup makes a
      // later webhook or a repeat reconcile a no-op — never a double charge.
      type: isInst ? 'instalment' : 'stripe-checkout',
      amount, gateway: 'stripe', reference: sessionId, paymentIntent: s.paymentIntent,
      ...(isInst ? { index: idx } : {}),
    });
    if (updated && isInst && updated.instalment?.schedule?.[idx]) updated.instalment.schedule[idx].status = 'paid';
    if (updated && s.paymentIntent) updated.stripePaymentIntent = s.paymentIntent;
  } catch (e) {
    console.error('[reconcile-record]', e);
    return res.status(200).json({ booking, reconciled: false, error: 'record-failed', detail: String(e?.message || e) });
  }
  // Mirror the webhook's fulfilment: hold on a deposit, release on paid-in-full.
  // Fulfilment is BEST-EFFORT and must NEVER break the response — the payment is
  // already recorded above, and the response MUST complete so the persistence
  // middleware flushes that payment to the durable store. Any throw here (a deal
  // fulfilment edge case, a sync error in ticketing) is logged, not propagated.
  if (updated) {
    try { if (updated.sourceDealId && bookingFullyPaid(updated) && !updated.dealFulfilmentCreated) createDealFulfilment(updated); } catch (e) { console.error('[reconcile-deal]', e?.message || e); }
    // SERVERLESS: once res.json returns, the Vercel instance FREEZES — a
    // fire-and-forget promise never runs, so the ticket/room/PDF-email would
    // silently never happen (paid-but-nothing-released). AWAIT each step (each
    // guarded so one failure can't block the others or the response), so the
    // PNR/e-ticket + confirmation email actually issue AND the booking mutations
    // (fulfilment, ticketing status) are captured by the synchronous store flush.
    try { await autoTicketFlight(updated); } catch (e) { console.error('[ticketing]', e?.message || e); }
    try { await autoBookStays(updated); } catch (e) { console.error('[stays]', e?.message || e); }
    try { await emailBookingConfirmation(updated); } catch (e) { console.error('[confirm-email]', e?.message || e); }
  }
  let paidPct = 0;
  try {
    const tot = (updated || booking).option?.pricing?.local?.total || 0;
    const paidNow = planPaid(updated || booking);
    paidPct = tot > 0 ? Math.round((paidNow / tot) * 100) : 0;
  } catch (e) { console.error('[reconcile-pct]', e?.message || e); }
  res.json({ booking: updated || booking, reconciled: !!updated, recordedAmount: amount, paidPct });
}));
// Webhook: signature-verified; a forged event can never mark a booking paid.
app.post('/api/pay/stripe/webhook', safe(async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const check = verifyStripeSignature(req.rawBody, sig);
  if (!check.ok) return res.status(400).json(check);
  const event = req.body || {};
  if (event.type === 'checkout.session.completed') {
    const meta = event.data?.object?.metadata || {};
    const amountMinor = event.data?.object?.amount_total || 0;
    // IDEMPOTENCY: Stripe delivers this event at-least-once and redelivers on any
    // retry. The ACU / membership / deposit branches credit a wallet directly, so
    // they must fire ONCE per event id — otherwise a legitimate redelivery would
    // re-credit free ACU / re-fund a membership / re-place a deposit. The booking
    // branches below have their own reference-based dedup (recordPayment /
    // markQuoteRequestPaid), so they don't need this claim.
    const fresh = claimStripeEvent(event.data?.object?.id || event.id);
    // SEC-4 fulfilment: a paid ACU top-up / membership is credited ONLY here,
    // by a signature-verified event — never on the unauthenticated POST.
    if (meta.kind === 'acu' && meta.userId && meta.pack) {
      if (fresh) {
        const r = buyAcu(meta.userId, meta.pack);
        if (r.ok) pushNotification(meta.userId, { type: 'success', icon: '⚡', title: 'ACU added', body: `Your wallet is topped up — balance ${r.balance} ACU.` });
      }
    } else if (meta.kind === 'membership' && meta.userId && meta.tier) {
      if (fresh) {
        const r = meta.mode === 'renew' ? renewMembership(meta.userId) : subscribeMembership(meta.userId, meta.tier, meta.billing || 'monthly');
        if (r.ok) pushNotification(meta.userId, { type: 'success', icon: '⭐', title: 'Travel+ active', body: `Your membership is ${meta.mode === 'renew' ? 'renewed' : 'live'} (${meta.billing === 'yearly' ? 'annual' : 'monthly'}) — enjoy your member benefits and ACU.` });
      }
    } else if (meta.kind === 'deposit' && meta.userId && meta.tier) {
      if (fresh) {
        const r = placeSearchDeposit({ userId: meta.userId, tier: meta.tier, searchId: meta.searchId || null, paymentIntent: event.data?.object?.payment_intent || null });
        if (r.ok) pushNotification(meta.userId, { type: 'success', icon: '🔎', title: 'Search deposit placed', body: `Your refundable ${meta.tier} search deposit is active — it comes straight off your booking when you travel.` });
      }
    } else if (meta.bookingId && String(meta.bookingId).startsWith('qr_')) {
      // A confirmed exact-quote was paid.
      markQuoteRequestPaid(meta.bookingId, { amount: amountMinor / 100, gateway: 'stripe', reference: event.data?.object?.id });
      if (meta.userId) pushNotification(meta.userId, { type: 'success', icon: '💳', title: 'Payment received', body: `Your ${(amountMinor / 100).toFixed(2)} payment is confirmed — your trip is booked at the exact quoted price.` });
    } else if (meta.bookingId) {
      const paymentIntent = event.data?.object?.payment_intent || null;
      // An instalment payment (routed here by /api/book/:id/pay in live mode)
      // carries its schedule index — record it AS an instalment and flip that
      // schedule row to paid, so the plan progresses exactly as the simulated
      // path does. A deposit / pay-in-full has no index and stays 'stripe-checkout'.
      const instalmentIndex = meta.instalmentIndex != null && meta.instalmentIndex !== '' ? Number(meta.instalmentIndex) : null;
      const paymentType = Number.isInteger(instalmentIndex) ? 'instalment' : 'stripe-checkout';
      const booking = recordPayment(meta.bookingId, { type: paymentType, amount: amountMinor / 100, gateway: 'stripe', reference: event.data?.object?.id, paymentIntent, ...(Number.isInteger(instalmentIndex) ? { index: instalmentIndex } : {}) });
      if (booking && Number.isInteger(instalmentIndex) && booking.instalment?.schedule?.[instalmentIndex]) {
        booking.instalment.schedule[instalmentIndex].status = 'paid';
      }
      // Store the PaymentIntent so a failed ticketing can actually refund it.
      if (booking && paymentIntent) booking.stripePaymentIntent = paymentIntent;
      if (booking && meta.userId) {
        pushNotification(meta.userId, { type: 'success', icon: '💳', title: 'Payment received', body: `Card payment of ${(amountMinor / 100).toFixed(2)} confirmed via Stripe — your booking is secured.` });
      }
      // CURATED DEAL: route to the Ops Fulfilment Desk (team books the real
      // supplier — manual now, API-ready later) ONLY when the fare is paid IN
      // FULL. On a deposit we reserve and wait — we never book a supplier, or
      // tell the customer their trip is confirmed, on a part-payment.
      if (booking && booking.sourceDealId) {
        if (bookingFullyPaid(booking)) {
          createDealFulfilment(booking);
          if (booking.userId) pushNotification(booking.userId, { type: 'success', icon: '🎟️', title: 'Booking confirmed', body: 'Your package is confirmed and paid — our team is finalising your booking with the supplier and will email your documents shortly.' });
        } else if (booking.userId) {
          pushNotification(booking.userId, { type: 'info', icon: '🎟️', title: 'Deposit received — trip reserved', body: 'Your deposit is in and your package is reserved at the price you locked. We finalise your booking with the supplier as soon as the balance is paid in full.' });
        }
      }
      // AUTO-TICKETING: money is captured — now issue the flight ticket by
      // creating the Duffel order. Failure flags the booking for a refund rather
      // than leaving the traveller paid-but-unticketed. AWAITED: on a serverless
      // host a detached promise dies when the webhook response returns.
      if (booking) { try { await autoTicketFlight(booking); } catch (e) { console.error('[ticketing]', e?.message || e); } }
      // AUTO-BOOK the hotel too (Duffel Stays: rates → quote → book). Failure
      // hands off to the ops desk, never a paid-but-unbooked room.
      if (booking) { try { await autoBookStays(booking); } catch (e) { console.error('[stays]', e?.message || e); } }
      // Paid in full via Stripe → email the full booking document (PDF-ready),
      // on top of the Console copy. Idempotent + fires only when fully paid.
      if (booking) { try { await emailBookingConfirmation(booking); } catch (e) { console.error('[confirm-email]', e?.message || e); } }
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
// Vendor SERVICE LISTINGS: an approved vendor lists what they deliver
// (photographer/guide/driver/translator/restaurant) at their own price;
// the listing competes in real package searches for their city.
app.post('/api/vendors/services', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json(addVendorService(user.id, req.body || {}));
}));
app.delete('/api/vendors/services/:id', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json(removeVendorService(user.id, req.params.id));
}));
// Vendor JOBS: paid bookings of the vendor's services, waiting on delivery
// confirmation. Confirming creates the 90/10 earnings row (released the
// Friday AFTER the service date) and notifies the customer.
app.get('/api/vendors/jobs', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  res.json({ jobs: listFulfilmentOrders().filter((o) => o.vendorId === user.id) });
}));
app.post('/api/vendors/jobs/:id/confirm', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required' });
  const order = listFulfilmentOrders().find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'job-not-found' });
  if (order.vendorId !== user.id) return res.status(403).json({ error: 'not-your-job' });
  const ref = String(req.body?.ref || '').trim();
  if (!ref) return res.status(400).json({ error: 'confirmation-required', message: 'Enter your booking/confirmation reference for the customer.' });
  const done = completeFulfilmentOrder(order.id, { supplierRef: ref, completedBy: 'vendor' });
  if (!done.ok) return res.json(done);
  // Already completed → do NOT create a second earnings row (double-payout).
  if (done.already) return res.json({ ok: true, order: done.order, already: true });
  const sale = recordVendorServiceJob({ vendorId: user.id, bookingId: order.bookingId, orderId: order.id, priceGbp: order.sellGbp ?? order.sellPrice, serviceDate: order.serviceDate });
  res.json({ ok: true, order: done.order, earnings: sale.ok ? sale.sale : null });
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
app.post('/api/support/chat', safe(async (req, res) => {
  const { message, history } = req.body || {};
  if (message != null && typeof message !== 'string') return res.status(400).json({ error: 'message-must-be-string' });
  const user = currentUser(req);
  // Deep, system-aware agent: resolves with the user's REAL bookings, payments,
  // e-tickets, wallet, rewards and visa rules; escalates only when a human must
  // authorise an action — and hands the human a full diagnostic. The recent
  // transcript keeps multi-turn requests (e.g. a booking change) coherent.
  const out = assist(message, user?.id, Array.isArray(history) ? history.slice(-8) : []);
  // A cancellation just flagged a refund due (operatorConfirm). Actually issue
  // it via Stripe when a captured PaymentIntent is on file — idempotent (guarded
  // by refundId). The in-module ops ticket remains the fallback if this can't
  // fire, so the customer is made whole either way.
  if (user && stripeEnabled()) {
    for (const b of listBookings(user.id)) {
      const f = b.fulfilment;
      if (f && f.needsRefund && f.refundGbp > 0 && !f.refundId && b.stripePaymentIntent) {
        const r = await createRefund({ paymentIntentId: b.stripePaymentIntent, amountMinor: Math.round(f.refundGbp * 100) }).catch(() => ({ ok: false }));
        if (r.ok) {
          f.refundId = r.refundId; f.refundedAt = new Date().toISOString(); f.needsRefund = false;
          const line = (b.payments || []).find((p) => p.type === 'refund' && p.status === 'pending');
          if (line) line.status = 'refunded';
          recordAudit({ actor: 'system', role: 'system', action: 'refund.issued', entity: 'booking', entityId: b.id, summary: `£${f.refundGbp} · ${r.refundId}` });
        }
      }
    }
  }
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
  // POLICY IS EMBASSY-LEVEL: only the embassy (or admin) sets criteria, fees,
  // branding and templates. A CONSULATE processes applications UNDER that
  // policy — it can read the config but never change it.
  if (!requireRole(req, res, ['embassy', 'admin'])) return;
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
  // OWNERSHIP: this mutates a booking (rebooks/refunds) — owner or admin only.
  const booking = getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'not-found' });
  const user = currentUser(req);
  if (booking.userId && (!user || (booking.userId !== user.id && !user.allAccess && user.role !== 'admin'))) {
    return res.status(403).json({ error: 'not-your-booking' });
  }
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
  // OWNERSHIP: mutates a booking (price-guard rebook/refund) — owner or admin only.
  const target = getBooking(req.params.id);
  if (!target) return res.status(404).json({ error: 'not-found' });
  const user = currentUser(req);
  if (target.userId && (!user || (target.userId !== user.id && !user.allAccess && user.role !== 'admin'))) {
    return res.status(403).json({ error: 'not-your-booking' });
  }
  const { drift } = req.body || {};
  const event = runPriceGuard(req.params.id, typeof drift === 'number' ? drift : undefined);
  res.json({ event, booking: getBooking(req.params.id) });
}));

// ---- Reviews & supplier scoring ------------------------------------------
app.post('/api/reviews', safe((req, res) => {
  // Signed-in only: anonymous review submission let scripts move supplier/host
  // reliability scores and the public leaderboard at will. Tie every review to
  // a real account (and stamp it) so bulk manipulation is attributable.
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required', message: 'Sign in to leave a review.' });
  const result = submitReview({ ...(req.body || {}), userId: user.id });
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

// Admin: look up one user by email or id (for the manage-user panel).
app.get('/api/admin/user-find', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'no-query' });
  const u = q.includes('@') ? findUserByEmail(q) : getUser(q);
  if (!u) return res.status(404).json({ error: 'not-found', message: 'No user with that email or id.' });
  res.json({ user: getUser(u.id) });
}));
// Admin: grant/adjust a user's ACU balance ({ add } or { setTo }).
app.post('/api/admin/users/:id/acu', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const { add, setTo } = req.body || {};
  const r = adminAdjustAcu(req.params.id, { add: add != null ? Number(add) : null, setTo: setTo != null ? Number(setTo) : null });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
}));
// Admin: set (or clear) a user's membership tier ({ tier: 'elite' | 'none' | ... }).
app.post('/api/admin/users/:id/membership', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  const r = adminSetMembership(req.params.id, (req.body || {}).tier);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
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
// SEC-6: a draft holds half-entered booking PII (name, passport). It MUST be
// per-account — an anonymous save landed in a single shared "anon:" bucket, so
// one visitor could read another visitor's draft. Require a signed-in account;
// the app always provisions one before the booking form, so real users are
// unaffected while the cross-session leak is closed.
app.put('/api/drafts/:key', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'auth-required', saved: false });
  const rec = saveDraft(user.id, req.params.key, (req.body || {}).payload);
  res.json({ saved: true, savedAt: rec.savedAt });
}));
app.get('/api/drafts/:key', safe((req, res) => {
  const user = currentUser(req);
  if (!user) return res.json({ draft: null });
  res.json({ draft: getDraft(user.id, req.params.key) });
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
// Admin-only: the blog body is public HTML, so untrusted callers must never
// reach the generator (stored-XSS vector). Content is also escaped in createPost.
app.post('/api/blog/generate', safe((req, res) => {
  if (!requireRole(req, res, ['admin'])) return;
  res.json({ post: createPost(req.body || {}) });
}));

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
  if (text != null && typeof text !== 'string') return res.status(400).json({ error: 'text-must-be-string' });
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
    // Accept writes only AFTER the load settles (resolve or reject) — hydrate()
    // replaces the collections wholesale, so any write before it is lost.
    // Expose the load as a promise so incoming writes can AWAIT it (no 503).
    storeReadyPromise = load().then((snap) => {
      if (snap && hydrate(snap)) console.log('[persist] restored store from Firebase RTDB');
    }).catch((e) => console.error('[persist] load failed:', e?.message || e))
      .finally(() => { storeReady = true; });
    // Belt-and-braces periodic flush (covers long-lived Cloud Run instances).
    // GATE on storeReady: before hydrate() lands, the in-memory store is EMPTY,
    // and snapshotting it would overwrite the real saved data with nothing. Never
    // flush (periodic OR on shutdown) until the load has settled.
    // CRITICAL: use saveMerge (per-record MERGE), NEVER save() (whole-store
    // overwrite). With multiple instances, a whole-store set from THIS instance's
    // possibly-stale memory silently wipes accounts/bookings/profile edits another
    // instance just wrote — the root cause of "my name/profile change didn't
    // stick" and "my account vanished". A merge only ever writes THIS instance's
    // records over their own keys and leaves everyone else's intact.
    const flushEvery = setInterval(() => { if (storeReady) saveMerge(flatSnapshot()); }, 15000);
    if (flushEvery.unref) flushEvery.unref();
    const flush = () => {
      if (!storeReady) { process.exit(0); return; } // load never finished — save nothing over good data
      saveMerge(flatSnapshot()).finally(() => process.exit(0));
    };
    process.on('SIGTERM', flush);
    process.on('SIGINT', flush);
  } else {
    storeReady = true; // no persistence configured → nothing to load, ready now
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
