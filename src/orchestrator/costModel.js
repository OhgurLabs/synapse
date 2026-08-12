// Cost attribution model for LLM providers
//
// Pricing per 1M tokens (input/output) — updated 2026-08-06 for live roster.
// Sources: public list prices where known; approximate where models are
// subscription/coding-plan/local. Unknown paid models fall back to a
// *provider* default that is intentionally mid-tier, not Opus-max, so Haiku
// traffic is not silently billed as Opus when an entry is missing.

/**
 * Pricing table keyed by provider, then model.
 * Each provider has:
 *   - [model]: direct model entry with {inputPer1M, outputPer1M} in USD
 *   - default: fallback pricing if exact model not found
 */
const PRICING_TABLE = Object.freeze({
  claude: Object.freeze({
    // Historical / still-referenced
    'claude-opus-4-6': Object.freeze({ inputPer1M: 15, outputPer1M: 75 }),
    'claude-3-sonnet': Object.freeze({ inputPer1M: 3, outputPer1M: 15 }),
    // Live roster (HEAD agents.json)
    'claude-opus-5': Object.freeze({ inputPer1M: 15, outputPer1M: 75 }),
    'claude-fable-5': Object.freeze({ inputPer1M: 3, outputPer1M: 15 }),
    'claude-haiku-4-5': Object.freeze({ inputPer1M: 1, outputPer1M: 5 }),
    // Mid-tier default — do not default unknown Claude to Opus pricing
    default: Object.freeze({ inputPer1M: 3, outputPer1M: 15 }),
  }),

  codex: Object.freeze({
    'gpt-5.3-codex': Object.freeze({ inputPer1M: 2, outputPer1M: 8 }),
    'gpt-4o': Object.freeze({ inputPer1M: 2.5, outputPer1M: 10 }),
    // Live roster
    'gpt-5.5': Object.freeze({ inputPer1M: 2, outputPer1M: 8 }),
    'gpt-5.4-mini': Object.freeze({ inputPer1M: 0.4, outputPer1M: 1.6 }),
    default: Object.freeze({ inputPer1M: 2, outputPer1M: 8 }),
  }),

  gemini: Object.freeze({
    'gemini-3-auto': Object.freeze({ inputPer1M: 1.25, outputPer1M: 5 }),
    'gemini-3-flash': Object.freeze({ inputPer1M: 0.35, outputPer1M: 1.4 }),
    'gemini-2.5-pro': Object.freeze({ inputPer1M: 1.25, outputPer1M: 5 }),
    default: Object.freeze({ inputPer1M: 1.25, outputPer1M: 5 }),
  }),

  ollama: Object.freeze({
    // Local models are free regardless of the specific GGUF — the default
    // covers every model id, so no per-model entries are needed here.
    default: Object.freeze({ inputPer1M: 0, outputPer1M: 0 }),
  }),

  // Alias for llama provider (same as ollama — local models)
  llama: Object.freeze({
    default: Object.freeze({ inputPer1M: 0, outputPer1M: 0 }),
  }),

  'llama-cpp': Object.freeze({
    default: Object.freeze({ inputPer1M: 0, outputPer1M: 0 }),
  }),

  local: Object.freeze({
    default: Object.freeze({ inputPer1M: 0, outputPer1M: 0 }),
  }),

  // Z.AI coding-plan agents (subscription; attribute nominal API-equivalent)
  glm: Object.freeze({
    'zai-coding-plan/glm-5.2': Object.freeze({ inputPer1M: 1, outputPer1M: 3 }),
    'zai-coding-plan/glm-5-turbo': Object.freeze({ inputPer1M: 0.5, outputPer1M: 1.5 }),
    default: Object.freeze({ inputPer1M: 1, outputPer1M: 3 }),
  }),

  // Grok-build harness (local/subscription; treat as $0 until metered)
  grok: Object.freeze({
    'grok-build': Object.freeze({ inputPer1M: 0, outputPer1M: 0 }),
    default: Object.freeze({ inputPer1M: 0, outputPer1M: 0 }),
  }),
});

/**
 * Calculate cost for a single LLM dispatch.
 *
 * @param {string} provider - Provider name (claude, codex, gemini, ollama, etc.)
 * @param {string} model - Model identifier
 * @param {number} inputTokens - Number of input tokens
 * @param {number} outputTokens - Number of output tokens
 * @returns {{costUsd: number, priceSource: string}} - Cost in USD and source of pricing
 *
 * priceSource values:
 *   - 'exact': exact model found in pricing table
 *   - 'provider_default': model not found, used provider-level default
 *   - 'unknown_provider': provider not found, returned $0 (with warning)
 */
function calculateCost(provider, model, inputTokens, outputTokens) {
  // Validate provider
  if (typeof provider !== 'string' || !provider) {
    throw new Error('provider must be a non-empty string');
  }

  // Validate model
  if (typeof model !== 'string' || !model) {
    throw new Error('model must be a non-empty string');
  }

  // Validate inputTokens
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens)) {
    throw new Error('inputTokens must be a non-negative finite number');
  }

  if (inputTokens < 0) {
    throw new Error('inputTokens must be a non-negative finite number');
  }

  // Validate outputTokens
  if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens)) {
    throw new Error('outputTokens must be a non-negative finite number');
  }

  if (outputTokens < 0) {
    throw new Error('outputTokens must be a non-negative finite number');
  }

  // Normalize provider name to lowercase
  const normalizedProvider = provider.toLowerCase();

  // Look up provider in pricing table
  const providerPricing = PRICING_TABLE[normalizedProvider];

  if (!providerPricing) {
    // Unknown provider — log warning and return zero cost
    console.warn(`[costModel] Unknown provider "${provider}" — returning $0 cost. Add to PRICING_TABLE if this is a paid provider.`);
    return {
      costUsd: 0,
      priceSource: 'unknown_provider',
    };
  }

  // Look up model-specific pricing first (direct access, not nested)
  let pricing = providerPricing[model];
  let priceSource = 'exact';

  // Fall back to provider default if model not found
  if (!pricing) {
    pricing = providerPricing.default;
    priceSource = 'provider_default';
  }

  // Calculate cost per token (pricing is per 1M tokens)
  const inputCostPerToken = pricing.inputPer1M / 1_000_000;
  const outputCostPerToken = pricing.outputPer1M / 1_000_000;

  const inputCost = inputTokens * inputCostPerToken;
  const outputCost = outputTokens * outputCostPerToken;
  const totalCost = inputCost + outputCost;

  // Round to 6 decimal places to avoid floating point precision issues
  const costUsd = Math.round(totalCost * 1_000_000) / 1_000_000;

  return {
    costUsd,
    priceSource,
  };
}

export { PRICING_TABLE, calculateCost };
