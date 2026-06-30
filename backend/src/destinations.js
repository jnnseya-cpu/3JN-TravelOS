// A small catalog of destinations the prototype "knows". Each destination
// carries the data the rest of the system needs: airport codes, the cost basis
// used to synthesise realistic supplier pricing, and visa rules keyed by the
// traveller's nationality.

export const DESTINATIONS = {
  DXB: {
    city: 'Dubai',
    country: 'AE',
    countryName: 'United Arab Emirates',
    airport: 'DXB',
    timezone: 'Asia/Dubai',
    // USD baselines used by the supplier mocks.
    flightBaseUSD: 520,
    hotelNightBaseUSD: 140,
    activityBaseUSD: 65,
    transferBaseUSD: 38,
    carDayBaseUSD: 45,
    aliases: ['dubai', 'dxb', 'united arab emirates', 'uae'],
    visa: {
      // by traveller nationality (ISO country)
      GB: { required: true, type: 'eVisa (30-day tourist)', costUSD: 95, processingDays: 4 },
      US: { required: true, type: 'eVisa (30-day tourist)', costUSD: 95, processingDays: 4 },
      NG: { required: true, type: 'eVisa (30-day tourist)', costUSD: 120, processingDays: 6 },
      IN: { required: true, type: 'eVisa (30-day tourist)', costUSD: 95, processingDays: 5 },
      DEFAULT: { required: true, type: 'eVisa (30-day tourist)', costUSD: 110, processingDays: 5 },
    },
  },
  IST: {
    city: 'Istanbul',
    country: 'TR',
    countryName: 'Türkiye',
    airport: 'IST',
    timezone: 'Europe/Istanbul',
    flightBaseUSD: 320,
    hotelNightBaseUSD: 95,
    activityBaseUSD: 45,
    transferBaseUSD: 28,
    aliases: ['istanbul', 'ist', 'turkey', 'türkiye', 'turkiye'],
    visa: {
      GB: { required: false, type: 'Visa-free (90 days)', costUSD: 0, processingDays: 0 },
      US: { required: false, type: 'Visa-free (90 days)', costUSD: 0, processingDays: 0 },
      NG: { required: true, type: 'eVisa', costUSD: 60, processingDays: 3 },
      DEFAULT: { required: true, type: 'eVisa', costUSD: 50, processingDays: 3 },
    },
  },
  BCN: {
    city: 'Barcelona',
    country: 'ES',
    countryName: 'Spain',
    airport: 'BCN',
    timezone: 'Europe/Madrid',
    flightBaseUSD: 180,
    hotelNightBaseUSD: 130,
    activityBaseUSD: 55,
    transferBaseUSD: 32,
    aliases: ['barcelona', 'bcn', 'spain'],
    visa: {
      GB: { required: false, type: 'Schengen visa-free (90 days)', costUSD: 0, processingDays: 0 },
      US: { required: false, type: 'Schengen visa-free (90 days)', costUSD: 0, processingDays: 0 },
      NG: { required: true, type: 'Schengen short-stay visa', costUSD: 90, processingDays: 15 },
      IN: { required: true, type: 'Schengen short-stay visa', costUSD: 90, processingDays: 15 },
      DEFAULT: { required: true, type: 'Schengen short-stay visa', costUSD: 90, processingDays: 15 },
    },
  },
  JFK: {
    city: 'New York',
    country: 'US',
    countryName: 'United States',
    airport: 'JFK',
    timezone: 'America/New_York',
    flightBaseUSD: 480,
    hotelNightBaseUSD: 210,
    activityBaseUSD: 80,
    transferBaseUSD: 55,
    aliases: ['new york', 'nyc', 'jfk', 'usa', 'united states', 'manhattan'],
    visa: {
      GB: { required: true, type: 'ESTA', costUSD: 21, processingDays: 2 },
      NG: { required: true, type: 'B-2 visa (interview)', costUSD: 185, processingDays: 30 },
      DEFAULT: { required: true, type: 'B-2 visa', costUSD: 185, processingDays: 30 },
    },
  },
  DPS: {
    city: 'Bali',
    country: 'ID',
    countryName: 'Indonesia',
    airport: 'DPS',
    timezone: 'Asia/Makassar',
    flightBaseUSD: 760,
    hotelNightBaseUSD: 70,
    activityBaseUSD: 40,
    transferBaseUSD: 22,
    aliases: ['bali', 'dps', 'denpasar', 'indonesia'],
    visa: {
      GB: { required: true, type: 'Visa on arrival', costUSD: 35, processingDays: 0 },
      DEFAULT: { required: true, type: 'Visa on arrival', costUSD: 35, processingDays: 0 },
    },
  },
};

const ORIGIN_BY_COUNTRY = {
  GB: { airport: 'LHR', city: 'London' },
  US: { airport: 'JFK', city: 'New York' },
  AE: { airport: 'DXB', city: 'Dubai' },
  NG: { airport: 'LOS', city: 'Lagos' },
  FR: { airport: 'CDG', city: 'Paris' },
  DE: { airport: 'FRA', city: 'Frankfurt' },
  ES: { airport: 'MAD', city: 'Madrid' },
  IN: { airport: 'DEL', city: 'Delhi' },
  ZA: { airport: 'JNB', city: 'Johannesburg' },
  CA: { airport: 'YYZ', city: 'Toronto' },
  AU: { airport: 'SYD', city: 'Sydney' },
  SA: { airport: 'RUH', city: 'Riyadh' },
};

export function originForCountry(country) {
  return ORIGIN_BY_COUNTRY[country] || ORIGIN_BY_COUNTRY.GB;
}

// Public catalogue for the Destination Marketplace — indicative "from" prices
// (per person, derived from the cost basis) + headline experiences.
const DEST_BLURB = {
  DXB: { tag: 'Luxury · sun · skyline', emoji: '🌇', experiences: ['Desert safari', 'Burj Khalifa', 'Marina yacht'] },
  IST: { tag: 'Culture · food · history', emoji: '🕌', experiences: ['Bosphorus cruise', 'Grand Bazaar', 'Hagia Sophia'] },
  BCN: { tag: 'Beach · art · tapas', emoji: '🏖️', experiences: ['Sagrada Família', 'Gothic Quarter', 'Beach day'] },
  JFK: { tag: 'City · shopping · shows', emoji: '🗽', experiences: ['Broadway show', 'Empire State', 'Central Park'] },
  DPS: { tag: 'Tropical · wellness · surf', emoji: '🌴', experiences: ['Ubud rice terraces', 'Temple tour', 'Surf lesson'] },
};
// Curated experiences for a catalogue destination (empty for synthesised ones).
export function destExperiences(code) {
  return (DEST_BLURB[code] || {}).experiences || [];
}

export function destinationsCatalog() {
  return Object.entries(DESTINATIONS).map(([code, d]) => {
    const fromUSD = Math.round((d.flightBaseUSD + d.hotelNightBaseUSD * 7 + d.activityBaseUSD * 2) * 0.92);
    const b = DEST_BLURB[code] || { tag: '', emoji: '✈️', experiences: [] };
    return { code, city: d.city, country: d.countryName, airport: d.airport, tag: b.tag, emoji: b.emoji, experiences: b.experiences, fromUSD };
  });
}

export function findDestination(text) {
  const lower = (text || '').toLowerCase();
  for (const [code, dest] of Object.entries(DESTINATIONS)) {
    if (dest.aliases.some((a) => lower.includes(a))) {
      return { code, ...dest };
    }
  }
  return null;
}

export function visaRule(dest, nationality) {
  return dest.visa[nationality] || dest.visa.DEFAULT;
}

// ---- Worldwide destination engine -----------------------------------------
// The OS is global: any city/country the user names must yield a real package,
// not "pick one of five". For destinations outside the curated catalogue we
// synthesise a deterministic cost basis + estimated visa rule so the full
// pipeline (suppliers → packages → pricing → visa) runs anywhere on Earth.
function seedRng(str) {
  let s = 0;
  for (let i = 0; i < (str || '').length; i++) s = (s * 31 + str.charCodeAt(i)) % 2147483647;
  return () => { s = (s * 1103515245 + 12345) % 2147483647; return s / 2147483647; };
}
const titleCaseDest = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Pull the destination phrase out of a free-text request when it isn't a
// catalogue city — e.g. "I want to travel to Kinshasa in August" → "Kinshasa".
const DEST_STOP = /^(in|for|with|on|during|next|this|the|my|our|a|an|and|over|plus|including|nights?|days?|weeks?|month|months|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/i;
export function extractDestination(text) {
  if (!text) return null;
  const m = text.match(/\b(?:travel(?:ling|ing)?|trip|fly(?:ing)?|going|go|holiday|vacation|getaway|visit(?:ing)?|destination|head(?:ing)?)\s+(?:to\s+|in\s+|for\s+)?(.+)/i);
  const tail = m ? m[1] : null;
  if (!tail) return null;
  const words = tail.replace(/[.,!?].*$/, '').split(/\s+/);
  const out = [];
  for (const w of words) {
    if (!w) continue;
    if (DEST_STOP.test(w) || /^\d/.test(w) || !/[A-Za-zÀ-ÿ]/.test(w)) break;
    out.push(w);
    if (out.length >= 3) break;
  }
  // Reject vague descriptors ("somewhere warm", "anywhere cheap") so they still
  // trigger clarifying questions rather than a fabricated destination.
  const NON_PLACE = /^(somewhere|anywhere|nowhere|some|any|warm|warmer|hot|sunny|sunshine|sun|cold|cool|tropical|exotic|nice|lovely|cheap|cheapest|affordable|budget|luxury|abroad|overseas|holiday|holidays|vacation|getaway|paradise|beach|destination|place|places|country|countries|city|cities|somewhere)$/i;
  const placeWords = out.filter((w) => !NON_PLACE.test(w));
  if (!placeWords.length) return null;
  const name = placeWords.join(' ').replace(/[^A-Za-zÀ-ÿ'’\- ]/g, '').trim();
  return name || null;
}

function estimatedVisaRule(rnd) {
  const required = rnd() > 0.3;
  return {
    required,
    type: required ? 'eVisa / eTA (tourist) — estimated' : 'Likely visa-free (estimated)',
    costUSD: required ? Math.round(20 + rnd() * 130) : 0,
    processingDays: required ? Math.round(2 + rnd() * 13) : 0,
  };
}

export function synthesizeDestination(name) {
  const city = titleCaseDest(name);
  if (!city) return null;
  const code = (city.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3)) || 'INT';
  const rnd = seedRng('dest-' + city);
  return {
    code, city, country: '', countryName: '', airport: code, timezone: '',
    flightBaseUSD: Math.round(380 + rnd() * 620),
    hotelNightBaseUSD: Math.round(70 + rnd() * 180),
    activityBaseUSD: Math.round(35 + rnd() * 70),
    transferBaseUSD: Math.round(25 + rnd() * 45),
    carDayBaseUSD: Math.round(30 + rnd() * 55),
    aliases: [city.toLowerCase()],
    visa: { DEFAULT: estimatedVisaRule(rnd) },
    synthetic: true,
  };
}

// Resolve a place NAME (already isolated) → catalogue or synthesised destination.
export function resolveDestination(name) {
  return findDestination(name) || synthesizeDestination(name);
}

// Resolve from a free-text REQUEST sentence → catalogue, or synthesised from the
// extracted destination phrase, or null (ask) when nothing place-like is found.
export function resolveDestinationFromText(text) {
  const known = findDestination(text);
  if (known) return known;
  const guess = extractDestination(text);
  return guess ? synthesizeDestination(guess) : null;
}
