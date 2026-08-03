import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import Database from '../persistence/sqlite-provider.js';
import { createLogger } from '../logger.js';

const log = createLogger('scheduled-report-store');

function toIsoTimestamp(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return value;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

/**
 * ScheduledReportStore — SQLite persistence layer for scheduled report configurations.
 *
 * Tables:
 *   - schedules: id, cron_expression, format, template, scope, retention_count, next_run, created_at, updated_at
 *   - generated_reports: id, schedule_id, generated_at, file_path, file_size, format, scope, created_at
 */
export class ScheduledReportStore {
  /**
   * @param {Object} options
   * @param {string} options.dbPath
   * @param {string} [options.reportsDir] - Directory for generated reports
   */
  constructor(options = {}) {
    if (!options.dbPath) {
      throw new TypeError('dbPath option is required');
    }

    this.dbPath = options.dbPath;
    this.reportsDir = options.reportsDir || '.synapse/reports';
    this._cleanupTimer = null;

    this._ensureParentDir();
    this._ensureReportsDir();
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this._initTables();
    this._prepareStatements();
  }

  _ensureParentDir() {
    const dir = dirname(this.dbPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  _ensureReportsDir() {
    try {
      mkdirSync(this.reportsDir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  _initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS report_schedules (
        id TEXT PRIMARY KEY,
        cron_expression TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT 'csv',
        template TEXT NOT NULL DEFAULT 'activity_summary',
        scope TEXT,
        retention_count INTEGER NOT NULL DEFAULT 10,
        next_run TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS generated_reports (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        format TEXT NOT NULL,
        scope TEXT,
        FOREIGN KEY (schedule_id) REFERENCES report_schedules(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_report_schedules_next_run ON report_schedules(next_run) WHERE enabled = 1;
      CREATE INDEX IF NOT EXISTS idx_generated_reports_schedule_id ON generated_reports(schedule_id, generated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_generated_reports_id ON generated_reports(id);
    `);
  }

  _prepareStatements() {
    this._stmts = {
      schedule: {
        insert: this.db.prepare(`
          INSERT INTO report_schedules (id, cron_expression, format, template, scope, retention_count, next_run, created_at, updated_at, enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `),
        updateNextRun: this.db.prepare(`
          UPDATE report_schedules SET next_run = ?, updated_at = ? WHERE id = ?
        `),
        deleteById: this.db.prepare('DELETE FROM report_schedules WHERE id = ?'),
        deactivateById: this.db.prepare('UPDATE report_schedules SET enabled = 0 WHERE id = ?'),
        selectAll: this.db.prepare(`
          SELECT id, cron_expression, format, template, scope, retention_count, next_run, created_at, updated_at, enabled
          FROM report_schedules
          ORDER BY created_at ASC
        `),
        selectById: this.db.prepare(`
          SELECT id, cron_expression, format, template, scope, retention_count, next_run, created_at, updated_at, enabled
          FROM report_schedules WHERE id = ?
        `),
        selectDue: this.db.prepare(`
          SELECT id, cron_expression, format, template, scope, retention_count, next_run, created_at, updated_at, enabled
          FROM report_schedules
          WHERE next_run <= ? AND enabled = 1
          ORDER BY next_run ASC
        `),
      },
      generatedReport: {
        insert: this.db.prepare(`
          INSERT INTO generated_reports (id, schedule_id, generated_at, file_path, file_size, format, scope)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `),
        selectByScheduleId: this.db.prepare(`
          SELECT id, schedule_id, generated_at, file_path, file_size, format, scope
          FROM generated_reports
          WHERE schedule_id = ?
          ORDER BY generated_at DESC
          LIMIT ? OFFSET ?
        `),
        deleteByScheduleId: this.db.prepare('DELETE FROM generated_reports WHERE schedule_id = ?'),
        deleteById: this.db.prepare('DELETE FROM generated_reports WHERE id = ?'),
        selectById: this.db.prepare(`
          SELECT id, schedule_id, generated_at, file_path, file_size, format, scope
          FROM generated_reports WHERE id = ?
        `),
        cleanupOld: this.db.prepare(`
          DELETE FROM generated_reports
          WHERE schedule_id = ?
            AND id IN (
              SELECT id FROM generated_reports
              WHERE schedule_id = ?
              ORDER BY generated_at DESC
              LIMIT -1 OFFSET ?
            )
        `),
        countByScheduleId: this.db.prepare(`
          SELECT COUNT(*) as count FROM generated_reports WHERE schedule_id = ?
        `),
      },
    };
  }

  /**
   * Create a new report schedule
   * @param {Object} params
   * @param {string} params.cronExpression - Cron expression (e.g., '0 0 * * *' for daily at midnight)
   * @param {string} [params.format='json'] - Output format: 'json', 'csv', 'pdf'
   * @param {string} [params.template='activity_summary'] - Report template name
   * @param {Object} [params.scope={}] - Scope parameters (campaignId, date range, etc.)
   * @param {number} [params.retention_count=10] - Number of reports to keep
   * @returns {Object} Created schedule object
   */
  createSchedule({ cronExpression, format = 'json', template = 'activity_summary', scope = {}, retention_count = 10 }) {
    if (!cronExpression || typeof cronExpression !== 'string') {
      throw new TypeError('cronExpression is required and must be a string');
    }

    const id = 'sch_' + randomUUID().replace(/-/g, '');
    const now = toIsoTimestamp();
    const nextRun = this._calculateNextRun(cronExpression, now);

    const scopeStr = typeof scope === 'string' ? scope : JSON.stringify(scope);

    this._stmts.schedule.insert.run(id, cronExpression, format, template, scopeStr, retention_count, nextRun, now, now);

    return this.getSchedule(id);
  }

  /**
   * Get a schedule by ID
   * @param {string} id
   * @returns {Object|null}
   */
  getSchedule(id) {
    const row = this._stmts.schedule.selectById.get(id);
    if (!row) return null;
    return this._expandSchedule(row);
  }

  /**
   * List all schedules
   * @returns {Object[]}
   */
  listSchedules() {
    const rows = this._stmts.schedule.selectAll.all();
    return rows.map(this._expandSchedule.bind(this));
  }

  /**
   * Delete a schedule by ID
   * @param {string} id
   * @returns {boolean}
   */
  deleteSchedule(id) {
    const result = this._stmts.schedule.deleteById.run(id);
    return result.changes > 0;
  }

  /**
   * Get schedules that are due for execution
   * @param {number} nowTs - Current timestamp in milliseconds
   * @returns {Object[]}
   */
  getNextDueSchedules(nowTs) {
    const nowIso = new Date(nowTs).toISOString();
    const rows = this._stmts.schedule.selectDue.all(nowIso);
    return rows.map(this._expandSchedule.bind(this));
  }

  /**
   * Record a generated report
   * @param {string} scheduleId
   * @param {string} filePath
   * @param {Object} metadata
   * @param {number} [metadata.fileSize=0]
   * @param {string} [metadata.format]
   * @param {Object} [metadata.scope]
   */
  recordGeneratedReport(scheduleId, filePath, metadata = {}) {
    if (!this.getSchedule(scheduleId)) {
      throw new Error(`Schedule ${scheduleId} not found`);
    }

    const id = 'rpt_' + randomUUID().replace(/-/g, '');
    const now = toIsoTimestamp();
    const fileSize = metadata.fileSize || 0;
    const format = metadata.format || 'json';
    const scopeStr = typeof metadata.scope === 'string' ? metadata.scope : JSON.stringify(metadata.scope || {});

    this._stmts.generatedReport.insert.run(id, scheduleId, now, filePath, fileSize, format, scopeStr);

    // Cleanup old reports if retention count is set
    const schedule = this.getSchedule(scheduleId);
    if (schedule && schedule.retention_count > 0) {
      this.cleanupOldReports(scheduleId, schedule.retention_count);
    }

    return this.getReport(id);
  }

  /**
   * Get a generated report by ID
   * @param {string} id
   * @returns {Object|null}
   */
  getReport(id) {
    const row = this._stmts.generatedReport.selectById.get(id);
    if (!row) return null;
    return {
      ...row,
      scope: this._parseScope(row.scope),
    };
  }

  /**
   * List reports for a schedule
   * @param {string} scheduleId
   * @param {number} [limit=50]
   * @param {number} [offset=0]
   * @returns {Object[]}
   */
  listReports(scheduleId, limit = 50, offset = 0) {
    const rows = this._stmts.generatedReport.selectByScheduleId.all(scheduleId, limit, offset);
    return rows.map(row => ({
      ...row,
      scope: this._parseScope(row.scope),
    }));
  }

  /**
   * Get all reports across all schedules
   * @param {number} [limit=100]
   * @param {number} [offset=0]
   * @returns {Object[]}
   */
  listAllReports(limit = 100, offset = 0) {
    const stmt = this.db.prepare(`
      SELECT gr.id, gr.schedule_id, gr.generated_at, gr.file_path, gr.file_size, gr.format, gr.scope, gr.created_at,
             s.cron_expression, s.template
      FROM generated_reports gr
      JOIN report_schedules s ON gr.schedule_id = s.id
      ORDER BY gr.generated_at DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(limit, offset);
    return rows.map(row => ({
      ...row,
      scope: this._parseScope(row.scope),
    }));
  }

  /**
   * Cleanup old reports beyond retention count
   * @param {string} scheduleId
   * @param {number} retentionCount
   * @returns {number} Number of reports deleted
   */
  cleanupOldReports(scheduleId, retentionCount) {
    const countResult = this._stmts.generatedReport.countByScheduleId.get(scheduleId);
    const currentCount = countResult.count;

    if (currentCount <= retentionCount) {
      return 0;
    }

    const toDelete = currentCount - retentionCount;
    // OFFSET should skip the newest N reports we want to keep, not skip toDelete reports
    this._stmts.generatedReport.cleanupOld.run(scheduleId, scheduleId, retentionCount);
    return toDelete;
  }

  /**
   * Calculate next run time from cron expression
   * @private
   */
  _calculateNextRun(cronExpression, fromIso) {
    const from = new Date(fromIso);
    const [minute, hour, dayOfMonth, month, dayOfWeek] = cronExpression.split(' ').slice(0, 5);

    let next = new Date(from);
    next.setMilliseconds(0);
    next.setMicroseconds ? next.setMicroseconds(0) : null;

    // Simple cron parser for common patterns
    // Supports: *, N, N-M, */N patterns
    const parseCronField = (field, min, max, currentValue) => {
      if (field === '*') return null;
      if (field.includes('/')) {
        const [start, step] = field.split('/').map(Number);
        let result = currentValue;
        while (result <= max && result < start + Math.floor((max - start) / step) * step) {
          result += Number(step);
        }
        return result > max ? null : result;
      }
      if (field.includes('-')) {
        const [start, end] = field.split('-').map(Number);
        return currentValue >= start && currentValue <= end ? currentValue : null;
      }
      const val = Number(field);
      return val >= min && val <= max ? val : null;
    };

    // Try to find next valid time
    const maxIterations = 366 * 24 * 60; // Max one year of minutes
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      const currentMinute = next.getMinutes();
      const currentHour = next.getHours();
      const currentDay = next.getDate();
      const currentMonth = next.getMonth() + 1;
      const currentDayOfWeek = next.getDay();

      // Check if current time matches all fields
      const minuteMatch = parseCronField(minute, 0, 59, currentMinute);
      const hourMatch = parseCronField(hour, 0, 23, currentHour);
      const dayMatch = parseCronField(dayOfMonth, 1, 31, currentDay);
      const monthMatch = parseCronField(month, 1, 12, currentMonth);
      const dayOfWeekMatch = parseCronField(dayOfWeek, 0, 6, currentDayOfWeek);

      if (minuteMatch !== null && hourMatch !== null && dayMatch !== null && monthMatch !== null && dayOfWeekMatch !== null) {
        return next.toISOString();
      }

      // Advance to next minute
      next.setMinutes(next.getMinutes() + 1);
      if (next.getMinutes() === 0) {
        next.setHours(next.getHours() + 1);
      }
      if (next.getHours() === 24) {
        next.setHours(0);
        next.setDate(next.getDate() + 1);
      }
    }

    // Fallback: return 1 hour from now if no match found
    return new Date(from.getTime() + 60 * 60 * 1000).toISOString();
  }

  /**
   * Expand schedule row with parsed scope
   * @private
   */
  _expandSchedule(row) {
    return {
      ...row,
      scope: this._parseScope(row.scope),
    };
  }

  /**
   * Parse scope JSON string
   * @private
   */
  _parseScope(scopeStr) {
    if (!scopeStr || scopeStr === '{}') return {};
    try {
      return JSON.parse(scopeStr);
    } catch {
      return { _raw: scopeStr };
    }
  }

  /**
   * Close the database connection
   */
  close() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
