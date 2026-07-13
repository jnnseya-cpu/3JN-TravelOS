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

// British date for customer-facing lever text: 2028-08-23 → 23/08/2028.
function ukd(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso == null ? '' : iso));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso == null ? '' : iso);
}

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
// TRUTH RULE: a saving may only be labelled "verified" when it is computed from
// REAL live supplier data. On the deterministic estimator (no live feed) every
// number is an ILLUSTRATIVE ESTIMATE — we never assert it as a booked fact, and
// we never name a real competitor as overpriced against a price we synthesised.
export function deepPriceDive({ intent, dest, origin, scan, liveFlights = false, liveHotels = false }) {
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
        how: `Depart ${best.days > 0 ? '+' : ''}${best.days} day${Math.abs(best.days) > 1 ? 's' : ''} (${ukd(best.checkIn)}) and the same flights drop.`,
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
  // Verified ONLY when every component compared is live inventory. On the
  // estimator the spread is between synthesised prices, so it's an estimate and
  // the wording must not assert it as a booked comparison.
  let supplierSpreadUSD = 0;
  let spreadAllLive = true;
  for (const offers of Object.values(scan)) {
    if (!offers || offers.length < 2) continue;
    const ok = offers.filter((o) => o.verified && o.reliabilityScore >= 70);
    if (ok.length < 2) continue;
    if (!ok.every((o) => o.live)) spreadAllLive = false;
    const min = Math.min(...ok.map((o) => o.priceUSD));
    const avg = ok.reduce((s, o) => s + o.priceUSD, 0) / ok.length;
    supplierSpreadUSD += avg - min;
  }
  if (supplierSpreadUSD > 1) {
    const verified = spreadAllLive;
    savings.push({
      lever: 'Supplier competition',
      savingUSD: round(supplierSpreadUSD),
      how: verified
        ? 'Every component priced across competing verified suppliers; the floor won.'
        : 'Estimate: each component compared across competing suppliers so the lowest reliable price wins — confirmed against live inventory before you book.',
      basis: verified ? 'verified' : 'estimated',
    });
  }

  // ---- 4. Negotiated net rates: agent accounts vs public prices -----------
  // We only claim a negotiated net rate when the offer is LIVE and actually
  // carries a real public price to beat. On the estimator there is no real
  // agent booking, so we make NO such claim (it would be untrue).
  const negotiatedUSD = Object.values(scan).flat()
    .filter((o) => o && o.live && o.agent && o.publicPriceUSD > o.priceUSD)
    .reduce((s, o) => s + (o.publicPriceUSD - o.priceUSD), 0);
  if (negotiatedUSD > 1) {
    savings.push({
      lever: 'Negotiated net rates',
      savingUSD: round(negotiatedUSD),
      how: 'A 3JN partner net rate came in below the public price for this component.',
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
      const cheaper = sorted[0];
      const dearer = sorted[sorted.length - 1];
      const diff = dearer.priceUSD - cheaper.priceUSD;
      if (diff > 1 && (!bestSwap || diff > bestSwap.savingUSD)) {
        // Only name the dearer property (often a real brand) when the prices are
        // LIVE. On the estimator we describe it generically — asserting a named
        // competitor is overpriced against a synthesised price would be untrue.
        const dearerLabel = liveHotels ? dearer.supplier : `a higher-priced ${stars}★ stay`;
        bestSwap = {
          savingUSD: round(diff),
          how: liveHotels
            ? `Stay at ${cheaper.supplier} instead of ${dearerLabel} — same ${stars}★ rating.`
            : `Estimate: ${cheaper.supplier} comes in below ${dearerLabel} at the same ${stars}★ rating — confirmed live before you book.`,
          apply: { hotel: cheaper.supplier },
          basis: liveHotels ? 'verified' : 'estimated',
        };
      }
    }
    if (bestSwap) savings.push({ lever: 'Hotel swap (same rating)', ...bestSwap });
  }

  // ---- Unbeatable-price verdict --------------------------------------------
  // Our reliable floor total vs what the same basket lists at publicly. The
  // verdict is only stated as fact when the whole basket is LIVE; otherwise it
  // is an estimate (the public reference is synthesised, not a real quote).
  let ourTotalUSD = 0;
  let publicTotalUSD = 0;
  let basketAllLive = true;
  let sawFloor = false;
  for (const offers of Object.values(scan)) {
    const f = floorOf(offers || []);
    if (f == null) continue;
    sawFloor = true;
    ourTotalUSD += f;
    const cheapest = (offers || []).filter((o) => o.verified && o.reliabilityScore >= 70)
      .sort((a, b) => a.priceUSD - b.priceUSD)[0];
    if (!cheapest || !cheapest.live) basketAllLive = false;
    publicTotalUSD += (cheapest && cheapest.publicPriceUSD) || f;
  }
  if (!sawFloor) basketAllLive = false;
  const marginPct = publicTotalUSD > 0 ? Math.round(((publicTotalUSD - ourTotalUSD) / publicTotalUSD) * 1000) / 10 : 0;

  // DROP TRIVIAL LEVERS: a "save £1 / save £2" line reads as noise and makes the
  // whole dive look unserious. Only surface a lever whose saving is actually
  // worth acting on (≳ $8 ≈ £6). If nothing meaningful remains we honestly say so.
  for (let i = savings.length - 1; i >= 0; i--) {
    if (!(savings[i].savingUSD >= 8)) savings.splice(i, 1);
  }

  // SANITY CAP: an illustrative saving must never exceed what the trip costs —
  // "save £2,170" on a £1,786 trip is obviously broken and destroys trust. Cap
  // the TOTAL identified savings at 40% of the reliable floor and scale every
  // lever PROPORTIONALLY, so their relative sizes are preserved (never two
  // different levers flattened to the same figure).
  if (ourTotalUSD > 0 && savings.length) {
    const totalMax = Math.round(ourTotalUSD * 0.40);
    const sum = savings.reduce((a, s) => a + s.savingUSD, 0);
    if (sum > totalMax && sum > 0) {
      const scale = totalMax / sum;
      for (const s of savings) s.savingUSD = Math.round(s.savingUSD * scale);
    }
  }

  const verdict = marginPct > 0
    ? (basketAllLive
      ? `Priced ${marginPct}% under the public floor for the same verified basket.`
      : `Estimate: around ${marginPct}% under a typical public price for the same basket — confirmed against live inventory before you book.`)
    : (basketAllLive
      ? 'Matched to the verified market floor — no cheaper reliable combination found.'
      : 'Estimate: matched to the typical market floor — no cheaper reliable combination found.');

  const anyIndicative = savings.some((x) => x.basis === 'indicative' || x.basis === 'estimated');
  const anyVerified = savings.some((x) => x.basis === 'verified') || basketAllLive;
  // Truthful top-level basis: verified only when nothing is an estimate; mixed
  // when it's a blend; estimated when the whole dive is illustrative.
  const topBasis = !anyIndicative && anyVerified ? 'verified' : (anyVerified ? 'mixed' : 'estimated');
  const estimatedOnly = !anyVerified;
  return {
    leversChecked: 4,
    combinationsExplored,
    savings,
    liveBasket: basketAllLive,
    // How to read the numbers. Estimator mode: every figure is illustrative and
    // confirmed against live inventory before any payment. Live mode: alternative
    // date/airport savings are indicative (re-search to confirm the exact fare).
    basis: topBasis,
    indicativeNote: estimatedOnly
      ? 'These savings are illustrative estimates from our pricing model — every price is confirmed against live inventory before you pay, and you are only ever charged a real, bookable amount.'
      : (anyIndicative ? 'Alternative-date and alternative-airport savings are indicative — tap Re-search to confirm the exact live fare before booking. You are only ever charged a confirmed bookable price.' : null),
    totalIdentifiedUSD: round(savings.reduce((s, x) => s + x.savingUSD, 0)),
    unbeatable: {
      ourFloorUSD: round(ourTotalUSD),
      publicFloorUSD: round(publicTotalUSD),
      marginPct,
      live: basketAllLive,
      verdict,
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
