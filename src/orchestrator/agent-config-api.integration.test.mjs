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
// createAgentConfigStore was used at line 191 but never imported -- the third
// ReferenceError in this file, all of them invisible while it did not parse.
import { createAgentConfigStore } from "./agent-config-store.js";
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
// Named failures, so the mocha assertion at the bottom can say WHICH of the
// nine checks broke. The `failed` counter alone was only ever read by
// process.exit(failed > 0 ? 1 : 0), which mocha never sees.
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err.message}`);
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
    // Serialise from the LIVE registry, the way production does.
    //
    // agents.js:552 builds its output with serializeAgentsConfig(config), i.e.
    // from the in-memory agent instances. This mock wrote agentConfigData --
    // the copy read off disk at startup -- while updateAgentConfig mutates
    // agents[agentId] IN PLACE (agent-config-store.js:111-120). So every
    // update returned 200, was visible through GET (which reads the same live
    // registry), and never reached the file: agents.json still held the
    // seeded "gpt-4o" after five successful PUTs.
    const path = join(tempSynapseDir, "agents.json");
    const serialized = {
      ...agentConfigData,
      agents: agentConfigData.agents.map((a) => {
        const live = agents[a.id];
        if (!live) return a;
        return {
          ...a,
          name: live.name ?? a.name,
          model: live.model ?? a.model,
          displayModel: live.displayModel ?? null,
          color: live.color ?? a.color,
          role: live.role ?? a.role,
          permissions: live._permissions ?? a.permissions,
          denyActions: live._denyActions ?? a.denyActions,
          skills: live.skills ?? a.skills,
          status: live._status ?? a.status,
        };
      }),
    };
    writeFileSync(path, JSON.stringify(serialized, null, 2));
  }

  // Removed three injected deps that referenced identifiers which do not exist
  // anywhere -- not in this file, not anywhere in src/:
  //
  //     agentConfigHistory:   _agentConfigHistoryLive
  //     rollbackAgentConfig:  _rollbackAgentConfigLive
  //     getConfigHistory:     _getConfigHistoryLive
  //
  // plus a `_agentConfigHistoryLive.clear()` above. Three ReferenceErrors that
  // node --check cannot see and that nothing could observe while the file
  // failed to parse.
  //
  // They are not merely undeclared, they are backwards. rollbackAgentConfig
  // and getConfigHistory are values the store RETURNS (agent-config-store.js
  // :219-225), not deps it accepts, and createAgentConfigStore destructures
  // only { agents, saveAgentsConfig, createLogger, config } -- it builds its
  // own private `agentConfigHistory = new Map()` at line 22. So all three were
  // accepted and discarded. Declaring stand-ins would have preserved the
  // appearance of wiring without any of the effect; test isolation comes from
  // the store being constructed fresh per run, which it already is.
  const agentConfigStoreDeps = {
    agents, // The local test agents object
    saveAgentsConfig, // The mock saveAgentsConfig function
    loadAgentsConfig, // The mock loadAgentsConfig function
    createLogger,
    config,
  };

  const agentConfigStore = createAgentConfigStore(agentConfigStoreDeps);

  // The destructure that used to be here pulled `getAgentConfig` and
  // `getAgentConfigHistory` off the store. Neither exists -- the store returns
  // buildConfig and getConfigHistory (agent-config-store.js:219-225) -- so both
  // were silently undefined. It existed only to rebuild a subset object for the
  // api deps below, which is now handed the store itself.

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
    // Pass the store itself rather than a hand-picked subset. The subset
    // OMITTED buildConfig, which api.js:1909 calls on the very first request,
    // so every GET /api/agents/:id/config threw
    // "agentConfigStore.buildConfig is not a function" inside the HTTP handler
    // -- the request then never got a response and the test's fetch hung
    // forever rather than failing.
    //
    // api.js touches exactly five methods (1908, 1909, 1948, 1985, 2008):
    // getAgentConfigMetadata, buildConfig, updateAgentConfig,
    // rollbackAgentConfig, getConfigHistory. That is precisely the store's
    // surface, so passing it whole cannot drift out of sync the way a
    // hand-maintained subset did.
    agentConfigStore,
    // The MODULE NAMESPACE, not .default. agent-config-schema.js exports only a
    // named validateAgentConfig and has no default export, so `.default` was
    // undefined and api.js:1937 threw
    // "Cannot read properties of undefined (reading 'validateAgentConfig')"
    // inside the PUT handler -- returned to the caller as a 400 with that
    // message as the error body.
    //
    // That single mis-wire accounts for every remaining failure in this file:
    // no PUT ever applied, so there was nothing to roll back, no config history
    // to count, and the concurrent-PUT check had five failed writes.
    agentConfigSchema: await import("./agent-config-schema.js"),
  });

  // Start HTTP server
  const server = createHttpServer(handleApi);
  const port = await getFreePort();

  // The whole test body lives in this callback. It was never awaited, so
  // runTests() used to resolve immediately and the process only ended because
  // of the process.exit() at the bottom. Under mocha that would report a pass
  // without having run a single check. Wrapping it makes runTests() honest.
  await new Promise((resolve, reject) => {
  server.listen(port, async () => {
   try {
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
        // ONE OF the five, not specifically the fifth.
        //
        // These are fired with updates.map(...) and awaited together, so
        // nothing orders them: arrival order is not submission order, and each
        // handler is async. "concurrent-5 wins" asserts a serialisation the
        // test never established.
        //
        // What IS meaningful, and is what the test is named for, is that a
        // COMPLETE value from a single writer survives -- no torn or merged
        // result, and no reversion to the seeded value (which is exactly the
        // failure the mock above was hiding).
        const submitted = updates.map((u) => u.model);
        assert(
          submitted.includes(agent.model),
          `expected one of ${submitted.join(", ")}, got "${agent.model}"`,
        );
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

    // Was process.exit(failed > 0 ? 1 : 0). Under mocha that kills the whole
    // run, every other test file included. The verdict is carried by the
    // assertion in the it() below instead.
    resolve();
   } catch (err) { reject(err); }
  });
  });
}

describe("agent config API integration", function () {
  // Nine HTTP round trips against a real server on a temp .synapse dir.
  this.timeout(60000);

  it("passes every agent-config API check", async () => {
    await runTests();
    assert.equal(
      failures.length, 0,
      `${failures.length} of ${passed + failed} checks failed:\n  - ${failures.join("\n  - ")}`
    );
  });
});