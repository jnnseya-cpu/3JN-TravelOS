// 3JN VisaOS — AI-powered global visa intelligence & decision engine.
//
// A Visa Decision Agent Swarm: ten specialised agents run in parallel, each
// emitting findings that roll up into seven risk dimensions, a unified 0–1000
// score, and a decision (Auto Approval / Conditional / Human Review / Reject).
//
// Deterministic by design (seeded) so the same application always yields the
// same decision — auditable and testable. In production each agent would call
// document-forensics, biometric, OSINT, watchlist and behavioural services.

import { findDestination, visaRule, DESTINATIONS, resolveDestination } from './destinations.js';

// ---- 3JN VisaOS — module manifest (GovTech / RegTech / Border Intelligence) --
// The premium module positioning, dictated and locked. This is not an OTA
// feature: it is digital border & visa decision infrastructure sold to
// governments, immigration authorities and consulates.
export const VISAOS_MANIFEST = {
  name: '3JN VisaOS',
  category: 'Global AI-Powered Digital Border & Visa Decision Infrastructure (GovTech + RegTech + Border Intelligence)',
  positioning: '3JN VisaOS is a world-class AI-powered digital visa operating system that enables governments, immigration authorities and consulates to receive, verify, investigate, risk-score and decide visa applications in minutes through advanced fraud detection, behavioural intelligence, document forensics and real-time global risk assessment.',
  tagline: 'From embassy queues to AI-powered border intelligence.',
  problems: [
    'Embassy queues', 'Long waiting times', 'Inconsistent decision-making', 'Manual verification',
    'Forged documents', 'Fake bank statements', 'Fake employment letters', 'False declarations',
    'Bribery / corruption risk', 'Human bias', 'Poor fraud detection', 'Slow background checks', 'Expensive staffing',
  ],
  vision: 'Replace slow human-heavy visa processing with AI-driven digital border intelligence and near-instant trusted decisions.',
  sla: { decisionMinutes: 5, condition: 'after complete submission & payment, unless escalated' },
  promise: {
    prerequisites: ['Documents uploaded', 'Biometrics submitted', 'Payment confirmed'],
    outcomes: ['Approved', 'Rejected', 'Escalated for Human Review'],
    within: 'minutes',
  },
};

// Per-agent forensic checklists (the dictated swarm architecture). Each agent
// in agentFindings() runs these checks; the lists are test-pinned so the
// published capability can never drift from the engine.
export const AGENT_CHECKS = {
  'Document Forensics': [
    'Edits', 'Manipulation', 'Metadata tampering', 'Photoshop traces', 'Pixel inconsistencies',
    'Forged stamps', 'Signature anomalies', 'OCR mismatch', 'Duplicate templates',
  ],
  'Financial Authenticity': [
    'Bank statements', 'Salary consistency', 'Spending behaviour', 'Source of funds',
    'Unusual deposits', 'Money laundering signals', 'Sudden balance inflation',
  ],
  'Identity Verification': [
    'Passport authenticity', 'Face match', 'Liveness detection', 'Identity duplication',
    'Criminal watchlists', 'Sanctions lists', 'Terror databases', 'Stolen identity risk',
  ],
  // The moat: the AI investigates whether the declared identity matches real
  // life ("Senior Engineer at GE" with no footprint → risk rises).
  'Online Footprint Intelligence': [
    'LinkedIn consistency', 'Employment history', 'Professional presence', 'Business registrations',
    'Social media footprint', 'Travel history', 'Education consistency', 'Address consistency',
    'Public records', 'Reputation signals', 'Fraud signals',
  ],
  // Elite: deception shows in HOW the application is completed, not just what
  // it says (high hesitation around employment history → risk rises).
  'Behavioural Intelligence': [
    'Typing speed', 'Hesitation patterns', 'Correction frequency', 'Unusual pauses',
    'Navigation behaviour', 'Evasive answer patterns', 'Document upload stress signals', 'Contradiction signals',
  ],
  // Critical for governments: predicts the probability of overstay (0–100).
  'Overstay Risk': [
    'Travel history', 'Previous visa compliance', 'Home country economics', 'Family ties',
    'Job stability', 'Property ownership', 'Income consistency', 'Age', 'Dependents',
    'Migration patterns', 'Return probability', 'Historical country overstay data',
  ],
  // Identifies fraud CLUSTERS, not just individual bad documents.
  'Fraud Detection': [
    'Fake sponsors', 'Visa agents fraud', 'Organised fraud rings', 'Synthetic identities',
    'Repeat fraud patterns', 'Mule applicants', 'Network fraud',
  ],
  // Is the declared story credible for the declared purpose?
  'Intent Assessment': [
    'Tourism', 'Business', 'Study', 'Family visit', 'Medical', 'Conference',
  ],
  // The national security layer.
  'Border Risk': [
    'Criminal databases', 'Terrorism watchlists', 'Sanctions', 'Extremist networks',
    'Trafficking indicators', 'Smuggling signals',
  ],
  // The master AI: aggregates all intelligence into the unified 0–1000 risk
  // score and the Visa Decision Confidence Score.
  'Decision Agent': [
    'Aggregate all agent findings', 'Weight seven risk dimensions', 'Produce unified 0–1000 risk score',
    'Produce Visa Decision Confidence Score', 'Route: approve / conditional / human review / reject',
  ],
};

// ---- Physical Embassy Elimination (the key USP) -------------------------------
// Old model: Apply → Queue → Appointment → Wait → Interview → Decision.
// VisaOS: Apply Online → AI Verification → Risk Scoring → Decision in Minutes.
export const DIGITAL_JOURNEY = {
  usp: 'Physical Embassy Elimination',
  oldModel: ['Apply', 'Queue', 'Appointment', 'Wait', 'Interview', 'Decision'],
  newModel: ['Apply Online', 'AI Verification', 'Risk Scoring', 'Decision in Minutes'],
  physicalAppearanceOnlyIf: [
    'Biometrics required', 'Security escalation', 'Suspicious case', 'Random audit', 'Final interview',
  ],
  target: { fullyDigitalPct: [90, 95], effect: 'Embassy queues collapse.' },
};

// ---- Anti-Corruption Layer (documented; enforced in store.decideVisaApplication)
// No manual officer can secretly approve a fraudulent application: approving
// against the AI's high-risk verdict requires a written reason + a second
// approver (approval chain), and lands in the immutable audit log AND the
// hash-chained audit trail. This reduces bribery.
export const ANTI_CORRUPTION = {
  rule: 'No manual officer can secretly approve a fraudulent application.',
  overrideRequires: ['Reason', 'Approval chain', 'Audit log'],
  effect: 'This reduces bribery.',
};

// ---- Fraud-Free Architecture: Zero Trust -------------------------------------
// Trust nothing by default. Everything must be verified. Six mandatory
// security layers wrap every application; their per-application status is
// attached to each assessment, and decisions are sealed into a hash-chained
// audit trail (see store.sealVisaBlock) so no decision can be altered secretly.
export const ZERO_TRUST = {
  principle: 'Trust nothing by default. Everything must be verified.',
  mandatoryLayers: [
    { layer: 'Biometric Liveness', stops: 'Impersonation' },
    { layer: 'Device Fingerprinting', stops: 'Fraud devices' },
    { layer: 'IP Intelligence', stops: 'Suspicious geographies' },
    { layer: 'Metadata Analysis', stops: 'Manipulated files' },
    { layer: 'Blockchain Audit Trail', stops: 'Decisions altered secretly' },
    { layer: 'Immutable Logs', stops: 'Unrecorded actions' },
  ],
};
function zeroTrustStatus(a) {
  return {
    principle: ZERO_TRUST.principle,
    layers: [
      { layer: 'Biometric Liveness', status: a.livenessFailed ? 'fail' : 'pass', note: a.livenessFailed ? 'Liveness check failed — possible impersonation.' : 'Live subject confirmed; presentation attack ruled out.' },
      { layer: 'Device Fingerprinting', status: a.deviceFraud ? 'fail' : 'pass', note: a.deviceFraud ? 'Device fingerprint linked to prior fraudulent applications.' : 'Device fingerprint clean; no fraud-device linkage.' },
      { layer: 'IP Intelligence', status: a.ipSuspicious ? 'watch' : 'pass', note: a.ipSuspicious ? 'Application submitted from a suspicious geography / anonymised network.' : 'IP geography consistent with the declared address.' },
      { layer: 'Metadata Analysis', status: a.documentsAuthentic ? 'pass' : 'fail', note: a.documentsAuthentic ? 'File metadata consistent — no manipulation traces.' : 'File metadata indicates manipulation.' },
      { layer: 'Blockchain Audit Trail', status: 'enforced', note: 'Decision sealed into the hash-chained audit trail — cannot be altered secretly.' },
      { layer: 'Immutable Logs', status: 'enforced', note: 'Every action recorded in the append-only audit log.' },
    ],
  };
}

function seed(str) {
  let s = 0;
  for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) % 2147483647;
  return () => { s = (s * 1103515245 + 12345) % 2147483647; return s / 2147483647; };
}
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const r2 = (n) => Math.round(n);

// Dimension weights (sum to 1.0) — security & fraud dominate.
const WEIGHTS = { security: 0.22, fraud: 0.18, identity: 0.16, overstay: 0.16, financial: 0.12, intent: 0.08, behaviour: 0.08 };

// Assess a visa application. `app` carries declared facts + verification signals
// (booleans the demo UI toggles; in production these come from the agents' own
// upstream services).
export function assessVisa(app = {}) {
  const a = normalise(app);
  const rnd = seed(`${a.name}|${a.nationality}|${a.destination}|${a.purpose}`);

  // --- Seven risk dimensions (0 = safe, 100 = maximum risk) ---
  const base = () => 8 + rnd() * 14; // low baseline noise

  const identity = clamp(base() + (a.footprintMatches ? 0 : 38) + (a.onWatchlist ? 55 : 0) + (a.identityDuplicate ? 40 : 0) + (a.livenessFailed ? 35 : 0), 0, 100);
  const fraud = clamp(base() + (a.documentsAuthentic ? 0 : 55) + (a.footprintMatches ? 0 : 22) + (a.knownFraudNetwork ? 60 : 0) + (a.deviceFraud ? 30 : 0) + (a.ipSuspicious ? 12 : 0), 0, 100);
  const financial = clamp(base() + (a.fundsConsistent ? 0 : 48) + (a.monthlyIncome < 1500 ? 22 : 0) + (a.suddenDeposit ? 30 : 0), 0, 100);
  const overstay = clamp(base() + (a.priorOverstays ? 60 : 0) + (a.homeTies === 'weak' ? 30 : a.homeTies === 'moderate' ? 12 : 0) + overstayCountryBias(a.nationality, rnd) + (a.age < 25 ? 12 : 0), 0, 100);
  const behaviour = clamp(base() + a.behaviourHesitation * 0.6 + (a.contradictions ? 25 : 0), 0, 100);
  const security = clamp((a.onWatchlist ? 92 : base()) + (a.sanctioned ? 8 : 0), 0, 100);
  const intent = clamp(base() + (a.purposeCredible ? 0 : 35) + (a.declaredVsHistoryMismatch ? 25 : 0), 0, 100);

  const dims = { fraud: r2(fraud), identity: r2(identity), financial: r2(financial), overstay: r2(overstay), behaviour: r2(behaviour), security: r2(security), intent: r2(intent) };

  const weighted = Object.entries(WEIGHTS).reduce((s, [k, w]) => s + dims[k] * w, 0);
  const totalScore = clamp(r2(weighted * 10), 0, 1000); // 0–1000

  const band = totalScore <= 200 ? 'Safe' : totalScore <= 450 ? 'Review' : totalScore <= 700 ? 'High Risk' : 'Reject';
  const decision = totalScore <= 200 ? 'Auto Approval'
    : totalScore <= 450 ? 'Conditional Approval'
      : totalScore <= 700 ? 'Human Review'
        : 'Auto Rejection';
  const confidence = clamp(r2(100 - Math.abs(totalScore - bandCentre(band)) / 5), 60, 99);

  const conditions = decision === 'Conditional Approval'
    ? ['Refundable security deposit', 'Mandatory travel insurance', 'Proof of return ticket']
    : [];

  return {
    applicant: { name: a.name, nationality: a.nationality, destination: a.destination, purpose: a.purpose },
    agents: agentFindings(a, dims),
    risk: dims,
    totalScore,
    band,
    decision,
    confidence,
    decisionConfidenceScore: confidence, // the Decision Agent's headline output
    conditions,
    zeroTrust: zeroTrustStatus(a),
    slaMinutes: decision === 'Human Review' ? 'escalated' : 5,
  };
}

function bandCentre(b) { return b === 'Safe' ? 100 : b === 'Review' ? 325 : b === 'High Risk' ? 575 : 850; }

function overstayCountryBias(nat, rnd) {
  // Deterministic small bias by nationality (illustrative only).
  const hi = ['NG', 'PK', 'BD', 'AF']; const lo = ['GB', 'US', 'CA', 'AU', 'DE', 'FR'];
  if (lo.includes(nat)) return 0;
  if (hi.includes(nat)) return 18 + rnd() * 10;
  return 8 + rnd() * 8;
}

function agentFindings(a, dims) {
  const withChecks = (row) => (AGENT_CHECKS[row.agent] ? { ...row, checksRun: AGENT_CHECKS[row.agent] } : row);
  return [
    { agent: 'Document Forensics', status: statusFor(dims.fraud), finding: a.documentsAuthentic ? 'No manipulation, metadata or stamp anomalies detected.' : 'Metadata tampering + forged stamp signature detected.' },
    { agent: 'Financial Authenticity', status: statusFor(dims.financial), finding: a.fundsConsistent ? 'Bank statements consistent with declared income.' : 'Sudden balance inflation inconsistent with salary history.' },
    { agent: 'Identity Verification', status: statusFor(dims.identity), finding: a.onWatchlist ? 'Identity matches a sanctions/watchlist entry.' : 'Passport authentic; face match + liveness passed.' },
    { agent: 'Online Footprint Intelligence', status: statusFor(a.footprintMatches ? 15 : 70), finding: a.footprintMatches ? `Declared role at ${a.employer || 'employer'} corroborated by public footprint.` : `No professional footprint found for declared role at ${a.employer || 'employer'}.` },
    { agent: 'Behavioural Intelligence', status: statusFor(dims.behaviour), finding: a.behaviourHesitation > 50 ? 'High hesitation + corrections around employment history.' : 'Natural form-completion behaviour; no deception markers.' },
    { agent: 'Overstay Risk', status: statusFor(dims.overstay), finding: a.priorOverstays ? 'Prior visa overstay on record.' : `Return probability favourable (home ties: ${a.homeTies}).` },
    { agent: 'Fraud Detection', status: statusFor(dims.fraud), finding: a.knownFraudNetwork ? 'Linked to a known organised fraud cluster.' : 'No fraud-ring or synthetic-identity linkage.' },
    { agent: 'Intent Assessment', status: statusFor(dims.intent), finding: a.purposeCredible ? `Declared purpose (${a.purpose}) is credible and consistent.` : `Declared purpose (${a.purpose}) not supported by the application story.` },
    { agent: 'Border Risk', status: statusFor(dims.security), finding: a.onWatchlist || a.sanctioned ? 'Security database hit — escalate.' : 'Clear of criminal, terrorism and trafficking databases.' },
    { agent: 'Decision Agent', status: 'info', finding: 'Aggregated all signals into the unified risk score below.' },
  ].map(withChecks);
}
function statusFor(risk) { return risk >= 60 ? 'fail' : risk >= 35 ? 'watch' : 'pass'; }

function normalise(app) {
  const destObj = findDestination(app.destination || '') || (DESTINATIONS[app.destination] && { code: app.destination, ...DESTINATIONS[app.destination] });
  return {
    name: (app.name || 'Applicant').slice(0, 80),
    nationality: (app.nationality || 'GB').toUpperCase(),
    destination: destObj ? destObj.city : (app.destination || 'Dubai'),
    destCode: destObj ? destObj.code : null,
    age: Number(app.age) || 32,
    employer: app.employer || '',
    monthlyIncome: Number(app.monthlyIncome) || 2500,
    purpose: app.purpose || 'tourism',
    behaviourHesitation: clamp(Number(app.behaviourHesitation) || 10, 0, 100),
    // verification signals (default to the trustworthy path)
    documentsAuthentic: app.documentsAuthentic !== false,
    fundsConsistent: app.fundsConsistent !== false,
    footprintMatches: app.footprintMatches !== false,
    purposeCredible: app.purposeCredible !== false,
    priorOverstays: !!app.priorOverstays,
    onWatchlist: !!app.onWatchlist,
    sanctioned: !!app.sanctioned,
    knownFraudNetwork: !!app.knownFraudNetwork,
    identityDuplicate: !!app.identityDuplicate,
    livenessFailed: !!app.livenessFailed,
    deviceFraud: !!app.deviceFraud,
    ipSuspicious: !!app.ipSuspicious,
    suddenDeposit: !!app.suddenDeposit,
    contradictions: !!app.contradictions,
    declaredVsHistoryMismatch: !!app.declaredVsHistoryMismatch,
    homeTies: ['strong', 'moderate', 'weak'].includes(app.homeTies) ? app.homeTies : 'strong',
  };
}

// Pre-booking integration: approval probability for a nationality+destination,
// so the travel planner can show "Visa approval probability: X%" before booking.
export function approvalProbability(nationality, destinationText) {
  const dest = resolveDestination(destinationText);
  if (!dest) return { ok: false, error: 'unknown-destination' };
  const rule = visaRule(dest, (nationality || 'GB').toUpperCase());
  const rnd = seed(`prob-${nationality}-${dest.code}`);
  let p = rule.required ? 80 + rnd() * 14 : 96 + rnd() * 3; // visa-free ~ very high
  if ((nationality || 'GB').toUpperCase() === 'NG' && rule.required) p -= 10; // illustrative
  return {
    ok: true,
    destination: dest.city,
    nationality: (nationality || 'GB').toUpperCase(),
    visaRequired: rule.required,
    approvalProbability: clamp(r2(p), 0, 99),
    typicalDecisionMinutes: 5,
  };
}
