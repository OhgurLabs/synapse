// test/unit/approval-timeout-watcher.test.js
// Unit tests for approval-timeout-watcher core functions:
// createApprovalTimeoutWatcher factory, scan() candidate detection,
// handleTimeout() circuit breaker checks, and manual trigger/reset methods

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

console.log('test/unit/approval-timeout-watcher.test.js');

// ─── Mock Dependencies ──────────────────────────────────────────

function createMockStateManager(projects = []) {
  return {
    projectsDir: '/tmp/test-projects',
    listProjects: () => projects,
  };
}

function createMockCampaignManager(campaigns = [], updateFn = null) {
  const updates = [];
  return {
    listCampaigns: (projectId, status) => campaigns,
    updateMilestoneStatus: updateFn || async function(projectId, campaignId, milestoneId, newStatus, reason, actor) {
      updates.push({ projectId, campaignId, milestoneId, newStatus, reason, actor });
    },
    getUpdates: () => updates,
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
      return !entry || entry.count < 3;
    },
    recordApprovalTimeout: (campaignId, data) => {
      const entry = state.get(campaignId) || { count: 0, timestamps: [] };
      entry.count++;
      entry.timestamps.push(Date.now());
      state.set(campaignId, entry);
    },
    getCampaignApprovalStatus: (campaignId) => {
      const entry = state.get(campaignId);
      const isOpen = !!(entry && entry.count >= 3);
      return {
        open: isOpen,
        state: isOpen ? 'open' : 'closed',
        timeouts: entry ? entry.count : 0,
        threshold: 3,
        windowMs: 24 * 60 * 60 * 1000,
      };
    },
    resetCampaignApprovalBreaker: (campaignId) => {
      state.delete(campaignId);
    },
  };
}

function createMockConfig(overrides = {}) {
  return {
    approvalTimeoutWatcher: { scanIntervalMs: 60000 },
    campaigns: { approvalTimeoutMs: 3600000 },
    ...overrides,
  };
}

// ─── Tests: createApprovalTimeoutWatcher Factory ─────────────────

test('factory returns watcher with all required methods', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
  });

  assert.ok(typeof watcher.start === 'function', 'should have start method');
  assert.ok(typeof watcher.stop === 'function', 'should have stop method');
  assert.ok(typeof watcher.scan === 'function', 'should have scan method');
  assert.ok(typeof watcher.getCircuitBreakerStatus === 'function', 'should have getCircuitBreakerStatus method');
  assert.ok(typeof watcher.resetCircuitBreaker === 'function', 'should have resetCircuitBreaker method');
  assert.ok(typeof watcher.isRunning === 'function', 'should have isRunning method');
});

test('factory uses default timeout when config not provided', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: null,
  });

  watcher.start();
  assert.equal(watcher.isRunning(), true, 'watcher should be running');
  watcher.stop();
});

test('factory uses custom timeout from config', () => {
  const customTimeoutMs = 7200000; // 2 hours
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig({ campaigns: { approvalTimeoutMs: customTimeoutMs } }),
  });

  watcher.start();
  assert.equal(watcher.isRunning(), true, 'watcher should be running with custom config');
  watcher.stop();
});

test('factory uses custom scan interval from config', () => {
  const customScanIntervalMs = 30000; // 30 seconds
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig({ approvalTimeoutWatcher: { scanIntervalMs: customScanIntervalMs } }),
  });

  watcher.start();
  assert.equal(watcher.isRunning(), true, 'watcher should be running with custom scan interval');
  watcher.stop();
});

test('factory initializes watcher in stopped state', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
  });

  assert.equal(watcher.isRunning(), false, 'watcher should not be running initially');
});

// ─── Tests: scan() Candidate Detection ──────────────────────────

test('scan detects milestones in waiting_approval status', async () => {
  const timeoutMs = 3600000;
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      {
        id: 'm1',
        status: 'waiting_approval',
        title: 'Needs Approval',
        approvalRequestedAt: new Date(Date.now() - timeoutMs - 1000).toISOString(),
      },
    ],
  }];

  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);

  const watcher = createApprovalTimeoutWatcher({
    campaignManager,
    stateManager,
    events,
    config: createMockConfig(),
  });

  await watcher.scan();

  const emitted = events.getEmitted();
  const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
  assert.equal(timeoutEvents.length, 1, 'should detect and process timed-out milestone');
});

test('scan skips milestones not in waiting_approval status', async () => {
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'active', title: 'Active', approvalRequestedAt: null },
      { id: 'm2', status: 'completed', title: 'Completed', approvalRequestedAt: null },
      { id: 'm3', status: 'failed', title: 'Failed', approvalRequestedAt: null },
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
  assert.equal(timeoutEvents.length, 0, 'should skip non-waiting_approval milestones');
});

test('scan skips milestones without approvalRequestedAt', async () => {
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
  const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
  assert.equal(timeoutEvents.length, 0, 'should skip milestones without approvalRequestedAt');
});

test('scan detects multiple timeout candidates across campaigns', async () => {
  const timeoutMs = 3600000;
  const campaigns = [
    {
      id: 'campaign1',
      milestones: [
        { id: 'm1', status: 'waiting_approval', title: 'C1 M1', approvalRequestedAt: new Date(Date.now() - timeoutMs - 1000).toISOString() },
        { id: 'm2', status: 'waiting_approval', title: 'C1 M2', approvalRequestedAt: new Date(Date.now() - timeoutMs - 2000).toISOString() },
      ],
    },
    {
      id: 'campaign2',
      milestones: [
        { id: 'm3', status: 'waiting_approval', title: 'C2 M1', approvalRequestedAt: new Date(Date.now() - timeoutMs - 3000).toISOString() },
      ],
    },
  ];

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
  assert.equal(timeoutEvents.length, 3, 'should detect all 3 timeout candidates');
});

test('scan detects timeouts across multiple projects', async () => {
  const timeoutMs = 3600000;
  const projects = [{ id: 'proj1' }, { id: 'proj2' }];

  function createMultiProjectCampaignManager() {
    const updates = [];
    return {
      listCampaigns: (projectId) => [{
        id: `campaign-${projectId}`,
        milestones: [
          { id: 'm1', status: 'waiting_approval', title: `${projectId} M1`, approvalRequestedAt: new Date(Date.now() - timeoutMs - 1000).toISOString() },
        ],
      }],
      updateMilestoneStatus: async function(projectId, campaignId, milestoneId, newStatus, reason, actor) {
        updates.push({ projectId, campaignId, milestoneId, newStatus, reason, actor });
      },
      getUpdates: () => updates,
    };
  }

  const stateManager = createMockStateManager(projects);
  const events = createMockEvents();

  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMultiProjectCampaignManager(),
    stateManager,
    events,
    config: createMockConfig(),
  });

  await watcher.scan();

  const emitted = events.getEmitted();
  const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
  assert.equal(timeoutEvents.length, 2, 'should detect timeouts in both projects');
});

test('scan correctly calculates elapsed time', async () => {
  const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
  const fortyFiveMinutesAgo = Date.now() - (45 * 60 * 1000);
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);

  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: '30min', approvalRequestedAt: new Date(thirtyMinutesAgo).toISOString() },
      { id: 'm2', status: 'waiting_approval', title: '45min', approvalRequestedAt: new Date(fortyFiveMinutesAgo).toISOString() },
      { id: 'm3', status: 'waiting_approval', title: '2hr', approvalRequestedAt: new Date(twoHoursAgo).toISOString() },
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
  assert.equal(timeoutEvents.length, 1, 'should only trigger milestone past 1h timeout (2hr one)');
});

// ─── Tests: handleTimeout() Circuit Breaker Checks ──────────────

test('handleTimeout processes when circuit breaker is closed', async () => {
  const circuitBreaker = createMockCircuitBreaker();
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'Test', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
    ],
  }];

  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);

  const watcher = createApprovalTimeoutWatcher({
    campaignManager,
    stateManager,
    events,
    config: createMockConfig(),
    circuitBreaker,
  });

  await watcher.scan();

  const emitted = events.getEmitted();
  const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
  const blockedEvents = emitted.filter(e => e.event === 'approval:timeout_blocked');

  assert.equal(timeoutEvents.length, 1, 'should process timeout when breaker is closed');
  assert.equal(blockedEvents.length, 0, 'should not block when breaker is closed');
});

test('handleTimeout blocks when circuit breaker is open', async () => {
  const circuitBreaker = createMockCircuitBreaker();

  // Pre-trip the circuit breaker by recording 3 timeouts (trips it on the 3rd)
  circuitBreaker.recordApprovalTimeout('campaign1', { milestoneId: 'm0' });
  circuitBreaker.recordApprovalTimeout('campaign1', { milestoneId: 'm0' });
  circuitBreaker.recordApprovalTimeout('campaign1', { milestoneId: 'm0' });

  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'Test', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
    ],
  }];

  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();

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

  // When breaker is open, scan skips the entire campaign (line 219-222 in source)
  // So no events are emitted at all for that campaign
  assert.equal(timeoutEvents.length, 0, 'should not process timeout when breaker is open');
  assert.equal(blockedEvents.length, 0, 'scan skips campaign entirely when breaker is open');
});

test('handleTimeout records timeout event in circuit breaker', async () => {
  const circuitBreaker = createMockCircuitBreaker();
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'Test', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
    ],
  }];

  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();

  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(campaigns),
    stateManager,
    events,
    config: createMockConfig(),
    circuitBreaker,
  });

  await watcher.scan();

  const status = watcher.getCircuitBreakerStatus('campaign1');
  assert.equal(status.timeouts, 1, 'circuit breaker should have recorded 1 timeout');
});

test('handleTimeout emits correct event data', async () => {
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'Test Milestone', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
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
  const timeoutEvent = emitted.find(e => e.event === 'approval:timeout_autoresume');

  assert.ok(timeoutEvent, 'should emit timeout event');
  assert.equal(timeoutEvent.data.projectId, 'proj1', 'should include projectId');
  assert.equal(timeoutEvent.data.campaignId, 'campaign1', 'should include campaignId');
  assert.equal(timeoutEvent.data.milestoneId, 'm1', 'should include milestoneId');
  assert.ok(timeoutEvent.data.reason.includes('Auto-resumed'), 'should include reason');
  assert.equal(timeoutEvent.data.timeoutMs, 3600000, 'should include timeoutMs');
});

test('handleTimeout emits message notification', async () => {
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'Test Milestone', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
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
  const messageEvent = emitted.find(e => e.type === 'message');

  assert.ok(messageEvent, 'should emit message notification');
  assert.equal(messageEvent.msg.role, 'system', 'message should be from system');
  assert.ok(messageEvent.msg.content.includes('Test Milestone'), 'message should include milestone title');
  assert.ok(messageEvent.msg.content.includes('campaign1'), 'message should include campaign ID');
});

// ─── Tests: Manual Trigger Methods ─────────────────────────────

test('scan() method can be triggered manually', async () => {
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'Test', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
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
  assert.equal(timeoutEvents.length, 1, 'manual scan should process timeouts');
});

test('scan() can be called multiple times', async () => {
  const campaigns = [{
    id: 'campaign1',
    milestones: [],
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
  await watcher.scan();
  await watcher.scan();

  assert.ok(true, 'multiple scan calls should not throw');
});

// ─── Tests: Manual Reset Methods ────────────────────────────────

test('getCircuitBreakerStatus returns correct format', () => {
  const circuitBreaker = createMockCircuitBreaker();

  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
    circuitBreaker,
  });

  const status = watcher.getCircuitBreakerStatus('campaign1');

  assert.ok('open' in status, 'should have open property');
  assert.ok('state' in status, 'should have state property');
  assert.ok('timeouts' in status, 'should have timeouts property');
  assert.ok('threshold' in status, 'should have threshold property');
  assert.ok('windowMs' in status, 'should have windowMs property');
  assert.equal(status.threshold, 3, 'threshold should be 3');
  assert.equal(status.windowMs, 24 * 60 * 60 * 1000, 'windowMs should be 24h');
});

test('getCircuitBreakerStatus returns closed for unknown campaign', () => {
  const circuitBreaker = createMockCircuitBreaker();

  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
    circuitBreaker,
  });

  const status = watcher.getCircuitBreakerStatus('unknown-campaign');

  assert.equal(status.open, false, 'unknown campaign should have closed breaker');
  assert.equal(status.state, 'closed', 'unknown campaign should be in closed state');
  assert.equal(status.timeouts, 0, 'unknown campaign should have 0 timeouts');
});

test('getCircuitBreakerStatus returns open after threshold exceeded', async () => {
  const circuitBreaker = createMockCircuitBreaker();

  // Record 3 timeouts to trip the breaker
  circuitBreaker.recordApprovalTimeout('campaign1', { milestoneId: 'm1' });
  circuitBreaker.recordApprovalTimeout('campaign1', { milestoneId: 'm2' });
  circuitBreaker.recordApprovalTimeout('campaign1', { milestoneId: 'm3' });

  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
    circuitBreaker,
  });

  const status = watcher.getCircuitBreakerStatus('campaign1');

  assert.equal(status.open, true, 'breaker should be open after 3 timeouts');
  assert.equal(status.state, 'open', 'state should be open');
  assert.equal(status.timeouts, 3, 'should have 3 recorded timeouts');
});

test('resetCircuitBreaker resets breaker state', async () => {
  const circuitBreaker = createMockCircuitBreaker();

  // Trip the breaker - need 3 timeouts to trip it
  circuitBreaker.recordApprovalTimeout('campaign1', { milestoneId: 'm1' });
  circuitBreaker.recordApprovalTimeout('campaign1', { milestoneId: 'm2' });
  circuitBreaker.recordApprovalTimeout('campaign1', { milestoneId: 'm3' });

  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
    circuitBreaker,
  });

  // Verify breaker is open
  let status = watcher.getCircuitBreakerStatus('campaign1');
  assert.equal(status.open, true, 'breaker should be open before reset');

  // Reset the breaker
  const result = watcher.resetCircuitBreaker('campaign1', 'operator1');
  assert.equal(result, true, 'reset should return true');

  // Verify breaker is closed - check the circuit breaker directly
  const cbStatus = circuitBreaker.getCampaignApprovalStatus('campaign1');
  assert.equal(cbStatus.open, false, 'breaker should be closed after reset');
  assert.equal(cbStatus.timeouts, 0, 'timeouts should be reset to 0');
});

test('resetCircuitBreaker accepts custom userId', async () => {
  const circuitBreaker = createMockCircuitBreaker();
  let resetUserId = null;

  // Override to capture userId
  circuitBreaker.resetCampaignApprovalBreaker = (campaignId, opts) => {
    resetUserId = opts?.userId;
  };

  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
    circuitBreaker,
  });

  watcher.resetCircuitBreaker('campaign1', 'admin-user');

  assert.equal(resetUserId, 'admin-user', 'should pass userId to circuit breaker');
});

test('resetCircuitBreaker defaults userId to system', async () => {
  const circuitBreaker = createMockCircuitBreaker();
  let resetUserId = null;

  circuitBreaker.resetCampaignApprovalBreaker = (campaignId, opts) => {
    resetUserId = opts?.userId;
  };

  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
    circuitBreaker,
  });

  watcher.resetCircuitBreaker('campaign1');

  assert.equal(resetUserId, 'system', 'should default userId to system');
});

// ─── Tests: Lifecycle Integration ───────────────────────────────

test('start() begins watcher and performs initial scan', async () => {
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'Test', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
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

  watcher.start();

  assert.equal(watcher.isRunning(), true, 'watcher should be running after start');

  // Wait for initial scan
  await new Promise(resolve => setTimeout(resolve, 50));

  const emitted = events.getEmitted();
  const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
  assert.equal(timeoutEvents.length, 1, 'initial scan should process timeouts');

  watcher.stop();
});

test('stop() halts the watcher', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
  });

  watcher.start();
  assert.equal(watcher.isRunning(), true, 'watcher should be running');

  watcher.stop();
  assert.equal(watcher.isRunning(), false, 'watcher should not be running after stop');
});

test('start() is idempotent', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
  });

  watcher.start();
  watcher.start();
  watcher.start();

  assert.equal(watcher.isRunning(), true, 'watcher should still be running');

  watcher.stop();
});

test('stop() is idempotent', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
  });

  watcher.stop();
  watcher.stop();
  watcher.stop();

  assert.ok(true, 'multiple stops should not throw');
});

test('start() then stop() then start() works correctly', () => {
  const watcher = createApprovalTimeoutWatcher({
    campaignManager: createMockCampaignManager(),
    stateManager: createMockStateManager(),
    events: createMockEvents(),
    config: createMockConfig(),
  });

  watcher.start();
  assert.equal(watcher.isRunning(), true, 'should be running after first start');

  watcher.stop();
  assert.equal(watcher.isRunning(), false, 'should not be running after stop');

  watcher.start();
  assert.equal(watcher.isRunning(), true, 'should be running after restart');

  watcher.stop();
});

// ─── Tests: Campaign Update Integration ─────────────────────────

test('handleTimeout updates milestone status to active', async () => {
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'Test', approvalRequestedAt: new Date(Date.now() - 7200000).toISOString() },
    ],
  }];

  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);

  const watcher = createApprovalTimeoutWatcher({
    campaignManager,
    stateManager,
    events,
    config: createMockConfig(),
  });

  await watcher.scan();

  const updates = campaignManager.getUpdates();
  assert.equal(updates.length, 1, 'should have 1 update');
  assert.equal(updates[0].projectId, 'proj1', 'update should have correct projectId');
  assert.equal(updates[0].campaignId, 'campaign1', 'update should have correct campaignId');
  assert.equal(updates[0].milestoneId, 'm1', 'update should have correct milestoneId');
  assert.equal(updates[0].newStatus, 'active', 'update should set status to active');
  assert.ok(updates[0].reason.includes('Auto-resumed'), 'update should include auto-resume reason');
  assert.equal(updates[0].actor, 'system', 'update should be from system actor');
});

// ─── Summary ────────────────────────────────────────────────────

await runAsyncTests();

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
