/**
 * Parameter Transformer
 *
 * Provides type coercion and normalization for tool parameters.
 * Transforms parameters to expected types based on schema definitions.
 *
 * Supported transformations:
 * - String to number (parseInt, parseFloat)
 * - String to boolean (true/false, yes/no, 1/0)
 * - String to date (ISO 8601, various formats)
 * - Number to string
 * - Boolean to string
 * - Array normalization (comma-separated strings to arrays)
 * - Object normalization (JSON strings to objects)
 *
 * Usage:
 *   const transformer = new ParameterTransformer();
 *   const transformed = transformer.transform(schema, params);
 */

import { createLogger } from '../logger.js';

const log = createLogger('parameter-transformer');

/**
 * Supported type transformation modes
 */
export const TransformMode = {
  STRICT: 'strict',      // No transformation, validate as-is
  COERCE: 'coerce',      // Attempt type coercion
  NORMALIZE: 'normalize' // Coerce + normalize formats
};

/**
 * Type transformation utilities
 */
export class ParameterTransformer {
  constructor(options = {}) {
    this.mode = options.mode || TransformMode.COERCE;
    this.strictNumbers = options.strictNumbers ?? false;
    this.allowEmptyStringToNull = options.allowEmptyStringToNull ?? true;
  }

  /**
   * Transform parameters according to schema types.
   *
   * @param {Object} schema - JSON Schema defining expected types
   * @param {Object} parameters - Parameters to transform
   * @returns {Object} Transformed parameters
   */
  transform(schema, parameters) {
    if (this.mode === TransformMode.STRICT) {
      return parameters;
    }

    if (!schema || typeof schema !== 'object') {
      return parameters;
    }

    if (parameters === null || parameters === undefined) {
      return parameters;
    }

    if (typeof parameters !== 'object') {
      return parameters;
    }

    const transformed = {};
    const properties = schema.properties || {};
    const required = schema.required || [];

    for (const [key, value] of Object.entries(parameters)) {
      const propertySchema = properties[key];

      if (propertySchema) {
        transformed[key] = this._transformValue(value, propertySchema, key);
      } else if (required.includes(key)) {
        // Required field not in schema, pass through
        transformed[key] = value;
      } else {
        // Optional field not in schema, pass through
        transformed[key] = value;
      }
    }

    // Ensure required fields exist (even if undefined)
    for (const reqField of required) {
      if (!(reqField in transformed) && !(reqField in parameters)) {
        const propertySchema = properties[reqField];
        if (propertySchema?.default !== undefined) {
          transformed[reqField] = propertySchema.default;
        }
      }
    }

    return transformed;
  }

  /**
   * Transform a single value based on its schema.
   *
   * @param {*} value - Value to transform
   * @param {Object} schema - Schema for this value
   * @param {string} path - Field path for logging
   * @returns {*} Transformed value
   * @private
   */
  _transformValue(value, schema, path = '') {
    if (value === null || value === undefined) {
      if (this.allowEmptyStringToNull && value === '') {
        return null;
      }
      return value;
    }

    const type = schema.type;

    // Handle enum types - validate but don't transform
    if (schema.enum) {
      if (schema.enum.includes(value)) {
        return value;
      }
      // Try type coercion for enum
      if (typeof value === 'string') {
        // Try to parse as number for number enums
        const numValue = parseFloat(value);
        if (!Number.isNaN(numValue) && schema.enum.includes(numValue)) {
          log.debug({ path, value, numValue }, 'Coerced enum string to number');
          return numValue;
        }
        // Try boolean for boolean enums
        const lowerValue = value.toLowerCase().trim();
        if (lowerValue === 'true' && schema.enum.includes(true)) {
          log.debug({ path, value }, 'Coerced enum string to boolean true');
          return true;
        }
        if (lowerValue === 'false' && schema.enum.includes(false)) {
          log.debug({ path, value }, 'Coerced enum string to boolean false');
          return false;
        }
        // Try string coercion
        if (schema.enum.includes(value)) {
          log.debug({ path, value }, 'Coerced enum value as string');
          return value;
        }
      }
      return value; // Will fail validation
    }

    // Handle oneOf/anyOf types
    if (schema.oneOf || schema.anyOf) {
      return this._tryTypeUnions(value, schema, path);
    }

    // Handle array types
    if (type === 'array' && schema.items) {
      return this._transformArray(value, schema.items, path);
    }

    // Handle object types
    if (type === 'object' && schema.properties) {
      return this.transform(schema, value);
    }

    // Handle primitive types
    switch (type) {
      case 'string':
        return this._transformToString(value, schema, path);
      case 'number':
        return this._transformToNumber(value, schema, path);
      case 'integer':
        return this._transformToInteger(value, schema, path);
      case 'boolean':
        return this._transformToBoolean(value, schema, path);
      case 'date':
        return this._transformToDate(value, schema, path);
      default:
        return value;
    }
  }

  /**
   * Try to match value against oneOf/anyOf type unions.
   *
   * @param {*} value - Value to transform
   * @param {Object} schema - Schema with oneOf/anyOf
   * @param {string} path - Field path for logging
   * @returns {*} Transformed value
   * @private
   */
  _tryTypeUnions(value, schema, path) {
    const alternatives = schema.oneOf || schema.anyOf;

    if (!Array.isArray(alternatives)) {
      return value;
    }

    // Check if value matches any type without transformation
    let directMatch = null;
    for (const altSchema of alternatives) {
      if (this._matchesType(value, altSchema)) {
        directMatch = altSchema;
        break;
      }
    }

    // If we have a direct match, check if we should prefer a different type
    // For numeric strings, prefer number over string
    if (directMatch && typeof value === 'string') {
      const hasNumberType = alternatives.some(alt => alt.type === 'number' || alt.type === 'integer');
      const hasBooleanType = alternatives.some(alt => alt.type === 'boolean');
      const hasStringType = alternatives.some(alt => alt.type === 'string');

      if (hasNumberType && hasStringType) {
        // Try to parse as number
        const num = this._transformToNumber(value, directMatch, path);
        if (typeof num === 'number' && !Number.isNaN(num)) {
          log.debug({ path, value, num }, 'Preferred number type for numeric string in union');
          return num;
        }
      }

      if (hasBooleanType && hasStringType) {
        // Try to parse as boolean
        const bool = this._transformToBoolean(value, directMatch, path);
        if (typeof bool === 'boolean') {
          log.debug({ path, value, bool }, 'Preferred boolean type for boolean string in union');
          return bool;
        }
      }
    }

    // Return direct match if found
    if (directMatch) {
      return value;
    }

    // Try transforming to each alternative type
    for (const altSchema of alternatives) {
      const transformed = this._transformValue(value, altSchema, path);
      if (this._matchesType(transformed, altSchema)) {
        log.debug({ path, value, transformed, target: altSchema.type }, 'Coerced to union type');
        return transformed;
      }
    }

    return value; // Will fail validation
  }

  /**
   * Check if a value matches a schema type.
   *
   * @param {*} value - Value to check
   * @param {Object} schema - Schema to check against
   * @returns {boolean} True if value matches type
   * @private
   */
  _matchesType(value, schema) {
    if (value === null || value === undefined) {
      return schema.type === 'null' || schema.nullable;
    }

    const type = schema.type;

    switch (type) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !Number.isNaN(value);
      case 'integer':
        return Number.isInteger(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && !Array.isArray(value);
      case 'null':
        return value === null;
      default:
        return true;
    }
  }

  /**
   * Transform value to string.
   *
   * @param {*} value - Value to transform
   * @param {Object} schema - String schema (may include format)
   * @param {string} path - Field path for logging
   * @returns {string} Transformed string
   * @private
   */
  _transformToString(value, schema, path) {
    if (typeof value === 'string') {
      return this._normalizeString(value, schema, path);
    }

    // Convert other types to string
    if (typeof value === 'number' || typeof value === 'boolean') {
      const str = String(value);
      log.debug({ path, value, str }, 'Coerced to string');
      return str;
    }

    if (Array.isArray(value)) {
      const str = JSON.stringify(value);
      log.debug({ path, value, str }, 'Coerced array to JSON string');
      return str;
    }

    if (typeof value === 'object') {
      const str = JSON.stringify(value);
      log.debug({ path, value, str }, 'Coerced object to JSON string');
      return str;
    }

    return String(value);
  }

  /**
   * Normalize string value based on format.
   *
   * @param {string} value - String value
   * @param {Object} schema - String schema with format
   * @param {string} path - Field path for logging
   * @returns {string} Normalized string
   * @private
   */
  _normalizeString(value, schema, path) {
    const format = schema.format;

    if (!format) {
      return value;
    }

    switch (format) {
      case 'date-time':
      case 'date':
      case 'time':
        // These are validated by ajv-formats, no transformation needed
        return value;

      case 'email':
        // Lowercase email addresses (common normalization)
        if (schema.lowercase) {
          const lower = value.toLowerCase();
          if (lower !== value) {
            log.debug({ path, value, lower }, 'Lowercased email');
            return lower;
          }
        }
        return value;

      case 'uri':
      case 'url':
        // Normalize URL schemes to lowercase
        const urlMatch = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
        if (urlMatch) {
          const scheme = urlMatch[1].toLowerCase();
          if (scheme !== urlMatch[1]) {
            const normalized = value.replace(urlMatch[1], scheme);
            log.debug({ path, value, normalized }, 'Normalized URL scheme');
            return normalized;
          }
        }
        return value;

      default:
        return value;
    }
  }

  /**
   * Transform value to number.
   *
   * @param {*} value - Value to transform
   * @param {Object} schema - Number schema
   * @param {string} path - Field path for logging
   * @returns {number} Transformed number
   * @private
   */
  _transformToNumber(value, schema, path) {
    if (typeof value === 'number') {
      // Validate constraints
      if (!Number.isNaN(value)) {
        return value;
      }
      return NaN; // Already a number but NaN
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();

      // Empty string handling
      if (trimmed === '') {
        if (this.allowEmptyStringToNull) {
          return null;
        }
        return NaN;
      }

      // Check for scientific notation
      if (/^[+-]?\d*\.?\d+([eE][+-]?\d+)?$/.test(trimmed)) {
        const num = parseFloat(trimmed);
        if (!Number.isNaN(num)) {
          log.debug({ path, value, num }, 'Coerced string to number');
          return num;
        }
      }

      // Percentage format
      if (trimmed.endsWith('%')) {
        const percent = trimmed.slice(0, -1).trim();
        const num = parseFloat(percent) / 100;
        if (!Number.isNaN(num)) {
          log.debug({ path, value, num }, 'Coerced percentage to decimal');
          return num;
        }
      }

      return NaN;
    }

    if (typeof value === 'boolean') {
      const num = Number(value);
      log.debug({ path, value, num }, 'Coerced boolean to number');
      return num;
    }

    return NaN;
  }

  /**
   * Transform value to integer.
   *
   * @param {*} value - Value to transform
   * @param {Object} schema - Integer schema
   * @param {string} path - Field path for logging
   * @returns {number} Transformed integer
   * @private
   */
  _transformToInteger(value, schema, path) {
    if (Number.isInteger(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();

      if (trimmed === '') {
        if (this.allowEmptyStringToNull) {
          return null;
        }
        return NaN;
      }

      // Parse integer (no decimals)
      if (/^[+-]?\d+$/.test(trimmed)) {
        const int = parseInt(trimmed, 10);
        log.debug({ path, value, int }, 'Coerced string to integer');
        return int;
      }

      // Parse float and truncate
      const num = parseFloat(trimmed);
      if (!Number.isNaN(num)) {
        const int = this.strictNumbers ? NaN : Math.trunc(num);
        if (!Number.isNaN(int)) {
          log.debug({ path, value, int }, 'Coerced float to integer');
          return int;
        }
      }
    }

    if (typeof value === 'number') {
      if (this.strictNumbers && !Number.isInteger(value)) {
        return NaN;
      }
      const int = Math.trunc(value);
      log.debug({ path, value, int }, 'Truncated number to integer');
      return int;
    }

    return NaN;
  }

  /**
   * Transform value to boolean.
   *
   * @param {*} value - Value to transform
   * @param {Object} schema - Boolean schema
   * @param {string} path - Field path for logging
   * @returns {boolean} Transformed boolean
   * @private
   */
  _transformToBoolean(value, schema, path) {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const lower = value.toLowerCase().trim();

      const trueValues = ['true', 'yes', 'y', '1', 'on', 'enabled'];
      const falseValues = ['false', 'no', 'n', '0', 'off', 'disabled'];

      if (trueValues.includes(lower)) {
        log.debug({ path, value }, 'Coerced string to true');
        return true;
      }

      if (falseValues.includes(lower)) {
        log.debug({ path, value }, 'Coerced string to false');
        return false;
      }
    }

    if (typeof value === 'number') {
      const bool = value !== 0;
      log.debug({ path, value, bool }, 'Coerced number to boolean');
      return bool;
    }

    if (typeof value === 'object' && value !== null) {
      // Objects are truthy, but we don't auto-convert them
      return Boolean(value);
    }

    return Boolean(value);
  }

  /**
   * Transform array value.
   *
   * @param {*} value - Value to transform
   * @param {Object} itemSchema - Schema for array items
   * @param {string} path - Field path for logging
   * @returns {Array} Transformed array
   * @private
   */
  _transformArray(value, itemSchema, path) {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        this._transformValue(item, itemSchema, `${path}[${index}]`)
      );
    }

    if (typeof value === 'string') {
      // Try to parse as JSON array
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          log.debug({ path, value }, 'Parsed JSON string as array');
          return parsed.map((item, index) =>
            this._transformValue(item, itemSchema, `${path}[${index}]`)
          );
        }
      } catch {
        // Not valid JSON, try comma-separated
      }

      // Try comma-separated values
      const items = value.split(',').map(s => s.trim()).filter(s => s !== '');
      if (items.length > 0) {
        log.debug({ path, value, count: items.length }, 'Split comma-separated string to array');
        return items.map((item, index) =>
          this._transformValue(item, itemSchema, `${path}[${index}]`)
        );
      }

      // Empty or whitespace-only string
      return [];
    }

    // Single value - wrap in array
    return [this._transformValue(value, itemSchema, path)];
  }

  /**
   * Transform value to date.
   *
   * @param {*} value - Value to transform
   * @param {Object} schema - Date schema
   * @param {string} path - Field path for logging
   * @returns {Date} Transformed date
   * @private
   */
  _transformToDate(value, schema, path) {
    if (value instanceof Date) {
      return value;
    }

    if (typeof value === 'number') {
      // Detect if timestamp is in seconds (9-10 digits) or milliseconds (13 digits)
      // Modern Unix timestamps: seconds = ~10 digits (e.g., 1705315800)
      // Milliseconds = ~13 digits (e.g., 1705315800000)
      const absValue = Math.abs(value);
      let date;

      if (absValue >= 1e10) {
        // Milliseconds since the epoch. The lower threshold also covers
        // legitimate historical dates before September 2001.
        date = new Date(value);
        log.debug({ path, value }, 'Coerced milliseconds timestamp to date');
      } else if (absValue > 1e8) {
        // Likely seconds (9-10 digits for practical Unix dates)
        date = new Date(value * 1000);
        log.debug({ path, value }, 'Coerced seconds timestamp to date');
      } else {
        // Try as-is first, then as seconds
        date = new Date(value);
        if (!Number.isNaN(date.getTime())) {
          log.debug({ path, value }, 'Coerced timestamp to date');
        } else {
          date = new Date(value * 1000);
          if (!Number.isNaN(date.getTime())) {
            log.debug({ path, value }, 'Coerced seconds timestamp to date');
          }
        }
      }

      if (Number.isNaN(date.getTime())) {
        return new Date(NaN);
      }
      return date;
    }

    if (typeof value === 'string') {
      // ECMAScript treats a bare ISO date as UTC. For this schema's date-only
      // value, preserve the caller's calendar date in local time instead.
      const dateOnlyMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dateOnlyMatch) {
        const [, year, month, day] = dateOnlyMatch;
        const localDate = new Date(Number(year), Number(month) - 1, Number(day));
        if (
          localDate.getFullYear() === Number(year)
          && localDate.getMonth() === Number(month) - 1
          && localDate.getDate() === Number(day)
        ) {
          log.debug({ path, value }, 'Coerced date-only string to local date');
          return localDate;
        }
        return new Date(NaN);
      }

      // Try various date formats
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        log.debug({ path, value }, 'Coerced string to date');
        return date;
      }

      // Try common formats
      const formats = [
        /^(\d{4})-(\d{2})-(\d{2})$/,           // YYYY-MM-DD
        /^(\d{4})\/(\d{2})\/(\d{2})$/,           // YYYY/MM/DD
        /^(\d{2})-(\d{2})-(\d{4})$/,           // DD-MM-YYYY
        /^(\d{2})\/(\d{2})\/(\d{4})$/,           // DD/MM/YYYY
        /^(\d{2})-(\d{2})-(\d{2})$/,           // DD-MM-YY
        /^(\d{2})\/(\d{2})\/(\d{2})$/,           // DD/MM/YY
      ];

      for (const [format, regex] of Object.entries(formats)) {
        const match = value.match(regex);
        if (match) {
          const date = this._parseCustomDate(match);
          if (!Number.isNaN(date.getTime())) {
            log.debug({ path, value, format }, 'Parsed custom date format');
            return date;
          }
        }
      }
    }

    return new Date(NaN);
  }

  /**
   * Parse custom date format match.
   *
   * @param {Array} match - Regex match array
   * @returns {Date} Parsed date
   * @private
   */
  _parseCustomDate(match) {
    const [_, part1, part2, part3] = match;

    // Determine format based on part lengths
    if (part3.length === 4) {
      // YYYY-MM-DD or DD-MM-YYYY
      if (part1.length === 4) {
        return new Date(parseInt(part1, 10), parseInt(part2, 10) - 1, parseInt(part3, 10));
      }
      return new Date(parseInt(part3, 10), parseInt(part2, 10) - 1, parseInt(part1, 10));
    }

    // YY-MM-DD or DD-MM-YY
    // For 2-2-2 format, assume DD-MM-YY (part1=day, part2=month, part3=year)
    let year = parseInt(part3, 10);
    if (year < 50) {
      year += 2000;
    } else if (year < 100) {
      year += 1900;
    }

    const month = parseInt(part2, 10) - 1;
    const day = parseInt(part1, 10);

    return new Date(year, month, day);
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
    const changes = [];
    const properties = schema?.properties || {};

    for (const [key, originalValue] of Object.entries(originalParams || {})) {
      const transformedValue = transformedParams?.[key];
      const propertySchema = properties[key];

      if (originalValue !== transformedValue) {
        changes.push({
          field: key,
          original: originalValue,
          transformed: transformedValue,
          targetType: propertySchema?.type
        });
      }
    }

    return {
      mode: this.mode,
      changes,
      changeCount: changes.length
    };
  }

  /**
   * Transform parameters with configurable transformation rules.
   *
   * @param {Object} schema - JSON Schema defining expected types
   * @param {Object} parameters - Parameters to transform
   * @param {Object} transformationRules - Per-tool transformation rules
   * @returns {Object} Transformed parameters
   */
  transformWithRules(schema, parameters, transformationRules) {
    if (!transformationRules) {
      return this.transform(schema, parameters);
    }

    const originalMode = this.mode;
    const originalStrictNumbers = this.strictNumbers;
    const originalAllowEmptyStringToNull = this.allowEmptyStringToNull;

    try {
      // Apply transformation rules
      if (transformationRules.mode) {
        this.mode = transformationRules.mode;
      }
      if (transformationRules.strictNumbers !== undefined) {
        this.strictNumbers = transformationRules.strictNumbers;
      }
      if (transformationRules.allowEmptyStringToNull !== undefined) {
        this.allowEmptyStringToNull = transformationRules.allowEmptyStringToNull;
      }

      // Apply field-specific transformations if defined
      const transformed = this.transform(schema, parameters);

      // Apply custom field transformations
      if (transformationRules.fields) {
        for (const [fieldName, fieldRules] of Object.entries(transformationRules.fields)) {
          if (transformed[fieldName] !== undefined) {
            transformed[fieldName] = this._applyFieldRules(
              transformed[fieldName],
              fieldRules,
              fieldName
            );
          } else if (fieldRules.default !== undefined) {
            // Apply default value for missing fields
            transformed[fieldName] = fieldRules.default;
            log.debug({ field: fieldName, value: fieldRules.default }, 'Applied default value for missing field');
          }
        }
      }

      return transformed;
    } finally {
      // Restore original settings
      this.mode = originalMode;
      this.strictNumbers = originalStrictNumbers;
      this.allowEmptyStringToNull = originalAllowEmptyStringToNull;
    }
  }

  /**
   * Apply field-specific transformation rules.
   *
   * @param {*} value - Value to transform
   * @param {Object} rules - Field transformation rules
   * @param {string} fieldName - Field name for logging
   * @returns {*} Transformed value
   * @private
   */
  _applyFieldRules(value, rules, fieldName) {
    if (rules.default !== undefined && value === undefined) {
      log.debug({ field: fieldName, value: rules.default }, 'Applied default value');
      return rules.default;
    }

    if (rules.trim && typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== value) {
        log.debug({ field: fieldName, value, trimmed }, 'Trimmed field value');
      }
      value = trimmed;
    }

    if (rules.lowercase && typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower !== value) {
        log.debug({ field: fieldName, value, lower }, 'Lowercased field value');
      }
      value = lower;
    }

    if (rules.uppercase && typeof value === 'string') {
      const upper = value.toUpperCase();
      if (upper !== value) {
        log.debug({ field: fieldName, value, upper }, 'Uppercased field value');
      }
      value = upper;
    }

    if (rules.prefix && typeof value === 'string') {
      const prefixed = rules.prefix + value;
      log.debug({ field: fieldName, value, prefixed }, 'Added prefix to field value');
      value = prefixed;
    }

    if (rules.suffix && typeof value === 'string') {
      const suffixed = value + rules.suffix;
      log.debug({ field: fieldName, value, suffixed }, 'Added suffix to field value');
      value = suffixed;
    }

    if (rules.map && typeof rules.map === 'object') {
      const mapped = rules.map[value];
      if (mapped !== undefined) {
        log.debug({ field: fieldName, value, mapped }, 'Mapped field value');
        value = mapped;
      }
    }

    if (rules.multiply && typeof value === 'number') {
      const multiplied = value * rules.multiply;
      log.debug({ field: fieldName, value, multiplied }, 'Multiplied field value');
      value = multiplied;
    }

    if (rules.add && typeof value === 'number') {
      const added = value + rules.add;
      log.debug({ field: fieldName, value, added }, 'Added to field value');
      value = added;
    }

    return value;
  }
}

// Export singleton instance for convenience
export const parameterTransformer = new ParameterTransformer();
