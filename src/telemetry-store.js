/**
 * TelemetryStore — persists telemetry events to per-project JSONL files
 * with globally monotonic sequential eventIds.
 *
 * File: .synapse/projects/{projectId}/telemetry.jsonl
 * Format: one JSON object per line, newline-terminated.
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('telemetry-store');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour

export class TelemetryStore {
  /**
   * @param {string} projectsDir — .synapse/projects/ directory
   * @param {object} [opts]
   * @param {number} [opts.ttlMs] — event TTL in ms (default 24h). Set shorter for testing.
   */
  constructor(projectsDir, opts = {}) {
    this._projectsDir = projectsDir;
    this._nextEventId = 1;
    this._ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this._cleanupInterval = null;
    this._projectIds = [];
  }

  /**
   * Initialize the sequential counter from the highest persisted eventId
   * across all projects. Must be called before append().
   * @param {string[]} projectIds
   */
  init(projectIds) {
    let maxId = 0;
    for (const pid of projectIds) {
      const filePath = this._path(pid);
      if (!existsSync(filePath)) continue;
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        // Scan from end for efficiency — last line has highest ID
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const entry = JSON.parse(line);
            if (typeof entry.eventId === 'number' && entry.eventId > maxId) {
              maxId = entry.eventId;
            }
            break; // Only need the last valid line
          } catch { /* skip corrupt lines */ }
        }
      } catch (err) {
        log.warn('Failed to read telemetry file for counter init', { projectId: pid, error: err.message });
      }
    }
    this._nextEventId = maxId + 1;
    this._projectIds = projectIds;

    // Run cleanup on startup to purge stale entries
    this.cleanup();

    log.info('Telemetry store initialized', { nextEventId: this._nextEventId, projects: projectIds.length, ttlMs: this._ttlMs });
    return this;
  }

  _path(projectId) {
    // Same path discipline as StateManager / OperatorAuditStore — no ../ escape.
    if (
      !projectId ||
      typeof projectId !== 'string' ||
      !/^[a-zA-Z0-9_-]+$/.test(projectId) ||
      projectId.length > 128
    ) {
      throw new Error(
        `Invalid projectId for telemetry: "${String(projectId).slice(0, 80)}" — alphanumeric/hyphens/underscores only`
      );
    }
    return join(this._projectsDir, projectId, 'telemetry.jsonl');
  }

  /**
   * Append a telemetry event to disk. Returns the assigned eventId.
   * @param {string} projectId
   * @param {string} eventName — e.g. 'task:created', 'telemetry:subtask_claimed'
   * @param {object} eventData — the full event payload
   * @returns {number} the assigned eventId
   */
  append(projectId, eventName, eventData) {
    const eventId = this._nextEventId++;
    const entry = {
      eventId,
      event: eventName,
      timestamp: eventData.timestamp || new Date().toISOString(),
      projectId,
      agentId: eventData.agentId || eventData.agent || eventData.assignedTo || null,
      taskId: eventData.taskId || null,
      phase: eventData.phase || null,
      data: eventData,
    };

    const filePath = this._path(projectId);
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    try {
      appendFileSync(filePath, JSON.stringify(entry) + '\n');
    } catch (err) {
      log.error('Failed to persist telemetry event', { eventId, event: eventName, projectId, error: err.message });
    }

    return eventId;
  }

  /**
   * Read events after a given eventId for replay (Last-Event-ID support).
   * @param {string} projectId
   * @param {number} afterEventId
   * @returns {object[]}
   */
  getEventsAfter(projectId, afterEventId) {
    const filePath = this._path(projectId);
    if (!existsSync(filePath)) return [];
    try {
      const content = readFileSync(filePath, 'utf-8');
      const events = [];
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.eventId > afterEventId) events.push(entry);
        } catch { /* skip corrupt lines */ }
      }
      return events;
    } catch (err) {
      log.error('Failed to read telemetry events', { projectId, error: err.message });
      return [];
    }
  }

  /**
   * Read the last N events for a project (polling fallback).
   * @param {string} projectId
   * @param {number} limit
   * @returns {object[]}
   */
  getRecent(projectId, limit = 50) {
    const filePath = this._path(projectId);
    if (!existsSync(filePath)) return [];
    try {
      const content = readFileSync(filePath, 'utf-8');
      const events = [];
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch { /* skip corrupt lines */ }
      }
      return events.slice(-limit);
    } catch (err) {
      log.error('Failed to read recent telemetry events', { projectId, error: err.message });
      return [];
    }
  }

  /**
   * Remove telemetry entries older than the configured TTL from all projects.
   * Rewrites each telemetry.jsonl in place, keeping only entries within the window.
   * @returns {{ cleaned: number, kept: number }} totals across all projects
   */
  cleanup() {
    const cutoff = new Date(Date.now() - this._ttlMs).toISOString();
    let totalCleaned = 0;
    let totalKept = 0;

    for (const pid of this._projectIds) {
      const filePath = this._path(pid);
      if (!existsSync(filePath)) continue;

      try {
        const content = readFileSync(filePath, 'utf-8');
        const kept = [];
        let cleaned = 0;

        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.timestamp >= cutoff) {
              kept.push(line);
            } else {
              cleaned++;
            }
          } catch {
            // Drop corrupt lines during cleanup
            cleaned++;
          }
        }

        if (cleaned > 0) {
          writeFileSync(filePath, kept.length > 0 ? kept.join('\n') + '\n' : '');
          log.info('Telemetry cleanup', { projectId: pid, cleaned, kept: kept.length });
        }

        totalCleaned += cleaned;
        totalKept += kept.length;
      } catch (err) {
        log.error('Telemetry cleanup failed', { projectId: pid, error: err.message });
      }
    }

    return { cleaned: totalCleaned, kept: totalKept };
  }

  /**
   * Start the hourly cleanup timer. Call after init().
   */
  startCleanupTimer() {
    if (this._cleanupInterval) return;
    this._cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
    log.info('Telemetry cleanup timer started', { intervalMs: CLEANUP_INTERVAL_MS });
  }

  /**
   * Stop the cleanup timer (for graceful shutdown).
   */
  stopCleanupTimer() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }
}
