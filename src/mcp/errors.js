/**
 * MCP Client Error Types
 * 
 * Structured error classes for MCP connection failures, timeouts, and protocol errors.
 * These errors extend the SynapseError base class for consistent error handling.
 */

import {
  SynapseError,
  ErrorCategory,
  ErrorSeverity,
  NetworkError,
  TimeoutError as BaseTimeoutError,
  ToolInvocationError as BaseToolInvocationError,
  AuthError as BaseAuthError,
} from '../error-handling.js';

/**
 * Base error class for MCP client errors
 * Extends SynapseError for consistent error handling across the system
 */
export class MCPError extends SynapseError {
  constructor(message, options = {}) {
    // Map MCP-specific options to SynapseError fields
    const synapseOptions = {
      message,
      category: options.category || ErrorCategory.TOOL_INVOCATION_FAILURE,
      severity: options.severity || ErrorSeverity.DEGRADED,
      errorCode: options.code || 'MCP_ERROR',
      agentId: options.agentId,
      taskId: options.taskId,
      subtaskId: options.subtaskId,
      dispatchId: options.dispatchId,
      campaignId: options.campaignId,
      projectId: options.projectId,
      cause: options.cause,
      details: {
        serverId: options.serverId,
        ...options.details,
      },
      httpStatus: options.httpStatus,
      suggestedAction: options.suggestedAction,
      retryAfterSeconds: options.retryAfterSeconds,
    };

    super(synapseOptions);

    // MCP-specific fields
    this.serverId = options.serverId || null;
    this.context = options.context || options;
    this.code = options.code || 'MCP_ERROR';
  }

  toJSON() {
    const payload = this.toPayload();
    return {
      ...payload,
      code: this.code,
      context: this.context,
      serverId: this.serverId,
      stack: this.stack,
    };
  }
}

/**
 * Connection error - occurs when unable to establish connection to MCP server
 */
export class ConnectionError extends NetworkError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'MCP_CONNECTION_ERROR',
      operation: 'mcp_connection',
      details: {
        transport: options.transport,
        url: options.url,
        statusCode: options.statusCode,
        reconnectAttempts: options.reconnectAttempts,
        ...(options.details || {}),
      },
    });
    this.serverId = options.serverId || null;
    this.context = options;
    this.retryable = options.retryable !== false;
  }

  toJSON() {
    const payload = this.toPayload();
    return {
      ...payload,
      code: this.errorCode,
      context: this.context,
      serverId: this.serverId,
      stack: this.stack,
    };
  }
}

/**
 * Timeout error - occurs when request or connection times out
 */
export class TimeoutError extends BaseTimeoutError {
  constructor(message, options = {}) {
    const timeoutMs = options.timeoutMs || options.timeout;
    super(message, {
      ...options,
      errorCode: 'MCP_TIMEOUT_ERROR',
      timeoutMs,
      operation: options.operation || 'mcp_request',
      details: {
        timeout: options.timeout,
        method: options.method,
        requestId: options.requestId,
        elapsed: options.elapsed,
        ...(options.details || {}),
      },
    });
    this.serverId = options.serverId || null;
    this.timeoutMs = timeoutMs;
    this.context = options;
    this.retryable = true;
  }

  toJSON() {
    const payload = this.toPayload();
    return {
      ...payload,
      code: this.errorCode,
      context: this.context,
      serverId: this.serverId,
      stack: this.stack,
    };
  }
}

/**
 * Protocol error - occurs when MCP protocol violation or invalid response
 */
export class ProtocolError extends BaseToolInvocationError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'MCP_PROTOCOL_ERROR',
      details: {
        method: options.method,
        expected: options.expected,
        actual: options.actual,
        phase: options.phase,
        received: options.received,
        protocolVersion: options.protocolVersion,
        ...(options.details || {}),
      },
    });
    this.serverId = options.serverId || null;
    this.context = options;
    this.method = options.method || null;
    this.expected = options.expected || null;
    this.actual = options.actual || null;
    this.retryable = false;
  }

  toJSON() {
    const payload = this.toPayload();
    return {
      ...payload,
      code: this.errorCode,
      context: this.context,
      serverId: this.serverId,
      stack: this.stack,
    };
  }
}

/**
 * Authentication error - occurs when authentication fails
 */
export class AuthenticationError extends BaseAuthError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'MCP_AUTHENTICATION_ERROR',
      details: {
        authType: options.authType,
        ...(options.details || {}),
      },
    });
    this.serverId = options.serverId || null;
    this.authType = options.authType || null;
    this.retryable = options.retryable || false;
  }
}

/**
 * Malformed response error - occurs when MCP server returns invalid or unexpected data
 *
 * Enhanced with detailed validation, categorization, and recovery suggestions.
 */
export class MalformedResponseError extends BaseToolInvocationError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      errorCode: 'MCP_MALFORMED_RESPONSE_ERROR',
      details: {
        method: options.method,
        expected: options.expected,
        actual: options.actual,
        validationErrors: options.validationErrors,
        malformationType: options.malformationType,
        extractedData: options.extractedData,
        rawResponse: options.rawResponse,
        recoveryStrategy: options.recoveryStrategy,
        validationDetails: options.validationDetails,
        ...(options.details || {}),
      },
    });
    this.serverId = options.serverId || null;
    this.method = options.method || null;
    this.expected = options.expected || null;
    this.actual = options.actual || null;
    this.validationErrors = options.validationErrors || [];
    this.retryable = false;

    // Enhanced fields
    this.malformationType = options.malformationType || 'UNKNOWN';
    this.severity = options.severity || this._determineSeverity(options.malformationType);
    this.recoverable = options.recoverable !== undefined ? options.recoverable : this._isRecoverable(options.malformationType);
    this.extractedData = options.extractedData || null;
    this.rawResponse = options.rawResponse || null;
    this.recoveryStrategy = options.recoveryStrategy || this._determineRecoveryStrategy(options.malformationType);
    this.validationDetails = options.validationDetails || {};
  }

  /**
   * Parse and validate a raw JSON-RPC response string.
   * Returns a structured result with parsed data or specific error.
   *
   * @param {string} rawResponse - Raw response string from MCP server
   * @param {Object} [options] - Validation options
   * @param {boolean} [options.strict=true] - Strict validation mode
   * @returns {Object} Result with { success, data, error, validationReport }
   */
  static parseAndValidate(rawResponse, options = {}) {
    const { strict = true } = options;
    const validationReport = {
      stage: '',
      passed: false,
      errors: [],
      warnings: [],
      metrics: {}
    };

    // Stage 1: Basic type check
    validationReport.stage = 'type_check';
    if (typeof rawResponse !== 'string') {
      validationReport.errors.push({
        code: 'INVALID_INPUT_TYPE',
        message: `Expected string input, got ${typeof rawResponse}`,
        actual: typeof rawResponse
      });
      return {
        success: false,
        data: null,
        error: new MalformedResponseError(
          `Invalid input type for response parsing: ${typeof rawResponse}`,
          {
            malformationType: 'INVALID_INPUT_TYPE',
            expected: 'string',
            actual: typeof rawResponse,
            validationErrors: validationReport.errors,
            validationDetails: validationReport
          }
        ),
        validationReport
      };
    }

    // Stage 2: Empty check
    validationReport.stage = 'empty_check';
    const trimmed = rawResponse.trim();
    if (trimmed.length === 0) {
      validationReport.errors.push({
        code: 'EMPTY_RESPONSE',
        message: 'Response is empty or whitespace only'
      });
      return {
        success: false,
        data: null,
        error: MalformedResponseError.fromInvalidJSON(rawResponse, {
          message: 'Empty response received',
          position: 0
        }),
        validationReport
      };
    }

    // Stage 3: JSON parsing
    validationReport.stage = 'json_parsing';
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
      validationReport.metrics.parseTime = Date.now();
    } catch (parseErr) {
      validationReport.errors.push({
        code: 'JSON_PARSE_ERROR',
        message: parseErr.message,
        position: parseErr.position || null,
        snippet: trimmed.substring(0, 200)
      });
      return {
        success: false,
        data: null,
        error: MalformedResponseError.fromInvalidJSON(trimmed, parseErr),
        validationReport
      };
    }

    // Stage 4: JSON-RPC structure validation
    validationReport.stage = 'jsonrpc_structure';
    const structValidation = MalformedResponseError.validateJSONRPCStructure(parsed);
    if (!structValidation.valid) {
      validationReport.errors = structValidation.errors;
      validationReport.warnings = structValidation.warnings;
      validationReport.passed = structValidation.canProceed;
      
      // Attempt to extract useful data if possible
      const extractedData = structValidation.canProceed ? parsed : null;
      
      const error = MalformedResponseError.fromProtocolViolation(
        structValidation.errors[0].message,
        parsed,
        {
          validationReport,
          extractedData,
          recoverable: structValidation.canProceed
        }
      );
      
      return {
        success: structValidation.canProceed,
        data: extractedData,
        error: structValidation.canProceed ? null : error,
        validationReport
      };
    }

    validationReport.passed = true;
    validationReport.metrics.validationTime = Date.now();

    return {
      success: true,
      data: parsed,
      error: null,
      validationReport
    };
  }

  /**
   * Validate and normalize a tool result with comprehensive checks.
   *
   * @param {*} result - Result object to validate
   * @param {Object} [options] - Validation options
   * @param {string} [options.toolName] - Name of the tool for context
   * @param {boolean} [options.strict=true] - Strict validation mode
   * @param {boolean} [options.autoRecover=true] - Attempt auto-recovery of malformed data
   * @returns {Object} Result with { valid, normalized, errors, warnings, recovered }
   */
  static validateToolResult(result, options = {}) {
    const { toolName, strict = true, autoRecover = true } = options;
    const report = {
      valid: false,
      normalized: null,
      errors: [],
      warnings: [],
      recovered: false,
      recoveryActions: []
    };

    // Validate structure
    const validation = MalformedResponseError.validateToolCallResult(result);
    
    if (!validation.valid) {
      report.errors = validation.errors;
      report.warnings = validation.warnings;

      // Attempt auto-recovery if enabled
      if (autoRecover && validation.canProceed) {
        try {
          const normalized = this._attemptNormalization(result, validation.errors);
          if (normalized) {
            report.normalized = normalized;
            report.recovered = true;
            report.recoveryActions.push('Auto-normalized malformed content structure');
            report.valid = true;
            return report;
          }
        } catch (recoveryErr) {
          report.warnings.push(`Recovery attempt failed: ${recoveryErr.message}`);
        }
      }

      // Generate specific error
      const error = MalformedResponseError.fromInvalidContentStructure(
        result,
        validation.errors[0].message,
        { toolName, validationReport: report }
      );
      
      return {
        ...report,
        error
      };
    }

    report.valid = true;
    report.normalized = result;
    return report;
  }

  /**
   * Attempt to normalize a malformed result into a valid structure.
   * @private
   * @param {*} result - Malformed result
   * @param {Array} errors - Validation errors
   * @returns {Object|null} Normalized result or null if cannot be recovered
   */
  static _attemptNormalization(result, errors) {
    // Handle missing content array
    if (!result || typeof result !== 'object') {
      return null;
    }

    const normalized = { ...result };
    
    // Wrap non-array content in array
    if (normalized.content !== undefined && !Array.isArray(normalized.content)) {
      normalized.content = [normalized.content];
    }

    // Handle missing content by checking for direct text/data fields
    if (normalized.content === undefined) {
      if (typeof normalized.text === 'string') {
        normalized.content = [{ type: 'text', text: normalized.text }];
      } else if (normalized.data !== undefined) {
        normalized.content = [{ type: 'text', data: String(normalized.data) }];
      } else if (typeof normalized.result === 'string') {
        normalized.content = [{ type: 'text', text: normalized.result }];
      }
    }

    // Ensure content is array
    if (!normalized.content || !Array.isArray(normalized.content)) {
      return null;
    }

    // Validate each content item has required fields
    for (let i = 0; i < normalized.content.length; i++) {
      const item = normalized.content[i];
      if (typeof item !== 'object' || item === null) {
        // Try to convert primitives to text content
        if (typeof item === 'string') {
          normalized.content[i] = { type: 'text', text: item };
        } else {
          return null;
        }
      }
    }

    return normalized;
  }

  /**
   * Determine severity based on malformation type.
   *
   * @private
   * @param {string} malformationType - Type of malformation
   * @returns {string} Severity level (low, medium, high, critical)
   */
  _determineSeverity(malformationType) {
    const severityMap = {
      // Critical - Protocol violations that prevent processing
      'INVALID_JSON': 'critical',
      'MISSING_REQUIRED_FIELDS': 'critical',
      'INVALID_JSON_RPC_VERSION': 'critical',

      // High - Structural issues that prevent proper handling
      'MISSING_RESULT_AND_ERROR': 'high',
      'BOTH_RESULT_AND_ERROR': 'high',
      'INVALID_ID_TYPE': 'high',
      'INVALID_ERROR_STRUCTURE': 'high',

      // Medium - Field type mismatches or unexpected structures
      'INVALID_FIELD_TYPE': 'medium',
      'MISSING_CONTENT_ARRAY': 'medium',
      'INVALID_CONTENT_ITEM': 'medium',
      'UNEXPECTED_ADDITIONAL_FIELDS': 'medium',

      // Low - Minor issues that can be worked around
      'MISSING_OPTIONAL_FIELD': 'low',
      'DEPRECATED_FIELD': 'low',
      'ID_MISMATCH': 'low',

      // Unknown
      'UNKNOWN': 'medium'
    };

    return severityMap[malformationType] || 'medium';
  }

  /**
   * Determine if error is recoverable based on malformation type.
   *
   * @private
   * @param {string} malformationType - Type of malformation
   * @returns {boolean} Whether data can potentially be recovered
   */
  _isRecoverable(malformationType) {
    const recoverableTypes = [
      'MISSING_OPTIONAL_FIELD',
      'UNEXPECTED_ADDITIONAL_FIELDS',
      'DEPRECATED_FIELD',
      'ID_MISMATCH',
      'INVALID_JSON_RPC_VERSION',
      'MISSING_CONTENT_ARRAY'
    ];

    return recoverableTypes.includes(malformationType);
  }

  /**
   * Determine recovery strategy based on malformation type.
   *
   * @private
   * @param {string} malformationType - Type of malformation
   * @returns {string} Recovery strategy description
   */
  _determineRecoveryStrategy(malformationType) {
    const strategyMap = {
      'INVALID_JSON': 'Retry request; check server health; verify transport layer',
      'MISSING_REQUIRED_FIELDS': 'Use default values if safe; report to server maintainer',
      'INVALID_JSON_RPC_VERSION': 'Accept response if structurally valid; log warning',
      'MISSING_RESULT_AND_ERROR': 'Treat as timeout; retry with exponential backoff',
      'BOTH_RESULT_AND_ERROR': 'Prioritize error field per JSON-RPC spec; discard result',
      'INVALID_ID_TYPE': 'Match by position in pending requests; log warning',
      'INVALID_ERROR_STRUCTURE': 'Extract message if available; categorize as UNKNOWN_ERROR',
      'INVALID_FIELD_TYPE': 'Attempt type coercion; fall back to string representation',
      'MISSING_CONTENT_ARRAY': 'Wrap response in content array if possible',
      'INVALID_CONTENT_ITEM': 'Skip invalid items; process valid ones if present',
      'UNEXPECTED_ADDITIONAL_FIELDS': 'Ignore unknown fields; process known fields',
      'MISSING_OPTIONAL_FIELD': 'Continue processing with defaults',
      'DEPRECATED_FIELD': 'Map to new field if known; log migration warning',
      'ID_MISMATCH': 'Match by correlation ID or timestamp; verify response ordering',
      'UNKNOWN': 'Log full response; attempt generic extraction; notify operator'
    };

    return strategyMap[malformationType] || strategyMap['UNKNOWN'];
  }

  /**
   * Create MalformedResponseError from invalid JSON.
   *
   * @param {string} rawText - Raw response text that failed to parse
   * @param {Error} parseError - Original parse error
   * @param {Object} [context={}] - Additional context
   * @returns {MalformedResponseError}
   */
  static fromInvalidJSON(rawText, parseError, context = {}) {
    const snippet = rawText.length > 200 ? rawText.substring(0, 200) + '...' : rawText;

    return new MalformedResponseError(
      `Invalid JSON received from server: ${parseError.message}`,
      {
        malformationType: 'INVALID_JSON',
        expected: 'Valid JSON',
        actual: snippet,
        rawResponse: rawText,
        validationErrors: [{
          field: '',
          constraint: 'json_syntax',
          message: parseError.message,
          position: parseError.position || null
        }],
        validationDetails: {
          parseError: parseError.message,
          snippet
        },
        ...context
      }
    );
  }

  /**
   * Create MalformedResponseError from missing required fields.
   *
   * @param {Object} response - Response object
   * @param {Array<string>} missingFields - List of missing required fields
   * @param {Object} [context={}] - Additional context
   * @returns {MalformedResponseError}
   */
  static fromMissingFields(response, missingFields, context = {}) {
    const fieldList = missingFields.join(', ');

    return new MalformedResponseError(
      `Response missing required fields: ${fieldList}`,
      {
        malformationType: 'MISSING_REQUIRED_FIELDS',
        expected: `Object with fields: ${fieldList}`,
        actual: response,
        rawResponse: response,
        validationErrors: missingFields.map(field => ({
          field,
          constraint: 'required',
          message: `Required field "${field}" is missing`
        })),
        validationDetails: {
          missingFields,
          presentFields: Object.keys(response || {})
        },
        ...context
      }
    );
  }

  /**
   * Create MalformedResponseError from invalid field type.
   *
   * @param {string} field - Field name
   * @param {string} expectedType - Expected type
   * @param {*} actualValue - Actual value
   * @param {Object} [context={}] - Additional context
   * @returns {MalformedResponseError}
   */
  static fromInvalidFieldType(field, expectedType, actualValue, context = {}) {
    const actualType = actualValue === null ? 'null' : typeof actualValue;

    return new MalformedResponseError(
      `Field "${field}" has invalid type: expected ${expectedType}, got ${actualType}`,
      {
        malformationType: 'INVALID_FIELD_TYPE',
        expected: expectedType,
        actual: actualType,
        rawResponse: actualValue,
        validationErrors: [{
          field,
          constraint: 'type',
          message: `Expected type ${expectedType}, got ${actualType}`,
          expected: expectedType,
          actual: actualValue
        }],
        validationDetails: {
          field,
          expectedType,
          actualType,
          actualValue
        },
        ...context
      }
    );
  }

  /**
   * Create MalformedResponseError from protocol violation.
   *
   * @param {string} violation - Description of protocol violation
   * @param {Object} response - Response object
   * @param {Object} [context={}] - Additional context
   * @returns {MalformedResponseError}
   */
  static fromProtocolViolation(violation, response, context = {}) {
    // Determine specific malformation type from violation description
    let malformationType = 'UNKNOWN';

    if (violation.includes('both result and error')) {
      malformationType = 'BOTH_RESULT_AND_ERROR';
    } else if (violation.includes('missing result and error')) {
      malformationType = 'MISSING_RESULT_AND_ERROR';
    } else if (violation.includes('jsonrpc version')) {
      malformationType = 'INVALID_JSON_RPC_VERSION';
    } else if (violation.includes('id type')) {
      malformationType = 'INVALID_ID_TYPE';
    }

    return new MalformedResponseError(
      `JSON-RPC protocol violation: ${violation}`,
      {
        malformationType,
        expected: 'Valid JSON-RPC 2.0 response',
        actual: response,
        rawResponse: response,
        validationErrors: [{
          field: '',
          constraint: 'protocol',
          message: violation
        }],
        validationDetails: {
          violation,
          jsonrpcVersion: response?.jsonrpc,
          hasResult: response?.result !== undefined,
          hasError: response?.error !== undefined
        },
        ...context
      }
    );
  }

  /**
   * Create MalformedResponseError from invalid content structure.
   *
   * @param {Object} result - Tool result object
   * @param {string} issue - Description of the issue
   * @param {Object} [context={}] - Additional context
   * @returns {MalformedResponseError}
   */
  static fromInvalidContentStructure(result, issue, context = {}) {
    const hasContent = result?.content !== undefined;
    const isArray = Array.isArray(result?.content);

    let malformationType = 'INVALID_CONTENT_ITEM';
    if (!hasContent) {
      malformationType = 'MISSING_CONTENT_ARRAY';
    } else if (!isArray) {
      malformationType = 'INVALID_FIELD_TYPE';
    }

    return new MalformedResponseError(
      `Invalid tool result content structure: ${issue}`,
      {
        malformationType,
        expected: 'Object with content array',
        actual: result,
        rawResponse: result,
        validationErrors: [{
          field: 'content',
          constraint: 'structure',
          message: issue
        }],
        validationDetails: {
          issue,
          hasContent,
          isArray,
          contentType: hasContent ? (isArray ? 'array' : typeof result.content) : 'missing'
        },
        // Attempt data extraction if content exists in any form
        extractedData: hasContent ? { content: isArray ? result.content : [result.content] } : null,
        recoverable: hasContent,
        ...context
      }
    );
  }

  /**
   * Validate JSON-RPC response structure and return validation result.
   *
   * @param {*} response - Response to validate
   * @returns {Object} Validation result with { valid, errors, warnings, canProceed }
   */
  static validateJSONRPCStructure(response) {
    const errors = [];
    const warnings = [];

    // Check if response is an object
    if (response === null || typeof response !== 'object') {
      errors.push({
        field: '',
        constraint: 'type',
        message: 'Response must be an object',
        expected: 'object',
        actual: response === null ? 'null' : typeof response
      });
      return { valid: false, errors, warnings, canProceed: false };
    }

    // Check jsonrpc version
    if (response.jsonrpc === undefined) {
      warnings.push('Missing jsonrpc field (should be "2.0")');
    } else if (response.jsonrpc !== '2.0') {
      warnings.push(`Non-standard jsonrpc version: ${response.jsonrpc} (expected "2.0")`);
    }

    // Check id field
    if (response.id === undefined) {
      errors.push({
        field: 'id',
        constraint: 'required',
        message: 'Missing required field: id'
      });
    } else {
      const idType = typeof response.id;
      if (idType !== 'string' && idType !== 'number' && response.id !== null) {
        errors.push({
          field: 'id',
          constraint: 'type',
          message: 'id must be string, number, or null',
          expected: 'string|number|null',
          actual: idType
        });
      }
    }

    // Check for result or error (must have one, not both)
    const hasResult = response.result !== undefined;
    const hasError = response.error !== undefined;

    if (!hasResult && !hasError) {
      errors.push({
        field: '',
        constraint: 'protocol',
        message: 'Response must have either result or error field'
      });
    } else if (hasResult && hasError) {
      errors.push({
        field: '',
        constraint: 'protocol',
        message: 'Response cannot have both result and error fields'
      });
    }

    // Validate error structure if present
    if (hasError) {
      if (typeof response.error !== 'object' || response.error === null) {
        errors.push({
          field: 'error',
          constraint: 'type',
          message: 'error field must be an object',
          expected: 'object',
          actual: typeof response.error
        });
      } else {
        if (response.error.code === undefined) {
          warnings.push('error.code field is missing (required by JSON-RPC 2.0)');
        } else if (typeof response.error.code !== 'number') {
          errors.push({
            field: 'error.code',
            constraint: 'type',
            message: 'error.code must be a number',
            expected: 'number',
            actual: typeof response.error.code
          });
        }

        if (response.error.message === undefined) {
          errors.push({
            field: 'error.message',
            constraint: 'required',
            message: 'error.message is required'
          });
        } else if (typeof response.error.message !== 'string') {
          errors.push({
            field: 'error.message',
            constraint: 'type',
            message: 'error.message must be a string',
            expected: 'string',
            actual: typeof response.error.message
          });
        }
      }
    }

    const valid = errors.length === 0;
    const canProceed = valid || (errors.length === 1 && errors[0].field === 'jsonrpc');

    return {
      valid,
      errors,
      warnings,
      canProceed
    };
  }

  /**
   * Validate tool call result structure.
   *
   * @param {*} result - Result to validate
   * @returns {Object} Validation result with { valid, errors, warnings, canProceed }
   */
  static validateToolCallResult(result) {
    const errors = [];
    const warnings = [];

    // Check if result is an object
    if (result === null || typeof result !== 'object') {
      errors.push({
        field: '',
        constraint: 'type',
        message: 'Tool result must be an object',
        expected: 'object',
        actual: result === null ? 'null' : typeof result
      });
      return { valid: false, errors, warnings, canProceed: false };
    }

    // Check content array
    if (result.content === undefined) {
      errors.push({
        field: 'content',
        constraint: 'required',
        message: 'Missing required field: content'
      });
      return { valid: false, errors, warnings, canProceed: false };
    }

    if (!Array.isArray(result.content)) {
      errors.push({
        field: 'content',
        constraint: 'type',
        message: 'content must be an array',
        expected: 'array',
        actual: typeof result.content
      });
      return { valid: false, errors, warnings, canProceed: false };
    }

    // Validate content items
    result.content.forEach((item, index) => {
      if (item === null || typeof item !== 'object') {
        errors.push({
          field: `content[${index}]`,
          constraint: 'type',
          message: 'Content item must be an object',
          expected: 'object',
          actual: item === null ? 'null' : typeof item
        });
        return;
      }

      if (item.type === undefined) {
        errors.push({
          field: `content[${index}].type`,
          constraint: 'required',
          message: 'Content item missing required field: type'
        });
      } else {
        const validTypes = ['text', 'image', 'resource', 'audio', 'video'];
        if (!validTypes.includes(item.type)) {
          warnings.push(`content[${index}].type has unknown value: ${item.type}`);
        }

        // Type-specific validation
        if (item.type === 'text' && item.text === undefined) {
          errors.push({
            field: `content[${index}].text`,
            constraint: 'required',
            message: 'Text content item missing required field: text'
          });
        }
        if ((item.type === 'image' || item.type === 'audio' || item.type === 'video') && item.data === undefined) {
          errors.push({
            field: `content[${index}].data`,
            constraint: 'required',
            message: `${item.type} content item missing required field: data`
          });
        }
        if (item.type === 'resource' && item.uri === undefined) {
          errors.push({
            field: `content[${index}].uri`,
            constraint: 'required',
            message: 'Resource content item missing required field: uri'
          });
        }
      }
    });

    // Check isError field
    if (result.isError !== undefined && typeof result.isError !== 'boolean') {
      warnings.push('isError field should be a boolean');
    }

    const valid = errors.length === 0;
    const canProceed = valid || errors.every(e => e.constraint !== 'required');

    return {
      valid,
      errors,
      warnings,
      canProceed
    };
  }

  toJSON() {
    return {
      ...super.toJSON(),
      malformationType: this.malformationType,
      severity: this.severity,
      recoverable: this.recoverable,
      recoveryStrategy: this.recoveryStrategy,
      validationErrors: this.validationErrors,
      validationDetails: this.validationDetails,
      extractedData: this.extractedData,
      method: this.method,
      expected: this.expected,
      actual: this.actual
    };
  }
}

/**
 * ResponseValidator - Comprehensive validation utilities for MCP responses.
 * 
 * Provides static methods for validating JSON-RPC responses, tool results,
 * and streaming chunks with detailed error reporting and auto-recovery.
 */
export class ResponseValidator {
  /**
   * Validate a complete JSON-RPC response with full schema checking.
   *
   * @param {*} response - Response to validate
   * @param {Object} [options] - Validation options
   * @param {boolean} [options.strict=true] - Strict mode (fail on warnings)
   * @param {boolean} [options.validateResult=true] - Also validate result structure
   * @param {string} [options.expectedMethod] - Expected method for correlation
   * @returns {ValidationResult}
   */
  static validateJSONRPC(response, options = {}) {
    const { strict = true, validateResult = true, expectedMethod } = options;
    const result = {
      valid: true,
      errors: [],
      warnings: [],
      data: null,
      canProceed: false
    };

    // Basic type check
    if (response === null || typeof response !== 'object') {
      result.valid = false;
      result.errors.push({
        field: 'root',
        code: 'INVALID_TYPE',
        message: `Response must be an object, got ${typeof response}`,
        expected: 'object',
        actual: typeof response
      });
      return result;
    }

    // Validate jsonrpc field
    if (response.jsonrpc === undefined) {
      if (strict) {
        result.valid = false;
        result.errors.push({
          field: 'jsonrpc',
          code: 'MISSING_FIELD',
          message: 'Missing required field: jsonrpc'
        });
      } else {
        result.warnings.push('Missing jsonrpc field (should be "2.0")');
      }
    } else if (response.jsonrpc !== '2.0') {
      result.warnings.push(`Non-standard jsonrpc version: ${response.jsonrpc}`);
    }

    // Validate id field
    if (response.id === undefined) {
      result.valid = false;
      result.errors.push({
        field: 'id',
        code: 'MISSING_FIELD',
        message: 'Missing required field: id'
      });
    } else if (typeof response.id !== 'string' && typeof response.id !== 'number' && response.id !== null) {
      result.valid = false;
      result.errors.push({
        field: 'id',
        code: 'INVALID_TYPE',
        message: 'id must be string, number, or null',
        expected: 'string|number|null',
        actual: typeof response.id
      });
    }

    // Check for result/error exclusivity
    const hasResult = response.result !== undefined;
    const hasError = response.error !== undefined;

    if (!hasResult && !hasError) {
      result.valid = false;
      result.errors.push({
        field: '',
        code: 'PROTOCOL_VIOLATION',
        message: 'Response must have exactly one of: result or error'
      });
      result.canProceed = false;
    } else if (hasResult && hasError) {
      result.valid = false;
      result.errors.push({
        field: '',
        code: 'PROTOCOL_VIOLATION',
        message: 'Response cannot have both result and error'
      });
      result.canProceed = true; // Can proceed with error
    }

    // Validate error structure if present
    if (hasError) {
      if (typeof response.error !== 'object' || response.error === null) {
        result.valid = false;
        result.errors.push({
          field: 'error',
          code: 'INVALID_TYPE',
          message: 'error must be an object',
          expected: 'object',
          actual: typeof response.error
        });
      } else {
        // Validate error.code
        if (response.error.code === undefined) {
          if (strict) {
            result.valid = false;
            result.errors.push({
              field: 'error.code',
              code: 'MISSING_FIELD',
              message: 'error.code is required'
            });
          } else {
            result.warnings.push('error.code is missing');
          }
        } else if (typeof response.error.code !== 'number') {
          result.valid = false;
          result.errors.push({
            field: 'error.code',
            code: 'INVALID_TYPE',
            message: 'error.code must be a number',
            expected: 'number',
            actual: typeof response.error.code
          });
        }

        // Validate error.message
        if (response.error.message === undefined) {
          result.valid = false;
          result.errors.push({
            field: 'error.message',
            code: 'MISSING_FIELD',
            message: 'error.message is required'
          });
        } else if (typeof response.error.message !== 'string') {
          result.valid = false;
          result.errors.push({
            field: 'error.message',
            code: 'INVALID_TYPE',
            message: 'error.message must be a string',
            expected: 'string',
            actual: typeof response.error.message
          });
        }
      }

      result.canProceed = true;
      result.data = response.error;
    } else if (hasResult) {
      result.canProceed = true;
      result.data = response.result;

      // Validate result structure if requested
      if (validateResult && expectedMethod === 'tools/call') {
        const toolValidation = this.validateToolResult(response.result);
        if (!toolValidation.valid) {
          result.valid = false;
          result.errors.push(...toolValidation.errors);
          result.warnings.push(...toolValidation.warnings);
        }
      }
    }

    return result;
  }

  /**
   * Validate a tool result specifically.
   *
   * @param {*} result - Tool result to validate
   * @returns {ValidationResult}
   */
  static validateToolResult(result) {
    const validation = MalformedResponseError.validateToolCallResult(result);
    return {
      valid: validation.valid,
      errors: validation.errors.map(e => ({
        field: e.field,
        code: e.constraint === 'required' ? 'MISSING_FIELD' : 'INVALID_TYPE',
        message: e.message,
        ...e
      })),
      warnings: validation.warnings,
      canProceed: validation.canProceed
    };
  }

  /**
   * Validate a streaming chunk.
   *
   * @param {*} chunk - Chunk to validate
   * @param {number} [expectedIndex] - Expected index for ordering validation
   * @returns {ValidationResult}
   */
  static validateChunk(chunk, expectedIndex = null) {
    const result = {
      valid: true,
      errors: [],
      warnings: [],
      canProceed: true
    };

    if (chunk === null || typeof chunk !== 'object') {
      result.valid = false;
      result.errors.push({
        field: 'chunk',
        code: 'INVALID_TYPE',
        message: 'Chunk must be an object',
        expected: 'object',
        actual: typeof chunk
      });
      result.canProceed = false;
      return result;
    }

    // Check for data field
    if (chunk.data === undefined) {
      result.valid = false;
      result.errors.push({
        field: 'data',
        code: 'MISSING_FIELD',
        message: 'Chunk missing required field: data'
      });
      result.canProceed = false;
    }

    // Check index if expected
    if (expectedIndex !== null && chunk.index !== undefined) {
      if (chunk.index !== expectedIndex) {
        result.warnings.push(
          `Chunk index mismatch: expected ${expectedIndex}, got ${chunk.index}`
        );
      }
    }

    // Check status if present
    if (chunk.status !== undefined && !['partial', 'complete', 'error'].includes(chunk.status)) {
      result.warnings.push(
        `Unexpected chunk status: ${chunk.status} (expected: partial, complete, or error)`
      );
    }

    return result;
  }

  /**
   * Attempt to recover data from a malformed response.
   *
   * @param {*} response - Malformed response
   * @param {Object} [options] - Recovery options
   * @returns {Object} Recovery result with { success, data, strategy, warnings }
   */
  static attemptRecovery(response, options = {}) {
    const result = {
      success: false,
      data: null,
      strategy: null,
      warnings: []
    };

    // Strategy 1: Check if it's a valid tool result but wrapped incorrectly
    if (typeof response === 'object' && response !== null) {
      // Check for nested result
      if (response.result && typeof response.result === 'object') {
        const toolValidation = this.validateToolResult(response.result);
        if (toolValidation.valid) {
          result.success = true;
          result.data = response.result;
          result.strategy = 'extracted_nested_result';
          result.warnings.push('Response was wrapped in extra object layer');
          return result;
        }
      }

      // Check if response itself is a valid tool result
      const directValidation = this.validateToolResult(response);
      if (directValidation.valid) {
        result.success = true;
        result.data = response;
        result.strategy = 'direct_tool_result';
        return result;
      }

      // Try to extract content array from any field
      if (Array.isArray(response.content)) {
        result.success = true;
        result.data = {
          content: response.content,
          isError: response.isError || false
        };
        result.strategy = 'extracted_content_array';
        result.warnings.push('Constructed result from content array field');
        return result;
      }
    }

    // Strategy 2: String response - try JSON parse
    if (typeof response === 'string') {
      try {
        const parsed = JSON.parse(response);
        const validation = this.validateToolResult(parsed);
        if (validation.valid) {
          result.success = true;
          result.data = parsed;
          result.strategy = 'parsed_string_as_json';
          return result;
        }
      } catch (e) {
        // Not JSON, treat as plain text
        result.success = true;
        result.data = {
          content: [{ type: 'text', text: response }],
          isError: false
        };
        result.strategy = 'treated_as_plain_text';
        result.warnings.push('Response treated as plain text content');
        return result;
      }
    }

    return result;
  }
}

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether validation passed
 * @property {Array<Object>} errors - List of validation errors
 * @property {Array<string>} warnings - List of warnings
 * @property {boolean} canProceed - Whether processing can continue despite errors
 * @property {*} [data] - Extracted data if available
 */

/**
 * Discovery error - occurs during tool discovery from MCP servers
 * Used for detailed error reporting with per-server context
 */
export class DiscoveryError extends MCPError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'DiscoveryError';
    this.code = 'DISCOVERY_ERROR';
    this.serverName = options.serverName || null;
    this.errorType = options.errorType || 'UNKNOWN';
    this.retryable = options.retryable !== false;
    this.timeoutMs = options.timeoutMs || null;
    this.partialResults = options.partialResults || [];
  }
}
