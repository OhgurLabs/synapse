// test/unit/session-monitor.test.js
// Unit tests for session context leakage detection

import { strict as assert } from 'assert';
import { SessionMonitor } from '../../src/test-utils/session-monitor.js';

let passed = 0;
let failed = 0;
let testQueue = [];
let running = false;

function test(name, fn) {
  testQueue.push({ name, fn });
  if (!running) {
    runNextTest();
  }
}

function runNextTest() {
  if (testQueue.length === 0) {
    printSummary();
    return;
  }
  
  running = true;
  const { name, fn } = testQueue.shift();
  
  try {
    const result = fn();
    if (result instanceof Promise) {
      result
        .then(() => {
          passed++;
          console.log(`  ✓ ${name}`);
          running = false;
          runNextTest();
        })
        .catch((err) => {
          failed++;
          console.log(`  ✗ ${name}: ${err.message}`);
          console.error(err.stack);
          running = false;
          runNextTest();
        });
    } else {
      passed++;
      console.log(`  ✓ ${name}`);
      running = false;
      runNextTest();
    }
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
    console.error(err.stack);
    running = false;
    runNextTest();
  }
}

function printSummary() {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

console.log('test/unit/session-monitor.test.js');

// ─── Mock Session Manager ─────────────────────────────────────

function createMockSessionManager() {
  const sessions = new Map();
  const agentSessionKeys = new Map();
  
  return {
    sessions,
    stateManager: {
      projects: new Map([
        ['project-a', { projectDir: '/tmp/project-a' }],
        ['project-b', { projectDir: '/tmp/project-b' }]
      ]),
      getProjectContext(projectId) {
        if (projectId === 'project-a') {
          return 'Context for project A - isolated content';
        }
        if (projectId === 'project-b') {
          return 'Context for project B - different content';
        }
        return null;
      }
    },
    getSession(agentId, projectId, channelId) {
      const sessionKey = `${projectId}#${channelId}#${agentId}`;
      let sessionStore = sessions.get(projectId);
      
      if (!sessionStore) {
        sessionStore = new Map();
        sessions.set(projectId, sessionStore);
      }
      
      if (!sessionStore.has(sessionKey)) {
        sessionStore.set(sessionKey, {
          agentId,
          projectId,
          channelId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          turns: 0,
          maxTurns: 50,
          history: []
        });
        
        const keys = agentSessionKeys.get(agentId) || [];
        keys.push({ sessionKey, projectId, channelId });
        agentSessionKeys.set(agentId, keys);
      }
      
      return { sessionKey, session: sessionStore.get(sessionKey) };
    }
  };
}

// ─── Mock Deliberation Coordinator ─────────────────────────────

function createMockDeliberationCoordinator() {
  const store = new Map([
    ['deliberation:session-1', {
      sessionId: 'session-1',
      status: 'INIT',
      metadata: { projectId: 'project-a' },
      participants: []
    }],
    ['deliberation:session-2', {
      sessionId: 'session-2',
      status: 'PROPOSAL',
      metadata: { projectId: 'project-b' },
      participants: []
    }],
    ['deliberation_session:task-1', {
      taskId: 'task-1',
      sessionId: 'session-1',
      metadata: { projectId: 'project-a' }
    }],
    ['deliberation_session:task-2', {
      taskId: 'task-2',
      sessionId: 'session-2',
      metadata: { projectId: 'project-b' }
    }]
  ]);
  
  return {
    store,
    protocol: {
      getState(sessionId) {
        return store.get(`deliberation:${sessionId}`);
      }
    }
  };
}

// ─── Tests: SessionMonitor Initialization ───────────────────────

test('SessionMonitor initializes with default options', () => {
  const monitor = new SessionMonitor();
  assert.strictEqual(monitor.isMonitoring, false, 'Should not be monitoring initially');
  assert.strictEqual(monitor.snapshots.size, 0, 'Should have no snapshots initially');
  assert.strictEqual(monitor.leakageEvents.length, 0, 'Should have no leakage events initially');
});

test('SessionMonitor initializes with custom options', () => {
  const monitor = new SessionMonitor({
    maxHistoryLength: 500,
    enableSnapshot: false,
    snapshotIntervalMs: 10000
  });
  assert.strictEqual(monitor.options.maxHistoryLength, 500, 'Should use custom maxHistoryLength');
  assert.strictEqual(monitor.options.enableSnapshot, false, 'Should use custom enableSnapshot');
  assert.strictEqual(monitor.options.snapshotIntervalMs, 10000, 'Should use custom snapshotIntervalMs');
});

// ─── Tests: Session Monitoring Lifecycle ───────────────────────

test('SessionMonitor starts and stops monitoring', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  
  monitor.start(sessionManager);
  assert.strictEqual(monitor.isMonitoring, true, 'Should be monitoring after start');
  
  const report = monitor.stop();
  assert.strictEqual(monitor.isMonitoring, false, 'Should not be monitoring after stop');
  assert.ok(report, 'Should return report on stop');
});

test('SessionMonitor captures initial baseline', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  
  monitor.start(sessionManager);
  assert.strictEqual(monitor.snapshots.has('baseline'), true, 'Should have baseline snapshot');
  
  const baseline = monitor.snapshots.get('baseline');
  assert.ok(baseline.timestamp, 'Baseline should have timestamp');
  assert.ok(baseline.agentSessions, 'Baseline should have agentSessions');
  assert.ok(baseline.crossSessionContext, 'Baseline should have crossSessionContext');
  
  monitor.stop();
});

test('SessionMonitor captures snapshots when enabled', async () => {
  const monitor = new SessionMonitor({ 
    enableSnapshot: true,
    snapshotIntervalMs: 100 
  });
  const sessionManager = createMockSessionManager();
  
  monitor.start(sessionManager);
  
  await new Promise(resolve => setTimeout(resolve, 300));
  
  assert.ok(monitor.snapshots.size > 1, 'Should have multiple snapshots after interval');
  
  monitor.stop();
});

// ─── Tests: Agent Session Collection ───────────────────────────

test('SessionMonitor collects agent sessions', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  
  sessionManager.getSession('agent-1', 'project-a', 'channel-1');
  sessionManager.getSession('agent-2', 'project-b', 'channel-1');
  
  monitor.start(sessionManager);
  const state = monitor.getCurrentState();
  
  assert.strictEqual(state.agentSessions.size, 2, 'Should collect sessions from 2 projects');
  assert.ok(state.agentSessions.has('project-a'), 'Should have project-a sessions');
  assert.ok(state.agentSessions.has('project-b'), 'Should have project-b sessions');
  
  monitor.stop();
});

test('SessionMonitor collects agent session keys', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  
  sessionManager.getSession('agent-1', 'project-a', 'channel-1');
  sessionManager.getSession('agent-1', 'project-b', 'channel-2');
  
  monitor.start(sessionManager);
  const state = monitor.getCurrentState();
  
  assert.strictEqual(state.agentSessionKeys.size, 1, 'Should have 1 agent with session keys');
  assert.ok(state.agentSessionKeys.has('agent-1'), 'Should have keys for agent-1');
  
  const keys = state.agentSessionKeys.get('agent-1');
  assert.strictEqual(keys.length, 2, 'Should have 2 session keys for agent-1');
  
  monitor.stop();
});

// ─── Tests: Deliberation Session Collection ────────────────────

test('SessionMonitor collects deliberation sessions', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  const deliberationCoordinator = createMockDeliberationCoordinator();
  
  monitor.start(sessionManager, deliberationCoordinator);
  const state = monitor.getCurrentState();
  
  assert.ok(state.deliberationSessions.size >= 2, 'Should collect deliberation sessions');
  assert.ok(state.deliberationSessions.has('session-1'), 'Should have session-1');
  assert.ok(state.deliberationSessions.has('session-2'), 'Should have session-2');
  
  monitor.stop();
});

// ─── Tests: Cross-Session Context Collection ──────────────────

test('SessionMonitor collects cross-session context', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  
  monitor.start(sessionManager);
  const state = monitor.getCurrentState();
  
  assert.ok(state.crossSessionContext.size >= 2, 'Should collect context from 2 projects');
  assert.ok(state.crossSessionContext.has('project-a'), 'Should have context for project-a');
  assert.ok(state.crossSessionContext.has('project-b'), 'Should have context for project-b');
  
  const contextA = state.crossSessionContext.get('project-a');
  assert.strictEqual(contextA.projectId, 'project-a', 'Should have correct projectId');
  assert.ok(contextA.contextLength > 0, 'Should have non-zero context length');
  
  monitor.stop();
});

// ─── Tests: Agent Session Cross-Project Leakage Detection ──────

test('SessionMonitor detects agent session in wrong project', () => {
   const monitor = new SessionMonitor({ enableSnapshot: false });
   const sessionManager = createMockSessionManager();
   
   sessionManager.getSession('agent-leak', 'project-a', 'channel-1');
   sessionManager.getSession('agent-b', 'project-b', 'channel-1');
   
   const wrongSession = sessionManager.sessions.get('project-b');
   if (wrongSession) {
     wrongSession.set('project-a#channel-1#agent-leak', {
       agentId: 'agent-leak',
       projectId: 'project-a',
       channelId: 'channel-1',
       createdAt: new Date().toISOString(),
       updatedAt: new Date().toISOString(),
       turns: 0,
       history: []
     });
   }
   
   monitor.start(sessionManager);
   const leakage = monitor.checkLeakage();
   
   const wrongProjectLeaks = leakage.filter(l => l.type === 'agent_session_wrong_project');
   assert.ok(wrongProjectLeaks.length > 0, 'Should detect agent session in wrong project');
   
   monitor.stop();
 });

test('SessionMonitor detects agent session key mismatch', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  
  sessionManager.getSession('agent-mismatch', 'project-a', 'channel-1');
  
  monitor.start(sessionManager);
  
  const state = monitor.getCurrentState();
  state.agentSessionKeys.get('agent-mismatch')[0].projectId = 'wrong-project';
  
  const leakage = monitor.detectLeakage(state);
  const keyMismatches = leakage.filter(l => l.type === 'agent_session_key_mismatch');
  assert.ok(keyMismatches.length > 0, 'Should detect session key mismatch');
  
  monitor.stop();
});

// ─── Tests: Deliberation Session Leakage Detection ───────────────

test('SessionMonitor detects deliberation session project mismatch', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  const deliberationCoordinator = createMockDeliberationCoordinator();
  
  const store = deliberationCoordinator.store;
  store.get('deliberation_session:task-1').metadata.projectId = 'wrong-project';
  
  monitor.start(sessionManager, deliberationCoordinator);
  const leakage = monitor.checkLeakage();
  
  const projectMismatches = leakage.filter(l => l.type === 'deliberation_session_project_mismatch');
  assert.ok(projectMismatches.length > 0, 'Should detect deliberation session project mismatch');
  
  monitor.stop();
});

test('SessionMonitor detects deliberation participant in wrong project', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  const deliberationCoordinator = createMockDeliberationCoordinator();
  
  const store = deliberationCoordinator.store;
  store.get('deliberation:session-1').participants = [
    { agentId: 'agent-1', projectId: 'wrong-project' }
  ];
  
  monitor.start(sessionManager, deliberationCoordinator);
  const leakage = monitor.checkLeakage();
  
  const participantLeaks = leakage.filter(l => l.type === 'deliberation_participant_wrong_project');
  assert.ok(participantLeaks.length > 0, 'Should detect participant in wrong project');
  
  monitor.stop();
});

// ─── Tests: Cross-Session Context Leakage Detection ───────────────

test('SessionMonitor detects cross-session context leakage', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  
  sessionManager.stateManager.getProjectContext = (projectId) => {
    if (projectId === 'project-a') {
      return 'Context mentions project-b unexpectedly';
    }
    return 'Context for project B';
  };
  
  monitor.start(sessionManager);
  const leakage = monitor.checkLeakage();
  
  const contextLeaks = leakage.filter(l => l.type === 'cross_session_context_leakage');
  assert.ok(contextLeaks.length > 0, 'Should detect cross-session context leakage');
  
  monitor.stop();
});

// ─── Tests: Report Generation ───────────────────────────────────

test('SessionMonitor generates comprehensive report', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  
  monitor.start(sessionManager);
  
  const report = monitor.generateReport();
  
  assert.ok(report.timestamp, 'Report should have timestamp');
  assert.ok(report.summary, 'Report should have summary');
  assert.strictEqual(typeof report.summary.totalSnapshots, 'number', 'Should have total snapshots count');
  assert.strictEqual(typeof report.summary.totalLeakageEvents, 'number', 'Should have total leakage events count');
  assert.ok(report.leakageEvents, 'Report should have leakage events array');
  assert.ok(report.typeBreakdown, 'Report should have type breakdown');
  assert.ok(report.recommendations, 'Report should have recommendations');
  
  monitor.stop();
});

test('SessionMonitor categorizes leakage by severity', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  
  monitor.start(sessionManager);
  
  const criticalLeakage = {
    type: 'test_critical',
    severity: 'critical',
    timestamp: Date.now()
  };
  const highLeakage = {
    type: 'test_high',
    severity: 'high',
    timestamp: Date.now()
  };
  
  monitor.leakageEvents.push(criticalLeakage, highLeakage);
  
  const report = monitor.generateReport();
  assert.strictEqual(report.summary.critical, 1, 'Should count 1 critical event');
  assert.strictEqual(report.summary.high, 1, 'Should count 1 high event');
  
  monitor.stop();
});

test('SessionMonitor generates type breakdown', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  
  monitor.start(sessionManager);
  
  monitor.leakageEvents.push(
    { type: 'type1', severity: 'critical', timestamp: Date.now() },
    { type: 'type1', severity: 'high', timestamp: Date.now() },
    { type: 'type2', severity: 'medium', timestamp: Date.now() }
  );
  
  const report = monitor.generateReport();
  assert.ok(report.typeBreakdown.type1, 'Should have breakdown for type1');
  assert.strictEqual(report.typeBreakdown.type1.count, 2, 'type1 should have 2 events');
  assert.ok(report.typeBreakdown.type2, 'Should have breakdown for type2');
  assert.strictEqual(report.typeBreakdown.type2.count, 1, 'type2 should have 1 event');
  
  monitor.stop();
});

test('SessionMonitor generates recommendations', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  
  monitor.start(sessionManager);
  
  monitor.leakageEvents.push({
    type: 'agent_session_wrong_project',
    severity: 'critical',
    timestamp: Date.now()
  });
  
  const report = monitor.generateReport();
  assert.ok(report.recommendations.length > 0, 'Should generate recommendations');
  
  const criticalRec = report.recommendations.find(r => r.priority === 'immediate');
  assert.ok(criticalRec, 'Should have immediate priority recommendation for critical leakage');
  
  monitor.stop();
});

// ─── Tests: Helper Methods ───────────────────────────────────────

test('SessionMonitor filters leakage by severity', () => {
  const monitor = new SessionMonitor();
  
  monitor.leakageEvents.push(
    { type: 'test1', severity: 'critical', timestamp: Date.now() },
    { type: 'test2', severity: 'high', timestamp: Date.now() },
    { type: 'test3', severity: 'critical', timestamp: Date.now() }
  );
  
  const critical = monitor.getLeakageBySeverity('critical');
  assert.strictEqual(critical.length, 2, 'Should find 2 critical events');
  
  const high = monitor.getLeakageBySeverity('high');
  assert.strictEqual(high.length, 1, 'Should find 1 high event');
});

test('SessionMonitor filters leakage by type', () => {
  const monitor = new SessionMonitor();
  
  monitor.leakageEvents.push(
    { type: 'type1', severity: 'critical', timestamp: Date.now() },
    { type: 'type1', severity: 'high', timestamp: Date.now() },
    { type: 'type2', severity: 'medium', timestamp: Date.now() }
  );
  
  const type1 = monitor.getLeakageByType('type1');
  assert.strictEqual(type1.length, 2, 'Should find 2 type1 events');
  
  const type2 = monitor.getLeakageByType('type2');
  assert.strictEqual(type2.length, 1, 'Should find 1 type2 event');
});

test('SessionMonitor resets state', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  
  monitor.start(sessionManager);
  monitor.captureSnapshot();
  
  assert.ok(monitor.snapshots.size > 0, 'Should have snapshots');
  
  monitor.reset();
  
  assert.strictEqual(monitor.snapshots.size, 0, 'Should have no snapshots after reset');
  assert.strictEqual(monitor.leakageEvents.length, 0, 'Should have no leakage events after reset');
  
  monitor.stop();
});

test('SessionMonitor prunes old snapshots', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false, maxHistoryLength: 100 });
  const sessionManager = createMockSessionManager();
  
  monitor.start(sessionManager);
  
  for (let i = 0; i < 150; i++) {
    monitor.snapshots.set(`snapshot_${i}`, { timestamp: Date.now() });
  }
  
  monitor.pruneOldSnapshots();
  
  assert.ok(monitor.snapshots.size <= 101, 'Should prune to max snapshots + baseline');
  
  monitor.stop();
});

// ─── Tests: No Leakage Scenarios ─────────────────────────────────

test('SessionMonitor reports no leakage for clean state', () => {
  const monitor = new SessionMonitor({ enableSnapshot: false });
  const sessionManager = createMockSessionManager();
  const deliberationCoordinator = createMockDeliberationCoordinator();
  
  monitor.start(sessionManager, deliberationCoordinator);
  const leakage = monitor.checkLeakage();
  
  assert.strictEqual(leakage.length, 0, 'Should detect no leakage in clean state');
  
  const report = monitor.generateReport();
  assert.strictEqual(report.summary.totalLeakageEvents, 0, 'Report should show 0 leakage events');
  
  const infoRec = report.recommendations.find(r => r.priority === 'info');
  assert.ok(infoRec, 'Should have info recommendation when no leakage');
  
  monitor.stop();
});

printSummary();
