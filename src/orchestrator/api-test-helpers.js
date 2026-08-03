import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer as createNetServer } from 'net';
import { WebSocket } from 'ws';
import { createLogger } from '../logger.js';
import { StateManager } from '../state.js';
import { EventBus } from '../events.js';

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export function connectWS(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const messages = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
    const timer = setTimeout(() => reject(new Error('WS connection timeout')), 5000);
    ws.on('open', () => clearTimeout(timer));
  });
}

export function waitForMessages(messages, count, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (messages.length >= count) return resolve();
    const start = Date.now();
    const check = () => {
      if (messages.length >= count) return resolve();
      if (Date.now() - start > timeoutMs) return resolve();
      setTimeout(check, 20);
    };
    check();
  });
}

export async function waitForServer(port, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // wait until server starts
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Server didn't start within ${timeoutMs}ms`);
}

export async function getHealth(port) {
  const res = await fetch(`http://localhost:${port}/api/health`);
  return res.json();
}

export function closeAndWait(ws, ms = 150) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', () => setTimeout(resolve, ms));
    ws.close();
    setTimeout(resolve, ms + 100);
  });
}

export async function createApiHarness(options = {}) {
  const {
    projectId = 'test-proj',
    channels = ['general'],
    handleUserMessage = async () => {},
    classifyMessage = () => ({ type: 'discussion', confidence: 1 }),
    depsOverrides = {},
  } = options;

  const aliceToken = `alice-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const bobToken = `bob-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const auth = createMultiUserAuth({
    [aliceToken]: 'alice',
    [bobToken]: 'bob',
  });

  const tmpDir = mkdtempSync(join(tmpdir(), 'synapse-api-test-'));
  const stateManager = new StateManager(tmpDir);
  stateManager.init();
  stateManager.createProject(projectId, {
    displayName: 'Test Project',
    projectDir: tmpDir,
    channels,
  });

  // Create test-specific config with temp directory
  const config = createTestConfig(tmpDir);

  // Dynamically import modules that depend on config
  const { createTurnQueue } = await import('./dispatch.js');
  const { createApiServer } = await import('./api.js');
  const { createAgentConfigStore } = await import('./agent-config-store.js');
  const agentConfigSchemaModule = await import('./agent-config-schema.js');
  const agentsModule = await import('./agents.js');
  const {
    agents,
    saveAgentsConfig,
    initAgents,
  } = agentsModule;

  const { queueTurn, turnQueues } = createTurnQueue(config);
  const port = await getFreePort();

  // Initialize agents with test config
  initAgents(config);

  const agentConfigStore = createAgentConfigStore({
    agents,
    saveAgentsConfig,
    createLogger,
    config,
  });

  const deps = {
    PORT: port,
    stateManager,
    agents,
    config,
    auth,
    handleUserMessage,
    queueTurn,
    parseMentions: () => ({ mentioned: [], directed: [] }),
    classifyMessage,
    ROUTING_MATRIX: {},
    recoverTasks: () => {},
    startHeartbeat: () => {},
    startWatchdog: () => {},
    startStrategist: () => {},
    reindexEmbeddings: async () => {},
    loadAgentsConfig: () => ({ agents: [], roles: { engineer: { description: 'Engineers solve problems', permissions: [] } } }),
    saveAgentsConfig,
    addAgent: () => ({}),
    removeAgent: () => {},
    probeAgent: async () => ({ ok: true }),
    resolvePermissions: () => [],
    PROVIDERS: {},
    fallbackStates: new Map(),
    isAgentCoolingDown: () => false,
    agentCooldowns: new Map(),
    turnQueues,
    taskManager: { listTasks: () => [], getTask: () => null, pauseDaemon: () => {}, resumeDaemon: () => {} },
    campaignManager: { listCampaigns: () => [], getCampaign: () => null, createCampaign: () => ({ id: 'c1' }), updateCampaignStatus: () => {} },
    scheduleManager: { listSchedules: () => [], getSchedule: () => null, createSchedule: () => ({ id: 's1' }), deleteSchedule: () => false, updateScheduleStatus: () => {} },
    triggerManager: null,
    prefsManager: { getAll: () => ({}), getSchema: () => ({}) },
    agendaManager: { get: () => ({}) },
    getSessionMessageCount: () => 0,
    strategistDecomposeCampaign: async () => {},
    strategistInject: async () => {},
    strategistEvaluate: async () => {},
    addMessage: () => {},
    SERVER_START_TIME: Date.now(),
    webhookDispatcher: null,
    getCloudBudgetStatus: () => null,
    getVectorStore: null,
    sandbox: null,
    rateLimiter: null,
    credentialVault: null,
    schedulerLoop: null,
    triggerLoop: null,
    workflowLoop: null,
    createLogger,
    agentConfigStore,
    agentConfigSchema: agentConfigSchemaModule,
    events: new EventBus(),
  };

  // Seed test agents in the real agents object (used by agentConfigStore)
  Object.assign(agents, {
    alice: { id: 'alice', name: 'Alice', model: 'gpt-4', color: '#ff0000', provider: 'openai', _status: 'active', _permissions: ['code:execute'], skills: ['testing'] },
    bob: { id: 'bob', name: 'Bob', model: 'claude-3', color: '#0000ff', provider: 'anthropic', _status: 'active', _permissions: ['task:plan'], skills: ['debugging'] },
  });
  
  // Seed history via updateAgentConfig so the store owns it
  agentConfigStore.updateAgentConfig('alice', { 
    name: 'Alice', 
    model: 'gpt-4', 
    color: '#ff0000', 
    role: null, 
    status: 'active', 
    permissions: ['code:execute'], 
    denyActions: [], 
    skills: ['testing'] 
  });
  
  // Also seed in deps for other API routes
  deps.agents = agents;

  const mergedDeps = { ...deps, ...depsOverrides };
  const server = createApiServer(mergedDeps).startServer();
  await waitForServer(port);

  // Create timeline store for cost tracking tests
  const TimelineStore = (await import('./timeline-store.js')).TimelineStore;
  const timelineDbPath = join(tmpDir, 'timeline.db');
  const timelineStore = new TimelineStore({ dbPath: timelineDbPath, retentionMs: 7 * 24 * 60 * 60 * 1000 });

  return {
    port,
    auth,
    tokens: { alice: aliceToken, bob: bobToken },
    stateManager,
    tmpDir,
    server, // Add the server instance here
    agents,
    config,
    timelineStore,
  };
}

export function createTestConfig(projectDir) {
  return {
    server: {
      port: 8080,
      projectDir,
      keepAliveTimeoutMs: 65000,
      headersTimeoutMs: 66000,
      requestTimeoutMs: 30000,
      socketTimeoutMs: 120000,
    },
    auth: {
      enabled: true,
      tokenExpiryDays: 30,
      graceMs: 3600000,
      userRoles: {},
      roles: {
        OPERATOR: 'operator',
        VIEWER: 'viewer',
      },
    },
    rateLimit: {
      enabled: true,
      maxRequests: 120,
      windowMs: 60000,
    },
    orchestrator: {
      maxTotalTurns: 30,
      baseTurnBudget: 15,
      repetitionThreshold: 0.65,
      infoGainThreshold: 0.15,
      repetitionPatience: 2,
      wrapUpBudget: 5,
      maxConsecutive: 3,
    },
    agent: {
      stopGraceMs: 10000,
      defaultMaxTurns: 30,
      timeouts: {
        claude: 120000,
        codex: 120000,
        gemini: 120000,
        ollama: 120000,
      },
    },
    cb: {
      failureThreshold: 5,
      cooldownMs: 60000,
      maxFailureAgeMs: 300000,
    },
    compaction: {
      threshold: 1000,
      recentKeep: 5,
      summaryMax: 2000,
    },
    threading: {
      jaccardThreshold: 0.7,
      minTokenLength: 20,
      labelMax: 50,
      overflow: 'truncate',
      dynamicKeywordsCap: 100,
    },
    tasks: {
      heartbeatMs: 30000,
      stallMs: 120000,
      maxRequeues: 3,
      planningMaxTurns: 10,
      planningTimeoutMs: 300000,
      execMaxTurns: 5,
      timeouts: {
        claude: 300000,
        codex: 300000,
        gemini: 300000,
        ollama: 300000,
      },
      auditInterval: 60000,
      auditOnFailure: true,
      maxConcurrent: 5,
      stuckTimeoutMs: 600000,
    },
    router: {
      directedRouting: false,
      localFirst: false,
      cloudBudgetMaxDay: 10,
      budgetWindowMs: 86400000,
      soloBudget: 10,
      pairBudget: 15,
      councilBudget: 20,
      councilRounds: 3,
      confidence: 0.7,
      loadWindowMs: 3600000,
      auditInterval: 300000,
      decayHalfLife: 1800000,
      alertWindowSize: 10,
    },
    daemon: {
      sleepMs: 60000,
      maxDailyCost: 5,
      maxPerCycleCost: 1,
      replanInterval: 3600000,
    },
    campaign: {
      strategistIntervalMs: 300000,
      decomposeMaxTurns: 10,
      decomposeTimeoutMs: 120000,
      maxMilestonesPerCampaign: 20,
      maxTasksPerMilestone: 10,
      autoRetryFailedTasks: true,
      maxAutoRetries: 3,
      maxActiveCampaigns: 1,
    },
    review: {
      maxFixCycles: 3,
    },
    sandbox: {
      enabled: false,
      maxOutputBytes: 10485760,
      maxConcurrentProcesses: 12,
      envFilter: false,
      maxProcessLifetimeMs: 2700000,
      maxPerProvider: {
        ollama: 2,
      },
    },
    permissions: {
      enforce: true,
      auditLog: false,
    },
    git: {
      autoCommit: false,
      commitStateFiles: false,
      synapseRepoDir: process.cwd(),
    },
    agents: {
      defaults: {
        claude: { color: '#0000ff' },
        codex: { color: '#008000' },
        gemini: { color: '#ff0000' },
        ollama: { color: '#800080' },
      },
    },
    tracing: {
      enabled: false,
      endpoint: null,
    },
  };
}

export function createMultiUserAuth(tokenUserMap) {
  function extractToken(req) {
    const authHeader = req.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('token') || null;
  }

  function isAuthenticated(req) {
    const token = extractToken(req);
    if (token && tokenUserMap[token]) {
      return { authenticated: true, userId: tokenUserMap[token] };
    }
    return { authenticated: false, userId: null };
  }

  function checkRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/health') return true;
    if (url.pathname === '/api/auth/login' && req.method === 'POST') return true;
    const result = isAuthenticated(req);
    if (!result.authenticated) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return false;
    }
    return true;
  }

  return {
    isEnabled: () => true,
    validate: (token) => !!tokenUserMap[token],
    extractToken,
    isAuthenticated,
    checkRequest,
    checkUpgrade: (req) => isAuthenticated(req),
    getToken: () => Object.keys(tokenUserMap)[0],
    hasPassword: () => false,
    checkCredential: (cred) => !!tokenUserMap[cred],
    setSessionCookie: () => {},
    clearSessionCookie: () => {},
  };
}
