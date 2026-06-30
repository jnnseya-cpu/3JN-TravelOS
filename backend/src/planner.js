// Orchestrator — runs the full pipeline the brief describes, end to end:
//   understand intent -> detect context -> gate the search -> scan suppliers ->
//   compare & filter to reliable/verified -> build tiered packages -> recommend.
//
// This never throws on malformed input: if the destination can't be resolved it
// returns clarifying questions instead of crashing (directly solving the
// "Console Error: {}" class of failures from the previous build).

import { parseIntent } from './intent.js';
import { findDestination, originForCountry } from './destinations.js';
import { scanAll } from './suppliers.js';
import { buildPackages, clarifyingQuestions } from './packager.js';
import { costProtectionGate, SEARCH_TIERS } from './revenue.js';
import { route } from './ai-gateway.js';
import { approvalProbability } from './visaos.js';

export function plan({ text, context, user, searchTier = 'smart', overrides = {} }) {
  const intent = parseIntent(text, context, new Date(Date.UTC(2026, 5, 30)));

  // Apply any answers the user gave to clarifying questions.
  if (overrides.destination && !intent.destination) {
    intent.destination = findDestination(overrides.destination);
    if (intent.destination) intent.unresolved = intent.unresolved.filter((u) => u !== 'destination');
  }
  if (overrides.month) intent.month = overrides.month;

  // If we still can't resolve the destination, ask rather than fail.
  const questions = clarifyingQuestions(intent);
  if (!intent.destination) {
    return { stage: 'clarify', intent, questions, context };
  }

  // Estimate expected booking value (for the cost-protection gate) from a rough
  // pre-scan of the cheapest combination.
  const origin = originForCountry(intent.nationality);
  const scan = scanAll(intent, intent.destination, origin);
  const expectedBookingUSD = roughTotal(scan);

  // Cost-protection gate (ACPE).
  const gate = costProtectionGate({
    tier: searchTier,
    user,
    subscriptionActive: !!(user && user.subscriptionActive),
    expectedBookingUSD,
  });

  const effectiveTier = gate.allowed ? searchTier : (gate.downgradeTo || 'free');

  // Build packages (the scan already ran; gate decides depth/labelling).
  const currency = context.currency;
  const points = user ? user.points : 0;
  const packages = buildPackages(scan, intent, currency, points);

  return {
    stage: 'options',
    intent: publicIntent(intent),
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
    // 3JN VisaOS: pre-booking visa approval probability for this traveller.
    visa: approvalProbability(intent.nationality, intent.destination.city),
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
    destination: { code: intent.destination.code, city: intent.destination.city, countryName: intent.destination.countryName },
    travellers: intent.travellers,
    nights: intent.nights,
    month: intent.month,
    dates: intent.dates,
    components: intent.components,
    wantsInstalments: intent.wantsInstalments,
    priority: intent.priority,
    nationality: intent.nationality,
  };
}
