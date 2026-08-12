/**
 * Cross-Project Data Aggregation Service
 *
 * Federated query layer that collects failure events, anomaly signals, and agent
 * performance metrics from all active project stores. Normalizes heterogeneous
 * sources into a unified schema: { timestamp, projectId, agentId, eventType, severity, metadata }
 *
 * Data Sources:
 * - JSONL: task-events.jsonl, learnings.jsonl, anomaly-alerts.jsonl
 * - SQLite: _dispatch-log.sqlite, _circuit-breaker-transitions.sqlite
 * - JSON: campaigns.json, tasks.json
 *
 * Usage:
 *   const aggregator = createCrossProjectAggregator({ projectsBasePath: '/path/to/synapse/.synapse/projects' });
 *   const events = await aggregator.queryProjectEvents(['synapse', 'projalpha'], 3600000); // last hour
 */

import Database from '../persistence/sqlite-provider.js';
import { createLogger } from '../logger.js';
import { existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { createInterface } from 'readline';
import { createReadStream } from 'fs';
import { getDb, rowToCampaign, rowToTask, rowToSubtask, stateDbExists } from './state-db.js';
import { assertSafeProjectId } from '../safe-id.js';

const log = createLogger('cross-project-aggregator');

// Legacy export kept for API compatibility. Never used for behavior —
// every query takes explicit projectIds; there is no implicit default set.
const DEFAULT_PROJECT_IDS = [];

/**
 * Create cross-project data aggregator
 * @param {Object} options
 * @param {string} options.projectsBasePath - Base path to .synapse/projects directory
 * @returns {Object} Aggregator API
 */
export function createCrossProjectAggregator(options = {}) {
  const projectsBasePath = options.projectsBasePath || join(process.cwd(), '.synapse', 'projects');
  const synapseBasePath = dirname(projectsBasePath); // .synapse directory

  /**
   * Query events from project data sources within a time window
   * @param {string[]} projectIds - Project IDs to query
   * @param {number} windowMs - Time window in milliseconds (events newer than Date.now() - windowMs)
   * @returns {Promise<Array<UnifiedEvent>>} Normalized events
   */
  async function queryProjectEvents(projectIds, windowMs) {
    const cutoffMs = Date.now() - windowMs;
    const events = [];

    // Query each project's data sources
    for (const projectId of projectIds) {
      try {
        // JSONL sources (per-project)
        events.push(...await queryJsonlSources(projectId, cutoffMs));

        // JSON sources (per-project)
        events.push(...await queryJsonSources(projectId, cutoffMs));
      } catch (err) {
        log.warn('Failed to query project sources', { projectId, error: err.message });
      }
    }

    // SQLite sources (shared across all projects)
    events.push(...await querySqliteSources(cutoffMs));

    // Root-level JSONL sources
    events.push(...await queryRootJsonlSources(cutoffMs));

    // Sort by timestamp descending
    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    log.debug('Query complete', {
      projectIds,
      windowMs,
      eventCount: events.length,
      cutoffMs,
    });

    return events;
  }

  /**
   * Query JSONL sources for a project
   * @param {string} projectId
   * @param {number} cutoffMs
   * @returns {Promise<Array<UnifiedEvent>>}
   */
  async function queryJsonlSources(projectId, cutoffMs) {
    const events = [];
    try {
      assertSafeProjectId(projectId);
    } catch {
      // Skip path-unsafe project ids rather than throwing mid-aggregation.
      return events;
    }
    const projectPath = join(projectsBasePath, projectId);

    if (!existsSync(projectPath)) {
      return events;
    }

    // task-events.jsonl
    try {
      const taskEvents = await readJsonl(join(projectPath, 'task-events.jsonl'));
      for (const record of taskEvents) {
        if (isWithinWindow(record.timestamp, cutoffMs)) {
          events.push(normalizeTaskEvent(record, projectId));
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.debug('Failed to read task-events.jsonl', { projectId, error: err.message });
      }
    }

    // learnings.jsonl
    try {
      const learnings = await readJsonl(join(projectPath, 'learnings.jsonl'));
      for (const record of learnings) {
        if (isWithinWindow(record.timestamp, cutoffMs)) {
          events.push(normalizeLearning(record, projectId));
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.debug('Failed to read learnings.jsonl', { projectId, error: err.message });
      }
    }

    // telemetry.jsonl
    try {
      const telemetry = await readJsonl(join(projectPath, 'telemetry.jsonl'));
      for (const record of telemetry) {
        if (isWithinWindow(record.timestamp, cutoffMs)) {
          events.push(normalizeTelemetry(record, projectId));
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.debug('Failed to read telemetry.jsonl', { projectId, error: err.message });
      }
    }

    return events;
  }

  /**
   * Query root-level JSONL sources (anomaly-alerts.jsonl)
   * @param {number} cutoffMs
   * @returns {Promise<Array<UnifiedEvent>>}
   */
  async function queryRootJsonlSources(cutoffMs) {
    const events = [];
    const anomalyAlertsPath = join(synapseBasePath, 'anomaly-alerts.jsonl');

    if (!existsSync(anomalyAlertsPath)) {
      return events;
    }

    try {
      const alerts = await readJsonl(anomalyAlertsPath);
      for (const record of alerts) {
        const timestamp = record.firedAt || record.timestamp;
        if (isWithinWindow(timestamp, cutoffMs)) {
          events.push(normalizeAnomalyAlert(record));
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'EACCES') {
        log.warn('Failed to read anomaly-alerts.jsonl', { error: err.message });
      }
    }

    return events;
  }

  /**
   * Query campaign/task state from SQLite (state.sqlite)
   * Migrated from campaigns.json/tasks.json reads (#18, 2026-05-30) —
   * shape preserved via rowToCampaign/rowToTask/rowToSubtask which
   * round-trip extra fields like failedAt through the metadata column.
   * @param {string} projectId
   * @param {number} cutoffMs
   * @returns {Promise<Array<UnifiedEvent>>}
   */
  async function queryJsonSources(projectId, cutoffMs) {
    const events = [];
    try {
      assertSafeProjectId(projectId);
    } catch {
      return events;
    }
    const projectPath = join(projectsBasePath, projectId);

    // Skip projects that don't yet have a state DB OR have a corrupt
    // 0-byte one. Matches the previous campaigns.json/tasks.json-existence
    // guards plus the 0-byte safety added 2026-05-31 (#18 follow-up).
    if (!stateDbExists(projectPath)) {
      return events;
    }

    let db;
    try {
      db = getDb(projectPath);
    } catch (err) {
      log.debug('Failed to open state.sqlite', { projectId, error: err.message });
      return events;
    }

    // campaigns table — extract failure and completion events.
    // Counting milestones via JOIN-friendly subquery so normalize* helpers
    // can keep using campaign.milestones.length without us re-fetching the
    // full milestone rows (we only need the count).
    try {
      const campaignRows = db
        .prepare("SELECT * FROM campaigns WHERE project_id = ? AND status IN ('failed','completed')")
        .all(projectId);
      const countMilestonesStmt = db.prepare(
        'SELECT COUNT(*) AS n FROM milestones WHERE campaign_id = ? AND project_id = ?',
      );
      for (const row of campaignRows) {
        const campaign = rowToCampaign(row);
        const { n: milestoneCount } = countMilestonesStmt.get(campaign.id, projectId);
        // Hydrate length-only sentinel: normalize* helpers use
        // `(campaign.milestones || []).length` so any array of the right
        // length satisfies the contract without paying for full row fetch.
        campaign.milestones = new Array(milestoneCount);
        if (campaign.status === 'failed' && campaign.failedAt) {
          if (isWithinWindow(campaign.failedAt, cutoffMs)) {
            events.push(normalizeCampaignFailure(campaign, projectId));
          }
        } else if (campaign.status === 'completed' && campaign.completedAt) {
          if (isWithinWindow(campaign.completedAt, cutoffMs)) {
            events.push(normalizeCampaignCompletion(campaign, projectId));
          }
        }
      }
    } catch (err) {
      log.debug('Failed to query campaigns from state.sqlite', { projectId, error: err.message });
    }

    // tasks + subtasks table — extract failure events
    try {
      const taskRows = db
        .prepare('SELECT * FROM tasks WHERE project_id = ?')
        .all(projectId);
      const subtaskStmt = db.prepare('SELECT * FROM subtasks WHERE task_id = ?');
      for (const taskRow of taskRows) {
        const task = rowToTask(taskRow);
        if (task.status === 'failed' && task.failedAt) {
          if (isWithinWindow(task.failedAt, cutoffMs)) {
            events.push(normalizeTaskFailure(task, projectId));
          }
        }
        // Subtask failures — read from subtasks table
        const subtaskRows = subtaskStmt.all(task.id);
        for (const subtaskRow of subtaskRows) {
          const subtask = rowToSubtask(subtaskRow);
          if (subtask.error && subtask.completedAt) {
            if (isWithinWindow(subtask.completedAt, cutoffMs)) {
              events.push(normalizeSubtaskError(subtask, task, projectId));
            }
          }
        }
      }
    } catch (err) {
      log.debug('Failed to query tasks from state.sqlite', { projectId, error: err.message });
    }

    return events;
  }

  /**
   * Query SQLite databases (dispatch-log, circuit-breaker-transitions)
   * @param {number} cutoffMs
   * @returns {Promise<Array<UnifiedEvent>>}
   */
  async function querySqliteSources(cutoffMs) {
    const events = [];
    const cutoffIso = new Date(cutoffMs).toISOString();

    // _dispatch-log.sqlite
    try {
      const dispatchLogPath = join(projectsBasePath, '_dispatch-log.sqlite');
      if (existsSync(dispatchLogPath)) {
        const dispatchEvents = await queryDispatchLog(dispatchLogPath, cutoffIso);
        events.push(...dispatchEvents);
      }
    } catch (err) {
      if (err.code === 'SQLITE_BUSY') {
        log.debug('Dispatch log database is busy, skipping', { error: err.message });
      } else if (err.code !== 'ENOENT') {
        log.warn('Failed to query dispatch log', { error: err.message, code: err.code });
      }
    }

    // _circuit-breaker-transitions.sqlite
    try {
      const cbTransitionsPath = join(projectsBasePath, '_circuit-breaker-transitions.sqlite');
      if (existsSync(cbTransitionsPath)) {
        const cbEvents = await queryCircuitBreakerTransitions(cbTransitionsPath, cutoffIso);
        events.push(...cbEvents);
      }
    } catch (err) {
      if (err.code === 'SQLITE_BUSY') {
        log.debug('Circuit breaker transitions database is busy, skipping', { error: err.message });
      } else if (err.code !== 'ENOENT') {
        log.warn('Failed to query circuit breaker transitions', { error: err.message, code: err.code });
      }
    }

    return events;
  }

  /**
   * Query dispatch_decisions table from _dispatch-log.sqlite
   * @param {string} dbPath
   * @param {string} cutoffIso - ISO 8601 timestamp cutoff
   * @returns {Promise<Array<UnifiedEvent>>}
   */
  async function queryDispatchLog(dbPath, cutoffIso) {
    const events = [];
    let db = null;

    try {
      db = new Database(dbPath, { readonly: true, timeout: 5000 });

      const stmt = db.prepare(`
        SELECT
          id,
          timestamp,
          taskCategory,
          campaignId,
          selectedAgent,
          selectionReason,
          traceId,
          outcome,
          data,
          replayed_from_id,
          is_replay
        FROM dispatch_decisions
        WHERE timestamp >= ?
        ORDER BY timestamp DESC
      `);

      const rows = stmt.all(cutoffIso);

      for (const row of rows) {
        events.push(normalizeDispatchDecision(row));
      }

      log.debug('Queried dispatch log', { eventCount: rows.length, cutoffIso });
    } catch (err) {
      // Check for SQLITE_BUSY or lock errors
      if (err.message && (err.message.includes('SQLITE_BUSY') || err.message.includes('database is locked'))) {
        const busyError = new Error('Database is busy');
        busyError.code = 'SQLITE_BUSY';
        throw busyError;
      }
      throw err;
    } finally {
      if (db) {
        try {
          db.close();
        } catch (err) {
          log.debug('Failed to close dispatch log database', { error: err.message });
        }
      }
    }

    return events;
  }

  /**
   * Query cb_transitions table from _circuit-breaker-transitions.sqlite
   * @param {string} dbPath
   * @param {string} cutoffIso - ISO 8601 timestamp cutoff
   * @returns {Promise<Array<UnifiedEvent>>}
   */
  async function queryCircuitBreakerTransitions(dbPath, cutoffIso) {
    const events = [];
    let db = null;

    try {
      db = new Database(dbPath, { readonly: true, timeout: 5000 });

      const stmt = db.prepare(`
        SELECT
          id,
          timestamp,
          provider,
          agentId,
          dispatchId,
          previousState,
          newState,
          failureCount
        FROM cb_transitions
        WHERE timestamp >= ?
        ORDER BY timestamp DESC
      `);

      const rows = stmt.all(cutoffIso);

      for (const row of rows) {
        events.push(normalizeCircuitBreakerTransition(row));
      }

      log.debug('Queried circuit breaker transitions', { eventCount: rows.length, cutoffIso });
    } catch (err) {
      // Check for SQLITE_BUSY or lock errors
      if (err.message && (err.message.includes('SQLITE_BUSY') || err.message.includes('database is locked'))) {
        const busyError = new Error('Database is busy');
        busyError.code = 'SQLITE_BUSY';
        throw busyError;
      }
      throw err;
    } finally {
      if (db) {
        try {
          db.close();
        } catch (err) {
          log.debug('Failed to close circuit breaker database', { error: err.message });
        }
      }
    }

    return events;
  }

  /**
   * Read JSONL file and parse records
   * @param {string} filePath
   * @returns {Promise<Array<Object>>}
   */
  async function readJsonl(filePath) {
    if (!existsSync(filePath)) {
      return [];
    }

    const records = [];
    const fileStream = createReadStream(filePath);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch (err) {
        log.debug('Failed to parse JSONL line', { filePath, error: err.message });
      }
    }

    return records;
  }

  /**
   * Check if timestamp is within window
   * @param {string} timestamp - ISO 8601 timestamp
   * @param {number} cutoffMs - Cutoff time in milliseconds since epoch
   * @returns {boolean}
   */
  function isWithinWindow(timestamp, cutoffMs) {
    if (!timestamp) return false;
    try {
      const ts = new Date(timestamp).getTime();
      return ts >= cutoffMs;
    } catch (err) {
      return false;
    }
  }

  // ============================================================================
  // Schema Normalization Functions
  // ============================================================================

  /**
   * Normalize task-events.jsonl record
   */
  function normalizeTaskEvent(record, projectId) {
    const severity = inferTaskEventSeverity(record.action);
    return {
      timestamp: record.timestamp,
      projectId: projectId,
      agentId: record.agent || null,
      eventType: `task:${record.action}`,
      severity: severity,
      metadata: {
        taskId: record.taskId,
        reason: record.reason,
        eventId: record.eventId,
        action: record.action,
      },
    };
  }

  /**
   * Normalize learnings.jsonl record
   */
  function normalizeLearning(record, projectId) {
    return {
      timestamp: record.timestamp,
      projectId: projectId,
      agentId: record.source?.agentId || null,
      eventType: `learning:${record.category}`,
      severity: record.severity || 'info',
      metadata: {
        id: record.id,
        pattern: record.pattern,
        why: record.why,
        correction: record.correction,
        source: record.source,
        tags: record.tags,
        category: record.category,
      },
    };
  }

  /**
   * Normalize telemetry.jsonl record
   */
  function normalizeTelemetry(record, projectId) {
    return {
      timestamp: record.timestamp,
      projectId: record.projectId || projectId,
      agentId: record.agentId || null,
      eventType: record.event,
      severity: 'info',
      metadata: {
        eventId: record.eventId,
        taskId: record.taskId,
        phase: record.phase,
        data: record.data,
      },
    };
  }

  /**
   * Normalize anomaly-alerts.jsonl record
   */
  function normalizeAnomalyAlert(record) {
    return {
      timestamp: record.firedAt || record.timestamp,
      projectId: record.projectId || null,
      agentId: record.agentId || null,
      eventType: `anomaly:${record.condition}`,
      severity: record.severity || 'warning',
      metadata: {
        type: record.type,
        condition: record.condition,
        taskCategory: record.taskCategory,
        rollingSuccessRate: record.rollingSuccessRate,
        windowSize: record.windowSize,
        dispatchCount: record.dispatchCount,
        threshold: record.threshold,
        detail: record.detail,
      },
    };
  }

  /**
   * Normalize dispatch_decisions record
   */
  function normalizeDispatchDecision(row) {
    const severity = inferDispatchSeverity(row.outcome);
    const eventType = row.outcome === 'failed' || row.outcome === 'timeout'
      ? 'dispatch:failed'
      : 'dispatch:decision';

    return {
      timestamp: row.timestamp,
      projectId: null, // Cannot determine from dispatch_decisions alone
      agentId: row.selectedAgent || null,
      eventType: eventType,
      severity: severity,
      metadata: {
        id: row.id,
        taskCategory: row.taskCategory,
        campaignId: row.campaignId,
        selectionReason: row.selectionReason,
        traceId: row.traceId,
        outcome: row.outcome,
        data: row.data,
        replayed_from_id: row.replayed_from_id,
        is_replay: row.is_replay,
      },
    };
  }

  /**
   * Normalize cb_transitions record
   */
  function normalizeCircuitBreakerTransition(row) {
    const severity = row.newState === 'open' ? 'warning' : 'info';
    const eventType = row.newState === 'open'
      ? 'circuit_breaker:opened'
      : 'circuit_breaker:state_change';

    return {
      timestamp: row.timestamp,
      projectId: null, // Cannot determine from cb_transitions
      agentId: row.agentId || row.provider || null, // Use agentId if present, else provider
      eventType: eventType,
      severity: severity,
      metadata: {
        id: row.id,
        provider: row.provider,
        agentId: row.agentId,
        dispatchId: row.dispatchId,
        previousState: row.previousState,
        newState: row.newState,
        failureCount: row.failureCount,
      },
    };
  }

  /**
   * Normalize campaign failure from campaigns.json
   */
  function normalizeCampaignFailure(campaign, projectId) {
    return {
      timestamp: campaign.failedAt,
      projectId: projectId,
      agentId: null,
      eventType: 'campaign:failed',
      severity: 'error',
      metadata: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        createdAt: campaign.createdAt,
        failedAt: campaign.failedAt,
      },
    };
  }

  /**
   * Normalize task failure from tasks.json
   */
  function normalizeTaskFailure(task, projectId) {
    return {
      timestamp: task.failedAt,
      projectId: projectId,
      agentId: task.agent || null,
      eventType: 'task:failed',
      severity: 'error',
      metadata: {
        id: task.id,
        description: task.description,
        status: task.status,
        complexity: task.complexity,
        campaignId: task.campaignId || null,
        milestoneId: task.milestoneId || null,
        createdAt: task.createdAt,
        failedAt: task.failedAt,
      },
    };
  }

  /**
   * Normalize campaign completion from campaigns.json
   */
  function normalizeCampaignCompletion(campaign, projectId) {
    return {
      timestamp: campaign.completedAt,
      projectId: projectId,
      agentId: null,
      eventType: 'campaign:completed',
      severity: 'info',
      metadata: {
        id: campaign.id,
        name: campaign.name || campaign.title || null,
        status: campaign.status,
        createdAt: campaign.createdAt,
        completedAt: campaign.completedAt,
        milestoneCount: (campaign.milestones || []).length,
      },
    };
  }

  /**
   * Normalize subtask error from tasks.json
   */
  function normalizeSubtaskError(subtask, task, projectId) {
    return {
      timestamp: subtask.completedAt,
      projectId: projectId,
      agentId: subtask.assignee || null,
      eventType: 'subtask:error',
      severity: 'warning',
      metadata: {
        subtaskId: subtask.id,
        taskId: task.id,
        taskTitle: task.title || task.description || null,
        error: subtask.error,
        retryAttempts: subtask.retryAttempts || 0,
        status: subtask.status,
        campaignId: task.campaignId || null,
      },
    };
  }

  // ============================================================================
  // Severity Inference Helpers
  // ============================================================================

  function inferTaskEventSeverity(action) {
    if (!action) return 'info';
    if (action.includes('failed')) return 'error';
    if (action.includes('retried')) return 'warning';
    return 'info';
  }

  function inferDispatchSeverity(outcome) {
    if (!outcome) return 'info';
    if (outcome === 'failed' || outcome === 'timeout') return 'error';
    return 'info';
  }

  return {
    queryProjectEvents,
    DEFAULT_PROJECT_IDS,
  };
}

/**
 * Unified Event Schema
 * @typedef {Object} UnifiedEvent
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {string|null} projectId - Project identifier or null for cross-project events
 * @property {string|null} agentId - Agent identifier or null for system events
 * @property {string} eventType - Namespaced event type (e.g., "task:created", "anomaly:agent-anomaly")
 * @property {string} severity - "critical", "error", "warning", "info"
 * @property {Object} metadata - All remaining source-specific fields
 */
