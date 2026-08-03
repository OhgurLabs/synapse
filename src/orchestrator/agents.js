// orchestrator/agents.js — Agent registry & lifecycle management
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { registerPersonaHash } from './permissions.js';
export { registerPersonaHash };
import { commitPaths } from './git-branches.js';
import { createLogger } from '../logger.js';
const log = createLogger('agents');

// Phase 4 — bespoke per-CLI classes (claude.js, codex.js, gemini.js, opencode.js)
// were deleted after Phase 2 migrated their behavior into descriptors in
// src/harnesses/registry.js. The PROVIDERS map below is now ENTIRELY built
// from DESCRIPTOR_PROVIDERS — there are no hardcoded class imports.
//
// glm.js and llama.js are kept because they back the wrapper-HTTP path that
// some legacy agents.json entries still target directly; the opencode
// descriptor also exposes 'glm' / 'ollama' / 'llama' provider ids and
// will overwrite these via the DESCRIPTOR_PROVIDERS spread when those
// agents are routed through opencode.json instead.
import { GlmAgent } from '../agents/glm.js';
import { LlamaAgent } from '../agents/llama.js';

// BYOH descriptor-driven CLI agent. All provider-classes for descriptor
// harnesses are synthesized at module load via descriptorBackedAgentClass().
import { CliAgent } from '../agents/cli-runner.js';
import { DESCRIPTORS, getDescriptor, getHarness, detectHarness } from '../harnesses/registry.js';
import { validateDescriptor } from '../harnesses/descriptor-schema.js';

// Exported agent registry and execution capability set
export const agents = {}; // populated on init
export const EXECUTION_CAPABLE = new Set();

/**
 * Build a constructor-shaped function that pre-binds a descriptor into the
 * CliAgent's config. Lets the existing PROVIDERS map mechanism (new ProviderClass(config))
 * work transparently for descriptor-backed providers — no change to addAgent's call site.
 */
function descriptorBackedAgentClass(descriptor) {
  const validation = validateDescriptor(descriptor);
  if (!validation.ok) {
    log.error('Invalid harness descriptor — refusing to register', {
      descriptorId: descriptor.id,
      errors: validation.errors,
    });
    // Fall through with a stub that errors on use — better than crashing the
    // whole orchestrator at module load.
    return class InvalidDescriptorAgent {
      constructor() { throw new Error(`Invalid descriptor "${descriptor.id}": ${validation.errors.join('; ')}`); }
    };
  }
  const normalized = validation.descriptor;
  // Return a wrapper class whose constructor calls CliAgent with the descriptor injected.
  return class DescriptorBackedAgent extends CliAgent {
    constructor(config = {}) {
      super({ ...config, descriptor: normalized });
    }
  };
}

// Build the descriptor-backed providers from the registry. Each descriptor's
// identity.providers entries become provider keys in PROVIDERS.
const DESCRIPTOR_PROVIDERS = {};
for (const desc of DESCRIPTORS) {
  const klass = descriptorBackedAgentClass(desc);
  for (const provId of (desc.identity?.providers || [desc.id])) {
    DESCRIPTOR_PROVIDERS[provId] = klass;
  }
}

// Phase 4 — PROVIDERS map is now built entirely from descriptor-backed entries
// (claude/codex/gemini/opencode descriptors landed in Phase 2, grok+aider since
// Phase 1). The bespoke .js files for those four have been deleted from the
// repo. glm/ollama/llama remain as wrapper-HTTP fallbacks for legacy
// agents.json entries that target them directly; the opencode descriptor
// claims those provider ids too and overrides via the spread when the
// agents.json entry routes via opencode.
export const PROVIDERS = {
  // Wrapper-HTTP fallbacks for direct-targeted legacy entries
  glm: GlmAgent,
  ollama: LlamaAgent,
  // BYOH descriptor-backed entries — covers claude/codex/gemini/opencode/grok/aider
  // and (via opencode's identity.providers) glm/ollama/llama too.
  ...DESCRIPTOR_PROVIDERS,
};

// Provider names that participate in execution capability. Includes the
// existing bespoke 4 plus glm/ollama (wrapper-HTTP) plus any descriptor
// providers whose capabilities.execution is true.
const _executionCapableFromDescriptors = DESCRIPTORS
  .filter(d => d.capabilities?.execution !== false)
  .flatMap(d => d.identity?.providers || [d.id]);
export const EXECUTION_CAPABLE_PROVIDERS = new Set([
  'claude', 'codex', 'gemini', 'opencode', 'glm', 'ollama',
  ..._executionCapableFromDescriptors,
]);

// Default role permissions — ensure execution-capable roles get code:execute
// so agents can bypass provider-level approval gates (--dangerously-skip-permissions,
// --sandbox danger-full-access, etc.) and actually write files during task execution.
// These defaults are overridden by explicit roles in agents.json.
let rolesConfig = {
  developer:  { permissions: ['code:execute', 'task:execute', 'task:plan'] },
  architect:  { permissions: ['code:execute', 'task:execute', 'task:plan'] },
  reviewer:   { permissions: ['code:execute', 'task:execute', 'task:plan'] },
  governor:   { permissions: ['code:execute', 'task:execute'] },
  // researcher: writes notes, reports, and findings docs the same as developers
  // do — needs code:execute so canBypassPermissions() returns true and the harness
  // gets --dangerously-skip-permissions / --always-approve / equivalent flag.
  // Without it, headless dispatch hangs on the harness's permission prompt and
  // cancels with no useful output (researcher-role agents on grok-like
  // harnesses cancelled where developer-role agents on the same harness
  // completed, until role:researcher gained code:execute parity).
  researcher: { permissions: ['code:execute', 'task:execute', 'task:plan'] },
};
// Effective role definitions: code defaults merged with any agents.json
// overrides (merge happens in loadAgentsConfig). The /api/roles endpoint
// must serve THIS, not the raw file section — a fresh install has no
// `roles` section on disk, and serving `{}` left the agent-settings Role
// dropdown with nothing but "No role" (settings-pass finding, 2026-08-02).
export function getEffectiveRoles() { return rolesConfig; }

let onboardingConfig = {
  probePrompt: 'Respond with exactly: SYNAPSE_PROBE_OK followed by your name and role.',
  probeTimeoutMs: 30000,
  probeMaxRetries: 2,
};
// Raw `onboarding` section of agents.json, captured at load and re-serialized
// verbatim on save. Memory-authoritative: saveAgentsConfig used to read this
// (and roles) BACK FROM DISK to preserve them — which let an agent-tampered
// file launder its roles/onboarding edits into the next legitimate save.
let _onboardingSection = null;

// Optional callback for notifying orchestrator when agents change
let _onAgentsUpdated = null;
let _cachedConfig = null; // set by initAgents, used as fallback by loadAgentsConfig
let _agentState = null; // runtime state (paused flags) persisted to agents-state.json
export function setOnAgentsUpdated(fn) { _onAgentsUpdated = fn; }

// Optional callback invoked after a freshly-registered agent finishes its
// introduction probe. The orchestrator wires this to post the response into
// the System/#general channel so the user sees the new agent come to life.
// Signature: (agentId, agentName, response, error) — exactly one of
// response/error is populated.
let _onAgentIntroduced = null;
export function setOnAgentIntroduced(fn) { _onAgentIntroduced = fn; }

// Agent state persistence functions
function loadAgentState() {
  const synapseDir = join(_cachedConfig.server.projectDir, '.synapse');
  const statePath = join(synapseDir, 'agents-state.json');
  try {
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      _agentState = state || {};
      log.info('Loaded agent state', { pausedCount: Object.values(state).filter(s => s.paused).length });
    } else {
      _agentState = {};
      log.debug('No agent state file found, initialized empty state');
    }
  } catch (e) {
    log.warn('Failed to load agent state', { error: e.message });
    _agentState = {};
  }
}

function saveAgentState() {
  if (!_cachedConfig || !_agentState) return;
  const synapseDir = join(_cachedConfig.server.projectDir, '.synapse');
  const statePath = join(synapseDir, 'agents-state.json');
  try {
    const tmpPath = join(synapseDir, 'agents-state.json.tmp');
    writeFileSync(tmpPath, JSON.stringify(_agentState, null, 2) + '\n');
    renameSync(tmpPath, statePath);
    log.debug('Saved agent state', { pausedCount: Object.values(_agentState).filter(s => s.paused).length });
  } catch (e) {
    log.error('Failed to save agent state', { error: e.message });
  }
}

export function isAgentPaused(agentId) {
  return _agentState && _agentState[agentId] && _agentState[agentId].paused === true;
}

export function setAgentPaused(agentId, paused, reason = null) {
  if (!_agentState) _agentState = {};
  if (!_agentState[agentId]) _agentState[agentId] = {};
  _agentState[agentId].paused = paused;
  if (paused && reason) {
    _agentState[agentId].pauseReason = reason;
    _agentState[agentId].pausedAt = Date.now();
    log.info('Agent paused', { agentId, reason, pausedAt: new Date(_agentState[agentId].pausedAt).toISOString() });
  } else if (!paused) {
    _agentState[agentId].resumedAt = Date.now();
    delete _agentState[agentId].pauseReason;
    log.info('Agent resumed', { agentId, resumedAt: new Date(_agentState[agentId].resumedAt).toISOString() });
  } else {
    log.info('Agent pause state changed', { agentId, paused });
  }
  saveAgentState();
}

function notifyAgentsUpdated() {
  if (_onAgentsUpdated) _onAgentsUpdated(agents);
}

export function resolvePermissions(agentId) {
  const agent = agents[agentId];
  if (!agent) return [];
  const roleDef = rolesConfig[agent.role];
  const rolePerms = roleDef?.permissions || [];
  const agentPerms = agent._permissions || [];
  if (rolePerms.includes('*') || agentPerms.includes('*')) return ['*'];
  return [...new Set([...rolePerms, ...agentPerms])];
}

export function checkPermission(agentId, permission) {
  const perms = resolvePermissions(agentId);
  const has = perms.includes('*') || perms.includes(permission);
  if (!has) {
    log.warn('Permission denied', { agentId, permission, has: perms.join(', ') });
  }
  return has;
}

export async function probeAgent(agentId, projectDir) {
  const agent = agents[agentId];
  if (!agent) return { ok: false, response: 'Agent not found' };

  const prompt = onboardingConfig.probePrompt;
  const timeout = onboardingConfig.probeTimeoutMs || 30000;
  const deadline = Date.now() + timeout;

  try {
    let response;
    for (;;) {
      try {
        response = await Promise.race([
          agent.send(prompt, projectDir, { maxTurns: 1, probe: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Probe timed out')), Math.max(1000, deadline - Date.now()))),
        ]);
        break;
      } catch (err) {
        // Per-agent exclusivity contention (a startup introduction or a
        // real dispatch holds the agent's slot) is NOT a verdict on the
        // agent — it failed every wizard canary instantly whenever the
        // service had just restarted. Wait and retry within the probe
        // budget; anything else (or budget exhausted) propagates.
        if (/already has an active process/.test(err?.message || '') && Date.now() + 5000 < deadline) {
          log.info('Probe deferred: agent slot busy, retrying', { agentId, msLeft: deadline - Date.now() });
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        throw err;
      }
    }

    // Harnesses return ResponseObject ({text, tokens…}), not bare strings.
    // The old `typeof === 'string'` gate marked every successful probe as
    // failed while displaying the correct text beside it (ResponseObject
    // delegates .substring/.includes, so the message rendered fine).
    const text = typeof response === 'string' ? response
      : (response?.text != null ? String(response.text) : String(response ?? ''));
    const ok = text.includes('SYNAPSE_PROBE_OK');
    return { ok, response: text.substring(0, 500) };
  } catch (err) {
    // A timed-out probe MUST NOT leave its CLI running: the abandoned
    // process holds the per-agent exclusivity slot and every subsequent
    // validation/dispatch fails "already has an active process".
    if (/Probe timed out/.test(err.message || '')) {
      try {
        const killed = agent.sandbox?.killByAgent?.(agent.name || agentId, 'probe_timeout') || 0;
        if (killed) log.warn('Probe timeout: killed abandoned probe process', { agentId, killed });
      } catch { /* best-effort cleanup */ }
    }
    return { ok: false, response: err.message };
  }
}

/**
 * Ask a freshly-registered agent to introduce itself in the Synapse #general
 * channel. Unlike probeAgent (which parses for a magic marker used by the
 * validation pipeline and /api/agents/:id/probe), this uses a chat-style
 * prompt and returns the raw response so the caller can post it into
 * System/#general. The agent's existing credentials/endpoint/harness all
 * resolve normally — Synapse never sees auth.
 *
 * Returns { ok: boolean, response: string } — same shape as probeAgent.
 * ok = non-empty response within timeout. No marker check.
 */
export async function introduceAgent(agentId, projectDir) {
  const agent = agents[agentId];
  if (!agent) return { ok: false, response: 'Agent not found' };

  const prompt =
    'Introduce yourself in one short sentence to the Synapse #general channel. ' +
    'Mention your model and your role. Keep it under 30 words. Do not use preamble like "Sure" or "Of course."';
  const timeout = onboardingConfig.probeTimeoutMs || 30000;

  // The introduction fires on registration, and on the wizard path a
  // validation probe spawns for the SAME agent seconds later — per-agent
  // exclusivity makes one of the two die ("exit 1" with nothing useful in
  // it; reproduced on two fresh installs). The probe already waits out
  // contention (probeAgent); the introduction gets the same courtesy.
  // Escalating pauses: a single 20s pause was not enough when the agent
  // was added while same-provider chat traffic (a draining council) held
  // the provider slot — both attempts failed and a healthy CLI got a
  // terminal red badge (settings-pass finding F4, 2026-08-02).
  const pauses = [20_000, 60_000];
  let lastErr = 'no attempts ran';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await Promise.race([
        agent.send(prompt, projectDir, { maxTurns: 1, probe: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Introduction timed out')), timeout)),
      ]);

      // Harnesses return ResponseObject ({text, tokens…}) — coerce before the
      // emptiness check (the typeof-string gate marked every successful
      // introduction as failed; same class as probeAgent/test-dispatch).
      const text = typeof response === 'string' ? response
        : (response?.text != null ? String(response.text) : String(response ?? ''));
      const trimmed = text.trim();
      if (trimmed.length > 0) return { ok: true, response: trimmed.substring(0, 2000) };
      lastErr = 'empty response';
    } catch (err) {
      lastErr = err.message;
    }
    if (attempt <= pauses.length) {
      log.info(`Introduction attempt ${attempt} failed — retrying after contention pause`, { agentId, error: lastErr, pauseMs: pauses[attempt - 1] });
      await new Promise(r => setTimeout(r, pauses[attempt - 1]));
    }
  }
  return { ok: false, response: lastErr };
}

export function loadAgentsConfig(config) {
  config = config || _cachedConfig;
  const synapseDir = join(config.server.projectDir, '.synapse');
  const configPath = join(synapseDir, 'agents.json');
  let agentsCfg;

  if (existsSync(configPath)) {
    try {
      agentsCfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (e) {
      log.error('Failed to parse agents.json', { error: e.message });
    }
  }

  if (!agentsCfg) {
    // First boot (or corrupt file): seed only harnesses whose CLI is actually
    // present on this host. Seeding an undetected harness hands every new
    // user a guaranteed validation failure in the onboarding wizard. If
    // nothing is detected the roster stays empty, which is exactly the state
    // the wizard's first-agent builder is designed for.
    const defaults = config.agents?.defaults || {};
    const candidates = [
      { id: 'claude', name: 'Claude', provider: 'claude', color: defaults.claude?.color, harnessId: 'claudecode' },
      { id: 'codex', name: 'Codex', provider: 'codex', color: defaults.codex?.color, harnessId: 'codex' },
      { id: 'gemini', name: 'Gemini', provider: 'gemini', color: defaults.gemini?.color, harnessId: 'gemini-cli' },
    ];
    const seeded = candidates.filter((c) => {
      const harness = getHarness(c.harnessId);
      if (!harness) return false;
      try { return detectHarness(harness).found; } catch { return false; }
    });
    log.warn('Using default agent configuration', {
      reason: 'agents.json missing or corrupt',
      configPath,
      seeded: seeded.map((a) => a.id),
      skipped: candidates.filter((c) => !seeded.includes(c)).map((a) => a.id),
    });
    agentsCfg = { agents: seeded.map(({ harnessId, ...agent }) => agent) };
  }

  // Resolve persona files into persona strings
  for (const agent of agentsCfg.agents) {
    if (agent.personaFile) {
      const personaPath = join(synapseDir, agent.personaFile);
      if (existsSync(personaPath)) {
        try {
          agent.persona = readFileSync(personaPath, 'utf-8').trim();
          registerPersonaHash(agent.id, agent.persona);
          log.info('Loaded persona', { agent: agent.name, path: personaPath });
        } catch (e) {
          log.error('Failed to read persona', { agent: agent.name, error: e.message });
        }
      } else {
        log.warn('Persona file not found', { agent: agent.name, path: personaPath });
      }
    }
  }

  // Load roles and onboarding config
  if (agentsCfg.roles) rolesConfig = { ...rolesConfig, ...agentsCfg.roles };
  if (agentsCfg.onboarding) onboardingConfig = { ...onboardingConfig, ...agentsCfg.onboarding };
  if (agentsCfg.onboarding) _onboardingSection = { ...agentsCfg.onboarding };

  return agentsCfg;
}

export function initAgents(config, operatorAuditStore = null, metricsStore = null) {
  _cachedConfig = config;
  loadAgentState();
  const agentsCfg = loadAgentsConfig(config);
  const enabled = process.env.AGENTS
    ? new Set(process.env.AGENTS.split(',').map(s => s.trim()))
    : null; // null = all

  for (const agentDef of agentsCfg.agents) {
    if (enabled && !enabled.has(agentDef.id)) continue;

    const ProviderClass = PROVIDERS[agentDef.provider];
    if (!ProviderClass) {
      log.error('Unknown provider', { provider: agentDef.provider, agentId: agentDef.id });
      continue;
    }

    const inst = new ProviderClass({
      name: agentDef.name,
      model: agentDef.model,
      color: agentDef.color,
      persona: agentDef.persona,
      projectDir: config.server.projectDir,
      endpoint: agentDef.endpoint,                   // per-agent endpoint override (ollama variants)
      opencodeProvider: agentDef.opencodeProvider,   // opencode provider prefix (ollama variants)
      // BYOH: operator-set fields from agents.json — were silently dropped here
      // before, which forced every descriptor-backed agent to rely on PATH/which
      // resolution and could not honor explicit cliPath overrides.
      cliPath: agentDef.cliPath,
      cliArgs: agentDef.cliArgs,
      harnessOptions: agentDef.harnessOptions,
      baseUrl: agentDef.baseUrl,
      apiKeyEnv: agentDef.apiKeyEnv,
      auditLogger: operatorAuditStore,               // AuditLogger for provider dispatch audit trail
      metricsStore: metricsStore,                     // ProviderMetricsStore for latency tracking
    });
    inst.skills = agentDef.skills || [];
    inst.provider = agentDef.provider;
    inst.role = agentDef.role || null;
    inst._permissions = agentDef.permissions || [];
    inst._denyActions = agentDef.denyActions || [];
    inst._status = agentDef.status || 'active';
    inst._timeout = agentDef.timeout || null;
    inst._sandboxLimits = agentDef.sandboxLimits || null;
    // Per-agent tool-level allowlists (optional — overrides role defaults at the tool level)
    // Format: { allow: ['read', 'grep'], deny: ['bash', 'write'] }
    // If tools.allow is present, ONLY listed tools are permitted.
    // If tools.deny is present, those tools are blocked regardless.
    inst._toolsConfig = agentDef.tools || null;
    agents[agentDef.id] = inst;

    // Build execution-capable set from provider
    if (EXECUTION_CAPABLE_PROVIDERS.has(agentDef.provider)) {
      EXECUTION_CAPABLE.add(agentDef.id);
    }
  }

  log.info('Agents initialized', { agents: Object.keys(agents).join(', '), auditLoggerConfigured: !!operatorAuditStore });
}

/**
 * Build the canonical agents.json object from LIVE MEMORY only — agents
 * from the instance registry, roles from rolesConfig, onboarding from the
 * section captured at load. No disk read-back: reading the file to
 * "preserve" sections let an agent-tampered roles block ride through the
 * next legitimate save (laundering). Memory is the source of truth.
 */
export function buildAgentsConfigObject(config) {
  config = config || _cachedConfig;
  const synapseDir = join(config.server.projectDir, '.synapse');
  // Rebuild agents array from live state.
  // CRITICAL: every field that may live on the instance must be preserved here.
  // Earlier the rebuild silently dropped `endpoint`, `displayModel`, `baseUrl`,
  // `apiKeyEnv`, `persona`, and `bypassCodeExecutionCheck` — so any save through
  // /api/agents/:id/config destroyed those values, including the endpoint that
  // an ollama agent needs to even instantiate. Saving a setting on an Ollama
  // agent crashed synapse on the next restart.
  const agentsCfg = { agents: [] };
  for (const [id, agent] of Object.entries(agents)) {
    // Prefer the agent's STORED provider (set from config at load — `inst.provider =
    // agentDef.provider`, ~line 355; and in addAgent). Re-deriving via `instanceof` is
    // LOSSY: the opencode descriptor synthesizes the SAME class for the glm/ollama/llama
    // provider ids (PROVIDERS.glm === PROVIDERS.ollama === PROVIDERS.llama), so instanceof
    // matches whichever is FIRST in iteration order (glm) and silently rewrites
    // opencode-routed local agents (provider ollama) to glm. Before commit-on-save
    // that mis-write was reverted by the governance check every task; now it persists,
    // turning local agents into "glm" agents. Round-trip the known provider; fall back to
    // instanceof only if the instance somehow has no stored provider.
    let provider = agent.provider;
    if (!provider || provider === 'unknown') {
      for (const [prov, Cls] of Object.entries(PROVIDERS)) {
        if (agent instanceof Cls) { provider = prov; break; }
      }
    }
    const entry = { id, name: agent.name, provider: provider || 'unknown', model: agent.model, color: agent.color };
    if (agent.displayModel) entry.displayModel = agent.displayModel;
    if (agent.endpoint) entry.endpoint = agent.endpoint;
    if (agent.baseUrl) entry.baseUrl = agent.baseUrl;
    if (agent.apiKeyEnv) entry.apiKeyEnv = agent.apiKeyEnv;
    if (agent.role) entry.role = agent.role;
    entry.status = agent._status || 'active';
    entry.permissions = agent._permissions || [];
    if (agent.skills?.length > 0) entry.skills = agent.skills;
    if (agent._denyActions?.length > 0) entry.denyActions = agent._denyActions;
    if (agent._timeout) entry.timeout = agent._timeout;
    if (agent._sandboxLimits) entry.sandboxLimits = agent._sandboxLimits;
    if (agent._toolsConfig) entry.tools = agent._toolsConfig;
    if (agent.cliPath) entry.cliPath = agent.cliPath;
    if (agent.cliArgs?.length > 0) entry.cliArgs = agent.cliArgs;
    if (agent.harnessOptions && Object.keys(agent.harnessOptions).length > 0) entry.harnessOptions = agent.harnessOptions;
    if (agent.bypassCodeExecutionCheck) entry.bypassCodeExecutionCheck = true;
    // Inline persona text (separate from the on-disk persona.md path).
    if (agent.persona && typeof agent.persona === 'string') entry.persona = agent.persona;
    // Preserve persona file path: prefer explicit field, else infer from disk.
    if (agent.personaFile) {
      entry.personaFile = agent.personaFile;
    } else {
      const personaPath = join(synapseDir, 'agents', id, 'persona.md');
      if (existsSync(personaPath)) entry.personaFile = `agents/${id}/persona.md`;
    }
    agentsCfg.agents.push(entry);
  }
  // Roles + onboarding from MEMORY (see function doc — never from disk).
  if (Object.keys(rolesConfig).length > 0) agentsCfg.roles = rolesConfig;
  if (_onboardingSection) agentsCfg.onboarding = _onboardingSection;
  return agentsCfg;
}

/**
 * The exact byte content saveAgentsConfig writes. Exported so the
 * governance integrity check can recognize the orchestrator's own writes:
 * disk === serializeAgentsConfig() ⇒ legitimate self-write, not tampering.
 */
export function serializeAgentsConfig(config) {
  return JSON.stringify(buildAgentsConfigObject(config), null, 2) + '\n';
}

export function saveAgentsConfig(config) {
  config = config || _cachedConfig;
  const synapseDir = join(config.server.projectDir, '.synapse');
  const cfgPath = join(synapseDir, 'agents.json');
  const tmpPath = join(synapseDir, 'agents.json.tmp');
  const serialized = serializeAgentsConfig(config);
  try {
    // Create versioned backup before overwriting
    if (existsSync(cfgPath)) {
      const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 18) + 'Z';
      const bakPath = join(synapseDir, `agents.json.bak.${ts}`);
      copyFileSync(cfgPath, bakPath);
      // Prune backups — keep only 5 most recent
      const baks = readdirSync(synapseDir)
        .filter(f => f.startsWith('agents.json.bak.'))
        .sort() // ISO timestamps sort lexicographically = chronologically
        .reverse(); // newest first
      for (const old of baks.slice(5)) {
        try { unlinkSync(join(synapseDir, old)); } catch {}
      }
    }
    // Atomic write: write to temp then rename
    writeFileSync(tmpPath, serialized);
    renameSync(tmpPath, cfgPath);
    // Commit the change so it lands in HEAD. agents.json is governance-protected;
    // the per-task integrity check reverts any governance file that differs from
    // its task-start snapshot via `git checkout HEAD --`. An uncommitted UI edit
    // is not in HEAD, so that revert silently undid every operator edit
    // (ship-blocker, incident 2026-06-15). Committing makes the operator edit
    // legitimate (tracked + clean vs HEAD) so the integrity check leaves it
    // alone. Best-effort: a non-git projectDir just skips this (commitPaths
    // returns false) and the edit still persists on disk.
    try {
      const rel = join('.synapse', 'agents.json');
      commitPaths(config.server.projectDir, [rel], 'synapse: operator agent-config update via UI');
    } catch (commitErr) {
      log.warn('saveAgentsConfig: wrote agents.json but commit failed (edit persists on disk)', { error: commitErr.message });
    }
  } catch (e) {
    log.warn('saveAgentsConfig: could not write agents.json', { error: e.message });
  }
}

export function addAgent(config, def) {
  if (def === undefined && typeof config === 'object' && !config.server) { def = config; config = undefined; }
  config = config || _cachedConfig;
  const {
    id, name, provider, model, displayModel, color, skills, persona, personaFile, role,
    permissions, denyActions, timeout, sandboxLimits, cliPath, cliArgs, harnessOptions,
    endpoint, baseUrl, apiKeyEnv, bypassCodeExecutionCheck,
  } = def;
  if (!id || !provider) throw new Error('id and provider required');
  if (agents[id]) throw new Error(`Agent "${id}" already exists`);
  // Name length cap matches agent-config-schema.js. Cap = 12 (≤8 displays
  // without truncation; 9-12 truncates on standard badge but tooltip shows
  // full). Governors get 18 to fit "governor-<9-char>" convention.
  const displayName = name || id;
  const isGovernor = /^governor-/i.test(displayName);
  const maxNameLen = isGovernor ? 18 : 12;
  if (displayName.length > maxNameLen) {
    throw new Error(`Agent name must be ${maxNameLen} characters or fewer (got ${displayName.length}).`);
  }
  const ProviderClass = PROVIDERS[provider];
  if (!ProviderClass) throw new Error(`Unknown provider "${provider}". Available: ${Object.keys(PROVIDERS).join(', ')}`);

  log.info('Agent starting registration', { agentId: id, provider, name: name || id });

  const agentRole = role || 'developer'; // default role
  if (rolesConfig && Object.keys(rolesConfig).length > 0 && !rolesConfig[agentRole]) {
    log.warn('Unknown role', { role: agentRole, agentId: id, available: Object.keys(rolesConfig).join(', ') });
  }

  const inst = new ProviderClass({
    name: name || id,
    model: model || undefined,
    color: color || '#888888',
    persona: persona || null,
    projectDir: config.server.projectDir,
    cliPath: cliPath || undefined,
    cliArgs: cliArgs || undefined,
    harnessOptions: harnessOptions || undefined,
    endpoint: endpoint || undefined,
    baseUrl: baseUrl || undefined,
    apiKeyEnv: apiKeyEnv || undefined,
  });
  inst.skills = skills || [];
  inst.provider = provider;
  inst.role = agentRole;
  inst._permissions = permissions || [];
  inst._denyActions = denyActions || [];
  inst._status = 'registered'; // Start as registered, probe will activate
  inst._timeout = timeout || null;
  inst._sandboxLimits = sandboxLimits || null;
  if (displayModel) inst.displayModel = displayModel;
  if (personaFile) inst.personaFile = personaFile;
  if (bypassCodeExecutionCheck) inst.bypassCodeExecutionCheck = true;
  // Mirror onto inst directly so saveAgentsConfig's instance-field check sees them
  if (endpoint) inst.endpoint = endpoint;
  if (baseUrl) inst.baseUrl = baseUrl;
  if (apiKeyEnv) inst.apiKeyEnv = apiKeyEnv;
  agents[id] = inst;

  log.info('Agent instance created', { agentId: id, provider, role: agentRole, skills: inst.skills.length });

  // Build execution-capable set from provider
  if (EXECUTION_CAPABLE_PROVIDERS.has(provider)) {
    EXECUTION_CAPABLE.add(id);
    log.debug('Agent added to execution-capable set', { agentId: id, provider });
  }

  // Initialize paused state for new agent
  if (!_agentState) _agentState = {};
  _agentState[id] = { paused: false };
  saveAgentState();

  // Create persona directory + scaffold if persona provided
  const synapseDir = join(config.server.projectDir, '.synapse');
  const personaDir = join(synapseDir, 'agents', id);
  mkdirSync(personaDir, { recursive: true });
  if (persona) {
    writeFileSync(join(personaDir, 'persona.md'), persona);
    log.debug('Agent persona written', { agentId: id, personaPath: join(personaDir, 'persona.md') });
  }

  saveAgentsConfig(config);
  log.info('Agent registered', { agentId: id, provider, model: model || 'default', role: agentRole });

  // Fire-and-forget introduction — asks the agent to introduce itself in
  // System/#general. The response posts into chat via _onAgentIntroduced so
  // the user sees their new agent come to life (ok) or sees why it didn't
  // (failed). Status flips to 'active' on any non-empty response within the
  // probe timeout, 'failed' otherwise. See task 10d in init-wizard-design.md.
  log.info('Agent introduction initiated', { agentId: id, status: 'registered' });
  introduceAgent(id, config.server.projectDir).then(result => {
    if (result.ok) {
      inst._status = 'active';
      // Clear any prior validation error on success
      if (inst.lastValidationError) inst.lastValidationError = null;
      log.info('Agent introduced successfully', { agentId: id, status: 'active', provider });
      if (_onAgentIntroduced) {
        try { _onAgentIntroduced(id, inst.name || id, result.response, null); }
        catch (e) { log.warn('Failed to post agent intro to System/#general', { agentId: id, error: e.message }); }
      }
    } else {
      inst._status = 'failed';
      inst.lastValidationError = result.response || 'Introduction failed';
      log.error('Agent introduction failed', { agentId: id, response: result.response });
      if (_onAgentIntroduced) {
        try { _onAgentIntroduced(id, inst.name || id, null, result.response || 'Introduction failed'); }
        catch (e) { log.warn('Failed to post agent intro failure to System/#general', { agentId: id, error: e.message }); }
      }
    }
    saveAgentsConfig(config);
    notifyAgentsUpdated();
  }).catch(err => {
    inst._status = 'failed';
    inst.lastValidationError = err.message || 'Introduction threw';
    log.error('Agent introduction error', { agentId: id, error: err.message, stack: err.stack });
    if (_onAgentIntroduced) {
      try { _onAgentIntroduced(id, inst.name || id, null, err.message || 'Introduction threw'); }
      catch (e) { log.warn('Failed to post agent intro error to System/#general', { agentId: id, error: e.message }); }
    }
    saveAgentsConfig(config);
  });

  return { id, name: inst.name, color: inst.color, model: inst.model, provider, role: agentRole, status: 'registered' };
}

// Re-trigger the introduce-itself flow on an existing agent. Used after a
// failed agent's config is patched (e.g. the user fixed a bad cliPath via the
// settings modal) to give Synapse another shot at spawning the harness without
// requiring a delete + recreate cycle. Mirrors the post-addAgent introduce
// block above — same fire-and-forget pattern, same chat-side effects via
// _onAgentIntroduced, same persistence on resolution.
export function retryIntroduce(agentId, config) {
  config = config || _cachedConfig;
  const inst = agents[agentId];
  if (!inst) {
    log.warn('retryIntroduce: agent not found', { agentId });
    return;
  }
  inst._status = 'registered';
  inst.lastValidationError = null;
  log.info('Agent reintroduction initiated', { agentId, status: 'registered' });
  notifyAgentsUpdated();

  introduceAgent(agentId, config.server.projectDir).then(result => {
    if (result.ok) {
      inst._status = 'active';
      if (inst.lastValidationError) inst.lastValidationError = null;
      log.info('Agent reintroduced successfully', { agentId, status: 'active' });
      if (_onAgentIntroduced) {
        try { _onAgentIntroduced(agentId, inst.name || agentId, result.response, null); }
        catch (e) { log.warn('Failed to post agent reintro to System/#general', { agentId, error: e.message }); }
      }
    } else {
      inst._status = 'failed';
      inst.lastValidationError = result.response || 'Introduction failed';
      log.error('Agent reintroduction failed', { agentId, response: result.response });
      if (_onAgentIntroduced) {
        try { _onAgentIntroduced(agentId, inst.name || agentId, null, result.response || 'Introduction failed'); }
        catch (e) { log.warn('Failed to post agent reintro failure to System/#general', { agentId, error: e.message }); }
      }
    }
    saveAgentsConfig(config);
    notifyAgentsUpdated();
  }).catch(err => {
    inst._status = 'failed';
    inst.lastValidationError = err.message || 'Reintroduction threw';
    log.error('Agent reintroduction error', { agentId, error: err.message, stack: err.stack });
    if (_onAgentIntroduced) {
      try { _onAgentIntroduced(agentId, inst.name || agentId, null, err.message || 'Reintroduction threw'); }
      catch (e) { log.warn('Failed to post agent reintro error to System/#general', { agentId, error: e.message }); }
    }
    saveAgentsConfig(config);
  });
}

export function removeAgent(config, id) {
  if (id === undefined && typeof config === 'string') { id = config; config = undefined; }
  config = config || _cachedConfig;
  if (!agents[id]) throw new Error(`Agent "${id}" not found`);
  
  const agent = agents[id];
  log.info('Agent stopping', { agentId: id, provider: agent.provider, role: agent.role, status: agent._status });
  
  delete agents[id];
  
  EXECUTION_CAPABLE.delete(id);
  log.debug('Agent removed from execution-capable set', { agentId: id });
  
  if (_agentState && _agentState[id]) {
    delete _agentState[id];
    saveAgentState();
    log.debug('Agent state cleared', { agentId: id });
  }
  
  saveAgentsConfig(config);
  log.info('Agent stopped', { agentId: id, provider: agent.provider });
}

export function rollbackAgentConfig(config, agentId) {
  const synapseDir = join(config.server.projectDir, '.synapse');
  const bakFiles = readdirSync(synapseDir)
    .filter(f => f.startsWith('agents.json.bak.'))
    .sort()
    .reverse(); // newest first

  if (bakFiles.length === 0) {
    throw new Error(`no backup files found for agent "${agentId}"`);
  }

  const latestBackup = join(synapseDir, bakFiles[0]);
  let backupConfig;
  try {
    backupConfig = JSON.parse(readFileSync(latestBackup, 'utf-8'));
  } catch (e) {
    throw new Error(`Failed to parse backup file "${bakFiles[0]}": ${e.message}`);
  }

  const backupAgent = backupConfig.agents?.find(a => a.id === agentId);
  if (!backupAgent) {
    throw new Error(`Agent "${agentId}" not found in backup file "${bakFiles[0]}"`);
  }

  let agent = agents[agentId];
  if (!agent) {
    // Restore deleted agent
    const ProviderClass = PROVIDERS[backupAgent.provider];
    if (!ProviderClass) throw new Error(`Unknown provider "${backupAgent.provider}" for agent "${agentId}" in backup`);
    agent = new ProviderClass({
      name: backupAgent.name,
      model: backupAgent.model,
      color: backupAgent.color,
      projectDir: config.server.projectDir,
    });
    agent.provider = backupAgent.provider;
    agents[agentId] = agent;
    if (EXECUTION_CAPABLE_PROVIDERS.has(agent.provider)) {
      EXECUTION_CAPABLE.add(agentId);
    }
  }

  agent.name = backupAgent.name;
  agent.model = backupAgent.model;
  agent.color = backupAgent.color;
  agent.role = backupAgent.role;
  agent._permissions = backupAgent.permissions || [];
  agent._denyActions = backupAgent.denyActions || [];
  agent._status = backupAgent.status || 'active';
  agent.skills = backupAgent.skills || [];
  agent._timeout = backupAgent.timeout || null;
  agent._sandboxLimits = backupAgent.sandboxLimits || null;

  // Preserve paused state during rollback
  if (_agentState && _agentState[agentId]) {
    // Don't change paused state during rollback
  } else if (_agentState && _agentState[agentId]) {
    _agentState[agentId] = { paused: false };
    saveAgentState();
  }

  saveAgentsConfig(config);
}

export function getConfigHistory(config, agentId, limit = 5) {
  const synapseDir = join(config.server.projectDir, '.synapse');
  const bakFiles = readdirSync(synapseDir)
    .filter(f => f.startsWith('agents.json.bak.'))
    .sort()
    .reverse(); // newest first

  const history = [];
  for (const bakFile of bakFiles) {
    if (history.length >= limit) break;

    const bakPath = join(synapseDir, bakFile);
    let backupConfig;
    try {
      backupConfig = JSON.parse(readFileSync(bakPath, 'utf-8'));
    } catch (e) {
      continue;
    }

    const agent = backupConfig.agents?.find(a => a.id === agentId);
    if (!agent) continue;

    const timestamp = bakFile.replace('agents.json.bak.', '');
    history.push({ timestamp, config: agent });
  }

  return history;
}
