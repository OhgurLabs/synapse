import { createLogger } from '../logger.js';
import {
  JSONRPCErrorCodes,
  MCPErrorCodes,
  isJSONRPCErrorResponse,
  isJSONRPCResponse
} from './result-types.js';

const log = createLogger('error-response-processor');

export class ErrorResponseProcessor {
  constructor(options = {}) {
    this.enableDetailedLogging = options.enableDetailedLogging ?? false;
    this.includeOriginalError = options.includeOriginalError ?? true;
    this.strictMode = options.strictMode ?? true;
  }

  async process(errorResponse, context = {}) {
    const { toolName, serverId, toolId, requestId } = context;

    try {
      if (!errorResponse || typeof errorResponse !== 'object') {
        return this._createUnknownErrorResult(
          'Invalid error response: response is null or not an object',
          context
        );
      }

      if (!isJSONRPCResponse(errorResponse)) {
        return this._createMalformedErrorResult(
          'Invalid JSON-RPC response structure',
          errorResponse,
          context
        );
      }

      if (!isJSONRPCErrorResponse(errorResponse)) {
        return this._createMalformedErrorResult(
          'Response is missing error object',
          errorResponse,
          context
        );
      }

      const error = errorResponse.error;
      const errorInfo = this._extractErrorInfo(error, context);
      const errorCode = error.code;
      const mappedCode = this._mapErrorCode(errorCode);

      const isRetryable = this._determineRetryable(errorCode, mappedCode.code);
      const severity = mappedCode.severity || this._determineSeverity(errorCode, mappedCode.code);
      const category = this._categorizeError(errorCode, mappedCode.code);

      const result = {
        status: 'error',
        code: mappedCode.code,
        message: mappedCode.message,
        error: {
          type: 'JSONRPCError',
          code: errorCode,
          message: error.message,
          data: error.data
        },
        serverId,
        toolName,
        toolId,
        requestId,
        source: 'mcp',
        serverSource: serverId,
        retryable: isRetryable,
        severity,
        category,
        originalResponse: this.includeOriginalError ? errorResponse : undefined
      };

      if (this.enableDetailedLogging) {
        log.debug({
          toolName,
          serverId,
          errorCode,
          mappedCode: mappedCode.code,
          retryable: isRetryable,
          severity,
          category
        }, 'Error response processed');
      }

      return result;
    } catch (err) {
      log.error({
        toolName,
        serverId,
        err,
        errorResponse
      }, 'Error response processing failed');

      return this._createUnknownErrorResult(
        `Error response processing failed: ${err.message}`,
        context
      );
    }
  }

  async processMalformedResponse(rawResponse, context = {}) {
    const { toolName, serverId } = context;

    try {
      const extractedData = this._extractDataFromMalformedResponse(rawResponse);
      const validationErrors = this._validateMalformedResponse(rawResponse);

      const result = {
        status: 'error',
        code: 'MALFORMED_RESPONSE',
        message: 'Malformed MCP response received',
        error: {
          type: 'MalformedResponseError',
          message: 'Response does not conform to JSON-RPC 2.0 or MCP protocol',
          validationErrors
        },
        serverId,
        toolName,
        source: 'mcp',
        serverSource: serverId,
        extractedData,
        rawResponse: this.includeOriginalError ? rawResponse : undefined,
        validationErrors,
        canRetry: extractedData !== null,
        retryable: false,
        severity: 'high',
        category: 'protocol'
      };

      log.warn({
        toolName,
        serverId,
        extractedData: extractedData !== null,
        validationErrors: validationErrors.length
      }, 'Malformed response processed');

      return result;
    } catch (err) {
      log.error({
        toolName,
        serverId,
        err,
        rawResponse
      }, 'Malformed response processing failed');

      return this._createUnknownErrorResult(
        `Malformed response processing failed: ${err.message}`,
        context
      );
    }
  }

  async processTimeout(timeoutContext, context = {}) {
    const { toolName, serverId, toolId, requestId } = context;
    const { timeoutMs, elapsedMs, partialChunks } = timeoutContext;

    const result = {
      status: 'error',
      code: 'TIMEOUT',
      message: `Tool invocation timed out after ${timeoutMs}ms (elapsed: ${elapsedMs}ms)`,
      error: {
        type: 'TimeoutError',
        timeoutMs,
        elapsedMs
      },
      serverId,
      toolName,
      toolId,
      requestId,
      source: 'mcp',
      serverSource: serverId,
      retryable: true,
      severity: 'medium',
      category: 'timeout',
      partialChunks: partialChunks || [],
      chunksCollected: partialChunks?.length || 0
    };

    log.warn({
      toolName,
      serverId,
      timeoutMs,
      elapsedMs,
      chunksCollected: result.chunksCollected
    }, 'Timeout error processed');

    return result;
  }

  async processConnectionError(connectionError, context = {}) {
    const { toolName, serverId, toolId, requestId } = context;
    const { message, code, retryable, reconnectAttempts } = connectionError;

    const result = {
      status: 'error',
      code: code || 'CONNECTION_ERROR',
      message: message || 'MCP connection error',
      error: {
        type: 'ConnectionError',
        originalMessage: message
      },
      serverId,
      toolName,
      toolId,
      requestId,
      source: 'mcp',
      serverSource: serverId,
      retryable: retryable !== false,
      severity: 'high',
      category: 'connection',
      reconnectAttempts: reconnectAttempts || 0
    };

    log.error({
      toolName,
      serverId,
      code: result.code,
      retryable: result.retryable
    }, 'Connection error processed');

    return result;
  }

  async processValidationError(validationError, context = {}) {
    const { toolName, serverId, toolId, requestId } = context;
    const { errors, field, constraint, actual, expected } = validationError;

    const validationErrors = Array.isArray(errors) ? errors : [validationError];

    const result = {
      status: 'error',
      code: 'VALIDATION_FAILED',
      message: toolName ? `Parameter validation failed for tool: ${toolName}` : 'Parameter validation failed',
      error: {
        type: 'ValidationError',
        message: 'Tool invocation parameters failed validation',
        validationErrors
      },
      serverId,
      toolName,
      toolId,
      requestId,
      source: 'mcp',
      serverSource: serverId,
      retryable: false,
      severity: 'low',
      category: 'validation',
      validationErrors: validationErrors.map(err => ({
        field: err.field || field,
        constraint: err.constraint || constraint,
        message: err.message || 'Validation constraint violated',
        actual: err.actual !== undefined ? err.actual : actual,
        expected: err.expected !== undefined ? err.expected : expected
      })),
      details: validationErrors.map(err => ({
        field: err.field || field,
        constraint: err.constraint || constraint,
        message: err.message || 'Validation constraint violated',
        actual: err.actual !== undefined ? err.actual : actual,
        expected: err.expected !== undefined ? err.expected : expected
      }))
    };

    log.debug({
      toolName,
      serverId,
      errorCount: validationErrors.length
    }, 'Validation error processed');

    return result;
  }

  async processToolExecutionError(executionError, context = {}) {
    const { toolName, serverId, toolId, requestId, elapsedMs } = context;
    const { message, errorCode, stack, originalError } = executionError;

    const mappedCode = this._mapExecutionErrorCode(errorCode || 'TOOL_EXECUTION_FAILED');
    const isRetryable = this._determineExecutionErrorRetryable(errorCode);

    // Preserve original error type if available, otherwise use ToolExecutionError
    const originalErrorType = originalError?.constructor?.name || 'Error';

    const result = {
      status: 'error',
      code: mappedCode.code,
      message: message || mappedCode.message,
      error: {
        type: originalErrorType,
        code: errorCode,
        message,
        stack: this.includeOriginalError ? stack : undefined,
        originalError: this.includeOriginalError ? originalError : undefined,
        elapsedMs
      },
      serverId,
      toolName,
      toolId,
      requestId,
      source: 'mcp',
      serverSource: serverId,
      retryable: isRetryable,
      severity: 'medium',
      category: 'execution',
      elapsedMs
    };

    log.error({
      toolName,
      serverId,
      code: mappedCode.code,
      retryable: isRetryable
    }, 'Tool execution error processed');

    return result;
  }

  _extractErrorInfo(error, context) {
    const info = {
      code: error.code,
      message: error.message,
      data: error.data,
      serverId: context.serverId,
      toolName: context.toolName,
      timestamp: new Date().toISOString()
    };

    if (error.data && typeof error.data === 'object') {
      if (error.data.field) info.field = error.data.field;
      if (error.data.constraint) info.constraint = error.data.constraint;
      if (error.data.expected) info.expected = error.data.expected;
      if (error.data.actual) info.actual = error.data.actual;
      if (error.data.validationErrors) info.validationErrors = error.data.validationErrors;
      if (error.data.retryable !== undefined) info.serverRetryable = error.data.retryable;
    }

    return info;
  }

  _mapErrorCode(code) {
    if (code === JSONRPCErrorCodes.PARSE_ERROR) {
      return { code: 'PARSE_ERROR', message: 'Invalid JSON was received' };
    }
    if (code === JSONRPCErrorCodes.INVALID_REQUEST) {
      return { code: 'INVALID_REQUEST', message: 'The JSON sent is not a valid Request object' };
    }
    if (code === JSONRPCErrorCodes.METHOD_NOT_FOUND) {
      return { code: 'METHOD_NOT_FOUND', message: 'The method does not exist' };
    }
    if (code === JSONRPCErrorCodes.INVALID_PARAMS) {
      return { code: 'INVALID_PARAMS', message: 'Invalid method parameter(s)' };
    }
    if (code === JSONRPCErrorCodes.INTERNAL_ERROR) {
      return { code: 'INTERNAL_ERROR', message: 'Internal JSON-RPC error' };
    }

    if (code === MCPErrorCodes.TOOL_NOT_FOUND) {
      return { code: 'TOOL_NOT_FOUND', message: 'Tool not found on server' };
    }
    if (code === MCPErrorCodes.TOOL_EXECUTION_FAILED) {
      return { code: 'TOOL_EXECUTION_FAILED', message: 'Tool execution failed' };
    }
    if (code === MCPErrorCodes.SERVER_ERROR) {
      return { code: 'SERVER_ERROR', message: 'Server error' };
    }
    if (code === MCPErrorCodes.TIMEOUT) {
      return { code: 'TIMEOUT', message: 'Tool execution timed out' };
    }
    if (code === MCPErrorCodes.RATE_LIMITED) {
      return { code: 'RATE_LIMITED', message: 'Rate limit exceeded' };
    }
    if (code === MCPErrorCodes.AUTHENTICATION_FAILED) {
      return { code: 'AUTHENTICATION_FAILED', message: 'Authentication failed' };
    }
    if (code === MCPErrorCodes.PERMISSION_DENIED) {
      return { code: 'PERMISSION_DENIED', message: 'Permission denied' };
    }
    if (code === MCPErrorCodes.RESOURCE_NOT_FOUND) {
      return { code: 'RESOURCE_NOT_FOUND', message: 'Resource not found' };
    }
    if (code === MCPErrorCodes.INVALID_TOOL_ARGUMENTS) {
      return { code: 'INVALID_TOOL_ARGUMENTS', message: 'Invalid tool arguments' };
    }

    return {
      code: `UNKNOWN_ERROR_${code}`,
      message: `Unknown error code: ${code}`,
      severity: 'medium'
    };
  }

  _mapExecutionErrorCode(errorCode) {
    const codeMap = {
      'TOOL_EXECUTION_FAILED': { code: 'TOOL_EXECUTION_FAILED', message: 'Tool execution failed' },
      'RESOURCE_NOT_FOUND': { code: 'RESOURCE_NOT_FOUND', message: 'Resource not found' },
      'PERMISSION_DENIED': { code: 'PERMISSION_DENIED', message: 'Permission denied' },
      'AUTHENTICATION_FAILED': { code: 'AUTHENTICATION_FAILED', message: 'Authentication failed' },
      'RATE_LIMITED': { code: 'RATE_LIMITED', message: 'Rate limit exceeded' },
      'INVALID_ARGUMENTS': { code: 'INVALID_TOOL_ARGUMENTS', message: 'Invalid tool arguments' },
      'CONNECTION_LOST': { code: 'CONNECTION_ERROR', message: 'Connection lost during execution' },
      'INVALID_SOURCE': { code: 'INVALID_SOURCE', message: 'Invalid tool source format' },
      'TOOL_NOT_FOUND': { code: 'TOOL_NOT_FOUND', message: 'Tool not found' },
      'SERVER_NOT_CONNECTED': { code: 'SERVER_NOT_CONNECTED', message: 'MCP server not connected' },
      'VALIDATION_FAILED': { code: 'VALIDATION_FAILED', message: 'Parameter validation failed' },
      'INVOCATION_FAILED': { code: 'INVOCATION_FAILED', message: 'Tool invocation failed' }
    };

    return codeMap[errorCode] || {
      code: 'TOOL_EXECUTION_FAILED',
      message: 'Tool execution failed'
    };
  }

  _determineRetryable(errorCode, mappedCode) {
    const retryableCodes = [
      JSONRPCErrorCodes.INTERNAL_ERROR,
      MCPErrorCodes.SERVER_ERROR,
      MCPErrorCodes.TIMEOUT,
      MCPErrorCodes.RATE_LIMITED
    ];

    const retryableMappedCodes = [
      'INTERNAL_ERROR',
      'SERVER_ERROR',
      'TIMEOUT',
      'RATE_LIMITED',
      'CONNECTION_ERROR'
    ];

    return retryableCodes.includes(errorCode) || retryableMappedCodes.includes(mappedCode);
  }

  _determineExecutionErrorRetryable(errorCode) {
    const retryableCodes = [
      'CONNECTION_LOST',
      'RATE_LIMITED'
    ];

    return retryableCodes.includes(errorCode);
  }

  _determineSeverity(errorCode, mappedCode) {
    const highSeverityCodes = [
      'AUTHENTICATION_FAILED',
      'PERMISSION_DENIED',
      'TOOL_NOT_FOUND',
      'METHOD_NOT_FOUND',
      'MALFORMED_RESPONSE',
      'INVALID_REQUEST',
      'PARSE_ERROR'
    ];

    const mediumSeverityCodes = [
      'TIMEOUT',
      'SERVER_ERROR',
      'INTERNAL_ERROR',
      'CONNECTION_ERROR',
      'TOOL_EXECUTION_FAILED'
    ];

    if (highSeverityCodes.includes(mappedCode)) {
      return 'high';
    }

    if (mediumSeverityCodes.includes(mappedCode)) {
      return 'medium';
    }

    return 'low';
  }

  _categorizeError(errorCode, mappedCode) {
    const categoryMap = {
      'PARSE_ERROR': 'protocol',
      'INVALID_REQUEST': 'protocol',
      'METHOD_NOT_FOUND': 'protocol',
      'INVALID_PARAMS': 'validation',
      'INTERNAL_ERROR': 'server',
      'TOOL_NOT_FOUND': 'server',
      'TOOL_EXECUTION_FAILED': 'execution',
      'SERVER_ERROR': 'server',
      'TIMEOUT': 'timeout',
      'RATE_LIMITED': 'rate_limit',
      'AUTHENTICATION_FAILED': 'authentication',
      'PERMISSION_DENIED': 'authorization',
      'RESOURCE_NOT_FOUND': 'resource',
      'INVALID_TOOL_ARGUMENTS': 'validation',
      'MALFORMED_RESPONSE': 'protocol',
      'CONNECTION_ERROR': 'connection',
      'VALIDATION_FAILED': 'validation'
    };

    return categoryMap[mappedCode] || 'unknown';
  }

  _extractDataFromMalformedResponse(rawResponse) {
    try {
      if (typeof rawResponse === 'object' && rawResponse !== null) {
        if (Array.isArray(rawResponse.content)) {
          return { content: rawResponse.content };
        }
        if (rawResponse.result && typeof rawResponse.result === 'object') {
          return rawResponse.result;
        }
        if (rawResponse.error && typeof rawResponse.error === 'object') {
          return { error: rawResponse.error };
        }
        return rawResponse;
      }

      if (typeof rawResponse === 'string') {
        try {
          const parsed = JSON.parse(rawResponse);
          return this._extractDataFromMalformedResponse(parsed);
        } catch {
          return { text: rawResponse };
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  _validateMalformedResponse(rawResponse) {
    const errors = [];

    if (rawResponse === null || rawResponse === undefined) {
      errors.push({
        field: 'response',
        constraint: 'required',
        message: 'Response is null or undefined'
      });
      return errors;
    }

    if (typeof rawResponse !== 'object') {
      errors.push({
        field: 'response',
        constraint: 'type',
        message: `Expected object, got ${typeof rawResponse}`
      });
      return errors;
    }

    if (!rawResponse.jsonrpc) {
      errors.push({
        field: 'jsonrpc',
        constraint: 'required',
        message: 'Missing jsonrpc field'
      });
    } else if (rawResponse.jsonrpc !== '2.0') {
      errors.push({
        field: 'jsonrpc',
        constraint: 'enum',
        message: `Expected "2.0", got "${rawResponse.jsonrpc}"`
      });
    }

    if (rawResponse.id === undefined) {
      errors.push({
        field: 'id',
        constraint: 'required',
        message: 'Missing id field'
      });
    }

    if (!rawResponse.result && !rawResponse.error) {
      errors.push({
        field: 'response',
        constraint: 'required',
        message: 'Response must contain either result or error field'
      });
    }

    if (rawResponse.result && rawResponse.error) {
      errors.push({
        field: 'response',
        constraint: 'mutually_exclusive',
        message: 'Response cannot contain both result and error fields'
      });
    }

    return errors;
  }

  _createMalformedErrorResult(message, rawResponse, context) {
    const { toolName, serverId, toolId, requestId } = context;

    return {
      status: 'error',
      code: 'MALFORMED_RESPONSE',
      message,
      error: {
        type: 'MalformedResponseError',
        message
      },
      serverId,
      toolName,
      toolId,
      requestId,
      source: 'mcp',
      serverSource: serverId,
      retryable: false,
      severity: 'high',
      category: 'protocol',
      rawResponse: this.includeOriginalError ? rawResponse : undefined,
      canRetry: false,
      originalResponse: undefined
    };
  }

  _createUnknownErrorResult(message, context) {
    const { toolName, serverId, toolId, requestId } = context;

    return {
      status: 'error',
      code: 'UNKNOWN_ERROR',
      message,
      error: {
        type: 'UnknownError',
        message
      },
      serverId,
      toolName,
      toolId,
      requestId,
      source: 'mcp',
      serverSource: serverId,
      retryable: false,
      severity: 'medium',
      category: 'unknown',
      originalResponse: undefined
    };
  }
}

export const errorResponseProcessor = new ErrorResponseProcessor();
