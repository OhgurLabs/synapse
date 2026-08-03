/**
 * Unit tests for prometheus-registry.js
 *
 * Verifies that renderMetrics() produces valid Prometheus exposition format
 * with all six required metric families.
 */

import { renderMetrics } from '../../src/orchestrator/prometheus-registry.js';
import { strict as assert } from 'assert';

/**
 * Test helper: Parse Prometheus text format and extract metrics
 * @param {string} text - Prometheus text format
 * @returns {Object} Parsed metrics by name
 */
function parsePrometheusText(text) {
  const lines = text.split('\n');
  const metrics = {};
  let currentMetric = null;

  for (const line of lines) {
    if (!line || line.startsWith('#')) {
      // Parse HELP and TYPE comments
      const helpMatch = line.match(/^# HELP (\S+) (.+)$/);
      const typeMatch = line.match(/^# TYPE (\S+) (\S+)$/);

      if (helpMatch) {
        const [, name, help] = helpMatch;
        if (!metrics[name]) metrics[name] = {};
        metrics[name].help = help;
      } else if (typeMatch) {
        const [, name, type] = typeMatch;
        if (!metrics[name]) metrics[name] = {};
        metrics[name].type = type;
        currentMetric = name;
      }
      continue;
    }

    // Parse metric line
    const metricMatch = line.match(/^(\S+?)(?:\{([^}]+)\})?\s+(\S+)$/);
    if (metricMatch) {
      const [, name, labels, value] = metricMatch;

      // Find base metric name (strip _bucket, _sum, _count suffixes)
      const baseName = name.replace(/_bucket$|_sum$|_count$/, '');

      if (!metrics[baseName]) metrics[baseName] = {};
      if (!metrics[baseName].samples) metrics[baseName].samples = [];

      metrics[baseName].samples.push({
        name,
        labels: labels || '',
        value: parseFloat(value),
      });
    }
  }

  return metrics;
}

// ===== Test: renderMetrics with no collectors =====
console.log('Test: renderMetrics() with no collectors');
const emptyOutput = renderMetrics();
assert(typeof emptyOutput === 'string', 'Output should be a string');
assert(emptyOutput.length > 0, 'Output should not be empty');

const emptyMetrics = parsePrometheusText(emptyOutput);

// Verify all six metric families are present
assert(emptyMetrics.dispatch_duration_seconds, 'dispatch_duration_seconds metric missing');
assert(emptyMetrics.circuit_breaker_state, 'circuit_breaker_state metric missing');
assert(emptyMetrics.handoff_total, 'handoff_total metric missing');
assert(emptyMetrics.deliberation_total, 'deliberation_total metric missing');
assert(emptyMetrics.alert_firing, 'alert_firing metric missing');
assert(emptyMetrics.agent_health_status, 'agent_health_status metric missing');

// Verify metric types
assert.strictEqual(emptyMetrics.dispatch_duration_seconds.type, 'histogram', 'dispatch_duration_seconds should be histogram');
assert.strictEqual(emptyMetrics.circuit_breaker_state.type, 'gauge', 'circuit_breaker_state should be gauge');
assert.strictEqual(emptyMetrics.handoff_total.type, 'counter', 'handoff_total should be counter');
assert.strictEqual(emptyMetrics.deliberation_total.type, 'counter', 'deliberation_total should be counter');
assert.strictEqual(emptyMetrics.alert_firing.type, 'gauge', 'alert_firing should be gauge');
assert.strictEqual(emptyMetrics.agent_health_status.type, 'gauge', 'agent_health_status should be gauge');

// Verify histogram structure (should have buckets, sum, count)
const histogramSamples = emptyMetrics.dispatch_duration_seconds.samples;
assert(histogramSamples.some(s => s.name.endsWith('_bucket')), 'Histogram should have buckets');
assert(histogramSamples.some(s => s.name.endsWith('_sum')), 'Histogram should have _sum');
assert(histogramSamples.some(s => s.name.endsWith('_count')), 'Histogram should have _count');
assert(histogramSamples.some(s => s.labels.includes('le="+Inf"')), 'Histogram should have +Inf bucket');

console.log('✓ renderMetrics() with no collectors produces valid format');

// ===== Test: renderMetrics with mock collectors =====
console.log('\nTest: renderMetrics() with mock collectors');

const mockCollectors = {
  dispatchDuration: {
    byLabels: [
      {
        labels: { agent: 'lola', category: 'code' },
        buckets: { 0.1: 10, 0.5: 25, 1: 40, 5: 50, 10: 55, 30: 58, 60: 60 },
        sum: 125.5,
        count: 60,
      },
      {
        labels: { agent: 'loco', category: 'review' },
        buckets: { 0.1: 5, 0.5: 15, 1: 25, 5: 30, 10: 32, 30: 33, 60: 35 },
        sum: 88.2,
        count: 35,
      },
    ],
  },
  circuitBreakerState: {
    'claude-api': 'closed',
    'ollama-backend': 'half_open',
    'gemini-api': 'open',
  },
  handoffTotal: {
    success: 150,
    failure: 12,
    timeout: 3,
  },
  deliberationTotal: {
    consensus: 45,
    timeout: 5,
    failure: 2,
  },
  alertFiring: {
    critical: true,
    warning: false,
    info: false,
  },
  agentHealthStatus: {
    lola: true,
    loco: false,
    kit: true,
  },
};

const populatedOutput = renderMetrics(mockCollectors);
assert(typeof populatedOutput === 'string', 'Output should be a string');
assert(populatedOutput.length > 0, 'Output should not be empty');

const populatedMetrics = parsePrometheusText(populatedOutput);

// Verify dispatch histogram has data for both agents
const dispatchSamples = populatedMetrics.dispatch_duration_seconds.samples;
assert(dispatchSamples.some(s => s.labels.includes('agent="lola"')), 'Should have lola agent data');
assert(dispatchSamples.some(s => s.labels.includes('agent="loco"')), 'Should have loco agent data');

// Verify circuit breaker states
const cbSamples = populatedMetrics.circuit_breaker_state.samples;
assert(cbSamples.some(s => s.labels.includes('service="claude-api"') && s.value === 0), 'claude-api should be closed (0)');
assert(cbSamples.some(s => s.labels.includes('service="ollama-backend"') && s.value === 1), 'ollama-backend should be half_open (1)');
assert(cbSamples.some(s => s.labels.includes('service="gemini-api"') && s.value === 2), 'gemini-api should be open (2)');

// Verify handoff counters
const handoffSamples = populatedMetrics.handoff_total.samples;
assert(handoffSamples.some(s => s.labels.includes('status="success"') && s.value === 150), 'Should have 150 successful handoffs');
assert(handoffSamples.some(s => s.labels.includes('status="failure"') && s.value === 12), 'Should have 12 failed handoffs');

// Verify deliberation counters
const deliberationSamples = populatedMetrics.deliberation_total.samples;
assert(deliberationSamples.some(s => s.labels.includes('outcome="consensus"') && s.value === 45), 'Should have 45 consensus outcomes');
assert(deliberationSamples.some(s => s.labels.includes('outcome="timeout"') && s.value === 5), 'Should have 5 timeout outcomes');

// Verify alert gauges
const alertSamples = populatedMetrics.alert_firing.samples;
assert(alertSamples.some(s => s.labels.includes('severity="critical"') && s.value === 1), 'Critical alert should be firing');
assert(alertSamples.some(s => s.labels.includes('severity="warning"') && s.value === 0), 'Warning alert should not be firing');

// Verify agent health gauges
const healthSamples = populatedMetrics.agent_health_status.samples;
assert(healthSamples.some(s => s.labels.includes('agent="lola"') && s.value === 1), 'lola should be healthy');
assert(healthSamples.some(s => s.labels.includes('agent="loco"') && s.value === 0), 'loco should be unhealthy');
assert(healthSamples.some(s => s.labels.includes('agent="kit"') && s.value === 1), 'kit should be healthy');

console.log('✓ renderMetrics() with mock collectors produces correct data');

// ===== Test: Valid Prometheus format =====
console.log('\nTest: Output is valid Prometheus format');

// Check format compliance
assert(populatedOutput.includes('# HELP'), 'Should contain HELP comments');
assert(populatedOutput.includes('# TYPE'), 'Should contain TYPE comments');
assert(!populatedOutput.includes('undefined'), 'Should not contain undefined values');
assert(!populatedOutput.includes('NaN'), 'Should not contain NaN values');

// Check that all lines are valid (either comments, empty, or metric lines)
const outputLines = populatedOutput.split('\n');
for (const line of outputLines) {
  if (!line || line.startsWith('#')) continue;

  // Metric lines must match pattern: metric_name{labels} value
  const isValid = /^[a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?\s+[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(line);
  assert(isValid, `Invalid metric line: ${line}`);
}

console.log('✓ Output is valid Prometheus exposition format');

// ===== Test: Label escaping =====
console.log('\nTest: Label escaping');

const escapingCollectors = {
  agentHealthStatus: {
    'agent"with"quotes': true,
    'agent\\with\\backslash': true,
    'agent\nwith\nnewline': true,
  },
};

const escapedOutput = renderMetrics(escapingCollectors);
assert(escapedOutput.includes('\\"'), 'Should escape double quotes');
assert(escapedOutput.includes('\\\\'), 'Should escape backslashes');
assert(escapedOutput.includes('\\n'), 'Should escape newlines');
assert(!escapedOutput.includes('agent"with"quotes'), 'Should not have unescaped quotes');

console.log('✓ Label escaping works correctly');

// ===== Test: Content-Type compatibility =====
console.log('\nTest: Content-Type compatibility');

// The output should be compatible with Prometheus text format version 0.0.4
// Content-Type: text/plain; version=0.0.4; charset=utf-8

// Test that output is plain text (no binary data)
assert(Buffer.from(populatedOutput, 'utf-8').toString('utf-8') === populatedOutput, 'Output should be valid UTF-8');

console.log('✓ Output is compatible with Prometheus text format version 0.0.4');

console.log('\n✅ All prometheus-registry tests passed');
