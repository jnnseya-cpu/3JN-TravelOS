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
