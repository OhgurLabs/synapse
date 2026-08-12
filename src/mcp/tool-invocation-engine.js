/**
 * Tool Invocation Engine
 *
 * Provides low-level tool invocation interface for MCP tools.
 * Handles tool lookup, client routing, and result wrapping.
 *
 * Responsibilities:
 * - Look up tool metadata from ToolRegistry
 * - Validate parameters against tool inputSchema
 * - Route invocations to correct MCP server via ConnectionManager
 * - Execute tool calls through MCP client
 * - Return typed result objects with status and payload/error
 *
 * This is a lower-level interface than ToolDistributionService.invokeTool:
 * - No agent context required
 * - No permission checks (caller is responsible)
 * - Direct tool name lookup (no per-agent filtering)
 * - Returns typed result envelope
 *
 * Result format:
 *   Success: { status: 'ok', result: <payload> }
 *   Error:   { status: 'error', code: <error_code>, message: <error_msg> }
 *
 * Error codes:
 *   - TOOL_NOT_FOUND: Tool doesn't exist in registry
 *   - VALIDATION_FAILED: Parameters failed schema validation
 *   - SERVER_NOT_CONNECTED: MCP server is unavailable
 *   - INVOCATION_FAILED: Tool execution failed (network/runtime error)
 */

import { createLogger } from '../logger.js';
import { ParameterValidator } from './parameter-validator.js';
import { ParameterTransformer } from './parameter-transformer.js';
import { ParameterValidatorTransformer } from './parameter-validator-transformer.js';
import { ResultProcessor } from './result-processor.js';
import { StreamingHandler } from './streaming-handler.js';
import { ErrorResponseProcessor } from './error-response-processor.js';
import { TimeoutError } from './errors.js';
import { isJSONRPCResponse } from './result-types.js';
import { ToolTimeoutManager } from './tool-invocation-wrapper.js';
import { createExecutionMetricsCollector } from './execution-metrics-collector.js';
import { createToolCircuitBreaker } from './tool-circuit-breaker.js';
import { createToolErrorHandlingCoordinator } from './tool-error-handling-coordinator.js';
import { ToolFallbackService, FallbackStatus } from './tool-fallback-service.js';
import config from '../config.js';

const log = createLogger('tool-invocation-engine');

async function raceWithTimeout(promise, timeoutMs, message, onTimeout = null) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        onTimeout?.();
      } catch (err) {
        log.warn({ err: err.message }, 'Tool timeout cleanup failed');
      }
      reject(new TimeoutError(message, { timeoutMs }));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export class ToolInvocationEngine {
  /**
   * Create a ToolInvocationEngine instance.
   *
   * @param {ToolRegistry} toolRegistry - Tool registry for metadata lookup
   * @param {McpConnectionManager} connectionManager - MCP connection manager for client retrieval
   * @param {ParameterValidator|ParameterValidatorTransformer} [parameterValidator] - Parameter validator (optional, creates default if not provided)
   * @param {ParameterTransformer} [parameterTransformer] - Parameter transformer (optional, creates default if not provided)
   * @param {ResultProcessor} [resultProcessor] - Result processor (optional, creates default if not provided)
   * @param {StreamingHandler} [streamingHandler] - Streaming handler (optional, creates default if not provided)
   * @param {ErrorResponseProcessor} [errorResponseProcessor] - Error response processor (optional, creates default if not provided)
   * @param {ToolTimeoutManager} [timeoutManager] - Timeout manager for per-tool configs (optional, creates default if not provided)
   * @param {Object} [options] - Additional options
    * @param {number} [options.defaultTimeoutMs] - Default timeout override (uses config if not provided)
    * @param {ExecutionMetricsCollector} [options.metricsCollector] - Metrics collector (optional, creates default if not provided)
    * @param {ToolCircuitBreaker} [options.circuitBreaker] - Circuit breaker for tool failure tracking (optional, creates default if not provided)
    * @param {ToolFallbackService} [options.fallbackService] - Fallback service for handling tool failures (optional, but required for fallback functionality)
    * @param {ToolErrorHandlingCoordinator} [options.errorHandlingCoordinator] - Error handling coordinator (optional, creates default if not provided)
    */
  constructor(toolRegistry, connectionManager, parameterValidator = null, parameterTransformer = null, resultProcessor = null, streamingHandler = null, errorResponseProcessor = null, timeoutManager = null, options = {}) {
    if (!toolRegistry) {
      throw new TypeError('toolRegistry is required');
    }
    if (!connectionManager) {
      throw new TypeError('connectionManager is required');
    }

    this.toolRegistry = toolRegistry;
    this.connectionManager = connectionManager;
    this.fallbackService = options.fallbackService || null;

    // Support both ParameterValidatorTransformer (combined) and separate validator/transformer
    if (parameterValidator instanceof ParameterValidatorTransformer) {
      this.parameterValidatorTransformer = parameterValidator;
      this.parameterValidator = parameterValidator.validator;
      this.parameterTransformer = parameterValidator.transformer;
    } else {
      this.parameterValidator = parameterValidator || new ParameterValidator();
      this.parameterTransformer = parameterTransformer || new ParameterTransformer();
      this.parameterValidatorTransformer = null;
    }

    // Initialize result processing components
    this.resultProcessor = resultProcessor || new ResultProcessor();
    this.streamingHandler = streamingHandler || new StreamingHandler();
    this.errorResponseProcessor = errorResponseProcessor || new ErrorResponseProcessor();

    // Initialize timeout manager for per-tool timeout configuration and metrics
    const defaultTimeoutMs = options.defaultTimeoutMs ?? config.mcp.toolInvocationTimeoutMs;
    const metricsCollector = options.metricsCollector || createExecutionMetricsCollector();

    this.timeoutManager = timeoutManager || new ToolTimeoutManager({
      defaultTimeoutMs,
      perToolTimeouts: {},
      minTimeoutMs: 1000,
      maxTimeoutMs: 300000,
      metricsCollector
    });

    // Initialize error handling coordinator for comprehensive error processing
    this.errorHandlingCoordinator = options.errorHandlingCoordinator || createToolErrorHandlingCoordinator({
      enableErrorAggregation: options.enableErrorAggregation !== false,
      enableFallbackTools: options.enableFallbackTools !== false,
      enableAutoRetry: options.enableAutoRetry !== false,
      enableDetailedLogging: options.enableDetailedLogging || false
    });

    // Store default timeout for backward compatibility
    this.defaultTimeoutMs = defaultTimeoutMs;

    // Store metrics collector for direct access
    this.metricsCollector = metricsCollector;

    // Initialize circuit breaker for per-tool failure tracking
    this.circuitBreaker = options.circuitBreaker || createToolCircuitBreaker(config.mcp.toolCircuitBreaker);

    log.debug('ToolInvocationEngine initialized', {
      defaultTimeoutMs: this.defaultTimeoutMs,
      circuitBreakerConfig: {
        failureThreshold: config.mcp.toolCircuitBreaker.failureThreshold,
        cooldownMs: config.mcp.toolCircuitBreaker.cooldownMs
      }
    });
  }

  /**
   * Invoke an MCP tool by name.
   *
   * @param {string} toolName - Tool name (as registered in ToolRegistry)
   * @param {Object} [params={}] - Tool parameters
   * @param {Object} [options={}] - Invocation options
   * @param {number} [options.timeoutMs] - Override default timeout
   * @param {boolean} [options.enableStreaming] - Enable streaming for supported tools
   * @param {Object} [options.streamOptions] - Options for streaming handler
   * @returns {Promise<Object>} Typed result object
   *
   * Success result:
   *   { status: 'ok', result: <payload> }
   *
   * Error results:
   *   { status: 'error', code: 'TOOL_NOT_FOUND', message: '...' }
   *   { status: 'error', code: 'SERVER_NOT_CONNECTED', message: '...' }
   *   { status: 'error', code: 'INVOCATION_FAILED', message: '...', error: <original_error> }
   */
  async invoke(toolName, params = {}, options = {}) {
    if (!toolName || typeof toolName !== 'string') {
      throw new TypeError('toolName is required and must be a string');
    }

    // Normalize null/undefined to empty object for consistent behavior
    if (params == null) {
      params = {};
    }

    const startTimeMs = Date.now();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    log.debug({ toolName, params, timeoutMs }, 'Invoking tool');

    // Step 1: Look up tool in registry
    const tool = this.toolRegistry.getToolByName(toolName);
    if (!tool) {
      log.warn({ toolName }, 'Tool not found in registry');
      const errorResult = await this.errorResponseProcessor.processToolExecutionError(
        { message: `Tool not found: ${toolName}`, errorCode: 'TOOL_NOT_FOUND' },
        { toolName, serverId: 'unknown', toolId: null }
      );
      return errorResult;
    }

    const inputSchema = tool.metadata?.inputSchema;
    const outputSchema = tool.metadata?.outputSchema;
    const transformationRules = tool.transformation_rules;
    const toolId = tool.id;

    // Step 2 & 3: Transform and validate parameters
    if (inputSchema) {
      let validationResult;

      // Use combined validator if available, otherwise separate transform + validate
      if (this.parameterValidatorTransformer) {
        validationResult = this.parameterValidatorTransformer.validateAndTransform(
          inputSchema,
          params,
          { transformationRules }
        );
        params = validationResult.parameters;
      } else {
        // Transform first (with transformation rules if available)
        if (transformationRules) {
          params = this.parameterTransformer.transformWithRules(inputSchema, params, transformationRules);
        } else {
          params = this.parameterTransformer.transform(inputSchema, params);
        }
        log.debug({ toolName, params }, 'Parameters transformed');

        // Then validate
        validationResult = this.parameterValidator.validate(inputSchema, params);
      }

      if (!validationResult.valid) {
        log.warn({ toolName, errors: validationResult.errors }, 'Parameter validation failed');
        const errorResult = await this.errorResponseProcessor.processValidationError(
          { errors: validationResult.errors },
          { toolName, serverId: 'unknown', toolId }
        );
        return errorResult;
      }

      log.debug({ toolName, transformationInfo: validationResult.transformationInfo }, 'Parameter validation passed');
    } else {
      log.debug({ toolName }, 'No inputSchema for tool, skipping validation');
    }

    // Step 4: Extract MCP server ID from source
    // Source format: "mcp:{serverName}"
    const source = tool.source;
    if (!source || !source.startsWith('mcp:')) {
      log.error({ toolName, source }, 'Invalid tool source format');
      const errorResult = await this.errorResponseProcessor.processToolExecutionError(
        { message: `Invalid tool source format: ${source}`, errorCode: 'INVALID_SOURCE' },
        { toolName, serverId: 'unknown', toolId }
      );
      return errorResult;
    }

    const serverId = source.slice(4); // Remove "mcp:" prefix

    // Step 5: Get MCP client from connection manager
    const client = this.connectionManager.getClient(serverId);
    if (!client) {
      log.warn({ toolName, serverId }, 'MCP server not connected');
      const errorResult = await this.errorResponseProcessor.processConnectionError(
        { message: `MCP server not connected: ${serverId}`, code: 'SERVER_NOT_CONNECTED', retryable: false },
        { toolName, serverId, toolId }
      );
      return errorResult;
    }

    // Step 6: Extract original tool name (MCP servers expect unprefixed names)
    // The tool name in the registry may be namespaced (e.g., "filesystem:read_file")
    // but MCP servers expect the original unprefixed name (e.g., "read_file")
    const originalToolName = tool.metadata?.originalToolName || toolName;

    // Step 6.5: Check circuit breaker before invoking
    const circuitBreakerKey = `${serverId}:${originalToolName}`;
    const canExecute = this.circuitBreaker.canExecute(circuitBreakerKey);
    if (!canExecute.allowed) {
      log.warn({ toolName, serverId, originalToolName, circuitBreakerKey }, 'Circuit breaker open, rejecting invocation');
      return {
        ...canExecute.error,
        source: 'mcp',
        serverSource: serverId
      };
    }

    // Step 7: Dispatch callTool request through MCP client with timeout
    // The MCP client handles JSON serialization/deserialization internally
    try {
      log.info({ toolName, serverId, originalToolName }, 'Dispatching tool call to MCP server');
      
      // Record start of invocation for metrics
      const invocationStartTime = Date.now();
      
      const abortController = new AbortController();
      const resultPromise = client.callTool(originalToolName, params, { signal: abortController.signal });
      const rawResult = await raceWithTimeout(
        resultPromise,
        timeoutMs,
        `Tool invocation timed out after ${timeoutMs}ms`,
        () => abortController.abort(new Error('Tool invocation timed out'))
      );
      const endTimeMs = Date.now();
      
      // Record metrics for successful invocation
      if (this.timeoutManager) {
        this.timeoutManager.recordMetrics({
          toolName,
          startTime: invocationStartTime,
          endTime: endTimeMs,
          elapsedMs: endTimeMs - invocationStartTime,
          timeoutMs,
          status: 'success'
        }, serverId);
      }

      // Record success in circuit breaker
      this.circuitBreaker.recordSuccess(circuitBreakerKey);

      // Check if result is a JSON-RPC response
      // If not, return it as-is for backward compatibility
      if (!isJSONRPCResponse(rawResult)) {
        log.debug({ toolName, serverId }, 'Non-JSON-RPC response, returning as-is');
        return {
          status: 'ok',
          result: rawResult,
          source: 'mcp',
          serverSource: serverId
        };
      }

      // Process the result through ResultProcessor
      const processedResult = await this.resultProcessor.process(rawResult, {
        toolName,
        serverId,
        toolId,
        outputSchema,
        startTimeMs,
        endTimeMs,
        options
      });

      log.info({ toolName, serverId, status: processedResult.result.status }, 'Tool invocation completed');
      return {
        status: processedResult.result.status,
        result: processedResult.result.result,
        code: processedResult.result.code,
        message: processedResult.result.message,
        error: processedResult.result.error,
        metadata: processedResult.metadata,
        validation: processedResult.validation,
        source: 'mcp',
        serverSource: serverId
      };
    } catch (err) {
      const endTimeMs = Date.now();
      const elapsedMs = endTimeMs - startTimeMs;
      
      log.error({
        toolName,
        serverId,
        originalToolName,
        err,
        errorType: err.constructor?.name,
        errorMessage: err.message,
        elapsedMs
      }, 'Tool invocation failed');

      // Record metrics for failed invocation
      if (this.timeoutManager) {
        const status = err instanceof TimeoutError ? 'timeout' : 'error';
        this.timeoutManager.recordMetrics({
          toolName,
          startTime: startTimeMs,
          endTime: endTimeMs,
          elapsedMs,
          timeoutMs,
          status,
          errorCode: err instanceof TimeoutError ? 'TIMEOUT' : 'INVOCATION_FAILED'
        }, serverId);
      }

      // Record failure in circuit breaker
      this.circuitBreaker.recordFailure(circuitBreakerKey);

      // Handle timeout errors specially with enhanced error processing
      if (err instanceof TimeoutError) {
        const timeoutResult = await this.errorHandlingCoordinator.handleTimeout(
          { timeoutMs, elapsedMs, partialChunks: [] },
          { toolName, serverId, toolId, requestId: null }
        );
        
        // Attempt fallback if coordinator signals it should trigger
        if (this.fallbackService && timeoutResult.fallback?.shouldTrigger) {
          const fallbackResult = await this._attemptFallbackOnInvocationError(
            tool,
            serverId,
            { message: `Tool invocation timed out after ${timeoutMs}ms`, errorCode: 'TIMEOUT' },
            params,
            timeoutResult.fallback.operationCategory,
            timeoutResult
          );
          return fallbackResult;
        }
        
        return timeoutResult;
      }

      // Handle other errors with enhanced error processing
      const errorResult = await this.errorHandlingCoordinator.handleToolExecutionError(
        { message: err.message, errorCode: 'INVOCATION_FAILED', stack: err.stack, originalError: err },
        { toolName, serverId, toolId, requestId: null, elapsedMs }
      );
      
      // Attempt fallback if coordinator signals it should trigger
      if (this.fallbackService && errorResult.fallback?.shouldTrigger) {
        const fallbackResult = await this._attemptFallbackOnInvocationError(
          tool,
          serverId,
          { message: err.message, errorCode: 'INVOCATION_FAILED', originalError: err },
          params,
          errorResult.fallback.operationCategory,
          errorResult
        );
        return fallbackResult;
      }
      
      return errorResult;
    }
  }

  /**
   * Invoke an MCP tool with streaming support.
   *
   * @param {string} toolName - Tool name (as registered in ToolRegistry)
   * @param {Object} [params={}] - Tool parameters
   * @param {Object} [options={}] - Invocation options
   * @param {number} [options.timeoutMs] - Timeout for the stream
   * @param {number} [options.chunkTimeoutMs] - Timeout between chunks
   * @param {Function} [options.onChunk] - Callback for each chunk
   * @param {Function} [options.onProgress] - Callback for progress updates
   * @param {Function} [options.onComplete] - Callback for stream completion
   * @param {Function} [options.onError] - Callback for stream errors
   * @returns {Promise<Object>} Aggregated streaming result
   */
  async invokeWithStreaming(toolName, params = {}, options = {}) {
    if (!toolName || typeof toolName !== 'string') {
      throw new TypeError('toolName is required and must be a string');
    }

    const startTimeMs = Date.now();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    log.debug({ toolName, params, timeoutMs }, 'Invoking tool with streaming');

    // Step 1: Look up tool in registry
    const tool = this.toolRegistry.getToolByName(toolName);
    if (!tool) {
      log.warn({ toolName }, 'Tool not found in registry');
      const errorResult = await this.errorResponseProcessor.processToolExecutionError(
        { message: `Tool not found: ${toolName}`, errorCode: 'TOOL_NOT_FOUND' },
        { toolName, serverId: 'unknown', toolId: null }
      );
      return errorResult;
    }

    const inputSchema = tool.metadata?.inputSchema;
    const outputSchema = tool.metadata?.outputSchema;
    const transformationRules = tool.transformation_rules;
    const toolId = tool.id;

    // Step 2 & 3: Transform and validate parameters
    if (inputSchema) {
      let validationResult;

      if (this.parameterValidatorTransformer) {
        validationResult = this.parameterValidatorTransformer.validateAndTransform(
          inputSchema,
          params,
          { transformationRules }
        );
        params = validationResult.parameters;
      } else {
        if (transformationRules) {
          params = this.parameterTransformer.transformWithRules(inputSchema, params, transformationRules);
        } else {
          params = this.parameterTransformer.transform(inputSchema, params);
        }
        log.debug({ toolName, params }, 'Parameters transformed');

        validationResult = this.parameterValidator.validate(inputSchema, params);
      }

      if (!validationResult.valid) {
        log.warn({ toolName, errors: validationResult.errors }, 'Parameter validation failed');
        const errorResult = await this.errorResponseProcessor.processValidationError(
          { errors: validationResult.errors },
          { toolName, serverId: 'unknown', toolId }
        );
        return errorResult;
      }

      log.debug({ toolName, transformationInfo: validationResult.transformationInfo }, 'Parameter validation passed');
    }

    // Step 4: Extract MCP server ID from source
    const source = tool.source;
    if (!source || !source.startsWith('mcp:')) {
      log.error({ toolName, source }, 'Invalid tool source format');
      const errorResult = await this.errorResponseProcessor.processToolExecutionError(
        { message: `Invalid tool source format: ${source}`, errorCode: 'INVALID_SOURCE' },
        { toolName, serverId: 'unknown', toolId }
      );
      return errorResult;
    }

    const serverId = source.slice(4);

    // Step 5: Get MCP client from connection manager
    const client = this.connectionManager.getClient(serverId);
    if (!client) {
      log.warn({ toolName, serverId }, 'MCP server not connected');
      const errorResult = await this.errorResponseProcessor.processConnectionError(
        { message: `MCP server not connected: ${serverId}`, code: 'SERVER_NOT_CONNECTED', retryable: false },
        { toolName, serverId, toolId }
      );
      return errorResult;
    }

    // Step 6: Extract original tool name
    const originalToolName = tool.metadata?.originalToolName || toolName;

    // Step 6.5: Check circuit breaker before invoking
    const circuitBreakerKey = `${serverId}:${originalToolName}`;
    const canExecute = this.circuitBreaker.canExecute(circuitBreakerKey);
    if (!canExecute.allowed) {
      log.warn({ toolName, serverId, originalToolName, circuitBreakerKey }, 'Circuit breaker open, rejecting streaming invocation');
      return {
        ...canExecute.error,
        source: 'mcp',
        serverSource: serverId
      };
    }

    // Step 7: Create stream controller
    const streamController = this.streamingHandler.createStream(toolName, serverId, {
      timeoutMs,
      chunkTimeoutMs: options.chunkTimeoutMs,
      onChunk: options.onChunk,
      onProgress: options.onProgress,
      onComplete: options.onComplete,
      onError: options.onError
    });

      // Step 8: Invoke tool with streaming support
      try {
      log.info({ toolName, serverId, originalToolName }, 'Dispatching streaming tool call to MCP server');

      // Record start of invocation for metrics
      const invocationStartTime = Date.now();

      // Check if client supports streaming
      if (client.callToolStreaming && typeof client.callToolStreaming === 'function') {
        // Use streaming API if available
        const streamPromise = this._handleStreamingInvocation(client, originalToolName, params, streamController, outputSchema);
        await raceWithTimeout(
          streamPromise,
          timeoutMs,
          `Streaming tool invocation timed out after ${timeoutMs}ms`,
          () => streamController.abort()
        );
      } else {
        // Fall back to non-streaming and process as single chunk
        log.debug({ toolName }, 'Client does not support streaming, using fallback');
        const abortController = new AbortController();
        const resultPromise = client.callTool(originalToolName, params, { signal: abortController.signal });
        const rawResult = await raceWithTimeout(
          resultPromise,
          timeoutMs,
          `Tool invocation timed out after ${timeoutMs}ms`,
          () => abortController.abort(new Error('Tool invocation timed out'))
        );
        streamController.complete(rawResult);
      }

      const endTimeMs = Date.now();
      const elapsedMs = endTimeMs - invocationStartTime;
      
      // Record metrics for successful streaming invocation
      if (this.timeoutManager) {
        const chunkCount = streamController.getChunks().length;
        this.timeoutManager.recordMetrics({
          toolName,
          startTime: invocationStartTime,
          endTime: endTimeMs,
          elapsedMs,
          timeoutMs,
          status: 'success',
          chunkCount
        }, serverId);
      }

      // Record success in circuit breaker
      this.circuitBreaker.recordSuccess(circuitBreakerKey);

      // Aggregate streaming result
      const aggregatedResult = streamController.aggregate();
      
      // Process aggregated result through ResultProcessor
      const processedResult = await this.resultProcessor.aggregateStreamingChunks(
        aggregatedResult.chunks,
        {
          toolName,
          serverId,
          startTimeMs,
          endTimeMs,
          outputSchema
        }
      );

      log.info({ toolName, serverId, status: processedResult.status }, 'Streaming tool invocation completed');

      return {
        status: processedResult.status,
        result: processedResult.result,
        chunks: processedResult.chunks,
        context: {
          ...processedResult.context,
          streamId: streamController.streamId
        },
        validation: processedResult.validation,
        failedChunksCount: processedResult.failedChunksCount,
        source: 'mcp',
        serverSource: serverId
      };
    } catch (err) {
      const endTimeMs = Date.now();
      const elapsedMs = endTimeMs - startTimeMs;
      
      log.error({
        toolName,
        serverId,
        originalToolName,
        err,
        errorType: err.constructor?.name,
        errorMessage: err.message,
        elapsedMs
      }, 'Streaming tool invocation failed');

      // Record metrics for failed streaming invocation
      if (this.timeoutManager) {
        const chunkCount = streamController.getChunks().length;
        const status = err instanceof TimeoutError ? 'timeout' : 'error';
        this.timeoutManager.recordMetrics({
          toolName,
          startTime: startTimeMs,
          endTime: endTimeMs,
          elapsedMs,
          timeoutMs,
          status,
          errorCode: err instanceof TimeoutError ? 'TIMEOUT' : 'INVOCATION_FAILED',
          chunkCount
        }, serverId);
      }

      // Record failure in circuit breaker
      this.circuitBreaker.recordFailure(circuitBreakerKey);

      // Handle timeout errors with enhanced error processing
      if (err instanceof TimeoutError) {
        streamController.timeout(timeoutMs);
        const timeoutResult = await this.errorHandlingCoordinator.handleTimeout(
          { timeoutMs, elapsedMs, partialChunks: streamController.getChunks() },
          { toolName, serverId, toolId, requestId: null }
        );
        
        // Attempt fallback if coordinator signals it should trigger
        if (this.fallbackService && timeoutResult.fallback?.shouldTrigger) {
          const fallbackResult = await this._attemptFallbackOnInvocationError(
            tool,
            serverId,
            { message: `Streaming tool invocation timed out after ${timeoutMs}ms`, errorCode: 'TIMEOUT' },
            params,
            timeoutResult.fallback.operationCategory,
            timeoutResult
          );
          return fallbackResult;
        }
        
        return timeoutResult;
      }

      // Handle other errors with enhanced error processing
      streamController.fail(err.message, err);
      const errorResult = await this.errorHandlingCoordinator.handleToolExecutionError(
        { message: err.message, errorCode: 'INVOCATION_FAILED', stack: err.stack, originalError: err },
        { toolName, serverId, toolId, requestId: null }
      );
      
      // Attempt fallback if coordinator signals it should trigger
      if (this.fallbackService && errorResult.fallback?.shouldTrigger) {
        const fallbackResult = await this._attemptFallbackOnInvocationError(
          tool,
          serverId,
          { message: err.message, errorCode: 'INVOCATION_FAILED', originalError: err },
          params,
          errorResult.fallback.operationCategory,
          errorResult
        );
        return fallbackResult;
      }
      
      return errorResult;
      } finally {
        // Cleanup stream when done
        streamController.cleanup();
      }
    }

  /**
   * Handle streaming invocation from MCP client.
   *
   * @private
   * @param {Object} client - MCP client
   * @param {string} originalToolName - Original tool name
   * @param {Object} params - Tool parameters
   * @param {Object} streamController - Stream controller
   * @param {Object} [outputSchema] - Optional output schema
   */
  async _handleStreamingInvocation(client, originalToolName, params, streamController, outputSchema) {
    const startTime = Date.now();

    // Call streaming API
    const stream = await client.callToolStreaming(originalToolName, params);
    let chunkIndex = 0;

    try {
      for await (const chunk of stream) {
        if (streamController.aborted) {
          log.debug({ toolName: originalToolName }, 'Stream aborted');
          break;
        }

        // Check per-chunk timeout before processing
        if (streamController.checkTimeout()) {
          const timeoutMs = streamController.getContext().chunkTimeoutMs;
          log.warn({ toolName: originalToolName, elapsedMs: Date.now() - startTime, timeoutMs }, 'Per-chunk timeout exceeded');
          streamController.timeout(timeoutMs);
          break;
        }

        // Process chunk through ResultProcessor
        const processedChunk = await this.resultProcessor.processStreamingChunk(chunk, {
          toolName: originalToolName,
          serverId: streamController.getContext().serverId,
          chunkIndex,
          elapsedMs: Date.now() - startTime,
          outputSchema
        });

        // Add chunk to stream controller
        streamController.addChunk({
          data: processedChunk.data,
          final: processedChunk.final,
          chunkIndex,
          progress: chunk.progress,
          failed: processedChunk.failed,
          validationFailed: processedChunk.validationFailed,
          error: processedChunk.error
        });

        chunkIndex++;
      }
    } catch (err) {
      log.error({ toolName: originalToolName, err }, 'Error during streaming invocation');
      throw err;
    }
  }

  /**
   * Set a per-tool timeout configuration.
   *
   * @param {string} toolName - Tool name to configure
   * @param {number} timeoutMs - Timeout in milliseconds
   */
  setToolTimeout(toolName, timeoutMs) {
    this.timeoutManager.setToolTimeout(toolName, timeoutMs);
  }

  /**
   * Remove a per-tool timeout configuration.
   *
   * @param {string} toolName - Tool name to remove
   * @returns {boolean} True if timeout was removed
   */
  removeToolTimeout(toolName) {
    return this.timeoutManager.removeToolTimeout(toolName);
  }

  /**
   * Get the effective timeout for a tool.
   *
   * @param {string} toolName - Tool name to look up
   * @param {number} [overrideTimeoutMs] - Optional per-invocation override
   * @returns {number} Effective timeout in milliseconds
   */
  getToolTimeout(toolName, overrideTimeoutMs = null) {
    return this.timeoutManager.getTimeout(toolName, overrideTimeoutMs);
  }

  /**
   * Get all per-tool timeout configurations.
   *
   * @returns {Record<string, number>} Map of tool names to timeouts
   */
  getAllToolTimeouts() {
    return this.timeoutManager.getAllToolTimeouts();
  }

  /**
   * Get execution metrics for monitoring.
   *
   * @param {number} [limit=100] - Maximum number of recent metrics to return
   * @returns {Object[]} Recent execution metrics
   */
  getExecutionMetrics(limit = 100) {
    return this.timeoutManager.getRecentMetrics(limit);
  }

  /**
   * Get aggregated timeout statistics.
   *
   * @returns {Object} Aggregated statistics including total invocations, timeouts, success rate, and latency percentiles
   */
  getTimeoutStats() {
    return this.timeoutManager.getTimeoutStats();
  }

  /**
   * Clear all recorded execution metrics.
   */
  clearExecutionMetrics() {
    this.timeoutManager.clearMetrics();
  }

  /**
   * Get circuit breaker state for a tool.
   *
   * @param {string} serverId - MCP server ID
   * @param {string} toolName - Tool name
   * @returns {Object} Circuit breaker state {state, failureCount, openedAt}
   */
  getCircuitBreakerState(serverId, toolName) {
    const circuitBreakerKey = `${serverId}:${toolName}`;
    return this.circuitBreaker.getState(circuitBreakerKey);
  }

  /**
   * Get all circuit breaker states.
   *
   * @returns {Map<string, Object>} Map of circuit breaker keys to states
   */
  getAllCircuitBreakerStates() {
    return this.circuitBreaker.getAllStates();
  }

  /**
   * Manually reset a circuit breaker for a tool.
   *
   * @param {string} serverId - MCP server ID
   * @param {string} toolName - Tool name
   */
  resetCircuitBreaker(serverId, toolName) {
    const circuitBreakerKey = `${serverId}:${toolName}`;
    this.circuitBreaker.reset(circuitBreakerKey);
    log.info({ serverId, toolName, circuitBreakerKey }, 'Circuit breaker manually reset');
  }

  /**
   * Manually reset all circuit breakers.
   */
  resetAllCircuitBreakers() {
    this.circuitBreaker.resetAll();
    log.info('All circuit breakers manually reset');
  }

  /**
   * Get error statistics from error handling coordinator.
   *
   * @returns {Object} Error statistics
   */
  getErrorStatistics() {
    return this.errorHandlingCoordinator.getErrorStatistics();
  }

  /**
   * Get error patterns from error handling coordinator.
   *
   * @returns {Object} Detected error patterns
   */
  getErrorPatterns() {
    return this.errorHandlingCoordinator.getErrorPatterns();
  }

  /**
   * Get error handlers from error handling coordinator.
   *
   * @returns {Array<Object>} Registered error handlers
   */
  getAllErrorHandlers() {
    return this.errorHandlingCoordinator.getAllErrorHandlers();
  }

  /**
   * Register a custom error handler.
   *
   * @param {Object} handler - Handler configuration
   * @returns {string} Handler ID
   */
  registerErrorHandler(handler) {
    return this.errorHandlingCoordinator.registerErrorHandler(handler);
  }

  /**
   * Unregister a custom error handler.
   *
   * @param {string} handlerId - Handler ID to unregister
   * @returns {boolean} True if handler was found and removed
   */
  unregisterErrorHandler(handlerId) {
    return this.errorHandlingCoordinator.unregisterErrorHandler(handlerId);
  }

  /**
   * Clear all error history from error handling coordinator.
   */
  clearErrorHistory() {
    this.errorHandlingCoordinator.clearErrorHistory();
    log.info('Error history cleared');
  }

  /**
   * Get the error handling coordinator instance.
   *
   * @returns {ToolErrorHandlingCoordinator} Error handling coordinator
   */
  getErrorHandlingCoordinator() {
    return this.errorHandlingCoordinator;
  }

  /**
   * Attempt fallback when tool invocation fails.
   *
   * @private
   * @param {Object} tool - Primary tool that failed
   * @param {string} serverId - Primary server ID
   * @param {Object} error - Error that triggered fallback
   * @param {Object} params - Original tool parameters
   * @param {string} operationCategory - Operation category for fallback resolution
   * @param {Object} errorResult - Original error result from coordinator
   * @returns {Promise<Object>} Fallback result or original error if fallback unavailable
   */
  async _attemptFallbackOnInvocationError(tool, serverId, error, params, operationCategory, errorResult) {
    if (!this.fallbackService) {
      log.warn({ toolName: tool.name, serverId }, 'Fallback requested but fallbackService not configured');
      return errorResult;
    }

    log.info({
      toolName: tool.name,
      serverId,
      operationCategory,
      errorCode: error.errorCode
    }, 'Attempting fallback tool invocation');

    try {
      const fallbackResult = await this.fallbackService.attemptFallback({
        primaryTool: tool,
        primaryServerId: serverId,
        primaryError: error,
        args: params,
        operationCategory,
        options: {
          timeoutMs: this.defaultTimeoutMs,
          fallbackPolicy: errorResult.fallback?.policy
        }
      });

      // Handle different fallback result statuses
      switch (fallbackResult.status) {
        case FallbackStatus.SUCCESS:
          log.info({
            toolName: tool.name,
            serverId,
            fallbackTool: fallbackResult.context?.fallbackToolName,
            fallbackServerId: fallbackResult.context?.fallbackServerId
          }, 'Fallback tool invocation succeeded');

          return {
            ...fallbackResult,
            status: 'ok',
            isFallback: true,
            fallbackContext: {
              primaryTool: tool.name,
              primaryServerId: serverId,
              fallbackTool: fallbackResult.context?.fallbackToolName,
              fallbackServerId: fallbackResult.context?.fallbackServerId,
              attemptIndex: fallbackResult.context?.attemptIndex,
              operationCategory
            }
          };

        case FallbackStatus.NO_CANDIDATES:
          log.warn({
            toolName: tool.name,
            serverId,
            operationCategory
          }, 'Fallback failed - no alternative tools available');

          return {
            ...errorResult,
            fallbackAttempted: true,
            fallbackStatus: FallbackStatus.NO_CANDIDATES,
            fallbackError: fallbackResult.error
          };

        case FallbackStatus.NO_COMPATIBLE:
          log.warn({
            toolName: tool.name,
            serverId,
            operationCategory,
            candidateCount: fallbackResult.context?.candidateCount
          }, 'Fallback failed - no compatible alternative tools');

          return {
            ...errorResult,
            fallbackAttempted: true,
            fallbackStatus: FallbackStatus.NO_COMPATIBLE,
            fallbackError: fallbackResult.error
          };

        case FallbackStatus.FAILED:
          log.warn({
            toolName: tool.name,
            serverId,
            operationCategory,
            attemptedCount: fallbackResult.context?.attemptedFallbacks?.length,
            failedCount: fallbackResult.context?.fallbackErrors?.length
          }, 'Fallback failed - all alternative tools failed');

          return {
            ...errorResult,
            fallbackAttempted: true,
            fallbackStatus: FallbackStatus.FAILED,
            fallbackError: fallbackResult.error,
            fallbackAttempts: fallbackResult.context?.attemptedFallbacks || []
          };

        case FallbackStatus.SKIPPED:
          log.debug({
            toolName: tool.name,
            serverId,
            reason: fallbackResult.reason
          }, 'Fallback skipped per policy');

          return errorResult;

        default:
          log.warn({
            toolName: tool.name,
            serverId,
            fallbackStatus: fallbackResult.status
          }, 'Fallback returned unknown status');

          return errorResult;
      }
    } catch (err) {
      log.error({
        toolName: tool.name,
        serverId,
        operationCategory,
        error: err.message
      }, 'Fallback invocation threw exception');

      return {
        ...errorResult,
        fallbackAttempted: true,
        fallbackStatus: FallbackStatus.FAILED,
        fallbackError: `Fallback workflow exception: ${err.message}`
      };
    }
  }
}
