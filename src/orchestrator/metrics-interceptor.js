/**
 * MetricsInterceptor - Wraps dispatch calls to automatically record metrics.
 *
 * Follows the fire-and-forget resilient persistence pattern from dispatch.js lines 478-516.
 * Metrics recording failures NEVER block or fail the dispatch operation.
 *
 * Usage:
 *   const interceptor = new MetricsInterceptor(metricsStore);
 *   const wrappedDispatch = interceptor.wrapDispatch(dispatch);
 *   const result = await wrappedDispatch(options);
 */

export class MetricsInterceptor {
  /**
   * Create a new MetricsInterceptor.
   * @param {object} metricsStore - MetricsStore instance for recording metrics
   */
  constructor(metricsStore) {
    if (!metricsStore) {
      throw new Error('MetricsInterceptor requires a MetricsStore instance');
    }
    this.metricsStore = metricsStore;
  }

  /**
   * Wrap a dispatch function to automatically record metrics.
   *
   * @param {Function} dispatchFn - The dispatch function to wrap
   * @returns {Function} Wrapped dispatch function with same signature
   */
  wrapDispatch(dispatchFn) {
    const metricsStore = this.metricsStore;

    return async function wrappedDispatch(options) {
      const startTime = performance.now();
      let dispatchResult = null;
      let dispatchError = null;

      try {
        // Call the original dispatch function
        dispatchResult = await dispatchFn(options);
        return dispatchResult;
      } catch (error) {
        dispatchError = error;
        throw error;
      } finally {
        // Calculate latency
        const endTime = performance.now();
        const latencyMs = endTime - startTime;

        // Extract metrics from dispatch context and result
        // Fire-and-forget: metrics recording NEVER blocks the dispatch
        try {
          const metrics = extractMetrics(options, dispatchResult, latencyMs);

          // Record metric asynchronously without awaiting
          // This ensures we never delay the dispatch return
          metricsStore.recordMetric(metrics);
        } catch (err) {
          // Metrics extraction or recording failed
          // Log the error but never propagate it to the caller
          // This mirrors the pattern from dispatch.js lines 494-498, 508-512
          if (typeof console !== 'undefined' && console.error) {
            console.error('[MetricsInterceptor] Failed to record metric:', err.message || String(err));
          }
        }
      }
    };
  }

  /**
   * Manually record a metric with explicit parameters.
   * Useful for cases where the caller wants explicit control over metric data.
   *
   * @param {object} params - Metric parameters
   * @param {string} params.dispatchId - Unique dispatch identifier
   * @param {string} params.agentId - Agent identifier
   * @param {string} [params.campaignId] - Campaign identifier (optional)
   * @param {string} params.model - Model identifier (e.g., 'gpt-4', 'claude-3-opus')
   * @param {number} [params.inputTokens=0] - Input token count
   * @param {number} [params.outputTokens=0] - Output token count
   * @param {number} params.latencyMs - Latency in milliseconds
   */
  recordManual({ dispatchId, agentId, campaignId, model, inputTokens, outputTokens, latencyMs }) {
    if (!dispatchId || !agentId || !model || latencyMs === undefined) {
      throw new Error('recordManual requires dispatchId, agentId, model, and latencyMs');
    }

    this.metricsStore.recordMetric({
      dispatchId,
      agentId,
      campaignId: campaignId || null,
      model,
      inputTokens: inputTokens || 0,
      outputTokens: outputTokens || 0,
      latencyMs
    });
  }
}

/**
 * Extract metrics from dispatch options and result.
 *
 * @param {object} options - Original dispatch options
 * @param {object} result - Dispatch result (may be null if dispatch failed)
 * @param {number} latencyMs - Measured latency
 * @returns {object} Metrics object for recordMetric()
 */
function extractMetrics(options, result, latencyMs) {
  // Extract core identifiers from dispatch options
  const dispatchId = options.taskId || options.traceId || result?.traceId || 'unknown';
  const campaignId = options.campaignId || null;

  // Extract agent ID from plan (primary agent is the main executor)
  const agentId = options.plan?.primary || options.agentId || 'unknown';

  // Extract model from options or plan
  // Model might be in options.model, plan.model, or a default
  const model = options.model || options.plan?.model || 'unknown';

  // Extract token counts from result
  // LLM responses typically return usage info in result.usage or nested deeper
  let inputTokens = 0;
  let outputTokens = 0;

  if (result) {
    // Check common locations for token usage data
    const usage = result.usage || result.result?.usage || result.primary?.usage;

    if (usage) {
      inputTokens = usage.input_tokens || usage.inputTokens || usage.prompt_tokens || 0;
      outputTokens = usage.output_tokens || usage.outputTokens || usage.completion_tokens || 0;
    }
  }

  return {
    dispatchId,
    agentId,
    campaignId,
    model,
    inputTokens,
    outputTokens,
    latencyMs
  };
}
