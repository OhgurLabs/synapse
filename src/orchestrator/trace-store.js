import Database from '../persistence/sqlite-provider.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class TraceStore {
  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    
    const dbDir = path.dirname(dbPath);
    if (dbDir !== ':memory:' && !fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode=WAL');
    this.db.pragma('synchronous=NORMAL');
    
    this._initializeSchema();
    this._prepareStatements();
  }
  
  _initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        agent_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        result TEXT,
        metadata TEXT,
        campaign_id TEXT,
        task_id TEXT
      )
    `);
    
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_spans_trace_id ON spans(trace_id);
      CREATE INDEX IF NOT EXISTS idx_spans_parent_span_id ON spans(parent_span_id);
      CREATE INDEX IF NOT EXISTS idx_spans_agent_id ON spans(agent_id);
      CREATE INDEX IF NOT EXISTS idx_spans_campaign_id ON spans(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_spans_started_at ON spans(started_at);
    `);
  }
  
  _prepareStatements() {
    this._createSpanStatement = this.db.prepare(`
      INSERT INTO spans (trace_id, span_id, parent_span_id, agent_id, operation, status, started_at, ended_at, result, metadata, campaign_id, task_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    this._endSpanStatement = this.db.prepare(`
      UPDATE spans
      SET ended_at = ?, status = ?, result = ?
      WHERE span_id = ?
    `);
    
    this._getTraceStatement = this.db.prepare(`
      SELECT id, trace_id, span_id, parent_span_id, agent_id, operation, status, started_at, ended_at, result, metadata, campaign_id, task_id
      FROM spans
      WHERE trace_id = ?
      ORDER BY started_at ASC
    `);
    
    this._getSpanChildrenStatement = this.db.prepare(`
      SELECT id, trace_id, span_id, parent_span_id, agent_id, operation, status, started_at, ended_at, result, metadata, campaign_id, task_id
      FROM spans
      WHERE parent_span_id = ?
      ORDER BY started_at ASC
    `);
    
    this._getSpanStatement = this.db.prepare(`
      SELECT id, trace_id, span_id, parent_span_id, agent_id, operation, status, started_at, ended_at, result, metadata, campaign_id, task_id
      FROM spans
      WHERE span_id = ?
    `);
    
    this._getAllSpansStatement = this.db.prepare(`
      SELECT id, trace_id, span_id, parent_span_id, agent_id, operation, status, started_at, ended_at, result, metadata, campaign_id, task_id
      FROM spans
      ORDER BY started_at ASC
    `);

    this._getRecentSpansStatement = this.db.prepare(`
      SELECT id, trace_id, span_id, parent_span_id, agent_id, operation, status, started_at, ended_at, result, metadata, campaign_id, task_id
      FROM spans
      WHERE started_at >= ?
      ORDER BY started_at DESC
      LIMIT ?
    `);

    this._getRecentSpansNoFilterStatement = this.db.prepare(`
      SELECT id, trace_id, span_id, parent_span_id, agent_id, operation, status, started_at, ended_at, result, metadata, campaign_id, task_id
      FROM spans
      ORDER BY started_at DESC
      LIMIT ?
    `);
  }
  
  startSpan(traceId, parentSpanId, agentId, operation, metadata = {}, campaignId = null, taskId = null) {
    const spanId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    
    this._createSpanStatement.run(
      traceId,
      spanId,
      parentSpanId,
      agentId,
      operation,
      'active',
      startedAt,
      null,
      null,
      JSON.stringify(metadata),
      campaignId,
      taskId
    );
    
    return {
      spanId,
      traceId,
      parentSpanId,
      agentId,
      operation,
      status: 'active',
      startedAt,
      metadata,
      campaignId,
      taskId
    };
  }
  
  endSpan(spanId, status, result = null) {
    const endedAt = new Date().toISOString();
    const resultJson = result !== null ? JSON.stringify(result) : null;
    
    const resultStatement = this._endSpanStatement.run(endedAt, status, resultJson, spanId);
    
    if (resultStatement.changes === 0) {
      throw new Error(`Span not found: ${spanId}`);
    }
    
    const span = this.getSpan(spanId);
    return span;
  }
  
  getTrace(traceId) {
    const rows = this._getTraceStatement.all(traceId);
    
    return rows.map(row => this._rowToSpan(row));
  }
  
  getSpanChildren(spanId) {
    const rows = this._getSpanChildrenStatement.all(spanId);
    
    return rows.map(row => this._rowToSpan(row));
  }
  
  getSpan(spanId) {
    const row = this._getSpanStatement.get(spanId);
    
    if (!row) {
      return null;
    }
    
    return this._rowToSpan(row);
  }
  
  getRecentSpans(limit = 50, sinceISO = null) {
    let rows;
    if (sinceISO) {
      rows = this._getRecentSpansStatement.all(sinceISO, limit);
    } else {
      rows = this._getRecentSpansNoFilterStatement.all(limit);
    }
    return rows.map(row => this._rowToSpan(row));
  }

  getAllSpans() {
    const rows = this._getAllSpansStatement.all();
    
    return rows.map(row => this._rowToSpan(row));
  }
  
  _rowToSpan(row) {
    return {
      id: row.id,
      traceId: row.trace_id,
      spanId: row.span_id,
      parentSpanId: row.parent_span_id,
      agentId: row.agent_id,
      operation: row.operation,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      result: row.result,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      campaignId: row.campaign_id,
      taskId: row.task_id
    };
  }
  
  close() {
    this.db.close();
  }
}

export { TraceStore };
