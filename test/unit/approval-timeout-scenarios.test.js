// test/unit/approval-timeout-scenarios.test.js
// Unit tests for approval timeout scenarios with mocked Date.now()
// Tests: 24h timeout boundary conditions, circuit breaker tripping, timeout auto-resume

import { strict as assert } from 'assert';
import { createApprovalTimeoutWatcher } from '../../src/orchestrator/approval-timeout-watcher.js';
import { CircuitBreaker, STATES } from '../../src/orchestrator/circuit-breaker.js';

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
        if (err.stack) console.log('    ' + err.stack.split('\n').slice(1, 3).join('\n    '));
      });
    } else {
      fn();
      passed++;
      console.log(`  ✓ ${name}`);
    }
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
    if (err.stack) console.log('    ' + err.stack.split('\n').slice(1, 3).join('\n    '));
  }
}

async function runAsyncTests() {
  await new Promise(resolve => setTimeout(resolve, 200));
}

console.log('test/unit/approval-timeout-scenarios.test.js');

// ─── Mock Dependencies ──────────────────────────────────────────

function createMockStateManager(projects = []) {
  return {
    projectsDir: '/tmp/test-projects',
    listProjects: () => projects,
    getProjectDir: (pid) => `/tmp/test-projects/${pid}`,
  };
}

function createMockCampaignManager(campaigns = [], updateFn = null) {
  const updateTracker = [];
  return {
    listCampaigns: (projectId, status) => campaigns,
    getCampaign: (projectId, campaignId) => campaigns.find(c => c.id === campaignId),
    updateMilestoneStatus: updateFn || async function(projectId, campaignId, milestoneId, newStatus, reason, actor) {
      updateTracker.push({ projectId, campaignId, milestoneId, newStatus, reason, actor });
      const campaign = campaigns.find(c => c.id === campaignId);
      if (campaign) {
        const milestone = campaign.milestones.find(m => m.id === milestoneId);
        if (milestone) {
          milestone.status = newStatus;
          milestone.updatedAt = new Date().toISOString();
        }
      }
    },
    _saveWithRetryScoped: async function(projectId, actor, findFn, updateFn) {
      const campaign = findFn({ campaigns });
      if (campaign) {
        updateFn({ campaigns });
      }
    },
    getUpdateTracker: () => updateTracker,
  };
}

function createMockEvents() {
  const emitted = [];
  return {
    emit: (event, data) => {
      emitted.push({ event, data });
      return Promise.resolve();
    },
    emitMessage: (msg) => emitted.push({ type: 'message', msg }),
    on: (event, handler) => {
      emitted.push({ listener: { event, handler } });
      return { removeListener: () => {} };
    },
    getEmitted: () => emitted,
    clear: () => emitted.length = 0,
  };
}

function createMockConfig(overrides = {}) {
  return {
    approvalTimeoutWatcher: { scanIntervalMs: 60000 },
    campaigns: { 
      approvalTimeoutMs: 24 * 60 * 60 * 1000, // 24h default
      ...overrides,
    },
    ...overrides,
  };
}

// ─── Tests: 24h Timeout Boundary Conditions ─────────────────────

test('milestone exactly at 24h boundary is NOT triggered (strictly greater than)', async () => {
  const fixedNow = 1712800000000; // Fixed timestamp for reproducibility
  const timeoutMs = 24 * 60 * 60 * 1000; // 24h
  const approvalTime = new Date(fixedNow - timeoutMs).toISOString();
  
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { 
        id: 'm1', 
        status: 'waiting_approval', 
        title: 'At 24h boundary', 
        approvalRequestedAt: approvalTime,
      },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);
  
  // Mock Date.now() to return fixed time
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  
  try {
    const watcher = createApprovalTimeoutWatcher({
      campaignManager,
      stateManager,
      events,
      config: createMockConfig(),
    });
    
    await watcher.scan();
    
    const emitted = events.getEmitted();
    const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
    
    // elapsed = fixedNow - (fixedNow - 24h) = 24h, which is NOT > 24h
    // So it should NOT trigger
    assert.equal(timeoutEvents.length, 0, 
      'should NOT trigger at exact 24h boundary (requires strictly greater than)');
    
    const updateTracker = campaignManager.getUpdateTracker();
    assert.equal(updateTracker.length, 0, 
      'should not update milestone status when at exact boundary');
  } finally {
    Date.now = originalDateNow;
  }
});

test('milestone 1ms past 24h boundary IS triggered', async () => {
  const timeoutMs = 24 * 60 * 60 * 1000; // 24h
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { 
        id: 'm1', 
        status: 'waiting_approval', 
        title: '1ms past 24h', 
        approvalRequestedAt: new Date(Date.now() - timeoutMs - 1).toISOString(),
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
  
  assert.equal(timeoutEvents.length, 1, 
    'should trigger 1ms past 24h boundary');
  assert.equal(timeoutEvents[0].data.milestoneId, 'm1',
    'timeout event should reference correct milestone');
  assert.ok(timeoutEvents[0].data.reason?.includes('timeout') || timeoutEvents[0].data.reason?.includes('Auto-resumed'),
    'reason should mention timeout or auto-resume');
});

test('milestone at 23h 59m 59s is NOT triggered', async () => {
  const fixedNow = 1712800000000;
  const timeoutMs = 24 * 60 * 60 * 1000; // 24h
  const elapsed = timeoutMs - 1000; // 23h 59m 59s
  const approvalTime = new Date(fixedNow - elapsed).toISOString();
  
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { 
        id: 'm1', 
        status: 'waiting_approval', 
        title: 'Just under 24h', 
        approvalRequestedAt: approvalTime,
      },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);
  
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  
  try {
    const watcher = createApprovalTimeoutWatcher({
      campaignManager,
      stateManager,
      events,
      config: createMockConfig(),
    });
    
    await watcher.scan();
    
    const emitted = events.getEmitted();
    const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
    
    assert.equal(timeoutEvents.length, 0, 
      'should NOT trigger at 23h 59m 59s (under 24h threshold)');
  } finally {
    Date.now = originalDateNow;
  }
});

test('milestone at 25h IS triggered', async () => {
  const fixedNow = 1712800000000;
  const timeoutMs = 24 * 60 * 60 * 1000; // 24h
  const elapsed = timeoutMs + 60 * 60 * 1000; // 25h
  const approvalTime = new Date(fixedNow - elapsed).toISOString();
  
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { 
        id: 'm1', 
        status: 'waiting_approval', 
        title: '25h past', 
        approvalRequestedAt: approvalTime,
      },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);
  
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  
  try {
    const watcher = createApprovalTimeoutWatcher({
      campaignManager,
      stateManager,
      events,
      config: createMockConfig(),
    });
    
    await watcher.scan();
    
    const emitted = events.getEmitted();
    const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
    
    assert.equal(timeoutEvents.length, 1, 
      'should trigger at 25h (over 24h threshold)');
  } finally {
    Date.now = originalDateNow;
  }
});

test('multiple milestones with varying ages are processed correctly', async () => {
  const fixedNow = 1712800000000;
  const timeoutMs = 24 * 60 * 60 * 1000; // 24h
  
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { 
        id: 'm1', 
        status: 'waiting_approval', 
        title: '23h old', 
        approvalRequestedAt: new Date(fixedNow - (timeoutMs - 3600000)).toISOString(),
      },
      { 
        id: 'm2', 
        status: 'waiting_approval', 
        title: '24h exactly', 
        approvalRequestedAt: new Date(fixedNow - timeoutMs).toISOString(),
      },
      { 
        id: 'm3', 
        status: 'waiting_approval', 
        title: '24h 1m old', 
        approvalRequestedAt: new Date(fixedNow - timeoutMs - 60000).toISOString(),
      },
      { 
        id: 'm4', 
        status: 'waiting_approval', 
        title: '48h old', 
        approvalRequestedAt: new Date(fixedNow - (timeoutMs * 2)).toISOString(),
      },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);
  
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  
  try {
    const watcher = createApprovalTimeoutWatcher({
      campaignManager,
      stateManager,
      events,
      config: createMockConfig(),
    });
    
    await watcher.scan();
    
    const emitted = events.getEmitted();
    const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
    
    // Only m3 (24h 1m) and m4 (48h) should trigger
    assert.equal(timeoutEvents.length, 2, 
      'should only trigger for milestones over 24h (m3 and m4)');
    
    const triggeredIds = timeoutEvents.map(e => e.data.milestoneId).sort();
    assert.deepEqual(triggeredIds, ['m3', 'm4'], 
      'should trigger for m3 and m4 only');
  } finally {
    Date.now = originalDateNow;
  }
});

// ─── Tests: Circuit Breaker Tripping After 3 Consecutive Timeouts ──────────

test('circuit breaker trips open after 3 consecutive timeouts in 24h window', async () => {
  const fixedNow = 1712800000000;
  const timeoutMs = 24 * 60 * 60 * 1000;
  const approvalTime = new Date(fixedNow - timeoutMs - 1000).toISOString();
  
  // Create 5 milestones that will all timeout
  const milestones = [];
  for (let i = 1; i <= 5; i++) {
    milestones.push({
      id: `m${i}`,
      status: 'waiting_approval',
      title: `Milestone ${i}`,
      approvalRequestedAt: approvalTime,
    });
  }
  
  const campaigns = [{ id: 'campaign1', milestones }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);
  
  const circuitBreaker = new CircuitBreaker({
    approvalTimeoutThreshold: 3,
    approvalTimeoutWindowMs: 24 * 60 * 60 * 1000,
    events,
  });
  
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  
  try {
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
    
    // m1: count=0→1, processed
    // m2: count=1→2, processed
    // m3: count=2→3, recorded but breaker trips, re-check blocks it
    // m4, m5: breaker already open, blocked immediately
    assert.equal(timeoutEvents.length, 2, 
      'should process 2 timeouts before breaker trips on 3rd');
    assert.equal(blockedEvents.length, 3, 
      'should block 3 timeouts after breaker trips (including 3rd)');
    
    // Verify circuit breaker state
    const status = circuitBreaker.getCampaignApprovalStatus('campaign1');
    assert.equal(status.state, STATES.OPEN, 
      'circuit breaker should be in OPEN state after 3 timeouts');
    assert.equal(status.timeouts, 3, 
      'should have recorded 3 timeouts');
    assert.ok(status.openedAt, 
      'openedAt should be set');
  } finally {
    Date.now = originalDateNow;
  }
});

test('circuit breaker is per-campaign (not global)', async () => {
  const fixedNow = 1712800000000;
  const timeoutMs = 24 * 60 * 60 * 1000;
  const approvalTime = new Date(fixedNow - timeoutMs - 1000).toISOString();
  
  const campaigns = [
    {
      id: 'campaign1',
      milestones: [
        { id: 'm1', status: 'waiting_approval', title: 'C1 M1', approvalRequestedAt: approvalTime },
        { id: 'm2', status: 'waiting_approval', title: 'C1 M2', approvalRequestedAt: approvalTime },
        { id: 'm3', status: 'waiting_approval', title: 'C1 M3', approvalRequestedAt: approvalTime },
        { id: 'm4', status: 'waiting_approval', title: 'C1 M4', approvalRequestedAt: approvalTime },
      ],
    },
    {
      id: 'campaign2',
      milestones: [
        { id: 'm5', status: 'waiting_approval', title: 'C2 M1', approvalRequestedAt: approvalTime },
        { id: 'm6', status: 'waiting_approval', title: 'C2 M2', approvalRequestedAt: approvalTime },
      ],
    },
  ];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);
  
  const circuitBreaker = new CircuitBreaker({
    approvalTimeoutThreshold: 3,
    approvalTimeoutWindowMs: 24 * 60 * 60 * 1000,
    events,
  });
  
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  
  try {
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
    
    // Campaign1: m1→processed, m2→processed, m3→trips breaker (blocked on re-check), m4→blocked
    // Campaign2: m5→processed, m6→processed (separate breaker, count=2, not tripped)
    assert.equal(timeoutEvents.length, 4, 
      'should process 2 from C1 + 2 from C2 = 4 total');
    assert.equal(blockedEvents.length, 2, 
      'should block 2 from C1 (m3 trips, m4 blocked)');
    
    // Verify C1 is open, C2 is closed
    const c1Status = circuitBreaker.getCampaignApprovalStatus('campaign1');
    const c2Status = circuitBreaker.getCampaignApprovalStatus('campaign2');
    
    assert.equal(c1Status.state, STATES.OPEN, 
      'C1 circuit breaker should be OPEN');
    assert.equal(c2Status.state, STATES.CLOSED, 
      'C2 circuit breaker should be CLOSED (only 2 timeouts)');
  } finally {
    Date.now = originalDateNow;
  }
});

test('circuit breaker resets after operator manual reset', async () => {
  const fixedNow = 1712800000000;
  const timeoutMs = 24 * 60 * 60 * 1000;
  const approvalTime = new Date(fixedNow - timeoutMs - 1000).toISOString();
  
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'M1', approvalRequestedAt: approvalTime },
      { id: 'm2', status: 'waiting_approval', title: 'M2', approvalRequestedAt: approvalTime },
      { id: 'm3', status: 'waiting_approval', title: 'M3', approvalRequestedAt: approvalTime },
      { id: 'm4', status: 'waiting_approval', title: 'M4', approvalRequestedAt: approvalTime },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);
  
  const circuitBreaker = new CircuitBreaker({
    approvalTimeoutThreshold: 3,
    approvalTimeoutWindowMs: 24 * 60 * 60 * 1000,
    events,
  });
  
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  
  try {
    const watcher = createApprovalTimeoutWatcher({
      campaignManager,
      stateManager,
      events,
      config: createMockConfig(),
      circuitBreaker,
    });
    
    // First scan - should trip breaker on 3rd timeout
    await watcher.scan();
    
    let emitted = events.getEmitted();
    let timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
    assert.equal(timeoutEvents.length, 2, 
      'should process 2 timeouts before breaker trips');
    
    // Check breaker is open
    const statusBeforeReset = watcher.getCircuitBreakerStatus('campaign1');
    assert.equal(statusBeforeReset.state, STATES.OPEN, 
      'breaker should be OPEN after first scan');
    
    // Reset breaker
    const resetResult = watcher.resetCircuitBreaker('campaign1', 'operator1');
    assert.equal(resetResult, true, 
      'should successfully reset breaker');
    
    // Verify breaker is closed
    const statusAfterReset = watcher.getCircuitBreakerStatus('campaign1');
    assert.equal(statusAfterReset.state, STATES.CLOSED, 
      'breaker should be CLOSED after reset');
    assert.equal(statusAfterReset.timeouts, 0, 
      'timeout count should be 0 after reset');
    
    // Clear events and run another scan
    events.clear();
    campaignManager.getUpdateTracker().length = 0;
    
    // Remaining milestones (m4) should now be processed
    await watcher.scan();
    
    emitted = events.getEmitted();
    timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
    
    // m4 should be processed now (breaker reset, count=0→1)
    assert.ok(timeoutEvents.length >= 1, 
      'should process remaining timeouts after reset');
  } finally {
    Date.now = originalDateNow;
  }
});

test('circuit breaker allows new timeouts after window expires', async () => {
  const timeoutMs = 24 * 60 * 60 * 1000;
  const windowMs = 24 * 60 * 60 * 1000;
  
  const circuitBreaker = new CircuitBreaker({
    approvalTimeoutThreshold: 3,
    approvalTimeoutWindowMs: windowMs,
    events: createMockEvents(),
  });
  
  const now = 1712800000000;
  const originalDateNow = Date.now;
  
  // Record 3 timeouts at time T
  Date.now = () => now;
  circuitBreaker.recordApprovalTimeout('campaign1', { milestoneId: 'm1' });
  circuitBreaker.recordApprovalTimeout('campaign1', { milestoneId: 'm2' });
  circuitBreaker.recordApprovalTimeout('campaign1', { milestoneId: 'm3' });
  
  // Breaker should be open
  assert.equal(circuitBreaker.canCampaignRequestApproval('campaign1'), false,
    'breaker should be open after 3 timeouts');
  
  // Advance time past the window (24h + 1 second)
  const afterWindow = now + windowMs + 1000;
  Date.now = () => afterWindow;
  
  // Old timeouts should have expired
  const status = circuitBreaker.getCampaignApprovalStatus('campaign1');
  assert.equal(status.timeouts, 0, 
    'timeout count should be 0 after window expires');
  assert.equal(status.state, STATES.CLOSED, 
    'breaker should be CLOSED after timeouts expire');
  assert.equal(circuitBreaker.canCampaignRequestApproval('campaign1'), true,
    'should allow new approvals after window expires');
  
  Date.now = originalDateNow;
});

// ─── Tests: Timeout Auto-Resume Transitions ─────────────────────

test('timeout auto-resume transitions milestone from waiting_approval to active', async () => {
  const fixedNow = 1712800000000;
  const timeoutMs = 24 * 60 * 60 * 1000;
  const approvalTime = new Date(fixedNow - timeoutMs - 1000).toISOString();
  
  const milestones = [{
    id: 'm1',
    status: 'waiting_approval',
    title: 'To be auto-resumed',
    approvalRequestedAt: approvalTime,
  }];
  
  const campaigns = [{ id: 'campaign1', milestones }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);
  
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  
  try {
    const watcher = createApprovalTimeoutWatcher({
      campaignManager,
      stateManager,
      events,
      config: createMockConfig(),
    });
    
    await watcher.scan();
    
    // Verify milestone was updated to active
    const updateTracker = campaignManager.getUpdateTracker();
    assert.ok(updateTracker.length > 0, 
      'should have at least one status update');
    
    const update = updateTracker.find(u => u.milestoneId === 'm1');
    assert.ok(update, 
      'should have update for milestone m1');
    assert.equal(update.newStatus, 'active', 
      'milestone should transition to active status');
    assert.ok(update.reason?.includes('timeout') || update.reason?.includes('Auto-resumed'),
      'reason should mention timeout or auto-resume');
    assert.equal(update.actor, 'system', 
      'actor should be system for auto-resume');
    
    // Verify milestone object was updated
    const milestone = campaigns[0].milestones.find(m => m.id === 'm1');
    assert.equal(milestone.status, 'active',
      'milestone status should be active after update');
  } finally {
    Date.now = originalDateNow;
  }
});

test('timeout auto-resume sets approvalState to timeout before transition', async () => {
  const fixedNow = 1712800000000;
  const timeoutMs = 24 * 60 * 60 * 1000;
  const approvalTime = new Date(fixedNow - timeoutMs - 1000).toISOString();
  
  const milestones = [{
    id: 'm1',
    status: 'waiting_approval',
    title: 'Timeout milestone',
    approvalRequestedAt: approvalTime,
    approvalState: 'pending',
  }];
  
  const campaigns = [{ id: 'campaign1', milestones }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);
  
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  
  try {
    const watcher = createApprovalTimeoutWatcher({
      campaignManager,
      stateManager,
      events,
      config: createMockConfig(),
    });
    
    await watcher.scan();
    
    // Verify approvalState was set to timeout
    const milestone = campaigns[0].milestones.find(m => m.id === 'm1');
    assert.equal(milestone.approvalState, 'timeout',
      'approvalState should be set to timeout');
  } finally {
    Date.now = originalDateNow;
  }
});

test('timeout auto-resume emits notification event with correct schema', async () => {
  const fixedNow = 1712800000000;
  const timeoutMs = 24 * 60 * 60 * 1000;
  const approvalTime = new Date(fixedNow - timeoutMs - 1000).toISOString();
  
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { 
        id: 'm1', 
        status: 'waiting_approval', 
        title: 'Notification test', 
        approvalRequestedAt: approvalTime,
      },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);
  
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  
  try {
    const watcher = createApprovalTimeoutWatcher({
      campaignManager,
      stateManager,
      events,
      config: createMockConfig(),
    });
    
    await watcher.scan();
    
    const emitted = events.getEmitted();
    const timeoutEvent = emitted.find(e => e.event === 'approval:timeout_autoresume');
    
    assert.ok(timeoutEvent, 
      'should emit approval:timeout_autoresume event');
    
    // Verify event schema
    assert.equal(timeoutEvent.data.projectId, 'proj1',
      'event should include projectId');
    assert.equal(timeoutEvent.data.campaignId, 'campaign1',
      'event should include campaignId');
    assert.equal(timeoutEvent.data.milestoneId, 'm1',
      'event should include milestoneId');
    assert.ok(timeoutEvent.data.reason,
      'event should include reason');
    assert.equal(timeoutEvent.data.timeoutMs, timeoutMs,
      'event should include timeoutMs');
  } finally {
    Date.now = originalDateNow;
  }
});

test('timeout auto-resume emits chat message when emitMessage is available', async () => {
  const fixedNow = 1712800000000;
  const timeoutMs = 24 * 60 * 60 * 1000;
  const approvalTime = new Date(fixedNow - timeoutMs - 1000).toISOString();
  
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { 
        id: 'm1', 
        status: 'waiting_approval', 
        title: 'Chat notification test', 
        approvalRequestedAt: approvalTime,
      },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);
  
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  
  try {
    const watcher = createApprovalTimeoutWatcher({
      campaignManager,
      stateManager,
      events,
      config: createMockConfig(),
    });
    
    await watcher.scan();
    
    const emitted = events.getEmitted();
    const chatMessage = emitted.find(e => e.type === 'message');
    
    assert.ok(chatMessage, 
      'should emit chat message for timeout auto-resume');
    assert.equal(chatMessage.msg.role, 'system',
      'message should be from system role');
    assert.ok(chatMessage.msg.content?.includes('Approval Timeout'),
      'message content should mention approval timeout');
    assert.ok(chatMessage.msg.content?.includes('m1') || chatMessage.msg.content?.includes('Chat notification test'),
      'message should reference milestone');
  } finally {
    Date.now = originalDateNow;
  }
});

// ─── Tests: Edge Cases ──────────────────────────────────────────

test('milestones without approvalRequestedAt are skipped', async () => {
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'waiting_approval', title: 'No timestamp' },
      { id: 'm2', status: 'waiting_approval', title: 'Null timestamp', approvalRequestedAt: null },
      { id: 'm3', status: 'waiting_approval', title: 'Undefined timestamp', approvalRequestedAt: undefined },
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
  
  assert.equal(timeoutEvents.length, 0, 
    'should skip all milestones without valid approvalRequestedAt');
});

test('milestones not in waiting_approval status are skipped', async () => {
  const fixedNow = 1712800000000;
  const timeoutMs = 24 * 60 * 60 * 1000;
  const approvalTime = new Date(fixedNow - timeoutMs - 1000).toISOString();
  
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { id: 'm1', status: 'active', title: 'Active', approvalRequestedAt: approvalTime },
      { id: 'm2', status: 'completed', title: 'Completed', approvalRequestedAt: approvalTime },
      { id: 'm3', status: 'pending', title: 'Pending', approvalRequestedAt: approvalTime },
      { id: 'm4', status: 'waiting_approval', title: 'Waiting', approvalRequestedAt: approvalTime },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);
  
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  
  try {
    const watcher = createApprovalTimeoutWatcher({
      campaignManager,
      stateManager,
      events,
      config: createMockConfig(),
    });
    
    await watcher.scan();
    
    const emitted = events.getEmitted();
    const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
    
    assert.equal(timeoutEvents.length, 1, 
      'should only process m4 which is in waiting_approval status');
    assert.equal(timeoutEvents[0].data.milestoneId, 'm4',
      'should only trigger for m4');
  } finally {
    Date.now = originalDateNow;
  }
});

test('custom timeout configuration is respected', async () => {
  const fixedNow = 1712800000000;
  const customTimeoutMs = 12 * 60 * 60 * 1000; // 12h custom timeout
  const approvalTime = new Date(fixedNow - customTimeoutMs - 1000).toISOString();
  
  const campaigns = [{
    id: 'campaign1',
    milestones: [
      { 
        id: 'm1', 
        status: 'waiting_approval', 
        title: 'Custom timeout test', 
        approvalRequestedAt: approvalTime,
      },
    ],
  }];
  
  const stateManager = createMockStateManager([{ id: 'proj1' }]);
  const events = createMockEvents();
  const campaignManager = createMockCampaignManager(campaigns);
  
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  
  try {
    const watcher = createApprovalTimeoutWatcher({
      campaignManager,
      stateManager,
      events,
      config: createMockConfig({ approvalTimeoutMs: customTimeoutMs }),
    });
    
    await watcher.scan();
    
    const emitted = events.getEmitted();
    const timeoutEvents = emitted.filter(e => e.event === 'approval:timeout_autoresume');
    
    assert.equal(timeoutEvents.length, 1, 
      'should trigger based on custom 12h timeout');
    assert.equal(timeoutEvents[0].data.timeoutMs, customTimeoutMs,
      'event should include custom timeoutMs value');
  } finally {
    Date.now = originalDateNow;
  }
});

// ─── Summary ────────────────────────────────────────────────────

await runAsyncTests();

console.log(`\n====================================`);
console.log(`Approval Timeout Scenario Tests passed: ${passed}`);
console.log(`Approval Timeout Scenario Tests failed: ${failed}`);
console.log(`Total tests: ${passed + failed}`);
console.log('====================================');

if (failed > 0) {
  process.exit(1);
}
