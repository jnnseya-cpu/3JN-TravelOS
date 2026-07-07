// Orchestrator — runs the full pipeline the brief describes, end to end:
//   understand intent -> detect context -> gate the search -> scan suppliers ->
//   compare & filter to reliable/verified -> build tiered packages -> recommend.
//
// This never throws on malformed input: if the destination can't be resolved it
// returns clarifying questions instead of crashing (directly solving the
// "Console Error: {}" class of failures from the previous build).

import { parseIntent } from './intent.js';
import { findDestination, originForCountry, resolveOrigin } from './destinations.js';
import { scanAll } from './suppliers.js';
import { deepPriceDive } from './price-dive.js';
import { buildPackages, clarifyingQuestions } from './packager.js';
import { costProtectionGate, SEARCH_TIERS } from './revenue.js';
import { route } from './ai-gateway.js';
import { approvalProbability } from './visaos.js';

// Maps a "what do you need?" answer to the components we'll actually search.
const NEED_MAP = {
  'Flights + hotel': ['flights', 'hotel'],
  'Flights only': ['flights'],
  'Hotel only': ['hotel'],
  Train: ['train'],
  Coach: ['coach'],
  Cruise: ['cruise'],
  Ferry: ['ferry'],
  'Full holiday package': ['flights', 'hotel', 'activities', 'transfer', 'esim'],
};

export function plan({ text, context, user, searchTier = 'smart', overrides = {}, preferences = {}, live = null }) {
  const intent = parseIntent(text, context, new Date(Date.UTC(2026, 5, 30)));

  // Flight preferences: explicit toggles win, else inferred from the request text.
  const win = ['morning', 'afternoon', 'evening', 'night'].find((w) => new RegExp(`\\b${w}\\b`, 'i').test(text || ''));
  intent.flightPrefs = {
    directOnly: preferences.directOnly != null ? !!preferences.directOnly : /\b(direct|non.?stop)\b/i.test(text || ''),
    departureWindow: preferences.departureWindow || win || null,
  };

  // Apply any answers the user gave to clarifying questions.
  if (overrides.destination && !intent.destination) {
    intent.destination = findDestination(overrides.destination);
    if (intent.destination) intent.unresolved = intent.unresolved.filter((u) => u !== 'destination');
  }
  if (overrides.month) intent.month = overrides.month;
  // Answer to the "what do you need?" question (plain-English → components).
  if (overrides.need && NEED_MAP[overrides.need]) {
    intent.components = [...NEED_MAP[overrides.need]];
    intent.needComponents = false;
  }

  // If we still can't resolve the destination, ask rather than fail.
  const questions = clarifyingQuestions(intent);
  if (!intent.destination) {
    return { stage: 'clarify', intent, questions, context };
  }

  // Destination is known but the traveller didn't say WHAT they want. Honour the
  // plain-English promise: ask, don't assume flights/hotel.
  if ((!intent.components || intent.components.length === 0) && intent.needComponents) {
    return {
      stage: 'clarify',
      intent,
      questions: [{
        id: 'need',
        question: `What would you like for ${intent.destination.city}?`,
        options: ['Flights + hotel', 'Flights only', 'Hotel only', 'Train', 'Coach', 'Cruise', 'Full holiday package'],
      }],
      context,
    };
  }

  // Estimate expected booking value (for the cost-protection gate) from a rough
  // pre-scan of the cheapest combination.
  // Departure: the user's stated city if given, else inferred from nationality.
  const origin = (intent.originCity && resolveOrigin(intent.originCity)) || originForCountry(intent.nationality);
  origin.inferred = !intent.originCity;
  // Mixed-mode / split-origin legs: resolve each direction's own departure /
  // arrival point (airport, station or port city). Outbound defaults to the
  // stated origin; the return may come back into a different place entirely.
  if (intent.legs) {
    const backOrigin = (intent.legs.back.to && resolveOrigin(intent.legs.back.to)) || origin;
    intent.legs.resolved = { out: origin, back: backOrigin };
  }
  // Multi-origin group: resolve each party's own departure city — every party
  // flies from its own airport, everyone shares the stay, dates and booking.
  if (intent.groupOrigins) {
    intent.groupOrigins.resolved = intent.groupOrigins.parties.map((p) => ({
      count: p.count,
      origin: resolveOrigin(p.city) || origin,
    }));
  }
  const scan = scanAll(intent, intent.destination, origin, live);
  const expectedBookingUSD = roughTotal(scan);

  // International = the journey crosses a border. Domestic only when we KNOW both
  // ends' countries and they match (otherwise assume international — safer). This
  // decides whether a passport/visa is needed at booking (a local train is not).
  const international = !(origin.country && intent.destination.country && origin.country === intent.destination.country);

  // Is this an actual journey (transport/stay) or just a utility/add-on (e.g. an
  // eSIM)? A standalone eSIM purchase shouldn't show a flight route or visa.
  const JOURNEY_COMPONENTS = ['flights', 'train', 'coach', 'cruise', 'ferry', 'hotel'];
  const journey = intent.components.some((c) => JOURNEY_COMPONENTS.includes(c));

  // Provenance, read from the actual offers used. Price-live = a real fare
  // (Duffel/Amadeus); schedule-live = a real operated schedule (OAG) priced by
  // the estimator. Flights can be schedule-live but price-estimated.
  const flightOffers = scan.flights || [];
  const hotelOffers = scan.hotel || [];
  const priceSource = {
    flights: flightOffers.some((f) => f.live) ? 'live' : 'estimated',
    hotel: hotelOffers.some((h) => h.live) ? 'live' : 'estimated',
  };
  const scheduleSource = {
    flights: flightOffers.some((f) => f.live || f.scheduleLive) ? 'live' : 'estimated',
  };

  // Cost-protection gate (ACPE).
  const gate = costProtectionGate({
    tier: searchTier,
    user,
    subscriptionActive: !!(user && user.subscriptionActive),
    expectedBookingUSD,
  });

  const effectiveTier = gate.allowed ? searchTier : (gate.downgradeTo || 'free');

  // Deep Price Dive — the deep-thinking pass on EVERY funded search. It digs
  // across date shifts, alternative airports, supplier spread and negotiated
  // net rates, quantifying each saving. Deterministic local compute: costs no
  // external AI spend, so the ACPE gate is never violated. Downgraded (cached)
  // searches skip it — depth is part of what funding buys.
  const priceDive = gate.allowed && journey
    ? deepPriceDive({ intent, dest: intent.destination, origin, scan })
    : null;

  // Build packages (the scan already ran; gate decides depth/labelling).
  const currency = context.currency;
  const points = user ? user.points : 0;
  const packages = buildPackages(scan, intent, currency, points);

  // Was "direct only" honoured? (false when the route has no non-stop option.)
  const recFlight = (packages.options[0]?.components || []).find((c) => c.type === 'flight');
  const chosenDirect = recFlight ? (recFlight.details.outbound.stops || 0) === 0 && (recFlight.details.inbound.stops || 0) === 0 : false;

  return {
    stage: 'options',
    intent: publicIntent(intent),
    origin: { airport: origin.airport, city: origin.city, inferred: !!origin.inferred, approxCode: !!origin.approxCode },
    recommendedDestination: intent.recommendedDestination || null,
    flightPrefs: { ...intent.flightPrefs, directUnavailable: intent.flightPrefs.directOnly && !chosenDirect },
    priceSource,
    scheduleSource,
    international,
    journey,
    context,
    gate: {
      requestedTier: searchTier,
      effectiveTier,
      tierName: SEARCH_TIERS[effectiveTier]?.name,
      allowed: gate.allowed,
      reason: gate.reason,
      aiCostUSD: gate.aiCostUSD,
      requirement: gate.requirement || null,
    },
    scanSummary: summariseScan(scan),
    priceDive,
    // 3JN VisaOS: pre-booking visa approval probability — only for an actual
    // international journey. A local trip or a utility purchase (eSIM) needs none.
    visa: (international && journey) ? approvalProbability(intent.nationality, intent.destination.city) : { ok: false, domestic: !international, utility: !journey },
    // Which AI provider the gateway routes intent extraction to (Claude by
    // default; OpenAI/Gemini for other tasks). Runs locally when no key is set.
    aiRouting: route('intentExtraction'),
    packages,
    questions: [], // none outstanding
  };
}

function roughTotal(scan) {
  let total = 0;
  for (const offers of Object.values(scan)) {
    if (!offers.length) continue;
    if (offers[0].type === 'activity') {
      total += offers.reduce((s, o) => s + o.priceUSD, 0);
    } else {
      total += Math.min(...offers.map((o) => o.priceUSD));
    }
  }
  return Math.round(total);
}

function summariseScan(scan) {
  const out = {};
  for (const [k, offers] of Object.entries(scan)) {
    out[k] = {
      scanned: offers.length,
      verified: offers.filter((o) => o.verified).length,
      reliable: offers.filter((o) => o.reliabilityScore >= 70).length,
      cheapestUSD: Math.min(...offers.map((o) => o.priceUSD)),
    };
  }
  return out;
}

function publicIntent(intent) {
  return {
    destination: { code: intent.destination.code, city: intent.destination.city, country: intent.destination.country, countryName: intent.destination.countryName },
    travellers: intent.travellers,
    nights: intent.nights,
    month: intent.month,
    dates: intent.dates,
    components: intent.components,
    wantsInstalments: intent.wantsInstalments,
    priority: intent.priority,
    nationality: intent.nationality,
    hotelArea: intent.hotelArea || null,
    legs: intent.legs ? {
      out: { mode: intent.legs.out.mode, from: intent.legs.resolved?.out?.city || null },
      back: { mode: intent.legs.back.mode, to: intent.legs.resolved?.back?.city || null },
    } : null,
    groupOrigins: intent.groupOrigins ? intent.groupOrigins.parties.map((p, i) => ({
      count: p.count,
      city: intent.groupOrigins.resolved?.[i]?.origin?.city || p.city,
    })) : null,
  };
}
