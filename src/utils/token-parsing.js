/**
 * Shared token parsing utilities for agent drivers.
 *
 * Provides:
 *  - estimateTokens(text): chars/4 heuristic fallback for token estimation
 *
 * This module implements a simple character-based heuristic to estimate
 * token counts when the provider CLI does not expose token information.
 * The chars/4 ratio is a widely-used approximation (roughly 4 characters per token).
 */

/**
 * Estimate token count from raw text using the chars/4 heuristic.
 * 
 * @param {string} text - The text to estimate tokens for
 * @returns {{inputTokens: number, outputTokens: number, confidence: 'estimated'}}
 *          Returns inputTokens (0), outputTokens (estimated), and confidence field.
 */
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') {
    return { inputTokens: 0, outputTokens: 0, confidence: 'estimated' };
  }

  const estimatedOutput = Math.ceil(text.length / 4);
  
  return {
    inputTokens: 0,
    outputTokens: estimatedOutput,
    confidence: 'estimated',
  };
}

/**
 * Estimate token count with separate input/output estimation.
 * 
 * @param {string} text - The text to estimate tokens for
 * @param {number} [inputText] - Optional input text for input token estimation
 * @returns {{inputTokens: number, outputTokens: number, confidence: 'estimated'}}
 */
export function estimateTokenCounts(inputText = '', outputText = '') {
  const inputEstimate = inputText && typeof inputText === 'string' 
    ? Math.ceil(inputText.length / 4) 
    : 0;
  
  const outputEstimate = outputText && typeof outputText === 'string'
    ? Math.ceil(outputText.length / 4)
    : 0;

  return {
    inputTokens: inputEstimate,
    outputTokens: outputEstimate,
    confidence: 'estimated',
  };
}
