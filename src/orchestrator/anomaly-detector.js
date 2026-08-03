// Anomaly detector — monitors per-agent rolling success rate and emits alert:firing / alert:resolved.

import { createLogger } from '../logger.js';
import { loadAlertHistory, appendAlertEntry } from './alert-history-store.js';
import { existsSync, unlinkSync } from 'fs';

const log = createLogger('anomaly-detector');

const DEFAULT_THRESHOLD   = 0.7;
const DEFAULT_WINDOW_SIZE = 10;
const DEFAULT_INTERVAL_MS = 60_000;

export function createAnomalyDetector(opts = {}) {
  const { events, performanceStore, config, filePath, anomalyHistoryStore, historyStore } = opts;
  const activeAlerts = new Map();  // alertKey → alert object
  let alertHistory = [];
  let interval = null;

  // Use provided anomaly history store (SQLite-backed) or fall back to filePath for legacy JSONL
  const store = anomalyHistoryStore || historyStore;

  // Support both direct { threshold, windowSize } and nested { config.anomalyDetector.* }
  const threshold  = opts.threshold  ?? config?.anomalyDetector?.threshold  ?? DEFAULT_THRESHOLD;
  const windowSize = opts.windowSize ?? config?.anomalyDetector?.windowSize ?? DEFAULT_WINDOW_SIZE;
  const maxHistory = config?.anomalyDetector?.maxAlertHistory ?? 500;

  // Clean up orphaned .tmp file from prior crash (if any)
  if (filePath) {
    const tmpPath = `${filePath}.tmp`;
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
        log.info('Cleaned up orphaned .tmp file', { tmpPath });
      } catch (err) {
        log.warn('Failed to clean up orphaned .tmp file', { tmpPath, error: err.message });
      }
    }
  }

  // Helper: generate alert key from agentId and category
  function alertKey(agentId, category) {
    return `agent-anomaly:${agentId}:${category}`;
  }

  // Load and restore persisted alert history and active alerts
  // Support both SQLite store (preferred) and legacy JSONL filePath
  if (store) {
    // Use SQLite-backed store
    const result = store.query({ limit: maxHistory + 100 });
    const entries = result.entries;
    
    const firedMap = new Map();  // alertKey → fired alert object
    const resolvedEntries = [];
    const legacyEntries = [];

    // First pass: categorize entries
    for (const entry of entries) {
      // Handle both SQLite format (with type field) and legacy format
      const entryType = entry.type || 'resolved';
      const entryTime = entry.firedAt ? new Date(entry.firedAt).getTime() : null;
      
      if (!entryType) {
        // Legacy entry (no type field) — treat as resolved
        legacyEntries.push(entry);
      } else if (entryType === 'fired') {
        const key = alertKey(entry.agentId, entry.taskCategory);
        firedMap.set(key, entry);
      } else if (entryType === 'resolved') {
        resolvedEntries.push(entry);
      }
    }

    // Second pass: pair resolved entries with fired entries
    for (const resolved of resolvedEntries) {
      const key = alertKey(resolved.agentId, resolved.taskCategory);
      const fired = firedMap.get(key);
      if (fired) {
        // Match found — create resolved alert and add to history
        const resolvedAlert = { ...fired, resolvedAt: resolved.resolvedAt };
        alertHistory.push(resolvedAlert);
        firedMap.delete(key);  // remove from unresolved set
      }
    }

    // Add legacy entries to history
    for (const legacy of legacyEntries) {
      alertHistory.push(legacy);
    }

    // Apply maxHistory cap
    if (alertHistory.length > maxHistory) {
      alertHistory = alertHistory.slice(-maxHistory);
    }

    // Third pass: any remaining fired entries are still active
    for (const [key, fired] of firedMap.entries()) {
      activeAlerts.set(key, fired);
    }

    log.info('Alert history restored from SQLite store', {
      totalLoaded: entries.length,
      activeAlerts: activeAlerts.size,
      historyEntries: alertHistory.length,
    });
  } else if (filePath) {
    // Legacy JSONL fallback
    const retentionMs = config?.anomalyDetector?.retentionMs ?? (7 * 24 * 60 * 60 * 1000);
    const now = Date.now();
    const cutoffTime = now - retentionMs;

    const loaded = loadAlertHistory(filePath);
    const firedMap = new Map();
    const resolvedEntries = [];
    const legacyEntries = [];

    for (const entry of loaded) {
      const entryTime = entry.firedAt ? new Date(entry.firedAt).getTime() : null;
      if (entryTime && entryTime < cutoffTime) {
        continue;
      }

      if (!entry.type) {
        legacyEntries.push(entry);
      } else if (entry.type === 'fired') {
        const key = alertKey(entry.agentId, entry.taskCategory);
        firedMap.set(key, entry);
      } else if (entry.type === 'resolved') {
        resolvedEntries.push(entry);
      }
    }

    for (const resolved of resolvedEntries) {
      const key = alertKey(resolved.agentId, resolved.taskCategory);
      const fired = firedMap.get(key);
      if (fired) {
        const resolvedAlert = { ...fired, resolvedAt: resolved.resolvedAt };
        alertHistory.push(resolvedAlert);
        firedMap.delete(key);
      }
    }

    for (const legacy of legacyEntries) {
      alertHistory.push(legacy);
    }

    if (alertHistory.length > maxHistory) {
      alertHistory = alertHistory.slice(-maxHistory);
    }

    for (const [key, fired] of firedMap.entries()) {
      activeAlerts.set(key, fired);
    }

    log.info('Alert history restored from disk', {
      totalLoaded: loaded.length,
      activeAlerts: activeAlerts.size,
      historyEntries: alertHistory.length,
      retentionCutoff: new Date(cutoffTime).toISOString(),
    });
  }

  function fireAlert(agentId, category, rollingSuccessRate, count) {
    const key = alertKey(agentId, category);
    if (activeAlerts.has(key)) return; // dedup — already firing
    const severity = rollingSuccessRate < 0.3 ? 'critical' : 'warning';
    const alert = {
      projectId:          null,
      condition:          'agent-anomaly',
      agentId,
      taskCategory:       category,
      rollingSuccessRate,
      rollingRate:        rollingSuccessRate,
      windowSize:         count,
      dispatchCount:      count,
      threshold,
      severity,
      detail:             `Agent ${agentId} (${category}) rolling success rate ${(rollingSuccessRate * 100).toFixed(1)}% over last ${count} dispatches`,
      firedAt:            new Date().toISOString(),
      type:               'fired',
    };
    activeAlerts.set(key, alert);
    events?.emit('alert:firing', alert);
    // Persist new fired event to store if provided
    if (store) {
      try {
        store.append({ type: 'fired', ...alert });
      } catch (err) {
        log.warn('Failed to persist fired alert to SQLite store', { error: err.message });
      }
    } else if (filePath) {
      appendAlertEntry(filePath, { type: 'fired', ...alert });
    }
    log.warn('Anomaly alert fired', { agentId, category, rollingSuccessRate, dispatchCount: count });
  }

  function resolveAlert(agentId, category) {
    const key = alertKey(agentId, category);
    if (!activeAlerts.has(key)) return;
    const fired = activeAlerts.get(key);
    activeAlerts.delete(key);
    const resolvedAt = new Date().toISOString();
    const resolvedAlert = { ...fired, resolvedAt, type: 'resolved' };
    alertHistory.push(resolvedAlert);
    if (alertHistory.length > maxHistory) {
      alertHistory.shift();
    }
    // Persist new entry to store if provided
    if (store) {
      try {
        store.append(resolvedAlert);
      } catch (err) {
        log.warn('Failed to persist resolved alert to SQLite store', { error: err.message });
      }
    } else if (filePath) {
      appendAlertEntry(filePath, resolvedAlert);
    }
    const payload = { projectId: null, condition: 'agent-anomaly', agentId, taskCategory: category, resolvedAt };
    events?.emit('alert:resolved', payload);
    log.info('Anomaly alert resolved', { agentId, category });
  }

  function checkAll() {
    const windows = performanceStore?.getDispatchWindows(windowSize, { excludeInfrastructure: true });
    if (!windows) return;

    for (const windowData of windows) {
      const { agentId, category, successRate, dispatchCount, insufficientData } = windowData;
      
      if (insufficientData) {
        continue;
      }

      if (successRate < threshold) {
        fireAlert(agentId, category, successRate, dispatchCount);
      } else {
        resolveAlert(agentId, category);
      }
    }
  }

  function start() {
    const enabled    = config?.anomalyDetector?.enabled ?? true;
    const intervalMs = config?.anomalyDetector?.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!enabled) {
      log.info('Anomaly detector disabled via config');
      return;
    }
    checkAll(); // first check immediately
    interval = setInterval(checkAll, intervalMs);
    log.info('Anomaly detector started', { intervalMs, threshold, windowSize });
  }

  function stop() {
    if (interval) { clearInterval(interval); interval = null; }
  }

  function getActiveAlerts() {
    return [...activeAlerts.values()];
  }

  function acknowledgeAlert({ alertKey: ackKey, agentId, taskCategory, condition, operatorId, correlationId } = {}) {
    let alert = null;
    if (ackKey && activeAlerts.has(ackKey)) {
      alert = activeAlerts.get(ackKey);
    } else if (agentId && taskCategory) {
      const key = alertKey(agentId, taskCategory);
      if (activeAlerts.has(key)) {
        alert = activeAlerts.get(key);
      }
    }

    if (!alert && (agentId || taskCategory || condition)) {
      alert = [...activeAlerts.values()].find((entry) => {
        if (condition && entry.condition !== condition) return false;
        if (agentId && entry.agentId !== agentId) return false;
        if (taskCategory && entry.taskCategory !== taskCategory) return false;
        return true;
      }) || null;
    }

    if (!alert) return null;

    const acknowledgedAt = new Date().toISOString();
    const ackEntry = {
      ...alert,
      type: 'acknowledged',
      acknowledgedAt,
      acknowledgedBy: operatorId || 'system',
      correlationId: correlationId || null,
    };

    alertHistory.push(ackEntry);
    if (alertHistory.length > maxHistory) {
      alertHistory.shift();
    }

    if (store) {
      try {
        store.append(ackEntry);
      } catch (err) {
        log.warn('Failed to persist acknowledged alert to SQLite store', { error: err.message });
      }
    } else if (filePath) {
      appendAlertEntry(filePath, ackEntry);
    }

    return ackEntry;
  }

  function getAlertHistory() {
    // If store is available, query it for complete history
    if (store) {
      const result = store.query({ limit: 500 });
      return result.entries;
    }
    return [...alertHistory];
  }

  /**
   * Returns filtered alert history formatted for timeline API.
   * @param {Object} filters
   * @param {string} [filters.agentId] - Filter by agent ID
   * @param {string} [filters.category] - Filter by task category
   * @param {string} [filters.since] - ISO timestamp lower bound (firedAt >= since)
   * @param {string} [filters.until] - ISO timestamp upper bound (firedAt <= until)
   * @param {number} [filters.limit] - Maximum events to return
   * @param {number} [filters.offset] - Number of events to skip
   * @returns {{ events: Array, total: number }}
   */
  function getAlertHistoryFiltered(filters = {}) {
    const { agentId, category, since, until, limit, offset = 0 } = filters;
    const sinceTime = since ? new Date(since).getTime() : null;
    const untilTime = until ? new Date(until).getTime() : null;
    const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const safeLimit = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : undefined;

    // Filter the alert history
    let filtered = alertHistory.filter(alert => {
      if (agentId && alert.agentId !== agentId) return false;
      if (category && alert.taskCategory !== category) return false;
      const firedTime = new Date(alert.firedAt).getTime();
      if (since) {
        if (firedTime < sinceTime) return false;
      }
      if (until) {
        if (firedTime > untilTime) return false;
      }
      return true;
    });

    const total = filtered.length;

    // Apply pagination
    if (safeLimit !== undefined || safeOffset > 0) {
      const start = safeOffset;
      const end = safeLimit !== undefined ? start + safeLimit : undefined;
      filtered = filtered.slice(start, end);
    }

    // Transform to timeline event format
    const events = filtered.map(alert => {
      // Generate deterministic ID from agentId+category+firedAt
      const id = `anomaly-${alert.agentId}-${alert.taskCategory}-${alert.firedAt}`;
      const timestamp = alert.firedAt;
      const summary = alert.resolvedAt
        ? `Anomaly resolved: ${alert.agentId} (${alert.taskCategory})`
        : `Anomaly detected: ${alert.agentId} (${alert.taskCategory}) - ${(alert.rollingSuccessRate * 100).toFixed(1)}% success`;

      return {
        id,
        type: 'anomaly',
        timestamp,
        summary,
        data: alert,
      };
    });

    return { events, total };
  }

  // Alias for task-spec compatibility
  const getHistory = getAlertHistory;

  /**
   * Flush pending writes to disk immediately.
   * Since writes are synchronous, this is effectively a no-op but provided for API consistency.
   * @returns {Promise<void>}
   */
  async function flush() {
    // All writes are synchronous (writeAlertHistory blocks until fsync completes)
    // This method exists for test determinism and API consistency with DispatchLog
    return Promise.resolve();
  }

  return { start, stop, checkAll, getActiveAlerts, getAlertHistory, getAlertHistoryFiltered, getHistory, flush, resolveAlert, acknowledgeAlert };
}
