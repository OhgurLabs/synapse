import Database from '../persistence/sqlite-provider.js';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { createLogger } from '../logger.js';
import { randomUUID } from 'crypto';

const log = createLogger('export-job-queue');
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * ExportJobQueue - Manages background export jobs
 *
 * Tracks export jobs in SQLite with states: pending, processing, completed, failed
 * Provides job status lookup and cleanup of old completed jobs.
 */
export class ExportJobQueue {
  /**
   * @param {Object} options
   * @param {string} [options.dbPath] - Path to SQLite database
   * @param {string} [options.outputDir] - Directory for export files
   * @param {number} [options.retentionHours=24] - Hours to retain completed jobs
   */
  constructor(options = {}) {
    this.dbPath = options.dbPath || join(__dirname, '../../.synapse/export-jobs.sqlite');
    this.outputDir = options.outputDir || join(__dirname, '../../.synapse/exports');
    this.retentionHours = options.retentionHours || 24;

    // Ensure output directory exists
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }

    // Initialize database
    const dbDir = dirname(this.dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this._initSchema();
    this._failOrphanedJobs();

    log.info('ExportJobQueue initialized', {
      dbPath: this.dbPath,
      outputDir: this.outputDir,
      retentionHours: this.retentionHours,
    });
  }

  /**
   * Fail export jobs stranded by a process restart (#107 C3 finding).
   * Exports are processed by a setImmediate closure in the CREATING process
   * — a crash/restart between createJob and completion strands the job in
   * pending/processing with nothing to ever advance it, and cleanupOldJobs
   * only touches terminal states, so clients would poll "processing"
   * forever. At construction time the process is fresh, so any
   * pending/processing row is by definition orphaned: fail it loudly so
   * pollers get a terminal answer and retention can reclaim it.
   * @private
   */
  _failOrphanedJobs() {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE export_jobs
      SET status = 'failed', error = 'orphaned by process restart', completed_at = ?
      WHERE status IN ('pending', 'processing')
    `).run(now);
    if (result.changes > 0) {
      log.warn('Failed orphaned export jobs from a previous process', { count: result.changes });
    }
  }

  /**
   * Initialize database schema
   * @private
   */
  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS export_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        format TEXT NOT NULL,
        template TEXT,
        filters TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        file_path TEXT,
        error TEXT,
        progress INTEGER DEFAULT 0,
        total INTEGER DEFAULT 0,
        created_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_export_jobs_status ON export_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_export_jobs_created_at ON export_jobs(created_at);
    `);
  }

  /**
   * Create a new export job
   * @param {Object} params
   * @param {string} params.format - Export format (csv, json, pdf)
   * @param {string} [params.template] - PDF template name
   * @param {Object} params.filters - Export filters
   * @param {string} [params.createdBy] - User ID
   * @returns {Object} Job record
   */
  createJob(params) {
    const { format, template, filters, createdBy } = params;

    const jobId = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO export_jobs (id, status, format, template, filters, created_at, created_by, progress, total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      jobId,
      'pending',
      format,
      template || null,
      JSON.stringify(filters),
      now,
      createdBy || 'system',
      0,
      0
    );

    log.info('Export job created', { jobId, format, template });

    return {
      id: jobId,
      status: 'pending',
      format,
      template,
      filters,
      created_at: now,
      created_by: createdBy || 'system',
      progress: 0,
      total: 0,
    };
  }

  /**
   * Update job status
   * @param {string} jobId
   * @param {string} status - 'pending', 'processing', 'completed', 'failed'
   * @param {Object} [updates] - Additional fields to update
   */
  updateJobStatus(jobId, status, updates = {}) {
    const now = new Date().toISOString();
    const fields = [];
    const values = [];

    fields.push('status = ?');
    values.push(status);

    if (status === 'processing' && !updates.started_at) {
      fields.push('started_at = ?');
      values.push(now);
    }

    if (status === 'completed' || status === 'failed') {
      fields.push('completed_at = ?');
      values.push(now);
    }

    if (updates.file_path) {
      fields.push('file_path = ?');
      values.push(updates.file_path);
    }

    if (updates.error) {
      fields.push('error = ?');
      values.push(updates.error);
    }

    if (updates.progress !== undefined) {
      fields.push('progress = ?');
      values.push(updates.progress);
    }

    if (updates.total !== undefined) {
      fields.push('total = ?');
      values.push(updates.total);
    }

    values.push(jobId);

    const stmt = this.db.prepare(`
      UPDATE export_jobs
      SET ${fields.join(', ')}
      WHERE id = ?
    `);

    stmt.run(...values);

    log.debug('Export job updated', { jobId, status, updates });
  }

  /**
   * Get job status
   * @param {string} jobId
   * @returns {Object|null} Job record or null if not found
   */
  getJobStatus(jobId) {
    const stmt = this.db.prepare(`
      SELECT * FROM export_jobs WHERE id = ?
    `);

    const row = stmt.get(jobId);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      status: row.status,
      format: row.format,
      template: row.template,
      filters: JSON.parse(row.filters),
      created_at: row.created_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      file_path: row.file_path,
      error: row.error,
      progress: row.progress,
      total: row.total,
      created_by: row.created_by,
    };
  }

  /**
   * List all jobs
   * @param {Object} [options]
   * @param {string} [options.status] - Filter by status
   * @param {number} [options.limit=100] - Max results
   * @returns {Object[]} Job records
   */
  listJobs(options = {}) {
    const { status, limit = 100 } = options;

    let sql = 'SELECT * FROM export_jobs';
    const params = [];

    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);

    return rows.map(row => ({
      id: row.id,
      status: row.status,
      format: row.format,
      template: row.template,
      filters: JSON.parse(row.filters),
      created_at: row.created_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      file_path: row.file_path,
      error: row.error,
      progress: row.progress,
      total: row.total,
      created_by: row.created_by,
    }));
  }

  /**
   * Cleanup completed jobs older than retention period
   * @returns {number} Number of jobs cleaned up
   */
  cleanupOldJobs() {
    const cutoffDate = new Date(Date.now() - this.retentionHours * 60 * 60 * 1000).toISOString();

    // Get jobs to delete
    const stmt = this.db.prepare(`
      SELECT id, file_path FROM export_jobs
      WHERE (status = 'completed' OR status = 'failed')
        AND completed_at < ?
    `);

    const jobs = stmt.all(cutoffDate);

    // Delete files
    for (const job of jobs) {
      if (job.file_path && existsSync(job.file_path)) {
        try {
          unlinkSync(job.file_path);
          log.debug('Deleted export file', { jobId: job.id, filePath: job.file_path });
        } catch (err) {
          log.warn('Failed to delete export file', {
            jobId: job.id,
            filePath: job.file_path,
            error: err.message,
          });
        }
      }
    }

    // Delete database records
    const deleteStmt = this.db.prepare(`
      DELETE FROM export_jobs
      WHERE (status = 'completed' OR status = 'failed')
        AND completed_at < ?
    `);

    const result = deleteStmt.run(cutoffDate);

    log.info('Cleaned up old export jobs', {
      count: result.changes,
      cutoffDate,
    });

    return result.changes;
  }

  /**
   * Generate file path for export
   * @param {string} jobId
   * @param {string} format
   * @returns {string} File path
   */
  getFilePath(jobId, format) {
    const ext = format === 'csv' ? 'csv' : format === 'pdf' ? 'pdf' : 'json';
    return join(this.outputDir, `export-${jobId}.${ext}`);
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      log.info('ExportJobQueue closed');
    }
  }
}

/**
 * Create an ExportJobQueue instance
 * @param {Object} options
 * @returns {ExportJobQueue}
 */
export function createExportJobQueue(options) {
  return new ExportJobQueue(options);
}

export default ExportJobQueue;
