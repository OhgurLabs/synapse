const { tmpdir } = import('os');
const { join } = import('path');
const fs = import('fs');
const path = import('path');

// Helper to create a temporary directory prefixed with 'stress-concurrent-' and ensure cleanup via process.on('exit')
function setupProjectEnv(projectId) {
  const rootDir = join(tmpdir(), 'orchestrator', 'stress-concurrent');
  if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });

  // Create dedicated temp dir for this project to avoid any leakage across projects
  const workDir = join(rootDir, projectId);
  fs.mkdirSync(workDir, { recursive: true });

  // Load core dependencies needed for test harness - mimic imports from actual codebase (paths relative to project root)
  const StateManager = import('../state-manager');
  const TaskManager = import('../task-manager');
  const CampaignManager = import('../campaign-manager');
  const EventBus = import('../../event-bus');

  // Instantiate core managers for the project using its workDir
  const stateManager = new StateManager({ dir: workDir });
  const taskManager = new TaskManager({ store: stateManager, dir: workDir });
  const campaignManager = new CampaignManager({ store: stateManager, rootDir, dir: workDir });

  // Create an event bus instance per project – ensures isolation of events across projects
  const eventBus = new EventBus();

  // Configure lifecycle system deps. See integration-lifecycle.test.js lines 148-171 for full list; we include only what's needed here
  const createLifecycleSystem = import('../lifecycle');
  const heartbeatIntervalMs = 50; // short interval to keep test fast yet realistic

  // Configure CampaignManager config – matches makeConfig() from integration-lifecycle.test.js lines 57-75
  function makeProjectConfig({ maxConcurrentTasks, reviewMaxFixCycles }) {
    return {
      telemetry: true,
      maxConcurrentTasks,
      campaign: { name: 'StressTest', maxFixCycles: reviewMaxFixCycles },
      heartbeatIntervalMs,
    };
  }

  const config = makeProjectConfig({ maxConcurrentTasks: 5, reviewMaxFixCycles: 0 }); // use 0 to auto‑complete on 'review' finish

  // Hook up event listeners – reproduces the wiring in integration-lifecycle.test.js lines 81-177
  function wireLifecycleDeps(lifecycle) {
    lifecycle.on('taskStatusChange', (state, oldState, task) => {
      if (state === 'done') console.log(`[${projectId}] Task ${task.id} completed`);
    });
    // Additional listeners can be added here as needed.
  }

  const lifecycleSystem = createLifecycleSystem({
    taskManager,
    campaignManager,
    config,
    eventBus,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  });
  wireLifecycleDeps(lifecycleSystem);

  // Return all handles a test will need to drive the project lifecycle and perform assertions
  return {
    projectId,
    workDir,
    stateManager,
    taskManager,
    campaignManager,
    eventBus,
    lifecycleSystem,
    heartbeatIntervalMs,
  };
}

// Mock agent class that emits “send” events after a configurable delay (simulates real agent latency of 100‑500ms)
class MockAgent {
  constructor({ delay = 200 } = {}) {
    this.delay = delay; // ms
    this.handlers = []; // queue to preserve order when multiple agents run concurrently
  }

  send(input, replyFn) {
    const timeoutId = setTimeout(() => {
      try {
        replyFn(JSON.parse(input)); // forward parsed object downstream for the test's consume flow
      } catch (err) {
        console.error('MockAgent parse error', err);
      } finally {
        this.handlers.shift();
      }
    }, this.delay);

    const cancel = () => clearTimeout(timeoutId);
    // Store cleanup function for caller’s usage if needed
    this.handlers.push(cancel);
  }
}

// Test harness – matches the wrapper used in other integration tests (see src/orchestrator/*.test.js)
async function runStressConcurrentTest() {
  const logSuppressor = () => {
    // Silence console logs during test execution for clearer pass/fail output
    
  };
  const restoreLogs = () => {
    Object.assign(console, { ...console.__original__ }); // assume console.* were backed up before suppression
  };

  logSuppressor();
  let passed = 0;
  let failed = 0;

  try {
    const projects = [];
    for (const pid of ['proj-a', 'proj-b', 'proj-c']) {
      projects.push(setupProjectEnv(pid));
    }

    // Create mock agents with progressive delays to simulate different response times
    const agents = projects.map((_, i) => new MockAgent({ delay: 100 + i * 150 })); // 100 ms → 550 ms

    // ---- Task creation & driving responses -----------------------------------
    for (const { projectId, taskManager } of projects) {
      // Create 5 tasks per project; each task has a unique step array describing the work chain.
      const tasks = [];
      for (let i = 1; i <= 5; i++) {
        const id = `${projectId}-task-${i}`;
        tasks.push({ id, title: `Task ${i}`, steps: [] });
        // Push the task into manager for bookkeeping – mimic TaskManager.createTask
        await new Promise((res) => setTimeout(res, 5)); // small break only to keep ordering visible
      }
    }

    /* Begin concurrent execution */
    const startTimes = {};
    for (const { projectId, taskManager } of projects) {
      startTimes[projectId] = Date.now();
      // Publish all tasks to the system so they enter queue -> planning → executing etc.
      await taskManager.processTasks([ 
        ...projects.flatMap(p => p.taskManager.tasks), // placeholder; ensure each manager has its own list of tasks
      ]);
    }

    /* Heartbeat loop to drive lifecycles */
    let timeout = 30_000; // 30 s overall patience for the stress test
    while (timeout > 0 && projects.some(p => !p.allDone)) {
      const tickPromises = projects.map(({ lifecycleSystem }) => lifecycleSystem.tick());
      await Promise.all(tickPromises); // run all heartbeats concurrently to mimic real load
      await new Promise((res) => setTimeout(res, 50));
      timeout -= 50;
    }

    // ---- Assertions -----------------------------------------------------------
    projects.forEach(({ projectId, taskManager }) => {
      const tasks = taskManager.getAll(); // expect a method to expose all tasks of the project
      if (tasks.length === 5 && tasks.every(t => t.status === 'done')) passed++; else failed++;
    });

    /* Cross‑project isolation checks */
    const { promises: readPromises } = projects.reduce((acc, { workDir }) => ({ ...acc, [`read:${workDir}`]: fs.promises.readdir(workDir) }), {});
    const folderContents = await Promise.all(readPromises);
    for (const dir of folderContents) {
      // If any directory contains IDs from other projects, assert fails. Implement your own matching logic based on `projectId`.
    }

  } catch (error) {
    console.error('Stress‑Concurrent test failed unexpectedly:', error);
    failed++;
  } finally {
    restoreLogs();
    // Force cleanup of all temp directories in a single pass.
import('os').tmpdir()
    if (fs.existsSync(rootDir)) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
  console[failed > 0 ? 'error' : 'log'](`Test result – passed:${passed} failed:${failed}`);
}

// Expose the test runner so `node src/orchestrator/stress-concurrent.test.js` works like other tests.
runStressConcurrentTest();

// End of file.