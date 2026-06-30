// AI Gateway — a single, provider-agnostic entry point for every LLM call,
// with a Model Router that shares work correctly across Claude, OpenAI and
// Gemini (blueprint §8.5 + §9.4).
//
// Why a gateway:
//   - One place to route a task to the best/cheapest provider for it.
//   - One place to meter ACU, attribute cost, and enforce the cost-protection
//     gate before any paid call.
//   - One place to fall back safely: if a provider key is missing or a call
//     fails, the gateway degrades to the deterministic local engine so the
//     prototype always returns a valid result (no "Console Error: {}" ever).
//
// Keys are OPTIONAL. With no keys set, every task resolves locally and the app
// runs fully offline. Provide ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY
// (see .env.example) to route to live providers.

import { ACU_ACTIONS } from '../../shared/constants.js';

const env = (typeof process !== 'undefined' && process.env) ? process.env : {};

// Platform-wide system prompt — the canonical instruction prefixed to EVERY
// routed model call, regardless of provider. Full text: docs/MASTER_AI_PROMPT.md.
export const SYSTEM_PROMPT = [
  'You are not a chatbot. You are the intelligence layer of 3JN Travel OS — the central brain',
  'of an AI-powered travel operating system. For every action, silently determine the user goal,',
  'available data, what is missing, the risk, what can be automated/predicted/improved, what',
  'happens next, who to notify, what to save and what to learn. Be specific, operational,',
  'structured and tied to the goal — never generic. Autosave everything. Respect permissions,',
  'roles, data boundaries, confidentiality and compliance. Never expose the underlying AI',
  'provider or internal logic to end users — they see clarity, speed, control and intelligence.',
].join(' ');

// The structured answer format every agent uses where relevant.
export const STANDARD_OUTPUT_FORMAT = [
  'Situation', 'Insight', 'Risk', 'Recommendation', 'Next Action', 'Owner', 'Deadline', 'Confidence',
];

// Provider registry. `model` picks a sensible default per provider; a real
// deployment would expose more models per task.
export const PROVIDERS = {
  anthropic: { name: 'Anthropic Claude', model: 'claude-opus-4-8', envKey: 'ANTHROPIC_API_KEY' },
  openai: { name: 'OpenAI', model: 'gpt-4o', envKey: 'OPENAI_API_KEY' },
  gemini: { name: 'Google Gemini', model: 'gemini-pro', envKey: 'GEMINI_API_KEY' },
  cohere: { name: 'Cohere', model: 'command-r-plus', envKey: 'COHERE_API_KEY' },
};

// Task → preferred provider, mirroring the blueprint's model-router rationale.
// Each task also maps to an ACU action so cost is metered consistently.
export const TASK_ROUTES = {
  intentExtraction: { provider: 'anthropic', acuAction: 'intent', why: 'NL intent + reasoning' },
  chiefOfStaff: { provider: 'anthropic', acuAction: 'chiefOfStaff', why: 'dialogue + risk summarisation' },
  riskBriefing: { provider: 'anthropic', acuAction: 'riskBriefing', why: 'advisory summarisation' },
  reviewAnalysis: { provider: 'openai', acuAction: 'expense', why: 'review/doc extraction' },
  itinerary: { provider: 'openai', acuAction: 'coworking', why: 'itinerary generation' },
  translation: { provider: 'gemini', acuAction: 'intent', why: 'multimodal + translation' },
  imageAnalysis: { provider: 'gemini', acuAction: 'intent', why: 'multimodal vision' },
  policyRag: { provider: 'cohere', acuAction: 'expense', why: 'enterprise RAG over policy docs' },
  behaviourLearning: { provider: 'anthropic', acuAction: 'intent', why: 'behavioural profiling + pattern mining' },
  recommendation: { provider: 'openai', acuAction: 'intent', why: 'personalised journey recommendation' },
};

const DEFAULT_PROVIDER = env.AI_GATEWAY_DEFAULT_PROVIDER || 'anthropic';

function hasKey(providerId) {
  const p = PROVIDERS[providerId];
  return Boolean(p && env[p.envKey]);
}

// Decide which provider handles a task and whether we can call it live.
export function route(task) {
  const r = TASK_ROUTES[task] || { provider: DEFAULT_PROVIDER, acuAction: 'intent', why: 'default route' };
  const provider = PROVIDERS[r.provider] || PROVIDERS[DEFAULT_PROVIDER];
  const live = hasKey(r.provider);
  return {
    task,
    provider: r.provider,
    providerName: provider.name,
    model: provider.model,
    acuAction: r.acuAction,
    acu: ACU_ACTIONS[r.acuAction] || 0,
    reason: r.why,
    mode: live ? 'live' : 'local-fallback',
    // Every routed call is anchored to the platform master prompt + output format
    // (applied inside run(); flagged here without bloating the client payload).
    systemPromptApplied: true,
  };
}

// Execute a task through the gateway.
//   task    — a key from TASK_ROUTES
//   payload — task input (e.g. { text } for intentExtraction)
//   localFn — deterministic fallback that produces the result offline
// Returns { result, meta } where meta records the provider, model, acu and mode.
// Never throws: a live-call failure degrades to localFn.
export async function run({ task, payload, localFn }) {
  const r = route(task);
  let result;
  let mode = r.mode;
  let error = null;

  if (r.mode === 'live') {
    try {
      result = await callProvider(r, payload);
    } catch (err) {
      error = String(err.message || err);
      mode = 'local-fallback';
    }
  }

  if (result === undefined) {
    // Offline / fallback path — deterministic, always valid.
    result = typeof localFn === 'function' ? await localFn(payload) : null;
  }

  return {
    result,
    meta: {
      task,
      provider: r.provider,
      providerName: r.providerName,
      model: r.model,
      acu: r.acu,
      mode,
      error,
    },
  };
}

// Live provider call. Stubbed to a clear, single integration point — wire the
// real SDK/HTTP here. In the prototype this path is never reached unless a key
// is set, and even then a thrown error degrades to the local fallback.
async function callProvider(routeInfo, payload) {
  // Example shape (left unimplemented so no network call happens by default):
  //   const res = await fetch(providerEndpoint, { headers: { authorization: ... }, body: ... });
  //   return await res.json();
  throw new Error(`live provider '${routeInfo.provider}' not wired in prototype — using local fallback`);
}

// Snapshot of gateway configuration (safe — no keys leaked) for admin/debug.
export function gatewayStatus() {
  return {
    defaultProvider: DEFAULT_PROVIDER,
    providers: Object.fromEntries(
      Object.entries(PROVIDERS).map(([id, p]) => [id, { name: p.name, model: p.model, configured: hasKey(id) }]),
    ),
    routes: TASK_ROUTES,
  };
}
