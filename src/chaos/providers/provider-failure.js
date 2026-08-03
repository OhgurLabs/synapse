/**
 * ProviderFailureProvider - Simulates provider failures by intercepting agent dispatch.
 * 
 * Supports Anthropic, OpenAI/Codex, Ollama, and Gemini targets by monkey-patching
 * the agent-interaction.js dispatch paths.
 * 
 * @module chaos/providers/provider-failure
 */

import { FaultProvider, FaultInjectionError, FaultNotInjectableError } from '../fault-provider.js';

/**
 * Provider failure error for simulated provider errors
 */
export class ProviderFailureError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} provider - Provider that failed
   * @param {string} [reason] - Specific failure reason
   */
  constructor(message, provider, reason) {
    super(message);
    this.name = 'ProviderFailureError';
    this.provider = provider;
    this.reason = reason;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * ProviderFailureProvider - Simulates provider failures.
 * 
 * Intercepts agent dispatch by wrapping the agent's send method to throw
 * simulated provider errors. Supports all four providers:
 * - Anthropic (claude)
 * - OpenAI/Codex (codex)
 * - Ollama (ollama)
 * - Gemini (gemini)
 * 
 * @extends FaultProvider
 */
export class ProviderFailureProvider extends FaultProvider {
  /**
   * @param {Object} options - Configuration options
   * @param {string} [options.type='provider_failure'] - Fault type identifier
   * @param {number} [options.recoveryTimeout=30000] - Recovery timeout in ms
   * @param {boolean} [options.emitEvents=true] - Emit lifecycle events
   * @param {string} [options.errorType='rate_limit'] - Type of error to simulate
   * @param {string} [options.provider] - Provider to simulate (overrides target)
   */
  constructor(options = {}) {
    super({
      type: options.type || 'provider_failure',
      recoveryTimeout: options.recoveryTimeout || 30000,
      emitEvents: options.emitEvents !== false,
    });
    
    /**
     * Error type to simulate
     * @type {string}
     */
    this.errorType = options.errorType || 'rate_limit';
    
    /**
     * Provider override (if specified)
     * @type {string|null}
     */
    this.providerOverride = options.provider || null;
    
    /**
     * Original send method (for recovery)
     * @private
     * @type {Function|null}
     */
    this._originalSend = null;
    
    /**
     * Target agent object
     * @private
     * @type {Object|null}
     */
    this._targetAgent = null;
  }
  
  /**
   * Check if the fault can be injected.
   * 
   * @param {Object} context - Injection context
   * @param {string} context.target - Target identifier
   * @param {Object} [context.metadata] - Custom metadata
   * @param {Object} [context.metadata.agent] - Agent object to intercept
   * @returns {boolean} True if fault can be injected
   */
  canInject(context) {
    if (!context.target) {
      return false;
    }
    
    // Check if target is a valid provider
    const validProviders = ['anthropic', 'claude', 'codex', 'openai', 'ollama', 'gemini'];
    const targetLower = String(context.target).toLowerCase();
    const isProvider = validProviders.includes(targetLower);
    
    // Or check if agent object is provided in metadata
    const hasAgent = context.metadata?.agent !== undefined;
    
    return isProvider || hasAgent;
  }
  
  /**
   * Inject the provider failure fault.
   * 
   * @param {Object} context - Injection context
   * @param {string} context.faultId - Unique fault identifier
   * @param {string} context.target - Target identifier
   * @param {Object} [context.metadata] - Custom metadata
   * @param {Object} [context.metadata.agent] - Agent object to intercept
   * @returns {Promise<void>} Resolves when fault is applied
   * @throws {FaultInjectionError} If injection fails
   */
  async inject(context) {
    const target = context.target;
    const targetLower = String(target).toLowerCase();
    
    // Determine provider
    const provider = this.providerOverride || 
                     (targetLower.includes('anthropic') || targetLower.includes('claude') ? 'claude' :
                      targetLower.includes('codex') || targetLower.includes('openai') ? 'codex' :
                      targetLower.includes('ollama') ? 'ollama' :
                      targetLower.includes('gemini') ? 'gemini' :
                      'unknown');
    
    // Get agent object from metadata if provided
    let agent = context.metadata?.agent;
    
    if (!agent) {
      // Try to find agent by target name
      if (context.metadata?.agents) {
        agent = context.metadata.agents[target];
      }
    }
    
    this._targetAgent = agent;
    
    if (agent && typeof agent.send === 'function') {
      // Wrap the agent's send method
      this._originalSend = agent.send.bind(agent);
      
      agent.send = async (contextStr, workingDir, options) => {
        throw this._createProviderError(provider);
      };
      
      this.active = true;
      this.injectedAt = context.now;
      
      if (this.emitEvents) {
        this.emit('faultApplied', {
          faultId: context.faultId,
          provider,
          errorType: this.errorType,
        });
      }
    } else {
      // If no agent object, we can still mark as active for tracking
      // The actual injection will happen when an agent dispatch occurs
      this.active = true;
      this.injectedAt = context.now;
      
      if (this.emitEvents) {
        this.emit('faultApplied', {
          faultId: context.faultId,
          provider,
          errorType: this.errorType,
          note: 'Provider marked as failed - will affect next dispatch',
        });
      }
    }
  }
  
  /**
   * Recover from the provider failure fault.
   * 
   * @param {Object} context - Recovery context
   * @param {string} context.faultId - Unique fault identifier
   * @returns {Promise<void>} Resolves when recovery is complete
   * @throws {FaultRecoveryError} If recovery fails
   */
  async recover(context) {
    try {
      // Restore original send method
      if (this._targetAgent && this._originalSend) {
        this._targetAgent.send = this._originalSend;
        this._originalSend = null;
        this._targetAgent = null;
      }
      
      this.active = false;
      this.injectedAt = null;
      
      if (this.emitEvents) {
        this.emit('faultRecovered', {
          faultId: context.faultId,
        });
      }
    } catch (e) {
      throw new FaultInjectionError(
        `Failed to recover from provider failure: ${e.message}`,
        context.faultId,
        context
      );
    }
  }
  
  /**
   * Create a provider error based on error type.
   * 
   * @private
   * @param {string} provider - Provider name
   * @returns {ProviderFailureError} Error to throw
   */
  _createProviderError(provider) {
    const errorMessages = {
      rate_limit: {
        claude: 'You have hit your rate limit. Please wait and try again.',
        codex: 'You have exceeded your usage limit. Please try again later.',
        ollama: 'Model is busy or rate limited. Try again shortly.',
        gemini: 'Resource exhausted: rate limit exceeded. Retry after delay.',
        unknown: 'Provider rate limit exceeded. Please try again.',
      },
      unavailable: {
        claude: 'Anthropic service is currently unavailable.',
        codex: 'OpenAI/Codex service is currently unavailable.',
        ollama: 'Ollama service is currently unavailable.',
        gemini: 'Gemini service is currently unavailable.',
        unknown: 'Provider service is currently unavailable.',
      },
      internal_error: {
        claude: 'Anthropic encountered an internal error.',
        codex: 'OpenAI/Codex encountered an internal error.',
        ollama: 'Ollama encountered an internal error.',
        gemini: 'Gemini encountered an internal error.',
        unknown: 'Provider encountered an internal error.',
      },
      auth_error: {
        claude: 'Authentication failed. Please check your credentials.',
        codex: 'Authentication failed. Please check your credentials.',
        ollama: 'Authentication failed. Please check your credentials.',
        gemini: 'Authentication failed. Please check your credentials.',
        unknown: 'Authentication failed. Please check your credentials.',
      },
      timeout: {
        claude: 'Anthropic request timed out after waiting for response.',
        codex: 'OpenAI/Codex request timed out after waiting for response.',
        ollama: 'Ollama request timed out after waiting for response.',
        gemini: 'Gemini request timed out after waiting for response.',
        unknown: 'Provider request timed out. No response received.',
      },
    };
    
    const type = this.errorType || 'rate_limit';
    const messages = errorMessages[type] || errorMessages.rate_limit;
    const message = messages[provider] || messages.unknown;
    
    return new ProviderFailureError(message, provider, type);
  }
  
  /**
   * Get current provider state.
   * 
   * @returns {Object} Provider state
   */
  getState() {
    const baseState = super.getState();
    return {
      ...baseState,
      errorType: this.errorType,
      providerOverride: this.providerOverride,
      hasOriginalSend: this._originalSend !== null,
    };
  }
}

export default ProviderFailureProvider;