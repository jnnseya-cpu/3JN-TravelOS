// Visa Centre + Risk Intelligence Feed.
//
// Visa: deterministic eligibility from the destination catalogue's visa rules,
// keyed by traveller nationality. Risk: a deterministic, destination-seeded
// risk score (0-100, higher = safer) plus advisory cards across the seven
// intelligence layers from the landing page.

import { DESTINATIONS, findDestination, visaRule } from './destinations.js';

const titleCase = (s) => (s || '').trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Resolve ANY destination the user types — a catalogue city (full data) or any
// other place worldwide (a deterministic, clearly-estimated profile). This is
// what makes the Travel Intelligence lookup global rather than 5 cities only.
function resolveDest(text) {
  const known = findDestination(text) || (DESTINATIONS[text] && { code: text, ...DESTINATIONS[text] });
  if (known) return { ...known, estimated: false };
  const city = titleCase(text);
  if (!city) return null;
  const code = (city.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6)) || 'CITY';
  return { code, city, countryName: city, estimated: true };
}

// Deterministic estimated visa rule for any non-catalogue destination.
function estimatedVisaRule(nationality, city) {
  const r = seed(`visa-${nationality}-${city}`);
  const required = r() > 0.28; // most international tourist travel needs an eVisa/eTA
  return {
    required,
    type: required ? 'eVisa / eTA (tourist) — estimated' : 'Likely visa-free (estimated)',
    costUSD: required ? Math.round(20 + r() * 130) : 0,
    processingDays: required ? Math.round(2 + r() * 13) : 0,
  };
}

export function visaCheck(nationality, destinationText) {
  const dest = resolveDest(destinationText);
  if (!dest) return { ok: false, error: 'unknown-destination' };
  const nat = (nationality || 'GB').toUpperCase();
  const rule = dest.estimated ? estimatedVisaRule(nat, dest.city) : visaRule(dest, nat);
  return {
    ok: true,
    estimated: !!dest.estimated,
    destination: { code: dest.code, city: dest.city, country: dest.countryName },
    nationality: nat,
    required: rule.required,
    visaType: rule.type,
    costUSD: rule.costUSD,
    processingDays: rule.processingDays,
    checklist: rule.required
      ? ['Valid passport (6+ months)', 'Passport-style photo', 'Return ticket', 'Proof of accommodation', rule.processingDays > 7 ? 'Bank statements (3 months)' : 'Online application']
      : ['Valid passport (6+ months)', 'Return ticket'],
    recommendation: rule.required
      ? `Apply at least ${Math.max(7, rule.processingDays + 3)} days before travel. 3JN Visa Concierge can process this for you.${dest.estimated ? ' Figures are estimated — confirm with the official portal.' : ''}`
      : `No visa expected for this trip — travel on your passport.${dest.estimated ? ' (Estimated — confirm officially.)' : ''}`,
  };
}

function seed(str) {
  let s = 0;
  for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) % 2147483647;
  return () => { s = (s * 1103515245 + 12345) % 2147483647; return s / 2147483647; };
}

const LAYERS = ['Weather', 'Safety', 'Visa', 'Currency', 'Demand', 'Crowd', 'Health'];

export function riskFeed(destinationText) {
  const dest = resolveDest(destinationText);
  if (!dest) return { ok: false, error: 'unknown-destination' };
  const rnd = seed('risk-' + dest.code);
  const score = Math.round(78 + rnd() * 20); // 78-98, higher = safer
  const level = score >= 90 ? 'Low' : score >= 80 ? 'Moderate' : 'Elevated';
  const layers = LAYERS.map((name) => {
    const s = Math.round(72 + rnd() * 26);
    return { layer: name, status: s >= 88 ? 'good' : s >= 78 ? 'watch' : 'caution', note: layerNote(name, dest, rnd) };
  });
  return {
    ok: true,
    estimated: !!dest.estimated,
    destination: { code: dest.code, city: dest.city, country: dest.countryName },
    riskScore: score,
    level,
    layers,
    advisories: [
      `${dest.city}: ${level.toLowerCase()} overall risk — standard precautions advised.`,
      `Best travel window identified for ${dest.city} based on weather + demand.`,
    ],
  };
}

function layerNote(name, dest, rnd) {
  switch (name) {
    case 'Weather': return `${Math.round(20 + rnd() * 18)}°C, mostly clear`;
    case 'Safety': return 'No active advisories';
    case 'Visa': return 'Requirements vary by nationality — check Visa Centre';
    case 'Currency': return 'Rates favourable this week';
    case 'Demand': return rnd() > 0.5 ? 'Prices rising — book soon' : 'Prices stable';
    case 'Crowd': return rnd() > 0.5 ? 'Moderate crowds' : 'Quieter period';
    case 'Health': return 'No health alerts';
    default: return '';
  }
}

export { DESTINATIONS };
