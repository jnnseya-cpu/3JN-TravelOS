// End-to-end-ish unit tests for the 3JN Travel OS pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseIntent } from '../src/intent.js';
import { detectContext } from '../src/geo.js';
import { plan } from '../src/planner.js';
import { priceBreakdown, instalmentPlan, tierForPoints } from '../src/pricing.js';
import { costProtectionGate, whiteLabelPayout } from '../src/revenue.js';
import { createUser, createBooking, saveQuote } from '../src/store.js';
import { runPriceGuard } from '../src/monitor.js';

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
  // flights route to an affiliate partner, not Direct
  const flight = std.components.find((c) => c.type === 'flight');
  assert.ok(['Kiwi.com', 'Trip.com', 'Expedia'].includes(flight.sourcedVia));
});

test('referral rewards both parties', () => {
  const referrer = createUser({ name: 'Referrer' });
  const friend = createUser({ name: 'Friend', referredByCode: referrer.referralCode });
  assert.equal(friend.points, 250 + 50); // signup bonus + referral
});
