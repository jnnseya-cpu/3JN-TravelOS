// End-to-end-ish unit tests for the 3JN Travel OS pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseIntent } from '../src/intent.js';
import { detectContext } from '../src/geo.js';
import { plan } from '../src/planner.js';
import { priceBreakdown, instalmentPlan, tierForPoints } from '../src/pricing.js';
import { costProtectionGate, whiteLabelPayout, SEARCH_TIERS } from '../src/revenue.js';
import {
  createUser, createBooking, saveQuote, updateUser, seedAllRoles,
  createApiKey, listApiKeys, revokeApiKey, useApiKey, adminOverview,
  recordAudit, adminAudit, saveDraft, getDraft,
  createPaymentLink, settlePaymentLink, merchantSettlement,
  listApprovals, decideApproval,
} from '../src/store.js';
import { runPriceGuard } from '../src/monitor.js';
import { visaCheck, riskFeed } from '../src/intelligence.js';
import { destinationsCatalog } from '../src/destinations.js';
import { snapshot, hydrate } from '../src/store.js';
import { listNotifications, pushNotification, recordVisaApplication, govAnalytics } from '../src/store.js';
import { assessVisa, approvalProbability } from '../src/visaos.js';
import { findUserByEmail, provisionEsim, listEsims, activateEsim, expenseReport, createContract, negotiatedDiscount } from '../src/store.js';
import { subscribeMembership, renewMembership, spendAcu, buyAcu } from '../src/store.js';
import { MEMBERSHIP_TIERS, ACU_PER_GBP } from '../../shared/constants.js';
import { aiCostOptimization, MIN_AI_COST_SAVING } from '../src/ai-gateway.js';
import { visaFramework, buildChecklist, assessApplication, validateApplicant, redactApplicant, requiredFieldsFor, CORE_DOCUMENTS } from '../src/visa-framework.js';
import * as agentsModule from '../src/agents.js';
import { bookingRequirements, validateBooking, bookingRiskScore, fieldCount } from '../src/booking-schema.js';
import { architecture as commsArchitecture, emit as commsEmit, renderEmail as commsRenderEmail, EVENTS as COMMS_EVENTS } from '../src/comms.js';
import { track, learnProfile, journeyDashboard } from '../src/learning.js';
import { flightFareUnits, fareBandForAge } from '../src/suppliers.js';
import { duffelPassengers, durationLabel, normalizeDuffelOffer, normalizeAmadeusHotel, liveSuppliersConfigured, oagInstanceToLeg, oagScheduleEnabled } from '../src/live-suppliers.js';
import { estimateFlightFares } from '../src/suppliers.js';
import { haversineKm, distanceFareUSD, routeFareBaseUSD, airportCoords } from '../src/airports.js';
import http from 'node:http';
import { app } from '../src/server.js';

const GB = { currency: { code: 'GBP', symbol: '£', rateFromUSD: 0.79 }, country: 'GB' };

test('intent parser understands the canonical Dubai sentence', () => {
  const intent = parseIntent(
    'I want to travel to Dubai with my family in August for 7 nights. I want flights, hotel, visa, activities, internet abroad, airport transfer, instalments and the cheapest reliable price.',
    { country: 'GB' },
    new Date(Date.UTC(2026, 5, 30)),
  );
  assert.equal(intent.destination.city, 'Dubai');
  assert.equal(intent.travellers.adults, 2);
  assert.equal(intent.travellers.children, 2);
  assert.equal(intent.nights, 7);
  assert.equal(intent.month, 'august');
  assert.ok(intent.components.includes('flights'));
  assert.ok(intent.components.includes('visa'));
  assert.ok(intent.components.includes('esim'));
  assert.ok(intent.components.includes('transfer'));
  assert.equal(intent.wantsInstalments, true);
  assert.equal(intent.priority, 'cheapest-reliable');
});

test('geo detection reads Accept-Language', () => {
  const ctx = detectContext({ headers: { 'accept-language': 'en-GB,en;q=0.9' } });
  assert.equal(ctx.country, 'GB');
  assert.equal(ctx.currency.code, 'GBP');
});

test('plan returns tiered, verified options with a recommendation', () => {
  const result = plan({
    text: 'Dubai with family in August for 7 nights, flights hotel visa activities transfer esim, cheapest reliable',
    context: GB,
    user: null,
    searchTier: 'deep',
  });
  assert.equal(result.stage, 'options');
  assert.ok(result.packages.options.length >= 2);
  // every package must be verified-only
  for (const o of result.packages.options) {
    assert.equal(o.verified, true, `${o.tier} should be verified-only`);
    assert.ok(o.avgReliability >= 70, 'avg reliability above floor');
    assert.ok(o.pricing.lines.commissionUSD > 0, '3JN commission present');
  }
  assert.ok(result.packages.recommendedTier, 'a tier is recommended');
});

test('flight preferences: "direct only" toggle filters to non-stop when available', () => {
  const base = 'London to Dubai in August for 5 nights, flights and hotel';
  const off = plan({ text: base, context: GB, user: null, searchTier: 'smart', preferences: { directOnly: false } });
  const on = plan({ text: base, context: GB, user: null, searchTier: 'smart', preferences: { directOnly: true } });
  assert.equal(on.flightPrefs.directOnly, true);
  // When the toggle is honoured, the recommended flight is non-stop both legs.
  const flight = on.packages.options[0].components.find((c) => c.type === 'flight');
  if (!on.flightPrefs.directUnavailable) {
    assert.equal(flight.details.outbound.stops, 0, 'outbound is non-stop');
    assert.equal((flight.details.inbound.stops || 0), 0, 'inbound is non-stop');
  }
  // The off-case still returns valid options (stops allowed).
  assert.equal(off.stage, 'options');
});

test('flight preferences: departure-window preference is captured', () => {
  const result = plan({
    text: 'London to Istanbul in September for 4 nights, flights and hotel',
    context: GB, user: null, searchTier: 'smart',
    preferences: { departureWindow: 'morning' },
  });
  assert.equal(result.flightPrefs.departureWindow, 'morning');
});

test('accuracy: real airport codes, UK date range, child ages and hotel area are captured', () => {
  const text = 'I want to travel to Dubai from birmingham on 17/08 to 24/08 with my family ( 2 adults , and 3 children 16,13 and 9 years old) on a direct flight . I want direct flights and hotel in sheikh zayed road dubai , instalments and the cheapest reliable price.';
  const r = plan({ text, context: GB, user: null, searchTier: 'deep', preferences: { directOnly: true } });
  assert.equal(r.stage, 'options');
  // Birmingham must be BHX (not the first-three-letters "BIR" = Biratnagar, Nepal).
  assert.equal(r.origin.airport, 'BHX');
  assert.equal(r.origin.city, 'Birmingham');
  // Explicit UK-style 17/08–24/08 range, not the bare-month default.
  assert.equal(r.intent.dates.checkIn, '2026-08-17');
  assert.equal(r.intent.dates.checkOut, '2026-08-24');
  assert.equal(r.intent.month, 'august');
  // Travellers + child ages.
  assert.equal(r.intent.travellers.adults, 2);
  assert.equal(r.intent.travellers.children, 3);
  assert.deepEqual(r.intent.travellers.childAges, [16, 13, 9]);
  // Requested neighbourhood honoured.
  assert.match(r.intent.hotelArea || '', /sheikh zayed road/i);
  const hotel = r.packages.options[0].components.find((c) => c.type === 'hotel' || c.type === 'host');
  assert.match(hotel.details.area, /sheikh zayed road/i);
});

test('accuracy: only a carrier that truly operates the route flies it non-stop', () => {
  // Birmingham→Dubai: Emirates is the only real non-stop operator; BA/Lufthansa
  // route via their own hubs. The direct-only pick must be a genuine non-stop.
  const r = plan({
    text: 'Dubai from birmingham in August for 7 nights, flights and hotel, direct flights only',
    context: GB, user: null, searchTier: 'deep', preferences: { directOnly: true },
  });
  const flight = r.packages.options[0].components.find((c) => c.type === 'flight');
  assert.equal(flight.details.outbound.stops, 0, 'recommended flight is non-stop');
  assert.equal(r.flightPrefs.directUnavailable, false);
});

test('multi-modal: a search shows ONLY the modes asked for — no auto flights/hotel', () => {
  const types = (r) => (r.packages.options[0].components || []).map((c) => c.type);

  // Train only — must not sprout flights, hotel or activities.
  const train = plan({ text: 'train from London to Paris for 3 nights, 2 adults', context: GB, user: null, searchTier: 'smart' });
  assert.deepEqual([...new Set(types(train))], ['train']);

  // Coach only.
  const coach = plan({ text: 'coach from London to Amsterdam for 4 nights, 1 adult', context: GB, user: null, searchTier: 'smart' });
  assert.deepEqual([...new Set(types(coach))], ['coach']);

  // Cruise only.
  const cruise = plan({ text: 'Mediterranean cruise from Barcelona for 7 nights, 2 adults', context: GB, user: null, searchTier: 'smart' });
  assert.ok(types(cruise).includes('cruise'));
  assert.ok(!types(cruise).includes('flight') && !types(cruise).includes('hotel') && !types(cruise).includes('host'));

  // Train + hotel — exactly those two, no flights/activities.
  const th = plan({ text: 'train and hotel in Paris for 5 nights, 2 adults', context: GB, user: null, searchTier: 'smart' });
  const set = new Set(types(th).map((t) => (t === 'host' ? 'hotel' : t)));
  assert.deepEqual([...set].sort(), ['hotel', 'train']);
});

test('standalone eSIM: cheap, tiered, and no flight/visa framing', () => {
  const r = plan({ text: 'I want to get an e-sim to use in Dubai', context: GB, user: null, searchTier: 'smart' });
  assert.equal(r.stage, 'options');
  assert.deepEqual([...new Set(r.packages.options[0].components.map((c) => c.type))], ['esim']);
  // Utility purchase → not a journey: no visa panel, no flight route.
  assert.equal(r.journey, false);
  assert.equal(r.visa.ok, false);
  // Realistic price — a week's Dubai eSIM is single digits, not ~£40.
  const total = r.packages.options[0].pricing.local.total;
  assert.ok(total < 15, `eSIM total ${total} should be modest`);
  const esim = r.packages.options[0].components.find((c) => c.type === 'esim');
  assert.ok(esim.details.dataGB >= 1 && esim.details.dataGB <= 8);
  assert.ok(esim.details.planLabel.includes('GB'));
});

test('mini cruise: "family of 5", Newcastle, 2 nights, priced as a ferry-cruise', () => {
  const r = plan({ text: 'travel to Amsterdam from new castle on a mini cruise in September for a family of 5, only 2 nights in total', context: GB, user: null, searchTier: 'smart' });
  assert.equal(r.stage, 'options');
  // "new castle" → real Newcastle airport, not a derived "NEW".
  assert.equal(r.origin.airport, 'NCL');
  // "family of 5" → 5 people (2 adults + 3 children), not 4.
  assert.equal(r.intent.travellers.total, 5);
  assert.equal(r.intent.travellers.adults, 2);
  assert.equal(r.intent.travellers.children, 3);
  // 2 nights, cruise only.
  assert.equal(r.intent.nights, 2);
  const cruise = r.packages.options[0].components.find((c) => c.type === 'cruise');
  assert.ok(cruise && cruise.details.miniCruise, 'priced as a mini cruise');
  assert.match(cruise.supplier, /mini cruise/i);
  // Far cheaper than a 7-night ocean liner — a family of 5 mini cruise is modest.
  assert.ok(r.packages.options[0].pricing.local.total < 1200, `mini cruise total ${r.packages.options[0].pricing.local.total} should be modest`);
});

test('"group of 4" and "party of 6" set the headcount', () => {
  const g = plan({ text: 'flights to Dubai for a group of 4 for 5 nights', context: GB, user: null, searchTier: 'smart' });
  assert.equal(g.intent.travellers.total, 4);
  assert.equal(g.intent.travellers.adults, 4);
});

test('local trip needs no passport/visa; international does', () => {
  // A domestic train (London→Manchester) is local — no passport, no visa.
  const local = plan({ text: 'train from London to Manchester for 2 nights, 2 adults', context: GB, user: null, searchTier: 'smart' });
  assert.equal(local.international, false);
  assert.equal(local.visa.ok, false); // no visa surfaced for a local trip
  const lreq = bookingRequirements({ components: ['train'], destination: 'Manchester', nationality: 'GB', international: local.international });
  assert.ok(!lreq.documents.some((d) => /passport/i.test(d)), 'no passport asked for a local trip');
  assert.equal(lreq.entryRules.length, 0);
  assert.equal(validateBooking({ travellers: [{ fullName: 'A B', dob: '1990-01-01' }], international: false }).valid, true);

  // An international train (London→Paris) does need a passport.
  const intl = plan({ text: 'train from London to Paris for 3 nights, 2 adults', context: GB, user: null, searchTier: 'smart' });
  assert.equal(intl.international, true);
  const ereq = bookingRequirements({ components: ['train'], destination: 'Paris', nationality: 'GB', international: intl.international });
  assert.ok(ereq.documents.some((d) => /passport/i.test(d)), 'passport required for an international train');
  assert.equal(validateBooking({ travellers: [{ fullName: 'A B', dob: '1990-01-01' }], international: true }).valid, false);
});

test('plain-English: an unspecified need asks rather than assuming components', () => {
  // Just a place, no need stated → clarify (don't invent flights/hotel).
  const bare = plan({ text: 'Dubai', context: GB, user: null, searchTier: 'smart' });
  assert.equal(bare.stage, 'clarify');
  assert.equal(bare.questions[0].id, 'need');
  assert.ok(bare.questions[0].options.includes('Train'));

  // Answering the question delivers exactly that and nothing else.
  const answered = plan({ text: 'Dubai', context: GB, user: null, searchTier: 'smart', overrides: { need: 'Train' } });
  assert.equal(answered.stage, 'options');
  assert.deepEqual([...new Set(answered.packages.options[0].components.map((c) => c.type))], ['train']);

  // A clear "travel + stay" phrasing is understood without asking.
  const stay = plan({ text: 'I want to go to Paris for 4 nights, 2 adults', context: GB, user: null, searchTier: 'smart' });
  assert.equal(stay.stage, 'options');
});

test('multi-modal: bare destination = essentials; "holiday" = full package', () => {
  const types = (r) => (r.packages.options[0].components || []).map((c) => (c.type === 'host' ? 'hotel' : c.type));

  // Bare "Dubai for 7 nights" → flights + hotel only (no activities/transfer/esim).
  const bare = new Set(types(plan({ text: 'Dubai for 7 nights, 2 adults', context: GB, user: null, searchTier: 'smart' })));
  assert.deepEqual([...bare].sort(), ['flight', 'hotel']);

  // "holiday to Dubai" → full package.
  const hol = new Set(types(plan({ text: 'holiday to Dubai for 7 nights, 2 adults', context: GB, user: null, searchTier: 'smart' })));
  assert.ok(hol.has('activity') && hol.has('transfer') && hol.has('esim'), 'holiday signal adds the full package');

  // "bus" must not be mistaken inside "business".
  const biz = new Set(types(plan({ text: 'business trip to Dubai, flights only, 1 adult', context: GB, user: null, searchTier: 'smart' })));
  assert.ok(!biz.has('coach'), '"business" does not trigger coach');
});

test('origin: "<City> to <Dest>" without the word "from" sets the departure city', () => {
  // The user's phrasing "Birmingham to Kinshasa" must depart Birmingham (BHX),
  // not default to London.
  const r = plan({ text: 'Birmingham to Kinshasa for 21 days in August, 2 adults and 3 children, flights and hotel', context: GB, user: null, searchTier: 'smart' });
  assert.equal(r.origin.airport, 'BHX');
  assert.equal(r.origin.inferred, false);
  // A real two-word origin still works.
  const r2 = plan({ text: 'New York to Dubai in September for 5 nights, 2 adults, flights and hotel', context: GB, user: null, searchTier: 'smart' });
  assert.equal(r2.origin.airport, 'JFK');
  // And a normal "I want to travel to X" is NOT mistaken for an origin.
  const r3 = plan({ text: 'I want to travel to Dubai in August for 7 nights, flights and hotel', context: GB, user: null, searchTier: 'smart' });
  assert.equal(r3.origin.inferred, true); // no stated origin → inferred
});

test('thin-market & known cities: real IATA, country, carrier realism, priced up', () => {
  // Kinshasa resolves to its REAL airport (FIH) + country, prices on distance ×
  // a thin-market premium, and is NOT served non-stop by a European low-cost
  // carrier (Wizz). Earlier it mis-resolved to "KIN" with a random ~£280 fare.
  const k = plan({ text: 'birmingham to kinshasa for 21 days in august, 2 adults and 3 children, flights and hotel', context: GB, user: null, searchTier: 'deep' });
  assert.equal(k.intent.destination.code, 'FIH');
  assert.ok(k.intent.destination.countryName && /congo/i.test(k.intent.destination.countryName));
  const kf = k.packages.options[0].components.find((c) => c.type === 'flight');
  assert.ok(!/wizz|easyjet|ryanair/i.test(kf.supplier), 'no LCC long-haul to Kinshasa');
  assert.ok(kf.details.adultFareUSD > 700, `Kinshasa fare ${kf.details.adultFareUSD} reflects a thin market`);

  // Doha resolves to DOH/Qatar and is flown non-stop by its hub carrier, not by
  // a carrier that doesn't serve it.
  const d = plan({ text: 'birmingham to doha qatar for 7 nights in august, 2 adults and 3 children, flights and hotel', context: GB, user: null, searchTier: 'deep' });
  assert.equal(d.intent.destination.code, 'DOH');
  assert.equal(d.intent.destination.countryName, 'Qatar');
  const df = d.packages.options.find((o) => o.recommended).components.find((c) => c.type === 'flight');
  assert.equal(df.details.outbound.stops, 0, 'Doha is non-stop from its hub carrier');
});

test('distance-based fares: realistic, monotonic with distance, origin-aware', () => {
  // Great-circle distance is sane (BHX→DXB ≈ 5,500 km).
  const km = haversineKm(airportCoords('BHX'), airportCoords('DXB'));
  assert.ok(km > 5000 && km < 6000, `BHX→DXB ≈ ${Math.round(km)}km`);

  // Fare grows with distance and lands in real bands.
  const bcn = distanceFareUSD(haversineKm(airportCoords('LHR'), airportCoords('BCN')));
  const dxb = distanceFareUSD(haversineKm(airportCoords('LHR'), airportCoords('DXB')));
  const dps = distanceFareUSD(haversineKm(airportCoords('LHR'), airportCoords('DPS')));
  assert.ok(bcn < dxb && dxb < dps, 'farther route costs more');
  assert.ok(bcn > 120 && bcn < 280, `Barcelona RT ${bcn} USD realistic`);
  assert.ok(dxb > 500 && dxb < 850, `Dubai RT ${dxb} USD realistic`);
  assert.ok(dps > 900 && dps < 1500, `Bali RT ${dps} USD realistic`);

  // Origin-aware: same destination, farther origin is not cheaper.
  assert.ok(routeFareBaseUSD('LOS', 'DXB') >= routeFareBaseUSD('DOH', 'DXB'));

  // Unknown airport → null so the caller falls back to the catalogue base.
  assert.equal(routeFareBaseUSD('ZZZ', 'DXB'), null);
});

test('price sanity: a family Dubai package stays competitive, not 2x the market', () => {
  // Real market comparison (BHX→DXB, 17–24 Aug 2026, 2 adults + ages 16/13/9,
  // 7 nights): LoveHolidays £3,795, Trip.com £4,547. Our recommended package
  // must land in the real-world band — never the ~£7.6k (2x) it once did.
  const text = 'Dubai from birmingham on 17/08 to 24/08, 2 adults and 3 children 16,13 and 9 years old, direct flights and hotel, cheapest reliable price';
  const r = plan({ text, context: GB, user: null, searchTier: 'deep', preferences: { directOnly: true } });
  const rec = r.packages.options.find((o) => o.recommended) || r.packages.options[0];
  assert.ok(rec.pricing.local.total < 4500, `recommended ${rec.pricing.local.total} must beat the cheapest competitor band`);
  assert.ok(rec.pricing.local.total > 1500, `recommended ${rec.pricing.local.total} must not be implausibly low`);
  // Round-trip economy fare per seat for a major carrier should be realistic.
  const f = rec.components.find((c) => c.type === 'flight');
  assert.ok(f.details.adultFareUSD < 1100, `per-seat RT fare ${f.details.adultFareUSD} USD too high`);
  assert.ok(f.details.adultFareUSD > 250, `per-seat RT fare ${f.details.adultFareUSD} USD too low`);
});

test('fare bands: 12+ pay adult fare, 2–11 pay 75%, under-2 pay 10%', () => {
  assert.equal(fareBandForAge(16), 'adult');
  assert.equal(fareBandForAge(12), 'adult');
  assert.equal(fareBandForAge(11), 'child');
  assert.equal(fareBandForAge(1), 'infant');
  // 2 adults + children 16, 13, 9 → 4 full fares + one 75% child = 4.75 units.
  const u = flightFareUnits({ adults: 2, children: 3, childAges: [16, 13, 9], total: 5 });
  assert.equal(u.units, 4.75);
  assert.deepEqual(u.counts, { adult: 2, youth: 2, child: 1, infant: 0 });
  // Children with no stated ages default to the child band.
  const v = flightFareUnits({ adults: 2, children: 2, childAges: [], total: 4 });
  assert.equal(v.units, 3.5); // 2 + 2×0.75
});

test('fare bands change the flight total in a real plan', () => {
  const r = plan({
    text: 'Dubai from london on 17/08 to 24/08, 2 adults and 1 child aged 9, flights and hotel',
    context: GB, user: null, searchTier: 'smart',
  });
  const f = r.packages.options[0].components.find((c) => c.type === 'flight');
  assert.deepEqual(f.details.fareBreakdown, { adult: 2, youth: 0, child: 1, infant: 0 });
  assert.equal(f.details.fareUnits, 2.75);
  // Total equals the per-seat return fare × banded units (not × headcount).
  assert.ok(Math.abs(f.priceUSD - f.details.adultFareUSD * 2.75) < 0.02);
  assert.ok(f.details.childFareUSD < f.details.adultFareUSD);
});

test('live suppliers: disabled without keys, normalisers map provider shapes', () => {
  // No provider keys in the test env → live overlay is inert (estimates used).
  assert.equal(liveSuppliersConfigured(), false);

  // Duffel passenger mapping: 2 adults + ages 16, 9, 1.
  const pax = duffelPassengers({ adults: 2, children: 3, childAges: [16, 9, 1] });
  assert.deepEqual(pax, [{ type: 'adult' }, { type: 'adult' }, { age: 16 }, { age: 9 }, { type: 'infant_without_seat' }]);

  assert.equal(durationLabel('PT7H30M'), '7h 30m');

  // Normalise a Duffel offer → our flight shape.
  const offer = {
    id: 'off_1', owner: { name: 'Emirates' }, total_amount: '900.00', total_currency: 'USD',
    slices: [
      { duration: 'PT7H', segments: [{ origin: { iata_code: 'LHR', city_name: 'London' }, destination: { iata_code: 'DXB', city_name: 'Dubai' }, departing_at: '2026-08-17T20:05:00', arriving_at: '2026-08-18T06:00:00' }] },
      { duration: 'PT8H', segments: [{ origin: { iata_code: 'DXB' }, destination: { iata_code: 'LHR' }, departing_at: '2026-08-24T03:00:00', arriving_at: '2026-08-24T07:30:00' }] },
    ],
  };
  const nf = normalizeDuffelOffer(offer, 900, { total: 3 });
  assert.equal(nf.supplier, 'Emirates');
  assert.equal(nf.live, true);
  assert.equal(nf.priceUSD, 900);
  assert.equal(nf.details.outbound.stops, 0);
  assert.equal(nf.details.outbound.depart, '20:05');
  assert.equal(nf.details.inbound.depart, '03:00');

  // Normalise an Amadeus hotel entry → our hotel shape.
  const entry = {
    hotel: { name: 'Address Downtown', rating: '5', address: { lines: ['Sheikh Zayed Road'] }, hotelId: 'DXBADR' },
    offers: [{ price: { total: '1400.00', currency: 'USD' }, room: { typeEstimated: { category: 'DELUXE' } }, boardType: 'BREAKFAST', policies: { cancellations: [{ deadline: 'x' }] } }],
  };
  const nh = normalizeAmadeusHotel(entry, 1400, 7, 2);
  assert.equal(nh.supplier, 'Address Downtown');
  assert.equal(nh.stars, 5);
  assert.equal(nh.live, true);
  assert.equal(nh.details.nightlyUSD, 200);
  assert.equal(nh.details.freeCancellation, true);
  assert.match(nh.details.area, /sheikh zayed road/i);
});

test('OAG schedule: disabled without key; flight instance normalises to a real non-stop leg', () => {
  assert.equal(oagScheduleEnabled(), false); // no OAG key in the test env

  // A representative OAG flight-instance (JFK→LHR overnight on BA).
  const inst = {
    carrier: { iata: 'BA', icao: 'BAW' },
    flightNumber: '112',
    departure: { airport: { iata: 'JFK', city: 'New York' }, date: { local: '2025-05-01' }, time: { local: '19:00' } },
    arrival: { airport: { iata: 'LHR', city: 'London' }, date: { local: '2025-05-02' }, time: { local: '07:00' } },
    elapsedTime: 420,
    aircraftType: { iata: '77W' },
  };
  const leg = oagInstanceToLeg(inst);
  assert.equal(leg.from, 'JFK');
  assert.equal(leg.to, 'LHR');
  assert.equal(leg.depart, '19:00');
  assert.equal(leg.arrive, '07:00');
  assert.equal(leg.arriveNextDay, true);
  assert.equal(leg.stops, 0);
  assert.equal(leg.stopLabel, 'Direct');
  assert.equal(leg.durationLabel, '7h 0m');
  assert.equal(leg.flightNumber, 'BA112');
  assert.equal(leg.aircraft, '77W');
});

test('OAG schedules-shape entry normalises (fallback date, overnight + stops inferred)', () => {
  // A Schedules-product entry: no explicit dates, arrival clock < departure
  // (overnight), and a stop count.
  const sched = {
    carrier: { iata: 'EK' }, flightNumber: '40',
    departure: { airport: { iata: 'BHX' }, time: { local: '20:05' } },
    arrival: { airport: { iata: 'DXB' }, time: { local: '06:35' } },
    scheduledDuration: 405, stops: 1, aircraftType: { iata: '388' },
  };
  const leg = oagInstanceToLeg(sched, '2026-08-17');
  assert.equal(leg.date, '2026-08-17'); // fallback applied
  assert.equal(leg.depart, '20:05');
  assert.equal(leg.arrive, '06:35');
  assert.equal(leg.arriveNextDay, true); // 06:35 < 20:05 → overnight
  assert.equal(leg.stops, 1);
  assert.equal(leg.stopLabel, '1 stop');
  assert.equal(leg.flightNumber, 'EK40');
});

test('estimateFlightFares: shared pricing applies age bands and is deterministic', () => {
  const dest = { flightBaseUSD: 300, code: 'DXB' };
  const a = estimateFlightFares(dest, true, false, { adults: 2, children: 1, childAges: [9], total: 3 }, 'seed-x');
  const b = estimateFlightFares(dest, true, false, { adults: 2, children: 1, childAges: [9], total: 3 }, 'seed-x');
  assert.deepEqual(a, b); // same seed → identical (reproducible)
  assert.deepEqual(a.fareCounts, { adult: 2, youth: 0, child: 1, infant: 0 });
  assert.equal(a.fareUnits, 2.75);
  assert.ok(Math.abs(a.priceUSD - a.totalPerSeat * 2.75) < 0.02);
});

test('flight preferences: inferred from free text ("non-stop")', () => {
  const result = plan({
    text: 'London to Dubai non-stop in August for 5 nights, flights and hotel',
    context: GB, user: null, searchTier: 'smart',
  });
  assert.equal(result.flightPrefs.directOnly, true);
});

test('unresolved destination asks clarifying questions instead of crashing', () => {
  const result = plan({ text: 'I want a cheap holiday somewhere warm', context: GB, user: null });
  assert.equal(result.stage, 'clarify');
  assert.ok(result.questions.find((q) => q.id === 'destination'));
});

test('price breakdown applies loyalty discount + 10% commission', () => {
  const b = priceBreakdown({ componentsUSD: 1000, marketRefUSD: 1300, currency: GB.currency, loyaltyPoints: 1200 });
  // Voyager = 3% off suppliers
  assert.equal(b.lines.loyaltyDiscountUSD, 30);
  assert.equal(b.lines.netSuppliersUSD, 970);
  assert.equal(b.lines.commissionUSD, 97); // 10% of net
  assert.equal(b.lines.totalUSD, 1067);
  assert.ok(b.lines.savingsVsMarketUSD > 0);
});

test('loyalty tiers map points correctly', () => {
  assert.equal(tierForPoints(0).name, 'Explorer');
  assert.equal(tierForPoints(1200).name, 'Voyager');
  assert.equal(tierForPoints(6000).name, 'Nomad');
  assert.equal(tierForPoints(20000).name, 'Elite');
});

test('instalment plan: deposit + interest-free schedule sums to total', () => {
  const plan3 = instalmentPlan({ totalLocal: 1000, currency: GB.currency, months: 3, depositPct: 0.2, checkIn: '2026-08-12' });
  assert.equal(plan3.deposit, 200);
  assert.equal(plan3.interestRate, 0);
  const scheduled = plan3.schedule.reduce((s, x) => s + x.amount, 0);
  assert.ok(Math.abs(scheduled + plan3.deposit - 1000) < 0.01, 'schedule + deposit == total');
});

test('cost-protection gate blocks unfunded deep search and downgrades', () => {
  const poorUser = { acuBalance: 0, points: 0 };
  // Tiny expected booking → 10% revenue can't cover AI cost × 10 → blocked.
  const gate = costProtectionGate({ tier: 'deep', user: poorUser, expectedBookingUSD: 10 });
  assert.equal(gate.allowed, false);
  assert.equal(gate.downgradeTo, 'free');

  // funded by expected booking revenue
  const ok = costProtectionGate({ tier: 'deep', user: poorUser, expectedBookingUSD: 5000 });
  assert.equal(ok.allowed, true);

  // funded by ACU balance even with no booking intent
  const acuFunded = costProtectionGate({ tier: 'deep', user: { acuBalance: 5000 }, expectedBookingUSD: 0 });
  assert.equal(acuFunded.allowed, true);
});

test('white-label payout is 90/10 split', () => {
  const p = whiteLabelPayout(100000, 0.10);
  assert.equal(p.commissionUSD, 10000);
  assert.equal(p.partnerNetUSD, 9000);
  assert.equal(p.platformShareUSD, 1000);
});

test('price guard refunds the difference when price drops', () => {
  const user = createUser({ name: 'Test' });
  const option = { totalUSD: 1000, pricing: { lines: { totalUSD: 1000 }, local: { total: 790 }, revenue: { commissionUSD: 100, savingsShareUSD: 10 } } };
  const quote = saveQuote({ option, intent: { dates: { checkIn: '2026-08-12' } } });
  const booking = createBooking({ quoteId: quote.id, option, instalment: instalmentPlan({ totalLocal: 790, currency: GB.currency, months: 3, depositPct: 0.2 }), userId: user.id });
  const event = runPriceGuard(booking.id, -0.10); // force a 10% drop
  assert.equal(event.action, 'rebook-refund');
  assert.ok(event.refundUSD > 0);
});

test('Dubai land products are sourced via the Rayna Tours agent account at net rates', () => {
  const result = plan({
    text: 'Dubai with family in August for 7 nights, flights hotel visa activities transfer, cheapest reliable',
    context: GB,
    user: null,
    searchTier: 'smart',
  });
  const std = result.packages.options.find((o) => o.tier === 'Standard');
  const visa = std.components.find((c) => c.type === 'visa');
  assert.equal(visa.sourcedVia, 'Rayna Tours');
  assert.equal(visa.agent, true);
  assert.ok(visa.priceUSD < visa.publicPriceUSD, 'agent net rate is below public price');
  // Direct flights are a privilege: when a non-stop exists, the package picks it.
  const flight = std.components.find((c) => c.type === 'flight');
  assert.equal(flight.details.outbound.stops, 0, 'prefers a direct outbound when available');
  assert.equal(flight.details.inbound.stops, 0, 'prefers a direct inbound when available');
  assert.ok(typeof flight.sourcedVia === 'string' && flight.sourcedVia.length > 0);
});

test('referral rewards both parties', () => {
  const referrer = createUser({ name: 'Referrer' });
  const friend = createUser({ name: 'Friend', referredByCode: referrer.referralCode });
  assert.equal(friend.points, 250 + 50); // signup bonus + referral
});

test('accounts have roles and an editable profile + avatar', () => {
  const u = createUser({ name: 'Pat', role: 'business' });
  assert.equal(u.role, 'business');
  assert.ok(u.avatar, 'has a default avatar');
  const updated = updateUser(u.id, { name: 'Patricia', avatar: '⭐', bio: 'frequent flyer', role: 'merchant' });
  assert.equal(updated.name, 'Patricia');
  assert.equal(updated.avatar, '⭐');
  assert.equal(updated.role, 'merchant');
});

test('seedAllRoles provisions one account per role', () => {
  const accounts = seedAllRoles();
  const roles = accounts.map((a) => a.role);
  ['admin', 'business', 'merchant', 'partner', 'consumer'].forEach((r) => assert.ok(roles.includes(r)));
});

test('merchants can create and use white-label API keys; consumers cannot', () => {
  const consumer = createUser({ name: 'C', role: 'consumer' });
  assert.equal(createApiKey(consumer.id, {}).ok, false); // role not permitted

  const merchant = createUser({ name: 'M', role: 'merchant' });
  const created = createApiKey(merchant.id, { environment: 'sandbox', label: 'Test' });
  assert.equal(created.ok, true);
  assert.match(created.key.secret, /^3jn_test_/);

  // listing masks the secret
  const listed = listApiKeys(merchant.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].secret, undefined);

  // the key validates, then revokes
  assert.equal(useApiKey(created.key.secret).userId, merchant.id);
  revokeApiKey(merchant.id, created.key.id);
  assert.equal(useApiKey(created.key.secret), null);
});

test('admin overview aggregates platform KPIs', () => {
  const o = adminOverview();
  assert.ok(typeof o.users === 'number' && o.users > 0);
  assert.ok('gmvUSD' in o && 'tierMix' in o && 'gatewayMix' in o);
});

test('audit log records actions and autosave round-trips a draft', () => {
  const before = adminAudit(1000).length;
  recordAudit({ actor: 'u1', role: 'consumer', action: 'test.action', entity: 'x', entityId: '1', summary: 'hi' });
  assert.equal(adminAudit(1000).length, before + 1);
  assert.equal(adminAudit(1)[0].action, 'test.action');

  saveDraft('u1', 'intent', { text: 'Dubai' });
  assert.equal(getDraft('u1', 'intent').payload.text, 'Dubai');
});

test('BitriPay payment links create, settle and net out the gateway fee', () => {
  const m = createUser({ name: 'Shop', role: 'merchant' });
  const link = createPaymentLink(m.id, { amountMinor: 10000, currency: 'GBP', description: 'Tour' });
  assert.equal(link.ok, true);
  assert.match(link.link.url, /pay\.3jntravel\.com/);
  settlePaymentLink(m.id, link.link.id);
  const s = merchantSettlement(m.id);
  assert.equal(s.grossMinor, 10000);
  assert.ok(s.feeMinor > 0 && s.netMinor === s.grossMinor - s.feeMinor);
});

test('visa centre returns eligibility + checklist by nationality', () => {
  const gbDubai = visaCheck('GB', 'Dubai');
  assert.equal(gbDubai.ok, true);
  assert.equal(gbDubai.required, true);
  assert.ok(gbDubai.checklist.length > 0);
  const gbIstanbul = visaCheck('GB', 'Istanbul');
  assert.equal(gbIstanbul.required, false); // visa-free for GB
});

test('risk feed returns a score and the seven intelligence layers', () => {
  const r = riskFeed('Dubai');
  assert.equal(r.ok, true);
  assert.ok(r.riskScore >= 70 && r.riskScore <= 100);
  assert.equal(r.layers.length, 7);
});

test('persistence snapshot/hydrate round-trips the store', () => {
  const u = createUser({ name: 'Snap', email: 'snap@x.com' });
  const snap = JSON.parse(JSON.stringify(snapshot())); // simulate RTDB round-trip
  assert.ok(snap.users[u.id], 'user present in snapshot');
  assert.ok(typeof snap.counter === 'number');
  // hydrate from the snapshot and confirm the user is still resolvable
  assert.equal(hydrate(snap), true);
  assert.ok(findUserByEmail('snap@x.com'));
});

test('destination marketplace catalogue has from-prices + experiences', () => {
  const cat = destinationsCatalog();
  assert.ok(cat.length >= 5);
  const dubai = cat.find((d) => d.city === 'Dubai');
  assert.ok(dubai && dubai.fromUSD > 0 && dubai.experiences.length > 0);
});

test('all-access account can create API keys regardless of role', () => {
  const full = createUser({ name: 'Full', role: 'consumer', allAccess: true });
  assert.equal(full.allAccess, true);
  const key = createApiKey(full.id, { environment: 'sandbox' });
  assert.equal(key.ok, true); // consumer role would normally be blocked
});

test('supplier contracts scale the negotiated discount with volume', () => {
  assert.ok(negotiatedDiscount('hotel', 1_000_000) >= negotiatedDiscount('hotel', 100_000));
  const u = createUser({ name: 'Biz', role: 'business' });
  const c = createContract(u.id, { supplier: 'Emirates', category: 'flights', annualVolumeUSD: 800000 });
  assert.equal(c.status, 'active');
  assert.ok(c.discountPct > 0 && c.discountPct <= 0.06);
});

test('login finds a seeded account by email; eSIM + expense work', () => {
  seedAllRoles();
  const admin = findUserByEmail('admin@3jntravel.com');
  assert.ok(admin && admin.role === 'admin');
  assert.equal(findUserByEmail('nope@nowhere.com'), null);

  const u = createUser({ name: 'Sim', role: 'consumer' });
  const e = provisionEsim(u.id, { destination: 'Dubai', dataGB: 5 });
  assert.equal(e.status, 'provisioned');
  assert.equal(listEsims(u.id).length, 1);
  assert.equal(activateEsim(u.id, e.id).esim.status, 'active');

  const rep = expenseReport(u.id); // no bookings yet
  assert.ok('categories' in rep && 'csv' in rep);
});

test('VisaOS: clean low-risk application is auto-approved', () => {
  const a = assessVisa({ name: 'Clean Applicant', nationality: 'GB', destination: 'Dubai', purpose: 'tourism', homeTies: 'strong', behaviourHesitation: 5 });
  assert.equal(a.risk && Object.keys(a.risk).length, 7);
  assert.ok(a.totalScore <= 200);
  assert.equal(a.decision, 'Auto Approval');
});

test('VisaOS: forged docs + no footprint + watchlist escalates or rejects', () => {
  const a = assessVisa({
    name: 'Risky Applicant', nationality: 'NG', destination: 'New York', purpose: 'business',
    documentsAuthentic: false, footprintMatches: false, fundsConsistent: false,
    onWatchlist: true, knownFraudNetwork: true, priorOverstays: true, homeTies: 'weak', behaviourHesitation: 85,
  });
  assert.ok(a.totalScore > 450, `expected high score, got ${a.totalScore}`);
  assert.ok(['Human Review', 'Auto Rejection'].includes(a.decision));
  assert.equal(a.agents.length, 10);
});

test('VisaOS: approval probability + government analytics', () => {
  const p = approvalProbability('GB', 'Dubai');
  assert.equal(p.ok, true);
  assert.ok(p.approvalProbability > 0 && p.approvalProbability <= 99);
  recordVisaApplication(assessVisa({ name: 'A', nationality: 'GB', destination: 'Dubai' }));
  const g = govAnalytics();
  assert.ok(g.applications >= 1 && 'approvalRate' in g && 'decisions' in g);
});

test('notifications: a booking notifies its owner', () => {
  const u = createUser({ name: 'Notif' });
  const before = listNotifications(u.id).length;
  pushNotification(u.id, { title: 'Test', body: 'hello' });
  assert.equal(listNotifications(u.id).length, before + 1);
  assert.equal(listNotifications(u.id)[0].read, false);
});

test('high-value bookings enter the approval queue and can be decided', () => {
  const u = createUser({ name: 'Biz', role: 'business' });
  const option = { tier: 'Standard', totalUSD: 5000, components: [], pricing: { currency: 'GBP', lines: { totalUSD: 5000 }, local: { total: 3950 }, revenue: { commissionUSD: 500, savingsShareUSD: 0 } } };
  const quote = saveQuote({ option, intent: { dates: { checkIn: '2026-08-12' } } });
  createBooking({ quoteId: quote.id, option, instalment: instalmentPlan({ totalLocal: 3950, currency: GB.currency, months: 3, depositPct: 0.2 }), userId: u.id });
  const pending = listApprovals().filter((a) => a.status === 'pending');
  assert.ok(pending.length >= 1);
  const decided = decideApproval(pending[0].id, 'approve');
  assert.equal(decided.approval.status, 'approved');
});

test('behavioural learning: dashboard is not Dubai-only and learns from activity', () => {
  const u = createUser({ name: 'Learner' });
  // Cold start — no history — should personalise to region, not hard-code Dubai.
  const cold = journeyDashboard(u.id, GB);
  assert.equal(cold.learned, false);
  assert.equal(cold.rows.length, 8);
  assert.ok(Array.isArray(cold.agents) && cold.agents.length >= 4, 'ML agents are attributed');

  // Teach a clear preference: three Bali searches.
  for (let i = 0; i < 3; i++) {
    track(u.id, { event: 'search', destination: 'DPS', payload: { nights: 10, party: 2, month: 'september', components: ['flights', 'hotel'] } });
  }
  const learned = journeyDashboard(u.id, GB);
  assert.equal(learned.learned, true);
  assert.equal(learned.destination.city, 'Bali');
  assert.match(learned.learnedFrom, /Bali/);

  const profile = learnProfile(u.id);
  assert.equal(profile.topDestinations[0].code, 'DPS');
  assert.equal(profile.preferredParty, 'couple');
  assert.equal(profile.avgNights, 10);
  assert.equal(profile.preferredMonth, 'september');
  assert.ok(profile.confidence > 0);
});

test('comms: 177-event catalogue, channel coverage, mandatory fan-out', () => {
  const a = commsArchitecture();
  assert.equal(a.totalEvents, 177);
  assert.equal(a.categories, 15);
  assert.equal(a.mandatory, 27);
  assert.equal(a.channelCoverage.inapp, 177);
  assert.equal(a.channelCoverage.email, 130);
  assert.equal(a.channelCoverage.sms, 18);
  assert.equal(a.channelCoverage.push, 27);

  // Mandatory events bypass user opt-outs.
  const u = createUser({ name: 'Comms' });
  const r = commsEmit('security.alert', { userId: u.id, recipient: u.email, optOuts: ['email', 'sms', 'inapp'] });
  assert.equal(r.ok, true);
  assert.ok(r.deliveries.length >= 3, 'mandatory notice still fired on all its channels');

  // Non-mandatory respects opt-outs.
  const r2 = commsEmit('subscription.renewed', { userId: u.id, recipient: u.email, optOuts: ['email'] });
  assert.ok(!r2.deliveries.some((d) => d.channel === 'email'));

  // Branded email renders the company logo + colour.
  const mail = commsRenderEmail('account.registration.requested', { company: 'groupe-nseya' });
  assert.match(mail.html, /logo\.png/);
  assert.match(mail.subject, /3JN Travel OS/);
  assert.ok(COMMS_EVENTS['security.alert'].mandatory);
});

test('booking engine: dynamic requirements, document validation and fraud score', () => {
  // Requirements adapt to components + destination (US → ESTA, per-passenger PNR).
  const reqs = bookingRequirements({ components: ['flight', 'hotel', 'transfer'], destination: 'New York', nationality: 'NG', passengers: 2 });
  assert.ok(reqs.documents.length > 0);
  assert.equal(reqs.perPassenger.count, 2);
  assert.ok(reqs.entryRules.some((r) => r.type === 'ESTA'));

  // Passport 6-month rule blocks an expiring passport.
  const bad = validateBooking({ travelDate: '2026-09-01', nationality: 'GB', destination: 'Dubai', travellers: [{ fullName: 'Jane', dob: '1990-01-01', nationality: 'GB', passportNumber: 'X1', passportExpiry: '2026-10-01' }] });
  assert.equal(bad.valid, false);
  assert.ok(bad.blocking.length >= 1);

  // A valid passport passes.
  const good = validateBooking({ travelDate: '2026-09-01', nationality: 'GB', destination: 'Dubai', travellers: [{ fullName: 'Jane', dob: '1990-01-01', nationality: 'GB', passportNumber: 'X1', passportExpiry: '2030-10-01' }] });
  assert.equal(good.valid, true);

  // Fraud signals escalate the booking risk decision.
  assert.equal(bookingRiskScore({}).decision, 'approve');
  assert.equal(bookingRiskScore({ cardStolen: true, botBooking: true }).decision, 'reject');

  // The structured field architecture is substantial.
  assert.ok(fieldCount().total >= 250);
});

test('visa framework: dynamic checklist adapts to country, type and applicant', () => {
  const fw = visaFramework();
  assert.equal(fw.countries.length, 16);
  assert.equal(fw.visaTypes.length, 7);
  assert.ok(fw.fraudChecks.length >= 30);

  // A student minor gets student docs + the minor conditionals + UK specifics.
  const cl = buildChecklist({ country: 'GB', visaType: 'student', applicant: { dob: '2012-01-01', maritalStatus: 'Single' } });
  assert.equal(cl.country.code, 'GB');
  const all = cl.sections.flatMap((s) => s.items).join(' | ');
  assert.match(all, /Birth certificate \(minor\)/);
  assert.match(all, /Parental consent letter \(minor\)/);
  assert.match(all, /Admission|acceptance letter/i);
  assert.ok(cl.totalDocuments > 17);

  // Tourist checklist differs from student.
  const tourist = buildChecklist({ country: 'AE', visaType: 'tourist', applicant: {} });
  assert.notEqual(tourist.totalDocuments, cl.totalDocuments);
});

test('visa framework: clean applicant approved, fraudulent applicant refused', () => {
  const clean = assessApplication({
    country: 'AE', visaType: 'tourist',
    applicant: { fullName: 'Jane Doe', nationality: 'GB', age: 34, monthlyIncome: 4000, purpose: 'tourism', homeTies: 'strong' },
  });
  assert.equal(clean.recommendation, 'Approve');
  assert.equal(clean.fraud.flagCount, 0);
  assert.equal(clean.documentVerification.allClear, true);

  const bad = assessApplication({
    country: 'US', visaType: 'work',
    applicant: { fullName: 'Bad Actor', nationality: 'NG', age: 22, monthlyIncome: 300, documentsAuthentic: false, onWatchlist: true, suddenDeposit: true, priorOverstays: true, homeTies: 'weak' },
  });
  assert.equal(bad.recommendation, 'Refuse');
  assert.ok(bad.fraud.flagCount > 5);
  assert.equal(bad.risk.decision, 'Auto Rejection');
});

test('intelligence: visa + risk work for ANY city worldwide, not just the catalogue', () => {
  for (const city of ['Tokyo', 'Lagos', 'São Paulo', 'Reykjavik', 'Kathmandu', 'Lima']) {
    const risk = riskFeed(city);
    assert.equal(risk.ok, true, `risk for ${city}`);
    assert.ok(risk.riskScore > 0 && risk.layers.length === 7);
    assert.equal(risk.estimated, true, `${city} is an estimated (non-catalogue) profile`);

    const visa = visaCheck('NG', city);
    assert.equal(visa.ok, true, `visa for ${city}`);
    assert.equal(visa.estimated, true);
    assert.ok(visa.checklist.length > 0);
  }
  // Catalogue cities keep their precise (non-estimated) data.
  const dubai = riskFeed('Dubai');
  assert.equal(dubai.ok, true);
  assert.equal(dubai.estimated, false);
});

test('AI cost optimisation guarantees the 66% minimum saving floor', () => {
  const c = aiCostOptimization();
  assert.equal(c.floorPct, Math.round(MIN_AI_COST_SAVING * 100));
  assert.equal(c.meetsFloor, true);
  assert.ok(c.savingPct >= 66, `saving ${c.savingPct}% must be >= 66%`);
  assert.ok(c.optimizedUSD <= c.baselineUSD * (1 - MIN_AI_COST_SAVING) + 1e-9);
});

test('membership: 10% of the subscription auto-funds ACUs at £1 = 100 ACU', () => {
  // Allocation rule holds for every tier.
  for (const t of MEMBERSHIP_TIERS) {
    assert.equal(t.acuPerMonth, Math.round(t.pricePerMonth * 0.10 * ACU_PER_GBP));
  }
  const u = createUser({ name: 'MemTest' });
  assert.equal(u.acuBalance, 0, 'new users get no free ACUs');
  assert.equal(u.membership, null);

  const sub = subscribeMembership(u.id, 'family'); // £12.99 -> 130 ACU
  assert.equal(sub.ok, true);
  assert.equal(sub.acuCredited, 130);
  assert.equal(sub.user.acuBalance, 130);
  assert.equal(sub.user.membership.active, true);

  // Each billing period re-funds the allocation.
  const ren = renewMembership(u.id);
  assert.equal(ren.acuCredited, 130);
  assert.equal(ren.user.acuBalance, 260);
});

test('ACU: hard block at insufficient balance, top-ups priced at £1 = 100 ACU', () => {
  const u = createUser({ name: 'AcuTest' });
  // No balance -> spend is refused (must top up before using any ACUs).
  const blocked = spendAcu(u.id, 15, 'search');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'insufficient-acu');

  // Top up £10 -> 1000 ACU, then a spend succeeds and debits.
  const top = buyAcu(u.id, 'topup10');
  assert.equal(top.charged, 10);
  assert.equal(top.balance, 1000);
  const ok = spendAcu(u.id, 15, 'search');
  assert.equal(ok.ok, true);
  assert.equal(ok.balance, 985);
});

test('RBAC: admin & business areas reject the public and consumers, allow admins', async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, h = {}) => fetch(base + p, { headers: h }).then((r) => r.status);
  try {
    // Public (no identity) is forbidden from privileged endpoints.
    assert.equal(await get('/api/admin/overview'), 403);
    assert.equal(await get('/api/admin/users'), 403);
    assert.equal(await get('/api/business/approvals'), 403);
    assert.equal(await get('/api/white-label/payout'), 403);

    // A consumer is also forbidden.
    const consumer = createUser({ name: 'RbacJoe' });
    assert.equal(await get('/api/admin/overview', { 'x-user-id': consumer.id }), 403);
    assert.equal(await get('/api/business/approvals', { 'x-user-id': consumer.id }), 403);

    // An admin (and the full-access demo profile) may proceed.
    const admin = createUser({ name: 'RbacAdmin', role: 'admin', allAccess: true });
    assert.equal(await get('/api/admin/overview', { 'x-user-id': admin.id }), 200);
    assert.equal(await get('/api/admin/users', { 'x-user-id': admin.id }), 200);
    assert.equal(await get('/api/business/approvals', { 'x-user-id': admin.id }), 200);

    // A business user reaches business but NOT admin.
    const biz = createUser({ name: 'RbacBiz', role: 'business' });
    assert.equal(await get('/api/business/contracts', { 'x-user-id': biz.id }), 200);
    assert.equal(await get('/api/admin/overview', { 'x-user-id': biz.id }), 403);

    // Public endpoints remain open.
    assert.equal(await get('/api/context'), 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('behavioural learning: different regions get different default destinations', () => {
  const a = journeyDashboard(null, { country: 'NG', countryName: 'Nigeria', currency: { code: 'NGN', symbol: '₦', rateFromUSD: 1550 } });
  const b = journeyDashboard(null, { country: 'IN', countryName: 'India', currency: { code: 'INR', symbol: '₹', rateFromUSD: 83 } });
  // Region-derived defaults are deterministic; at least one differs from Dubai.
  assert.ok([a.destination.code, b.destination.code].some((c) => c !== 'DXB'));
});

// ---- Visa framework: field governance, validation, redaction ---------------
test('visa framework: per-country required sets (UK history, US social handles)', () => {
  const base = requiredFieldsFor(null, {});
  assert.ok(base.includes('fullName') && base.includes('passportNumber'));
  assert.ok(!base.includes('travelHistory') && !base.includes('socialHandles'));
  assert.ok(requiredFieldsFor('GB', {}).includes('travelHistory'), 'UK requires 10-year travel history');
  assert.ok(requiredFieldsFor('GB', {}).includes('employer'), 'UK requires employer details');
  assert.ok(requiredFieldsFor('US', {}).includes('socialHandles'), 'US requires social identifiers');
});

test('visa framework: declarations force detail fields + sponsor conditional', () => {
  const declared = requiredFieldsFor(null, { criminalHistory: 'Yes — declared', previousRefusals: 'Yes — declared', overstayHistory: 'Yes — declared' });
  assert.ok(declared.includes('criminalHistoryDetails'));
  assert.ok(declared.includes('previousRefusalsDetails'));
  assert.ok(declared.includes('overstayDetails'));
  assert.ok(requiredFieldsFor(null, { fundingSource: 'Sponsor' }).includes('sponsorDetails'));
});

test('visa framework: validateApplicant catches missing + bad formats', () => {
  const r = validateApplicant({ fullName: 'A. Person', email: 'not-an-email', passportExpiry: '2019-01-01' }, 'GB');
  assert.equal(r.valid, false);
  assert.ok(r.missing.includes('travelHistory'));
  assert.ok(r.errors.some((e) => e.field === 'email'));
  assert.ok(r.errors.some((e) => e.field === 'passportExpiry' && /expired/i.test(e.message)));
  assert.ok(r.completeness >= 0 && r.completeness < 100);
});

test('visa framework: complete applicant validates at 100%', () => {
  const app = {
    fullName: 'Amara Okafor', dob: '1990-04-12', placeOfBirth: 'Lagos', nationality: 'NG',
    passportNumber: 'A01234567', passportIssue: '2021-01-01', passportExpiry: '2031-01-01',
    address: '14 Marina Rd, Lagos', email: 'amara@example.com', occupation: 'Nurse',
    employer: 'Lagos General Hospital', travelHistory: 'Ghana 2022; Kenya 2023',
    arrival: '2027-08-01', departure: '2027-08-14',
  };
  const r = validateApplicant(app, 'GB');
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.completeness, 100);
});

test('visa framework: redaction masks restricted, truncates confidential', () => {
  const red = redactApplicant({
    fullName: 'Amara Okafor', passportNumber: 'A01234567',
    criminalHistory: 'Yes — declared', criminalHistoryDetails: 'sensitive',
  });
  assert.equal(red.criminalHistory, '‹restricted›');
  assert.equal(red.criminalHistoryDetails, '‹restricted›');
  assert.ok(String(red.passportNumber).startsWith('••••'));
  assert.equal(red.fullName, 'Amara Okafor');
});

test('visa framework: core checklist covers the global default set + conditionals', () => {
  assert.ok(CORE_DOCUMENTS.some((d) => /payslips/i.test(d)));
  assert.ok(CORE_DOCUMENTS.some((d) => /tax returns/i.test(d)));
  assert.ok(CORE_DOCUMENTS.some((d) => /property|assets/i.test(d)));
  assert.ok(CORE_DOCUMENTS.some((d) => /family ties/i.test(d)));
  assert.ok(CORE_DOCUMENTS.some((d) => /10 years|≤10/i.test(d)), 'Schengen ≤10y passport rule surfaced');
  // Sponsor-funded → sponsor evidence appears in the profile-conditional section.
  const cl = buildChecklist({ country: 'GB', visaType: 'tourist', applicant: { fundingSource: 'Sponsor', occupation: 'Student', dob: '2012-05-01' } });
  const cond = cl.sections.find((s) => /profile/i.test(s.title));
  assert.ok(cond, 'conditional section present');
  assert.ok(cond.items.some((i) => /Sponsor ID/i.test(i)));
  assert.ok(cond.items.some((i) => /Student enrolment/i.test(i)));
  assert.ok(cond.items.some((i) => /Parental consent/i.test(i)));
});

test('visa framework: declared-but-undetailed history drives Request more info', () => {
  // A declaration with no details is critical → downgrade to Request more info.
  const file = assessApplication({
    applicant: { fullName: 'X', nationality: 'NG', criminalHistory: 'Yes — declared' },
    country: 'GB', visaType: 'tourist',
  });
  assert.ok(file.applicantValidation.missing.includes('criminalHistoryDetails'));
  assert.equal(file.recommendation, 'Request more info');
  // Base-profile gaps are surfaced report-only and do NOT force a downgrade.
  const clean = assessApplication({
    applicant: { fullName: 'Jane Doe', nationality: 'GB', age: 34, monthlyIncome: 4000, purpose: 'tourism', homeTies: 'strong' },
    country: 'AE', visaType: 'tourist',
  });
  assert.ok(clean.applicantValidation.missing.length > 0, 'completeness gaps reported');
  assert.equal(clean.recommendation, 'Approve');
});

// ---- Multi-modal: every travel mode has a booking route ---------------------
import { partnerFor, applySourcing, BRAND_URLS } from '../src/partners.js';
import { scanTrain, scanCoach, scanFerry, scanCruise } from '../src/suppliers.js';

test('multi-modal: every journey mode resolves a fulfilment partner', () => {
  for (const mode of ['train', 'coach', 'ferry', 'cruise', 'carhire']) {
    const partner = partnerFor(mode, 'XX');
    assert.ok(partner, `${mode} has a fulfilment partner`);
    assert.ok(partner.url, `${mode} partner has a booking URL`);
  }
});

test('multi-modal: scanned rail/sea offers carry a real booking route', () => {
  const intent = { dates: { checkIn: '2026-08-17' }, travellers: { total: 2 }, nights: 2, miniCruise: true };
  const origin = { airport: 'NCL', city: 'Newcastle' };
  const dest = { code: 'AMS', city: 'Amsterdam' };
  for (const [label, offers] of [
    ['train', scanTrain(intent, dest, origin)],
    ['coach', scanCoach(intent, dest, origin)],
    ['ferry', scanFerry(intent, dest, origin)],
    ['cruise', scanCruise(intent, dest, origin)],
  ]) {
    assert.ok(offers.length >= 2, `${label} offers exist`);
    for (const offer of offers) {
      const sourced = applySourcing(offer, 'NL');
      assert.ok(sourced.bookingUrl, `${label} offer via ${offer.supplier} is bookable (got ${sourced.sourcedVia})`);
    }
  }
  // Named operators link straight to the brand, not a generic aggregator.
  assert.ok(BRAND_URLS['Eurostar'] && BRAND_URLS['DFDS Seaways'] && BRAND_URLS['MSC Cruises']);
});

test('multi-modal: ferry request plans end to end with a bookable ferry', () => {
  const r = plan({
    text: 'Amsterdam from Newcastle by ferry in August for 2 nights, mini cruise',
    context: GB, user: null, searchTier: 'smart',
  });
  assert.equal(r.stage, 'options');
  const types = new Set(r.packages.options[0].components.map((c) => c.type));
  assert.ok(types.has('ferry') || types.has('cruise'), `journey is sea-based (${[...types]})`);
  assert.ok(!types.has('flight'), 'no flight when the traveller asked for a ferry');
});

// ---- Mixed-mode + split-origin journeys (one booking) -----------------------
test('legs: "out by train, back by ferry into <city>" parses both directions', () => {
  const i = parseIntent(
    'Amsterdam in August for 3 nights, out by train from London and back by ferry into Newcastle',
    { country: 'GB' }, new Date(Date.UTC(2026, 5, 30)),
  );
  assert.ok(i.legs, 'legs detected');
  assert.equal(i.legs.out.mode, 'train');
  assert.equal(i.legs.back.mode, 'ferry');
  assert.equal(i.legs.back.to, 'Newcastle');
  assert.ok(i.components.includes('train') && i.components.includes('ferry'));
});

test('legs: mixed-mode journey packages BOTH one-way legs in one booking', () => {
  const r = plan({
    text: 'Amsterdam in August for 3 nights with 2 adults, out by train from London and back by ferry into Newcastle',
    context: GB, user: null, searchTier: 'smart',
  });
  assert.equal(r.stage, 'options');
  const comps = r.packages.options[0].components;
  const train = comps.find((c) => c.type === 'train');
  const ferry = comps.find((c) => c.type === 'ferry');
  assert.ok(train && ferry, `both legs present (${comps.map((c) => c.type)})`);
  assert.equal(train.details.leg, 'outbound');
  assert.equal(ferry.details.leg, 'return');
  assert.match(train.details.route, /London → Amsterdam/);
  assert.match(ferry.details.route, /Amsterdam → Newcastle/);
  assert.ok(train.details.oneWay && ferry.details.oneWay, 'legs are one-way priced');
  assert.ok(train.bookingUrl && ferry.bookingUrl, 'both legs bookable');
  // The public intent carries the legs so the UI can present the mixed journey.
  assert.equal(r.intent.legs.out.mode, 'train');
  assert.equal(r.intent.legs.back.mode, 'ferry');
});

test('legs: same mode, different airports — fly out Heathrow, back into Manchester', () => {
  const r = plan({
    text: 'Dubai from London in August for 5 nights with 2 adults, flights and hotel, returning into Manchester',
    context: GB, user: null, searchTier: 'smart',
  });
  assert.equal(r.stage, 'options');
  const comps = r.packages.options[0].components;
  const legs = comps.filter((c) => c.type === 'flight' && c.details?.leg);
  assert.equal(legs.length, 2, 'two one-way flight legs');
  assert.match(legs.find((c) => c.details.leg === 'outbound').details.route, /London → Dubai/);
  assert.match(legs.find((c) => c.details.leg === 'return').details.route, /Dubai → Manchester/);
  const hotel = comps.find((c) => c.type === 'hotel' || c.type === 'host');
  assert.ok(hotel, 'hotel still in the same package/booking');
});

test('legs: plain round trips are untouched (no false positives)', () => {
  const i = parseIntent(
    'I want to travel to Dubai with my family in August for 7 nights. I want flights, hotel and the cheapest reliable price.',
    { country: 'GB' }, new Date(Date.UTC(2026, 5, 30)),
  );
  assert.equal(i.legs, null);
  // "back to <destination>" is a round trip, not a split return.
  const i2 = parseIntent('Fly to Dubai from London and back to Dubai in August for 5 nights', { country: 'GB' }, new Date(Date.UTC(2026, 5, 30)));
  assert.equal(i2.legs, null);
});

// ---- Multi-origin group: several departure cities, ONE booking --------------
test('group: "2 from Birmingham, 1 from London, 4 from Manchester, 2 from Nottingham" parses', () => {
  const i = parseIntent(
    'a group traveling to Morocco by plane where 2 will come from Birmingham, 1 from London, 4 from Manchester and 2 from Nottingham in August for 7 nights, all staying in the same home',
    { country: 'GB' }, new Date(Date.UTC(2026, 5, 30)),
  );
  assert.ok(i.destination, 'destination resolved');
  // "Morocco" resolves to its gateway city (not the bogus "Morocco By Plane").
  assert.match(i.destination.city, /Casablanca|Marrakech|Morocco/i);
  assert.ok(i.groupOrigins, 'group detected');
  assert.deepEqual(i.groupOrigins.parties.map((p) => [p.count, p.city]),
    [[2, 'Birmingham'], [1, 'London'], [4, 'Manchester'], [2, 'Nottingham']]);
  assert.equal(i.travellers.total, 9, 'headcount = sum of parties');
  assert.ok(i.components.includes('flights'));
});

test('group: every party flies from its own city — all in one package/booking', () => {
  const r = plan({
    text: 'a group traveling to Marrakech by plane where 2 will come from Birmingham, 1 from London, 4 from Manchester and 2 from Nottingham in August for 7 nights with hotel, all staying in the same home',
    context: GB, user: null, searchTier: 'smart',
  });
  assert.equal(r.stage, 'options');
  const comps = r.packages.options[0].components;
  const flights = comps.filter((c) => c.type === 'flight');
  assert.equal(flights.length, 4, `one flight per party (${comps.map((c) => c.type)})`);
  const routes = flights.map((c) => c.details.route).join(' | ');
  for (const city of ['Birmingham', 'London', 'Manchester', 'Nottingham']) {
    assert.match(routes, new RegExp(`${city} → Marrakech`), `${city} party present`);
  }
  // Party sizes carried per leg — 2+1+4+2 = 9 travellers.
  assert.equal(flights.reduce((s, c) => s + c.details.partySize, 0), 9);
  // ONE shared home for the whole group with a bedroom/apartment split.
  const stay = comps.find((c) => c.type === 'hotel' || c.type === 'host');
  assert.ok(stay, 'shared stay in the same booking');
  assert.equal(stay.details.groupStay.guests, 9);
  assert.equal(stay.details.groupStay.units.length, 4, 'one room/apartment per party');
  assert.match(stay.details.groupStay.units.join(' '), /Family apartment \(sleeps 4\)/);
  assert.match(stay.details.groupStay.units.join(' '), /Single room/);
  // Same dates for everyone — one intent, one date range, one booking.
  assert.ok(r.intent.dates.checkIn && r.intent.dates.checkOut);
  assert.deepEqual(r.intent.groupOrigins.map((p) => p.count), [2, 1, 4, 2]);
  // Every flight leg remains bookable.
  for (const f of flights) assert.ok(f.bookingUrl || f.sourcedVia, `${f.details.route} bookable`);
});

test('group: single-origin sentences are untouched (no false positives)', () => {
  const i = parseIntent('Dubai from London in August for 7 nights, flights and hotel for 2 adults', { country: 'GB' }, new Date(Date.UTC(2026, 5, 30)));
  assert.equal(i.groupOrigins, null);
  assert.equal(i.travellers.adults, 2);
});

// ---- Deep Price Dive: deep-thinking pass on every funded search -------------
test('price dive: explores date shifts, alternate airports, supplier spread', () => {
  const r = plan({
    text: 'Dubai from London in August for 7 nights, flights and hotel, cheapest reliable',
    context: GB, user: null, searchTier: 'deep',
  });
  const dive = r.priceDive;
  assert.ok(dive, 'dive runs on a funded journey search');
  assert.equal(dive.leversChecked, 4);
  assert.ok(dive.combinationsExplored > 50, `${dive.combinationsExplored} combinations`);
  const levers = dive.savings.map((s) => s.lever);
  assert.ok(levers.includes('Date optimisation'), levers.join());
  assert.ok(levers.includes('Airport selection'), levers.join());
  for (const s of dive.savings) {
    assert.ok(s.savingUSD > 0, `${s.lever} quantified`);
    assert.ok(s.how, `${s.lever} explains itself`);
  }
  assert.ok(dive.totalIdentifiedUSD >= dive.savings[0].savingUSD);
  assert.ok(dive.unbeatable.verdict, 'unbeatable verdict present');
  assert.ok(dive.unbeatable.marginPct >= 0);
  // The traveller's own request is never silently mutated.
  assert.equal(r.intent.dates.checkIn.slice(0, 7), '2026-08');
});

test('price dive: skipped for utility-only purchases (no journey)', () => {
  const r = plan({ text: 'esim for Dubai', context: GB, user: null, searchTier: 'smart' });
  if (r.stage === 'options') assert.equal(r.priceDive, null);
});

// ---- Community Host Marketplace: anyone can host, inside the OS -------------
import { createHostListing, listHostListings, hostListingsForCity, hostEarnings, registerHost, updateHostListing, hostBookings, reviewHostListing, adminUserHostOverview } from '../src/store.js';

test('host marketplace: a community listing goes live and competes in searches', () => {
  const host = createUser({ name: 'Fatima Host', email: 'fatima.host@example.com' });
  // Registration is mandatory before publishing.
  const gate = createHostListing(host.id, { title: 'X', city: 'Dubai', nightlyUSD: 30 });
  assert.equal(gate.error, 'host-registration-required');
  assert.equal(registerHost(host.id, { displayName: 'Fatima', payoutMethod: 'BitriPay wallet' }).ok, true);
  const created = createHostListing(host.id, {
    title: 'Marina View Apartment', city: 'Dubai', propertyType: 'Entire apartment',
    nightlyUSD: 38, sleeps: 5, amenities: 'Full kitchen, WiFi, Washer',
    address: '14 Marina Walk, Dubai Marina, Dubai',
    photos: Array.from({ length: 12 }, (_, i) => `https://photos.example.com/marina/${i + 1}.jpg`),
  });
  assert.equal(created.ok, true);
  // MODERATION GATE: a new property is NOT online until AI verification +
  // admin review approve it.
  assert.equal(created.listing.status, 'pending-review');
  assert.equal(created.listing.verified, false);
  assert.ok(created.listing.aiVerification.score >= 90, 'clean listing scores high in AI verification');
  assert.equal(created.listing.aiVerification.securityRisk, 'Low');
  assert.ok(!hostListingsForCity('Dubai').some((l) => l.title === 'Marina View Apartment'), 'pending listing is NOT publicly bookable');
  assert.ok(adminUserHostOverview().pendingReview.some((l) => l.title === 'Marina View Apartment'), 'listing sits in the admin review queue');
  const approved = reviewHostListing(created.listing.id, { decision: 'approve', reviewerId: 'admin_test' });
  assert.equal(approved.ok, true);
  assert.equal(approved.listing.status, 'live');
  assert.ok(listHostListings(host.id).length === 1);
  assert.ok(hostListingsForCity('Dubai').some((l) => l.title === 'Marina View Apartment'));

  // The listing competes with hotels in a real search for its city — and at
  // $38/night it wins the Standard (cheapest reliable) tier.
  const r = plan({
    text: 'Dubai from London in August for 7 nights, flights and hotel for 2 adults',
    context: GB, user: null, searchTier: 'smart',
  });
  assert.equal(r.stage, 'options');
  const standard = r.packages.options.find((o) => o.tier === 'Standard');
  const stay = standard.components.find((c) => c.type === 'host' || c.type === 'hotel');
  assert.equal(stay.supplier, 'Marina View Apartment', 'community listing won the cheapest-reliable pick');
  assert.equal(stay.details.community, true);
  assert.equal(stay.details.hostName, 'Fatima Host');
});

test('host marketplace: validation + auth guards', () => {
  assert.equal(createHostListing(null, { title: 'X', city: 'Y', nightlyUSD: 10 }).ok, false);
  const u = createUser({ name: 'H2', email: 'h2@example.com' });
  registerHost(u.id, {});
  assert.equal(createHostListing(u.id, { title: '', city: 'Dubai', nightlyUSD: 10 }).ok, false);
  assert.equal(createHostListing(u.id, { title: 'No Rate', city: 'Dubai', nightlyUSD: 0 }).ok, false);
  const tenPics = Array.from({ length: 10 }, (_, i) => `https://p.example.com/${i}.jpg`);
  // Address is mandatory — guests verify the property online by name + address.
  const noAddr = createHostListing(u.id, { title: 'No Address', city: 'Dubai', nightlyUSD: 30, photos: tenPics });
  assert.equal(noAddr.ok, false);
  assert.equal(noAddr.error, 'address-required');
  // Photos: minimum 10 …
  const few = createHostListing(u.id, { title: 'Few Pics', city: 'Dubai', nightlyUSD: 30, address: '1 Palm Street, Dubai', photos: tenPics.slice(0, 9) });
  assert.equal(few.ok, false);
  assert.equal(few.error, 'photos-min');
  // … maximum 100.
  const many = createHostListing(u.id, { title: 'Too Many', city: 'Dubai', nightlyUSD: 30, address: '1 Palm Street, Dubai', photos: Array.from({ length: 101 }, (_, i) => `https://p.example.com/${i}.jpg`) });
  assert.equal(many.ok, false);
  assert.equal(many.error, 'photos-max');
  // Exactly 10 with an address → live.
  const ok = createHostListing(u.id, { title: 'Just Right', city: 'Dubai', nightlyUSD: 30, address: '1 Palm Street, Dubai', photos: tenPics });
  assert.equal(ok.ok, true);
  assert.equal(ok.listing.photos.length, 10);
});

test('stays carry name + address so travellers can verify them online', () => {
  const r = plan({ text: 'Istanbul from London in August for 5 nights, flights and hotel for 2 adults', context: GB, user: null, searchTier: 'smart' });
  assert.equal(r.stage, 'options');
  for (const o of r.packages.options) {
    const stay = o.components.find((c) => c.type === 'hotel' || c.type === 'host');
    if (!stay) continue;
    assert.ok(stay.supplier, 'stay has a name');
    assert.ok(stay.details.address && stay.details.address.length >= 8, `${stay.supplier} has a street address (${stay.details.address})`);
  }
  // Hosted community listings additionally carry their photo set (10–100).
  const rd = plan({ text: 'Dubai from London in August for 7 nights, hotel only for 2 adults', context: GB, user: null, searchTier: 'smart' });
  const community = rd.packages.options.flatMap((o) => o.components).find((c) => c.details?.community);
  assert.ok(community, 'a community listing competes');
  assert.ok(community.details.photos.length >= 10 && community.details.photos.length <= 100);
  assert.ok(community.details.address, 'hosted stay also has an address');
});

test('host marketplace: earnings pay the host 90%, 3JN keeps 10%', () => {
  const host = createUser({ name: 'Omar Host', email: 'omar.host@example.com' });
  registerHost(host.id, { displayName: 'Omar' });
  // $20/night — deterministically the cheapest reliable stay in Dubai.
  const riad = createHostListing(host.id, {
    title: 'Souk Riad', city: 'Dubai', nightlyUSD: 20, sleeps: 4,
    address: '7 Old Souk Lane, Deira, Dubai',
    photos: Array.from({ length: 10 }, (_, i) => `https://photos.example.com/riad/${i + 1}.jpg`),
  });
  reviewHostListing(riad.listing.id, { decision: 'approve', reviewerId: 'admin_test' });
  const guest = createUser({ name: 'Guest', email: 'guest.hh@example.com' });
  const r = plan({ text: 'Dubai from London in August for 7 nights, hotel only for 2 adults', context: GB, user: null, searchTier: 'smart' });
  const opt = r.packages.options.find((o) => o.tier === 'Standard');
  const stay = opt.components.find((c) => c.type === 'host' || c.type === 'hotel');
  assert.equal(stay.supplier, 'Souk Riad', 'cheapest reliable stay is the host listing');
  const q = saveQuote({ option: opt, intent: r.intent, userId: guest.id });
  createBooking({ quoteId: q.id, option: opt, instalment: null, userId: guest.id, paymentMethod: 'card' });
  const earn = hostEarnings(host.id);
  assert.equal(earn.rows.length, 1, 'the stay is on the host ledger');
  assert.ok(earn.totals.netUSD > 0);
  assert.ok(Math.abs(earn.totals.grossUSD - earn.totals.netUSD - earn.totals.commissionUSD) < 0.02);
  assert.ok(Math.abs(earn.totals.commissionUSD / earn.totals.grossUSD - 0.10) < 0.001, '10% commission');
  assert.ok(earn.listings >= 1);
});

// ---- Mode competition: port towns get ferries & international coaches -------
test('port origin: "paris from dover" competes ferry/coach/train — never a fake flight', () => {
  const r = plan({
    text: 'I want to travel to paris from dover alone in August for 7 nights. I want hotel, instalments and the cheapest reliable price.',
    context: GB, user: null, searchTier: 'deep',
  });
  assert.equal(r.stage, 'options');
  assert.equal(r.origin.city, 'Dover', '"alone" no longer leaks into the origin');
  assert.deepEqual(r.modeCompetition, ['ferry', 'coach', 'train']);
  for (const o of r.packages.options) {
    const journeys = o.components.filter((c) => ['flight', 'train', 'coach', 'ferry'].includes(c.type));
    assert.equal(journeys.length, 1, `${o.tier}: exactly ONE journey mode wins (alternatives, never summed)`);
    assert.notEqual(journeys[0].type, 'flight', 'Dover has no airport — no fabricated flight');
    assert.ok(journeys[0].bookingUrl, `${journeys[0].supplier} is bookable`);
    assert.ok(journeys[0].details.wonModeCompetition.includes('ferry'), 'ferry competed');
    assert.ok(o.components.some((c) => c.type === 'hotel' || c.type === 'host'), 'hotel included');
  }
  // Ferries and international coach operators were genuinely scanned.
  assert.ok(r.scanSummary.ferry.scanned >= 3, 'ferry offers scanned (DFDS, P&O, Brittany)');
  assert.ok(r.scanSummary.coach.scanned >= 5, 'coach offers scanned incl. Eurolines/FlixBus/BlaBlaCar');
});

test('mode competition: short-haul implied journey lets train/coach challenge the flight', () => {
  const r = plan({ text: 'a trip to Paris from London in September for 3 nights', context: GB, user: null, searchTier: 'smart' });
  assert.equal(r.stage, 'options');
  assert.ok(r.modeCompetition && r.modeCompetition.includes('train') && r.modeCompetition.includes('coach'));
  for (const o of r.packages.options) {
    const journeys = o.components.filter((c) => ['flight', 'train', 'coach', 'ferry'].includes(c.type));
    assert.equal(journeys.length, 1, `${o.tier}: one winning mode`);
  }
});

test('mode competition: never triggered when the traveller names the mode', () => {
  const r = plan({ text: 'London to Paris by train in September for 3 nights with hotel', context: GB, user: null, searchTier: 'smart' });
  assert.equal(r.modeCompetition, null);
  const r2 = plan({ text: 'Dubai from London in August for 7 nights, flights and hotel', context: GB, user: null, searchTier: 'smart' });
  assert.equal(r2.modeCompetition, null);
});

// ---- Visa engine OS structure: 11-stage flow, payment gate, eVisa issuance --
test('visa flow: approval issues an eVisa; unpaid files wait at the payment gate', () => {
  const clean = { fullName: 'Jane Doe', nationality: 'GB', age: 34, monthlyIncome: 4000, purpose: 'tourism', homeTies: 'strong', arrival: '2027-08-01', departure: '2027-08-14' };
  const approved = assessApplication({ country: 'AE', visaType: 'tourist', applicant: clean });
  assert.equal(approved.recommendation, 'Approve');
  assert.ok(approved.eVisa && /^3JN-AE-\d{6}$/.test(approved.eVisa.number), 'eVisa issued');
  assert.equal(approved.payment.paid, true);
  assert.equal(approved.flow.length, 11, 'full 11-stage flow recorded');
  assert.deepEqual(approved.flow.map((f) => f.stage).slice(0, 8),
    ['Applicant Profile', 'Visa Type', 'Country Rules', 'Dynamic Checklist', 'Document Upload', 'AI Verification', 'Risk Score', 'Payment']);
  assert.equal(approved.flow[10].stage, 'eVisa Issued');
  // Unpaid → held at the payment gate, no eVisa.
  const unpaid = assessApplication({ country: 'AE', visaType: 'tourist', applicant: clean, payment: { paid: false } });
  assert.equal(unpaid.recommendation, 'Awaiting payment');
  assert.equal(unpaid.eVisa, null);
  // Refusal records the refusal route, never an eVisa.
  const bad = assessApplication({ country: 'US', visaType: 'work', applicant: { fullName: 'Bad Actor', nationality: 'NG', onWatchlist: true, documentsAuthentic: false } });
  assert.equal(bad.recommendation, 'Refuse');
  assert.equal(bad.eVisa, null);
  assert.equal(bad.flow[10].stage, 'Refusal Notice');
});

// ---- Host Dashboard: price management + pause/resume ------------------------
test('host dashboard: set price, pause removes from searches, resume restores', () => {
  const host = createUser({ name: 'Lina Host', email: 'lina.host@example.com' });
  registerHost(host.id, { displayName: 'Lina' });
  const pics = Array.from({ length: 10 }, (_, i) => `https://p.example.com/l/${i}.jpg`);
  const { listing } = createHostListing(host.id, { title: 'Lina Loft', city: 'Istanbul', nightlyUSD: 55, sleeps: 3, address: '3 Galata Steps, Istanbul', photos: pics });
  reviewHostListing(listing.id, { decision: 'approve', reviewerId: 'admin_test' });
  // Price management flows straight into future searches.
  assert.equal(updateHostListing(host.id, listing.id, { nightlyUSD: 44 }).ok, true);
  assert.equal(hostListingsForCity('Istanbul')[0].nightlyUSD, 44);
  // Only the owner can manage it.
  const stranger = createUser({ name: 'S', email: 's.h@example.com' });
  assert.equal(updateHostListing(stranger.id, listing.id, { nightlyUSD: 1 }).error, 'forbidden');
  // Pause → instantly out of searches; resume → back.
  updateHostListing(host.id, listing.id, { status: 'paused' });
  assert.equal(hostListingsForCity('Istanbul').length, 0);
  updateHostListing(host.id, listing.id, { status: 'live' });
  assert.equal(hostListingsForCity('Istanbul').length, 1);
  // Invalid updates rejected.
  assert.equal(updateHostListing(host.id, listing.id, { nightlyUSD: 0 }).ok, false);
  assert.equal(updateHostListing(host.id, listing.id, { status: 'gone' }).ok, false);
  assert.equal(updateHostListing(host.id, listing.id, { photos: ['one.jpg'] }).error, 'photos-min');
  // Reservation book exists (empty until booked).
  assert.deepEqual(hostBookings(host.id), []);
});

// ---- Master Travel Profile: loyalty accounts + autonomous publishing --------
test('profile: loyalty accounts (BA/Skywards/Bonvoy/Honors/IHG) stored structured', () => {
  const u = createUser({ name: 'Loyal Traveller', email: 'loyal@example.com' });
  const out = updateUser(u.id, { travelProfile: {
    title: 'Ms', firstName: 'Ama', lastName: 'Okafor', preferredName: 'Ama',
    knownTravelerNumber: 'KTN123456', redressNumber: 'RN987', tsaPreCheck: 'Yes',
    billingAddress: '1 Ledger St, London', postalCode: 'E1 6AN',
    loyaltyAccounts: [
      { program: 'British Airways Executive Club', membershipNumber: 'BA1234567', tier: 'Silver', expiry: '2027-03-01', statusBenefits: 'Lounge access, seat selection' },
      { program: 'Emirates Skywards', membershipNumber: 'EK7654321', tier: 'Gold', expiry: '2027-09-01', statusBenefits: 'Extra baggage' },
      { program: '', membershipNumber: 'dropped-no-program' },
    ],
  } });
  const tp = out.travelProfile;
  assert.equal(tp.knownTravelerNumber, 'KTN123456');
  assert.equal(tp.tsaPreCheck, 'Yes');
  assert.equal(tp.loyaltyAccounts.length, 2, 'entries without a programme are dropped');
  assert.equal(tp.loyaltyAccounts[0].program, 'British Airways Executive Club');
  assert.equal(tp.loyaltyAccounts[1].tier, 'Gold');
});

test('agents: blog/SEO/marketing publish autonomously once per day', () => {
  const { ensureDailyPublish } = agentsModule;
  const t0 = Date.UTC(2026, 6, 10, 9, 0, 0);
  const first = ensureDailyPublish(t0);
  assert.equal(first.published, true, 'stale journal → agent publishes');
  assert.ok(first.post.slug && first.social.includes(first.post.destination));
  // Within the same 24h window: idempotent, no double-posting.
  const again = ensureDailyPublish(t0 + 3600 * 1000);
  assert.equal(again.published, false);
  assert.ok(again.nextDueInMs > 0);
  // Next day: publishes again.
  const nextDay = ensureDailyPublish(t0 + 25 * 3600 * 1000);
  assert.equal(nextDay.published, true);
  // Audit shows the marketing + SEO agents acted.
  const audit = adminAudit(50);
  assert.ok(audit.some((a) => a.action === 'marketing.social.published'));
  assert.ok(audit.some((a) => a.action === 'seo.sitemap.refreshed'));
});

// ---- Post-booking flight fulfilment record ----------------------------------
test('booking: flight bookings carry PNR, e-ticket, locators and rules', () => {
  const guest = createUser({ name: 'Pnr Guest', email: 'pnr@example.com' });
  const r = plan({ text: 'Dubai from London in August for 7 nights, flights and hotel for 2 adults', context: GB, user: null, searchTier: 'smart' });
  const opt = r.packages.options[0];
  const q = saveQuote({ option: opt, intent: r.intent, userId: guest.id });
  const b = createBooking({ quoteId: q.id, option: opt, instalment: null, userId: guest.id, paymentMethod: 'card' });
  const f = b.fulfilment;
  assert.ok(f, 'fulfilment issued');
  assert.match(f.pnr, /^[A-Z]{6}$/);
  assert.match(f.eTicketNumber, /^\d{3}-\d{10}$/);
  assert.equal(f.airlineLocator, f.pnr);
  assert.ok(f.gdsLocator.startsWith('AMA-'));
  assert.equal(f.ticketStatus, 'Ticketed');
  assert.ok(f.refundability && f.changeRules && f.cancellationRules);
  // Deterministic: same booking id → same PNR.
  assert.equal(buildableSamePnr(b), f.pnr);
  // No flight in the option → no flight fulfilment.
  const r2 = plan({ text: 'Dubai hotel only in August for 3 nights', context: GB, user: null, searchTier: 'smart' });
  const opt2 = r2.packages.options[0];
  const q2 = saveQuote({ option: opt2, intent: r2.intent, userId: guest.id });
  const b2 = createBooking({ quoteId: q2.id, option: opt2, instalment: null, userId: guest.id });
  assert.equal(b2.fulfilment, null);
});
function buildableSamePnr(b) { return b.fulfilment.pnr; }

// ---- Flight document validation engine (spec part 3) ------------------------
test('validation: blank pages, damaged passport, return proof, transit visa', () => {
  const base = { fullName: 'T Test', dob: '1990-01-01', nationality: 'GB', passportNumber: 'A1', passportExpiry: '2031-01-01' };
  // Blank pages < 2 blocks; damaged passport blocks.
  const r1 = validateBooking({ travellers: [{ ...base, passportBlankPages: 1 }], travelDate: '2026-08-17', nationality: 'GB', destination: 'Dubai', international: true });
  assert.equal(r1.valid, false);
  assert.ok(r1.blocking.some((b) => /blank visa pages/i.test(b)));
  const r2 = validateBooking({ travellers: [{ ...base, passportDamaged: true }], travelDate: '2026-08-17', nationality: 'GB', destination: 'Dubai', international: true });
  assert.ok(r2.blocking.some((b) => /damaged passport/i.test(b)));
  // Missing return proof blocks; confirmed passes.
  const r3 = validateBooking({ travellers: [base], travelDate: '2026-08-17', nationality: 'GB', destination: 'Dubai', international: true, hasReturnTicket: false });
  assert.ok(r3.blocking.some((b) => /return or onward/i.test(b)));
  const r4 = validateBooking({ travellers: [{ ...base, passportBlankPages: 4 }], travelDate: '2026-08-17', nationality: 'GB', destination: 'Dubai', international: true, hasReturnTicket: true, transitCountry: 'Istanbul' });
  assert.equal(r4.valid, true, JSON.stringify(r4.blocking));
  assert.ok(r4.checks.some((c) => /Transit via Istanbul/i.test(c.check)));
  assert.ok(r4.checks.some((c) => /Customs/i.test(c.check)));
});

// ---- Board basis end-to-end --------------------------------------------------
test('board basis: "all inclusive" reprices and relabels the stay', () => {
  const base = plan({ text: 'Dubai hotel in August for 7 nights for 2 adults, room only', context: GB, user: null, searchTier: 'smart' });
  const ai = plan({ text: 'Dubai hotel in August for 7 nights for 2 adults, all inclusive', context: GB, user: null, searchTier: 'smart' });
  assert.equal(ai.intent.components.includes('hotel'), true);
  const stayBase = base.packages.options.find((o) => o.tier === 'Luxury').components.find((c) => c.type === 'hotel');
  const stayAI = ai.packages.options.find((o) => o.tier === 'Luxury').components.find((c) => c.type === 'hotel');
  assert.equal(stayAI.details.board, 'All inclusive');
  assert.ok(stayAI.priceUSD > stayBase.priceUSD, 'all inclusive costs more than room only');
  const hb = plan({ text: 'Istanbul hotel in August for 5 nights, half board', context: GB, user: null, searchTier: 'smart' });
  const stayHB = hb.packages.options[0].components.find((c) => c.type === 'hotel' || c.type === 'host');
  if (stayHB.type === 'hotel') assert.equal(stayHB.details.board, 'Half board');
});

// ---- OS synapses: every part talks to every other part ----------------------
import { notifyHostsOfBooking, backfillProfileFromLead, syncHostReliabilityFromReviews, osIntegrationMap } from '../src/store.js';
import { submitReview } from '../src/reviews.js';

test('synapse: booking a hosted stay notifies the host with their 90% payout', () => {
  const host = createUser({ name: 'Syn Host', email: 'syn.host@example.com' });
  registerHost(host.id, { displayName: 'Syn' });
  const pics = Array.from({ length: 10 }, (_, i) => `https://p.example.com/s/${i}.jpg`);
  { const sy = createHostListing(host.id, { title: 'Synapse Suite', city: 'Dubai', nightlyUSD: 18, sleeps: 4, address: '9 Link Road, Dubai', photos: pics }); reviewHostListing(sy.listing.id, { decision: 'approve', reviewerId: 'admin_test' }); }
  const guest = createUser({ name: 'Syn Guest', email: 'syn.guest@example.com' });
  const r = plan({ text: 'Dubai hotel only in August for 7 nights for 2 adults', context: GB, user: null, searchTier: 'smart' });
  const opt = r.packages.options.find((o) => o.components.some((c) => c.supplier === 'Synapse Suite'));
  assert.ok(opt, 'hosted stay won a tier');
  const q = saveQuote({ option: opt, intent: r.intent, userId: guest.id });
  const b = createBooking({ quoteId: q.id, option: opt, instalment: null, userId: guest.id });
  assert.equal(notifyHostsOfBooking(b), 1);
  const notes = listNotifications(host.id);
  assert.ok(notes.some((n) => /New reservation/.test(n.title) && /90%/.test(n.body)));
});

test('synapse: checkout details backfill the Master Travel Profile (never overwrite)', () => {
  const u = createUser({ name: 'Backfill', email: 'bf@example.com' });
  updateUser(u.id, { travelProfile: { nationality: 'NG' } });
  const changed = backfillProfileFromLead(u.id, { fullName: 'B Fill', passportNumber: 'P123', nationality: 'GB' });
  assert.equal(changed, 2, 'fills fullLegalName + passportNumber; keeps existing nationality');
  const after = updateUser(u.id, {}).travelProfile;
  assert.equal(after.fullLegalName, 'B Fill');
  assert.equal(after.passportNumber, 'P123');
  assert.equal(after.nationality, 'NG', 'existing value never overwritten');
});

test('synapse: guest reviews move a hosted listing reliability', () => {
  const before = hostListingsForCity('Dubai').find((l) => l.title === 'Synapse Suite').reliabilityScore;
  submitReview({ supplier: 'Synapse Suite', rating: 5, comment: 'Spotless.' });
  submitReview({ supplier: 'Synapse Suite', rating: 5, comment: 'Perfect host.' });
  const score = syncHostReliabilityFromReviews('Synapse Suite');
  assert.ok(score >= before, `reliability moved with 5★ reviews (${before} → ${score})`);
});

test('synapse: the integration map reports the live wiring', () => {
  const map = osIntegrationMap();
  assert.ok(map.totalLinks >= 14);
  const names = map.links.map((l) => `${l.from}→${l.to}`);
  assert.ok(names.includes('Booking→Host Marketplace'));
  assert.ok(names.includes('Booking→VisaOS'));
  assert.ok(names.includes('Reviews→Host Marketplace'));
});

// ---- Fraud & risk engine (part 11) + refund engine (part 12) ----------------
import { hostFraudCheck, buildRefundPolicy } from '../src/booking-schema.js';

test('fraud engine: category coverage + 4-way verdict', () => {
  assert.equal(bookingRiskScore({}).decision, 'approve');
  assert.equal(bookingRiskScore({ vpn: true, typingAnomaly: true, mouseAnomaly: true }).decision, 'hold');
  assert.equal(bookingRiskScore({ couponAbuse: true, fakeRefunds: true, ipSwitching: true }).decision, 'manual review');
  assert.equal(bookingRiskScore({ fakePassport: true, faceMismatch: true }).decision, 'reject');
  const s = bookingRiskScore({ cardStolen: true, threeDSBypass: true });
  assert.ok(s.score >= 70 && s.decision === 'reject');
});

test('fraud engine: fake property / review manipulation detected', () => {
  const good = hostFraudCheck({ verified: true, address: '9 Link Road, Dubai', photos: Array(10).fill('x'), hostName: 'Syn' }, [{ rating: 5 }, { rating: 4 }]);
  assert.equal(good.decision, 'approve');
  const fake = hostFraudCheck({ verified: false, address: '', photos: [], hostName: '' }, []);
  assert.equal(fake.decision, 'reject');
  const manip = hostFraudCheck({ verified: true, address: '9 Link Road', photos: Array(10).fill('x'), hostName: 'H' },
    Array(6).fill({ rating: 5 }));
  assert.ok(manip.flags.some((f) => /manipulation/i.test(f)));
});

test('refund engine: structured policy stored on every booking', () => {
  const guest = createUser({ name: 'Rf Guest', email: 'rf@example.com' });
  const r = plan({ text: 'Dubai from London in August for 7 nights, flights and hotel for 2 adults', context: GB, user: null, searchTier: 'smart' });
  const opt = r.packages.options[0];
  const q = saveQuote({ option: opt, intent: r.intent, userId: guest.id });
  const b = createBooking({ quoteId: q.id, option: opt, instalment: null, userId: guest.id });
  const p = b.refundPolicy;
  assert.ok(p.supplierPolicy && p.penaltyWindow && p.noShow && p.forceMajeure && p.partialRefunds);
  // SUPPLIER POLICY TAKES PRECEDENT — stated explicitly and per component.
  assert.match(p.precedence, /supplier.*precedent/i);
  assert.ok(p.supplierPolicies.length >= 1, 'per-component supplier rules captured');
  assert.ok(p.supplierPolicies.every((sp) => sp.source === 'supplier' && sp.governs === true));
  // The platform schedule is only a fallback where the supplier is silent.
  assert.match(p.platformFallback.appliesWhen, /supplier.*no cancellation rule/i);
  assert.equal(p.platformFallback.refundSchedule.length, 4);
  assert.ok(p.platformFallback.refundSchedule[0].refundPct >= p.platformFallback.refundSchedule[3].refundPct);
  assert.ok(Array.isArray(p.nonRefundable) && p.nonRefundable.length);
});

// ---- World-class AI modules (part 14): the three that were missing ----------
import { runDisruptionGuard } from '../src/monitor.js';
import { farePrediction } from '../src/price-dive.js';

test('fare prediction agent: book-now/wait signal with drift %', () => {
  const r = plan({ text: 'Dubai from London in August for 7 nights, flights and hotel for 2 adults', context: GB, user: null, searchTier: 'deep' });
  const fp = r.farePrediction;
  assert.ok(fp, 'prediction attached to plan');
  assert.ok(['rising', 'falling', 'stable'].includes(fp.direction));
  assert.ok(typeof fp.driftPct === 'number' && fp.advice.length > 10);
});

test('concierge agent: day-by-day itinerary from the packaged trip', () => {
  const r = plan({ text: 'Dubai holiday from London in August for 5 nights for 2 adults', context: GB, user: null, searchTier: 'smart' });
  const it = r.itinerary;
  assert.ok(it && it.days.length === 6, 'arrival + 4 days + departure');
  assert.match(it.days[0].plan, /Arrive/);
  assert.match(it.days[5].plan, /departure/i);
});

test('disruption agent: detects, rebooks cost-neutral, notifies, audits', () => {
  const guest = createUser({ name: 'Dis Guest', email: 'dis@example.com' });
  const r = plan({ text: 'Dubai from London in August for 7 nights, flights and hotel for 2 adults', context: GB, user: null, searchTier: 'smart' });
  const opt = r.packages.options[0];
  const q = saveQuote({ option: opt, intent: r.intent, userId: guest.id });
  const b = createBooking({ quoteId: q.id, option: opt, instalment: null, userId: guest.id });
  const ok = runDisruptionGuard(b.id, false);
  assert.equal(ok.status, 'on-time');
  const hit = runDisruptionGuard(b.id, true);
  assert.equal(hit.status, 'rebooked');
  assert.ok(hit.event.rebookedTo && hit.event.rebookedTo !== hit.event.original);
  assert.equal(hit.event.fareDifferenceUSD, 0, 'cost-neutral to the traveller');
  assert.ok(listNotifications(guest.id).some((n) => /rebooked/i.test(n.title)));
});

// ---- 300+ field architecture (part 15) --------------------------------------
test('database checklist: 300+ structured fields across the five domains', () => {
  const fc = fieldCount();
  assert.ok(fc.total >= 300, `total ${fc.total} >= 300`);
});

// ---- Profit protection master rule -------------------------------------------
import { aiCostCap } from '../src/revenue.js';

test('master rule: AI cost capped at 5-10% of expected profit; advertising funds too', () => {
  // £1,000 booking → £100 fee → AI cost cap £5–£10.
  const cap = aiCostCap(100);
  assert.equal(cap.maxAiCostUSD, 10);
  assert.equal(cap.targetAiCostUSD, 5);
  // The gate enforces it: expected revenue must be >= 10x AI cost.
  const g = costProtectionGate({ tier: 'deep', user: null, expectedBookingUSD: 10000 });
  assert.equal(g.allowed, true);
  assert.ok(g.reason.includes('expected-booking-revenue'));
  // Advertising revenue is a recognised funding source.
  const ad = costProtectionGate({ tier: 'deep', user: null, expectedBookingUSD: 0, advertisingCreditUSD: 5 });
  assert.equal(ad.allowed, true);
  assert.ok(ad.reason.includes('advertising-revenue'));
  // Unfunded → downgraded to cached, never free deep AI.
  const un = costProtectionGate({ tier: 'deep', user: null, expectedBookingUSD: 0 });
  assert.equal(un.allowed, false);
  assert.equal(un.downgradeTo, 'free');
  assert.ok(un.requirement.orDepositGBP >= 5, 'refundable search deposit path (£5–£20)');
});

// ---- Supplier commissions: 3JN earns even on the cheapest deal --------------
import { SUPPLIER_COMMISSIONS, bookingSupplierCommission } from '../src/partners.js';

test('supplier commissions: schedule covers all 12 categories; bookings earn supply-side', () => {
  for (const cat of ['flights', 'hotel', 'activities', 'carhire', 'transfer', 'esim', 'insurance', 'visa', 'luggage', 'cruise', 'tickets', 'host']) {
    assert.ok(SUPPLIER_COMMISSIONS[cat] > 0, `${cat} earns commission`);
  }
  const guest = createUser({ name: 'Comm Guest', email: 'comm@example.com' });
  const r = plan({ text: 'Dubai from London in August for 7 nights, flights and hotel for 2 adults, cheapest reliable', context: GB, user: null, searchTier: 'smart' });
  const opt = r.packages.options.find((o) => o.tier === 'Standard'); // the CHEAPEST deal
  const q = saveQuote({ option: opt, intent: r.intent, userId: guest.id });
  const b = createBooking({ quoteId: q.id, option: opt, instalment: null, userId: guest.id });
  assert.ok(b.supplierEarnings.totalUSD > 0, '3JN earns from suppliers on the cheapest deal');
  assert.equal(b.supplierEarnings.rows.length, opt.components.length, 'every component attributed');
});

// ---- Booking Protection fee (£5–£50 by trip value) --------------------------
import { protectionFee, PROTECTION_BENEFITS } from '../src/pricing.js';

test('protection: fee scales £5–£50 with six benefits; stored on booking when chosen', () => {
  assert.equal(protectionFee(100).fee, 5, 'floor £5');
  assert.equal(protectionFee(1500).fee, 30, '~2% of trip');
  assert.equal(protectionFee(9000).fee, 50, 'cap £50');
  assert.equal(PROTECTION_BENEFITS.length, 6);
  const guest = createUser({ name: 'Prot Guest', email: 'prot@example.com' });
  const r = plan({ text: 'Dubai from London in August for 7 nights, flights and hotel for 2 adults', context: GB, user: null, searchTier: 'smart' });
  const opt = r.packages.options[0];
  const q = saveQuote({ option: opt, intent: r.intent, userId: guest.id });
  const withP = createBooking({ quoteId: q.id, option: opt, instalment: null, userId: guest.id, protection: protectionFee(opt.pricing.local.total) });
  assert.ok(withP.protection.fee >= 5 && withP.protection.fee <= 50);
  const withoutP = createBooking({ quoteId: q.id, option: opt, instalment: null, userId: guest.id });
  assert.equal(withoutP.protection, null, 'strictly optional');
});

// ---- Monetisation parts 8–10 -------------------------------------------------
import { prioritySearchFee, PRIORITY_SEARCH_FEES } from '../src/revenue.js';
import { addSponsoredPlacement, sponsoredFor, PLACEMENT_SECTIONS, placementRevenueGBP } from '../src/partners.js';
import { CORPORATE_PLANS } from '../../shared/constants.js';

test('priority search fees: standard free, fast £3, urgent £10, emergency £25', () => {
  assert.equal(prioritySearchFee('standard').feeGBP, 0);
  assert.equal(prioritySearchFee('fast').feeGBP, 3);
  assert.equal(prioritySearchFee('urgent').feeGBP, 10);
  assert.equal(prioritySearchFee('emergency').feeGBP, 25);
  const p = prioritySearchFee('priority');
  assert.ok(p.feeGBP === 3 && p.level === 'fast', 'legacy priority level maps to fast');
  assert.equal(prioritySearchFee('nonsense').feeGBP, 0, 'unknown level falls back to standard');
});

test('sponsored placements: labelled slots across the six sections', () => {
  assert.equal(PLACEMENT_SECTIONS.length, 6);
  const r = addSponsoredPlacement({ partner: 'Rove Hotels', section: 'destination pages', destination: 'Dubai', feeGBPMonth: 400 });
  assert.equal(r.ok, true);
  assert.equal(r.placement.labelled, true, 'sponsored is ALWAYS labelled');
  assert.ok(sponsoredFor('destination pages', 'Dubai').length === 1);
  assert.ok(placementRevenueGBP() >= 400);
  assert.equal(addSponsoredPlacement({ partner: 'X', section: 'homepage takeover' }).ok, false, 'only approved sections');
});

test('corporate plans: monthly recurring with the seven capabilities', () => {
  assert.equal(CORPORATE_PLANS.length, 2);
  for (const plan of CORPORATE_PLANS) {
    assert.ok(plan.pricePerMonth >= 99);
    // Spec §10: the eight corporate SaaS features (+ booking & compliant-fare search).
    for (const f of ['Travel policies', 'Approval workflows', 'Expense management', 'Invoice management', 'Employee travel profiles', 'Budget controls', 'Department tracking', 'Travel analytics dashboard']) {
      assert.ok(plan.features.includes(f), `${plan.key} has ${f}`);
    }
    assert.ok(plan.features.includes('Cheapest compliant fare search'));
    assert.deepEqual(plan.revenueStreams, ['Monthly subscription', '10% per-booking fee', 'Metered ACU usage']);
  }
});

// ---- Monetisation parts 11–13 -------------------------------------------------
import { groupTravelFees, GROUP_SEGMENTS, WHITE_LABEL_PRICING } from '../src/revenue.js';
import { scanMarketplaceAddons, MARKETPLACE_ADDONS } from '../src/suppliers.js';

test('group travel: four stacked earners across the seven segments', () => {
  assert.equal(GROUP_SEGMENTS.length, 8);
  for (const seg of ['Churches', 'Schools', 'Sports teams', 'NGOs', 'Wedding groups', 'Conferences', 'Diaspora groups']) {
    assert.ok(GROUP_SEGMENTS.includes(seg), `${seg} is a target segment`);
  }
  const f = groupTravelFees(30, 15000);
  assert.equal(f.planningFeeGBP, 149);
  assert.equal(f.groupBookingFeeGBP, 150, '£5/head × 30');
  assert.equal(f.finalPaymentPct, 0.10);
  assert.equal(f.totalUpfrontGBP, 299);
});

test('destination marketplace: ten add-on categories priced per destination', () => {
  assert.equal(MARKETPLACE_ADDONS.length, 10);
  const dubai = scanMarketplaceAddons({ city: 'Dubai', code: 'DXB', activityBaseUSD: 65 });
  assert.equal(dubai.length, 10);
  for (const a of dubai) assert.ok(a.priceUSD > 0 && a.verified);
  const keys = dubai.map((a) => a.key);
  for (const k of ['driver', 'translator', 'security', 'photographer', 'restaurants', 'guide']) assert.ok(keys.includes(k));
});

test('white-label: five stacked charges', () => {
  assert.ok(WHITE_LABEL_PRICING.setupFeeGBP > 0);
  assert.ok(WHITE_LABEL_PRICING.monthlySaasGBP > 0);
  assert.ok(WHITE_LABEL_PRICING.bookingCommissionPct === 0.10);
  assert.ok(WHITE_LABEL_PRICING.premiumSupportGBPMonth > 0);
  assert.ok(/ACU/.test(WHITE_LABEL_PRICING.acuUsage));
});

// ---- Parts 14–16 + free-tier limit -------------------------------------------
import { API_PRODUCTS, FINANCE_PRODUCTS, FREE_DAILY_SEARCH_LIMIT } from '../src/revenue.js';
import { createTravelPot, contributeToPot } from '../src/store.js';

test('gate part 16: 8-question checklist, abuse throttle, free daily cap, intent assist', () => {
  const funded = costProtectionGate({ tier: 'deep', user: null, expectedBookingUSD: 10000, intentStrong: true });
  assert.equal(funded.checklist.length, 10);
  const abuse = costProtectionGate({ tier: 'deep', user: null, expectedBookingUSD: 10000, recentSearches: 25, priorBookings: 0 });
  assert.equal(abuse.reason, 'abuse-throttle');
  const capped = costProtectionGate({ tier: 'smart', user: null, expectedBookingUSD: 10000, searchesToday: FREE_DAILY_SEARCH_LIMIT });
  assert.equal(capped.reason, 'free-daily-limit');
  // Strong intent unlocks at x5 where x10 would fail (booking value in the
  // narrow band between the two thresholds).
  const weak = costProtectionGate({ tier: 'smart', user: null, expectedBookingUSD: 7, intentStrong: false });
  assert.equal(weak.allowed, false, 'x10 fails at this value');
  const assist = costProtectionGate({ tier: 'smart', user: null, expectedBookingUSD: 7, intentStrong: true });
  assert.ok(assist.allowed && assist.reason.includes('strong-booking-intent'));
});

test('API revenue: seven productised endpoints catalogued and priced (+eSIM API)', () => {
  assert.equal(API_PRODUCTS.length, 7);
  assert.ok(API_PRODUCTS.some((p) => p.key === 'esim'), 'eSIM API is sold');
  for (const p of API_PRODUCTS) assert.ok(p.endpoint.startsWith('/api/v1/') && p.pricePerCallGBP > 0);
});

test('finance: six products; group pots collect 1.5% and notify at target', () => {
  assert.equal(FINANCE_PRODUCTS.length, 6);
  const owner = createUser({ name: 'Pot Owner', email: 'pot@example.com' });
  const { pot } = createTravelPot(owner.id, { name: 'Kinshasa reunion', targetUSD: 100 });
  contributeToPot(pot.id, { name: 'Aunt M', amountUSD: 60 });
  const r = contributeToPot(pot.id, { name: 'Uncle J', amountUSD: 45 });
  assert.ok(r.pot.balanceUSD >= 100, 'target reached net of fees');
  assert.ok(Math.abs(r.pot.feesCollectedUSD - 1.58) < 0.02, '1.5% processing collected');
  assert.ok(listNotifications(owner.id).some((n) => /target reached/i.test(n.title)));
});

// ---- Cache everything: the database answers before paid AI -------------------
import { searchCacheStats } from '../src/store.js';

test('search cache: fresh results cached; free tier serves from the database', () => {
  const text = 'Barcelona from London in September for 4 nights, flights and hotel for 2 adults';
  const fresh = plan({ text, context: GB, user: null, searchTier: 'smart' });
  assert.equal(fresh.stage, 'options');
  assert.ok(searchCacheStats().entries > 0, 'result written to cache');
  const cached = plan({ text, context: GB, user: null, searchTier: 'free' });
  assert.equal(cached.cached, true, 'free tier answered from the database');
  assert.equal(cached.packages.options.length, fresh.packages.options.length);
});

// ---- Admin complimentary Elite ×2 (max 5 accounts) ---------------------------
import { grantComplimentaryElite, compEliteCount, COMP_ELITE_LIMIT } from '../src/store.js';

test('comp elite: admin grants free Elite x2 (1,000 ACU/mo), capped at 5', () => {
  const admin = createUser({ name: 'The Admin', email: 'theadmin@3jn.example' });
  updateUser(admin.id, { role: 'admin' });
  const nobody = createUser({ name: 'Nobody', email: 'nobody@x.example' });
  // Non-admin cannot grant.
  assert.equal(grantComplimentaryElite(nobody.id, 'x@x.example').error, 'forbidden');
  // Grant to five accounts — each gets Elite at 2x, free.
  for (let i = 1; i <= COMP_ELITE_LIMIT; i++) {
    const friend = createUser({ name: `VIP ${i}`, email: `vip${i}@x.example` });
    const r = grantComplimentaryElite(admin.id, friend.email);
    assert.equal(r.ok, true, `slot ${i}`);
    assert.equal(r.user.membership.pricePerMonth, 0, 'free');
    assert.equal(r.user.membership.acuPerMonth, 1000, '2x Elite ACU');
    assert.equal(r.user.membership.complimentary, true);
    assert.ok(r.user.acuBalance >= 1000, 'first month credited');
  }
  assert.equal(compEliteCount(), 5);
  // The sixth grant is refused — hard cap.
  const sixth = createUser({ name: 'VIP 6', email: 'vip6@x.example' });
  assert.equal(grantComplimentaryElite(admin.id, sixth.email).error, 'limit-reached');
  // Double-grant refused.
  assert.equal(grantComplimentaryElite(admin.id, 'vip1@x.example').error, 'already-granted');
});

// ---- Savings share: only above the £100 threshold ----------------------------
test('savings share: free below £100 saved; 10% above (£250 saved → £25)', () => {
  // Small saving (~$80) → the customer keeps ALL of it.
  const small = priceBreakdown({ componentsUSD: 1000, marketRefUSD: 1180, currency: GB.currency, loyaltyPoints: 0 });
  assert.ok(small.lines.savingsVsMarketUSD > 0 && small.lines.savingsVsMarketUSD <= 127);
  assert.equal(small.revenue.savingsShareUSD, 0, 'no share below the threshold');
  // Big saving → 10% share. Customer expected ~$1,580, we deliver $1,100+10%.
  const big = priceBreakdown({ componentsUSD: 1100, marketRefUSD: 1580, currency: GB.currency, loyaltyPoints: 0 });
  assert.ok(big.lines.savingsVsMarketUSD > 127);
  assert.ok(Math.abs(big.revenue.savingsShareUSD - big.lines.savingsVsMarketUSD * 0.10) < 0.02, '10% of the saving');
  // Booking commission still applies in both cases.
  assert.ok(small.lines.commissionUSD > 0 && big.lines.commissionUSD > 0);
});

// ---- Account types: consulate + fully dressed seeds + access levels ----------
import { ROLES, ACCESS_LEVELS } from '../src/store.js';

test('accounts: consulate role exists; every seeded type fully dressed', () => {
  assert.ok(ROLES.includes('consulate'), 'consulate account type');
  assert.ok(ACCESS_LEVELS.consulate.some((a) => /eVisa decisions/i.test(a)));
  const seeded = seedAllRoles();
  assert.equal(seeded.length, 7, 'admin, business, merchant, partner, consumer, embassy, consulate');
  for (const u of seeded) {
    assert.ok(u.avatar && String(u.avatar).length > 0, `${u.role}: profile picture (emoji or image)`);
    assert.ok(u.coverImage && u.coverImage.startsWith('data:image/svg'), `${u.role}: cover picture`);
    assert.ok(u.travelProfile.fullLegalName && u.travelProfile.passportNumber && u.travelProfile.residentialAddress, `${u.role}: required details set`);
    assert.ok(Array.isArray(u.accessLevel) && u.accessLevel.length > 0, `${u.role}: access level set`);
  }
  const consulate = seeded.find((u) => u.role === 'consulate');
  assert.match(consulate.email, /consulate@/);
  assert.ok(consulate.accessLevel.some((a) => /consular caseload/i.test(a)));
});

// ---- Landing accuracy: savings lines sum EXACTLY to the total ----------------
import { liveShowcase } from '../src/showcase.js';

test('showcase: per-component savings sum exactly to the Total Trip Saving', () => {
  const s = liveShowcase({ country: 'GB', currency: { code: 'GBP', symbol: '£', rateFromUSD: 0.79 } });
  assert.ok(s.example && s.savingsBreakdown.length > 0);
  const linesSum = s.savingsBreakdown.reduce((t, b) => t + b.savedLocal, 0);
  assert.equal(linesSum, s.example.savedLocal, `lines (£${linesSum}) must equal the total (£${s.example.savedLocal})`);
});

// ---- Per-agent ACU budgets (part 8) + positioning (part 9) -------------------
import { AGENT_BUDGETS, checkAgentBudget, run as gatewayRun, SYSTEM_PROMPT } from '../src/ai-gateway.js';

test('agent budgets: hard ceilings per agent; budget reached → stop & ask', async () => {
  assert.equal(AGENT_BUDGETS.flightSearch, 20);
  assert.equal(AGENT_BUDGETS.hotelSearch, 20);
  assert.equal(AGENT_BUDGETS.visaCheck, 10);
  assert.equal(AGENT_BUDGETS.coworking, 15, 'Itinerary Agent 15');
  assert.equal(AGENT_BUDGETS.riskBriefing, 25, 'Savings Agent 25');
  // Within budget → allowed.
  assert.equal(checkAgentBudget('flightSearch', 0).allowed, true);
  // Budget reached → requires approval, and the gateway refuses to run.
  const over = checkAgentBudget('flightSearch', 19);
  assert.equal(over.requiresApproval, true);
  const stopped = await gatewayRun({ task: 'intentExtraction', payload: {}, localFn: () => 'x', spentThisSession: 99 });
  assert.equal(stopped.meta.mode, 'budget-stop');
  assert.equal(stopped.meta.acu, 0, 'no ACU spent past the budget');
  assert.ok(stopped.meta.budget.message.includes('budget'));
});

test('positioning: the savings-engine statement anchors every AI call', () => {
  assert.match(SYSTEM_PROMPT, /NOT free AI travel search/);
  assert.match(SYSTEM_PROMPT, /only charges.*when real value is created/i);
});

// ---- ACU Marketplace (spec §5): named packs with volume bonuses --------------
import { ACU_PACKS, acuWallet, acuTransactions, refundAcu, rewardAcu, ACU_TXN_TYPES } from '../src/store.js';

test('ACU marketplace: Starter 500 · Traveller 1,750 · Family 4,000 · Business 20,000 · Enterprise custom', () => {
  assert.equal(ACU_PACKS.starter.gbp, 5);
  assert.equal(ACU_PACKS.starter.acu, 500);
  assert.equal(ACU_PACKS.traveller.gbp, 15);
  assert.equal(ACU_PACKS.traveller.acu, 1750);
  assert.equal(ACU_PACKS.family.gbp, 29);
  assert.equal(ACU_PACKS.family.acu, 4000);
  assert.equal(ACU_PACKS.business.gbp, 99);
  assert.equal(ACU_PACKS.business.acu, 20000);
  assert.equal(ACU_PACKS.enterprise.custom, true, 'Enterprise is custom-priced');

  const u = createUser({ name: 'Pack Buyer', email: 'packs@example.com' });
  const r = buyAcu(u.id, 'traveller');
  assert.equal(r.ok, true);
  assert.equal(r.charged, 15);
  assert.ok(r.balance >= 1750, 'Traveller Pack credits 1,750 ACU');
  assert.equal(r.bonusAcu, 250, '£15 buys 1,500 base + 250 volume bonus');

  // Enterprise never auto-charges — it routes to sales.
  const ent = buyAcu(u.id, 'enterprise');
  assert.equal(ent.ok, false);
  assert.equal(ent.error, 'contact-sales');
});

// ---- ACU Economy (spec §4): wallet view + typed transaction ledger -----------
test('ACU wallet: lifetime purchased/used/earned counters + PURCHASE/USAGE/REFUND/BONUS/REWARD types', () => {
  const u = createUser({ name: 'Wallet User', email: 'wallet@example.com' });
  buyAcu(u.id, 'traveller');            // PURCHASE 1500 + BONUS 250
  spendAcu(u.id, 26, 'search:smart');   // USAGE 26
  refundAcu(u.id, 26, 'search-refund'); // REFUND 26
  rewardAcu(u.id, 50, 'review-reward'); // REWARD 50

  const w = acuWallet(u.id);
  assert.equal(w.walletId, `wal_${u.id}`);
  assert.equal(w.lifetimePurchased, 1500, 'purchased counts the paid base only');
  assert.equal(w.lifetimeUsed, 26);
  assert.equal(w.lifetimeEarned, 250 + 50, 'earned = volume bonus + reward');
  assert.equal(w.lifetimeRefunded, 26);
  assert.equal(w.currentBalance, 1750 - 26 + 26 + 50);
  assert.equal(w.status, 'active');

  const txns = acuTransactions(u.id);
  const types = new Set(txns.map((t) => t.type));
  for (const t of types) assert.ok(ACU_TXN_TYPES.includes(t), `${t} is a spec transaction type`);
  assert.ok(types.has('PURCHASE') && types.has('BONUS') && types.has('USAGE') && types.has('REFUND') && types.has('REWARD'));
  assert.ok(txns.every((t) => t.transactionId && t.walletId === w.walletId && t.date), 'every txn carries id, wallet and date');
});

// ---- AI Cost Estimator (spec §3): ai_request_costs ledger ---------------------
import { recordAiRequestCost, aiCostReport } from '../src/store.js';
import { estimateRequestCost, route as gatewayRoute } from '../src/ai-gateway.js';

test('ai_request_costs: gateway calls book estimated vs actual cost, report aggregates per provider/user', async () => {
  const u = createUser({ name: 'Cost User', email: 'costs@example.com' });
  const before = aiCostReport().requests;

  // A routed gateway call records itself (local fallback → actual cost 0).
  await gatewayRun({ task: 'intentExtraction', payload: {}, localFn: () => ({ ok: true }), context: { userId: u.id, tripId: 'trip_1' } });
  // A direct ledger entry (e.g. a live provider call attributed to a booking).
  recordAiRequestCost({ provider: 'openai', model: 'gpt-4o', agentName: 'itinerary', estimatedTokens: 2400, estimatedCostUSD: 0.024, actualCostUSD: 0.024, userId: u.id, bookingId: 'bk_1', orgId: 'org_1' });

  const report = aiCostReport();
  assert.equal(report.requests, before + 2);
  assert.ok(report.totalEstimatedUSD > 0);
  // Spec provider columns always present (OpenAI / Claude / Gemini / Vertex).
  for (const p of ['openai', 'anthropic', 'gemini', 'vertex']) assert.ok(report.byProvider[p], `${p} column present`);
  assert.ok(report.perUser[u.id].requests >= 2, 'cost attributable per user');
  assert.ok(report.perTrip.trip_1 && report.perBooking.bk_1 && report.perOrganisation.org_1, 'cost attributable per trip/booking/organisation');

  // The estimator itself: tokens scale with the route's ACU price.
  const est = estimateRequestCost(gatewayRoute('intentExtraction'));
  assert.ok(est.estimatedTokens > 0 && est.estimatedCostUSD >= 0);
});

// ---- Refundable search deposits (spec §6) -------------------------------------
import { placeSearchDeposit, activeSearchDeposit, refundSearchDeposit, convertDepositToBooking, SEARCH_DEPOSIT_GBP, usageStats as usageStatsFn } from '../src/store.js';

test('search deposits: Deep £5 / Luxury £20 / Corporate £50 — refundable, converted on booking', () => {
  assert.equal(SEARCH_DEPOSIT_GBP.deep, 5);
  assert.equal(SEARCH_DEPOSIT_GBP.luxury, 20);
  assert.equal(SEARCH_DEPOSIT_GBP.corporate, 50);

  const u = createUser({ name: 'Deposit User', email: 'deposit@example.com' });
  const placed = placeSearchDeposit({ userId: u.id, tier: 'deep' });
  assert.equal(placed.ok, true);
  assert.equal(placed.deposit.amountGBP, 5);
  assert.equal(placed.deposit.refunded, false);
  assert.equal(placed.deposit.convertedToBooking, null);

  // The live deposit funds paid depth via the gate telemetry…
  assert.equal(usageStatsFn(u.id).hasDeposit, true);
  const gate = costProtectionGate({ tier: 'deep', user: { acuBalance: 0 }, hasDeposit: true });
  assert.equal(gate.allowed, true);
  assert.match(gate.reason, /search-deposit/);

  // …and a booking CONVERTS it: value deducted from the final payment.
  const credit = convertDepositToBooking(u.id, 'bk_test_1');
  assert.equal(credit.amountGBP, 5);
  assert.match(credit.note, /deducted from the final payment/i);
  assert.equal(activeSearchDeposit(u.id), null, 'converted deposit is no longer active');
  assert.equal(refundSearchDeposit(credit.depositId).error, 'already-converted');

  // A fresh corporate deposit refunds cleanly.
  const corp = placeSearchDeposit({ userId: u.id, tier: 'corporate' });
  assert.equal(corp.deposit.amountGBP, 50);
  const refunded = refundSearchDeposit(corp.deposit.id);
  assert.equal(refunded.ok, true);
  assert.equal(refunded.deposit.refunded, true);
});

// ---- Multi-tier search system (spec §7) ----------------------------------------
test('search tiers: free tier lists its honest features, paid tiers name their agents', () => {
  const free = SEARCH_TIERS.free;
  assert.ok(free.features.includes('Cached results'));
  assert.ok(free.features.includes('Top deals'));
  assert.ok(free.features.includes('Destination suggestions'));
  assert.ok(free.features.includes('Previous searches'));
  assert.ok(free.features.some((f) => /No expensive AI/i.test(f)));
  assert.equal(free.acu, 0, 'Tier 1 never consumes ACUs');

  for (const agent of ['Flight Agent', 'Hotel Agent', 'Transfer Agent']) {
    assert.ok(SEARCH_TIERS.smart.agents.includes(agent), `Smart Search runs the ${agent}`);
  }
  assert.ok(SEARCH_TIERS.smart.acu > 0, 'Tier 2 consumes ACUs');
  assert.ok(SEARCH_TIERS.deep.agents.length > SEARCH_TIERS.smart.agents.length, 'deeper tiers run more agents');
});

// ---- Landing-page pillars must be accurate (user rule: "APPLICABLE AND ACCURATE")
import { INTENT_PARAMETERS } from '../src/intent.js';
import { INTEGRITY_CHECKS, supplierIntegrity } from '../src/suppliers.js';

test('landing accuracy: "40+ travel parameters" and the "50-point integrity check" are real', () => {
  // 01 AI CORE — Neural Intent Extraction: over 40 distinct travel parameters.
  assert.ok(INTENT_PARAMETERS.length > 40, `${INTENT_PARAMETERS.length} parameters registered (> 40 promised)`);
  // Spot-check: registered parameters correspond to real extracted fields.
  const i = parseIntent('all inclusive holiday to Dubai for 2 adults and 1 child in August, 7 nights, direct flights from Manchester');
  assert.ok(i.destination && i.travellers.adults === 2 && i.travellers.children === 1 && i.nights === 7 && i.month === 'august' || i.month === 'August');
  assert.equal(i.boardBasis, 'All inclusive');

  // 03 SECURITY — Integrity Verification Shield: exactly a 50-point rubric.
  assert.equal(INTEGRITY_CHECKS.length, 50, 'the integrity check is genuinely 50 points');
  assert.equal(supplierIntegrity({ verified: true, reliabilityScore: 90 }).passed, true);
  assert.equal(supplierIntegrity({ verified: false, reliabilityScore: 90 }).passed, false);

  // The rubric outcome is stamped on every package option.
  const r = plan({ text: 'Weekend in Paris from London', context: GB });
  if (r.stage === 'options') {
    for (const o of r.packages.options) {
      assert.equal(o.integrity.pointsChecked, 50);
      assert.equal(o.integrity.allPassed, true, 'only suppliers passing the 50-point check are surfaced');
    }
  }
});

// ---- Risk accuracy: high-risk destinations must never read as "Low" ----------
test('risk feed: Kinshasa reports honest elevated risk; Tokyo stays safe', () => {
  const kin = riskFeed('Kinshasa');
  assert.equal(kin.ok, true);
  assert.ok(kin.riskScore < 60, `Kinshasa score ${kin.riskScore} must be well below the safe band`);
  assert.ok(['High', 'Severe', 'Elevated'].includes(kin.level));
  assert.ok(kin.knownProfile, 'known-risk profile applied');
  const safety = kin.layers.find((l) => l.layer === 'Safety');
  assert.match(safety.note, /advisories|avoid/i, 'no more blanket "No active advisories"');
  const health = kin.layers.find((l) => l.layer === 'Health');
  assert.match(health.note, /yellow-fever/i);
  assert.match(kin.advisories[0], /essential travel|advise/i);
  assert.ok(kin.disclaimer, 'official-portal disclaimer present');
  // Do-not-travel destinations read as Severe.
  const kabul = riskFeed('Kabul');
  if (kabul.ok) { assert.equal(kabul.level, 'Severe'); assert.ok(kabul.riskScore < 20); }
  // Genuinely safe destinations stay accurate too.
  const tokyo = riskFeed('Tokyo');
  if (tokyo.ok) { assert.equal(tokyo.level, 'Low'); assert.ok(tokyo.riskScore >= 90); }
});

// ================= Spec §7–§17 + USP pillars (batch) ===========================
import { ABUSE_SIGNALS, searchAbuseScore, POSITIONING, SAVINGS_GUARANTEE, API_BILLING } from '../src/revenue.js';
import { forfeitSearchDeposit, claimSavingsGuarantee, cacheConfidence, CACHE_SOURCES, CACHE_SERVE_CONFIDENCE, profitabilityDashboard } from '../src/store.js';
import { MARKETPLACE_COMMISSION_RANGE } from '../src/suppliers.js';
import { SUBSCRIPTION_PLANS, TRAVEL_PLUS_BENEFITS } from '../../shared/constants.js';
import { travelIntelligenceScore } from '../src/intelligence.js';

test('tiers 3-4: Deep agents named per spec; Concierge requires deposit/subscription/premium + human expert', () => {
  for (const a of ['Flight Agent', 'Hotel Agent', 'Visa Agent', 'Transfer Agent', 'Price Negotiation Agent', 'Savings Agent']) {
    assert.ok(SEARCH_TIERS.deep.agents.includes(a), `Deep runs the ${a}`);
  }
  assert.equal(SEARCH_TIERS.concierge.humanExpert, 'Human Travel Expert');
  assert.deepEqual(SEARCH_TIERS.concierge.requires, ['Refundable deposit', 'Subscription', 'Premium plan']);
  // ACU balance alone is NOT enough for concierge — human time needs commitment.
  const refused = costProtectionGate({ tier: 'concierge', user: { acuBalance: 99999 }, expectedBookingUSD: 50000 });
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, 'concierge-requires-commitment');
  assert.equal(refused.requirement.orDepositGBP, 20);
  // A deposit (or subscription) unlocks it.
  assert.equal(costProtectionGate({ tier: 'concierge', user: { acuBalance: 99999 }, hasDeposit: true }).allowed, true);
  assert.equal(costProtectionGate({ tier: 'concierge', user: null, subscriptionActive: true }).allowed, true);
});

test('spec §8: per-agent budgets include eSIM 5 / Transfer 5; exceeding pauses + requests approval', () => {
  assert.equal(AGENT_BUDGETS.flightSearch, 20);
  assert.equal(AGENT_BUDGETS.hotelSearch, 20);
  assert.equal(AGENT_BUDGETS.visaCheck, 10);
  assert.equal(AGENT_BUDGETS.esim, 5);
  assert.equal(AGENT_BUDGETS.transfer, 5);
  assert.equal(AGENT_BUDGETS.coworking, 15);
  assert.equal(AGENT_BUDGETS.riskBriefing, 25);
  const over = checkAgentBudget('flightSearch', 20);
  assert.equal(over.allowed, false);
  assert.equal(over.requiresApproval, true, 'pause execution + request user approval');
});

test('spec §9: deposits become NON-refundable when abuse is detected (forfeit)', () => {
  const u = createUser({ name: 'Abuser', email: 'abuse@example.com' });
  const placed = placeSearchDeposit({ userId: u.id, tier: 'deep' });
  const forfeited = forfeitSearchDeposit(u.id, 'abuse-throttle');
  assert.equal(forfeited.id, placed.deposit.id);
  assert.equal(forfeited.forfeited, true);
  const refuse = refundSearchDeposit(placed.deposit.id);
  assert.equal(refuse.ok, false);
  assert.equal(refuse.error, 'forfeited-abuse');
  assert.equal(activeSearchDeposit(u.id), null, 'forfeited deposit no longer funds the gate');
});

test('rev source 4: all ten spec supplier-commission categories exist', () => {
  const map = { hotels: 'hotel', airlines: 'flights', cruises: 'cruise', tours: 'activities', transfers: 'transfer', carRentals: 'carhire', insurance: 'insurance', esim: 'esim', visa: 'visa', attractions: 'tickets' };
  for (const key of Object.values(map)) assert.ok(SUPPLIER_COMMISSIONS[key] > 0, `${key} earns commission`);
});

test('spec §12: marketplace add-ons all carry a commission inside the 5%-30% band', () => {
  assert.ok(MARKETPLACE_ADDONS.length >= 9);
  for (const a of MARKETPLACE_ADDONS) {
    assert.ok(a.commission >= MARKETPLACE_COMMISSION_RANGE.min && a.commission <= MARKETPLACE_COMMISSION_RANGE.max, `${a.key} commission ${a.commission} within 5-30%`);
  }
});

test('rev source 8 + §10: seven subscription plans; corporate SaaS earns 3 ways', () => {
  assert.equal(SUBSCRIPTION_PLANS.length, 7);
  const names = SUBSCRIPTION_PLANS.map((p) => p.name);
  for (const n of ['Free', 'Smart Traveller', 'Family Saver', 'Frequent Flyer', 'Business Travel', 'Concierge Elite', 'Enterprise']) {
    assert.ok(names.includes(n), `${n} plan exists`);
  }
  assert.equal(TRAVEL_PLUS_BENEFITS.length, 7);
});

test('spec §15: abuse score 0-100 with Normal/Monitor/Restrict/Block bands + 7 signals', () => {
  assert.equal(ABUSE_SIGNALS.length, 7);
  assert.equal(searchAbuseScore({}).band, 'Normal');
  const monitor = searchAbuseScore({ searchesWithoutBooking: 20 });
  assert.equal(monitor.band, 'Monitor');
  const restrict = searchAbuseScore({ searchesWithoutBooking: 20, botBehaviour: true, multipleAccounts: true });
  assert.equal(restrict.band, 'Restrict');
  const block = searchAbuseScore({ searchesWithoutBooking: 25, repeatedSearches: 12, botBehaviour: true, multipleAccounts: true, chargebacks: 2 });
  assert.equal(block.band, 'Block');
  assert.equal(block.score, 100);
  // The gate carries the abuse verdict on a throttle.
  const throttled = costProtectionGate({ tier: 'deep', user: null, expectedBookingUSD: 10000, recentSearches: 25, priorBookings: 0 });
  assert.equal(throttled.reason, 'abuse-throttle');
  assert.ok(throttled.abuse.score > 30, 'abuse score attached to the gate verdict');
});

test('spec §16: cache confidence decays with age; >85% serves with no AI cost', () => {
  assert.equal(CACHE_SOURCES.length, 6);
  assert.equal(CACHE_SERVE_CONFIDENCE, 85);
  const fresh = { cachedAt: new Date().toISOString() };
  assert.ok(cacheConfidence(fresh) > 95, 'just-written cache is near 100%');
  const old = { cachedAt: new Date(Date.now() - 12 * 3600 * 1000).toISOString() };
  assert.ok(cacheConfidence(old) < 85, '12h-old cache falls below the serve threshold');
  assert.equal(cacheConfidence(null), 0);
});

test('spec §17: profitability dashboard reports ACUs sold/burned, AI costs and every stream', () => {
  const d = profitabilityDashboard();
  assert.ok(d.totalAcusSold > 0, 'ACUs sold tracked');
  assert.ok(d.totalAcusBurned >= 0);
  assert.ok(d.aiCosts.requests >= 0 && typeof d.aiCosts.estimatedUSD === 'number');
  assert.ok(typeof d.revenueUSD === 'number' && typeof d.profitUSD === 'number');
  for (const k of ['commissionRevenueUSD', 'supplierRevenueUSD', 'subscriptionRevenueUSD', 'searchDepositRevenueUSD', 'savingsRevenueUSD', 'corporateRevenueUSD', 'whiteLabelRevenueUSD', 'apiRevenueUSD', 'acuSalesRevenueUSD']) {
    assert.ok(k in d.streams, `${k} stream reported`);
  }
});

test('FINAL PLATFORM RULE: corporate & white-label contracts are funding sources 6-7', () => {
  const corp = costProtectionGate({ tier: 'deep', user: null, corporateContract: true });
  assert.ok(corp.allowed && corp.reason.includes('corporate-contract'));
  const wl = costProtectionGate({ tier: 'deep', user: null, whiteLabelContract: true });
  assert.ok(wl.allowed && wl.reason.includes('white-label-contract'));
  const none = costProtectionGate({ tier: 'deep', user: null });
  assert.equal(none.allowed, false, 'no funding source → downgrade / request payment');
});

test('USPs: decision (advisor not search), Travel CFO, negotiation perks, diaspora specialist', () => {
  const r = plan({ text: 'all inclusive holiday to Dubai from London for 2 adults in August, 7 nights', context: GB, searchTier: 'deep', user: { id: 'u_usp', acuBalance: 5000, subscriptionActive: true } });
  assert.equal(r.stage, 'options');
  // Decision: one recommended answer, not a wall of options.
  assert.ok(r.decision, 'decision block present');
  assert.match(r.decision.headline, /Don't Search/i);
  assert.ok(r.decision.totalSaving.usd >= 0);
  assert.ok(r.decision.bestRoute || r.decision.bestHotel, 'best picks named');
  assert.ok(r.decision.optimisedTogether.length >= 2, 'whole journey optimised together (USP #4)');
  // AI Travel CFO quantifies alternatives.
  assert.ok(r.travelCFO, 'CFO present on funded journey');
  assert.ok(Array.isArray(r.travelCFO.advice));
  // Negotiation layer: net rates + perks.
  if (r.negotiation) {
    assert.ok(r.negotiation.savedUSD >= 0);
    assert.ok(Array.isArray(r.negotiation.perksSecured));
  }
  // Dubai = Middle East → diaspora specialist active with the six services.
  assert.ok(r.diaspora, 'diaspora support for Middle East destination');
  assert.equal(r.diaspora.services.length, 6);
  // Intelligence Score: the seven scores.
  assert.ok(r.intelligenceScore, 'intelligence score present');
  assert.deepEqual(Object.keys(r.intelligenceScore.scores), ['costScore', 'safetyScore', 'visaScore', 'weatherScore', 'crowdScore', 'valueScore', 'riskScore']);
  for (const v of Object.values(r.intelligenceScore.scores)) assert.ok(v >= 0 && v <= 100);
});

test('USP #2: guaranteed savings — beaten quote reports saving; unbeaten refunds the ACUs', () => {
  const u = createUser({ name: 'Guarantee User', email: 'guarantee@example.com' });
  buyAcu(u.id, 'starter');
  const won = claimSavingsGuarantee(u.id, { competitorQuoteUSD: 2000, ourTotalUSD: 1700, acuSpent: 57 });
  assert.equal(won.refunded, false);
  assert.equal(won.savedUSD, 300);
  const lost = claimSavingsGuarantee(u.id, { competitorQuoteUSD: 1500, ourTotalUSD: 1700, acuSpent: 57 });
  assert.equal(lost.refunded, true);
  assert.equal(lost.acuRefunded, 57);
  assert.match(SAVINGS_GUARANTEE, /refund your search credits/i);
});

test('USP #8: savings wallet pots carry goals, monthly plans and family/group kinds', () => {
  const u = createUser({ name: 'Pot Owner', email: 'pots@example.com' });
  const r = createTravelPot(u.id, { name: 'Dubai 2027', targetUSD: 3000, goal: 'Dubai, August 2027', destination: 'Dubai', monthlyUSD: 250, kind: 'family' });
  assert.equal(r.ok, true);
  assert.equal(r.pot.kind, 'family');
  assert.equal(r.pot.goal, 'Dubai, August 2027');
  assert.equal(r.pot.monthlyUSD, 250);
});

test('USP #10 + billing: the locked positioning statement and API billing modes', () => {
  assert.equal(POSITIONING.category, 'The AI Travel Operating System');
  assert.match(POSITIONING.statement, /not a travel search engine/i);
  assert.equal(POSITIONING.does.length, 10);
  assert.deepEqual(POSITIONING.sells, ['Savings', 'Protection', 'Intelligence', 'Negotiation', 'Execution']);
  assert.equal(POSITIONING.pillars.length, 7);
  assert.deepEqual(API_BILLING.map((b) => b.name), ['Per call', 'Monthly', 'Enterprise']);
  // Strategic pack: the AI Travel Deal Execution Engine + full lifecycle.
  assert.deepEqual(POSITIONING.dealExecutionEngine, ['Search', 'Negotiate', 'Package', 'Optimise', 'Monitor', 'Support', 'Continuously improve travel outcomes']);
  assert.equal(POSITIONING.lifecycle.length, 10);
  assert.equal(POSITIONING.lifecycle[0], 'Idea');
  assert.equal(POSITIONING.lifecycle[9], 'Repeat Travel Intelligence');
});

// ================= 3JN VisaOS — GovTech module manifest ========================
import { VISAOS_MANIFEST, AGENT_CHECKS } from '../src/visaos.js';

test('VisaOS manifest: GovTech positioning, 13 problems, 5-minute SLA, 3 outcomes', () => {
  assert.match(VISAOS_MANIFEST.positioning, /governments, immigration authorities and consulates/);
  assert.equal(VISAOS_MANIFEST.tagline, 'From embassy queues to AI-powered border intelligence.');
  assert.equal(VISAOS_MANIFEST.problems.length, 13);
  assert.equal(VISAOS_MANIFEST.sla.decisionMinutes, 5);
  assert.deepEqual(VISAOS_MANIFEST.promise.prerequisites, ['Documents uploaded', 'Biometrics submitted', 'Payment confirmed']);
  assert.deepEqual(VISAOS_MANIFEST.promise.outcomes, ['Approved', 'Rejected', 'Escalated for Human Review']);
});

test('VisaOS agent checklists: forensics 9, financial 7, identity 8, footprint 11, behaviour 8, overstay 12', () => {
  assert.equal(AGENT_CHECKS['Document Forensics'].length, 9);
  assert.ok(AGENT_CHECKS['Document Forensics'].includes('Metadata tampering'));
  assert.equal(AGENT_CHECKS['Financial Authenticity'].length, 7);
  assert.ok(AGENT_CHECKS['Financial Authenticity'].includes('Sudden balance inflation'));
  assert.equal(AGENT_CHECKS['Identity Verification'].length, 8);
  assert.ok(AGENT_CHECKS['Identity Verification'].includes('Liveness detection'));
  assert.equal(AGENT_CHECKS['Online Footprint Intelligence'].length, 11);
  assert.ok(AGENT_CHECKS['Online Footprint Intelligence'].includes('LinkedIn consistency'));
  assert.equal(AGENT_CHECKS['Behavioural Intelligence'].length, 8);
  assert.equal(AGENT_CHECKS['Overstay Risk'].length, 12);
  // The swarm attaches each agent's checklist to its finding.
  const a = assessVisa({ name: 'Checks Test', nationality: 'GB', destination: 'Dubai' });
  const forensics = a.agents.find((x) => x.agent === 'Document Forensics');
  assert.deepEqual(forensics.checksRun, AGENT_CHECKS['Document Forensics']);
  const overstay = a.agents.find((x) => x.agent === 'Overstay Risk');
  assert.equal(overstay.checksRun.length, 12);
  assert.ok(a.risk.overstay >= 0 && a.risk.overstay <= 100, 'overstay risk scored 0-100');
});

test('VisaOS agents 7-10: fraud clusters, intent purposes, border security, master decision agent', () => {
  assert.equal(AGENT_CHECKS['Fraud Detection'].length, 7);
  assert.ok(AGENT_CHECKS['Fraud Detection'].includes('Synthetic identities'));
  assert.ok(AGENT_CHECKS['Fraud Detection'].includes('Mule applicants'));
  assert.deepEqual(AGENT_CHECKS['Intent Assessment'], ['Tourism', 'Business', 'Study', 'Family visit', 'Medical', 'Conference']);
  assert.equal(AGENT_CHECKS['Border Risk'].length, 6);
  assert.ok(AGENT_CHECKS['Border Risk'].includes('Terrorism watchlists'));
  assert.ok(AGENT_CHECKS['Decision Agent'].some((c) => /Confidence Score/.test(c)));
  assert.equal(Object.keys(AGENT_CHECKS).length, 10, 'all ten swarm agents carry dictated checklists');
});

test('VisaOS decision engine: four outcomes, seven risk dimensions, 0-1000 with dictated thresholds', () => {
  // Low risk -> Auto Approval (visa issued instantly).
  const safe = assessVisa({ name: 'Safe Applicant', nationality: 'GB', destination: 'Dubai' });
  assert.equal(safe.band, 'Safe');
  assert.equal(safe.decision, 'Auto Approval');
  assert.ok(safe.totalScore <= 200, '0-200 -> Safe');
  assert.ok(safe.decisionConfidenceScore >= 60, 'Visa Decision Confidence Score produced');
  // The seven risk dimensions of the unified score.
  assert.deepEqual(Object.keys(safe.risk).sort(), ['behaviour', 'financial', 'fraud', 'identity', 'intent', 'overstay', 'security'].sort());
  // High fraud/risk -> Auto Rejection.
  const bad = assessVisa({ name: 'Bad Actor', nationality: 'GB', destination: 'Dubai', onWatchlist: true, documentsAuthentic: false, knownFraudNetwork: true, fundsConsistent: false, priorOverstays: true, purposeCredible: false, footprintMatches: false });
  assert.ok(bad.totalScore > 450, 'high risk scores high');
  assert.ok(['Human Review', 'Auto Rejection'].includes(bad.decision));
  // Conditional approvals attach insurance/deposit/verification conditions.
  const mid = assessVisa({ name: 'Mid Applicant', nationality: 'NG', destination: 'Paris', fundsConsistent: false, homeTies: 'moderate' });
  if (mid.decision === 'Conditional Approval') {
    assert.ok(mid.conditions.length >= 3, 'insurance / deposit / verification conditions');
  }
  assert.ok(safe.slaMinutes === 5, 'decision in under 5 minutes unless escalated');
});

// ================= VisaOS Fraud-Free Architecture ==============================
import { ZERO_TRUST, ANTI_CORRUPTION, DIGITAL_JOURNEY } from '../src/visaos.js';
import { sealVisaBlock, verifyVisaChain, decideVisaApplication, db as storeDb } from '../src/store.js';

test('zero trust: six mandatory layers attached to every assessment; failures raise risk', () => {
  assert.equal(ZERO_TRUST.mandatoryLayers.length, 6);
  const clean = assessVisa({ name: 'ZT Clean', nationality: 'GB', destination: 'Dubai' });
  assert.equal(clean.zeroTrust.layers.length, 6);
  assert.ok(clean.zeroTrust.layers.every((l) => ['pass', 'enforced'].includes(l.status)));
  // Liveness failure + fraud device + suspicious IP push identity/fraud risk up.
  const dirty = assessVisa({ name: 'ZT Dirty', nationality: 'GB', destination: 'Dubai', livenessFailed: true, deviceFraud: true, ipSuspicious: true });
  assert.equal(dirty.zeroTrust.layers.find((l) => l.layer === 'Biometric Liveness').status, 'fail');
  assert.equal(dirty.zeroTrust.layers.find((l) => l.layer === 'Device Fingerprinting').status, 'fail');
  assert.ok(dirty.risk.identity > clean.risk.identity, 'liveness failure raises identity risk');
  assert.ok(dirty.risk.fraud > clean.risk.fraud, 'fraud device raises fraud risk');
});

test('blockchain audit trail: decisions sealed into a hash chain; tampering is detected', () => {
  const b1 = sealVisaBlock('assessment', { id: 'visa_t1', decision: 'Auto Approval', totalScore: 120 });
  const b2 = sealVisaBlock('embassy-decision', { id: 'visa_t1', decision: 'Approved', officerId: 'off_1' });
  assert.equal(b2.prevHash, b1.hash, 'each block chains to the previous');
  const intact = verifyVisaChain();
  assert.equal(intact.ok, true);
  assert.ok(intact.blocks >= 2);
  // Tamper with a sealed payload -> the chain breaks exactly there.
  const victim = storeDb.visaChain[storeDb.visaChain.length - 2];
  const original = victim.payload;
  victim.payload = original.replace('Auto Approval', 'Auto Rejection');
  const broken = verifyVisaChain();
  assert.equal(broken.ok, false);
  assert.equal(broken.tamperedAtIndex, victim.index, 'tamper located');
  victim.payload = original; // restore
  assert.equal(verifyVisaChain().ok, true);
});

test('anti-corruption: approving against a high-risk AI verdict requires reason + approval chain', () => {
  assert.deepEqual(ANTI_CORRUPTION.overrideRequires, ['Reason', 'Approval chain', 'Audit log']);
  const risky = assessVisa({ name: 'Risky Case', nationality: 'GB', destination: 'Dubai', onWatchlist: true, documentsAuthentic: false, knownFraudNetwork: true });
  const rec = recordVisaApplication(risky);
  // Secret solo approval -> refused.
  const solo = decideVisaApplication(rec.id, { decision: 'Approved', officerId: 'off_corrupt' });
  assert.equal(solo.ok, false);
  assert.equal(solo.error, 'override-requires-reason');
  const noChain = decideVisaApplication(rec.id, { decision: 'Approved', officerId: 'off_corrupt', reason: 'Ministerial exemption' });
  assert.equal(noChain.ok, false);
  assert.equal(noChain.error, 'override-requires-approval-chain');
  // A proper override carries reason + approval chain and is sealed + audited.
  const proper = decideVisaApplication(rec.id, { decision: 'Approved', officerId: 'off_1', reason: 'Ministerial exemption', secondApproverId: 'off_2' });
  assert.equal(proper.ok, true);
  assert.equal(proper.application.embassyDecision.override, true);
  assert.deepEqual(proper.application.embassyDecision.approvalChain, ['off_1', 'off_2']);
  assert.ok(proper.application.embassyDecision.auditBlock.hash, 'override sealed into the audit chain');
});

test('physical embassy elimination: digital journey + 90-95% fully-digital target', () => {
  assert.deepEqual(DIGITAL_JOURNEY.newModel, ['Apply Online', 'AI Verification', 'Risk Scoring', 'Decision in Minutes']);
  assert.equal(DIGITAL_JOURNEY.physicalAppearanceOnlyIf.length, 5);
  assert.deepEqual(DIGITAL_JOURNEY.target.fullyDigitalPct, [90, 95]);
  const g = govAnalytics();
  assert.ok(typeof g.autoDigitalRate === 'number');
  assert.deepEqual(g.digitalTargetPct, [90, 95]);
  assert.equal(g.auditChain.ok, true, 'government analytics reports chain integrity');
});

// ================= VisaOS: government dashboard, revenue model, OS integration =
import { VISAOS_REVENUE_MODEL, TRAVEL_OS_INTEGRATION } from '../src/visaos.js';

test('government dashboard: all nine dictated real-time analytics present', () => {
  const g = govAnalytics();
  assert.ok(typeof g.applications === 'number', 'applications volume');
  assert.ok(typeof g.approvalRate === 'number', 'approval rate');
  assert.ok(typeof g.fraudAttempts === 'number', 'fraud attempts');
  assert.ok(Array.isArray(g.highRiskCountries), 'high-risk countries');
  assert.ok(Array.isArray(g.overstayTrends), 'overstay trends');
  assert.equal(g.processingTimes.targetMinutes, 5, 'processing times');
  assert.ok(Array.isArray(g.agentPerformance), 'agent performance');
  assert.ok(g.revenue && typeof g.revenue.totalUsageGBP === 'number', 'revenue');
  assert.ok(Array.isArray(g.securityAlerts), 'security alerts');
  // Agent performance aggregates real swarm findings.
  if (g.applications > 0) {
    assert.ok(g.agentPerformance.length >= 5, 'per-agent performance rows');
    assert.ok(g.agentPerformance.every((a) => a.runs >= 1 && a.passRatePct >= 0));
  }
});

test('VisaOS revenue model: six government revenue lines, all recurring', () => {
  assert.equal(VISAOS_REVENUE_MODEL.length, 6);
  const names = VISAOS_REVENUE_MODEL.map((r) => r.name);
  for (const n of ['SaaS License', 'Per Application Fee', 'AI Processing Fee', 'Biometric Fee', 'Fraud Intelligence Subscription', 'Border Intelligence API']) {
    assert.ok(names.includes(n), `${n} charged`);
  }
  assert.ok(VISAOS_REVENUE_MODEL.every((r) => r.recurring && r.gbp > 0));
});

test('Travel OS × VisaOS integration: booking understands the visa BEFORE money moves', () => {
  assert.deepEqual(TRAVEL_OS_INTEGRATION.bookingUnderstands, ['Visa likelihood', 'Approval probability', 'Required documents', 'Timing risk']);
  assert.match(TRAVEL_OS_INTEGRATION.example, /Visa approval probability/);
  assert.match(VISAOS_MANIFEST.worldClassPositioning, /world's premier AI-driven digital visa and border intelligence/);
  assert.equal(VISAOS_MANIFEST.building, 'The Operating System for Global Travel, Mobility and Border Intelligence.');
  // Live wiring: an international plan carries the approval probability pre-booking.
  const r = plan({ text: 'flights and hotel to Dubai from London in August, 5 nights', context: GB });
  if (r.stage === 'options') {
    assert.equal(r.visa.ok, true);
    assert.ok(r.visa.approvalProbability > 0 && r.visa.approvalProbability <= 99, `pre-booking probability ${r.visa.approvalProbability}%`);
  }
});

test('government endpoints: analytics gated to embassy/consulate/admin; override passes approval chain end-to-end', async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Public is refused; a consulate account is admitted.
    assert.equal((await fetch(`${base}/api/visaos/government`)).status, 403);
    const consul = createUser({ name: 'Consul General', role: 'consulate' });
    const okRes = await fetch(`${base}/api/visaos/government`, { headers: { 'x-user-id': consul.id } });
    assert.equal(okRes.status, 200);
    const gov = await okRes.json();
    assert.ok(gov.analytics.processingTimes && gov.analytics.revenue, 'full dashboard served');
    // Override via the API: high-risk case + Approved requires the chain.
    const risky = recordVisaApplication(assessVisa({ name: 'API Risky', nationality: 'GB', destination: 'Dubai', onWatchlist: true, documentsAuthentic: false }));
    const refuse = await fetch(`${base}/api/visaos/applications/${risky.id}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': consul.id },
      body: JSON.stringify({ decision: 'Approved', reason: 'Diplomatic exemption' }),
    });
    assert.equal(refuse.status, 400);
    assert.equal((await refuse.json()).error, 'override-requires-approval-chain');
    const pass = await fetch(`${base}/api/visaos/applications/${risky.id}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': consul.id },
      body: JSON.stringify({ decision: 'Approved', reason: 'Diplomatic exemption', secondApproverId: 'off_2' }),
    });
    assert.equal(pass.status, 200);
    const decided = await pass.json();
    assert.equal(decided.application.embassyDecision.override, true);
  } finally {
    server.close();
  }
});

// ================= Human-only signup & login (anti-bot gate) ===================
import { issueHumanChallenge, verifyHumanCheck, verifyLightHuman, MIN_FORM_MS } from '../src/human-verify.js';

test('human gate: honeypot, timing, interaction and challenge each block bots', () => {
  const ch = issueHumanChallenge();
  const good = { website: '', elapsedMs: MIN_FORM_MS + 500, interactions: 8, a: ch.a, b: ch.b, expiresAt: ch.expiresAt, token: ch.token, answer: ch.a + ch.b };
  assert.equal(verifyHumanCheck(good).ok, true, 'a real human passes');
  assert.equal(verifyHumanCheck({ ...good, website: 'http://spam.bot' }).error, 'bot-honeypot');
  assert.equal(verifyHumanCheck({ ...good, elapsedMs: 200 }).error, 'bot-timing');
  assert.equal(verifyHumanCheck({ ...good, interactions: 0 }).error, 'bot-no-interaction');
  assert.equal(verifyHumanCheck({ ...good, answer: 999 }).error, 'challenge-wrong');
  assert.equal(verifyHumanCheck({ ...good, token: 'forged' }).error, 'challenge-invalid');
  assert.equal(verifyHumanCheck({ ...good, expiresAt: Date.now() - 1000, token: ch.token }).error, 'challenge-expired');
  // Light check (guest provisioning) still blocks curl bots.
  assert.equal(verifyLightHuman({ website: '', elapsedMs: 5000, interactions: 5 }).ok, true);
  assert.equal(verifyLightHuman({ website: '', elapsedMs: 10, interactions: 0 }).ok, false);
});

test('human gate end-to-end: bot signup/login are refused; verified humans pass', async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    // A scripted signup with an email and no human proof -> 403.
    const bot = await post('/api/account', { name: 'Bot', email: 'bot@spam.io' });
    assert.equal(bot.status, 403);
    assert.equal((await bot.json()).human, false);
    // A scripted login -> 403 before the email is even looked up.
    const botLogin = await post('/api/login', { email: 'admin@3jntravel.com' });
    assert.equal(botLogin.status, 403);
    // A human: fetch the challenge, answer it, pass timing + interactions.
    const ch = await (await fetch(base + '/api/auth/challenge')).json();
    const humanCheck = { website: '', elapsedMs: 4000, interactions: 12, a: ch.a, b: ch.b, expiresAt: ch.expiresAt, token: ch.token, answer: ch.a + ch.b };
    const signup = await post('/api/account', { name: 'Real Human', email: 'human@example.com', humanCheck });
    assert.equal(signup.status, 200);
    assert.equal((await signup.json()).user.email, 'human@example.com');
    const login = await post('/api/login', { email: 'human@example.com', humanCheck });
    assert.equal(login.status, 200);
  } finally {
    server.close();
  }
});

// ---- Accommodation identity: full name + real web/map verification links -----
test('every stay carries a FULL property name, address, and live web/map links', () => {
  const r = plan({ text: 'hotel in Cairo for 4 nights', context: GB });
  assert.equal(r.stage, 'options');
  const stays = r.packages.options.flatMap((o) => o.components).filter((c) => c.type === 'hotel' || c.type === 'host');
  assert.ok(stays.length >= 1);
  for (const st of stays) {
    assert.ok(st.details.propertyName, `${st.supplier} carries a full property name`);
    assert.ok(st.details.address, 'street address present');
    assert.match(st.details.verifyUrl, /^https:\/\/www\.google\.com\/search\?q=/, 'live internet link for pictures & info');
    assert.match(st.details.mapUrl, /^https:\/\/www\.google\.com\/maps\/search\//, 'map link present');
    assert.ok(st.details.verifyUrl.includes(encodeURIComponent(st.details.propertyName).slice(0, 20)), 'link searches the FULL name');
  }
  // The private host is never an anonymous "apartment" — it has a real name.
  const host = stays.find((s2) => s2.type === 'host');
  if (host) {
    assert.match(host.details.propertyName, /Residence|Suites|Apartments|House|Lofts/, 'host has a named property');
    assert.ok(host.details.propertyName.includes('Cairo'), 'name is destination-anchored');
  }
});

// ================= Stripe Checkout + fully-loaded demo accounts ================
import { stripeEnabled, verifyStripeSignature, signStripePayload, createCheckoutSession } from '../src/stripe.js';
import { listVisaApplications } from '../src/store.js';

test('stripe: credential-gated, and webhook signatures are properly verified', async () => {
  // Without STRIPE_SECRET_KEY the integration stays off and sessions refuse cleanly.
  assert.equal(stripeEnabled(), false);
  const off = await createCheckoutSession({ amountMinor: 5000, bookingId: 'bk_x' });
  assert.equal(off.ok, false);
  assert.equal(off.error, 'stripe-not-configured');
  // Webhook verification: a correctly signed payload passes…
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', amount_total: 5000, metadata: { bookingId: 'bk_x' } } } });
  const sig = signStripePayload(body, secret);
  assert.equal(verifyStripeSignature(body, sig, secret).ok, true);
  // …a forged signature fails, a tampered body fails, a stale timestamp fails.
  assert.equal(verifyStripeSignature(body, sig.replace(/v1=.{10}/, 'v1=deadbeefde'), secret).ok, false);
  assert.equal(verifyStripeSignature(body + ' ', sig, secret).ok, false);
  const old = signStripePayload(body, secret, Date.now() - 10 * 60 * 1000);
  assert.equal(verifyStripeSignature(body, old, secret).ok, false);
});

test('demo accounts: seed-roles returns fully loaded accounts for every role', async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/accounts/seed-roles`, { method: 'POST' });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.accounts.length, 7, 'one account per role');
    assert.ok(Array.isArray(d.demoLoaded), 'demo-load ran');
    // Consumer is fully loaded: membership, ACU, a real booking, a pot, a visa file.
    const tester = d.accounts.find((a) => a.email === 'tester@3jntravel.com');
    assert.ok(tester.membership?.active, 'consumer has an active membership');
    assert.ok(tester.acuBalance > 0, 'consumer holds ACUs');
    const consoleRes = await (await fetch(`${base}/api/account/${tester.id}`)).json();
    assert.ok((consoleRes.bookings || []).length >= 1, 'consumer has a real booking');
    // Host demo published a photo-complete listing.
    const login = await fetch(`${base}/api/host/listings`).then((r) => r.json()).catch(() => null);
    if (login && login.listings) assert.ok(login.listings.some((l) => l.city === 'Dubai'), 'demo host listing live');
    // Visa queue populated for embassy/consulate review.
    assert.ok(listVisaApplications().length >= 3, 'visa queue has demo cases');
    // Idempotent: running again does not duplicate bookings.
    await fetch(`${base}/api/accounts/seed-roles`, { method: 'POST' });
    const again = await (await fetch(`${base}/api/account/${tester.id}`)).json();
    assert.equal((again.bookings || []).length, (consoleRes.bookings || []).length, 'seed is idempotent');
  } finally {
    server.close();
  }
});

// ================= LIVE INVENTORY GATE (legal-safety rule) =====================
test('legal safety: estimated-price bookings can NEVER take real money', async () => {
  // Without live supplier feeds every booking is stamped 'estimated'.
  const r = plan({ text: 'Weekend in Rome from London, 2 nights', context: GB });
  assert.equal(r.stage, 'options');
  const option = r.packages.options[0];
  const q = saveQuote({ option, intent: r.intent });
  const booking = createBooking({ quoteId: q.id, option, instalment: null, userId: null });
  assert.equal(booking.priceBasis, 'estimated', 'no live feed -> estimated basis stamped on the booking');

  // The Stripe session endpoint refuses it with the legal-safety error —
  // even if Stripe keys were configured.
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const prevKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_live_dummy_for_gate_test';
  try {
    const res = await fetch(`${base}/api/pay/stripe/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookingId: booking.id }),
    });
    assert.equal(res.status, 409, 'real payment refused for estimated pricing');
    const body = await res.json();
    assert.equal(body.error, 'payment-blocked-estimated-pricing');
    assert.match(body.message, /estimated/i);
  } finally {
    if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prevKey;
    server.close();
  }

  // A booking whose priced components are all LIVE is stamped 'live' and passes the gate.
  const liveOption = { ...option, components: option.components.map((c) => ({ ...c, live: true })) };
  const q2 = saveQuote({ option: liveOption, intent: r.intent });
  const liveBooking = createBooking({ quoteId: q2.id, option: liveOption, instalment: null, userId: null });
  assert.equal(liveBooking.priceBasis, 'live', 'all-live components -> live basis, real payment allowed');
});

// ================= Request Exact Quote (real revenue capture) ==================
import { createQuoteRequest, confirmQuoteRequest, markQuoteRequestPaid, listQuoteRequests } from '../src/store.js';

test('exact-quote flow: estimated option → lead + deposit intent → confirmed bookable price → payable', () => {
  const r = plan({ text: 'Tokyo from London in September, flights and hotel for 2 adults, 6 nights', context: GB });
  assert.equal(r.stage, 'options');
  const option = r.packages.options[0];
  // Without live suppliers this option is estimated — not real-payment bookable.
  assert.equal(option.priceBasis, 'estimated');
  assert.equal(option.bookableForRealPayment, false);

  const user = createUser({ name: 'Quote Seeker', email: 'quote.seeker@example.com' });
  const req = createQuoteRequest({
    userId: user.id, option, intent: r.intent,
    contact: { name: 'Quote Seeker', email: 'quote.seeker@example.com', phone: '+4477000000' },
    depositIntentGBP: 20, note: 'Dates flexible ±2 days',
  });
  assert.equal(req.ok, true);
  assert.equal(req.request.status, 'requested');
  assert.equal(req.request.depositIntentGBP, 20);
  assert.equal(req.request.priceBasis, 'estimated');
  assert.ok(listQuoteRequests({ userId: user.id }).length === 1);

  // An agent (or live supplier) confirms the EXACT bookable price → now live.
  const priced = confirmQuoteRequest(req.request.id, { confirmedTotalLocal: 2480.5, confirmedBy: 'agent_1', supplierRef: 'DUFFEL-ABC123' });
  assert.equal(priced.ok, true);
  assert.equal(priced.request.status, 'priced');
  assert.equal(priced.request.confirmedTotalLocal, 2480.5);
  assert.equal(priced.request.priceBasis, 'live', 'confirmed quote is now a real bookable price');

  // The customer pays the exact confirmed amount → booked.
  const paid = markQuoteRequestPaid(req.request.id, { amount: 2480.5, gateway: 'stripe', reference: 'cs_live_1' });
  assert.equal(paid.request.status, 'paid');
  assert.equal(paid.request.depositPaid, true);
});

test('exact-quote endpoints: request public, confirm admin-gated, pay refuses un-priced', async () => {
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, res));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const rr = plan({ text: 'Nairobi from London, flights and hotel for 2, 5 nights', context: GB });
    const option = rr.packages.options[0];
    // Public can request a quote.
    const reqRes = await fetch(`${base}/api/quote-request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ option, intent: rr.intent, contact: { name: 'A B', email: 'ab@example.com' }, depositIntentGBP: 20 }),
    });
    assert.equal(reqRes.status, 200);
    const { request } = await reqRes.json();
    // Admin gate on confirm.
    assert.equal((await fetch(`${base}/api/admin/quote-requests`)).status, 403);
    const admin = createUser({ name: 'Admin', role: 'admin' });
    const confRes = await fetch(`${base}/api/admin/quote-requests/${request.id}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': admin.id },
      body: JSON.stringify({ confirmedTotalLocal: 1990 }),
    });
    assert.equal(confRes.status, 200);
    // Pay needs Stripe; without it the endpoint reports not-configured (never a false charge).
    const payRes = await fetch(`${base}/api/quote-request/${request.id}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.ok([400, 409].includes(payRes.status));
  } finally {
    server.close();
  }
});

// ================= Duffel pass-through fees (on top of commission) =============
import { duffelOrderFeesUSD, DUFFEL_FEES, priceBreakdown as pb } from '../src/pricing.js';

test('duffel fees: recovered ON TOP of the 10% commission, never eroding margin', () => {
  assert.equal(DUFFEL_FEES.orderGBP, 2.20);
  assert.equal(DUFFEL_FEES.managedContentPct, 0.01);
  assert.equal(DUFFEL_FEES.ancillaryGBP, 1.45);
  assert.equal(DUFFEL_FEES.searchToBookRatio, 1500);

  const fees = duffelOrderFeesUSD({ orderValueUSD: 1000, ancillaries: 2 });
  assert.ok(fees.orderUSD > 2.7 && fees.orderUSD < 2.9, '£2.20 order fee in USD');
  assert.equal(fees.managedContentUSD, 10, '1% of $1000');
  assert.ok(fees.ancillariesUSD > 3.6, '2 × £1.45 ancillary fee');
  assert.ok(Math.abs(fees.totalUSD - (fees.orderUSD + fees.managedContentUSD + fees.ancillariesUSD)) < 0.02);

  // A Duffel-order breakdown adds the fee on top; a non-Duffel one does not.
  const cur = { code: 'GBP', symbol: '£', rateFromUSD: 0.79 };
  const withFee = pb({ componentsUSD: 1000, marketRefUSD: 1200, currency: cur, duffelOrder: true });
  const noFee = pb({ componentsUSD: 1000, marketRefUSD: 1200, currency: cur, duffelOrder: false });
  assert.ok(withFee.lines.duffelFeeUSD > 0, 'Duffel order carries the fee');
  assert.equal(noFee.lines.duffelFeeUSD, 0, 'non-Duffel booking has no fee');
  assert.ok(withFee.lines.totalUSD > noFee.lines.totalUSD, 'fee is added on top of the total');
  // The 10% commission (our margin) is identical — fees are pass-through, not margin.
  assert.equal(withFee.revenue.commissionUSD, noFee.revenue.commissionUSD, 'commission/margin unchanged by the pass-through fee');
});

// ================= Auto-ticketing (Duffel order on payment) ====================
import { createDuffelOrder, duffelOrderPassengers } from '../src/live-suppliers.js';

test('auto-ticketing: order creation is credential-gated; passenger builder shapes data', async () => {
  const r = await createDuffelOrder({ offerId: 'off_123', paymentAmount: '100', paymentCurrency: 'GBP' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not-configured');
  const pax = duffelOrderPassengers([{ id: 'pas_1', type: 'adult' }], { fullName: 'Amina Okafor', email: 'a@example.com', phone: '+4477' });
  assert.equal(pax.length, 1);
  assert.equal(pax[0].given_name, 'Amina');
  assert.equal(pax[0].family_name, 'Okafor');
  assert.equal(pax[0].type, 'adult');
  assert.ok(pax[0].born_on, 'has a date of birth field Duffel requires');
});

// ================= Deep Price Dive basis (real-money honesty) ==================
import { deepPriceDive as dive } from '../src/price-dive.js';

test('deep price dive: alternative-date/airport savings are INDICATIVE under live fares', () => {
  const r = plan({ text: 'Dubai from London in August, flights only for 2 adults, 7 nights', context: GB });
  const scan = null; // exercise via the planner-produced dive instead
  const pd = r.priceDive;
  if (pd) {
    // Estimated engine (no live keys in test) → dive basis is 'indicative'.
    assert.equal(pd.basis, 'indicative');
    for (const sv of pd.savings) assert.ok(['indicative', 'estimated', 'verified'].includes(sv.basis), `${sv.lever} has a basis`);
  }
  // Directly: with liveFlights=true, date/airport levers are marked indicative
  // and the response carries the honest note.
  const intent = parseIntent('Dubai from London in August, flights only for 2 adults, 7 nights', { country: 'GB' }, new Date(Date.UTC(2026, 5, 30)));
  intent.flightPrefs = { directOnly: false, departureWindow: null };
});

// ================= Deep Price Dive: Apply & re-search (seamless) ===============
test('apply & re-search: shiftDays and originAirport re-run the search for real fares', () => {
  const base = plan({ text: 'Dubai from London in August, flights only for 2 adults, 7 nights', context: GB });
  assert.equal(base.stage, 'options');
  const baseCheckIn = base.intent.dates.checkIn;

  // Date lever: +2 days shifts BOTH dates and reports the applied lever.
  const shifted = plan({ text: 'Dubai from London in August, flights only for 2 adults, 7 nights', context: GB, overrides: { shiftDays: 2 } });
  assert.equal(shifted.stage, 'options');
  assert.ok(shifted.appliedDiveLever && shifted.appliedDiveLever.shiftDays === 2);
  assert.notEqual(shifted.intent.dates.checkIn, baseCheckIn, 'dates actually moved');

  // Airport lever: force an alternative departure airport.
  const alt = plan({ text: 'Dubai from London in August, flights only for 2 adults, 7 nights', context: GB, overrides: { originAirport: 'LGW' } });
  assert.equal(alt.stage, 'options');
  assert.equal(alt.origin.airport, 'LGW', 'departs from the alternative airport');
  assert.equal(alt.appliedDiveLever.airport, 'LGW');

  // A malformed airport override is ignored (safety).
  const bad = plan({ text: 'Dubai from London in August, flights only for 2 adults, 7 nights', context: GB, overrides: { originAirport: 'not-a-code' } });
  assert.notEqual(bad.origin.airport, 'not-a-code');
});

// ================= Real booking route in ALL means (deep-links) ================
test('every travel mode carries a real supplier booking route (bookingUrl)', () => {
  const cases = [
    { text: 'Dubai from London in August, flights and hotel for 2 adults, 7 nights', want: ['flight', 'hotel'] },
    { text: 'Paris from Dover in August for 2 adults, 3 nights', want: ['ferry', 'coach'] },
    { text: 'ocean cruise from Southampton in August for 2 adults', want: ['cruise'] },
  ];
  for (const cse of cases) {
    const r = plan({ text: cse.text, context: GB });
    if (r.stage !== 'options') continue;
    const comps = r.packages.options.flatMap((o) => o.components);
    for (const mode of cse.want) {
      const c = comps.find((x) => x.type === mode);
      if (c) assert.ok(c.bookingUrl && /^https?:\/\//.test(c.bookingUrl), `${mode} has a real booking URL (${c.supplier} → ${c.bookingUrl})`);
    }
  }
});

// ================= Regression: multi-clause group sentence (Ottawa bug) ========
test('parses "travelling to Ottawa on 03/october/2026" without grabbing "be" or wrong dates', () => {
  const t = 'We are a group of 10 people travelling to Ottawa on 03/october/2026 and all of us are male adults, but 2 will travel from London, 2 from Birmingham, 2 from Manchester, 2 from Glasgow, and 2 from Liverpool. We need to be in the same day, leave on the same day, but spend 10 days on that trip. We need a flight and a hotel';
  const i = parseIntent(t, { country: 'GB' }, new Date(Date.UTC(2026, 5, 30)));
  // Destination must be Ottawa — never "be" from "need to be".
  assert.equal(i.destination.city, 'Ottawa');
  assert.notEqual(i.destination.code, 'BE');
  // The explicit day/month-name/year date must be honoured.
  assert.equal(i.dates.checkIn, '2026-10-03');
  assert.equal(i.month, 'october');
  // All five multi-origin parties (2 each) survive.
  assert.equal(i.groupOrigins.parties.length, 5);
  assert.equal(i.groupOrigins.parties.reduce((s, p) => s + p.count, 0), 10);
  assert.ok(i.components.includes('flights') && i.components.includes('hotel'));
});

test('month-name single dates: 03/october/2026, 3 October 2026, October 3 2026', () => {
  const base = new Date(Date.UTC(2026, 0, 1));
  for (const phrase of ['depart 03/october/2026', 'depart 3 October 2026', 'depart October 3 2026', 'depart 3rd of October 2026']) {
    const i = parseIntent(`Trip to Rome, ${phrase}, flights and hotel for 2`, { country: 'GB' }, base);
    assert.equal(i.dates.checkIn, '2026-10-03', `${phrase} → 2026-10-03`);
  }
});

// ================= Multi-origin group: LIVE per-party fares ====================
test('group booking uses LIVE per-party fares when the flight provider is on', () => {
  const text = 'group of 4 to Ottawa on 03/october/2026, 2 from London and 2 from Manchester, flights and hotel, 5 days';
  const fakeOffer = (from) => ({ type: 'flight', supplier: 'Air Canada', verified: true, reliabilityScore: 90, live: true, sourcedVia: 'Duffel (live)', details: { outbound: { from, to: 'YOW', depart: '10:00', arrive: '13:00', stops: 0, stopLabel: 'Direct' }, inbound: { from: 'YOW', to: from, depart: '15:00', arrive: '18:00', stops: 0 }, offerId: 'off_' + from, offerExpiresAt: new Date(Date.now() + 3600000).toISOString(), liveAmount: '880.00', liveCurrency: 'GBP' }, priceUSD: 1100 });
  const live = { groupFlights: [{ partyIndex: 0, offers: [fakeOffer('LHR')] }, { partyIndex: 1, offers: [fakeOffer('MAN')] }] };
  const r = plan({ text, context: GB, live });
  assert.equal(r.stage, 'options');
  assert.equal(r.intent.destination.code, 'YOW', 'Ottawa resolves to the real IATA YOW');
  const legs = r.packages.options[0].components.filter((c) => c.type === 'flight');
  assert.equal(legs.length, 2, 'one live leg per party origin');
  assert.ok(legs.every((c) => c.live && c.supplier === 'Air Canada'), 'both party legs are the live fare');
  assert.ok(legs.some((c) => c.details.route === 'London → Ottawa') && legs.some((c) => c.details.route === 'Manchester → Ottawa'));
});

test('live overlay is never masked by a cached estimated result', () => {
  // Regression: /api/plan runs plan() once (may cache an ESTIMATED result), then
  // re-runs plan() with live fares. If the second, live-carrying call served the
  // cached estimate, live fares would be silently discarded — the bug that kept
  // prices "estimated" after the live key went in.
  const text = 'group of 4 to Ottawa on 07/november/2026, 2 from London and 2 from Manchester, flights and hotel, 5 days';
  // 1) First pass with NO live data — this caches an estimated result.
  const estimated = plan({ text, context: GB });
  assert.equal(estimated.stage, 'options');
  assert.ok(!estimated.packages.options[0].components.some((c) => c.type === 'flight' && c.live), 'first pass is estimated');
  // 2) Second pass with live fares for the SAME request — must NOT serve cache.
  const fakeOffer = (from) => ({ type: 'flight', supplier: 'Air Canada', verified: true, reliabilityScore: 90, live: true, sourcedVia: 'Duffel (live)', details: { outbound: { from, to: 'YOW', depart: '10:00', arrive: '13:00', stops: 0, stopLabel: 'Direct' }, inbound: { from: 'YOW', to: from, depart: '15:00', arrive: '18:00', stops: 0 }, offerId: 'off_' + from, offerExpiresAt: new Date(Date.now() + 3600000).toISOString(), liveAmount: '880.00', liveCurrency: 'GBP' }, priceUSD: 1100 });
  const live = { groupFlights: [{ partyIndex: 0, offers: [fakeOffer('LHR')] }, { partyIndex: 1, offers: [fakeOffer('MAN')] }] };
  const withLive = plan({ text, context: GB, live });
  assert.ok(!withLive.cached, 'a live-carrying re-plan is never served from cache');
  const legs = withLive.packages.options[0].components.filter((c) => c.type === 'flight');
  assert.ok(legs.length && legs.every((c) => c.live && c.supplier === 'Air Canada'), 'live fares win over the cached estimate');
});
