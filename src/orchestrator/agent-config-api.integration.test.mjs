// Test: Agent Config API lifecycle integration
//
// Exercises all four endpoints via a real in-process HTTP server:
// - GET /api/agents/:id/config — returns agent config shape
// - PUT /api/agents/:id/config — updates config, returns 200
// - PUT /api/agents/:id/config/rollback — restores previous config
// - GET /api/agents/:id/config/history — returns history entries
//
// Test scenarios:
// 1. GET config for existing agent returns correct shape and values
// 1a. GET config for non-existent agent returns 404
// 2. PUT valid partial config (change model) returns 200, subsequent GET reflects change
// 3. PUT invalid config (negative timeout, unknown role) returns 400 with descriptive errors
// 4. PUT to non-existent agent returns 404
// 5. After valid PUT, rollback via PUT /rollback restores previous config, confirmed by GET
// 6. Double rollback when no further history returns 404 or 409
// 7. Config history endpoint returns correct number of entries after multiple updates
// 8. Concurrent PUT requests don't corrupt agents.json (fire 5 PUTs in parallel, verify file is valid JSON after all complete)

import { strict as assert } from "assert";
import { createServer as createHttpServer } from "http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHandleApi } from "./api.js";
import { createTurnQueue } from "./dispatch.js";
import config from "../config.js";
import { createLogger } from "../logger.js";

// ─── Test harness state ──────────────────────────────────────────

const log = createLogger("agent-config-api-test");

// Suppress noisy log output during tests
const savedLogLevel = process.env.SYNAPSE_LOG_LEVEL;
process.env.SYNAPSE_LOG_LEVEL = "error";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
    console.log(`    ${err.stack}`);
  }
}

console.log("src/orchestrator/agent-config-api.integration.test.mjs\n");

// ─── Helpers ─────────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createHttpServer(() => {});
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForServer(port, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return;
    } catch {
      /* server not ready yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Server didn't start within ${timeoutMs}ms`);
}

function makeAgentConfig(id, overrides = {}) {
  return {
    id,
    name: overrides.name || `Agent ${id}`,
    model: overrides.model || "gpt-4o",
    color: overrides.color || "#3b82f6",
    role: overrides.role || "analyst",
    provider: overrides.provider || "openai",
    status: "active",
    permissions: overrides.permissions || [],
    denyActions: overrides.denyActions || [],
    skills: overrides.skills || [],
  };
}

function makeAgentsConfig(agentsList) {
  return {
    agents: agentsList,
    roles: {
      analyst: {
        description: "Analyst role",
        permissions: ["read", "analyze"],
        denyActions: [],
      },
      coder: {
        description: "Coder role",
        permissions: ["read", "write", "execute"],
        denyActions: [],
      },
    },
  };
}

// ─── Test runner ─────────────────────────────────────────────────

async function runTests() {
  // Setup: create temp directory for test .synapse folder
  const tempBase = mkdtempSync(join(tmpdir(), "synapse-test-"));
  const tempSynapseDir = join(tempBase, ".synapse");
  mkdirSync(tempSynapseDir, { recursive: true });

  // Seed initial agents.json with 2 test agents
  const initialAgents = [
    makeAgentConfig("agent-alpha", {
      name: "Alpha Agent",
      model: "gpt-4o",
      role: "analyst",
      color: "#3b82f6",
    }),
    makeAgentConfig("agent-beta", {
      name: "Beta Agent",
      model: "claude-3",
      role: "coder",
      color: "#10b981",
    }),
  ];

  const initialConfig = makeAgentsConfig(initialAgents);
  writeFileSync(join(tempSynapseDir, "agents.json"), JSON.stringify(initialConfig, null, 2));

  // Create mock deps with real agents persistence functions
  const agents = {};
  let agentConfigData = initialConfig;

  function loadAgentsConfig() {
    const path = join(tempSynapseDir, "agents.json");
    if (existsSync(path)) {
      agentConfigData = JSON.parse(readFileSync(path, "utf-8"));
    }
    return agentConfigData;
  }

  function saveAgentsConfig() {
    const path = join(tempSynapseDir, "agents.json");
    writeFileSync(path, JSON.stringify(agentConfigData, null, 2));
  }

      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForServer(port, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return;
    } catch {
      /* server not ready yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Server didn't start within ${timeoutMs}ms`);
}

function makeAgentConfig(id, overrides = {}) {
  return {
    id,
    name: overrides.name || `Agent ${id}`,
    model: overrides.model || "gpt-4o",
    color: overrides.color || "#3b82f6",
    role: overrides.role || "analyst",
    provider: overrides.provider || "openai",
    status: "active",
    permissions: overrides.permissions || [],
    denyActions: overrides.denyActions || [],
    skills: overrides.skills || [],
  };
}

function makeAgentsConfig(agentsList) {
  return {
    agents: agentsList,
    roles: {
      analyst: {
        description: "Analyst role",
        permissions: ["read", "analyze"],
        denyActions: [],
      },
      coder: {
        description: "Coder role",
        permissions: ["read", "write", "execute"],
        denyActions: [],
      },
    },
  };
}

// ─── Test runner ─────────────────────────────────────────────────

async function runTests() {
  // Setup: create temp directory for test .synapse folder
  const tempBase = mkdtempSync(join(tmpdir(), "synapse-test-"));
  const tempSynapseDir = join(tempBase, ".synapse");
  mkdirSync(tempSynapseDir, { recursive: true });

  // Seed initial agents.json with 2 test agents
  const initialAgents = [
    makeAgentConfig("agent-alpha", {
      name: "Alpha Agent",
      model: "gpt-4o",
      role: "analyst",
      color: "#3b82f6",
    }),
    makeAgentConfig("agent-beta", {
      name: "Beta Agent",
      model: "claude-3",
      role: "coder",
      color: "#10b981",
    }),
  ];

  const initialConfig = makeAgentsConfig(initialAgents);
  writeFileSync(join(tempSynapseDir, "agents.json"), JSON.stringify(initialConfig, null, 2));

  // Create mock deps with real agents persistence functions
  const agents = {}; // This 'agents' object will be the local registry for the test
  let agentConfigData = initialConfig;

  function loadAgentsConfig() {
    const path = join(tempSynapseDir, "agents.json");
    if (existsSync(path)) {
      agentConfigData = JSON.parse(readFileSync(path, "utf-8"));
    }
    return agentConfigData;
  }

  function saveAgentsConfig() {
    const path = join(tempSynapseDir, "agents.json");
    writeFileSync(path, JSON.stringify(agentConfigData, null, 2));
  }

  // Clear the live agent config history to ensure clean state for tests
  _agentConfigHistoryLive.clear();

  // Create mock deps for agentConfigStore
  const agentConfigStoreDeps = {
    agents, // The local test agents object
    saveAgentsConfig, // The mock saveAgentsConfig function
    loadAgentsConfig, // The mock loadAgentsConfig function
    agentConfigHistory: _agentConfigHistoryLive, // Use the live history for the store to manage
    rollbackAgentConfig: _rollbackAgentConfigLive, // Pass the live rollback for the store to call
    getConfigHistory: _getConfigHistoryLive, // Pass the live get history for the store to call
    createLogger,
    config,
  };

  const agentConfigStore = createAgentConfigStore(agentConfigStoreDeps);

  const {
    getAgentConfig,
    updateAgentConfig,
    rollbackAgentConfig,
    getAgentConfigHistory,
    getAgentConfigMetadata,
  } = agentConfigStore;

  // Populate the agents registry from config
  for (const agent of agentConfigData.agents) {
    agents[agent.id] = {
      ...agent,
      _permissions: agent.permissions || [],
      _denyActions: agent.denyActions || [],
      _status: agent.status || "active",
    };
  }

  // Create API handler
  const handleApi = createHandleApi({
    PORT: 3000,
    stateManager: {
      baseDir: tempBase,
      projectsDir: join(tempBase, "projects"),
      listProjects: () => [],
      getProject: () => null,
      listChannels: () => [],
    },
    agents,
    loadAgentsConfig,
    saveAgentsConfig,
    addAgent: () => ({}),
    removeAgent: () => {},
    probeAgent: async () => ({ ok: true }),
    resolvePermissions: () => ({}),
    PROVIDERS: { openai: {}, anthropic: {} },
    config: {
      ...config,
      server: { ...config.server, projectDir: tempSynapseDir },
      orchestrator: {
        ...config.orchestrator,
        apiDefaultLimit: 50,
        defaultMessageLimit: 50,
      },
    },
    fallbackStates: new Map(),
    isAgentCoolingDown: () => false,
    agentCooldowns: new Map(),
    turnQueues: new Map(),
    taskManager: { listTasks: () => [], getTask: () => null },
    campaignManager: { listCampaigns: () => [], getCampaign: () => null },
    scheduleManager: { listSchedules: () => [], getSchedule: () => null },
    triggerManager: null,
    prefsManager: { getAll: () => ({}), getSchema: () => ({}) },
    agendaManager: { get: () => ({}) },
    getSessionMessageCount: () => 0,
    strategistDecomposeCampaign: async () => {},
    strategistInject: async () => {},
    strategistEvaluate: async () => {},
    addMessage: () => {},
    SERVER_START_TIME: Date.now(),
    auth: {
      checkRequest: () => true,
      isAuthenticated: () => ({ authenticated: true, userId: "tester" }),
      isEnabled: () => false,
    },
    webhookDispatcher: {
      store: { list: () => [], create: () => ({}), remove: () => false },
    },
    getCloudBudgetStatus: () => null,
    getVectorStore: () => null,
    sandbox: null,
    rateLimiter: null,
    credentialVault: null,
    events: {
      emit(event, data) {
        return Promise.resolve();
      },
      on() {},
      off() {},
    },
    telemetryStore: null,
    WS_EVENT_MAP: { "agent:config_updated": true },
    circuitBreaker: null,
    alertMonitor: null,
    performanceStore: null,
    dispatchLog: null,
    anomalyDetector: null,
    snapshotManager: null,
    agentConfigStore: {
      getAgentConfigMetadata, // Use the real one from the store
      updateAgentConfig,
      rollbackAgentConfig,
      getAgentConfigHistory,
    },
    agentConfigSchema: (await import("./agent-config-schema.js")).default,
  });

  // Start HTTP server
  const server = createHttpServer(handleApi);
  const port = await getFreePort();

  server.listen(port, async () => {
    await waitForServer(port);

    const baseUrl = `http://localhost:${port}`;

    try {
      // ─── Test 1: GET config for existing agent returns correct shape and values ───
      await test("GET config for existing agent returns correct shape and values", async () => {
        const res = await fetch(`${baseUrl}/api/agents/agent-alpha/config`);
        assert.equal(res.status, 200, "should return 200");
        const data = await res.json();
        assert.equal(data.id, "agent-alpha", "id should match");
        assert.equal(data.name, "Alpha Agent", "name should match");
        assert.equal(data.model, "gpt-4o", "model should match");
        assert.equal(data.role, "analyst", "role should match");
        assert.equal(data.provider, "openai", "provider should match");
        assert.equal(data.status, "active", "status should match");
        assert(Array.isArray(data.permissions), "permissions should be array");
        assert(Array.isArray(data.skills), "skills should be array");
        assert("lastModified" in data, "should include lastModified metadata");
      });

      // ─── Test 1a: GET config for non-existent agent returns 404 ───
      await test("GET config for non-existent agent returns 404", async () => {
        const res = await fetch(`${baseUrl}/api/agents/non-existent-agent/config`);
        assert.equal(res.status, 404, "should return 404");
        const data = await res.json();
        assert(data.error, "should include error message");
        assert(data.error.includes("non-existent-agent"), "error should mention agent id");
      });

      // ─── Test 2: PUT valid partial config (change model) returns 200, subsequent GET reflects change ───
      await test("PUT valid partial config (change model) returns 200, subsequent GET reflects change", async () => {
        const res = await fetch(`${baseUrl}/api/agents/agent-alpha/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4-turbo" }),
        });
        assert.equal(res.status, 200, "should return 200");
        const data = await res.json();
        assert.equal(data.model, "gpt-4-turbo", "model should be updated");

        // Verify with GET
        const getRes = await fetch(`${baseUrl}/api/agents/agent-alpha/config`);
        assert.equal(getRes.status, 200);
        const getData = await getRes.json();
        assert.equal(getData.model, "gpt-4-turbo", "GET should reflect change");
      });

      // ─── Test 3: PUT invalid config (negative timeout, unknown role) returns 400 with descriptive errors ───
      await test("PUT invalid config (negative timeout, unknown role) returns 400 with descriptive errors", async () => {
        // Test negative timeout
        const res1 = await fetch(`${baseUrl}/api/agents/agent-alpha/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timeout: -100 }),
        });
        assert.equal(res1.status, 400, "should return 400 for negative timeout");
        const err1 = await res1.json();
        assert(err1.error, "should include error message");
        assert(err1.details, "should include validation details");

        // Test unknown role (assuming 'nonexistent-role' is not in roles config)
        const res2 = await fetch(`${baseUrl}/api/agents/agent-alpha/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "nonexistent-role" }),
        });
        assert.equal(res2.status, 400, "should return 400 for unknown role");
        const err2 = await res2.json();
        assert(err2.error, "should include error message");
        assert(err2.details, "should include validation details");
      });

      // ─── Test 4: PUT to non-existent agent returns 404 ───
      await test("PUT to non-existent agent returns 404", async () => {
        const res = await fetch(`${baseUrl}/api/agents/non-existent-agent/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "test-model" }),
        });
        assert.equal(res.status, 404, "should return 404");
        const data = await res.json();
        assert(data.error, "should include error message");
        assert(data.error.includes("non-existent-agent"), "error should mention agent id");
      });

      // ─── Test 5: After valid PUT, rollback via PUT /rollback restores previous config, confirmed by GET ───
      await test("After valid PUT, rollback via PUT /rollback restores previous config, confirmed by GET", async () => {
        // First, update model to something new
        await fetch(`${baseUrl}/api/agents/agent-alpha/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-5-preview" }),
        });

        // Verify the update
        const getRes1 = await fetch(`${baseUrl}/api/agents/agent-alpha/config`);
        const getData1 = await getRes1.json();
        assert.equal(getData1.model, "gpt-5-preview", "model should be updated before rollback");

        // Now rollback
        const rollbackRes = await fetch(`${baseUrl}/api/agents/agent-alpha/config/rollback`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
        });
        assert.equal(rollbackRes.status, 200, "rollback should return 200");
        const rollbackData = await rollbackRes.json();
        assert.equal(rollbackData.model, "gpt-4-turbo", "rollback should restore to previous model");

        // Verify with GET
        const getRes2 = await fetch(`${baseUrl}/api/agents/agent-alpha/config`);
        const getData2 = await getRes2.json();
        assert.equal(getData2.model, "gpt-4-turbo", "GET should reflect rollback");
      });

      // ─── Test 6: Double rollback when no further history returns 404 or 409 ───
      await test("Double rollback when no further history returns 404 or 409", async () => {
        // First rollback (we already did one in test 5, so this should be the last)
        const rollbackRes1 = await fetch(`${baseUrl}/api/agents/agent-alpha/config/rollback`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
        });

        // Second rollback should fail
        const rollbackRes2 = await fetch(`${baseUrl}/api/agents/agent-alpha/config/rollback`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
        });

        assert(
          rollbackRes2.status === 404 || rollbackRes2.status === 409,
          `double rollback should return 404 or 409, got ${rollbackRes2.status}`
        );
        const errData = await rollbackRes2.json();
        assert(errData.error, "should include error message");
      });

      // ─── Test 7: Config history endpoint returns correct number of entries after multiple updates ───
      await test("Config history endpoint returns correct number of entries after multiple updates", async () => {
        // Make several updates to build history
        await fetch(`${baseUrl}/api/agents/agent-beta/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "model-1" }),
        });
        await fetch(`${baseUrl}/api/agents/agent-beta/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "model-2" }),
        });
        await fetch(`${baseUrl}/api/agents/agent-beta/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "model-3" }),
        });

        // Get history
        const historyRes = await fetch(`${baseUrl}/api/agents/agent-beta/config/history`);
        assert.equal(historyRes.status, 200, "should return 200");
        const history = await historyRes.json();

        assert(Array.isArray(history), "history should be array");
        assert(history.length >= 3, `history should have at least 3 entries, got ${history.length}`);

        // Verify each entry has required fields
        for (const entry of history) {
          assert(entry.timestamp, "each entry should have timestamp");
          assert(entry.config, "each entry should have config");
          assert(entry.config.model, "config should have model");
        }
      });

      // ─── Test 8: Concurrent PUT requests don't corrupt agents.json (fire 5 PUTs in parallel, verify file is valid JSON after all complete) ───
      await test("Concurrent PUT requests don't corrupt agents.json (fire 5 PUTs in parallel, verify file is valid JSON after all complete)", async () => {
        const agentId = "agent-alpha";
        const updates = [
          { model: "concurrent-1" },
          { model: "concurrent-2" },
          { model: "concurrent-3" },
          { model: "concurrent-4" },
          { model: "concurrent-5" },
        ];

        // Fire all PUTs in parallel
        const promises = updates.map((update, i) =>
          fetch(`${baseUrl}/api/agents/${agentId}/config`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(update),
          }).then((res) => {
            assert.equal(res.status, 200, `PUT ${i} should return 200`);
            return res.json();
          })
        );

        await Promise.all(promises);

        // Verify file is still valid JSON
        const agentsPath = join(tempSynapseDir, "agents.json");
        assert(existsSync(agentsPath), "agents.json should exist");

        const content = readFileSync(agentsPath, "utf-8");
        let parsedConfig;
        try {
          parsedConfig = JSON.parse(content);
        } catch (e) {
          assert.fail(`agents.json is not valid JSON: ${e.message}`);
        }

        assert(parsedConfig.agents, "parsed config should have agents array");
        const agent = parsedConfig.agents.find((a) => a.id === agentId);
        assert(agent, "agent should exist in parsed config");
        assert(agent.model === "concurrent-5", "last update should be reflected");
      });
    } finally {
      server.close();
    }

    // Teardown: clean up temp directory
    rmSync(tempBase, { recursive: true, force: true });

    // Print summary
    console.log();
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);

    // Restore log level
    if (savedLogLevel !== undefined) {
      process.env.SYNAPSE_LOG_LEVEL = savedLogLevel;
    }

    // Exit with appropriate code
    process.exit(failed > 0 ? 1 : 0);
  });
}

// Run tests
runTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});