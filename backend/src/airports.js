// Airport coordinates + a distance-based fare anchor.
//
// Worldwide pricing accuracy needs the actual flown distance, not a flat random
// base. With origin + destination coordinates we compute the great-circle
// distance and derive a realistic round-trip economy fare per seat — so any city
// on Earth is priced sensibly, and the SAME destination costs more from a
// farther origin (Lagos→Dubai ≠ London→Dubai). Deterministic, no external API.

// Approximate lat/lon for the airports the OS emits (origins + destinations).
// One decimal is plenty for a fare estimate.
const AIRPORT_COORDS = {
  // UK & Ireland
  LHR: [51.5, -0.5], LGW: [51.2, -0.2], STN: [51.9, 0.2], BHX: [52.5, -1.7], MAN: [53.4, -2.3],
  GLA: [55.9, -4.4], EDI: [55.9, -3.4], BRS: [51.4, -2.7], LBA: [53.9, -1.7], LPL: [53.3, -2.9],
  NCL: [55.0, -1.7], DUB: [53.4, -6.3],
  // Port towns (pseudo-codes — ferry/coach gateways, not airports)
  DOV: [51.1, 1.3], FOL: [51.1, 1.2], NHV: [50.8, 0.1], PME: [50.8, -1.1],
  PLH: [50.4, -4.1], HPQ: [51.9, 1.3], HUY: [53.7, -0.3], HLY: [53.3, -4.6],
  CQF: [51.0, 1.9], DKK: [51.0, 2.4],
  // Europe
  CDG: [49.0, 2.5], FRA: [50.0, 8.6], MUC: [48.4, 11.8], BER: [52.4, 13.5], AMS: [52.3, 4.8],
  MAD: [40.5, -3.6], BCN: [41.3, 2.1], LIS: [38.8, -9.1], FCO: [41.8, 12.3], MXP: [45.6, 8.7],
  ZRH: [47.5, 8.5], GVA: [46.2, 6.1], VIE: [48.1, 16.6], BRU: [50.9, 4.5], CPH: [55.6, 12.7],
  ARN: [59.7, 18.0], OSL: [60.2, 11.1], HEL: [60.3, 25.0], ATH: [38.0, 23.9], IST: [41.3, 28.8],
  WAW: [52.2, 21.0],
  // Middle East
  DXB: [25.3, 55.4], AUH: [24.4, 54.7], DOH: [25.3, 51.6], RUH: [24.9, 46.7], JED: [21.7, 39.2],
  TLV: [32.0, 34.9], AMM: [31.7, 35.9],
  // Africa
  LOS: [6.6, 3.3], ABV: [9.0, 7.3], ACC: [5.6, -0.2], NBO: [-1.3, 36.9], JNB: [-26.1, 28.2],
  CPT: [-34.0, 18.6], CAI: [30.1, 31.4], CMN: [33.4, -7.6], FIH: [-4.4, 15.4], ADD: [9.0, 38.8],
  // Americas
  JFK: [40.6, -73.8], LAX: [34.0, -118.4], ORD: [42.0, -87.9], MIA: [25.8, -80.3], SFO: [37.6, -122.4],
  BOS: [42.4, -71.0], YYZ: [43.7, -79.6], YVR: [49.2, -123.2], MEX: [19.4, -99.1], GRU: [-23.4, -46.5],
  EZE: [-34.8, -58.5],
  // Asia-Pacific
  DEL: [28.6, 77.1], BOM: [19.1, 72.9], BLR: [13.2, 77.7], SIN: [1.4, 103.9], HKG: [22.3, 113.9],
  BKK: [13.7, 100.7], KUL: [2.7, 101.7], HND: [35.6, 139.8], ICN: [37.5, 126.4], PEK: [40.1, 116.6],
  PVG: [31.1, 121.8], SYD: [-33.9, 151.2], MEL: [-37.7, 144.8], AKL: [-37.0, 174.8], DPS: [-8.7, 115.2],
};

export function airportCoords(code) {
  return AIRPORT_COORDS[(code || '').toUpperCase()] || null;
}

// Alternative departure airports within reach of the given one — the "airport
// selection" lever of the Deep Price Dive (fly from MAN instead of BHX when
// it's meaningfully cheaper). Sorted nearest-first.
export function nearbyAirports(code, maxKm = 180) {
  const base = airportCoords(code);
  if (!base) return [];
  return Object.entries(AIRPORT_COORDS)
    .filter(([c]) => c !== (code || '').toUpperCase())
    .map(([c, xy]) => ({ code: c, km: Math.round(haversineKm(base, xy)) }))
    .filter((a) => a.km <= maxKm)
    .sort((a, b) => a.km - b.km);
}

// Great-circle distance in km between two [lat, lon] points.
export function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]); const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Realistic round-trip economy fare (USD/seat) for a flown distance. Calibrated
// against real UK fares: ~£150 short-haul, ~£260 Istanbul, ~£500 NY/Dubai,
// ~£950 Bali. Tapers on the ultra-long-haul leg so 12,000km isn't overpriced.
export function distanceFareUSD(km) {
  if (!(km > 0)) return null;
  const knee = 9000;
  const base = km <= knee ? 70 + km * 0.105 : 70 + knee * 0.105 + (km - knee) * 0.07;
  return Math.round(base);
}

// Market premium for thin / low-competition routes where real fares run well
// above what distance alone implies (few carriers, high demand, limited
// capacity). Keyed by destination airport. 1.0 = priced on distance only.
const MARKET_FACTOR = {
  FIH: 1.45, // Kinshasa — very thin, expensive market
  LOS: 1.30, ABV: 1.30, // Nigeria
  ACC: 1.22, // Accra
  ADD: 1.12, NBO: 1.12, // East Africa
  CMN: 1.08,
  GRU: 1.10, EZE: 1.12, // South America long-haul
  AKL: 1.10, // New Zealand
};
export function marketFactor(destCode) {
  return MARKET_FACTOR[(destCode || '').toUpperCase()] || 1.0;
}

// Convenience: round-trip economy fare base for an origin airport → destination,
// adjusted for thin-market premiums. Returns null when either airport's
// coordinates are unknown (caller falls back to the catalogue/synthesised base).
export function routeFareBaseUSD(originCode, destCode) {
  const a = airportCoords(originCode);
  const b = airportCoords(destCode);
  if (!a || !b) return null;
  return Math.round(distanceFareUSD(haversineKm(a, b)) * marketFactor(destCode));
}
