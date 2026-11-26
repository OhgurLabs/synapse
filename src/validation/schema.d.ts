// Type declarations for src/validation/schema.js

/** Validation result returned by Validator.validate(). */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Chainable validator node — holds type constraints and validation checks.
 * Created via Schema factory methods; not directly instantiated.
 */
export declare class Validator {
  /** Mark field as optional (undefined/null allowed). */
  optional(): this;

  /** Mark field as required (default). */
  required(): this;

  /** Minimum value (number) or minimum length (string/array). */
  min(n: number): this;

  /** Maximum value (number) or maximum length (string/array). */
  max(n: number): this;

  /** String must match the given regex pattern. */
  pattern(regex: RegExp): this;

  /** Arbitrary validation function. Return true to pass, false or a string error to fail. */
  custom(fn: (value: unknown) => boolean | string): this;

  /** Validate a value, optionally with a dot-path prefix for error messages. */
  validate(value: unknown, path?: string): ValidationResult;
}

/**
 * Schema factory — creates chainable Validator instances for runtime validation.
 */
export declare class Schema {
  static string(): Validator;
  static number(): Validator;
  static boolean(): Validator;
  static enum(values: readonly unknown[]): Validator;
  static array(itemSchema?: Validator): Validator;
  static object(shape?: Record<string, Validator>): Validator;
  static any(): Validator;
}
