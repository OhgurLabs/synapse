import { createLogger } from '../logger.js';
import { join, dirname } from 'path';
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs';

const log = createLogger('audit-logger');

export class AuditLogEntry {
  constructor(data) {
    this.type = data.type || 'unknown';
    this.path = data.path || null;
    this.operation = data.operation || null;
    this.reason = data.reason || null;
    this.timestamp = data.timestamp || new Date().toISOString();
    this.agentId = data.agentId || null;
    this.taskId = data.taskId || null;
    this.subtaskId = data.subtaskId || null;
    this.campaignId = data.campaignId || null;
    this.projectId = data.projectId || null;
    this.traceId = data.traceId || null;
    this.dispatchId = data.dispatchId || null;
    this.advisoryMode = data.advisoryMode || false;
    this.blocked = data.blocked || false;
    this.productionImpactDetected = data.productionImpactDetected || false;
    this.consecutiveBlocks = data.consecutiveBlocks || 0;
  }

  toJSON() {
    return {
      type: this.type,
      path: this.path,
      operation: this.operation,
      reason: this.reason,
      timestamp: this.timestamp,
      agentId: this.agentId,
      taskId: this.taskId,
      subtaskId: this.subtaskId,
      campaignId: this.campaignId,
      projectId: this.projectId,
      traceId: this.traceId,
      dispatchId: this.dispatchId,
      advisoryMode: this.advisoryMode,
      blocked: this.blocked,
      productionImpactDetected: this.productionImpactDetected,
      consecutiveBlocks: this.consecutiveBlocks,
    };
  }
}

export class StructuredAuditLogger {
  constructor(config = {}) {
    this.logPath = config.logPath || null;
    this.callbacks = [];
    this.enabled = config.enabled !== false;
    this.buffer = [];
    this.maxBuffer = config.maxBuffer || 1000;

    if (this.logPath) {
      try {
        mkdirSync(dirname(this.logPath), { recursive: true });
      } catch (err) {
        if (err.code !== 'EEXIST') {
          log.warn('Failed to create audit log directory', { error: err.message });
        }
      }
    }

    log.info('StructuredAuditLogger initialized', { logPath: this.logPath, enabled: this.enabled });
  }

  logAction(entryData) {
    if (!this.enabled) return;

    const entry = new AuditLogEntry(entryData);
    const jsonEntry = entry.toJSON();

    this.buffer.push(jsonEntry);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer = this.buffer.slice(-this.maxBuffer);
    }

    if (this.logPath) {
      try {
        appendFileSync(this.logPath, JSON.stringify(jsonEntry) + '\n');
      } catch (err) {
        log.error('Failed to persist audit log entry', { error: err.message, entry: jsonEntry });
      }
    }

    for (const callback of this.callbacks) {
      try {
        callback(jsonEntry);
      } catch (err) {
        log.error('Audit log callback failed', { error: err.message, entry: jsonEntry });
      }
    }

    log.info('Audit log entry recorded', {
      type: entry.type,
      path: entry.path,
      agentId: entry.agentId,
      blocked: entry.blocked,
    });
  }

  on(event, callback) {
    if (event === 'entry' || event === 'log') {
      this.callbacks.push(callback);
      return () => {
        this.callbacks = this.callbacks.filter(cb => cb !== callback);
      };
    }
    log.warn('Unknown audit logger event', { event });
    return () => {};
  }

  query(opts = {}) {
    const { limit = 100, agentId, taskId, campaignId, since, action, projectId } = opts;
    let results = [...this.buffer];

    if (agentId) results = results.filter(e => e.agentId === agentId);
    if (taskId) results = results.filter(e => e.taskId === taskId);
    if (campaignId) results = results.filter(e => e.campaignId === campaignId);
    if (projectId) results = results.filter(e => e.projectId === projectId);
    if (since) {
      const sinceDate = new Date(since);
      results = results.filter(e => new Date(e.timestamp) >= sinceDate);
    }
    if (action) results = results.filter(e => e.type === action);

    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return results.slice(0, limit);
  }

  queryFromFile(projectId, opts = {}) {
    if (!this.logPath || !existsSync(this.logPath)) return [];

    const { limit = 100, agentId, taskId, campaignId, since, action } = opts;
    const results = [];

    try {
      const content = readFileSync(this.logPath, 'utf-8');
      const sinceDate = since ? new Date(since) : null;

      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (projectId && entry.projectId !== projectId) continue;
          if (agentId && entry.agentId !== agentId) continue;
          if (taskId && entry.taskId !== taskId) continue;
          if (campaignId && entry.campaignId !== campaignId) continue;
          if (sinceDate && new Date(entry.timestamp) < sinceDate) continue;
          if (action && entry.type !== action) continue;
          results.push(entry);
        } catch { /* skip corrupt lines */ }
      }

      results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      return results.slice(0, limit);
    } catch (err) {
      log.error('Failed to query audit log file', { error: err.message });
      return [];
    }
  }

  getBufferedEntries() {
    return [...this.buffer];
  }

  clearBuffer() {
    this.buffer = [];
  }

  export(format = 'json') {
    const entries = this.getBufferedEntries();
    const data = {
      timestamp: new Date().toISOString(),
      totalEntries: entries.length,
      logPath: this.logPath,
      entries,
    };

    if (format === 'json') {
      return JSON.stringify(data, null, 2);
    } else if (format === 'csv') {
      const headers = [
        'timestamp', 'type', 'path', 'operation', 'reason',
        'agentId', 'taskId', 'subtaskId', 'campaignId', 'projectId',
        'traceId', 'dispatchId', 'blocked', 'advisoryMode',
      ];
      const rows = entries.map(e =>
        headers.map(h => JSON.stringify(e[h] || '')).join(',')
      );
      return [headers.join(','), ...rows].join('\n');
    }
    return data;
  }
}

export class AuditLoggerMiddleware {
  constructor(auditLogger) {
    this.auditLogger = auditLogger;
    this.interceptedOperations = new Set();
  }

  interceptWrite(filePath, operation, reason, context) {
    const auditEvent = {
      type: 'write_blocked',
      path: filePath,
      operation,
      reason,
      advisoryMode: context.advisoryMode || false,
      blocked: context.blocked !== false,
      timestamp: new Date().toISOString(),
      agentId: context.agentId || null,
      taskId: context.taskId || null,
      subtaskId: context.subtaskId || null,
      campaignId: context.campaignId || null,
      projectId: context.projectId || null,
      traceId: context.traceId || null,
      dispatchId: context.dispatchId || null,
      productionImpactDetected: context.productionImpactDetected || false,
      consecutiveBlocks: context.consecutiveBlocks || 0,
    };

    this.auditLogger.logAction(auditEvent);
    this.interceptedOperations.add(`${operation}:${filePath}`);

    return auditEvent;
  }

  getInterceptedOperations() {
    return [...this.interceptedOperations];
  }

  clearInterceptedOperations() {
    this.interceptedOperations.clear();
  }
}

export function createAuditLogger(config = {}) {
  return new StructuredAuditLogger(config);
}

export function createAuditMiddleware(auditLogger) {
  return new AuditLoggerMiddleware(auditLogger);
}
