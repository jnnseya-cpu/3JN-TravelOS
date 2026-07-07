// Deep Price Dive — the deep-thinking pass that runs on EVERY funded search.
//
// The promise: outstanding, extremely competitive, unbeatable prices. The base
// scan already picks the cheapest *reliable* combination; this engine then
// digs further across four proven levers and quantifies each one:
//
//   1. Date optimisation      — rescan flights across ±3 departure days
//   2. Airport selection      — rescan from every alternative airport in reach
//   3. Supplier competition   — the spread the multi-supplier scan already won
//   4. Negotiated net rates   — agent-account savings vs public prices
//
// Everything is deterministic local compute (seeded scans), so the dive costs
// no external AI spend and never violates the ACPE cost-protection gate — depth
// is free, so every search gets it. The traveller's request is never mutated:
// cheaper alternatives are SURFACED with exact savings, not silently applied.

import { scanFlights } from './suppliers.js';
import { nearbyAirports } from './airports.js';

const round = (n) => Math.round(n);
const floorOf = (offers = []) => {
  const ok = offers.filter((o) => o.verified && o.reliabilityScore >= 70);
  return ok.length ? Math.min(...ok.map((o) => o.priceUSD)) : null;
};

function shiftDates(intent, days) {
  const shift = (iso) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  return {
    ...intent,
    dates: {
      checkIn: shift(intent.dates.checkIn),
      checkOut: intent.dates.checkOut ? shift(intent.dates.checkOut) : intent.dates.checkOut,
    },
  };
}

// Run the dive. `scan` is the already-sourced base scan (applySourcing done).
export function deepPriceDive({ intent, dest, origin, scan, liveFlights = false }) {
  const savings = [];
  let combinationsExplored = Object.values(scan).reduce((s, offers) => s + (offers?.length || 0), 0);

  const baseFlightFloor = floorOf(scan.flights);

  // ---- 1. Date optimisation: ±3 departure days ----------------------------
  if (baseFlightFloor != null && intent.dates?.checkIn) {
    let best = null;
    for (const days of [-3, -2, -1, 1, 2, 3]) {
      const shifted = shiftDates(intent, days);
      const offers = scanFlights(shifted, dest, origin);
      combinationsExplored += offers.length;
      const f = floorOf(offers);
      if (f != null && (!best || f < best.priceUSD)) {
        best = { priceUSD: f, days, checkIn: shifted.dates.checkIn };
      }
    }
    if (best && best.priceUSD < baseFlightFloor * 0.98) {
      savings.push({
        lever: 'Date optimisation',
        savingUSD: round(baseFlightFloor - best.priceUSD),
        how: `Depart ${best.days > 0 ? '+' : ''}${best.days} day${Math.abs(best.days) > 1 ? 's' : ''} (${best.checkIn}) and the same flights drop.`,
        apply: { shiftDays: best.days, checkIn: best.checkIn },
        // Alternative dates are re-priced by the model, not the live feed —
        // acting on this re-searches for the exact live fare (never charged blind).
        basis: liveFlights ? 'indicative' : 'estimated',
      });
    }
  }

  // ---- 2. Airport selection: every alternative departure in reach ---------
  if (baseFlightFloor != null && origin?.airport) {
    let best = null;
    for (const alt of nearbyAirports(origin.airport, 180)) {
      const offers = scanFlights(intent, dest, { ...origin, airport: alt.code });
      combinationsExplored += offers.length;
      const f = floorOf(offers);
      if (f != null && (!best || f < best.priceUSD)) best = { priceUSD: f, code: alt.code, km: alt.km };
    }
    if (best && best.priceUSD < baseFlightFloor * 0.97) {
      savings.push({
        lever: 'Airport selection',
        savingUSD: round(baseFlightFloor - best.priceUSD),
        how: `Fly from ${best.code} (${best.km} km away) instead of ${origin.airport}.`,
        apply: { airport: best.code },
        basis: liveFlights ? 'indicative' : 'estimated',
      });
    }
  }

  // ---- 3. Supplier competition: the spread the scan already beat ----------
  let supplierSpreadUSD = 0;
  for (const offers of Object.values(scan)) {
    if (!offers || offers.length < 2) continue;
    const ok = offers.filter((o) => o.verified && o.reliabilityScore >= 70);
    if (ok.length < 2) continue;
    const min = Math.min(...ok.map((o) => o.priceUSD));
    const avg = ok.reduce((s, o) => s + o.priceUSD, 0) / ok.length;
    supplierSpreadUSD += avg - min;
  }
  if (supplierSpreadUSD > 1) {
    savings.push({
      lever: 'Supplier competition',
      savingUSD: round(supplierSpreadUSD),
      how: 'Every component priced across competing verified suppliers; the floor won.',
      basis: liveFlights ? 'verified' : 'estimated',
    });
  }

  // ---- 4. Negotiated net rates: agent accounts vs public prices -----------
  const negotiatedUSD = Object.values(scan).flat()
    .filter((o) => o && o.agent && o.publicPriceUSD > o.priceUSD)
    .reduce((s, o) => s + (o.publicPriceUSD - o.priceUSD), 0);
  if (negotiatedUSD > 1) {
    savings.push({
      lever: 'Negotiated net rates',
      savingUSD: round(negotiatedUSD),
      how: 'Booked on 3JN agent accounts below public prices.',
      basis: 'verified',
    });
  }

  // ---- 5. Hotel swap: same star rating, lower price ------------------------
  // The AI Travel CFO's "Stay in Hotel B — same rating — save £X" advice.
  const hotelPool = (scan.hotel || []).filter((o) => o.verified && o.reliabilityScore >= 70);
  if (hotelPool.length >= 2) {
    const byStars = new Map();
    for (const h of hotelPool) {
      const k = h.stars || 0;
      if (!byStars.has(k)) byStars.set(k, []);
      byStars.get(k).push(h);
    }
    let bestSwap = null;
    for (const [stars, list] of byStars) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((a, b) => a.priceUSD - b.priceUSD);
      const diff = sorted[sorted.length - 1].priceUSD - sorted[0].priceUSD;
      if (diff > 1 && (!bestSwap || diff > bestSwap.savingUSD)) {
        bestSwap = {
          savingUSD: round(diff),
          how: `Stay at ${sorted[0].supplier} instead of ${sorted[sorted.length - 1].supplier} — same ${stars}★ rating.`,
          apply: { hotel: sorted[0].supplier },
        };
      }
    }
    if (bestSwap) savings.push({ lever: 'Hotel swap (same rating)', ...bestSwap });
  }

  // ---- Unbeatable-price verdict --------------------------------------------
  // Our reliable floor total vs what the same basket lists at publicly.
  let ourTotalUSD = 0;
  let publicTotalUSD = 0;
  for (const offers of Object.values(scan)) {
    const f = floorOf(offers || []);
    if (f == null) continue;
    ourTotalUSD += f;
    const cheapest = (offers || []).filter((o) => o.verified && o.reliabilityScore >= 70)
      .sort((a, b) => a.priceUSD - b.priceUSD)[0];
    publicTotalUSD += (cheapest && cheapest.publicPriceUSD) || f;
  }
  const marginPct = publicTotalUSD > 0 ? Math.round(((publicTotalUSD - ourTotalUSD) / publicTotalUSD) * 1000) / 10 : 0;

  const anyIndicative = savings.some((x) => x.basis === 'indicative' || x.basis === 'estimated');
  return {
    leversChecked: 4,
    combinationsExplored,
    savings,
    // How to read the numbers: with live fares on, alternative-date/airport
    // savings are INDICATIVE (re-search to confirm the exact live fare); the
    // supplier/negotiated levers reflect the fares actually compared.
    basis: liveFlights ? (anyIndicative ? 'mixed' : 'verified') : 'indicative',
    indicativeNote: anyIndicative ? 'Alternative-date and alternative-airport savings are indicative — tap Re-search to confirm the exact live fare before booking. You are only ever charged a confirmed bookable price.' : null,
    totalIdentifiedUSD: round(savings.reduce((s, x) => s + x.savingUSD, 0)),
    unbeatable: {
      ourFloorUSD: round(ourTotalUSD),
      publicFloorUSD: round(publicTotalUSD),
      marginPct,
      verdict: marginPct > 0
        ? `Priced ${marginPct}% under the public floor for the same verified basket.`
        : 'Matched to the verified market floor — no cheaper reliable combination found.',
    },
  };
}

// ---- Fare Prediction Agent ---------------------------------------------------
// Pre-booking price-direction forecast: scans the fare curve around the chosen
// departure (±5 days) and reads demand pressure into a book-now / wait signal.
// Deterministic (seeded scans) — the same trip always predicts the same way.
export function farePrediction({ intent, dest, origin }) {
  if (!intent?.dates?.checkIn) return null;
  const base = floorOf(scanFlights(intent, dest, origin));
  if (base == null) return null;
  const ahead = [];
  for (const days of [1, 2, 3, 4, 5]) {
    const f = floorOf(scanFlights(shiftDates(intent, days), dest, origin));
    if (f != null) ahead.push(f);
  }
  if (!ahead.length) return null;
  const avgAhead = ahead.reduce((s, x) => s + x, 0) / ahead.length;
  const driftPct = Math.round(((avgAhead - base) / base) * 1000) / 10;
  const direction = driftPct > 2 ? 'rising' : driftPct < -2 ? 'falling' : 'stable';
  return {
    agent: 'Fare Prediction Agent',
    currentFloorUSD: base,
    forecastFloorUSD: round(avgAhead),
    driftPct,
    direction,
    advice: direction === 'rising'
      ? `Book now — fares around your dates trend ${driftPct}% higher.`
      : direction === 'falling'
        ? `Waiting may pay: nearby departures trend ${Math.abs(driftPct)}% lower. The Price Guard protects you either way.`
        : 'Fares are stable around your dates — book when ready; the Price Guard covers you after.',
  };
}
