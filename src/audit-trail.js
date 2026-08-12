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
import { assertSafeProjectId } from './safe-id.js';

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
    this._eventIdInitialized = new Set(); // projectIds whose sequence we resumed from disk

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
    assertSafeProjectId(projectId);
    return join(this.projectsDir, projectId, 'approval-audit.jsonl');
  }

  _initEventId(projectId) {
    if (!this.projectsDir || !projectId) return;
    const filePath = this._path(projectId);
    if (!existsSync(filePath)) return;

    try {
      const content = readFileSync(filePath, 'utf-8');

      // Resume from the MAXIMUM id in the file, not the last entry.
      //
      // Reading only the last entry is correct for a monotonic file, but every
      // file written before this counter was wired up contains DUPLICATES
      // (1,2,1,2,1 — each restart began again at 1). On such a file the last
      // entry is 1, so a "resume" would issue 2 and collide with the 2 already
      // present, and export() would keep silently dropping records. Verified
      // against a synthetic legacy file before this change.
      //
      // Scanned with a regex rather than JSON.parse per line: the content is
      // already in memory, and this avoids parsing tens of thousands of
      // records to read one integer. If the pattern ever matches an eventId
      // nested inside a payload the result is an OVER-estimate, which only
      // makes ids sparse — safe. Under-estimating is the dangerous direction,
      // and this cannot do that.
      let max = 0;
      const re = /"eventId"\s*:\s*(\d+)/g;
      let m;
      while ((m = re.exec(content)) !== null) {
        const id = Number(m[1]);
        if (Number.isFinite(id) && id > max) max = id;
      }
      if (max >= this._nextEventId) this._nextEventId = max + 1;
    } catch (err) {
      log.warn('Failed to read approval audit file for counter init', { projectId, error: err.message });
    }
  }

  /**
   * Allocate the next event id, resuming a project's sequence from disk the
   * first time we touch that project.
   *
   * _initEventId() existed but was NEVER CALLED, so _nextEventId always began
   * at 1 for a fresh instance. Every orchestrator restart therefore re-issued
   * ids 1,2,3... against a file that already contained them, and since
   * export() de-duplicates by eventId, the duplicates were SILENTLY DROPPED --
   * an audit trail quietly losing records. Observed 2026-08-05: five logged
   * approvals across three instances wrote ids 1,2,1,2,1 and exported as 2.
   *
   * The counter is per-instance but only ever moves forward across projects,
   * so ids stay unique within every project's file (sparse, which is fine --
   * nothing treats them as contiguous; export() only sorts by them).
   */
  _nextId(projectId) {
    if (projectId && !this._eventIdInitialized.has(projectId)) {
      this._initEventId(projectId);
      this._eventIdInitialized.add(projectId);
    }
    return this._nextEventId++;
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
    entry.eventId = this._nextId(entry.projectId);

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
    entry.eventId = this._nextId(entry.projectId);

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
    entry.eventId = this._nextId(entry.projectId);

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
    entry.eventId = this._nextId(entry.projectId);

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
    entry.eventId = this._nextId(entry.projectId);

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
    // COPY the buffer. This used to alias it (`= this.buffer`) and then push
    // every on-disk entry into the live buffer, so one export permanently
    // loaded the whole audit file into memory -- bypassing maxBuffer, since
    // the pushes went around _addToBuffer(). Reachable from chat now that
    // `/audit export` exists, on a file that only ever grows.
    // The sibling query methods are unaffected: .filter() already copies.
    let entries = [...this.buffer];

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

    // Any format other than 'json' or 'csv' returns the structured object
    // unserialised. Pass 'object' when you only need counts or want to shape
    // the output yourself: serialising to JSON and parsing it back to read one
    // integer costs several multiples of the file size in transient memory,
    // and this file only grows. `/audit export` relies on this.
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
    // Forget the resumed sequences too: the file this project's counter was
    // derived from may have just been deleted, so the next write must re-read
    // rather than trust a stale high-water mark.
    this._eventIdInitialized.clear();
  }
}

export function createApprovalAuditTrail(config = {}) {
  return new ApprovalAuditTrail(config);
}
