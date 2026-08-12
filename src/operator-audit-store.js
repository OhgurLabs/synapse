/**
 * OperatorAuditStore — append-only JSONL store for operator action audit logs.
 * Persists to per-project files with globally monotonic sequential eventIds.
 *
 * File: .synapse/projects/{projectId}/operator-audit.jsonl
 * Format: one JSON object per line, newline-terminated.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('operator-audit-store');

// Same shape as state.js validateId — keep path segments under projectsDir only.
const SAFE_PROJECT_ID_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_PROJECT_ID_LEN = 128;

function assertSafeProjectId(projectId) {
  if (
    !projectId ||
    typeof projectId !== 'string' ||
    !SAFE_PROJECT_ID_RE.test(projectId) ||
    projectId.length > MAX_PROJECT_ID_LEN
  ) {
    throw new Error(
      `Invalid projectId for operator audit: "${String(projectId).slice(0, 80)}" — alphanumeric/hyphens/underscores only`
    );
  }
}

export class OperatorAuditStore {
  /**
   * @param {string} projectsDir — .synapse/projects/ directory
   */
  constructor(projectsDir) {
    this._projectsDir = projectsDir;
    this._nextEventId = 1;
  }

  /**
   * Initialize the sequential counter from the highest persisted eventId
   * across all projects. Must be called before append().
   * @param {string[]} projectIds
   */
  init(projectIds) {
    let maxId = 0;
    for (const pid of projectIds) {
      // Same skip as queryAll: ids arrive from raw directory names
      // (state.js hydration never validates them), and init() runs unwrapped
      // on the boot path — a junk dir must not crash the orchestrator.
      if (typeof pid !== 'string' || !SAFE_PROJECT_ID_RE.test(pid) || pid.length > MAX_PROJECT_ID_LEN) {
        log.warn('Skipping invalid project id during audit counter init', { projectId: String(pid) });
        continue;
      }
      const filePath = this._path(pid);
      if (!existsSync(filePath)) continue;
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const entry = JSON.parse(line);
            if (typeof entry.eventId === 'number' && entry.eventId > maxId) {
              maxId = entry.eventId;
            }
            break;
          } catch { /* skip corrupt lines */ }
        }
      } catch (err) {
        log.warn('Failed to read audit file for counter init', { projectId: pid, error: err.message });
      }
    }
    this._nextEventId = maxId + 1;

    log.info('Operator audit store initialized', { nextEventId: this._nextEventId, projects: projectIds.length });
    return this;
  }

  _path(projectId) {
    assertSafeProjectId(projectId);
    return join(this._projectsDir, projectId, 'operator-audit.jsonl');
  }

  /**
   * Append an audit entry to disk. Returns the assigned eventId.
   * Supports both (projectId, entry) and (entry) signatures.
   * @param {string|object} projectIdOrEntry
   * @param {object} [entry]
   * @returns {number} the assigned eventId
   */
  append(projectIdOrEntry, entry) {
    let projectId = projectIdOrEntry;
    let payload = entry;

    // Handle single-argument signature: append(entry)
    if (typeof projectIdOrEntry === 'object' && entry === undefined) {
      payload = projectIdOrEntry;
      projectId = payload.projectId || 'default';
    }

    const eventId = this._nextEventId++;
    const record = {
      eventId,
      timestamp: payload.timestamp || new Date().toISOString(),
      actorId: payload.actorId || payload.operatorId || null,
      actionType: payload.actionType || payload.action || null,
      // agentId is included LAST so existing precedence is untouched — it only
      // fills a slot that would otherwise be null.
      //
      // Without it, every agent_pause / agent_resume entry lost its SUBJECT.
      // api.js:2481-2483 appends `{ action: 'agent_pause', agentId, ... }` and
      // this mapping read only resourceId/target/providerId, so the audit trail
      // recorded that AN agent was paused without recording WHICH — unqueryable,
      // and silent, because a dropped field throws nothing.
      target: payload.target || payload.resourceId || payload.providerId || payload.agentId || null,
      correlationId: payload.correlationId || null,
      source: payload.source || null,
      reason: payload.reason || null,
      beforeState: payload.beforeState || null,
      afterState: payload.afterState || null,
      decision: payload.decision || null,
      // Same silent-drop class as the agentId note above: manual weight
      // overrides carry their idempotency key as actionId, and losing it
      // made audit entries uncorrelatable with idempotent replays (#107).
      actionId: payload.actionId || payload.idempotencyKey || null,
      // Keep legacy fields for compatibility
      operatorId: payload.operatorId || payload.actorId || null,
      action: payload.action || payload.actionType || null,
      campaignId: payload.campaignId || null,
      resourceType: payload.resourceType || null,
      resourceId: payload.resourceId || payload.target || payload.agentId || null,
      payload: payload.payload || payload.details || null,
      status: payload.status || null,
      causalChain: payload.causalChain || null,
    };

    const filePath = this._path(projectId);
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    try {
      appendFileSync(filePath, JSON.stringify(record) + '\n');
    } catch (err) {
      log.error('Failed to persist audit entry', { eventId, action: record.actionType, projectId, error: err.message });
    }

    return eventId;
  }

  /**
   * Query audit entries for a project with optional filtering and pagination.
   * @param {string} projectId
   * @param {object} [opts]
   * @param {number} [opts.limit=50]
   * @param {number} [opts.afterEventId] — only return entries after this eventId
   * @param {string} [opts.action] — filter to a specific action type
   * @param {string} [opts.correlationId] — filter to a specific correlationId
   * @param {string} [opts.decision] — filter by decision ('allow' or 'deny')
   * @returns {object[]}
   */
  query(projectId, opts = {}) {
    const { limit = 50, afterEventId, action, correlationId, decision } = opts;
    try {
      assertSafeProjectId(projectId);
    } catch (err) {
      log.error('Refused audit query with unsafe projectId', { projectId: String(projectId).slice(0, 80), error: err.message });
      return [];
    }
    const filePath = this._path(projectId);
    if (!existsSync(filePath)) return [];
    try {
      const content = readFileSync(filePath, 'utf-8');
      const results = [];
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (afterEventId != null && entry.eventId <= afterEventId) continue;
          if (action && entry.actionType !== action && entry.action !== action) continue;
          if (correlationId && entry.correlationId !== correlationId) continue;
          if (decision && (entry.decision || entry.status) !== decision) continue;
          results.push(entry);
        } catch { /* skip corrupt lines */ }
      }
      return results.slice(-limit);
    } catch (err) {
      log.error('Failed to query audit entries', { projectId, error: err.message });
      return [];
    }
  }

  /**
   * Query audit entries across all projects. Used when no projectId filter is specified.
   * @param {object} [opts] — same options as query()
   * @returns {object[]}
   */
  queryAll(opts = {}) {
    const { limit = 50 } = opts;
    const results = [];
    try {
      if (!existsSync(this._projectsDir)) return [];
      const dirs = readdirSync(this._projectsDir, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        // Skip non-id directory names (defense if junk lands under projects/)
        if (!SAFE_PROJECT_ID_RE.test(d.name) || d.name.length > MAX_PROJECT_ID_LEN) continue;
        const entries = this.query(d.name, { ...opts, limit: 10000 });
        results.push(...entries);
      }
    } catch (err) {
      log.error('Failed to query all audit entries', { error: err.message });
    }
    results.sort((a, b) => a.eventId - b.eventId);
    return results.slice(-limit);
  }

  /**
   * Query audit entries by correlationId across all known projects.
   * @param {string} correlationId
   * @param {string[]} projectIds
   * @returns {object[]}
   */
  queryByCorrelationId(correlationId, projectIds = ['default']) {
    const results = [];
    for (const pid of projectIds) {
      const entries = this.query(pid, { correlationId, limit: 1000 });
      results.push(...entries);
    }
    return results.sort((a, b) => a.eventId - b.eventId);
  }

  /**
   * Retrieve a single audit entry by eventId.
   * @param {string} projectId
   * @param {number} eventId
   * @returns {object|null}
   */
  getById(projectId, eventId) {
    const filePath = this._path(projectId);
    if (!existsSync(filePath)) return null;
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.eventId === eventId) return entry;
        } catch { /* skip corrupt lines */ }
      }
      return null;
    } catch (err) {
      log.error('Failed to read audit entry', { projectId, eventId, error: err.message });
      return null;
    }
  }

  /**
   * Clears all audit entries for a given projectId and resets event counter.
   * @param {string} projectId
   */
  clear(projectId) {
    const filePath = this._path(projectId);
    if (existsSync(filePath)) {
      try {
        rmSync(filePath);
        log.info('Cleared operator audit log', { projectId });
      } catch (err) {
        log.error('Failed to clear operator audit log', { projectId, error: err.message });
      }
    }
    this._nextEventId = 1; // Reset counter after clearing
  }

  /**
   * AuditLogger-compatible interface for provider metrics integration.
   * Maps action object to append() call with proper field mapping.
   * @param {object} action - Action object with provider metrics fields
   * @param {string} [action.traceId] - Trace/dispatch ID
   * @param {string} [action.agentId] - Agent identifier
   * @param {string} [action.action_type] - Action type (e.g., 'provider_dispatch')
   * @param {string} [action.input_summary] - Input summary
   * @param {string} [action.output_summary] - Output summary
   * @param {string} [action.outcome] - Outcome ('success' or 'failure')
   * @param {object} [action.context_metadata] - Context metadata
   * @returns {Promise<object>} Promise resolving to { success: true, eventId }
   */
  async logAction(action) {
    try {
      const eventId = this.append({
        projectId: action.projectId || action.context_metadata?.projectId || 'default',
        timestamp: action.timestamp || new Date().toISOString(),
        actorId: action.agentId || 'provider-metrics-store',
        actionType: action.action_type || 'provider_event',
        correlationId: action.traceId || action.context_metadata?.dispatchId || null,
        target: action.context_metadata?.provider || null,
        campaignId: action.context_metadata?.campaignId || null,
        status: action.outcome || 'success',
        payload: {
          input_summary: action.input_summary,
          output_summary: action.output_summary,
          context_metadata: action.context_metadata,
        },
      });

      return { success: true, eventId };
    } catch (err) {
      log.error('logAction failed', { error: err.message, action });
      return { success: false, error: err.message };
    }
  }
}
