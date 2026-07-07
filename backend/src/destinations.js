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
    flightBaseUSD: 620,
    hotelNightBaseUSD: 130,
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
    flightBaseUSD: 330,
    hotelNightBaseUSD: 90,
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
    flightBaseUSD: 170,
    hotelNightBaseUSD: 125,
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
    flightBaseUSD: 680,
    hotelNightBaseUSD: 200,
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
    flightBaseUSD: 1050,
    hotelNightBaseUSD: 68,
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
  const o = ORIGIN_BY_COUNTRY[country] || ORIGIN_BY_COUNTRY.GB;
  return { ...o, country: ORIGIN_BY_COUNTRY[country] ? country : 'GB' };
}

// Real IATA codes for major world origin cities. Deriving an airport code from
// the first three letters of a city name produces nonsense ("Birmingham"→"BIR",
// which is Biratnagar, Nepal). This table keeps departures accurate worldwide.
// Keyed by lowercase city name (with common aliases). country is ISO-3166-1.
const CITY_AIRPORTS = {
  // United Kingdom & Ireland
  london: { airport: 'LHR', city: 'London', country: 'GB' },
  birmingham: { airport: 'BHX', city: 'Birmingham', country: 'GB' },
  manchester: { airport: 'MAN', city: 'Manchester', country: 'GB' },
  glasgow: { airport: 'GLA', city: 'Glasgow', country: 'GB' },
  edinburgh: { airport: 'EDI', city: 'Edinburgh', country: 'GB' },
  bristol: { airport: 'BRS', city: 'Bristol', country: 'GB' },
  leeds: { airport: 'LBA', city: 'Leeds', country: 'GB' },
  liverpool: { airport: 'LPL', city: 'Liverpool', country: 'GB' },
  newcastle: { airport: 'NCL', city: 'Newcastle', country: 'GB' },
  'new castle': { airport: 'NCL', city: 'Newcastle', country: 'GB' },
  'london gatwick': { airport: 'LGW', city: 'London', country: 'GB' },
  'london stansted': { airport: 'STN', city: 'London', country: 'GB' },
  dublin: { airport: 'DUB', city: 'Dublin', country: 'IE' },
  // Europe
  paris: { airport: 'CDG', city: 'Paris', country: 'FR' },
  frankfurt: { airport: 'FRA', city: 'Frankfurt', country: 'DE' },
  munich: { airport: 'MUC', city: 'Munich', country: 'DE' },
  berlin: { airport: 'BER', city: 'Berlin', country: 'DE' },
  amsterdam: { airport: 'AMS', city: 'Amsterdam', country: 'NL' },
  madrid: { airport: 'MAD', city: 'Madrid', country: 'ES' },
  barcelona: { airport: 'BCN', city: 'Barcelona', country: 'ES' },
  lisbon: { airport: 'LIS', city: 'Lisbon', country: 'PT' },
  rome: { airport: 'FCO', city: 'Rome', country: 'IT' },
  milan: { airport: 'MXP', city: 'Milan', country: 'IT' },
  zurich: { airport: 'ZRH', city: 'Zurich', country: 'CH' },
  geneva: { airport: 'GVA', city: 'Geneva', country: 'CH' },
  vienna: { airport: 'VIE', city: 'Vienna', country: 'AT' },
  brussels: { airport: 'BRU', city: 'Brussels', country: 'BE' },
  copenhagen: { airport: 'CPH', city: 'Copenhagen', country: 'DK' },
  stockholm: { airport: 'ARN', city: 'Stockholm', country: 'SE' },
  oslo: { airport: 'OSL', city: 'Oslo', country: 'NO' },
  helsinki: { airport: 'HEL', city: 'Helsinki', country: 'FI' },
  athens: { airport: 'ATH', city: 'Athens', country: 'GR' },
  istanbul: { airport: 'IST', city: 'Istanbul', country: 'TR' },
  warsaw: { airport: 'WAW', city: 'Warsaw', country: 'PL' },
  // Middle East
  dubai: { airport: 'DXB', city: 'Dubai', country: 'AE' },
  'abu dhabi': { airport: 'AUH', city: 'Abu Dhabi', country: 'AE' },
  doha: { airport: 'DOH', city: 'Doha', country: 'QA' },
  riyadh: { airport: 'RUH', city: 'Riyadh', country: 'SA' },
  jeddah: { airport: 'JED', city: 'Jeddah', country: 'SA' },
  'tel aviv': { airport: 'TLV', city: 'Tel Aviv', country: 'IL' },
  amman: { airport: 'AMM', city: 'Amman', country: 'JO' },
  // Africa
  lagos: { airport: 'LOS', city: 'Lagos', country: 'NG' },
  abuja: { airport: 'ABV', city: 'Abuja', country: 'NG' },
  accra: { airport: 'ACC', city: 'Accra', country: 'GH' },
  nairobi: { airport: 'NBO', city: 'Nairobi', country: 'KE' },
  johannesburg: { airport: 'JNB', city: 'Johannesburg', country: 'ZA' },
  'cape town': { airport: 'CPT', city: 'Cape Town', country: 'ZA' },
  cairo: { airport: 'CAI', city: 'Cairo', country: 'EG' },
  casablanca: { airport: 'CMN', city: 'Casablanca', country: 'MA' },
  kinshasa: { airport: 'FIH', city: 'Kinshasa', country: 'CD' },
  'addis ababa': { airport: 'ADD', city: 'Addis Ababa', country: 'ET' },
  // Americas
  'new york': { airport: 'JFK', city: 'New York', country: 'US' },
  'los angeles': { airport: 'LAX', city: 'Los Angeles', country: 'US' },
  chicago: { airport: 'ORD', city: 'Chicago', country: 'US' },
  miami: { airport: 'MIA', city: 'Miami', country: 'US' },
  'san francisco': { airport: 'SFO', city: 'San Francisco', country: 'US' },
  boston: { airport: 'BOS', city: 'Boston', country: 'US' },
  toronto: { airport: 'YYZ', city: 'Toronto', country: 'CA' },
  vancouver: { airport: 'YVR', city: 'Vancouver', country: 'CA' },
  'mexico city': { airport: 'MEX', city: 'Mexico City', country: 'MX' },
  'sao paulo': { airport: 'GRU', city: 'São Paulo', country: 'BR' },
  'são paulo': { airport: 'GRU', city: 'São Paulo', country: 'BR' },
  'buenos aires': { airport: 'EZE', city: 'Buenos Aires', country: 'AR' },
  // Asia-Pacific
  delhi: { airport: 'DEL', city: 'Delhi', country: 'IN' },
  mumbai: { airport: 'BOM', city: 'Mumbai', country: 'IN' },
  bangalore: { airport: 'BLR', city: 'Bangalore', country: 'IN' },
  singapore: { airport: 'SIN', city: 'Singapore', country: 'SG' },
  'hong kong': { airport: 'HKG', city: 'Hong Kong', country: 'HK' },
  bangkok: { airport: 'BKK', city: 'Bangkok', country: 'TH' },
  'kuala lumpur': { airport: 'KUL', city: 'Kuala Lumpur', country: 'MY' },
  tokyo: { airport: 'HND', city: 'Tokyo', country: 'JP' },
  seoul: { airport: 'ICN', city: 'Seoul', country: 'KR' },
  beijing: { airport: 'PEK', city: 'Beijing', country: 'CN' },
  shanghai: { airport: 'PVG', city: 'Shanghai', country: 'CN' },
  sydney: { airport: 'SYD', city: 'Sydney', country: 'AU' },
  melbourne: { airport: 'MEL', city: 'Melbourne', country: 'AU' },
  auckland: { airport: 'AKL', city: 'Auckland', country: 'NZ' },
};

// Look up a city's real airport + country. Returns null when unknown.
export function airportForCity(name) {
  const key = (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return CITY_AIRPORTS[key] || null;
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
const DEST_STOP = /^(in|for|with|on|during|next|this|the|my|our|a|an|and|over|plus|including|by|via|where|who|nights?|days?|weeks?|month|months|plane|flight|flights|air|train|rail|coach|bus|ferry|cruise|boat|car|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/i;
export function extractDestination(text) {
  if (!text) return null;
  // Work on a padded, punctuation-stripped copy.
  let t = ' ' + text.replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ') + ' ';
  // Strip a "from <origin>" clause so the origin is never mistaken for the
  // destination ("fly from Manchester to Lisbon" → destination is Lisbon).
  t = t.replace(/\sfrom\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’\- ]*?(?=\s+(?:to|in|for|with|on|and|by|next|this|during)\s|\s\d|\s*$)/ig, ' ');
  // The destination follows the LAST " to " ("I want to travel to Lisbon").
  let tail = null;
  const parts = t.split(/\sto\s/i);
  if (parts.length > 1) tail = parts[parts.length - 1];
  else {
    // Leading "<Destination> from <origin>" / "<Destination> by ferry" — the
    // sentence opens with the place itself ("Amsterdam from Newcastle by
    // ferry"). Only a capitalised opener counts, never a sentence starter.
    const STARTERS = /^(i|we|my|our|please|can|could|would|book|find|get|plan|show|looking|want|need|give|help|hi|hello|the|a|an|cheap|cheapest|mini|direct|return|one)$/i;
    const lead = (text || '').trim().match(/^([A-ZÀ-Þ][A-Za-zÀ-ÿ'’\-]*(?:\s+[A-ZÀ-Þ][A-Za-zÀ-ÿ'’\-]*){0,2})\s+(?:from|by|in|for|with|on|next|this|during)\b/);
    if (lead && !STARTERS.test(lead[1].split(/\s+/)[0])) tail = lead[1] + ' ';
    if (!tail) { const m = t.match(/\b(?:visit(?:ing)?|destination|holiday\s+in|vacation\s+in|getaway\s+to|\bin)\s+(.+)/i); tail = m ? m[1] : null; }
  }
  if (!tail) return null;
  const words = tail.trim().split(/\s+/);
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

// ISO country code → English name (e.g. 'CD' → 'Democratic Republic of the
// Congo'). Uses Intl; falls back to the raw code if unavailable.
let REGION_NAMES = null;
function regionName(iso) {
  if (!iso) return '';
  try {
    REGION_NAMES = REGION_NAMES || new Intl.DisplayNames(['en'], { type: 'region' });
    return REGION_NAMES.of(iso.toUpperCase()) || iso;
  } catch { return iso; }
}

export function synthesizeDestination(name) {
  // Resolve a known city to its REAL airport + country (so distance pricing and
  // carrier-hub realism work), incl. a "City Country" form like "Doha Qatar".
  let known = airportForCity(name);
  if (!known) {
    const parts = (name || '').trim().split(/\s+/);
    if (parts.length > 1) known = airportForCity(parts.slice(0, -1).join(' ')) || airportForCity(parts[0]);
  }
  const city = titleCaseDest(known ? known.city : name);
  if (!city) return null;
  const code = known ? known.airport : ((city.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3)) || 'INT');
  const country = known ? known.country : '';
  const rnd = seedRng('dest-' + city);
  return {
    code, city, country, countryName: country ? regionName(country) : '',
    airport: code, timezone: '',
    // Fallback only — the distance model overrides this when both airports'
    // coordinates are known (which they are for any real, resolved city).
    flightBaseUSD: Math.round(300 + rnd() * 750),
    hotelNightBaseUSD: Math.round(70 + rnd() * 150),
    activityBaseUSD: Math.round(35 + rnd() * 70),
    transferBaseUSD: Math.round(25 + rnd() * 45),
    carDayBaseUSD: Math.round(30 + rnd() * 55),
    aliases: [city.toLowerCase()],
    visa: { DEFAULT: estimatedVisaRule(rnd) },
    synthetic: true,
  };
}

// When the user names an arrival COUNTRY instead of a city, recommend the main
// gateway city for that country so we never return a "country as a city".
const COUNTRY_TO_CITY = {
  nigeria: 'Lagos', ghana: 'Accra', kenya: 'Nairobi', 'south africa': 'Johannesburg', egypt: 'Cairo',
  morocco: 'Casablanca', 'democratic republic of the congo': 'Kinshasa', congo: 'Kinshasa', drc: 'Kinshasa',
  japan: 'Tokyo', china: 'Beijing', india: 'New Delhi', thailand: 'Bangkok', indonesia: 'Bali',
  'south korea': 'Seoul', singapore: 'Singapore', malaysia: 'Kuala Lumpur', vietnam: 'Hanoi',
  france: 'Paris', spain: 'Barcelona', italy: 'Rome', germany: 'Berlin', portugal: 'Lisbon',
  'united kingdom': 'London', uk: 'London', britain: 'London', greece: 'Athens', netherlands: 'Amsterdam',
  'united states': 'New York', usa: 'New York', america: 'New York', canada: 'Toronto', brazil: 'Rio de Janeiro',
  mexico: 'Cancún', argentina: 'Buenos Aires', australia: 'Sydney', 'new zealand': 'Auckland',
  uae: 'Dubai', 'united arab emirates': 'Dubai', 'saudi arabia': 'Riyadh', qatar: 'Doha', turkey: 'Istanbul',
};
// Returns the recommended city if `name` is a known country, else null.
export function recommendedCityForCountry(name) {
  const c = COUNTRY_TO_CITY[(name || '').trim().toLowerCase()];
  return c || null;
}

// Resolve a place NAME (already isolated) → catalogue or synthesised destination.
// If the name is a country, recommend its gateway city.
export function resolveDestination(name) {
  const known = findDestination(name);
  if (known) return known;
  const rec = recommendedCityForCountry(name);
  if (rec) {
    const d = findDestination(rec) || synthesizeDestination(rec);
    if (d) { d.recommendedFromCountry = titleCaseDest(name); }
    return d;
  }
  return synthesizeDestination(name);
}

// Resolve an ORIGIN / departure city → an airport + city. Falls back to a code
// derived from the city name for anywhere not in the catalogue.
// Port towns — ferry/coach gateways with no meaningful airport of their own.
// A port origin routes SURFACE modes (ferry, international coach, rail), not a
// fabricated flight.
const PORT_TOWNS = {
  dover: { code: 'DOV', city: 'Dover', country: 'GB' },
  folkestone: { code: 'FOL', city: 'Folkestone', country: 'GB' },
  newhaven: { code: 'NHV', city: 'Newhaven', country: 'GB' },
  portsmouth: { code: 'PME', city: 'Portsmouth', country: 'GB' },
  plymouth: { code: 'PLH', city: 'Plymouth', country: 'GB' },
  harwich: { code: 'HPQ', city: 'Harwich', country: 'GB' },
  hull: { code: 'HUY', city: 'Hull', country: 'GB' },
  holyhead: { code: 'HLY', city: 'Holyhead', country: 'GB' },
  calais: { code: 'CQF', city: 'Calais', country: 'FR' },
  dunkirk: { code: 'DKK', city: 'Dunkirk', country: 'FR' },
};

export function resolveOrigin(name) {
  // 0) Port towns first — they are ferry/coach gateways, not airports.
  const port = PORT_TOWNS[String(name || '').trim().toLowerCase()];
  if (port) return { airport: port.code, city: port.city, country: port.country, port: true };
  // 1) Real IATA table for major world cities (accurate codes + country).
  const real = airportForCity(name);
  if (real) return { airport: real.airport, city: real.city, country: real.country };
  // 2) Destination catalogue (carries its own airport + ISO country).
  const known = findDestination(name);
  if (known) return { airport: known.airport, city: known.city, country: known.country };
  // 3) Unknown city — title-case it and derive a placeholder code, flagged so
  //    the UI can tell the traveller we assumed the nearest code.
  const city = titleCaseDest(name);
  if (!city) return null;
  const airport = (city.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3)) || 'INT';
  return { airport, city, country: null, approxCode: true };
}

// Resolve from a free-text REQUEST sentence → catalogue, or synthesised from the
// extracted destination phrase, or null (ask) when nothing place-like is found.
export function resolveDestinationFromText(text) {
  const known = findDestination(text);
  if (known) return known;
  const guess = extractDestination(text);
  return guess ? resolveDestination(guess) : null;
}
