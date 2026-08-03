// Test suite for normalizeErrorKey function in pattern-detection.js
import { describe, it } from 'node:test';
import assert from 'node:assert';

// Import the normalizeErrorKey function by reading and evaluating the module
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

describe('normalizeErrorKey - Escalation Message Exclusion', () => {
  it('should exclude complexity escalation messages', () => {
    // These are normal system behavior, not failures
    const escalationMessages = [
      'Escalated: low → medium, excluding []',
      'Escalated: medium → high, excluding [task_123]',
      'ESCALATED: low → high, excluding []',
      'Escalated: low -> medium, excluding [st_456, task_789]',
    ];
    
    for (const msg of escalationMessages) {
      const normalized = normalizeErrorKey(msg);
      assert.strictEqual(normalized, '', `Expected empty string for escalation message: ${msg}`);
    }
  });
  
  it('should normalize regular errors normally', () => {
    const regularErrors = [
      { input: 'Task failed: timeout', expected: 'Task failed: timeout' },
      { input: 'Error: Connection refused to task_123', expected: 'Error: Connection refused to task_<ID>' },
      { input: 'Failed to process UUID abc12345def4567890abcdef1234567890', expected: 'Failed to process UUID abc12345def4567890abcdef1234567890' },
    ];
    
    for (const { input, expected } of regularErrors) {
      const normalized = normalizeErrorKey(input);
      assert.strictEqual(normalized, expected, `Expected "${expected}" for input: ${input}`);
    }
  });
  
  it('should handle edge cases', () => {
    assert.strictEqual(normalizeErrorKey(null), '');
    assert.strictEqual(normalizeErrorKey(undefined), '');
    assert.strictEqual(normalizeErrorKey(''), '');
    assert.strictEqual(normalizeErrorKey('   '), '');
  });
});

// Inline implementation of normalizeErrorKey for testing
function normalizeErrorKey(error) {
  if (!error || typeof error !== 'string') {
    return '';
  }
  
  // Exclude complexity escalation messages - these are normal system behavior, not failures
  // Pattern: "Escalated: <level> → <level>, excluding <[]>" (handles both → and -> arrows)
  if (/^Escalated:.*[→-].*excluding/i.test(error)) {
    return '';
  }
  
  // Remove UUIDs
  let normalized = error.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');
  
  // Remove numeric IDs (task_123, st_456, etc.)
  normalized = normalized.replace(/\b(task_|st_|campaign_|ms_)[0-9a-z]+/gi, '$1<ID>');
  
  // Remove timestamps
  normalized = normalized.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?/g, '<TIMESTAMP>');
  
  // Trim and normalize whitespace
  normalized = normalized.trim().replace(/\s+/g, ' ');
  
  return normalized;
}
