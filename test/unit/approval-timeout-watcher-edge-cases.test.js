// test/unit/approval-timeout-watcher-edge-cases.test.js
// Unit tests for edge cases: missing dependencies, empty project lists,
// malformed campaign data, and concurrent timeout processing

import { strict as assert } from 'assert';
import { createApprovalTimeoutWatcher } from '../../src/orchestrator/approval-timeout-watcher.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    if (fn.constructor.name === 'AsyncFunction') {
      fn().then(() => {
        passed++;
        console.log(`  ✓ ${name}`);
      }).catch(err => {
        failed++;
        console.log(`  ✗ ${name}: ${err.message}`);
      });
    } else {
      fn();
      passed++;
      console.log(`  ✓ ${name}`);
    }
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

async function runAsyncTests() {
  await new Promise(resolve => setTimeout(resolve, 100));
}

console.log('test/unit/approval-timeout-watcher-edge-cases.test.js');

// ─── Mock Dependencies ──────────────────────────────────────────

function createMockStateManager(projects = []) {
  return {
    projectsDir: '/tmp/test-projects',
    listProjects: () => projects,
  };
}

function createMockCampaignManager(campaigns = [], updateFn = null) {
  return {
    listCampaigns: (projectId, status) => campaigns,
    updateMilestoneStatus: updateFn || async function() {},
  };
}

function createMockEvents() {
  const emitted = [];
  return {
    emit: (event, data) => emitted.push({ event, data }),
    emitMessage: (msg) => emitted.push({ type: 'message', msg }),
    getEmitted: () => emitted,
  };
}

function createMockCircuitBreaker() {
  const state = new Map();
  return {
    canCampaignRequestApproval: (campaignId) => {
      const entry = state.get(campaignId);
      // Returns true when closed (< 3 timeouts), false when open (>= 3)
      return !entry || entry.count < 3;
    },
    recordApprovalTimeout: (campaignId, data) => {
      const entry = state.get(campaignId) || { count: 0, timestamps: [] };
      entry.count++;
      entry.timestamps.push(Date.now());
      state.set(campaignId, entry);
      // Note: breaker opens AFTER recording, when count reaches 3
    },
    getCampaignApprovalStatus: (campaignId) => {
      const entry = state.get(campaignId);
      if (!entry) return null; // Matches real circuit-breaker.js behavior
      const isOpen = entry.count >= 3;
      return {
        open: isOpen,
        state: isOpen ? 'open' : 'closed',
        timeouts: entry.count,
        threshold: 3,
        windowMs: 24 * 60 * 60 * 1000,
      };
    },
    resetCampaignApprovalBreaker: (campaignId) => {
      state.delete(campaignId);
    },
  };
}

function createMockConfig() {
  return {
    approvalTimeoutWatcher: { scanIntervalMs: 60000 },
    campaigns: { approvalTimeoutMs: 3600000 }, // 1 hour for testing
  };
}

// ─── Tests: Missing Dependencies ────────────────────────────────

test('watcher handles missing campaignManager gracefully', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: null,
    stateManager: createMockStateManager(['proj1']),
    events: createMockEvents(),
    config: createMockConfig(),
  });
  
  assert.ok(watcher, 'watcher should be created');
  assert.ok(typeof watcher.start === 'function', 'start method should exist');
  assert.ok(typeof watcher.stop === 'function', 'stop method should exist');
  assert.ok(typeof watcher.scan === 'function', 'scan method should exist');
});

test('watcher handles missing stateManager gracefully', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: null,
    events: createMockEvents(),
    config: createMockConfig(),
  });
  
  assert.ok(watcher, 'watcher should be created');
  assert.ok(typeof watcher.start === 'function', 'start method should exist');
});

test('watcher handles missing events gracefully', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: null,
    config: createMockConfig(),
  });
  
  assert.ok(watcher, 'watcher should be created');
  assert.ok(typeof watcher.start === 'function', 'start method should exist');
});

test('watcher handles missing config gracefully', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: null,
  });
  
  assert.ok(watcher, 'watcher should be created with defaults');
});

test('watcher handles missing circuitBreaker gracefully', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
    circuitBreaker: null,
  });
  
  const status = watcher.getCircuitBreakerStatus('campaign1');
  assert.equal(status.open, false, 'should return closed status when no circuit breaker');
  assert.equal(status.timeouts, 0, 'should return 0 timeouts');
});

test('watcher handles all dependencies missing', () => {
  const watcher = createApprovalTimeoutWatcher({});
  
  assert.ok(watcher, 'watcher should be created with all defaults');
  assert.ok(typeof watcher.start === 'function', 'start method should exist');
  assert.ok(typeof watcher.stop === 'function', 'stop method should exist');
});

// ─── Tests: Empty Project Lists ─────────────────────────────────

test('scan handles empty project list', async () => {
  const stateManager = createMockStateManager([]);
  const events = createMockEvents();
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager,
    events,
    config: createMockConfig(),
  });
  
  await watcher.scan();
  
  const emitted = events.getEmitted();
  assert.equal(emitted.length, 0, 'should not emit any events for empty projects');
});

test('scan handles project with no campaigns', async () => {
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager([]),
    stateManager,
    events,
    config: createMockConfig(),
  });
  
  await watcher.scan();
  
  const emitted = events.getEmitted();
  assert.equal(emitted.length, 0, 'should not emit events when no campaigns');
});

test('scan handles project with campaigns but no pending approvals', async () => {
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'active', title: 'Active Milestone' },
      { id: 'm2', status: 'completed', title: 'Completed Milestone' },
      { id: 'm3', status: 'waiting_approval', title: 'Just Requested', approvalRequestedAt: Date.now() },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(campaigns),
    stateManager,
    events,
    config: createMockConfig(),
  });
  
  await watcher.scan();
  
  const emitted = events.getEmitted();
  assert.equal(emitted.length, 0, 'should not emit for non-timed-out approvals');
});

// ─── Tests: Malformed Campaign Data ─────────────────────────────

test('scan handles campaign with missing milestones array', async () => {
  const campaigns = [{ id: 'campaign1' }]; // No milestones property
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(campaigns),
    stateManager,
    events,
    config: createMockConfig(),
  });
  
  await watcher.scan();
  
  // Should not throw, should handle gracefully
  assert.ok(true, 'should not throw on missing milestones');
});

test('scan handles milestone with missing approvalRequestedAt', async () => {
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'No timestamp' },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(campaigns),
    stateManager,
    events,
    config: createMockConfig(),
  });
  
  await watcher.scan();
  
  const emitted = events.getEmitted();
  assert.equal(emitted.length, 0, 'should skip milestones without approvalRequestedAt');
});

test('scan handles milestone with invalid approvalRequestedAt format', async () => {
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'Invalid date', approvalRequestedAt: 'not-a-date' },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(campaigns),
    stateManager,
    events,
    config: createMockConfig(),
  });
  
  await watcher.scan();
  
  // Should handle gracefully without throwing
  assert.ok(true, 'should handle invalid date format');
});

test('scan handles milestone with null approvalRequestedAt', async () => {
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'Null date', approvalRequestedAt: null },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(campaigns),
    stateManager,
    events,
    config: createMockConfig(),
  });
  
  await watcher.scan();
  
  const emitted = events.getEmitted();
  assert.equal(emitted.length, 0, 'should skip milestones with null approvalRequestedAt');
});

test('scan handles milestone with missing id', async () => {
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { status: 'waiting_approval', title: 'No ID', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(campaigns),
    stateManager,
    events,
    config: createMockConfig(),
  });
  
  await watcher.scan();
  
  // Should handle gracefully
  assert.ok(true, 'should handle milestone without id');
});

test('scan handles campaign with missing id', async () => {
  const campaigns = [{
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'Campaign no ID', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(campaigns),
    stateManager,
    events,
    config: createMockConfig(),
  });
  
  await watcher.scan();
  
  // Should handle gracefully
  assert.ok(true, 'should handle campaign without id');
});

test('scan handles project with missing id (string project)', async () => {
  const stateManager = createMockStateManager(['proj1']); // String instead of object
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager([]),
    stateManager,
    events: createMockEvents(),
    config: createMockConfig(),
  });
  
  await watcher.scan();
  
  // Should handle gracefully
  assert.ok(true, 'should handle string project id');
});

// ─── Tests: Concurrent Timeout Processing ───────────────────────

test('concurrent timeouts are processed sequentially', async () => {
  let processCount = 0;
  let concurrentCount = 0;
  let maxConcurrent = 0;
  
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'M1', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
      { id: 'm2', status: 'waiting_approval', title: 'M2', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
      { id: 'm3', status: 'waiting_approval', title: 'M3', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
    ],
  }];
  
  const updateFn = async () => {
    processCount++;
    concurrentCount++;
    maxConcurrent = Math.max(maxConcurrent, concurrentCount);
    await new Promise(resolve => setTimeout(resolve, 10));
    concurrentCount--;
  };
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(campaigns, updateFn),
    stateManager,
    events,
    config: createMockConfig(),
  });
  
  await watcher.scan();
  
  assert.equal(maxConcurrent, 1, 'should process timeouts sequentially (max concurrent = 1)');
  assert.equal(processCount, 3, 'should process all 3 timeouts');
});

test('circuit breaker prevents cascade after threshold', async () => {
  const circuitBreaker = createMockCircuitBreaker();
  const events = createMockEvents();
  
  // Create 5 milestones that will timeout
  const milestones = [];
  for (let i = 1; i <= 5; i++) {
    milestones.push({
      id: `m${i}`,
      status: 'waiting_approval',
      title: `Milestone ${i}`,
      approvalRequestedAt: new Date(Date.now() - 7200000).toISOString(),
    });
  }
  
  const campaigns = [{
    id: 'campaign1',
    milestones,
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(campaigns),
    stateManager,
    events,
    config: createMockConfig(),
    circuitBreaker,
  });
  
  await watcher.scan();
  
  const emitted = events.getEmitted();
  const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
  const blockedEvents = emitted.filter(e => e.event === 'approval:timeout_blocked');
  
  // m1: count=0→1, processed
  // m2: count=1→2, processed
  // m3: count=2→3, recorded but breaker trips, re-check blocks it
  // m4, m5: breaker already open, blocked immediately
  assert.equal(timeoutEvents.length, 2, 'should process 2 timeouts before breaker trips on 3rd');
  assert.equal(blockedEvents.length, 3, 'should block 3 after breaker trips (including 3rd)');
});

test('circuit breaker is per-campaign (not global)', async () => {
  const circuitBreaker = createMockCircuitBreaker();
  const events = createMockEvents();
  
  // Create milestones for two different campaigns
  const campaigns = [
    {
      id: 'campaign1',
      milestones: [
        { id: 'm1', status: 'waiting_approval', title: 'C1 M1', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
        { id: 'm2', status: 'waiting_approval', title: 'C1 M2', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
        { id: 'm3', status: 'waiting_approval', title: 'C1 M3', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
        { id: 'm4', status: 'waiting_approval', title: 'C1 M4', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
      ],
    },
    {
      id: 'campaign2',
      milestones: [
        { id: 'm5', status: 'waiting_approval', title: 'C2 M1', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
      ],
    },
  ];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(campaigns),
    stateManager,
    events,
    config: createMockConfig(),
    circuitBreaker,
  });
  
  await watcher.scan();
  
  const emitted = events.getEmitted();
  const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
  const blockedEvents = emitted.filter(e => e.event === 'approval:timeout_blocked');
  
  // Campaign1: m1→processed, m2→processed, m3→trips breaker (blocked on re-check), m4→blocked
  // Campaign2: m5→processed (separate breaker, count=1)
  assert.equal(timeoutEvents.length, 3, 'should process 2 from C1 + 1 from C2');
  assert.equal(blockedEvents.length, 2, 'should block 2 from C1 (m3 trips, m4 blocked)');
});

test('reset circuit breaker allows new timeouts', async () => {
  const circuitBreaker = createMockCircuitBreaker();
  const events = createMockEvents();
  
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'M1', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
      { id: 'm2', status: 'waiting_approval', title: 'M2', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
      { id: 'm3', status: 'waiting_approval', title: 'M3', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(campaigns),
    stateManager,
    events,
    config: createMockConfig(),
    circuitBreaker,
  });
  
  // First scan - should trip breaker on 3rd timeout
  await watcher.scan();
  
  let emitted = events.getEmitted();
  let timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
  // m1, m2 processed; m3 trips breaker and gets blocked on re-check
  assert.equal(timeoutEvents.length, 2, 'should process 2 timeouts before breaker trips');
  
  // Check breaker is open
  const status = watcher.getCircuitBreakerStatus('campaign1');
  assert.equal(status.open, true, 'breaker should be open');
  
  // Reset breaker
  const resetResult = watcher.resetCircuitBreaker('campaign1', 'operator1');
  assert.equal(resetResult, true, 'should successfully reset breaker');
  
  // Verify breaker is closed
  const newStatus = watcher.getCircuitBreakerStatus('campaign1');
  assert.equal(newStatus.open, false, 'breaker should be closed after reset');
});

test('reset circuit breaker without circuitBreaker returns false', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
    circuitBreaker: null,
  });
  
  const result = watcher.resetCircuitBreaker('campaign1', 'operator1');
  assert.equal(result, false, 'should return false when circuitBreaker not available');
});

// ─── Tests: Lifecycle Edge Cases ────────────────────────────────

test('start is idempotent (calling twice does not create duplicate intervals)', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
  });
  
  watcher.start();
  const firstRunning = watcher.isRunning();
  watcher.start();
  const secondRunning = watcher.isRunning();
  
  assert.equal(firstRunning, true, 'should be running after first start');
  assert.equal(secondRunning, true, 'should still be running after second start');
  
  watcher.stop();
});

test('stop can be called when not running', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
  });
  
  // Should not throw
  watcher.stop();
  assert.ok(true, 'stop should not throw when not running');
});

test('stop can be called multiple times', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
  });
  
  watcher.start();
  watcher.stop();
  watcher.stop();
  watcher.stop();
  
  assert.ok(true, 'multiple stops should not throw');
});

// ─── Tests: Timeout Boundary Conditions ─────────────────────────

test('milestone exactly at timeout boundary is not triggered', async () => {
  // Use a fixed reference time to ensure precise boundary testing
  const fixedNow = Date.now();
  const exactTimeout = 3600000; // 1 hour
  const approvalTime = new Date(fixedNow - exactTimeout).toISOString();
  
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { 
        id: 'm1', 
        status: 'waiting_approval', 
        title: 'At boundary', 
        approvalRequestedAt: approvalTime 
      },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  
  // Mock Date.now() to return fixed time for precise boundary testing
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(campaigns),
    stateManager,
    events,
    config: createMockConfig(),
  });
  
  try {
    await watcher.scan();
    
    const emitted = events.getEmitted();
    const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
    
    // elapsed = fixedNow - (fixedNow - 3600000) = 3600000, which is NOT > 3600000
    // So it should NOT trigger
    assert.equal(timeoutEvents.length, 0, 'should not trigger at exact boundary (not strictly greater)');
  } finally {
    Date.now = originalDateNow;
  }
});

test('milestone 1ms past timeout boundary is triggered', async () => {
  const exactTimeout = 3600000; // 1 hour
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { 
        id: 'm1', 
        status: 'waiting_approval', 
        title: 'Past boundary', 
        approvalRequestedAt: new Date(Date.now() - exactTimeout - 1).toISOString() 
      },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(campaigns),
    stateManager,
    events,
    config: createMockConfig(),
  });
  
  await watcher.scan();
  
  const emitted = events.getEmitted();
  const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
  
  assert.equal(timeoutEvents.length, 1, 'should trigger 1ms past boundary');
});

// ─── Summary ────────────────────────────────────────────────────

await runAsyncTests();

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
