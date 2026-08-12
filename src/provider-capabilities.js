// provider-capabilities.js — Phase 1 of the BYOH de-ollama migration.
// Plan: vault/design/byoh-deollama-core-logic-plan.md
//
// The string 'ollama' is used across core logic as a proxy for a bundle of
// capabilities (local, zero-cost, GPU-slot-limited, never rate-limited,
// opaque GGUF model id). This module makes that bundle EXPLICIT: a resolver
// that answers "what are this agent's provider capabilities?" from
//   agent overrides  >  descriptor capability fields  >  legacy defaults
// where the legacy defaults reproduce today's name-keyed behavior exactly,
// so day-one behavior is identical by construction.
//
// PHASE 1 CONTRACT: nothing in core logic reads this module yet. Phase 2
// migrates the name-check sites onto it one at a time, behind the
// characterization suite (src/provider-capability-characterization.test.js).
//
// Numbers that are ENFORCED from config (concurrency caps, timeouts,
// complexity gate) are read from config AT CALL TIME rather than copied
// here — the resolver must never drift from the values production enforces.

import config from './config.js';
import { getDescriptor } from './harnesses/registry.js';
import { PROVIDER_COST_TIER } from './tasks.js';

export const COMPLEXITY_LEVELS = Object.freeze(['low', 'medium', 'high']);

// Static legacy facts the 'ollama' name-checks encode today. Everything not
// listed here falls back to CLOUD_DEFAULTS — the same treatment core logic
// gives an unknown provider name today.
const LEGACY_STATIC = Object.freeze({
  ollama: Object.freeze({ locality: 'local', cost: 0, rateLimited: false, opaqueModelId: true }),
  // llama/llamacpp/local ride the same local treatment via
  // config.pace.localProviders — the one place this was already
  // capability-shaped (the plan calls it "the good pattern").
  llama: Object.freeze({ locality: 'local', cost: 0, rateLimited: false, opaqueModelId: true }),
  llamacpp: Object.freeze({ locality: 'local', cost: 0, rateLimited: false, opaqueModelId: true }),
  local: Object.freeze({ locality: 'local', cost: 0, rateLimited: false, opaqueModelId: true }),
  claude: Object.freeze({ locality: 'cloud', cost: 2, rateLimited: true, opaqueModelId: false }),
  codex: Object.freeze({ locality: 'cloud', cost: 1, rateLimited: true, opaqueModelId: false }),
  gemini: Object.freeze({ locality: 'cloud', cost: 1, rateLimited: true, opaqueModelId: false }),
  glm: Object.freeze({ locality: 'cloud', cost: 1, rateLimited: true, opaqueModelId: false }),
});

const CLOUD_DEFAULTS = Object.freeze({ locality: 'cloud', cost: 1, rateLimited: true, opaqueModelId: false });

// The new descriptor capability fields Phase 1 introduces. Only these are
// lifted from descriptor.capabilities — the pre-existing harness-mechanics
// fields (execution, streaming, tokenReporting, …) are a different axis.
const DESCRIPTOR_CAPABILITY_FIELDS = Object.freeze([
  'locality', 'cost', 'rateLimited', 'concurrency', 'maxComplexity', 'defaultTimeoutMs', 'opaqueModelId',
]);

function legacyStaticFor(provider) {
  if (Object.prototype.hasOwnProperty.call(LEGACY_STATIC, provider)) return LEGACY_STATIC[provider];
  // config.pace.localProviders is operator-extendable — honor it the way
  // pace accounting already does.
  if (config.pace?.localProviders?.has?.(provider)) return LEGACY_STATIC.ollama;
  return CLOUD_DEFAULTS;
}

/**
 * Resolve the capability bundle for an agent (or bare provider id).
 *
 * @param {Object|string} agentOrProvider - agent-like object ({provider,
 *   timeout?, maxConcurrent?, maxComplexity?}) or a provider id string
 * @returns {{provider: string, locality: 'local'|'cloud', cost: number,
 *   rateLimited: boolean, concurrency: number|null,
 *   maxComplexity: 'low'|'medium'|'high', defaultTimeoutMs: number,
 *   opaqueModelId: boolean}}
 */
export function capabilitiesFor(agentOrProvider) {
  const agent = typeof agentOrProvider === 'string' ? { provider: agentOrProvider } : (agentOrProvider || {});
  const provider = agent.provider || 'unknown';

  const legacy = legacyStaticFor(provider);
  const caps = {
    provider,
    ...legacy,
    // Enforced-config values, read live (see header). NOTE the ?? — a cap of
    // 0 must pass through as 0, preserving the falsy-zero behavior the
    // characterization suite pins (a 0 cap currently DISABLES the cap at the
    // sandbox; whether to fix that is a deliberate Phase 2 decision, not a
    // side effect of this resolver).
    concurrency: config.sandbox?.maxPerProvider?.[provider] ?? null, // null ⇒ unlimited (today's behavior for everything but ollama)
    maxComplexity: config.tasks?.complexityGate?.[provider] ?? 'high',
    defaultTimeoutMs: config.agents?.timeouts?.[provider] ?? config.agents?.timeouts?.claude ?? 900000,
  };

  // Descriptor capability fields override legacy defaults (a descriptor that
  // declares locality/cost/… is the BYOH acceptance path: new local harness
  // = descriptor, not core edits).
  const descriptor = getDescriptor(provider);
  if (descriptor?.capabilities) {
    for (const f of DESCRIPTOR_CAPABILITY_FIELDS) {
      if (descriptor.capabilities[f] !== undefined) caps[f] = descriptor.capabilities[f];
    }
  }

  // Agent-level overrides win over everything (operator intent).
  if (agent.maxConcurrent !== undefined) caps.concurrency = agent.maxConcurrent;
  if (agent.maxComplexity !== undefined && COMPLEXITY_LEVELS.includes(agent.maxComplexity)) caps.maxComplexity = agent.maxComplexity;
  if (agent.timeout !== undefined && Number.isFinite(agent.timeout)) caps.defaultTimeoutMs = agent.timeout;

  return caps;
}

/** locality === 'local' — the routing/budget discriminator Phase 2 migrates to. */
export function isLocal(agentOrProvider) {
  return capabilitiesFor(agentOrProvider).locality === 'local';
}

/** rateLimited === false ⇒ fallback-eligible, "always available". */
export function isRateLimited(agentOrProvider) {
  return capabilitiesFor(agentOrProvider).rateLimited === true;
}

/**
 * Backend concurrency-pool key (de-ollama Phase 2.3, #103). Providers are
 * names; the GPU is a backend. All local-capability agents share the
 * 'local-gpu' pool by DEFAULT — deliberately as tight as the legacy ollama
 * cap, never looser (two llama.cpp ports on one box must not double the
 * effective cap). Operators with genuinely separate backends opt in by
 * setting agent.backend (paired with a config.sandbox.maxPerBackend entry).
 * Cloud agents return null: no backend pooling, provider caps still apply.
 *
 * @param {Object|string} agentOrProvider
 * @returns {string|null}
 */
export function backendKeyFor(agentOrProvider) {
  const agent = typeof agentOrProvider === 'string' ? { provider: agentOrProvider } : (agentOrProvider || {});
  if (typeof agent.backend === 'string' && agent.backend.trim()) return agent.backend.trim();
  // GGUF model id ⇒ local inference regardless of provider name. This is the
  // signal that catches BYOH harnesses (pi/omp/opencode) pointed at a local
  // llama.cpp server — their PROVIDER id defaults to cloud treatment, but 4
  // of them stacking on one GPU was the original incident (2026-08-01).
  // Heuristic errs toward CAPPING (safe); billing stays provider-keyed.
  if (typeof agent.model === 'string' && /\.gguf/i.test(agent.model)) return 'local-gpu';
  return isLocal(agent) ? 'local-gpu' : null;
}

/**
 * "Runs local inference" — the unified signal for GPU capping AND local-first
 * routing (de-ollama Phase 2.4, #103). True when the agent maps to a backend
 * pool (explicit agent.backend, GGUF model id, or local-capability provider).
 * Using ONE signal for both keeps the invariants aligned: whatever is capped
 * as local is preferred as local, and vice versa.
 */
export function isLocalInference(agentOrProvider) {
  return backendKeyFor(agentOrProvider) !== null;
}

/**
 * Cost tier, mirroring tasks.js PROVIDER_COST_TIER exactly (the ladder the
 * cheapest-first router sorts by). Unknown providers get tier 1, same as
 * getAgentCostTier's fallback.
 */
export function costTier(agentOrProvider) {
  const caps = capabilitiesFor(agentOrProvider);
  if (Object.prototype.hasOwnProperty.call(PROVIDER_COST_TIER, caps.provider)) {
    return PROVIDER_COST_TIER[caps.provider];
  }
  return caps.locality === 'local' ? 0 : 1;
}
