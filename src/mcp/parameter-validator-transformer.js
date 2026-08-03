/**
 * Parameter Validator Transformer
 *
 * Combines parameter validation and transformation into a unified interface.
 * Provides configurable modes for validation-only, transformation-only, or combined operations.
 *
 * Features:
 * - Transform parameters to expected types before validation
 * - Configurable transformation modes (strict, coerce, normalize)
 * - Unified result format with validation errors and transformation info
 * - Per-tool schema transformation rules
 * - Support for custom transformation rules
 *
 * Usage:
 *   const validator = new ParameterValidatorTransformer();
 *   const result = validator.validateAndTransform(schema, params);
 *
 *   // Result format:
 *   // Success: { valid: true, parameters: <transformed>, transformationInfo: {...} }
 *   // Failure: { valid: false, errors: [...], parameters: <original or partial> }
 */

import { createLogger } from '../logger.js';
import { ParameterValidator } from './parameter-validator.js';
import { ParameterTransformer, TransformMode } from './parameter-transformer.js';

const log = createLogger('parameter-validator-transformer');

/**
 * Validation modes for the combined validator
 */
export const ValidationMode = {
  VALIDATE_ONLY: 'validate_only',      // Only validate, no transformation
  TRANSFORM_ONLY: 'transform_only',    // Only transform, no validation
  TRANSFORM_THEN_VALIDATE: 'transform_then_validate', // Transform then validate (default)
  VALIDATE_THEN_TRANSFORM: 'validate_then_transform'  // Validate original, then transform
};

/**
 * Combined parameter validation and transformation result
 */
export class ValidationResult {
  constructor(valid, parameters, errors = [], transformationInfo = null) {
    this.valid = valid;
    this.parameters = parameters;
    this.errors = errors;
    this.transformationInfo = transformationInfo;
  }

  /**
   * Check if validation passed
   */
  get success() {
    return this.valid;
  }

  /**
   * Get error count
   */
  get errorCount() {
    return this.errors?.length || 0;
  }

  /**
   * Get transformation change count
   */
  get changeCount() {
    return this.transformationInfo?.changeCount || 0;
  }

  /**
   * Convert to error result format for tool invocation
   */
  toErrorResult() {
    if (this.valid) {
      return null;
    }

    return {
      status: 'error',
      code: 'VALIDATION_FAILED',
      details: this.errors
    };
  }

  /**
   * Serialize to plain object
   */
  toJSON() {
    return {
      valid: this.valid,
      parameters: this.parameters,
      errors: this.errors,
      transformationInfo: this.transformationInfo
    };
  }
}

/**
 * Combined parameter validation and transformation
 */
export class ParameterValidatorTransformer {
  /**
   * Create a ParameterValidatorTransformer instance.
   *
   * @param {Object} [options] - Configuration options
   * @param {string} [options.mode] - Default validation mode (default: TRANSFORM_THEN_VALIDATE)
   * @param {string} [options.transformMode] - Default transformation mode (default: COERCE)
   * @param {boolean} [options.strictNumbers] - Strict number parsing (default: false)
   * @param {boolean} [options.allowEmptyStringToNull] - Allow empty strings to become null (default: true)
   * @param {Object} [options.customTransformers] - Custom transformation rules per field
   */
  constructor(options = {}) {
    this.defaultMode = options.mode || ValidationMode.TRANSFORM_THEN_VALIDATE;
    this.customTransformers = options.customTransformers || {};

    // Create validator instance
    this.validator = new ParameterValidator();

    // Create transformer instance with options
    this.transformer = new ParameterTransformer({
      mode: options.transformMode || TransformMode.COERCE,
      strictNumbers: options.strictNumbers ?? false,
      allowEmptyStringToNull: options.allowEmptyStringToNull ?? true
    });
  }

  /**
   * Validate and transform parameters according to schema.
   *
   * @param {Object} schema - JSON Schema defining expected types
   * @param {Object} parameters - Parameters to validate and transform
* @param {Object} [options] - Per-call options
    * @param {string} [options.mode] - Override default validation mode
    * @param {Object} [options.transformationRules] - Per-tool transformation rules
    * @returns {ValidationResult} Combined validation and transformation result
    */
   validateAndTransform(schema, parameters = {}, options = {}) {
    const mode = options.mode || this.defaultMode;
    const transformationRules = options.transformationRules;
    const originalParams = parameters;

    // Normalize null/undefined to empty object for consistent behavior
    if (parameters == null) {
      parameters = {};
    }

    log.debug({ mode, schema: !!schema, paramCount: Object.keys(parameters).length, hasTransformationRules: !!transformationRules }, 'Validating and transforming parameters');

    switch (mode) {
      case ValidationMode.VALIDATE_ONLY:
        return this._validateOnly(schema, parameters, originalParams);

      case ValidationMode.TRANSFORM_ONLY:
        return this._transformOnly(schema, parameters, originalParams, transformationRules);

      case ValidationMode.TRANSFORM_THEN_VALIDATE:
        return this._transformThenValidate(schema, parameters, originalParams, transformationRules);

      case ValidationMode.VALIDATE_THEN_TRANSFORM:
        return this._validateThenTransform(schema, parameters, originalParams, transformationRules);

      default:
        return this._transformThenValidate(schema, parameters, originalParams, transformationRules);
    }
  }

  /**
   * Validate only, no transformation.
   *
   * @private
   */
  _validateOnly(schema, parameters, originalParams) {
    const validationResult = this.validator.validate(schema, parameters);

    if (validationResult.valid) {
      return new ValidationResult(true, parameters, [], null);
    }

    return new ValidationResult(false, parameters, validationResult.errors, null);
  }

/**
    * Transform only, no validation.
    *
    * @private
    */
   _transformOnly(schema, parameters, originalParams, transformationRules) {
    const transformed = transformationRules
      ? this.transformer.transformWithRules(schema, parameters, transformationRules)
      : this.transformer.transform(schema, parameters);
    const transformationInfo = this.transformer.getTransformationInfo(schema, originalParams, transformed);

    return new ValidationResult(true, transformed, [], transformationInfo);
  }

  /**
    * Transform parameters, then validate the transformed result.
    * This is the most common use case for MCP tool invocation.
    *
    * @private
    */
   _transformThenValidate(schema, parameters, originalParams, transformationRules) {
    // Step 1: Transform parameters
    const transformed = transformationRules
      ? this.transformer.transformWithRules(schema, parameters, transformationRules)
      : this.transformer.transform(schema, parameters);
    const transformationInfo = this.transformer.getTransformationInfo(schema, originalParams, transformed);

    // Step 2: Validate transformed parameters
    const validationResult = this.validator.validate(schema, transformed);

    if (validationResult.valid) {
      log.debug({ changeCount: transformationInfo.changeCount }, 'Transform and validate succeeded');
      return new ValidationResult(true, transformed, [], transformationInfo);
    }

    log.warn({
      errors: validationResult.errors,
      transformationInfo
    }, 'Transform succeeded but validation failed');

    return new ValidationResult(false, transformed, validationResult.errors, transformationInfo);
  }

  /**
    * Validate original parameters, then transform if validation passes.
    * Useful when you want to reject parameters that need transformation.
    *
    * @private
    */
   _validateThenTransform(schema, parameters, originalParams, transformationRules) {
    // Step 1: Validate original parameters
    const validationResult = this.validator.validate(schema, parameters);

    if (!validationResult.valid) {
      return new ValidationResult(false, parameters, validationResult.errors, null);
    }

    // Step 2: Transform validated parameters
    const transformed = transformationRules
      ? this.transformer.transformWithRules(schema, parameters, transformationRules)
      : this.transformer.transform(schema, parameters);
    const transformationInfo = this.transformer.getTransformationInfo(schema, originalParams, transformed);

    log.debug({ changeCount: transformationInfo.changeCount }, 'Validate then transform succeeded');
    return new ValidationResult(true, transformed, [], transformationInfo);
  }

  /**
   * Validate parameters without transformation (convenience method).
   *
   * @param {Object} schema - JSON Schema
   * @param {Object} parameters - Parameters to validate
   * @returns {Object} Validation result with valid and errors fields
   */
  validate(schema, parameters) {
    return this.validator.validate(schema, parameters);
  }

  /**
   * Transform parameters without validation (convenience method).
   *
   * @param {Object} schema - JSON Schema
   * @param {Object} parameters - Parameters to transform
   * @returns {Object} Transformed parameters
   */
  transform(schema, parameters) {
    return this.transformer.transform(schema, parameters);
  }

  /**
   * Add a custom transformation rule for a specific field.
   *
   * @param {string} fieldName - Field name to add rule for
   * @param {Function} transformFn - Transformation function (value, schema, context) => transformedValue
   */
  addCustomTransformer(fieldName, transformFn) {
    if (typeof transformFn !== 'function') {
      throw new TypeError('transformFn must be a function');
    }

    this.customTransformers[fieldName] = transformFn;
    log.debug({ fieldName }, 'Added custom transformer');
  }

  /**
   * Remove a custom transformation rule.
   *
   * @param {string} fieldName - Field name to remove rule for
   */
  removeCustomTransformer(fieldName) {
    delete this.customTransformers[fieldName];
    log.debug({ fieldName }, 'Removed custom transformer');
  }

  /**
   * Apply custom transformers to parameters.
   *
   * @param {Object} parameters - Parameters to transform
   * @param {Object} [context] - Context object passed to custom transformers
   * @returns {Object} Parameters with custom transformations applied
   */
  applyCustomTransformers(parameters, context = {}) {
    if (Object.keys(this.customTransformers).length === 0) {
      return parameters;
    }

    const transformed = { ...parameters };

    for (const [fieldName, transformFn] of Object.entries(this.customTransformers)) {
      if (fieldName in transformed) {
        try {
          transformed[fieldName] = transformFn(transformed[fieldName], context);
          log.debug({ fieldName }, 'Applied custom transformer');
        } catch (err) {
          log.error({ fieldName, err }, 'Custom transformer failed');
        }
      }
    }

    return transformed;
  }

  /**
   * Create a validation error response for tool invocation.
   *
   * @param {ValidationResult|Object} result - Validation result
   * @returns {Object|null} Error response or null if valid
   */
  createErrorResult(result) {
    if (result instanceof ValidationResult) {
      return result.toErrorResult();
    }

    return this.validator.createErrorResult(result);
  }

  /**
   * Get transformation info for debugging.
   *
   * @param {Object} schema - Original schema
   * @param {Object} originalParams - Original parameters
   * @param {Object} transformedParams - Transformed parameters
   * @returns {Object} Transformation info
   */
  getTransformationInfo(schema, originalParams, transformedParams) {
    return this.transformer.getTransformationInfo(schema, originalParams, transformedParams);
  }

  /**
   * Create a new instance with modified options.
   *
   * @param {Object} [options] - Options to merge with current configuration
   * @returns {ParameterValidatorTransformer} New instance with merged options
   */
  withOptions(options = {}) {
    const newOptions = {
      mode: this.defaultMode,
      transformMode: this.transformer.mode,
      strictNumbers: this.transformer.strictNumbers,
      allowEmptyStringToNull: this.transformer.allowEmptyStringToNull,
      customTransformers: { ...this.customTransformers },
      ...options
    };

    return new ParameterValidatorTransformer(newOptions);
  }
}

// Export singleton instance for convenience
export const parameterValidatorTransformer = new ParameterValidatorTransformer();
