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
const VIATOR_KEY = env.VIATOR_API_KEY || '';
const VIATOR_BASE = env.VIATOR_BASE_URL || 'https://api.viator.com';
const MOZIO_KEY = env.MOZIO_API_KEY || '';
const MOZIO_BASE = env.MOZIO_BASE_URL || 'https://api.mozio.com';
const INSURANCE_KEY = env.XCOVER_API_KEY || env.BATTLEFACE_API_KEY || '';
// LEGAL GATE: selling insurance in the UK is FCA-regulated. Even with a
// provider key, sales stay OFF until the IAR/authorisation is confirmed.
const INSURANCE_AUTHORISED = env.INSURANCE_AUTHORISED === 'true';
const RAYNA_PORTAL_URL = env.RAYNA_PORTAL_URL || 'https://agents.raynab2b.com';

export function esimApiEnabled() { return !!ESIMACCESS_KEY && typeof fetch === 'function'; }
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
    { channel: 'hotels', provider: 'Amadeus', envVar: 'AMADEUS_CLIENT_ID + AMADEUS_CLIENT_SECRET', signup: 'https://developers.amadeus.com — self-serve', covers: 'Live hotel rates + booking', fallback: 'estimator + ops desk' },
    { channel: 'esim', provider: 'eSIM Access', envVar: 'ESIMACCESS_API_KEY', signup: 'https://esimaccess.com — self-serve reseller, wholesale rates', covers: 'Instant eSIM provisioning (QR/LPA into documents automatically)', fallback: 'auto-provisioned in-OS, ops verifies' },
    { channel: 'activities', provider: 'Viator (+ GetYourGuide later)', envVar: 'VIATOR_API_KEY', signup: 'https://partnerresources.viator.com — open partner signup', covers: 'Global tours/activities catalogue, ~8% commission', fallback: 'Rayna agent portal (18 countries) / ops desk' },
    { channel: 'activities-rayna', provider: 'Rayna Tours (B2B agent — YOUR account)', envVar: 'RAYNA_PORTAL_URL (+ RAYNA_AGENT_ID)', signup: 'agreement in place — no API; portal operated by 3JN', covers: 'Activities + Dubai visa in Rayna’s 18-country footprint at net rates', fallback: 'AUTOMATED OPS DESK (this is the primary route)' },
    { channel: 'transfers', provider: 'Mozio / HolidayTaxis', envVar: 'MOZIO_API_KEY', signup: 'https://www.mozio.com/partners — application', covers: 'Airport transfers, thousands of local operators', fallback: 'ops desk / vendor marketplace' },
    { channel: 'insurance', provider: 'Cover Genius (XCover) / battleface', envVar: 'XCOVER_API_KEY + INSURANCE_AUTHORISED=true', signup: 'https://www.covergenius.com / https://battleface.com — B2B + FCA IAR REQUIRED', covers: 'Travel insurance at 30-40% commission', fallback: 'signpost only — NO sale until FCA authorisation confirmed' },
    { channel: 'carhire', provider: 'CarTrawler / Discover Cars', envVar: 'CARTRAWLER_KEY (later)', signup: 'https://www.cartrawler.com (B2B) · discovercars.com/affiliate (instant)', covers: 'Car hire', fallback: 'ops desk + affiliate links' },
    { channel: 'ground', provider: 'Distribusion / Trainline Partner', envVar: 'DISTRIBUSION_KEY (later)', signup: 'https://www.distribusion.com — B2B', covers: 'Rail + coach', fallback: 'ops desk' },
    { channel: 'local-services', provider: '3JN Vendor Marketplace', envVar: '— always on', signup: 'vendor onboarding in-OS (risk review + Friday payouts)', covers: 'Photographers, guides, translators, drivers, restaurants', fallback: 'this IS the supply' },
  ].map((d) => ({
    ...d,
    open: d.channel === 'flights' ? !!env.DUFFEL_TOKEN
      : d.channel === 'flights-lcc' ? !!env.TEQUILA_API_KEY
      : d.channel === 'flights-market' ? !!env.TRAVELPAYOUTS_TOKEN
      : d.channel === 'hotels' ? !!(env.AMADEUS_CLIENT_ID && env.AMADEUS_CLIENT_SECRET)
      : d.channel === 'esim' ? esimApiEnabled()
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

// ---- Viator partner API (activities) -------------------------------------------
export async function searchViatorActivities({ destination, date, pax = 2 }) {
  if (!viatorEnabled()) return null;
  const res = await httpJSON(`${VIATOR_BASE}/partner/products/search`, {
    method: 'POST',
    headers: { 'exp-api-key': VIATOR_KEY, Accept: 'application/json;version=2.0', 'Content-Type': 'application/json' },
    body: JSON.stringify({ filtering: { destination: String(destination) }, pagination: { start: 1, count: 8 }, currency: 'GBP' }),
  });
  const products = res?.products;
  if (!Array.isArray(products) || !products.length) return null;
  return products.map((p) => ({
    type: 'activity',
    supplier: 'Viator',
    title: p.title,
    productCode: p.productCode,
    priceGbp: p.pricing?.summary?.fromPrice ?? null,
    rating: p.reviews?.combinedAverageRating ?? null,
    live: true,
    sourcedVia: 'Viator (live)',
  })).filter((p) => p.priceGbp != null);
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

// ---- Fulfilment channel routing -------------------------------------------------
// Which lane completes each paid component TODAY, given the doors that are
// open? 'auto' = fully automatic; anything else lands on the Ops Fulfilment
// Desk under that channel with a pre-packed portal payload.
export function fulfilmentChannelFor(component, destCountry) {
  const t = component?.type;
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
  if (t === 'hotel' && !component.live) return 'ops:hotels';
  if (t === 'host') return 'auto:host-marketplace';
  return null; // live flights/hotels auto-ticket elsewhere
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
