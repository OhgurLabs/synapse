/**
 * Agent config store — atomic update, rollback, and history.
 *
 * Provides a clean API for applying validated config patches to the live
 * agent registry, rolling back to previous snapshots, and retrieving config
 * history. Delegates persistence to saveAgentsConfig() in agents.js which
 * uses write-tmp-then-rename for atomicity.
 */

import { join } from 'path';
import { existsSync, statSync } from 'fs';

export function createAgentConfigStore(deps) {
  const {
    agents,
    saveAgentsConfig,
    createLogger,
    config,
  } = deps;

  const log = createLogger('agent-config-store');
  const agentConfigHistory = new Map(); // agentId -> array of config snapshots

  /**
   * Return metadata for the agent's configuration (last modified timestamp, backup count).
   *
   * @param {string} agentId
   * @returns {Object} { lastModified: string, backupsCount: number }
   */
  function getAgentConfigMetadata(agentId) {
    const synapseDir = join(config.server.projectDir, '.synapse');
    const cfgPath = join(synapseDir, 'agents.json');

    let lastModified = new Date().toISOString();
    if (existsSync(cfgPath)) {
      try {
        lastModified = statSync(cfgPath).mtime.toISOString();
      } catch {}
    }

    // Use in-memory history count so availableBackups accurately reflects
    // what rollbackAgentConfig can actually restore (the two must stay in sync).
    const availableBackups = agentConfigHistory.get(agentId)?.length ?? 0;

    return { lastModified, availableBackups };
  }

  /**
   * Build a serialisable config snapshot from a live agent instance.
   *
   * @param {string} agentId
   * @param {Object} inst - Live agent instance from the agents registry
   * @returns {Object}
   */
  function buildConfig(agentId, inst) {
    return {
      id: agentId,
      name: inst.name,
      model: inst.model,
      displayModel: inst.displayModel || null,
      color: inst.color,
      role: inst.role || null,
      provider: inst.provider,
      status: inst._status || 'active',
      permissions: inst._permissions || [],
      denyActions: inst._denyActions || [],
      skills: inst.skills || [],
      persona: inst.persona || null,
      personaFile: inst.personaFile || null,
      timeout: inst._timeout || null,
      sandboxLimits: inst._sandboxLimits || null,
      cliPath: inst.cliPath || inst._defaultCliPath || null,
      cliArgs: inst.cliArgs || inst._defaultCliArgs || null,
      harnessOptions: inst.harnessOptions || inst._defaultHarnessOptions || null,
      endpoint: inst.endpoint || null,
      baseUrl: inst.baseUrl || null,
      apiKeyEnv: inst.apiKeyEnv || null,
      bypassCodeExecutionCheck: !!inst.bypassCodeExecutionCheck,
    };
  }

  /**
   * Apply a validated config patch to the in-memory agent instance and persist
   * atomically to .synapse/agents.json (write-tmp-then-rename + timestamped backup).
   *
   * Only fields that are present in the patch are applied — absent keys leave the
   * existing value unchanged.
   *
   * @param {string} agentId - The agent ID to update
   * @param {Object} patch   - Partial config validated by validateAgentConfig()
   * @returns {{ ok: true, config: Object } | { ok: false, error: string }}
   */
  function updateAgentConfig(agentId, patch) {
    const inst = agents[agentId];
    if (!inst) {
      return { ok: false, error: `Agent "${agentId}" not found` };
    }

    // Save current config to history before applying changes
    const currentConfig = buildConfig(agentId, inst);
    if (!agentConfigHistory.has(agentId)) {
      agentConfigHistory.set(agentId, []);
    }
    agentConfigHistory.get(agentId).push(currentConfig);

    // Apply each patchable field to the live instance.
    // Earlier this list omitted displayModel, persona, personaFile, baseUrl,
    // apiKeyEnv, and bypassCodeExecutionCheck — the schema validated them and
    // the UI sent them, but they were silently dropped on save. Five visible
    // fields gave the user a green success toast that did nothing.
    if ('name' in patch)        inst.name           = patch.name;
    if ('model' in patch)       inst.model          = patch.model;
    if ('displayModel' in patch) inst.displayModel  = patch.displayModel ?? null;
    if ('color' in patch)       inst.color          = patch.color;
    if ('role' in patch)        inst.role           = patch.role;
    if ('permissions' in patch) inst._permissions   = patch.permissions;
    if ('denyActions' in patch) inst._denyActions   = patch.denyActions;
    if ('skills' in patch)      inst.skills         = patch.skills;
    if ('status' in patch)      inst._status        = patch.status;
    if ('timeout' in patch)     inst._timeout       = patch.timeout;
    if ('sandboxLimits' in patch) inst._sandboxLimits = patch.sandboxLimits;
    if ('persona' in patch)     inst.persona        = patch.persona ?? null;
    if ('personaFile' in patch) inst.personaFile    = patch.personaFile ?? null;
    if ('endpoint' in patch)    inst.endpoint       = patch.endpoint ?? null;
    if ('baseUrl' in patch)     inst.baseUrl        = patch.baseUrl ?? null;
    if ('apiKeyEnv' in patch)   inst.apiKeyEnv      = patch.apiKeyEnv ?? null;
    if ('bypassCodeExecutionCheck' in patch) inst.bypassCodeExecutionCheck = !!patch.bypassCodeExecutionCheck;
    if ('cliPath' in patch)       inst.cliPath          = patch.cliPath ?? undefined;
    if ('cliArgs' in patch)       inst.cliArgs           = patch.cliArgs?.length ? patch.cliArgs : undefined;
    if ('harnessOptions' in patch) inst.harnessOptions    = patch.harnessOptions && Object.keys(patch.harnessOptions).length ? patch.harnessOptions : undefined;

    // Persist atomically (write-tmp-then-rename, creates timestamped backup)
    try {
      saveAgentsConfig(config);
    } catch (e) {
      log.error('updateAgentConfig: persist failed', { agentId, error: e.message });
      return { ok: false, error: `Failed to persist config: ${e.message}` };
    }

    log.info('Agent config updated', { agentId, fields: Object.keys(patch) });
    return { ok: true, config: buildConfig(agentId, inst) };
  }

  /**
   * Roll back the agent's config to the most recent backup.
   *
   * @param {string} agentId
   * @returns {{ ok: true, config: Object } | { ok: false, error: string }}
   */
  function rollbackAgentConfig(agentId) {
    const history = agentConfigHistory.get(agentId);

    if (!history || history.length === 0) {
      return { ok: false, error: `No config history found for agent "${agentId}"` };
    }

    // Get the most recent backup (last in array) and remove it from history
    const backupEntry = history.pop();
    if (!backupEntry) {
      return { ok: false, error: `No valid backup found for agent "${agentId}"` };
    }

    // Update in-memory instance properties from backup
    const inst = agents[agentId];
    if (!inst) {
      return { ok: false, error: `Agent "${agentId}" not found in current registry` };
    }

    if (backupEntry.name !== undefined) inst.name = backupEntry.name;
    if (backupEntry.model !== undefined) inst.model = backupEntry.model;
    if (backupEntry.color !== undefined) inst.color = backupEntry.color;
    if (backupEntry.role !== undefined) inst.role = backupEntry.role;
    inst._permissions = backupEntry.permissions || [];
    inst._denyActions = backupEntry.denyActions || [];
    inst._status = backupEntry.status || 'active';
    inst.skills = backupEntry.skills || [];
    inst._timeout = backupEntry.timeout || null;
    inst._sandboxLimits = backupEntry.sandboxLimits || null;
    inst.cliPath = backupEntry.cliPath || null;
    inst.cliArgs = backupEntry.cliArgs || null;
    inst.harnessOptions = backupEntry.harnessOptions || null;

    // Persist atomically
    try {
      saveAgentsConfig(config);
      log.info('Agent config rolled back', { agentId });
      const configWithMetadata = buildConfig(agentId, inst);
      const metadata = getAgentConfigMetadata(agentId);
      configWithMetadata.availableBackups = metadata.availableBackups;
      return { ok: true, config: configWithMetadata };
    } catch (e) {
      log.error('rollbackAgentConfig: persist failed', { agentId, error: e.message });
      return { ok: false, error: `Failed to persist rollback: ${e.message}` };
    }
  }

  /**
   * Return a list of config history entries for the given agent, newest first.
   * Each entry is { timestamp: string, config: Object }.
   *
   * @param {string} agentId
   * @param {number} [limit=5]
   * @returns {Array<{ timestamp: string, config: Object }>}
   */
  function getConfigHistory(agentId, limit = 5) {
    const history = agentConfigHistory.get(agentId) || [];

    // Return history entries with timestamps, newest first
    return history
      .slice()
      .reverse()
      .slice(0, limit)
      .map(configSnapshot => ({
        timestamp: configSnapshot.timestamp || new Date().toISOString(),
        config: configSnapshot,
      }));
  }

  return {
    buildConfig,
    getAgentConfigMetadata,
    updateAgentConfig,
    rollbackAgentConfig,
    getConfigHistory,
  };
}