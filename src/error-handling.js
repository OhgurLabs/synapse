/**
 * Error Handling Infrastructure
 * 
 * Provides a standardized error taxonomy and common interface for all core agent types
 * and orchestration components in the Synapse system.
 */

/**
 * Error categories covering all core failure types
 */
export const ErrorCategory = Object.freeze({
  TRANSIENT_NETWORK: 'TRANSIENT_NETWORK',
  AGENT_TIMEOUT: 'AGENT_TIMEOUT',
  TOOL_INVOCATION_FAILURE: 'TOOL_INVOCATION_FAILURE',
  STATE_CORRUPTION: 'STATE_CORRUPTION',
  ORCHESTRATION_FAULT: 'ORCHESTRATION_FAULT',
  RESOURCE_EXHAUSTION: 'RESOURCE_EXHAUSTION',
  AUTH_FAILURE: 'AUTH_FAILURE',
});

/**
 * Error severity levels determining retry and recovery behavior
 */
export const ErrorSeverity = Object.freeze({
  RETRYABLE: 'RETRYABLE',
  DEGRADED: 'DEGRADED',
  FATAL: 'FATAL',
});

/**
 * Base class for all Synapse errors
 * 
 * Conforms to ErrorHandlingInterface specification:
 * - category: ErrorCategory enum value
 * - severity: ErrorSeverity enum value  
 * - errorCode: Machine-readable error code
 * - agentId, taskId, subtaskId, dispatchId, campaignId, projectId: Context fields
 * - timestamp: ISO 8601 timestamp
 * - retryCount: Number of retry attempts
 * - cause: Original error if wrapped
 * - details: Category-specific context
 * - httpStatus: HTTP status code if applicable
 * - suggestedAction: Human-readable recovery suggestion
 * - retryAfterSeconds: Suggested retry delay
 */
export class SynapseError extends Error {
  constructor({
    message,
    category,
    severity,
    errorCode,
    agentId,
    taskId,
    subtaskId,
    dispatchId,
    campaignId,
    projectId,
    cause,
    details,
    httpStatus,
    suggestedAction,
    retryAfterSeconds,
  }) {
    super(message);
    this.name = this.constructor.name;
    
    // Classification - required fields
    this.category = category;
    this.severity = severity;
    this.errorCode = errorCode;
    
    // Context fields - optional
    this.agentId = agentId;
    this.taskId = taskId;
    this.subtaskId = subtaskId;
    this.dispatchId = dispatchId;
    this.campaignId = campaignId;
    this.projectId = projectId;
    
    // Temporal information
    this.timestamp = new Date().toISOString();
    this.retryCount = 0;
    
    // Error chain
    this.cause = cause;
    
    // Additional context
    this.details = details || {};
    this.httpStatus = httpStatus;
    this.suggestedAction = suggestedAction;
    this.retryAfterSeconds = retryAfterSeconds;
    
    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
    
    // Append cause to stack if present
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.message}\n${cause.stack}`;
    }
  }
  
  /**
   * Check if error is retryable
   */
  get isRetryable() {
    return this.severity === ErrorSeverity.RETRYABLE;
  }
  
  /**
   * Get structured payload for monitoring/audit integration
   */
  toPayload() {
    return {
      name: this.name,
      message: this.message,
      category: this.category,
      severity: this.severity,
      errorCode: this.errorCode,
      agentId: this.agentId,
      taskId: this.taskId,
      subtaskId: this.subtaskId,
      dispatchId: this.dispatchId,
      campaignId: this.campaignId,
      projectId: this.projectId,
      timestamp: this.timestamp,
      retryCount: this.retryCount,
      httpStatus: this.httpStatus,
      details: this.details,
      suggestedAction: this.suggestedAction,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
  
  /**
   * Create a retry instance with incremented retry count
   */
  withRetry() {
    const clone = Object.create(Object.getPrototypeOf(this));
    Object.assign(clone, this);
    clone.retryCount = (this.retryCount || 0) + 1;
    clone.timestamp = new Date().toISOString();
    return clone;
  }
}

/**
 * NetworkError - Transient network connectivity issues
 * 
 * Examples: DNS timeouts, connection drops, HTTP 503/504
 * Default severity: RETRYABLE
 */
export class NetworkError extends SynapseError {
  constructor(message, options = {}) {
    const {
      host,
      operation,
      timeoutMs,
      httpStatus,
      ...rest
    } = options;
    
    super({
      message,
      category: ErrorCategory.TRANSIENT_NETWORK,
      severity: ErrorSeverity.RETRYABLE,
      errorCode: options.errorCode || 'NETWORK_ERROR',
      httpStatus,
      details: {
        host,
        operation,
        timeoutMs,
        ...(options.details || {}),
      },
      suggestedAction: 'Retry after brief delay',
      retryAfterSeconds: options.retryAfterSeconds || 2,
      ...rest,
    });
  }
}

/**
 * DNSTimeoutError - DNS resolution exceeded timeout
 */
export class DNSTimeoutError extends NetworkError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'NETWORK_DNS_TIMEOUT',
      operation: 'dns_lookup',
    });
  }
}

/**
 * ConnectionDroppedError - TCP connection dropped mid-operation
 */
export class ConnectionDroppedError extends NetworkError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'NETWORK_CONNECTION_DROPPED',
      operation: 'tcp_connection',
    });
  }
}

/**
 * HTTPError - HTTP-level errors (503, 504, etc.)
 */
export class HTTPError extends NetworkError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: `HTTP_${options.httpStatus || 500}`,
      operation: 'http_request',
    });
  }
}

/**
 * TimeoutError - Agent operations exceeding configured time limits
 * 
 * Examples: Model inference timeout, tool execution timeout
 * Default severity: RETRYABLE
 */
export class TimeoutError extends SynapseError {
  constructor(message, options = {}) {
    const {
      timeoutMs,
      operation,
      ...rest
    } = options;
    
    super({
      message,
      category: ErrorCategory.AGENT_TIMEOUT,
      severity: ErrorSeverity.RETRYABLE,
      errorCode: options.errorCode || 'AGENT_TIMEOUT',
      details: {
        timeoutMs,
        operation,
        ...(options.details || {}),
      },
      suggestedAction: 'Retry with extended timeout or use degraded mode',
      retryAfterSeconds: options.retryAfterSeconds || 4,
      ...rest,
    });
  }
}

/**
 * ModelTimeoutError - Model inference exceeded timeout
 */
export class ModelTimeoutError extends TimeoutError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'AGENT_MODEL_TIMEOUT',
      operation: 'model_inference',
    });
  }
}

/**
 * ToolTimeoutError - Tool execution exceeded timeout
 */
export class ToolTimeoutError extends TimeoutError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'AGENT_TOOL_TIMEOUT',
      operation: 'tool_execution',
    });
  }
}

/**
 * ToolInvocationError - Failed tool or MCP service calls
 * 
 * Examples: Invalid tool parameters, tool not found, MCP protocol errors
 * Default severity: DEGRADED
 */
export class ToolInvocationError extends SynapseError {
  constructor(message, options = {}) {
    const {
      toolName,
      parameters,
      ...rest
    } = options;
    
    super({
      message,
      category: ErrorCategory.TOOL_INVOCATION_FAILURE,
      severity: ErrorSeverity.DEGRADED,
      errorCode: options.errorCode || 'TOOL_INVOCATION_FAILURE',
      details: {
        toolName,
        parameters,
        ...(options.details || {}),
      },
      suggestedAction: 'Check tool parameters and availability',
      ...rest,
    });
  }
}

/**
 * ToolNotFoundError - Requested tool does not exist
 */
export class ToolNotFoundError extends ToolInvocationError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'TOOL_NOT_FOUND',
    });
  }
}

/**
 * InvalidToolParametersError - Tool received invalid parameters
 */
export class InvalidToolParametersError extends ToolInvocationError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'TOOL_INVALID_PARAMS',
    });
  }
}

/**
 * MCPProtocolError - MCP protocol violation
 */
export class MCPProtocolError extends ToolInvocationError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'MCP_PROTOCOL_ERROR',
    });
  }
}

/**
 * StateCorruptionError - Data integrity issues in persistent state
 * 
 * Examples: Checkpoint corruption, JSON parse errors, version conflicts
 * Default severity: FATAL
 */
export class StateCorruptionError extends SynapseError {
  constructor(message, options = {}) {
    super({
      message,
      category: ErrorCategory.STATE_CORRUPTION,
      severity: ErrorSeverity.FATAL,
      errorCode: options.errorCode || 'STATE_CORRUPTION',
      details: options.details || {},
      suggestedAction: 'Manual intervention required - restore from backup',
      ...options,
    });
  }
}

/**
 * CheckpointCorruptionError - Checkpoint file integrity check failed
 */
export class CheckpointCorruptionError extends StateCorruptionError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'STATE_CHECKPOINT_CORRUPT',
    });
  }
}

/**
 * VersionConflictError - Optimistic lock version mismatch
 */
export class VersionConflictError extends StateCorruptionError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'STATE_VERSION_CONFLICT',
    });
  }
}

/**
 * ChecksumMismatchError - Data checksum verification failed
 */
export class ChecksumMismatchError extends StateCorruptionError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'STATE_CHECKSUM_MISMATCH',
    });
  }
}

/**
 * OrchestrationError - Coordinator-level failures in task dispatch or lifecycle
 * 
 * Examples: Invalid task state transitions, campaign state conflicts
 * Default severity: FATAL
 */
export class OrchestrationError extends SynapseError {
  constructor(message, options = {}) {
    super({
      message,
      category: ErrorCategory.ORCHESTRATION_FAULT,
      severity: ErrorSeverity.FATAL,
      errorCode: options.errorCode || 'ORCHESTRATION_FAULT',
      details: options.details || {},
      suggestedAction: 'Manual intervention required - review task state',
      ...options,
    });
  }
}

/**
 * InvalidStateTransitionError - Invalid task state transition attempted
 */
export class InvalidStateTransitionError extends OrchestrationError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'ORCHESTRATION_INVALID_TRANSITION',
    });
  }
}

/**
 * CampaignConflictError - Campaign state prevents operation
 */
export class CampaignConflictError extends OrchestrationError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'ORCHESTRATION_CAMPAIGN_CONFLICT',
    });
  }
}

/**
 * ResourceExhaustionError - System resource limits reached
 * 
 * Examples: Rate limits, memory pressure, connection pool exhaustion
 * Default severity: RETRYABLE
 */
export class ResourceExhaustionError extends SynapseError {
  constructor(message, options = {}) {
    super({
      message,
      category: ErrorCategory.RESOURCE_EXHAUSTION,
      severity: ErrorSeverity.RETRYABLE,
      errorCode: options.errorCode || 'RESOURCE_EXHAUSTION',
      details: options.details || {},
      suggestedAction: 'Wait for resources to become available',
      retryAfterSeconds: options.retryAfterSeconds || 5,
      ...options,
    });
  }
}

/**
 * RateLimitError - API rate limit exceeded
 */
export class RateLimitError extends ResourceExhaustionError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'RESOURCE_RATE_LIMIT',
    });
  }
}

/**
 * ConnectionPoolExhaustedError - Connection pool exhausted
 */
export class ConnectionPoolExhaustedError extends ResourceExhaustionError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'RESOURCE_CONNECTION_POOL_EXHAUSTED',
    });
  }
}

/**
 * AuthError - Identity or permission verification failures
 * 
 * Examples: Invalid tokens, permission denied, expired credentials
 * Default severity: FATAL
 */
export class AuthError extends SynapseError {
  constructor(message, options = {}) {
    super({
      message,
      category: ErrorCategory.AUTH_FAILURE,
      severity: ErrorSeverity.FATAL,
      errorCode: options.errorCode || 'AUTH_FAILURE',
      details: options.details || {},
      suggestedAction: 'Re-authenticate or check permissions',
      ...options,
    });
  }
}

/**
 * AuthenticationError - Authentication token invalid or expired
 */
export class AuthenticationError extends AuthError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'AUTH_INVALID_TOKEN',
    });
  }
}

/**
 * AuthorizationError - Insufficient permissions for operation
 */
export class AuthorizationError extends AuthError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'AUTH_PERMISSION_DENIED',
    });
  }
}

/**
 * ErrorEmitter - Emits errors to monitoring and audit systems
 */
export class ErrorEmitter {
  constructor(config = {}) {
    this.listeners = [];
    this.auditLogger = config.auditLogger;
    this.metricsStore = config.metricsStore;
  }
  
  /**
   * Emit error to all registered listeners
   */
  emit(error) {
    const payload = error.toPayload ? error.toPayload() : {
      name: error.name,
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    };
    
    // Notify all listeners
    for (const listener of this.listeners) {
      try {
        listener(error, payload);
      } catch (err) {
        console.error('Error listener failed:', err);
      }
    }
    
    // Audit log
    if (this.auditLogger) {
      this.auditLogger.logAction({
        type: 'error',
        agentId: error.agentId,
        taskId: error.taskId,
        subtaskId: error.subtaskId,
        dispatchId: error.dispatchId,
        campaignId: error.campaignId,
        projectId: error.projectId,
        reason: error.message,
        blocked: error.severity === ErrorSeverity.FATAL,
      });
    }
    
    // Metrics
    if (this.metricsStore) {
      this.metricsStore.recordError({
        category: error.category,
        severity: error.severity,
        errorCode: error.errorCode,
        agentId: error.agentId,
        timestamp: error.timestamp,
      });
    }
  }
  
  /**
   * Register error listener
   */
  on(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }
}

/**
 * Wrap a standard Error into a SynapseError
 * 
 * Automatically categorizes common error types and preserves the original error chain.
 */
export function wrapError(error, options = {}) {
  if (error instanceof SynapseError) {
    return error;
  }
  
  const defaultCategory = ErrorCategory.ORCHESTRATION_FAULT;
  const defaultSeverity = ErrorSeverity.FATAL;
  
  // Map common error types to categories
  let category = options.category;
  let severity = options.severity;
  
  if (!category) {
    if (error instanceof TypeError || error instanceof SyntaxError) {
      category = ErrorCategory.TOOL_INVOCATION_FAILURE;
      severity = severity || ErrorSeverity.DEGRADED;
    } else if (error.message.includes('timeout') || error.message.includes('Timeout')) {
      category = ErrorCategory.AGENT_TIMEOUT;
      severity = severity || ErrorSeverity.RETRYABLE;
    } else if (error.message.includes('ECONN') || error.message.includes('ENOTFOUND')) {
      category = ErrorCategory.TRANSIENT_NETWORK;
      severity = severity || ErrorSeverity.RETRYABLE;
    }
  }
  
  return new SynapseError({
    message: error.message,
    cause: error,
    ...options,
    category: category || defaultCategory,
    severity: severity || defaultSeverity,
  });
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error) {
  if (error instanceof SynapseError) {
    return error.severity === ErrorSeverity.RETRYABLE;
  }
  return false;
}

/**
 * Get retry delay for an error
 */
export function getRetryDelay(error) {
  if (error instanceof SynapseError) {
    return error.retryAfterSeconds || 2;
  }
  return 2;
}
