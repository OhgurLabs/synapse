/**
 * RateLimitProvider - Simulates rate limits for AI providers.
 * 
 * Honors RATE_LIMIT_SEMANTICS from agent-interaction.js:
 * - Codex: Single shared bucket for all models + web (propagate per-provider)
 * - Claude: Multiple buckets (Sonnet, all-model, 5-hour, weekly) - NOT per-model
 * - Gemini: Per-model rate limits, web separate from models (NO propagation)
 * - Ollama: No rate limits (local inference)
 * 
 * @module chaos/providers/rate-limit
 */

import { FaultProvider, FaultInjectionError } from '../fault-provider.js';

/**
 * Rate limit error for simulated rate limits
 */
export class RateLimitError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} provider - Provider that rate limited
   * @param {string} [model] - Model that was rate limited
   * @param {number} [retryAfter] - Seconds to wait before retrying
   */
  constructor(message, provider, model, retryAfter) {
    super(message);
    this.name = 'RateLimitError';
    this.provider = provider;
    this.model = model;
    this.retryAfter = retryAfter;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * RateLimitProvider - Simulates rate limits.
 * 
 * Implements provider-specific rate limit bucket semantics:
 * - Codex: Provider-wide bucket (all codex agents share one subscription pool)
 * - Claude: Per-model bucket (opus vs sonnet are separate buckets)
 * - Gemini: Per-agent bucket (each Gemini agent has independent limits)
 * - Ollama: No rate limits (local inference)
 * 
 * @extends FaultProvider
 */
export class RateLimitProvider extends FaultProvider {
  /**
   * @param {Object} options - Configuration options
   * @param {string} [options.type='rate_limit'] - Fault type identifier
   * @param {number} [options.recoveryTimeout=60000] - Recovery timeout in ms
   * @param {boolean} [options.emitEvents=true] - Emit lifecycle events
   * @param {string} [options.provider] - Provider to simulate (claude, codex, gemini, ollama)
   * @param {string} [options.model] - Model to simulate (for Claude per-model buckets)
   * @param {string} [options.agentId] - Agent ID to simulate (for Gemini per-agent buckets)
   * @param {number} [options.retryAfter] - Seconds to wait before retrying (default: 60)
   * @param {boolean} [options.persistentExhaustion=false] - If true, simulate multi-hour 429s (effectively indefinite)
   */
  constructor(options = {}) {
    super({
      type: options.type || 'rate_limit',
      recoveryTimeout: options.recoveryTimeout || 60000,
      emitEvents: options.emitEvents !== false,
    });
    
    /**
     * Provider to simulate
     * @type {string}
     */
    this.provider = options.provider || 'claude';
    
    /**
     * Model to simulate (for Claude per-model buckets)
     * @type {string|null}
     */
    this.model = options.model || null;
    
    /**
     * Agent ID to simulate (for Gemini per-agent buckets)
     * @type {string|null}
     */
    this.agentId = options.agentId || null;
    
    /**
     * Retry after seconds
     * @type {number}
     */
    this.retryAfter = options.retryAfter || 60;

    /**
     * If true, simulate multi-hour 429s (effectively indefinite)
     * @type {boolean}
     */
    this.persistentExhaustion = options.persistentExhaustion || false;
    
    /**
     * Original rate limit check function (for recovery)
     * @private
     * @type {Function|null}
     */
    this._originalCheckFunction = null;
    
    /**
     * Target object for monkey-patching
     * @private
     * @type {Object|null}
     */
    this._targetObject = null;
  }
  
  /**
   * Check if the fault can be injected.
   * 
   * @param {Object} context - Injection context
   * @param {string} context.target - Target identifier
   * @param {Object} [context.metadata] - Custom metadata
   * @param {Object} [context.metadata.agents] - Map of agents
   * @param {Object} [context.metadata.config] - Config object with RATE_LIMIT_SEMANTICS
   * @returns {boolean} True if fault can be injected
   */
  canInject(context) {
    if (!context.target) {
      return false;
    }
    
    // Ollama has no rate limits
    if (this.provider === 'ollama') {
      return false;
    }
    
    const validProviders = ['claude', 'codex', 'gemini', 'anthropic', 'openai'];
    const targetLower = String(context.target).toLowerCase();
    const isProvider = validProviders.includes(targetLower);
    
    // Check if we have agents to inject into
    const hasAgents = context.metadata?.agents !== undefined;
    
    // Check if we have a config with rate limit semantics
    const hasConfig = context.metadata?.config !== undefined;
    
    return isProvider || hasAgents || hasConfig;
  }
  
  /**
   * Inject the rate limit fault.
   * 
   * @param {Object} context - Injection context
   * @param {string} context.faultId - Unique fault identifier
   * @param {string} context.target - Target identifier
   * @param {Object} [context.metadata] - Custom metadata
   * @returns {Promise<void>} Resolves when fault is applied
   * @throws {FaultInjectionError} If injection fails
   */
  async inject(context) {
    const target = context.target;
    const targetLower = String(target).toLowerCase();
    
    // Determine provider if not explicitly set
    if (!this.provider) {
      this.provider = targetLower.includes('anthropic') || targetLower.includes('claude') ? 'claude' :
                      targetLower.includes('codex') || targetLower.includes('openai') ? 'codex' :
                      targetLower.includes('gemini') ? 'gemini' :
                      'claude';
    }
    
    // Determine model and agent from target
    if (!this.model && target.includes('-')) {
      const parts = target.split('-');
      if (parts.length >= 2) {
        this.model = parts.slice(-2).join('-');
      }
    }
    
    if (!this.agentId && target.includes('/')) {
      this.agentId = target.split('/').pop();
    }
    
    // Get agents from metadata if provided
    const agents = context.metadata?.agents;
    
    if (agents) {
      // Inject into specific agent or all agents of the provider
      const targetAgent = agents[target] || 
                          Object.values(agents).find(a => 
                            a.provider === this.provider || 
                            a.provider === targetLower
                          );
      
      if (targetAgent && typeof targetAgent.send === 'function') {
        this._targetObject = targetAgent;
        this._originalCheckFunction = targetAgent.send;
        
        targetAgent.send = async (contextStr, workingDir, options) => {
          throw this._createRateLimitError();
        };
        
        this.active = true;
        this.injectedAt = context.now;
        
        if (this.emitEvents) {
          this.emit('faultApplied', {
            faultId: context.faultId,
            provider: this.provider,
            model: this.model,
            agentId: this.agentId,
            retryAfter: this.retryAfter,
            persistentExhaustion: this.persistentExhaustion,
          });
        }
        
        return;
      }
    }
    
    // If no agent object, mark as active for tracking
    this.active = true;
    this.injectedAt = context.now;
    
    if (this.emitEvents) {
      this.emit('faultApplied', {
        faultId: context.faultId,
        provider: this.provider,
        model: this.model,
        agentId: this.agentId,
        retryAfter: this.retryAfter,
        persistentExhaustion: this.persistentExhaustion,
        note: 'Rate limit marked - will affect next dispatch',
      });
    }
  }
  
  /**
   * Recover from the rate limit fault.
   * 
   * @param {Object} context - Recovery context
   * @param {string} context.faultId - Unique fault identifier
   * @returns {Promise<void>} Resolves when recovery is complete
   * @throws {FaultRecoveryError} If recovery fails
   */
  async recover(context) {
    try {
      // Restore original send method
      if (this._targetObject && this._originalCheckFunction) {
        this._targetObject.send = this._originalCheckFunction;
        this._originalCheckFunction = null;
        this._targetObject = null;
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
        `Failed to recover from rate limit: ${e.message}`,
        context.faultId,
        context
      );
    }
  }
  
  /**
   * Create a rate limit error based on provider semantics.
   * 
   * @private
   * @returns {RateLimitError} Error to throw
   */
  _createRateLimitError() {
    const provider = this.provider;
    const model = this.model || 'unknown';
    const agentId = this.agentId;
    const retryAfter = this.persistentExhaustion ? Number.MAX_SAFE_INTEGER : this.retryAfter;
    
    const messages = {
      claude: model.includes('opus') 
        ? `Claude Opus rate limit exceeded. Reset in ${retryAfter}s.`
        : `Claude rate limit exceeded (${model}). Reset in ${retryAfter}s.`,
      codex: `Codex rate limit exceeded. Shared bucket for all models. Reset in ${retryAfter}s.`,
      gemini: agentId
        ? `Gemini rate limit for ${agentId}. Reset in ${retryAfter}s.`
        : `Gemini rate limit exceeded. Reset in ${retryAfter}s.`,
      anthropic: `Anthropic rate limit exceeded. Reset in ${retryAfter}s.`,
      openai: `OpenAI rate limit exceeded. Reset in ${retryAfter}s.`,
    };
    
    const message = messages[provider] || messages.claude;
    
    return new RateLimitError(message, provider, model, retryAfter);
  }
  
  /**
   * Get current rate limit state.
   * 
   * @returns {Object} Rate limit state
   */
  getState() {
    const baseState = super.getState();
    return {
      ...baseState,
      provider: this.provider,
      model: this.model,
      agentId: this.agentId,
      retryAfter: this.retryAfter,
      persistentExhaustion: this.persistentExhaustion,
      hasOriginalFunction: this._originalCheckFunction !== null,
    };
  }
}

export default RateLimitProvider;