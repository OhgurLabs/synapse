// health-subsystems.js — Compute per-subsystem health status for the health endpoint.
// Returns { subsystems: { agents, rag, scheduler, git, backupMirrors }, status } where each subsystem
// has { status: 'green'|'yellow'|'red', detail: '...' } and top-level status is the worst.

import { execFile, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { STATES } from './circuit-breaker.js';
import { ragConfigured } from '../rag/embedding.js';

/**
 * Compute per-subsystem health statuses.
 *
 * @param {object} deps
 * @param {object}   deps.agents           - agent registry (id → agent with .provider)
 * @param {Function} deps.isAgentCoolingDown - (agentId) → boolean
 * @param {import('./circuit-breaker.js').CircuitBreaker|null} deps.circuitBreaker
 * @param {Function|null} deps.getVectorStore - (projectId) → VectorStore|null
 * @param {object}   deps.stateManager     - state manager with .listProjects()
 * @param {object}   deps.lifecycle        - lifecycle object with .getHealthState()
 * @param {string}   [deps.projectDir]     - working directory for git status
 * @returns {Promise<{ subsystems: object, status: string }>}
 */
export async function computeSubsystemStatuses(deps) {
  const [agents, rag, scheduler, git, backupMirrors] = await Promise.all([
    computeAgentStatus(deps),
    computeRagStatus(deps),
    computeSchedulerStatus(deps),
    computeGitStatus(deps),
    computeBackupMirrorStatus(deps),
  ]);

  const subsystems = { agents, rag, scheduler, git, backupMirrors };
  const statuses = Object.values(subsystems).map(s => s.status);
  const status = statuses.includes('red') ? 'red'
    : statuses.includes('yellow') ? 'yellow'
    : 'green';

  return { subsystems, status };
}

/**
 * Agents: green = all available; yellow = some cooling/circuit-broken; red = all unavailable.
 */
function computeAgentStatus({ agents, isAgentCoolingDown, circuitBreaker }) {
  const ids = Object.keys(agents || {});
  if (ids.length === 0) {
    return { status: 'red', detail: 'No agents registered' };
  }

  let unavailable = 0;
  const reasons = [];

  for (const id of ids) {
    const coolingDown = isAgentCoolingDown(id);
    const cbOpen = circuitBreaker
      ? circuitBreaker.getState(id) === STATES.OPEN
      : false;

    if (coolingDown && cbOpen) {
      unavailable++;
      reasons.push(`${id}: cooling down + circuit open`);
    } else if (cbOpen) {
      unavailable++;
      reasons.push(`${id}: circuit open`);
    } else if (coolingDown) {
      unavailable++;
      reasons.push(`${id}: cooling down`);
    }
  }

  if (unavailable === ids.length) {
    return { status: 'red', detail: `All ${ids.length} agents unavailable: ${reasons.join('; ')}` };
  }
  if (unavailable > 0) {
    return { status: 'yellow', detail: `${unavailable}/${ids.length} agents unavailable: ${reasons.join('; ')}` };
  }
  return { status: 'green', detail: `All ${ids.length} agents available` };
}

/**
 * RAG: green = all indexed & aligned; yellow = some missing snippets; red = store failed or none indexed.
 */
function computeRagStatus({ getVectorStore, stateManager }) {
  // RAG is optional. Unconfigured (no SYNAPSE_EMBED_ENDPOINT) is a normal
  // state, not a fault — fresh installs were greeting users with a
  // 'rag-paused' warning for a feature they never enabled.
  if (!ragConfigured) {
    return { status: 'green', detail: 'RAG not configured (optional — set SYNAPSE_EMBED_ENDPOINT to enable semantic recall)' };
  }
  if (!getVectorStore) {
    return { status: 'red', detail: 'RAG store not available' };
  }

  const projects = stateManager?.listProjects() || [];
  if (projects.length === 0) {
    return { status: 'green', detail: 'No projects configured' };
  }

  let totalIndexed = 0;
  let totalMissing = 0;
  let allAligned = true;
  let storeErrors = 0;

  for (const p of projects) {
    const pid = p.id || p;
    try {
      const store = getVectorStore(pid);
      if (!store) {
        storeErrors++;
        continue;
      }
      const count = store.count();
      totalIndexed += count;
      const alignment = store.checkAlignment();
      if (!alignment.aligned) allAligned = false;
      totalMissing += store.countMissingSnippets();
    } catch {
      storeErrors++;
    }
  }

  if (storeErrors === projects.length || (totalIndexed === 0 && projects.length > 0)) {
    return { status: 'red', detail: storeErrors > 0
      ? `RAG store failed for ${storeErrors}/${projects.length} projects`
      : `No projects indexed (${projects.length} projects)` };
  }
  if (totalMissing > 0 || !allAligned) {
    const parts = [];
    if (totalMissing > 0) parts.push(`${totalMissing} missing snippets`);
    if (!allAligned) parts.push('index misaligned');
    return { status: 'yellow', detail: `${totalIndexed} indexed; ${parts.join(', ')}` };
  }
  return { status: 'green', detail: `${totalIndexed} indexed across ${projects.length} project(s), all aligned` };
}

/**
 * Scheduler: green = heartbeat running, last tick within interval;
 * yellow = last tick >2x interval; red = stalled or watchdog recovered in last 5 min.
 */
function computeSchedulerStatus({ lifecycle }) {
  if (!lifecycle || typeof lifecycle.getHealthState !== 'function') {
    return { status: 'red', detail: 'Lifecycle not available' };
  }

  const state = lifecycle.getHealthState();
  const {
    heartbeatRunning,
    lastHeartbeatCompleted,
    heartbeatStallMs,
    heartbeatIntervalMs,
    lastWatchdogRecovery,
    inFlightPlanningTasks = 0,
    busyAgents = 0,
  } = state;

  // heartbeatRunning is only true *during* a tick (single-flight), so it is
  // not a "is the scheduler on" signal — use lastHeartbeatCompleted + stall age.
  if (!lastHeartbeatCompleted) {
    return { status: 'red', detail: 'Heartbeat is not running (never completed a tick)' };
  }

  // Watchdog recovered in the last 5 minutes → red
  // Accept epoch ms (lifecycle) or ISO string (legacy / mixed callers).
  const RECOVERY_WINDOW_MS = 5 * 60 * 1000;
  const recoveryAt = typeof lastWatchdogRecovery === 'number'
    ? lastWatchdogRecovery
    : (lastWatchdogRecovery ? Date.parse(lastWatchdogRecovery) : NaN);
  if (Number.isFinite(recoveryAt) && (Date.now() - recoveryAt) < RECOVERY_WINDOW_MS) {
    const agoSec = Math.round((Date.now() - recoveryAt) / 1000);
    return { status: 'red', detail: `Watchdog recovered heartbeat ${agoSec}s ago` };
  }

  // Check last tick age
  if (lastHeartbeatCompleted) {
    const elapsed = Date.now() - lastHeartbeatCompleted;
    const interval = heartbeatIntervalMs || heartbeatStallMs || 30000;

    if (elapsed > heartbeatStallMs) {
      if (heartbeatRunning && (inFlightPlanningTasks > 0 || busyAgents > 0)) {
        return {
          status: 'yellow',
          detail: `Long-running in-flight work (${inFlightPlanningTasks} planning, ${busyAgents} executing); last heartbeat tick ${Math.round(elapsed / 1000)}s ago`,
        };
      }
      return { status: 'red', detail: `Heartbeat stalled (last tick ${Math.round(elapsed / 1000)}s ago, stall threshold ${Math.round(heartbeatStallMs / 1000)}s)` };
    }
    if (elapsed > interval * 2) {
      return { status: 'yellow', detail: `Last heartbeat tick ${Math.round(elapsed / 1000)}s ago (>2x ${Math.round(interval / 1000)}s interval)` };
    }
  }

  return { status: 'green', detail: 'Heartbeat running normally' };
}

/**
 * Git: green = clean/normal; yellow = uncommitted changes; red = git errors.
 */
function computeGitStatus({ projectDir }) {
  const cwd = projectDir || process.cwd();
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain'], { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({ status: 'red', detail: `git status failed: ${err.message}` });
        return;
      }
      const output = (stdout || '').trim();
      if (output.length === 0) {
        resolve({ status: 'green', detail: 'Working directory clean' });
      } else {
        const lines = output.split('\n').length;
        resolve({ status: 'yellow', detail: `${lines} uncommitted change(s)` });
      }
    });
  });
}

/**
 * Backup Mirrors: green = all mirrors fresh (<24h); yellow = some stale (24-48h); red = critical staleness (>48h) or check failed.
 * Reads health status from .synapse/backup-mirrors-health.json written by check-git-mirrors-health.sh
 */
function computeBackupMirrorStatus({ projectDir }) {
  const healthFilePath = join(projectDir || process.cwd(), '.synapse', 'backup-mirrors-health.json');
  
  try {
    const data = readFileSync(healthFilePath, 'utf8');
    const status = JSON.parse(data);
    
    if (!status || typeof status !== 'object') {
      return { status: 'yellow', detail: 'Invalid backup mirror health status file format' };
    }
    
    // Support both camelCase and snake_case field names
    const total = status.summary?.total_repos || status.total_repos || status.totalRepos || 0;
    const healthy = status.summary?.healthy_repos || status.healthy_repos || status.healthyRepos || 0;
    const stale = status.summary?.stale_repos || status.stale_repos || status.staleRepos || 0;
    const errors = status.summary?.error_repos || status.error_repos || status.errorRepos || 0;
    const lastCheck = status.last_check || status.lastCheck || 'never';
    const overallStatus = status.overall_status || status.overallStatus || 'green';
    
    if (total === 0) {
      return { status: 'green', detail: 'No backup repositories configured' };
    }
    
    // Calculate staleness percentage
    const stalePercentage = total > 0 ? (stale / total) * 100 : 0;
    
    // Determine status based on severity
    if (errors > 0 && errors === total) {
      return { status: 'red', detail: `Backup mirror health check failed for all ${total} repository(s)` };
    }
    
    if (stalePercentage >= 50 || stale > 0) {
      const detail = `${healthy}/${total} mirrors healthy, ${stale} stale (${stalePercentage.toFixed(1)}%), ${errors} errors. Last check: ${lastCheck}`;
      return { status: 'yellow', detail };
    }
    
    return { status: 'green', detail: `All ${total} backup mirrors healthy. Last check: ${lastCheck}` };
  } catch (err) {
    if (err.code === 'ENOENT') {
      // No health file = backup mirrors were never set up. That's the
      // normal state of every fresh install — an optional feature being
      // absent is not a warning (the yellow here fired a
      // 'backup-mirror-stale' alert on first boot, OOBE noise).
      return { status: 'green', detail: 'No backup mirrors configured (optional — check-git-mirrors-health.sh sets this up)' };
    }
    return { status: 'yellow', detail: `Failed to read backup mirror health: ${err.message}` };
  }
}
