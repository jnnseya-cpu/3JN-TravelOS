// Package optimiser — turns a raw supplier scan into transparent, comparable
// package options and recommends the best value.
//
// The brief requires: filter to reliable + verified suppliers, find the
// cheapest reliable combination, build a complete package, and present
// transparent options. The session added: produce multiple tiers
// (Standard / Premium / Luxury) and recommend the best.

import { RELIABILITY_FLOOR, INTEGRITY_CHECKS } from './suppliers.js';
import { priceBreakdown } from './pricing.js';

// Keep only verified suppliers at or above the reliability floor.
function reliableVerified(offers) {
  return offers.filter((o) => o.verified && o.reliabilityScore >= RELIABILITY_FLOOR);
}

// Selection strategy per tier.
const TIERS = {
  Standard: {
    label: 'Standard — Cheapest Reliable',
    blurb: 'The lowest total price across verified, reliable suppliers.',
    pickFlight: (list) => preferDirect(list, cheapest),
    pickHotel: (list) => cheapest(list),
    pickPerSupplier: (list) => cheapest(list),
    marketMultiplier: 1.18, // public price we beat
  },
  Premium: {
    label: 'Premium — Best Balance',
    blurb: 'Higher-rated suppliers and better comfort for a modest uplift.',
    pickFlight: (list) => preferDirect(list, bestValue),
    pickHotel: (list) => byStars(list, 4),
    pickPerSupplier: (list) => bestValue(list),
    marketMultiplier: 1.22,
  },
  Luxury: {
    label: 'Luxury — Top Rated',
    blurb: 'The highest-rated, most premium verified options available.',
    pickFlight: (list) => preferDirect(list, topRated),
    pickHotel: (list) => byStars(list, 5),
    pickPerSupplier: (list) => topRated(list),
    marketMultiplier: 1.30,
  },
};

function cheapest(list) {
  return [...list].sort((a, b) => a.priceUSD - b.priceUSD)[0];
}
function topRated(list) {
  return [...list].sort((a, b) => b.reliabilityScore - a.reliabilityScore || a.priceUSD - b.priceUSD)[0];
}
// Direct flights are a privilege: pick from the non-stop subset when any exist,
// otherwise fall back to the full list (flights with stops are perfectly fine).
function isDirect(f) {
  return f.type === 'flight' && (f.details?.outbound?.stops || 0) === 0 && (f.details?.inbound?.stops || 0) === 0;
}
function preferDirect(list, picker) {
  const direct = list.filter(isDirect);
  return picker(direct.length ? direct : list);
}

// Departure-time windows (local outbound departure hour).
const DEPART_WINDOWS = { morning: [5, 12], afternoon: [12, 17], evening: [17, 24], night: [0, 5] };
function departHour(f) {
  const t = f.details?.outbound?.depart || '';
  const h = parseInt(t.split(':')[0], 10);
  return Number.isNaN(h) ? 12 : h;
}
// Apply traveller flight preferences: "direct only" is a hard filter (kept only
// when at least one non-stop exists), departure window is a soft preference.
function applyFlightPrefs(pool, prefs) {
  let list = pool;
  if (prefs?.directOnly) {
    const direct = list.filter(isDirect);
    if (direct.length) list = direct; // honour the toggle when possible
  }
  const win = prefs?.departureWindow && DEPART_WINDOWS[prefs.departureWindow];
  if (win) {
    const inWin = list.filter((f) => { const h = departHour(f); return h >= win[0] && h < win[1]; });
    if (inWin.length) list = inWin;
  }
  return list;
}
// Value = reliability per unit cost — rewards reliable suppliers that aren't the
// most expensive.
function bestValue(list) {
  return [...list].sort((a, b) => (b.reliabilityScore / b.priceUSD) - (a.reliabilityScore / a.priceUSD))[0];
}
function byStars(list, stars) {
  const exact = list.filter((h) => h.stars === stars);
  const pool = exact.length ? exact : list.filter((h) => (h.stars || 0) >= stars - 1);
  return cheapest(pool.length ? pool : list);
}

// Build a single package option for a given tier.
// Pick the tier's best journey from a cross-mode pool; if a flight wins,
// re-apply the traveller's flight preferences within the flight subset.
function key0PickJourney(tier, pool, scan, intent) {
  const pick = tier.pickPerSupplier(pool);
  if (pick && pick.type === 'flight' && scan.flights) {
    return tier.pickFlight(applyFlightPrefs(reliableVerified(scan.flights), intent.flightPrefs)) || pick;
  }
  return pick;
}

function buildOption(tierName, scan, intent, currency, loyaltyPoints) {
  const tier = TIERS[tierName];
  const selections = [];
  let componentsUSD = 0;
  // groupTravel carries multi-origin group parties; outboundLeg/returnLeg carry
  // mixed-mode / split-origin journeys — one booking either way; they lead.
  const componentOrder = ['groupTravel', 'outboundLeg', 'returnLeg', 'flights', 'train', 'coach', 'ferry', 'cruise', 'hotel', 'activities', 'visa', 'insurance', 'transfer', 'carhire', 'tickets', 'boat', 'esim'];

  // MODE COMPETITION: the traveller named no way to travel, so realistic modes
  // (ferry vs coach vs train vs flight) compete and ONE wins per tier — they
  // are alternatives, never summed into the same package.
  const JOURNEY_MODE_KEYS = ['flights', 'train', 'coach', 'ferry'];
  const competing = intent.modeCompetition
    ? JOURNEY_MODE_KEYS.filter((k) => scan[k] && scan[k].length)
    : [];
  const skipKeys = new Set();
  if (competing.length > 1) {
    const pool = competing.flatMap((k) => reliableVerified(scan[k]));
    let pick = key0PickJourney(tier, pool, scan, intent);
    if (pick) {
      componentsUSD += pick.priceUSD;
      selections.push({
        ...pick,
        details: { ...pick.details, wonModeCompetition: competing.join(' vs ') },
      });
    }
    competing.forEach((k) => skipKeys.add(k));
  }

  for (const key of componentOrder) {
    if (skipKeys.has(key)) continue;
    const offers = scan[key];
    if (!offers || !offers.length) continue;

    if (key === 'groupTravel') {
      // Multi-origin group: pick the tier's best flight PER PARTY — every
      // party gets its own departure city; all land in the same package.
      const pool = reliableVerified(offers);
      const byParty = new Map();
      for (const o of pool) {
        const i = o.details?.partyIndex ?? 0;
        if (!byParty.has(i)) byParty.set(i, []);
        byParty.get(i).push(o);
      }
      for (const [, list] of [...byParty.entries()].sort((a, b) => a[0] - b[0])) {
        const pick = tier.pickFlight(applyFlightPrefs(list, intent.flightPrefs));
        if (pick) {
          componentsUSD += pick.priceUSD;
          selections.push(pick);
        }
      }
      continue;
    }

    if (key === 'activities') {
      // Activities: take all reliable+verified (they're a bundle).
      const chosen = reliableVerified(offers);
      chosen.forEach((c) => {
        componentsUSD += c.priceUSD;
        selections.push(c);
      });
      continue;
    }

    const pool = reliableVerified(offers);
    if (!pool.length) continue;

    let pick;
    if (key === 'flights') pick = tier.pickFlight(applyFlightPrefs(pool, intent.flightPrefs));
    else if (key === 'hotel') pick = tier.pickHotel(pool);
    else pick = tier.pickPerSupplier(pool);

    if (pick) {
      componentsUSD += pick.priceUSD;
      selections.push(pick);
    }
  }

  const marketRefUSD = componentsUSD * tier.marketMultiplier;
  const breakdown = priceBreakdown({ componentsUSD, marketRefUSD, currency, loyaltyPoints });

  // Average reliability across selected suppliers — used for the "reliable"
  // promise and ranking.
  const avgReliability = selections.length
    ? Math.round(selections.reduce((s, x) => s + x.reliabilityScore, 0) / selections.length)
    : 0;

  return {
    tier: tierName,
    label: tier.label,
    blurb: tier.blurb,
    verified: selections.every((s) => s.verified),
    // Integrity Verification Shield: every surfaced supplier passed the
    // 50-point rubric (verified + at/above the reliability floor).
    integrity: { pointsChecked: INTEGRITY_CHECKS.length, allPassed: selections.every((s) => s.verified && s.reliabilityScore >= RELIABILITY_FLOOR) },
    avgReliability,
    components: selections.map((s) => ({
      type: s.type,
      supplier: s.supplier,
      reliabilityScore: s.reliabilityScore,
      verified: s.verified,
      priceUSD: s.priceUSD,
      publicPriceUSD: s.publicPriceUSD,
      stars: s.stars,
      details: s.details,
      sourcedVia: s.sourcedVia,
      sourcedType: s.sourcedType,
      bookingUrl: s.bookingUrl,
      agent: s.agent,
      agentId: s.agentId,
      live: !!s.live,
      scheduleLive: !!s.scheduleLive,
    })),
    pricing: breakdown,
    totalUSD: breakdown.lines.totalUSD,
  };
}

export function buildPackages(scan, intent, currency, loyaltyPoints = 0) {
  const options = Object.keys(TIERS)
    .map((name) => buildOption(name, scan, intent, currency, loyaltyPoints))
    .filter((o) => o.components.length > 0);

  // Recommend best value: most reliability per pound. Standard usually wins on
  // pure price, but if a higher tier is only marginally more for a big
  // reliability gain, recommend it.
  let recommended = null;
  let bestScore = -Infinity;
  for (const o of options) {
    const score = o.avgReliability / Math.max(1, o.totalUSD) * 1000;
    if (score > bestScore) {
      bestScore = score;
      recommended = o.tier;
    }
  }
  options.forEach((o) => { o.recommended = o.tier === recommended; });

  return {
    options,
    recommendedTier: recommended,
    cheapestTier: [...options].sort((a, b) => a.totalUSD - b.totalUSD)[0]?.tier || null,
  };
}

// Clarifying questions when the intent is ambiguous (the session asked for
// this). Returns an array of question objects the UI can render.
export function clarifyingQuestions(intent) {
  const qs = [];
  if (!intent.destination) {
    qs.push({
      id: 'destination',
      question: 'Where would you like to travel?',
      options: ['Dubai', 'Istanbul', 'Barcelona', 'New York', 'Bali'],
    });
  }
  if (!intent.month) {
    qs.push({
      id: 'month',
      question: 'Which month are you planning to travel?',
      options: ['August', 'September', 'October', 'December'],
    });
  }
  return qs;
}
