/**
 * Permission enforcement — bypass gating, persona integrity, audit logging.
 *
 * Four defense layers:
 *   1. bypassPermissions gating — only code:execute agents get provider-specific
 *      "no approval / full access" CLI flags (Claude/Codex/Gemini), when supported
 *   2. System prompt hardening — handled in context.js
 *   3. Persona hash verification — detect tampered persona.md files
 *   4. Context tagging — handled in context.js
 */

import { resolvePermissions, agents } from './agents.js';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { createLogger, redactSensitive } from '../logger.js';
import { assertSafeProjectId } from '../safe-id.js';

const log = createLogger('permissions');

// Action → required permission mapping
const ACTION_PERMISSIONS = {
  'conversation:respond': null,           // any active agent
  'code:execute':         'code:execute',
  'task:plan':            'task:plan',
  'task:execute':         'task:execute',
  'code:review':          'code:review',
  'research:web':         'research:web',
  'research:codebase':    'research:codebase',
};

// --- Permission checks ---

export function hasPermission(agentId, action) {
  // denyActions is an explicit operator block and beats everything —
  // previously only filterByPermission honored it, so direct hasPermission
  // callers (planner eligibility, task:execute checks) ignored deny.
  if (agents[agentId]?._denyActions?.includes(action)) return false;
  const required = ACTION_PERMISSIONS[action];
  if (!required) return true;  // no permission needed for this action
  const perms = resolvePermissions(agentId);
  return perms.includes('*') || perms.includes(required);
}

export function canBypassPermissions(agentId) {
  // Single-tenant BYOH: an operator-registered agent with no explicit
  // permission scope is trusted to execute — the operator deliberately added
  // it and owns the box. The wizard creates agents with `permissions: []`,
  // and treating that as "must run sandboxed" made codex no-op (bwrap) on
  // every dispatch path. Only a non-empty scope that withholds code:execute
  // (and isn't wildcard) is a deliberate restriction.
  // A non-existent agent must NEVER bypass (resolvePermissions returns []
  // for both unknown agents AND registered-but-unscoped ones — distinguish
  // them via the registry).
  if (!agents[agentId]) return false;
  // An explicit code:execute deny must never get the bypass flags — before
  // this check, an agent with empty permissions AND denyActions:
  // ['code:execute'] was granted full bypass by the empty-scope trust rule.
  if (agents[agentId]._denyActions?.includes('code:execute')) return false;
  const perms = resolvePermissions(agentId);
  if (!perms || perms.length === 0) return true;
  return perms.includes('*') || perms.includes('code:execute');
}

/**
 * Filter agent list to those permitted for an action.
 * Graceful fallthrough: if no agents qualify, returns original list with a warning.
 */
export function filterByPermission(agentIds, action, agentMap) {
  const eligible = agentIds.filter(id => {
    if (agentMap[id]?._denyActions?.includes(action)) return false;
    return hasPermission(id, action);
  });
  if (eligible.length === 0) {
    // Graceful fallthrough: still exclude agents that explicitly deny this action
    const notDenied = agentIds.filter(id => !agentMap[id]?._denyActions?.includes(action));
    if (notDenied.length > 0) {
      log.warn(`No agent has "${action}" — falling through (excluding ${agentIds.length - notDenied.length} with denyActions)`);
      return notDenied;
    }
    log.warn(`No agent has "${action}" — falling through (all agents)`);
    return agentIds;
  }
  return eligible;
}

// --- Per-tool allowlists ---

/**
 * Returns the tool-level config for an agent, or null if none configured.
 * Source: agents.json → agent.tools: { allow?: string[], deny?: string[] }
 */
export function getToolPermissions(agentId) {
  return agents[agentId]?._toolsConfig || null;
}

/**
 * Check whether an agent is permitted to use a specific tool.
 * Tool names: 'bash', 'read', 'write', 'edit', 'grep', 'websearch', etc.
 *
 * Logic:
 *   - No _toolsConfig: all tools permitted (backward-compatible)
 *   - tools.deny includes tool: denied
 *   - tools.allow present and tool not in it: denied
 *   - Otherwise: permitted
 */
export function hasToolPermission(agentId, tool) {
  const cfg = getToolPermissions(agentId);
  if (!cfg) return true;
  if (cfg.deny?.includes(tool)) return false;
  if (cfg.allow) return cfg.allow.includes(tool);
  return true;
}

// --- Persona integrity ---

const personaHashes = new Map();  // agentId → sha256 hash at load time

export function registerPersonaHash(agentId, personaText) {
  if (!personaText) return;
  personaHashes.set(agentId, createHash('sha256').update(personaText).digest('hex'));
}

export function verifyPersonaIntegrity(agentId, currentPersonaText) {
  const expected = personaHashes.get(agentId);
  if (!expected || !currentPersonaText) return { ok: true };
  const actual = createHash('sha256').update(currentPersonaText).digest('hex');
  if (actual !== expected) {
    log.error('PERSONA TAMPERED', { agentId, expected, actual });
    return { ok: false, expected, actual };
  }
  return { ok: true };
}

// --- Audit logging ---

export function auditDispatch(projectsDir, projectId, entry) {
  try {
    assertSafeProjectId(projectId);
    const path = join(projectsDir, projectId, 'permission-audit.jsonl');
    const safeEntry = redactSensitive({ ts: new Date().toISOString(), ...entry });
    appendFileSync(path, JSON.stringify(safeEntry) + '\n');
  } catch { /* non-critical — dir may not exist yet / invalid projectId */ }
}
