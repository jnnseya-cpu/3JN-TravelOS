#!/usr/bin/env node
// ============================================================================
// 3JN Travel OS — LIVE launch readiness verifier
// ============================================================================
// Run this against your PRODUCTION url before taking a single real payment. It
// reads the app's own health + config diagnostics and turns "are the live keys
// really wired?" from a guess into an evidence-based GO / NO-GO board. It NEVER
// spends money or touches a customer — it only asks the running app what state
// its integrations are actually in, then prints the exact env var to fix each
// gap and the manual money-path walk you must do by hand.
//
//   node scripts/live-readiness.mjs https://www.3jntravel.com
//   BASE_URL=https://www.3jntravel.com node scripts/live-readiness.mjs
//
// Exit code 0 = all automated live-config checks pass; 1 = at least one blocker.
// ============================================================================

const BASE = (process.argv[2] || process.env.BASE_URL || '').replace(/\/+$/, '');
const EXPECTED_BUILD = process.env.EXPECTED_BUILD || 'v148';

if (!BASE) {
  console.error('Usage: node scripts/live-readiness.mjs <https://your-production-url>');
  process.exit(2);
}

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, json, text: text.slice(0, 200) };
}

const checks = [];
function check(name, pass, detail, fix) {
  checks.push({ name, pass: !!pass, detail, fix });
}

console.log(`\n${b('3JN Travel OS — live launch readiness')}  ${dim(BASE)}\n`);

// ---- 1. Health -------------------------------------------------------------
let health, ctx;
try {
  health = await getJson('/api/health');
} catch (e) {
  console.error(r(`✗ Could not reach ${BASE}/api/health — is the URL right and the site up?`), e?.message || e);
  process.exit(1);
}
if (health.status !== 200 || !health.json?.ok) {
  console.error(r(`✗ /api/health did not return ok (status ${health.status}). ${health.text}`));
  process.exit(1);
}
const H = health.json;

check('Build is the launch build', String(H.build || '').includes(EXPECTED_BUILD),
  `serving ${H.build}`, `Redeploy: expected build to contain "${EXPECTED_BUILD}". Bump BUILD_TAG + sw.js CACHE_VERSION and push to main.`);
check('Durable persistence is on', H.persistence === true,
  `backend: ${H.persistenceBackend || 'none'}`, 'Set the Firebase creds (FIREBASE_SERVICE_ACCOUNT / RTDB URL) — without it, bookings vanish on the next serverless cold start.');
check('Transactional email (SMTP) is live', H.email === true,
  H.email ? 'mailer enabled' : 'mailer OFF', 'Set SMTP_PASS (+ SMTP_USER/HOST) — otherwise no confirmation PDF or instalment reminder ever sends.');
check('Live flights are flowing', H.liveFlights === true,
  H.liveFlights ? 'flights live' : 'flights are ESTIMATES only', 'Set a live DUFFEL_TOKEN (duffel_live_…). A test token = every trip is an unpayable estimate.');
check('Live hotels are flowing', H.liveHotels === true,
  H.liveHotels ? 'hotels live' : 'hotels are estimates only', 'Enable Duffel Stays / a bedbank (TBO/RateHawk) — or launch flights-first and keep hotels as clearly-labelled estimates.');

// ---- 2. Config diagnostics (supplier + Stripe truth) -----------------------
try {
  ctx = await getJson('/api/context');
} catch { /* handled below */ }
if (ctx?.json?.suppliers) {
  const S = ctx.json.suppliers;
  check('Duffel is in LIVE mode (not sandbox ZZ)', S.duffelMode === 'live',
    `duffelMode = ${S.duffelMode}`, 'Swap the sandbox/test token for a live duffel_live_… token. Sandbox "ZZ" fares behave differently (thin data, £0 diffs, async ticketing).');
  check('Stripe is in LIVE mode', S.stripe === 'live',
    `stripe = ${S.stripe}`, 'Set STRIPE_SECRET_KEY to your sk_live_… key. A test key takes no real money.');
  check('Stripe webhook secret is set', S.stripeWebhook === true,
    S.stripeWebhook ? 'webhook configured' : 'NO webhook secret', 'Set STRIPE_WEBHOOK_SECRET — without it a payment captures but the ticket never issues and no PDF sends. This is the #1 silent launch killer.');
  const warn = ctx.json.configWarning;
  check('App self-diagnosis is clean', !warn,
    warn ? `${warn.severity}: ${warn.message}` : 'no config warnings', warn ? warn.message : '');
} else {
  check('Config diagnostics reachable', false, `/api/context returned ${ctx?.status}`, 'Confirm the deployed build exposes /api/context.suppliers (v148).');
}

// ---- 3. Trust surface -------------------------------------------------------
if (ctx?.json) {
  const contact = ctx.json.contact || {};
  const tp = ctx.json.trustpilot || {};
  const mp = ctx.json.moneyProtection || null;
  check('Real human contact is published', !!(contact.whatsapp || contact.phone),
    contact.whatsappDisplay || contact.phone || 'none', 'Set the WhatsApp/phone env so a customer can reach a person.');
  check('Company details are shown', !!(contact.company?.number),
    contact.company ? `${contact.company.name} ${contact.company.number}` : 'none', 'Confirm the company/registration details render on Contact + About.');
  check('Trustpilot is wired (badge/widget)', !!tp.domain,
    tp.businessUnitId ? 'live star widget' : (tp.domain ? 'domain badge only' : 'not set'), 'Optional but recommended: set TRUSTPILOT_DOMAIN (badge) and TRUSTPILOT_BUSINESS_UNIT_ID (live stars) + TRUSTPILOT_AFS_EMAIL (verified invites).');
  check('Financial protection statement present', !!mp,
    mp ? 'money-protection configured' : y('NOT SET — see legal gate below'), 'Package sales in the UK need ATOL/ABTA or equivalent protection wired into MONEY_PROTECTION_* before public launch. This is a LEGAL gate, not a nicety.');
}

// ---- Report ----------------------------------------------------------------
console.log('');
let blockers = 0;
for (const c of checks) {
  const icon = c.pass ? g('✅') : r('❌');
  console.log(`${icon}  ${c.name}  ${dim('— ' + c.detail)}`);
  if (!c.pass) { blockers++; if (c.fix) console.log(`     ${y('fix')} ${c.fix}`); }
}

console.log(`\n${b('Automated live-config verdict:')} ${blockers === 0 ? g('GO — all live integrations report ready') : r(`NO-GO — ${blockers} blocker(s) above`)}\n`);

// ---- Manual money-path walk (cannot be automated safely) -------------------
console.log(b('Now do this ONCE by hand (real keys, small real amounts) — the part no script should spend for you:'));
const steps = [
  'Search a REAL flight → pay in full with a REAL card → within minutes the booking shows a real airline PNR + e-ticket AND the confirmation email arrives with the PDF.',
  'Book on instalments: pay the deposit → confirm NO e-ticket. Clear the balance → confirm the e-ticket releases only now (the £0-gate).',
  'Trigger a refund from the admin cancel → confirm the money actually returns to the card in Stripe.',
  'Exact-quote: request → confirm the price in admin → pay → it appears as a real booking and (as a member) banks Travel Credit.',
  'Date change on a live fare → confirm the exact total (fee + airline diff) charges the saved card BEFORE reissue; a declined card blocks it.',
  'Confirm the Stripe webhook fired for each (Stripe dashboard → Webhooks → recent deliveries all 2xx).',
];
steps.forEach((s, i) => console.log(`  ${b((i + 1) + '.')} ${s}`));

console.log(`\n${b('Legal / ops go-no-go (not code — you must confirm):')}`);
[
  'ATOL / ABTA / package-travel financial protection is in place for flight+hotel sales.',
  'A human is reachable on the published WhatsApp on launch day.',
  'Refund + chargeback process is understood and someone owns it.',
  'Start CAPPED: friends/community + small tickets first, you watching every booking — not a public blast.',
].forEach((s) => console.log(`  ${y('▢')} ${s}`));
console.log('');

process.exit(blockers === 0 ? 0 : 1);
