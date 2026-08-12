/**
 * Shared token parsing utilities for agent drivers.
 *
 * Provides:
 *  - estimateTokensFromText(text): chars/4 heuristic fallback
 *  - ResponseObject: backward-compatible result wrapper with toString()
 */

/**
 * Estimate token count from raw text using the chars/4 heuristic.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokensFromText(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Backward-compatible response object returned by agent send() methods.
 *
 * Callers that treat the result as a string will get the response text via
 * toString() / string coercion (template literals, concatenation, etc.).
 */
export class ResponseObject {
  /**
   * @param {object} fields
   * @param {string}  fields.text          - The response text
   * @param {number}  fields.inputTokens   - Input token count
   * @param {number}  fields.outputTokens  - Output token count
   * @param {string}  fields.model         - Model identifier
   * @param {string}  fields.provider      - Provider name (e.g. 'claude', 'gemini')
   * @param {'exact'|'estimated'} fields.confidence
   * @param {string|null} [fields.sessionId] - Harness session identifier, when the
   *   harness emits one. Carried so a later dispatch in the same task series can
   *   resume instead of starting cold.
   */
  constructor({ text, inputTokens, outputTokens, model, provider, confidence, sessionId }) {
    this.text = text ?? '';
    this.inputTokens = inputTokens ?? 0;
    this.outputTokens = outputTokens ?? 0;
    this.model = model ?? '';
    this.provider = provider ?? '';
    this.confidence = confidence ?? 'estimated';
    // This constructor DESTRUCTURES a fixed field list, so anything not named
    // here is silently dropped. That is why the harness sessionId never reached
    // the orchestrator even though cli-runner has always parsed it: adding it at
    // the call site alone would have been a no-op with no error. Producers that
    // do not supply one (glm.js) simply get null.
    this.sessionId = sessionId ?? null;
  }

  toString() {
    return this.text;
  }

  // Delegate String.prototype methods so callers can use response.match(), .includes(), etc.
  match(...args) { return this.text.match(...args); }
  replace(...args) { return this.text.replace(...args); }
  includes(...args) { return this.text.includes(...args); }
  split(...args) { return this.text.split(...args); }
  trim() { return this.text.trim(); }
  startsWith(...args) { return this.text.startsWith(...args); }
  substring(...args) { return this.text.substring(...args); }
  slice(...args) { return this.text.slice(...args); }
  indexOf(...args) { return this.text.indexOf(...args); }
  lastIndexOf(...args) { return this.text.lastIndexOf(...args); }

  // Support JSON serialisation without losing the text field
  toJSON() {
    return {
      text: this.text,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      model: this.model,
      provider: this.provider,
      confidence: this.confidence,
    };
  }
}
