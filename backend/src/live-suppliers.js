// Live supplier pricing (flights + hotels) for 3JN Travel OS.
//
// Real provider integrations — Duffel for flights, Amadeus for hotels — that
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

import { fxRate } from './live-data.js';

const env = process.env;
const TIMEOUT_MS = Number(env.LIVE_SUPPLIERS_TIMEOUT_MS) || 6000;

const DUFFEL_TOKEN = env.DUFFEL_TOKEN || env.DUFFEL_API_KEY || '';
const DUFFEL_BASE = env.DUFFEL_BASE_URL || 'https://api.duffel.com';
const DUFFEL_VERSION = env.DUFFEL_VERSION || 'v2';

const AMADEUS_ID = env.AMADEUS_CLIENT_ID || '';
const AMADEUS_SECRET = env.AMADEUS_CLIENT_SECRET || '';
const AMADEUS_BASE = env.AMADEUS_BASE_URL || 'https://api.amadeus.com';

export function liveFlightsEnabled() { return !!DUFFEL_TOKEN && typeof fetch === 'function'; }
export function liveHotelsEnabled() { return !!(AMADEUS_ID && AMADEUS_SECRET) && typeof fetch === 'function'; }
export function liveSuppliersConfigured() { return liveFlightsEnabled() || liveHotelsEnabled(); }

// ---- low-level fetch with timeout -----------------------------------------
async function httpJSON(url, opts = {}) {
  if (typeof fetch !== 'function') return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
  return {
    from: first.origin?.iata_code || '', fromCity: first.origin?.city_name || first.origin?.name || '',
    to: last.destination?.iata_code || '', toCity: last.destination?.city_name || last.destination?.name || '',
    date: dateOf(first.departing_at),
    depart: hhmm(first.departing_at), arrive: hhmm(last.arriving_at),
    arriveNextDay: dateOf(last.arriving_at) !== dateOf(first.departing_at),
    durationLabel: durationLabel(slice.duration),
    stops, stopLabel: stops === 0 ? 'Direct' : `${stops} stop${stops > 1 ? 's' : ''}`,
  };
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
      baggage: 'As per fare rules',
      offerId: offer.id,
    },
    priceUSD,
  };
}

// Fetch live flights from Duffel. Returns an array of normalised offers, or
// null when disabled / unreachable / no usable offers.
export async function fetchLiveFlights(intent, dest, origin) {
  if (!liveFlightsEnabled()) return null;
  const originCode = origin?.airport;
  const destCode = dest?.code;
  if (!originCode || !destCode || !intent?.dates?.checkIn) return null;

  const slices = [{ origin: originCode, destination: destCode, departure_date: intent.dates.checkIn }];
  if (intent.dates.checkOut) slices.push({ origin: destCode, destination: originCode, departure_date: intent.dates.checkOut });

  const body = {
    data: {
      slices,
      passengers: duffelPassengers(intent.travellers),
      cabin_class: 'economy',
    },
  };

  const res = await httpJSON(`${DUFFEL_BASE}/air/offer_requests?return_offers=true`, {
    method: 'POST',
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

// Fetch live hotels from Amadeus. Returns normalised offers or null.
export async function fetchLiveHotels(intent, dest) {
  if (!liveHotelsEnabled()) return null;
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

// Convenience: fetch whatever is configured, in parallel, for the plan flow.
export async function fetchLiveOffers(intent, dest, origin) {
  const [flights, hotels] = await Promise.all([
    liveFlightsEnabled() ? fetchLiveFlights(intent, dest, origin).catch(() => null) : Promise.resolve(null),
    liveHotelsEnabled() ? fetchLiveHotels(intent, dest).catch(() => null) : Promise.resolve(null),
  ]);
  return { flights, hotels };
}
