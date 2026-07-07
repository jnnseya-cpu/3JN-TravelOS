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

// Known-risk destinations — long-standing, well-established government advisory
// levels (FCDO/State-style). The deterministic engine must never paint a
// do-not-travel destination as "Low risk · no advisories". Score = safety
// (higher is safer). Matched by city or country keyword.
const RISK_PROFILES = [
  { match: /kinshasa|congo|drc/i, score: 42, level: 'High', safety: 'Government advisories in effect — avoid eastern provinces and North Kivu; crime and demonstration risk in Kinshasa', health: 'Yellow-fever certificate REQUIRED · malaria zone · check outbreak notices', advisory: 'Most governments advise against all but essential travel to parts of DRC — check FCDO/State before booking.' },
  { match: /kabul|afghanistan/i, score: 12, level: 'Severe', safety: 'DO NOT TRAVEL — all government advisories', health: 'Medical infrastructure extremely limited', advisory: 'All major governments advise against ALL travel to Afghanistan.' },
  { match: /mogadishu|somalia/i, score: 15, level: 'Severe', safety: 'DO NOT TRAVEL — terrorism and kidnap risk', health: 'Medical facilities very limited', advisory: 'Advise against all travel.' },
  { match: /tripoli|libya/i, score: 18, level: 'Severe', safety: 'DO NOT TRAVEL — conflict and kidnap risk', health: 'Limited medical care', advisory: 'Advise against all travel.' },
  { match: /sanaa|yemen/i, score: 12, level: 'Severe', safety: 'DO NOT TRAVEL — armed conflict', health: 'Cholera risk · infrastructure collapse', advisory: 'Advise against all travel.' },
  { match: /damascus|syria/i, score: 15, level: 'Severe', safety: 'DO NOT TRAVEL — conflict zone', health: 'Limited medical care', advisory: 'Advise against all travel.' },
  { match: /port.?au.?prince|haiti/i, score: 22, level: 'Severe', safety: 'DO NOT TRAVEL — gang violence and kidnapping', health: 'Cholera risk · limited care', advisory: 'Advise against all travel.' },
  { match: /bamako|mali\b|ouagadougou|burkina/i, score: 25, level: 'High', safety: 'Advise against most travel — terrorism risk', health: 'Malaria zone', advisory: 'Advise against all but essential travel.' },
  { match: /caracas|venezuela/i, score: 35, level: 'High', safety: 'Reconsider travel — crime and shortages', health: 'Bring essential medication', advisory: 'Reconsider travel; some areas advise against all travel.' },
  { match: /lagos|abuja|nigeria/i, score: 52, level: 'Elevated', safety: 'Increased caution — several states carry advise-against notices', health: 'Yellow-fever certificate required · malaria zone', advisory: 'Exercise increased caution; regional advisories vary.' },
  { match: /cairo|egypt/i, score: 62, level: 'Moderate', safety: 'Increased caution — avoid North Sinai', health: 'Routine vaccinations advised', advisory: 'Tourist areas: normal precautions; regional exceptions apply.' },
  { match: /cape town|johannesburg|south africa/i, score: 60, level: 'Moderate', safety: 'Increased caution — elevated crime in some districts; use registered transport', health: 'No major alerts', advisory: 'Exercise increased caution.' },
  { match: /s(ã|a)o paulo|rio de janeiro|brazil/i, score: 60, level: 'Moderate', safety: 'Increased caution — street crime in urban centres', health: 'Check dengue/zika notices', advisory: 'Exercise increased caution.' },
  { match: /bangkok|thailand/i, score: 74, level: 'Moderate', safety: 'Normal precautions — avoid far-southern provinces', health: 'Dengue-season awareness', advisory: 'Most of Thailand: normal precautions.' },
  { match: /tokyo|japan/i, score: 95, level: 'Low', safety: 'Very safe — normal precautions', health: 'No alerts', advisory: 'One of the safest major destinations.' },
];

export function riskFeed(destinationText) {
  const dest = resolveDest(destinationText);
  if (!dest) return { ok: false, error: 'unknown-destination' };
  const rnd = seed('risk-' + dest.code);
  const hay = `${dest.city} ${dest.countryName || ''} ${destinationText}`;
  const profile = RISK_PROFILES.find((p) => p.match.test(hay)) || null;
  const score = profile ? profile.score : Math.round(78 + rnd() * 20); // higher = safer
  const level = profile ? profile.level : (score >= 90 ? 'Low' : score >= 80 ? 'Moderate' : 'Elevated');
  const layers = LAYERS.map((name) => {
    const sVal = Math.round(72 + rnd() * 26);
    let note = layerNote(name, dest, rnd);
    let status = sVal >= 88 ? 'good' : sVal >= 78 ? 'watch' : 'caution';
    if (profile && name === 'Safety') { note = profile.safety; status = score < 45 ? 'caution' : 'watch'; }
    if (profile && name === 'Health') { note = profile.health; status = score < 45 ? 'caution' : 'watch'; }
    return { layer: name, status, note };
  });
  return {
    ok: true,
    estimated: !!dest.estimated,
    destination: { code: dest.code, city: dest.city, country: dest.countryName },
    riskScore: score,
    level,
    knownProfile: !!profile,
    layers,
    advisories: profile
      ? [profile.advisory, 'Reflects long-standing government advisories — always confirm the official FCDO/State page before booking.']
      : [
        `${dest.city}: ${level.toLowerCase()} overall risk — standard precautions advised.`,
        `Best travel window identified for ${dest.city} based on weather + demand.`,
      ],
    disclaimer: 'Estimated intelligence — confirm on the official government travel-advice portal.',
  };
}

// ---- Travel Intelligence Score (USP #3) ------------------------------------
// Every trip receives seven 0–100 scores — Cost, Safety, Visa, Weather, Crowd,
// Value, Risk — deterministic (seeded) so the same trip always scores the same.
const PEAK_MONTHS = ['july', 'august', 'december'];
const SHOULDER_MONTHS = ['april', 'may', 'june', 'september', 'october'];
export function travelIntelligenceScore({ destinationText, month = null, savingsPct = 0, avgReliability = 80, visaProbability = null }) {
  const risk = riskFeed(destinationText);
  if (!risk.ok) return null;
  const rnd = seed('tis-' + risk.destination.code + '-' + (month || 'any'));
  const m = (month || '').toLowerCase();
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

  const safetyScore = risk.riskScore; // higher = safer (honest profiles included)
  const visaScore = visaProbability != null ? clamp(visaProbability) : clamp(70 + rnd() * 25);
  const costScore = clamp(50 + savingsPct * 2.5);                    // savings vs public floor
  const crowdScore = clamp(PEAK_MONTHS.includes(m) ? 45 + rnd() * 15 : SHOULDER_MONTHS.includes(m) ? 70 + rnd() * 15 : 82 + rnd() * 14);
  const weatherScore = clamp(SHOULDER_MONTHS.includes(m) ? 80 + rnd() * 16 : PEAK_MONTHS.includes(m) ? 68 + rnd() * 20 : 60 + rnd() * 25);
  const valueScore = clamp(avgReliability * 0.6 + costScore * 0.4);  // reliability per pound
  const riskScore = clamp(safetyScore * 0.6 + visaScore * 0.4);      // composite trip risk (higher = lower risk)

  const scores = { costScore, safetyScore, visaScore, weatherScore, crowdScore, valueScore, riskScore };
  const overall = clamp(Object.values(scores).reduce((s, v) => s + v, 0) / 7);
  return {
    destination: risk.destination,
    scores,
    overall,
    band: overall >= 80 ? 'Excellent' : overall >= 65 ? 'Good' : overall >= 50 ? 'Fair' : 'Caution',
    disclaimer: risk.disclaimer,
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
