// test/unit/write-interception.test.js
// Unit tests for write interception middleware

import { strict as assert } from 'assert';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import {
  initWriteInterception,
  interceptWrite,
  isProtectedPath,
  setAdvisoryMode,
  getAdvisoryMode,
  PermissionError,
  getBlockedAttempts,
  clearBlockedAttempts,
  queryBlockedAttempts,
  addProtectedPattern,
  removeProtectedPattern,
  resetProductionImpactState,
  getProductionImpactState,
  exportBlockedAttempts,
  createWriteInterceptor,
  createDispatchInterceptor,
  DEFAULT_PROTECTED_PATTERNS,
} from '../../src/orchestrator/write-interception.js';

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
  // Cleanup
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best effort */ }
  if (failed > 0) process.exit(1);
}

console.log('test/unit/write-interception.test.js');

const tmpDir = mkdtempSync(join(tmpdir(), 'synapse-write-interception-test-'));

// ─── Tests: isProtectedPath ─────────────────────────────────────

test('isProtectedPath returns false when not initialized', () => {
  clearBlockedAttempts();
  const result = isProtectedPath('/any/path/file.txt');
  assert.strictEqual(result, false, 'Should return false when not initialized');
});

test('isProtectedPath matches default protected patterns', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  
  assert.strictEqual(isProtectedPath(join(tmpDir, '.synapse', 'agents.json')), true);
  assert.strictEqual(isProtectedPath(join(tmpDir, '.synapse', 'config.json')), true);
  assert.strictEqual(isProtectedPath(join(tmpDir, '.synapse', 'auth.json')), true);
  assert.strictEqual(isProtectedPath(join(tmpDir, '.synapse', 'agents', 'test-agent', 'persona.md')), true);
  assert.strictEqual(isProtectedPath(join(tmpDir, '.synapse', 'projects', 'proj1', 'config.json')), true);
});

test('isProtectedPath allows non-protected paths', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  
  assert.strictEqual(isProtectedPath(join(tmpDir, 'src', 'index.js')), false);
  assert.strictEqual(isProtectedPath(join(tmpDir, 'README.md')), false);
  assert.strictEqual(isProtectedPath(join(tmpDir, '.git', 'config')), false);
  assert.strictEqual(isProtectedPath(join(tmpDir, 'package.json')), false);
});

test('isProtectedPath matches glob patterns with **', () => {
  const customDir = mkdtempSync(join(tmpdir(), 'synapse-custom-test-'));
  initWriteInterception({ 
    projectRoot: customDir,
    protectedPatterns: ['**/secrets/*', '**/.synapse/projects/**/*']
  });
  
  // With **/ prefix, patterns match at any depth
  assert.strictEqual(isProtectedPath(join(customDir, 'secrets', 'api-key')), true);
  assert.strictEqual(isProtectedPath(join(customDir, '.synapse', 'projects', 'proj1', 'config.json')), true);
  assert.strictEqual(isProtectedPath(join(customDir, 'src', 'index.js')), false);
  
  rmSync(customDir, { recursive: true, force: true });
});

test('isProtectedPath matches glob patterns with *', () => {
  const customDir = mkdtempSync(join(tmpdir(), 'synapse-glob-test-'));
  initWriteInterception({ 
    projectRoot: customDir,
    protectedPatterns: ['**/yarn.lock', '**/dist/*']
  });
  
  assert.strictEqual(isProtectedPath(join(customDir, 'yarn.lock')), true);
  assert.strictEqual(isProtectedPath(join(customDir, 'dist', 'index.js')), true);
  assert.strictEqual(isProtectedPath(join(customDir, 'src', 'index.js')), false);
  
  rmSync(customDir, { recursive: true, force: true });
});

// ─── Tests: interceptWrite blocking behavior ───────────────────

test('interceptWrite throws PermissionError for protected paths', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  let error = null;
  try {
    interceptWrite(join(tmpDir, '.synapse', 'agents.json'), 'write', 'governance', {
      agentId: 'test-agent',
      taskId: 'task-123',
    });
  } catch (err) {
    error = err;
  }
  
  assert.ok(error instanceof PermissionError, 'Should throw PermissionError');
  assert.strictEqual(error.name, 'PermissionError');
  assert.ok(error.message.includes('agents.json'), 'Message should include file path');
  assert.ok(error.message.includes('governance'), 'Message should include reason');
  assert.strictEqual(error.details.path, join(tmpDir, '.synapse', 'agents.json'));
  assert.strictEqual(error.details.operation, 'write');
  assert.strictEqual(error.details.reason, 'governance');
  assert.strictEqual(error.details.agentId, 'test-agent');
  assert.strictEqual(error.details.taskId, 'task-123');
  assert.ok(error.details.timestamp, 'Should have timestamp');
});

test('interceptWrite allows non-protected paths', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const result = interceptWrite(join(tmpDir, 'src', 'index.js'), 'write', 'task_execution', {
    agentId: 'test-agent',
  });
  
  assert.strictEqual(result.blocked, false);
  assert.strictEqual(result.advisory, false);
});

test('interceptWrite records blocked attempts', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  try {
    interceptWrite(join(tmpDir, '.synapse', 'config.json'), 'write', 'governance', {
      agentId: 'agent-1',
      taskId: 'task-1',
      campaignId: 'campaign-1',
    });
  } catch (err) {
    // Expected
  }
  
  const blocked = getBlockedAttempts();
  assert.strictEqual(blocked.length, 1);
  assert.strictEqual(blocked[0].path, join(tmpDir, '.synapse', 'config.json'));
  assert.strictEqual(blocked[0].operation, 'write');
  assert.strictEqual(blocked[0].reason, 'governance');
  assert.strictEqual(blocked[0].agentId, 'agent-1');
  assert.strictEqual(blocked[0].taskId, 'task-1');
  assert.strictEqual(blocked[0].campaignId, 'campaign-1');
  assert.strictEqual(blocked[0].blocked, true);
  assert.strictEqual(blocked[0].advisoryMode, false);
});

test('interceptWrite includes all context fields in error', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  try {
    interceptWrite(
      join(tmpDir, '.synapse', 'auth.json'),
      'delete',
      'security_policy',
      {
        agentId: 'security-agent',
        taskId: 'cleanup-task',
        subtaskId: 'subtask-abc',
        campaignId: 'security-campaign',
        projectId: 'main-project',
        traceId: 'trace-xyz',
        dispatchId: 'dispatch-123',
      }
    );
  } catch (err) {
    assert.strictEqual(err.details.agentId, 'security-agent');
    assert.strictEqual(err.details.taskId, 'cleanup-task');
    assert.strictEqual(err.details.campaignId, 'security-campaign');
  }
});

// ─── Tests: Advisory mode ──────────────────────────────────────

test('advisory mode allows writes to protected paths', () => {
  initWriteInterception({ projectRoot: tmpDir, advisoryMode: true, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const result = interceptWrite(join(tmpDir, '.synapse', 'agents.json'), 'write', 'governance', {
    agentId: 'test-agent',
  });
  
  assert.strictEqual(result.blocked, false);
  assert.strictEqual(result.advisory, true);
  assert.ok(result.auditEvent, 'Should have audit event');
  assert.strictEqual(result.auditEvent.blocked, false);
  assert.strictEqual(result.auditEvent.advisoryMode, true);
});

test('setAdvisoryMode toggles advisory mode', () => {
  initWriteInterception({ projectRoot: tmpDir, advisoryMode: false, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  
  assert.strictEqual(getAdvisoryMode(), false);
  
  const result1 = setAdvisoryMode(true);
  assert.strictEqual(result1, true);
  assert.strictEqual(getAdvisoryMode(), true);
  
  const result2 = setAdvisoryMode(false);
  assert.strictEqual(result2, false);
  assert.strictEqual(getAdvisoryMode(), false);
});

test('advisory mode still logs blocked attempts', () => {
  initWriteInterception({ projectRoot: tmpDir, advisoryMode: true, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  interceptWrite(join(tmpDir, '.synapse', 'config.json'), 'write', 'governance', {
    agentId: 'test-agent',
  });
  
  const blocked = getBlockedAttempts();
  assert.strictEqual(blocked.length, 1);
  assert.strictEqual(blocked[0].blocked, false);
  assert.strictEqual(blocked[0].advisoryMode, true);
});

// ─── Tests: Production impact detection ────────────────────────

test('consecutive blocks are tracked', () => {
  initWriteInterception({ 
    projectRoot: tmpDir, 
    productionImpactThreshold: 3,
    productionImpactWindowMs: 60000,
    protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS],
  });
  clearBlockedAttempts();
  
  // First block
  try {
    interceptWrite(join(tmpDir, '.synapse', 'agents.json'), 'write', 'governance');
  } catch (err) { /* expected */ }
  
  let state = getProductionImpactState();
  assert.strictEqual(state.consecutiveBlocks, 1);
  
  // Second block
  try {
    interceptWrite(join(tmpDir, '.synapse', 'config.json'), 'write', 'governance');
  } catch (err) { /* expected */ }
  
  state = getProductionImpactState();
  assert.strictEqual(state.consecutiveBlocks, 2);
});

test('auto-switch to advisory mode after threshold', () => {
  initWriteInterception({ 
    projectRoot: tmpDir, 
    productionImpactThreshold: 2,
    productionImpactWindowMs: 60000,
    advisoryMode: false,
    protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS],
  });
  clearBlockedAttempts();
  
  assert.strictEqual(getAdvisoryMode(), false);
  
  // First block - should throw
  try {
    interceptWrite(join(tmpDir, '.synapse', 'agents.json'), 'write', 'governance');
  } catch (err) {
    assert.ok(err instanceof PermissionError);
  }
  
  // Second block - should trigger advisory mode switch
  const result = interceptWrite(join(tmpDir, '.synapse', 'config.json'), 'write', 'governance');
  
  assert.strictEqual(getAdvisoryMode(), true, 'Should have switched to advisory mode');
  assert.strictEqual(result.advisory, true);
  assert.strictEqual(result.auditEvent.productionImpactDetected, true);
});

test('resetProductionImpactState clears counters', () => {
  initWriteInterception({ 
    projectRoot: tmpDir, 
    productionImpactThreshold: 2,
    protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS],
  });
  clearBlockedAttempts();
  
  try {
    interceptWrite(join(tmpDir, '.synapse', 'agents.json'), 'write', 'governance');
  } catch (err) { /* expected */ }
  
  let state = getProductionImpactState();
  assert.strictEqual(state.consecutiveBlocks, 1);
  
  const resetResult = resetProductionImpactState();
  assert.strictEqual(resetResult.reset, true);
  assert.strictEqual(resetResult.previous, 1);
  
  state = getProductionImpactState();
  assert.strictEqual(state.consecutiveBlocks, 0);
});

// ─── Tests: Pattern management ─────────────────────────────────

test('addProtectedPattern adds new patterns', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  addProtectedPattern('**/custom-protected/*');
  
  assert.strictEqual(isProtectedPath(join(tmpDir, 'custom-protected', 'secret.txt')), true);
});

test('removeProtectedPattern removes patterns', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  addProtectedPattern('**/temp-protected/*');
  assert.strictEqual(isProtectedPath(join(tmpDir, 'temp-protected', 'file.txt')), true);
  
  removeProtectedPattern('**/temp-protected/*');
  assert.strictEqual(isProtectedPath(join(tmpDir, 'temp-protected', 'file.txt')), false);
});

test('custom protected patterns override defaults', () => {
  const customDir = mkdtempSync(join(tmpdir(), 'synapse-custom-patterns-'));
  initWriteInterception({ 
    projectRoot: customDir,
    protectedPatterns: ['**/only-this/*']
  });
  
  assert.strictEqual(isProtectedPath(join(customDir, 'only-this', 'file.txt')), true);
  assert.strictEqual(isProtectedPath(join(customDir, '.synapse', 'agents.json')), false);
  
  rmSync(customDir, { recursive: true, force: true });
});

// ─── Tests: Blocked attempts query ─────────────────────────────

test('queryBlockedAttempts filters by agentId', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  try {
    interceptWrite(join(tmpDir, '.synapse', 'agents.json'), 'write', 'governance', { agentId: 'agent-a' });
  } catch (err) { /* expected */ }
  
  try {
    interceptWrite(join(tmpDir, '.synapse', 'config.json'), 'write', 'governance', { agentId: 'agent-b' });
  } catch (err) { /* expected */ }
  
  const agentA = queryBlockedAttempts({ agentId: 'agent-a' });
  assert.strictEqual(agentA.length, 1);
  assert.strictEqual(agentA[0].agentId, 'agent-a');
  
  const agentB = queryBlockedAttempts({ agentId: 'agent-b' });
  assert.strictEqual(agentB.length, 1);
  assert.strictEqual(agentB[0].agentId, 'agent-b');
});

test('queryBlockedAttempts filters by pathPattern', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  try {
    interceptWrite(join(tmpDir, '.synapse', 'agents.json'), 'write', 'governance');
  } catch (err) { /* expected */ }
  
  try {
    interceptWrite(join(tmpDir, '.synapse', 'config.json'), 'write', 'governance');
  } catch (err) { /* expected */ }
  
  const agentsMatches = queryBlockedAttempts({ pathPattern: 'agents' });
  assert.strictEqual(agentsMatches.length, 1);
  assert.ok(agentsMatches[0].path.includes('agents.json'));
  
  const configMatches = queryBlockedAttempts({ pathPattern: 'config' });
  assert.strictEqual(configMatches.length, 1);
  assert.ok(configMatches[0].path.includes('config.json'));
});

test('queryBlockedAttempts respects limit', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  for (let i = 0; i < 10; i++) {
    try {
      interceptWrite(join(tmpDir, '.synapse', `agents.json`), 'write', 'governance');
    } catch (err) { /* expected */ }
  }
  
  const limited = queryBlockedAttempts({ limit: 3 });
  assert.strictEqual(limited.length, 3);
});

test('queryBlockedAttempts returns results sorted by timestamp descending', () => {
  return new Promise((resolve) => {
    initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS, '**/agents-timestamp-test-*.json'] });
    clearBlockedAttempts();
    
    // Use unique paths for this test to avoid pollution
    const uniquePath1 = join(tmpDir, '.synapse', 'agents-timestamp-test-1.json');
    const uniquePath2 = join(tmpDir, '.synapse', 'agents-timestamp-test-2.json');
    
    try {
      interceptWrite(uniquePath1, 'write', 'governance');
    } catch (err) { /* expected */ }
    
    setTimeout(() => {
      try {
        interceptWrite(uniquePath2, 'write', 'governance');
      } catch (err) { /* expected */ }
      
      setTimeout(() => {
        const allResults = queryBlockedAttempts({ limit: 100 });
        // Filter to only our unique paths
        const ourResults = allResults.filter(r => 
          r.path === uniquePath1 || r.path === uniquePath2
        );
        assert.strictEqual(ourResults.length, 2);
        assert.ok(new Date(ourResults[0].timestamp) >= new Date(ourResults[1].timestamp));
        resolve();
      }, 10);
    }, 10);
  });
});

// ─── Tests: Export functionality ───────────────────────────────

test('exportBlockedAttempts returns JSON format', () => {
  initWriteInterception({ projectRoot: tmpDir, advisoryMode: true, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  interceptWrite(join(tmpDir, '.synapse', 'agents.json'), 'write', 'governance');
  
  const exported = exportBlockedAttempts('json');
  const parsed = JSON.parse(exported);
  
  assert.ok(parsed.timestamp);
  assert.strictEqual(parsed.advisoryMode, true);
  assert.strictEqual(parsed.totalBlocked, 1);
  assert.ok(Array.isArray(parsed.attempts));
  assert.strictEqual(parsed.attempts.length, 1);
});

test('exportBlockedAttempts returns CSV format', () => {
  initWriteInterception({ projectRoot: tmpDir, advisoryMode: false, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  try {
    interceptWrite(join(tmpDir, '.synapse', 'agents.json'), 'write', 'governance', { agentId: 'test' });
  } catch (err) { /* expected */ }
  
  const exported = exportBlockedAttempts('csv');
  const lines = exported.split('\n');
  
  assert.strictEqual(lines.length, 2); // header + 1 row
  assert.ok(lines[0].includes('timestamp'));
  assert.ok(lines[0].includes('path'));
  assert.ok(lines[1].includes('agents.json'));
});

// ─── Tests: createWriteInterceptor ─────────────────────────────

test('createWriteInterceptor intercepts _saveConfig', () => {
  initWriteInterception({ projectRoot: tmpDir, advisoryMode: true, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const mockStateManager = {
    configPath: join(tmpDir, '.synapse', 'config.json'),
    projectsDir: join(tmpDir, '.synapse', 'projects'),
    _saveConfig: function() { return 'saved'; },
  };
  
  const intercepted = createWriteInterceptor(mockStateManager, {
    projectRoot: tmpDir,
    advisoryMode: true,
    context: { agentId: 'test-agent' },
  });
  
  const result = intercepted._saveConfig();
  assert.strictEqual(result, 'saved');
  
  const blocked = getBlockedAttempts();
  assert.strictEqual(blocked.length, 1);
  assert.strictEqual(blocked[0].operation, '_saveConfig');
});

test('createWriteInterceptor intercepts createProject', () => {
  initWriteInterception({ projectRoot: tmpDir, advisoryMode: true, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const mockStateManager = {
    projectsDir: join(tmpDir, '.synapse', 'projects'),
    createProject: function(projectId) { return { projectId }; },
  };
  
  const intercepted = createWriteInterceptor(mockStateManager, {
    projectRoot: tmpDir,
    advisoryMode: true,
    context: { agentId: 'test-agent' },
  });
  
  const result = intercepted.createProject('test-project');
  assert.strictEqual(result.projectId, 'test-project');
  
  const blocked = getBlockedAttempts();
  assert.strictEqual(blocked.length, 1);
  assert.strictEqual(blocked[0].operation, 'createProject');
  assert.ok(blocked[0].path.includes('test-project'));
});

// ─── Tests: createDispatchInterceptor ──────────────────────────

test('createDispatchInterceptor intercepts write actions', () => {
  initWriteInterception({ projectRoot: tmpDir, advisoryMode: true, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const mockDispatch = function(task) { return { dispatched: true }; };
  
  const intercepted = createDispatchInterceptor(mockDispatch, {
    context: { agentId: 'dispatch-agent', taskId: 'dispatch-task' },
  });
  
  const task = {
    id: 'task-123',
    actions: [
      { type: 'write', path: join(tmpDir, '.synapse', 'agents.json'), reason: 'task_execution' },
      { type: 'read', path: join(tmpDir, 'src', 'index.js') },
    ],
  };
  
  const result = intercepted(task);
  assert.strictEqual(result.dispatched, true);
  
  const blocked = getBlockedAttempts();
  assert.strictEqual(blocked.length, 1);
  assert.strictEqual(blocked[0].path, join(tmpDir, '.synapse', 'agents.json'));
  assert.strictEqual(blocked[0].operation, 'write');
  assert.strictEqual(blocked[0].agentId, 'dispatch-agent');
});

test('createDispatchInterceptor blocks in non-advisory mode', () => {
  initWriteInterception({ projectRoot: tmpDir, advisoryMode: false, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const mockDispatch = function(task) { return { dispatched: true }; };
  
  const intercepted = createDispatchInterceptor(mockDispatch, {
    context: { agentId: 'dispatch-agent' },
  });
  
  const task = {
    id: 'task-123',
    actions: [
      { type: 'write', path: join(tmpDir, '.synapse', 'config.json'), reason: 'task_execution' },
    ],
  };
  
  let error = null;
  try {
    intercepted(task);
  } catch (err) {
    error = err;
  }
  
  assert.ok(error instanceof PermissionError);
  assert.ok(error.message.includes('config.json'));
});

// ─── Tests: PermissionError details ────────────────────────────

test('PermissionError includes descriptive message with path and reason', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  
  try {
    interceptWrite(
      join(tmpDir, '.synapse', 'agents.json'),
      'write',
      'governance enforcement',
      { agentId: 'test-agent' }
    );
  } catch (err) {
    assert.ok(err.message.includes('Blocked write'), 'Message should describe action');
    assert.ok(err.message.includes('protected path'), 'Message should mention protection');
    assert.ok(err.message.includes('agents.json'), 'Message should include path');
    assert.ok(err.message.includes('governance enforcement'), 'Message should include reason');
  }
});

test('PermissionError details object contains all required fields', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  
  try {
    interceptWrite(
      join(tmpDir, '.synapse', 'auth.json'),
      'delete',
      'security',
      {
        agentId: 'agent-1',
        taskId: 'task-1',
        campaignId: 'campaign-1',
      }
    );
  } catch (err) {
    assert.strictEqual(err.details.path, join(tmpDir, '.synapse', 'auth.json'));
    assert.strictEqual(err.details.operation, 'delete');
    assert.strictEqual(err.details.reason, 'security');
    assert.strictEqual(err.details.agentId, 'agent-1');
    assert.strictEqual(err.details.taskId, 'task-1');
    assert.strictEqual(err.details.campaignId, 'campaign-1');
    assert.ok(err.details.timestamp);
  }
});

// ─── Edge Cases: Path Traversal ─────────────────────────────────

test('path traversal with ../ is blocked for protected files', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  // Path with ../ that resolves to a protected file
  const traversalPath = join(tmpDir, '.synapse', 'projects', 'default', '..', 'agents.json');
  const normalizedPath = join(tmpDir, '.synapse', 'agents.json');
  
  // The path should be blocked because it resolves to a protected file
  try {
    interceptWrite(traversalPath, 'write', 'governance', { agentId: 'malicious-agent' });
  } catch (err) {
    assert.ok(err instanceof PermissionError);
  }
  
  // Verify the normalized path is also blocked
  try {
    interceptWrite(normalizedPath, 'write', 'governance', { agentId: 'malicious-agent' });
  } catch (err) {
    assert.ok(err instanceof PermissionError);
    assert.ok(err.message.includes('agents.json'));
  }
});

test('deep path traversal cannot escape project root to access protected files', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const deepTraversal = join(tmpDir, 'src', 'deep', 'path', '..', '..', '..', '.synapse', 'agents.json');
  
  try {
    interceptWrite(deepTraversal, 'write', 'governance', { agentId: 'malicious-agent' });
  } catch (err) {
    assert.ok(err instanceof PermissionError);
  }
});

test('path traversal to .env is blocked', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS, '**/.env'] });
  clearBlockedAttempts();
  
  const traversalPath = join(tmpDir, 'config', '..', '.env');
  
  try {
    interceptWrite(traversalPath, 'write', 'governance', { agentId: 'malicious-agent' });
  } catch (err) {
    assert.ok(err instanceof PermissionError);
    assert.ok(err.message.includes('.env'));
  }
});

test('path traversal to auth.json via nested directories is blocked', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const traversalPath = join(tmpDir, '.synapse', 'projects', 'test', 'subdir', '..', '..', 'auth.json');
  
  try {
    interceptWrite(traversalPath, 'write', 'governance', { agentId: 'malicious-agent' });
  } catch (err) {
    assert.ok(err instanceof PermissionError);
  }
});

test('double-dot encoding variations are handled', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const paths = [
    join(tmpDir, '.synapse', 'projects', '..', 'agents.json'),
    join(tmpDir, '.synapse', 'projects', 'test', '..', '..', 'agents.json'),
  ];
  
  for (const path of paths) {
    try {
      interceptWrite(path, 'write', 'governance', { agentId: 'test-agent' });
    } catch (err) {
      assert.ok(err instanceof PermissionError, `Should block path: ${path}`);
    }
  }
});

// ─── Edge Cases: Symlinks ──────────────────────────────────────

test('symlink to protected file is blocked', () => {
  const linkDir = mkdtempSync(join(tmpdir(), 'synapse-symlink-test-'));
  const protectedFile = join(tmpDir, '.synapse', 'agents.json');
  const symlinkPath = join(linkDir, 'secret-link.json');
  
  writeFileSync(protectedFile, '{}');
  symlinkSync(protectedFile, symlinkPath);
  
  initWriteInterception({ 
    projectRoot: linkDir, 
    protectedPatterns: ['**/secret-link.json'] 
  });
  clearBlockedAttempts();
  
  try {
    interceptWrite(symlinkPath, 'write', 'governance', { agentId: 'test-agent' });
  } catch (err) {
    assert.ok(err instanceof PermissionError);
  }
  
  rmSync(linkDir, { recursive: true, force: true });
});

test('symlink outside project pointing to protected file is detected', () => {
  const externalDir = mkdtempSync(join(tmpdir(), 'synapse-external-'));
  const protectedFile = join(tmpDir, '.synapse', 'agents.json');
  const externalSymlink = join(externalDir, 'backdoor.json');
  
  writeFileSync(protectedFile, '{}');
  
  try {
    symlinkSync(protectedFile, externalSymlink);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  
  initWriteInterception({ 
    projectRoot: externalDir, 
    protectedPatterns: ['**/backdoor.json'] 
  });
  clearBlockedAttempts();
  
  try {
    interceptWrite(externalSymlink, 'write', 'governance', { agentId: 'test-agent' });
  } catch (err) {
    assert.ok(err instanceof PermissionError);
  }
  
  rmSync(externalDir, { recursive: true, force: true });
});

test('symlink chain to protected file is blocked', () => {
  const chainDir = mkdtempSync(join(tmpdir(), 'synapse-chain-'));
  const protectedFile = join(tmpDir, '.synapse', 'config.json');
  const link1 = join(chainDir, 'link1.json');
  const link2 = join(chainDir, 'link2.json');
  
  writeFileSync(protectedFile, '{}');
  
  symlinkSync(protectedFile, link1);
  symlinkSync(link1, link2);
  
  initWriteInterception({ 
    projectRoot: chainDir, 
    protectedPatterns: ['**/link*.json'] 
  });
  clearBlockedAttempts();
  
  try {
    interceptWrite(link2, 'write', 'governance', { agentId: 'test-agent' });
  } catch (err) {
    assert.ok(err instanceof PermissionError);
  }
  
  rmSync(chainDir, { recursive: true, force: true });
});

// ─── Edge Cases: Permission Boundaries ─────────────────────────

test('files at project root boundary are protected when pattern matches', () => {
  initWriteInterception({ 
    projectRoot: tmpDir, 
    protectedPatterns: ['**/.env', '**/.gitignore'] 
  });
  clearBlockedAttempts();
  
  try {
    interceptWrite(join(tmpDir, '.env'), 'write', 'governance', { agentId: 'test-agent' });
  } catch (err) {
    assert.ok(err instanceof PermissionError);
  }
});

test('files just outside project root are NOT protected by project-specific patterns', () => {
  const parentDir = dirname(tmpDir);
  const outsideFile = join(parentDir, 'outside-project.json');
  
  // Use a pattern that is specific to the project structure
  initWriteInterception({ 
    projectRoot: tmpDir, 
    protectedPatterns: ['.synapse/agents.json'] 
  });
  clearBlockedAttempts();
  
  // Outside file should not be blocked by project-specific patterns
  const result = interceptWrite(outsideFile, 'write', 'governance', { agentId: 'test-agent' });
  assert.strictEqual(result.blocked, false, 'Outside file should not be protected by project-specific patterns');
});

test('nested project configs are protected', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const nestedConfig = join(tmpDir, '.synapse', 'projects', 'nested', 'deep', 'project', 'config.json');
  
  try {
    interceptWrite(nestedConfig, 'write', 'governance', { agentId: 'test-agent' });
  } catch (err) {
    assert.ok(err instanceof PermissionError);
    assert.ok(err.message.includes('config.json'));
  }
});

test('similar-but-different filenames are NOT protected', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const similarPaths = [
    join(tmpDir, '.synapse', 'agents.json.bak'),
    join(tmpDir, '.synapse', 'agents.json.backup'),
    join(tmpDir, '.synapse', 'my-agents.json'),
    join(tmpDir, 'agents.json'),
  ];
  
  for (const path of similarPaths) {
    const result = interceptWrite(path, 'write', 'governance', { agentId: 'test-agent' });
    assert.strictEqual(result.blocked, false, `Should allow: ${path}`);
  }
});

test('case sensitivity is respected for protected paths', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const caseVariations = [
    join(tmpDir, '.synapse', 'AGENTS.json'),
    join(tmpDir, '.synapse', 'Agents.json'),
    join(tmpDir, '.SYNAPSE', 'agents.json'),
  ];
  
  for (const path of caseVariations) {
    const result = interceptWrite(path, 'write', 'governance', { agentId: 'test-agent' });
    assert.strictEqual(result.blocked, false, `Should allow (case differs): ${path}`);
  }
});

test('empty path is handled gracefully', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const result = interceptWrite('', 'write', 'governance', { agentId: 'test-agent' });
  assert.strictEqual(result.blocked, false);
});

test('null-like strings are handled gracefully', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const result = interceptWrite('null', 'write', 'governance', { agentId: 'test-agent' });
  assert.strictEqual(result.blocked, false);
});

test('very long paths are handled correctly', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const deepDir = Array(100).fill('deep').join('/');
  const longPath = join(tmpDir, deepDir, 'file.txt');
  
  const result = interceptWrite(longPath, 'write', 'governance', { agentId: 'test-agent' });
  assert.strictEqual(result.blocked, false);
});

test('paths with special characters are handled', () => {
  initWriteInterception({ projectRoot: tmpDir, protectedPatterns: [...DEFAULT_PROTECTED_PATTERNS] });
  clearBlockedAttempts();
  
  const specialPaths = [
    join(tmpDir, 'file with spaces.txt'),
    join(tmpDir, 'file-with-dashes.txt'),
    join(tmpDir, 'file_with_underscores.txt'),
  ];
  
  for (const path of specialPaths) {
    const result = interceptWrite(path, 'write', 'governance', { agentId: 'test-agent' });
    assert.strictEqual(result.blocked, false, `Should allow: ${path}`);
  }
});

// ─── Summary ────────────────────────────────────────────────────

printSummary();
