// "Inspire Me" — destination discovery for travellers with no fixed plan.
//
// The customer describes what they want in plain English ("somewhere warm and
// cheap for a beach break") and the OS returns the 3 CHEAPEST matching
// destinations (country + city) for each of the next 30 / 60 / 120 / 180 days.
//
// Pricing is origin-aware and distance-derived (routeFareBaseUSD) so it works
// from ANY departure city, and each window applies a realistic advance-booking
// discount (booking further out is cheaper) plus a deterministic per-destination
// seasonal wobble so different windows can surface different places. Everything
// is a labelled ESTIMATE — a real bookable fare is confirmed when the traveller
// runs the full search on the chosen destination + date.

import { routeFareBaseUSD, airportCoords } from './airports.js';

// A curated, geographically diverse candidate set. Codes MUST exist in the
// airport-coords table so the route can be priced from any origin. Tags drive
// the free-text preference match.
export const INSPIRE_DESTINATIONS = [
  { code: 'IST', city: 'Istanbul', country: 'TR', countryName: 'Türkiye', tags: ['city', 'culture', 'budget', 'foodie', 'history'] },
  { code: 'BCN', city: 'Barcelona', country: 'ES', countryName: 'Spain', tags: ['beach', 'city', 'nightlife', 'warm', 'foodie', 'family'] },
  { code: 'LIS', city: 'Lisbon', country: 'PT', countryName: 'Portugal', tags: ['beach', 'city', 'warm', 'budget', 'foodie', 'romantic'] },
  { code: 'MAD', city: 'Madrid', country: 'ES', countryName: 'Spain', tags: ['city', 'culture', 'foodie', 'nightlife'] },
  { code: 'FCO', city: 'Rome', country: 'IT', countryName: 'Italy', tags: ['city', 'culture', 'history', 'romantic', 'foodie'] },
  { code: 'ATH', city: 'Athens', country: 'GR', countryName: 'Greece', tags: ['beach', 'culture', 'history', 'warm', 'budget'] },
  { code: 'AMS', city: 'Amsterdam', country: 'NL', countryName: 'Netherlands', tags: ['city', 'culture', 'nightlife', 'family'] },
  { code: 'CDG', city: 'Paris', country: 'FR', countryName: 'France', tags: ['city', 'culture', 'romantic', 'foodie', 'family'] },
  { code: 'BER', city: 'Berlin', country: 'DE', countryName: 'Germany', tags: ['city', 'culture', 'nightlife', 'budget', 'history'] },
  { code: 'VIE', city: 'Vienna', country: 'AT', countryName: 'Austria', tags: ['city', 'culture', 'romantic', 'history'] },
  { code: 'CMN', city: 'Casablanca', country: 'MA', countryName: 'Morocco', tags: ['culture', 'warm', 'budget', 'adventure', 'foodie'] },
  { code: 'CAI', city: 'Cairo', country: 'EG', countryName: 'Egypt', tags: ['culture', 'history', 'warm', 'budget', 'adventure'] },
  { code: 'DXB', city: 'Dubai', country: 'AE', countryName: 'United Arab Emirates', tags: ['beach', 'warm', 'luxury', 'family', 'city', 'nightlife'] },
  { code: 'DOH', city: 'Doha', country: 'QA', countryName: 'Qatar', tags: ['warm', 'luxury', 'city', 'family'] },
  { code: 'TLV', city: 'Tel Aviv', country: 'IL', countryName: 'Israel', tags: ['beach', 'warm', 'nightlife', 'city', 'foodie'] },
  { code: 'NBO', city: 'Nairobi', country: 'KE', countryName: 'Kenya', tags: ['nature', 'adventure', 'wildlife', 'warm'] },
  { code: 'CPT', city: 'Cape Town', country: 'ZA', countryName: 'South Africa', tags: ['beach', 'nature', 'adventure', 'romantic', 'foodie', 'warm'] },
  { code: 'ACC', city: 'Accra', country: 'GH', countryName: 'Ghana', tags: ['beach', 'warm', 'culture', 'adventure'] },
  { code: 'BKK', city: 'Bangkok', country: 'TH', countryName: 'Thailand', tags: ['beach', 'warm', 'budget', 'nightlife', 'foodie', 'adventure'] },
  { code: 'KUL', city: 'Kuala Lumpur', country: 'MY', countryName: 'Malaysia', tags: ['warm', 'budget', 'city', 'foodie', 'family'] },
  { code: 'SIN', city: 'Singapore', country: 'SG', countryName: 'Singapore', tags: ['city', 'warm', 'luxury', 'family', 'foodie'] },
  { code: 'DPS', city: 'Bali', country: 'ID', countryName: 'Indonesia', tags: ['beach', 'warm', 'nature', 'romantic', 'budget', 'adventure'] },
  { code: 'HND', city: 'Tokyo', country: 'JP', countryName: 'Japan', tags: ['city', 'culture', 'foodie', 'adventure'] },
  { code: 'DEL', city: 'Delhi', country: 'IN', countryName: 'India', tags: ['culture', 'history', 'budget', 'foodie', 'adventure'] },
  { code: 'MIA', city: 'Miami', country: 'US', countryName: 'United States', tags: ['beach', 'warm', 'nightlife', 'luxury'] },
  { code: 'JFK', city: 'New York', country: 'US', countryName: 'United States', tags: ['city', 'culture', 'nightlife', 'family'] },
  { code: 'MEX', city: 'Mexico City', country: 'MX', countryName: 'Mexico', tags: ['culture', 'history', 'budget', 'foodie', 'warm'] },
  { code: 'SYD', city: 'Sydney', country: 'AU', countryName: 'Australia', tags: ['beach', 'warm', 'nature', 'family', 'city'] },
];

// Free-text → preference tags.
const PREF_KEYWORDS = {
  beach: ['beach', 'sea', 'coast', 'sand', 'island', 'seaside', 'ocean'],
  warm: ['warm', 'hot', 'sun', 'sunny', 'sunshine', 'tropical', 'heat'],
  city: ['city', 'urban', 'city break', 'shopping', 'shop'],
  culture: ['culture', 'cultural', 'museum', 'art', 'heritage'],
  history: ['history', 'historic', 'historical', 'ancient', 'ruins'],
  nightlife: ['nightlife', 'party', 'club', 'clubs', 'bars', 'vibrant'],
  nature: ['nature', 'hike', 'hiking', 'mountain', 'mountains', 'outdoor', 'outdoors', 'scenery', 'scenic'],
  wildlife: ['safari', 'wildlife', 'animals'],
  foodie: ['food', 'foodie', 'cuisine', 'culinary', 'restaurant', 'restaurants', 'eat', 'eating'],
  budget: ['cheap', 'cheapest', 'budget', 'affordable', 'affordably', 'inexpensive', 'low cost', 'low-cost', 'save'],
  luxury: ['luxury', 'luxurious', '5 star', 'five star', 'premium', 'upscale', 'high end', 'high-end'],
  romantic: ['romantic', 'romance', 'honeymoon', 'couple', 'anniversary'],
  family: ['family', 'kids', 'children', 'child'],
  adventure: ['adventure', 'adventurous', 'explore', 'backpack', 'backpacking', 'off the beaten'],
};

export function parseInspire(text) {
  const t = String(text || '').toLowerCase();
  const tags = new Set();
  for (const [tag, kws] of Object.entries(PREF_KEYWORDS)) {
    if (kws.some((k) => t.includes(k))) tags.add(tag);
  }
  return { tags };
}

// Deterministic per-string factor in [lo, hi] — no Math.random, so results are
// stable for the same input (a per-destination-per-window seasonal wobble).
function hashFactor(str, lo = 0.85, hi = 1.15) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 1000000;
  return lo + ((h % 1000) / 1000) * (hi - lo);
}

export const INSPIRE_WINDOWS = [30, 60, 120, 180];
// Booking further ahead is cheaper — the deeper the window, the lower the floor.
const WINDOW_FACTOR = { 30: 1.0, 60: 0.92, 120: 0.85, 180: 0.80 };

// Core engine. Returns { windows: { 30:[...3], 60:[...], 120:[...], 180:[...] },
// matchedTags }. Prices are per-party (fare × travellers), USD; the caller
// converts to the traveller's currency.
export function inspireDestinations({ text = '', originCode = 'LHR', travellers = 1, perPerson = false } = {}) {
  const { tags } = parseInspire(text);
  const pax = Math.max(1, Math.round(travellers) || 1);
  const origin = (originCode || 'LHR').toUpperCase();

  const candidates = INSPIRE_DESTINATIONS
    .filter((d) => d.code !== origin && airportCoords(d.code))
    .map((d) => {
      const base = routeFareBaseUSD(origin, d.code);
      if (!base) return null;
      const score = tags.size ? d.tags.filter((x) => tags.has(x)).length : 0;
      return { ...d, base, score };
    })
    .filter(Boolean);

  // Honour stated preferences: keep matching destinations when at least 3 match,
  // otherwise fall back to the whole set so we always return three options.
  let pool = candidates;
  if (tags.size) {
    const matching = candidates.filter((c) => c.score > 0);
    if (matching.length >= 3) pool = matching;
  }

  const windows = {};
  for (const w of INSPIRE_WINDOWS) {
    const priced = pool.map((d) => {
      const seasonal = hashFactor(`${d.code}:${w}`);
      const perSeatUSD = Math.max(1, Math.round(d.base * WINDOW_FACTOR[w] * seasonal));
      return {
        code: d.code, city: d.city, country: d.country, countryName: d.countryName,
        tags: d.tags, matchedTags: d.tags.filter((x) => tags.has(x)),
        perSeatUSD,
        fromUSD: perPerson ? perSeatUSD : perSeatUSD * pax,
        travellers: pax,
        // A plausible off-peak departure ~55% into the window (mid-week bias
        // applied when the caller stamps the real date).
        offsetDays: Math.round(w * 0.55),
        window: w,
      };
    })
      .sort((a, b) => a.fromUSD - b.fromUSD || b.matchedTags.length - a.matchedTags.length)
      .slice(0, 3);
    windows[w] = priced;
  }
  return { windows, matchedTags: [...tags] };
}
