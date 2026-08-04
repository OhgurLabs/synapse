// Directed routing — classify messages, select optimal agent(s), dispatch in solo/pair mode.
//
// Replaces the broadcast-to-all conversation loop for 80%+ of messages.
// Feature-flagged via config.router.enabled (SYNAPSE_DIRECTED_ROUTING env).
//
// Message flow:
//   classifyMessage → ROUTING_MATRIX lookup → selectAgent → dispatch{Solo,Pair}
//   Escalation on failure/low-confidence → provider load balancing → periodic audit

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import config from './config.js';
import { createLogger } from './logger.js';
import { PROVIDER_COST_TIER, COST_TIER_LABELS, getAgentCostTier } from './tasks.js';
import { rosterAllowsAgentAnyRole } from './roster.js';
import { isAgentPaused } from './orchestrator/agents.js';
import { STATES } from './orchestrator/circuit-breaker.js';
const log = createLogger('router');

function isProviderCircuitOpen(circuitBreaker, provider) {
  if (!circuitBreaker || !provider) return false;

  if (typeof circuitBreaker.getStateProvider === 'function') {
    return circuitBreaker.getStateProvider(provider) === STATES.OPEN;
  }

  if (typeof circuitBreaker.getState === 'function') {
    return circuitBreaker.getState(provider) === STATES.OPEN;
  }

  if (typeof circuitBreaker.canRequest === 'function') {
    return circuitBreaker.canRequest(provider) === false;
  }

  return false;
}

// --- Reuse existing patterns from orchestrator/tasks ---
const EXECUTION_RE = /\b(implement|execute|build|fix|create|write|refactor|rename|deploy|install|configure|setup|migrate|modify|edit|patch|make|ship)\b/i;
const DISCUSSION_OVERRIDE_RE = /\b(what do you think|thoughts on|discuss|analyze|design|plan|consider|evaluate|opinion|perspective|delegate|assign|prioritize|review|audit|assess|recommend)\b/i;
const PROVIDER_ROUTING = {
  claude: /\b(analyze|write|document|explain|review|design|plan|draft|summarize|assess)\b/i,
  codex:  /\b(implement|code|fix|bug|refactor|test|audit|debug|build|patch|migrate|deploy)\b/i,
  gemini: /\b(research|search|find|compare|explore|investigate|scan|benchmark|survey|implement|code|fix|bug|refactor|test|debug|build)\b/i,
};
const DELEGATION_RE = /(?:^|\n)\s*@(\w+)\s+(implement|execute|build|fix|create|write|refactor|deploy|install|configure|setup|migrate|modify|edit|patch|ship|apply|update)\b/is;

// --- Message classification ---

const DESIGN_RE = /\b(should we|trade-?off|what'?s the best approach|RFC|design decision|architecture decision|which approach|pros and cons)\b/i;
const REVIEW_RE = /\b(review|audit|check|validate|qa|code review|pull request|PR review)\b/i;
const RESEARCH_RE = /\b(research|find out|compare|explore|investigate|look into|what is|how does)\b/i;
const STATUS_RE = /\b(status|where are we|how'?s it going|progress|update me|what'?s the state)\b/i;
const QUESTION_RE = /^(who|what|when|where|why|how|is|are|can|could|would|should|do|does|did)\b/i;
const SIMPLE_RE = /^(ok|okay|thanks|thank you|got it|understood|sure|yep|yes|no|nah|cool|nice|great|good|roger|ack|kk|np)\.?$/i;

/**
 * Classify a message into a routing type.
 * @param {string} text - raw message text (after command stripping)
 * @param {string[]} mentioned - agent IDs from parseMentions
 * @param {Object} agents - agent registry { id: agentInstance }
 * @returns {{ type: string, confidence: number }}
 */
export function classifyMessage(text, mentioned, agents) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Delegation from operator — matches directed execution segments
  if (DELEGATION_RE.test(text)) {
    return { type: 'delegation', confidence: 0.9 };
  }

  // Simple/ack response — short and non-substantive
  if (trimmed.length < 50 && SIMPLE_RE.test(trimmed)) {
    return { type: 'simple_response', confidence: 0.9 };
  }

  // Status check
  if (STATUS_RE.test(lower)) {
    return { type: 'status_check', confidence: 0.85 };
  }

  // Design decision — high-level architectural question → pair (architect + reviewer)
  if (DESIGN_RE.test(lower)) {
    return { type: 'design_decision', confidence: 0.8 };
  }

  // Review request
  if (REVIEW_RE.test(lower) && !EXECUTION_RE.test(lower)) {
    return { type: 'review_request', confidence: 0.8 };
  }

  // Research task
  if (RESEARCH_RE.test(lower) && !EXECUTION_RE.test(lower)) {
    return { type: 'research', confidence: 0.75 };
  }

  // Implementation task (execution keywords without discussion override)
  if (EXECUTION_RE.test(lower) && !DISCUSSION_OVERRIDE_RE.test(lower)) {
    return { type: 'implementation', confidence: 0.75 };
  }

  // Question — ends with ? or starts with interrogative
  if (trimmed.endsWith('?') || QUESTION_RE.test(trimmed)) {
    return { type: 'question', confidence: 0.7 };
  }

  // Fallback: treat as question (safe default — solo dispatch)
  return { type: 'question', confidence: 0.5 };
}

// --- Complexity estimation (Local-First Routing) ---
// Maps classification type → complexity level. Used to decide whether to prefer
// local (ollama) agents over cloud agents for cost/latency savings.

const COMPLEXITY_MAP = {
  simple_response:  'low',
  status_check:     'low',
  question:         'medium',
  research:         'medium',
  review_request:   'medium',
  implementation:   'high',
  design_decision:  'high',
  delegation:       'high',
};

/**
 * Estimate message complexity from classification + text heuristics.
 * @param {{ type: string, confidence: number }} classification
 * @param {string} text
 * @returns {'low'|'medium'|'high'}
 */
export function estimateComplexity(classification, text) {
  const base = COMPLEXITY_MAP[classification.type] || 'medium';

  // Short messages that classified as medium → downgrade to low
  if (base === 'medium' && text.length < 80 && !text.includes('```')) return 'low';

  // Long/multi-paragraph messages with code → upgrade to high
  if (base === 'medium' && (text.length > 500 || (text.match(/```/g) || []).length >= 2)) return 'high';

  return base;
}

// --- Rate limit tracking (persistent) ---
// Per-provider rolling windows. Tracks dispatches to subscription providers.
// Persisted to JSONL so counts survive restarts.

let dispatchLogPath = null;
const dispatches = []; // [{ provider, ts }, ...] sorted by ts

/**
 * Initialize persistent dispatch log. Call once at startup with the state dir.
 * @param {string} stateDir - e.g. .synapse/projects/
 */
export function initDispatchLog(stateDir) {
  if (!stateDir) return;
  mkdirSync(stateDir, { recursive: true });
  dispatchLogPath = join(stateDir, '_dispatch-log.jsonl');
  // Load existing entries, prune old ones
  if (existsSync(dispatchLogPath)) {
    try {
      const maxWindowMs = Math.max(...Object.values(config.router.rateWindows || {})
        .filter(Boolean).map(w => w.windowMs));
      const cutoff = Date.now() - (maxWindowMs || 86400000);
      const lines = readFileSync(dispatchLogPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.ts >= cutoff) dispatches.push(entry);
        } catch { /* skip malformed lines */ }
      }
      // Rewrite pruned file
      const pruned = dispatches.map(e => JSON.stringify(e)).join('\n') + (dispatches.length ? '\n' : '');
      writeFileSync(dispatchLogPath, pruned);
      log.info('Dispatch log loaded', { entries: dispatches.length, pruned: lines.length - dispatches.length });
    } catch (err) {
      log.warn('Failed to load dispatch log', { error: err.message });
    }
  }
}

function recordCloudDispatch(provider) {
  const entry = { provider, ts: Date.now() };
  dispatches.push(entry);
  if (dispatchLogPath) {
    try { appendFileSync(dispatchLogPath, JSON.stringify(entry) + '\n'); } catch { /* best-effort */ }
  }
}

function pruneDispatches(windowMs) {
  const cutoff = Date.now() - windowMs;
  while (dispatches.length > 0 && dispatches[0].ts < cutoff) dispatches.shift();
}

function countInWindow(provider, windowMs) {
  const cutoff = Date.now() - windowMs;
  let count = 0;
  for (let i = dispatches.length - 1; i >= 0; i--) {
    if (dispatches[i].ts < cutoff) break;
    if (dispatches[i].provider === provider) count++;
  }
  return count;
}

/**
 * Get rate limit status per provider.
 * @returns {{ providers: Object }}
 */
export function getCloudBudgetStatus() {
  const windows = config.router.rateWindows || {};
  // Prune entries older than the longest window
  const maxWindowMs = Math.max(...Object.values(windows).filter(Boolean).map(w => w.windowMs), 86400000);
  pruneDispatches(maxWindowMs);

  const providers = {};
  for (const [name, win] of Object.entries(windows)) {
    if (!win) {
      // Unlimited provider (ollama)
      providers[name] = { used: 0, max: 0, remaining: 0, windowMs: 0, windowLabel: 'unlimited', costTier: COST_TIER_LABELS[PROVIDER_COST_TIER[name]] || 'free' };
      continue;
    }
    const used = countInWindow(name, win.windowMs);
    providers[name] = {
      used,
      max: win.max,
      remaining: Math.max(0, win.max - used),
      windowMs: win.windowMs,
      windowLabel: win.label,
      costTier: COST_TIER_LABELS[PROVIDER_COST_TIER[name]] || 'unknown',
    };
  }
  // Aggregate totals (excluding ollama)
  const cloud = Object.entries(providers).filter(([n]) => n !== 'ollama');
  const totalUsed = cloud.reduce((s, [, p]) => s + p.used, 0);
  const totalMax = cloud.reduce((s, [, p]) => s + p.max, 0);
  return { used: totalUsed, max: totalMax, remaining: totalMax - totalUsed, providers };
}

function isCloudBudgetLow() {
  const windows = config.router.rateWindows || {};
  for (const [name, win] of Object.entries(windows)) {
    if (!win) continue;
    const used = countInWindow(name, win.windowMs);
    if (used >= win.max * 0.8) return true;
  }
  return false;
}

// --- Routing matrix ---
// Each type maps to a dispatch mode and agent selection spec.
// primary/secondary/escalation are role strings resolved at dispatch time.
// Budget: { maxResponses } controls total agent responses for the dispatch.

export const ROUTING_MATRIX = Object.freeze({
  status_check: {
    mode: 'solo',
    primary: { role: 'ops', provider: 'ollama' },
    secondary: null,
    escalation: { role: 'architect' },
    budget: { maxRounds: 1, maxResponses: 1 },
  },
  question: {
    mode: 'solo',
    primary: { role: 'relevance' },  // by relevance score
    secondary: null,
    escalation: { role: 'architect' },
    budget: { maxRounds: 2, maxResponses: 2 },
  },
  simple_response: {
    mode: 'solo',
    primary: { role: 'ops', provider: 'ollama' },
    secondary: null,
    escalation: null,
    budget: { maxRounds: 1, maxResponses: 1 },
  },
  implementation: {
    // Baker model: architect receives all build directives, decomposes into subtasks.
    // Clarence (best) → Dexter (strongest implementer) → Ollie (free fallback)
    mode: 'solo',
    primary: { role: 'architect' },
    secondary: null,
    escalation: null,
    budget: { maxRounds: 2, maxResponses: 2 },
  },
  review_request: {
    mode: 'pair',
    primary: { role: 'reviewer' },
    secondary: { role: 'reviewer' },
    escalation: { role: 'architect' },
    budget: { maxRounds: 2, maxResponses: 3 },
  },
  research: {
    mode: 'solo',
    primary: { role: 'researcher', provider: 'gemini' },
    secondary: null,
    escalation: { role: 'architect' },
    budget: { maxRounds: 2, maxResponses: 2 },
  },
  design_decision: {
    mode: 'pair',
    primary: { role: 'architect', provider: 'claude' },
    secondary: { role: 'reviewer', provider: 'codex' },
    escalation: { role: 'developer' },
    budget: { maxRounds: 2, maxResponses: 4 },
  },
  // Delegation falls through to existing execution path in orchestrator
  delegation: {
    mode: 'execution',
    primary: null,
    secondary: null,
    escalation: null,
    budget: null,
  },
});

/**
 * Build a minimal selection result with routing metadata.
 * @param {string} selected - selected agent ID
 * @param {string} category - task category
 * @param {string} reason - selection reason
 * @returns {{ selected: string, routing_metadata: Object }}
 */
function makeSelectionResult(selected, category, reason) {
  if (!selected) return null;
  return {
    selected,
    routing_metadata: {
      category: category || null,
      weights: [{ id: selected, successRate: null, weight: 1.0, reason }],
      reason,
      roll: null,
    },
  };
}

function normalizeProviderWeightInput(providerWeights) {
  if (!providerWeights) return null;

  // Structured input with metadata
  if (providerWeights && typeof providerWeights === 'object' && providerWeights.weights) {
    const { weights, status, reason, asOf, asOfMs, staleByMs, source, fallbackUsed, lastGoodAsOf } = providerWeights;
    return {
      weights,
      meta: {
        status: status || null,
        reason: reason || null,
        asOf: asOf ?? asOfMs ?? null,
        staleByMs: staleByMs ?? null,
        source: source || null,
        fallbackUsed: !!fallbackUsed,
        lastGoodAsOf: lastGoodAsOf ?? null,
      },
    };
  }

  // Simple map input
  if (typeof providerWeights === 'object') {
    return {
      weights: providerWeights,
      meta: {
        status: 'provided',
        reason: 'static_override',
        asOf: null,
        staleByMs: null,
        source: 'override',
        fallbackUsed: false,
        lastGoodAsOf: null,
      },
    };
  }

  return null;
}

function applyProviderScaling(candidateStats, baseWeights, providerWeightMap) {
  if (!providerWeightMap || !candidateStats || candidateStats.length === 0) return baseWeights;

  const providerById = new Map(candidateStats.map(s => [s.id, s.provider || null]));

  const scaled = baseWeights.map(w => {
    const provider = providerById.get(w.id) ?? null;
    const hasSignalWeight = provider !== null && Object.prototype.hasOwnProperty.call(providerWeightMap, provider);
    const rawProviderWeight = hasSignalWeight ? providerWeightMap[provider] : 1;
    const providerWeight = (typeof rawProviderWeight === 'number' && rawProviderWeight >= 0)
      ? rawProviderWeight
      : (hasSignalWeight ? 0 : 1);

    const weighted = +(w.weight * providerWeight).toFixed(6);

    return {
      ...w,
      provider,
      providerWeight: hasSignalWeight ? providerWeight : null,
      weight: weighted,
    };
  });

  const total = scaled.reduce((acc, w) => acc + w.weight, 0);
  if (total <= 0) {
    // Fall back to base weights if provider signals zero out all candidates
    return baseWeights.map(w => ({
      ...w,
      provider: providerById.get(w.id) ?? null,
      providerWeight: null,
    }));
  }

  return scaled.map(w => ({
    ...w,
    weight: +(w.weight / total).toFixed(4),
  }));
}

/**
 * Compute cost-based weights using range-based normalization.
 *
 * Given a set of candidates and their costs, returns normalized weights where
 * cheaper agents receive higher weights. The formula is:
 *   costWeight_i = (maxCost - cost_i) / (maxCost - minCost)
 *
 * This produces a linear scale from 0 (most expensive) to 1 (cheapest).
 * Requires all candidates to have valid cost data in costMap.
 *
 * @param {{ id: string }[]} candidateStats - array of candidate objects with id field
 * @param {Object} costMap - map of agentId -> cost; all candidates must be present
 * @returns {number[]} - array of normalized cost weights (same order as candidateStats)
 */
export function computeCostWeights(candidateStats, costMap) {
  if (!candidateStats || candidateStats.length === 0) return [];
  if (!costMap || Object.keys(costMap).length === 0) {
    // No cost data, return uniform weights
    const uniform = 1.0 / candidateStats.length;
    return candidateStats.map(() => uniform);
  }

  // Extract costs (caller should ensure all are valid)
  const costs = candidateStats.map(s => costMap[s.id]);

  const maxCost = Math.max(...costs);
  const minCost = Math.min(...costs);
  const costRange = maxCost - minCost;

  // If all costs are equal, return uniform weights
  if (costRange === 0) {
    const uniform = 1.0 / candidateStats.length;
    return candidateStats.map(() => uniform);
  }

  // Compute range-based weights: higher weight for lower cost
  const costWeights = costs.map(cost => (maxCost - cost) / costRange);

  return costWeights;
}

/**
 * Compute routing weights for a set of candidate stats. Pure function — no
 * random selection, no side-effects, no logging.
 *
 * Rules (evaluated in order):
 *  1. Single candidate → weight 1.0, reason 'single_candidate'
 *  2. Any candidate with successRate === null (< 5 dispatches) → uniform
 *     weights for all, reason 'insufficient_data_fallback' (or 'insufficient_data_cost_aware'
 *     when cost blending is active)
 *  3. All rates identical or within sensitivityThreshold → uniform weights,
 *     reason 'uniform_rates' (or 'uniform_rates_cost_aware' / 'confidence_adjusted_cost_aware'
 *     when cost blending is active)
 *  4. All have data (≥5 dispatches) → delta-proportional weighted selection:
 *     a. Compute delta_i = successRate_i - min(successRates)
 *     b. Raw weight_i = delta_i / sum(deltas)
 *     c. Reserve floorWeight for each candidate (bounded by 1/N)
 *     d. Distribute remaining weight proportionally using raw weights
 *     e. Reason: 'delta_proportional' (detailReason: 'delta_proportional_cost_blended' when
 *        cost blending is active)
 *
 * Delta-proportional approach gives higher performers materially more weight
 * than simple rate normalization. Example: candidates at 0.90 and 0.60 success
 * rates yield ~95% and ~5% weights (with default 0.05 floor), vs 60/40 under
 * linear normalization.
 *
 * Config (optional):
 *  - floorWeight (default 0.05): minimum weight for any candidate (preserves exploration)
 *  - sensitivityThreshold (default 0.001): if max-min rate < threshold, use uniform
 *  - costCoefficient (default 0): blend factor in [0,1]; 0 = quality-only, 1 = cost-only
 *  - costMap (default null): map of agentId -> cost (lower cost = higher weight); missing entries default to 1.0
 *
 * Cost blending (optional):
 *  When config.costCoefficient > 0 and config.costMap is provided, each candidate's final weight is blended:
 *    costWeight_i = (maxCost - cost_i) / (maxCost - minCost)  [range-based normalization, 0=expensive, 1=cheap]
 *    finalWeight_i = (1 - costCoefficient) * performanceWeight_i + costCoefficient * costWeight_i
 *  All candidates must have valid cost data in costMap for blending to occur. If any candidate is missing
 *  or has null/invalid cost, blending is skipped. If all costs are equal, blending is also skipped
 *  (no differentiation possible). When costCoefficient=0 or costMap=null, behavior is identical
 *  to the non-cost path (fully backward compatible).
 *
 * @param {{ id: string, totalDispatches: number, successRate: number|null, provider?: string|null }[]} candidateStats
 * @param {{ floorWeight?: number, sensitivityThreshold?: number, costCoefficient?: number, costMap?: Object }} [config={}]
 * @param {Object|null} [providerWeightMap=null] - optional provider-level weights used to scale agent weights
 * @param {Object|null} [circuitBreaker=null] - optional circuit breaker to exclude OPEN provider candidates
* @returns {{ id: string, successRate: number|null, weight: number, reason: string, provider?: string|null, providerWeight?: number|null }[]}
 */
export function computeRoutingWeights(candidateStats, config = {}, providerWeightMap = null, circuitBreaker = null) {
  const { floorWeight = 0.05, sensitivityThreshold = 0.001, costCoefficient = 0, costMap = null } = config;
  if (!candidateStats || candidateStats.length === 0) return [];

  const filteredStats = circuitBreaker
    ? candidateStats.filter(s => {
        if (!s?.provider) return true;
        const isOpen = isProviderCircuitOpen(circuitBreaker, s.provider);
        console.log(`[DEBUG computeRoutingWeights] Agent ${s.id} provider ${s.provider}: CB ${isOpen ? 'OPEN' : 'CLOSED'}`);
        return !isOpen;
      })
    : candidateStats;

  console.log('[DEBUG computeRoutingWeights] Input stats:', candidateStats.map(s => s.id));
  console.log('[DEBUG computeRoutingWeights] Filtered stats:', filteredStats.map(s => s.id));

  if (filteredStats.length === 0) return [];

  // Pre-compute cost metadata for all candidates
  const hasCostConfig = costCoefficient > 0 && costMap && Object.keys(costMap).length > 0;
  const hasCostMap = costMap && Object.keys(costMap).length > 0;
  const costWeightsArr = hasCostConfig ? computeCostWeights(filteredStats, costMap) : null;

  // Helper to attach cost metadata to a result entry
  const withCostMeta = (entry, idx) => {
    // Always include provider_cost if we have a costMap, even if costCoefficient=0
    const rawCost = hasCostMap ? costMap[entry.id] : undefined;
    const provider_cost = (hasCostMap && rawCost !== undefined && rawCost !== null && rawCost > 0) ? rawCost : null;
    // cost_weight is only computed when costCoefficient > 0
    const cost_weight = hasCostConfig && costWeightsArr ? +costWeightsArr[idx].toFixed(6) : null;
    return {
      ...entry,
      provider_cost,
      cost_weight,
    };
  };

  if (filteredStats.length === 1) {
    const s = filteredStats[0];
    return applyProviderScaling(filteredStats, [withCostMeta({ id: s.id, successRate: s.successRate, weight: 1.0, reason: 'single_candidate' }, 0)], providerWeightMap);
  }

  // Check if any candidate lacks sufficient data
  const hasInsufficientData = filteredStats.some(s => s.successRate === null);

  if (hasInsufficientData) {
    const uniformWeight = +(1 / filteredStats.length).toFixed(4);
    return applyProviderScaling(filteredStats, filteredStats.map((s, i) => withCostMeta({
      id: s.id,
      successRate: s.successRate,
      weight: uniformWeight,
      reason: 'insufficient_data_fallback',
    }, i)), providerWeightMap);
  }

  // All candidates have data at this point. Apply confidence weighting for 5-19 dispatches.
  const adjusted = filteredStats.map(s => {
    const clampedDispatches = Math.max(0, Math.min(20, s.totalDispatches || 0));
    const confidenceFactor = clampedDispatches >= 20 ? 1 : (clampedDispatches / 20);
    return {
      ...s,
      confidenceFactor,
      adjustedRate: (s.successRate ?? 0) * confidenceFactor,
    };
  });

  const rates = adjusted.map(s => s.adjustedRate);
  const minRate = Math.min(...rates);
  const maxRate = Math.max(...rates);
  const lowConfidenceGroup = adjusted.every(s => s.totalDispatches >= 5 && s.totalDispatches < 20);

  // If all rates are identical or very close, use uniform weights
  if (maxRate - minRate < sensitivityThreshold) {
    const uniformWeight = +(1 / filteredStats.length).toFixed(4);
    let uniformWeights = filteredStats.map(() => uniformWeight);
    let costBlendedUniform = false;

    // Apply cost blending for uniform rates case
    if (hasCostConfig) {
      // Extract costs, ensuring all are valid
      const costs = filteredStats.map(s => {
        const cost = costMap[s.id];
        return (cost !== undefined && cost !== null && cost >= 0) ? cost : null;
      });

      // Only blend if ALL costs are valid and they differ
      const allCostsValid = costs.every(c => c !== null);
      if (allCostsValid) {
        const maxCost = Math.max(...costs);
        const minCost = Math.min(...costs);
        const costRange = maxCost - minCost;

        if (costRange > 0) {
          const costWeights = computeCostWeights(filteredStats, costMap);
          const blendedWeights = uniformWeights.map((perfWeight, i) =>
            (1 - costCoefficient) * perfWeight + costCoefficient * costWeights[i]
          );
          const blendedSum = blendedWeights.reduce((acc, w) => acc + w, 0);
          uniformWeights = blendedWeights.map(w => +(w / blendedSum).toFixed(4));
          costBlendedUniform = true;
        }
      }
    }

    const uniformReason = lowConfidenceGroup ? 'confidence_adjusted' : 'uniform_rates';
    return applyProviderScaling(filteredStats, filteredStats.map((s, i) => withCostMeta({
      id: s.id,
      successRate: s.successRate,
      weight: uniformWeights[i],
      reason: costBlendedUniform ? `${uniformReason}_cost_aware` : uniformReason,
      detailReason: lowConfidenceGroup ? 'confidence_adjusted' : null,
    }, i)), providerWeightMap);
  }

  // Compute delta-proportional weights using confidence-adjusted rates
  const deltas = adjusted.map(s => s.adjustedRate - minRate);
  const sumDeltas = deltas.reduce((acc, d) => acc + d, 0);

  // Calculate raw proportional weights based on deltas
  const rawWeights = deltas.map(d => d / sumDeltas);

  // Enforce a minimum floor weight, redistributing proportionally from higher weights
  const count = filteredStats.length;
  const effectiveFloor = Math.min(floorWeight, 1 / count);
  const deficits = rawWeights.map(w => (w < effectiveFloor ? effectiveFloor - w : 0));
  const deficitTotal = deficits.reduce((acc, d) => acc + d, 0);
  const aboveTotal = rawWeights.reduce((acc, w, idx) => (rawWeights[idx] >= effectiveFloor ? acc + w : acc), 0);

  let adjustedWeights = rawWeights.slice();
  if (deficitTotal > 0 && aboveTotal > 0) {
    adjustedWeights = rawWeights.map((w, idx) => {
      if (w < effectiveFloor) return effectiveFloor;
      const reduction = deficitTotal * (w / aboveTotal);
      return w - reduction;
    });
  }

  // Normalize after redistribution and round
  const normSum = adjustedWeights.reduce((acc, w) => acc + w, 0);
  const normalizedWeights = adjustedWeights.map(w => +(w / normSum).toFixed(4));

  // Apply cost blending if costCoefficient > 0 and costMap is provided
  let finalWeights = normalizedWeights;
  let costBlended = false;
  if (hasCostConfig) {
    // Extract costs, ensuring all are valid
    const costs = filteredStats.map(s => {
      const cost = costMap[s.id];
      return (cost !== undefined && cost !== null && cost > 0) ? cost : null;
    });

    // Only blend if ALL costs are valid and they differ
    const allCostsValid = costs.every(c => c !== null);
    if (allCostsValid) {
      const maxCost = Math.max(...costs);
      const minCost = Math.min(...costs);
      const costRange = maxCost - minCost;

      if (costRange > 0) {
        const costWeights = computeCostWeights(filteredStats, costMap);

        // Blend performance and cost weights
        const blendedWeights = normalizedWeights.map((perfWeight, i) =>
          (1 - costCoefficient) * perfWeight + costCoefficient * costWeights[i]
        );

        // Re-normalize blended weights
        const blendedSum = blendedWeights.reduce((acc, w) => acc + w, 0);
        finalWeights = blendedWeights.map(w => +(w / blendedSum).toFixed(4));
        costBlended = true;
      }
    }
  }

  // Return with reasons (overall weighted selection; detailReason tracks delta provenance)
  return applyProviderScaling(filteredStats, filteredStats.map((s, i) => withCostMeta({
    id: s.id,
    successRate: s.successRate,
    weight: finalWeights[i],
    reason: (s.totalDispatches >= 5 && s.totalDispatches < 20) ? 'confidence_adjusted' : 'weighted_selection',
    detailReason: costBlended ? 'delta_proportional_cost_blended' : 'delta_proportional',
  }, i)), providerWeightMap);
}

/**
 * Build cost metadata for routing audit trail.
 * @param {number} costCoefficient - the cost weighting coefficient used
 * @param {Object|null} costMap - map of agentId -> cost
 * @param {Array} candidatesMeta - array of candidate metadata with weights
 * @returns {Object} cost metadata object
 */
function buildCostMetadata(costCoefficient, costMap, candidatesMeta) {
  if (!costCoefficient || costCoefficient <= 0 || !costMap || Object.keys(costMap).length === 0) {
    return {
      coefficient: 0,
      applied: false,
      reason: 'coefficient_zero_or_missing_cost_map',
      costs: null,
    };
  }

  const costs = candidatesMeta.map(c => costMap[c.id]);
  const allCostsValid = costs.every(c => c !== null && c !== undefined);
  
  if (!allCostsValid) {
    return {
      coefficient: costCoefficient,
      applied: false,
      reason: 'missing_cost_data_for_some_candidates',
      costs: costs,
    };
  }

  const maxCost = Math.max(...costs);
  const minCost = Math.min(...costs);
  const costRange = maxCost - minCost;
  
  return {
    coefficient: costCoefficient,
    applied: true,
    reason: 'delta_proportional_cost_blended',
    costs: Object.fromEntries(
      candidatesMeta.map(c => [c.id, costMap[c.id]])
    ),
    minCost,
    maxCost,
    costRange: costRange > 0 ? costRange : null,
  };
}

/**
 * Apply error-pattern penalty factors to computed routing weights.
 * Penalties are applied multiplicatively and stack for agents with multiple penalties.
 * Ensures penalized weights never fall below floorWeight.
 *
 * @param {{ id: string, weight: number }[]} weights - computed weights from computeRoutingWeights()
 * @param {{ agentId: string, penaltyFactor: number, patternId: string, expiresAt: number|null, errorCategory: string|null }[]} penalties - penalty constraints from applyConstraints()
 * @param {number} [floorWeight=0.05] - minimum weight floor
 * @returns {{ id: string, weight: number, penalties_applied?: { patternId: string, penaltyFactor: number, errorCategory: string|null }[], original_weight?: number }[]} adjusted weights with penalty metadata
 */
export function applyPenaltyWeights(weights, penalties, floorWeight = 0.05) {
  if (!penalties || penalties.length === 0) {
    return weights;
  }

  // Group penalties by agentId for efficient lookup
  const penaltiesByAgent = new Map();
  for (const penalty of penalties) {
    if (!penaltiesByAgent.has(penalty.agentId)) {
      penaltiesByAgent.set(penalty.agentId, []);
    }
    penaltiesByAgent.get(penalty.agentId).push(penalty);
  }

  // Apply penalties to matching agents
  const penalizedWeights = weights.map(w => {
    const agentPenalties = penaltiesByAgent.get(w.id);
    if (!agentPenalties || agentPenalties.length === 0) {
      return w; // No penalties for this agent
    }

    // Calculate cumulative penalty (multiplicative stacking)
    let cumulativeFactor = 1.0;
    const appliedPenalties = [];

    for (const penalty of agentPenalties) {
      cumulativeFactor *= penalty.penaltyFactor;
      appliedPenalties.push({
        patternId: penalty.patternId,
        penaltyFactor: penalty.penaltyFactor,
        errorCategory: penalty.errorCategory,
      });
    }

    // Apply penalty and enforce floor
    const originalWeight = w.weight;
    const penalizedWeight = originalWeight * cumulativeFactor;
    const finalWeight = Math.max(penalizedWeight, floorWeight);

    return {
      ...w,
      weight: +finalWeight.toFixed(6),
      original_weight: +originalWeight.toFixed(6),
      penalties_applied: appliedPenalties,
    };
  });

  // Renormalize weights to sum to 1.0 (penalties change relative weights, so we need to renormalize)
  const totalWeight = penalizedWeights.reduce((sum, w) => sum + w.weight, 0);
  if (totalWeight === 0) {
    // All weights are zero (shouldn't happen due to floorWeight, but handle defensively)
    return weights;
  }

  return penalizedWeights.map(w => ({
    ...w,
    weight: +(w.weight / totalWeight).toFixed(6),
  }));
}

/**
 * Select an agent using weighted probability based on performance data.
 * Uses delta-proportional weighting: higher performers get materially more
 * weight than simple normalization. Falls back to uniform random selection
 * when ANY candidate has insufficient data.
 *
 * @param {string[]} candidates - agent IDs to choose from
 * @param {Object} performanceStore - PerformanceStore instance
 * @param {string} taskCategory - category for performance lookup
 * @param {Function} [randomFn] - random number generator (for deterministic testing)
 * @param {{ floorWeight?: number, sensitivityThreshold?: number, costCoefficient?: number, providerCostMap?: Object }} [config] - routing weight config (providerCostMap: per-provider cost values, e.g., {claude: 1.0, codex: 0.3})
 * @param {Object} [agentMap] - optional agent map for provider-level overrides
 * @param {Object} [providerWeights] - optional provider-level weight overrides (e.g., {claude: 0.6, codex: 0.4})
 * @param {Object} [penalties] - optional error pattern penalties
 * @param {Object} [circuitBreaker] - optional circuit breaker instance to filter unavailable agents
 * @returns {{ selected: string, routing_metadata: Object }|null} selection result with metadata
 */
export function weightedPerformanceSelect(candidates, performanceStore, taskCategory, randomFn = Math.random, config = {}, agentMap = null, providerWeights = null, penalties = null, circuitBreaker = null) {
  if (candidates.length === 0) return null;

  // Filter out agents with open circuit breakers (check provider-level state)
  const availableCandidates = circuitBreaker && agentMap
    ? candidates.filter(id => {
        const agent = agentMap[id];
        if (!agent?.provider) return true;
        return !isProviderCircuitOpen(circuitBreaker, agent.provider);
      })
    : candidates;

  if (availableCandidates.length === 0) {
    log.info('Weighted select: no available candidates (all CB open)', {
      category: taskCategory,
      totalCandidates: candidates.length,
    });
    return null;
  }

  if (availableCandidates.length < candidates.length) {
    log.info('Weighted select: filtered candidates by circuit breaker', {
      category: taskCategory,
      totalCandidates: candidates.length,
      availableCandidates: availableCandidates.length,
      filteredOut: candidates.length - availableCandidates.length,
    });
  }

  const normalizedProviderWeights = normalizeProviderWeightInput(providerWeights);
  const providerWeightMap = normalizedProviderWeights?.weights || null;
  const providerSignalMeta = normalizedProviderWeights?.meta || null;

  const stats = availableCandidates.map(id => {
    const s = performanceStore?.getStatsByAgentCategory(id, taskCategory);
    const provider = agentMap?.[id]?.provider || null;
    return {
      id,
      provider,
      totalDispatches: s?.totalDispatches || 0,
      successRate: (s?.totalDispatches >= 5) ? s.successRate : null,
    };
  });

  // DEBUG: Log stats before passing to computeRoutingWeights
  if (circuitBreaker) {
    console.log('[DEBUG weightedPerformanceSelect] Stats before computeRoutingWeights:', JSON.stringify(stats, null, 2));
    console.log('[DEBUG weightedPerformanceSelect] availableCandidates:', availableCandidates);
    console.log('[DEBUG weightedPerformanceSelect] original candidates:', candidates);
  }

  const missingProviders = stats.filter(s => s.provider === null).map(s => s.id);
  const providerWeightSum = providerWeightMap
    ? Object.values(providerWeightMap)
        .filter(v => typeof v === 'number' && v >= 0)
        .reduce((acc, v) => acc + v, 0)
    : 0;
  const canApplyProviderWeights = Boolean(providerWeightMap && agentMap && missingProviders.length === 0 && providerWeightSum > 0);

  // Resolve cost configuration from config parameter
  const costCoefficient = config.costCoefficient ?? 0;
  const providerCostMap = config.providerCostMap || null;
  const costMap = agentMap
    ? Object.fromEntries(
        availableCandidates
          .map(id => {
            const agent = agentMap[id];
            const provider = agent?.provider;
            if (!provider) return [id, null];
            // Use configured provider costs if available, otherwise fall back to PROVIDER_COST_TIER
            const cost = providerCostMap?.[provider] ?? PROVIDER_COST_TIER[provider] ?? 1.0;
            return [id, cost !== undefined ? cost : null];
          })
      )
    : null;

  // Compute weights using performance data, optionally scaled by provider signals
  const weights = computeRoutingWeights(
    stats,
    { ...config, costCoefficient, costMap },
    canApplyProviderWeights ? providerWeightMap : null,
    circuitBreaker
  );
  if (weights.length === 0) return null;

  // Apply error pattern penalty weights (deprioritizes agents with recent failures, but doesn't block them)
  const penalizedWeights = penalties && penalties.length > 0
    ? applyPenaltyWeights(weights, penalties, config.floorWeight)
    : weights;

  // Optional exploration cap for binary choices to avoid over-skewed probabilities
  let adjustedWeights = penalizedWeights;
  const maxPairWeightCap = (config && typeof config.maxPairWeightCap === 'number') ? config.maxPairWeightCap : 0.85;
  if (penalizedWeights.length === 2 && maxPairWeightCap && maxPairWeightCap < 1) {
    const overIdx = penalizedWeights.findIndex(w => w.weight > maxPairWeightCap);
    if (overIdx !== -1) {
      const otherIdx = overIdx === 0 ? 1 : 0;
      adjustedWeights = penalizedWeights.map((w, idx) => {
        if (idx === overIdx) return { ...w, weight: +maxPairWeightCap.toFixed(4), cappedFrom: w.weight };
        if (idx === otherIdx) return { ...w, weight: +(1 - maxPairWeightCap).toFixed(4), cappedFrom: w.weight };
        return w;
      });
    }
  }

  // Provider weight metadata for routing auditability
  let providerWeightsMeta = null;
  if (providerWeightMap) {
    const statusFromMeta = providerSignalMeta?.status || null;
    const reasonFromMeta = providerSignalMeta?.reason || null;
    providerWeightsMeta = {
      requested: true,
      applied: canApplyProviderWeights,
      status: canApplyProviderWeights
        ? (statusFromMeta ? (statusFromMeta === 'stale' ? 'stale_applied' : statusFromMeta) : 'applied')
        : (statusFromMeta === 'stale' ? 'stale_ignored' : 'ignored'),
      reason: canApplyProviderWeights
        ? (reasonFromMeta || 'provider_weights_applied')
        : (reasonFromMeta || (missingProviders.length ? 'missing_provider_info' : 'provider_weights_unusable')),
      asOf: providerSignalMeta?.asOf ?? null,
      staleByMs: providerSignalMeta?.staleByMs ?? null,
      fallbackUsed: providerSignalMeta?.fallbackUsed ?? false,
      lastGoodAsOf: providerSignalMeta?.lastGoodAsOf ?? null,
      source: providerSignalMeta?.source || 'analytics_signals',
      weights: canApplyProviderWeights ? providerWeightMap : null,
      missingProviders: missingProviders.length ? missingProviders : null,
    };

    if (providerWeightsMeta.fallbackUsed && !providerWeightsMeta.reason) {
      providerWeightsMeta.reason = 'stale_signals_using_last_known_good';
    }

    if (!canApplyProviderWeights && providerWeightSum <= 0) {
      providerWeightsMeta.status = 'fallback_performance';
      providerWeightsMeta.reason = reasonFromMeta || 'zero_or_negative_provider_weights';
    }
  }

  // Determine overall selection reason based on the strategy used
  // Priority: provider signals (if applied) > insufficient_data_fallback > single_candidate > confidence_adjusted > weighted_selection
  let reason;
  if (providerWeightsMeta?.applied) {
    reason = providerWeightsMeta.status && providerWeightsMeta.status.startsWith('stale')
      ? 'provider_signals_stale'
      : 'provider_signals_applied';
  } else if (adjustedWeights.some(w => w.reason === 'insufficient_data_fallback')) {
    reason = 'insufficient_data_fallback';
  } else if (adjustedWeights.some(w => w.reason === 'single_candidate')) {
    reason = 'single_candidate';
  } else if (adjustedWeights.some(w => w.reason === 'confidence_adjusted')) {
    reason = 'confidence_adjusted';
  } else {
    reason = 'weighted_selection';
  }

  // Preserve per-candidate reasons in metadata for auditability
  const statsMap = new Map(stats.map(s => [s.id, s]));
  const candidatesMeta = adjustedWeights.map(w => {
    const stat = statsMap.get(w.id) || {};
    const provider = w.provider ?? stat.provider ?? null;
    const providerWeight = w.providerWeight ?? (
      provider && providerWeightMap && Object.prototype.hasOwnProperty.call(providerWeightMap, provider)
        ? providerWeightMap[provider]
        : null
    );
    const meta = {
      id: w.id,
      provider,
      successRate: w.successRate,
      weight: w.weight,
      reason: w.detailReason || w.reason,
      totalDispatches: stat.totalDispatches || 0,
      providerWeight,
    };
    // Include penalty metadata if penalties were applied to this agent
    if (w.penalties_applied && w.penalties_applied.length > 0) {
      meta.original_weight = w.original_weight;
      meta.penalties_applied = w.penalties_applied;
    }
    return meta;
  });

  // Single available candidate — no random selection needed
  if (availableCandidates.length === 1) {
    log.info('Weighted select: single available candidate', { 
      selected: availableCandidates[0], 
      category: taskCategory,
      circuitBreakerFiltered: availableCandidates.length < candidates.length,
    });
    const costMetadata = buildCostMetadata(costCoefficient, costMap, candidatesMeta);
    const penaltiesMeta = penalties && penalties.length > 0
      ? { applied: true, count: penalties.length, penalties }
      : null;
    return {
      selected: availableCandidates[0],
      routing_metadata: {
        category: taskCategory,
        weights: candidatesMeta,
        reason: availableCandidates.length < candidates.length ? 'cb_filter_single' : 'single_candidate',
        roll: null,
        provider_weights: providerWeightsMeta,
        cost: costMetadata,
        penalties: penaltiesMeta,
      },
    };
  }

  // Weighted random selection using computed weights
  const roll = randomFn();
  let cumulative = 0;
  let selected = adjustedWeights[adjustedWeights.length - 1].id;
  for (const w of adjustedWeights) {
    cumulative += w.weight;
    if (roll < cumulative) {
      selected = w.id;
      break;
    }
  }

  // Logging
  if (reason === 'insufficient_data_fallback') {
    const withData = stats.filter(s => s.successRate !== null);
    const logReason = withData.length === 0 ? 'insufficient data (no data)' : 'insufficient data (guard)';
    log.info(`Weighted select: uniform (${logReason})`, {
      category: taskCategory,
      weights: candidatesMeta,
      selected,
      roll,
      provider_weights: providerWeightsMeta,
    });
  } else {
    const logLabel = providerWeightsMeta?.applied
      ? (providerWeightsMeta.status && providerWeightsMeta.status.startsWith('stale')
          ? 'provider-weighted (stale)'
          : 'provider-weighted')
      : 'performance-based';
    log.info(`Weighted select: ${logLabel}`, {
      category: taskCategory,
      weights: candidatesMeta,
      selected,
      roll,
      provider_weights: providerWeightsMeta,
    });
  }

  const costMetadata = buildCostMetadata(costCoefficient, costMap, candidatesMeta);
  const penaltiesMeta = penalties && penalties.length > 0
    ? { applied: true, count: penalties.length, penalties }
    : null;
  
  // Circuit breaker metadata
  const cbMetadata = circuitBreaker && availableCandidates.length < candidates.length
    ? {
        applied: true,
        filteredOut: candidates.length - availableCandidates.length,
        reason: 'cb_filter',
      }
    : null;
  
  return {
    selected,
    routing_metadata: {
      category: taskCategory,
      weights: candidatesMeta,
      reason,
      roll,
      provider_weights: providerWeightsMeta,
      cost: costMetadata,
      penalties: penaltiesMeta,
      circuit_breaker: cbMetadata,
    },
  };
}

function selectByOrderedCandidates(candidates, available, agentMap, isAgentCoolingDown, performanceStore, taskCategory, agentCooldowns = null, routingConfig = null, penalties = null, circuitBreaker = null) {
  for (const matcher of candidates) {
    const matches = available.filter(aid => {
      const a = agentMap[aid];
      if (!a || isAgentCoolingDown(aid) || !matcher(aid, a)) return false;
      if (circuitBreaker && a.provider && !circuitBreaker.canRequest(a.provider)) return false;
      
      // Codex shared bucket check: filter out agents if their provider's shared bucket is limited
      if (agentCooldowns && a.provider === 'codex') {
        for (const [id, entry] of agentCooldowns.entries()) {
          const other = agentMap[id];
          if (other?.provider === 'codex' && entry && Date.now() < entry.until) {
            // Skip this agent if another codex agent is rate limited (shared bucket)
            return false;
          }
        }
      }
      
      return true;
    });
    if (matches.length === 0) continue;
    if (matches.length === 1) return makeSelectionResult(matches[0], taskCategory, 'role_fallback');
    // Multiple matches — weighted probability selection (handles null performanceStore gracefully)
    const providerWeights = routingConfig?.providerWeights || null;
    return weightedPerformanceSelect(matches, performanceStore, taskCategory, Math.random, routingConfig, agentMap, providerWeights, penalties, circuitBreaker);
  }
  return null;
}

function selectRoleFallback(spec, available, agentMap, isAgentCoolingDown, performanceStore, taskCategory, agentCooldowns = null, routingConfig = null, penalties = null, circuitBreaker = null) {
  if (!spec?.role) return null;

  if (spec.role === 'architect') {
    // Baker model: architect receives all build directives and decomposes into
    // subtasks. Preference is by role+provider tier, never by agent id.
    return selectByOrderedCandidates([
      (_id, a) => a.role === 'architect' && a.provider === 'claude',
      (_id, a) => a.role === 'architect' && a.provider === 'codex',
      (_id, a) => a.role === 'architect' && a.provider === 'ollama',  // local & free
      (_id, a) => a.role === 'architect',                             // any architect
    ], available, agentMap, isAgentCoolingDown, performanceStore, taskCategory, agentCooldowns, routingConfig, penalties, circuitBreaker);
  }

  if (spec.role === 'reviewer') {
    // Cost-tier ordered: local/free first, then cloud providers.
    return selectByOrderedCandidates([
      (_id, a) => a.role === 'reviewer' && a.provider === 'ollama',   // local & free
      (_id, a) => a.role === 'reviewer' && a.provider === 'gemini',
      (_id, a) => a.role === 'reviewer' && a.provider === 'claude',
      (_id, a) => a.role === 'reviewer' && a.provider === 'codex',
      (_id, a) => a.role === 'reviewer',                           // any reviewer as last resort
    ], available, agentMap, isAgentCoolingDown, performanceStore, taskCategory, agentCooldowns, routingConfig, penalties, circuitBreaker);
  }

  if (spec.role === 'developer') {
    // Cookies model: cheapest first. Reviewers are developers with extra duties.
    return selectByOrderedCandidates([
      (_id, a) => a.role === 'developer' && a.provider === 'ollama',  // local & free
      (_id, a) => a.role === 'developer' && a.provider === 'gemini',
      (_id, a) => a.role === 'developer' && a.provider === 'claude',
      (_id, a) => a.role === 'reviewer' && a.provider === 'claude',  // reviewer = developer++
      (_id, a) => a.role === 'developer' && a.provider === 'codex',
      (_id, a) => a.role === 'reviewer' && a.provider === 'gemini',
      (_id, a) => a.role === 'reviewer' && a.provider === 'codex',
      (_id, a) => a.provider === 'gemini',
      (_id, a) => a.provider === 'claude',
      (_id, a) => a.provider === 'codex',
    ], available, agentMap, isAgentCoolingDown, performanceStore, taskCategory, agentCooldowns, routingConfig, penalties, circuitBreaker);
  }
  if (spec.role === "researcher") {
    return selectByOrderedCandidates([
      (_id, a) => a.role === "researcher" && a.provider === "ollama",  // local & free
      (_id, a) => a.role === "researcher" && a.provider === "gemini",
    ], available, agentMap, isAgentCoolingDown, performanceStore, taskCategory, agentCooldowns, routingConfig, penalties, circuitBreaker);
  }

  return null;
}

/**
 * Select the best agent for a routing spec.
 * @param {Object} spec - { role, provider } from ROUTING_MATRIX
 * @param {string[]} available - agent IDs not cooling down
 * @param {Object} agentMap - { id: agentInstance }
 * @param {string} text - message text (for relevance scoring)
 * @param {Function} isAgentCoolingDown - cooldown check function
 * @param {Function} rankAgentsByRelevance - relevance ranker
 * @param {string} [complexity] - 'low'|'medium'|'high' for local-first routing
 * @param {Object} [performanceStore] - PerformanceStore instance for success-rate tiebreaking
 * @param {string} [taskCategory] - task category for performance lookup (e.g. classification type)
 * @returns {{ selected: string, routing_metadata: Object }|null} selection result with metadata, or null
 */
export function selectAgent(spec, available, agentMap, text, isAgentCoolingDown, rankAgentsByRelevance, complexity, performanceStore, taskCategory, agentCooldowns = null, routingConfig = null, penalties = null, circuitBreaker = null) {
  if (!spec || available.length === 0) return null;

  // Helper to check if an agent is eligible (not cooling down and circuit breaker closed)
  const isAgentAvailable = (id) => {
    if (isAgentCoolingDown(id)) return false;
    if (circuitBreaker) {
      const agent = agentMap[id];
      // Check provider-level CB (primary gate)
      if (agent?.provider && !circuitBreaker.canRequest(agent.provider)) return false;
      // Check agent-level CB (defense in depth)
      if (circuitBreaker.canAgentRequest && !circuitBreaker.canAgentRequest(id)) return false;
    }
    return true;
  };

  // --- Local-first preference ---
  // For low/medium complexity: try ollama agents first (cost = $0, latency = local).
  // Falls through gracefully when no ollama agents are available.
  if (config.router.localFirst && complexity && complexity !== 'high') {
    const ollamaAgents = available.filter(id => {
      const a = agentMap[id];
      return a && a.provider === 'ollama' && (!a._status || a._status === 'active') && isAgentAvailable(id);
    });

    if (ollamaAgents.length > 0) {
      // Prefer role match within ollama agents
      if (spec.role && spec.role !== 'relevance') {
        const roleMatch = ollamaAgents.find(id => agentMap[id]?.role === spec.role);
        if (roleMatch) return makeSelectionResult(roleMatch, taskCategory, 'local_first');
      }
      // Ollie handles low AND medium for any role (multi-role capable, comparable to Sonnet 4.5/4.6)
      if (complexity === 'low' || complexity === 'medium') return makeSelectionResult(ollamaAgents[0], taskCategory, 'local_first');
    }

    // Cloud budget protection: for ops/developer/relevance traffic, try harder to use local.
    // Do not let budget pressure make Ollie step on architect/reviewer/researcher roles.
    if (isCloudBudgetLow() && ollamaAgents.length > 0
      && (!spec.role || ['ops', 'developer', 'relevance'].includes(spec.role))) {
      log.warn('Cloud budget low — routing to local agent', { budgetStatus: getCloudBudgetStatus() });
      return makeSelectionResult(ollamaAgents[0], taskCategory, 'local_first_budget');
    }
  }

  // Special case: relevance-based selection
  if (spec.role === 'relevance') {
    const ranked = rankAgentsByRelevance(text);
    for (const { id } of ranked) {
      if (available.includes(id) && isAgentAvailable(id)) return makeSelectionResult(id, taskCategory, 'relevance_ranked');
    }
    // Fall through to any available (respecting circuit breaker)
    const fallback = available.find(id => isAgentAvailable(id));
    return makeSelectionResult(fallback || null, taskCategory, 'relevance_ranked');
  }

  // Priority 1: exact role + preferred provider match
  if (spec.role && spec.provider) {
    const match = available.find(id => {
      const a = agentMap[id];
      return a && a.role === spec.role && a.provider === spec.provider && isAgentAvailable(id);
    });
    if (match) return makeSelectionResult(match, taskCategory, 'exact_role_provider_match');
  }

  // Priority 1.5: explicit role fallback policy (prevents agents stepping on each other).
  // selectRoleFallback returns { selected, routing_metadata } or null
  const roleFallback = selectRoleFallback(spec, available, agentMap, isAgentCoolingDown, performanceStore, taskCategory, agentCooldowns, routingConfig, penalties, circuitBreaker);
  if (roleFallback) return roleFallback;

  // Priority 2: role match — pre-sort by cost tier, then weighted probability selection
  if (spec.role) {
    const roleMatches = available.filter(id => {
      const a = agentMap[id];
      return a && a.role === spec.role && isAgentAvailable(id);
    }).sort((a, b) => getAgentCostTier(a, agentMap[a]?.provider) - getAgentCostTier(b, agentMap[b]?.provider));
      if (roleMatches.length > 0) {
      if (roleMatches.length > 1 && performanceStore && taskCategory) {
        const providerWeights = routingConfig?.providerWeights || null;
        return weightedPerformanceSelect(roleMatches, performanceStore, taskCategory, Math.random, routingConfig, agentMap, providerWeights, penalties, circuitBreaker);
      }
      return makeSelectionResult(roleMatches[0], taskCategory, 'role_match');
    }
  }

  // Priority 3: provider match — pre-sort by cost tier, then weighted probability selection
  if (spec.provider) {
    const providerMatches = available.filter(id => {
      const a = agentMap[id];
      return a && a.provider === spec.provider && isAgentAvailable(id);
    }).sort((a, b) => getAgentCostTier(a, agentMap[a]?.provider) - getAgentCostTier(b, agentMap[b]?.provider));
    if (providerMatches.length > 0) {
      if (providerMatches.length > 1 && performanceStore && taskCategory) {
        const providerWeights = routingConfig?.providerWeights || null;
        return weightedPerformanceSelect(providerMatches, performanceStore, taskCategory, Math.random, routingConfig, agentMap, providerWeights, penalties, circuitBreaker);
      }
      return makeSelectionResult(providerMatches[0], taskCategory, 'provider_match');
    }
  }

  // Priority 4: provider-routing regex match (skill-agnostic fallback)
  for (const id of available) {
    const a = agentMap[id];
    if (!a || !isAgentAvailable(id)) continue;
    const pattern = PROVIDER_ROUTING[a.provider];
    if (pattern && pattern.test(text)) return makeSelectionResult(id, taskCategory, 'regex_fallback');
  }

  // Priority 5: any available — pre-sort by cost tier, then weighted probability selection
  const fallbackCandidates = available
    .filter(id => agentMap[id] && isAgentAvailable(id))
    .sort((a, b) => getAgentCostTier(a, agentMap[a]?.provider) - getAgentCostTier(b, agentMap[b]?.provider));
  if (fallbackCandidates.length > 1 && performanceStore && taskCategory) {
    const providerWeights = routingConfig?.providerWeights || null;
    return weightedPerformanceSelect(fallbackCandidates, performanceStore, taskCategory, Math.random, routingConfig, agentMap, providerWeights, penalties, circuitBreaker);
  }
  return makeSelectionResult(fallbackCandidates[0] || null, taskCategory, 'any_available');
}

// --- Low confidence detection ---
// Detects responses that warrant escalation to a second agent.

const HEDGING_RE = /^(i'?m not sure|i'?m uncertain|it'?s hard to say|i don'?t know|i'?m not confident|unclear|not certain|difficult to determine)/i;

/**
 * Check if an agent response is low-confidence and should trigger escalation.
 * @param {string} response - agent's response text
 * @returns {boolean}
 */
export function isLowConfidence(response) {
  if (!response) return true;
  const trimmed = response.trim();
  // Very short non-code response
  if (trimmed.length < 100 && !trimmed.includes('```') && !trimmed.includes('function ')) {
    return true;
  }
  // Hedging language in the opening
  const opening = trimmed.slice(0, 200);
  if (HEDGING_RE.test(opening)) return true;
  return false;
}

// --- Constraint application ---

/**
 * Apply injected constraints to the available agent list.
 * Returns the filtered list and a record of which rules were applied.
 *
 * @param {string[]} available - agent IDs
 * @param {Object} agentMap - { id: agentInstance }
 * @param {Object[]} constraints - array of constraint objects from getActiveConstraints()
 * @returns {{ filtered: string[], paused: boolean, applied: string[] }}
 */
export function applyConstraints(available, agentMap, constraints) {
  if (!constraints || constraints.length === 0) {
    return { filtered: available, paused: false, applied: [], priorityOverride: null, penalties: [] };
  }

  const applied = [];
  let filtered = [...available];
  let paused = false;
  let priorityOverride = null;
  const penalties = [];

  for (const c of constraints) {
    // Support both new { type, value } format and old flat format
    const isNewFormat = c.type && 'value' in c;
    const getVal = (newType, oldKey) => isNewFormat && c.type === newType ? c.value : c[oldKey];

    const pauseCampaign = getVal('pause_campaign', 'pause_campaign');
    const prioOverride = getVal('priority_override', 'priority_override');
    const timeWindow = getVal('time_window', 'time_window');
    const excludeAgents = getVal('exclude_agents', 'exclude_agents');
    const requireProvider = getVal('require_provider', 'require_provider');
    const maxConcurrent = getVal('max_concurrent', 'max_concurrent');
    const errorPatternPenalty = getVal('error_pattern_penalty', 'error_pattern_penalty');

    if (pauseCampaign) {
      paused = true;
      applied.push('pause_campaign');
    }

    if (prioOverride && typeof prioOverride === 'string') {
      priorityOverride = prioOverride;
      applied.push(`priority_override:${prioOverride}`);
    }

    if (timeWindow && typeof timeWindow === 'object') {
      const now = new Date();
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const currentDay = days[now.getDay()];
      const currentHour = now.getHours();
      const inWindow = (!timeWindow.days || timeWindow.days.includes(currentDay))
        && (timeWindow.startHour === undefined || currentHour >= timeWindow.startHour)
        && (timeWindow.endHour === undefined || currentHour < timeWindow.endHour);
      if (!inWindow) {
        const before = filtered.length;
        filtered = [];
        if (before > 0) applied.push('time_window:outside');
      }
    }

    if (Array.isArray(excludeAgents) && excludeAgents.length > 0) {
      const excludeSet = new Set(excludeAgents);
      const before = filtered.length;
      filtered = filtered.filter(id => !excludeSet.has(id));
      if (filtered.length < before) {
        applied.push(`exclude_agents:${excludeAgents.join(',')}`);
      }
    }

    if (requireProvider && typeof requireProvider === 'string') {
      const before = filtered.length;
      filtered = filtered.filter(id => agentMap[id]?.provider === requireProvider);
      if (filtered.length < before) {
        applied.push(`require_provider:${requireProvider}`);
      }
    }

    if (typeof maxConcurrent === 'number' && maxConcurrent >= 0) {
      applied.push(`max_concurrent:${maxConcurrent}`);
    }

    // Handle error_pattern_penalty constraints
    if (errorPatternPenalty && typeof errorPatternPenalty === 'object') {
      const { agentId, errorCategory, penaltyFactor, patternId, expiresAt } = errorPatternPenalty;

      // Skip if required fields are missing
      if (!agentId || !patternId) {
        continue;
      }

      // Skip expired penalties
      const now = Date.now();
      if (expiresAt) {
        const expiryTime = typeof expiresAt === 'number' ? expiresAt : new Date(expiresAt).getTime();
        if (expiryTime < now) {
          continue; // Penalty has expired, skip it
        }
      }

      // Extract penalty data with defaults
      penalties.push({
        agentId,
        penaltyFactor: typeof penaltyFactor === 'number' ? penaltyFactor : 0.2,
        patternId,
        expiresAt: expiresAt || null,
        errorCategory: errorCategory || null,
      });

      applied.push(`error_pattern_penalty:${agentId}:${patternId}`);
    }
  }

  return { filtered, paused, applied, priorityOverride, penalties };
}

// --- Steer override validation ---

/**
 * Role capability map: given an agent's role, which ROUTING_MATRIX primary roles
 * can it fulfill? Higher-capability roles subsume lower ones.
 *
 * Keys are agent role values; values are arrays of required-role strings the
 * agent is considered capable of handling.
 */
export const STEER_ROLE_CAPABILITIES = Object.freeze({
  architect:  ['architect', 'strategist', 'reviewer', 'developer', 'implementer', 'researcher'],
  reviewer:   ['reviewer', 'developer', 'implementer', 'researcher'],
  developer:  ['developer', 'implementer', 'researcher'],
  researcher: ['researcher'],
  ops:        ['ops'],
});

/**
 * Validate a steer override target (agent or provider) against the task category.
 *
 * Checks (in order):
 *  1. targetAgent exists in agentMap
 *  2. targetAgent role is compatible with the primary role required by taskCategory
 *  3. targetProvider has at least one known agent
 *  4. targetAgent is not the same as originalAgent
 *
 * The "relevance" primary role (used for `question` category) accepts any agent
 * because selection is driven by similarity scoring, not a fixed role.
 *
 * @param {Object} params
 * @param {string|null} params.targetAgent     - agent ID to steer to, or null
 * @param {string|null} params.targetProvider  - provider name to steer to, or null
 * @param {string|null} params.taskCategory    - ROUTING_MATRIX category of the original dispatch
 * @param {Object}      params.agentMap        - { id: agentInstance }
 * @param {string|null} [params.originalAgent] - original dispatch agent (to catch same-target)
 * @returns {{ valid: boolean, error: string|null }}
 */
export function validateSteerTarget({ targetAgent, targetProvider, taskCategory, agentMap, originalAgent = null }) {
  // 1. Target agent must exist
  if (targetAgent && !agentMap[targetAgent]) {
    return { valid: false, error: `Unknown targetAgent: ${targetAgent}` };
  }

  // 2. Check role/category compatibility for a named agent
  if (targetAgent && taskCategory) {
    const route = ROUTING_MATRIX[taskCategory];
    if (route && route.primary?.role) {
      const requiredRole = route.primary.role;
      // 'relevance' category selects by similarity — any agent is acceptable
      if (requiredRole !== 'relevance') {
        const agentRole = agentMap[targetAgent]?.role;
        const capable = STEER_ROLE_CAPABILITIES[agentRole] || ['developer', 'implementer', 'researcher'];
        if (!capable.includes(requiredRole) && agentRole !== requiredRole) {
          return {
            valid: false,
            error: `Agent ${targetAgent} (role: ${agentRole}) cannot handle category ${taskCategory} (requires role: ${requiredRole})`,
          };
        }
      }
    }
  }

  // 3. Provider must have at least one registered agent
  if (targetProvider) {
    const hasAgent = Object.values(agentMap).some(a => a && a.provider === targetProvider);
    if (!hasAgent) {
      return { valid: false, error: `No agents available for provider: ${targetProvider}` };
    }
  }

  // 4. Cannot steer to the same agent that handled the original dispatch
  if (targetAgent && originalAgent && targetAgent === originalAgent) {
    return { valid: false, error: 'targetAgent must differ from original dispatch agent' };
  }

  return { valid: true, error: null };
}

// --- Dispatch modes ---

// Audit counter — track dispatches for periodic spot-check
let dispatchCounter = 0;

/**
 * Build the routing plan for a message. Called by orchestrator's handleUserMessage.
 * Returns a dispatch descriptor that the orchestrator executes.
 *
 * @param {string} text - raw message text
 * @param {string[]} mentioned - agent IDs from parseMentions
 * @param {Object} directed - { agentId: segment } from parseDirectedSegments
 * @param {Object} agentMap - { id: agentInstance }
 * @param {Function} isAgentCoolingDown - cooldown check
 * @param {Function} rankAgentsByRelevance - relevance ranker
 * @param {string|null} modeOverride - user-selected mode ('solo'|'pair'|null for auto)
 * @param {Object} [performanceStore] - PerformanceStore instance for success-rate tiebreaking
 * @param {Object[]} [constraints] - active constraints from campaignManager.getActiveConstraints()
 * @returns {{ mode, type, primary, secondary, escalation, participants, budget, confidence, autoClassified } | null}
 *   null = fall through to legacy path (delegation, explicit 1-2 @mentions, etc.)
 */
export function buildRoutingPlan(text, mentioned, directed, agentMap, isAgentCoolingDown, rankAgentsByRelevance, modeOverride = null, performanceStore = null, constraints = null, routingConfig = null, circuitBreaker = null, rosterSpec = null) {
  // Use provided config or default to router settings
  if (!routingConfig) {
    routingConfig = {
      floorWeight: config.router.floorWeight,
      sensitivityThreshold: config.router.sensitivityThreshold,
    };
  }
  const hasDirectedSegments = Object.keys(directed).length > 0;

  // Explicit 1-2 @mentions with directed segments → existing execution path
  if (hasDirectedSegments) return null;

  // Classify the message (always — needed for agent selection even when mode is overridden)
  const classification = classifyMessage(text, mentioned, agentMap);

  // Determine effective mode: user override wins, then @mention count, then classifier
  const VALID_MODES = new Set(['solo', 'pair', 'council']);
  // @everyone / @all is an unambiguous request for the whole room and
  // dominates every other signal, including the selected mode (operator
  // ruling 2026-08-02: auto must recognize @everyone as a council request).
  const wantsEveryone = /(^|\s)@(everyone|all)\b/i.test(text);
  const effectiveMode = wantsEveryone
    ? 'council'
    : (modeOverride && VALID_MODES.has(modeOverride))
      ? modeOverride
      : null; // null = auto (use classifier/mentions)

  // Explicit 1 @mention → solo (unless user forced a different mode)
  if (mentioned.length === 1 && (!effectiveMode || effectiveMode === 'solo')) {
    const agentId = mentioned[0];
    return {
      mode: 'solo',
      type: 'explicit_mention',
      primary: agentId,
      secondary: null,
      escalation: null,
      participants: [agentId],
      budget: { maxRounds: 2, maxResponses: config.router.soloBudget },
      confidence: 1.0,
      autoClassified: !effectiveMode,
      routing_metadata: {
        primary_selection: { category: null, weights: [{ id: agentId, successRate: null, weight: 1.0, reason: 'explicit_mention' }], reason: 'explicit_mention', roll: null },
        secondary_selection: null,
        escalation_selection: null,
      },
    };
  }

  // Explicit 2 @mentions → pair (unless user forced a different mode)
  if (mentioned.length === 2 && (!effectiveMode || effectiveMode === 'pair')) {
    return {
      mode: 'pair',
      type: 'explicit_mention',
      primary: mentioned[0],
      secondary: mentioned[1],
      escalation: null,
      participants: mentioned,
      budget: { maxRounds: 2, maxResponses: config.router.pairBudget },
      confidence: 1.0,
      autoClassified: !effectiveMode,
      routing_metadata: {
        primary_selection: { category: null, weights: [{ id: mentioned[0], successRate: null, weight: 1.0, reason: 'explicit_mention' }], reason: 'explicit_mention', roll: null },
        secondary_selection: { category: null, weights: [{ id: mentioned[1], successRate: null, weight: 1.0, reason: 'explicit_mention' }], reason: 'explicit_mention', roll: null },
        escalation_selection: null,
      },
    };
  }

  // Council: convene every eligible agent as a first-class routing plan.
  // The Council button and @everyone/@all both land here — this is native
  // router behavior, independent of message classification. (Council was
  // silently dead from d048cb64 (2026-02-17) to 2026-08-02 because this
  // mode fell through to auto-classification and solo-routed.)
  if (effectiveMode === 'council') {
    let councilAvailable = Object.keys(agentMap).filter(id => {
      const a = agentMap[id];
      return a && a.role !== 'governor'
        && (!a._status || a._status === 'active')
        && !isAgentPaused(id)
        && !isAgentCoolingDown(id)
        && (!circuitBreaker || circuitBreaker.canRequest(id))
        // Council must honor the project roster spec — without this filter a
        // council seats every active agent in the instance, not the project's
        // pinned team (null/empty spec = all agents, matching project semantics).
        && rosterAllowsAgentAnyRole(rosterSpec, id, a);
    });
    const councilConstraints = applyConstraints(councilAvailable, agentMap, constraints);
    if (councilConstraints.paused) {
      log.info('Council routing halted: pause_campaign constraint active', { constraintRules: councilConstraints.applied });
      return null;
    }
    councilAvailable = councilConstraints.filtered;
    if (councilAvailable.length >= 2) {
      return {
        mode: 'council',
        type: wantsEveryone ? 'everyone_broadcast' : 'council',
        primary: councilAvailable[0],
        secondary: null,
        escalation: null,
        participants: councilAvailable,
        budget: {
          maxRounds: config.router.councilMaxRounds || 4,
          maxResponses: Math.max(councilAvailable.length * 3, 12),
        },
        confidence: 1.0,
        autoClassified: wantsEveryone && modeOverride !== 'council',
        routing_metadata: {
          primary_selection: {
            category: 'council',
            weights: councilAvailable.map(id => ({ id, successRate: null, weight: 1.0, reason: 'council_round_table' })),
            reason: 'council_round_table',
            roll: null,
          },
          secondary_selection: null,
          escalation_selection: null,
          constraint_applied: councilConstraints.applied?.length > 0 ? councilConstraints.applied : null,
        },
      };
    }
    // Fewer than 2 eligible agents: a council is meaningless — fall
    // through to normal routing so the message still gets answered.
  }

  const route = ROUTING_MATRIX[classification.type];
  if (!route) return null;

  // Delegation type falls through to existing execution path (mode override can't change this)
  if (route.mode === 'execution' && !effectiveMode) return null;

  let available = Object.keys(agentMap).filter(id => {
    const a = agentMap[id];
    return a && (!a._status || a._status === 'active') && !isAgentPaused(id);
  });

  // --- Apply injected constraints ---
  const { filtered, paused, applied: constraintRules, priorityOverride, penalties } = applyConstraints(available, agentMap, constraints);

  if (paused) {
    log.info('Routing halted: pause_campaign constraint active', { constraintRules });
    return null;
  }

  available = filtered;

  // No candidates left after constraint filtering
  if (available.length === 0) {
    log.warn('No agents available after constraint filtering', { constraintRules });
    return null;
  }

  // Build constraint_applied metadata (null when no constraints altered routing)
  const constraintApplied = constraintRules.length > 0 ? constraintRules : null;

  // Handle priority_override: short-circuit agent selection and force a specific primary
  if (priorityOverride) {
    const complexity = estimateComplexity(classification, text);
    return {
      mode: 'solo',
      type: classification.type,
      complexity,
      primary: priorityOverride,
      secondary: null,
      escalation: null,
      participants: [priorityOverride],
      budget: { maxRounds: 2, maxResponses: config.router.soloBudget },
      confidence: classification.confidence,
      autoClassified: !effectiveMode,
      routing_metadata: {
        primary_selection: { category: classification.type, weights: [{ id: priorityOverride, successRate: null, weight: 1.0, reason: 'priority_override' }], reason: 'priority_override', roll: null },
        secondary_selection: null,
        escalation_selection: null,
        constraint_applied: constraintApplied,
        priority_override: priorityOverride,
      },
    };
  }

  // Resolve the dispatch mode — user override or classifier's recommendation
  let dispatchMode = effectiveMode || route.mode;

  // max_concurrent constraint: if set to 1, downgrade pair → solo
  // Support both old flat format (c.max_concurrent) and new { type, value } format
  const maxConcurrentConstraint = constraints?.find(c =>
    typeof c.max_concurrent === 'number' || (c.type === 'max_concurrent' && typeof c.value === 'number')
  );
  const maxConcurrent = maxConcurrentConstraint?.max_concurrent ?? maxConcurrentConstraint?.value;
  if (typeof maxConcurrent === 'number' && maxConcurrent <= 1 && dispatchMode === 'pair') {
    dispatchMode = 'solo';
  }

  // --- Complexity estimation for local-first routing ---
  const complexity = estimateComplexity(classification, text);

  // --- Solo or pair — select agents ---
  // Use the classifier's route for agent specs, or fall back to relevance
  const primarySpec = route.primary || { role: 'relevance' };

  // Task category for performance-based tiebreaking
  const taskCategory = classification.type;

  // If @mentions provided, use those instead of agent selection
  // selectAgent returns { selected, routing_metadata } — unwrap to get agent ID strings
  const primaryResult = mentioned.length > 0
    ? null
    : selectAgent(primarySpec, available, agentMap, text, isAgentCoolingDown, rankAgentsByRelevance, complexity, performanceStore, taskCategory, null, routingConfig, penalties, circuitBreaker);
  const primary = mentioned.length > 0 ? mentioned[0] : primaryResult?.selected;
  if (!primary) return null;

  if (dispatchMode === 'solo') {
    const escalationResult = route.escalation
      ? selectAgent(route.escalation, available.filter(id => id !== primary), agentMap, text, isAgentCoolingDown, rankAgentsByRelevance, complexity, performanceStore, taskCategory, null, routingConfig, penalties, circuitBreaker)
      : null;
    const escalation = escalationResult?.selected || null;
    return {
      mode: 'solo',
      type: classification.type,
      complexity,
      primary,
      secondary: null,
      escalation,
      participants: [primary],
      budget: { maxRounds: 2, maxResponses: config.router.soloBudget },
      confidence: classification.confidence,
      autoClassified: !effectiveMode,
      routing_metadata: {
        primary_selection: primaryResult?.routing_metadata || null,
        secondary_selection: null,
        escalation_selection: escalationResult?.routing_metadata || null,
        constraint_applied: constraintApplied,
      },
    };
  }

  // --- Pair mode ---
  const secondarySpec = route.secondary || { role: 'reviewer' };
  const secondaryResult = mentioned.length >= 2
    ? null
    : selectAgent(secondarySpec, available.filter(id => id !== primary), agentMap, text, isAgentCoolingDown, rankAgentsByRelevance, complexity, performanceStore, taskCategory, null, routingConfig, penalties, circuitBreaker);
  const secondary = mentioned.length >= 2 ? mentioned[1] : secondaryResult?.selected || null;

  const escalationResult = route.escalation
    ? selectAgent(route.escalation, available.filter(id => id !== primary && id !== secondary), agentMap, text, isAgentCoolingDown, rankAgentsByRelevance, complexity, performanceStore, taskCategory, null, routingConfig, penalties, circuitBreaker)
    : null;
  const escalation = escalationResult?.selected || null;

  const participants = [primary];
  if (secondary) participants.push(secondary);

  return {
    mode: 'pair',
    type: classification.type,
    complexity,
    primary,
    secondary,
    escalation,
    participants,
    budget: { maxRounds: 2, maxResponses: config.router.pairBudget },
    confidence: classification.confidence,
    autoClassified: !effectiveMode,
    routing_metadata: {
      primary_selection: primaryResult?.routing_metadata || null,
      secondary_selection: secondaryResult?.routing_metadata || null,
      escalation_selection: escalationResult?.routing_metadata || null,
      constraint_applied: constraintApplied,
    },
  };
}

/**
 * Increment dispatch counter and check if an audit is due.
 * @returns {boolean} true if an audit should be dispatched
 */
export function shouldAudit() {
  dispatchCounter++;
  return (dispatchCounter % config.router.auditInterval) === 0;
}

/**
 * Record that an agent was dispatched (for provider load tracking + cloud budget).
 * @param {string} agentId
 * @param {Object} agentMap
 */
export function recordDispatch(agentId, agentMap) {
  const provider = agentMap[agentId]?.provider;
  if (provider) {
    // Track cloud budget — ollama is free, everything else is a cloud dispatch
    if (provider !== 'ollama') {
      recordCloudDispatch(provider);
    }
  }
}

/**
 * Build the routed system prompt addition — tells agents they were specifically selected.
 * @param {string} mode - solo/pair/council
 * @param {string} role - why this agent was selected (e.g. "primary", "reviewer", "escalation")
 * @returns {string}
 */
export function routedPromptSuffix(mode, role) {
  if (mode === 'solo') {
    return `\n\n## Routing
You were specifically selected for this message (${role}). Respond substantively — do not defer, "+1", or pass. If you need to escalate, say so explicitly.`;
  }
  if (mode === 'pair') {
    if (role === 'primary') {
      return `\n\n## Routing
You were selected as the primary responder for this task. Work the problem directly. A reviewer will check your output next.`;
    }
    return `\n\n## Routing
You were selected as the reviewer. The primary agent's response is above. Review it for correctness, completeness, and quality. Flag specific issues if found.`;
  }
  return ''; // council mode uses existing comm rules
}

// Re-export for tests
export { EXECUTION_RE, DISCUSSION_OVERRIDE_RE, PROVIDER_ROUTING, DELEGATION_RE, COMPLEXITY_MAP };
