/**
 * ToolFallbackService
 *
 * Orchestrates the complete fallback workflow for MCP tool invocation failures.
 * Provides centralized fallback logic with comprehensive monitoring and policy enforcement.
 *
 * Features:
 * - Failure detection: Identifies when fallback should be triggered based on error type
 * - Alternative identification: Discovers compatible fallback tools in the same operation category
 * - Compatibility analysis: Validates that fallback tools can handle the same parameters
 * - Priority ranking: Ranks fallback tools by server priority, success rate, and compatibility
 * - Policy enforcement: Respects configured fallback policies (max attempts, timeouts, retry logic)
 * - Event tracking: Emits detailed events for operational monitoring and debugging
 * - Circuit breaker integration: Checks and updates tool circuit breaker states
 * - Metrics collection: Records fallback success/failure metrics for analytics
 *
 * Workflow:
 *   1. Detect failure → Check if fallback should trigger based on error type and policy
 *   2. Identify alternatives → Find tools in same operation category, exclude primary tool
 *   3. Analyze compatibility → Check if fallback tools can handle the same parameters
 *   4. Rank alternatives → Order by server priority, historical success, and compatibility score
 *   5. Attempt fallback → Invoke each fallback tool in order with retry logic
 *   6. Handle results → Record success/failure, update metrics, emit events
 *
 * Usage:
 *   const fallbackService = new ToolFallbackService({
 *     connectionManager,
 *     toolRegistry,
 *     toolCircuitBreaker,
 *     compatibilityAnalyzer,
 *     fallbackPriorityRanker,
 *     fallbackPolicyManager,
 *     fallbackEventTracker,
 *     metricsCollector
 *   });
 *   
 *   const result = await fallbackService.attemptFallback({
 *     primaryTool,
 *     primaryError,
 *     args,
 *     operationCategory
 *   });
 */

import { createLogger } from '../logger.js';
import { STATES } from '../orchestrator/circuit-breaker.js';

const log = createLogger('tool-fallback-service');

/**
 * Fallback result status codes
 */
export const FallbackStatus = {
  SUCCESS: 'success',
  FAILED: 'failed',
  NO_CANDIDATES: 'no_candidates',
  NO_COMPATIBLE: 'no_compatible',
  SKIPPED: 'skipped'
};

/**
 * Fallback failure reasons
 */
export const FallbackFailureReason = {
  NO_CANDIDATES: 'no_candidates',
  NO_COMPATIBLE_TOOLS: 'no_compatible_tools',
  ALL_FAILED: 'all_attempts_failed',
  ALL_CIRCUITS_OPEN: 'all_circuits_open',
  TIMEOUT: 'timeout',
  POLICY_DISABLED: 'policy_disabled',
  CIRCUIT_OPEN: 'circuit_open'
};

/**
 * ToolFallbackService - Orchestrates fallback workflow for MCP tool invocation failures
 */
export class ToolFallbackService {
  /**
   * Create a ToolFallbackService instance
   * @param {Object} dependencies - Service dependencies
   * @param {McpConnectionManager} dependencies.connectionManager - Connection manager for tool invocation
   * @param {ToolRegistry} dependencies.toolRegistry - Tool registry for finding alternative tools
   * @param {ToolCircuitBreaker} dependencies.toolCircuitBreaker - Tool circuit breaker for state management
   * @param {ToolCompatibilityAnalyzer} dependencies.compatibilityAnalyzer - Compatibility analyzer for fallback validation
   * @param {FallbackPriorityRanker} dependencies.fallbackPriorityRanker - Priority ranker for tool ordering
   * @param {FallbackPolicyManager} dependencies.fallbackPolicyManager - Policy manager for fallback configuration
   * @param {FallbackEventTracker} dependencies.fallbackEventTracker - Event tracker for monitoring
   * @param {ExecutionMetricsCollector} [dependencies.metricsCollector] - Optional metrics collector
   */
  constructor(dependencies) {
    const {
      connectionManager,
      toolRegistry,
      toolCircuitBreaker,
      compatibilityAnalyzer,
      fallbackPriorityRanker,
      fallbackPolicyManager,
      fallbackEventTracker,
      metricsCollector
    } = dependencies;

    if (!connectionManager) {
      throw new TypeError('connectionManager is required');
    }
    if (!toolRegistry) {
      throw new TypeError('toolRegistry is required');
    }
    if (!toolCircuitBreaker) {
      throw new TypeError('toolCircuitBreaker is required');
    }
    if (!compatibilityAnalyzer) {
      throw new TypeError('compatibilityAnalyzer is required');
    }
    if (!fallbackPriorityRanker) {
      throw new TypeError('fallbackPriorityRanker is required');
    }
    if (!fallbackPolicyManager) {
      throw new TypeError('fallbackPolicyManager is required');
    }
    if (!fallbackEventTracker) {
      throw new TypeError('fallbackEventTracker is required');
    }

    this.connectionManager = connectionManager;
    this.toolRegistry = toolRegistry;
    this.toolCircuitBreaker = toolCircuitBreaker;
    this.compatibilityAnalyzer = compatibilityAnalyzer;
    this.fallbackPriorityRanker = fallbackPriorityRanker;
    this.fallbackPolicyManager = fallbackPolicyManager;
    this.fallbackEventTracker = fallbackEventTracker;
    this.metricsCollector = metricsCollector || null;

    log.info('ToolFallbackService initialized');
  }

  /**
   * Attempt fallback tool invocation when primary tool fails.
   * 
   * This is the main entry point for the fallback workflow. It orchestrates:
   * 1. Failure detection and policy validation
   * 2. Alternative tool identification
   * 3. Compatibility analysis
   * 4. Priority ranking
   * 5. Sequential fallback attempts with retry logic
   * 6. Result handling and event tracking
   * 
   * @param {Object} context - Fallback context
   * @param {Object} context.primaryTool - Primary tool that failed
   * @param {string} context.primaryServerId - Primary server ID
   * @param {Error|Object} context.primaryError - Error that triggered fallback
   * @param {Object} context.args - Tool arguments
   * @param {string} context.operationCategory - Operation category for fallback resolution
   * @param {Object} [context.options] - Additional options
   * @param {number} [context.options.timeoutMs] - Timeout for fallback invocations
   * @param {Object} [context.options.fallbackPolicy] - Fallback policy overrides
   * @returns {Promise<Object>} Fallback result with status and context
   */
  async attemptFallback(context) {
    const {
      primaryTool,
      primaryServerId,
      primaryError,
      args = {},
      operationCategory,
      options = {}
    } = context;

    if (!primaryTool || !primaryServerId) {
      throw new TypeError('primaryTool and primaryServerId are required');
    }

    const primaryToolKey = `${primaryServerId}:${primaryTool.name}`;

    // Step 1: Detect failure and validate policy
    const policyValidation = this._detectFailureAndValidatePolicy(
      primaryTool,
      primaryServerId,
      primaryError,
      operationCategory,
      options
    );

    if (!policyValidation.shouldTrigger) {
      log.info({
        primaryTool: primaryToolKey,
        operationCategory,
        reason: policyValidation.reason,
        policyEnabled: policyValidation.policy.enabled,
        errorType: primaryError?.name,
        errorMessage: primaryError?.message
      }, 'Fallback not triggered - policy conditions not met');

      return {
        status: FallbackStatus.SKIPPED,
        reason: policyValidation.reason,
        context: {
          primaryTool: primaryTool.name,
          primaryServerId,
          operationCategory
        }
      };
    }

    // Start fallback tracking session
    const correlationId = this.fallbackEventTracker.startFallback(
      primaryTool.name,
      primaryServerId,
      operationCategory,
      {
        primaryError: primaryError?.message || primaryError?.toString(),
        policy: policyValidation.policy
      }
    );



    try {
      // Step 2: Identify alternative tools
      const alternatives = this._identifyAlternatives(
        primaryTool,
        primaryServerId,
        operationCategory
      );

      if (alternatives.length === 0) {
        this.fallbackEventTracker.completeFallback(
          correlationId,
          'failure',
          {
            failureReason: FallbackFailureReason.NO_CANDIDATES,
            candidateCount: 0
          }
        );

        log.warn({
          primaryTool: primaryToolKey,
          operationCategory,
          correlationId,
          error: primaryError?.message
        }, 'Fallback failed - no alternative tools available in category');

        return {
          status: FallbackStatus.NO_CANDIDATES,
          code: 'NO_FALLBACK_CANDIDATES',
          error: 'No alternative tools found for fallback',
          context: {
            primaryTool: primaryTool.name,
            primaryServerId,
            operationCategory,
            candidateCount: 0,
            correlationId
          }
        };
      }

      log.info({
        primaryTool: primaryToolKey,
        operationCategory,
        candidateCount: alternatives.length
      }, 'Found alternative tools for fallback');

      // Check circuit breaker impact on fallback availability
      const totalCandidates = alternatives.length;
      const openCircuits = [];
      const affectedTools = [];

      for (const candidate of alternatives) {
        const candidateServerId = candidate.source.replace('mcp:', '');
        const candidateToolKey = `${candidateServerId}:${candidate.name}`;
        const circuitState = this.toolCircuitBreaker.getState(candidateToolKey);

        if (circuitState.state === STATES.OPEN) {
          openCircuits.push(candidateToolKey);
          affectedTools.push(candidateToolKey);
        }
      }

      // Record circuit impact if any tools are affected
      if (openCircuits.length > 0) {
        this.fallbackEventTracker.recordCircuitImpact(
          correlationId,
          totalCandidates,
          openCircuits.length,
          affectedTools
        );
      }

      // Step 3: Analyze compatibility
      const compatibilityResults = {};
      const compatibleAlternatives = [];

      for (const candidate of alternatives) {
        const candidateToolKey = `${candidate.source.replace('mcp:', '')}:${candidate.name}`;
        
        try {
          const analysis = this.compatibilityAnalyzer.checkCompatibility(
            primaryTool,
            candidate,
            args
          );

          compatibilityResults[candidateToolKey] = analysis;

          this.fallbackEventTracker.recordCandidateAnalysis(
            correlationId,
            candidate.name,
            candidate.source.replace('mcp:', ''),
            analysis
          );

          if (analysis.isCompatible) {
            compatibleAlternatives.push({
              tool: candidate,
              analysis
            });
          }
        } catch (err) {
          log.warn({
            primaryTool: primaryToolKey,
            fallbackTool: candidateToolKey,
            error: err.message
          }, 'Compatibility analysis failed, assuming compatible');

          compatibilityResults[candidateToolKey] = {
            isCompatible: true,
            compatibilityLevel: 'unknown',
            compatibilityScore: 0.7,
            warnings: [err.message]
          };

          compatibleAlternatives.push({
            tool: candidate,
            analysis: compatibilityResults[candidateToolKey]
          });
        }
      }

      if (compatibleAlternatives.length === 0) {
        this.fallbackEventTracker.completeFallback(
          correlationId,
          'failure',
          {
            failureReason: FallbackFailureReason.NO_COMPATIBLE,
            candidateCount: alternatives.length,
            compatibleCount: 0
          }
        );

        log.warn({
          primaryTool: primaryToolKey,
          operationCategory,
          candidateCount: alternatives.length,
          correlationId,
          compatibilityResults: Object.keys(compatibilityResults).map(key => ({
            tool: key,
            isCompatible: compatibilityResults[key].isCompatible,
            compatibilityLevel: compatibilityResults[key].compatibilityLevel
          }))
        }, 'Fallback failed - no compatible alternative tools');

        return {
          status: FallbackStatus.NO_COMPATIBLE,
          code: 'NO_COMPATIBLE_FALLBACK_TOOLS',
          error: `${alternatives.length} alternative tools found, but none are compatible`,
          context: {
            primaryTool: primaryTool.name,
            primaryServerId,
            operationCategory,
            candidateCount: alternatives.length,
            compatibleCount: 0,
            correlationId
          }
        };
      }

      log.info({
        primaryTool: primaryToolKey,
        candidateCount: alternatives.length,
        compatibleCount: compatibleAlternatives.length
      }, 'Compatibility analysis complete');

      // Step 4: Rank fallback tools
      const rankedAlternatives = this.fallbackPriorityRanker.rankTools(
        primaryTool,
        compatibleAlternatives.map(item => item.tool),
        {
          compatibilityResults,
          parameters: args
        }
      );

      this.fallbackEventTracker.recordRanking(correlationId, rankedAlternatives);

      log.info({
        primaryTool: primaryToolKey,
        rankedCount: rankedAlternatives.length,
        topTool: rankedAlternatives[0]?.tool.name,
        topScore: rankedAlternatives[0]?.overallScore
      }, 'Fallback tools ranked');

      // Step 5: Attempt fallback invocations
      const fallbackResult = await this._attemptFallbackInvocations(
        correlationId,
        primaryTool,
        primaryServerId,
        args,
        rankedAlternatives,
        policyValidation.policy,
        compatibilityResults
      );

      // Step 6: Handle results
      return this._handleFallbackResult(
        correlationId,
        fallbackResult,
        {
          primaryTool,
          primaryServerId,
          operationCategory,
          candidateCount: alternatives.length,
          compatibleCount: compatibleAlternatives.length,
          primaryError: primaryError?.message
        }
      );

    } catch (err) {
      log.error({
        primaryTool: primaryToolKey,
        correlationId,
        error: err.message
      }, 'Fallback workflow failed with exception');

      this.fallbackEventTracker.completeFallback(
        correlationId,
        'failure',
        {
          failureReason: 'workflow_error',
          error: err.message
        }
      );

      return {
        status: FallbackStatus.FAILED,
        code: 'FALLBACK_WORKFLOW_ERROR',
        error: `Fallback workflow failed: ${err.message}`,
        context: {
          primaryTool: primaryTool.name,
          primaryServerId,
          operationCategory,
          correlationId
        }
      };
    }
  }

  /**
   * Detect if fallback should be triggered and validate policy.
   * @private
   */
  _detectFailureAndValidatePolicy(primaryTool, primaryServerId, primaryError, operationCategory, options) {
    const toolKey = `${primaryServerId}:${primaryTool.name}`;

    // Check tool circuit breaker state
    const circuitState = this.toolCircuitBreaker.getState(toolKey);
    const isCircuitOpen = circuitState.state === STATES.OPEN;

    // Get fallback policy for operation category
    const policy = operationCategory
      ? this.fallbackPolicyManager.getPolicyForOperation(operationCategory)
      : this.fallbackPolicyManager.getPolicyForOperation(null);

    // Merge with runtime overrides
    const effectivePolicy = {
      ...policy,
      ...options.fallbackPolicy
    };

    // Check if fallback is enabled
    if (!effectivePolicy.enabled) {
      return {
        shouldTrigger: false,
        reason: 'Fallback policy disabled',
        policy: effectivePolicy
      };
    }

    // Check if error should trigger fallback
    const shouldTriggerOnFailure = this.fallbackPolicyManager.shouldTriggerFallback(
      primaryError,
      effectivePolicy
    );

    if (isCircuitOpen) {
      return {
        shouldTrigger: true,
        reason: 'Tool circuit breaker is open',
        policy: effectivePolicy
      };
    }

    if (!shouldTriggerOnFailure) {
      return {
        shouldTrigger: false,
        reason: 'Error type does not trigger fallback per policy',
        policy: effectivePolicy
      };
    }

    return {
      shouldTrigger: true,
      reason: 'Primary tool failure detected',
      policy: effectivePolicy
    };
  }

  /**
   * Identify alternative tools for fallback.
   * @private
   */
  _identifyAlternatives(primaryTool, primaryServerId, operationCategory) {
    if (!operationCategory) {
      log.debug({
        primaryTool: primaryTool.name,
        primaryServerId
      }, 'No operation category provided, cannot identify alternatives');
      return [];
    }

    try {
      const categoryTools = this.toolRegistry.getToolsByCategory(operationCategory);

      if (!categoryTools || categoryTools.length === 0) {
        log.debug({
          operationCategory,
          primaryTool: primaryTool.name
        }, 'No tools found in operation category');
        return [];
      }

      // Filter out primary tool and tools from same server
      const alternatives = categoryTools.filter(tool => {
        const toolServerId = tool.source.replace('mcp:', '');
        return (
          tool.name !== primaryTool.name &&
          toolServerId !== primaryServerId &&
          tool.approval_state === 'approved'
        );
      });

      log.debug({
        primaryTool: primaryTool.name,
        operationCategory,
        categoryCount: categoryTools.length,
        alternativeCount: alternatives.length
      }, 'Identified alternative tools');

      return alternatives;
    } catch (err) {
      log.error({
        operationCategory,
        primaryTool: primaryTool.name,
        error: err.message
      }, 'Failed to identify alternative tools');
      return [];
    }
  }

  /**
   * Attempt fallback tool invocations in ranked order.
   * @private
   */
  async _attemptFallbackInvocations(correlationId, primaryTool, primaryServerId, args, rankedAlternatives, policy, compatibilityResults) {
    const maxAttempts = Math.min(policy.maxAttempts, rankedAlternatives.length);
    const fallbackTools = rankedAlternatives.slice(0, maxAttempts);

    const attemptedFallbacks = [];
    const fallbackErrors = [];
    let successfulFallback = null;

    for (let i = 0; i < fallbackTools.length; i++) {
      const { tool, overallScore, scores, metadata } = fallbackTools[i];
      const fallbackServerId = tool.source.replace('mcp:', '');
      const fallbackToolKey = `${fallbackServerId}:${tool.name}`;
      const compatibilityResult = compatibilityResults[fallbackToolKey];

      attemptedFallbacks.push({
        name: tool.name,
        serverId: fallbackServerId,
        rank: i + 1,
        overallScore,
        scores,
        compatibilityLevel: compatibilityResult?.compatibilityLevel,
        compatibilityScore: compatibilityResult?.compatibilityScore
      });

      this.fallbackEventTracker.recordAttemptStart(
        correlationId,
        tool.name,
        fallbackServerId,
        {
          rank: i + 1,
          compatibilityScore: compatibilityResult?.compatibilityScore,
          overallScore
        }
      );

      try {
        const result = await this._attemptSingleFallback(
          tool,
          fallbackServerId,
          args,
          policy,
          correlationId
        );

        if (result.success) {
          successfulFallback = {
            tool,
            serverId: fallbackServerId,
            result,
            attemptIndex: i,
            compatibilityResult
          };

          this.fallbackEventTracker.recordAttemptSuccess(
            correlationId,
            tool.name,
            fallbackServerId,
            result.invocationResult
          );

          // Record success in circuit breaker
          this.toolCircuitBreaker.recordSuccess(fallbackToolKey);

          // Record success in priority ranker
          this.fallbackPriorityRanker.recordSuccess(
            fallbackToolKey,
            result.latencyMs
          );

          log.info({
            primaryTool: primaryTool.name,
            fallbackTool: fallbackToolKey,
            attemptIndex: i,
            latencyMs: result.latencyMs
          }, 'Fallback tool invocation succeeded');

          break;
        } else {
          fallbackErrors.push({
            toolName: tool.name,
            serverId: fallbackServerId,
            error: result.error,
            attemptIndex: i
          });

          this.fallbackEventTracker.recordAttemptFailure(
            correlationId,
            tool.name,
            fallbackServerId,
            result.error,
            {
              circuitState: result.circuitState,
              errorCode: result.errorCode
            }
          );

          // Record failure in circuit breaker
          this.toolCircuitBreaker.recordFailure(fallbackToolKey);

          // Record failure in priority ranker
          this.fallbackPriorityRanker.recordFailure(
            fallbackToolKey,
            result.error
          );

          log.debug({
            fallbackTool: fallbackToolKey,
            attemptIndex: i,
            error: result.error
          }, 'Fallback tool invocation failed');
        }
      } catch (err) {
        fallbackErrors.push({
          toolName: tool.name,
          serverId: fallbackServerId,
          error: err.message,
          attemptIndex: i
        });

        this.fallbackEventTracker.recordAttemptFailure(
          correlationId,
          tool.name,
          fallbackServerId,
          err.message
        );

        // Record failure in circuit breaker
        this.toolCircuitBreaker.recordFailure(fallbackToolKey);

        // Record failure in priority ranker
        this.fallbackPriorityRanker.recordFailure(
          fallbackToolKey,
          err.message
        );

        log.warn({
          fallbackTool: fallbackToolKey,
          attemptIndex: i,
          error: err.message
        }, 'Fallback tool invocation threw exception');
      }
    }

    return {
      attemptedFallbacks,
      fallbackErrors,
      successfulFallback
    };
  }

  /**
   * Attempt to invoke a single fallback tool with retry logic.
   * @private
   */
  async _attemptSingleFallback(fallbackTool, fallbackServerId, args, policy, correlationId) {
    const fallbackToolKey = `${fallbackServerId}:${fallbackTool.name}`;

    // Check if server is connected
    const connectionState = this.connectionManager.getState(fallbackServerId);
    if (!connectionState || connectionState.status !== 'connected') {
      return {
        success: false,
        error: `Server ${fallbackServerId} is not connected`,
        errorCode: 'SERVER_NOT_CONNECTED',
        circuitState: null
      };
    }

    // Check circuit breaker state
    const circuitState = this.toolCircuitBreaker.getState(fallbackToolKey);
    if (circuitState.state === STATES.OPEN) {
      return {
        success: false,
        error: `Tool circuit breaker is open for ${fallbackTool.name}`,
        errorCode: 'CIRCUIT_OPEN',
        circuitState: circuitState.state
      };
    }

    // Apply parameter transformations if needed
    let transformedArgs = args;
    const compatibilityResult = this.compatibilityAnalyzer.checkCompatibility(
      { name: 'primary', metadata: {} }, // We'd need the actual primary tool here
      fallbackTool,
      args
    );

    if (compatibilityResult.transformations && compatibilityResult.transformations.length > 0) {
      transformedArgs = this._applyParameterTransformations(args, compatibilityResult.transformations);
    }

    // Invoke with retry logic
    const retryConfig = policy.retry || { enabled: false };
    const maxRetries = retryConfig.enabled ? retryConfig.maxRetries : 0;
    const timeoutMs = policy.timeoutMs || 30000;

    let lastError = null;
    const startTime = Date.now();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.connectionManager.invokeToolWithCircuitBreaker(
          fallbackServerId,
          fallbackTool.name,
          transformedArgs,
          {
            timeoutMs,
            operationCategory: null // Avoid recursive fallback
          }
        );

        const latencyMs = Date.now() - startTime;

        if (result.status === 'error') {
          lastError = result.error;

          if (attempt < maxRetries && !this._isNonRetryableError(result)) {
            const delay = this.fallbackPolicyManager.calculateRetryDelay(attempt, retryConfig);
            log.debug({
              fallbackTool: fallbackToolKey,
              attempt: attempt + 1,
              maxRetries: maxRetries + 1,
              delayMs: Math.round(delay)
            }, 'Retrying fallback tool invocation');

            await this._sleep(delay);
            continue;
          }

          return {
            success: false,
            error: result.error,
            errorCode: result.code || 'TOOL_ERROR',
            circuitState: circuitState.state
          };
        }

        return {
          success: true,
          invocationResult: result,
          latencyMs
        };
      } catch (err) {
        lastError = err.message;

        if (attempt < maxRetries) {
          const delay = this.fallbackPolicyManager.calculateRetryDelay(attempt, retryConfig);
          log.debug({
            fallbackTool: fallbackToolKey,
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
            delayMs: Math.round(delay)
          }, 'Retrying fallback tool invocation after exception');

          await this._sleep(delay);
          continue;
        }

        return {
          success: false,
          error: err.message,
          errorCode: 'EXCEPTION',
          circuitState: circuitState.state
        };
      }
    }

    return {
      success: false,
      error: lastError || 'Unknown error',
      errorCode: 'RETRY_EXHAUSTED',
      circuitState: circuitState.state
    };
  }

  /**
   * Apply parameter transformations based on compatibility analysis.
   * @private
   */
  _applyParameterTransformations(args, transformations) {
    const transformed = { ...args };

    for (const transform of transformations) {
      const { parameter, transformType, transformFunction } = transform;

      if (transformed[parameter] !== undefined && transformFunction) {
        try {
          transformed[parameter] = transformFunction(transformed[parameter]);
          log.debug({
            parameter,
            transformType,
            from: typeof args[parameter],
            to: typeof transformed[parameter]
          }, 'Applied parameter transformation');
        } catch (err) {
          log.warn({
            parameter,
            transformType,
            error: err.message
          }, 'Failed to apply parameter transformation');
        }
      }
    }

    return transformed;
  }

  /**
   * Check if an error is non-retryable.
   * @private
   */
  _isNonRetryableError(result) {
    if (!result || result.status !== 'error') {
      return false;
    }

    const errorCode = result.code || '';
    const errorMessage = result.error || '';

    const nonRetryableCodes = ['VALIDATION_ERROR', 'AUTH_ERROR', 'PERMISSION_ERROR'];
    const nonRetryableMessages = ['validation', 'invalid parameter', 'authentication', 'unauthorized', 'permission', 'forbidden'];

    if (nonRetryableCodes.includes(errorCode)) {
      return true;
    }

    if (nonRetryableMessages.some(msg => errorMessage.toLowerCase().includes(msg))) {
      return true;
    }

    return false;
  }

  /**
   * Handle fallback result and complete tracking.
   * @private
   */
  _handleFallbackResult(correlationId, fallbackResult, context) {
    const { attemptedFallbacks, fallbackErrors, successfulFallback } = fallbackResult;

    if (successfulFallback) {
      const fallbackToolKey = `${successfulFallback.serverId}:${successfulFallback.tool.name}`;

      log.info({
        primaryTool: context.primaryTool.name,
        primaryServerId: context.primaryServerId,
        fallbackTool: fallbackToolKey,
        operationCategory: context.operationCategory,
        attemptIndex: successfulFallback.attemptIndex,
        attemptsBeforeSuccess: successfulFallback.attemptIndex,
        totalAttempted: attemptedFallbacks.length,
        latencyMs: successfulFallback.result.latencyMs,
        correlationId
      }, 'Fallback operation completed successfully');

      this.fallbackEventTracker.completeFallback(
        correlationId,
        'success',
        {
          fallbackToolName: successfulFallback.tool.name,
          fallbackServerId: successfulFallback.serverId,
          attemptIndex: successfulFallback.attemptIndex
        }
      );

      return {
        status: FallbackStatus.SUCCESS,
        ...successfulFallback.result.invocationResult,
        context: {
          ...successfulFallback.result.invocationResult.context,
          ...context,
          isFallback: true,
          fallbackToolName: successfulFallback.tool.name,
          fallbackServerId: successfulFallback.serverId,
          attemptIndex: successfulFallback.attemptIndex,
          attemptedFallbacks,
          fallbackErrors,
          correlationId
        }
      };
    }

    log.error({
      primaryTool: context.primaryTool.name,
      primaryServerId: context.primaryServerId,
      operationCategory: context.operationCategory,
      attemptedCount: attemptedFallbacks.length,
      failedCount: fallbackErrors.length,
      failureReason: fallbackErrors.length > 0 ? FallbackFailureReason.ALL_FAILED : FallbackFailureReason.NO_CANDIDATES,
      errors: fallbackErrors.map(e => e.error),
      correlationId
    }, 'All fallback attempts failed');

    this.fallbackEventTracker.completeFallback(
      correlationId,
      'failure',
      {
        failureReason: fallbackErrors.length > 0 ? FallbackFailureReason.ALL_FAILED : FallbackFailureReason.NO_CANDIDATES,
        attemptedCount: attemptedFallbacks.length,
        failedCount: fallbackErrors.length
      }
    );

    return {
      status: FallbackStatus.FAILED,
      code: 'ALL_FALLBACKS_FAILED',
      error: `All ${attemptedFallbacks.length} fallback attempts failed`,
      context: {
        ...context,
        attemptedFallbacks,
        fallbackErrors,
        correlationId
      }
    };
  }

  /**
   * Sleep for specified duration.
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get fallback statistics for operational monitoring.
   * @returns {Object} Fallback statistics
   */
  getStatistics() {
    return this.fallbackEventTracker.getStatistics();
  }

  /**
   * Get current configuration.
   * @returns {Object} Current configuration
   */
  getConfig() {
    return {
      fallbackPolicyManager: this.fallbackPolicyManager.getAllPolicies(),
      fallbackPriorityRanker: this.fallbackPriorityRanker.getConfig()
    };
  }
}
