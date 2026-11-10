// Trend Intelligence — embedded, keyless detection + scoring engine.
//
// This is the core of the Trend Intelligence AI spec (v2.3) embedded INTO 3JN
// (not a separate service). It is deterministic and needs NO new API keys: it
// reads 3JN's own first-party demand signals, scores opportunities with the
// exact §5 formulas, and decides whether a Growth Brief should be created.
//
// Pure functions only — no I/O, no model calls — so every number is testable.
// The §5 worked example (TI-03) is the anchor: inputs below must yield an
// opportunity score of 86.25 and a confidence of 83.5.

// ---- §5.3 per-source movement ------------------------------------------------
const log1p = (n) => Math.log(1 + Math.max(0, Number(n) || 0));

// Log lift of a current comparable count c against a baseline median b.
export function logLift(c, b) {
  return Math.log((Math.max(0, Number(c) || 0) + 1) / (Math.max(0, Number(b) || 0) + 1));
}

function median(arr) {
  const a = arr.map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Median Absolute Deviation.
function mad(arr) {
  const a = arr.map(Number).filter(Number.isFinite);
  if (!a.length) return 0;
  const med = median(a);
  return median(a.map((x) => Math.abs(x - med)));
}

// Robust anomaly score: z = (log1p(c) − median(log1p(x))) /
//   max(1.4826 × MAD(log1p(x)), 0.2).  Floor on the denominator (0.2) stops a
// flat history from producing an infinite z.
export function robustZ(c, history = []) {
  const logs = history.map(log1p);
  const centre = median(logs);
  const scale = Math.max(1.4826 * mad(logs), 0.2);
  return (log1p(c) - centre) / scale;
}

// §5.3 count-feed gate: c >= minCount AND z >= minZ (both adjustable). With
// fewer than 4 comparable periods, history is insufficient → draft-only.
export function countFeedGate(c, history = [], { minCount = 20, minZ = 2 } = {}) {
  const enoughHistory = history.length >= 4;
  const z = robustZ(c, history);
  const lift = logLift(c, median(history));
  return {
    c: Number(c) || 0, z, lift,
    enoughHistory,
    passed: enoughHistory && (Number(c) || 0) >= minCount && z >= minZ,
    reason: !enoughHistory ? 'insufficient-history'
      : (Number(c) || 0) < minCount ? 'below-count-gate'
        : z < minZ ? 'below-z-gate' : 'passed',
  };
}

// ---- §5.4 opportunity score (0–100) -----------------------------------------
// 25% demand · 25% platform fit · 20% commercial intent · 15% timing ·
// 15% readiness.  Missing readiness (0) blocks ACTIVATION but the score is
// still computed. Hard vetoes (out-of-market, unsupported claim, restricted
// topic, no inventory, illegal targeting) block regardless of score.
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number(n) || 0));

export function opportunityScore({ demand = 0, fit = 0, intent = 0, timing = 0, readiness = 0 } = {}) {
  return 0.25 * clamp(demand) + 0.25 * clamp(fit) + 0.20 * clamp(intent)
    + 0.15 * clamp(timing) + 0.15 * clamp(readiness);
}

// ---- §5.5 confidence (0–100), computed INDEPENDENTLY of the opportunity -----
// 35% source quality · 25% independent corroboration · 20% sample/coverage ·
// 20% freshness.  Model certainty is excluded. A single source family is
// capped at 69 (§5.5).
export function corroborationScore(independentFamilyCount) {
  const n = Math.max(0, Math.floor(Number(independentFamilyCount) || 0));
  if (n <= 1) return 0;
  if (n === 2) return 80;
  return 100; // three or more
}

export function confidenceScore({ sourceQuality = 0, corroboration = 0, coverage = 0, freshness = 0 } = {}, { familyCount = null } = {}) {
  const raw = 0.35 * clamp(sourceQuality) + 0.25 * clamp(corroboration)
    + 0.20 * clamp(coverage) + 0.20 * clamp(freshness);
  // Single-source-family cap.
  if (familyCount != null && familyCount <= 1) return Math.min(raw, 69);
  return raw;
}

// ---- §5 decision table -------------------------------------------------------
// Returns the action class for a scored opportunity.
export function classifyOpportunity(score, confidence, { veto = false, autoOptIn = false } = {}) {
  const s = Number(score) || 0, c = Number(confidence) || 0;
  if (veto) return { action: 'archive', reason: 'veto' };
  if (s < 60 || c < 55) return { action: 'archive', reason: 'below-cutoff' };
  if (s >= 85 && c >= 85 && autoOptIn) return { action: 'auto', reason: 'high-confidence-opt-in' };
  if (s >= 75 && c >= 75) return { action: 'brief', reason: 'eligible' };
  return { action: 'watch', reason: 'mid-band' };
}

// Round only for display (§5.4: score at full precision, round only to show).
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Convenience: full scoring of one candidate from its component inputs.
// `readiness: 0` does not veto scoring, but it blocks live activation (§5.4):
// activationBlocked is surfaced so the caller keeps such a brief draft-only.
export function scoreCandidate(components = {}, confidenceInputs = {}, opts = {}) {
  const score = opportunityScore(components);
  const confidence = confidenceScore(confidenceInputs, opts);
  const veto = !!opts.veto;
  const activationBlocked = veto || clamp(components.readiness) === 0;
  const decision = classifyOpportunity(score, confidence, { veto, autoOptIn: !!opts.autoOptIn });
  return {
    score, confidence,
    scoreRounded: round2(score), confidenceRounded: round2(confidence),
    activationBlocked, decision,
  };
}
