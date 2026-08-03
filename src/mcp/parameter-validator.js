import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createLogger } from '../logger.js';

const log = createLogger('parameter-validator');

/**
 * Validation error categories for structured error handling
 */
export const ValidationErrorCategory = {
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  PARAMS_NOT_OBJECT: 'PARAMS_NOT_OBJECT',
  MISSING_REQUIRED: 'MISSING_REQUIRED',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  CONSTRAINT_VIOLATION: 'CONSTRAINT_VIOLATION',
  FORMAT_ERROR: 'FORMAT_ERROR',
  ADDITIONAL_PROPERTIES: 'ADDITIONAL_PROPERTIES',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

/**
 * ParameterValidator — Validates tool parameters against JSON Schema.
 *
 * Uses AJV to validate arguments against the tool's inputSchema captured
 * during tool discovery. Returns structured validation errors with field names
 * and constraint violations.
 *
 * Features:
 * - Schema caching for performance (compiled validators reused)
 * - Pre-validation type guards to prevent AJV crashes
 * - Configurable strictness modes (strict, lenient, permissive)
 * - Detailed error categorization for recovery strategies
 * - Support for JSON Schema drafts 4-2019-09
 * - Extended formats via ajv-formats (email, uri, date-time, etc.)
 *
 * Validation results:
 * - Success: { valid: true, category: null }
 * - Failure: { valid: false, category: <ErrorCategory>, errors: [{ field, constraint, message, severity }] }
 */
export class ParameterValidator {
  /**
   * Create a ParameterValidator instance.
   *
   * @param {Object} [options] - Configuration options
   * @param {string} [options.strictness='strict'] - Validation strictness: 'strict', 'lenient', or 'permissive'
   * @param {boolean} [options.cacheSchemas=true] - Whether to cache compiled validators
   * @param {number} [options.maxCacheSize=100] - Maximum number of cached schemas
   * @param {boolean} [options.coerceTypes=false] - Whether to coerce types (e.g., "123" -> 123)
   */
  constructor(options = {}) {
    const {
      strictness = 'strict',
      cacheSchemas = true,
      maxCacheSize = 100,
      coerceTypes = false
    } = options;

    this.strictness = strictness;
    this.cacheSchemas = cacheSchemas;
    this.schemaCache = new Map();
    this.maxCacheSize = maxCacheSize;

    // Configure AJV based on strictness mode
    const ajvOptions = {
      allErrors: true,
      strict: strictness === 'strict',
      strictTypes: strictness === 'strict',
      useDefaults: false,
      coerceTypes: coerceTypes ? 'array' : false,
      removeAdditional: strictness === 'strict' ? false : 'failing',
      allowUnionTypes: true
    };

    this.ajv = new Ajv(ajvOptions);
    addFormats(this.ajv);

    // Track schema compilation stats for metrics
    this.stats = {
      compilations: 0,
      cacheHits: 0,
      cacheMisses: 0,
      validations: 0,
      failures: 0
    };
  }

  /**
   * Validate the schema itself before using it for parameter validation.
   * Catches malformed schemas early to prevent AJV compilation errors.
   *
   * @param {Object} schema - JSON Schema to validate
   * @returns {Object} Validation result
   */
  validateSchema(schema) {
    // Note: null/undefined/non-object schema is treated as "no validation" (passes) for backward compatibility
    // This allows tools without schemas to function and maintains existing behavior
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return { valid: true, skipValidation: true };
    }

    // Check for required schema properties
    if (!schema.hasOwnProperty('type') && 
        !schema.hasOwnProperty('$ref') && 
        !schema.hasOwnProperty('$schema') &&
        !schema.hasOwnProperty('anyOf') &&
        !schema.hasOwnProperty('oneOf') &&
        !schema.hasOwnProperty('allOf')) {
      // Schema without type or composition keywords is suspicious but not necessarily invalid
      log.debug('Schema lacks type or composition keywords, may be overly permissive');
    }

    // Try to compile schema to validate it
    try {
      this.ajv.compile(schema);
      return { valid: true };
    } catch (err) {
      log.error({ err, schema }, 'Schema validation failed during compilation');
      return {
        valid: false,
        category: ValidationErrorCategory.SCHEMA_INVALID,
        errors: [{
          field: 'schema',
          constraint: 'valid',
          message: `Invalid JSON Schema: ${err.message}`,
          severity: 'error',
          originalError: err
        }]
      };
    }
  }

  /**
   * Generate a cache key for a schema.
   *
   * @param {Object} schema - JSON Schema
   * @returns {string} Cache key
   * @private
   */
  _getSchemaKey(schema) {
    // Use JSON.stringify for cache key - schemas are typically small
    // For very large schemas, consider using a hash library
    try {
      return JSON.stringify(schema);
    } catch (err) {
      // If schema is not serializable, use object reference
      return String(schema);
    }
  }

  /**
   * Get or compile a validator function from cache.
   *
   * @param {Object} schema - JSON Schema
   * @returns {Function|null} Compiled validator function or null if caching disabled
   * @private
   */
  _getValidator(schema) {
    if (!this.cacheSchemas) {
      return null;
    }

    const key = this._getSchemaKey(schema);

    if (this.schemaCache.has(key)) {
      this.stats.cacheHits++;
      return this.schemaCache.get(key);
    }

    this.stats.cacheMisses++;

    // Evict oldest entry if cache is full
    if (this.schemaCache.size >= this.maxCacheSize) {
      const firstKey = this.schemaCache.keys().next().value;
      this.schemaCache.delete(firstKey);
      log.debug('Schema cache evicted oldest entry');
    }

    // Compile and cache
    const validate = this.ajv.compile(schema);
    this.schemaCache.set(key, validate);
    this.stats.compilations++;

    return validate;
  }

  /**
   * Clear the schema cache.
   * Useful when tool schemas change dynamically.
   */
  clearCache() {
    const size = this.schemaCache.size;
    this.schemaCache.clear();
    log.debug({ cleared: size }, 'Schema cache cleared');
  }

  /**
   * Get validation statistics.
   *
   * @returns {Object} Statistics object
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Validate parameters against a tool's JSON Schema.
   *
   * @param {Object} schema - JSON Schema from tool metadata (inputSchema)
   * @param {Object} [parameters={}] - Parameters to validate
   * @param {Object} [options] - Validation options
   * @param {string} [options.toolName] - Name of tool (for logging/context)
   * @param {boolean} [options.skipSchemaValidation=false] - Skip schema validation (assume valid)
   * @returns {Object} Validation result
   * @returns {boolean} return.valid - Whether parameters are valid
   * @returns {string} [return.category] - Error category (if invalid)
   * @returns {Array<Object>} [return.errors] - Array of validation errors (if invalid)
   * @returns {string} return.errors[].field - Field path that failed validation
   * @returns {string} return.errors[].constraint - Type of constraint violated
   * @returns {string} return.errors[].message - Human-readable error message
   * @returns {string} return.errors[].severity - 'error' or 'warning'
   */
  validate(schema, parameters = {}, options = {}) {
    const { toolName = 'unknown', skipSchemaValidation = false } = options;
    this.stats.validations++;

    // Pre-validation: Check schema validity
    if (!skipSchemaValidation) {
      const schemaResult = this.validateSchema(schema);
      if (!schemaResult.valid) {
        log.error({ toolName, schema, ...schemaResult }, 'Schema validation failed');
        this.stats.failures++;
        return schemaResult;
      }
      // If schema is not a valid object, skip parameter validation (treat as no schema)
      if (schemaResult.skipValidation) {
        log.debug({ toolName, schema }, 'No valid schema provided, skipping validation');
        return { valid: true, category: null };
      }
    }

    // Pre-validation: Normalize undefined to empty object, but keep null as null
    // (null is explicitly passed and should be rejected as invalid)
    if (parameters === undefined) {
      parameters = {};
    }

    // Pre-validation: Type guard - parameters must be a plain object (null is not allowed)
    if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
      log.warn({ toolName, paramsType: typeof parameters }, 'Parameters must be a plain object');
      this.stats.failures++;
      return {
        valid: false,
        category: ValidationErrorCategory.PARAMS_NOT_OBJECT,
        errors: [{
          field: '',
          constraint: 'type',
          message: 'Parameters must be a plain object',
          severity: 'error'
        }]
      };
    }

    try {
      // Get validator from cache or compile new one
      const validate = this._getValidator(schema) || this.ajv.compile(schema);
      const valid = validate(parameters);

      if (valid) {
        return { valid: true, category: null };
      }

      this.stats.failures++;
      const errors = this._formatErrors(validate.errors, toolName);
      const category = this._categorizeErrors(errors);
      
      log.debug({ toolName, errors, count: errors.length, category }, 'Parameter validation failed');
      return { valid: false, category, errors };
    } catch (err) {
      log.error({ err, toolName, schema, parameters }, 'Validation execution failed');
      this.stats.failures++;
      return {
        valid: false,
        category: ValidationErrorCategory.INTERNAL_ERROR,
        errors: [{
          field: '',
          constraint: 'internal',
          message: `Validation execution failed: ${err.message}`,
          severity: 'error',
          originalError: err
        }]
      };
    }
  }

  /**
   * Categorize validation errors by severity and type.
   *
   * @param {Array<Object>} errors - Formatted validation errors
   * @returns {string} Error category
   * @private
   */
  _categorizeErrors(errors) {
    if (!errors || errors.length === 0) {
      return ValidationErrorCategory.INTERNAL_ERROR;
    }

    // Check for specific categories in priority order
    const hasRequired = errors.some(e => e.constraint === 'required');
    if (hasRequired) {
      return ValidationErrorCategory.MISSING_REQUIRED;
    }

    const hasType = errors.some(e => e.constraint === 'type');
    if (hasType) {
      return ValidationErrorCategory.TYPE_MISMATCH;
    }

    const hasFormat = errors.some(e => 
      e.constraint === 'format' || 
      e.constraint === 'pattern' ||
      e.message?.includes('format')
    );
    if (hasFormat) {
      return ValidationErrorCategory.FORMAT_ERROR;
    }

    const hasAdditional = errors.some(e => e.constraint === 'additional_properties');
    if (hasAdditional) {
      return ValidationErrorCategory.ADDITIONAL_PROPERTIES;
    }

    // Default to constraint violation for other errors
    return ValidationErrorCategory.CONSTRAINT_VIOLATION;
  }

  /**
   * Format AJV errors into structured error objects.
   *
   * @param {Array<Object>} ajvErrors - Raw AJV validation errors
   * @param {string} [toolName] - Tool name for context
   * @returns {Array<Object>} Formatted errors with field, constraint, message, severity
   * @private
   */
  _formatErrors(ajvErrors, toolName = 'unknown') {
    if (!ajvErrors || !Array.isArray(ajvErrors)) {
      return [];
    }

    return ajvErrors.map(err => {
      let field = this._formatFieldPath(err.instancePath);

      // For required keyword, the missing property is in params
      if (err.keyword === 'required' && err.params?.missingProperty) {
        if (field) {
          field = `${field}.${err.params.missingProperty}`;
        } else {
          field = err.params.missingProperty;
        }
      }

      // For additionalProperties keyword, the extra property is in params
      if (err.keyword === 'additionalProperties' && err.params?.additionalProperty) {
        if (field) {
          field = `${field}.${err.params.additionalProperty}`;
        } else {
          field = err.params.additionalProperty;
        }
      }

      const constraint = this._mapConstraint(err.keyword);
      const message = this._formatMessage(err, field);
      const severity = this._determineSeverity(err, constraint);

      return {
        field,
        constraint,
        message,
        severity,
        keyword: err.keyword,
        schemaPath: err.schemaPath
      };
    });
  }

  /**
   * Determine error severity based on constraint type and strictness mode.
   *
   * @param {Object} err - AJV error object
   * @param {string} constraint - Mapped constraint type
   * @returns {string} 'error' or 'warning'
   * @private
   */
  _determineSeverity(err, constraint) {
    // In strict mode, everything is an error
    if (this.strictness === 'strict') {
      return 'error';
    }

    // Missing required fields and type mismatches are always errors
    if (constraint === 'required' || constraint === 'type') {
      return 'error';
    }

    // In lenient mode, some constraint violations are warnings
    if (this.strictness === 'lenient') {
      if (constraint === 'additional_properties') {
        return 'warning';
      }
    }

    return 'error';
  }

  /**
   * Format AJV instance path to user-friendly field path.
   *
   * @param {string} instancePath - AJV instance path (e.g., "/outer/inner")
   * @returns {string} Formatted field path (e.g., "outer.inner")
   * @private
   */
  _formatFieldPath(instancePath) {
    if (!instancePath || instancePath === '') {
      return '';
    }

    // Remove leading slash and join with dots
    const path = instancePath.replace(/^\//, '');
    if (!path) {
      return '';
    }

    // Handle JSON pointer encoding (~1 -> ~, ~0 -> /)
    const decoded = path.replace(/~1/g, '~').replace(/~0/g, '/');
    return decoded.split('/').join('.');
  }

  /**
   * Map AJV keyword to constraint type.
   *
   * @param {string} keyword - AJV validation keyword
   * @returns {string} Constraint type
   * @private
   */
  _mapConstraint(keyword) {
    const constraintMap = {
      required: 'required',
      type: 'type',
      additionalProperties: 'additional_properties',
      additionalItems: 'additional_items',
      enum: 'enum',
      const: 'const',
      multipleOf: 'multiple_of',
      maximum: 'maximum',
      minimum: 'minimum',
      exclusiveMaximum: 'exclusive_maximum',
      exclusiveMinimum: 'exclusive_minimum',
      maxLength: 'max_length',
      minLength: 'min_length',
      pattern: 'pattern',
      maxItems: 'max_items',
      minItems: 'min_items',
      uniqueItems: 'unique_items',
      maxProperties: 'max_properties',
      minProperties: 'min_properties',
      dependentRequired: 'dependent_required',
      if: 'conditional',
      then: 'conditional',
      else: 'conditional',
      allOf: 'all_of',
      anyOf: 'any_of',
      oneOf: 'one_of',
      not: 'not'
    };

    return constraintMap[keyword] || keyword;
  }

  /**
   * Format human-readable error message.
   *
   * @param {Object} err - AJV error object
   * @param {string} field - Formatted field path
   * @returns {string} Human-readable message
   * @private
   */
  _formatMessage(err, field) {
    const { keyword, params } = err;

    switch (keyword) {
      case 'required':
        return `Missing required field: ${params.missingProperty}`;

      case 'type':
        return err.message || `Expected type: ${params.type}`;

      case 'additionalProperties':
        return `Unexpected property: ${params.additionalProperty}`;

      case 'enum':
        return `Value must be one of: ${params.allowedValues?.join(', ')}`;

      case 'const':
        return `Value must be: ${params.allowedValue}`;

      case 'maximum':
      case 'exclusiveMaximum':
        const maxVal = params.limit ?? params.comparisonValue;
        return `Value must be ${params.exclusive ? '<' : '<='} ${maxVal}`;

      case 'minimum':
      case 'exclusiveMinimum':
        const minVal = params.limit ?? params.comparisonValue;
        return `Value must be ${params.exclusive ? '>' : '>='} ${minVal}`;

      case 'maxLength':
        return `String length must be <= ${params.limit}`;

      case 'minLength':
        return `String length must be >= ${params.limit}`;

      case 'pattern':
        return `String must match pattern: ${params.pattern}`;

      case 'maxItems':
        return `Array must have <= ${params.limit} items`;

      case 'minItems':
        return `Array must have >= ${params.limit} items`;

      case 'maxProperties':
        return `Object must have <= ${params.limit} properties`;

      case 'minProperties':
        return `Object must have >= ${params.limit} properties`;

      case 'multipleOf':
        return `Value must be a multiple of ${params.multipleOf}`;

      case 'uniqueItems':
        return 'Array items must be unique';

      default:
        return err.message || `Validation failed for ${field || 'root'}`;
    }
  }

  /**
   * Create a validation error response for tool invocation.
   *
   * @param {Object} validationResult - Result from validate()
   * @param {Object} [options] - Options
   * @param {string} [options.toolName] - Tool name for context
   * @returns {Object|null} Structured error response or null if valid
   */
  createErrorResult(validationResult, options = {}) {
    const { toolName = 'unknown' } = options;
    
    if (validationResult.valid) {
      return null;
    }

    // Determine error code based on category
    let errorCode = 'VALIDATION_FAILED';
    if (validationResult.category === ValidationErrorCategory.MISSING_REQUIRED) {
      errorCode = 'MISSING_REQUIRED_PARAMS';
    } else if (validationResult.category === ValidationErrorCategory.TYPE_MISMATCH) {
      errorCode = 'TYPE_MISMATCH';
    } else if (validationResult.category === ValidationErrorCategory.SCHEMA_INVALID) {
      errorCode = 'INVALID_TOOL_SCHEMA';
    } else if (validationResult.category === ValidationErrorCategory.FORMAT_ERROR) {
      errorCode = 'FORMAT_ERROR';
    }

    return {
      status: 'error',
      code: errorCode,
      category: validationResult.category,
      toolName,
      details: validationResult.errors,
      errorCount: validationResult.errors?.length || 0,
      retryable: false,
      suggestions: this._generateSuggestions(validationResult.errors)
    };
  }

  /**
   * Generate helpful suggestions based on validation errors.
   *
   * @param {Array<Object>} errors - Validation errors
   * @returns {Array<string>} Suggestions for fixing errors
   * @private
   */
  _generateSuggestions(errors) {
    const suggestions = [];

    if (!errors || errors.length === 0) {
      return suggestions;
    }

    // Group errors by field
    const errorsByField = {};
    for (const error of errors) {
      const field = error.field || 'root';
      if (!errorsByField[field]) {
        errorsByField[field] = [];
      }
      errorsByField[field].push(error);
    }

    // Generate suggestions per field
    for (const [field, fieldErrors] of Object.entries(errorsByField)) {
      const hasRequired = fieldErrors.some(e => e.constraint === 'required');
      const hasType = fieldErrors.some(e => e.constraint === 'type');
      const hasEnum = fieldErrors.some(e => e.constraint === 'enum');
      const hasMinLength = fieldErrors.some(e => e.constraint === 'min_length');
      const hasMaxLength = fieldErrors.some(e => e.constraint === 'max_length');
      const hasMinimum = fieldErrors.some(e => e.constraint === 'minimum');
      const hasMaximum = fieldErrors.some(e => e.constraint === 'maximum');

      if (hasRequired) {
        suggestions.push(`Provide the required field: ${field}`);
      }
      if (hasType) {
        suggestions.push(`Check the type of field: ${field} (expected a valid JSON value)`);
      }
      if (hasEnum) {
        const enumError = fieldErrors.find(e => e.constraint === 'enum');
        suggestions.push(`Use one of the allowed values for ${field}: ${enumError.message}`);
      }
      if (hasMinLength) {
        suggestions.push(`Make sure ${field} is long enough`);
      }
      if (hasMaxLength) {
        suggestions.push(`Shorten the value of ${field}`);
      }
      if (hasMinimum || hasMaximum) {
        suggestions.push(`Adjust the numeric value of ${field} to be within allowed range`);
      }
    }

    return suggestions.slice(0, 3); // Limit to top 3 suggestions
  }

  /**
   * Validate parameters and extract timeout configuration if present.
   * Some tools may specify timeout in parameters (e.g., for long-running operations).
   *
   * @param {Object} schema - JSON Schema
   * @param {Object} parameters - Parameters to validate
   * @param {number} defaultTimeoutMs - Default timeout if not specified in params
   * @param {Object} [options] - Validation options
   * @returns {Object} Validation result with timeout info
   * @returns {boolean} return.valid - Whether parameters are valid
   * @returns {Object} [return.errors] - Validation errors if invalid
   * @returns {number} [return.timeoutMs] - Extracted timeout value (only if valid)
   */
  validateWithTimeoutExtraction(schema, parameters = {}, defaultTimeoutMs = 60000, options = {}) {
    const result = this.validate(schema, parameters, options);
    
    if (!result.valid) {
      return result;
    }

    // Extract timeout from parameters if schema allows it
    // Look for common timeout parameter names
    const timeoutField = Object.keys(parameters).find(key => 
      key.toLowerCase().includes('timeout') || 
      key.toLowerCase().includes('timelimit')
    );

    if (timeoutField && typeof parameters[timeoutField] === 'number') {
      const extractedTimeout = parameters[timeoutField];
      // Ensure timeout is reasonable (1s to 1 hour)
      const normalizedTimeout = Math.max(1000, Math.min(extractedTimeout, 3600000));
      result.timeoutMs = normalizedTimeout;
      log.debug({ toolName: options.toolName, timeoutField, extractedTimeout, normalizedTimeout }, 'Timeout extracted from parameters');
    } else {
      result.timeoutMs = defaultTimeoutMs;
    }

    return result;
  }
}

// Export singleton instance for convenience
export const parameterValidator = new ParameterValidator();
