import { existsSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import Database from '../persistence/sqlite-provider.js';
import { createLogger } from '../logger.js';

const log = createLogger('state-db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  type TEXT DEFAULT 'standard',
  done_criteria TEXT DEFAULT '',
  branch TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  last_review_at TEXT,
  last_review_summary TEXT,
  next_action TEXT,
  contingency TEXT,
  metadata TEXT DEFAULT '{}',
  PRIMARY KEY (id, project_id)
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  done_criteria TEXT DEFAULT '',
  blocked_by TEXT,
  contingency TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  task_ids TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  PRIMARY KEY (id, campaign_id),
  FOREIGN KEY (campaign_id, project_id) REFERENCES campaigns(id, project_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  campaign_id TEXT,
  milestone_id TEXT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  type TEXT DEFAULT 'task',
  category TEXT,
  task_category TEXT,
  channel TEXT DEFAULT 'general',
  thread_id TEXT,
  done_criteria TEXT DEFAULT '',
  owner TEXT,
  plan TEXT,
  context TEXT,
  delegation_context TEXT,
  git_baseline TEXT,
  review_cycle INTEGER DEFAULT 0,
  max_review_cycles INTEGER DEFAULT 3,
  review_findings TEXT,
  review_feedback_history TEXT DEFAULT '[]',
  review_iterations TEXT DEFAULT '[]',
  rework_in_progress INTEGER DEFAULT 0,
  rollback_reason TEXT,
  shared_with TEXT DEFAULT '[]',
  touched_files TEXT DEFAULT '[]',
  dependencies TEXT DEFAULT '[]',
  deliberation TEXT,
  trace_context TEXT,
  validation_report TEXT,
  trust_score TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  last_reviewer_id TEXT,
  metadata TEXT DEFAULT '{}',
  PRIMARY KEY (id, project_id)
);

CREATE TABLE IF NOT EXISTS task_state_versions (
  project_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS campaign_state_versions (
  project_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  assignee TEXT,
  complexity TEXT DEFAULT 'medium',
  role TEXT,
  suggested_role TEXT,
  result TEXT,
  error TEXT,
  meta TEXT DEFAULT '{}',
  retry_count INTEGER DEFAULT 0,
  retry_attempts INTEGER DEFAULT 0,
  backoff_ms INTEGER,
  last_retry_at TEXT,
  next_retry_at TEXT,
  claimed_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (task_id, id),
  FOREIGN KEY (task_id, project_id) REFERENCES tasks(id, project_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'general',
  speaker TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  type TEXT DEFAULT 'message',
  source TEXT DEFAULT 'websocket',
  reply_to TEXT,
  thread_id TEXT,
  meta TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_campaigns_project ON campaigns(project_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_campaign ON tasks(campaign_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_assignee ON subtasks(assignee);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(project_id, channel);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`;

const dbs = new Map();

export function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.pragma(`table_info(${tableName})`);
  if (columns.some(column => column.name === columnName)) return false;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  return true;
}

function getDb(projectDir) {
  if (dbs.has(projectDir)) return dbs.get(projectDir);
  const dbPath = join(projectDir, 'state.sqlite');
  if (!existsSync(dirname(dbPath))) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  // Corrupt-DB fail-loud guard. A healthy persisted state.sqlite is NEVER
  // 0 bytes once opened (SQLite writes its header immediately), so an
  // existing 0-byte file is unambiguously corruption — exactly the Iter4
  // self-destruct, where the zeroed DB silently became a valid EMPTY db via
  // CREATE TABLE IF NOT EXISTS and the orchestrator thrashed for 7 hours on
  // lost state. Refuse to start instead of silently reinitializing.
  if (existsSync(dbPath)) {
    let sizeBytes = -1;
    try { sizeBytes = statSync(dbPath).size; } catch { /* fall through */ }
    if (sizeBytes === 0) {
      log.error(
        'FATAL: state.sqlite exists but is 0 bytes — database was truncated/corrupted. ' +
        'Refusing to start to avoid silently discarding campaign/task state.',
        { path: dbPath },
      );
      process.exit(1);
    }
  }

  // Open + integrity-check together. A non-zero garbage / partially
  // truncated file makes better-sqlite3 throw "file is not a database" at
  // construction time, so the constructor must be inside the same guard.
  // integrity_check returns a single "ok" row on a healthy database.
  let db;
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const rows = db.pragma('integrity_check');
    const ok = Array.isArray(rows) && rows.length === 1 && rows[0]?.integrity_check === 'ok';
    if (!ok) {
      log.error(
        'FATAL: state.sqlite failed integrity_check — database is corrupt. ' +
        'Refusing to start. Restore .synapse/ from a backup or postmortem.',
        { path: dbPath, result: JSON.stringify(rows).slice(0, 300) },
      );
      process.exit(1);
    }
  } catch (err) {
    log.error(
      'FATAL: state.sqlite is unreadable as a SQLite database — refusing to start ' +
      'rather than silently discarding state. Restore .synapse/ from a backup or postmortem.',
      { path: dbPath, error: err.message },
    );
    process.exit(1);
  }

  db.exec(SCHEMA);
  ensureColumn(db, 'milestones', 'metadata', "TEXT DEFAULT '{}'");
  ensureColumn(db, 'tasks', 'metadata', "TEXT DEFAULT '{}'");
  dbs.set(projectDir, db);
  log.info('State database opened', { path: dbPath });
  return db;
}

export function campaignToRow(c, projectId) {
  const metadata = {};
  const knownFields = new Set([
    'id', 'title', 'description', 'status', 'type', 'doneCriteria', 'branch',
    'createdAt', 'updatedAt', 'completedAt', 'lastReviewAt', 'lastReviewSummary',
    'nextAction', 'contingency', 'milestones',
  ]);
  for (const [key, value] of Object.entries(c)) {
    if (!knownFields.has(key) && value !== undefined && value !== null && value !== '' &&
        !(Array.isArray(value) && value.length === 0) &&
        !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)) {
      metadata[key] = value;
    }
  }
  return {
    id: c.id,
    project_id: projectId,
    title: c.title || '',
    description: c.description || '',
    status: c.status || 'queued',
    type: c.type || 'standard',
    done_criteria: typeof c.doneCriteria === 'string' ? c.doneCriteria : JSON.stringify(c.doneCriteria || ''),
    branch: c.branch || null,
    created_at: c.createdAt || new Date().toISOString(),
    updated_at: c.updatedAt || new Date().toISOString(),
    completed_at: c.completedAt || null,
    last_review_at: c.lastReviewAt || null,
    last_review_summary: c.lastReviewSummary || null,
    next_action: c.nextAction || null,
    contingency: typeof c.contingency === 'string' ? c.contingency : (c.contingency ? JSON.stringify(c.contingency) : null),
    metadata: JSON.stringify(metadata),
  };
}

export function rowToCampaign(row) {
  const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
  const parseFlexible = (v) => {
    if (typeof v !== 'string') return v;
    try { const p = JSON.parse(v); return (typeof p === 'object' && p !== null) ? p : v; }
    catch { return v; }
  };
  if (!meta.projectIds) meta.projectIds = [row.project_id];
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    type: row.type,
    doneCriteria: parseFlexible(row.done_criteria),
    branch: row.branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    lastReviewAt: row.last_review_at,
    lastReviewSummary: row.last_review_summary,
    nextAction: row.next_action,
    contingency: parseFlexible(row.contingency),
    milestones: [],
    ...meta,
  };
}

export function milestoneToRow(m, campaignId, projectId) {
  const knownFields = new Set([
    'id', 'title', 'description', 'doneCriteria', 'status', 'blockedBy',
    'contingency', 'order', 'createdAt', 'updatedAt', 'completedAt', 'tasks',
  ]);
  const metadata = {};
  for (const [key, value] of Object.entries(m)) {
    if (!knownFields.has(key) && value !== undefined && value !== null) {
      metadata[key] = value;
    }
  }
  return {
    id: m.id,
    campaign_id: campaignId,
    project_id: projectId,
    title: m.title || '',
    description: m.description || '',
    status: m.status || 'pending',
    done_criteria: m.doneCriteria || '',
    blocked_by: typeof m.blockedBy === 'string' ? m.blockedBy : JSON.stringify(m.blockedBy || []),
    contingency: m.contingency || null,
    sort_order: m.order ?? 0,
    created_at: m.createdAt || new Date().toISOString(),
    updated_at: m.updatedAt || new Date().toISOString(),
    completed_at: m.completedAt || null,
    task_ids: JSON.stringify(m.tasks || []),
    metadata: JSON.stringify(metadata),
  };
}

export function rowToMilestone(row) {
  const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
  let blockedBy = [];
  if (row.blocked_by) {
    try { const p = JSON.parse(row.blocked_by); blockedBy = Array.isArray(p) ? p : [row.blocked_by]; }
    catch { blockedBy = [row.blocked_by]; }
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    doneCriteria: row.done_criteria,
    blockedBy,
    contingency: row.contingency,
    order: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    tasks: typeof row.task_ids === 'string' ? JSON.parse(row.task_ids) : (row.task_ids || []),
    ...meta,
  };
}

export function taskToRow(t, projectId) {
  const knownFields = new Set([
    'id', 'title', 'description', 'status', 'type', 'campaignId', 'milestoneId',
    'category', 'taskCategory', 'channel', 'threadId', 'doneCriteria', 'owner',
    'plan', 'context', 'delegationContext', 'gitBaseline', 'reviewCycle',
    'maxReviewCycles', 'reviewFindings', 'reviewFeedbackHistory', 'reviewIterations',
    'reworkInProgress', 'rollbackReason', 'sharedWith', 'touchedFiles', 'dependencies',
    'deliberation', 'traceContext', 'validationReport', 'trustScore',
    'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'lastReviewerId',
    'subtasks', 'project',
  ]);
  const metadata = {};
  for (const [key, value] of Object.entries(t)) {
    if (!knownFields.has(key) && value !== undefined && value !== null && value !== '' &&
        !(Array.isArray(value) && value.length === 0) &&
        !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)) {
      metadata[key] = value;
    }
  }
  return {
    id: t.id,
    project_id: projectId,
    campaign_id: t.campaignId || null,
    milestone_id: t.milestoneId || null,
    title: t.title || '',
    description: t.description || '',
    status: t.status || 'queued',
    type: t.type || 'task',
    category: t.category || null,
    task_category: t.taskCategory || null,
    channel: t.channel || 'general',
    thread_id: t.threadId || null,
    done_criteria: t.doneCriteria || '',
    owner: t.owner || null,
    plan: typeof t.plan === 'string' ? t.plan : JSON.stringify(t.plan || null),
    context: typeof t.context === 'string' ? t.context : JSON.stringify(t.context || null),
    delegation_context: typeof t.delegationContext === 'string' ? t.delegationContext : JSON.stringify(t.delegationContext || null),
    git_baseline: typeof t.gitBaseline === 'string' ? t.gitBaseline : JSON.stringify(t.gitBaseline || null),
    review_cycle: t.reviewCycle || 0,
    max_review_cycles: t.maxReviewCycles || 3,
    review_findings: typeof t.reviewFindings === 'string' ? t.reviewFindings : JSON.stringify(t.reviewFindings || null),
    review_feedback_history: JSON.stringify(t.reviewFeedbackHistory || []),
    review_iterations: JSON.stringify(t.reviewIterations || []),
    rework_in_progress: t.reworkInProgress ? 1 : 0,
    rollback_reason: t.rollbackReason || null,
    shared_with: JSON.stringify(t.sharedWith || []),
    touched_files: JSON.stringify(t.touchedFiles || []),
    dependencies: JSON.stringify(t.dependencies || []),
    deliberation: typeof t.deliberation === 'string' ? t.deliberation : JSON.stringify(t.deliberation || null),
    trace_context: JSON.stringify(t.traceContext || null),
    validation_report: JSON.stringify(t.validationReport || null),
    trust_score: JSON.stringify(t.trustScore || null),
    created_at: t.createdAt || new Date().toISOString(),
    updated_at: t.updatedAt || new Date().toISOString(),
    started_at: t.startedAt || null,
    completed_at: t.completedAt || null,
    last_reviewer_id: t.lastReviewerId || null,
    metadata: JSON.stringify(metadata),
  };
}

export function rowToTask(row) {
  const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return v; } };
  // Guarded parse: one corrupt metadata row must not throw — an exception here
  // makes load() fail for the whole project, and a subsequent save would wipe it.
  let meta;
  try { meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}); }
  catch { meta = {}; }
  return {
    id: row.id,
    project: row.project_id,
    campaignId: row.campaign_id,
    milestoneId: row.milestone_id,
    title: row.title,
    description: row.description,
    status: row.status,
    type: row.type,
    category: row.category,
    taskCategory: row.task_category,
    channel: row.channel,
    threadId: row.thread_id,
    doneCriteria: row.done_criteria,
    owner: row.owner,
    plan: parse(row.plan),
    context: parse(row.context),
    delegationContext: parse(row.delegation_context),
    gitBaseline: parse(row.git_baseline),
    reviewCycle: row.review_cycle,
    maxReviewCycles: row.max_review_cycles,
    reviewFindings: parse(row.review_findings),
    reviewFeedbackHistory: parse(row.review_feedback_history) || [],
    reviewIterations: parse(row.review_iterations) || [],
    reworkInProgress: !!row.rework_in_progress,
    rollbackReason: row.rollback_reason,
    sharedWith: parse(row.shared_with) || [],
    touchedFiles: parse(row.touched_files) || [],
    dependencies: parse(row.dependencies) || [],
    deliberation: parse(row.deliberation),
    traceContext: parse(row.trace_context),
    validationReport: parse(row.validation_report),
    trustScore: parse(row.trust_score),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastReviewerId: row.last_reviewer_id,
    subtasks: [],
    ...meta,
  };
}

export function subtaskToRow(s, taskId, projectId) {
  const knownFields = new Set([
    'id', 'text', 'status', 'assignee', 'complexity', 'role', 'suggestedRole',
    'result', 'error', 'meta', 'retryCount', 'retryAttempts', 'backoffMs',
    'lastRetryAt', 'nextRetryAt', 'claimedUntil', 'createdAt', 'updatedAt',
    'startedAt', 'completedAt',
  ]);
  // Spilled top-level fields (claimedAt, verdict, failedProviders, …) share
  // the meta column with genuine meta content (reviewFinding, lastDispatch).
  // They are namespaced under _spill so the read side can tell them apart —
  // the previous flat merge made rowToSubtask strip every non-column key out
  // of meta on read, silently destroying meta.reviewFinding on round-trip.
  const extra = {};
  for (const [key, value] of Object.entries(s)) {
    if (!knownFields.has(key) && value !== undefined && value !== null && value !== '' &&
        !(Array.isArray(value) && value.length === 0)) {
      extra[key] = value;
    }
  }
  const metaObj = { ...(s.meta || {}) };
  delete metaObj._spill;
  // A key present in both places is a legacy-read duplicate (the old flat
  // merge restored meta content to the top level). Identical values → it is
  // genuine meta content, keep it there and drop the spill copy; divergent
  // values → the top-level one was mutated in place (claimedAt etc.), it wins.
  for (const k of Object.keys(extra)) {
    if (k in metaObj && JSON.stringify(metaObj[k]) === JSON.stringify(extra[k])) {
      delete extra[k];
    } else {
      delete metaObj[k];
    }
  }
  if (Object.keys(extra).length) metaObj._spill = extra;
  return {
    id: s.id,
    task_id: taskId,
    project_id: projectId,
    text: s.text || '',
    status: s.status || 'queued',
    assignee: s.assignee || null,
    complexity: s.complexity || 'medium',
    role: s.role || null,
    suggested_role: s.suggestedRole || null,
    result: typeof s.result === 'string' ? s.result : (s.result ? JSON.stringify(s.result) : null),
    error: typeof s.error === 'string' ? s.error : (s.error ? JSON.stringify(s.error) : null),
    meta: JSON.stringify(metaObj),
    retry_count: s.retryCount || 0,
    retry_attempts: s.retryAttempts || 0,
    backoff_ms: s.backoffMs || null,
    last_retry_at: s.lastRetryAt || null,
    next_retry_at: s.nextRetryAt || null,
    claimed_until: s.claimedUntil || null,
    created_at: s.createdAt || new Date().toISOString(),
    updated_at: s.updatedAt || new Date().toISOString(),
    started_at: s.startedAt || null,
    completed_at: s.completedAt || null,
  };
}

export function rowToSubtask(row) {
  let meta;
  try { meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : (row.meta || {}); }
  catch { meta = {}; }
  const parseFlexible = (v) => {
    if (typeof v !== 'string') return v;
    try { const p = JSON.parse(v); return typeof p === 'object' && p !== null ? p : v; }
    catch { return v; }
  };
  const knownFields = new Set([
    'id', 'text', 'status', 'assignee', 'complexity', 'role', 'suggestedRole',
    'result', 'error', 'retryCount', 'retryAttempts', 'backoffMs',
    'lastRetryAt', 'nextRetryAt', 'claimedUntil', 'createdAt', 'updatedAt',
    'startedAt', 'completedAt', 'meta',
  ]);
  // New rows namespace spilled top-level fields under meta._spill, leaving
  // genuine meta content (reviewFinding, lastDispatch) intact. Legacy rows
  // merged both flat — for those, restore non-column keys to the top level
  // but ALSO leave them in meta, so neither access pattern loses data.
  let extra;
  if (meta._spill && typeof meta._spill === 'object' && !Array.isArray(meta._spill)) {
    extra = meta._spill;
    meta = { ...meta };
    delete meta._spill;
  } else {
    extra = {};
    for (const [k, v] of Object.entries(meta)) {
      if (!knownFields.has(k)) extra[k] = v;
    }
  }
  return {
    id: row.id,
    text: row.text,
    status: row.status,
    assignee: row.assignee,
    complexity: row.complexity,
    role: row.role,
    suggestedRole: row.suggested_role,
    result: parseFlexible(row.result),
    error: parseFlexible(row.error),
    meta,
    retryCount: row.retry_count,
    retryAttempts: row.retry_attempts,
    backoffMs: row.backoff_ms,
    lastRetryAt: row.last_retry_at,
    nextRetryAt: row.next_retry_at,
    claimedUntil: row.claimed_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    ...extra,
  };
}

export function getCampaignStateVersion(db, projectId) {
  db.prepare(`
    INSERT INTO campaign_state_versions (project_id, version)
    VALUES (?, 0)
    ON CONFLICT(project_id) DO NOTHING
  `).run(projectId);
  return db.prepare(
    'SELECT version FROM campaign_state_versions WHERE project_id = ?'
  ).get(projectId).version;
}

export function persistCampaigns(db, projectId, campaigns, { expectedVersion } = {}) {
  const deleteMilestones = db.prepare(
    'DELETE FROM milestones WHERE campaign_id IN (SELECT id FROM campaigns WHERE project_id = ?)'
  );
  const deleteCampaigns = db.prepare('DELETE FROM campaigns WHERE project_id = ?');
  const insertCampaign = db.prepare(`
    INSERT INTO campaigns (id, project_id, title, description, status, type, done_criteria, branch,
      created_at, updated_at, completed_at, last_review_at, last_review_summary, next_action, contingency, metadata)
    VALUES (@id, @project_id, @title, @description, @status, @type, @done_criteria, @branch,
      @created_at, @updated_at, @completed_at, @last_review_at, @last_review_summary, @next_action, @contingency, @metadata)
  `);
  const insertMilestone = db.prepare(`
    INSERT INTO milestones (id, campaign_id, project_id, title, description, status, done_criteria,
      blocked_by, contingency, sort_order, created_at, updated_at, completed_at, task_ids, metadata)
    VALUES (@id, @campaign_id, @project_id, @title, @description, @status, @done_criteria,
      @blocked_by, @contingency, @sort_order, @created_at, @updated_at, @completed_at, @task_ids, @metadata)
  `);

  // Same DB-backed CAS as persistTasks (adb5fb2e): the version bump is
  // conditional on expectedVersion and lives INSIDE the delete+insert
  // transaction, so a cross-process lost-update either wins the bump or
  // throws CAMPAIGN_VERSION_CONFLICT before touching rows. Callers without
  // expectedVersion (snapshot restore) bump unconditionally — a restore must
  // invalidate every in-flight CAS writer.
  const initializeVersion = db.prepare(`
    INSERT INTO campaign_state_versions (project_id, version)
    VALUES (?, 0)
    ON CONFLICT(project_id) DO NOTHING
  `);
  const advanceExpectedVersion = db.prepare(`
    UPDATE campaign_state_versions
    SET version = version + 1
    WHERE project_id = ? AND version = ?
  `);
  const advanceVersion = db.prepare(`
    UPDATE campaign_state_versions SET version = version + 1 WHERE project_id = ?
  `);

  db.transaction(() => {
    initializeVersion.run(projectId);
    if (expectedVersion !== undefined) {
      const result = advanceExpectedVersion.run(projectId, expectedVersion);
      if (result.changes !== 1) {
        const currentVersion = db.prepare(
          'SELECT version FROM campaign_state_versions WHERE project_id = ?'
        ).get(projectId)?.version;
        const err = new Error(
          `Campaign state version conflict for ${projectId}: expected ${expectedVersion}, current ${currentVersion}`
        );
        err.code = 'CAMPAIGN_VERSION_CONFLICT';
        err.expectedVersion = expectedVersion;
        err.currentVersion = currentVersion;
        throw err;
      }
    } else {
      advanceVersion.run(projectId);
    }
    deleteMilestones.run(projectId);
    deleteCampaigns.run(projectId);
    for (const campaign of campaigns) {
      insertCampaign.run(campaignToRow(campaign, projectId));
      for (const milestone of campaign.milestones || []) {
        insertMilestone.run(milestoneToRow(milestone, campaign.id, projectId));
      }
    }
  })();
}

export function getTaskStateVersion(db, projectId) {
  db.prepare(`
    INSERT INTO task_state_versions (project_id, version)
    VALUES (?, 0)
    ON CONFLICT(project_id) DO NOTHING
  `).run(projectId);
  return db.prepare(
    'SELECT version FROM task_state_versions WHERE project_id = ?'
  ).get(projectId).version;
}

export function persistTasks(db, projectId, tasks, { expectedVersion } = {}) {
  const deleteSubtasks = db.prepare(
    'DELETE FROM subtasks WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)'
  );
  const deleteTasks = db.prepare('DELETE FROM tasks WHERE project_id = ?');
  const insertTask = db.prepare(`
    INSERT INTO tasks (id, project_id, campaign_id, milestone_id, title, description, status, type,
      category, task_category, channel, thread_id, done_criteria, owner, plan, context,
      delegation_context, git_baseline, review_cycle, max_review_cycles, review_findings,
      review_feedback_history, review_iterations, rework_in_progress, rollback_reason,
      shared_with, touched_files, dependencies, deliberation, trace_context,
      validation_report, trust_score, created_at, updated_at, started_at, completed_at,
      last_reviewer_id, metadata)
    VALUES (@id, @project_id, @campaign_id, @milestone_id, @title, @description, @status, @type,
      @category, @task_category, @channel, @thread_id, @done_criteria, @owner, @plan, @context,
      @delegation_context, @git_baseline, @review_cycle, @max_review_cycles, @review_findings,
      @review_feedback_history, @review_iterations, @rework_in_progress, @rollback_reason,
      @shared_with, @touched_files, @dependencies, @deliberation, @trace_context,
      @validation_report, @trust_score, @created_at, @updated_at, @started_at, @completed_at,
      @last_reviewer_id, @metadata)
  `);
  const insertSubtask = db.prepare(`
    INSERT INTO subtasks (id, task_id, project_id, text, status, assignee, complexity, role,
      suggested_role, result, error, meta, retry_count, retry_attempts, backoff_ms,
      last_retry_at, next_retry_at, claimed_until, created_at, updated_at, started_at, completed_at)
    VALUES (@id, @task_id, @project_id, @text, @status, @assignee, @complexity, @role,
      @suggested_role, @result, @error, @meta, @retry_count, @retry_attempts, @backoff_ms,
      @last_retry_at, @next_retry_at, @claimed_until, @created_at, @updated_at, @started_at, @completed_at)
  `);
  const initializeVersion = db.prepare(`
    INSERT INTO task_state_versions (project_id, version)
    VALUES (?, 0)
    ON CONFLICT(project_id) DO NOTHING
  `);
  const advanceExpectedVersion = db.prepare(`
    UPDATE task_state_versions
    SET version = version + 1
    WHERE project_id = ? AND version = ?
  `);
  const advanceVersion = db.prepare(`
    UPDATE task_state_versions SET version = version + 1 WHERE project_id = ?
  `);

  db.transaction(() => {
    initializeVersion.run(projectId);
    if (expectedVersion !== undefined) {
      const result = advanceExpectedVersion.run(projectId, expectedVersion);
      if (result.changes !== 1) {
        const currentVersion = db.prepare(
          'SELECT version FROM task_state_versions WHERE project_id = ?'
        ).get(projectId)?.version;
        const err = new Error(
          `Task state version conflict for ${projectId}: expected ${expectedVersion}, current ${currentVersion}`
        );
        err.code = 'TASK_VERSION_CONFLICT';
        err.expectedVersion = expectedVersion;
        err.currentVersion = currentVersion;
        throw err;
      }
    } else {
      advanceVersion.run(projectId);
    }
    deleteSubtasks.run(projectId);
    deleteTasks.run(projectId);
    for (const task of tasks) {
      insertTask.run(taskToRow(task, projectId));
      for (const subtask of task.subtasks || []) {
        insertSubtask.run(subtaskToRow(subtask, task.id, projectId));
      }
    }
  })();
}

export { getDb };

/**
 * Pre-flight check for callers that scan multiple projects' state.sqlite
 * files (pattern-detection, cross-project-aggregator, etc.). Returns true
 * only when there's a state.sqlite of NON-ZERO size at the given path.
 *
 * Why this exists: getDb() process.exit(1)s on 0-byte state.sqlite as a
 * safety guard against the Iter4 silent-re-init self-destruct. That guard
 * is correct for an orchestrator loading its own main DB — refuse to
 * start rather than discard state. But for project-scan callers (added
 * by #18, 2026-05-30), one corrupt project's 0-byte file would take
 * down the entire orchestrator. This helper lets scans skip cleanly
 * without invoking getDb on a known-broken path.
 *
 * Usage:
 *   if (!stateDbExists(projectDir)) continue; // skip empty/corrupt
 *   const db = getDb(projectDir);
 *
 * A naive `existsSync(dbPath)` check is NOT sufficient — it returns true
 * for 0-byte files (the exact corruption mode this protects against).
 */
export function stateDbExists(projectDir) {
  const dbPath = join(projectDir, 'state.sqlite');
  if (!existsSync(dbPath)) return false;
  try {
    return statSync(dbPath).size > 0;
  } catch {
    // statSync racing with concurrent deletion — treat as absent.
    return false;
  }
}

/**
 * Checkpoint and close every cached project state database.
 *
 * All handles are attempted even when one checkpoint/close fails; callers get
 * an AggregateError after the cache is cleared so shutdown can log the failure
 * without leaking the remaining handles.
 */
export function closeStateDbs() {
  const errors = [];
  for (const [projectDir, db] of dbs) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      errors.push(new Error(`checkpoint failed for ${projectDir}: ${err.message}`, { cause: err }));
    }
    try {
      db.close();
    } catch (err) {
      errors.push(new Error(`close failed for ${projectDir}: ${err.message}`, { cause: err }));
    }
  }
  dbs.clear();
  if (errors.length) throw new AggregateError(errors, 'Failed to close one or more state databases');
}

/**
 * Test-only helper. Closes all cached db handles and clears the cache so
 * tests can recreate their temp directories without dangling unlinked-file
 * handles from a previous test polluting subsequent reads/writes.
 *
 * Not for production use — the orchestrator relies on the cache being
 * stable for the lifetime of the process.
 */
export function _resetDbCacheForTesting() {
  for (const db of dbs.values()) {
    try { db.close(); } catch { /* ignore — file may already be gone */ }
  }
  dbs.clear();
}
