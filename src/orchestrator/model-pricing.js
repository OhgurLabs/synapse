/**
 * model-pricing.js — LLM model pricing table and cost calculation utilities.
 *
 * Provides pricing information for all supported models and helper functions
 * for computing per-dispatch costs based on token usage.
 *
 * Pricing is expressed as cost per token (NOT per million tokens).
 * All ollama/local models are costed at $0.
 *
 * Provider pricing references (as of 2026-03):
 * - Claude API: https://www.anthropic.com/pricing
 * - OpenAI Codex: https://openai.com/pricing
 * - Google Gemini: https://ai.google.dev/pricing
 */

/**
 * Character-to-token estimation ratio for fallback when token counts unavailable.
 * Default: 0.25 tokens per character (approximately 4 characters per token).
 * Based on empirical averages across English text with typical code/markdown mix.
 */
export const tokensPerCharRatio = 0.25;

/**
 * Model pricing table.
 * Maps model identifiers to input/output cost per token.
 *
 * Structure:
 * {
 *   "model-id": {
 *     inputCostPerToken: number,   // cost per input token
 *     outputCostPerToken: number   // cost per output token
 *   }
 * }
 */
const pricingTable = {
  // ──────────────────────────────────────────────────────────────────────
  // Claude models (Anthropic)
  // ──────────────────────────────────────────────────────────────────────
  'claude-opus-4-6': {
    inputCostPerToken: 15 / 1_000_000,   // $15 per 1M input tokens
    outputCostPerToken: 75 / 1_000_000   // $75 per 1M output tokens
  },
  'claude-sonnet-4-6': {
    inputCostPerToken: 3 / 1_000_000,    // $3 per 1M input tokens
    outputCostPerToken: 15 / 1_000_000   // $15 per 1M output tokens
  },
  'claude-sonnet-4-5': {
    inputCostPerToken: 3 / 1_000_000,    // $3 per 1M input tokens
    outputCostPerToken: 15 / 1_000_000   // $15 per 1M output tokens
  },

  // ──────────────────────────────────────────────────────────────────────
  // OpenAI Codex models
  // ──────────────────────────────────────────────────────────────────────
  'gpt-5.4-codex': {
    inputCostPerToken: 20 / 1_000_000,   // $20 per 1M input tokens
    outputCostPerToken: 80 / 1_000_000   // $80 per 1M output tokens
  },
  'gpt-5.2-codex': {
    inputCostPerToken: 15 / 1_000_000,   // $15 per 1M input tokens
    outputCostPerToken: 60 / 1_000_000   // $60 per 1M output tokens
  },
  'gpt-5.1-codex-max': {
    inputCostPerToken: 10 / 1_000_000,   // $10 per 1M input tokens
    outputCostPerToken: 40 / 1_000_000   // $40 per 1M output tokens
  },
  'gpt-5.1-codex-mini': {
    inputCostPerToken: 2 / 1_000_000,    // $2 per 1M input tokens
    outputCostPerToken: 8 / 1_000_000    // $8 per 1M output tokens
  },

  // ──────────────────────────────────────────────────────────────────────
  // Google Gemini models
  // ──────────────────────────────────────────────────────────────────────
  'gemini-2.5-pro': {
    inputCostPerToken: 7 / 1_000_000,    // $7 per 1M input tokens
    outputCostPerToken: 21 / 1_000_000   // $21 per 1M output tokens
  },
  'gemini-2.5-flash': {
    inputCostPerToken: 0.5 / 1_000_000,  // $0.50 per 1M input tokens
    outputCostPerToken: 1.5 / 1_000_000  // $1.50 per 1M output tokens
  },
  'gemini-3-pro-preview': {
    inputCostPerToken: 10 / 1_000_000,   // $10 per 1M input tokens
    outputCostPerToken: 30 / 1_000_000   // $30 per 1M output tokens
  },
  'gemini-3-flash-preview': {
    inputCostPerToken: 1 / 1_000_000,    // $1 per 1M input tokens
    outputCostPerToken: 3 / 1_000_000    // $3 per 1M output tokens
  },

  // ──────────────────────────────────────────────────────────────────────
  // Ollama models (local GGUF models — zero cost)
  // ──────────────────────────────────────────────────────────────────────
  'Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf': {
    inputCostPerToken: 0,
    outputCostPerToken: 0
  },
  'Qwen3.5-27B-UD-Q4_K_XL.gguf': {
    inputCostPerToken: 0,
    outputCostPerToken: 0
  }
};

/**
 * Retrieves pricing information for a given model.
 *
 * @param {string} modelId - The model identifier (e.g., 'claude-opus-4-6')
 * @returns {{inputCostPerToken: number, outputCostPerToken: number} | null}
 *          Pricing object with per-token costs, or null if model not found
 *
 * @example
 * const pricing = getPricing('claude-sonnet-4-6');
 * if (pricing) {
 *   const cost = (inputTokens * pricing.inputCostPerToken) +
 *                (outputTokens * pricing.outputCostPerToken);
 * }
 */
export function getPricing(modelId) {
  if (!modelId) {
    return null;
  }

  return pricingTable[modelId] || null;
}

/**
 * Computes the total cost for a dispatch given token counts and model.
 *
 * @param {string} modelId - Model identifier
 * @param {number} inputTokens - Number of input tokens
 * @param {number} outputTokens - Number of output tokens
 * @returns {number | null} Total cost in USD, or null if pricing unavailable
 *
 * @example
 * const cost = computeCost('claude-opus-4-6', 1000, 500);
 * // Returns: (1000 * 0.000015) + (500 * 0.000075) = 0.0525
 */
export function computeCost(modelId, inputTokens, outputTokens) {
  const pricing = getPricing(modelId);
  if (!pricing) {
    return null;
  }

  const input = (inputTokens || 0) * pricing.inputCostPerToken;
  const output = (outputTokens || 0) * pricing.outputCostPerToken;

  return input + output;
}

/**
 * Estimates token count from character count using tokensPerCharRatio.
 * Used as fallback when provider doesn't return token counts.
 *
 * @param {number} charCount - Number of characters
 * @returns {number} Estimated token count
 *
 * @example
 * const estimatedTokens = estimateTokensFromChars(1000);
 * // Returns: 250 (1000 * 0.25)
 */
export function estimateTokensFromChars(charCount) {
  return Math.ceil((charCount || 0) * tokensPerCharRatio);
}

/**
 * Returns all pricing entries in the pricing table.
 *
 * @returns {Array<{modelId: string, inputCostPerToken: number, outputCostPerToken: number}>}
 *          Array of pricing entries with model ID and costs
 *
 * @example
 * const entries = listPricingEntries();
 * // Returns: [
 * //   { modelId: 'claude-opus-4-6', inputCostPerToken: 0.000015, outputCostPerToken: 0.000075 },
 * //   ...
 * // ]
 */
export function listPricingEntries() {
  return Object.entries(pricingTable).map(([modelId, pricing]) => ({
    modelId,
    inputCostPerToken: pricing.inputCostPerToken,
    outputCostPerToken: pricing.outputCostPerToken
  }));
}

/**
 * Returns all model IDs that have pricing data.
 *
 * @returns {string[]} Array of model identifiers
 */
export function getAvailableModels() {
  return Object.keys(pricingTable);
}

/**
 * Checks if a model has pricing data available.
 *
 * @param {string} modelId - Model identifier
 * @returns {boolean} True if pricing exists for this model
 */
export function hasPricing(modelId) {
  return modelId in pricingTable;
}
