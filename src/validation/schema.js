// Schema — lightweight, zero-dependency runtime validation.
// Chainable builder pattern: Schema.string().min(1).max(255).required()

/**
 * Internal validator node — holds a chain of constraints.
 * Not exported; consumers interact through the Schema factory.
 */
class Validator {
  constructor(type) {
    /** @type {string} */
    this._type = type; // 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object' | 'any'
    /** @type {boolean} */
    this._required = true; // required by default
    /** @type {Array<{name: string, fn: function, msg: string}>} */
    this._checks = [];
    /** @type {*} metadata used by enum, array, object */
    this._meta = undefined;
  }

  // ── Chainable modifiers ────────────────────────────────────────────

  /** Mark this field as optional (undefined / missing key is OK). */
  optional() {
    this._required = false;
    return this;
  }

  /** Mark this field as required (this is the default). */
  required() {
    this._required = true;
    return this;
  }

  /** Minimum value (number) or minimum length (string / array). */
  min(n) {
    this._checks.push({
      name: 'min',
      fn: (v) => {
        if (typeof v === 'number') return v >= n;
        if (typeof v === 'string') return v.length >= n;
        if (Array.isArray(v)) return v.length >= n;
        return true;
      },
      msg: `must be at least ${n}`,
    });
    return this;
  }

  /** Maximum value (number) or maximum length (string / array). */
  max(n) {
    this._checks.push({
      name: 'max',
      fn: (v) => {
        if (typeof v === 'number') return v <= n;
        if (typeof v === 'string') return v.length <= n;
        if (Array.isArray(v)) return v.length <= n;
        return true;
      },
      msg: `must be at most ${n}`,
    });
    return this;
  }

  /** String must match the given regex. */
  pattern(regex) {
    this._checks.push({
      name: 'pattern',
      fn: (v) => typeof v === 'string' && regex.test(v),
      msg: `must match pattern ${regex}`,
    });
    return this;
  }

  /** Arbitrary validation function.  Receives value, returns true/false or a string error. */
  custom(fn) {
    this._checks.push({
      name: 'custom',
      fn: (v) => {
        const result = fn(v);
        if (result === true) return true;
        if (typeof result === 'string') return result; // error message
        return false;
      },
      msg: 'failed custom validation',
    });
    return this;
  }

  // ── Core validation ────────────────────────────────────────────────

  /**
   * @param {*} value
   * @param {string} [path] - dot-path for nested error messages
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate(value, path = '') {
    const errors = [];
    const prefix = path ? `${path}: ` : '';

    // Handle undefined / null
    if (value === undefined || value === null) {
      if (this._required) {
        errors.push(`${prefix}is required`);
      }
      return { valid: errors.length === 0, errors };
    }

    // Type check
    switch (this._type) {
      case 'string':
        if (typeof value !== 'string') {
          errors.push(`${prefix}must be a string`);
          return { valid: false, errors };
        }
        break;
      case 'number':
        if (typeof value !== 'number' || Number.isNaN(value)) {
          errors.push(`${prefix}must be a number`);
          return { valid: false, errors };
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          errors.push(`${prefix}must be a boolean`);
          return { valid: false, errors };
        }
        break;
      case 'enum': {
        const allowed = this._meta;
        if (!allowed.includes(value)) {
          errors.push(`${prefix}must be one of [${allowed.join(', ')}]`);
          return { valid: false, errors };
        }
        break;
      }
      case 'array': {
        if (!Array.isArray(value)) {
          errors.push(`${prefix}must be an array`);
          return { valid: false, errors };
        }
        const itemValidator = this._meta;
        if (itemValidator) {
          for (let i = 0; i < value.length; i++) {
            const itemResult = itemValidator.validate(value[i], `${path}[${i}]`);
            errors.push(...itemResult.errors);
          }
        }
        break;
      }
      case 'object': {
        if (typeof value !== 'object' || Array.isArray(value)) {
          errors.push(`${prefix}must be an object`);
          return { valid: false, errors };
        }
        const shape = this._meta;
        if (shape) {
          for (const [key, validator] of Object.entries(shape)) {
            const fieldPath = path ? `${path}.${key}` : key;
            const fieldResult = validator.validate(value[key], fieldPath);
            errors.push(...fieldResult.errors);
          }
        }
        break;
      }
      // 'any' — skip type check
    }

    // Run constraint checks
    for (const check of this._checks) {
      const result = check.fn(value);
      if (result === true) continue;
      if (typeof result === 'string') {
        errors.push(`${prefix}${result}`);
      } else {
        errors.push(`${prefix}${check.msg}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

// ── Schema factory ─────────────────────────────────────────────────────

export class Schema {
  /** @returns {Validator} */
  static string() {
    return new Validator('string');
  }

  /** @returns {Validator} */
  static number() {
    return new Validator('number');
  }

  /** @returns {Validator} */
  static boolean() {
    return new Validator('boolean');
  }

  /**
   * @param {Array} values - allowed values
   * @returns {Validator}
   */
  static enum(values) {
    const v = new Validator('enum');
    v._meta = [...values];
    return v;
  }

  /**
   * @param {Validator} [itemSchema] - validator for each item
   * @returns {Validator}
   */
  static array(itemSchema) {
    const v = new Validator('array');
    v._meta = itemSchema ?? null;
    return v;
  }

  /**
   * @param {Record<string, Validator>} shape - validators for each key
   * @returns {Validator}
   */
  static object(shape) {
    const v = new Validator('object');
    v._meta = shape ?? null;
    return v;
  }

  /**
   * Unconstrained type — only required/optional and custom checks apply.
   * @returns {Validator}
   */
  static any() {
    return new Validator('any');
  }
}
