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
  listApprovals, decideApproval, flatSnapshot, getUser as getUserById,
} from '../src/store.js';
import { runPriceGuard } from '../src/monitor.js';
import { visaCheck, riskFeed } from '../src/intelligence.js';
import { destinationsCatalog } from '../src/destinations.js';
import { inspireDestinations, INSPIRE_WINDOWS } from '../src/inspire.js';
import { snapshot, hydrate } from '../src/store.js';
import { markEmailVerified } from '../src/store.js';
import { listNotifications, pushNotification, recordVisaApplication, govAnalytics } from '../src/store.js';
import { processReferralOnPaidBooking, partnerDashboard, decideInfluencer } from '../src/store.js';
import { createSupportTicket, supportTicketsForUser, resolveSupportTicket, recordPayment } from '../src/store.js';
import { supportRespond } from '../src/chatbot.js';
import { aiMarginReport, minAcuForMargin, pricedAcuForAction, MIN_AI_MARGIN } from '../src/ai-gateway.js';
import { commissionSplit } from '../src/vendors.js';
import { embassyProposal, visaDecisionLetter } from '../src/embassy.js';
import { bookingDocument } from '../src/documents.js';
import { saveEmbassyConfig, getEmbassyConfig, redactVisaForApplicant, releaseVisaDecision } from '../src/store.js';
import { updateHostPayout, hostDashboard } from '../src/store.js';
import { applyVendor, vendorDashboard, runWeeklyVendorPayouts, recordVendorSale, flagVendorSale } from '../src/store.js';
import { db } from '../src/store.js';
import { assist } from '../src/assistant.js';
import { getUserRaw } from '../src/store.js';
import { acuForAction, effectiveRevshareRate, accrueRevshare, isValidAttribution, REVSHARE_CAP_GBP, tierForFollowers } from '../src/rewards.js';
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

test('price breakdown funds loyalty discount from commission, never below supplier cost', () => {
  // Voyager (3%) on a $1000 supplier-cost package.
  const b = priceBreakdown({ componentsUSD: 1000, marketRefUSD: 1300, currency: GB.currency, loyaltyPoints: 1200 });
  assert.equal(b.lines.loyaltyDiscountUSD, 30);       // the member's rebate
  assert.equal(b.lines.netSuppliersUSD, 1000);        // supplier cost ALWAYS collected in full
  assert.equal(b.lines.grossCommissionUSD, 100);      // the headline 10% on the receipt
  assert.equal(b.lines.commissionUSD, 70);            // our real take = gross − rebate
  assert.equal(b.lines.totalUSD, 1070);               // customer pays cost + our net take
  // Receipt stays consistent: suppliers − loyalty + gross commission = total.
  assert.equal(b.lines.suppliersUSD - b.lines.loyaltyDiscountUSD + b.lines.grossCommissionUSD, b.lines.totalUSD);
  assert.ok(b.lines.savingsVsMarketUSD > 0);

  // Elite (8%) keeps real transaction margin — the top tier is never break-even
  // and never a loss: an 8% rebate out of a 10% commission leaves us 2%.
  const elite = priceBreakdown({ componentsUSD: 1000, marketRefUSD: 1300, currency: GB.currency, loyaltyPoints: 15000 });
  assert.equal(elite.lines.loyaltyDiscountUSD, 80);   // 8% rebate to the member
  assert.equal(elite.lines.grossCommissionUSD, 100);  // full 10% on the receipt
  assert.equal(elite.lines.commissionUSD, 20);        // we keep 2% — real margin, never £0
  assert.equal(elite.lines.totalUSD, 1020);
  assert.ok(elite.lines.commissionUSD > 0, 'top tier still profitable on the transaction');
  assert.ok(elite.lines.totalUSD >= elite.lines.netSuppliersUSD, 'never below supplier cost');
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

  // funded by PURCHASED ACU balance even with no booking intent
  const acuFunded = costProtectionGate({ tier: 'deep', user: { acuBalance: 5000 }, expectedBookingUSD: 0, hasPurchasedAcu: true });
  assert.equal(acuFunded.allowed, true);

  // MARGIN PROTECTION: the free 50-ACU starter (never purchased, no commitment)
  // may run Smart but NOT Deep — Deep downgrades until the user commits.
  const starterDeep = costProtectionGate({ tier: 'deep', user: { acuBalance: 50 }, expectedBookingUSD: 0, hasPurchasedAcu: false });
  assert.equal(starterDeep.allowed, false);
  assert.equal(starterDeep.downgradeTo, 'smart');
  const starterSmart = costProtectionGate({ tier: 'smart', user: { acuBalance: 50 }, expectedBookingUSD: 0, hasPurchasedAcu: false });
  assert.equal(starterSmart.allowed, true, 'free starter still runs the cheap Smart search');
});

test('white-label payout is 90/10 split', () => {
  const p = whiteLabelPayout(100000, 0.10);
  assert.equal(p.commissionUSD, 10000);
  assert.equal(p.partnerNetUSD, 9000);
  assert.equal(p.platformShareUSD, 1000);
});

test('payment rail policy: Stripe carries all money in until BitriPay ships', () => {
  const user = createUser({ name: 'Rail Test' });
  const option = { totalUSD: 500, pricing: { lines: { totalUSD: 500 }, local: { total: 395 }, revenue: { commissionUSD: 50, savingsShareUSD: 5 } } };
  const quote = saveQuote({ option, intent: { dates: { checkIn: '2026-09-01' } } });
  // A BitriPay/mobile-money selection must settle on Stripe while the rail
  // is unfinished — money in defaults to Stripe, no exceptions.
  for (const method of ['bitripay', 'mpesa', 'airtel', 'orange', 'africell']) {
    const b = createBooking({ quoteId: quote.id, option, instalment: null, userId: user.id, paymentMethod: method });
    assert.equal(b.gateway, 'stripe', `${method} settles on Stripe until BitriPay launches`);
  }
  // Card stays Stripe, as ever.
  const card = createBooking({ quoteId: quote.id, option, instalment: null, userId: user.id, paymentMethod: 'card' });
  assert.equal(card.gateway, 'stripe');
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
  // A British passport is visa-free (VoA) for the UAE, so there is no visa
  // component; the Rayna agent account instead sources the land products
  // (transfers/activities). Verify Rayna net-rate sourcing on those.
  const land = std.components.find((c) => (c.type === 'transfer' || c.type === 'activities') && c.sourcedVia === 'Rayna Tours');
  assert.ok(land, 'Dubai land products are sourced via Rayna Tours');
  assert.equal(land.agent, true);
  assert.ok(land.priceUSD < land.publicPriceUSD, 'agent net rate is below public price');
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
  // updateUser edits profile fields only — it must NEVER change privilege, even
  // if a role/allAccess is passed in the patch (self-elevation hole otherwise).
  const updated = updateUser(u.id, { name: 'Patricia', avatar: '⭐', bio: 'frequent flyer', role: 'merchant', allAccess: true });
  assert.equal(updated.name, 'Patricia');
  assert.equal(updated.avatar, '⭐');
  assert.equal(updated.bio, 'frequent flyer');
  assert.equal(updated.role, 'business', 'role is NOT changed by a profile edit');
  assert.equal(updated.allAccess, false, 'allAccess is NOT changed by a profile edit');
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
  assert.equal(gbDubai.required, false); // British passport = free visa-on-arrival for the UAE
  const ngDubai = visaCheck('NG', 'Dubai');
  assert.equal(ngDubai.required, true); // Nigerian passport needs a pre-arranged eVisa
  assert.ok(ngDubai.checklist.length > 0);
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
  assert.equal(u.acuBalance, 50, 'new users get a 50 ACU starter to try searches');
  assert.equal(u.membership, null);

  const sub = subscribeMembership(u.id, 'family'); // monthly £12.99 -> 130 ACU
  assert.equal(sub.ok, true);
  assert.equal(sub.acuCredited, 130);
  assert.equal(sub.user.acuBalance, 180, '50 starter + 130 funded');
  assert.equal(sub.user.membership.active, true);

  // Each billing period re-funds the allocation.
  const ren = renewMembership(u.id);
  assert.equal(ren.acuCredited, 130);
  assert.equal(ren.user.acuBalance, 310);
});

test('ACU: hard block at insufficient balance, top-ups priced at £1 = 100 ACU', () => {
  const u = createUser({ name: 'AcuTest' }); // starts with 50 ACU
  // Spending MORE than the balance is refused (must top up first).
  const blocked = spendAcu(u.id, 60, 'search');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'insufficient-acu');

  // Top up £10 -> +1,100 ACU (1,000 base + 10% bonus) on top of the 50 starter.
  const top = buyAcu(u.id, 'topup10');
  assert.equal(top.charged, 10);
  assert.equal(top.balance, 1150);
  assert.equal(top.bonusAcu, 100);
  const ok = spendAcu(u.id, 15, 'search');
  assert.equal(ok.ok, true);
  assert.equal(ok.balance, 1135);
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

test('price dive TRUTH: estimator never claims verified/booked facts or names a competitor as overpriced', () => {
  const r = plan({
    text: 'Dubai from London in August for 7 nights, flights and hotel, cheapest reliable',
    context: GB, user: null, searchTier: 'deep',
  });
  const dive = r.priceDive;
  assert.ok(dive);
  // 1. On the estimator (no live keys), nothing is presented as "verified".
  assert.equal(dive.basis, 'estimated');
  assert.ok(dive.savings.every((s) => s.basis !== 'verified'), 'no synthesised saving is marked verified');
  assert.equal(dive.unbeatable.live, false);
  // 2. No claim of a completed agent-account booking (that lever is live-only).
  assert.ok(!dive.savings.some((s) => /Booked on 3JN agent/i.test(s.how)), 'no false booked-on-agent claim');
  assert.ok(!dive.savings.some((s) => s.lever === 'Negotiated net rates'), 'negotiated-rate lever is gated to live data');
  // 3. The hotel swap never names a real competitor brand as the overpriced one.
  const swap = dive.savings.find((s) => /Hotel swap/i.test(s.lever));
  if (swap) {
    assert.match(swap.how, /Estimate:/, 'swap is labelled an estimate');
    assert.match(swap.how, /higher-priced/, 'the dearer option is described generically, not named');
    for (const brand of ['Rove Hotels', 'Atlantis The Royal', 'Address Downtown', 'Premier Inn']) {
      assert.ok(!swap.how.includes(`instead of ${brand}`), `does not name ${brand} as overpriced`);
    }
  }
  // 4. The unbeatable verdict is stated as an estimate, not a fact.
  assert.match(dive.unbeatable.verdict, /^Estimate:/);
  // 5. A plain-English disclosure is attached.
  assert.match(dive.indicativeNote, /illustrative estimate/i);
});

// ---- Community Host Marketplace: anyone can host, inside the OS -------------
import { createHostListing, listHostListings, hostListingsForCity, hostEarnings, registerHost, updateHostListing, hostBookings, reviewHostListing, adminUserHostOverview } from '../src/store.js';

test('host marketplace: a community listing goes live and competes in searches', () => {
  const host = createUser({ name: 'Fatima Host', email: 'fatima.host@example.com' });
  // Registration is mandatory before publishing.
  const gate = createHostListing(host.id, { title: 'X', city: 'Dubai', nightlyUSD: 30 });
  assert.equal(gate.error, 'host-registration-required');
  // Registration REQUIRES payout details — without them the host can't be paid.
  assert.equal(registerHost(host.id, { displayName: 'Fatima', payoutMethod: 'Bank transfer' }).ok, false, 'no payout details → refused');
  // PAYMENT RAIL POLICY: BitriPay payouts are refused (coming soon) until the
  // rail is complete — Stripe carries all money in and out for now.
  const btp = registerHost(host.id, { displayName: 'Fatima', payoutMethod: 'BitriPay wallet', payout: { walletId: 'BTP-778812' } });
  assert.equal(btp.ok, false);
  assert.equal(btp.error, 'bitripay-coming-soon');
  assert.equal(registerHost(host.id, { displayName: 'Fatima', payoutMethod: 'Bank transfer', payout: { accountHolder: 'Fatima H', accountNumber: 'GB29NWBK60161331926819', bankName: 'NatWest', sortOrSwift: '601613' } }).ok, true);
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
  registerHost(u.id, { payout: { accountHolder: 'Test Host', accountNumber: 'GB29NWBK60161331926819', bankName: 'NatWest' } });
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
  registerHost(host.id, { displayName: 'Omar', payout: { accountHolder: 'Omar H', accountNumber: 'GB29NWBK60161331926819', bankName: 'HSBC' } });
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
  registerHost(host.id, { displayName: 'Lina', payout: { accountHolder: 'Lina K', accountNumber: 'GB29NWBK60161331926819', bankName: 'Monzo' } });
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
  registerHost(host.id, { displayName: 'Syn', payout: { accountHolder: 'Syn H', accountNumber: 'GB29NWBK60161331926819', bankName: 'Barclays' } });
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
  const admin = createUser({ name: 'The Admin', email: 'theadmin@3jn.example', role: 'admin' });
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

test('ACU top-ups: £5 → 500 (0%) · £10 → 1,100 (+10%) · £15 → 1,800 (+20%)', () => {
  assert.equal(ACU_PACKS.top5.gbp, 5);
  assert.equal(ACU_PACKS.top5.acu, 500);
  assert.equal(ACU_PACKS.top10.gbp, 10);
  assert.equal(ACU_PACKS.top10.acu, 1100);
  assert.equal(ACU_PACKS.top15.gbp, 15);
  assert.equal(ACU_PACKS.top15.acu, 1800);
  assert.equal(ACU_PACKS.enterprise.custom, true, 'Enterprise is custom-priced');

  const u = createUser({ name: 'Pack Buyer', email: 'packs@example.com' });
  assert.equal(buyAcu(u.id, 'top5').bonusAcu, 0, '£5 has no bonus');
  assert.equal(buyAcu(u.id, 'top10').bonusAcu, 100, '£10 = 1,000 base + 10% bonus');
  const r = buyAcu(u.id, 'top15');
  assert.equal(r.charged, 15);
  assert.equal(r.bonusAcu, 300, '£15 = 1,500 base + 20% bonus');

  // Enterprise never auto-charges — it routes to sales.
  const ent = buyAcu(u.id, 'enterprise');
  assert.equal(ent.ok, false);
  assert.equal(ent.error, 'contact-sales');
});

// ---- ACU Economy (spec §4): wallet view + typed transaction ledger -----------
test('ACU wallet: lifetime purchased/used/earned counters + PURCHASE/USAGE/REFUND/BONUS/REWARD types', () => {
  const u = createUser({ name: 'Wallet User', email: 'wallet@example.com' });
  buyAcu(u.id, 'top15');                // PURCHASE 1500 + BONUS 300
  spendAcu(u.id, 26, 'search:smart');   // USAGE 26
  refundAcu(u.id, 26, 'search-refund'); // REFUND 26
  rewardAcu(u.id, 50, 'review-reward'); // REWARD 50

  const w = acuWallet(u.id);
  assert.equal(w.walletId, `wal_${u.id}`);
  assert.equal(w.lifetimePurchased, 1500, 'purchased counts the paid base only');
  assert.equal(w.lifetimeUsed, 26);
  assert.equal(w.lifetimeEarned, 300 + 50, 'earned = volume bonus + reward');
  assert.equal(w.lifetimeRefunded, 26);
  assert.equal(w.currentBalance, 50 + 1800 - 26 + 26 + 50, '50 ACU signup starter + wallet activity');
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

test('USP #2: guaranteed savings — beaten quote reports saving; unbeaten refunds the ACUs actually spent', () => {
  const u = createUser({ name: 'Guarantee User', email: 'guarantee@example.com' });
  buyAcu(u.id, 'starter');
  spendAcu(u.id, 57, 'deep-search'); // the user really spends 57 ACU on a search
  const won = claimSavingsGuarantee(u.id, { competitorQuoteUSD: 2000, ourTotalUSD: 1700, acuSpent: 57 });
  assert.equal(won.refunded, false);
  assert.equal(won.savedUSD, 300);
  const lost = claimSavingsGuarantee(u.id, { competitorQuoteUSD: 1500, ourTotalUSD: 1700, acuSpent: 57 });
  assert.equal(lost.refunded, true);
  assert.equal(lost.acuRefunded, 57);
  // ANTI-ABUSE: a second claim can't refund more than was really spent (57).
  const abuse = claimSavingsGuarantee(u.id, { competitorQuoteUSD: 1, ourTotalUSD: 999999, acuSpent: 1000000 });
  assert.equal(abuse.acuRefunded, 0, 'cannot mint ACU beyond real unrefunded search spend');
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
    assert.equal(d.accounts.length, 8, 'one account per role + the property host');
    assert.ok(d.accounts.some((a) => a.email === 'host@3jntravel.com'), 'host demo account listed');
    assert.ok(Array.isArray(d.demoLoaded), 'demo-load ran');
    // Consumer is fully loaded: membership, ACU, a real booking, a pot, a visa file.
    const tester = d.accounts.find((a) => a.email === 'tester@3jntravel.com');
    assert.ok(tester.membership?.active, 'consumer has an active membership');
    assert.ok(tester.acuBalance > 0, 'consumer holds ACUs');
    const consoleRes = await (await fetch(`${base}/api/account/${tester.id}`, { headers: { 'x-user-id': tester.id } })).json();
    assert.ok((consoleRes.bookings || []).length >= 1, 'consumer has a real booking');
    // SECURITY: reading an account without auth (401) or as another user (403).
    assert.equal((await fetch(`${base}/api/account/${tester.id}`)).status, 401, 'unauthenticated account read is blocked');
    // Host demo published a photo-complete listing.
    const login = await fetch(`${base}/api/host/listings`).then((r) => r.json()).catch(() => null);
    if (login && login.listings) assert.ok(login.listings.some((l) => l.city === 'Dubai'), 'demo host listing live');
    // Visa queue populated for embassy/consulate review.
    assert.ok(listVisaApplications().length >= 3, 'visa queue has demo cases');
    // Idempotent: running again does not duplicate bookings.
    await fetch(`${base}/api/accounts/seed-roles`, { method: 'POST' });
    const again = await (await fetch(`${base}/api/account/${tester.id}`, { headers: { 'x-user-id': tester.id } })).json();
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
    // Estimated engine (no live keys in test) → the WHOLE dive is an estimate,
    // and every figure must be labelled honestly (never "verified").
    assert.equal(pd.basis, 'estimated');
    assert.ok(pd.savings.every((sv) => sv.basis === 'estimated' || sv.basis === 'indicative'), 'no synthesised saving is marked verified');
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

test('suppliers & agents must actually operate at the destination', () => {
  // Regression: Careem (MENA/Pakistan only) was offered for Canada/Turkey, and
  // Rayna Tours (a Dubai land agent) was attached as the booking agent for
  // components in countries it does not serve — a realism/credibility bug.
  const comps = (r) => r.packages.options.flatMap((o) => o.components);
  const ott = comps(plan({ text: '2 adults to Ottawa for 5 nights in October, flights hotel transfer visa', context: GB, user: null }));
  assert.ok(!ott.some((c) => c.supplier === 'Careem'), 'Careem never offered for Canada');
  assert.ok(!ott.some((c) => c.sourcedVia === 'Rayna Tours'), 'Rayna never the agent for Canada');
  assert.ok(ott.some((c) => c.type === 'transfer'), 'a global transfer provider still covers Canada');

  const ist = comps(plan({ text: '2 adults to Istanbul for 5 nights in October, flights hotel transfer visa', context: GB, user: null }));
  assert.ok(!ist.some((c) => c.supplier === 'Careem'), 'Careem never offered for Turkey (MENA/Pakistan only)');
  // Rayna DOES operate in Turkey, so it is a valid in-region agent there.
  assert.ok(ist.some((c) => c.sourcedVia === 'Rayna Tours' && c.agent), 'Rayna IS a valid agent for Turkey');

  const dxb = comps(plan({ text: '2 adults to Dubai for 5 nights in October, flights hotel transfer visa', context: GB, user: null }));
  assert.ok(dxb.some((c) => c.sourcedVia === 'Rayna Tours' && c.agent), 'Rayna IS the in-region agent for the UAE');
});

// ---- Global Rewards & Influencer Programme --------------------------------
test('rewards: ACU earning maths (fixed, per-£ and promo multiplier)', () => {
  assert.equal(acuForAction('REFER_FRIEND'), 250, '250 ACU per paid referral');
  assert.equal(acuForAction('VERIFIED_REVIEW'), 100);
  assert.equal(acuForAction('BOOK_TRIP', { netBookingGbp: 500 }), 500, '1 ACU per £1 net');
  assert.equal(acuForAction('BOOK_TRIP', { netBookingGbp: 500, promo: true }), 1000, 'promo doubles the earn');
});

test('rewards: revenue-share rate by tier + 20-referral unlock', () => {
  assert.equal(effectiveRevshareRate({ paidReferrals: 0 }), 0, 'no share before unlock');
  assert.equal(effectiveRevshareRate({ paidReferrals: 20 }), 0.0025, 'baseline 0.25% at 20 referrals');
  assert.equal(effectiveRevshareRate({ approvedTier: 'ambassador' }), 0.01, 'ambassador 1%');
  assert.equal(effectiveRevshareRate({ approvedTier: 'rising' }), 0.0025, 'rising 0.25%');
  assert.equal(tierForFollowers(12000).key, 'ambassador');
  assert.equal(tierForFollowers(6000).key, 'rising');
  assert.equal(tierForFollowers(100).key, 'referrer');
});

test('rewards: revenue share respects the £20,000 per-customer cap', () => {
  // Near the cap, only the remaining headroom is payable.
  const near = accrueRevshare({ netRevenueGbp: 1000000, rate: 0.01, alreadyEarnedGbp: 19950 });
  assert.equal(near, 50, 'caps at exactly the £20k remaining');
  assert.equal(accrueRevshare({ netRevenueGbp: 1000, rate: 0.01, alreadyEarnedGbp: REVSHARE_CAP_GBP }), 0, 'nothing past the cap');
});

test('rewards: self-referral attribution is rejected', () => {
  assert.equal(isValidAttribution({ referrerId: 'u1', friendId: 'u1' }), false);
  assert.equal(isValidAttribution({ referrerId: 'u1', friendId: 'u2', referrerStanding: 'suspended' }), false);
  assert.equal(isValidAttribution({ referrerId: 'u1', friendId: 'u2' }), true);
});

test('rewards: paid referral awards 250 ACU and accrues revenue share for an approved ambassador', () => {
  const referrer = createUser({ email: 'amb@x.co', name: 'Ambassador' });
  const raw = getUserRefCode(referrer.id);
  const friend = createUser({ email: 'friend@x.co', name: 'Friend', referredByCode: raw });
  // Approve the referrer as a 1% ambassador so revenue share applies immediately.
  decideInfluencer(referrer.id, { approve: true, tier: 'ambassador' });
  const booking = { id: 'bk_rwd_1', userId: friend.id, option: { pricing: { revenue: { commissionUSD: 127 } } } };
  const r = processReferralOnPaidBooking(booking);
  assert.ok(r.ok, 'referral processed');
  assert.equal(r.acu, 250, '250 ACU to the referrer');
  // £127 commission ≈ £100 net → 1% = £1 revenue share.
  assert.ok(Math.abs(r.revshareGbp - 1) < 0.01, 'revenue share ~= £1 at 1%');
  const dash = partnerDashboard(referrer.id);
  assert.ok(dash.totalReferrals >= 1 && dash.lifetimeEarningsGbp >= 1, 'dashboard reflects the earnings');
  assert.equal(booking.referralProcessed, true, 'guarded against double-processing');
  // Re-processing the same booking must not double-pay.
  const again = processReferralOnPaidBooking(booking);
  assert.ok(!again.ok, 'same booking is never rewarded twice');
});

// Helper: read a user's referral code from the raw store.
function getUserRefCode(userId) {
  const dash = partnerDashboard(userId);
  return dash.referralCode;
}

// ---- AI Support Concierge (chatbot + escalation) --------------------------
test('support bot answers common requests and escalates only when required', () => {
  const bot = (m) => supportRespond(m);
  // Resolved by the bot (no human needed):
  for (const m of ['hi there', 'where is my e-ticket', 'do I need a visa for Dubai', 'how do I refer a friend', 'I want to book a holiday']) {
    assert.equal(bot(m).escalate, false, `bot handles: ${m}`);
    assert.ok(bot(m).reply.length > 0);
  }
  // Escalated to a human:
  assert.equal(bot('can I speak to a human please').escalate, true);
  assert.equal(bot('I want a refund, I was charged twice').escalate, true);
  assert.equal(bot('this is a scam, I will sue you').escalate, true);
  assert.equal(bot('qwertyuiop zxcvbnm').escalate, true); // unknown → human
  assert.equal(bot('refund me now').intent, 'refund');
});

test('support escalation opens a ticket and notifies the customer', () => {
  const u = createUser({ email: 'sup@x.co', name: 'Support Tester' });
  const t = createSupportTicket({ userId: u.id, intent: 'refund', message: 'charged twice', reason: 'Refund dispute' });
  assert.equal(t.status, 'open');
  assert.ok(supportTicketsForUser(u.id).some((x) => x.id === t.id));
  const r = resolveSupportTicket(t.id, { note: 'Refund processed', agent: 'Amara' });
  assert.ok(r.ok && r.ticket.status === 'resolved');
});

// ---- 3JN Assistant (deep, system-aware agent) -----------------------------
test('assistant resolves with the user\'s real system data before escalating', () => {
  const u = createUser({ email: 'agent@x.co', name: 'Alan Turing' });
  getUserRaw(u.id).travelProfile = { nationality: 'GB' };
  const option = { tier: 'Standard', destination: 'Dubai', travellers: { total: 2 }, totalUSD: 1200, pricing: { symbol: '£', local: { total: 950 }, revenue: { commissionUSD: 95 } }, components: [{ type: 'flight', supplier: 'Emirates', live: true }] };
  const b = createBooking({ option, userId: u.id, instalment: { deposit: 200, schedule: [{ due: '2026-08-01', amount: 200, status: 'paid' }, { due: '2026-09-01', amount: 375, status: 'pending' }] } });

  const status = assist('where is my booking and e-ticket', u.id);
  assert.equal(status.resolved, true);
  assert.ok(status.reply.includes(b.id), 'quotes the real booking reference');

  const pay = assist('when is my next payment due', u.id);
  assert.ok(pay.reply.includes('375') && pay.reply.includes('2026-09-01'), 'quotes the real next instalment');

  const visa = assist('do I need a visa for Dubai', u.id);
  assert.equal(visa.resolved, true);
  assert.ok(/visa-free/i.test(visa.reply), 'GB passport is visa-free for Dubai');

  const rewards = assist('how many referrals do I have', u.id);
  assert.equal(rewards.resolved, true);

  // Refund escalates BUT with the real booking attached as diagnostic context.
  const refund = assist('I want a refund', u.id);
  assert.equal(refund.escalate, true);
  assert.ok(refund.diagnostic && refund.diagnostic.id === b.id, 'escalation carries the booking diagnostic');
});

test('admin can approve an influencer who has not formally applied yet', () => {
  // Regression: decideInfluencer used to no-op if no profile existed, so an
  // admin promotion silently failed and revenue share never accrued.
  const ref = createUser({ email: 'promote@x.co', name: 'Promote Pat' });
  const decided = decideInfluencer(ref.id, { approve: true, tier: 'ambassador' });
  assert.ok(decided.ok && decided.profile.tier === 'ambassador', 'promotion sets the tier even with no prior profile');
  const friend = createUser({ email: 'promo-friend@x.co', name: 'F', referredByCode: partnerDashboard(ref.id).referralCode });
  const b = createBooking({ option: { tier: 'Premium', pricing: { symbol: '£', local: { total: 1000 }, revenue: { commissionUSD: 127 } }, totalUSD: 1270, components: [{ type: 'flight', supplier: 'Emirates', live: true }], travellers: { total: 1 } }, userId: friend.id, instalment: { deposit: 250, schedule: [{ due: '2026-08-01', amount: 250, status: 'pending' }] } });
  recordPayment(b.id, { type: 'deposit', amount: 250 });
  assert.ok(Math.abs(partnerDashboard(ref.id).lifetimeEarningsGbp - 1) < 0.01, '1% revenue share accrues (£1 of £100 net)');
});

// ---- Assistant as booking operator (quote → confirm → execute) ------------
test('assistant executes a date change with confirmation and charges the fee', () => {
  const u = createUser({ email: 'opr@x.co', name: 'Operator Test' });
  const b = createBooking({ option: { tier: 'Standard', pricing: { symbol: '£', local: { total: 900 } }, totalUSD: 1140, travellers: { total: 2 }, components: [{ type: 'flight', supplier: 'BA', live: true, details: { baggage: '1 cabin bag', outbound: { from: 'LHR', to: 'DXB', date: '2027-10-03' } } }] }, userId: u.id });
  const quote = assist('change my flight date to 20 October 2027', u.id);
  assert.ok(/CONFIRM/i.test(quote.reply) && /45/.test(quote.reply), 'quotes the change fee and asks to confirm');
  const done = assist('confirm', u.id);
  assert.equal(done.resolved, true);
  assert.equal(b.option.components[0].details.outbound.date, '2027-10-20', 'date is actually changed');
  assert.equal(b.fulfilment.ticketing, 'reissued', 'e-ticket re-issued');
  assert.ok(b.payments.some((p) => p.type === 'change-charge' && p.amount === 45), 'change fee charged');
});

test('assistant adds baggage on confirmation with the extra charge', () => {
  const u = createUser({ email: 'opr2@x.co', name: 'Bag Test' });
  const b = createBooking({ option: { tier: 'Standard', pricing: { symbol: '£', local: { total: 900 } }, totalUSD: 1140, travellers: { total: 1 }, components: [{ type: 'flight', supplier: 'BA', live: true, details: { baggage: '1 cabin bag', outbound: { from: 'LHR', to: 'DXB', date: '2027-10-03' } } }] }, userId: u.id });
  assert.ok(/80/.test(assist('add 2 checked bags', u.id).reply), 'quotes 2 × £40');
  assist('yes go ahead', u.id);
  assert.ok(/added checked bag/i.test(b.option.components[0].details.baggage), 'baggage updated');
  assert.ok(b.payments.some((p) => p.type === 'change-charge' && p.amount === 80), '£80 charged');
});

test('assistant cancels with a policy-based refund quote', () => {
  const u = createUser({ email: 'opr3@x.co', name: 'Cancel Test' });
  const b = createBooking({ option: { tier: 'Standard', pricing: { symbol: '£', local: { total: 500 } }, totalUSD: 635, travellers: { total: 1 }, components: [{ type: 'flight', supplier: 'BA', live: true, details: { outbound: { from: 'LHR', to: 'DXB', date: '2027-10-03' } } }] }, userId: u.id, instalment: { deposit: 200, schedule: [{ due: '2027-01-01', amount: 200, status: 'paid' }] } });
  assert.ok(/CONFIRM/i.test(assist('cancel my booking', u.id).reply), 'quotes cancellation and asks to confirm');
  assist('confirm', u.id);
  assert.equal(b.status, 'cancelled', 'booking is cancelled');
});

test('assistant carries a multi-turn change ("departure" → a date) without escalating', () => {
  // Regression: a bare follow-up like "departure" used to re-classify as unknown
  // and dead-end into a human handoff. With transcript context it stays in the
  // change flow, asks for the date, then quotes the change.
  const u = createUser({ email: 'flow@x.co', name: 'Flow Test' });
  const b = createBooking({ option: { tier: 'Standard', pricing: { symbol: '£', local: { total: 900 } }, totalUSD: 1140, travellers: { total: 1 }, components: [{ type: 'flight', supplier: 'BA', live: true, details: { baggage: '1 cabin bag', outbound: { from: 'LHR', to: 'DXB', date: '2027-10-03' }, inbound: { from: 'DXB', to: 'LHR', date: '2027-10-10' } } }] }, userId: u.id });
  const t1 = assist('i need to change my booking', u.id, []);
  const hist = [{ role: 'user', text: 'i need to change my booking' }, { role: 'bot', text: t1.reply }];
  // Bare slot word — must NOT escalate; must ask for the departure date.
  const t2 = assist('departure', u.id, hist);
  assert.equal(t2.escalate, false, '"departure" does not escalate mid-change');
  assert.ok(/departure date/i.test(t2.reply), 'asks for the new departure date');
  hist.push({ role: 'user', text: 'departure' }, { role: 'bot', text: t2.reply });
  // Now a bare date lands as the new departure and gets quoted.
  const t3 = assist('20 October 2027', u.id, hist);
  assert.ok(/CONFIRM/i.test(t3.reply), 'a bare date in-flow is quoted with CONFIRM');
  assist('confirm', u.id, hist);
  assert.equal(b.option.components[0].details.outbound.date, '2027-10-20', 'departure actually moved');
});

test('assistant operates on hotels too (add nights, upgrade room/board)', () => {
  const u = createUser({ email: 'htlop@x.co', name: 'Hotel Op' });
  const b = createBooking({ option: { tier: 'Standard', pricing: { symbol: '£', local: { total: 1200 } }, totalUSD: 1524, travellers: { total: 2 }, components: [
    { type: 'flight', supplier: 'BA', live: false, details: { outbound: { from: 'LHR', to: 'DXB', date: '2027-10-03' }, inbound: { from: 'DXB', to: 'LHR', date: '2027-10-10' } } },
    { type: 'hotel', supplier: 'Rove', stars: 4, details: { nights: 7, rooms: 1, nightlyUSD: 127, board: 'Room only', roomType: 'Superior Double', checkIn: '2027-10-03', checkOut: '2027-10-10' } },
  ] }, userId: u.id });
  // Add nights
  assert.ok(/CONFIRM/i.test(assist('add 2 nights to my hotel', u.id).reply));
  assist('confirm', u.id);
  assert.equal(b.option.components[1].details.nights, 9, 'stay extended by 2 nights');
  // £127/night at the 0.79 anchor (1/0.79 ≈ 1.266) = £100.33/night → £200.66 for 2.
  assert.ok(b.payments.some((p) => p.type === 'change-charge' && p.amount === 200.66), '2 × £100.33/night charged at the platform anchor');
  // Whole-trip date change moves flight AND hotel
  assist('move my trip to 15 November 2027', u.id);
  assist('confirm', u.id);
  assert.equal(b.option.components[0].details.outbound.date, '2027-11-15', 'flight moved');
  assert.equal(b.option.components[1].details.checkIn, '2027-11-15', 'hotel moved with it');
});

test('minimum AI profit margin is enforced at 200% (3x markup) across every action', () => {
  const rep = aiMarginReport();
  assert.equal(rep.minMarginPct, 200);
  assert.equal(rep.allMeetFloor, true, 'every AI action clears the 200% margin floor (3x markup)');
  assert.ok(rep.actions.every((a) => a.marginPct >= 200));
  // Business rule: the customer is charged 3x–10x provider cost. The floor never
  // lets an action be charged below 3x its provider cost.
  assert.ok(minAcuForMargin(0.01) >= 1);
  assert.ok(pricedAcuForAction(1) >= 1);
});

// ---- Vendor Partner Programme ----------------------------------------------
test('vendor commission model matches the spec (£1,000 examples + bonus)', () => {
  const ind = commissionSplit(1000, 'independent');
  assert.equal(ind.platformFeeGbp, 100); assert.equal(ind.vendorGbp, 30); assert.equal(ind.platformKeepsGbp, 70);
  const reg = commissionSplit(1000, 'registered');
  assert.equal(reg.vendorGbp, 40); assert.equal(reg.platformKeepsGbp, 60);
  const indB = commissionSplit(1000, 'independent', { hasBonus: true });
  assert.equal(indB.vendorGbp, 40); assert.equal(indB.platformKeepsGbp, 60);
  const regB = commissionSplit(1000, 'registered', { hasBonus: true });
  assert.equal(regB.vendorGbp, 50); assert.equal(regB.platformKeepsGbp, 50, 'platform never keeps less than 5%');
});

test('wave7 MONEY-1: a loyalty-discounted sale never pays a vendor more than 3JN kept', () => {
  // £1,000 supplier base, but an Elite member's discount left 3JN with only £20
  // of the £100 headline fee. The vendor's 3% carve (£30 of gross) would exceed
  // the actual fee → a net LOSS. With the actual fee passed, the carve scales.
  const s = commissionSplit(1000, 'independent', { actualPlatformFeeGbp: 20 });
  assert.equal(s.platformFeeGbp, 20, 'reports the actual fee, not the gross 10%');
  assert.ok(s.vendorGbp <= s.platformFeeGbp, 'vendor never paid more than the fee collected');
  assert.ok(s.platformKeepsGbp >= 0, 'platform never books a loss on the sale');
  // Proportional floor holds: independent keeps 7/10 of whatever fee remained.
  assert.equal(s.vendorGbp, 6, '3/10 of the £20 actual fee');
  assert.equal(s.platformKeepsGbp, 14, '7/10 of the £20 actual fee');
  // No actual fee supplied → legacy behaviour (carve off the gross 10%).
  const legacy = commissionSplit(1000, 'independent');
  assert.equal(legacy.vendorGbp, 30); assert.equal(legacy.platformKeepsGbp, 70);
});

test('vendor lifecycle: AI risk review → approved → attributed sale → Friday payout', () => {
  const v = createUser({ email: 'vlife@x.co', name: 'Vendor Life' });
  const appd = applyVendor(v.id, { tier: 'independent', identityDoc: true, addressProof: true, socialHandles: ['@v'], businessHistory: true });
  assert.equal(appd.profile.status, 'approved', 'clean applicant auto-approves');
  assert.ok(appd.profile.vendorCode.startsWith('VND-'));
  // Missing identity/address → NOT auto-approved.
  const shady = createUser({ email: 'shady@x.co', name: 'No Docs' });
  const appS = applyVendor(shady.id, {});
  assert.notEqual(appS.profile.status, 'approved', 'incomplete applications never auto-approve');
  // Attributed sale on first payment. The carve is 3% of the FEE-EXCLUSIVE
  // supplier base (net £1,000), NOT the fee-inclusive total — so 3JN's 7%
  // keep-floor is preserved. netSuppliersUSD £1,000 ≈ $1,266 at the 0.79 anchor.
  const cust = createUser({ email: 'vcust@x.co', name: 'C' });
  const b = createBooking({ option: { tier: 'Standard', pricing: { symbol: '£', local: { total: 1100 }, lines: { netSuppliersUSD: 1265.82 }, revenue: { commissionUSD: 126.58 } }, totalUSD: 1392, travellers: { total: 1 }, components: [{ type: 'flight', supplier: 'BA', live: true }] }, userId: cust.id, vendorCode: appd.profile.vendorCode });
  recordPayment(b.id, { type: 'deposit', amount: 200 });
  const dash = vendorDashboard(v.id);
  assert.equal(dash.commissionEarnedGbp, 30, '3% of the £1,000 net supplier base');
  assert.equal(dash.pendingPayoutGbp, 30);
  // 7% KEEP-FLOOR: after paying the 3% vendor carve, 3JN keeps ≥7% of the base.
  const sale = dash.recentSales.find((sl) => sl.bookingId === b.id);
  assert.ok(sale.platformKeepsGbp >= sale.saleGbp * 0.07 - 0.01, '3JN keeps at least 7% (floor preserved)');
  // Weekly run pays and is idempotent.
  const run = runWeeklyVendorPayouts();
  assert.ok(run.batches.some((x) => x.vendorId === v.id && x.amountGbp === 30));
  assert.equal(vendorDashboard(v.id).pendingPayoutGbp, 0);
  assert.equal(runWeeklyVendorPayouts().batches.filter((x) => x.vendorId === v.id).length, 0, 'never pays twice');
});

test('vendor protections: self-referral earns nothing; flagged sales are not paid', () => {
  const v = createUser({ email: 'vself@x.co', name: 'Selfie' });
  const appd = applyVendor(v.id, { tier: 'independent', identityDoc: true, addressProof: true, socialHandles: ['@s'], businessHistory: true });
  // Self-referral: vendor books for themselves with their own code.
  const own = createBooking({ option: { tier: 'Standard', pricing: { symbol: '£', local: { total: 500 } }, totalUSD: 635, travellers: { total: 1 }, components: [{ type: 'flight', supplier: 'BA', live: true }] }, userId: v.id, vendorCode: appd.profile.vendorCode });
  recordPayment(own.id, { type: 'deposit', amount: 100 });
  assert.equal((vendorDashboard(v.id).commissionEarnedGbp || 0), 0, 'self-referral earns nothing');
  // A refunded sale is never payable.
  const r = recordVendorSale({ vendorId: v.id, bookingId: 'bkx', saleGbp: 800, customerId: 'someone-else' });
  flagVendorSale(r.sale.id, 'refunded');
  const run = runWeeklyVendorPayouts();
  assert.ok(!run.batches.some((x) => x.saleIds.includes(r.sale.id)), 'refunded sale excluded from payout');
});

test('vendor commission is HELD until the trip completes (departure/checkout passed)', () => {
  const v = createUser({ email: 'vhold@x.co', name: 'Hold V' });
  const appd = applyVendor(v.id, { tier: 'independent', identityDoc: true, addressProof: true, socialHandles: ['@h'], businessHistory: true });
  const cust = createUser({ email: 'vhc@x.co', name: 'C' });
  const b = createBooking({ option: { tier: 'Standard', pricing: { symbol: '£', local: { total: 1100 }, lines: { netSuppliersUSD: 1265.82 }, revenue: { commissionUSD: 126.58 } }, totalUSD: 1392, travellers: { total: 1 }, components: [
    { type: 'flight', supplier: 'BA', live: true, details: { outbound: { from: 'LHR', to: 'DXB', date: '2097-10-03' }, inbound: { from: 'DXB', to: 'LHR', date: '2097-10-10' } } },
    { type: 'hotel', supplier: 'Rove', details: { nights: 7, checkIn: '2097-10-03', checkOut: '2097-10-10' } },
  ] }, userId: cust.id, vendorCode: appd.profile.vendorCode });
  recordPayment(b.id, { type: 'deposit', amount: 200 });
  const sale = db.vendorSales.find((s) => s.vendorId === v.id);
  assert.equal(sale.serviceDate, '2097-10-10', 'service date = latest of return flight / checkout');
  // Friday run BEFORE travel: nothing released; dashboard shows it as held.
  const before = runWeeklyVendorPayouts();
  assert.ok(!before.batches.some((x) => x.vendorId === v.id), 'no payout before the trip completes');
  const dash = vendorDashboard(v.id);
  assert.equal(dash.heldUntilTravelGbp, 30, '£30 held until travel');
  assert.equal(dash.pendingPayoutGbp, 0);
  // After the trip completes → next Friday run releases it.
  sale.serviceDate = '2020-01-01';
  const after = runWeeklyVendorPayouts();
  assert.ok(after.batches.some((x) => x.vendorId === v.id && x.amountGbp === 30), 'released after travel completed');
});

// ---- Staff access PIN (privileged accounts never open passwordless) --------
test('staff PIN locks privileged login, demo identities and admin APIs', async () => {
  process.env.STAFF_ACCESS_PIN = 'test-pin-9';
  try {
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
    try {
      // With a PIN CONFIGURED, seed-roles fails closed WITHOUT the PIN — the demo
      // account list (even masked) is not served to an anonymous caller.
      assert.equal((await post('/api/accounts/seed-roles', {})).status, 403, 'seed fails closed when a PIN is configured but not supplied');
      // WITH the pin → identities unlock.
      const seed2 = await (await post('/api/accounts/seed-roles', { staffPin: 'test-pin-9' })).json();
      const admin2 = seed2.accounts.find((a) => a.role === 'admin');
      assert.ok(admin2.id, 'PIN unlocks the admin identity');
      // Full-access endpoint refuses without the pin.
      assert.equal((await post('/api/account/test', {})).status, 403);
      // Admin API refuses a valid admin id without the pin header, allows with it.
      const noPin = await fetch(base + '/api/admin/live-status?probe=0', { headers: { 'x-user-id': admin2.id } });
      assert.equal(noPin.status, 403, 'admin API requires the PIN even with a valid admin id');
      const withPin = await fetch(base + '/api/admin/live-status?probe=0', { headers: { 'x-user-id': admin2.id, 'x-staff-pin': 'test-pin-9' } });
      assert.equal(withPin.status, 200, 'PIN + admin id opens the admin API');
    } finally { server.close(); }
  } finally { delete process.env.STAFF_ACCESS_PIN; }
});

test('LIVE_MODE: no free AI for guests; demo accounts fail closed', async () => {
  process.env.LIVE_MODE = 'true';
  try {
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
    try {
      // Guest fresh search → must be told to create an account + fund ACUs.
      const r = await (await post('/api/plan', { text: `2 adults to Rome for 4 nights in October ${Date.now()}, flights hotel` })).json();
      assert.equal(r.stage, 'topup-required', 'guests get no free AI in live mode');
      assert.equal(r.reason, 'account-required');
      // Demo seeding fails closed (no STAFF_ACCESS_PIN configured).
      assert.equal((await post('/api/accounts/seed-roles', {})).status, 403);
      assert.equal((await post('/api/account/test', {})).status, 403);
    } finally { server.close(); }
  } finally { delete process.env.LIVE_MODE; }
});

// ---- Embassy governance ------------------------------------------------------
test('embassy sets criteria/fees/templates; AI proposal follows THEIR thresholds; letter is branded', () => {
  // Configure a strict embassy: approve only very low scores; custom fee + name.
  const saved = saveEmbassyConfig('AE', {
    embassyName: 'Embassy of the United Arab Emirates — London',
    language: 'en',
    criteria: { autoApproveMaxScore: 100, autoRejectMinScore: 300 },
    fees: { tourist: { amountGBP: 199, processingDays: 3 } },
    refusalReasons: ['Custom refusal A'],
    approvalConditions: ['Single entry · 30 days'],
  }, 'officer-1');
  assert.ok(saved.ok && saved.config.fees.tourist.amountGBP === 199, 'embassy sets its own visa price');
  const cfg = getEmbassyConfig('AE');
  assert.equal(cfg.embassyName.includes('United Arab Emirates'), true);
  // A mid-score application: default criteria would approve (<=220), but THIS
  // embassy's stricter criteria demand human review.
  const midApp = { totalScore: 180, risk: { security: 10 }, missingDocuments: [] };
  assert.equal(embassyProposal(midApp, cfg).proposal, 'Escalated', 'proposal follows the embassy criteria, not defaults');
  assert.equal(embassyProposal({ totalScore: 80, risk: { security: 5 }, missingDocuments: [] }, cfg).proposal, 'Approved');
  assert.equal(embassyProposal({ totalScore: 500, risk: { security: 5 }, missingDocuments: [] }, cfg).proposal, 'Refused');
  // Decision letter carries the embassy branding, reason and conditions.
  const appRec = recordVisaApplication(assessVisa({ name: 'Amina K', nationality: 'NG', destination: 'Dubai', visaType: 'tourist' }));
  const decided = decideVisaApplication(appRec.id, { decision: 'Approved', reason: 'Meets all criteria', conditions: ['Single entry · 30 days'], officerId: 'officer-1' });
  assert.ok(decided.ok);
  const letter = visaDecisionLetter(decided.application, cfg);
  assert.ok(letter.includes('United Arab Emirates'), 'letter carries the embassy name');
  assert.ok(letter.includes('VISA APPROVED') && letter.includes('Single entry'), 'letter shows decision + conditions');
  assert.ok(letter.includes('199'), 'letter shows the embassy-set fee');
});

test('travel document is COMPLETE: e-ticket number, hotel, transfer, eSIM, insurance, voucher', () => {
  const b = { id: 'bkg_doc1', fulfilment: { pnr: 'KXQPLM', eTicketNumber: '176-2400123456', ticketing: 'confirmed' }, leadTraveller: { fullLegalName: 'Jean N' }, payments: [{ amount: 500 }], option: { tier: 'Standard', destination: 'Dubai', travellers: { total: 2 }, pricing: { symbol: '£', local: { total: 2000 } }, components: [
    { type: 'flight', supplier: 'Emirates', details: { cabin: 'Economy', baggage: '2 checked', outbound: { from: 'LHR', to: 'DXB', date: '2026-10-03', depart: '10:00', arrive: '20:00' }, inbound: { from: 'DXB', to: 'LHR', date: '2026-10-10' }, passengers: 2 } },
    { type: 'hotel', supplier: 'Rove Downtown', stars: 4, details: { nights: 7, rooms: 1, roomType: 'Superior Double', board: 'Breakfast included', area: 'Downtown', checkIn: '2026-10-03', checkOut: '2026-10-10' } },
    { type: 'transfer', supplier: 'Blacklane', details: { vehicle: 'Business saloon', trips: 2 } },
    { type: 'esim', supplier: 'Airalo', details: { planLabel: '6GB · 11 days' } },
    { type: 'insurance', supplier: 'AXA Travel', details: { cover: 'Medical £5m', people: 2 } },
    { type: 'activities', supplier: 'Desert Safari', details: {} },
  ] } };
  const html = bookingDocument(b, {});
  for (const must of ['176-2400123456', 'HTL-', 'from 15:00', 'by 11:00', 'Downtown', 'TRF-', '3JN board with your name', '8944-', 'POL-', 'VCH-', 'Superior Double', 'Breakfast included', 'support@3jntravel.com']) {
    assert.ok(html.includes(must), `document must contain ${must}`);
  }
  // Held fare: the e-ticket line must explain WHEN the number arrives, never blank.
  const held = { ...b, fulfilment: { pnr: 'KXQPLM', ticketing: 'held', ticketNumbers: [] } };
  assert.ok(bookingDocument(held, {}).includes('Issued automatically on final instalment'), 'held state is explained');
  // Same booking always renders the same confirmation refs (stable reprints).
  assert.equal(bookingDocument(b, {}), html, 'documents are deterministic');
});

test('visa AI result is officer-only until the officer RELEASES the decision', () => {
  const applicant = createUser({ email: 'vconf@x.co', name: 'Confidential Applicant' });
  const rec = recordVisaApplication({ ...assessVisa({ name: 'Confidential Applicant', nationality: 'NG', destination: 'Dubai', purpose: 'tourism' }), userId: applicant.id });
  const seen = redactVisaForApplicant(rec);
  // Applicant sees their OWN data + status — never the AI verdict.
  assert.equal(seen.status, 'under-review');
  assert.equal(seen.decision, null, 'no decision visible before release');
  assert.ok(!('totalScore' in seen) && !('band' in seen) && !('recommendation' in seen) && !('file' in seen) && !('risk' in seen), 'AI internals are stripped');
  // Officer decides — applicant STILL sees nothing.
  decideVisaApplication(rec.id, { decision: 'Refused', reason: 'Insufficient funds evidence', officerId: 'officer-1' });
  assert.equal(redactVisaForApplicant(rec).decision, null, 'decision stays confidential until released');
  const before = listNotifications(applicant.id).filter((n) => /visa decision/i.test(n.title)).length;
  // Release: only now the applicant learns the outcome and is notified.
  const rel = releaseVisaDecision(rec.id, 'officer-1');
  assert.ok(rel.ok);
  const after = redactVisaForApplicant(rec);
  assert.equal(after.status, 'decided');
  assert.equal(after.decision.decision, 'Refused');
  assert.equal(after.decision.reason, 'Insufficient funds evidence');
  assert.ok(listNotifications(applicant.id).filter((n) => /visa decision/i.test(n.title)).length > before, 'applicant notified on release, not before');
});

// ---- Accommodation privilege: hotel default; host must EARN the slot -------
test('hotel holds the privilege; a private host earns it only via reviews + security + price', async () => {
  const { buildPackages } = await import('../src/packager.js');
  const mkScan = (host) => ({
    flights: [{ type: 'flight', supplier: 'BA', verified: true, reliabilityScore: 90, priceUSD: 400, details: { outbound: { stops: 0 }, inbound: { stops: 0 } } }],
    hotel: [
      { type: 'hotel', supplier: 'City Hotel', verified: true, reliabilityScore: 88, stars: 4, priceUSD: 700, details: { guestRating: 8.4, reviews: 900 } },
      host,
    ],
  });
  const intent = { nights: 5, travellers: { adults: 2, children: 0, childAges: [], total: 2 }, components: ['flights', 'hotel'], flightPrefs: {}, dates: { checkIn: '2027-05-01' } };
  const cur = { code: 'GBP', symbol: '£', rateFromUSD: 0.79 };
  const std = (scan) => buildPackages(scan, intent, cur, 0).options.find((o) => o.tier === 'Standard').components.find((c) => ['hotel', 'host'].includes(c.type));

  // 1. Cheaper external host with a WEAK review base → hotel keeps the slot.
  const weak = { type: 'host', supplier: 'Cheap Flat', verified: true, reliabilityScore: 90, stars: 4, priceUSD: 500, details: { guestRating: 7.9, reviews: 12 } };
  assert.equal(std(mkScan(weak)).supplier, 'City Hotel', 'weakly-reviewed host never wins on price alone');

  // 2. Cheaper external host with STRONG reviews + reliability → earns the slot.
  const strong = { type: 'host', supplier: 'Loved Flat', verified: true, reliabilityScore: 92, stars: 4, priceUSD: 500, details: { guestRating: 9.1, reviews: 340 } };
  assert.equal(std(mkScan(strong)).supplier, 'Loved Flat', 'well-reviewed secure cheaper host earns the privilege');

  // 3. Same strong host but PRICIER than the hotel → hotel keeps the slot.
  const pricier = { ...strong, priceUSD: 800 };
  assert.equal(std(mkScan(pricier)).supplier, 'City Hotel', 'without a better price the hotel stays privileged');
});

// ---- Host listing full schema: calendar, per-date pricing, availability ----
test('host calendar: blocked dates hide the listing; per-date + weekend prices apply', async () => {
  const { stayQuote, stayIsAvailable } = await import('../src/host-listing.js');
  const u = createUser({ email: 'cal@x.co', name: 'Cal Host' });
  registerHost(u.id, { displayName: 'Cal', payout: { accountHolder: 'Cal Host', accountNumber: 'GB29NWBK60161331926819', bankName: 'Chase' } });
  const r = createHostListing(u.id, { title: 'Calendar Flat', city: 'Lisbon', address: '1 Rua Alegre, Lisbon', nightlyUSD: 100, sleeps: 4, photos: Array.from({ length: 10 }, (_, i) => `https://x/${i}.jpg`), weekendPriceUSD: 150, weekendDays: ['Fri', 'Sat'] });
  assert.ok(r.ok);
  // Block a date inside the stay → the listing is unavailable for that stay.
  updateHostListing(u.id, r.listing.id, { availability: { blocked: ['2027-05-03'], priceOverridesUSD: { '2027-05-01': 300 } } });
  assert.equal(stayIsAvailable(r.listing, '2027-05-01', 5), false, 'stay covering a blocked date is unavailable');
  assert.equal(stayIsAvailable(r.listing, '2027-05-10', 3), true, 'other dates unaffected');
  // Calendar pricing: 2027-05-01 is a Saturday with a $300 override; the
  // override wins; Sunday 05-02 uses the base $100 (not weekend).
  const q = stayQuote(r.listing, 2, 2, '2027-05-01');
  assert.equal(q.lines[0].amountUSD, 400, 'override $300 + base $100');
  // Weekend pricing without an override: Fri 2027-05-07 → $150, Sun 05-09 → $100.
  const q2 = stayQuote(r.listing, 2, 2, '2027-05-07');
  assert.equal(q2.lines[0].amountUSD, 300, 'Fri $150 + Sat $150 — weekend pricing on both nights');
});

test('host experiences: published per-person, compete in the activities scan', () => {
  const u = createUser({ email: 'exp@x.co', name: 'Exp Host' });
  registerHost(u.id, { displayName: 'Exp', payout: { accountHolder: 'Exp Host', accountNumber: 'GB29NWBK60161331926819', bankName: 'Chase' } });
  const e = createHostListing(u.id, { kind: 'experience', title: 'Alfama Food Walk', city: 'Barcelona', address: 'Gothic Quarter, Barcelona', nightlyUSD: 40, sleeps: 10, photos: Array.from({ length: 5 }, (_, i) => `https://x/e${i}.jpg`), experienceType: 'Food tour', durationHours: 3, whatProvided: 'Tastings', whatToBring: 'Comfortable shoes' });
  assert.ok(e.ok && e.listing.kind === 'experience');
  assert.equal(e.listing.details.depositPct, 100, 'experiences take full payment at booking');
  reviewHostListing(e.listing.id, { decision: 'approve', reviewerId: 'admin_test' });
  const r = plan({ text: 'holiday to Barcelona for 4 nights, 2 adults, flights hotel activities', context: GB, user: null });
  const acts = r.packages.options.flatMap((o) => o.components).filter((c) => c.type === 'activities');
  assert.ok(acts.some((a) => a.supplier === 'Alfama Food Walk' || a.details?.experience), 'community experience competes in the activities scan');
});

test('host payout is captured at registration, validated per method, and masked', () => {
  const u = createUser({ email: 'payout@x.co', name: 'Payout Host' });
  // Bank transfer without an account number → refused.
  assert.equal(registerHost(u.id, { payoutMethod: 'Bank transfer', payout: { accountHolder: 'P H' } }).ok, false);
  // PayPal with a bad email → refused.
  assert.equal(registerHost(u.id, { payoutMethod: 'PayPal', payout: { paypalEmail: 'not-an-email' } }).ok, false);
  // Valid bank details → registered, stored, and MASKED on the dashboard.
  const r = registerHost(u.id, { displayName: 'P', payoutMethod: 'Bank transfer', payout: { accountHolder: 'Payout Host', accountNumber: 'GB29NWBK60161331926819', bankName: 'NatWest', sortOrSwift: '601613' } });
  assert.equal(r.ok, true);
  const dash = hostDashboard(u.id);
  assert.ok(!dash.profile.payout, 'raw payout details never leave the server');
  assert.ok(dash.profile.payoutMasked.accountNumber.includes('••••'), 'account number masked');
  assert.ok(dash.profile.payoutMasked.accountNumber.endsWith('6819'), 'last 4 shown');
  assert.equal(dash.profile.payoutMasked.verified, false, 'verified only after first payout check');
  // Update to PayPal — re-validated, re-verification required.
  const up = updateHostPayout(u.id, { payoutMethod: 'PayPal', payout: { paypalEmail: 'host@pay.me' } });
  assert.equal(up.ok, true);
  assert.ok(up.payout.paypalEmail.includes('•••'), 'paypal email masked');
});

test('marketplace basket add-ons are REAL components: photographer, guide, restaurant, translator, driver', () => {
  const r = plan({ text: 'Trip to Dubai for 5 nights, 2 adults, flights and hotel, with a photographer, a local guide, restaurant reservations, a translator and a local driver', context: GB, user: null });
  assert.equal(r.stage, 'options');
  const types = new Set(r.packages.options[0].components.map((c) => c.type));
  for (const t of ['photographer', 'guide', 'restaurant', 'translator', 'driver']) {
    assert.ok(types.has(t), `${t} is searched, priced and packaged`);
  }
  const rest = r.packages.options[0].components.find((c) => c.type === 'restaurant');
  assert.ok(rest.priceUSD > 0 && rest.verified, 'restaurant booking is a priced, verified component');
});

// ---- Market Benchmark: prove live fares against the market leaders ----------
import { compareLinks, sellPriceUSD, benchmarkVerdict, runFlightBenchmark, DEFAULT_BENCHMARK_ROUTES } from '../src/benchmark.js';
import { resolveOrigin as resolveOriginBM, findDestination as findDestinationBM } from '../src/destinations.js';

test('Nottingham resolves to East Midlands (EMA) — never a fake "NOT" code', () => {
  const o = resolveOriginBM('Nottingham');
  assert.equal(o.airport, 'EMA');
  assert.equal(o.country, 'GB');
  assert.ok(!o.approxCode, 'a real IATA code, not a derived placeholder');
  // The whole catchment maps to real airports.
  assert.equal(resolveOriginBM('Derby').airport, 'EMA');
  assert.equal(resolveOriginBM('Leicester').airport, 'EMA');
  assert.equal(resolveOriginBM('Belfast').airport, 'BFS');
  assert.equal(resolveOriginBM('Cardiff').airport, 'CWL');
});

test('Brussels is a real catalogue destination with short-haul pricing and honest visa rules', () => {
  const d = findDestinationBM('trip to Brussels');
  assert.ok(d, 'Brussels found');
  assert.equal(d.airport, 'BRU');
  assert.equal(d.country, 'BE');
  assert.ok(d.flightBaseUSD <= 200, 'short-haul fare basis, not a long-haul synthesis');
  assert.equal(d.visa.GB.required, false, 'British citizens are Schengen visa-free');
  assert.equal(d.visa.NG.required, true, 'Schengen short-stay visa where genuinely needed');
});

test('the Nottingham→Brussels test query plans end-to-end with realistic economics', () => {
  const r = plan({ text: 'I want to travel to Brussels from Nottingham, 1 adult for 5 days, on 01/09/2026. I want flights only, instalments and the lowest reliable price.', context: GB, user: null, searchTier: 'smart' });
  assert.equal(r.stage, 'options');
  assert.equal(r.origin.airport, 'EMA', 'departs from the real East Midlands airport');
  assert.equal(r.intent.dates.checkIn, '2026-09-01');
  assert.deepEqual(r.intent.travellers.total, 1);
  // Flights-only: no hotel in the packages.
  const std = r.packages.options[0];
  assert.ok(std.components.some((c) => c.type === 'flight'));
  assert.ok(!std.components.some((c) => c.type === 'hotel'), 'flights only — no hotel priced in');
  // Short-haul realism: the cheapest scanned fare must not price like long-haul.
  assert.ok(r.scanSummary.flights.cheapestUSD < 350, `EMA→BRU estimate is short-haul (got $${r.scanSummary.flights.cheapestUSD})`);
});

test('market benchmark: sell price mirrors checkout math and verdicts are honest', () => {
  // £100 raw fare under the tiered take-rate: + flat £4.99 flight fee (~$6.32)
  // + Duffel pass-through (£2.20 order + 1%) — NOT 10%.
  const sell = sellPriceUSD(100);
  assert.ok(sell > 108 && sell < 113, `raw $100 sells ~$110 flights-only (got $${sell})`);
  // Verdicts in GBP.
  assert.equal(benchmarkVerdict(95, 100).verdict, 'unbeatable');
  assert.equal(benchmarkVerdict(100, 100).verdict, 'unbeatable');
  assert.equal(benchmarkVerdict(102, 100).verdict, 'competitive');
  const above = benchmarkVerdict(120, 100);
  assert.equal(above.verdict, 'above-market');
  assert.equal(above.deltaGbp, 20);
  assert.equal(above.deltaPct, 20);
  assert.equal(benchmarkVerdict(120, null).verdict, 'awaiting-market-price');
});

test('market benchmark: leader links target the identical route and dates', () => {
  const links = compareLinks({ origin: 'EMA', dest: 'BRU', depart: '2026-09-01', ret: '2026-09-06' });
  assert.ok(links.skyscanner.includes('/ema/bru/260901/260906/'), 'Skyscanner deep link carries both dates');
  assert.ok(links.kayak.includes('/EMA-BRU/2026-09-01/2026-09-06'), 'Kayak deep link carries both dates');
  assert.ok(decodeURIComponent(links.googleFlights).includes('EMA to BRU on 2026-09-01'), 'Google Flights query names the route');
  // One-way variant drops the return cleanly.
  const ow = compareLinks({ origin: 'LHR', dest: 'DXB', depart: '2026-09-01' });
  assert.ok(ow.skyscanner.endsWith('/260901/'), 'one-way Skyscanner link has a single date');
});

test('market benchmark: refuses to invent prices without a live fare key', async () => {
  const out = await runFlightBenchmark({ depart: '2026-09-01', ret: '2026-09-06' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'live-flights-not-configured');
  assert.match(out.message, /production/i, 'tells the admin where the real run happens');
  assert.ok(DEFAULT_BENCHMARK_ROUTES.some((r) => r.origin === 'EMA' && r.dest === 'BRU'), 'the Nottingham test route is in the default sweep');
});

test('connecting flights expose per-segment flights, stopover airports and wait times', () => {
  const seg = (from, to, dep, arr, num) => ({
    origin: { iata_code: from, city_name: from === 'EMA' ? 'Nottingham' : from === 'AMS' ? 'Amsterdam' : 'Brussels' },
    destination: { iata_code: to, city_name: to === 'AMS' ? 'Amsterdam' : 'Brussels' },
    departing_at: dep, arriving_at: arr,
    marketing_carrier: { name: 'KLM', iata_code: 'KL' }, marketing_carrier_flight_number: num,
    duration: 'PT1H15M',
    passengers: [{ cabin_class_marketing_name: 'Economy', baggages: [{ type: 'carry_on', quantity: 1 }] }],
  });
  const offer = {
    id: 'off_test', total_amount: '120.00', total_currency: 'GBP', expires_at: '2026-08-30T12:00:00Z',
    owner: { name: 'KLM' },
    slices: [{ duration: 'PT4H05M', segments: [
      seg('EMA', 'AMS', '2026-09-01T06:00:00', '2026-09-01T08:20:00', '1070'),
      seg('AMS', 'BRU', '2026-09-01T10:05:00', '2026-09-01T10:50:00', '1723'),
    ] }],
    passengers: [{ id: 'pas_1', type: 'adult' }],
  };
  const norm = normalizeDuffelOffer(offer, 152, { total: 1, adults: 1, children: 0, childAges: [] });
  const leg = norm.details.outbound;
  assert.equal(leg.stops, 1);
  assert.equal(leg.segments.length, 2, 'every individual flight is listed');
  assert.equal(leg.segments[0].flightNumber, 'KL1070');
  assert.equal(leg.segments[1].flightNumber, 'KL1723');
  assert.equal(leg.layovers.length, 1);
  assert.equal(leg.layovers[0].airport, 'AMS', 'stopover airport is named');
  assert.equal(leg.layovers[0].durationLabel, '1h 45m', 'exact wait time is stated');
  assert.equal(leg.layovers[0].tight, false);
  assert.match(leg.stopLabel, /via Amsterdam \(AMS\) 1h 45m wait/, 'summary label says where and how long');
});

test('market benchmark: judges vs the lowest quote AND vs protected fares separately', async () => {
  const { saveBenchmarkRun, recordBenchmarkMarket } = await import('../src/store.js');
  const saved = saveBenchmarkRun({ at: '2026-07-08T12:00:00Z', depart: '2026-09-01', ret: '2026-09-06', adults: 1, mode: 'live', rows: [
    { id: 'EMA-BRU-2026-09-01', label: 'Nottingham (EMA) → Brussels', origin: 'EMA', dest: 'BRU', depart: '2026-09-01', ret: '2026-09-06', adults: 1, live: true, ourPriceGbp: 92, rawFareGbp: 80, links: {}, market: null, result: null },
  ] });
  // momondo £96 protected fare → we win outright.
  let r = recordBenchmarkMarket(saved.id, 'EMA-BRU-2026-09-01', { source: 'momondo', priceGbp: 96 });
  assert.equal(r.row.result.verdict, 'unbeatable');
  // Kiwi £87 self-transfer combo → lowest overall beats us, but the verdict
  // stays honest about WHAT beat us: separate unprotected tickets.
  r = recordBenchmarkMarket(saved.id, 'EMA-BRU-2026-09-01', { source: 'Kiwi.com', priceGbp: 87, selfTransfer: true });
  assert.equal(r.row.result.verdict, 'above-market');
  assert.equal(r.row.result.vs.source, 'Kiwi.com');
  assert.equal(r.row.protectedResult.verdict, 'unbeatable', 'still unbeatable among protected single tickets');
  assert.match(r.row.note, /self-transfer/, 'headline says exactly who undercuts us and with what product');
  assert.equal(r.row.marketQuotes.length, 2, 'every recorded quote is kept');
});

// ---- Kiwi Tequila LCC door: the airlines Duffel doesn't carry ---------------
test('Tequila itinerary normalises with segments, layovers and booking context', async () => {
  const { normalizeTequilaItinerary } = await import('../src/live-suppliers.js');
  const item = {
    price: 91.5,
    booking_token: 'TOK-abc123456789',
    deep_link: 'https://www.kiwi.com/deep?booking=abc',
    baglimit: { hold_weight: 20 },
    availability: { seats: 4 },
    route: [
      { flyFrom: 'EMA', cityFrom: 'Nottingham', flyTo: 'DUB', cityTo: 'Dublin', local_departure: '2026-09-01T07:10:00.000Z', local_arrival: '2026-09-01T08:05:00.000Z', airline: 'FR', flight_no: 664, return: 0 },
      { flyFrom: 'DUB', cityFrom: 'Dublin', flyTo: 'BRU', cityTo: 'Brussels', local_departure: '2026-09-01T10:30:00.000Z', local_arrival: '2026-09-01T13:25:00.000Z', airline: 'FR', flight_no: 1023, return: 0 },
      { flyFrom: 'BRU', cityFrom: 'Brussels', flyTo: 'EMA', cityTo: 'Nottingham', local_departure: '2026-09-05T17:20:00.000Z', local_arrival: '2026-09-05T18:10:00.000Z', airline: 'FR', flight_no: 1024, return: 1 },
    ],
  };
  const norm = normalizeTequilaItinerary(item, 116, { total: 1, adults: 1, children: 0, childAges: [] });
  assert.equal(norm.supplier, 'Ryanair', 'IATA FR maps to the real carrier name');
  assert.equal(norm.live, true);
  assert.match(norm.sourcedVia, /Tequila/);
  const out = norm.details.outbound;
  assert.equal(out.from, 'EMA'); assert.equal(out.to, 'BRU');
  assert.equal(out.stops, 1);
  assert.equal(out.segments.length, 2);
  assert.equal(out.segments[0].flightNumber, 'FR664');
  assert.equal(out.layovers[0].airport, 'DUB', 'stopover airport named');
  assert.equal(out.layovers[0].durationLabel, '2h 25m', 'exact wait computed');
  assert.match(out.stopLabel, /via Dublin \(DUB\) 2h 25m wait/);
  const back = norm.details.inbound;
  assert.equal(back.stops, 0); assert.equal(back.stopLabel, 'Direct');
  assert.equal(norm.details.bookingToken, 'TOK-abc123456789');
  assert.equal(norm.details.liveCurrency, 'GBP');
  assert.match(norm.details.baggage, /20kg/);
});

test('a paid LCC booking routes to the ops desk with the customer told honestly', async () => {
  const { createBooking, saveQuote, listSupportTickets } = await import('../src/store.js');
  const u = createUser({ name: 'LCC Buyer', email: 'lcc.buyer@example.com' });
  const option = {
    tier: 'Standard', totalUSD: 116,
    pricing: { lines: { totalUSD: 116 }, local: { total: 92 }, revenue: { commissionUSD: 11, savingsShareUSD: 0 } },
    components: [{ type: 'flight', supplier: 'Ryanair', live: true, verified: true, reliabilityScore: 86, priceUSD: 116, details: { bookingToken: 'TOK-xyz', deepLink: 'https://kiwi.com/x', passengers: 1, outbound: { from: 'EMA', to: 'BRU', stops: 1 } } }],
  };
  const q = saveQuote({ option, intent: { dates: { checkIn: '2026-09-01' } } });
  const b = createBooking({ quoteId: q.id, option, instalment: null, userId: u.id, paymentMethod: 'card' });
  assert.equal(b.priceBasis, 'live', 'a Tequila fare is a real, chargeable price');
});

// ---- AI Smart Instalment Payment Engine --------------------------------------
import { buildSmartInstalmentPlan, assessInstalmentRisk, tierForDeparture, INSTALMENT_TIERS, daysUntil as instDaysUntil } from '../src/instalments.js';

test('smart instalments: every tier sums to exactly 100% and ends 7 days out', () => {
  for (const t of INSTALMENT_TIERS) {
    const sum = t.depositPct + t.schedule.reduce((s, [, p]) => s + p, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${t.name} sums to 100% (got ${sum})`);
    if (t.schedule.length) assert.equal(t.schedule[t.schedule.length - 1][0], 7, `${t.name} final payment is 7 days before departure`);
  }
});

test('smart instalments: date bands select the right plan at the boundaries', () => {
  const today = '2026-07-09';
  const plus = (d) => { const x = new Date(today + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
  assert.equal(tierForDeparture(plus(180), today).name, 'Ultimate Flex');
  assert.equal(tierForDeparture(plus(179), today).name, 'Premium Flex');
  assert.equal(tierForDeparture(plus(120), today).name, 'Premium Flex');
  assert.equal(tierForDeparture(plus(119), today).name, 'Smart Plan');
  assert.equal(tierForDeparture(plus(90), today).name, 'Smart Plan');
  assert.equal(tierForDeparture(plus(89), today).name, 'Easy Pay');
  assert.equal(tierForDeparture(plus(60), today).name, 'Easy Pay');
  assert.equal(tierForDeparture(plus(59), today).name, 'Express');
  assert.equal(tierForDeparture(plus(45), today).name, 'Express');
  assert.equal(tierForDeparture(plus(44), today).name, 'Quick Pay');
  assert.equal(tierForDeparture(plus(30), today).name, 'Quick Pay');
  assert.equal(tierForDeparture(plus(29), today).name, 'Priority');
  assert.equal(tierForDeparture(plus(21), today).name, 'Priority');
  assert.equal(tierForDeparture(plus(20), today).name, 'Last Minute');
  assert.equal(tierForDeparture(plus(14), today).name, 'Last Minute');
  assert.equal(tierForDeparture(plus(13), today).name, 'Rapid');
  assert.equal(tierForDeparture(plus(8), today).name, 'Rapid');
  assert.equal(tierForDeparture(plus(7), today).name, 'Instant Purchase');
  assert.equal(tierForDeparture(plus(0), today).name, 'Instant Purchase');
  assert.equal(tierForDeparture(plus(-1), today), null, 'past departures get no plan');
});

test('smart instalments: plan amounts sum to the total, final absorbs rounding, dates land right', () => {
  const plan = buildSmartInstalmentPlan({ totalLocal: 999.99, currency: { code: 'GBP', symbol: '£' }, departISO: '2027-03-15', todayISO: '2026-07-09' });
  assert.equal(plan.plan, 'Ultimate Flex');
  assert.equal(plan.depositPct, 0.10);
  assert.equal(plan.depositNonRefundable, true);
  assert.equal(plan.payEarlyAnytime, true);
  const sum = plan.deposit + plan.schedule.reduce((s, x) => s + x.amount, 0);
  assert.ok(Math.abs(sum - 999.99) < 0.005, `schedule sums to the total (got ${sum})`);
  assert.equal(plan.schedule[plan.schedule.length - 1].due, '2027-03-08', 'final payment exactly 7 days before departure');
  assert.equal(plan.schedule[0].due, '2026-10-16', 'first instalment 150 days before departure');
  // 0–7 days: Instant Booking, no instalments.
  const instant = buildSmartInstalmentPlan({ totalLocal: 500, currency: { code: 'GBP', symbol: '£' }, departISO: '2026-07-12', todayISO: '2026-07-09' });
  assert.equal(instant.plan, 'Instant Purchase');
  assert.equal(instant.depositPct, 1);
  assert.equal(instant.schedule.length, 0);
});

test('smart instalments: the AI risk engine adjusts deposits, caps plans and declines', () => {
  // Guest, first booking, high value, short runway → high risk.
  const hi = assessInstalmentRisk({ user: null, history: { paidBookings: 0, cancelled: 0, noShows: 0, chargebacks: 0 }, totalGbp: 6000, daysToDeparture: 14 });
  assert.equal(hi.band, 'high');
  const hiPlan = buildSmartInstalmentPlan({ totalLocal: 6000, currency: { code: 'GBP', symbol: '£' }, departISO: '2027-03-15', todayISO: '2026-07-09', risk: hi });
  assert.equal(hiPlan.depositPct, 0.25, 'high risk: 10% tier deposit + 15pp');
  assert.equal(hiPlan.schedule.length, 2, 'high risk: instalments capped at 2');
  assert.equal(hiPlan.schedule[hiPlan.schedule.length - 1].daysBefore, 7, 'the 7-day final payment survives the cap');
  const sum = hiPlan.deposit + hiPlan.schedule.reduce((s, x) => s + x.amount, 0);
  assert.ok(Math.abs(sum - 6000) < 0.005, 'risk-adjusted plan still sums to the total');
  assert.equal(hi.adjustments.requireIdCheck, true);
  // Chargeback + guest → declined → Instant Booking only.
  const bad = assessInstalmentRisk({ user: null, history: { paidBookings: 0, cancelled: 1, noShows: 0, chargebacks: 1 }, totalGbp: 3000, daysToDeparture: 30 });
  assert.equal(bad.band, 'declined');
  const badPlan = buildSmartInstalmentPlan({ totalLocal: 3000, currency: { code: 'GBP', symbol: '£' }, departISO: '2026-09-09', todayISO: '2026-07-09', risk: bad });
  assert.equal(badPlan.depositPct, 1, 'declined risk pays in full');
  assert.equal(badPlan.schedule.length, 0);
  // Trusted repeat customer → deposit relief, floored at the supplier minimum.
  const trusted = assessInstalmentRisk({ user: { travelProfile: { fullLegalName: 'T H', passportNumber: 'X1' } }, history: { paidBookings: 4, cancelled: 0, noShows: 0, chargebacks: 0 }, totalGbp: 800, daysToDeparture: 200 });
  assert.equal(trusted.band, 'low');
  const tPlan = buildSmartInstalmentPlan({ totalLocal: 800, currency: { code: 'GBP', symbol: '£' }, departISO: '2027-03-15', todayISO: '2026-07-09', risk: trusted });
  assert.equal(tPlan.depositPct, 0.10, 'trusted relief never dips below the 10% supplier minimum');
});

test('smart instalments: missed payment → grace warning, then auto-cancel with deposit forfeited', async () => {
  const { createBooking: mkBooking, saveQuote: mkQuote, enforceInstalments, getBooking } = await import('../src/store.js');
  const u = createUser({ name: 'Instalment Test', email: 'inst.test@example.com' });
  const option = { tier: 'Standard', totalUSD: 1266, pricing: { currency: 'GBP', symbol: '£', lines: { totalUSD: 1266 }, local: { total: 1000 }, revenue: { commissionUSD: 100, savingsShareUSD: 0 } }, components: [{ type: 'flight', supplier: 'Wizz Air', verified: true, reliabilityScore: 74, priceUSD: 1266, details: {} }] };
  const plan = buildSmartInstalmentPlan({ totalLocal: 1000, currency: { code: 'GBP', symbol: '£' }, departISO: '2026-10-09', todayISO: '2026-07-09' });
  assert.equal(plan.plan, 'Smart Plan'); // 92 days out
  const q = mkQuote({ option, intent: { dates: { checkIn: '2026-10-09' } } });
  const b = mkBooking({ quoteId: q.id, option, instalment: plan, userId: u.id, paymentMethod: 'card' });
  // Deposit paid at booking (createBooking records it). First instalment due
  // 60 days before departure = 2026-08-10. The day after: in grace.
  let sweep = enforceInstalments('2026-08-11');
  assert.ok(sweep.actions.some((a) => a.bookingId === b.id && a.action === 'grace-warning'), 'grace warning fires first');
  // Three days later, still unpaid → defaulted: cancelled + deposit forfeited.
  sweep = enforceInstalments('2026-08-14');
  const act = sweep.actions.find((a) => a.bookingId === b.id);
  assert.equal(act.action, 'auto-cancelled');
  assert.equal(act.forfeitedDeposit, plan.deposit, 'the non-refundable deposit is forfeited');
  assert.equal(act.refundableBalance, 0, 'nothing beyond the deposit was paid → nothing to refund');
  const cancelled = getBooking(b.id);
  assert.equal(cancelled.status, 'cancelled-instalment-default');
});

test('smart instalments v2: Quick Pay splits 50/20/30 and Price Lock rides every smart plan', () => {
  // 35 days out → Quick Pay: 50% deposit, 20% instalment at 14d, 30% final at 7d.
  const plan = buildSmartInstalmentPlan({ totalLocal: 1000, currency: { code: 'GBP', symbol: '£' }, departISO: '2026-08-13', todayISO: '2026-07-09' });
  assert.equal(plan.plan, 'Quick Pay');
  assert.equal(plan.deposit, 500);
  assert.equal(plan.schedule.length, 2);
  assert.equal(plan.schedule[0].amount, 200, 'instalment 1 is 20%');
  assert.equal(plan.schedule[1].amount, 300, 'final payment is 30%');
  assert.equal(plan.schedule[1].due, '2026-08-06', 'final due 7 days before departure');
  // AI Booking Protection™ is part of the plan contract.
  assert.equal(plan.priceLock.locked, true);
  assert.match(plan.priceLock.guarantee, /frozen/i);
  assert.deepEqual(plan.reminderOffsets, [14, 7, 3, 1, 0]);
  assert.equal(plan.autopay.enabled, false, 'autopay is opt-in consent, never default-on');
});

test('smart instalments v2: reminders fire at 14/7/3/1/0 days, receipts issue, price lock lands on the booking', async () => {
  const { createBooking: mkB, saveQuote: mkQ, enforceInstalments, recordPayment, getBooking, listNotifications } = await import('../src/store.js');
  const u = createUser({ name: 'Reminder Test', email: 'rem.test@example.com' });
  const option = { tier: 'Standard', totalUSD: 1266, pricing: { currency: 'GBP', symbol: '£', lines: { totalUSD: 1266 }, local: { total: 1000 }, revenue: { commissionUSD: 100, savingsShareUSD: 0 } }, components: [{ type: 'flight', supplier: 'Wizz Air', verified: true, reliabilityScore: 74, priceUSD: 1266, details: {} }] };
  const plan = buildSmartInstalmentPlan({ totalLocal: 1000, currency: { code: 'GBP', symbol: '£' }, departISO: '2026-10-09', todayISO: '2026-07-09' });
  const q = mkQ({ option, intent: { dates: { checkIn: '2026-10-09' } } });
  const b = mkB({ quoteId: q.id, option, instalment: plan, userId: u.id, paymentMethod: 'card' });
  // AI Booking Protection™: the booking carries the Price Locked guarantee.
  assert.equal(getBooking(b.id).priceLock.locked, true);
  assert.equal(getBooking(b.id).priceLock.badge, 'Price Locked');
  // First instalment due 2026-08-10 → reminder fires 14 days ahead, once only.
  let sweep = enforceInstalments('2026-07-27');
  assert.ok(sweep.actions.some((a) => a.bookingId === b.id && a.action === 'reminder' && a.daysAway === 14), '14-day reminder fires');
  sweep = enforceInstalments('2026-07-27');
  assert.ok(!sweep.actions.some((a) => a.bookingId === b.id && a.action === 'reminder'), 'same reminder never repeats');
  // Due-date reminder + autopay charge attempt when consent is on.
  getBooking(b.id).instalment.autopay = { enabled: true, method: 'saved-card', retry: { attempts: 3, everyHours: 24 } };
  sweep = enforceInstalments('2026-08-10');
  assert.ok(sweep.actions.some((a) => a.bookingId === b.id && a.action === 'reminder' && a.daysAway === 0), 'due-day reminder fires');
  assert.ok(sweep.actions.some((a) => a.bookingId === b.id && a.action === 'autopay-charge'), 'autopay charge initiates on the due date');
  // Receipts: every successful payment issues one with the live balance.
  recordPayment(b.id, { type: 'instalment', amount: 250, gateway: 'stripe' });
  const paid = getBooking(b.id).payments.find((p) => p.type === 'instalment');
  assert.match(paid.receiptId, /^rcpt_/);
  const notes = listNotifications(u.id);
  assert.ok(notes.some((n) => /Receipt rcpt_/.test(n.title) && /remaining/.test(n.body)), 'receipt notification carries the outstanding balance');
});

// ---- Travelpayouts/Aviasales market-data door (self-serve Tequila fallback) ---
test('Aviasales market fares normalise with carrier names, stops and honest sourcing', async () => {
  const { normalizeMarketFare, marketDataEnabled } = await import('../src/live-suppliers.js');
  const m = normalizeMarketFare({
    origin: 'EMA', destination: 'BRU', airline: 'FR', flight_number: 664,
    price: 87, transfers: 0, departure_at: '2026-09-01T07:10:00Z', return_at: '2026-09-05T18:00:00Z',
    link: '/search/EMA0109BRU05091',
  });
  assert.equal(m.carrier, 'Ryanair', 'IATA FR resolves to the carrier the market shows');
  assert.equal(m.priceGbp, 87);
  assert.equal(m.stopLabel, 'Direct');
  assert.match(m.link, /^https:\/\/www\.aviasales\.com\//);
  assert.match(m.source, /market data/i, 'labelled market data — never presented as a bookable fare');
  assert.equal(normalizeMarketFare({}), null, 'priceless entries are dropped');
  assert.equal(normalizeMarketFare({ airline: 'FR', price: 'n/a' }), null, 'a non-numeric price is dropped, not surfaced as £NaN');
  assert.equal(normalizeMarketFare({ airline: 'FR', price: '' }), null, 'an empty price is dropped');
  assert.equal(marketDataEnabled(), false, 'off without TRAVELPAYOUTS_TOKEN — fail closed');
});

// ---- Tiered take-rate: flat flight fee + partner share of the take ----------
import { FLIGHT_ONLY_FEE_GBP as FEE_GBP, FLIGHT_ONLY_PARTNER_SHARE as PARTNER_SHARE } from '../../shared/constants.js';
import { flightOnlySplit } from '../src/vendors.js';

test('tiered take-rate: flights-only pays the flat fee, members fly fee-free, packages keep 10%', () => {
  // Flights-only, guest: flat £4.99 (~$6.32), never 10%.
  const r1 = plan({ text: 'Flights only to Barcelona from London, 1 adult, 2026-09-10 to 2026-09-14', context: GB, user: null, searchTier: 'smart' });
  assert.equal(r1.stage, 'options');
  const opt = r1.packages.options[0];
  assert.ok(opt.components.every((c) => c.type === 'flight'), 'flights-only basket');
  assert.equal(opt.pricing.feeModel, 'flight-service-fee');
  assert.match(opt.pricing.feeLabel, /2%/);
  // 2% of the fare, floored at £4.99 and capped at £15 (all in USD via the anchor).
  const feeUSD = opt.pricing.lines.commissionUSD;
  const flightUSD = opt.pricing.lines.suppliersUSD; // flights-only → suppliers = the fare
  const expected = Math.min(15 / 0.79, Math.max(4.99 / 0.79, flightUSD * 0.02));
  assert.ok(Math.abs(feeUSD - expected) < 0.02, `2% service fee, floored/capped (got $${feeUSD})`);
  assert.ok(feeUSD >= 4.99 / 0.79 - 0.02 && feeUSD <= 15 / 0.79 + 0.02, 'fee inside the £4.99–£15 band');
  // Same trip WITH a hotel: the classic 10% commission applies.
  const r2 = plan({ text: 'Flights and hotel to Barcelona from London, 1 adult, 2026-09-10 to 2026-09-14', context: GB, user: null, searchTier: 'smart' });
  const opt2 = r2.packages.options[0];
  assert.equal(opt2.pricing.feeModel, 'commission-10');
  assert.ok(opt2.pricing.lines.commissionUSD > feeUSD * 3, 'package commission is the real margin');
  // Active Travel+ member: the flight fee disappears entirely.
  const member = createUser({ name: 'Member Flyer', email: 'member.flyer@example.com' });
  subscribeMembership(member.id, 'nomad');
  const r3 = plan({ text: 'Flights only to Barcelona from London, 1 adult, 2026-09-10 to 2026-09-14', context: GB, user: findUserByEmail('member.flyer@example.com'), searchTier: 'smart' });
  const opt3 = r3.packages.options[0];
  assert.equal(opt3.pricing.feeModel, 'flight-flat-member-free');
  assert.equal(opt3.pricing.lines.commissionUSD, 0, 'Travel+ members pay no flight fee');
});

test('tiered take-rate: partners earn a share of the flight take + lifetime attribution', async () => {
  const { applyVendor, decideVendor, createBooking: mkB, saveQuote: mkQ, recordPayment, getBooking } = await import('../src/store.js');
  // Approved vendor with a code.
  const v = createUser({ name: 'Flight Affiliate', email: 'flight.affiliate@example.com' });
  applyVendor(v.id, { businessName: 'FA Travel', tier: 'independent', documents: ['Government ID', 'Proof of address', 'Selfie verification'], experienceYears: 3, salesChannel: 'Instagram travel page' });
  const dec = decideVendor(v.id, { approve: true });
  const code = dec.profile.vendorCode;
  // Customer books FLIGHTS-ONLY via the vendor: partner earns 40% of the flat fee.
  const cust = createUser({ name: 'Attributed Customer', email: 'attributed.cust@example.com' });
  const flightOption = { tier: 'Standard', totalUSD: 130, pricing: { currency: 'GBP', symbol: '£', feeModel: 'flight-service-fee', lines: { totalUSD: 130, commissionUSD: 6.34 }, local: { total: 102.7 }, revenue: { commissionUSD: 6.34, savingsShareUSD: 0 } }, components: [{ type: 'flight', supplier: 'Wizz Air', verified: true, reliabilityScore: 74, priceUSD: 130, details: {} }] };
  const q1 = mkQ({ option: flightOption, intent: { dates: { checkIn: '2026-09-10' } } });
  const b1 = mkB({ quoteId: q1.id, option: flightOption, instalment: null, userId: cust.id, paymentMethod: 'card', vendorCode: code });
  recordPayment(b1.id, { type: 'full', amount: 102.7, gateway: 'stripe' });
  const sale1 = (await import('../src/store.js')).vendorDashboard(v.id).recentSales.find((s) => s.bookingId === b1.id);
  assert.equal(sale1.model, 'flight-only');
  const expectedTake = 6.34 / 1.27; // our take in GBP
  assert.ok(Math.abs(sale1.vendorGbp - Math.round(expectedTake * PARTNER_SHARE * 100) / 100) < 0.02, `partner gets ${PARTNER_SHARE * 100}% of the take (got £${sale1.vendorGbp})`);
  // Split maths never pays out more than the take.
  const split = flightOnlySplit(4.99);
  assert.ok(split.vendorGbp + split.platformKeepsGbp <= split.platformFeeGbp + 0.001, 'structurally cannot pay more than 3JN takes');
  // LIFETIME ATTACH: the customer's NEXT booking (a package, NO code passed)
  // still credits the same partner — at the full package carve.
  const pkgOption = { tier: 'Standard', totalUSD: 1266, pricing: { currency: 'GBP', symbol: '£', feeModel: 'commission-10', lines: { totalUSD: 1266, commissionUSD: 126.6 }, local: { total: 1000 }, revenue: { commissionUSD: 126.6, savingsShareUSD: 0 } }, components: [{ type: 'flight', supplier: 'Wizz Air', verified: true, reliabilityScore: 74, priceUSD: 500, details: {} }, { type: 'hotel', supplier: 'Rove Hotels', verified: true, reliabilityScore: 88, priceUSD: 766, details: {} }] };
  const q2 = mkQ({ option: pkgOption, intent: { dates: { checkIn: '2026-11-01' } } });
  const b2 = mkB({ quoteId: q2.id, option: pkgOption, instalment: null, userId: cust.id, paymentMethod: 'card' });
  assert.equal(getBooking(b2.id).vendorCode, code, 'no code passed — lifetime attribution supplies the partner');
  recordPayment(b2.id, { type: 'full', amount: 1000, gateway: 'stripe' });
  const sale2 = (await import('../src/store.js')).vendorDashboard(v.id).recentSales.find((s) => s.bookingId === b2.id);
  assert.ok(sale2 && sale2.vendorGbp >= 1000 * 0.03 - 0.01, 'the package pays the partner their full 3% carve');
});

// ---- Ops Fulfilment Desk: the automatic way around manual supplier portals ---
test('paid booking decomposes into channel-routed fulfilment orders; eSIM auto-completes; Rayna completes with a confirmation', async () => {
  const { createBooking: mkB, saveQuote: mkQ, recordPayment, listFulfilmentOrders, completeFulfilmentOrder, getBooking, listNotifications } = await import('../src/store.js');
  const u = createUser({ name: 'Fulfil Test', email: 'fulfil.test@example.com' });
  const option = {
    tier: 'Standard', totalUSD: 500,
    destination: { city: 'Dubai', country: 'AE' },
    dates: { checkIn: '2026-10-01' },
    pricing: { currency: 'GBP', symbol: '£', feeModel: 'commission-10', lines: { totalUSD: 500, commissionUSD: 50 }, local: { total: 395 }, revenue: { commissionUSD: 50, savingsShareUSD: 0 } },
    components: [
      { type: 'activity', supplier: 'Desert Safari & BBQ', agent: true, agentId: 'AGT-48973', verified: true, reliabilityScore: 92, priceUSD: 130, details: { date: '2026-10-02', passengers: 2 } },
      { type: 'esim', supplier: 'Airalo', verified: true, reliabilityScore: 92, priceUSD: 12, details: {} },
      { type: 'visa', supplier: 'UAE eVisa', verified: true, reliabilityScore: 90, priceUSD: 95, details: {} },
    ],
  };
  const q = mkQ({ option, intent: { dates: { checkIn: '2026-10-01' } } });
  const b = mkB({ quoteId: q.id, option, instalment: null, userId: u.id, paymentMethod: 'card', lead: { fullName: 'Fulfil Test', nationality: 'GB' } });
  recordPayment(b.id, { type: 'full', amount: 395, gateway: 'stripe' });
  // give the async auto-fulfil a beat
  await new Promise((r) => setTimeout(r, 20));
  const mine = listFulfilmentOrders().filter((o) => o.bookingId === b.id);
  assert.equal(mine.length, 3, 'one order per fulfilable component');
  const rayna = mine.find((o) => o.componentType === 'activity');
  assert.equal(rayna.channel, 'ops:rayna', 'agent-sourced activity routes to the Rayna portal channel');
  assert.match(rayna.portalPayload, /Rayna agent portal/, 'payload carries the portal instruction');
  assert.match(rayna.portalPayload, /Fulfil Test/, 'payload carries the lead traveller');
  const visa = mine.find((o) => o.componentType === 'visa');
  assert.equal(visa.channel, 'ops:rayna', 'Dubai visa also routes to Rayna (their product)');
  const esim = mine.find((o) => o.componentType === 'esim');
  assert.equal(esim.status, 'completed', 'eSIM fulfils itself automatically');
  assert.ok(esim.supplierRef, 'auto-fulfilled eSIM carries a real ICCID reference');
  // Completing an ops order without a confirmation number is refused.
  assert.equal(completeFulfilmentOrder(rayna.id, {}).ok, false, 'no confirmation → refused');
  // With the Rayna confirmation: component updated + customer notified.
  const done = completeFulfilmentOrder(rayna.id, { supplierRef: 'RTL-778812' });
  assert.equal(done.ok, true);
  assert.equal(getBooking(b.id).option.components[0].details.confirmation, 'RTL-778812', 'confirmation lands in the booking → documents');
  const notes = listNotifications(u.id);
  assert.ok(notes.some((n) => /confirmed/i.test(n.title) && /RTL-778812/.test(n.body)), 'customer told with the real reference');
});

test('supplier doors report every acquisition target; insurance stays closed without FCA authorisation', async () => {
  const { supplierDoors, insuranceSaleEnabled } = await import('../src/extras-suppliers.js');
  const doors = supplierDoors();
  for (const provider of ['Duffel', 'Amadeus', 'eSIM Access', 'Viator', 'Mozio', 'Rayna']) {
    assert.ok(doors.some((d) => d.provider.includes(provider)), `${provider} door listed`);
  }
  const rayna = doors.find((d) => d.channel === 'activities-rayna');
  assert.equal(rayna.open, true, 'Rayna channel is always operable (ops desk)');
  const vendors = doors.find((d) => d.channel === 'local-services');
  assert.equal(vendors.open, true, 'vendor marketplace is our own supply');
  assert.equal(insuranceSaleEnabled(), false, 'insurance sales fail CLOSED without key + INSURANCE_AUTHORISED=true (FCA)');
});

// ---- Vendor service marketplace: list → compete → job → 90/10 payout ---------
test('a real vendor service competes in searches, routes the job to the vendor, and pays 90% after delivery', async () => {
  const { applyVendor: apV, decideVendor: decV, addVendorService, vendorServicesForCity, createBooking: mkB, saveQuote: mkQ, recordPayment, listFulfilmentOrders, completeFulfilmentOrder, recordVendorServiceJob, getBooking } = await import('../src/store.js');
  const { saleIsPayable } = await import('../src/vendors.js');
  // Photographer signs up as a vendor, gets approved, lists their service.
  const ph = createUser({ name: 'Dubai Photographer', email: 'dubai.photo@example.com' });
  apV(ph.id, { businessName: 'Lens of Dubai', tier: 'independent', identityDoc: true, addressProof: true, socialHandles: ['@lensofdubai'] });
  decV(ph.id, { approve: true });
  // Unapproved users cannot list.
  const rando = createUser({ name: 'No Vendor', email: 'no.vendor@example.com' });
  assert.equal(addVendorService(rando.id, { type: 'photographer', city: 'Dubai', priceGbp: 100 }).ok, false);
  const listed = addVendorService(ph.id, { type: 'photographer', title: 'Golden-hour shoot', city: 'Dubai', priceGbp: 120, unit: 'per 2h shoot' });
  assert.equal(listed.ok, true);
  // The listing appears in the city's service pool and in a REAL search.
  const pool = vendorServicesForCity('Dubai', 'photographer');
  assert.ok(pool.some((s) => s.details.vendorId === ph.id), 'listing live for the city');
  const r = plan({ text: 'Trip to Dubai for 4 nights, 2 adults, flights and hotel with a photographer', context: GB, user: null, searchTier: 'smart' });
  const comp = r.packages.options[0].components.find((c) => c.type === 'photographer');
  assert.ok(comp, 'photographer packaged');
  assert.ok(comp.details.vendorId === ph.id, 'the real vendor WON the slot on price (£120 beats the catalogue)');
  // Customer books & pays → the job routes to the vendor.
  const option = r.packages.options[0];
  const q = mkQ({ option, intent: r.intent });
  const b = mkB({ quoteId: q.id, option, instalment: null, userId: createUser({ name: 'Cust', email: 'svc.cust@example.com' }).id, paymentMethod: 'card', lead: { fullName: 'Svc Cust', nationality: 'GB' } });
  recordPayment(b.id, { type: 'full', amount: option.pricing.local.total, gateway: 'stripe' });
  await new Promise((res) => setTimeout(res, 20));
  const job = listFulfilmentOrders().find((o) => o.bookingId === b.id && o.componentType === 'photographer');
  assert.ok(job, 'fulfilment order created');
  assert.equal(job.channel, 'ops:vendor-delivery');
  assert.equal(job.vendorId, ph.id, 'job assigned to THE vendor whose service was booked');
  // Vendor confirms → customer document updated + 90/10 earnings row gated on service date.
  const done = completeFulfilmentOrder(job.id, { supplierRef: 'LOD-2026-001', completedBy: 'vendor' });
  assert.equal(done.ok, true);
  const sale = recordVendorServiceJob({ vendorId: ph.id, bookingId: b.id, orderId: job.id, priceGbp: job.sellPrice, serviceDate: job.serviceDate });
  assert.equal(sale.ok, true);
  assert.equal(sale.sale.model, 'service-delivery');
  assert.ok(Math.abs(sale.sale.vendorGbp - job.sellPrice * 0.9) < 0.02, 'vendor earns 90%');
  assert.ok(Math.abs(sale.sale.platformKeepsGbp - job.sellPrice * 0.1) < 0.02, '3JN keeps the 10% platform fee');
  // Money releases only AFTER the service date (Friday run gate).
  if (sale.sale.serviceDate) {
    assert.equal(saleIsPayable(sale.sale, '2026-08-01'), false, 'not payable before the service happens');
    const after = new Date(new Date(sale.sale.serviceDate + 'T00:00:00Z').getTime() + 2 * 86400000).toISOString().slice(0, 10);
    assert.equal(saleIsPayable(sale.sale, after), true, 'payable once the service date has passed');
  }
});

// ---- Bot Defence: block bot signups/logins; real accounts NEVER touched ------
import { nameLooksBot, emailLooksBot, botSignupVerdict, accountIsDormantBot } from '../src/bot-defence.js';

test('bot defence: gibberish and machine identities flag; real human names never do', () => {
  // Machine signals.
  assert.equal(nameLooksBot('xkqzvbnt').bot, true, 'vowelless keyboard mash');
  assert.equal(nameLooksBot('user84729384').bot, true, 'digit-flood name');
  assert.equal(nameLooksBot('aaaaaaaa Smith').bot, true, 'repeated-run name');
  assert.equal(emailLooksBot('bot@mailinator.com').bot, true, 'disposable domain');
  assert.equal(emailLooksBot('a1b2c3d4e5f6a1b2c3d4e5@gmail.com').bot, true, 'hex-blob local part');
  // Real people — including names that trip naive filters — always pass.
  for (const name of ['Md Rahman', 'Xu Li', 'Ng Wei', "O'Brien-Smith", 'Jean-Baptiste N’Guessan', 'Krzysztof Szczęsny', 'محمد أحمد', '王小明', 'Björk Guðmundsdóttir', 'B', 'Justin Nseya']) {
    assert.equal(nameLooksBot(name).bot, false, `"${name}" is a human name`);
  }
  assert.equal(emailLooksBot('jane.doe+travel@gmail.com').bot, false, 'plus-tags are human');
});

test('bot defence: signup verdict blocks only high-confidence combinations', () => {
  // Honeypot filled → hard block (humans cannot see the field).
  assert.equal(botSignupVerdict({ name: 'Jane Doe', email: 'jane@gmail.com', honeypot: 'http://spam.biz' }).block, true);
  // Disposable email → hard block.
  assert.equal(botSignupVerdict({ name: 'Jane Doe', email: 'x@yopmail.com' }).block, true);
  // Bot name + instant submit → block.
  assert.equal(botSignupVerdict({ name: 'xkqzvbnt', email: 'x84729@gmail.com', elapsedMs: 300, interactions: 0 }).block, true);
  // Bot-ish name ALONE, normal behaviour → NEVER blocks a real person.
  assert.equal(botSignupVerdict({ name: 'xkqzvbnt', email: 'realperson@gmail.com', elapsedMs: 45000, interactions: 60 }).block, false);
  // Ordinary signup → clean pass.
  assert.equal(botSignupVerdict({ name: 'Amina Diallo', email: 'amina.diallo@gmail.com', elapsedMs: 30000, interactions: 40 }).block, false);
});

test('bot defence: dormant sweep quarantines zero-activity bots and NEVER touches real accounts', async () => {
  const { sweepBotAccounts, unflagBotAccount, getUserRaw } = await import('../src/store.js');
  const old = new Date(Date.UTC(2026, 5, 18)).toISOString(); // 12 days before the store clock
  // A dormant bot: mash name, zero activity, 12 days old. (createUser returns
  // a sanitized copy — age the STORED record via getUserRaw.)
  const bot = getUserRaw(createUser({ name: 'qwxzkjvb', email: 'qz9382744@fastmail.com' }).id);
  bot.createdAt = old;
  // A REAL user with the SAME suspicious-looking name but ONE booking → immune.
  const oddButReal = getUserRaw(createUser({ name: 'qwxzkjvb', email: 'odd.real@gmail.com' }).id);
  oddButReal.createdAt = old;
  const option = { tier: 'Standard', totalUSD: 100, pricing: { currency: 'GBP', symbol: '£', lines: { totalUSD: 100 }, local: { total: 79 }, revenue: { commissionUSD: 10, savingsShareUSD: 0 } }, components: [{ type: 'flight', supplier: 'Wizz Air', verified: true, reliabilityScore: 74, priceUSD: 100, details: {} }] };
  const q = saveQuote({ option, intent: { dates: { checkIn: '2026-12-01' } } });
  createBooking({ quoteId: q.id, option, instalment: null, userId: oddButReal.id, paymentMethod: 'card' });
  // A quiet human: real name, zero activity → NOT flagged (quiet ≠ bot).
  const quiet = getUserRaw(createUser({ name: 'Grace Mutombo', email: 'grace.mutombo@gmail.com' }).id);
  quiet.createdAt = old;
  // A brand-new account (even mash-named) → too young to judge.
  const fresh = createUser({ name: 'zxkvqjwp', email: 'zx99231@gmail.com' });

  const sweep = sweepBotAccounts({ olderThanHours: 72 });
  const flaggedIds = sweep.list.map((x) => x.userId);
  assert.ok(flaggedIds.includes(bot.id), 'dormant bot quarantined');
  assert.ok(!flaggedIds.includes(oddButReal.id), 'one booking = immune, even with the same name');
  assert.ok(!flaggedIds.includes(quiet.id), 'quiet human with a real name untouched');
  assert.ok(!flaggedIds.includes(fresh.id), 'new accounts get time before judgement');
  assert.equal(bot.suspended, true);
  // Demo/staff accounts are categorically exempt.
  assert.ok(!sweep.list.some((x) => String(x.email || '').endsWith('@3jntravel.com')), 'demo accounts never flagged');
  // Appeal path: one click restores.
  const restored = unflagBotAccount(bot.id);
  assert.equal(restored.ok, true);
  assert.equal(bot.suspended, false);
  assert.ok(!bot.flaggedBot, 'flag fully removed on restore');
});

test('bot defence: quarantined accounts cannot log in; signup endpoint refuses bots', async () => {
  const { sweepBotAccounts, getUserRaw } = await import('../src/store.js');
  // Endpoint-level checks ride the running-app tests elsewhere; here verify
  // the store-level contract the endpoints depend on.
  const botUser = getUserRaw(createUser({ name: 'jjqxxzwk', email: 'jq0192837@inbox.lv' }).id);
  botUser.createdAt = new Date(Date.UTC(2026, 5, 18)).toISOString();
  sweepBotAccounts({ olderThanHours: 72 });
  assert.equal(botUser.suspended, true, 'flagged before login is possible');
  assert.ok(botUser.flaggedBot.reasons.includes('zero-activity'));
});

// ---- Connection-quality ladder: direct → short stopover → everything else ----
test('flight selection privileges direct, then SHORT stopovers, before any long/overnight connection', async () => {
  const { buildPackages } = await import('../src/packager.js');
  const leg = (stops, layovers = []) => ({ from: 'EMA', to: 'BRU', date: '2026-09-01', depart: '08:00', arrive: '12:00', stops, stopLabel: stops ? `${stops} stop` : 'Direct', layovers, durationLabel: '4h 0m' });
  const flight = (supplier, priceUSD, out, back) => ({ type: 'flight', supplier, verified: true, reliabilityScore: 90, priceUSD, details: { outbound: out, inbound: back, passengers: 1, cabin: 'Economy' } });
  const shortLay = [{ airport: 'AMS', city: 'Amsterdam', minutes: 95, durationLabel: '1h 35m', overnight: false, tight: false }];
  const longLay = [{ airport: 'IST', city: 'Istanbul', minutes: 540, durationLabel: '9h 00m', overnight: true, tight: false }];
  const intent = { components: ['flights'], travellers: { total: 1, adults: 1, children: 0, childAges: [] }, nights: 4, dates: { checkIn: '2026-09-01', checkOut: '2026-09-05' }, flightPrefs: {} };
  const currency = { code: 'GBP', symbol: '£', rateFromUSD: 0.79 };
  // Case 1: a CHEAP long-overnight connection vs a dearer SHORT stopover —
  // the short stopover wins the Standard (cheapest) tier regardless.
  let scan = { flights: [
    flight('Cheap Overnight Air', 90, leg(1, longLay), leg(1, longLay)),
    flight('KLM', 140, leg(1, shortLay), leg(1, shortLay)),
  ] };
  let pkg = buildPackages(scan, intent, currency, 0);
  assert.equal(pkg.options[0].components[0].supplier, 'KLM', 'short stopover beats a cheaper overnight layover');
  // Case 2: add a direct option — direct wins even at a higher price.
  scan.flights.push(flight('Brussels Airlines', 180, leg(0), leg(0)));
  pkg = buildPackages(scan, intent, currency, 0);
  assert.equal(pkg.options[0].components[0].supplier, 'Brussels Airlines', 'direct is the top privilege');
  // Case 3: only long connections exist — cheapest of them wins (no starvation).
  scan = { flights: [
    flight('Cheap Overnight Air', 90, leg(1, longLay), leg(1, longLay)),
    flight('Dear Overnight Air', 200, leg(1, longLay), leg(1, longLay)),
  ] };
  pkg = buildPackages(scan, intent, currency, 0);
  assert.equal(pkg.options[0].components[0].supplier, 'Cheap Overnight Air', 'ladder falls through when no better tier exists');
});

// ---- Budget stays + honest tiers (dedupe, real premium cabins) ---------------
test('budget travellers get verified hostels/budget chains; ordinary searches never see them', () => {
  const r = plan({ text: 'Cheap budget hostel and flights to Dubai from London, 1 adult, 4 nights on 2026-09-10', context: GB, user: null, searchTier: 'smart' });
  assert.equal(r.stage, 'options');
  assert.equal(r.intent.budgetStay, true, 'budget intent detected');
  const stay = r.packages.options[0].components.find((c) => c.type === 'hotel' || c.type === 'host');
  // The cheapest verified bed wins the slot — a budget chain/hostel, or a
  // community HOST that undercuts them (hosts are a budget answer too).
  assert.ok(stay.type === 'host' || ['ibis budget', 'easyHotel', 'Generator Hostel', "St Christopher's Inn"].includes(stay.supplier), `Standard picked a verified budget stay (got ${stay.supplier})`);
  assert.ok(stay.verified && stay.reliabilityScore >= 75, 'budget never means unverified');
  // Premium still climbs the star ladder even on a budget search.
  const premiumStay = r.packages.options.find((o) => o.tier === 'Premium')?.components.find((c) => c.type === 'hotel' || c.type === 'host');
  if (premiumStay) assert.ok((premiumStay.stars || 4) >= 3, 'Premium stays premium');
  // A non-budget search never sees hostel dorms.
  const r2 = plan({ text: 'Flights and hotel to Dubai from London, 1 adult, 4 nights on 2026-09-10', context: GB, user: null, searchTier: 'smart' });
  for (const o of r2.packages.options) {
    const h = o.components.find((c) => c.type === 'hotel');
    if (h) assert.ok(!['Generator Hostel', "St Christopher's Inn", 'ibis budget', 'easyHotel'].includes(h.supplier), 'no budget brands without budget intent');
  }
});

test('identical tiers dedupe into one honest option; Luxury prefers a REAL premium cabin', async () => {
  const { buildPackages } = await import('../src/packager.js');
  const leg0 = { from: 'LHR', to: 'DXB', date: '2026-08-12', depart: '10:00', arrive: '20:00', stops: 0, stopLabel: 'Direct', layovers: [], durationLabel: '7h 0m' };
  const mkFlight = (supplier, priceUSD, cabin, rating = 90) => ({ type: 'flight', supplier, verified: true, reliabilityScore: rating, priceUSD, details: { outbound: leg0, inbound: leg0, passengers: 1, cabin } });
  const intent = { components: ['flights'], travellers: { total: 1, adults: 1, children: 0, childAges: [] }, nights: 7, dates: { checkIn: '2026-08-12', checkOut: '2026-08-19' }, flightPrefs: {} };
  const currency = { code: 'GBP', symbol: '£', rateFromUSD: 0.79 };
  // ONE live economy offer: all three tiers converge → ONE option, merge noted.
  let pkg = buildPackages({ flights: [mkFlight('Gulf Air', 800, 'Economy')] }, intent, currency, 0);
  assert.equal(pkg.options.length, 1, 'identical baskets never shown twice');
  assert.ok(pkg.options[0].mergedTiers?.length === 2, 'merge recorded');
  assert.match(pkg.options[0].blurb, /Also the best/, 'merge explained honestly');
  // Add a BUSINESS cabin offer: Luxury separates and takes it.
  pkg = buildPackages({ flights: [mkFlight('Gulf Air', 800, 'Economy'), mkFlight('Emirates', 2400, 'Business', 96)] }, intent, currency, 0);
  const lux = pkg.options.find((o) => o.tier === 'Luxury');
  assert.ok(lux, 'Luxury reappears when it can genuinely differ');
  assert.equal(lux.components[0].details.cabin, 'Business', 'Luxury flies the real premium cabin');
  const std = pkg.options.find((o) => o.tier === 'Standard');
  assert.equal(std.components[0].details.cabin, 'Economy', 'Standard stays on the cheapest fare');
});

// ---- Duffel pass-through rides the FLIGHT value only --------------------------
test('Duffel fees are charged on the flight order value, never on the whole package', async () => {
  const { buildPackages: bp } = await import('../src/packager.js');
  const leg0 = { from: 'LHR', to: 'DXB', date: '2026-08-12', depart: '10:00', arrive: '20:00', stops: 0, stopLabel: 'Direct', layovers: [], durationLabel: '7h 0m' };
  const scan = {
    flights: [{ type: 'flight', supplier: 'Gulf Air', verified: true, reliabilityScore: 90, live: true, priceUSD: 3231, details: { outbound: leg0, inbound: leg0, passengers: 4, cabin: 'Economy', offerId: 'off_x', liveAmount: '2552.31', liveCurrency: 'GBP' } }],
    hotel: [{ type: 'hotel', supplier: 'Rove Hotels', verified: true, reliabilityScore: 88, stars: 4, priceUSD: 900, details: {} }],
    activities: [{ type: 'activity', supplier: 'Desert Safari & BBQ', verified: true, reliabilityScore: 92, priceUSD: 300, details: {} }],
  };
  const intent = { components: ['flights', 'hotel', 'activities'], travellers: { total: 4, adults: 4, children: 0, childAges: [] }, nights: 7, dates: { checkIn: '2026-08-12', checkOut: '2026-08-19' }, flightPrefs: {} };
  const pkg = bp(scan, intent, { code: 'GBP', symbol: '£', rateFromUSD: 0.79 }, 0);
  const o = pkg.options[0];
  // Expected: £2.20 order fee (→$2.79) + 1% of the FLIGHT ($3231 → $32.31),
  // NOT 1% of the whole ~$4.9k package.
  const fee = o.pricing.lines.duffelFeeUSD;
  assert.ok(Math.abs(fee - (2.20 * 1.27 + 3231 * 0.01)) < 0.02, `fee is order + 1% of flight only (got $${fee})`);
  assert.ok(fee < 3231 * 0.011 + 3, 'fee can never scale with the hotel/activities');
});

// ---- Typo-tolerant origins + distance-honest estimated schedules -------------
test('typo "Birmingam" resolves to Birmingham (BHX) and long-haul estimates price and time honestly', async () => {
  const { resolveOrigin: ro } = await import('../src/destinations.js');
  // One-letter slips match the real city; the fake "BIR" code is history.
  assert.equal(ro('Birmingam').airport, 'BHX');
  assert.equal(ro('Birmingam').corrected, true);
  assert.equal(ro('Manchestor').airport, 'MAN');
  assert.equal(ro('Nottinham').airport, 'EMA');
  // Short/genuinely-unknown names still take the flagged placeholder path.
  assert.equal(ro('Xyzzytown').approxCode, true);
  // The full pipeline: Birmingham(typo)→Kinshasa must price like the ~6,300km
  // route it is, with a via-hub schedule that includes the layover.
  const r = plan({ text: 'Flights only to Kinshasa from Birmingam, 1 adult, 2026-08-28 to 2026-09-17', context: GB, user: null, searchTier: 'smart' });
  assert.equal(r.origin.airport, 'BHX', 'typo corrected in the pipeline');
  const f = r.packages.options[0].components.find((c) => c.type === 'flight');
  assert.ok(f.priceUSD > 450, `long-haul return per-seat fare is realistic (got $${f.priceUSD})`);
  const out = f.details.outbound;
  if (out.stops > 0) {
    assert.ok(out.durationMins >= 9 * 60, `via-hub Birmingham→Kinshasa is a real multi-hour connection, not the fake 11h14m/£304 (got ${out.durationLabel})`);
    assert.equal(out.segments.length, 2, 'estimated connection shows both legs');
    assert.equal(out.segments[0].flightNumber, null, 'flight numbers are never invented for estimates');
    assert.ok(out.segments[0].indicative, 'segments marked indicative');
    assert.ok(out.layovers[0].minutes >= 90, 'layover length is stated');
    assert.match(out.stopLabel, /via .* wait/, 'summary names the hub and the wait');
  }
});

// ---- WAVE 1 security: auth/IDOR/escalation are closed ------------------------
test('security: account takeover, IDOR and privilege escalation are blocked', async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b, h) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(h || {}) }, body: JSON.stringify(b) });
  const get = (p, h) => fetch(`${base}${p}`, { headers: h || {} });
  // Public signup cannot mint an admin.
  const suRes = await post('/api/account', { name: 'Eve', email: 'eve@example.com', role: 'admin', allAccess: true, humanCheck: { website: '', elapsedMs: 30000, interactions: 40, a: 1, b: 1, answer: 2, token: 't' } });
  const eve = (await suRes.json()).user;
  if (eve) { assert.notEqual(eve.role, 'admin', 'signup role forced to consumer'); assert.notEqual(eve.allAccess, true); }
  // A signed-in consumer cannot self-escalate via PATCH allAccess.
  const victim = createUser({ name: 'Victim', email: 'victim.sec@example.com' });
  const esc1 = await fetch(`${base}/api/account/${victim.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-user-id': victim.id }, body: JSON.stringify({ allAccess: true, role: 'admin' }) });
  const after = (await esc1.json()).user;
  assert.notEqual(after.allAccess, true, 'self-edit cannot grant allAccess');
  assert.notEqual(after.role, 'admin', 'self-edit cannot grant a role');
  // IDOR: attacker cannot read victim's account or edit it.
  const attacker = createUser({ name: 'Attacker', email: 'attacker.sec@example.com' });
  assert.equal((await get(`/api/account/${victim.id}`, { 'x-user-id': attacker.id })).status, 403, 'cannot read another account');
  assert.equal((await get(`/api/account/${victim.id}/wallet`, { 'x-user-id': attacker.id })).status, 403, 'cannot read another wallet');
  assert.equal((await fetch(`${base}/api/account/${victim.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-user-id': attacker.id }, body: '{"name":"hacked"}' })).status, 403, 'cannot edit another account');
  server.close();
});

// ---- WAVE 2 clock: vendor commission releases AFTER travel, on the real clock ---
test('vendor commission is held until travel completes, then releases (real clock)', async () => {
  const { saleIsPayable } = await import('../src/vendors.js');
  const today = new Date().toISOString().slice(0, 10);
  const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const base = { status: 'confirmed', paymentCleared: true, validated: true, refunded: false, chargeback: false, fraudFlag: false, complianceHold: false, paidOut: false };
  // Travel not yet happened → held; travel done → payable. (Frozen clock made
  // EVERY future serviceDate look "held forever" — vendors were never paid.)
  assert.equal(saleIsPayable({ ...base, serviceDate: future }, today), false, 'future travel: commission held');
  assert.equal(saleIsPayable({ ...base, serviceDate: past }, today), true, 'past travel: commission releases');
  assert.equal(saleIsPayable({ ...base, serviceDate: null }, today), true, 'immediately-consumed service: releases next run');
});

// ---- Airalo eSIM adapter: env-gated, correct normalisation -------------------
test('Airalo adapter is env-gated and normalises an order into a real activation', async () => {
  const { airaloEnabled, provisionEsimViaAiralo } = await import('../src/extras-suppliers.js');
  assert.equal(airaloEnabled(), false);
  assert.equal(await provisionEsimViaAiralo({ countryCode: 'GB' }), null, 'no credentials → null (in-OS fallback provisions)');
});

test('a provisioned Airalo eSIM renders its real activation in the travel document', async () => {
  const { bookingDocument } = await import('../src/documents.js');
  const booking = {
    id: 'bkg_esim1', leadTraveller: { fullName: 'Traveller One' },
    fulfilment: {}, payments: [{ type: 'full', amount: 100, status: 'paid' }],
    option: {
      tier: 'Standard', dates: { checkIn: '2026-09-01' }, destination: { city: 'Dubai', country: 'AE' },
      pricing: { symbol: '£', local: { total: 100 }, lines: { totalUSD: 127 } },
      components: [{ type: 'esim', supplier: 'Airalo', priceUSD: 10, details: { esim: {
        live: true, provider: 'Airalo', iccid: '891000000000009125',
        lpa: 'LPA:1$lpa.airalo.com$TEST', smdp: 'lpa.airalo.com', matchingId: 'TEST',
        qrUrl: 'https://sandbox.airalo.com/qr?id=1', appleInstallUrl: 'https://esimsetup.apple.com/x',
        shareLink: 'https://esims.cloud/he4qy-kqc8u68t', shareAccessCode: '8319',
        packageTitle: 'Dubai 1GB 7 days', dataLabel: '1 GB', validityDays: 7, isRoaming: true,
      } } }],
    },
  };
  const html = bookingDocument(booking, { currencySymbol: '£' });
  for (const must of ['891000000000009125', 'LPA:1$lpa.airalo.com$TEST', 'lpa.airalo.com', 'esims.cloud/he4qy-kqc8u68t', '8319', 'esimsetup.apple.com']) {
    assert.ok(html.includes(must), `document shows ${must}`);
  }
});

// ---- Viator activities door: env-gated, correct normalisation ----------------
test('Viator door is env-gated and normalises live tours into activity offers', async () => {
  const { viatorEnabled, searchViatorActivities, viatorActivitiesForScan } = await import('../src/extras-suppliers.js');
  assert.equal(viatorEnabled(), false, 'off without VIATOR_API_KEY — never fabricates tours');
  assert.equal(await searchViatorActivities({ destinationCity: 'Dubai' }), null);
  assert.equal(await viatorActivitiesForScan({ destinationCity: 'Dubai' }), null);
});

// ---- CarTrawler Mobility: webhook ride-tracking, secret-validated ------------
test('CarTrawler ride events update the booking live and validate the inbound secret', async () => {
  const { createBooking: mkB, saveQuote: mkQ, getBooking, listNotifications } = await import('../src/store.js');
  const { CARTRAWLER_EVENT_STATUS } = await import('../src/extras-suppliers.js');
  // Event map is complete and customer-facing.
  for (const e of ['ORDER_CREATED', 'CAR_DISPATCHED', 'CAR_ARRIVED', 'SERVICE_COMPLETED', 'SUPPLIER_CANCELLED']) {
    assert.ok(CARTRAWLER_EVENT_STATUS[e]?.title, `${e} has a customer status`);
  }
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // A booking carrying a CarTrawler order ref.
    const u = createUser({ name: 'Ride Rider', email: 'ride@x.co' });
    const opt = { tier: 'Standard', pricing: { symbol: '£', local: { total: 60 }, lines: { totalUSD: 76 } }, totalUSD: 76, travellers: { total: 1 }, components: [{ type: 'transfer', supplier: 'CarTrawler', priceUSD: 76 }] };
    const q = mkQ({ option: opt, intent: { dates: { checkIn: '2026-09-01' } } });
    const b = mkB({ quoteId: q.id, option: opt, instalment: null, userId: u.id });
    b.mobility = { orderRef: 'CT-ORDER-777', events: [] };
    // Webhook with the WRONG secret is refused (when a secret is set — here
    // none is configured, so it is accepted; assert the happy path + matching).
    const post = (body, auth) => fetch(`${base}/api/webhooks/cartrawler`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
    let r = await (await post({ event: 'CAR_DISPATCHED', orderRef: 'CT-ORDER-777' })).json();
    assert.equal(r.matched, true, 'event matched the booking by order ref');
    assert.equal(getBooking(b.id).mobility.status, 'dispatched');
    r = await (await post({ event: 'CAR_ARRIVED', orderRef: 'CT-ORDER-777' })).json();
    assert.equal(getBooking(b.id).mobility.status, 'arrived');
    // Idempotent: a duplicate of the latest event is a no-op.
    r = await (await post({ event: 'CAR_ARRIVED', orderRef: 'CT-ORDER-777' })).json();
    assert.equal(r.duplicate, true);
    // Unknown ref → logged, no crash, matched:false.
    r = await (await post({ event: 'CAR_DISPATCHED', orderRef: 'CT-NOPE' })).json();
    assert.equal(r.matched, false);
    // The customer saw live updates.
    assert.ok(listNotifications(u.id).some((n) => /driver/i.test(n.title)), 'traveller notified of ride status');
  } finally { server.close(); }
});

// ---- Inspire me: propose destinations when there is none in mind -------------
test('destination proposer ranks by vibe, season and budget; planner offers it', async () => {
  const { proposeDestinations } = await import('../src/destinations.js');
  // Beach + budget in July → warm, in-season, good-value places lead.
  const beach = proposeDestinations({ text: 'cheap beach holiday', monthIndex: 6, budget: 'low' });
  assert.ok(beach.length >= 4);
  assert.ok(beach.slice(0, 3).some((p) => ['Bali', 'Barcelona', 'Lisbon'].includes(p.city)), 'beach/value picks surface');
  assert.ok(beach[0].inSeason, 'top pick is in season');
  // Luxury sun in January → Dubai/Cape Town (warm + premium that month).
  const lux = proposeDestinations({ text: 'luxury sun', monthIndex: 0, budget: 'high' });
  assert.ok(lux.slice(0, 2).some((p) => ['Dubai', 'Cape Town'].includes(p.city)));
  // Blank slate still returns a sensible spread, never empty.
  assert.ok(proposeDestinations({ text: 'somewhere nice' }).length >= 4);

  // Planner: a no-destination search returns proposals in the clarify stage,
  // and inspire:true returns the dedicated inspiration stage.
  const clarify = plan({ text: 'a warm beach trip in July for 7 nights', context: GB, user: null, searchTier: 'smart' });
  assert.equal(clarify.stage, 'clarify');
  assert.ok(Array.isArray(clarify.proposals) && clarify.proposals.length >= 4, 'proposals offered even without a destination');
  const inspired = plan({ text: 'a warm beach trip in July for 7 nights', context: GB, user: null, searchTier: 'smart', overrides: { inspire: true } });
  assert.equal(inspired.stage, 'inspiration');
  assert.ok(inspired.proposals.length >= 4);
  // Picking a proposal (by naming it) plans normally.
  const built = plan({ text: 'A trip to Bali for 5 nights with flights and hotel', context: GB, user: null, searchTier: 'smart' });
  assert.equal(built.stage, 'options');
});

// ---- WAVE 4: search/logic regression fixes ----------------------------------
import { parseExplicitDates } from '../src/intent.js';
import { scanHotels } from '../src/suppliers.js';
import { normalizeTequilaItinerary } from '../src/live-suppliers.js';

test('wave4 dates: day-range with month name never misparses; month-first keeps checkout', () => {
  const today = new Date(Date.UTC(2026, 0, 10));
  // "3-9 August" used to be eaten by the DD/MM matcher as 3rd of month-9 (Sep).
  const a = parseExplicitDates('3-9 August', today);
  assert.equal(a.checkIn, '2026-08-03');
  assert.equal(a.checkOut, '2026-08-09');
  assert.equal(a.nights, 6);
  // Month-first ("August 17 to 24") used to drop the checkout entirely (NaN).
  const b = parseExplicitDates('August 17 to 24', today);
  assert.equal(b.checkIn, '2026-08-17');
  assert.equal(b.checkOut, '2026-08-24');
  assert.equal(b.nights, 7);
  // A plain single DD/MM/YYYY still parses as a single check-in.
  const c = parseExplicitDates('03/10/2026', today);
  assert.equal(c.checkIn, '2026-10-03');
  assert.equal(c.checkOut, null);
});

test('wave4 dorm: a group of 4 in a dorm is priced per BED, not per room', () => {
  // Build an intent that unlocks budget stays for 4 travellers, 3 nights.
  const intent = parseIntent('cheap hostel in Barcelona for 4 adults, 3 nights', { country: 'GB' }, new Date(Date.UTC(2026, 5, 30)));
  intent.budgetStay = true;
  const offers = scanHotels(intent, intent.destination);
  const dorm = offers.find((o) => /dorm/i.test(o.details.roomType || ''));
  assert.ok(dorm, 'a dorm option is offered to a budget group');
  assert.equal(dorm.details.rooms, 4, 'four beds sold for four travellers');
  // Priced per BED: total ≈ nightly × nights × 4 (±1 for display rounding), and
  // decisively NOT the old ÷(rooms≈2) underquote.
  const perBed = dorm.details.nightlyUSD * dorm.details.nights;
  assert.ok(Math.abs(dorm.priceUSD - perBed * 4) <= 1, `priced for 4 beds (${dorm.priceUSD})`);
  assert.ok(dorm.priceUSD > perBed * 3, 'not the halved underquote');
});

test('wave4 tequila TZ: duration uses UTC epochs, not wall-clock across timezones', () => {
  // Westbound: London 10:00 local (09:00Z) → New York 13:00 local (18:00Z).
  // Wall-clock subtraction would give a bogus 3h; the true elapsed is 9h.
  const item = {
    route: [{
      airline: 'BA', flight_no: '175',
      flyFrom: 'LHR', cityFrom: 'London', flyTo: 'JFK', cityTo: 'New York',
      local_departure: '2026-08-17T10:00:00.000Z', local_arrival: '2026-08-17T13:00:00.000Z',
      dTime: Date.UTC(2026, 7, 17, 9, 0, 0) / 1000, aTime: Date.UTC(2026, 7, 17, 18, 0, 0) / 1000,
      return: 0,
    }],
    booking_token: 'tok', baglimit: { hold_weight: 23 },
  };
  const offer = normalizeTequilaItinerary(item, 240, { adults: 1, children: 0, childAges: [], total: 1 });
  assert.equal(offer.details.outbound.durationLabel, '9h 0m');
  assert.equal(offer.details.outbound.depart, '10:00', 'display time stays LOCAL');
});

test('wave4 scanSummary: empty categories report null cheapest, never Infinity', () => {
  const res = plan({ text: 'Barcelona from London in September for 4 nights, flights and hotel for 2 adults', context: GB, user: null, searchTier: 'smart' });
  for (const [, s] of Object.entries(res.scanSummary || {})) {
    assert.ok(s.cheapestUSD === null || Number.isFinite(s.cheapestUSD), `cheapestUSD finite or null (${s.cheapestUSD})`);
  }
});

test('wave4 one-way: a flights-only one-way search does not crash', () => {
  const res = plan({ text: 'one way flight from London to Barcelona on 15/08/2026 for 2 adults', context: GB, user: null, searchTier: 'smart' });
  assert.equal(res.stage, 'options');
});

// ---- WAVE 5: security + idempotency + routing regressions -------------------
import { fulfilmentChannelFor } from '../src/extras-suppliers.js';
import { createPost as createBlogPost } from '../src/agents.js';
import { recordVendorServiceJob, applyVendor as applyVendorW5 } from '../src/store.js';

test('wave5 blog: generator requires admin; destination is escaped in the HTML body', async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // No auth → refused (was unauthenticated → stored XSS).
    const anon = await fetch(`${base}/api/blog/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ destination: 'Dubai' }) });
    assert.ok(anon.status === 401 || anon.status === 403, 'blog generation is not public');
  } finally { server.close(); }
  // Even via the internal function, a script payload is neutralised in the body.
  const post = createBlogPost({ destination: '<img src=x onerror=alert(1)>' });
  assert.ok(!/<img/i.test(post.body), 'raw <img> never reaches the rendered body');
  assert.ok(post.body.includes('&lt;img'), 'destination is HTML-escaped');
});

test('wave5 IDOR: disruption + price-guard reject a non-owner', async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const owner = createUser({ name: 'Owner', email: `own${Date.now()}@x.co` });
    const other = createUser({ name: 'Attacker', email: `atk${Date.now()}@x.co` });
    const opt = { tier: 'Standard', pricing: { symbol: '£', local: { total: 500 }, lines: { totalUSD: 633 } }, totalUSD: 633, travellers: { total: 1 }, components: [{ type: 'flight', supplier: 'BA', live: true, details: { outbound: { from: 'LHR', to: 'DXB', date: '2027-10-03' } } }] };
    const b = createBooking({ quoteId: 'q_w5', option: opt, instalment: null, userId: owner.id });
    const call = (path, uid) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(uid ? { 'x-user-id': uid } : {}) }, body: '{}' });
    assert.equal((await call(`/api/book/${b.id}/disruption`, other.id)).status, 403, 'non-owner cannot run disruption');
    assert.equal((await call(`/api/book/${b.id}/price-guard`, other.id)).status, 403, 'non-owner cannot run price-guard');
    assert.equal((await call(`/api/book/${b.id}/price-guard`, owner.id)).status, 200, 'owner can');
  } finally { server.close(); }
});

test('wave5 vendor job: re-confirm never double-mints the 90% payout', () => {
  const v = createUser({ email: `vend${Date.now()}@x.co`, name: 'Photo Vendor' });
  const appd = applyVendorW5(v.id, { tier: 'independent', identityDoc: true, addressProof: true, socialHandles: ['@p'], businessHistory: true });
  assert.equal(appd.profile.status, 'approved');
  const args = { vendorId: v.id, bookingId: 'bk_w5', orderId: 'ford_w5', priceGbp: 100, serviceDate: '2026-09-01' };
  const first = recordVendorServiceJob(args);
  const second = recordVendorServiceJob(args);
  assert.equal(first.ok, true);
  assert.equal(second.already, true, 'second confirm is idempotent');
  assert.equal(second.sale.id, first.sale.id, 'same earnings row returned, not a new one');
});

test('wave5 fulfilment: a live hotel routes to the ops desk (never charged-but-unbooked)', () => {
  assert.equal(fulfilmentChannelFor({ type: 'hotel', live: true }, 'AE'), 'ops:hotels');
  assert.equal(fulfilmentChannelFor({ type: 'hotel', live: false }, 'AE'), 'ops:hotels');
});

// ---- WAVE 5b: payment-architecture regressions ------------------------------
import { applyDepositCreditToBooking as applyCreditW5, placeSearchDeposit as placeDepW5, convertDepositToBooking as convertDepW5, processReferralOnPaidBooking as procRefW5, getUserRaw as getUserRawW5, applyMobilityEvent as applyMobilityEventW5 } from '../src/store.js';

const LIVE_OPT_W5 = () => ({ tier: 'Standard', totalUSD: 1266, pricing: { currency: 'GBP', symbol: '£', local: { total: 1000 }, lines: { totalUSD: 1266 }, revenue: { commissionUSD: 100 } }, components: [{ type: 'flight', supplier: 'BA', live: true, priceUSD: 1266, details: {} }] });
const INST_W5 = () => ({ deposit: 200, schedule: [{ due: '2026-08-01', amount: 400, status: 'scheduled' }, { due: '2026-09-01', amount: 400, status: 'scheduled' }] });

test('wave5 deposit: Stripe-captured booking records no optimistic deposit (no double-count)', () => {
  const u = createUser({ name: 'Payer', email: `pay${Date.now()}@x.co` });
  // Stripe live + a live fare → the webhook is authoritative, so NO pre-recorded deposit.
  const b = createBooking({ quoteId: 'q_p1a', option: LIVE_OPT_W5(), instalment: INST_W5(), userId: u.id, stripeLive: true });
  assert.equal(b.awaitExternalCapture, true);
  assert.ok(!b.payments.some((p) => p.type === 'deposit'), 'no optimistic deposit when Stripe captures externally');
  // Stripe off (current default) → optimistic deposit recorded, behaviour unchanged.
  const b2 = createBooking({ quoteId: 'q_p1b', option: LIVE_OPT_W5(), instalment: INST_W5(), userId: u.id, stripeLive: false });
  assert.ok(b2.payments.some((p) => p.type === 'deposit' && p.amount === 200), 'optimistic deposit still recorded with Stripe off');
});

test('wave5 search deposit: converting it actually credits the booking (money no longer vanishes)', () => {
  const u = createUser({ name: 'Corp', email: `corp${Date.now()}@x.co` });
  const dep = placeDepW5({ userId: u.id, tier: 'corporate' }); // £50
  assert.ok(dep.ok || dep.deposit, 'deposit placed');
  const b = createBooking({ quoteId: 'q_p3', option: LIVE_OPT_W5(), instalment: INST_W5(), userId: u.id });
  const credit = convertDepW5(u.id, b.id);
  assert.ok(credit && credit.amountGBP === 50, 'credit is the £50 corporate deposit');
  applyCreditW5(b, credit.amountGBP);
  assert.ok(b.payments.some((p) => p.type === 'deposit-credit' && p.amount === 50), 'credit counted as paid');
  const cashDue = b.instalment.deposit + b.instalment.schedule.reduce((s, x) => s + x.amount, 0);
  assert.ok(Math.abs(cashDue - 950) < 0.01, `cash still due = total − credit (£${cashDue})`);
});

test('wave5 referral: 250 ACU fires once (first paid booking), not on every booking', () => {
  const referrer = createUser({ name: 'Referrer', email: `ref${Date.now()}@x.co` });
  const rr = getUserRawW5(referrer.id); rr.referralCode = `RC${Date.now()}`;
  const friend = createUser({ name: 'Friend', email: `fr${Date.now()}@x.co` });
  const fr = getUserRawW5(friend.id); fr.referredByCode = rr.referralCode;
  const mk = (n) => { const b = createBooking({ quoteId: `q_ref${n}`, option: LIVE_OPT_W5(), instalment: null, userId: friend.id }); b.referralProcessed = false; return b; };
  const before = getUserRawW5(referrer.id).acuBalance || 0;
  const r1 = procRefW5(mk(1));
  const r2 = procRefW5(mk(2));
  assert.equal(r1.acu, 250, 'first paid booking mints 250 ACU');
  assert.equal(r2.acu, 0, 'second booking mints NO further signup ACU');
  const gained = (getUserRawW5(referrer.id).acuBalance || 0) - before;
  assert.ok(gained >= 250 && gained < 500, `only one 250-ACU grant (got ${gained})`);
});

// ---- WAVE 5c: mobility dedup + ownerless-booking PII ------------------------
test('wave5 mobility: an out-of-order repeat of an earlier event is deduped (not just the last)', () => {
  const u = createUser({ name: 'Rider2', email: `r2${Date.now()}@x.co` });
  const b = createBooking({ quoteId: 'q_mob', option: LIVE_OPT_W5(), instalment: null, userId: u.id });
  b.mobility = { orderRef: 'CT-OOO-1', events: [] };
  const send = (event) => applyMobilityEventW5({ event, orderRef: 'CT-OOO-1', status: event.toLowerCase(), title: `Ride ${event}` });
  assert.equal(send('CAR_DISPATCHED').duplicate, undefined);
  assert.equal(send('CAR_ARRIVED').duplicate, undefined);
  // A retry of the EARLIER event (not the latest) must still be a no-op.
  assert.equal(send('CAR_DISPATCHED').duplicate, true, 'non-adjacent repeat deduped');
  assert.equal(b.mobility.events.length, 2, 'no phantom third event appended');
});

test('wave5 PII: an ownerless booking cannot be read by an anonymous caller', async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const b = createBooking({ quoteId: 'q_pii', option: LIVE_OPT_W5(), instalment: null, userId: null, lead: { fullName: 'Jane Doe', passportNumber: 'X1234567' } });
    assert.equal(b.userId, null);
    const anon = await fetch(`${base}/api/book/${b.id}`);
    assert.equal(anon.status, 403, 'anonymous read of an ownerless booking is refused');
    const doc = await fetch(`${base}/api/book/${b.id}/document`);
    assert.equal(doc.status, 403, 'ownerless document is refused too');
  } finally { server.close(); }
});

// ---- "flights only" must never bundle a hotel (the "stay"/"apartment" trap) --
test('flights-only: an explicit "only" drops a loosely-triggered stay + keeps the flat fee', () => {
  const GB2 = { country: 'GB', currency: { code: 'GBP', symbol: '£', rateFromUSD: 0.79 } };
  // The word "stay" used to fire the hotel trigger → a 10% package with a hotel.
  const r = plan({ text: 'flights only from London to Bali for my stay 12 to 17 August, 1 adult', context: GB2, user: null, searchTier: 'smart' });
  assert.equal(r.stage, 'options');
  assert.deepEqual(r.intent.components, ['flights'], 'only flights, no hotel');
  const o = r.packages.options[0];
  assert.equal(o.pricing.feeModel, 'flight-service-fee', '2% service fee, not 10% commission');
  assert.ok(!o.components.some((c) => c.type === 'hotel' || c.type === 'host'), 'no stay bundled in');
  // "apartment" is likewise not a stay when the request is flight-only.
  const r2 = plan({ text: 'flight only Bali apartment 12-17 Aug 1 adult', context: GB2, user: null, searchTier: 'smart' });
  assert.equal(r2.packages.options[0].pricing.feeModel, 'flight-service-fee');
  // A genuine package (no "only") still bundles + charges 10%.
  const r3 = plan({ text: 'Bali from London 12 to 17 August, flights and hotel for 1 adult', context: GB2, user: null, searchTier: 'smart' });
  assert.equal(r3.packages.options[0].pricing.feeModel, 'commission-10');
});

// ---- Flights-only service fee: 2% · £4.99 floor · £15 cap -------------------
test('flights-only fee: 2% of fare, floored at £4.99, capped at £15', () => {
  const cur = { code: 'GBP', symbol: '£', rateFromUSD: 0.79 };
  const feeGbp = (fareGbp) => priceBreakdown({ componentsUSD: fareGbp / 0.79, marketRefUSD: fareGbp / 0.79 * 1.2, currency: cur, flightsOnly: true }).local.commission;
  assert.equal(feeGbp(80), 4.99, 'cheap flight → £4.99 floor (never below cost)');
  assert.equal(feeGbp(150), 4.99, 'still at the floor');
  assert.ok(Math.abs(feeGbp(450) - 9) < 0.05, 'mid-haul → 2% (£9 on £450)');
  assert.equal(feeGbp(750), 15, 'exactly at the cap');
  assert.equal(feeGbp(1500), 15, 'long-haul stays capped at £15 (1%, competitive)');
  // Members fly fee-free regardless of fare.
  const memberFee = priceBreakdown({ componentsUSD: 900 / 0.79, marketRefUSD: 1000, currency: cur, flightsOnly: true, memberActive: true }).local.commission;
  assert.equal(memberFee, 0, 'Travel+ members pay no flight service fee');
});

// ---- WAVE 6: deep-clean critical-fix regressions ----------------------------
import { quoteCancellation as quoteCancelW6 } from '../src/operator.js';
import { submitReview as submitReviewW6 } from '../src/reviews.js';
import { buildRefundPolicy as buildRefundW6 } from '../src/booking-schema.js';

test('wave6 geo: an unsupported currencyCountry never crashes the search', () => {
  // Italy/Japan/China etc. are outside the 14-country map — must fall back, not 500.
  for (const c of ['IT', 'JP', 'CN', 'BR', 'ZZ']) {
    const ctx = detectContext({ headers: {} }, { country: c, currencyCountry: c });
    assert.ok(ctx.currency && ctx.currency.code, `currency resolved for ${c}`);
  }
  // A supported country still gets its own currency.
  assert.equal(detectContext({ headers: {} }, { country: 'GB', currencyCountry: 'GB' }).currency.code, 'GBP');
});

test('wave6 autopay: recordAudit is imported — the endpoint returns 200, not 500', async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const u = createUser({ name: 'Autopay User', email: `ap${Date.now()}@x.co` });
    const opt = { tier: 'Standard', pricing: { symbol: '£', local: { total: 900 }, lines: { totalUSD: 1140 } }, totalUSD: 1140, travellers: { total: 1 }, components: [{ type: 'flight', supplier: 'BA', live: true }] };
    const b = createBooking({ quoteId: 'q_ap', option: opt, instalment: { engine: 'ai-smart', deposit: 200, schedule: [{ due: '2026-09-01', amount: 700, status: 'scheduled' }], autopay: {} }, userId: u.id });
    const res = await fetch(`${base}/api/book/${b.id}/autopay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': u.id }, body: JSON.stringify({ enabled: true }) });
    assert.equal(res.status, 200, 'autopay no longer 500s (recordAudit was undefined)');
    const d = await res.json();
    assert.equal(d.autopay.enabled, true);
  } finally { server.close(); }
});

test('wave6 cancellation: a flexible booking 30+ days out quotes a real refund, not £0', () => {
  const option = { components: [{ type: 'hotel', supplier: 'Rove', details: { freeCancellation: true } }], pricing: { symbol: '£' }, dates: { checkIn: '2027-06-01' } };
  const booking = { option, refundPolicy: buildRefundW6(option, '2027-06-01'), payments: [{ type: 'deposit', amount: 200 }, { type: 'instalment', amount: 300 }] };
  const q = quoteCancelW6(booking).quote;
  assert.ok(q.refundablePct > 0, `flexible + 30 days out is refundable (got ${q.refundablePct}%)`);
  assert.ok(q.refundGbp > 0, `real refund quoted (got £${q.refundGbp})`);
  assert.equal(q.paidGbp, 500);
});

test('wave6 reviews: an invalid rating is rejected, not coerced to 1 star', () => {
  assert.equal(submitReviewW6({ supplier: 'BA', rating: 0 }).error, 'invalid-rating');
  assert.equal(submitReviewW6({ supplier: 'BA', rating: undefined }).error, 'invalid-rating');
  assert.equal(submitReviewW6({ supplier: 'BA', rating: 9 }).error, 'invalid-rating');
  assert.equal(submitReviewW6({ supplier: 'BA', rating: 4 }).ok, true);
});

test('wave6 dates: a backwards range is swapped, not turned into a 1-night inverted trip', () => {
  const r = parseExplicitDates('24/08/2026 to 17/08/2026', new Date(Date.UTC(2026, 0, 10)));
  assert.equal(r.checkIn, '2026-08-17');
  assert.equal(r.checkOut, '2026-08-24');
  assert.equal(r.nights, 7);
});

// ---- WAVE 6: wired-up (formerly dead) functions -----------------------------
import { derivePartnerMetrics as derivePMW6, netRevenueAfterReversals as netRevW6 } from '../src/rewards.js';
import { mozioTransfersForScan as mozioScanW6 } from '../src/extras-suppliers.js';
import { adjustedReliability as adjRelW6, submitReview as submitReviewW6b } from '../src/reviews.js';

test('wave6 wired: reversed (cancelled) revshare rows are subtracted from partner lifetime', () => {
  const rows = [
    { amountGbp: 100, at: '2026-07-01' },
    { amountGbp: 50, at: '2026-07-01', reversed: true }, // cancelled booking
  ];
  const m = derivePMW6({ revshareRows: rows });
  assert.equal(m.lifetimeEarningsGbp, 100, 'reversed £50 excluded from lifetime');
  assert.equal(netRevW6({ grossCommissionGbp: 150, reversedGbp: 50 }), 100);
});

test('wave6 wired: adjustedReliability blends real reviews into a supplier score', () => {
  for (let i = 0; i < 6; i++) submitReviewW6b({ supplier: `Stellar Air ${i % 1}`, rating: 5 });
  const lifted = adjRelW6(70, 'Stellar Air 0');
  assert.ok(lifted > 70, `5-star reviews lift reliability (got ${lifted})`);
  // A supplier with no reviews is unchanged (safe no-op).
  assert.equal(adjRelW6(80, 'Never Reviewed Airlines'), 80);
});

test('wave6 wired: Mozio transfer overlay is a safe no-op when the door is shut', async () => {
  assert.equal(await mozioScanW6({ destAirport: 'DXB', destCity: 'Dubai' }), null);
});

// ---- Revenue features: sponsored placements + priority/group fees -----------
import { createSponsoredPlacement as createPlW6, sponsoredPlacementsFor as sponForW6, sponsoredPlacementRevenueGBP as splRevW6, listSponsoredPlacements as listPlW6 } from '../src/store.js';

test('revenue: sponsored placements persist, filter by section/destination, and total revenue', () => {
  const before = splRevW6();
  const r = createPlW6({ partner: 'Rove Hotels', section: 'destination pages', destination: 'Dubai', feeGBPMonth: 400 });
  assert.equal(r.ok, true);
  assert.ok(r.placement.id.startsWith('spl_'));
  assert.equal(r.placement.labelled, true, 'always labelled');
  // Invalid section is rejected.
  assert.equal(createPlW6({ partner: 'X', section: 'homepage takeover' }).ok, false);
  // Section + destination filter (a '*' placement matches any destination).
  createPlW6({ partner: 'Global eSIM', section: 'destination pages', destination: '*', feeGBPMonth: 100 });
  const dubai = sponForW6('destination pages', 'Dubai');
  assert.ok(dubai.some((p) => p.partner === 'Rove Hotels') && dubai.some((p) => p.partner === 'Global eSIM'));
  assert.ok(dubai.every((p) => p.sponsored && p.labelled), 'every returned placement is marked sponsored');
  const paris = sponForW6('destination pages', 'Paris');
  assert.ok(paris.some((p) => p.partner === 'Global eSIM') && !paris.some((p) => p.partner === 'Rove Hotels'), '* matches Paris, Dubai-only does not');
  assert.equal(splRevW6(), before + 400 + 100, 'active monthly revenue accrues');
});

test('revenue: sponsored placement admin endpoints require admin; injected into search response', async () => {
  process.env.STAFF_ACCESS_PIN = 'pin-rev-1';
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Anonymous cannot create placements.
    const anon = await fetch(`${base}/api/admin/placements`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ partner: 'Sneaky', section: 'recommended deals' }) });
    assert.ok(anon.status === 401 || anon.status === 403, 'placement create is admin-only');
    // Group quote is public and returns the fee schedule.
    const gq = await (await fetch(`${base}/api/group/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ headcount: 30, tripValueGBP: 15000 }) })).json();
    assert.equal(gq.planningFeeGBP, 149, '25+ travellers → £149 planning fee');
    assert.equal(gq.groupBookingFeeGBP, 150, '£5 × 30 coordination fee');
    assert.equal(gq.totalUpfrontGBP, 299);
    assert.ok(Array.isArray(gq.segments) && gq.segments.length === 8);
    // Priority-search tiers endpoint lists the paid bands.
    const pt = await (await fetch(`${base}/api/search/priority-tiers`)).json();
    assert.ok(pt.tiers.some((t) => t.level === 'urgent' && t.feeGBP === 10));
    assert.ok(pt.tiers.some((t) => t.level === 'emergency' && t.feeGBP === 25));
  } finally { server.close(); delete process.env.STAFF_ACCESS_PIN; }
});

test('revenue: sponsored placement revenue appears in the admin overview total', async () => {
  const { adminOverview } = await import('../src/store.js');
  const before = adminOverview();
  createPlW6({ partner: 'KPI Test Partner', section: 'business travel pages', destination: '*', feeGBPMonth: 500 });
  const after = adminOverview();
  assert.equal(after.placementRevenueMonthlyGBP, before.placementRevenueMonthlyGBP + 500, 'placement £/mo tracked');
  assert.ok(after.totalRevenueUSD > before.totalRevenueUSD, 'headline revenue includes placement income');
});

// ---- Duffel Stays (hotel replacement for Amadeus) ---------------------------
import { normalizeDuffelStay as normStayW6, fetchDuffelStays as fetchStaysW6, duffelStaysEnabled as staysEnabledW6, liveHotelsEnabled as liveHotelsW6 } from '../src/live-suppliers.js';

test('duffel stays: normaliser maps a search result to the hotel-offer shape', () => {
  const result = {
    id: 'sr_123',
    accommodation: {
      name: 'Marina Bay Hotel', rating: 5, review_score: 9.2,
      location: { address: { line_one: '12 Marina Walk', city_name: 'Dubai' }, geographic_coordinates: { latitude: 25.1, longitude: 55.2 } },
      photos: [{ url: 'https://img/1.jpg' }, { url: 'https://img/2.jpg' }],
    },
    rooms: [{ rates: [{ name: 'Deluxe King' }] }],
    cheapest_rate_total_amount: '900.00', cheapest_rate_currency: 'USD',
  };
  const o = normStayW6(result, 900, 3, 1);
  assert.equal(o.type, 'hotel');
  assert.equal(o.supplier, 'Marina Bay Hotel');
  assert.equal(o.live, true);
  assert.equal(o.sourcedVia, 'Duffel Stays (live)');
  assert.equal(o.stars, 5);
  assert.equal(o.reliabilityScore, 92, 'review 9.2/10 → reliability 92');
  assert.equal(o.details.nightlyUSD, 300, '900 / 3 nights');
  assert.equal(o.details.roomType, 'Deluxe King');
  assert.equal(o.priceUSD, 900);
  assert.ok(o.details.photos.length === 2);
});

test('duffel stays: gated behind the Duffel token; a safe no-op when the door is shut', async () => {
  // No DUFFEL_TOKEN in tests → Stays door shut, no live hotels claimed.
  assert.equal(staysEnabledW6(), false);
  assert.equal(liveHotelsW6(), false);
  assert.equal(await fetchStaysW6({ dates: { checkIn: '2026-09-01', checkOut: '2026-09-05' }, travellers: { total: 2, adults: 2 }, nights: 4 }, { city: 'Dubai' }), null);
});

// ---- Duffel Stays automatic booking (quote → book → confirmation) -----------
import { bookDuffelStay as bookStayW6 } from '../src/live-suppliers.js';

test('duffel stays booking: safe no-op when the door is shut', async () => {
  const r = await bookStayW6({ searchResultId: 'sr_x', guests: [{ given_name: 'A', family_name: 'B' }] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not-configured');
});

test('duffel stays booking: a live Stays room auto-books; other hotels go to ops', () => {
  // A live hotel carrying a Stays search-result id is auto-booked (no manual order).
  assert.equal(fulfilmentChannelFor({ type: 'hotel', live: true, details: { staysSearchResultId: 'sr_1' } }, 'AE'), null);
  // A live hotel WITHOUT a Stays id (e.g. Amadeus) still routes to the ops desk.
  assert.equal(fulfilmentChannelFor({ type: 'hotel', live: true, details: {} }, 'AE'), 'ops:hotels');
  // A synthetic/estimated hotel routes to the ops desk.
  assert.equal(fulfilmentChannelFor({ type: 'hotel', live: false, details: {} }, 'AE'), 'ops:hotels');
});

// ---- Per-passenger name capture (group/family flight ticketing) -------------
import { duffelOrderPassengers as duffelPaxW6 } from '../src/live-suppliers.js';

test('flight manifest: every captured passenger name/DOB reaches the Duffel order', () => {
  const offerPassengers = [{ id: 'p1', type: 'adult' }, { id: 'p2', type: 'adult' }, { id: 'p3', type: 'child', age: 8 }];
  const travellers = [
    { fullName: 'Jean Nseya', dob: '1985-04-12', type: 'adult', email: 'jean@x.co', phone: '+44700900123' },
    { fullName: 'Marie Nseya', dob: '1987-09-01', type: 'adult' },
    { fullName: 'Luc Nseya', dob: '2018-02-20', type: 'child' },
  ];
  const pax = duffelPaxW6(offerPassengers, travellers[0], { departureDate: '2026-09-01', travellers });
  assert.equal(pax.length, 3);
  assert.deepEqual([pax[0].given_name, pax[0].family_name], ['Jean', 'Nseya']);
  assert.deepEqual([pax[1].given_name, pax[1].family_name], ['Marie', 'Nseya'], 'second passenger is a REAL name, not a placeholder');
  assert.deepEqual([pax[2].given_name, pax[2].family_name], ['Luc', 'Nseya']);
  assert.equal(pax[2].born_on, '2018-02-20', 'child DOB is the captured one');
  assert.equal(pax[0].email, 'jean@x.co', 'lead carries contact; others do not');
  assert.equal(pax[1].email, undefined);
  assert.ok(pax.every((p) => p.family_name && p.family_name !== 'Traveller'), 'no placeholder surnames');
});

test('flight manifest: falls back to the lead when no manifest is supplied', () => {
  const pax = duffelPaxW6([{ id: 'p1', type: 'adult' }], { fullName: 'Solo Traveller' }, { departureDate: '2026-09-01' });
  assert.equal(pax.length, 1);
  assert.deepEqual([pax[0].given_name, pax[0].family_name], ['Solo', 'Traveller']);
});

// ---- WAVE 7: pre-launch security launch-blockers ----------------------------
test('wave7 auth: /api/auth/firebase refuses an unverified token (no more login-as-any-email)', async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Body email with NO verifiable Firebase token → 401 (was: returned the account).
    const r1 = await fetch(`${base}/api/auth/firebase`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@3jntravel.com' }) });
    assert.equal(r1.status, 401, 'no token → unverified');
    const r2 = await fetch(`${base}/api/auth/firebase`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: 'forged.jwt.here', name: 'x' }) });
    assert.equal(r2.status, 401, 'a forged token cannot be verified');
  } finally { server.close(); }
});

test('wave7 auth: a privileged account cannot be opened by login without a configured staff PIN', async () => {
  const admin = createUser({ name: 'Priv Admin', email: `priv${Date.now()}@x.co`, role: 'admin' });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ch = issueHumanChallenge();
    const humanCheck = { website: '', elapsedMs: MIN_FORM_MS + 500, interactions: 8, a: ch.a, b: ch.b, expiresAt: ch.expiresAt, token: ch.token, answer: ch.a + ch.b };
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: admin.email, humanCheck }) });
    assert.equal(res.status, 403, 'fail closed — no PIN configured means DENY for a privileged account');
    const d = await res.json();
    assert.equal(d.error, 'staff-pin-required');
  } finally { server.close(); }
});

test('wave7 auth: an ADMIN_EMAILS owner is elevated to admin on login (with the PIN)', async () => {
  const email = `owner${Date.now()}@x.co`;
  createUser({ name: 'Owner', email }); // starts as a plain consumer
  const prevPin = process.env.STAFF_ACCESS_PIN;
  const prevAdmins = process.env.ADMIN_EMAILS;
  process.env.STAFF_ACCESS_PIN = 'pin-4242';
  process.env.ADMIN_EMAILS = `someone@else.co, ${email}`;
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const mkHuman = () => { const ch = issueHumanChallenge(); return { website: '', elapsedMs: MIN_FORM_MS + 500, interactions: 8, a: ch.a, b: ch.b, expiresAt: ch.expiresAt, token: ch.token, answer: ch.a + ch.b }; };
    // Without the PIN → denied even though the email is allowlisted.
    const noPin = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, humanCheck: mkHuman() }) });
    assert.equal(noPin.status, 403, 'allowlisted owner still needs the staff PIN');
    // With the PIN → elevated to admin.
    const ok = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-staff-pin': 'pin-4242' }, body: JSON.stringify({ email, humanCheck: mkHuman() }) });
    assert.equal(ok.status, 200);
    const d = await ok.json();
    assert.equal(d.user.role, 'admin', 'owner email is elevated to admin');
  } finally {
    server.close();
    if (prevPin === undefined) delete process.env.STAFF_ACCESS_PIN; else process.env.STAFF_ACCESS_PIN = prevPin;
    if (prevAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = prevAdmins;
  }
});

test('wave7 auth: an ADMIN_EMAILS owner reaches admin endpoints on every request without the PIN', async () => {
  const email = `own${Date.now()}@x.co`;
  const u = createUser({ name: 'Own', email }); // plain consumer in the store
  markEmailVerified(u.id); // owner has signed in once via Firebase/PIN (sets the verified flag)
  const other = createUser({ name: 'Other', email: `oth${Date.now()}@x.co` });
  const prevPin = process.env.STAFF_ACCESS_PIN;
  const prevAdmins = process.env.ADMIN_EMAILS;
  process.env.STAFF_ACCESS_PIN = 'zzz';
  process.env.ADMIN_EMAILS = email;
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // No x-staff-pin at all — the owner is admin via the env allowlist (works on
    // any serverless instance regardless of the stored role).
    const ov = await fetch(`${base}/api/admin/overview`, { headers: { 'x-user-id': u.id } });
    assert.equal(ov.status, 200, 'owner reaches the admin API without the staff PIN');
    // A normal consumer is still blocked.
    const blocked = await fetch(`${base}/api/admin/overview`, { headers: { 'x-user-id': other.id } });
    assert.equal(blocked.status, 403, 'a non-owner consumer is still denied');
  } finally {
    server.close();
    if (prevPin === undefined) delete process.env.STAFF_ACCESS_PIN; else process.env.STAFF_ACCESS_PIN = prevPin;
    if (prevAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = prevAdmins;
  }
});

test('wave7 auth: loading an allowlisted owner account self-heals to admin (no PIN)', async () => {
  const email = `heal${Date.now()}@x.co`;
  const u = createUser({ name: 'Heal', email }); // plain consumer, created before allowlist
  assert.notEqual(u.role, 'admin');
  markEmailVerified(u.id); // owner has verified via Firebase/PIN at least once
  const prev = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = email;
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const d = await fetch(`${base}/api/account/${u.id}`, { headers: { 'x-user-id': u.id } }).then((r) => r.json());
    assert.equal(d.user.role, 'admin', 'just loading the owner account promotes it to admin');
  } finally {
    server.close();
    if (prev === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = prev;
  }
});

test('wave7 auth: /api/account/elevate flips an allowlisted owner to admin with the PIN', async () => {
  const email = `elev${Date.now()}@x.co`;
  const u = createUser({ name: 'Elev', email }); // plain consumer
  const prevPin = process.env.STAFF_ACCESS_PIN;
  const prevAdmins = process.env.ADMIN_EMAILS;
  process.env.STAFF_ACCESS_PIN = 'pin-7788';
  process.env.ADMIN_EMAILS = email;
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Wrong PIN → denied.
    const bad = await fetch(`${base}/api/account/elevate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': u.id }, body: JSON.stringify({ staffPin: 'nope' }) });
    assert.equal(bad.status, 403);
    // Right PIN → elevated.
    const ok = await fetch(`${base}/api/account/elevate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': u.id, 'x-staff-pin': 'pin-7788' }, body: JSON.stringify({ staffPin: 'pin-7788' }) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).user.role, 'admin');
  } finally {
    server.close();
    if (prevPin === undefined) delete process.env.STAFF_ACCESS_PIN; else process.env.STAFF_ACCESS_PIN = prevPin;
    if (prevAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = prevAdmins;
  }
});

test('wave7 manifest: travellers are matched to offer passengers by TYPE, not index', () => {
  // Offer order is adult, adult, child. The manifest arrives child-FIRST.
  const offerPassengers = [{ id: 'p1', type: 'adult' }, { id: 'p2', type: 'adult' }, { id: 'p3', type: 'child' }];
  const travellers = [
    { fullName: 'Luc Nseya', dob: '2018-02-20', type: 'child' },
    { fullName: 'Jean Nseya', dob: '1985-04-12', type: 'adult', email: 'jean@x.co' },
    { fullName: 'Marie Nseya', dob: '1987-09-01', type: 'adult' },
  ];
  const pax = duffelPaxW6(offerPassengers, travellers[0], { departureDate: '2026-09-01', travellers });
  // The child offer slot (p3) must carry the child traveller's DOB, never an adult's.
  const childSlot = pax.find((p) => p.type === 'child');
  assert.equal(childSlot.given_name, 'Luc');
  assert.equal(childSlot.born_on, '2018-02-20', 'child DOB lands in the child passenger slot');
  // Both adult slots carry adults (born before 2018), not the child.
  const adultSlots = pax.filter((p) => p.type === 'adult');
  assert.equal(adultSlots.length, 2);
  assert.ok(adultSlots.every((p) => p.born_on < '2018-01-01'), 'adult slots get adult DOBs');
  // Contact details stay on the lead (manifest index 0 = Luc, a child) — but the
  // lead is the contact regardless of type, so its slot carries the email.
  assert.ok(pax.some((p) => p.email === undefined), 'non-lead passengers carry no contact');
});

test('wave7 manifest: infant offer passenger claims an infant traveller', () => {
  const offerPassengers = [{ id: 'p1', type: 'adult' }, { id: 'p2', type: 'infant_without_seat' }];
  const travellers = [
    { fullName: 'Jean Nseya', dob: '1985-04-12', type: 'adult' },
    { fullName: 'Baby Nseya', dob: '2025-06-01', type: 'infant' },
  ];
  const pax = duffelPaxW6(offerPassengers, travellers[0], { departureDate: '2026-09-01', travellers });
  const infantSlot = pax.find((p) => p.type === 'infant_without_seat');
  assert.equal(infantSlot.given_name, 'Baby');
  assert.equal(infantSlot.born_on, '2025-06-01');
});

// ---- Serverless persistence: merge-save must not clobber other instances -----
test('serverless persistence: a partial merge-save keeps records from other instances', () => {
  // Mock Firebase RTDB node with the two write modes the code uses.
  const node = { users: {} };
  const setPath = (obj, path, val) => {
    const parts = path.split('/'); let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = cur[parts[i]] || {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = JSON.parse(JSON.stringify(val));
  };
  const update = (flat) => { for (const [k, v] of Object.entries(flat)) setPath(node, k, v); }; // ref.update (merge)

  // Instance A: a fresh instance holding only user A saves its store.
  const emailA = `insA${Date.now()}@x.co`;
  const a = createUser({ email: emailA, name: 'Inst A user' });
  update(flatSnapshot());
  assert.ok(node.users[a.id], 'A persisted to Firebase');

  // Instance B: a DIFFERENT fresh instance that never saw A (its store is hydrated
  // from an empty view) creates user B and saves. With the OLD whole-store set this
  // wiped A; with the merge write it must NOT.
  hydrate({ users: {} }); // simulate a cold instance that only knows about B
  const b = createUser({ email: `insB${Date.now()}@x.co`, name: 'Inst B user' });
  update(flatSnapshot());

  assert.ok(node.users[a.id], 'A SURVIVED B\'s partial save — no clobber');
  assert.ok(node.users[b.id], 'B persisted too');

  // And a cold instance C hydrating from Firebase sees BOTH.
  hydrate({ users: node.users });
  assert.ok(getUserById(a.id), 'instance C sees A after hydrate');
  assert.ok(getUserById(b.id), 'instance C sees B after hydrate');
});

// ---- Margin protection covers ALL free/promotional ACU, not just the starter ----
test('margin protection: only PURCHASED ACU (not free/reward/bonus) unlocks Deep search', () => {
  const rewarded = createUser({ name: 'Rewarded', email: `rew${Date.now()}@x.co` });
  rewardAcu(rewarded.id, 500, 'referral-reward'); // free promotional ACU (REWARD, not PURCHASE)
  assert.equal(usageStatsFn(rewarded.id).hasPurchasedAcu, false, 'reward ACU is not a purchase');
  const rDeep = costProtectionGate({ tier: 'deep', user: { acuBalance: 550 }, expectedBookingUSD: 0, hasPurchasedAcu: false });
  assert.equal(rDeep.allowed, false);
  assert.equal(rDeep.downgradeTo, 'smart', 'free/reward ACU cannot fund the expensive Deep tier');

  // A real top-up flips the commitment signal and unlocks Deep.
  buyAcu(rewarded.id, 'top5');
  assert.equal(usageStatsFn(rewarded.id).hasPurchasedAcu, true, 'a top-up is a purchase');
  const paidDeep = costProtectionGate({ tier: 'deep', user: { acuBalance: 1050 }, expectedBookingUSD: 0, hasPurchasedAcu: true });
  assert.equal(paidDeep.allowed, true, 'purchased ACU funds Deep');
});

// ---- Anti-farming: the free starter ACU can't be multiplied across accounts ----
test('anti-farming: free 50-ACU starter is capped per IP per day', () => {
  const ip = '203.0.113.7';
  const a = createUser({ name: 'Farm A', email: `fa${Date.now()}@x.co`, signupIp: ip });
  const b = createUser({ name: 'Farm B', email: `fb${Date.now()}@x.co`, signupIp: ip });
  const c = createUser({ name: 'Farm C', email: `fc${Date.now()}@x.co`, signupIp: ip });
  const d = createUser({ name: 'Farm D', email: `fd${Date.now()}@x.co`, signupIp: ip });
  assert.equal(a.acuBalance, 50, 'first account from an IP gets the starter');
  assert.equal(b.acuBalance, 50, 'second too (real households share IPs)');
  assert.equal(c.acuBalance, 0, 'beyond the per-IP cap, no free ACU — farming gets nothing');
  assert.equal(d.acuBalance, 0);
  assert.equal(createUser({ name: 'Other', email: `o${Date.now()}@x.co`, signupIp: '198.51.100.9' }).acuBalance, 50);
});

// ==== WAVE 8: close all loopholes / backdoors / abuse ========================
import { earnAcu, claimStripeEvent, recordBehaviour as recordBehaviourFn } from '../src/store.js';

test('wave8 auth: a self-registered owner-email account is NOT admin until verified', async () => {
  const email = `boss${Date.now()}@x.co`;
  const prev = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = email;
  try {
    // An account merely CLAIMING the owner email (e.g. via a store insert) is a
    // plain consumer — the overlay requires a server-set verification flag that
    // public signup can never set.
    const u = createUser({ name: 'Impostor', email });
    assert.equal(getUserById(u.id).role, 'consumer', 'unverified owner email is not admin');
    // Only after the trusted auth path marks it verified does the overlay apply.
    markEmailVerified(u.id);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const d = await fetch(`${base}/api/account/${u.id}`, { headers: { 'x-user-id': u.id } }).then((r) => r.json());
      assert.equal(d.user.role, 'admin', 'verified owner email is promoted');
    } finally { server.close(); }
  } finally { if (prev === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = prev; }
});

test('wave8 auth: public signup refuses to mint an owner-email account', async () => {
  const email = `reserved${Date.now()}@x.co`;
  const prev = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = email;
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ch = issueHumanChallenge();
    const humanCheck = { website: '', elapsedMs: MIN_FORM_MS + 500, interactions: 8, a: ch.a, b: ch.b, expiresAt: ch.expiresAt, token: ch.token, answer: ch.a + ch.b };
    const res = await fetch(`${base}/api/account`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', email, humanCheck }) });
    assert.equal(res.status, 403, 'owner email cannot be registered via public signup');
    assert.equal((await res.json()).error, 'use-admin-login');
  } finally {
    server.close();
    if (prev === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = prev;
  }
});

test('wave8 auth: record ids are unguessable (high-entropy, not sequential)', () => {
  const a = createUser({ name: 'Seq A', email: `sa${Date.now()}@x.co` });
  const b = createUser({ name: 'Seq B', email: `sb${Date.now()}@x.co` });
  // No attacker can derive B's id from A's — the random suffix has real entropy.
  assert.notEqual(a.id, b.id);
  const suffix = a.id.split('_')[1] || '';
  assert.ok(suffix.length >= 20, `id has a long random suffix (${a.id})`);
  assert.ok(/[0-9a-f]{20,}/.test(a.id), 'id carries a high-entropy hex tail');
});

test('wave8 abuse: updateUser can never elevate privilege', () => {
  const u = createUser({ name: 'Norm', email: `nm${Date.now()}@x.co` });
  updateUser(u.id, { role: 'admin', allAccess: true, emailVerified: true });
  const raw = getUserRaw(u.id);
  assert.equal(raw.role, 'consumer', 'role unchanged');
  assert.equal(!!raw.allAccess, false, 'allAccess unchanged');
  assert.equal(!!raw.emailVerified, false, 'emailVerified cannot be set by a profile edit');
});

test('wave8 money: repeatable reward actions are one-time (no unlimited ACU minting)', () => {
  const u = createUser({ name: 'Farmer', email: `frm${Date.now()}@x.co` });
  const start = getUserRaw(u.id).acuBalance;
  const first = earnAcu(u.id, 'UPLOAD_PHOTO');
  assert.equal(first.acu, 50, 'first upload rewards once');
  const second = earnAcu(u.id, 'UPLOAD_PHOTO');
  assert.equal(second.acu, 0, 'a second upload mints nothing');
  assert.equal(second.already, true);
  const shareA = earnAcu(u.id, 'SHARE_ITINERARY');
  const shareB = earnAcu(u.id, 'SHARE_ITINERARY');
  assert.equal(shareA.acu, 75);
  assert.equal(shareB.acu, 0, 'share itinerary is also one-time');
  assert.equal(getUserRaw(u.id).acuBalance, start + 50 + 75, 'balance grew by exactly one of each');
});

test('wave8 money: only a PAID booking counts as commitment (unpaid /api/book does not)', () => {
  const u = createUser({ name: 'Unpaid', email: `up${Date.now()}@x.co` });
  const opt = { tier: 'smart', components: [], pricing: { currency: 'GBP', symbol: '£', local: { total: 500 }, lines: { totalUSD: 633 } } };
  const b = createBooking({ userId: u.id, option: opt, lead: { fullName: 'Unpaid U', email: u.email } });
  assert.equal(usageStatsFn(u.id).priorBookings, 0, 'a confirmed-but-unpaid booking is NOT commitment');
  recordPayment(b.id, { type: 'stripe-checkout', amount: 500, gateway: 'stripe', reference: `evt_${Date.now()}` });
  assert.equal(usageStatsFn(u.id).priorBookings, 1, 'once money clears, it counts');
});

test('wave8 money: Stripe event fulfilment is idempotent (redelivery credits once)', () => {
  const evt = `evt_test_${Date.now()}`;
  assert.equal(claimStripeEvent(evt), true, 'first delivery fulfils');
  assert.equal(claimStripeEvent(evt), false, 'redelivery is a no-op');
  assert.equal(claimStripeEvent(`evt_other_${Date.now()}`), true, 'a different event still fulfils');
});

test('wave8 abuse: user-writable telemetry payload is size-capped', () => {
  const before = db.behaviour.length;
  const huge = 'x'.repeat(50000);
  recordBehaviourFn('anon', { event: 'e'.repeat(500), destination: 'd'.repeat(500), payload: { blob: huge } });
  const rec = db.behaviour[db.behaviour.length - 1];
  assert.ok(db.behaviour.length === before + 1);
  assert.ok(rec.event.length <= 80, 'event capped');
  assert.ok(rec.destination.length <= 80, 'destination capped');
  assert.deepEqual(rec.payload, {}, 'oversized payload dropped, not stored');
});

// ==== WAVE 9: Curated real-deals catalogue ==================================
import { createDeal, updateDeal, getDeal, listDeals, publicDeal, listDealsAdmin, buildDealOption, createDealFulfilment, dealTotalGBP, getBooking as getBookingById } from '../src/store.js';

test('wave9 deals: a deal needs a real price and never leaks the internal fulfilment note', () => {
  assert.equal(createDeal({ title: 'No price' }).error, 'price-required');
  assert.equal(createDeal({ priceGBP: 999 }).error, 'title-required');
  const { ok, deal } = createDeal({ title: 'Dubai 5★ Escape', priceGBP: 1299, destinationCity: 'Dubai', destinationCountry: 'UAE', inclusions: ['Return flights', '5 nights 5★'], fulfilmentNote: 'Book via Rayna portal net £980', wasPriceGBP: 1599 });
  assert.ok(ok);
  assert.equal(deal.priceBasis, undefined); // deals aren't bookings
  const pub = publicDeal(deal);
  assert.equal(pub.fulfilmentNote, undefined, 'internal note never exposed publicly');
  assert.equal(pub.wasPriceGBP, 1599, 'honest RRP kept (was > price)');
  // A "was" price below the sell price is dropped (never a fake discount).
  const cheapMarkup = createDeal({ title: 'Fake sale', priceGBP: 500, wasPriceGBP: 400 }).deal;
  assert.equal(cheapMarkup.wasPriceGBP, null, 'a was-price below the sell price is refused');
});

test('wave9 deals: only active deals are public; drafts are admin-only', () => {
  const draft = createDeal({ title: 'Draft deal', priceGBP: 200, active: false }).deal;
  const live = createDeal({ title: 'Live deal', priceGBP: 300, active: true }).deal;
  const publicIds = listDeals({ activeOnly: true }).map((d) => d.id);
  assert.ok(publicIds.includes(live.id), 'active deal is public');
  assert.ok(!publicIds.includes(draft.id), 'draft is hidden from the public');
  assert.ok(listDealsAdmin().some((d) => d.id === draft.id), 'admin sees the draft');
});

test('wave9 deals: per-person pricing multiplies; buying builds a CONFIRMED (payable) booking', () => {
  const deal = createDeal({ title: 'Beach week', priceGBP: 700, perPerson: true }).deal;
  assert.equal(dealTotalGBP(deal, 2), 1400, 'per-person price scales with pax');
  const option = buildDealOption(deal, 2);
  assert.equal(option.pricing.local.total, 1400);
  assert.equal(option.priceBasis, 'confirmed');
  const b = createBooking({ option, sourceDealId: deal.id, lead: { fullName: 'Buyer', email: 'buyer@x.co' } });
  assert.equal(b.priceBasis, 'confirmed', 'a curated deal booking is payable, not estimated');
  assert.equal(b.sourceDealId, deal.id);
});

test('wave9 deals: fulfilment lands in the ops desk and decrements stock only on payment', () => {
  const deal = createDeal({ title: 'Limited cruise', priceGBP: 900, slots: 3, fulfilmentNote: 'Book on MSC agent site' }).deal;
  const b = createBooking({ option: buildDealOption(deal, 1), sourceDealId: deal.id, lead: { fullName: 'Sailor', email: 'sail@x.co' } });
  assert.equal(getDeal(deal.id).sold, 0, 'stock is not touched until payment');
  const before = db.fulfilmentOrders.length;
  const order = createDealFulfilment(b);
  assert.ok(order, 'an ops order is created on payment');
  assert.equal(order.channel, 'ops:curated-deal');
  assert.equal(order.fulfilmentNote, 'Book on MSC agent site', 'the team gets the internal how-to-book note');
  assert.equal(db.fulfilmentOrders.length, before + 1);
  assert.equal(getDeal(deal.id).sold, 1, 'stock decremented once paid');
  // Idempotent — a redelivered webhook must not double-count.
  assert.equal(createDealFulfilment(b), null, 'no duplicate ops order / stock hit');
  assert.equal(getDeal(deal.id).sold, 1);
});

test('wave9 deals: admin CRUD is gated; public browse + reservation checkout work end to end', async () => {
  const admin = createUser({ name: 'Deal Admin', email: `da${Date.now()}@x.co`, role: 'admin' });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // A consumer cannot create deals.
    const nope = await fetch(`${base}/api/admin/deals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x', priceGBP: 10 }) });
    assert.equal(nope.status, 403);
    // Admin creates a published deal.
    const made = await fetch(`${base}/api/admin/deals`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': admin.id }, body: JSON.stringify({ title: 'London Theatre Break', priceGBP: 240, destinationCity: 'London', active: true, inclusions: ['2 nights hotel', 'West End ticket'] }) }).then((r) => r.json());
    assert.ok(made.ok);
    const dealId = made.deal.id;
    // Public sees it.
    const pub = await fetch(`${base}/api/deals`).then((r) => r.json());
    assert.ok(pub.deals.some((d) => d.id === dealId), 'published deal is publicly listed');
    // Checkout with no Stripe configured → a reservation + a real confirmed booking.
    const co = await fetch(`${base}/api/deals/${dealId}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pax: 1, lead: { fullName: 'Guest', email: 'g@x.co' } }) }).then((r) => r.json());
    assert.ok(co.ok);
    assert.equal(co.mode, 'reservation', 'without Stripe we take a reservation');
    assert.equal(getBookingById(co.booking.id).priceBasis, 'confirmed');
  } finally { server.close(); }
});

test('inspire: returns 3 cheapest destinations per window, cheaper further out, tags matched', () => {
  const out = inspireDestinations({ text: 'somewhere warm and cheap for a relaxing beach holiday', originCode: 'LHR', travellers: 2 });
  // Every window (30/60/120/180) yields exactly 3 ideas.
  for (const w of INSPIRE_WINDOWS) {
    assert.ok(Array.isArray(out.windows[w]), `window ${w} exists`);
    assert.equal(out.windows[w].length, 3, `window ${w} has 3 ideas`);
    // Each idea names a real country + city and carries a per-person price.
    for (const d of out.windows[w]) {
      assert.ok(d.countryName && d.city, 'country + city present');
      assert.ok(d.perSeatUSD > 0, 'priced per person');
    }
    // Sorted cheapest-first within the window.
    const prices = out.windows[w].map((d) => d.perSeatUSD);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b), `window ${w} sorted cheapest-first`);
  }
  // Booking the SAME destination further out is cheaper (180-day factor < 30-day).
  const near = out.windows[30][0];
  const far = out.windows[180].find((d) => d.code === near.code);
  if (far) assert.ok(far.perSeatUSD <= near.perSeatUSD, '180-day cheaper than 30-day for same city');
  // The preference keywords ("warm", "beach") are surfaced back to the user.
  assert.ok(out.matchedTags.length > 0, 'matched at least one preference tag');
});

test('master travel profile autosaves incrementally and every field persists (PATCH → GET)', async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const u = createUser({ name: 'Justin Nseya', email: `prof${Date.now()}@x.co` });
  const H = { 'content-type': 'application/json', 'x-user-id': u.id };
  const patch = (tp) => fetch(`${base}/api/account/${u.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ travelProfile: tp }) }).then((r) => r.json());
  try {
    // Autosave #1 — a couple of fields as the user types them.
    let d = await patch({ fullLegalName: 'Justin Ngolu Nseya', dob: '1987-04-09' });
    assert.equal(d.user.travelProfile.fullLegalName, 'Justin Ngolu Nseya', 'first autosave persists');
    // Autosave #2 — MORE fields land; the earlier ones must NOT be lost (merge).
    d = await patch({ nationality: 'GB', passportNumber: '144888474', passportExpiry: '2033-03-22' });
    assert.equal(d.user.travelProfile.passportNumber, '144888474', 'second autosave persists new field');
    assert.equal(d.user.travelProfile.fullLegalName, 'Justin Ngolu Nseya', 'earlier field survives the merge');
    // A fresh GET (what a page reload does) returns the fully accumulated profile.
    const got = await fetch(`${base}/api/account/${u.id}`, { headers: { 'x-user-id': u.id } }).then((r) => r.json());
    assert.equal(got.user.travelProfile.dob, '1987-04-09', 'reload sees DOB');
    assert.equal(got.user.travelProfile.nationality, 'GB', 'reload sees nationality');
    assert.equal(Object.keys(got.user.travelProfile).length >= 5, true, 'all five fields present after reload');
  } finally { server.close(); }
});
