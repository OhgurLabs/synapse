// Unit test for circuit breaker override validation in src/config.js
// Tests the startup validation that ensures override keys match known providers
// and values are within acceptable bounds.

import { spawnSync } from 'child_process';

// Custom test harness (matches existing test patterns in the codebase)
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// Helper to run config module with ENV vars and capture output
function runConfigWithEnv(env = {}) {
  const result = spawnSync('node', [
    '-e',
    "import('./src/config.js').then(() => console.log('OK')).catch(e => { console.error(e.message); process.exit(1); })"
  ], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    cwd: process.cwd(),
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

// Test 1: No overrides configured
test('No overrides - logs default message', () => {
  const result = runConfigWithEnv();
  assert(result.exitCode === 0, 'Should exit successfully');
  assert(result.stdout.includes('No circuit breaker provider overrides configured'), 'Should log default message');
});

// Test 2: Valid overrides for multiple providers
test('Valid overrides - logs configured providers', () => {
  const result = runConfigWithEnv({
    SYNAPSE_CB_FAILURE_THRESHOLD_CLAUDE: '5',
    SYNAPSE_CB_COOLDOWN_MS_CODEX: '30000',
    SYNAPSE_CB_MAX_FAILURE_AGE_MS_GEMINI: '120000',
  });
  assert(result.exitCode === 0, 'Should exit successfully');
  assert(result.stdout.includes('Circuit breaker provider overrides:'), 'Should log overrides header');
  assert(result.stdout.includes('claude: failureThreshold=5'), 'Should log claude override');
  assert(result.stdout.includes('codex: cooldownMs=30000'), 'Should log codex override');
  assert(result.stdout.includes('gemini: maxFailureAgeMs=120000'), 'Should log gemini override');
});

// Test 3: Out-of-bounds values are clamped
test('Out-of-bounds values - clamped to valid range', () => {
  const result = runConfigWithEnv({
    SYNAPSE_CB_FAILURE_THRESHOLD_CLAUDE: '150',  // max is 100
    SYNAPSE_CB_COOLDOWN_MS_CODEX: '500',         // min is 1000
    SYNAPSE_CB_MAX_FAILURE_AGE_MS_GEMINI: '30000', // min is 60000
  });
  assert(result.exitCode === 0, 'Should exit successfully');
  assert(result.stdout.includes('failureThreshold=100'), 'Should clamp to max 100');
  assert(result.stdout.includes('cooldownMs=1000'), 'Should clamp to min 1000');
  assert(result.stdout.includes('maxFailureAgeMs=60000'), 'Should clamp to min 60000');
});

// Test 4: Multiple overrides for single provider
test('Multiple overrides for single provider - all logged', () => {
  const result = runConfigWithEnv({
    SYNAPSE_CB_FAILURE_THRESHOLD_OLLAMA: '10',
    SYNAPSE_CB_COOLDOWN_MS_OLLAMA: '120000',
    SYNAPSE_CB_MAX_FAILURE_AGE_MS_OLLAMA: '7200000',
  });
  assert(result.exitCode === 0, 'Should exit successfully');
  assert(result.stdout.includes('ollama: failureThreshold=10, cooldownMs=120000, maxFailureAgeMs=7200000'), 'Should log all overrides');
});

// Test 5: Invalid ENV values (non-numeric) are ignored
test('Invalid ENV values - ignored and not logged', () => {
  const result = runConfigWithEnv({
    SYNAPSE_CB_FAILURE_THRESHOLD_CLAUDE: 'invalid',
  });
  assert(result.exitCode === 0, 'Should exit successfully');
  assert(result.stdout.includes('No circuit breaker provider overrides configured'), 'Should ignore invalid values');
});

console.log('\n✓ All circuit breaker override validation tests passed\n');
