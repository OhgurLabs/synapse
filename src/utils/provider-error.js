/**
 * Structured error class for provider-specific errors.
 * Provides machine-readable error signals for intelligent retry and backoff logic.
 */
export class ProviderError extends Error {
  /**
   * @param {string} message - Human-readable error message
   * @param {object} options - Error options
   * @param {number} [options.httpStatus] - HTTP status code (429, 503, 500, etc.)
   * @param {string} [options.errorType] - Provider-specific error type code
   * @param {number} [options.retryAfter] - Retry-after delay in seconds (from header or parsed)
   * @param {string} [options.provider] - Provider name (claude, codex, gemini, ollama)
   * @param {Error} [options.cause] - Original error that caused this error
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.httpStatus = options.httpStatus;
    this.errorType = options.errorType;
    this.retryAfter = options.retryAfter;
    this.provider = options.provider;
  }

  /**
   * Check if this error is transient (may succeed on retry)
   * @returns {boolean}
   */
  isTransient() {
    // MODEL_NOT_FOUND is a configuration error — retrying won't help and
    // would just burn rate-limit budget on the same 404. Explicit non-transient.
    if (this.errorType === 'MODEL_NOT_FOUND') return false;

    // 429 Too Many Requests - always transient
    if (this.httpStatus === 429) return true;

    // 503 Service Unavailable - transient
    if (this.httpStatus === 503) return true;

    // 500-599 server errors - generally transient
    if (this.httpStatus >= 500 && this.httpStatus < 600) return true;

    // Network errors are transient
    if (this.errorType === 'NETWORK_ERROR') return true;

    return false;
  }

  /**
   * Check if this error is a rate limit error
   * @returns {boolean}
   */
  isRateLimited() {
    return this.httpStatus === 429 || this.errorType === 'RATE_LIMIT';
  }

  /**
   * Get recommended retry delay in milliseconds
   * @returns {number|null} - Retry delay in ms, or null if not retryable
   */
  getRetryDelay() {
    if (!this.isTransient()) return null;
    
    // Use explicit retry-after if available
    if (this.retryAfter != null) {
      return this.retryAfter * 1000;
    }
    
    // Default backoff based on error type
    if (this.isRateLimited()) {
      return 60000; // 60 seconds for rate limits
    }
    
    if (this.httpStatus >= 500) {
      return 30000; // 30 seconds for server errors
    }
    
    return 5000; // 5 seconds for other transient errors
  }
}

/**
 * Convert a generic error or string to a structured ProviderError
 * @param {string|Error} error - Error message or Error object
 * @param {object} options - Conversion options
 * @param {string} options.provider - Provider name
   * @param {number} [options.httpStatus] - HTTP status code if known
   * @returns {ProviderError}
 */
export function toProviderError(error, options = {}) {
  const { provider, httpStatus, errorType: explicitErrorType, retryAfter } = options;
  
  if (error instanceof ProviderError) {
    return error;
  }
  
  const message = error instanceof Error ? error.message : String(error);
  
  // Try to infer HTTP status from error message
  let inferredStatus = httpStatus;
  if (!inferredStatus) {
    const statusMatch = message.match(/HTTP\s*(\d{3})/i);
    if (statusMatch) {
      inferredStatus = parseInt(statusMatch[1], 10);
    }
  }
  
  // Try to infer error type from message
  let errorType = explicitErrorType || null;
  if (!errorType && /rate.?limit|too many requests|resource_exhausted|quota exceeded/i.test(message)) {
    errorType = 'RATE_LIMIT';
  } else if (!errorType && (
    /network|connection|timeout|timed out|socket hang up|econnreset|econnrefused|ehostunreach|enetdown|enotfound|dns|packet loss|temporary failure in name resolution|non-existent domain/i.test(message)
  )) {
    errorType = 'NETWORK_ERROR';
  } else if (!errorType && /unavailable|maintenance/i.test(message)) {
    errorType = 'SERVICE_UNAVAILABLE';
  } else if (!errorType && isModelNotFoundMessage(message)) {
    errorType = 'MODEL_NOT_FOUND';
  }

  // For model-not-found errors, replace the raw provider error with an
  // operator-actionable message. The original CLI/SDK message is preserved
  // as `cause` and is still in the log; what the UI sees and the wizard
  // surfaces is the clean version.
  let finalMessage = message;
  if (errorType === 'MODEL_NOT_FOUND') {
    finalMessage = rewriteModelNotFound(message, provider);
  }

  return new ProviderError(finalMessage, {
    httpStatus: inferredStatus,
    errorType,
    retryAfter,
    provider,
    cause: error instanceof Error ? error : undefined,
  });
}

/**
 * Detect "model not found" / "model not recognized by this account" errors
 * across the providers Synapse currently supports. Add patterns here when
 * a new provider's CLI surfaces an unrecognized-model error.
 */
function isModelNotFoundMessage(message) {
  if (!message) return false;
  const m = String(message);
  return (
    // Gemini CLI: `ModelNotFoundError: Requested entity was not found.` (+ code: 404)
    /ModelNotFoundError|Requested entity was not found/i.test(m) ||
    // Codex CLI (ChatGPT account): `The 'gpt-5' model is not supported when using Codex with a ChatGPT account.`
    /is not supported when using Codex with a ChatGPT account/i.test(m) ||
    // Anthropic SDK style: `model: not_found` / `model_not_found`
    /\bmodel(?:[ _]not[ _]found|: not_found)\b/i.test(m) ||
    // opencode "Model not found: <id>"
    /^[\s>]*Error:?\s*Model not found:/i.test(m) ||
    // Ollama-style "model '<id>' not found"
    /model ['"][^'"]+['"]\s+not\s+found/i.test(m)
  );
}

/**
 * Turn a raw provider error into an operator-actionable message. Tries to
 * pull the offending model id out of the original text so the operator can
 * see exactly which model name was wrong without having to dig through logs.
 */
function rewriteModelNotFound(message, provider) {
  const m = String(message || '');
  // Try to extract the model id from each known pattern. Quoted patterns are
  // anchor-safe; unquoted patterns capture greedily up to whitespace, then
  // we trim trailing punctuation so a sentence-ending period doesn't truncate
  // a model id that legitimately contains dots (e.g. "glm-4.6" vs "glm-4.6.").
  const patterns = [
    /The ['"]([^'"]+)['"] model is not supported/i,
    /model ['"]([^'"]+)['"]\s+not\s+found/i,
    /Model not found:\s*(\S+)/i,
    /unknown model[: ]+(\S+)/i,
  ];
  let modelId = null;
  for (const p of patterns) {
    const match = m.match(p);
    if (match && match[1]) {
      modelId = match[1].replace(/[.,;:]+$/, '');
      break;
    }
  }
  const target = modelId ? `Model "${modelId}"` : 'The configured model';
  const prov = provider ? ` for provider "${provider}"` : '';
  return `${target}${prov} was not recognized. Check the agent's model name in Settings — typos or unreleased model identifiers fail at first dispatch.`;
}
