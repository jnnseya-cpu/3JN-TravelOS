// AI Gateway — proves the LIVE provider path is real and functioning (not a stub),
// and that every failure mode degrades safely to the deterministic engine. Uses a
// mocked global.fetch so no real network/billed call is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, runText, route, aiConfigured, checkAgentBudget } from '../src/ai-gateway.js';

const KEY = 'ANTHROPIC_API_KEY';
function withKey(v, fn) {
  const prev = process.env[KEY];
  if (v == null) delete process.env[KEY]; else process.env[KEY] = v;
  return (async () => { try { return await fn(); } finally {
    if (prev === undefined) delete process.env[KEY]; else process.env[KEY] = prev;
  } })();
}
function mockFetch(impl) {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); };
  return { calls, restore: () => { global.fetch = orig; } };
}
const anthropicOk = (text) => ({ ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text }] }) });

test('no key → not configured; runText uses the deterministic fallback and makes NO network call', async () => {
  await withKey(null, async () => {
    assert.equal(aiConfigured('chiefOfStaff'), false, 'no key → not live');
    const m = mockFetch(() => { throw new Error('should not be called'); });
    try {
      const out = await runText({ task: 'chiefOfStaff', prompt: 'hi', localFn: () => 'DETERMINISTIC' });
      assert.equal(out.text, 'DETERMINISTIC');
      assert.equal(m.calls.length, 0, 'no provider call without a key');
    } finally { m.restore(); }
  });
});

test('with key → LIVE path returns the model text and calls the real Anthropic endpoint correctly', async () => {
  await withKey('sk-ant-test', async () => {
    assert.equal(aiConfigured('chiefOfStaff'), true, 'key present → live');
    const m = mockFetch(() => anthropicOk('Hello from the model.'));
    try {
      const out = await runText({ task: 'chiefOfStaff', prompt: 'greet the traveller', localFn: () => 'DETERMINISTIC' });
      assert.equal(out.text, 'Hello from the model.', 'returns the model text, not the fallback');
      assert.equal(out.meta.mode, 'live');
      assert.equal(m.calls.length, 1, 'exactly one provider call');
      const { url, opts } = m.calls[0];
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(opts.method, 'POST');
      assert.equal(opts.headers['x-api-key'], 'sk-ant-test', 'auth header carries the key');
      assert.ok(opts.headers['anthropic-version'], 'sends the API version header');
      const body = JSON.parse(opts.body);
      assert.ok(body.system && body.system.length > 20, 'platform system prompt is sent');
      assert.equal(body.messages[0].content, 'greet the traveller', 'user prompt is sent');
      assert.ok(body.max_tokens > 0, 'a token cap is sent');
    } finally { m.restore(); }
  });
});

test('provider HTTP error → degrades to the deterministic fallback (never throws)', async () => {
  await withKey('sk-ant-test', async () => {
    const m = mockFetch(() => ({ ok: false, status: 503, text: async () => 'overloaded' }));
    try {
      const out = await runText({ task: 'chiefOfStaff', prompt: 'x', localFn: () => 'FALLBACK' });
      assert.equal(out.text, 'FALLBACK');
      assert.equal(out.meta.mode, 'local-fallback');
    } finally { m.restore(); }
  });
});

test('empty / malformed model reply → validation rejects it → deterministic fallback', async () => {
  await withKey('sk-ant-test', async () => {
    const m = mockFetch(() => anthropicOk('   ')); // whitespace only → invalid
    try {
      const out = await run({ task: 'chiefOfStaff', payload: { prompt: 'x' }, localFn: () => 'SAFE' });
      assert.equal(out.result, 'SAFE');
      assert.equal(out.meta.mode, 'local-fallback');
    } finally { m.restore(); }
  });
});

test('agent budget guard: over-budget stops execution and requests approval (no call)', async () => {
  await withKey('sk-ant-test', async () => {
    const m = mockFetch(() => anthropicOk('nope'));
    try {
      // chiefOfStaff budget is 20 ACU; claim it is already spent this session.
      const out = await run({ task: 'chiefOfStaff', payload: { prompt: 'x' }, localFn: () => 'X', spentThisSession: 999 });
      assert.equal(out.meta.mode, 'budget-stop');
      assert.equal(m.calls.length, 0, 'no provider call once the budget is exhausted');
      assert.equal(checkAgentBudget('chiefOfStaff', 999).requiresApproval, true);
    } finally { m.restore(); }
  });
});

test('route() reports live vs local-fallback based on key presence', async () => {
  await withKey(null, async () => assert.equal(route('chiefOfStaff').mode, 'local-fallback'));
  await withKey('sk-ant-test', async () => assert.equal(route('chiefOfStaff').mode, 'live'));
});
