// Behavioural-learning / ML engine for 3JN Travel OS.
//
// Every meaningful user action (search, destination view, plan, quote, booking,
// dwell) is logged to the behaviour stream. This module turns that stream into
// a per-user PROFILE and a personalised JOURNEY DASHBOARD — so the hero panel is
// driven by what the user actually searches and does, not a hard-coded Dubai
// example.
//
// The "model" here is a transparent, deterministic recommender (recency-decayed
// weighted affinities + simple aggregations). It runs fully offline so the
// prototype needs no external ML service; in production the same interface could
// front a real embedding/collaborative-filtering model. Each learning TRACK is
// attributed to a named AI agent so the execution is visible to the user.

import { recordBehaviour, listBehaviour } from './store.js';
import { DESTINATIONS, destinationsCatalog, visaRule } from './destinations.js';
import { riskFeed } from './intelligence.js';
import { CURRENCY_BY_COUNTRY, COUNTRY_NAMES } from './geo.js';
import { route } from './ai-gateway.js';

// How much each kind of event says about intent (higher = stronger signal).
const EVENT_WEIGHTS = {
  book: 12,
  quote: 7,
  plan: 4,
  search: 3,
  view_destination: 2,
  clarify: 1.5,
  chip: 1,
  dwell: 0.4,
  view: 0.3,
};
// Interest in a destination halves every 14 days of inactivity.
const HALF_LIFE_DAYS = 14;

function partyBucket(total) {
  if (!total || total <= 1) return 'solo';
  if (total === 2) return 'couple';
  if (total >= 5) return 'group';
  return 'family';
}

// Record a behaviour event (thin wrapper so callers don't import the store).
export function track(userId, event) {
  return recordBehaviour(userId, event);
}

// Build a learned profile for a user from their behaviour stream.
export function learnProfile(userId, now = Date.now()) {
  const events = listBehaviour(userId);
  const affinity = {};
  const party = {};
  const months = {};
  const tiers = {};
  const interests = {};
  let nightsSum = 0;
  let nightsCount = 0;
  let totalWeight = 0;

  for (const ev of events) {
    // A missing/malformed `at` makes Date.parse NaN, which cascades NaN through
    // every weight and poisons the ENTIRE profile. Treat an unparseable date as
    // "just now" (no decay) so one bad event can't wipe out the learning.
    const parsedAt = Date.parse(ev.at);
    const ageDays = Number.isFinite(parsedAt) ? Math.max(0, (now - parsedAt) / 86400000) : 0;
    const decay = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    const w = (EVENT_WEIGHTS[ev.event] ?? 0.3) * decay;
    totalWeight += w;
    if (ev.destination && DESTINATIONS[ev.destination]) {
      affinity[ev.destination] = (affinity[ev.destination] || 0) + w;
    }
    const p = ev.payload || {};
    if (p.party) party[partyBucket(p.party)] = (party[partyBucket(p.party)] || 0) + w;
    if (p.nights) { nightsSum += p.nights * w; nightsCount += w; }
    if (p.month) months[p.month] = (months[p.month] || 0) + w;
    if (p.tier) tiers[p.tier] = (tiers[p.tier] || 0) + w;
    if (Array.isArray(p.components)) p.components.forEach((c) => { interests[c] = (interests[c] || 0) + w; });
  }

  const totalAffinity = Object.values(affinity).reduce((a, b) => a + b, 0) || 1;
  const topDestinations = Object.entries(affinity)
    .sort((a, b) => b[1] - a[1])
    .map(([code, score]) => ({
      code,
      city: DESTINATIONS[code].city,
      countryName: DESTINATIONS[code].countryName,
      score: Math.round(score * 100) / 100,
      share: score / totalAffinity,
    }));

  const topKey = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const tier = topKey(tiers);
  const budgetBand = tier === 'deep' ? 'premium' : tier === 'express' ? 'value-led' : tier ? 'balanced' : 'unknown';

  return {
    userId: userId || 'guest',
    eventCount: events.length,
    uniqueDestinations: topDestinations.length,
    topDestinations,
    preferredParty: topKey(party),
    avgNights: nightsCount ? Math.round(nightsSum / nightsCount) : null,
    preferredMonth: topKey(months),
    budgetBand,
    interests: Object.entries(interests).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 5),
    // 0..1 — how much signal we have. ~6 strong events ≈ confident.
    confidence: Math.min(1, totalWeight / 18),
  };
}

// Pick a sensible default destination when we have no behavioural signal yet.
// Deterministic per region so different users don't all see Dubai.
function regionDefault(context) {
  const catalog = destinationsCatalog();
  const country = context?.country || 'GB';
  const hash = country.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return catalog[hash % catalog.length].code;
}

const ICONS = { flight: '✈', hotel: '🏨', visa: '🛂', transfer: '🚘', window: '📅', risk: '🛡', weather: '🌦', currency: '💱' };

// The personalised Journey Dashboard for the hero panel.
export function journeyDashboard(userId, context) {
  const ctx = context || { country: 'GB', countryName: 'United Kingdom', currency: { code: 'GBP', symbol: '£', rateFromUSD: 0.79 } };
  const profile = learnProfile(userId);
  const top = profile.topDestinations[0];
  const learned = Boolean(top);
  const code = top?.code || regionDefault(ctx);
  const dest = DESTINATIONS[code];
  const meta = destinationsCatalog().find((d) => d.code === code) || { emoji: '✈️' };
  const cur = ctx.currency || { code: 'USD', symbol: '$', rateFromUSD: 1 };
  const toLocal = (usd) => Math.round(usd * (cur.rateFromUSD || 1));
  const money = (usd) => `${cur.symbol}${toLocal(usd).toLocaleString()}`;

  const nights = profile.avgNights || 7;
  const risk = riskFeed(code);
  const weatherLayer = risk.ok ? risk.layers.find((l) => l.layer === 'Weather') : null;

  // Reference cost basis (real per-destination data) and honest, clearly-labelled
  // savings ESTIMATES derived from it. Nothing here is a booked fact — the copy
  // says "from" / "est." so the traveller is never shown a fake confirmed status.
  const flightFromUSD = dest.flightBaseUSD;
  const hotelStayUSD = dest.hotelNightBaseUSD * nights;
  const transferFromUSD = dest.transferBaseUSD || dest.carDayBaseUSD || 30;
  const flightSaveUSD = Math.round(dest.flightBaseUSD * 0.32);
  const hotelUpgradeUSD = Math.round(dest.hotelNightBaseUSD * 0.45 * nights * 0.18);
  const windowSaveUSD = Math.round((dest.flightBaseUSD + hotelStayUSD) * 0.07);
  const totalSaveUSD = flightSaveUSD + windowSaveUSD + hotelUpgradeUSD;

  // Visa status for the user's nationality (their detected region) — show the
  // actual rule (type + fee) instead of a vague "ready".
  const visa = visaRule(dest, ctx.country);
  const visaValue = visa.required
    ? `${visa.type || 'eVisa'}${visa.costUSD ? ` · ${money(visa.costUSD)}` : ''}`
    : (visa.type || 'Visa-free');

  // Currency pair: user's currency → destination-country currency.
  const toCur = CURRENCY_BY_COUNTRY[dest.country];
  let currencyRow;
  if (toCur && toCur.code !== cur.code) {
    const rate = (toCur.rateFromUSD / (cur.rateFromUSD || 1));
    currencyRow = { icon: ICONS.currency, label: `Currency · ${cur.code}→${toCur.code}`, value: `${rate.toFixed(2)} best`, kind: 'blue' };
  } else {
    currencyRow = { icon: ICONS.currency, label: `Currency · ${cur.code}`, value: 'Rates locked', kind: 'blue' };
  }

  const monthLabel = profile.preferredMonth ? profile.preferredMonth[0].toUpperCase() + profile.preferredMonth.slice(1) : 'flexible dates';

  const rows = [
    { icon: ICONS.flight, label: `Cheapest flight · ${dest.city}`, value: `from ${money(flightFromUSD)} · est. save ${money(flightSaveUSD)}`, kind: 'good' },
    { icon: ICONS.hotel, label: `Hotel · ${nights} nights`, value: `from ${money(hotelStayUSD)} · upgrade value +${money(hotelUpgradeUSD)}`, kind: 'blue' },
    { icon: ICONS.visa, label: `Visa · ${dest.city} (${COUNTRY_NAMES[ctx.country] || ctx.country})`, value: visaValue, kind: visa.required ? 'blue' : 'good' },
    { icon: ICONS.transfer, label: 'Airport transfer', value: `from ${money(transferFromUSD)} · ready to add`, kind: 'blue' },
    { icon: ICONS.window, label: `Best travel window · ${monthLabel}`, value: `est. save ${money(windowSaveUSD)}`, kind: 'good' },
    { icon: ICONS.risk, label: 'Travel Risk Score', value: risk.ok ? `${risk.riskScore} · ${risk.level}` : '—', kind: 'good' },
    { icon: ICONS.weather, label: `Weather · ${dest.city}`, value: weatherLayer ? weatherLayer.note : '—', kind: 'blue' },
    currencyRow,
  ];

  const signalWord = profile.eventCount === 1 ? 'signal' : 'signals';
  const learnedFrom = learned
    ? `Learned from your activity — ${profile.eventCount} ${signalWord}, ${dest.city} is your strongest match (${Math.round(top.share * 100)}%).`
    : `Personalised to ${ctx.countryName}. Search a trip and the dashboard rebuilds around you.`;

  return {
    destination: { code, city: dest.city, countryName: dest.countryName, emoji: meta.emoji },
    learned,
    learnedFrom,
    confidence: profile.confidence,
    currency: { code: cur.code, symbol: cur.symbol },
    rows,
    savings: {
      local: toLocal(totalSaveUSD),
      display: money(totalSaveUSD),
      headline: `Est. saving ${money(totalSaveUSD)}`,
      note: learned
        ? `Projected across flight, hotel upgrade and flexible dates for ${dest.city}. Run the search for a live, bookable price.`
        : `Typical saving for ${dest.city}. Search your real dates to lock an exact, bookable price.`,
    },
    agents: learningAgents(profile, top, ctx),
    aiRouting: route('behaviourLearning'),
  };
}

// The ML/behaviour-learning AI agents and the track each one executes. Surfaced
// to the user so the "machine learning that runs on your behaviour" is visible.
export function learningAgents(profile, top, ctx) {
  return [
    {
      agent: 'Pattern Miner',
      track: 'Search & activity patterns',
      learned: profile.eventCount ? `${profile.eventCount} signals across ${profile.uniqueDestinations} destinations` : 'Awaiting first signals',
      route: 'behaviourLearning',
    },
    {
      agent: 'Affinity Engine',
      track: 'Destination affinity',
      learned: top ? `Top match: ${top.city} (${Math.round(top.share * 100)}%)` : 'No destination affinity yet',
      route: 'recommendation',
    },
    {
      agent: 'Seasonality Forecaster',
      track: 'Travel window',
      learned: profile.preferredMonth ? `Prefers ${profile.preferredMonth}` : 'Flexible dates',
      route: 'riskBriefing',
    },
    {
      agent: 'Budget Sensor',
      track: 'Budget sensitivity',
      learned: profile.budgetBand === 'unknown' ? 'Learning budget band' : profile.budgetBand,
      route: 'behaviourLearning',
    },
    {
      agent: 'Preference Graph',
      track: 'Experience preferences',
      learned: profile.interests.length ? profile.interests.join(', ') : 'Broad interests',
      route: 'recommendation',
    },
    {
      agent: 'Geo & Currency Agent',
      track: 'Region & currency',
      learned: `${ctx.countryName || ctx.country} · ${ctx.currency?.code || 'USD'}`,
      route: 'translation',
    },
  ];
}
