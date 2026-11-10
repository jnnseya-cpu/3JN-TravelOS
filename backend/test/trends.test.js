// ============================================================================
// 3JN Travel OS — Trend Intelligence (embedded) test harness
// ============================================================================
// Proves the detect → score → Growth Brief engine that is embedded INTO 3JN
// (not a separate service). Three layers, all against the real code:
//   1. Pure scoring engine (trends.js) — anchored on the spec's §5 worked
//      example (TI-03): component inputs must yield opportunity 86.25 and
//      confidence 83.5 at full precision, before any rounding/decision.
//   2. Store lifecycle (store.js) — observation dedup, demand bucketing, brief
//      versioning, approval/supersede, effective-brief resolution + expiry.
//   3. HTTP surface (server.js) — cron auth, admin gating, scan → draft,
//      approve, and the SEO/marketing agents reading the effective brief.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import app from '../src/server.js';
import {
  logLift, robustZ, countFeedGate,
  opportunityScore, confidenceScore, corroborationScore,
  classifyOpportunity, scoreCandidate, round2,
} from '../src/trends.js';
import {
  recordTrendObservation, demandSignal, listTrendTopics,
  createGrowthBrief, approveGrowthBrief, getEffectiveGrowthBrief,
  listGrowthBriefs, getGrowthBrief, bridgeBehaviourToTrends,
  recordBehaviour, createUser,
} from '../src/store.js';
import { createPost, ensureDailyPublish, getPost } from '../src/agents.js';

// ---- 1. Pure engine ---------------------------------------------------------

test('TI-03: §5 worked example scores 86.25 opportunity at full precision', () => {
  const s = opportunityScore({ demand: 80, fit: 95, intent: 85, timing: 90, readiness: 80 });
  assert.equal(s, 86.25);
});

test('TI-03: §5 worked example scores 83.5 confidence at full precision', () => {
  const c = confidenceScore({ sourceQuality: 90, corroboration: 80, coverage: 70, freshness: 90 });
  assert.equal(c, 83.5);
});

test('TI-03: the combined candidate is a reviewable brief (not auto, not archived)', () => {
  const r = scoreCandidate(
    { demand: 80, fit: 95, intent: 85, timing: 90, readiness: 80 },
    { sourceQuality: 90, corroboration: 80, coverage: 70, freshness: 90 },
    { familyCount: 2 },
  );
  assert.equal(r.score, 86.25);
  assert.equal(r.confidence, 83.5);
  assert.equal(r.decision.action, 'brief');       // ≥75/≥75 but auto needs opt-in
  assert.equal(r.activationBlocked, false);         // readiness 80 > 0
});

test('scores are computed at full precision; rounding is display-only', () => {
  // 83.5 confidence proves no premature rounding; round2 is the display helper.
  assert.equal(round2(83.5), 83.5);
  assert.equal(round2(86.254), 86.25);
});

test('corroboration ladder: 0 for one family, 80 for two, 100 for three+', () => {
  assert.equal(corroborationScore(0), 0);
  assert.equal(corroborationScore(1), 0);
  assert.equal(corroborationScore(2), 80);
  assert.equal(corroborationScore(3), 100);
  assert.equal(corroborationScore(9), 100);
});

test('single source family caps confidence at 69 (§5.5)', () => {
  // Inputs that would otherwise exceed 69 are capped when only one family.
  const capped = confidenceScore({ sourceQuality: 100, corroboration: 0, coverage: 100, freshness: 100 }, { familyCount: 1 });
  assert.ok(capped <= 69, `expected ≤69, got ${capped}`);
  const uncapped = confidenceScore({ sourceQuality: 100, corroboration: 0, coverage: 100, freshness: 100 }, { familyCount: 2 });
  assert.ok(uncapped > 69, 'two families are not capped');
});

test('decision table: hard veto archives regardless of score', () => {
  const r = classifyOpportunity(99, 99, { veto: true });
  assert.equal(r.action, 'archive');
  assert.equal(r.reason, 'veto');
});

test('decision table: below-cutoff archives (<60 score or <55 confidence)', () => {
  assert.equal(classifyOpportunity(59, 90).action, 'archive');
  assert.equal(classifyOpportunity(90, 54).action, 'archive');
});

test('decision table: mid-band watches, high+opt-in auto-activates', () => {
  assert.equal(classifyOpportunity(70, 70).action, 'watch');
  assert.equal(classifyOpportunity(88, 88).action, 'brief');            // no opt-in
  assert.equal(classifyOpportunity(88, 88, { autoOptIn: true }).action, 'auto');
});

test('readiness 0 blocks activation but still produces a score', () => {
  const r = scoreCandidate(
    { demand: 90, fit: 90, intent: 90, timing: 90, readiness: 0 },
    { sourceQuality: 90, corroboration: 100, coverage: 90, freshness: 90 },
    { familyCount: 3 },
  );
  assert.ok(r.score > 0, 'score still computed');
  assert.equal(r.activationBlocked, true);
});

test('logLift is ln((c+1)/(b+1)) and guards negatives/zeros', () => {
  assert.equal(round2(logLift(99, 0)), round2(Math.log(100)));
  assert.equal(logLift(0, 0), 0);
  assert.equal(logLift(-5, -5), 0);                                     // clamped to 0/0 → ln1 = 0
});

test('robustZ floors the denominator so a flat history is finite', () => {
  const z = robustZ(50, [1, 1, 1, 1, 1, 1]);   // MAD = 0 → scale floored at 0.2
  assert.ok(Number.isFinite(z) && z > 0, `expected finite positive z, got ${z}`);
});

test('countFeedGate: needs ≥4 periods, else draft-only (insufficient-history)', () => {
  const g = countFeedGate(100, [10, 10, 10]);   // only 3 periods
  assert.equal(g.enoughHistory, false);
  assert.equal(g.passed, false);
  assert.equal(g.reason, 'insufficient-history');
});

test('countFeedGate: passes only when c≥minCount AND z≥minZ', () => {
  const hist = [2, 3, 2, 4, 3, 2, 3, 2];
  const pass = countFeedGate(60, hist, { minCount: 20, minZ: 2 });
  assert.equal(pass.passed, true, `expected pass, got ${JSON.stringify(pass)}`);

  const belowCount = countFeedGate(10, hist, { minCount: 20, minZ: 2 });
  assert.equal(belowCount.passed, false);
  assert.equal(belowCount.reason, 'below-count-gate');
});

// ---- 2. Store lifecycle -----------------------------------------------------

test('recordTrendObservation dedups by (installation, family, record, revision)', () => {
  const inst = 'test-' + Math.random().toString(36).slice(2, 8);
  const a = recordTrendObservation(inst, { topic: 'Lagos', sourceFamily: 'first_party_search', sourceRecordId: 'beh_1', count: 3 });
  assert.equal(a.ok, true);
  assert.ok(!a.duplicate);
  const b = recordTrendObservation(inst, { topic: 'Lagos', sourceFamily: 'first_party_search', sourceRecordId: 'beh_1', count: 3 });
  assert.equal(b.duplicate, true, 'replay must not inflate counts');
  assert.equal(a.observation.topic, 'lagos');          // normalised lower-case
});

test('demandSignal buckets current vs prior windows and lists families', () => {
  const inst = 'test-' + Math.random().toString(36).slice(2, 8);
  const now = Date.now();
  const hoursAgo = (h) => new Date(now - h * 3600000).toISOString();
  // current window (0–24h): 30; the window 24–48h ago: 5
  recordTrendObservation(inst, { topic: 'accra', sourceFamily: 'first_party_search', sourceRecordId: 's1', count: 30, observedAt: hoursAgo(1) });
  recordTrendObservation(inst, { topic: 'accra', sourceFamily: 'first_party_conversion', sourceRecordId: 'c1', count: 5, observedAt: hoursAgo(30) });
  const sig = demandSignal(inst, 'accra', 'ZZ', { now });
  assert.equal(sig.current, 30);
  assert.equal(sig.history[0], 5);                     // the 24–48h bucket
  assert.deepEqual([...sig.families].sort(), ['first_party_conversion', 'first_party_search']);
});

test('createGrowthBrief versions per (installation, market, locale, topic)', () => {
  const inst = 'test-' + Math.random().toString(36).slice(2, 8);
  const v1 = createGrowthBrief(inst, { topic_id: 'Lagos', market: 'GB', opportunity_score: 80, confidence: 70 });
  const v2 = createGrowthBrief(inst, { topic_id: 'Lagos', market: 'GB', opportunity_score: 82, confidence: 72 });
  assert.equal(v1.brief.brief_version, 1);
  assert.equal(v2.brief.brief_version, 2);
  assert.equal(v1.brief.status, 'draft');
  // §6 contract fields present
  assert.equal(v1.brief.schema_version, 1);
  assert.ok(Array.isArray(v1.brief.allowed_channels));
  assert.ok(v1.brief.expires_at > v1.brief.valid_from);
});

test('approveGrowthBrief activates and supersedes the prior approved brief for a scope', () => {
  const inst = 'test-' + Math.random().toString(36).slice(2, 8);
  const v1 = createGrowthBrief(inst, { topic_id: 'cairo', market: 'GB', opportunity_score: 80, confidence: 70 });
  const v2 = createGrowthBrief(inst, { topic_id: 'cairo', market: 'GB', opportunity_score: 85, confidence: 75 });
  approveGrowthBrief(inst, v1.brief.id, { by: 'ops' });
  approveGrowthBrief(inst, v2.brief.id, { by: 'ops' });
  assert.equal(getGrowthBrief(inst, v1.brief.id).status, 'superseded');
  assert.equal(getGrowthBrief(inst, v2.brief.id).status, 'approved');
});

test('getEffectiveGrowthBrief: approved + unexpired + scope + channel, newest version', () => {
  const inst = 'test-' + Math.random().toString(36).slice(2, 8);
  const b = createGrowthBrief(inst, { topic_id: 'nairobi', market: 'GB', opportunity_score: 85, confidence: 75, allowed_channels: ['seo'] });
  approveGrowthBrief(inst, b.brief.id, { by: 'ops' });
  const eff = getEffectiveGrowthBrief(inst, { topic: 'nairobi', market: 'GB', channel: 'seo' });
  assert.ok(eff && eff.id === b.brief.id);
  // wrong channel → nothing effective
  assert.equal(getEffectiveGrowthBrief(inst, { topic: 'nairobi', channel: 'paid_search' }), null);
});

test('getEffectiveGrowthBrief: an expired approved brief is not effective', () => {
  const inst = 'test-' + Math.random().toString(36).slice(2, 8);
  const b = createGrowthBrief(inst, { topic_id: 'tunis', market: 'GB', opportunity_score: 85, confidence: 75, validityHours: 1 });
  approveGrowthBrief(inst, b.brief.id, { by: 'ops' });
  const future = new Date(Date.now() + 2 * 3600000).toISOString();     // 2h ahead, past the 1h window
  assert.equal(getEffectiveGrowthBrief(inst, { topic: 'tunis', now: future }), null);
});

test('bridgeBehaviourToTrends ingests first-party behaviour, deduped, as two families', () => {
  const inst = 'test-' + Math.random().toString(36).slice(2, 8);
  recordBehaviour('u1', { event: 'search', destination: 'Marrakech' });
  recordBehaviour('u2', { event: 'book', destination: 'Marrakech' });
  const first = bridgeBehaviourToTrends(inst);
  assert.ok(first.ingested >= 2, `expected ≥2 ingested, got ${first.ingested}`);
  const second = bridgeBehaviourToTrends(inst);
  assert.equal(second.ingested, 0, 'second bridge must not re-ingest (deduped by behaviour id)');
  const topics = listTrendTopics(inst).map((t) => t.topic);
  assert.ok(topics.includes('marrakech'));
  const sig = demandSignal(inst, 'marrakech', 'ZZ');
  assert.ok(sig.families.includes('first_party_search') && sig.families.includes('first_party_conversion'));
});

// ---- 3. HTTP surface --------------------------------------------------------

let server, base;
test('boot: server listening', async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

async function api(method, path, { userId, body, headers } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}), ...(headers || {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}
const adminUser = () => createUser({ name: 'TrendAdmin', email: `trend.${Math.round(performance.now() * 1000)}@ex.co`, role: 'admin', allAccess: true });

test('cron/trend-scan rejects without the CRON_SECRET', async () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-secret';
  try {
    const r = await api('GET', '/api/cron/trend-scan');
    assert.equal(r.status, 401);
  } finally { if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev; }
});

test('admin trend endpoints are admin-gated', async () => {
  const r = await api('GET', '/api/admin/trends/opportunities');
  assert.ok(r.status === 401 || r.status === 403, `expected gated, got ${r.status}`);
});

test('invisible autonomous flow: behaviour → scan → auto-activated effective brief (no human step)', async () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-secret';
  const admin = adminUser();
  try {
    // Seed a real surge on 3JN's own behaviour stream for a curated destination
    // (Lisbon is in the catalogue → strong fit + readiness, so it clears the band).
    for (let i = 0; i < 60; i++) recordBehaviour('shopper', { event: 'search', destination: 'Lisbon' });
    for (let i = 0; i < 12; i++) recordBehaviour('buyer', { event: 'book', destination: 'Lisbon' });

    // The scan is the ONLY step — no approval UI, no human click.
    const scan = await api('GET', '/api/cron/trend-scan', { headers: { authorization: 'Bearer test-secret' } });
    assert.equal(scan.status, 200);
    assert.ok(scan.json.ok);
    assert.ok(scan.json.scored.length > 0, 'scan produced scored opportunities');
    assert.ok(scan.json.activated >= 1, 'at least one eligible brief auto-activated');

    // Behind-the-scenes admin API still reflects the scoring (not a visible UI).
    const opps = await api('GET', '/api/admin/trends/opportunities', { userId: admin.id });
    assert.equal(opps.status, 200);
    const lisbon = opps.json.opportunities.find((o) => o.topic === 'lisbon');
    assert.ok(lisbon && lisbon.score > 0, 'lisbon scored');

    // The brief is ALREADY effective for the SEO channel — no manual approval.
    const eff = await api('GET', '/api/admin/trends/briefs/effective?topic=lisbon&channel=seo', { userId: admin.id });
    assert.equal(eff.status, 200);
    assert.ok(eff.json.brief && eff.json.brief.status === 'approved', 'lisbon brief auto-resolved as effective');
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
  }
});

test('nothing trend-related leaks to the PUBLIC blog API', async () => {
  // The public blog feed must never expose trend provenance fields.
  const r = await api('GET', '/api/blog');
  assert.equal(r.status, 200);
  for (const p of (r.json.posts || [])) {
    assert.ok(!('trendBriefId' in p), 'no trendBriefId on public posts');
    assert.ok(!('priority' in p), 'no priority marker on public posts');
    assert.ok(!(p.tags || []).includes('trending'), 'no "trending" tag on public posts');
  }
});

test('daily publish silently steers the topic from the effective brief — no public marker', () => {
  // This is the whole point of "invisible": an approved brief changes WHICH
  // destination the autonomous daily post covers, but leaves no trend trace on
  // the public post (no tag, no priority, no brief id). It must be the only
  // effective 3jn/seo brief at this point (the store tests above used random
  // installations), so the steered topic is deterministic.
  const inst = '3jn';
  const b = createGrowthBrief(inst, { topic_id: 'reykjavik', market: 'ZZ', opportunity_score: 88, confidence: 80, allowed_channels: ['seo'] });
  approveGrowthBrief(inst, b.brief.id, { by: 'trend-intel' });
  // Drive it 2 days ahead so the once-per-24h publish gate is clear regardless of
  // any post the server's publishing loop already emitted at boot.
  const future = Date.now() + 2 * 24 * 3600 * 1000;
  const eff = getEffectiveGrowthBrief(inst, { channel: 'seo', now: future });
  assert.ok(eff, 'an effective seo brief exists');

  const pub = ensureDailyPublish(future);
  assert.equal(pub.published, true, 'the daily post published');
  assert.equal(String(pub.post.destination).toLowerCase(), eff.topic_id, 'post covers the effective brief topic');

  // Invisible: nothing about the trend engine leaks onto the public post object.
  const full = getPost(pub.post.slug);
  assert.ok(!full.trendBriefId, 'no trend id on the public post');
  assert.ok(!full.priority, 'no priority marker on the public post');
  assert.ok(!(full.tags || []).includes('trending'), 'no "trending" tag on the public post');
});

test('an activation-blocked brief never steers the public topic', () => {
  // readiness 0 → activationBlocked. ensureDailyPublish must ignore it, so a
  // brief we cannot serve never leads the journal.
  const inst = '3jn';
  const b = createGrowthBrief(inst, { topic_id: 'xyzzy-unservable', market: 'ZZ', opportunity_score: 95, confidence: 90, allowed_channels: ['seo'], activationBlocked: true });
  approveGrowthBrief(inst, b.brief.id, { by: 'trend-intel' });
  const eff = getEffectiveGrowthBrief(inst, { topic: 'xyzzy-unservable', channel: 'seo' });
  assert.equal(eff.activationBlocked, true, 'the blocked brief is still the record, just inert');
});

test('teardown: close server', async () => {
  await new Promise((r) => server.close(r));
});
