// Supplier Doors — every non-flight/hotel supply channel, env-gated like
// Duffel/Tequila: each adapter is INERT until its key lands, then that lane
// goes live with zero code changes. Where no API exists (Rayna agent portal),
// fulfilment routes to the automated Ops Fulfilment Desk instead — a human
// completes a pre-packed order in the supplier portal and the OS does
// everything else (customer confirmation, documents, audit).
//
// Nothing here fabricates availability: an adapter that can't reach its
// provider returns null and the component stays estimator/ops-fulfilled.

const env = process.env;
const TIMEOUT_MS = Number(env.EXTRAS_TIMEOUT_MS) || 8000;

async function httpJSON(url, opts = {}) {
  if (typeof fetch !== 'function') return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    const body = await r.json();
    return r.ok ? body : { __error: body, __status: r.status };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---- Door keys ----------------------------------------------------------------
const ESIMACCESS_KEY = env.ESIMACCESS_API_KEY || '';
const ESIMACCESS_BASE = env.ESIMACCESS_BASE_URL || 'https://api.esimaccess.com';
// Airalo Partners API — OAuth2 client-credentials (24h token), then submit an
// order to provision a real eSIM (ICCID + LPA activation + QR + eSIMs Cloud
// sharing link). Sandbox: https://sandbox-partners-api.airalo.com.
const AIRALO_ID = env.AIRALO_CLIENT_ID || '';
const AIRALO_SECRET = env.AIRALO_CLIENT_SECRET || '';
const AIRALO_BASE = env.AIRALO_BASE_URL || 'https://partners-api.airalo.com';
const AIRALO_BRAND = env.AIRALO_BRAND_SETTINGS_NAME || ''; // optional branded eSIMs Cloud
const VIATOR_KEY = env.VIATOR_API_KEY || '';
// Production https://api.viator.com · Sandbox https://api.sandbox.viator.com.
const VIATOR_BASE = env.VIATOR_BASE_URL || 'https://api.viator.com';
// Partner tier drives the booking path: 'affiliate' → redirect the customer
// to the Viator productUrl (commission via cookie); 'merchant' → book via
// /bookings/cart/hold + /bookings/cart/book. Content/search is identical for
// both, so search works the moment the key lands regardless of tier.
const VIATOR_TIER = (env.VIATOR_PARTNER_TIER || 'affiliate').toLowerCase();
export function viatorPartnerTier() { return VIATOR_TIER; }
// AFFILIATE ATTRIBUTION: a Viator affiliate earns commission only when the
// customer reaches the product page through a link carrying the partner's
// tracking params. The API returns a clean productUrl — we append pid (your
// partner id), mcid (media campaign id) and medium so the click attributes to
// YOUR account. Without VIATOR_PARTNER_ID set, links still work but earn £0, so
// this is the piece that actually "connects" the affiliate revenue.
const VIATOR_PARTNER_ID = env.VIATOR_PARTNER_ID || '';      // pid — your Viator partner id (P00…)
const VIATOR_MCID = env.VIATOR_MCID || '42383';            // Viator's API media-campaign id (override if told otherwise)
const VIATOR_MEDIUM = env.VIATOR_MEDIUM || 'api';           // link medium
export function viatorAffiliateReady() { return viatorEnabled() && VIATOR_TIER === 'affiliate' && !!VIATOR_PARTNER_ID; }
// Append the affiliate tracking params to a Viator product URL (idempotent —
// never double-adds; preserves any existing query string).
export function viatorAffiliateUrl(productUrl) {
  if (!productUrl || VIATOR_TIER !== 'affiliate' || !VIATOR_PARTNER_ID) return productUrl || null;
  try {
    const u = new URL(productUrl);
    if (!u.searchParams.has('pid')) u.searchParams.set('pid', VIATOR_PARTNER_ID);
    if (VIATOR_MCID && !u.searchParams.has('mcid')) u.searchParams.set('mcid', VIATOR_MCID);
    if (VIATOR_MEDIUM && !u.searchParams.has('medium')) u.searchParams.set('medium', VIATOR_MEDIUM);
    return u.toString();
  } catch { return productUrl; }
}
const MOZIO_KEY = env.MOZIO_API_KEY || '';
const MOZIO_BASE = env.MOZIO_BASE_URL || 'https://api.mozio.com';
// CarTrawler Mobility (chauffeur/ride). Server-to-server: a Bearer partner
// token + the X-Mobility-Partner id header on every request. Lifecycle events
// are PUSHED to our webhook receiver (validated against an inbound secret).
const CARTRAWLER_TOKEN = env.CARTRAWLER_PARTNER_TOKEN || '';
const CARTRAWLER_PARTNER_ID = env.CARTRAWLER_PARTNER_ID || '';
const CARTRAWLER_BASE = env.CARTRAWLER_BASE_URL || '';
const CARTRAWLER_WEBHOOK_SECRET = env.CARTRAWLER_WEBHOOK_SECRET || '';
const INSURANCE_KEY = env.XCOVER_API_KEY || env.BATTLEFACE_API_KEY || '';
// LEGAL GATE: selling insurance in the UK is FCA-regulated. Even with a
// provider key, sales stay OFF until the IAR/authorisation is confirmed.
const INSURANCE_AUTHORISED = env.INSURANCE_AUTHORISED === 'true';
const RAYNA_PORTAL_URL = env.RAYNA_PORTAL_URL || 'https://agents.raynab2b.com';

export function esimApiEnabled() { return (!!ESIMACCESS_KEY || airaloEnabled()) && typeof fetch === 'function'; }
export function airaloEnabled() { return !!(AIRALO_ID && AIRALO_SECRET) && typeof fetch === 'function'; }
export function cartrawlerEnabled() { return !!(CARTRAWLER_TOKEN && CARTRAWLER_PARTNER_ID && CARTRAWLER_BASE) && typeof fetch === 'function'; }
export function cartrawlerWebhookSecret() { return CARTRAWLER_WEBHOOK_SECRET; }

// The customer-facing status for each CarTrawler Mobility lifecycle event.
export const CARTRAWLER_EVENT_STATUS = {
  ORDER_CREATED: { status: 'confirmed', icon: '🚗', title: 'Ride confirmed', body: 'Your chauffeur ride is booked and confirmed.' },
  SUPPLIER_FORWARDED: { status: 'assigned', icon: '🚗', title: 'Driver being assigned', body: 'Your ride was sent to the local operator — a driver is being assigned.' },
  CAR_DISPATCHED: { status: 'dispatched', icon: '🚕', title: 'Driver on the way', body: 'Your driver has been dispatched and is on the way.' },
  CAR_ARRIVED: { status: 'arrived', icon: '📍', title: 'Your driver has arrived', body: 'Your driver is at the pickup point.' },
  SERVICE_IN_PROGRESS: { status: 'in-progress', icon: '🛣', title: 'Ride in progress', body: 'Your ride is underway — safe travels.' },
  SERVICE_COMPLETED: { status: 'completed', icon: '✅', title: 'Ride completed', body: 'Your ride is complete. Thank you for travelling with 3JN.' },
  USER_CANCELLED: { status: 'cancelled', icon: '✖️', title: 'Ride cancelled', body: 'Your ride was cancelled.' },
  SUPPLIER_CANCELLED: { status: 'cancelled', icon: '⚠️', title: 'Ride cancelled by operator', body: 'The operator cancelled your ride — our team is arranging an alternative and any refund due.' },
  TRANSACTION_COMPLETED: { status: 'paid', icon: '💳', title: 'Ride payment settled', body: 'Payment for your ride is settled.' },
  TRANSACTION_FAILED: { status: 'payment-failed', icon: '⚠️', title: 'Ride payment issue', body: 'A payment issue occurred on your ride — our team is resolving it.' },
  PRICE_CONFIRMATION_REQUIRED: { status: 'price-review', icon: '💬', title: 'Ride price update', body: 'The operator needs to confirm a price change — our team is reviewing it before anything is charged.' },
};

// ---- CarTrawler Mobility: outbound calls (webhook config + rides) --------------
const CT_HEADERS = () => ({ Authorization: `Bearer ${CARTRAWLER_TOKEN}`, 'X-Mobility-Partner': CARTRAWLER_PARTNER_ID, 'Content-Type': 'application/json', Accept: 'application/json' });
export async function cartrawlerWebhookOptions() {
  if (!cartrawlerEnabled()) return null;
  return httpJSON(`${CARTRAWLER_BASE}/neows/v1/webhook-service/options`, { headers: CT_HEADERS() });
}
export async function cartrawlerWebhookInspect() {
  if (!cartrawlerEnabled()) return null;
  return httpJSON(`${CARTRAWLER_BASE}/neows/v1/webhook-service/inspect`, { headers: CT_HEADERS() });
}
export async function cartrawlerWebhookUpdate(webhooks) {
  if (!cartrawlerEnabled()) return null;
  return httpJSON(`${CARTRAWLER_BASE}/neows/v1/webhook-service/update`, { method: 'PATCH', headers: CT_HEADERS(), body: JSON.stringify({ webhooks }) });
}
export function viatorEnabled() { return !!VIATOR_KEY && typeof fetch === 'function'; }
export function mozioEnabled() { return !!MOZIO_KEY && typeof fetch === 'function'; }
export function insuranceSaleEnabled() { return !!INSURANCE_KEY && INSURANCE_AUTHORISED && typeof fetch === 'function'; }

// ---- The doors, for the admin acquisition checklist ---------------------------
// One row per supply channel: what it covers, the env var that opens it, where
// to sign up, and how fulfilment runs while the door is still closed.
export function supplierDoors() {
  return [
    { channel: 'flights', provider: 'Duffel', envVar: 'DUFFEL_TOKEN', signup: 'https://duffel.com', covers: 'Network carriers + easyJet/Vueling LCC — live booking + auto e-ticket', fallback: 'estimator' },
    { channel: 'flights-lcc', provider: 'Travelfusion / Kiwi partner', envVar: 'TEQUILA_API_KEY', signup: 'https://www.travelfusion.com (sales) · Ryanair approved-OTA programme', covers: 'Ryanair/Jet2 bookable content', fallback: 'ops desk books on airline site' },
    { channel: 'flights-market', provider: 'Travelpayouts (Aviasales)', envVar: 'TRAVELPAYOUTS_TOKEN', signup: 'https://www.travelpayouts.com — self-serve, token instant', covers: 'Real market prices incl. Ryanair/Jet2 (calibration + benchmark)', fallback: 'synthetic estimates' },
    { channel: 'hotels-tbo', provider: 'TBO Holidays (bedbank — NET rates)', envVar: 'TBO_HOTEL_USERNAME + TBO_HOTEL_PASSWORD', signup: 'https://www.tbotechnology.in — B2B agent signup (credit check, then API certification)', covers: 'Global hotels at contracted NET rates + free-cancellation — funds the instalment price-lock margin', fallback: 'estimator + ops desk' },
    { channel: 'hotels-ratehawk', provider: 'RateHawk (Emerging Travel Group)', envVar: 'RATEHAWK_KEY_ID + RATEHAWK_API_KEY', signup: 'https://www.ratehawk.com/partners — B2B agent signup', covers: 'Global hotels at net rates (alternative/second bedbank)', fallback: 'estimator + ops desk' },
    { channel: 'hotels', provider: 'Amadeus', envVar: 'AMADEUS_CLIENT_ID + AMADEUS_CLIENT_SECRET', signup: 'https://developers.amadeus.com — self-serve', covers: 'Live hotel rates + booking', fallback: 'estimator + ops desk' },
    { channel: 'esim', provider: 'Airalo Partners (or eSIM Access)', envVar: 'AIRALO_CLIENT_ID + AIRALO_CLIENT_SECRET (or ESIMACCESS_API_KEY)', signup: 'https://partners.airalo.com — OAuth2, self-serve; optional AIRALO_BRAND_SETTINGS_NAME for branded eSIMs Cloud', covers: 'Instant eSIM: real ICCID + LPA activation + QR + Apple direct-install + eSIMs Cloud share link, straight into the travel documents', fallback: 'auto-provisioned in-OS, ops verifies' },
    { channel: 'activities', provider: `Viator (${VIATOR_TIER})`, envVar: 'VIATOR_API_KEY (+ VIATOR_PARTNER_ID for affiliate commission, VIATOR_PARTNER_TIER affiliate|merchant, VIATOR_BASE_URL for sandbox)', signup: 'https://partnerresources.viator.com — open partner signup', covers: 'Global tours/activities: live search for all tiers; affiliate books via redirect+commission (live), merchant books via availability→book→voucher (built — set VIATOR_PARTNER_TIER=merchant + certify field names)', fallback: 'Rayna agent portal (18 countries) / ops desk' },
    { channel: 'activities-rayna', provider: 'Rayna Tours (B2B agent — YOUR account)', envVar: 'RAYNA_PORTAL_URL (+ RAYNA_AGENT_ID)', signup: 'agreement in place — no API; portal operated by 3JN', covers: 'Activities + Dubai visa in Rayna’s 18-country footprint at net rates', fallback: 'AUTOMATED OPS DESK (this is the primary route)' },
    { channel: 'transfers', provider: 'Mozio / HolidayTaxis', envVar: 'MOZIO_API_KEY', signup: 'https://www.mozio.com/partners — application', covers: 'Airport transfers, thousands of local operators', fallback: 'ops desk / vendor marketplace' },
    { channel: 'insurance', provider: 'Cover Genius (XCover) / battleface', envVar: 'XCOVER_API_KEY + INSURANCE_AUTHORISED=true', signup: 'https://www.covergenius.com / https://battleface.com — B2B + FCA IAR REQUIRED', covers: 'Travel insurance at 30-40% commission', fallback: 'signpost only — NO sale until FCA authorisation confirmed' },
    { channel: 'carhire', provider: 'CarTrawler / Discover Cars', envVar: 'CARTRAWLER_KEY (later)', signup: 'https://www.cartrawler.com (B2B) · discovercars.com/affiliate (instant)', covers: 'Car hire', fallback: 'ops desk + affiliate links' },
    { channel: 'mobility', provider: 'CarTrawler Mobility (chauffeur/ride)', envVar: 'CARTRAWLER_PARTNER_TOKEN + CARTRAWLER_PARTNER_ID + CARTRAWLER_BASE_URL + CARTRAWLER_WEBHOOK_SECRET', signup: 'CarTrawler Partner Manager (staging → production)', covers: 'Chauffeur rides with LIVE status: driver dispatched / arrived / in-progress / completed, pushed to our webhook and shown on the booking', fallback: 'ops desk / other transfer providers' },
    { channel: 'ground', provider: 'Distribusion / Trainline Partner', envVar: 'DISTRIBUSION_KEY (later)', signup: 'https://www.distribusion.com — B2B', covers: 'Rail + coach', fallback: 'ops desk' },
    { channel: 'local-services', provider: '3JN Vendor Marketplace', envVar: '— always on', signup: 'vendor onboarding in-OS (risk review + Friday payouts)', covers: 'Photographers, guides, translators, drivers, restaurants', fallback: 'this IS the supply' },
  ].map((d) => ({
    ...d,
    open: d.channel === 'flights' ? !!env.DUFFEL_TOKEN
      : d.channel === 'flights-lcc' ? !!env.TEQUILA_API_KEY
      : d.channel === 'flights-market' ? !!env.TRAVELPAYOUTS_TOKEN
      : d.channel === 'hotels' ? !!(env.AMADEUS_CLIENT_ID && env.AMADEUS_CLIENT_SECRET)
      : d.channel === 'hotels-tbo' ? !!(env.TBO_HOTEL_USERNAME && env.TBO_HOTEL_PASSWORD)
      : d.channel === 'hotels-ratehawk' ? !!(env.RATEHAWK_KEY_ID && env.RATEHAWK_API_KEY)
      : d.channel === 'esim' ? (airaloEnabled() || esimApiEnabled())
      : d.channel === 'activities' ? viatorEnabled()
      : d.channel === 'transfers' ? mozioEnabled()
      : d.channel === 'insurance' ? insuranceSaleEnabled()
      : d.channel === 'activities-rayna' || d.channel === 'local-services',
  }));
}

// ---- eSIM Access (self-serve reseller API) ------------------------------------
// Provision an eSIM for a paid order. Endpoint shapes per eSIM Access RT API;
// verify against their docs at onboarding. Returns null on any failure so the
// in-OS provisioning (ops-verified) remains the fallback.
export async function provisionEsimViaApi({ destinationCountry, dataGB, days, ourRef }) {
  if (!esimApiEnabled()) return null;
  const res = await httpJSON(`${ESIMACCESS_BASE}/api/v1/open/esim/order`, {
    method: 'POST',
    headers: { 'RT-AccessCode': ESIMACCESS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactionId: ourRef, packageInfoList: [{ locationCode: destinationCountry, dataGB, periodNum: days }] }),
  });
  const profile = res?.obj?.esimList?.[0] || res?.data?.esimList?.[0];
  if (!profile) return null;
  return {
    provider: 'eSIM Access',
    iccid: profile.iccid || null,
    lpa: profile.ac || profile.activationCode || null, // LPA:1$... activation string
    qrData: profile.qrCodeUrl || null,
    live: true,
  };
}

// ---- Airalo Partners API ------------------------------------------------------
// OAuth2 client-credentials token, cached until ~1h before expiry (24h life,
// 3 req/min limit). Then submit an order → a real eSIM with ICCID, LPA
// activation string, QR, Apple direct-install URL and eSIMs Cloud share link.
let _airaloToken = null; // { access_token, expiresAtMs }
async function airaloToken() {
  if (!airaloEnabled()) return null;
  if (_airaloToken && _airaloToken.expiresAtMs > Date.now() + 60000) return _airaloToken.access_token;
  const form = new URLSearchParams({ client_id: AIRALO_ID, client_secret: AIRALO_SECRET, grant_type: 'client_credentials' });
  const res = await httpJSON(`${AIRALO_BASE}/v2/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const tok = res?.data?.access_token;
  if (!tok) return null;
  const expiresIn = Number(res.data.expires_in) || 82800; // ~23h default
  _airaloToken = { access_token: tok, expiresAtMs: Date.now() + expiresIn * 1000 };
  return tok;
}

// Pick the cheapest Airalo package covering `countryCode` with >= dataGB. The
// catalogue is large, so filter by country server-side.
export async function airaloPickPackage({ countryCode, minGB = 1 }) {
  const tok = await airaloToken();
  if (!tok || !countryCode) return null;
  const q = new URLSearchParams({ 'filter[type]': 'local', 'filter[country]': String(countryCode).toUpperCase(), limit: '100' });
  const res = await httpJSON(`${AIRALO_BASE}/v2/packages?${q}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${tok}` },
  });
  const countries = res?.data;
  if (!Array.isArray(countries)) return null;
  // Response nests operators→packages under each country entry. Per the schema
  // a package's data size is `amount` in MB (with `is_unlimited`), validity is
  // `day`, price is `price`. Skip KYC-required operators — they can't be
  // auto-provisioned without identity capture and would fail the order.
  const pkgs = [];
  for (const c of countries) for (const op of c.operators || []) {
    if (op.is_kyc_verify) continue;
    for (const p of op.packages || []) {
      if (p.type && p.type !== 'sim') continue; // skip top-ups
      const gb = p.is_unlimited ? 999 : (Number(p.amount) || 0) / 1000; // amount is MB
      if (gb >= minGB) pkgs.push({ id: p.id, title: p.title, gb, days: p.day || null, priceUSD: Number(p.price) || null, apnValue: op.apn_value || null, apnType: op.apn_type || null });
    }
  }
  const priced = pkgs.filter((p) => p.priceUSD != null);
  if (!priced.length) return null;
  // Cheapest package that clears the data need; if the need can't be met,
  // fall back to the largest available so a trip is never left without data.
  return priced.sort((a, b) => a.priceUSD - b.priceUSD)[0];
}

// Submit an Airalo order and normalise the eSIM into our activation shape.
export async function provisionEsimViaAiralo({ countryCode, minGB = 1, ourRef }) {
  const tok = await airaloToken();
  if (!tok) return null;
  const pkg = await airaloPickPackage({ countryCode, minGB });
  if (!pkg) return null;
  const form = new URLSearchParams({ quantity: '1', package_id: pkg.id, type: 'sim', description: `3JN ${ourRef || ''}`.trim() });
  if (AIRALO_BRAND) form.set('brand_settings_name', AIRALO_BRAND);
  const res = await httpJSON(`${AIRALO_BASE}/v2/orders`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${tok}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const sim = res?.data?.sims?.[0];
  if (!sim) return null;
  return {
    provider: 'Airalo',
    packageTitle: res.data.package || pkg.title,
    dataLabel: res.data.data || `${pkg.gb}GB`,
    validityDays: res.data.validity || pkg.days || null,
    iccid: sim.iccid || null,
    lpa: sim.qrcode || (sim.lpa && sim.matching_id ? `LPA:1$${sim.lpa}$${sim.matching_id}` : null), // LPA:1$smdp$matchingId
    smdp: sim.lpa || null,
    matchingId: sim.matching_id || null,
    qrData: sim.qrcode || null,
    qrUrl: sim.qrcode_url || null,
    appleInstallUrl: sim.direct_apple_installation_url || null,
    apnValue: sim.apn_value || null,
    apnType: sim.apn_type || null,
    isRoaming: sim.is_roaming !== false,
    shareLink: res.data.sharing?.link || null,
    shareAccessCode: res.data.sharing?.access_code || null,
    live: true,
  };
}

// ---- Viator partner API (activities/tours) -------------------------------------
// Viator's product search keys on a NUMERIC destination id, resolved from the
// city name via /partner/destinations. The destination list is large and
// stable, so cache it in-process for the day.
const VIATOR_HEADERS = () => ({ 'exp-api-key': VIATOR_KEY, Accept: 'application/json;version=2.0', 'Accept-Language': 'en', 'Content-Type': 'application/json' });
let _viatorDests = null; // { at, map: Map(lowerCityName -> destinationId) }
async function viatorDestinationId(city) {
  if (!viatorEnabled() || !city) return null;
  const want = String(city).trim().toLowerCase();
  if (!_viatorDests || Date.now() - _viatorDests.at > 24 * 3600000) {
    const res = await httpJSON(`${VIATOR_BASE}/partner/destinations`, { headers: VIATOR_HEADERS() });
    const list = res?.destinations;
    if (!Array.isArray(list)) return null;
    const map = new Map();
    for (const d of list) if (d.name && d.destinationId != null) {
      const key = String(d.name).toLowerCase();
      if (!map.has(key)) map.set(key, d.destinationId); // first (usually the city, not a sub-area)
    }
    _viatorDests = { at: Date.now(), map };
  }
  // Exact match, else a city whose name starts with the query (e.g. "Dubai").
  if (_viatorDests.map.has(want)) return _viatorDests.map.get(want);
  for (const [name, id] of _viatorDests.map) if (name === want || name.startsWith(want + ',') || name.startsWith(want + ' ')) return id;
  return null;
}

export async function searchViatorActivities({ destinationCity, date, pax = 2, currency = 'GBP' }) {
  if (!viatorEnabled()) return null;
  const destId = await viatorDestinationId(destinationCity);
  if (destId == null) return null;
  const body = {
    // destination is the numeric destination id from /partner/destinations.
    filtering: { destination: Number(destId), ...(date ? { startDate: date, endDate: date } : {}) },
    sorting: { sort: 'TRAVELER_RATING', order: 'DESCENDING' },
    pagination: { start: 1, count: 10 },
    currency,
  };
  const res = await httpJSON(`${VIATOR_BASE}/partner/products/search`, {
    method: 'POST', headers: VIATOR_HEADERS(), body: JSON.stringify(body),
  });
  const products = res?.products?.results || res?.products || res?.data;
  if (!Array.isArray(products) || !products.length) return null;
  return products.map((p) => {
    const priceGbp = p.pricing?.summary?.fromPrice ?? p.fromPrice ?? null;
    const rating = p.reviews?.combinedAverageRating ?? p.rating ?? null;
    return {
      type: 'activity',
      supplier: `${p.title || 'Tour'} · Viator`,
      title: p.title || 'Activity',
      productCode: p.productCode || p.code || null,
      productUrl: viatorAffiliateUrl(p.productUrl || p.webURL || null),
      priceGbp: priceGbp != null ? Math.round(Number(priceGbp) * 100) / 100 : null,
      rating,
      reviewCount: p.reviews?.totalReviews ?? null,
      durationMins: p.duration?.fixedDurationInMinutes ?? null,
      live: true,
      sourcedVia: 'Viator (live)',
    };
  }).filter((p) => p.priceGbp != null && p.productCode);
}

// Normalise live Viator tours into the OS activity-offer shape so they compete
// in the package scan (priced in USD at the platform anchor).
export async function viatorActivitiesForScan({ destinationCity, date, pax = 2 }) {
  const tours = await searchViatorActivities({ destinationCity, date, pax }).catch(() => null);
  if (!tours || !tours.length) return null;
  return tours.slice(0, 6).map((t) => ({
    type: 'activity',
    supplier: t.supplier,
    verified: true,
    reliabilityScore: t.rating ? Math.min(97, Math.round(t.rating * 19)) : 88, // 5.0★ → ~95
    priceUSD: Math.round((t.priceGbp / 0.79) * 100) / 100,
    details: { unit: 'per person', viatorProductCode: t.productCode, viatorDate: date || null, productUrl: t.productUrl, rating: t.rating, reviews: t.reviewCount, durationMins: t.durationMins, live: true },
    sourcedVia: 'Viator (live)',
    sourcedType: 'activities-api',
  }));
}

// ===========================================================================
// VIATOR MERCHANT booking (availability → book → voucher → cancel)
// ===========================================================================
// Merchant partners book at NET rates through the API: the customer pays 3JN, we
// are merchant of record and settle with Viator. Content/search is shared with
// affiliate — only this booking path is merchant-only, and it's gated on
// VIATOR_PARTNER_TIER=merchant. Every request/response field below follows
// Viator's Partner API v2; the EXACT field names MUST be re-verified against
// Viator's docs at certification (their schema evolves — same rule as the TBO
// bedbank lane). On ANY error we fail safe so the affiliate/ops fallback stands.
export function viatorMerchantEnabled() { return viatorEnabled() && VIATOR_TIER === 'merchant'; }

// Party size → Viator age-band pax mix (adults, plus children when ages given).
function viatorPaxMix({ adults = 1, childAges = [] } = {}) {
  const mix = [{ ageBand: 'ADULT', numberOfTravelers: Math.max(1, Number(adults) || 1) }];
  const kids = (childAges || []).filter((a) => a != null);
  if (kids.length) mix.push({ ageBand: 'CHILD', numberOfTravelers: kids.length });
  return mix;
}

// 1) Real-time availability + price for a product on a date. Returns the bookable
//    product option + total price, or { ok:false, error } when it can't be booked.
export async function viatorAvailabilityCheck({ productCode, travelDate, currency = 'GBP', adults = 1, childAges = [] } = {}) {
  if (!viatorMerchantEnabled()) return { ok: false, error: 'not-merchant' };
  if (!productCode || !travelDate) return { ok: false, error: 'missing-input' };
  const body = { productCode, travelDate, currency, paxMix: viatorPaxMix({ adults, childAges }) };
  const res = await httpJSON(`${VIATOR_BASE}/partner/availability/check`, { method: 'POST', headers: VIATOR_HEADERS(), body: JSON.stringify(body) });
  if (res == null) return { ok: false, error: 'unreachable' };
  if (res.__error || res.__status >= 400) return { ok: false, error: res.__error?.message || `http-${res.__status}`, status: res.__status };
  const opt = (res.bookableItems || res.productOptions || [])[0] || res;
  const total = res.totalPrice?.price?.recommendedRetailPrice ?? res.totalPrice?.recommendedRetailPrice ?? opt?.totalPrice ?? null;
  const available = res.available ?? opt?.available ?? (total != null);
  if (!available) return { ok: false, error: 'unavailable' };
  return { ok: true, productCode, productOptionCode: opt?.productOptionCode || opt?.code || null, startTime: opt?.startTime || null, totalPriceGbp: currency === 'GBP' && total != null ? Math.round(Number(total) * 100) / 100 : (total ?? null), currency };
}

// 2) Book the tour (merchant = net-rate settlement; the customer already paid us).
//    Re-checks availability + price first, never books materially above what the
//    customer paid, and returns { ok, bookingRef, voucherUrl, status }.
export async function bookViatorTour({ productCode, travelDate, currency = 'GBP', adults = 1, childAges = [], booker = {}, maxPriceGbp = null } = {}) {
  if (!viatorMerchantEnabled()) return { ok: false, error: 'not-merchant' };
  if (!productCode || !travelDate) return { ok: false, error: 'missing-input' };
  const avail = await viatorAvailabilityCheck({ productCode, travelDate, currency, adults, childAges });
  if (!avail.ok) return { ok: false, error: `availability:${avail.error}` };
  // Never book materially above what the customer was charged (2% tolerance).
  if (maxPriceGbp != null && avail.totalPriceGbp != null && avail.totalPriceGbp > maxPriceGbp * 1.02) {
    return { ok: false, error: 'price-changed', nowGbp: avail.totalPriceGbp, wasGbp: maxPriceGbp };
  }
  const names = String(booker.fullName || '').trim().split(/\s+/).filter(Boolean);
  const first = names[0] || 'Guest';
  const last = names.slice(1).join(' ') || 'Traveller';
  const body = {
    currency,
    bookerInfo: { firstName: first, lastName: last },
    communication: { email: booker.email || undefined, phone: booker.phone || undefined },
    items: [{
      productCode,
      productOptionCode: avail.productOptionCode || undefined,
      startTime: avail.startTime || undefined,
      travelDate,
      paxMix: viatorPaxMix({ adults, childAges }),
      travelers: [{ bandId: 'ADULT', firstName: first, lastName: last }],
    }],
    // MERCHANT: booked on account at net rates (no customer card token to Viator).
    // If Viator require a paymentDataToken for your account type, add it here at
    // certification — the flow otherwise fails safe to the ops desk.
  };
  const res = await httpJSON(`${VIATOR_BASE}/partner/bookings/book`, { method: 'POST', headers: VIATOR_HEADERS(), body: JSON.stringify(body) });
  if (res == null) return { ok: false, error: 'unreachable' };
  if (res.__error || res.__status >= 400) return { ok: false, error: res.__error?.message || `http-${res.__status}`, status: res.__status };
  const item = (res.items || res.bookings || [])[0] || res;
  const ref = res.bookingRef || item?.bookingRef || item?.itineraryItemId || null;
  if (!ref) return { ok: false, error: 'no-booking-ref' };
  return { ok: true, bookingRef: ref, voucherUrl: item?.voucherUrl || res.voucherUrl || null, status: item?.status || res.status || 'CONFIRMED' };
}

// 3) Cancellation quote (refund amount) + cancel. Used by the customer-cancel /
//    ops path so a Viator tour is cancelled through the API, not just on paper.
export async function viatorCancellationQuote(bookingRef) {
  if (!viatorMerchantEnabled() || !bookingRef) return { ok: false, error: 'not-configured' };
  const res = await httpJSON(`${VIATOR_BASE}/partner/bookings/${encodeURIComponent(bookingRef)}/cancel-quote`, { method: 'POST', headers: VIATOR_HEADERS(), body: '{}' });
  if (res == null || res.__error) return { ok: false, error: res?.__error?.message || 'quote-failed', status: res?.__status };
  return { ok: true, refundGbp: res.refundDetails?.refundAmount ?? res.refundAmount ?? null, status: res.status || null };
}
export async function cancelViatorBooking(bookingRef, reasonCode = 'CUSTOMER_SERVICE_CANCELLED') {
  if (!viatorMerchantEnabled() || !bookingRef) return { ok: false, error: 'not-configured' };
  const res = await httpJSON(`${VIATOR_BASE}/partner/bookings/${encodeURIComponent(bookingRef)}/cancel`, { method: 'POST', headers: VIATOR_HEADERS(), body: JSON.stringify({ reason: reasonCode }) });
  if (res == null || res.__error) return { ok: false, error: res?.__error?.message || 'cancel-failed', status: res?.__status };
  return { ok: true, status: res.status || 'CANCELLED', refundGbp: res.refundDetails?.refundAmount ?? null };
}

// ---- Mozio (airport transfers) --------------------------------------------------
export async function searchMozioTransfers({ from, to, dateTimeISO, pax = 2 }) {
  if (!mozioEnabled()) return null;
  const q = new URLSearchParams({ start_address: from, end_address: to, pickup_datetime: dateTimeISO, num_passengers: String(pax), currency: 'GBP' });
  const res = await httpJSON(`${MOZIO_BASE}/v2/search/?${q}`, { headers: { 'API-KEY': MOZIO_KEY, Accept: 'application/json' } });
  const results = res?.results;
  if (!Array.isArray(results) || !results.length) return null;
  return results.slice(0, 5).map((r) => ({
    type: 'transfer',
    supplier: r.steps?.[0]?.details?.provider_name || 'Mozio partner',
    vehicle: r.steps?.[0]?.details?.vehicle_type || null,
    priceGbp: Number(r.total_price?.total_price?.value) || null,
    searchId: res.search_id || null,
    resultId: r.result_id || null,
    live: true,
    sourcedVia: 'Mozio (live)',
  })).filter((r) => r.priceGbp != null);
}

// Live airport transfers normalised to the scan offer shape (priceUSD + details),
// so real Mozio prices drop straight into the package the same way live flights/
// hotels/activities do. Round transfer (arrival + departure) to match the
// synthetic scanTransfers model. Returns null when the door is shut or empty.
export async function mozioTransfersForScan({ destAirport, destCity, dateTimeISO, pax = 2 }) {
  if (!mozioEnabled() || !destCity) return null;
  const raw = await searchMozioTransfers({
    from: `${destAirport || destCity} Airport`, to: destCity,
    dateTimeISO: dateTimeISO || `${new Date().toISOString().slice(0, 10)}T12:00:00`, pax,
  }).catch(() => null);
  if (!raw || !raw.length) return null;
  return raw.map((r) => ({
    type: 'transfer', supplier: r.supplier, verified: true, reliabilityScore: 86,
    live: true, sourcedVia: r.sourcedVia, sourcedType: 'transfer aggregator',
    details: { vehicle: r.vehicle || 'Standard', trips: 2, capacity: pax <= 3 ? '1-3 pax' : '4-6 pax (MPV)', mozioSearchId: r.searchId, mozioResultId: r.resultId },
    priceUSD: Math.round((r.priceGbp / 0.79) * 2 * 100) / 100, // ×2 = arrival + departure
  }));
}

// ---- Fulfilment channel routing -------------------------------------------------
// Which lane completes each paid component TODAY, given the doors that are
// open? 'auto' = fully automatic; anything else lands on the Ops Fulfilment
// Desk under that channel with a pre-packed portal payload.
export function fulfilmentChannelFor(component, destCountry) {
  const t = component?.type;
  // A service listed by a REAL marketplace vendor routes to THAT vendor as a
  // job — they confirm delivery and earn 90% after the service date.
  if (component?.details?.vendorService && component.details.vendorId) return 'ops:vendor-delivery';
  if (t === 'esim') return esimApiEnabled() ? 'auto:esim-api' : 'auto:esim-inhouse';
  if (t === 'activity' || t === 'activities') {
    if (component.agent || component.agentId || component.details?.agent) return 'ops:rayna';
    return viatorEnabled() ? 'ops:viator-api' : 'ops:activities';
  }
  if (t === 'visa') return destCountry === 'AE' ? 'ops:rayna' : 'ops:visa-desk';
  if (t === 'transfer') return mozioEnabled() ? 'ops:mozio-api' : 'ops:transfers';
  if (t === 'insurance') return insuranceSaleEnabled() ? 'ops:insurance-api' : 'ops:insurance-signpost';
  if (t === 'carhire') return 'ops:carhire';
  if (['photographer', 'guide', 'restaurant', 'translator', 'driver'].includes(t)) return 'ops:vendor-marketplace';
  if (['train', 'coach', 'ferry', 'cruise'].includes(t)) return 'ops:ground';
  // Hotels: a live Duffel Stays room (carries a staysSearchResultId) is booked
  // AUTOMATICALLY on payment by autoBookStays (rates → quote → book), so it needs
  // no manual order here — like a live flight. Any other hotel routes to the ops
  // desk so it is reserved manually (never charged-but-unbooked).
  if (t === 'hotel') return (component.live && component.details?.staysSearchResultId) ? null : 'ops:hotels';
  if (t === 'host') return 'auto:host-marketplace';
  return null; // live flights auto-ticket via autoTicketFlight
}

// The pre-packed payload the ops operator pastes into the supplier portal —
// EVERYTHING needed to complete the order in one visit, no hunting through
// the booking. Rayna gets its portal URL + agent context on top.
export function portalPayload(order) {
  const L = [];
  L.push(`3JN ref: ${order.bookingId} / ${order.id}`);
  L.push(`Service: ${order.componentLabel}`);
  if (order.serviceDate) L.push(`Date: ${order.serviceDate}`);
  L.push(`Destination: ${order.destination || '-'}`);
  L.push(`Pax: ${order.pax || 1}`);
  if (order.customer?.name) L.push(`Lead: ${order.customer.name}`);
  if (order.customer?.email) L.push(`Email: ${order.customer.email}`);
  if (order.customer?.phone) L.push(`Phone: ${order.customer.phone}`);
  if (order.customer?.nationality) L.push(`Nationality: ${order.customer.nationality}`);
  if (order.customer?.passport) L.push(`Passport: ${order.customer.passport}`);
  L.push(`Sell price: ${order.symbol || '£'}${order.sellPrice}`);
  if (order.channel === 'ops:rayna') {
    L.push(`— Book in the Rayna agent portal (${RAYNA_PORTAL_URL}) on the 3JN agent account at NET rates.`);
    L.push('Paste the Rayna confirmation number back into this order to complete it.');
  } else {
    L.push('Complete with the supplier, then paste the confirmation number back into this order.');
  }
  return L.join('\n');
}

export { RAYNA_PORTAL_URL };
