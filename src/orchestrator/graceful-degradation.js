/**
 * Graceful Degradation Handler
 *
 * Handles system behavior when all providers in a capability category have
 * open circuit breakers. Prevents system lockup by pausing work queue instead
 * of crashing or looping.
 *
 * Key behaviors:
 * - Detects when all providers for a capability category are unavailable (CB open)
 * - Pauses work queue for that category (does not crash/loop)
 * - Provides clear status and recovery expectations
 * - Monitors for provider recovery and automatically resumes when capacity available
 * - Logs manual intervention triggers
 */

import { createLogger } from '../logger.js';
import { STATES } from './circuit-breaker.js';

const log = createLogger('graceful-degradation');

/**
 * Capability category definitions - maps roles to provider types
 */
export const CAPABILITY_CATEGORIES = Object.freeze({
  // Code execution roles - need execution-capable providers
  code_execution: ['claude', 'codex', 'ollama', 'gemini'],
  
  // Architecture roles - prefer Claude but can use others
  architecture: ['claude', 'codex', 'gemini', 'ollama'],
  
  // Review roles - multiple providers available
  review: ['claude', 'codex', 'gemini', 'ollama'],
  
  // Development roles - execution focused
  development: ['claude', 'codex', 'ollama', 'gemini'],
  
  // Research roles - prefer Gemini
  research: ['gemini', 'claude', 'codex', 'ollama'],
  
  // Ops roles - can use any provider
  ops: ['claude', 'codex', 'gemini', 'ollama'],
  
  // Developer role
  developer: ['claude', 'codex', 'ollama', 'gemini'],
  
  // Researcher role
  researcher: ['gemini', 'claude', 'codex', 'ollama'],
  
  // Any available fallback
  any: ['claude', 'codex', 'gemini', 'ollama'],
});

/**
 * GracefulDegradationHandler manages system-wide degradation state
 * and coordinates work queue pausing/resuming based on provider availability
 */
export class GracefulDegradationHandler {
  /**
   * @param {object} opts
   * @param {import('./circuit-breaker.js').CircuitBreaker} opts.circuitBreaker - Circuit breaker instance
   * @param {Function} opts.onPauseWork - Callback to pause work queue for category
   * @param {Function} opts.onResumeWork - Callback to resume work queue for category
   * @param {number} opts.checkIntervalMs - How often to check for recovery (default: 5s)
   */
  constructor({
    circuitBreaker,
    onPauseWork,
    onResumeWork,
    checkIntervalMs = 5000,
  } = {}) {
    this._circuitBreaker = circuitBreaker;
    this._onPauseWork = onPauseWork;
    this._onResumeWork = onResumeWork;
    this._checkIntervalMs = checkIntervalMs;
    
    // category → { paused: boolean, pausedAt: number, reason: string, recovering: boolean }
    this._degradedCategories = new Map();
    
    // Recovery check interval
    this._recoveryCheckInterval = null;
    
    // Manual intervention tracking
    this._manualInterventionTriggers = [];
  }
  
  /**
   * Start monitoring for degradation conditions
   */
  start() {
    if (this._recoveryCheckInterval) return;
    
    log.info('Starting graceful degradation monitoring');
    this._recoveryCheckInterval = setInterval(() => {
      this._checkRecovery();
    }, this._checkIntervalMs);
  }
  
  /**
   * Stop monitoring
   */
  stop() {
    if (this._recoveryCheckInterval) {
      clearInterval(this._recoveryCheckInterval);
      this._recoveryCheckInterval = null;
      log.info('Stopped graceful degradation monitoring');
    }
  }
  
  /**
   * Check if a specific category is degraded
   * @param {string} category - Capability category to check
   * @returns {boolean}
   */
  isCategoryDegraded(category) {
    return this._degradedCategories.has(category) && 
           this._degradedCategories.get(category).paused;
  }
  
  /**
   * Get degradation status for a category
   * @param {string} category
   * @returns {{ paused: boolean, pausedAt: number|null, reason: string|null, recovering: boolean }}
   */
  getCategoryStatus(category) {
    const status = this._degradedCategories.get(category);
    if (!status) {
      return { paused: false, pausedAt: null, reason: null, recovering: false };
    }
    return status;
  }
  
  /**
   * Get all degraded categories
   * @returns {Array<{ category: string, status: Object }>}
   */
  getDegradedCategories() {
    const result = [];
    for (const [category, status] of this._degradedCategories) {
      if (status.paused) {
        result.push({ category, status });
      }
    }
    return result;
  }
  
  /**
   * Check all categories for degradation and apply appropriate handling
   */
  _checkRecovery() {
    for (const [category, status] of this._degradedCategories) {
      if (status.paused && !status.recovering) {
        // Check if any provider in this category is now available
        const providers = CAPABILITY_CATEGORIES[category] || CAPABILITY_CATEGORIES.any;
        const hasAvailableProvider = providers.some(provider => {
          if (!this._circuitBreaker) return false;
          return this._circuitBreaker.canRequest(provider);
        });
        
        if (hasAvailableProvider) {
          log.info('Recovery detected for category', { category });
          status.recovering = true;
          this._resumeCategory(category);
        }
      }
    }
  }
  
  /**
   * Check if any category is degraded and needs attention
   * @returns {boolean}
   */
  hasDegradedCategories() {
    return this.getDegradedCategories().length > 0;
  }
  
  /**
   * Evaluate degradation state for a category based on provider availability
   * @param {string} category - Capability category to evaluate
   * @param {string[]} availableProviders - Currently available providers
   * @returns {{ degraded: boolean, reason: string|null, availableCount: number }}
   */
  evaluateCategoryDegradation(category, availableProviders = null) {
    const providers = CAPABILITY_CATEGORIES[category] || CAPABILITY_CATEGORIES.any;
    
    // If no circuit breaker, use availableProviders filter
    if (!this._circuitBreaker) {
      const availableCount = providers.filter(p => availableProviders?.includes(p)).length;
      const degraded = availableCount === 0;
      
      return {
        degraded,
        reason: degraded ? `No providers available: ${providers.join(', ')}` : null,
        availableCount,
      };
    }
    
    // Check circuit breaker state for each provider
    const openCBProviders = [];
    let availableCount = 0;
    
    for (const provider of providers) {
      const state = this._circuitBreaker.getState(provider);
      if (state === STATES.OPEN) {
        openCBProviders.push(provider);
      } else {
        availableCount++;
      }
    }
    
    const degraded = availableCount === 0;
    
    return {
      degraded,
      reason: degraded 
        ? `All providers in category "${category}" have open circuit breakers: ${openCBProviders.join(', ')}`
        : null,
      availableCount,
    };
  }
  
  /**
   * Apply degradation handling for a category
   * @param {string} category
   * @param {object} context - Additional context
   */
  applyDegradation(category, context = {}) {
    const evaluation = this.evaluateCategoryDegradation(category);
    
    if (!evaluation.degraded) {
      return { applied: false, reason: 'Category not degraded' };
    }
    
    // Check if already degraded
    const existingStatus = this._degradedCategories.get(category);
    if (existingStatus && existingStatus.paused) {
      return { applied: false, reason: 'Already degraded' };
    }
    
    // Apply degradation
    const status = {
      paused: true,
      pausedAt: Date.now(),
      reason: evaluation.reason,
      recovering: false,
      availableProviders: evaluation.availableCount,
      affectedProviders: context.affectedProviders || [],
    };
    
    this._degradedCategories.set(category, status);
    
    // Notify work queue to pause
    if (this._onPauseWork) {
      try {
        this._onPauseWork(category, status);
      } catch (err) {
        log.error('Failed to pause work for category', { category, error: err.message });
      }
    }
    
    log.warn('Category degraded - work paused', {
      category,
      reason: evaluation.reason,
      availableProviders: evaluation.availableCount,
    });
    
    // Track manual intervention trigger if needed
    this._trackInterventionTrigger(category, status);
    
    return { applied: true, status };
  }
  
  /**
   * Resume work for a category
   * @param {string} category
   */
  resumeCategory(category) {
    this._resumeCategory(category);
  }
  
  /**
   * Internal resume handler
   * @param {string} category
   */
  _resumeCategory(category) {
    const status = this._degradedCategories.get(category);
    if (!status || !status.paused) {
      return { resumed: false, reason: 'Category not degraded' };
    }
    
    status.paused = false;
    status.resumedAt = Date.now();
    status.recovering = false;
    
    // Notify work queue to resume
    if (this._onResumeWork) {
      try {
        this._onResumeWork(category);
      } catch (err) {
        log.error('Failed to resume work for category', { category, error: err.message });
      }
    }
    
    log.info('Category recovered - work resumed', { category });
    
    return { resumed: true, status };
  }
  
  /**
   * Force resume a category (bypass recovery check)
   * @param {string} category
   */
  forceResume(category) {
    const status = this._degradedCategories.get(category);
    if (status) {
      status.paused = false;
      status.resumedAt = Date.now();
      status.recovering = false;
    }
    
    if (this._onResumeWork) {
      this._onResumeWork(category);
    }
    
    return { resumed: true };
  }
  
  /**
   * Track manual intervention triggers
   * @param {string} category
   * @param {object} status
   */
  _trackInterventionTrigger(category, status) {
    const trigger = {
      category,
      triggeredAt: Date.now(),
      reason: status.reason,
      severity: this._calculateSeverity(category, status),
      manualActionsRequired: this._getRequiredManualActions(category, status),
    };
    
    this._manualInterventionTriggers.push(trigger);
    
    // Keep only last 100 triggers
    if (this._manualInterventionTriggers.length > 100) {
      this._manualInterventionTriggers.shift();
    }
    
    return trigger;
  }
  
  /**
   * Calculate severity level for degradation
   * @param {string} category
   * @param {object} status
   * @returns {'low'|'medium'|'high'|'critical'}
   */
  _calculateSeverity(category, status) {
    // Critical: core execution categories with no fallback
    if (['code_execution', 'development'].includes(category)) {
      return 'critical';
    }
    
    // High: architecture/review with no fallback
    if (['architecture', 'review'].includes(category)) {
      return 'high';
    }
    
    // Medium: research/op
    if (['research', 'ops'].includes(category)) {
      return 'medium';
    }
    
    // Low: unknown/fallback categories
    return 'low';
  }
  
  /**
   * Get required manual actions for a degradation event
   * @param {string} category
   * @param {object} status
   * @returns {string[]}
   */
  _getRequiredManualActions(category, status) {
    const actions = [];
    
    // Always recommend checking provider health
    actions.push('Verify provider health status');
    
    // If degraded for > 5 minutes, recommend manual intervention
    const duration = Date.now() - status.pausedAt;
    if (duration > 300000) { // 5 minutes
      actions.push('Consider manual provider restart if auto-recovery fails');
    }
    
    // If degraded for > 15 minutes, escalate
    if (duration > 900000) { // 15 minutes
      actions.push('Escalate to platform team - extended outage detected');
    }
    
    // Category-specific recommendations
    if (category === 'code_execution') {
      actions.push('Verify code execution providers (claude, codex, ollama) are healthy');
    } else if (category === 'architecture') {
      actions.push('Verify architecture provider (claude) is healthy');
    }
    
    return actions;
  }
  
  /**
   * Get manual intervention triggers
   * @returns {Array}
   */
  getManualInterventionTriggers() {
    return [...this._manualInterventionTriggers];
  }
  
  /**
   * Clear manual intervention triggers older than specified duration
   * @param {number} maxAgeMs - Maximum age in milliseconds
   */
  clearOldTriggers(maxAgeMs = 3600000) { // Default: 1 hour
    const cutoff = Date.now() - maxAgeMs;
    const before = this._manualInterventionTriggers.length;
    this._manualInterventionTriggers = this._manualInterventionTriggers.filter(
      t => t.triggeredAt > cutoff
    );
    const after = this._manualInterventionTriggers.length;
    
    if (before > after) {
      log.debug('Cleared old intervention triggers', { removed: before - after });
    }
  }
  
  /**
   * Get summary statistics
   * @returns {{ degradedCategories: number, totalTriggers: number, avgRecoveryTimeMs: number }}
   */
  getStats() {
    const degraded = this.getDegradedCategories().length;
    const triggers = this.getManualInterventionTriggers();
    
    // Calculate average recovery time
    let totalRecoveryTime = 0;
    let recoveryCount = 0;
    
    for (const trigger of triggers) {
      if (trigger.resumedAt && trigger.pausedAt) {
        totalRecoveryTime += (trigger.resumedAt - trigger.pausedAt);
        recoveryCount++;
      }
    }
    
    const avgRecoveryTime = recoveryCount > 0 
      ? Math.round(totalRecoveryTime / recoveryCount)
      : 0;
    
    return {
      degradedCategories: degraded,
      totalTriggers: triggers.length,
      avgRecoveryTimeMs: avgRecoveryTime,
    };
  }
}

/**
 * Create a handler with default configuration
 * @param {object} options
 * @returns {GracefulDegradationHandler}
 */
export function createGracefulDegradationHandler(options = {}) {
  return new GracefulDegradationHandler(options);
}
