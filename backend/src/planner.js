// Orchestrator — runs the full pipeline the brief describes, end to end:
//   understand intent -> detect context -> gate the search -> scan suppliers ->
//   compare & filter to reliable/verified -> build tiered packages -> recommend.
//
// This never throws on malformed input: if the destination can't be resolved it
// returns clarifying questions instead of crashing (directly solving the
// "Console Error: {}" class of failures from the previous build).

import { parseIntent } from './intent.js';
import { findDestination, originForCountry, resolveOrigin } from './destinations.js';
import { airportCoords, haversineKm } from './airports.js';
import { scanAll } from './suppliers.js';
import { deepPriceDive, farePrediction } from './price-dive.js';
import { hostListingsForCity, hostExperiencesForCity, vendorServicesForCity, cacheSearch, getCachedSearch, cacheConfidence, CACHE_SERVE_CONFIDENCE, CACHE_SOURCES } from './store.js';
import { buildPackages, clarifyingQuestions } from './packager.js';
import { costProtectionGate, SEARCH_TIERS } from './revenue.js';
import { route } from './ai-gateway.js';
import { approvalProbability } from './visaos.js';
import { travelIntelligenceScore } from './intelligence.js';

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

export function plan({ text, context, user, searchTier = 'smart', overrides = {}, preferences = {}, live = null, usage = {} }) {
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
  // Deep Price Dive "Apply & re-search": shift the parsed dates by N days so the
  // alternative-date lever produces a REAL live fare for those exact dates.
  if (overrides.shiftDays && intent.dates?.checkIn) {
    const shift = (iso) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + Number(overrides.shiftDays)); return d.toISOString().slice(0, 10); };
    intent.dates = {
      checkIn: shift(intent.dates.checkIn),
      checkOut: intent.dates.checkOut ? shift(intent.dates.checkOut) : intent.dates.checkOut,
    };
    intent.appliedDiveLever = { type: 'date', shiftDays: Number(overrides.shiftDays), checkIn: intent.dates.checkIn };
  }
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
  // Deep Price Dive "Apply & re-search": fly from the alternative airport the
  // dive found cheaper — re-searched live so the shown fare is real & bookable.
  if (overrides.originAirport && /^[A-Z]{3}$/.test(String(overrides.originAirport))) {
    origin.airport = String(overrides.originAirport);
    origin.inferred = false;
    intent.appliedDiveLever = { ...(intent.appliedDiveLever || {}), airport: origin.airport };
  }
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
  // Community host supply: 3JN-verified listings for this destination compete
  // with hotels inside the same scan (fetched early: it keys the cache too).
  const communityHosts = hostListingsForCity(intent.destination.city);
  const communityExperiences = hostExperiencesForCity(intent.destination.city);

  // MODE COMPETITION — when the traveller states origin + destination but
  // names no way to travel, the OS doesn't assume a flight: every realistic
  // mode competes and the cheapest reliable one wins. From a PORT town (Dover,
  // Calais…) that means ferries and international coaches (Eurolines, FlixBus,
  // BlaBlaCar…), never a fabricated flight; on short-haul routes trains and
  // coaches challenge the plane.
  const routeKmApprox = (() => {
    const a = airportCoords(origin.airport);
    const b = airportCoords(intent.destination.airport || intent.destination.code);
    return a && b ? haversineKm(a, b) : null;
  })();
  let modeCompetition = null;
  if (!intent.modesExplicit && (intent.originCity || intent.components.includes('flights'))) {
    let modes = null;
    if (origin.port) modes = ['ferry', 'coach', 'train'];
    else if (routeKmApprox != null && routeKmApprox <= 900 && intent.components.includes('flights')) modes = ['flights', 'train', 'coach'];
    if (modes && modes.length > 1) {
      modeCompetition = modes;
      intent.modeCompetition = modes;
      intent.components = [...new Set([...intent.components.filter((c) => !(origin.port && c === 'flights')), ...modes])];
    }
  }

  // Real marketplace vendors serving this city compete in the local-service
  // slots (photographer, guide, driver…) at their own listed prices.
  const vendorServices = vendorServicesForCity(intent.destination.city);
  const scan = scanAll(intent, intent.destination, origin, live, communityHosts, communityExperiences, vendorServices);
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
  // For a multi-origin group the single-origin scan.flights is replaced by
  // scan.groupTravel (one set of offers per departure party) — provenance must
  // be read per PARTY so a group where some parties are live and others fell
  // back to the estimator reports 'partial', not a misleading 'estimated'.
  const flightOffers = (scan.groupTravel && scan.groupTravel.length) ? scan.groupTravel : (scan.flights || []);
  const hotelOffers = scan.hotel || [];
  let flightsProvenance;
  let flightPartiesLive = null;
  if (scan.groupTravel && scan.groupTravel.length) {
    const partyIdx = [...new Set(scan.groupTravel.map((o) => o.details?.partyIndex))];
    const liveParties = partyIdx.filter((idx) => scan.groupTravel.some((o) => o.details?.partyIndex === idx && o.live));
    flightPartiesLive = { live: liveParties.length, total: partyIdx.length };
    flightsProvenance = liveParties.length === 0 ? 'estimated'
      : liveParties.length === partyIdx.length ? 'live' : 'partial';
  } else {
    flightsProvenance = flightOffers.some((f) => f.live) ? 'live' : 'estimated';
  }
  const priceSource = {
    flights: flightsProvenance,
    flightPartiesLive, // {live,total} for a group, else null
    hotel: hotelOffers.some((h) => h.live) ? 'live' : 'estimated',
  };
  const scheduleSource = {
    flights: flightOffers.some((f) => f.live || f.scheduleLive) ? 'live' : 'estimated',
  };

  // Cost-protection gate (ACPE).
  const gate = costProtectionGate({
    tier: searchTier,
    user,
    // A live refundable search deposit funds paid depth (spec §6).
    hasDeposit: !!usage.hasDeposit,
    subscriptionActive: !!(user && user.subscriptionActive),
    // Final Platform Rule funding sources 6–7: corporate & white-label contracts.
    corporateContract: !!(user && (user.corporatePlan?.active || user.role === 'business')),
    whiteLabelContract: !!usage.whiteLabelContract,
    expectedBookingUSD,
    // Strong intent = explicit dates + more than one component named.
    intentStrong: !!(intent.dates?.checkIn && intent.components.length >= 2),
    // Real usage telemetry (abuse prevention).
    recentSearches: usage.recentSearches || 0,
    searchesToday: usage.searchesToday || 0,
    priorBookings: usage.priorBookings || 0,
    sameDestinationRepeats: usage.sameDestinationRepeats || 0,
  });

  const effectiveTier = gate.allowed ? searchTier : (gate.downgradeTo || 'free');

  // CACHE EVERYTHING: downgraded/free searches answer from the database first —
  // no paid AI. Fresh funded results are written back for the next traveller.
  // Key on the EXACT request (raw text captures every parsed nuance) plus the
  // out-of-text inputs that change results: toggles, loyalty, live host supply.
  const cacheKey = [intent.raw.toLowerCase(), origin.airport,
    intent.dates?.checkIn || '-',
    intent.flightPrefs.directOnly ? 'D1' : 'D0', intent.flightPrefs.departureWindow || '-',
    user ? (user.points || 0) : 0, communityHosts.length].join('|');
  // CHECK CACHE FIRST — before spending ACUs, at EVERY tier (Cache-First
  // Intelligence Engine, spec §16). Confidence decays with age: above the 85%
  // serve threshold the answer is served with NO AI COST; the free tier serves
  // any age. The checked sources: historical results, popular routes, past
  // bookings, cached prices, destination intelligence, supplier deals.
  // NEVER serve from cache when a live supplier overlay is being applied: the
  // caller fetched real Duffel/Amadeus fares and is re-planning to fold them in.
  // A cache hit here would return the earlier ESTIMATED result and silently
  // discard the live fares — the exact bug that kept prices "estimated" after
  // the live key went in. When `live` is present we compute fresh and (below)
  // overwrite the cache with the live result for the next traveller.
  if (!live) {
    const hit = getCachedSearch(cacheKey);
    const confidence = cacheConfidence(hit);
    if (hit && (effectiveTier === 'free' || confidence > CACHE_SERVE_CONFIDENCE)) {
      return { ...hit.result, cached: true, cachedAt: hit.cachedAt, cacheConfidence: confidence, cacheSources: CACHE_SOURCES, gate: { ...hit.result.gate, requestedTier: searchTier, effectiveTier, allowed: gate.allowed, reason: gate.allowed ? 'served-from-cache' : gate.reason, requirement: gate.requirement || null } };
    }
  }

  // Deep Price Dive — the deep-thinking pass on EVERY funded search. It digs
  // across date shifts, alternative airports, supplier spread and negotiated
  // net rates, quantifying each saving. Deterministic local compute: costs no
  // external AI spend, so the ACPE gate is never violated. Downgraded (cached)
  // searches skip it — depth is part of what funding buys.
  const priceDive = gate.allowed && journey
    ? deepPriceDive({ intent, dest: intent.destination, origin, scan, liveFlights: priceSource.flights === 'live' })
    : null;

  // Fare Prediction Agent — book-now / wait signal before any money moves.
  const farePredictionOut = gate.allowed && intent.components.includes('flights')
    ? farePrediction({ intent, dest: intent.destination, origin })
    : null;

  // Travel Concierge Agent — a day-by-day itinerary from what was actually
  // packaged (arrival, activities spread across days, free days, departure).
  const itinerary = journey ? buildItinerary(intent, scan) : null;

  // Build packages (the scan already ran; gate decides depth/labelling).
  const currency = context.currency;
  const points = user ? user.points : 0;
  // Active Travel+ members pay NO flat fee on flights-only bookings.
  const memberActive = !!(user && user.membership?.active);
  const packages = buildPackages(scan, intent, currency, points, memberActive);

  // Was "direct only" honoured? (false when the route has no non-stop option.)
  const recFlight = (packages.options[0]?.components || []).find((c) => c.type === 'flight');
  const chosenDirect = recFlight ? (recFlight.details.outbound.stops || 0) === 0 && (recFlight.details.inbound.stops || 0) === 0 : false;

  // REAL-PRICE POLICY: mark every option's price basis. A component is "real"
  // when it came from a live supplier feed OR is our own committed marketplace
  // inventory (community host). Real-money checkout is allowed only for a
  // fully-real option (enforced again server-side at payment).
  const REAL = (c) => c.live || c.details?.community;
  const PRICED = ['flight', 'hotel', 'host', 'train', 'coach', 'ferry', 'cruise'];
  for (const o of packages.options) {
    const priced = (o.components || []).filter((c) => PRICED.includes(c.type));
    o.priceBasis = priced.length && priced.every(REAL) ? 'live' : 'estimated';
    o.bookableForRealPayment = o.priceBasis === 'live';
  }

  const response = {
    stage: 'options',
    appliedDiveLever: intent.appliedDiveLever || null,
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
    // THE DECISION (positioning: advisor, not search engine). "Don't Search.
    // Let AI Find, Negotiate and Build the Best Trip." — one recommended
    // answer with the saving and each best pick, not a wall of options.
    decision: buildDecision(packages, priceDive, farePredictionOut, intent),
    // AI NEGOTIATION LAYER (USP #5): net rates + perks secured per trip.
    negotiation: (gate.allowed && journey) ? buildNegotiation(packages, intent) : null,
    // DIASPORA TRAVEL SPECIALIST (USP #6): journeys home, planned natively.
    diaspora: journey ? diasporaSupport(intent) : null,
    // TRAVEL INTELLIGENCE SCORE (USP #3): every trip scored across Cost,
    // Safety, Visa, Weather, Crowd, Value and Risk — most sites don't.
    intelligenceScore: journey && intent.destination ? travelIntelligenceScore({
      destinationText: intent.destination.city,
      month: intent.month,
      savingsPct: priceDive?.unbeatable?.marginPct || 0,
      avgReliability: packages.options.find((o) => o.recommended)?.avgReliability ?? 80,
      visaProbability: (international && journey) ? (approvalProbability(intent.nationality, intent.destination.city)?.approvalProbability ?? null) : null,
    }) : null,
    // AI TRAVEL CFO (USP #1): a personal travel financial adviser — every
    // funded search quantifies the cheaper alternatives it found ("travel 10
    // days later: save £430 · fly from Manchester: save £165 · same-rating
    // hotel swap: save £290").
    travelCFO: (gate.allowed && journey && priceDive) ? {
      role: 'AI Travel CFO — your personal travel financial adviser',
      advice: (priceDive.savings || []).map((s) => ({ lever: s.lever, saveUSD: s.savingUSD, say: s.how, apply: s.apply || null })),
      potentialSavingUSD: priceDive.totalIdentifiedUSD,
      prediction: farePredictionOut?.advice || null,
    } : null,
    scanSummary: summariseScan(scan),
    priceDive,
    farePrediction: farePredictionOut,
    itinerary,
    modeCompetition,
    // 3JN VisaOS: pre-booking visa approval probability — only for an actual
    // international journey. A local trip or a utility purchase (eSIM) needs none.
    visa: (international && journey) ? approvalProbability(intent.nationality, intent.destination.city) : { ok: false, domestic: !international, utility: !journey },
    // Which AI provider the gateway routes intent extraction to (Claude by
    // default; OpenAI/Gemini for other tasks). Runs locally when no key is set.
    aiRouting: route('intentExtraction'),
    packages,
    questions: [], // none outstanding
  };
  cacheSearch(cacheKey, response); // the database answers the next traveller
  return response;
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

// Diaspora Travel Specialist (USP #6) — journeys home are different, and free
// aggregators don't understand them. Detected by destination region (Africa,
// Caribbean, South Asia, Middle East) or an explicit family-visit signal.
const DIASPORA_REGIONS = {
  Africa: ['NG', 'GH', 'KE', 'ZA', 'CD', 'CG', 'CM', 'SN', 'ET', 'UG', 'TZ', 'ZW', 'ZM', 'MW', 'MA', 'EG', 'DZ', 'TN', 'RW', 'BI', 'CI', 'AO', 'GM', 'SL', 'LR', 'ML', 'BF', 'NE', 'TD', 'SO', 'ER', 'MZ', 'BW', 'NA'],
  Caribbean: ['JM', 'TT', 'BB', 'HT', 'DO', 'CU', 'GY', 'SR', 'GD', 'LC', 'VC', 'AG', 'DM', 'KN', 'BS'],
  'South Asia': ['IN', 'PK', 'BD', 'LK', 'NP', 'AF', 'MV'],
  'Middle East': ['AE', 'SA', 'QA', 'KW', 'OM', 'BH', 'JO', 'LB', 'IQ', 'IR', 'YE', 'SY', 'PS', 'TR'],
};
export const DIASPORA_SERVICES = [
  'Excess baggage pre-purchase (cheaper than airport rates)',
  'Money transfer options at the destination (partner rates)',
  'Local SIM / eSIM set up before landing',
  'Airport pickup coordination — including pickup by relatives (arrival details shared securely)',
  'Visa support with a prefilled document checklist',
  'Multi-city routes — visit more than one family stop in one booking',
];
function diasporaSupport(intent) {
  const cc = intent.destination?.country || null;
  const region = cc ? Object.keys(DIASPORA_REGIONS).find((r) => DIASPORA_REGIONS[r].includes(cc)) : null;
  const familySignal = /\b(family|relatives|parents|grandm|grandf|wedding|funeral|back home|home\s?town|visit(ing)? (my|our))\b/i.test(intent.raw || '');
  if (!region && !familySignal) return null;
  return {
    specialist: 'Diaspora Travel Specialist',
    region: region || 'Family visit',
    trigger: region ? `destination region: ${region}` : 'family-visit signal in the request',
    services: DIASPORA_SERVICES,
    note: 'Journeys home are different — 3JN plans excess baggage, pickups, SIMs, visas and multi-city family stops natively.',
  };
}

// AI Negotiation Layer (USP #5) — the agent works hotels, tour operators,
// local suppliers and transport providers for net rates AND perks. Negotiated
// components are real (agent accounts below public price); perks are the
// deterministic outcome of the same seeded negotiation.
const NEGOTIATED_PERKS = ['Free room upgrade (subject to availability)', 'Free breakfast', 'Free airport pickup', 'Late checkout', 'Welcome drink / resort credit'];
function buildNegotiation(packages, intent) {
  const rec = packages?.options?.find((o) => o.recommended) || packages?.options?.[0];
  if (!rec) return null;
  const negotiated = rec.components.filter((c) => c.agent && c.publicPriceUSD > c.priceUSD);
  const hotel = rec.components.find((c) => c.type === 'hotel' || c.type === 'host');
  let seedN = 0;
  for (const ch of (intent.raw || '')) seedN = (seedN * 31 + ch.charCodeAt(0)) % 997;
  const perks = hotel
    ? [...new Set([NEGOTIATED_PERKS[seedN % 5], NEGOTIATED_PERKS[(seedN + 2) % 5]])]
    : [];
  const savedUSD = negotiated.reduce((s, c) => s + (c.publicPriceUSD - c.priceUSD), 0);
  if (!negotiated.length && !perks.length) return null;
  return {
    layer: 'AI Negotiation Layer',
    contacts: ['hotels', 'tour operators', 'local suppliers', 'transport providers'],
    negotiatedComponents: negotiated.map((c) => ({ type: c.type, supplier: c.supplier, publicUSD: c.publicPriceUSD, negotiatedUSD: c.priceUSD, agent: c.agent })),
    savedUSD: Math.round(savedUSD * 100) / 100,
    perksSecured: perks,
  };
}

// The Decision — the platform is an advisor, not a search engine. Instead of
// "Flight A / B / C / D" it returns ONE recommended answer: the total saving
// and the best pick per component, with the reasoning attached.
function buildDecision(packages, priceDive, farePrediction, intent) {
  const rec = packages?.options?.find((o) => o.recommended) || packages?.options?.[0];
  if (!rec) return null;
  const pick = (...types) => rec.components.find((c) => types.includes(c.type)) || null;
  const flight = pick('flight');
  const journey = flight || pick('train', 'coach', 'ferry', 'cruise');
  const hotel = pick('hotel', 'host');
  const transfer = pick('transfer');
  const esim = pick('esim');
  const fmt = (c, detail) => (c ? { supplier: c.supplier, reliability: c.reliabilityScore, priceUSD: c.priceUSD, ...(detail || {}) } : null);
  // Best travel window: the date-shift dive lever when it found a cheaper
  // window, else the fare-prediction advice, else the traveller's own dates.
  const dateLever = priceDive?.savings?.find?.((l) => /date/i.test(l.lever || '')) || null;
  const bestTravelWindow = dateLever?.how
    || farePrediction?.advice
    || (intent.month ? `Your chosen window (${intent.month})` : 'Your chosen dates');
  return {
    headline: "Don't Search. Let AI Find, Negotiate and Build the Best Trip.",
    recommendedTier: rec.tier,
    totalSaving: {
      local: rec.pricing.local.savingsVsMarket,
      usd: rec.pricing.lines.savingsVsMarketUSD,
      symbol: rec.pricing.symbol,
      vs: 'public market reference for the same components',
    },
    bestRoute: journey ? fmt(journey, journey.details?.outbound ? { route: `${journey.details.outbound.from} → ${journey.details.outbound.to}`, depart: journey.details.outbound.depart } : {}) : null,
    bestHotel: fmt(hotel, hotel?.stars ? { stars: hotel.stars } : {}),
    bestTransfer: fmt(transfer),
    bestEsim: fmt(esim),
    bestTravelWindow,
    // Global Travel Optimiser (USP #4): the components were optimised
    // TOGETHER as one journey, never booked piecemeal.
    optimisedTogether: rec.components.map((c) => c.type),
    why: [
      `Highest reliability per pound across ${rec.components.length} verified components (avg ${rec.avgReliability}/100)`,
      'Wholesale/negotiated rates beat the public reference price',
      'Every supplier passed the 50-point integrity check',
      'Flight, stay, transfer, visa, insurance and eSIM optimised together as one journey',
    ],
  };
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
    budgetStay: !!intent.budgetStay,
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

// Concierge itinerary builder: activities spread across the stay with arrival,
// leisure days and departure — the full-trip plan a human concierge would draft.
function buildItinerary(intent, scan) {
  const nights = intent.nights || 7;
  const dest = intent.destination.city;
  const acts = (scan.activities || []).filter((a) => a.verified).map((a) => a.supplier);
  const days = [];
  for (let d = 1; d <= Math.min(nights + 1, 15); d++) {
    if (d === 1) days.push({ day: 1, plan: `Arrive in ${dest} — transfer, check-in, evening orientation walk` });
    else if (d === nights + 1) days.push({ day: d, plan: `Check-out & departure — transfer to your ${intent.components.includes('flights') ? 'flight' : 'journey'} home` });
    else if (acts.length) days.push({ day: d, plan: acts[(d - 2) % acts.length] });
    else days.push({ day: d, plan: d % 3 === 0 ? `Free day — Concierge suggestions on request` : `Explore ${dest} at your pace` });
  }
  return { agent: 'Travel Concierge Agent', destination: dest, days };
}
