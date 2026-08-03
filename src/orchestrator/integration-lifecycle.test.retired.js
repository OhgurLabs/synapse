// RETIRED 2026-08-01 (renamed out of the *.test.js glob — 0/6 passing).
//
// This harness predates two architectural shifts and cannot pass without a
// ground-up rewrite:
//   - e411d713 made planning fire-and-forget (planTask runs in background;
//     the harness's synchronous tick assumes inline planning and races it)
//   - 77dc6195 moved subtask execution to agent pull loops; the harness has
//     no idle loops, so subtasks can never advance past 'queued'
// Production task advancement was verified healthy by live probe when this
// was diagnosed (see vault/audit/codebase-audit-2026-07-31-passes-1-3.md).
// A replacement harness must drive the pull loop directly (agent-cookies
// pickup path) rather than simulating ticks.
//
// integration-lifecycle.test.js — E2E integration tests for campaign lifecycle,
// webhook delivery, and cron/scheduler execution against a real orchestrator.
//
// Uses real state persistence (tmp dirs), real EventBus, real TaskManager +
// CampaignManager + ScheduleManager. Only agents are mocked (with pushResponse queues).

import { strict as assert } from 'assert';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StateManager } from '../state.js';
import { TaskManager, routeSubtask } from '../tasks.js';
import { CampaignManager } from '../campaigns.js';
import { EventBus } from '../events.js';
import { createLifecycleSystem } from './lifecycle.js';

// Suppress noisy log output during tests
const savedLogLevel = process.env.SYNAPSE_LOG_LEVEL;
process.env.SYNAPSE_LOG_LEVEL = 'error';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}: ${err.message}`);
  }
}

console.log('orchestrator/integration-lifecycle.test.js');

// ─── Helpers ─────────────────────────────────────────────────────

function mockAgent(id, opts = {}) {
  const responses = [];
  const provider = opts.provider || 'claude';
  return {
    id,
    name: opts.name || id,
    provider,
    role: opts.role || 'developer',
    model: opts.model || `${provider}-${id}-mock`,
    skills: opts.skills || [],
    pushResponse(text) { responses.push(text); },
    async send() {
      if (responses.length > 0) return responses.shift();
      return `Default response from ${id}`;
    },
  };
}

function makeConfig(overrides = {}) {
  return {
    tasks: {
      heartbeatIntervalMs: 100000,
      planningTimeoutMs: 5000,
      planningMaxTurns: 5,
      executionMaxTurns: 5,
      executionTimeouts: { claude: 5000 },
      maxConcurrentTasks: 10,
      stuckSubtaskTimeoutMs: 600000,
      audit: { interval: 0, onFailure: false },
      review: { maxFixCycles: 0, structuredFindings: false },
      daemon: { rePlanInterval: 5 },
      ...(overrides.tasks || {}),
    },
    permissions: { enforce: false, auditLog: false },
    git: { autoCommit: false, commitStateFiles: false, synapseRepoDir: '/tmp' },
  };
}

/**
 * Set up a full test environment with real persistence and real EventBus.
 * Returns all managers, lifecycle system, and event collectors.
 */
function setupTestEnv(agentMap, configOverrides = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'synapse-lifecycle-int-'));
  const sm = new StateManager(tmpDir);
  sm.init();
  sm.createProject('test-proj', {
    displayName: 'Test Project',
    projectDir: tmpDir,
    channels: ['general'],
  });

  const taskManager = new TaskManager(sm);
  const campaignManager = new CampaignManager(sm);
  const eventBus = new EventBus();
  const collectedEvents = [];

  // Wire up event hooks so TaskManager/CampaignManager emit through real EventBus
  taskManager.setOnEvent((type, data) => {
    collectedEvents.push({ type, data });
    eventBus.emit(type, data).catch(() => {});
  });
  campaignManager.setOnEvent((type, data) => {
    collectedEvents.push({ type, data });
    eventBus.emit(type, data).catch(() => {});
  });

  const config = makeConfig(configOverrides);
  const thinkingAgents = new Set();
  const strategistCalls = [];

  /**
   * Simple strategist that checks milestone progress and advances campaign state.
   * In production, this would be an agent-driven evaluation. For testing,
   * it deterministically checks task completion and transitions milestones/campaign.
   */
  function strategistEvaluate(projectId, campaignId) {
    strategistCalls.push({ projectId, campaignId });

    const camp = campaignManager.getCampaign(projectId, campaignId);
    if (!camp || camp.status !== 'active') return Promise.resolve();

    // Check each active milestone for task completion
    for (const ms of camp.milestones) {
      if (ms.status !== 'active') continue;
      if (campaignManager.isMilestoneComplete(projectId, campaignId, ms.id, taskManager)) {
        campaignManager.updateMilestoneStatus(projectId, campaignId, ms.id, 'completed', 'All tasks done');
        // Activate the next unblocked milestone
        const next = campaignManager.getNextUnblockedMilestone(projectId, campaignId);
        if (next) {
          campaignManager.updateMilestoneStatus(projectId, campaignId, next.id, 'active', 'Previous milestone completed');
        }
      }
    }

    // Check if all milestones are terminal → campaign complete
    const fresh = campaignManager.getCampaign(projectId, campaignId);
    if (fresh && fresh.milestones.length > 0) {
      const allTerminal = fresh.milestones.every(m =>
        m.status === 'completed' || m.status === 'skipped'
      );
      if (allTerminal) {
        campaignManager.updateCampaignStatus(projectId, campaignId, 'completed', 'All milestones done');
      }
    }

    return Promise.resolve();
  }

  const deps = {
    taskManager,
    stateManager: sm,
    campaignManager,
    agents: agentMap,
    addMessage: () => {},
    broadcastToChannel: () => {},
    withTimeout: async (promise) => promise,
    config,
    routeSubtask,
    getAgentResponse: async (_name, agent, _pid, _cid, prompt) => agent.send(prompt),
    isAgentCoolingDown: () => false,
    setAgentCooldown: () => 5,
    RATE_LIMIT_RE: /rate.?limit|too many requests|429/i,
    thinkingAgents,
    PROJECT_DIR: tmpDir,
    canBypassPermissions: () => true,
    filterByPermission: null,
    hasPermission: () => true,
    auditDispatch: () => {},
    strategistEvaluate,
  };

  const lifecycle = createLifecycleSystem(deps);

  return {
    tmpDir, sm, taskManager, campaignManager, eventBus,
    collectedEvents, strategistCalls, lifecycle, config,
  };
}

// ─── Campaign Lifecycle E2E Tests ─────────────────────────────────

console.log('\nCampaign lifecycle E2E tests:');

await test('full campaign lifecycle: create → milestones → tasks → milestone complete → campaign complete', async () => {
  const architect = mockAgent('architect', { role: 'architect', skills: ['plan', 'design'] });
  const worker = mockAgent('worker', { role: 'developer', skills: ['implement'] });

  // Push plan responses — 1 subtask per task, 2 tasks total (one per milestone)
  architect.pushResponse(JSON.stringify([
    { text: 'Implement feature A', role: 'implementer', complexity: 'low' },
  ]));
  architect.pushResponse(JSON.stringify([
    { text: 'Implement feature B', role: 'implementer', complexity: 'low' },
  ]));

  // Push worker execution responses
  worker.pushResponse('Feature A implemented successfully.');
  worker.pushResponse('Feature B implemented successfully.');

  const env = setupTestEnv({ architect, worker });

  try {
    // ── 1. Create campaign ──────────────────────────────────────
    const campaign = env.campaignManager.createCampaign('test-proj', {
      title: 'E2E Test Campaign',
      description: 'End-to-end lifecycle test',
      doneCriteria: 'All features shipped and verified',
      contingency: 'Roll back if milestone stalls',
    });

    assert.equal(campaign.status, 'active');
    assert.equal(campaign.milestones.length, 0);
    assert.ok(campaign.id.startsWith('campaign_'));
    assert.ok(campaign.createdAt);

    // ── 2. Add milestones with dependency chain (MS1 → MS2) ─────
    const ms1 = env.campaignManager.addMilestone('test-proj', campaign.id, {
      title: 'Core Features',
      description: 'Build feature A',
      doneCriteria: 'Feature A working',
      order: 1,
    });

    const ms2 = env.campaignManager.addMilestone('test-proj', campaign.id, {
      title: 'Polish & Finish',
      description: 'Build feature B',
      doneCriteria: 'Feature B working',
      blockedBy: [ms1.id],
      order: 2,
    });

    assert.ok(ms1.id.startsWith('ms_'));
    assert.equal(ms1.status, 'pending');
    assert.equal(ms2.status, 'pending');
    assert.deepEqual(ms2.blockedBy, [ms1.id]);

    // Verify campaign now has 2 milestones
    let camp = env.campaignManager.getCampaign('test-proj', campaign.id);
    assert.equal(camp.milestones.length, 2);

    // ── 3. Activate MS1 ─────────────────────────────────────────
    env.campaignManager.updateMilestoneStatus('test-proj', campaign.id, ms1.id, 'active', 'Starting work');

    camp = env.campaignManager.getCampaign('test-proj', campaign.id);
    assert.equal(camp.milestones.find(m => m.id === ms1.id).status, 'active');
    assert.equal(camp.milestones.find(m => m.id === ms2.id).status, 'pending');

    // Verify MS2 is still blocked
    const nextMs = env.campaignManager.getNextUnblockedMilestone('test-proj', campaign.id);
    assert.equal(nextMs, null, 'MS2 should be blocked by MS1');

    // ── 4. Create tasks and link to milestones ──────────────────
    const task1 = env.taskManager.createTask('test-proj', 'general', {
      title: 'Build Feature A',
      description: 'Implement the core feature A',
      campaignId: campaign.id,
      milestoneId: ms1.id,
    });
    env.campaignManager.linkTaskToMilestone('test-proj', campaign.id, ms1.id, task1.id);

    const task2 = env.taskManager.createTask('test-proj', 'general', {
      title: 'Build Feature B',
      description: 'Implement the polish feature B',
      campaignId: campaign.id,
      milestoneId: ms2.id,
    });
    env.campaignManager.linkTaskToMilestone('test-proj', campaign.id, ms2.id, task2.id);

    // Verify tasks are queued and linked
    assert.equal(task1.status, 'queued');
    assert.equal(task2.status, 'queued');
    assert.equal(task1.campaignId, campaign.id);
    assert.equal(task2.milestoneId, ms2.id);

    camp = env.campaignManager.getCampaign('test-proj', campaign.id);
    assert.deepEqual(camp.milestones.find(m => m.id === ms1.id).tasks, [task1.id]);
    assert.deepEqual(camp.milestones.find(m => m.id === ms2.id).tasks, [task2.id]);

    // ── 5. Heartbeat tick 1: queued → planning → executing ──────
    // Both tasks go through planning (architect decomposes into subtasks)
    await env.lifecycle.heartbeatTick();

    let t1 = env.taskManager.getTask('test-proj', task1.id);
    let t2 = env.taskManager.getTask('test-proj', task2.id);
    assert.equal(t1.status, 'executing', `Tick 1: task1 should be executing, got ${t1.status}`);
    assert.equal(t2.status, 'executing', `Tick 1: task2 should be executing, got ${t2.status}`);
    assert.ok(t1.subtasks.length > 0, 'task1 should have subtasks after planning');
    assert.ok(t2.subtasks.length > 0, 'task2 should have subtasks after planning');

    // ── 6. Heartbeat tick 2: execute subtasks ───────────────────
    // Worker agent processes the subtasks for both tasks
    await env.lifecycle.heartbeatTick();

    t1 = env.taskManager.getTask('test-proj', task1.id);
    t2 = env.taskManager.getTask('test-proj', task2.id);
    // Subtasks should be done
    assert.equal(t1.subtasks[0].status, 'done', 'task1 subtask should be done');
    assert.equal(t2.subtasks[0].status, 'done', 'task2 subtask should be done');

    // ── 7. Heartbeat tick 3: reviewing → done → strategist eval ─
    // Both tasks complete, strategistEvaluate transitions milestones and campaign
    await env.lifecycle.heartbeatTick();

    t1 = env.taskManager.getTask('test-proj', task1.id);
    t2 = env.taskManager.getTask('test-proj', task2.id);
    assert.equal(t1.status, 'done', `Tick 3: task1 should be done, got ${t1.status}`);
    assert.equal(t2.status, 'done', `Tick 3: task2 should be done, got ${t2.status}`);
    assert.ok(t1.completedAt, 'task1 should have completedAt');
    assert.ok(t2.completedAt, 'task2 should have completedAt');

    // ── 8. Verify milestone transitions ─────────────────────────
    // strategistEvaluate should have been called at least twice (once per completed task)
    assert.ok(env.strategistCalls.length >= 2, `strategistEvaluate should be called >= 2 times, got ${env.strategistCalls.length}`);

    camp = env.campaignManager.getCampaign('test-proj', campaign.id);

    // MS1 completed (task1 done → strategist marked it complete)
    const finalMs1 = camp.milestones.find(m => m.id === ms1.id);
    assert.equal(finalMs1.status, 'completed', 'MS1 should be completed');
    assert.ok(finalMs1.completedAt, 'MS1 should have completedAt');

    // MS2 completed (unblocked by MS1, task2 done → strategist marked it complete)
    const finalMs2 = camp.milestones.find(m => m.id === ms2.id);
    assert.equal(finalMs2.status, 'completed', 'MS2 should be completed');
    assert.ok(finalMs2.completedAt, 'MS2 should have completedAt');

    // ── 9. Verify campaign reached completed state ──────────────
    assert.equal(camp.status, 'completed', 'Campaign should be completed');
    assert.ok(camp.completedAt, 'Campaign should have completedAt timestamp');

    // ── 10. Verify real event emission ──────────────────────────
    const eventTypes = env.collectedEvents.map(e => e.type);
    assert.ok(eventTypes.includes('campaign:created'), 'Should emit campaign:created');
    assert.ok(eventTypes.includes('task:created'), 'Should emit task:created');
    assert.ok(eventTypes.includes('task:status_changed'), 'Should emit task:status_changed');
    assert.ok(eventTypes.includes('task:completed'), 'Should emit task:completed');
    assert.ok(eventTypes.includes('campaign:milestone_completed'), 'Should emit campaign:milestone_completed');
    assert.ok(eventTypes.includes('campaign:status_changed'), 'Should emit campaign:status_changed');

    // Verify specific event data
    const completedEvents = env.collectedEvents.filter(e => e.type === 'task:completed');
    assert.equal(completedEvents.length, 2, 'Should have 2 task:completed events');

    const milestoneCompletedEvents = env.collectedEvents.filter(e => e.type === 'campaign:milestone_completed');
    assert.equal(milestoneCompletedEvents.length, 2, 'Should have 2 milestone_completed events');

    const campaignCompletedEvent = env.collectedEvents.find(
      e => e.type === 'campaign:status_changed' && e.data.status === 'completed'
    );
    assert.ok(campaignCompletedEvent, 'Should have campaign:status_changed → completed event');

  } finally {
    rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

await test('milestone dependency: MS2 unblocked only after MS1 completes', async () => {
  const architect = mockAgent('architect', { role: 'architect', skills: ['plan', 'design'] });
  const worker = mockAgent('worker', { role: 'developer', skills: ['implement'] });

  // Only push responses for task1 (MS1) — we verify MS2 state before running task2
  architect.pushResponse(JSON.stringify([
    { text: 'Build foundation', role: 'implementer', complexity: 'low' },
  ]));
  worker.pushResponse('Foundation built.');

  const env = setupTestEnv({ architect, worker });

  try {
    const campaign = env.campaignManager.createCampaign('test-proj', {
      title: 'Dependency Test Campaign',
    });

    const ms1 = env.campaignManager.addMilestone('test-proj', campaign.id, {
      title: 'Foundation', order: 1,
    });
    const ms2 = env.campaignManager.addMilestone('test-proj', campaign.id, {
      title: 'Building', blockedBy: [ms1.id], order: 2,
    });
    const ms3 = env.campaignManager.addMilestone('test-proj', campaign.id, {
      title: 'Roof', blockedBy: [ms2.id], order: 3,
    });

    env.campaignManager.updateMilestoneStatus('test-proj', campaign.id, ms1.id, 'active');

    // Create and link only task1 for MS1
    const task1 = env.taskManager.createTask('test-proj', 'general', {
      title: 'Lay foundation',
      campaignId: campaign.id,
      milestoneId: ms1.id,
    });
    env.campaignManager.linkTaskToMilestone('test-proj', campaign.id, ms1.id, task1.id);

    // Before heartbeat: MS2 is blocked, MS3 is blocked
    assert.equal(env.campaignManager.getNextUnblockedMilestone('test-proj', campaign.id), null);

    // Run 3 ticks to complete task1
    await env.lifecycle.heartbeatTick(); // plan
    await env.lifecycle.heartbeatTick(); // execute
    await env.lifecycle.heartbeatTick(); // review → done → strategist

    // Verify: MS1 completed, MS2 now active (unblocked), MS3 still pending
    let camp = env.campaignManager.getCampaign('test-proj', campaign.id);
    assert.equal(camp.milestones.find(m => m.id === ms1.id).status, 'completed');
    assert.equal(camp.milestones.find(m => m.id === ms2.id).status, 'active', 'MS2 should be activated');
    assert.equal(camp.milestones.find(m => m.id === ms3.id).status, 'pending', 'MS3 should still be pending (blocked by MS2)');

    // Campaign still active (MS2, MS3 not done)
    assert.equal(camp.status, 'active');

  } finally {
    rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

await test('failed task does not complete milestone', async () => {
  const architect = mockAgent('architect', { role: 'architect', skills: ['plan', 'design'] });
  const worker = mockAgent('worker', { role: 'developer', skills: ['implement'] });

  // Architect plans 1 subtask, worker returns empty responses → escalation then failure
  architect.pushResponse(JSON.stringify([
    { text: 'Attempt risky operation', role: 'implementer', complexity: 'low' },
  ]));
  // 4 empty responses: 3 escalation retries + 1 to exceed MAX_ESCALATIONS cap
  worker.pushResponse('');
  worker.pushResponse('');
  worker.pushResponse('');
  worker.pushResponse('');

  const env = setupTestEnv({ architect, worker });

  try {
    const campaign = env.campaignManager.createCampaign('test-proj', {
      title: 'Failure Test Campaign',
    });
    const ms1 = env.campaignManager.addMilestone('test-proj', campaign.id, {
      title: 'Risky Milestone', order: 1,
    });
    env.campaignManager.updateMilestoneStatus('test-proj', campaign.id, ms1.id, 'active');

    const task1 = env.taskManager.createTask('test-proj', 'general', {
      title: 'Risky task',
      campaignId: campaign.id,
      milestoneId: ms1.id,
    });
    env.campaignManager.linkTaskToMilestone('test-proj', campaign.id, ms1.id, task1.id);

    // Run heartbeat ticks: 1 plan + 4 execute (3 escalation retries + final fail) + 1 review
    for (let i = 0; i < 8; i++) {
      await env.lifecycle.heartbeatTick();
    }

    const t1 = env.taskManager.getTask('test-proj', task1.id);
    assert.equal(t1.status, 'failed', `Task should be failed, got ${t1.status}`);

    // Milestone should NOT be completed (task failed, not done)
    const camp = env.campaignManager.getCampaign('test-proj', campaign.id);
    assert.notEqual(camp.milestones.find(m => m.id === ms1.id).status, 'completed',
      'Milestone should NOT be completed when its task failed');
    assert.equal(camp.status, 'active', 'Campaign should remain active');

  } finally {
    rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

await test('EventBus receives real events during campaign lifecycle', async () => {
  const architect = mockAgent('architect', { role: 'architect', skills: ['plan', 'design'] });
  const worker = mockAgent('worker', { role: 'developer', skills: ['implement'] });

  architect.pushResponse(JSON.stringify([
    { text: 'Quick task', role: 'implementer', complexity: 'low' },
  ]));
  worker.pushResponse('Done.');

  const env = setupTestEnv({ architect, worker });

  try {
    // Subscribe to EventBus and collect events
    const busEvents = [];
    env.eventBus.on('task:completed', (data) => { busEvents.push({ type: 'task:completed', data }); });
    env.eventBus.on('campaign:created', (data) => { busEvents.push({ type: 'campaign:created', data }); });
    env.eventBus.on('campaign:milestone_completed', (data) => { busEvents.push({ type: 'campaign:milestone_completed', data }); });
    env.eventBus.on('campaign:status_changed', (data) => { busEvents.push({ type: 'campaign:status_changed', data }); });

    const campaign = env.campaignManager.createCampaign('test-proj', {
      title: 'EventBus Test Campaign',
    });
    const ms1 = env.campaignManager.addMilestone('test-proj', campaign.id, {
      title: 'Only Milestone', order: 1,
    });
    env.campaignManager.updateMilestoneStatus('test-proj', campaign.id, ms1.id, 'active');

    const task1 = env.taskManager.createTask('test-proj', 'general', {
      title: 'EventBus test task',
      campaignId: campaign.id,
      milestoneId: ms1.id,
    });
    env.campaignManager.linkTaskToMilestone('test-proj', campaign.id, ms1.id, task1.id);

    // Run lifecycle ticks
    await env.lifecycle.heartbeatTick(); // plan
    await env.lifecycle.heartbeatTick(); // execute
    await env.lifecycle.heartbeatTick(); // review → done

    // Allow async EventBus handlers to complete
    await new Promise(r => setTimeout(r, 50));

    // Verify EventBus received events
    assert.ok(busEvents.some(e => e.type === 'campaign:created'), 'EventBus should receive campaign:created');
    assert.ok(busEvents.some(e => e.type === 'task:completed'), 'EventBus should receive task:completed');
    assert.ok(busEvents.some(e => e.type === 'campaign:milestone_completed'), 'EventBus should receive campaign:milestone_completed');
    assert.ok(busEvents.some(e => e.type === 'campaign:status_changed'), 'EventBus should receive campaign:status_changed');

    // Verify task:completed event has correct data
    const taskCompletedEvent = busEvents.find(e => e.type === 'task:completed');
    assert.equal(taskCompletedEvent.data.projectId, 'test-proj');
    assert.equal(taskCompletedEvent.data.taskId, task1.id);

    // Verify milestone_completed event has correct data
    const msCompletedEvent = busEvents.find(e => e.type === 'campaign:milestone_completed');
    assert.equal(msCompletedEvent.data.campaignId, campaign.id);
    assert.equal(msCompletedEvent.data.milestoneId, ms1.id);

  } finally {
    rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

await test('multi-task milestone: all tasks must complete before milestone completes', async () => {
  const architect = mockAgent('architect', { role: 'architect', skills: ['plan', 'design'] });
  const worker = mockAgent('worker', { role: 'developer', skills: ['implement'] });

  // Push plan + execution responses for 3 tasks (all in same milestone)
  for (let i = 0; i < 3; i++) {
    architect.pushResponse(JSON.stringify([
      { text: `Subtask for task ${i}`, role: 'implementer', complexity: 'low' },
    ]));
    worker.pushResponse(`Task ${i} done.`);
  }

  const env = setupTestEnv({ architect, worker });

  try {
    const campaign = env.campaignManager.createCampaign('test-proj', {
      title: 'Multi-Task Milestone Campaign',
    });
    const ms1 = env.campaignManager.addMilestone('test-proj', campaign.id, {
      title: 'Big Milestone (3 tasks)', order: 1,
    });
    env.campaignManager.updateMilestoneStatus('test-proj', campaign.id, ms1.id, 'active');

    // Create 3 tasks, all linked to MS1
    const tasks = [];
    for (let i = 0; i < 3; i++) {
      const t = env.taskManager.createTask('test-proj', 'general', {
        title: `Multi-task ${i}`,
        campaignId: campaign.id,
        milestoneId: ms1.id,
      });
      env.campaignManager.linkTaskToMilestone('test-proj', campaign.id, ms1.id, t.id);
      tasks.push(t);
    }

    // Verify milestone has 3 linked tasks
    let camp = env.campaignManager.getCampaign('test-proj', campaign.id);
    assert.equal(camp.milestones.find(m => m.id === ms1.id).tasks.length, 3);

    // Run heartbeat ticks — all 3 tasks process in parallel (maxConcurrent=10)
    // Tick 1: all 3 planned, Tick 2: all 3 subtasks executed, Tick 3: all 3 reviewed → done
    await env.lifecycle.heartbeatTick(); // plan all 3
    await env.lifecycle.heartbeatTick(); // execute all 3 subtasks
    await env.lifecycle.heartbeatTick(); // review all 3 → done → strategist

    // Verify all 3 tasks are done
    for (const t of tasks) {
      const fresh = env.taskManager.getTask('test-proj', t.id);
      assert.equal(fresh.status, 'done', `Task ${t.id} should be done, got ${fresh.status}`);
    }

    // Verify milestone completed (all 3 tasks done)
    camp = env.campaignManager.getCampaign('test-proj', campaign.id);
    assert.equal(camp.milestones.find(m => m.id === ms1.id).status, 'completed');

    // Verify campaign completed (only milestone is done)
    assert.equal(camp.status, 'completed');

    // Verify progress tracking works correctly
    const progress = env.campaignManager.checkMilestoneProgress('test-proj', campaign.id, ms1.id, env.taskManager);
    assert.equal(progress.total, 3);
    assert.equal(progress.done, 3);
    assert.equal(progress.failed, 0);
    assert.equal(progress.executing, 0);

  } finally {
    rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

await test('campaign state persists across manager reloads', async () => {
  const architect = mockAgent('architect', { role: 'architect', skills: ['plan', 'design'] });
  const worker = mockAgent('worker', { role: 'developer', skills: ['implement'] });

  architect.pushResponse(JSON.stringify([
    { text: 'Persist test', role: 'implementer', complexity: 'low' },
  ]));
  worker.pushResponse('Persisted.');

  const env = setupTestEnv({ architect, worker });

  try {
    // Create campaign and milestone
    const campaign = env.campaignManager.createCampaign('test-proj', {
      title: 'Persistence Test',
      doneCriteria: 'State survives reload',
    });
    const ms1 = env.campaignManager.addMilestone('test-proj', campaign.id, {
      title: 'Persist MS', order: 1,
    });
    env.campaignManager.updateMilestoneStatus('test-proj', campaign.id, ms1.id, 'active');

    const task1 = env.taskManager.createTask('test-proj', 'general', {
      title: 'Persist task',
      campaignId: campaign.id,
      milestoneId: ms1.id,
    });
    env.campaignManager.linkTaskToMilestone('test-proj', campaign.id, ms1.id, task1.id);

    // Run lifecycle to completion
    await env.lifecycle.heartbeatTick();
    await env.lifecycle.heartbeatTick();
    await env.lifecycle.heartbeatTick();

    // Create fresh managers pointing to the same tmpDir — simulate process restart
    const freshCampaignManager = new CampaignManager(env.sm);
    const freshTaskManager = new TaskManager(env.sm);

    // Verify state survived via fresh managers reading from disk
    const reloadedCampaign = freshCampaignManager.getCampaign('test-proj', campaign.id);
    assert.ok(reloadedCampaign, 'Campaign should be reloadable');
    assert.equal(reloadedCampaign.status, 'completed', 'Campaign status should persist');
    assert.equal(reloadedCampaign.milestones.find(m => m.id === ms1.id).status, 'completed');

    const reloadedTask = freshTaskManager.getTask('test-proj', task1.id);
    assert.ok(reloadedTask, 'Task should be reloadable');
    assert.equal(reloadedTask.status, 'done', 'Task status should persist');

  } finally {
    rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

// ─── Cleanup ─────────────────────────────────────────────────────

if (savedLogLevel !== undefined) {
  process.env.SYNAPSE_LOG_LEVEL = savedLogLevel;
} else {
  delete process.env.SYNAPSE_LOG_LEVEL;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
