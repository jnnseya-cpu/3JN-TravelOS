// Live supplier pricing (flights + hotels) for 3JN Travel OS.
//
// Real provider integrations — Duffel for flights, Duffel Stays for hotels (same
// token; Amadeus is an optional fallback) — that
// return offers normalised to the SAME shape as the deterministic engine, so
// the packager/pricing pipeline is unchanged. They follow the live-data.js
// principles:
//   - env-gated: inert unless the provider's keys are present,
//   - short timeouts so the UI never hangs,
//   - graceful fallback: any error / unreachable network returns null and the
//     caller uses the synthetic estimate (clearly labelled estimated vs live),
//   - provider currency is converted to USD via the live FX feed.
//
// Set the keys + enable outbound network in your deployment to switch the
// numbers from "estimated" to "live". Nothing here fabricates a price: if a
// provider doesn't answer, we return null rather than a made-up "live" figure.

import { fxRate, geocode } from './live-data.js';
import { estimateFlightFares } from './suppliers.js';
import { routeFareBaseUSD } from './airports.js';

const env = process.env;
const TIMEOUT_MS = Number(env.LIVE_SUPPLIERS_TIMEOUT_MS) || 6000;
// Flight fare searches (Duffel offer_requests) are the heaviest call — busy
// routes return hundreds of offers. Give them a longer deadline so major
// departure points (London, Birmingham, Manchester) come back live instead of
// timing out and falling back to the estimator like the quieter regional ones.
const FLIGHT_TIMEOUT_MS = Number(env.LIVE_FLIGHTS_TIMEOUT_MS) || 9000;

const DUFFEL_TOKEN = env.DUFFEL_TOKEN || env.DUFFEL_API_KEY || '';
const DUFFEL_BASE = env.DUFFEL_BASE_URL || 'https://api.duffel.com';
const DUFFEL_VERSION = env.DUFFEL_VERSION || 'v2';

const AMADEUS_ID = env.AMADEUS_CLIENT_ID || '';
const AMADEUS_SECRET = env.AMADEUS_CLIENT_SECRET || '';
const AMADEUS_BASE = env.AMADEUS_BASE_URL || 'https://api.amadeus.com';

// OAG has two products with separate subscription keys:
//  - Schedules: forward-looking scheduled services (best for a future trip date)
//  - Flight Info: operated flight instances (best near-term)
// Either gives the real carriers/times/non-stops we need; we prefer Schedules
// for a future departure and fall back to Flight Info. Both are priced by the
// deterministic estimator (OAG returns no fares).
const OAG_SCHEDULES_KEY = env.OAG_SCHEDULES_KEY || '';
const OAG_FLIGHTINFO_KEY = env.OAG_SUBSCRIPTION_KEY || env.OAG_FLIGHTINFO_KEY || env.OAG_API_KEY || '';
const OAG_BASE = env.OAG_BASE_URL || 'https://api.oag.com';

// Kiwi Tequila — the LOW-COST CARRIER door. Duffel carries network carriers
// (BA/KLM/Turkish…) but NOT Ryanair/Jet2/TUI, which are the airlines that
// actually serve UK regional airports like East Midlands. Without this key,
// routes like EMA→BRU can never return a live fare no matter how correct the
// code is. Free key: https://tequila.kiwi.com — set TEQUILA_API_KEY.
const TEQUILA_KEY = env.TEQUILA_API_KEY || env.KIWI_TEQUILA_KEY || '';
const TEQUILA_BASE = env.TEQUILA_BASE_URL || 'https://api.tequila.kiwi.com';

// Travelpayouts / Aviasales Data API — the SELF-SERVE market-data door.
// Kiwi Tequila went invitation-only, but Travelpayouts issues a token to any
// account immediately after signup (travelpayouts.com → Tools → API). Data is
// real fares from recent user searches (7-day cache) and INCLUDES Ryanair /
// Jet2 / Wizz — the carriers Duffel lacks. Cached market prices are NOT
// guaranteed bookable, so they NEVER enable real payment: they calibrate
// estimates and auto-fill the Market Benchmark with honest market quotes.
const TRAVELPAYOUTS_TOKEN = env.TRAVELPAYOUTS_TOKEN || env.AVIASALES_TOKEN || '';
const TRAVELPAYOUTS_BASE = env.TRAVELPAYOUTS_BASE_URL || 'https://api.travelpayouts.com';

export function duffelEnabled() { return !!DUFFEL_TOKEN && typeof fetch === 'function'; }
export function lccFlightsEnabled() { return !!TEQUILA_KEY && typeof fetch === 'function'; }
export function marketDataEnabled() { return !!TRAVELPAYOUTS_TOKEN && typeof fetch === 'function'; }
export function liveFlightsEnabled() { return duffelEnabled() || lccFlightsEnabled(); }
// Duffel Stays uses the SAME Duffel token as flights — so hotels can go live the
// moment flights work, with NO extra credentials. Amadeus stays as a fallback.
// Set DUFFEL_STAYS=false to disable the Stays path (e.g. to force Amadeus).
export function duffelStaysEnabled() { return duffelEnabled() && env.DUFFEL_STAYS !== 'false'; }
export function liveHotelsEnabled() { return (duffelStaysEnabled() || !!(AMADEUS_ID && AMADEUS_SECRET)) && typeof fetch === 'function'; }
export function oagScheduleEnabled() { return !!(OAG_SCHEDULES_KEY || OAG_FLIGHTINFO_KEY) && typeof fetch === 'function'; }
export function liveSuppliersConfigured() { return liveFlightsEnabled() || liveHotelsEnabled() || oagScheduleEnabled(); }

// IATA carrier code → display name (extend as needed; falls back to the code).
const CARRIER_NAMES = {
  BA: 'British Airways', EK: 'Emirates', QR: 'Qatar Airways', TK: 'Turkish Airlines',
  LH: 'Lufthansa', AF: 'Air France', KL: 'KLM', VS: 'Virgin Atlantic', EY: 'Etihad Airways',
  SQ: 'Singapore Airlines', CX: 'Cathay Pacific', AA: 'American Airlines', DL: 'Delta Air Lines',
  UA: 'United Airlines', IB: 'Iberia', AZ: 'ITA Airways', SV: 'Saudia', MS: 'EgyptAir',
  ET: 'Ethiopian Airlines', KQ: 'Kenya Airways', WY: 'Oman Air', GF: 'Gulf Air', W6: 'Wizz Air',
  FR: 'Ryanair', U2: 'easyJet', AT: 'Royal Air Maroc', QF: 'Qantas', NH: 'ANA', JL: 'Japan Airlines',
  LS: 'Jet2.com', SN: 'Brussels Airlines', VY: 'Vueling', TP: 'TAP Air Portugal', EW: 'Eurowings',
  PC: 'Pegasus Airlines', DY: 'Norwegian', BY: 'TUI Airways', HV: 'Transavia', TO: 'Transavia France',
  RK: 'Ryanair UK', EI: 'Aer Lingus', LO: 'LOT Polish Airlines', A3: 'Aegean Airlines',
};
const PREMIUM_CARRIERS = new Set(['EK', 'QR', 'SQ', 'EY', 'CX', 'QF', 'NH']);
function carrierName(iata) { return CARRIER_NAMES[iata] || (iata ? `${iata} (airline)` : 'Airline'); }

// ---- low-level fetch with timeout -----------------------------------------
// `opts.timeoutMs` overrides the default deadline — busy routes (e.g. LHR) return
// far larger offer sets than regional airports and need longer than the 6s used
// for quick calls, or they abort mid-response and silently fall back to estimates.
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

// Convert a provider amount in `currency` to USD. Falls back to the raw number
// when FX is unavailable and the currency is already USD; otherwise null so we
// never present an unconverted figure as USD.
async function toUSD(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const cur = (currency || 'USD').toUpperCase();
  if (cur === 'USD') return Math.round(n * 100) / 100;
  const rate = await fxRate(cur, 'USD'); // 1 unit of `cur` in USD
  if (typeof rate !== 'number') return null;
  return Math.round(n * rate * 100) / 100;
}

// ===========================================================================
// FLIGHTS — Duffel
// ===========================================================================

// Build the Duffel passenger list from our traveller party. Duffel prices by
// passenger type/age: adults explicit, children by age, infants on lap.
export function duffelPassengers(travellers) {
  const out = [];
  for (let i = 0; i < (travellers.adults || 1); i++) out.push({ type: 'adult' });
  const ages = Array.isArray(travellers.childAges) ? travellers.childAges : [];
  for (const age of ages) {
    if (age < 2) out.push({ type: 'infant_without_seat' });
    else out.push({ age });
  }
  // Children counted but without a stated age → assume age 8 (child band).
  const unpriced = Math.max(0, (travellers.children || 0) - ages.length);
  for (let i = 0; i < unpriced; i++) out.push({ age: 8 });
  return out;
}

function hhmm(iso) {
  // Duffel timestamps are local to the airport, e.g. "2026-08-17T20:05:00".
  const m = String(iso || '').match(/T(\d{2}:\d{2})/);
  return m ? m[1] : '';
}
function dateOf(iso) {
  const m = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}
// ISO-8601 duration "PT7H30M" → "7h 30m".
export function durationLabel(iso) {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return '';
  const h = +(m[1] || 0); const min = +(m[2] || 0);
  return `${h}h ${min}m`;
}

function sliceToLeg(slice) {
  const segs = slice.segments || [];
  if (!segs.length) return null;
  const first = segs[0]; const last = segs[segs.length - 1];
  const stops = segs.length - 1;
  // Per-segment detail — a connecting itinerary must tell the traveller WHICH
  // flights they are on, WHERE they change planes and HOW LONG each wait is.
  const segments = segs.map((s) => ({
    carrier: s.marketing_carrier?.name || s.operating_carrier?.name || '',
    flightNumber: `${s.marketing_carrier?.iata_code || s.operating_carrier?.iata_code || ''}${s.marketing_carrier_flight_number || s.operating_carrier_flight_number || ''}`,
    operatedBy: s.operating_carrier?.name && s.operating_carrier.name !== s.marketing_carrier?.name ? s.operating_carrier.name : null,
    from: s.origin?.iata_code || '', fromCity: s.origin?.city_name || s.origin?.name || '',
    to: s.destination?.iata_code || '', toCity: s.destination?.city_name || s.destination?.name || '',
    date: dateOf(s.departing_at), depart: hhmm(s.departing_at), arrive: hhmm(s.arriving_at),
    durationLabel: durationLabel(s.duration),
    aircraft: s.aircraft?.name || null,
  }));
  // Layover between consecutive segments. Duffel timestamps are LOCAL to the
  // airport, and both sides of a layover are the SAME airport, so a plain
  // difference is the true wait time.
  const layovers = [];
  for (let i = 1; i < segs.length; i++) {
    const mins = Math.round((new Date(segs[i].departing_at) - new Date(segs[i - 1].arriving_at)) / 60000);
    layovers.push({
      airport: segs[i].origin?.iata_code || '',
      city: segs[i].origin?.city_name || segs[i].origin?.name || '',
      minutes: mins > 0 ? mins : null,
      durationLabel: mins > 0 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : '',
      overnight: dateOf(segs[i].departing_at) !== dateOf(segs[i - 1].arriving_at),
      tight: mins > 0 && mins < 60, // under an hour — flag it so nobody misses a connection unwarned
    });
  }
  const viaLabel = layovers.length
    ? ` · via ${layovers.map((l) => `${l.city || l.airport} (${l.airport})${l.durationLabel ? ' ' + l.durationLabel + ' wait' : ''}`).join(', ')}`
    : '';
  return {
    from: first.origin?.iata_code || '', fromCity: first.origin?.city_name || first.origin?.name || '',
    to: last.destination?.iata_code || '', toCity: last.destination?.city_name || last.destination?.name || '',
    date: dateOf(first.departing_at),
    depart: hhmm(first.departing_at), arrive: hhmm(last.arriving_at),
    arriveNextDay: dateOf(last.arriving_at) !== dateOf(first.departing_at),
    durationLabel: durationLabel(slice.duration),
    stops, stopLabel: stops === 0 ? 'Direct' : `${stops} stop${stops > 1 ? 's' : ''}${viaLabel}`,
    segments, layovers,
  };
}

// Read the REAL baggage allowance a Duffel offer includes (per passenger, per
// segment). Duffel returns baggages as [{type:'checked'|'carry_on', quantity}].
// Produces a clear, human string; falls back to a cabin-only note when the fare
// includes no checked bag, or a generic line if the data is absent.
export function duffelBaggageLabel(offer) {
  const seg = offer?.slices?.[0]?.segments?.[0];
  const bags = seg?.passengers?.[0]?.baggages;
  if (!Array.isArray(bags) || !bags.length) return 'Cabin bag included · checked bags per fare rules';
  const checked = bags.filter((b) => b.type === 'checked').reduce((s, b) => s + (Number(b.quantity) || 0), 0);
  const carry = bags.filter((b) => b.type === 'carry_on').reduce((s, b) => s + (Number(b.quantity) || 0), 0);
  const parts = [];
  parts.push(carry > 0 ? `${carry} cabin bag${carry > 1 ? 's' : ''}` : 'Cabin bag');
  parts.push(checked > 0 ? `${checked} checked bag${checked > 1 ? 's' : ''} included` : 'no checked bag (add at booking)');
  return parts.join(' + ');
}

// Normalise one Duffel offer to our flight-offer shape. Returns null if the
// offer is unusable. `priceUSD` is pre-converted by the caller.
export function normalizeDuffelOffer(offer, priceUSD, travellers) {
  const slices = offer.slices || [];
  const outbound = slices[0] ? sliceToLeg(slices[0]) : null;
  const inbound = slices[1] ? sliceToLeg(slices[1]) : null;
  if (!outbound) return null;
  const carrier = offer.owner?.name || offer.slices?.[0]?.segments?.[0]?.marketing_carrier?.name || 'Airline';
  return {
    type: 'flight',
    supplier: carrier,
    verified: true,
    reliabilityScore: 90, // a real, ticketed Duffel offer from a known carrier
    premium: /emirates|qatar|singapore|etihad|cathay/i.test(carrier),
    live: true,
    sourcedVia: 'Duffel (live)',
    sourcedType: 'GDS',
    details: {
      outbound, inbound,
      passengers: travellers.total,
      cabin: offer.slices?.[0]?.segments?.[0]?.passengers?.[0]?.cabin_class_marketing_name || 'Economy',
      baggage: duffelBaggageLabel(offer),
      offerId: offer.id,
      // Real-money safety: a Duffel offer is only ticketable until it expires,
      // and can reprice. Store both so payment can RE-VALIDATE before charging.
      offerExpiresAt: offer.expires_at || null,
      liveAmount: offer.total_amount || null,
      liveCurrency: offer.total_currency || null,
      offerPassengers: (offer.passengers || []).map((p) => ({ id: p.id, type: p.type, age: p.age })),
    },
    priceUSD,
  };
}

// Re-validate a Duffel offer at PAYMENT time: is it still live, and at the same
// price? Prevents charging a customer for a stale/repriced fare we can't ticket.
// Returns { ok, live, expired, priceUSD, currency } or { ok:false } offline.
export async function validateDuffelOffer(offerId) {
  if (!duffelEnabled() || !offerId) return { ok: false, reason: 'not-configured' };
  const res = await httpJSON(`${DUFFEL_BASE}/air/offers/${encodeURIComponent(offerId)}`, {
    headers: {
      Authorization: `Bearer ${DUFFEL_TOKEN}`,
      'Duffel-Version': DUFFEL_VERSION,
      Accept: 'application/json',
    },
  });
  // Distinguish "offer genuinely gone" (HTTP 404/410) from "couldn't reach
  // Duffel" (network/timeout/5xx → httpJSON returns null, or a 5xx __status).
  // Only the former is a real expiry; a transient failure must NOT be reported
  // as expired or the caller may cancel/refund a fare that is actually fine.
  if (res == null || (res.__status && res.__status >= 500)) {
    return { ok: false, live: false, expired: false, reason: 'unreachable' };
  }
  if (res.__status === 404 || res.__status === 410) {
    return { ok: true, live: false, expired: true, reason: 'offer-gone' };
  }
  const offer = res.data;
  if (!offer) return { ok: false, live: false, expired: false, reason: 'unexpected-response' };
  const expired = offer.expires_at ? (Date.parse(offer.expires_at) < Date.now()) : false;
  const usd = await toUSD(offer.total_amount, offer.total_currency);
  return { ok: true, live: !expired, expired, priceUSD: usd, amount: offer.total_amount, currency: offer.total_currency, expiresAt: offer.expires_at };
}

// A tiny connectivity self-test for admin: confirms the Duffel token works and
// whether it is a TEST or LIVE key (test tokens start with 'duffel_test').
// Create a Duffel ORDER against a live offer — this ISSUES THE TICKET.
// Called on payment success (money already captured). Duffel is paid from the
// balance (mode 'balance') by default. Returns { ok, order:{...} } or
// { ok:false, error } — the caller triggers a refund on failure.
export async function createDuffelOrder({ offerId, passengers = [], paymentAmount, paymentCurrency, paymentType = 'balance' } = {}) {
  if (!duffelEnabled() || !offerId) return { ok: false, error: 'not-configured' };
  const body = {
    data: {
      type: 'instant',
      selected_offers: [offerId],
      passengers,
      payments: [{ type: paymentType, amount: String(paymentAmount), currency: paymentCurrency }],
    },
  };
  const res = await httpJSON(`${DUFFEL_BASE}/air/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DUFFEL_TOKEN}`,
      'Duffel-Version': DUFFEL_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res?.__error || !res?.data) {
    return { ok: false, error: res?.__error?.errors?.[0]?.message || res?.__error?.message || 'duffel-order-failed', status: res?.__status };
  }
  const o = res.data;
  const ticketNumbers = [];
  for (const d of (o.documents || [])) if (d.type === 'electronic_ticket' && d.unique_identifier) ticketNumbers.push(d.unique_identifier);
  return {
    ok: true,
    order: {
      id: o.id,
      bookingReference: o.booking_reference || null,
      ticketNumbers,
      passengers: (o.passengers || []).map((p) => ({ name: `${p.given_name || ''} ${p.family_name || ''}`.trim() })),
      totalAmount: o.total_amount, totalCurrency: o.total_currency,
    },
  };
}
// HOLD order — reserve the fare WITHOUT paying yet (for pay-monthly / instalments).
// The airline holds the price until payment_required_by; we pay to ticket once
// the customer has finished paying us. Only works on offers that allow holds.
export async function createDuffelHoldOrder({ offerId, passengers = [] }) {
  if (!duffelEnabled() || !offerId) return { ok: false, error: 'not-configured' };
  const res = await httpJSON(`${DUFFEL_BASE}/air/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DUFFEL_TOKEN}`, 'Duffel-Version': DUFFEL_VERSION, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ data: { type: 'hold', selected_offers: [offerId], passengers } }),
  });
  if (res?.__error || !res?.data) return { ok: false, error: res?.__error?.errors?.[0]?.message || 'hold-failed', status: res?.__status };
  const o = res.data;
  return { ok: true, order: { id: o.id, bookingReference: o.booking_reference || null, paymentRequiredBy: o.payment_status?.payment_required_by || null, priceGuaranteeExpiresAt: o.payment_status?.price_guarantee_expires_at || null, totalAmount: o.total_amount, totalCurrency: o.total_currency } };
}
// Pay a held order from balance → ISSUES THE TICKET. Called when the customer
// has finished paying us (final instalment) or immediately for pay-in-full.
export async function payDuffelOrder({ orderId, amount, currency }) {
  if (!duffelEnabled() || !orderId) return { ok: false, error: 'not-configured' };
  const res = await httpJSON(`${DUFFEL_BASE}/air/payments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DUFFEL_TOKEN}`, 'Duffel-Version': DUFFEL_VERSION, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ data: { order_id: orderId, payment: { type: 'balance', amount: String(amount), currency } } }),
  });
  if (res?.__error || !res?.data) return { ok: false, error: res?.__error?.errors?.[0]?.message || 'pay-failed', status: res?.__status };
  // Fetch the order to read the issued e-tickets.
  const ord = await httpJSON(`${DUFFEL_BASE}/air/orders/${orderId}`, { headers: { Authorization: `Bearer ${DUFFEL_TOKEN}`, 'Duffel-Version': DUFFEL_VERSION, Accept: 'application/json' } });
  const o = ord?.data || {};
  const ticketNumbers = [];
  for (const d of (o.documents || [])) if (d.type === 'electronic_ticket' && d.unique_identifier) ticketNumbers.push(d.unique_identifier);
  return { ok: true, order: { id: orderId, bookingReference: o.booking_reference || null, ticketNumbers } };
}

// Build Duffel passenger records for order creation from the stored manifest.
// Each offer passenger is matched 1:1 (same order the search built the fare
// units: adults, then children) to a captured traveller, so a group/family
// flight ticket-issues with EVERY real name. Duffel validates born_on against
// each passenger TYPE's age band; a real DOB is used when captured, otherwise a
// plausible one is derived per type/age so the order still passes.
export function duffelOrderPassengers(offerPassengers = [], lead = {}, opts = {}) {
  const manifest = Array.isArray(opts.travellers) && opts.travellers.length ? opts.travellers : [lead];
  const depYear = Number(String(opts.departureDate || '').slice(0, 4)) || new Date().getUTCFullYear();
  const dobFor = (p, t) => {
    if (t?.dob) return t.dob;
    if (p.born_on) return p.born_on;
    const age = Number.isFinite(p.age) ? p.age
      : p.type === 'infant_without_seat' ? 1
      : p.type === 'child' ? 8
      : 30;
    return `${depYear - age}-01-01`;
  };
  const nameParts = (t, fallbackGiven, fallbackFamily) => {
    const parts = String(t?.fullName || '').trim().split(/\s+/).filter(Boolean);
    return { given: parts[0] || fallbackGiven, family: parts.slice(1).join(' ') || (parts[0] ? parts[0] : fallbackFamily) };
  };
  return (offerPassengers.length ? offerPassengers : [{ type: 'adult' }]).map((p, i) => {
    const t = manifest[i] || {};
    const nm = nameParts(t, `Guest${i + 1}`, 'Traveller');
    return {
      id: p.id || undefined,
      type: p.type || 'adult',
      given_name: nm.given,
      family_name: nm.family,
      born_on: dobFor(p, t),
      email: (i === 0 ? (t.email || lead.email) : undefined) || undefined,
      phone_number: (i === 0 ? (t.phone || lead.phone) : undefined) || undefined,
      gender: p.gender || 'm',
      title: p.title || 'mr',
    };
  });
}

export function duffelMode() {
  if (!DUFFEL_TOKEN) return 'off';
  return /test/i.test(DUFFEL_TOKEN) ? 'test' : 'live';
}

// Fetch live flights from Duffel. Returns an array of normalised offers, or
// null when disabled / unreachable / no usable offers.
async function fetchDuffelFlights(intent, originCode, destCode, cabinClass = 'economy') {
  if (!duffelEnabled()) return null;
  const slices = [{ origin: originCode, destination: destCode, departure_date: intent.dates.checkIn }];
  if (intent.dates.checkOut) slices.push({ origin: destCode, destination: originCode, departure_date: intent.dates.checkOut });

  const body = {
    data: {
      slices,
      passengers: duffelPassengers(intent.travellers),
      cabin_class: cabinClass,
    },
  };

  const res = await httpJSON(`${DUFFEL_BASE}/air/offer_requests?return_offers=true`, {
    method: 'POST',
    timeoutMs: FLIGHT_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${DUFFEL_TOKEN}`,
      'Duffel-Version': DUFFEL_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const offers = res?.data?.offers;
  if (!Array.isArray(offers) || !offers.length) return null;

  // Take the cheapest handful (the packager re-ranks anyway).
  const sorted = [...offers].sort((a, b) => Number(a.total_amount) - Number(b.total_amount)).slice(0, 8);
  const out = [];
  for (const offer of sorted) {
    const usd = await toUSD(offer.total_amount, offer.total_currency);
    if (usd == null) continue;
    const norm = normalizeDuffelOffer(offer, usd, intent.travellers);
    if (norm) out.push(norm);
  }
  return out.length ? out : null;
}

// ---- Kiwi Tequila (low-cost carriers) --------------------------------------
// dd/mm/yyyy — the date format Tequila's search API expects.
function tequilaDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}
// Normalise one Tequila itinerary to our flight-offer shape (same contract as
// normalizeDuffelOffer, including per-segment detail + layovers). Exported for
// tests. `enable_vi=0` in the search means every itinerary is a SINGLE booking
// (protected, bags through) — never a self-transfer combo.
export function normalizeTequilaItinerary(item, priceUSD, travellers) {
  const segs = Array.isArray(item?.route) ? item.route : [];
  if (!segs.length) return null;
  const toLeg = (list) => {
    if (!list.length) return null;
    const first = list[0]; const last = list[list.length - 1];
    const dep = (s) => String(s.local_departure || '').slice(0, 19);
    const arr = (s) => String(s.local_arrival || '').slice(0, 19);
    const hh = (iso) => (String(iso).match(/T(\d{2}:\d{2})/) || [])[1] || '';
    const dd = (iso) => String(iso).slice(0, 10);
    // Duration math MUST use Tequila's UTC epoch seconds (dTime/aTime). The
    // local_departure/local_arrival strings are wall-clock at each airport and
    // span different timezones, so subtracting them yields wrong elapsed times
    // (a westbound leg could even read negative). local_* is display-only.
    const utcMs = (s, which) => {
      const v = which === 'dep' ? s.dTime : s.aTime;
      if (typeof v === 'number' && isFinite(v)) return v * 1000;
      const iso = which === 'dep' ? s.local_departure : s.local_arrival;
      const t = Date.parse(String(iso || '').replace(/(\.\d+)?Z?$/, 'Z'));
      return isFinite(t) ? t : null;
    };
    const segments = list.map((s) => ({
      carrier: carrierName(s.airline),
      flightNumber: `${s.airline || ''}${s.flight_no || ''}`,
      operatedBy: s.operating_carrier && s.operating_carrier !== s.airline ? carrierName(s.operating_carrier) : null,
      from: s.flyFrom || '', fromCity: s.cityFrom || '',
      to: s.flyTo || '', toCity: s.cityTo || '',
      date: dd(dep(s)), depart: hh(dep(s)), arrive: hh(arr(s)),
      durationLabel: '',
      aircraft: null,
    }));
    const layovers = [];
    for (let i = 1; i < list.length; i++) {
      const a = utcMs(list[i - 1], 'arr'); const b = utcMs(list[i], 'dep');
      const mins = (a != null && b != null) ? Math.round((b - a) / 60000) : null;
      layovers.push({
        airport: list[i].flyFrom || '',
        city: list[i].cityFrom || '',
        minutes: mins != null && mins > 0 ? mins : null,
        durationLabel: mins != null && mins > 0 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : '',
        overnight: dd(dep(list[i])) !== dd(arr(list[i - 1])),
        tight: mins != null && mins > 0 && mins < 60,
      });
    }
    const stops = list.length - 1;
    const totalMs = (() => { const d = utcMs(first, 'dep'); const a = utcMs(last, 'arr'); return (d != null && a != null) ? a - d : null; })();
    const totalMins = totalMs != null ? Math.round(totalMs / 60000) : 0;
    const viaLabel = layovers.length
      ? ` · via ${layovers.map((l) => `${l.city || l.airport} (${l.airport})${l.durationLabel ? ' ' + l.durationLabel + ' wait' : ''}`).join(', ')}`
      : '';
    return {
      from: first.flyFrom || '', fromCity: first.cityFrom || '',
      to: last.flyTo || '', toCity: last.cityTo || '',
      date: dd(dep(first)),
      depart: hh(dep(first)), arrive: hh(arr(last)),
      arriveNextDay: dd(arr(last)) !== dd(dep(first)),
      durationLabel: totalMins > 0 ? `${Math.floor(totalMins / 60)}h ${totalMins % 60}m` : '',
      stops, stopLabel: stops === 0 ? 'Direct' : `${stops} stop${stops > 1 ? 's' : ''}${viaLabel}`,
      segments, layovers,
    };
  };
  const outbound = toLeg(segs.filter((s) => !s.return));
  const inbound = toLeg(segs.filter((s) => s.return));
  if (!outbound) return null;
  const mainCarrier = carrierName(segs[0].airline);
  const bagNote = item.baglimit?.hold_weight ? `checked up to ${item.baglimit.hold_weight}kg bookable` : 'checked bags bookable';
  return {
    type: 'flight',
    supplier: mainCarrier,
    verified: true,
    reliabilityScore: 86, // real bookable LCC fare via the Kiwi Tequila pipe
    premium: false,
    live: true,
    sourcedVia: 'Kiwi Tequila (live)',
    sourcedType: 'LCC aggregator',
    details: {
      outbound, inbound,
      passengers: travellers.total,
      cabin: 'Economy',
      baggage: `Cabin bag included · ${bagNote}`,
      // Tequila booking context: re-validated via check_flights before any
      // real charge; ticketing runs through the ops queue (see autoTicketFlight).
      bookingToken: item.booking_token || null,
      deepLink: item.deep_link || null,
      liveAmount: item.price != null ? String(item.price) : null,
      liveCurrency: 'GBP',
      seatsLeft: item.availability?.seats ?? null,
    },
    priceUSD,
  };
}

async function fetchTequilaFlights(intent, originCode, destCode) {
  if (!lccFlightsEnabled()) return null;
  const q = new URLSearchParams({
    fly_from: originCode,
    fly_to: destCode,
    date_from: tequilaDate(intent.dates.checkIn),
    date_to: tequilaDate(intent.dates.checkIn),
    adults: String(intent.travellers.adults || 1),
    children: String(intent.travellers.children || 0),
    curr: 'GBP',
    limit: '8',
    sort: 'price',
    enable_vi: '0', // single-booking itineraries ONLY — no self-transfer combos
  });
  if (intent.dates.checkOut) {
    q.set('return_from', tequilaDate(intent.dates.checkOut));
    q.set('return_to', tequilaDate(intent.dates.checkOut));
  }
  const res = await httpJSON(`${TEQUILA_BASE}/v2/search?${q}`, {
    timeoutMs: FLIGHT_TIMEOUT_MS,
    headers: { apikey: TEQUILA_KEY, Accept: 'application/json' },
  });
  const items = res?.data;
  if (!Array.isArray(items) || !items.length) return null;
  const out = [];
  for (const item of items.slice(0, 8)) {
    const usd = await toUSD(item.price, 'GBP');
    if (usd == null) continue;
    const norm = normalizeTequilaItinerary(item, usd, intent.travellers);
    if (norm) out.push(norm);
  }
  return out.length ? out : null;
}

// Re-validate a Tequila itinerary right before charging real money — same
// safety contract as validateDuffelOffer: never charge for a fare that has
// repriced or sold out.
export async function validateTequilaOffer(bookingToken, { adults = 1, children = 0 } = {}) {
  if (!lccFlightsEnabled() || !bookingToken) return { ok: false, reason: 'not-configured' };
  const q = new URLSearchParams({
    booking_token: bookingToken, bnum: '0',
    adults: String(adults), children: String(children), infants: '0',
    currency: 'GBP',
  });
  const res = await httpJSON(`${TEQUILA_BASE}/v2/booking/check_flights?${q}`, {
    timeoutMs: FLIGHT_TIMEOUT_MS,
    headers: { apikey: TEQUILA_KEY, Accept: 'application/json' },
  });
  if (!res || res.__error) return { ok: false, reason: 'unreachable' };
  return {
    ok: true,
    live: res.flights_checked === true && res.flights_invalid !== true,
    expired: res.flights_invalid === true,
    priceChanged: res.price_change === true,
    amount: res.conversion?.amount ?? res.total ?? null,
    currency: 'GBP',
  };
}

// ---- Travelpayouts / Aviasales market fares ---------------------------------
// Real prices from recent user searches (incl. Ryanair/Jet2/Wizz), cached up
// to 7 days. NOT bookable offers — used to calibrate estimates and to feed
// the Market Benchmark automatically. Exported normaliser for tests.
export function normalizeMarketFare(item) {
  if (!item || item.price == null) return null;
  const transfers = Number(item.transfers) || 0;
  return {
    carrier: carrierName(item.airline),
    airlineCode: item.airline || '',
    flightNumber: item.airline && item.flight_number ? `${item.airline}${item.flight_number}` : null,
    priceGbp: Math.round(Number(item.price) * 100) / 100,
    transfers,
    stopLabel: transfers === 0 ? 'Direct' : `${transfers} stop${transfers > 1 ? 's' : ''}`,
    departureAt: String(item.departure_at || '').slice(0, 16),
    returnAt: item.return_at ? String(item.return_at).slice(0, 16) : null,
    link: item.link ? `https://www.aviasales.com${item.link}` : null,
    source: 'Aviasales market data (7-day cache)',
  };
}

export async function fetchMarketFares(intent, dest, origin) {
  if (!marketDataEnabled()) return null;
  const originCode = origin?.airport;
  const destCode = dest?.code || dest?.airport;
  if (!originCode || !destCode || !intent?.dates?.checkIn) return null;
  const q = new URLSearchParams({
    origin: originCode,
    destination: destCode,
    departure_at: intent.dates.checkIn,
    currency: 'gbp',
    sorting: 'price',
    limit: '8',
    one_way: intent.dates.checkOut ? 'false' : 'true',
    token: TRAVELPAYOUTS_TOKEN,
  });
  if (intent.dates.checkOut) q.set('return_at', intent.dates.checkOut);
  const res = await httpJSON(`${TRAVELPAYOUTS_BASE}/aviasales/v3/prices_for_dates?${q}`, {
    headers: { Accept: 'application/json' },
  });
  const items = res?.data;
  if (!Array.isArray(items) || !items.length) return null;
  const fares = items.map(normalizeMarketFare).filter(Boolean);
  return fares.length ? fares : null;
}

export async function fetchLiveFlights(intent, dest, origin) {
  if (!liveFlightsEnabled()) return null;
  const originCode = origin?.airport;
  const destCode = dest?.code;
  if (!originCode || !destCode || !intent?.dates?.checkIn) return null;
  // Query ALL doors concurrently: Duffel economy (the price fight), Duffel
  // BUSINESS (so the Luxury tier is genuinely premium, not the same economy
  // fare relabelled), and Tequila (LCCs — Ryanair/Jet2/Wizz for regional
  // airports). Merged and sorted by price; the packager re-ranks per tier.
  const [duffel, duffelBiz, tequila] = await Promise.all([
    fetchDuffelFlights(intent, originCode, destCode, 'economy').catch(() => null),
    fetchDuffelFlights(intent, originCode, destCode, 'business').catch(() => null),
    fetchTequilaFlights(intent, originCode, destCode).catch(() => null),
  ]);
  const merged = [...(duffel || []), ...(duffelBiz || []), ...(tequila || [])]
    .sort((a, b) => a.priceUSD - b.priceUSD).slice(0, 14);
  return merged.length ? merged : null;
}

// Diagnose exactly WHY a live flight search did or didn't return bookable fares.
// This runs a real probe search against Duffel (LHR→JFK, ~30 days out) and
// reports the precise outcome so an admin can see whether "estimated" is caused
// by: no token, a test token, the network being unable to reach Duffel, an auth
// rejection, or simply no offers on the probe route. Never throws.
export async function duffelDiagnostic() {
  const mode = duffelMode();
  if (!DUFFEL_TOKEN) return { ok: false, mode, reason: 'not-configured', message: 'No DUFFEL_TOKEN set — flights fall back to estimated prices.' };
  if (typeof fetch !== 'function') return { ok: false, mode, reason: 'no-fetch', message: 'This runtime has no fetch() — cannot reach any live provider.' };
  const probeDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const body = { data: { slices: [{ origin: 'LHR', destination: 'JFK', departure_date: probeDate }], passengers: [{ type: 'adult' }], cabin_class: 'economy' } };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const r = await fetch(`${DUFFEL_BASE}/air/offer_requests?return_offers=true`, {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${DUFFEL_TOKEN}`, 'Duffel-Version': DUFFEL_VERSION, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - startedAt;
    let payload = null;
    try { payload = await r.json(); } catch {}
    if (r.status === 401 || r.status === 403) {
      return { ok: false, mode, reason: 'auth-rejected', status: r.status, latencyMs, message: `Duffel rejected the token (HTTP ${r.status}). The key may be revoked, wrong, or lacking flight permissions.` };
    }
    if (!r.ok) {
      const detail = payload?.errors?.[0]?.message || payload?.errors?.[0]?.title || `HTTP ${r.status}`;
      return { ok: false, mode, reason: 'provider-error', status: r.status, latencyMs, message: `Duffel returned an error: ${detail}` };
    }
    const offers = payload?.data?.offers;
    const count = Array.isArray(offers) ? offers.length : 0;
    if (!count) return { ok: false, mode, reason: 'no-offers', status: r.status, latencyMs, message: 'Duffel is reachable and the token works, but the probe route returned 0 offers. Live fares will appear for routes/dates that do have inventory.' };
    return { ok: true, mode, reason: 'ok', status: r.status, latencyMs, probeOffers: count, probeCheapest: offers[0]?.total_amount ? `${offers[0].total_amount} ${offers[0].total_currency}` : null, message: `Duffel is LIVE and reachable — ${count} real offers on the probe route in ${latencyMs}ms. Flights are bookable.` };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, mode, reason: aborted ? 'timeout' : 'unreachable', message: aborted ? `Duffel did not respond within ${TIMEOUT_MS}ms — the deployment may be unable to reach api.duffel.com (network policy/egress).` : `Could not reach api.duffel.com from this deployment (${e?.message || 'network error'}). Check outbound network access.` };
  } finally {
    clearTimeout(t);
  }
}

// ===========================================================================
// HOTELS — Amadeus (OAuth2 client-credentials → hotels-by-city → offers)
// ===========================================================================

let amadeusToken = { value: '', exp: 0 };
async function amadeusAuth() {
  if (amadeusToken.value && amadeusToken.exp > Date.now()) return amadeusToken.value;
  const res = await httpJSON(`${AMADEUS_BASE}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(AMADEUS_ID)}&client_secret=${encodeURIComponent(AMADEUS_SECRET)}`,
  });
  if (!res?.access_token) return null;
  amadeusToken = { value: res.access_token, exp: Date.now() + (Number(res.expires_in || 1700) * 1000) };
  return amadeusToken.value;
}

// Normalise one Amadeus hotel-offer entry to our hotel-offer shape.
export function normalizeAmadeusHotel(entry, priceUSD, nights, rooms) {
  const h = entry.hotel || {};
  const offer = (entry.offers && entry.offers[0]) || {};
  const stars = Number(h.rating) || 0;
  const nightlyUSD = nights ? Math.round((priceUSD / nights) * 100) / 100 : priceUSD;
  return {
    type: 'hotel',
    supplier: h.name || 'Hotel',
    verified: true,
    reliabilityScore: stars >= 4 ? 90 : 82,
    stars,
    live: true,
    sourcedVia: 'Amadeus (live)',
    sourcedType: 'GDS',
    details: {
      nights, rooms: rooms || 1,
      nightlyUSD,
      board: offer.boardType || 'Room only',
      freeCancellation: !!(offer.policies && offer.policies.cancellations && offer.policies.cancellations.length),
      roomType: offer.room?.typeEstimated?.category || offer.room?.description?.text || 'Standard Room',
      area: h.address?.lines?.[0] || h.cityCode || '',
      guestRating: h.rating ? Math.round((Number(h.rating) / 5) * 100) / 10 : undefined,
      latitude: h.latitude, longitude: h.longitude,
      hotelId: h.hotelId,
    },
    priceUSD,
  };
}

// ===========================================================================
// HOTELS — Duffel Stays (SAME token as flights; no extra credentials needed)
// ===========================================================================
// Normalise one Duffel Stays search result to our hotel-offer shape.
export function normalizeDuffelStay(result, priceUSD, nights, rooms) {
  const acc = result.accommodation || {};
  const stars = Number(acc.rating) || 0;
  const nightlyUSD = nights ? Math.round((priceUSD / nights) * 100) / 100 : priceUSD;
  const reviewScore = acc.review_score != null ? Number(acc.review_score) : null; // 0–10
  return {
    type: 'hotel',
    supplier: acc.name || 'Hotel',
    verified: true,
    reliabilityScore: reviewScore != null ? Math.round(reviewScore * 10) : (stars >= 4 ? 90 : 82),
    stars,
    live: true,
    sourcedVia: 'Duffel Stays (live)',
    sourcedType: 'aggregator',
    details: {
      nights, rooms: rooms || 1,
      nightlyUSD,
      board: 'Room only',
      freeCancellation: false, // confirmed at rate level before payment
      roomType: result.rooms?.[0]?.rates?.[0]?.name || 'Standard Room',
      area: acc.location?.address?.line_one || acc.location?.address?.city_name || '',
      guestRating: reviewScore != null ? reviewScore : (stars ? Math.round(stars / 5 * 100) / 10 : undefined),
      photos: (acc.photos || []).map((p) => p.url).filter(Boolean).slice(0, 6),
      latitude: acc.location?.geographic_coordinates?.latitude,
      longitude: acc.location?.geographic_coordinates?.longitude,
      staysSearchResultId: result.id,
    },
    priceUSD,
  };
}

// Fetch live hotels from Duffel Stays. Geocodes the destination city, searches a
// radius around it, and normalises the cheapest rate per property. Returns
// normalised offers or null.
export async function fetchDuffelStays(intent, dest) {
  if (!duffelStaysEnabled()) return null;
  if (!intent?.dates?.checkIn || !intent?.dates?.checkOut || !dest?.city) return null;
  const geo = await geocode(dest.city).catch(() => null);
  if (!geo || geo.lat == null || geo.lon == null) return null;
  const rooms = Math.max(1, Math.ceil((intent.travellers?.total || 1) / 2));
  const guests = [];
  for (let i = 0; i < Math.max(1, intent.travellers?.adults || 1); i++) guests.push({ type: 'adult' });
  for (const age of (intent.travellers?.childAges || [])) guests.push({ type: 'child', age });
  const body = { data: {
    rooms,
    location: { radius: 10, geographic_coordinates: { longitude: geo.lon, latitude: geo.lat } },
    check_in_date: intent.dates.checkIn,
    check_out_date: intent.dates.checkOut,
    guests: guests.length ? guests : [{ type: 'adult' }],
  } };
  const res = await httpJSON(`${DUFFEL_BASE}/stays/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DUFFEL_TOKEN}`, 'Duffel-Version': DUFFEL_VERSION, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const results = res?.data?.results;
  if (!Array.isArray(results) || !results.length) return null;
  const out = [];
  for (const r of results.slice(0, 20)) {
    const amount = r.cheapest_rate_total_amount;
    if (!amount) continue;
    const usd = await toUSD(amount, r.cheapest_rate_currency);
    if (usd == null) continue;
    out.push(normalizeDuffelStay(r, usd, intent.nights, rooms));
  }
  return out.length ? out : null;
}

// Duffel Stays booking flow — rates → quote → book — the hotel equivalent of the
// flight order path. Called on payment so a paid hotel ticket-issues itself.
function staysHeaders() {
  return { Authorization: `Bearer ${DUFFEL_TOKEN}`, 'Duffel-Version': DUFFEL_VERSION, 'Content-Type': 'application/json', Accept: 'application/json' };
}
export async function bookDuffelStay({ searchResultId, guests = [], email, phone, maxAmountUSD = null } = {}) {
  if (!duffelStaysEnabled() || !searchResultId) return { ok: false, error: 'not-configured' };
  // 1) FRESH rates for the stored search result (rates/search results expire —
  //    this re-prices right before we book, like the flight fresh-fare check).
  const rres = await httpJSON(`${DUFFEL_BASE}/stays/search_results/${encodeURIComponent(searchResultId)}/actions/fetch_all_rates`, { method: 'POST', headers: staysHeaders() });
  if (rres == null || (rres.__status && rres.__status >= 500)) return { ok: false, error: 'rates-unreachable' };
  if (rres.__status === 404 || rres.__status === 410 || rres.__status === 422) return { ok: false, error: 'rates-expired' };
  const rooms = rres?.data?.accommodation?.rooms || rres?.data?.rooms || [];
  const rates = rooms.flatMap((r) => r.rates || []);
  if (!rates.length) return { ok: false, error: 'no-rates' };
  // Cheapest bookable rate.
  const rate = rates.reduce((a, b) => (Number(a.total_amount) <= Number(b.total_amount) ? a : b));
  // 2) Quote — Duffel confirms the exact bookable amount.
  const qres = await httpJSON(`${DUFFEL_BASE}/stays/quotes`, { method: 'POST', headers: staysHeaders(), body: JSON.stringify({ data: { rate_id: rate.id } }) });
  const quote = qres?.data;
  if (!quote?.id) return { ok: false, error: 'quote-failed', detail: qres?.__error };
  const usd = await toUSD(quote.total_amount, quote.total_currency);
  // Never book materially above what the customer paid — flag for ops instead.
  if (maxAmountUSD != null && usd != null && usd > maxAmountUSD * 1.02) {
    return { ok: false, error: 'price-changed', nowUSD: usd, wasUSD: maxAmountUSD };
  }
  // 3) Book — Duffel is the merchant of record (paid from the Duffel balance).
  const guestList = guests.length ? guests : [{ given_name: 'Guest', family_name: 'Traveller' }];
  const bres = await httpJSON(`${DUFFEL_BASE}/stays/bookings`, {
    method: 'POST', headers: staysHeaders(),
    body: JSON.stringify({ data: { quote_id: quote.id, guests: guestList, email: email || undefined, phone_number: phone || undefined } }),
  });
  const bk = bres?.data;
  if (!bk?.id) return { ok: false, error: 'booking-failed', detail: bres?.__error };
  return { ok: true, reference: bk.reference || bk.id, bookingId: bk.id, status: bk.status || 'confirmed', checkIn: bk.check_in_date, checkOut: bk.check_out_date, amountUSD: usd };
}

// Fetch live hotels. Duffel Stays first (same token as flights, no extra creds),
// then Amadeus as a fallback. Returns normalised offers or null.
export async function fetchLiveHotels(intent, dest) {
  if (!liveHotelsEnabled()) return null;
  if (duffelStaysEnabled()) {
    const stays = await fetchDuffelStays(intent, dest).catch(() => null);
    if (stays && stays.length) return stays;
  }
  if (!(AMADEUS_ID && AMADEUS_SECRET)) return null;
  const cityCode = dest?.code;
  if (!cityCode || !intent?.dates?.checkIn || !intent?.dates?.checkOut) return null;
  const token = await amadeusAuth();
  if (!token) return null;
  const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  // 1) hotels in the city
  const list = await httpJSON(`${AMADEUS_BASE}/v1/reference-data/locations/hotels/by-city?cityCode=${encodeURIComponent(cityCode)}`, { headers: auth });
  const ids = (list?.data || []).map((d) => d.hotelId).filter(Boolean).slice(0, 20);
  if (!ids.length) return null;

  // 2) live offers for those hotels
  const rooms = Math.max(1, Math.ceil(intent.travellers.total / 2));
  const params = new URLSearchParams({
    hotelIds: ids.join(','),
    adults: String(Math.max(1, intent.travellers.adults || 1)),
    checkInDate: intent.dates.checkIn,
    checkOutDate: intent.dates.checkOut,
    roomQuantity: String(rooms),
    bestRateOnly: 'true',
  });
  const offersRes = await httpJSON(`${AMADEUS_BASE}/v3/shopping/hotel-offers?${params.toString()}`, { headers: auth });
  const data = offersRes?.data;
  if (!Array.isArray(data) || !data.length) return null;

  const out = [];
  for (const entry of data) {
    const offer = entry.offers && entry.offers[0];
    if (!offer?.price?.total) continue;
    const usd = await toUSD(offer.price.total, offer.price.currency);
    if (usd == null) continue;
    out.push(normalizeAmadeusHotel(entry, usd, intent.nights, rooms));
  }
  return out.length ? out : null;
}

// ===========================================================================
// FLIGHT SCHEDULES — OAG (Schedules API preferred for future dates, Flight Info
// instances as fallback). Both return real carriers / times / non-stops.
// ===========================================================================

// OAG times/dates come as { local: "19:00" } / { local: "2025-05-01" } objects
// or as plain strings depending on product/plan; read both defensively.
function oagTime(t) {
  if (!t) return '';
  if (typeof t === 'string') { const m = t.match(/(\d{2}:\d{2})/); return m ? m[1] : ''; }
  return oagTime(t.local || t.utc || '');
}
function oagDate(d) {
  if (!d) return '';
  if (typeof d === 'string') { const m = d.match(/(\d{4}-\d{2}-\d{2})/); return m ? m[1] : ''; }
  return oagDate(d.local || d.utc || '');
}
function minsToLabel(mins) {
  const n = Number(mins) || 0;
  return `${Math.floor(n / 60)}h ${n % 60}m`;
}
// Number of stops for a schedule/instance entry. Flight Info instances are
// single sectors (non-stop); Schedules entries may carry a stop count.
function oagStops(entry) {
  const s = entry.stops ?? entry.stopCount ?? entry.numberOfStops;
  if (typeof s === 'number') return s;
  if (typeof entry.flightType === 'string' && /nonstop|non-stop|direct/i.test(entry.flightType)) return 0;
  return 0;
}

// Build one of our flight legs from a single OAG entry (instance OR schedule).
// `fallbackDate` is used when a schedule entry carries no explicit date.
export function oagInstanceToLeg(entry, fallbackDate = '') {
  const dep = entry.departure || {};
  const arr = entry.arrival || {};
  const from = dep.airport?.iata || dep.airport?.iataCode || dep.airport || '';
  const to = arr.airport?.iata || arr.airport?.iataCode || arr.airport || '';
  const date = oagDate(dep.date) || fallbackDate;
  const depart = oagTime(dep.time);
  const arrive = oagTime(arr.time);
  // Next-day arrival: explicit arrival date differs, an explicit day offset, or
  // (for schedules without dates) the arrival clock is earlier than departure.
  const arrDate = oagDate(arr.date);
  const offset = Number(arr.daysOffset ?? arr.dateOffset ?? arr.dayChange ?? 0) || 0;
  const arriveNextDay = (arrDate && date && arrDate !== date)
    || offset > 0
    || (!arrDate && depart && arrive && arrive < depart);
  const stops = oagStops(entry);
  return {
    from, fromCity: dep.airport?.city || '', to, toCity: arr.airport?.city || '',
    date, depart, arrive, arriveNextDay,
    durationLabel: minsToLabel(entry.elapsedTime || entry.flightDuration || entry.scheduledDuration),
    stops, stopLabel: stops === 0 ? 'Direct' : `${stops} stop${stops > 1 ? 's' : ''}`,
    flightNumber: entry.carrier?.iata && entry.flightNumber ? `${entry.carrier.iata}${entry.flightNumber}` : undefined,
    aircraft: entry.aircraftType?.iata || entry.aircraftType?.icao || undefined,
  };
}

// Fetch real services for one direction from whichever OAG product is keyed.
// Returns the raw entry array (schedules or instances share enough shape that
// oagInstanceToLeg handles both).
async function oagServices(fromAirport, toAirport, date) {
  if (!fromAirport || !toAirport || !date) return null;
  if (OAG_SCHEDULES_KEY) {
    const params = new URLSearchParams({
      version: 'v2',
      DepartureAirport: fromAirport,
      ArrivalAirport: toAirport,
      StartDate: date,
      EndDate: date,
      CodeType: 'IATA',
    });
    const res = await httpJSON(`${OAG_BASE}/schedules/?${params.toString()}`, {
      headers: { 'Subscription-Key': OAG_SCHEDULES_KEY, Accept: 'application/json' },
    });
    const data = res?.data || res?.schedules || null;
    if (Array.isArray(data)) return data;
  }
  if (OAG_FLIGHTINFO_KEY) {
    const params = new URLSearchParams({
      version: 'v2',
      DepartureDateTime: date,
      ArrivalDateTime: date,
      DepartureAirport: fromAirport,
      ArrivalAirport: toAirport,
      CodeType: 'IATA',
    });
    const res = await httpJSON(`${OAG_BASE}/flight-instances/?${params.toString()}`, {
      headers: { 'Subscription-Key': OAG_FLIGHTINFO_KEY, Accept: 'application/json' },
    });
    const data = res?.data || res?.flightInstances || null;
    if (Array.isArray(data)) return data;
  }
  return null;
}

// Real-schedule flights from OAG: which carriers actually fly the route non-stop
// and when. Priced with the deterministic estimator (OAG has no fares), so each
// offer is flagged scheduleLive (real schedule) but price-estimated.
export async function fetchOagFlights(intent, dest, origin) {
  if (!oagScheduleEnabled()) return null;
  const o = origin?.airport; const d = dest?.code;
  if (!o || !d || !intent?.dates?.checkIn) return null;

  const [outbound, inboundRaw] = await Promise.all([
    oagServices(o, d, intent.dates.checkIn),
    intent.dates.checkOut ? oagServices(d, o, intent.dates.checkOut) : Promise.resolve(null),
  ]);
  if (!outbound || !outbound.length) return null;

  // Index return services by carrier so we can pair a round trip on one airline.
  const inboundByCarrier = new Map();
  for (const inst of inboundRaw || []) {
    const c = inst.carrier?.iata;
    if (c && !inboundByCarrier.has(c)) inboundByCarrier.set(c, inst);
  }

  const routeBase = routeFareBaseUSD(o, d); // distance-derived base (origin-aware)
  const seen = new Set();
  const offers = [];
  for (const inst of outbound) {
    const iata = inst.carrier?.iata;
    if (!iata || seen.has(iata)) continue; // one offer per carrier
    seen.add(iata);
    const premium = PREMIUM_CARRIERS.has(iata);
    const fares = estimateFlightFares(dest, premium, false, intent.travellers, `oag-${iata}-${o}-${d}-${intent.dates.checkIn}`, routeBase);
    const outLeg = oagInstanceToLeg(inst, intent.dates.checkIn);
    const retInst = inboundByCarrier.get(iata);
    const inLeg = retInst ? oagInstanceToLeg(retInst, intent.dates.checkOut) : null;
    offers.push({
      type: 'flight',
      supplier: carrierName(iata),
      verified: true,
      reliabilityScore: premium ? 94 : 88,
      premium,
      scheduleLive: true, // real operated schedule (OAG); price is estimated
      sourcedVia: 'OAG (live schedule)',
      sourcedType: 'Schedule',
      details: {
        outbound: { ...outLeg, perSeatUSD: fares.outboundPerSeat },
        inbound: inLeg ? { ...inLeg, perSeatUSD: fares.inboundPerSeat } : null,
        passengers: intent.travellers.total,
        cabin: 'Economy',
        baggage: premium ? '2 × 30kg checked + cabin' : '1 × 23kg checked + cabin',
        fareBreakdown: fares.fareCounts,
        fareUnits: fares.fareUnits,
        adultFareUSD: fares.totalPerSeat,
        childFareUSD: fares.childFareUSD,
        infantFareUSD: fares.infantFareUSD,
        flightNumber: outLeg.flightNumber,
        aircraft: outLeg.aircraft,
      },
      priceUSD: fares.priceUSD,
    });
    if (offers.length >= 8) break;
  }
  return offers.length ? offers : null;
}

// Convenience: fetch whatever is configured, in parallel, for the plan flow.
// Flight price source preference: Duffel (real fares) > OAG (real schedule,
// estimated fare) > synthetic. Hotels: Amadeus when configured.
export async function fetchLiveOffers(intent, dest, origin) {
  const [duffel, oag, hotels] = await Promise.all([
    liveFlightsEnabled() ? fetchLiveFlights(intent, dest, origin).catch(() => null) : Promise.resolve(null),
    oagScheduleEnabled() ? fetchOagFlights(intent, dest, origin).catch(() => null) : Promise.resolve(null),
    liveHotelsEnabled() ? fetchLiveHotels(intent, dest).catch(() => null) : Promise.resolve(null),
  ]);
  const flights = (duffel && duffel.length) ? duffel : (oag && oag.length ? oag : null);
  return { flights, hotels };
}
