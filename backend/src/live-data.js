// Live external data integration for 3JN Travel OS.
//
// Real-time weather, FX and travel-advisory data from free public APIs, with:
//   - short timeouts so the UI never hangs,
//   - in-memory TTL caching so we don't hammer providers,
//   - graceful fallback: if a provider is unreachable (e.g. outbound network is
//     disabled), the call returns null and the caller uses its deterministic
//     estimate, clearly labelled `source: 'estimated'` vs `source: 'live'`.
//
// Endpoints are overridable via env so a deployment can swap providers or point
// at keyed/paid tiers without code changes.

const env = process.env;
const ENABLED = env.LIVE_DATA_ENABLED !== 'false'; // on by default; set false to force offline
const TIMEOUT_MS = Number(env.LIVE_DATA_TIMEOUT_MS) || 3500;

const GEOCODE_URL = env.GEOCODE_URL || 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_URL = env.WEATHER_URL || 'https://api.open-meteo.com/v1/forecast';
const FX_URL = env.FX_URL || 'https://open.er-api.com/v6/latest'; // /{BASE}
const ADVISORY_URL = env.ADVISORY_URL || 'https://www.travel-advisory.info/api';

// ---- tiny TTL cache --------------------------------------------------------
const cache = new Map();
function cacheGet(key) {
  const e = cache.get(key);
  if (e && e.exp > Date.now()) return e.val;
  if (e) cache.delete(key);
  return undefined;
}
function cacheSet(key, val, ttlMs) { cache.set(key, { val, exp: Date.now() + ttlMs }); }

async function getJSON(url) {
  if (!ENABLED || typeof fetch !== 'function') return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) return null; // a proxy error page, etc.
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---- Geocoding (city → coords + country) -----------------------------------
export async function geocode(city) {
  const name = (city || '').trim();
  if (!name) return null;
  const key = `geo:${name.toLowerCase()}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const data = await getJSON(`${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`);
  const g = data?.results?.[0];
  const out = g ? {
    name: g.name, country: g.country, countryCode: g.country_code,
    lat: g.latitude, lon: g.longitude, timezone: g.timezone, population: g.population,
  } : null;
  cacheSet(key, out, 7 * 24 * 3600 * 1000); // 7 days
  return out;
}

const WEATHER_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Rain showers', 81: 'Rain showers', 82: 'Violent rain showers', 95: 'Thunderstorm', 96: 'Thunderstorm + hail', 99: 'Thunderstorm + hail',
};

// ---- Current weather by coordinates ----------------------------------------
export async function weather(lat, lon) {
  if (lat == null || lon == null) return null;
  const key = `wx:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const data = await getJSON(`${WEATHER_URL}?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`);
  const c = data?.current;
  const out = c ? { tempC: Math.round(c.temperature_2m), condition: WEATHER_CODES[c.weather_code] || 'Clear' } : null;
  cacheSet(key, out, 30 * 60 * 1000); // 30 min
  return out;
}

// ---- FX rate (base → quote) ------------------------------------------------
export async function fxRate(base, quote) {
  if (!base || !quote) return null;
  if (base === quote) return 1;
  const key = `fx:${base}`;
  let rates = cacheGet(key);
  if (rates === undefined) {
    const data = await getJSON(`${FX_URL}/${encodeURIComponent(base)}`);
    rates = data?.rates || null;
    cacheSet(key, rates, 60 * 60 * 1000); // 1 hour
  }
  const r = rates?.[quote];
  return typeof r === 'number' ? r : null;
}

// ---- Travel advisory (country risk) ----------------------------------------
// Returns { score 0-5, level, message, updated } where higher = riskier.
export async function advisory(countryCode) {
  const cc = (countryCode || '').toUpperCase();
  if (!cc || cc.length !== 2) return null;
  const key = `adv:${cc}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const data = await getJSON(`${ADVISORY_URL}?countrycode=${cc}`);
  const a = data?.data?.[cc]?.advisory;
  let out = null;
  if (a && typeof a.score === 'number') {
    const score = a.score; // 0 (safe) .. 5 (avoid)
    const level = score < 2.5 ? 'Low' : score < 3.5 ? 'Moderate' : score < 4.5 ? 'High' : 'Extreme';
    out = { score, level, message: a.message, updated: a.updated };
  }
  cacheSet(key, out, 6 * 3600 * 1000); // 6 hours
  return out;
}

// Is live data plausibly available right now? (Used for status surfaces.)
export function liveDataEnabled() { return ENABLED && typeof fetch === 'function'; }
