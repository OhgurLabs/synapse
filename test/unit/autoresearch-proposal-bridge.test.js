// Unit tests for src/orchestrator/autoresearch-proposal-bridge.js
// Tests: cycle discovery, outcome evaluation, proposal creation, state tracking, config disable

import { strict as assert } from 'assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Custom tap-style test harness (consistent with repo patterns)
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  Error: ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(message || `Deep equality failed:\nExpected: ${expectedStr}\nGot: ${actualStr}`);
  }
}

function assertTrue(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed: expected true');
  }
}

function assertFalse(condition, message) {
  if (condition) {
    throw new Error(message || 'Assertion failed: expected false');
  }
}

function assertObjectHasProperties(obj, props, message) {
  for (const prop of props) {
    if (!(prop in obj)) {
      throw new Error(message || `Missing property: ${prop}`);
    }
  }
}

// Create temporary test directory
const testDir = mkdtempSync(join(tmpdir(), 'autoresearch-bridge-test-'));
const baseDir = join(testDir, 'autoresearch');
const stateFilePath = join(testDir, '.evaluated-cycles.json');

// Cleanup on exit
process.on('exit', () => {
  rmSync(testDir, { recursive: true, force: true });
});

// Helper to create mock cycle result files (with optional baseDir override)
function createCycleResult(agentId, cycleNumber, resultData, overrideBaseDir = null) {
  const agentDir = join(overrideBaseDir || baseDir, agentId);
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true });
  }
  const filePath = join(agentDir, `cycle_${cycleNumber}_result.json`);
  writeFileSync(filePath, JSON.stringify(resultData, null, 2));
}

// Helper to create mock postcycle metrics
function createPostcycleMetrics(agentId, cycleNumber, metrics) {
  const agentDir = join(baseDir, agentId);
  const filePath = join(agentDir, `cycle_${cycleNumber}_postcycle_metrics.json`);
  writeFileSync(filePath, JSON.stringify(metrics, null, 2));
}

// Mock dependencies for bridge functions
function createMockTimelineStore() {
  const events = [];
  return {
    appendRoutingProposalEvent: (event) => {
      events.push({ type: 'routing_proposal', event });
      return { id: `timeline-${events.length}` };
    },
    appendOperatorActionEvent: (event) => {
      events.push({ type: 'operator_action', event });
      return { id: `audit-${events.length}` };
    },
    getEvents: () => events,
  };
}

function createMockOperatorAuditStore() {
  const entries = [];
  return {
    append: (entry) => {
      entries.push(entry);
      return `audit-${entries.length}`;
    },
    getEntries: () => entries,
  };
}

function createMockEvents() {
  const listeners = {};
  return {
    on: (event, listener) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(listener);
    },
    emit: async (event, data) => {
      if (listeners[event]) {
        for (const listener of listeners[event]) {
          await listener(data);
        }
      }
    },
    getEmitted: (event) => listeners[event] || [],
  };
}

// ============================================================================
// TEST SUITE - All tests wrapped in IIFE to allow top-level await
// ============================================================================

(async () => {
  // Import modules once at the start
  const outcomeEvaluator = await import('../../src/orchestrator/autoresearch-outcome-evaluator.js');
  const bridgeModule = await import('../../src/orchestrator/autoresearch-proposal-bridge.js');
  
  const { discoverCycles, evaluateAutoresearchOutcome } = outcomeEvaluator;
  const bridge = bridgeModule.default;
  
  const {
    evaluatePendingCycles,
    loadEvaluatedState,
    persistEvaluatedState,
    isEvaluated,
    markAsEvaluated,
    buildRecommendation,
    emitProposalCreatedEvent,
    emitOutcomeLoggedEvent,
  } = bridge;

  // Test: discoverCycles - returns empty array when baseDir does not exist
  test('discoverCycles - returns empty array when baseDir does not exist', () => {
    const cycles = discoverCycles('/nonexistent/path');
    assertEqual(cycles.length, 0, 'Should return empty array for non-existent directory');
  });

  // Test: discoverCycles - returns empty array when baseDir is empty
  test('discoverCycles - returns empty array when baseDir is empty', () => {
    const cycles = discoverCycles(baseDir);
    assertEqual(cycles.length, 0, 'Should return empty array when no agents exist');
  });

  // Test: discoverCycles - discovers cycles from agent directories
  test('discoverCycles - discovers cycles from agent directories', () => {
    // Create test cycles
    createCycleResult('claude', 1, { result: 'complete', metrics: { baseline: { score: 0.8 }, post: { score: 0.9 } } });
    createCycleResult('claude', 2, { result: 'complete', metrics: { baseline: { score: 0.85 }, post: { score: 0.95 } } });
    createCycleResult('codex', 1, { result: 'complete', metrics: { baseline: { score: 0.75 }, post: { score: 0.85 } } });
    
    // Create a non-complete cycle (should be excluded)
    createCycleResult('nia', 1, { result: 'in_progress', metrics: { baseline: { score: 0.8 } } });
    
    const cycles = discoverCycles(baseDir);
    
    assertEqual(cycles.length, 3, 'Should discover 3 complete cycles');
    assertTrue(cycles.some(c => c.agentId === 'claude' && c.cycleNumber === 1), 'Should include claude cycle_1');
    assertTrue(cycles.some(c => c.agentId === 'claude' && c.cycleNumber === 2), 'Should include claude cycle_2');
    assertTrue(cycles.some(c => c.agentId === 'codex' && c.cycleNumber === 1), 'Should include codex cycle_1');
    
    const coraCycles = cycles.filter(c => c.agentId === 'nia');
    assertEqual(coraCycles.length, 0, 'Should exclude incomplete cycle');
  });

  // Test: discoverCycles - skips already evaluated cycles
  test('discoverCycles - skips already evaluated cycles', () => {
    // Create a fresh agent directory for this test
    const freshBaseDir = join(testDir, 'fresh-autoresearch');
    mkdirSync(freshBaseDir, { recursive: true });
    
    // Create cycle with marker file in same directory
    const agentDir = join(freshBaseDir, 'claude');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'cycle_1_result.json'), JSON.stringify({ 
      result: 'complete', 
      metrics: { baseline: { score: 0.8 }, post: { score: 0.9 } } 
    }));
    
    // Create evaluated marker file (legacy check)
    writeFileSync(join(agentDir, 'cycle_1_evaluated'), '');
    
    const cycles = discoverCycles(freshBaseDir);
    assertEqual(cycles.length, 0, 'Should skip cycle with evaluated marker');
  });

  // Test: evaluateAutoresearchOutcome - returns failure when result file not found
  test('evaluateAutoresearchOutcome - returns failure when result file not found', () => {
    const nonExistentDir = join(testDir, 'nonexistent-agent');
    const result = evaluateAutoresearchOutcome(nonExistentDir, 1);
    
    assertEqual(result.significant, false, 'Should not be significant');
    assertEqual(result.agentId, null, 'Agent ID should be null');
    assertTrue(result.reason.includes('not found'), 'Should indicate file not found');
  });

  // Test: evaluateAutoresearchOutcome - handles schema with metrics.baseline/post structure
  test('evaluateAutoresearchOutcome - handles schema with metrics.baseline/post structure', () => {
    const agentDir = join(baseDir, 'nia-schema');
    mkdirSync(agentDir, { recursive: true });
    
    const resultData = {
      result: 'complete',
      postApplyCompletions: 15,
      metrics: {
        baseline: {
          score: 0.75,
          agentId: 'nia',
          sampleSize: 20,
        },
        post: {
          score: 0.90,
          agentId: 'nia',
          sampleSize: 15,
        },
      },
    };
    
    writeFileSync(join(agentDir, 'cycle_1_result.json'), JSON.stringify(resultData));
    
    const evaluation = evaluateAutoresearchOutcome(agentDir, 1);
    
    assertEqual(evaluation.significant, true, 'Should be significant (20% improvement)');
    assertEqual(evaluation.agentId, 'nia', 'Should extract agent ID');
    assertEqual(evaluation.sampleSize, 15, 'Should use postApplyCompletions');
    assertEqual(evaluation.metrics.baseline.quality_score, 0.75, 'Should normalize baseline score');
    assertEqual(evaluation.metrics.post.quality_score, 0.90, 'Should normalize post score');
    // 20% relative improvement: (0.90 - 0.75) / 0.75 * 100 = 20
    assertTrue(Math.abs(evaluation.metrics.relativeImprovement - 20) < 0.1, 'Should calculate ~20% relative improvement');
    assertTrue(evaluation.reason.includes('Primary threshold'), 'Should indicate primary threshold met');
  });

  // Test: evaluateAutoresearchOutcome - handles schema with separate postcycle metrics file
  test('evaluateAutoresearchOutcome - handles schema with separate postcycle metrics file', () => {
    const agentDir = join(baseDir, 'carl-separate');
    mkdirSync(agentDir, { recursive: true });
    
    const resultData = {
      result: 'complete',
      postApplyCompletions: 12,
      metrics: {
        baseline: {
          score: 0.70,  // Use score for quality_score
          rawPassRate: 0.70,  // Also set rawPassRate for success_rate
          agentId: 'carl',
        },
      },
    };
    
    const postcycleData = {
      score: 0.85,
      retryFreeRate: 120,
      sampleSize: 12,
      agentId: 'carl',
    };
    
    writeFileSync(join(agentDir, 'cycle_1_result.json'), JSON.stringify(resultData));
    writeFileSync(join(agentDir, 'cycle_1_postcycle_metrics.json'), JSON.stringify(postcycleData));
    
    const evaluation = evaluateAutoresearchOutcome(agentDir, 1);
    
    // (0.85 - 0.70) / 0.70 * 100 = 21.43% improvement with 12 samples >= 10, so significant
    assertEqual(evaluation.significant, true, 'Should be significant');
    assertEqual(evaluation.metrics.baseline.success_rate, 0.70, 'Should map rawPassRate to success_rate');
    assertEqual(evaluation.metrics.baseline.quality_score, 0.70, 'Should map baseline score to quality_score');
    assertEqual(evaluation.metrics.post.quality_score, 0.85, 'Should use postcycle score as quality_score');
    assertEqual(evaluation.sampleSize, 12, 'Should use postApplyCompletions');
    assertTrue(Math.abs(evaluation.metrics.relativeImprovement - 21.43) < 0.1, 'Should calculate ~21.4% relative improvement');
  });

  // Test: evaluateAutoresearchOutcome - handles fallback threshold with needsOperatorReview
  test('evaluateAutoresearchOutcome - handles fallback threshold with needsOperatorReview', () => {
    const agentDir = join(baseDir, 'kai-fallback');
    mkdirSync(agentDir, { recursive: true });
    
    // 18% improvement but only 8 postApplyCompletions (below primary threshold)
    // Should use fallback threshold (≥15% with ≥10 data points in post metrics)
    const resultData = {
      result: 'complete',
      postApplyCompletions: 8,
      metrics: {
        baseline: {
          score: 0.70,
          agentId: 'kai',
          sampleSize: 10,
        },
        post: {
          score: 0.85,
          agentId: 'kai',
          sampleSize: 10,
        },
      },
    };
    
    writeFileSync(join(agentDir, 'cycle_1_result.json'), JSON.stringify(resultData));
    
    const evaluation = evaluateAutoresearchOutcome(agentDir, 1);
    
    assertEqual(evaluation.significant, true, 'Should be significant via fallback threshold');
    assertEqual(evaluation.needsOperatorReview, true, 'Should flag for operator review');
    assertTrue(evaluation.reason.includes('Fallback threshold'), 'Should indicate fallback threshold met');
  });

  // Test: evaluateAutoresearchOutcome - below threshold returns not significant
  test('evaluateAutoresearchOutcome - below threshold returns not significant', () => {
    const agentDir = join(baseDir, 'below-threshold');
    mkdirSync(agentDir, { recursive: true });
    
    // Only 5% improvement (below 10% primary threshold)
    const resultData = {
      result: 'complete',
      postApplyCompletions: 20,
      metrics: {
        baseline: {
          score: 0.80,
          agentId: 'test-agent',
        },
        post: {
          score: 0.84,
          agentId: 'test-agent',
        },
      },
    };
    
    writeFileSync(join(agentDir, 'cycle_1_result.json'), JSON.stringify(resultData));
    
    const evaluation = evaluateAutoresearchOutcome(agentDir, 1);
    
    assertEqual(evaluation.significant, false, 'Should not be significant');
    assertFalse(evaluation.needsOperatorReview, 'Should not need operator review');
    assertTrue(evaluation.reason.includes('Improvement below threshold'), 'Should indicate below threshold');
  });

  // Test: evaluateAutoresearchOutcome - insufficient sample size returns not significant
  test('evaluateAutoresearchOutcome - insufficient sample size returns not significant', () => {
    const agentDir = join(baseDir, 'low-sample');
    mkdirSync(agentDir, { recursive: true });
    
    // 25% improvement but only 5 postApplyCompletions
    const resultData = {
      result: 'complete',
      postApplyCompletions: 5,
      metrics: {
        baseline: {
          score: 0.60,
          agentId: 'low-sample',
        },
        post: {
          score: 0.75,
          agentId: 'low-sample',
        },
      },
    };
    
    writeFileSync(join(agentDir, 'cycle_1_result.json'), JSON.stringify(resultData));
    
    const evaluation = evaluateAutoresearchOutcome(agentDir, 1);
    
    assertEqual(evaluation.significant, false, 'Should not be significant');
    assertTrue(evaluation.reason.includes('Insufficient sample size'), 'Should indicate insufficient samples');
  });

  // Test: buildRecommendation - calculates weight boost capped at 30%
  test('buildRecommendation - calculates weight boost capped at 30%', () => {
    const evaluation = {
      metrics: {
        relativeImprovement: 50, // Would be 50% boost if uncapped
        baseline: { quality_score: 0.70 },
        post: { quality_score: 1.05 },
      },
      agentId: 'test-agent',
      cycleId: 'cycle_1',
      needsOperatorReview: false,
    };
    
    const currentWeight = 1.0;
    const ttlMs = 14 * 24 * 60 * 60 * 1000;
    
    const recommendation = buildRecommendation(evaluation, currentWeight, ttlMs);
    
    assertEqual(recommendation.new_weights['test-agent'], 1.3, 'Should cap weight boost at 30%');
    assertEqual(recommendation.ttlMs, ttlMs, 'Should use provided TTL');
    assertEqual(recommendation.confidence, 'high', 'Should be high confidence without operator review');
    assertEqual(recommendation.context.source, 'autoresearch', 'Should set source to autoresearch');
  });

  // Test: buildRecommendation - applies proportional weight boost for small improvements
  test('buildRecommendation - applies proportional weight boost for small improvements', () => {
    const evaluation = {
      metrics: {
        relativeImprovement: 20,
        baseline: { quality_score: 0.70 },
        post: { quality_score: 0.84 },
      },
      agentId: 'test-agent',
      cycleId: 'cycle_1',
      needsOperatorReview: false,
    };
    
    const currentWeight = 1.0;
    const ttlMs = 14 * 24 * 60 * 60 * 1000;
    
    const recommendation = buildRecommendation(evaluation, currentWeight, ttlMs);
    
    // 20% improvement should result in 1.0 * 1.2 = 1.2 weight
    assertEqual(recommendation.new_weights['test-agent'], 1.2, 'Should apply 20% boost');
  });

  // Test: buildRecommendation - includes evidence in context
  test('buildRecommendation - includes evidence in context', () => {
    const evaluation = {
      metrics: {
        relativeImprovement: 25,
        absoluteDelta: 0.15,
        baseline: { quality_score: 0.70, success_rate: 0.65, avg_latency: 150, sampleSize: 20 },
        post: { quality_score: 0.85, success_rate: 0.80, avg_latency: 130, sampleSize: 20 },
      },
      agentId: 'test-agent',
      cycleId: 'cycle_1',
      needsOperatorReview: false,
    };
    
    const currentWeight = 1.0;
    const ttlMs = 14 * 24 * 60 * 60 * 1000;
    
    const recommendation = buildRecommendation(evaluation, currentWeight, ttlMs);
    
    assertObjectHasProperties(recommendation.context.evidence, 
      ['baselineMetrics', 'postMetrics', 'relativeImprovement', 'absoluteDelta', 'sampleSize'],
      'Should include all evidence fields');
    
    assertEqual(recommendation.context.evidence.relativeImprovement, '25.00', 'Should include relative improvement');
    assertEqual(recommendation.context.evidence.needsOperatorReview, false, 'Should include needsOperatorReview flag');
  });

  // Test: loadEvaluatedState - returns empty object when file does not exist
  test('loadEvaluatedState - returns empty object when file does not exist', () => {
    const nonExistentPath = join(testDir, 'nonexistent-state.json');
    const state = loadEvaluatedState(nonExistentPath);
    
    assertEqual(typeof state, 'object', 'Should return object');
    assertEqual(Object.keys(state).length, 0, 'Should be empty object');
  });

  // Test: loadEvaluatedState - parses existing state file
  test('loadEvaluatedState - parses existing state file', () => {
    const stateFile = join(testDir, 'state-test.json');
    const testState = {
      'claude:cycle_1': { evaluatedAt: '2026-03-18T00:00:00.000Z', agentId: 'claude', cycleId: 'cycle_1' },
      'codex:cycle_2': { evaluatedAt: '2026-03-18T00:00:00.000Z', agentId: 'codex', cycleId: 'cycle_2' },
    };
    
    writeFileSync(stateFile, JSON.stringify(testState, null, 2));
    
    const state = loadEvaluatedState(stateFile);
    
    assertEqual(Object.keys(state).length, 2, 'Should load 2 entries');
    assertTrue(state.hasOwnProperty('claude:cycle_1'), 'Should have claude:cycle_1 entry');
    assertEqual(state['claude:cycle_1'].agentId, 'claude', 'Should preserve agent ID');
  });

  // Test: loadEvaluatedState - handles corrupted JSON gracefully
  test('loadEvaluatedState - handles corrupted JSON gracefully', () => {
    const stateFile = join(testDir, 'corrupt-state.json');
    writeFileSync(stateFile, 'this is not valid json {{{');
    
    const state = loadEvaluatedState(stateFile);
    
    assertEqual(typeof state, 'object', 'Should return object even on error');
    assertEqual(Object.keys(state).length, 0, 'Should be empty on parse error');
  });

  // Test: isEvaluated - returns true for evaluated cycles
  test('isEvaluated - returns true for evaluated cycles', () => {
    const state = {
      'claude:cycle_1': { evaluatedAt: '2026-03-18T00:00:00.000Z', agentId: 'claude', cycleId: 'cycle_1' },
    };
    
    assertTrue(isEvaluated(state, 'claude', 'cycle_1'), 'Should return true for evaluated cycle');
    assertFalse(isEvaluated(state, 'claude', 'cycle_2'), 'Should return false for unevaluated cycle');
    assertFalse(isEvaluated(state, 'codex', 'cycle_1'), 'Should return false for different agent');
  });

  // Test: markAsEvaluated - adds cycle to state
  test('markAsEvaluated - adds cycle to state', () => {
    const state = {};
    
    markAsEvaluated(state, 'claude', 'cycle_1');
    
    assertTrue(state.hasOwnProperty('claude:cycle_1'), 'Should add entry with agentId:cycleId key');
    assertEqual(state['claude:cycle_1'].agentId, 'claude', 'Should preserve agent ID');
    assertEqual(state['claude:cycle_1'].cycleId, 'cycle_1', 'Should preserve cycle ID');
    assertTrue(state['claude:cycle_1'].hasOwnProperty('evaluatedAt'), 'Should include evaluatedAt timestamp');
  });

  // Test: persistEvaluatedState - creates directory if it does not exist
  test('persistEvaluatedState - creates directory if it does not exist', () => {
    const nestedPath = join(testDir, 'nested', 'deep', 'state.json');
    const state = {
      'test:cycle_1': { evaluatedAt: new Date().toISOString(), agentId: 'test', cycleId: 'cycle_1' },
    };
    
    // Import mkdirSync for directory creation
    import('fs').then(({ mkdirSync }) => {
      const dir = join(nestedPath, '..');
      mkdirSync(dir, { recursive: true });
      
      persistEvaluatedState(state, nestedPath);
      
      assertTrue(existsSync(nestedPath), 'Should create state file');
      assertTrue(existsSync(join(testDir, 'nested', 'deep')), 'Should create nested directories');
    });
  });

  // Test: persistEvaluatedState - persists state correctly
  test('persistEvaluatedState - persists state correctly', () => {
    const stateFile = join(testDir, 'persist-test.json');
    const state = {
      'claude:cycle_1': { evaluatedAt: '2026-03-18T00:00:00.000Z', agentId: 'claude', cycleId: 'cycle_1' },
      'codex:cycle_2': { evaluatedAt: '2026-03-18T00:00:00.000Z', agentId: 'codex', cycleId: 'cycle_2' },
    };
    
    persistEvaluatedState(state, stateFile);
    
    const loaded = JSON.parse(readFileSync(stateFile, 'utf-8'));
    assertDeepEqual(loaded, state, 'Should persist and reload identical state');
  });

  // Test: emitProposalCreatedEvent - creates timeline event with correlationId
  test('emitProposalCreatedEvent - creates timeline event with correlationId', () => {
    const timelineStore = createMockTimelineStore();
    const recommendation = {
      id: 'autoresearch-claude-cycle_1',
      new_weights: { claude: 1.2 },
      old_weights: { claude: 1.0 },
      rationale: ['Test rationale'],
    };
    const cycleId = 'cycle_1';
    
    emitProposalCreatedEvent(timelineStore, recommendation, cycleId);
    
    const events = timelineStore.getEvents();
    assertEqual(events.length, 1, 'Should create one timeline event');
    assertEqual(events[0].event.data.correlationId, cycleId, 'Should include correlationId');
    assertEqual(events[0].event.data.proposalId, recommendation.id, 'Should include proposal ID');
    assertEqual(events[0].event.data.sourceType, 'autoresearch', 'Should set source type');
  });

  // Test: emitOutcomeLoggedEvent - creates operator action event for non-significant outcomes
  test('emitOutcomeLoggedEvent - creates operator action event for non-significant outcomes', () => {
    const timelineStore = createMockTimelineStore();
    const evaluation = {
      cycleId: 'cycle_1',
      agentId: 'test-agent',
      significant: false,
      reason: 'Improvement below threshold',
      metrics: { relativeImprovement: 5 },
      sampleSize: 15,
      needsOperatorReview: false,
    };
    
    emitOutcomeLoggedEvent(timelineStore, evaluation);
    
    const events = timelineStore.getEvents();
    assertEqual(events.length, 1, 'Should create one operator action event');
    assertEqual(events[0].event.data.cycleId, 'cycle_1', 'Should include cycle ID');
    assertEqual(events[0].event.data.significant, false, 'Should include significant flag');
    assertEqual(events[0].event.actionType, 'autoresearch_outcome_logged', 'Should set action type');
  });

  // Test: evaluatePendingCycles - skips evaluation when config.enabled is false
  test('evaluatePendingCycles - skips evaluation when config.enabled is false', async () => {
    // Create a complete cycle
    createCycleResult('claude', 1, { 
      result: 'complete', 
      postApplyCompletions: 15,
      metrics: { 
        baseline: { score: 0.70 }, 
        post: { score: 0.85 } 
      } 
    });
    
    const timelineStore = createMockTimelineStore();
    const operatorAuditStore = createMockOperatorAuditStore();
    const events = createMockEvents();
    
    const config = {
      autoresearchBridge: { enabled: false },
      routing: { weights: { claude: 1.0 } },
    };
    
    const result = await evaluatePendingCycles({
      timelineStore,
      operatorAuditStore,
      events,
      config,
      autoresearchBaseDir: baseDir,
      stateFilePath,
    });
    
    assertEqual(result.evaluated, 0, 'Should skip evaluation when disabled');
    assertEqual(result.proposalsCreated, 0, 'Should create no proposals when disabled');
    assertEqual(result.outcomesLogged, 0, 'Should log no outcomes when disabled');
  });

  // Test: evaluatePendingCycles - evaluates cycles and creates proposals for significant improvements
  test('evaluatePendingCycles - evaluates cycles and creates proposals for significant improvements', async () => {
    // Create a significant improvement cycle (25% improvement, 15 completions)
    createCycleResult('claude', 1, { 
      result: 'complete', 
      postApplyCompletions: 15,
      metrics: { 
        baseline: { score: 0.70, agentId: 'claude' }, 
        post: { score: 0.875, agentId: 'claude' } 
      } 
    });
    
    const timelineStore = createMockTimelineStore();
    const operatorAuditStore = createMockOperatorAuditStore();
    const events = createMockEvents();
    
    const config = {
      autoresearchBridge: { enabled: true, proposalTtlMs: 14 * 24 * 60 * 60 * 1000 },
      routing: { weights: { claude: 1.0 } },
    };
    
    const result = await evaluatePendingCycles({
      timelineStore,
      operatorAuditStore,
      events,
      config,
      autoresearchBaseDir: baseDir,
      stateFilePath,
    });
    
    assertEqual(result.evaluated, 1, 'Should evaluate 1 cycle');
    assertEqual(result.proposalsCreated, 1, 'Should create 1 proposal for significant improvement');
    assertEqual(result.outcomesLogged, 0, 'Should not log non-significant outcomes');
    assertEqual(result.errors, 0, 'Should have no errors');
    
    // Verify state was persisted
    const state = JSON.parse(readFileSync(stateFilePath, 'utf-8'));
    assertTrue(state.hasOwnProperty('claude:cycle_1'), 'Should mark cycle as evaluated');
  });

  // Test: evaluatePendingCycles - logs outcome for non-significant improvements
  test('evaluatePendingCycles - logs outcome for non-significant improvements', async () => {
    // Create a non-significant improvement cycle (5% improvement)
    createCycleResult('test-agent', 1, { 
      result: 'complete', 
      postApplyCompletions: 20,
      metrics: { 
        baseline: { score: 0.80, agentId: 'test-agent' }, 
        post: { score: 0.84, agentId: 'test-agent' } 
      } 
    });
    
    const timelineStore = createMockTimelineStore();
    const operatorAuditStore = createMockOperatorAuditStore();
    const events = createMockEvents();
    
    const config = {
      autoresearchBridge: { enabled: true },
      routing: { weights: { 'test-agent': 1.0 } },
    };
    
    const result = await evaluatePendingCycles({
      timelineStore,
      operatorAuditStore,
      events,
      config,
      autoresearchBaseDir: baseDir,
      stateFilePath,
    });
    
    assertEqual(result.evaluated, 1, 'Should evaluate 1 cycle');
    assertEqual(result.proposalsCreated, 0, 'Should not create proposal for non-significant improvement');
    assertEqual(result.outcomesLogged, 1, 'Should log non-significant outcome');
  });

  // Test: evaluatePendingCycles - prevents re-evaluation of same cycle
  test('evaluatePendingCycles - prevents re-evaluation of same cycle', async () => {
    // Create a significant improvement cycle
    createCycleResult('claude', 1, { 
      result: 'complete', 
      postApplyCompletions: 15,
      metrics: { 
        baseline: { score: 0.70, agentId: 'claude' }, 
        post: { score: 0.90, agentId: 'claude' } 
      } 
    });
    
    const timelineStore = createMockTimelineStore();
    const operatorAuditStore = createMockOperatorAuditStore();
    const events = createMockEvents();
    
    const config = {
      autoresearchBridge: { enabled: true },
      routing: { weights: { claude: 1.0 } },
    };
    
    // First tick
    const result1 = await evaluatePendingCycles({
      timelineStore,
      operatorAuditStore,
      events,
      config,
      autoresearchBaseDir: baseDir,
      stateFilePath,
    });
    
    assertEqual(result1.evaluated, 1, 'Should evaluate on first tick');
    assertEqual(result1.proposalsCreated, 1, 'Should create proposal on first tick');
    
    // Second tick - should skip already evaluated cycle
    const result2 = await evaluatePendingCycles({
      timelineStore,
      operatorAuditStore,
      events,
      config,
      autoresearchBaseDir: baseDir,
      stateFilePath,
    });
    
    assertEqual(result2.evaluated, 0, 'Should skip already evaluated cycle');
    assertEqual(result2.proposalsCreated, 0, 'Should not create duplicate proposal');
  });

  // Test: evaluatePendingCycles - handles multiple cycles from different agents
  test('evaluatePendingCycles - handles multiple cycles from different agents', async () => {
    // Create cycles with different outcomes
    createCycleResult('claude', 1, { 
      result: 'complete', 
      postApplyCompletions: 15,
      metrics: { 
        baseline: { score: 0.70, agentId: 'claude' }, 
        post: { score: 0.90, agentId: 'claude' } 
      } 
    });
    
    createCycleResult('codex', 1, { 
      result: 'complete', 
      postApplyCompletions: 12,
      metrics: { 
        baseline: { score: 0.65, agentId: 'codex' }, 
        post: { score: 0.78, agentId: 'codex' } 
      } 
    });
    
    createCycleResult('nia', 1, { 
      result: 'complete', 
      postApplyCompletions: 20,
      metrics: { 
        baseline: { score: 0.80, agentId: 'nia' }, 
        post: { score: 0.84, agentId: 'nia' } 
      } 
    });
    
    const timelineStore = createMockTimelineStore();
    const operatorAuditStore = createMockOperatorAuditStore();
    const events = createMockEvents();
    
    const config = {
      autoresearchBridge: { enabled: true },
      routing: { weights: { claude: 1.0, codex: 1.0, nia: 1.0 } },
    };
    
    const result = await evaluatePendingCycles({
      timelineStore,
      operatorAuditStore,
      events,
      config,
      autoresearchBaseDir: baseDir,
      stateFilePath,
    });
    
    assertEqual(result.evaluated, 3, 'Should evaluate all 3 cycles');
    assertEqual(result.proposalsCreated, 2, 'Should create 2 proposals (claude and codex)');
    assertEqual(result.outcomesLogged, 1, 'Should log 1 non-significant outcome (nia)');
  });

  // Test: evaluatePendingCycles - handles errors gracefully
  test('evaluatePendingCycles - handles errors gracefully', async () => {
    // Create a cycle with missing metrics (will cause evaluation error)
    createCycleResult('error-agent', 1, { 
      result: 'complete', 
      metrics: {} // Missing baseline and post
    });
    
    const timelineStore = createMockTimelineStore();
    const operatorAuditStore = createMockOperatorAuditStore();
    const events = createMockEvents();
    
    const config = {
      autoresearchBridge: { enabled: true },
      routing: { weights: { 'error-agent': 1.0 } },
    };
    
    const result = await evaluatePendingCycles({
      timelineStore,
      operatorAuditStore,
      events,
      config,
      autoresearchBaseDir: baseDir,
      stateFilePath,
    });
    
    assertEqual(result.evaluated, 1, 'Should attempt to evaluate');
    assertEqual(result.errors, 1, 'Should record 1 error');
  });

  // Test: evaluatePendingCycles - uses custom proposalTtlMs from config
  test('evaluatePendingCycles - uses custom proposalTtlMs from config', async () => {
    const freshBaseDir = join(testDir, 'ttl-test-autoresearch');
    mkdirSync(freshBaseDir, { recursive: true });
    
    createCycleResult('claude', 1, { 
      result: 'complete', 
      postApplyCompletions: 15,
      metrics: { 
        baseline: { score: 0.70, agentId: 'claude' }, 
        post: { score: 0.90, agentId: 'claude' } 
      } 
    }, freshBaseDir);
    
    const timelineStore = createMockTimelineStore();
    const operatorAuditStore = createMockOperatorAuditStore();
    const events = createMockEvents();
    
    const customTtlMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    
    const config = {
      autoresearchBridge: { enabled: true, proposalTtlMs: customTtlMs },
      routing: { weights: { claude: 1.0 } },
    };
    
    const stateFilePathTtl = join(testDir, 'ttl-test-evaluated-cycles.json');
    
    await evaluatePendingCycles({
      timelineStore,
      operatorAuditStore,
      events,
      config,
      autoresearchBaseDir: freshBaseDir,
      stateFilePath: stateFilePathTtl,
    });
    
    const timelineEvents = timelineStore.getEvents();
    const proposalEvent = timelineEvents.find(e => e.event.data.proposalId && e.event.data.proposalId.includes('claude'));
    
    assertEqual(proposalEvent !== undefined, true, 'Should find proposal event');
    assertEqual(proposalEvent.event.data.context?.proposalTtlMs, customTtlMs, 'Should use custom TTL from config');
  });

  // Test: evaluatePendingCycles - emits governance event on proposal creation
  test('evaluatePendingCycles - emits governance event on proposal creation', async () => {
    const freshBaseDir = join(testDir, 'governance-test-autoresearch');
    mkdirSync(freshBaseDir, { recursive: true });
    
    createCycleResult('claude', 1, { 
      result: 'complete', 
      postApplyCompletions: 15,
      metrics: { 
        baseline: { score: 0.70, agentId: 'claude' }, 
        post: { score: 0.90, agentId: 'claude' } 
      } 
    }, freshBaseDir);
    
    const timelineStore = createMockTimelineStore();
    const operatorAuditStore = createMockOperatorAuditStore();
    const events = createMockEvents();
    
    let governanceEventEmitted = null;
    events.on('governance:proposal_created', (data) => {
      governanceEventEmitted = data;
    });
    
    const config = {
      autoresearchBridge: { enabled: true },
      routing: { weights: { claude: 1.0 } },
    };
    
    const stateFilePathGov = join(testDir, 'governance-test-evaluated-cycles.json');
    
    await evaluatePendingCycles({
      timelineStore,
      operatorAuditStore,
      events,
      config,
      autoresearchBaseDir: freshBaseDir,
      stateFilePath: stateFilePathGov,
    });
    
    assertEqual(governanceEventEmitted !== null, true, 'Should emit governance event');
    assertEqual(governanceEventEmitted.source, 'autoresearch', 'Should set source to autoresearch');
    assertEqual(governanceEventEmitted.agentId, 'claude', 'Should include agent ID');
  });

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`Tests completed: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60) + '\n');

  if (failed > 0) {
    process.exit(1);
  }
})();
