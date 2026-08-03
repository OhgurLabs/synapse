/**
 * ApprovalAuditTrail — comprehensive audit trail for milestone approval events.
 * Tracks all approval decisions with full context: timestamp, operator ID, milestone ID,
 * campaign ID, project ID, decision, and reason. Persists to per-project JSONL files.
 *
 * File: .synapse/projects/{projectId}/approval-audit.jsonl
 * Format: one JSON object per line, newline-terminated.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('approval-audit-trail');

export class ApprovalAuditEntry {
  constructor(data) {
    this.eventId = data.eventId || null;
    this.timestamp = data.timestamp || new Date().toISOString();
    this.operatorId = data.operatorId || data.actorId || null;
    this.milestoneId = data.milestoneId || null;
    this.campaignId = data.campaignId || null;
    this.projectId = data.projectId || null;
    this.decision = data.decision || null; // 'approved', 'rejected', 'timeout', 'expired', 'paused', 'resumed', 'paused_by_campaign', 'resumed_by_campaign', 'activated', 'requested'
    this.reason = data.reason || null;
    this.approvalRequestedAt = data.approvalRequestedAt || null;
    this.approvalApprovedAt = data.approvalApprovedAt || null;
    this.approvalDuration = data.approvalDuration || null; // Duration in seconds from request to decision
    this.subtaskId = data.subtaskId || null;
    this.traceId = data.traceId || null;
    this.dispatchId = data.dispatchId || null;
    this.source = data.source || 'cli'; // 'cli', 'rest', 'webhook'
    this.webhookProvider = data.webhookProvider || null; // 'slack', 'generic', null
    this.deliveryId = data.deliveryId || null;
    this.signatureValidated = data.signatureValidated || null; // true, false, or null if not applicable
    this.signatureError = data.signatureError || null;
    this.context = data.context || {};
  }

  toJSON() {
    return {
      eventId: this.eventId,
      timestamp: this.timestamp,
      operatorId: this.operatorId,
      milestoneId: this.milestoneId,
      campaignId: this.campaignId,
      projectId: this.projectId,
      decision: this.decision,
      reason: this.reason,
      approvalRequestedAt: this.approvalRequestedAt,
      approvalApprovedAt: this.approvalApprovedAt,
      approvalDuration: this.approvalDuration,
      subtaskId: this.subtaskId,
      traceId: this.traceId,
      dispatchId: this.dispatchId,
      source: this.source,
      webhookProvider: this.webhookProvider,
      deliveryId: this.deliveryId,
      signatureValidated: this.signatureValidated,
      signatureError: this.signatureError,
      context: this.context,
    };
  }
}

export class ApprovalAuditTrail {
  constructor(config = {}) {
    this.projectsDir = config.projectsDir || null;
    this.enabled = config.enabled !== false;
    this.buffer = [];
    this.maxBuffer = config.maxBuffer || 1000;
    this._nextEventId = 1;

    if (this.projectsDir) {
      try {
        if (!existsSync(this.projectsDir)) {
          mkdirSync(this.projectsDir, { recursive: true });
        }
      } catch (err) {
        log.warn('Failed to create audit trail directory', { error: err.message });
      }
    }

    log.info('ApprovalAuditTrail initialized', { projectsDir: this.projectsDir, enabled: this.enabled });
  }

  _path(projectId) {
    return join(this.projectsDir, projectId, 'approval-audit.jsonl');
  }

  _initEventId(projectId) {
    if (!this.projectsDir || !projectId) return;
    const filePath = this._path(projectId);
    if (!existsSync(filePath)) return;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (typeof entry.eventId === 'number' && entry.eventId >= this._nextEventId) {
            this._nextEventId = entry.eventId + 1;
          }
          break;
        } catch { 
        }
      }
    } catch (err) {
      log.warn('Failed to read approval audit file for counter init', { projectId, error: err.message });
    }
  }

  _addToBuffer(entry) {
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer = this.buffer.slice(-this.maxBuffer);
    }
  }

  logApproval(data) {
    if (!this.enabled) return null;

    const webhookData = data.webhookData || {};
    const resolvedSource = data.source || webhookData.source || (webhookData.provider ? 'webhook' : 'cli');
    const resolvedWebhookProvider = data.webhookProvider ?? webhookData.provider ?? null;
    const resolvedDeliveryId = data.deliveryId ?? webhookData.deliveryId ?? null;
    const resolvedSignatureValidated =
      data.signatureValidated !== undefined
        ? data.signatureValidated
        : webhookData.signatureValidated !== undefined
          ? webhookData.signatureValidated
          : null;
    const resolvedSignatureError =
      data.signatureError !== undefined
        ? data.signatureError
        : webhookData.signatureError !== undefined
          ? webhookData.signatureError
          : null;
    const entry = new ApprovalAuditEntry({
      ...data,
      decision: 'approved',
      source: resolvedSource,
      webhookProvider: resolvedWebhookProvider,
      deliveryId: resolvedDeliveryId,
      signatureValidated: resolvedSignatureValidated,
      signatureError: resolvedSignatureError,
    });
    entry.eventId = this._nextEventId++;

    const jsonEntry = entry.toJSON();
    this._addToBuffer(jsonEntry);
    this._persist(data.projectId || 'default', jsonEntry);

    log.info('Approval audit entry recorded', {
      eventId: entry.eventId,
      milestoneId: entry.milestoneId,
      campaignId: entry.campaignId,
      operatorId: entry.operatorId,
      decision: entry.decision,
      source: entry.source,
      webhookProvider: entry.webhookProvider,
      deliveryId: entry.deliveryId,
      signatureValidated: entry.signatureValidated,
    });

    return entry;
  }

  logRejection(data) {
    if (!this.enabled) return null;

    const webhookData = data.webhookData || {};
    const resolvedSource = data.source || webhookData.source || (webhookData.provider ? 'webhook' : 'cli');
    const resolvedWebhookProvider = data.webhookProvider ?? webhookData.provider ?? null;
    const resolvedDeliveryId = data.deliveryId ?? webhookData.deliveryId ?? null;
    const resolvedSignatureValidated =
      data.signatureValidated !== undefined
        ? data.signatureValidated
        : webhookData.signatureValidated !== undefined
          ? webhookData.signatureValidated
          : null;
    const resolvedSignatureError =
      data.signatureError !== undefined
        ? data.signatureError
        : webhookData.signatureError !== undefined
          ? webhookData.signatureError
          : null;
    const entry = new ApprovalAuditEntry({
      ...data,
      decision: 'rejected',
      source: resolvedSource,
      webhookProvider: resolvedWebhookProvider,
      deliveryId: resolvedDeliveryId,
      signatureValidated: resolvedSignatureValidated,
      signatureError: resolvedSignatureError,
    });
    entry.eventId = this._nextEventId++;

    const jsonEntry = entry.toJSON();
    this._addToBuffer(jsonEntry);
    this._persist(data.projectId || 'default', jsonEntry);

    log.info('Rejection audit entry recorded', {
      eventId: entry.eventId,
      milestoneId: entry.milestoneId,
      campaignId: entry.campaignId,
      operatorId: entry.operatorId,
      decision: entry.decision,
      source: entry.source,
      webhookProvider: entry.webhookProvider,
      deliveryId: entry.deliveryId,
      signatureValidated: entry.signatureValidated,
    });

    return entry;
  }

  logTimeout(data) {
    if (!this.enabled) return null;

    const entry = new ApprovalAuditEntry({
      ...data,
      decision: 'timeout',
    });
    entry.eventId = this._nextEventId++;

    const jsonEntry = entry.toJSON();
    this._addToBuffer(jsonEntry);
    this._persist(data.projectId || 'default', jsonEntry);

    log.info('Timeout audit entry recorded', {
      eventId: entry.eventId,
      milestoneId: entry.milestoneId,
      campaignId: entry.campaignId,
      decision: entry.decision,
    });

    return entry;
  }

  logExpiry(data) {
    if (!this.enabled) return null;

    const entry = new ApprovalAuditEntry({
      ...data,
      decision: 'expired',
    });
    entry.eventId = this._nextEventId++;

    const jsonEntry = entry.toJSON();
    this._addToBuffer(jsonEntry);
    this._persist(data.projectId || 'default', jsonEntry);

    log.info('Expiry audit entry recorded', {
      eventId: entry.eventId,
      milestoneId: entry.milestoneId,
      campaignId: entry.campaignId,
      decision: entry.decision,
    });

    return entry;
  }

  logEvent(data) {
    if (!this.enabled) return null;

    const entry = new ApprovalAuditEntry(data);
    entry.eventId = this._nextEventId++;

    const jsonEntry = entry.toJSON();
    this._addToBuffer(jsonEntry);
    this._persist(data.projectId || 'default', jsonEntry);

    log.info('Custom approval audit entry recorded', {
      eventId: entry.eventId,
      milestoneId: entry.milestoneId,
      decision: entry.decision,
    });

    return entry;
  }

  _persist(projectId, entry) {
    if (!this.projectsDir) return;

    const filePath = this._path(projectId);
    const dir = dirname(filePath);

    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      appendFileSync(filePath, JSON.stringify(entry) + '\n');
    } catch (err) {
      log.error('Failed to persist approval audit entry', { 
        eventId: entry.eventId, 
        projectId, 
        error: err.message 
      });
    }
  }

  queryByMilestone(projectId, milestoneId, opts = {}) {
    const { limit = 100 } = opts;
    let results = this.buffer.filter(e => e.milestoneId === milestoneId);

    if (projectId && this.projectsDir) {
      const filePath = this._path(projectId);
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8');
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.milestoneId === milestoneId && !results.find(r => r.eventId === entry.eventId)) {
                results.push(entry);
              }
            } catch { 
            }
          }
        } catch (err) {
          log.error('Failed to query approval audit by milestone', { projectId, milestoneId, error: err.message });
        }
      }
    }

    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return results.slice(0, limit);
  }

  queryByOperator(projectId, operatorId, opts = {}) {
    const { limit = 100, since } = opts;
    let results = this.buffer.filter(e => e.operatorId === operatorId);

    if (projectId && this.projectsDir) {
      const filePath = this._path(projectId);
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8');
          const sinceDate = since ? new Date(since) : null;
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.operatorId === operatorId) {
                if (sinceDate && new Date(entry.timestamp) < sinceDate) continue;
                if (!results.find(r => r.eventId === entry.eventId)) {
                  results.push(entry);
                }
              }
            } catch { 
            }
          }
        } catch (err) {
          log.error('Failed to query approval audit by operator', { projectId, operatorId, error: err.message });
        }
      }
    }

    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return results.slice(0, limit);
  }

  query(projectId, opts = {}) {
    const { limit = 100, milestoneId, operatorId, decision, since, eventId } = opts;
    let results = this._queryBuffer(opts);

    if (projectId && this.projectsDir) {
      const filePath = this._path(projectId);
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8');
          const sinceDate = since ? new Date(since) : null;
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (eventId && entry.eventId !== eventId) continue;
              if (milestoneId && entry.milestoneId !== milestoneId) continue;
              if (operatorId && entry.operatorId !== operatorId) continue;
              if (decision && entry.decision !== decision) continue;
              if (sinceDate && new Date(entry.timestamp) < sinceDate) continue;
              if (!results.find(r => r.eventId === entry.eventId)) {
                results.push(entry);
              }
            } catch { 
            }
          }
        } catch (err) {
          log.error('Failed to query approval audit', { projectId, error: err.message });
        }
      }
    }

    results.sort((a, b) => a.eventId - b.eventId);
    return results.slice(-limit);
  }

  _queryBuffer(opts = {}) {
    const { milestoneId, operatorId, decision, since, eventId } = opts;
    let results = [...this.buffer];

    if (eventId) results = results.filter(e => e.eventId === eventId);
    if (milestoneId) results = results.filter(e => e.milestoneId === milestoneId);
    if (operatorId) results = results.filter(e => e.operatorId === operatorId);
    if (decision) results = results.filter(e => e.decision === decision);
    if (since) {
      const sinceDate = new Date(since);
      results = results.filter(e => new Date(e.timestamp) >= sinceDate);
    }

    return results;
  }

  queryAllProjects(opts = {}) {
    const { limit = 100 } = opts;
    const results = [];

    if (!this.projectsDir) return results;

    try {
      if (!existsSync(this.projectsDir)) return results;
      const dirs = readdirSync(this.projectsDir, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const projectResults = this.query(d.name, { ...opts, limit: 10000 });
        results.push(...projectResults);
      }
    } catch (err) {
      log.error('Failed to query all approval audit entries', { error: err.message });
    }

    results.sort((a, b) => a.eventId - b.eventId);
    return results.slice(-limit);
  }

  getById(projectId, eventId) {
    const buffered = this.buffer.find(e => e.eventId === eventId);
    if (buffered) return buffered;

    if (!this.projectsDir || !projectId) return null;
    const filePath = this._path(projectId);
    if (!existsSync(filePath)) return null;

    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.eventId === eventId) return entry;
        } catch { 
        }
      }
    } catch (err) {
      log.error('Failed to read approval audit entry', { projectId, eventId, error: err.message });
    }

    return null;
  }

  getBufferedEntries() {
    return [...this.buffer];
  }

  clearBuffer() {
    this.buffer = [];
  }

  export(projectId, format = 'json') {
    let entries = this.buffer;
    
    if (projectId && this.projectsDir) {
      const filePath = this._path(projectId);
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8');
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (!entries.find(e => e.eventId === entry.eventId)) {
                entries.push(entry);
              }
            } catch { 
            }
          }
        } catch (err) {
          log.error('Failed to export approval audit', { projectId, error: err.message });
        }
      }
    }

    entries.sort((a, b) => a.eventId - b.eventId);

    const data = {
      timestamp: new Date().toISOString(),
      totalEntries: entries.length,
      projectId,
      entries,
    };

    if (format === 'json') {
      return JSON.stringify(data, null, 2);
    } else if (format === 'csv') {
      const headers = [
        'eventId', 'timestamp', 'operatorId', 'milestoneId', 'campaignId',
        'projectId', 'decision', 'reason', 'approvalRequestedAt', 'approvalApprovedAt',
        'approvalDuration', 'subtaskId', 'traceId', 'dispatchId',
        'source', 'webhookProvider', 'deliveryId', 'signatureValidated', 'signatureError',
      ];
      const rows = entries.map(e =>
        headers.map(h => JSON.stringify(e[h] || '')).join(',')
      );
      return [headers.join(','), ...rows].join('\n');
    }

    return data;
  }

  clear(projectId) {
    if (this.projectsDir && projectId) {
      const filePath = this._path(projectId);
      if (existsSync(filePath)) {
        try {
          rmSync(filePath);
          log.info('Cleared approval audit log', { projectId });
        } catch (err) {
          log.error('Failed to clear approval audit log', { projectId, error: err.message });
        }
      }
    }

    this.buffer = [];
    this._nextEventId = 1;
  }
}

export function createApprovalAuditTrail(config = {}) {
  return new ApprovalAuditTrail(config);
}
