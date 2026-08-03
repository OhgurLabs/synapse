import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createLogger } from '../logger.js';
import {
  isJSONRPCResponse,
  isJSONRPCSuccessResponse,
  isJSONRPCErrorResponse,
  isToolCallResult,
  JSONRPCErrorCodes,
  MCPErrorCodes
} from './result-types.js';

const log = createLogger('result-processor');

/**
 * ResultProcessor — Parses tool outputs and applies proper typing.
 *
 * Responsibilities:
 * - Parse JSON-RPC 2.0 responses from MCP servers
 * - Validate results against tool outputSchema (if available)
 * - Convert raw responses to properly typed ProcessedResult objects
 * - Handle malformed responses gracefully
 * - Extract metadata for debugging and monitoring
 * - Support streaming result processing
 * - Handle partial results for interrupted operations
 *
 * Processing pipeline:
 * 1. Validate response structure (JSON-RPC 2.0)
 * 2. Extract result payload or error information
 * 3. Apply output schema validation if available
 * 4. Build metadata (timing, server info, tool info)
 * 5. Return ProcessedResult with proper typing
 */
export class ResultProcessor {
  /**
   * Create a ResultProcessor instance.
   * 
   * @param {Object} [options={}] - Configuration options
   * @param {boolean} [options.validateByDefault=true] - Whether to validate schemas by default
   * @param {boolean} [options.allowUnknownFields=false] - Whether to allow unknown fields in results
   * @param {boolean} [options.strictMode=true] - Whether to enforce strict validation
   */
  constructor(options = {}) {
    this.validateByDefault = options.validateByDefault !== false;
    this.allowUnknownFields = options.allowUnknownFields || false;
    this.strictMode = options.strictMode !== false;

    // Initialize AJV for output schema validation
    this.ajv = new Ajv({
      allErrors: true,
      strict: false,
      strictTypes: false,
      strictSchema: false,
      validateFormats: false,
      useDefaults: false,
      coerceTypes: false,
      removeAdditional: false,
      allowUnionTypes: true
    });

    addFormats(this.ajv);

    // Cache compiled validators keyed by schema identity
    this._validatorCache = new Map();
  }

  /**
   * Process a raw tool invocation result.
   *
   * @param {*} rawResult - Raw result from MCP client
   * @param {Object} context - Invocation context
   * @param {string} context.toolName - Tool name that was invoked
   * @param {string} context.serverId - MCP server identifier
   * @param {string} [context.toolId] - Tool ID from registry
   * @param {Object} [context.outputSchema] - Optional output schema for validation
   * @param {number} context.startTimeMs - Start timestamp in milliseconds
   * @param {number} context.endTimeMs - End timestamp in milliseconds
   * @param {Object} [context.options={}] - Processing options
   * @param {boolean} [context.options.validateSchema] - Whether to validate against outputSchema
   * @param {boolean} [context.options.allowPartial] - Whether to accept partial results
   * @returns {Promise<ProcessedResult>} Processed result with metadata
   */
  async process(rawResult, context) {
    const {
      toolName,
      serverId,
      toolId,
      outputSchema,
      startTimeMs,
      endTimeMs,
      options = {}
    } = context;

    const processingOptions = {
      validateSchema: options.validateSchema ?? this.validateByDefault,
      allowPartial: options.allowPartial ?? false,
      ...options
    };

    const metadata = this._buildMetadata(toolName, serverId, toolId, startTimeMs, endTimeMs);

    try {
      // Step 1: Validate response structure
      if (rawResult === null || rawResult === undefined) {
        log.error({ toolName, serverId }, 'Null or undefined result received');
        metadata.processingStatus = 'failed';
        return {
          result: {
            status: 'error',
            code: 'PROCESSING_ERROR',
            message: 'Null or undefined result received',
            error: {
              type: 'ProcessingError',
              message: 'Null or undefined result'
            }
          },
          metadata,
          validation: null
        };
      }

      if (!isJSONRPCResponse(rawResult)) {
        log.warn({ toolName, serverId, rawResult }, 'Invalid JSON-RPC response structure');
        return this._handleMalformedResponse(rawResult, metadata, 'Invalid JSON-RPC response structure');
      }

      // Step 2: Check for error response
      if (isJSONRPCErrorResponse(rawResult)) {
        return this._handleErrorResponse(rawResult, metadata, toolName, serverId);
      }

      // Step 3: Validate success response structure
      if (!isJSONRPCSuccessResponse(rawResult)) {
        log.warn({ toolName, serverId, rawResult }, 'Response is neither success nor error');
        return this._handleMalformedResponse(rawResult, metadata, 'Response is neither success nor error');
      }

      // Step 4: Validate tool result structure
      if (!isToolCallResult(rawResult.result)) {
        log.warn({ toolName, serverId, result: rawResult.result }, 'Invalid tool call result structure');
        return this._handleMalformedResponse(rawResult.result, metadata, 'Invalid tool call result structure');
      }

      // Step 5: Apply output schema validation if available
      let validationResult = null;
      if (processingOptions.validateSchema && outputSchema) {
        validationResult = await this._validateOutputSchema(rawResult.result, outputSchema);
      }

      // Step 6: Build processed result
      let result;
      if (validationResult && !validationResult.canProceed) {
        result = {
          status: 'error',
          code: 'VALIDATION_FAILED',
          message: 'Output validation failed',
          details: validationResult.errors
        };
      } else {
        result = {
          status: rawResult.result.isError ? 'error' : 'ok',
          result: rawResult.result
        };
      }

      metadata.processingStatus = 'completed';
      metadata.validationStatus = validationResult?.status || 'unknown';

      return {
        result,
        metadata,
        validation: validationResult
      };
    } catch (err) {
      log.error({ toolName, serverId, err, rawResult }, 'Result processing failed');
      metadata.processingStatus = 'failed';

      return {
        result: {
          status: 'error',
          code: 'PROCESSING_ERROR',
          message: `Result processing failed: ${err.message}`,
          error: {
            type: err.constructor?.name || 'Error',
            message: err.message,
            stack: err.stack
          }
        },
        metadata,
        validation: null
      };
    }
  }

  /**
    * Process a streaming result chunk.
    *
    * @param {Object} chunk - Streaming chunk data
    * @param {Object} chunk.data - Chunk payload data
    * @param {boolean} [chunk.final=false] - Whether this is the final chunk in the stream
    * @param {Object} context - Streaming context
    * @param {string} context.toolName - Tool name
    * @param {string} context.serverId - Server ID
    * @param {number} context.chunkIndex - Chunk index
    * @param {number} context.elapsedMs - Elapsed time
    * @param {Object} [context.outputSchema] - Optional output schema for validation (only applied to final chunks)
    * @param {boolean} [context.allowPartial] - Whether to allow partial results on validation failure (default: true)
    * @returns {Promise<Object>} Processed chunk with data, validation info, and metadata
    * @description
    * Processes a streaming chunk by extracting data and optionally validating against outputSchema.
    * Schema validation is only applied to final chunks (chunk.final === true) because output schemas
    * describe the complete result shape, not intermediate partial chunks. Non-final chunks are passed
    * through without schema validation to avoid false validation failures.
    * @example
    * // Process a streaming chunk (non-final, no validation)
    * const chunk = { data: { content: [{ type: 'text', text: 'Hello' }] }, final: false };
    * const context = { toolName: 'echo', serverId: 'mcp-server', chunkIndex: 0, elapsedMs: 50 };
    * const processed = await processor.processStreamingChunk(chunk, context);
    * // Returns: { data: {...}, chunkIndex: 0, elapsedMs: 50, validation: null, timestamp: ... }
    *
    * @example
    * // Final chunk with validation
    * const chunk = { data: { content: [{ type: 'text', text: 'Hello' }] }, final: true };
    * const context = { toolName: 'echo', serverId: 'mcp-server', chunkIndex: 0, elapsedMs: 50, outputSchema: { type: 'object', required: ['content'] } };
    * const processed = await processor.processStreamingChunk(chunk, context);
    * // Returns: { data: {...}, validation: { status: 'valid', canProceed: true }, timestamp: ... }
    *
    * @example
    * // Final chunk with validation failure preserves data
    * const chunk = { data: { content: [] }, final: true };
    * const context = { toolName: 'echo', serverId: 'mcp-server', chunkIndex: 0, elapsedMs: 50, outputSchema: { required: ['content', 'missing'] } };
    * const processed = await processor.processStreamingChunk(chunk, context);
    * // Returns: { data: {...}, validationFailed: true, validation: { status: 'invalid', ... } }
    */
  async processStreamingChunk(chunk, context) {
    const { toolName, serverId, chunkIndex, elapsedMs, outputSchema, allowPartial } = context;
    const allowPartialData = allowPartial ?? true;

    try {
      // Validate chunk structure
      if (!chunk || typeof chunk !== 'object') {
        throw new Error('Invalid chunk structure');
      }

      // Extract chunk data
      const data = chunk.data || chunk;
      const isFinal = chunk.final || false;

      // Validate against output schema if provided
      // Skip validation for non-final chunks since output schemas describe complete result shape
      let validationResult = null;
      let validationFailed = false;
      if (outputSchema && this.validateByDefault && isFinal) {
        try {
          validationResult = await this._validateOutputSchema(data, outputSchema);
          // Validation failed if canProceed is false OR if status is error/unknown with errors present
          validationFailed = validationResult && (!validationResult.canProceed || 
            (validationResult.status === 'error' && validationResult.errors?.length > 0) ||
            (validationResult.status === 'unknown' && validationResult.errors?.length > 0));
        } catch (validationErr) {
          log.warn({ toolName, serverId, chunkIndex, err: validationErr }, 'Chunk validation error - preserving partial data');
          validationResult = {
            status: 'error',
            canProceed: allowPartialData,
            errors: [{
              field: '',
              constraint: 'validation_error',
              message: validationErr.message
            }],
            warnings: ['Validation failed but partial data preserved']
          };
          validationFailed = true;
        }
      }

      // Return chunk with data preserved even if validation failed
      const processedChunk = {
        data,
        final: isFinal,
        chunkIndex,
        elapsedMs,
        validation: validationResult,
        timestamp: Date.now()
      };

      // Mark chunk as having validation issues if validation failed
      // but preserve the data for partial result aggregation
      if (validationFailed) {
        processedChunk.validationFailed = true;
        log.debug({ toolName, serverId, chunkIndex }, 'Chunk validation failed - data preserved as partial');
      }

      return processedChunk;
    } catch (err) {
      log.error({ toolName, serverId, chunkIndex, err }, 'Streaming chunk processing failed');
      // Preserve partial data even on hard failures when allowed
      const partialData = chunk?.data || chunk;
      const result = {
        data: allowPartialData ? partialData : null,
        error: {
          type: err.constructor?.name || 'Error',
          message: err.message
        },
        chunkIndex,
        elapsedMs,
        failed: true,
        timestamp: Date.now()
      };
      
      if (allowPartialData) {
        result.partial = true;
        log.debug({ toolName, serverId, chunkIndex }, 'Chunk processing failed - partial data preserved');
      }
      
      return result;
    }
  }

  /**
   * Aggregate streaming chunks into a final result.
   *
   * @param {Array<Object>} chunks - Array of processed chunks
   * @param {Object} context - Aggregation context
   * @param {string} context.toolName - Tool name
   * @param {string} context.serverId - Server ID
   * @param {number} context.startTimeMs - Start time
   * @param {number} context.endTimeMs - End time
   * @param {Object} [context.outputSchema] - Optional output schema
   * @returns {Promise<Object>} Aggregated result
   */
  async aggregateStreamingChunks(chunks, context) {
    const { toolName, serverId, startTimeMs, endTimeMs, outputSchema } = context;
    const durationMs = endTimeMs - startTimeMs;

    try {
      // Categorize chunks by failure type
      const failedChunks = chunks.filter(c => c.failed);
      const validationFailedChunks = chunks.filter(c => !c.failed && c.validationFailed);
      const validChunks = chunks.filter(c => !c.failed && !c.validationFailed);

      // Include validation-failed chunks in aggregation (they have partial data)
      // Preserve original order by filtering out only completely failed chunks
      const chunksWithData = chunks.filter(c => !c.failed);

      // Aggregate data based on content type
      const aggregatedData = this._aggregateChunkData(chunksWithData);

      // Validate aggregated result against schema
      let validationResult = null;
      if (outputSchema && this.validateByDefault) {
        try {
          validationResult = await this._validateOutputSchema(aggregatedData, outputSchema);
        } catch (validationErr) {
          log.warn({ toolName, serverId, err: validationErr }, 'Aggregated result validation failed - preserving partial data');
          validationResult = {
            status: 'error',
            canProceed: true, // Allow partial data
            errors: [{
              field: '',
              constraint: 'aggregation_validation',
              message: validationErr.message
            }],
            warnings: ['Aggregated validation failed but partial data preserved']
          };
        }
      }

      // Determine overall status
      let status = 'success';
      if (failedChunks.length > 0 || validationFailedChunks.length > 0) {
        // If we have some valid data, it's partial; otherwise it's an error
        status = chunksWithData.length > 0 ? 'partial' : 'error';
      }

      // Build detailed metadata about chunk processing
      const metadata = {
        toolName,
        serverId,
        source: 'mcp',
        serverSource: serverId,
        elapsedMs: durationMs,
        chunkCount: chunks.length,
        validChunkCount: validChunks.length,
        failedChunksCount: failedChunks.length,
        validationFailedChunksCount: validationFailedChunks.length,
        bytesReceived: this._calculateBytesReceived(chunksWithData),
        complete: chunksWithData[chunksWithData.length - 1]?.final || false
      };

      // Include warnings if there were partial failures
      const warnings = [];
      if (failedChunks.length > 0) {
        warnings.push(`${failedChunks.length} chunk(s) failed processing and were excluded`);
      }
      if (validationFailedChunks.length > 0) {
        warnings.push(`${validationFailedChunks.length} chunk(s) failed validation but data was preserved`);
      }

      return {
        status,
        result: aggregatedData,
        chunks,
        context: metadata,
        validation: validationResult,
        failedChunksCount: failedChunks.length,
        validationFailedChunksCount: validationFailedChunks.length,
        warnings: warnings.length > 0 ? warnings : undefined
      };
    } catch (err) {
      log.error({ toolName, serverId, err }, 'Streaming chunk aggregation failed');

      // Even on aggregation failure, try to preserve partial data
      const partialData = this._extractPartialDataFromChunks(chunks);

      return {
        status: 'error',
        code: 'AGGREGATION_FAILED',
        message: `Failed to aggregate streaming chunks: ${err.message}`,
        result: partialData,
        chunks,
        context: {
          toolName,
          serverId,
          source: 'mcp',
          serverSource: serverId,
          elapsedMs: durationMs,
          chunkCount: chunks.length,
          failedChunksCount: chunks.filter(c => c.failed).length
        },
        error: {
          type: err.constructor?.name || 'Error',
          message: err.message,
          stack: err.stack
        }
      };
    }
  }

  /**
   * Handle a JSON-RPC error response.
   * 
   * @private
   * @param {Object} errorResponse - JSON-RPC error response
   * @param {ResultMetadata} metadata - Result metadata
   * @param {string} toolName - Tool name
   * @param {string} serverId - Server ID
   * @returns {ProcessedResult} Processed error result
   */
  _handleErrorResponse(errorResponse, metadata, toolName, serverId) {
    const { error } = errorResponse;

    // Determine if error is retryable
    const isRetryable = this._isErrorRetryable(error.code);

    // Map error codes to readable messages
    const mappedError = this._mapErrorCode(error.code, error.message);

    metadata.processingStatus = 'error';

    return {
      result: {
        status: 'error',
        code: mappedError.code,
        message: mappedError.message,
        error: {
          type: 'JSONRPCError',
          code: error.code,
          message: error.message,
          data: error.data
        },
        retryable: isRetryable
      },
      metadata,
      validation: null
    };
  }

  /**
   * Handle a malformed response.
   * 
   * @private
   * @param {*} rawResponse - Raw response data
   * @param {ResultMetadata} metadata - Result metadata
   * @param {string} reason - Reason for malformed response
   * @returns {ProcessedResult} Processed malformed response result
   */
  _handleMalformedResponse(rawResponse, metadata, reason) {
    metadata.processingStatus = 'malformed';

    // Try to extract any useful data from the response
    const extractedData = this._extractDataFromMalformedResponse(rawResponse);

    return {
      result: {
        status: 'error',
        code: 'MALFORMED_RESPONSE',
        message: reason,
        error: {
          type: 'MalformedResponseError',
          message: reason
        },
        extractedData,
        canRetry: extractedData !== null
      },
      metadata,
      validation: null
    };
  }

  /**
   * Validate result against output schema.
   * 
   * @private
   * @param {Object} result - Result to validate
   * @param {Object} outputSchema - JSON Schema for validation
   * @returns {Promise<ResultValidationOutcome>} Validation outcome
   */
  async _validateOutputSchema(result, outputSchema) {
    try {
      // Create stable schema identity for caching
      const schemaId = JSON.stringify(outputSchema);
      
      // Check cache first
      let validate = this._validatorCache.get(schemaId);
      if (!validate) {
        // Compile and cache the validator
        validate = this.ajv.compile(outputSchema);
        this._validatorCache.set(schemaId, validate);
      }
      
      const valid = validate(result);

      if (valid) {
        return {
          status: 'valid',
          canProceed: true,
          errors: [],
          warnings: []
        };
      }

      const errors = this._formatValidationErrors(validate.errors);
      const canProceed = this._canProceedWithErrors(errors);

      return {
        status: canProceed ? 'partial' : 'invalid',
        canProceed,
        errors,
        warnings: this._generateWarnings(errors)
      };
    } catch (err) {
      log.error({ err, schema: outputSchema }, 'Output schema validation compilation failed');
      return {
        status: 'unknown',
        canProceed: true,
        errors: [{
          field: '',
          constraint: 'schema_compilation',
          message: `Schema validation error: ${err.message}`
        }],
        warnings: ['Schema validation failed but partial data preserved']
      };
    }
  }

  /**
   * Format AJV validation errors.
   * 
   * @private
   * @param {Array<Object>} ajvErrors - AJV validation errors
   * @returns {Array<Object>} Formatted validation errors
   */
  _formatValidationErrors(ajvErrors) {
    if (!ajvErrors || !Array.isArray(ajvErrors)) {
      return [];
    }

    return ajvErrors.map(err => {
      let field = this._formatFieldPath(err.instancePath);

      // Handle missing required properties
      if (err.keyword === 'required' && err.params?.missingProperty) {
        if (field) {
          field = `${field}.${err.params.missingProperty}`;
        } else {
          field = err.params.missingProperty;
        }
      }

      const constraint = this._mapConstraint(err.keyword);
      const message = this._formatErrorMessage(err, field);

      return {
        field,
        constraint,
        message,
        actual: err.data,
        expected: err.params?.expected
      };
    });
  }

  /**
   * Format field path from AJV instance path.
   * 
   * @private
   * @param {string} instancePath - AJV instance path
   * @returns {string} Formatted field path
   */
  _formatFieldPath(instancePath) {
    if (!instancePath || instancePath === '') {
      return '';
    }

    const path = instancePath.replace(/^\//, '');
    if (!path) {
      return '';
    }

    const decoded = path.replace(/~1/g, '~').replace(/~0/g, '/');
    return decoded.split('/').join('.');
  }

  /**
   * Map AJV constraint keyword to readable constraint name.
   * 
   * @private
   * @param {string} keyword - AJV keyword
   * @returns {string} Constraint name
   */
  _mapConstraint(keyword) {
    const constraintMap = {
      required: 'required',
      type: 'type',
      additionalProperties: 'additional_properties',
      enum: 'enum',
      const: 'const',
      maximum: 'maximum',
      minimum: 'minimum',
      maxLength: 'max_length',
      minLength: 'min_length',
      pattern: 'pattern',
      maxItems: 'max_items',
      minItems: 'min_items',
      uniqueItems: 'unique_items',
      format: 'format'
    };

    return constraintMap[keyword] || keyword;
  }

  /**
   * Format error message from AJV error.
   * 
   * @private
   * @param {Object} err - AJV error object
   * @param {string} field - Formatted field path
   * @returns {string} Human-readable error message
   */
  _formatErrorMessage(err, field) {
    const { keyword, params } = err;

    switch (keyword) {
      case 'required':
        return `Missing required field: ${params.missingProperty}`;
      case 'type':
        return `Expected type ${params.type}`;
      case 'additionalProperties':
        return `Unexpected property: ${params.additionalProperty}`;
      case 'enum':
        return `Value must be one of: ${params.allowedValues?.join(', ')}`;
      case 'maximum':
      case 'minimum':
      case 'maxLength':
      case 'minLength':
      case 'maxItems':
      case 'minItems':
        return err.message || `Constraint ${keyword} violated`;
      case 'pattern':
        return `String must match pattern: ${params.pattern}`;
      case 'format':
        return `Invalid format: ${params.format}`;
      default:
        return err.message || `Validation failed for ${field || 'root'}`;
    }
  }

  /**
   * Determine if processing can proceed with validation errors.
   * 
   * @private
   * @param {Array<Object>} errors - Validation errors
   * @returns {boolean} Whether to proceed
   */
  _canProceedWithErrors(errors) {
    // Cannot proceed if there are required field errors
    const hasRequiredErrors = errors.some(e => e.constraint === 'required');
    if (hasRequiredErrors) {
      return false;
    }

    // Cannot proceed if there are type errors on root fields
    const hasRootTypeErrors = errors.some(e => 
      e.constraint === 'type' && !e.field.includes('.')
    );
    if (hasRootTypeErrors) {
      return false;
    }

    return true;
  }

  /**
   * Generate warnings from validation errors.
   * 
   * @private
   * @param {Array<Object>} errors - Validation errors
   * @returns {Array<string>} Warning messages
   */
  _generateWarnings(errors) {
    const warnings = [];

    // Warn about additional properties
    const additionalProps = errors.filter(e => e.constraint === 'additional_properties');
    if (additionalProps.length > 0) {
      const props = additionalProps.map(e => e.field.split('.').pop()).join(', ');
      warnings.push(`Result contains unknown fields: ${props}`);
    }

    return warnings;
  }

  /**
   * Map JSON-RPC error codes to readable codes.
   * 
   * @private
   * @param {number} code - Error code
   * @param {string} [defaultMessage] - Default message
   * @returns {Object} Mapped error with code and message
   */
  _mapErrorCode(code, defaultMessage) {
    // Check JSON-RPC standard errors
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

    // Check MCP-specific errors
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

    // Unknown error code
    return {
      code: `UNKNOWN_ERROR_${code}`,
      message: defaultMessage || `Unknown error code: ${code}`
    };
  }

  /**
   * Determine if an error is retryable.
   * 
   * @private
   * @param {number} code - Error code
   * @returns {boolean} Whether error is retryable
   */
  _isErrorRetryable(code) {
    const retryableCodes = [
      JSONRPCErrorCodes.INTERNAL_ERROR,
      MCPErrorCodes.SERVER_ERROR,
      MCPErrorCodes.TIMEOUT,
      MCPErrorCodes.RATE_LIMITED
    ];

    return retryableCodes.includes(code);
  }

  /**
   * Build result metadata.
   * 
   * @private
   * @param {string} toolName - Tool name
   * @param {string} serverId - Server ID
   * @param {string} [toolId] - Tool ID
   * @param {number} startTimeMs - Start time
   * @param {number} endTimeMs - End time
   * @returns {ResultMetadata} Metadata object
   */
  _buildMetadata(toolName, serverId, toolId, startTimeMs, endTimeMs) {
    const durationMs = endTimeMs - startTimeMs;
    const responseId = `res_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return {
      toolName,
      serverId,
      toolId,
      startTimeMs,
      endTimeMs,
      durationMs,
      processingStatus: 'processing',
      responseId,
      requestId: null,
      source: 'mcp',
      serverSource: serverId
    };
  }

  /**
   * Extract data from a malformed response.
   * 
   * @private
   * @param {*} rawResponse - Raw response data
   * @returns {*} Extracted data or null
   */
  _extractDataFromMalformedResponse(rawResponse) {
    try {
      // If response is already an object with content array, try to use it
      if (typeof rawResponse === 'object' && rawResponse !== null) {
        if (Array.isArray(rawResponse.content)) {
          return { content: rawResponse.content };
        }
        if (rawResponse.result && typeof rawResponse.result === 'object') {
          return rawResponse.result;
        }
        return rawResponse;
      }

      // Try to parse as JSON if it's a string
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

  /**
   * Aggregate streaming chunk data.
   * 
   * @private
   * @param {Array<Object>} chunks - Valid chunks
   * @returns {Object} Aggregated data
   */
  _aggregateChunkData(chunks) {
    if (chunks.length === 0) {
      return { content: [] };
    }

    // Check if chunks contain content arrays
    const hasContent = chunks.some(c => c.data?.content && Array.isArray(c.data.content));

    if (hasContent) {
      // Aggregate content arrays
      const content = chunks.flatMap(c => c.data?.content || []);
      return { content };
    }

    // Return the last chunk's data if available
    const lastChunk = chunks[chunks.length - 1];
    return lastChunk.data || {};
  }

  /**
   * Calculate total bytes received from chunks.
   *
   * @private
   * @param {Array<Object>} chunks - Chunks
   * @returns {number} Total bytes
   */
  _calculateBytesReceived(chunks) {
    return chunks.reduce((total, chunk) => {
      try {
        return total + JSON.stringify(chunk.data).length;
      } catch {
        return total;
      }
    }, 0);
  }

  /**
   * Clear the validator cache.
   * Use this when schemas are no longer needed or to free memory.
   */
  clearValidatorCache() {
    this._validatorCache.clear();
    log.debug('Validator cache cleared');
  }

  /**
   * Get cache statistics for monitoring.
   * @returns {Object} Cache statistics
   */
  getValidatorCacheStats() {
    return {
      size: this._validatorCache.size,
      entries: Array.from(this._validatorCache.keys()).map(key => ({
        schema: JSON.parse(key),
        compiled: true
      }))
    };
  }

  /**
   * Extract partial data from chunks when aggregation fails.
   * Best-effort attempt to recover any available data.
   *
   * @private
   * @param {Array<Object>} chunks - Chunks to extract from
   * @returns {Object} Partial data object
   */
  _extractPartialDataFromChunks(chunks) {
    try {
      // Try to get any chunks that have data
      const chunksWithData = chunks.filter(c => c.data != null);

      if (chunksWithData.length === 0) {
        return { content: [], _partial: true, _extractionFailed: false };
      }

      // Check if any chunks have content arrays
      const hasContent = chunksWithData.some(c =>
        c.data?.content && Array.isArray(c.data.content)
      );

      if (hasContent) {
        // Aggregate content arrays from chunks that have them
        const content = chunksWithData
          .filter(c => c.data?.content && Array.isArray(c.data.content))
          .flatMap(c => c.data.content);

        return {
          content,
          _partial: true,
          _extractedChunkCount: chunksWithData.length,
          _totalChunkCount: chunks.length
        };
      }

      // Return the last chunk with data
      const lastChunkWithData = chunksWithData[chunksWithData.length - 1];
      return {
        ...lastChunkWithData.data,
        _partial: true,
        _extractedChunkCount: 1,
        _totalChunkCount: chunks.length
      };
    } catch (err) {
      log.error({ err }, 'Failed to extract partial data from chunks');
      return {
        content: [],
        _partial: true,
        _extractionFailed: true,
        _error: err.message
      };
    }
  }
}

// Export singleton instance for convenience
export const resultProcessor = new ResultProcessor();
