// End-to-end-ish unit tests for the 3JN Travel OS pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseIntent } from '../src/intent.js';
import { detectContext } from '../src/geo.js';
import { plan } from '../src/planner.js';
import { priceBreakdown, instalmentPlan, tierForPoints } from '../src/pricing.js';
import { costProtectionGate, whiteLabelPayout } from '../src/revenue.js';
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
import { visaFramework, buildChecklist, assessApplication } from '../src/visa-framework.js';
import { bookingRequirements, validateBooking, bookingRiskScore, fieldCount } from '../src/booking-schema.js';
import { architecture as commsArchitecture, emit as commsEmit, renderEmail as commsRenderEmail, EVENTS as COMMS_EVENTS } from '../src/comms.js';
import { track, learnProfile, journeyDashboard } from '../src/learning.js';
import { flightFareUnits, fareBandForAge } from '../src/suppliers.js';
import { duffelPassengers, durationLabel, normalizeDuffelOffer, normalizeAmadeusHotel, liveSuppliersConfigured } from '../src/live-suppliers.js';
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
  // Voyager = 5% off suppliers
  assert.equal(b.lines.loyaltyDiscountUSD, 50);
  assert.equal(b.lines.netSuppliersUSD, 950);
  assert.equal(b.lines.commissionUSD, 95); // 10% of net
  assert.equal(b.lines.totalUSD, 1045);
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
