// Market Benchmark — proves 3JN live fares against the market leaders
// (Skyscanner, Google Flights, Kayak) BEFORE go-live. It runs real routes
// through the SAME live Duffel search customers get, prices them with the SAME
// checkout math (10% commission + Duffel pass-through), and hands the admin
// prefilled leader links for the identical route + dates so a human can read
// the market price in seconds and record it. Verdicts are honest: we either
// beat the market, sit within 3%, or we're above it by a stated amount.

import { fetchLiveFlights, liveFlightsEnabled, duffelMode } from './live-suppliers.js';
import { duffelOrderFeesUSD } from './pricing.js';
import { COMMISSION_RATE } from '../../shared/constants.js';

// Matches geo.js GB rate so benchmark GBP figures agree with the storefront.
const GBP_PER_USD = 0.79;
const gbp = (usd) => Math.round(usd * GBP_PER_USD * 100) / 100;

export const BENCHMARK_LEADERS = ['Skyscanner', 'Google Flights', 'Kayak'];

// Routes that matter to the business: the user's own test route first, then
// the core UK + diaspora corridors where we must win.
export const DEFAULT_BENCHMARK_ROUTES = [
  { label: 'Nottingham (EMA) → Brussels', origin: 'EMA', dest: 'BRU' },
  { label: 'Birmingham → Brussels (Nottingham alt.)', origin: 'BHX', dest: 'BRU' },
  { label: 'London → Dubai', origin: 'LHR', dest: 'DXB' },
  { label: 'London → New York', origin: 'LHR', dest: 'JFK' },
  { label: 'London → Kinshasa', origin: 'LHR', dest: 'FIH' },
  { label: 'London → Lagos', origin: 'LHR', dest: 'LOS' },
  { label: 'Manchester → Istanbul', origin: 'MAN', dest: 'IST' },
];

// Prefilled deep links to the market leaders for the SAME route and dates —
// the admin clicks, reads the leader's price, and records it next to ours.
export function compareLinks({ origin, dest, depart, ret }) {
  const yymmdd = (d) => String(d || '').replaceAll('-', '').slice(2);
  const o = String(origin || '').toUpperCase();
  const t = String(dest || '').toUpperCase();
  return {
    skyscanner: `https://www.skyscanner.net/transport/flights/${o.toLowerCase()}/${t.toLowerCase()}/${yymmdd(depart)}/${ret ? `${yymmdd(ret)}/` : ''}`,
    googleFlights: `https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from ${o} to ${t} on ${depart}${ret ? ` through ${ret}` : ''}`)}`,
    kayak: `https://www.kayak.co.uk/flights/${o}-${t}/${depart}${ret ? `/${ret}` : ''}`,
  };
}

// Customer sell price from a raw live fare — the SAME math the checkout uses
// (10% commission + Duffel pass-through fees), so the benchmark tests the
// price a customer actually pays, never a fantasy raw fare.
export function sellPriceUSD(rawUSD) {
  const commission = rawUSD * COMMISSION_RATE;
  const preFee = rawUSD + commission;
  const fees = duffelOrderFeesUSD({ orderValueUSD: preFee });
  return Math.round((preFee + fees.totalUSD) * 100) / 100;
}

// Honest verdict vs a recorded market-leader price (both in GBP).
export function benchmarkVerdict(ourGbp, marketGbp) {
  if (!(Number(marketGbp) > 0)) return { verdict: 'awaiting-market-price', deltaGbp: null, deltaPct: null };
  const deltaGbp = Math.round((ourGbp - marketGbp) * 100) / 100;
  const deltaPct = Math.round((deltaGbp / marketGbp) * 1000) / 10;
  if (deltaGbp <= 0) return { verdict: 'unbeatable', deltaGbp, deltaPct };
  if (deltaPct <= 3) return { verdict: 'competitive', deltaGbp, deltaPct };
  return { verdict: 'above-market', deltaGbp, deltaPct };
}

// Run the live benchmark. Needs the Duffel key, so in practice this runs on
// production; locally it explains itself instead of silently returning junk.
export async function runFlightBenchmark({ routes = DEFAULT_BENCHMARK_ROUTES, depart, ret, adults = 1 } = {}) {
  if (!liveFlightsEnabled()) {
    return {
      ok: false,
      reason: 'live-flights-not-configured',
      mode: duffelMode(),
      message: 'No live fare key (Duffel or Tequila) in this environment — run the benchmark on production (Vercel), where the live keys are set.',
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(depart || ''))) {
    return { ok: false, reason: 'bad-date', message: 'Pass a departure date as YYYY-MM-DD.' };
  }
  const travellers = { adults: Math.max(1, Number(adults) || 1), children: 0, total: Math.max(1, Number(adults) || 1), childAges: [] };
  const intent = { dates: { checkIn: depart, checkOut: ret || null }, travellers };
  const rows = [];
  for (const r of routes.slice(0, 8)) {
    const origin = String(r.origin || '').toUpperCase();
    const dest = String(r.dest || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(dest)) continue;
    const row = {
      id: `${origin}-${dest}-${depart}`,
      label: r.label || `${origin} → ${dest}`,
      origin, dest, depart, ret: ret || null, adults: travellers.adults,
      links: compareLinks({ origin, dest, depart, ret }),
      market: null, result: null,
    };
    try {
      const offers = await fetchLiveFlights(intent, { code: dest }, { airport: origin });
      if (offers && offers.length) {
        const best = offers.reduce((a, b) => (a.priceUSD <= b.priceUSD ? a : b));
        const sellUSD = sellPriceUSD(best.priceUSD);
        row.carrier = best.supplier;
        row.cabin = best.details?.cabin || 'Economy';
        row.baggage = best.details?.baggage || '';
        row.live = true;
        row.rawFareGbp = gbp(best.priceUSD);
        row.ourPriceGbp = gbp(sellUSD);
        row.offersFound = offers.length;
      } else {
        row.live = false;
        row.error = 'no-offers';
      }
    } catch (e) {
      row.live = false;
      row.error = String(e?.message || e).slice(0, 120);
    }
    rows.push(row);
  }
  return { ok: true, run: { at: new Date().toISOString(), depart, ret: ret || null, adults: travellers.adults, mode: duffelMode(), rows } };
}
