// Location, language and currency detection.
//
// In a real deployment this would read the request IP (via a GeoIP service),
// the Accept-Language header and the user's saved profile. For the prototype we
// derive everything we can from the inbound request headers and fall back to a
// sensible default so the experience is fully offline-capable.

const CURRENCY_BY_COUNTRY = {
  GB: { code: 'GBP', symbol: '£', rateFromUSD: 0.79 },
  US: { code: 'USD', symbol: '$', rateFromUSD: 1 },
  AE: { code: 'AED', symbol: 'د.إ', rateFromUSD: 3.67 },
  NG: { code: 'NGN', symbol: '₦', rateFromUSD: 1480 },
  FR: { code: 'EUR', symbol: '€', rateFromUSD: 0.92 },
  DE: { code: 'EUR', symbol: '€', rateFromUSD: 0.92 },
  ES: { code: 'EUR', symbol: '€', rateFromUSD: 0.92 },
  IN: { code: 'INR', symbol: '₹', rateFromUSD: 83.2 },
  ZA: { code: 'ZAR', symbol: 'R', rateFromUSD: 18.4 },
  CA: { code: 'CAD', symbol: 'C$', rateFromUSD: 1.36 },
  AU: { code: 'AUD', symbol: 'A$', rateFromUSD: 1.51 },
  SA: { code: 'SAR', symbol: '﷼', rateFromUSD: 3.75 },
  // Pan-Africa / DRC diaspora corridor — primary BitriPay market.
  CD: { code: 'CDF', symbol: 'FC', rateFromUSD: 2800 },
  KE: { code: 'KES', symbol: 'KSh', rateFromUSD: 129 },
};

const LANGUAGE_BY_COUNTRY = {
  GB: 'en', US: 'en', AE: 'ar', NG: 'en', FR: 'fr', DE: 'de',
  ES: 'es', IN: 'en', ZA: 'en', CA: 'en', AU: 'en', SA: 'ar',
  CD: 'fr', KE: 'sw', // DRC (French/Lingala), Kenya (Swahili)
};

const COUNTRY_NAMES = {
  GB: 'United Kingdom', US: 'United States', AE: 'United Arab Emirates',
  NG: 'Nigeria', FR: 'France', DE: 'Germany', ES: 'Spain', IN: 'India',
  ZA: 'South Africa', CA: 'Canada', AU: 'Australia', SA: 'Saudi Arabia',
  CD: 'DR Congo', KE: 'Kenya',
};

const DEFAULT_COUNTRY = 'GB';

function parseAcceptLanguage(header) {
  if (!header) return null;
  // e.g. "en-GB,en;q=0.9,fr;q=0.8"
  const first = header.split(',')[0].trim();
  const region = first.split('-')[1];
  return region ? region.toUpperCase() : null;
}

export function detectContext(req, overrides = {}) {
  const headerCountry = parseAcceptLanguage(req?.headers?.['accept-language']);
  const country =
    overrides.country ||
    req?.headers?.['x-country'] ||
    headerCountry ||
    DEFAULT_COUNTRY;

  const known = CURRENCY_BY_COUNTRY[country] ? country : DEFAULT_COUNTRY;
  // currencyCountry must be clamped to a supported country too — an unsupported
  // ISO code (IT, JP, CN, BR… any country outside the map) would make `currency`
  // undefined and 500 the whole search on `currency.code` below.
  const curCountry = CURRENCY_BY_COUNTRY[overrides.currencyCountry] ? overrides.currencyCountry : known;
  const currency = CURRENCY_BY_COUNTRY[curCountry];

  return {
    country: known,
    countryName: COUNTRY_NAMES[known],
    language: overrides.language || LANGUAGE_BY_COUNTRY[known] || 'en',
    currency: {
      code: currency.code,
      symbol: currency.symbol,
      rateFromUSD: currency.rateFromUSD,
    },
    detectedFrom: headerCountry ? 'accept-language' : 'default',
  };
}

// One entry PER CURRENCY (not per country) — several countries share a currency
// (FR/DE/ES all use EUR), which previously listed the Euro three times. Dedupe
// by currency code, keeping the first country as the representative.
export function listCurrencies() {
  const seen = new Set();
  const out = [];
  for (const [country, c] of Object.entries(CURRENCY_BY_COUNTRY)) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    out.push({ country, countryName: COUNTRY_NAMES[country], ...c });
  }
  return out;
}

export { CURRENCY_BY_COUNTRY, COUNTRY_NAMES };
