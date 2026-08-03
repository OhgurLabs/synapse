/**
 * Unit tests for ParameterTransformer class
 * 
 * Tests parameter transformation functionality:
 * - String transformation with format normalization
 * - Number and integer transformation
 * - Boolean transformation
 * - Array transformation (JSON parsing, comma-separated)
 * - Date transformation (timestamps, various formats)
 * - Type union handling (oneOf/anyOf)
 * - Enum validation
 * - Field-specific transformation rules
 */

import assert from 'assert';
import { ParameterTransformer, TransformMode } from '../../src/mcp/parameter-transformer.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function isNaN(value) {
  return Number.isNaN(value);
}

// ============================================================================
// CONSTRUCTOR TESTS
// ============================================================================

test('Constructor - default options', () => {
  const transformer = new ParameterTransformer();
  assertEqual(transformer.mode, TransformMode.COERCE, 'Default mode should be COERCE');
  assertEqual(transformer.strictNumbers, false, 'Default strictNumbers should be false');
  assertEqual(transformer.allowEmptyStringToNull, true, 'Default allowEmptyStringToNull should be true');
});

test('Constructor - custom options', () => {
  const transformer = new ParameterTransformer({
    mode: TransformMode.STRICT,
    strictNumbers: true,
    allowEmptyStringToNull: false
  });
  assertEqual(transformer.mode, TransformMode.STRICT, 'Should set custom mode');
  assertEqual(transformer.strictNumbers, true, 'Should set custom strictNumbers');
  assertEqual(transformer.allowEmptyStringToNull, false, 'Should set custom allowEmptyStringToNull');
});

// ============================================================================
// STRING TRANSFORMATION TESTS
// ============================================================================

test('_transformToString - string to string (no change)', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'string' };
  const result = transformer._transformToString('hello', schema, 'test');
  assertEqual(result, 'hello', 'String should remain unchanged');
});

test('_transformToString - number to string', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'string' };
  const result = transformer._transformToString(42, schema, 'test');
  assertEqual(result, '42', 'Number should be converted to string');
});

test('_transformToString - boolean to string', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'string' };
  assertEqual(transformer._transformToString(true, schema, 'test'), 'true', 'True should convert to "true"');
  assertEqual(transformer._transformToString(false, schema, 'test'), 'false', 'False should convert to "false"');
});

test('_transformToString - array to JSON string', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'string' };
  const result = transformer._transformToString([1, 2, 3], schema, 'test');
  assertEqual(result, '[1,2,3]', 'Array should be converted to JSON string');
});

test('_transformToString - object to JSON string', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'string' };
  const result = transformer._transformToString({ a: 1, b: 2 }, schema, 'test');
  assertEqual(result, '{"a":1,"b":2}', 'Object should be converted to JSON string');
});

test('_normalizeString - email lowercase', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'string', format: 'email', lowercase: true };
  const result = transformer._normalizeString('USER@EXAMPLE.COM', schema, 'email');
  assertEqual(result, 'user@example.com', 'Email should be lowercased');
});

test('_normalizeString - URL scheme normalization', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'string', format: 'url' };
  const result = transformer._normalizeString('HTTP://EXAMPLE.COM', schema, 'url');
  assertEqual(result, 'http://EXAMPLE.COM', 'URL scheme should be lowercased');
});

test('_normalizeString - no format specified', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'string' };
  const result = transformer._normalizeString('Hello World', schema, 'test');
  assertEqual(result, 'Hello World', 'String without format should remain unchanged');
});

// ============================================================================
// NUMBER TRANSFORMATION TESTS
// ============================================================================

test('_transformToNumber - number to number (no change)', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'number' };
  const result = transformer._transformToNumber(42.5, schema, 'test');
  assertEqual(result, 42.5, 'Number should remain unchanged');
});

test('_transformToNumber - valid string to number', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'number' };
  assertEqual(transformer._transformToNumber('42', schema, 'test'), 42, 'Integer string should convert to number');
  assertEqual(transformer._transformToNumber('42.5', schema, 'test'), 42.5, 'Float string should convert to number');
  assertEqual(transformer._transformToNumber('-3.14', schema, 'test'), -3.14, 'Negative float should convert to number');
});

test('_transformToNumber - scientific notation', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'number' };
  assertEqual(transformer._transformToNumber('1.23e4', schema, 'test'), 12300, 'Scientific notation should convert to number');
  assertEqual(transformer._transformToNumber('-5.5E-2', schema, 'test'), -0.055, 'Negative scientific notation should convert');
});

test('_transformToNumber - percentage to decimal', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'number' };
  assertEqual(transformer._transformToNumber('50%', schema, 'test'), 0.5, '50% should convert to 0.5');
  assertEqual(transformer._transformToNumber('25.5%', schema, 'test'), 0.255, '25.5% should convert to 0.255');
  assertEqual(transformer._transformToNumber('-10%', schema, 'test'), -0.1, 'Negative percentage should convert');
});

test('_transformToNumber - boolean to number', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'number' };
  assertEqual(transformer._transformToNumber(true, schema, 'test'), 1, 'True should convert to 1');
  assertEqual(transformer._transformToNumber(false, schema, 'test'), 0, 'False should convert to 0');
});

test('_transformToNumber - empty string with allowEmptyStringToNull', () => {
  const transformer = new ParameterTransformer({ allowEmptyStringToNull: true });
  const schema = { type: 'number' };
  const result = transformer._transformToNumber('', schema, 'test');
  assertEqual(result, null, 'Empty string should convert to null');
});

test('_transformToNumber - empty string without allowEmptyStringToNull', () => {
  const transformer = new ParameterTransformer({ allowEmptyStringToNull: false });
  const schema = { type: 'number' };
  const result = transformer._transformToNumber('', schema, 'test');
  assertEqual(isNaN(result), true, 'Empty string should convert to NaN');
});

test('_transformToNumber - invalid string', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'number' };
  const result = transformer._transformToNumber('invalid', schema, 'test');
  assertEqual(isNaN(result), true, 'Invalid string should convert to NaN');
});

test('_transformToNumber - NaN input', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'number' };
  const result = transformer._transformToNumber(NaN, schema, 'test');
  assertEqual(isNaN(result), true, 'NaN should remain NaN');
});

// ============================================================================
// INTEGER TRANSFORMATION TESTS
// ============================================================================

test('_transformToInteger - integer to integer (no change)', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'integer' };
  const result = transformer._transformToInteger(42, schema, 'test');
  assertEqual(result, 42, 'Integer should remain unchanged');
});

test('_transformToInteger - valid string to integer', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'integer' };
  assertEqual(transformer._transformToInteger('42', schema, 'test'), 42, 'Integer string should convert');
  assertEqual(transformer._transformToInteger('-10', schema, 'test'), -10, 'Negative integer string should convert');
});

test('_transformToInteger - float string to integer (truncated)', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'integer' };
  assertEqual(transformer._transformToInteger('42.7', schema, 'test'), 42, 'Float string should truncate');
  assertEqual(transformer._transformToInteger('-3.9', schema, 'test'), -3, 'Negative float string should truncate');
});

test('_transformToInteger - number to integer (truncated)', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'integer' };
  assertEqual(transformer._transformToInteger(42.7, schema, 'test'), 42, 'Float number should truncate');
  assertEqual(transformer._transformToInteger(-3.9, schema, 'test'), -3, 'Negative float number should truncate');
});

test('_transformToInteger - strict mode rejects floats', () => {
  const transformer = new ParameterTransformer({ strictNumbers: true });
  const schema = { type: 'integer' };
  const result = transformer._transformToInteger('42.7', schema, 'test');
  assertEqual(isNaN(result), true, 'Strict mode should reject float strings');
});

test('_transformToInteger - empty string with allowEmptyStringToNull', () => {
  const transformer = new ParameterTransformer({ allowEmptyStringToNull: true });
  const schema = { type: 'integer' };
  const result = transformer._transformToInteger('', schema, 'test');
  assertEqual(result, null, 'Empty string should convert to null');
});

test('_transformToInteger - invalid string', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'integer' };
  const result = transformer._transformToInteger('invalid', schema, 'test');
  assertEqual(isNaN(result), true, 'Invalid string should convert to NaN');
});

// ============================================================================
// BOOLEAN TRANSFORMATION TESTS
// ============================================================================

test('_transformToBoolean - boolean to boolean (no change)', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'boolean' };
  assertEqual(transformer._transformToBoolean(true, schema, 'test'), true, 'True should remain true');
  assertEqual(transformer._transformToBoolean(false, schema, 'test'), false, 'False should remain false');
});

test('_transformToBoolean - true string values', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'boolean' };
  const trueValues = ['true', 'TRUE', 'True', 'yes', 'YES', 'y', 'Y', '1', 'on', 'ON', 'enabled', 'ENABLED'];
  for (const val of trueValues) {
    assertEqual(transformer._transformToBoolean(val, schema, 'test'), true, `${val} should convert to true`);
  }
});

test('_transformToBoolean - false string values', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'boolean' };
  const falseValues = ['false', 'FALSE', 'False', 'no', 'NO', 'n', 'N', '0', 'off', 'OFF', 'disabled', 'DISABLED'];
  for (const val of falseValues) {
    assertEqual(transformer._transformToBoolean(val, schema, 'test'), false, `${val} should convert to false`);
  }
});

test('_transformToBoolean - number to boolean', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'boolean' };
  assertEqual(transformer._transformToBoolean(1, schema, 'test'), true, 'Non-zero number should convert to true');
  assertEqual(transformer._transformToBoolean(0, schema, 'test'), false, 'Zero should convert to false');
  assertEqual(transformer._transformToBoolean(-5, schema, 'test'), true, 'Negative number should convert to true');
  assertEqual(transformer._transformToBoolean(42.7, schema, 'test'), true, 'Float should convert to true');
});

test('_transformToBoolean - object to boolean', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'boolean' };
  assertEqual(transformer._transformToBoolean({ a: 1 }, schema, 'test'), true, 'Object should convert to true');
  assertEqual(transformer._transformToBoolean({}, schema, 'test'), true, 'Empty object should convert to true');
  assertEqual(transformer._transformToBoolean([1, 2], schema, 'test'), true, 'Array should convert to true');
});

test('_transformToBoolean - null/undefined to boolean', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'boolean' };
  assertEqual(transformer._transformToBoolean(null, schema, 'test'), false, 'Null should convert to false');
  assertEqual(transformer._transformToBoolean(undefined, schema, 'test'), false, 'Undefined should convert to false');
});

// ============================================================================
// ARRAY TRANSFORMATION TESTS
// ============================================================================

test('_transformArray - array to array (no change)', () => {
  const transformer = new ParameterTransformer();
  const itemSchema = { type: 'string' };
  const result = transformer._transformArray(['a', 'b', 'c'], itemSchema, 'test');
  assertDeepEqual(result, ['a', 'b', 'c'], 'Array should remain unchanged');
});

test('_transformArray - JSON string to array', () => {
  const transformer = new ParameterTransformer();
  const itemSchema = { type: 'string' };
  const result = transformer._transformArray('["a", "b", "c"]', itemSchema, 'test');
  assertDeepEqual(result, ['a', 'b', 'c'], 'JSON string should be parsed');
});

test('_transformArray - comma-separated string to array', () => {
  const transformer = new ParameterTransformer();
  const itemSchema = { type: 'string' };
  const result = transformer._transformArray('a,b,c', itemSchema, 'test');
  assertDeepEqual(result, ['a', 'b', 'c'], 'Comma-separated string should be split');
});

test('_transformArray - comma-separated string with spaces', () => {
  const transformer = new ParameterTransformer();
  const itemSchema = { type: 'string' };
  const result = transformer._transformArray('a, b, c', itemSchema, 'test');
  assertDeepEqual(result, ['a', 'b', 'c'], 'Spaces should be trimmed');
});

test('_transformArray - empty string to empty array', () => {
  const transformer = new ParameterTransformer();
  const itemSchema = { type: 'string' };
  const result = transformer._transformArray('', itemSchema, 'test');
  assertDeepEqual(result, [], 'Empty string should convert to empty array');
});

test('_transformArray - whitespace string to empty array', () => {
  const transformer = new ParameterTransformer();
  const itemSchema = { type: 'string' };
  const result = transformer._transformArray('   ', itemSchema, 'test');
  assertDeepEqual(result, [], 'Whitespace string should convert to empty array');
});

test('_transformArray - single value to array', () => {
  const transformer = new ParameterTransformer();
  const itemSchema = { type: 'string' };
  const result = transformer._transformArray('single', itemSchema, 'test');
  assertDeepEqual(result, ['single'], 'Single value should be wrapped in array');
});

test('_transformArray - array with type transformation', () => {
  const transformer = new ParameterTransformer();
  const itemSchema = { type: 'number' };
  const result = transformer._transformArray(['1', '2', '3'], itemSchema, 'test');
  assertDeepEqual(result, [1, 2, 3], 'Array items should be transformed');
});

// ============================================================================
// DATE TRANSFORMATION TESTS
// ============================================================================

test('_transformToDate - Date object to Date (no change)', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'date' };
  const date = new Date('2026-01-15T10:30:00Z');
  const result = transformer._transformToDate(date, schema, 'test');
  assertEqual(result.getTime(), date.getTime(), 'Date object should remain unchanged');
});

test('_transformToDate - milliseconds timestamp to Date', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'date' };
  const timestamp = 1705315800000;
  const result = transformer._transformToDate(timestamp, schema, 'test');
  assertEqual(result.getTime(), timestamp, 'Milliseconds timestamp should convert correctly');
});

test('_transformToDate - seconds timestamp to Date', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'date' };
  const timestamp = 1705315800;
  const result = transformer._transformToDate(timestamp, schema, 'test');
  assertEqual(result.getTime(), timestamp * 1000, 'Seconds timestamp should be multiplied by 1000');
});

test('_transformToDate - ISO string to Date', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'date' };
  const isoString = '2026-01-15T10:30:00Z';
  const result = transformer._transformToDate(isoString, schema, 'test');
  assertEqual(result.getTime(), new Date(isoString).getTime(), 'ISO string should convert to Date');
});

test('_transformToDate - YYYY-MM-DD format to Date', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'date' };
  const result = transformer._transformToDate('2026-01-15', schema, 'test');
  assertEqual(result.getFullYear(), 2026, 'Year should be 2026');
  assertEqual(result.getMonth(), 0, 'Month should be 0 (January)');
  assertEqual(result.getDate(), 15, 'Day should be 15');
});

test('_transformToDate - DD-MM-YYYY format to Date', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'date' };
  const result = transformer._transformToDate('15-01-2026', schema, 'test');
  assertEqual(result.getFullYear(), 2026, 'Year should be 2026');
  assertEqual(result.getMonth(), 0, 'Month should be 0 (January)');
  assertEqual(result.getDate(), 15, 'Day should be 15');
});

test('_transformToDate - YYYY/MM/DD format to Date', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'date' };
  const result = transformer._transformToDate('2026/01/15', schema, 'test');
  assertEqual(result.getFullYear(), 2026, 'Year should be 2026');
  assertEqual(result.getMonth(), 0, 'Month should be 0 (January)');
  assertEqual(result.getDate(), 15, 'Day should be 15');
});

test('_transformToDate - DD-MM-YY format to Date (20xx)', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'date' };
  const result = transformer._transformToDate('15-01-26', schema, 'test');
  assertEqual(result.getFullYear(), 2026, 'Year should be 2026');
  assertEqual(result.getMonth(), 0, 'Month should be 0 (January)');
  assertEqual(result.getDate(), 15, 'Day should be 15');
});

test('_transformToDate - DD-MM-YY format to Date (19xx)', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'date' };
  const result = transformer._transformToDate('15-01-85', schema, 'test');
  assertEqual(result.getFullYear(), 1985, 'Year should be 1985');
  assertEqual(result.getMonth(), 0, 'Month should be 0 (January)');
  assertEqual(result.getDate(), 15, 'Day should be 15');
});

test('_transformToDate - invalid date string', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'date' };
  const result = transformer._transformToDate('invalid-date', schema, 'test');
  assertEqual(isNaN(result.getTime()), true, 'Invalid date string should produce invalid Date');
});

// ============================================================================
// MAIN TRANSFORM METHOD TESTS
// ============================================================================

test('transform - with schema properties', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number' },
      active: { type: 'boolean' }
    }
  };
  const params = {
    name: 123,
    age: '25',
    active: 'yes'
  };
  const result = transformer.transform(schema, params);
  assertEqual(result.name, '123', 'Name should be converted to string');
  assertEqual(result.age, 25, 'Age should be converted to number');
  assertEqual(result.active, true, 'Active should be converted to boolean');
});

test('transform - strict mode returns parameters unchanged', () => {
  const transformer = new ParameterTransformer({ mode: TransformMode.STRICT });
  const schema = {
    type: 'object',
    properties: {
      age: { type: 'number' }
    }
  };
  const params = { age: '25' };
  const result = transformer.transform(schema, params);
  assertEqual(result.age, '25', 'Strict mode should not transform');
});

test('transform - null parameters', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'object', properties: {} };
  const result = transformer.transform(schema, null);
  assertEqual(result, null, 'Null parameters should return null');
});

test('transform - undefined parameters', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'object', properties: {} };
  const result = transformer.transform(schema, undefined);
  assertEqual(result, undefined, 'Undefined parameters should return undefined');
});

test('transform - no schema', () => {
  const transformer = new ParameterTransformer();
  const params = { a: 1, b: 2 };
  const result = transformer.transform(null, params);
  assertDeepEqual(result, params, 'No schema should return parameters unchanged');
});

test('transform - nested object transformation', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      user: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' }
        }
      }
    }
  };
  const params = {
    user: {
      name: 456,
      age: '30'
    }
  };
  const result = transformer.transform(schema, params);
  assertEqual(result.user.name, '456', 'Nested name should be converted to string');
  assertEqual(result.user.age, 30, 'Nested age should be converted to number');
});

test('transform - array of objects transformation', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            count: { type: 'number' }
          }
        }
      }
    }
  };
  const params = {
    items: [
      { name: 123, count: '5' },
      { name: 456, count: '10' }
    ]
  };
  const result = transformer.transform(schema, params);
  assertEqual(result.items[0].name, '123', 'First item name should be string');
  assertEqual(result.items[0].count, 5, 'First item count should be number');
  assertEqual(result.items[1].name, '456', 'Second item name should be string');
  assertEqual(result.items[1].count, 10, 'Second item count should be number');
});

test('transform - required field with default', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      timeout: { type: 'number', default: 30 }
    },
    required: ['timeout']
  };
  const params = {};
  const result = transformer.transform(schema, params);
  assertEqual(result.timeout, 30, 'Missing required field should use default');
});

// ============================================================================
// ENUM TESTS
// ============================================================================

test('transform - enum with matching value', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['active', 'inactive', 'pending'] }
    }
  };
  const params = { status: 'active' };
  const result = transformer.transform(schema, params);
  assertEqual(result.status, 'active', 'Matching enum value should pass through');
});

test('transform - enum with string coercion', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['active', 'inactive', 'pending'] }
    }
  };
  const params = { status: 123 };
  const result = transformer.transform(schema, params);
  assertEqual(result.status, 123, 'Non-matching enum value should pass through (will fail validation)');
});

test('transform - enum with numeric string coercion', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      level: { type: 'number', enum: [1, 2, 3] }
    }
  };
  const params = { level: '2' };
  const result = transformer.transform(schema, params);
  assertEqual(result.level, 2, 'String number should be coerced for enum');
});

// ============================================================================
// TYPE UNION TESTS (oneOf/anyOf)
// ============================================================================

test('transform - oneOf with direct match', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      value: {
        oneOf: [
          { type: 'string' },
          { type: 'number' }
        ]
      }
    }
  };
  const params = { value: 'hello' };
  const result = transformer.transform(schema, params);
  assertEqual(result.value, 'hello', 'Direct string match should pass through');
});

test('transform - oneOf with number preference for numeric string', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      value: {
        oneOf: [
          { type: 'number' },
          { type: 'string' }
        ]
      }
    }
  };
  const params = { value: '42' };
  const result = transformer.transform(schema, params);
  assertEqual(result.value, 42, 'Numeric string should be coerced to number in union');
});

test('transform - oneOf with transformation', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      value: {
        oneOf: [
          { type: 'number' },
          { type: 'string' }
        ]
      }
    }
  };
  const params = { value: '25.5' };
  const result = transformer.transform(schema, params);
  assertEqual(result.value, 25.5, 'Should coerce to number type');
});

test('transform - anyOf behavior same as oneOf', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      value: {
        anyOf: [
          { type: 'boolean' },
          { type: 'string' }
        ]
      }
    }
  };
  const params = { value: 'true' };
  const result = transformer.transform(schema, params);
  assertEqual(result.value, true, 'anyOf should behave like oneOf');
});

// ============================================================================
// TRANSFORM WITH RULES TESTS
// ============================================================================

test('transformWithRules - mode override', () => {
  const transformer = new ParameterTransformer({ mode: TransformMode.COERCE });
  const schema = {
    type: 'object',
    properties: {
      age: { type: 'number' }
    }
  };
  const params = { age: '25' };
  const rules = { mode: TransformMode.STRICT };
  const result = transformer.transformWithRules(schema, params, rules);
  assertEqual(result.age, '25', 'Rule should override instance mode');
});

test('transformWithRules - field-specific trim', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' }
    }
  };
  const params = { name: '  hello  ' };
  const rules = {
    fields: {
      name: { trim: true }
    }
  };
  const result = transformer.transformWithRules(schema, params, rules);
  assertEqual(result.name, 'hello', 'Field should be trimmed');
});

test('transformWithRules - field-specific lowercase', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      email: { type: 'string' }
    }
  };
  const params = { email: 'USER@EXAMPLE.COM' };
  const rules = {
    fields: {
      email: { lowercase: true }
    }
  };
  const result = transformer.transformWithRules(schema, params, rules);
  assertEqual(result.email, 'user@example.com', 'Field should be lowercased');
});

test('transformWithRules - field-specific uppercase', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      code: { type: 'string' }
    }
  };
  const params = { code: 'abc' };
  const rules = {
    fields: {
      code: { uppercase: true }
    }
  };
  const result = transformer.transformWithRules(schema, params, rules);
  assertEqual(result.code, 'ABC', 'Field should be uppercased');
});

test('transformWithRules - field-specific prefix', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'string' }
    }
  };
  const params = { id: '123' };
  const rules = {
    fields: {
      id: { prefix: 'user-' }
    }
  };
  const result = transformer.transformWithRules(schema, params, rules);
  assertEqual(result.id, 'user-123', 'Field should have prefix added');
});

test('transformWithRules - field-specific suffix', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' }
    }
  };
  const params = { name: 'test' };
  const rules = {
    fields: {
      name: { suffix: '-v1' }
    }
  };
  const result = transformer.transformWithRules(schema, params, rules);
  assertEqual(result.name, 'test-v1', 'Field should have suffix added');
});

test('transformWithRules - field-specific map', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      status: { type: 'string' }
    }
  };
  const params = { status: '1' };
  const rules = {
    fields: {
      status: { map: { '1': 'active', '0': 'inactive' } }
    }
  };
  const result = transformer.transformWithRules(schema, params, rules);
  assertEqual(result.status, 'active', 'Field should be mapped');
});

test('transformWithRules - field-specific multiply', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      price: { type: 'number' }
    }
  };
  const params = { price: 100 };
  const rules = {
    fields: {
      price: { multiply: 1.1 }
    }
  };
  const result = transformer.transformWithRules(schema, params, rules);
  // Use tolerance for floating point comparison
  const diff = Math.abs(result.price - 110);
  assertEqual(diff < 0.0001, true, `Field should be multiplied (got ${result.price}, expected 110)`);
});

test('transformWithRules - field-specific add', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      offset: { type: 'number' }
    }
  };
  const params = { offset: 10 };
  const rules = {
    fields: {
      offset: { add: 5 }
    }
  };
  const result = transformer.transformWithRules(schema, params, rules);
  assertEqual(result.offset, 15, 'Field should have value added');
});

test('transformWithRules - default value for missing field', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      timeout: { type: 'number' }
    }
  };
  const params = {};
  const rules = {
    fields: {
      timeout: { default: 30 }
    }
  };
  const result = transformer.transformWithRules(schema, params, rules);
  assertEqual(result.timeout, 30, 'Default should be applied for missing field');
});

test('transformWithRules - restores original settings', () => {
  const transformer = new ParameterTransformer({ mode: TransformMode.COERCE, strictNumbers: false });
  const schema = { type: 'object', properties: {} };
  const params = {};
  const rules = { mode: TransformMode.STRICT, strictNumbers: true };
  transformer.transformWithRules(schema, params, rules);
  assertEqual(transformer.mode, TransformMode.COERCE, 'Mode should be restored');
  assertEqual(transformer.strictNumbers, false, 'StrictNumbers should be restored');
});

// ============================================================================
// TRANSFORMATION INFO TESTS
// ============================================================================

test('getTransformationInfo - tracks changes', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      age: { type: 'number' },
      name: { type: 'string' }
    }
  };
  const original = { age: '25', name: 123, unchanged: 'value' };
  const transformed = transformer.transform(schema, original);
  const info = transformer.getTransformationInfo(schema, original, transformed);
  
  assertEqual(info.mode, TransformMode.COERCE, 'Should track mode');
  assertEqual(info.changeCount, 2, 'Should track 2 changes');
  assertEqual(info.changes[0].field, 'age', 'Should track age change');
  assertEqual(info.changes[0].original, '25', 'Should track original age');
  assertEqual(info.changes[0].transformed, 25, 'Should track transformed age');
  assertEqual(info.changes[1].field, 'name', 'Should track name change');
});

test('getTransformationInfo - no changes', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' }
    }
  };
  const original = { name: 'hello' };
  const transformed = transformer.transform(schema, original);
  const info = transformer.getTransformationInfo(schema, original, transformed);
  
  assertEqual(info.changeCount, 0, 'Should report no changes');
  assertDeepEqual(info.changes, [], 'Changes should be empty');
});

test('getTransformationInfo - handles null inputs', () => {
  const transformer = new ParameterTransformer();
  const info = transformer.getTransformationInfo(null, null, null);
  assertEqual(info.mode, TransformMode.COERCE, 'Should handle null schema');
  assertEqual(info.changeCount, 0, 'Should handle null params');
});

// ============================================================================
// EDGE CASES
// ============================================================================

test('transform - handles null values', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      value: { type: 'string' }
    }
  };
  const params = { value: null };
  const result = transformer.transform(schema, params);
  assertEqual(result.value, null, 'Null value should be preserved');
});

test('transform - handles undefined values', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      value: { type: 'string' }
    }
  };
  const params = { value: undefined };
  const result = transformer.transform(schema, params);
  assertEqual(result.value, undefined, 'Undefined value should be preserved');
});

test('transform - passes through fields not in schema', () => {
  const transformer = new ParameterTransformer();
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' }
    }
  };
  const params = { name: 'test', extra: 'value' };
  const result = transformer.transform(schema, params);
  assertEqual(result.extra, 'value', 'Extra field should pass through');
});

test('transform - empty schema properties', () => {
  const transformer = new ParameterTransformer();
  const schema = { type: 'object', properties: {} };
  const params = { a: 1, b: 2 };
  const result = transformer.transform(schema, params);
  assertDeepEqual(result, params, 'Empty schema should pass through params');
});

test('_transformValue - handles empty schema', () => {
  const transformer = new ParameterTransformer();
  const result = transformer._transformValue('test', {}, 'path');
  assertEqual(result, 'test', 'Empty schema should return value unchanged');
});

test('_tryTypeUnions - handles empty alternatives', () => {
  const transformer = new ParameterTransformer();
  const schema = { oneOf: [] };
  const result = transformer._tryTypeUnions('test', schema, 'path');
  assertEqual(result, 'test', 'Empty alternatives should return value unchanged');
});

test('_matchesType - handles various types', () => {
  const transformer = new ParameterTransformer();
  assertEqual(transformer._matchesType('hello', { type: 'string' }), true, 'Should match string');
  assertEqual(transformer._matchesType(42, { type: 'number' }), true, 'Should match number');
  assertEqual(transformer._matchesType(true, { type: 'boolean' }), true, 'Should match boolean');
  assertEqual(transformer._matchesType([1, 2], { type: 'array' }), true, 'Should match array');
  assertEqual(transformer._matchesType({ a: 1 }, { type: 'object' }), true, 'Should match object');
  assertEqual(transformer._matchesType(null, { type: 'null' }), true, 'Should match null');
  assertEqual(transformer._matchesType(null, { nullable: true }), true, 'Should match nullable');
  assertEqual(transformer._matchesType(NaN, { type: 'number' }), false, 'Should not match NaN');
});

test('_parseCustomDate - handles DD-MM-YY format', () => {
  const transformer = new ParameterTransformer();
  const match = '26-01-15'.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  const result = transformer._parseCustomDate(match);
  // Note: 2-2-2 format is treated as DD-MM-YY, not YY-MM-DD
  // '26-01-15' is parsed as day=26, month=0, year=2015
  assertEqual(result.getFullYear(), 2015, 'Year should be 2015');
  assertEqual(result.getMonth(), 0, 'Month should be 0 (January)');
  assertEqual(result.getDate(), 26, 'Day should be 26');
});

test('_applyFieldRules - handles multiple rules', () => {
  const transformer = new ParameterTransformer();
  const rules = {
    trim: true,
    lowercase: true,
    prefix: 'test-',
    suffix: '-end'
  };
  const result = transformer._applyFieldRules('  HELLO  ', rules, 'field');
  assertEqual(result, 'test-hello-end', 'All rules should be applied in order');
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log(`\n${'='.repeat(70)}`);
console.log(`ParameterTransformer Unit Tests: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(70)}\n`);

process.exit(failed > 0 ? 1 : 0);
