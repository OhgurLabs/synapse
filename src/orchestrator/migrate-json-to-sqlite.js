import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import Database from '../persistence/sqlite-provider.js';
import { createLogger } from '../logger.js';
import { campaignToRow, milestoneToRow, taskToRow, subtaskToRow } from './state-db.js';

const log = createLogger('migrate-json-to-sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued', type TEXT DEFAULT 'standard', done_criteria TEXT DEFAULT '',
  branch TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT, last_review_at TEXT, last_review_summary TEXT, next_action TEXT, contingency TEXT, metadata TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, project_id TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', done_criteria TEXT DEFAULT '',
  blocked_by TEXT, contingency TEXT, sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT, task_ids TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, campaign_id TEXT, milestone_id TEXT,
  title TEXT NOT NULL, description TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'queued',
  type TEXT DEFAULT 'task', category TEXT, task_category TEXT, channel TEXT DEFAULT 'general',
  thread_id TEXT, done_criteria TEXT DEFAULT '', owner TEXT, plan TEXT, context TEXT,
  delegation_context TEXT, git_baseline TEXT, review_cycle INTEGER DEFAULT 0, max_review_cycles INTEGER DEFAULT 3,
  review_findings TEXT, review_feedback_history TEXT DEFAULT '[]', review_iterations TEXT DEFAULT '[]',
  rework_in_progress INTEGER DEFAULT 0, rollback_reason TEXT, shared_with TEXT DEFAULT '[]',
  touched_files TEXT DEFAULT '[]', dependencies TEXT DEFAULT '[]', deliberation TEXT, trace_context TEXT,
  validation_report TEXT, trust_score TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT, completed_at TEXT, last_reviewer_id TEXT
);
CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT NOT NULL, task_id TEXT NOT NULL, project_id TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued', assignee TEXT, complexity TEXT DEFAULT 'medium',
  role TEXT, suggested_role TEXT, result TEXT, error TEXT, meta TEXT DEFAULT '{}',
  retry_count INTEGER DEFAULT 0, retry_attempts INTEGER DEFAULT 0, backoff_ms INTEGER,
  last_retry_at TEXT, next_retry_at TEXT, claimed_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT, completed_at TEXT,
  PRIMARY KEY (task_id, id)
);
CREATE INDEX IF NOT EXISTS idx_campaigns_project ON campaigns(project_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_campaign ON tasks(campaign_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);
`;

function insertOrReplace(db, table, row) {
  const sanitized = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined || v === null) {
      sanitized[k] = null;
    } else if (typeof v === 'object') {
      sanitized[k] = JSON.stringify(v);
    } else {
      sanitized[k] = v;
    }
  }
  const cols = Object.keys(sanitized).join(',');
  const vals = Object.keys(sanitized).map(() => '?').join(',');
  db.prepare(`INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${vals})`).run(Object.values(sanitized));
}

export function migrateProject(projectDir) {
  const campaignsPath = join(projectDir, 'campaigns.json');
  const tasksPath = join(projectDir, 'tasks.json');
  const dbPath = join(projectDir, 'state.sqlite');

  if (!existsSync(campaignsPath) && !existsSync(tasksPath)) {
    log.info('No JSON files found, skipping migration', { projectDir });
    return { migrated: false };
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = OFF');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  const projectId = projectDir.split('/').pop();
  let campaignsMigrated = 0;
  let tasksMigrated = 0;
  let subtasksMigrated = 0;
  let milestonesMigrated = 0;

  const migrateAll = db.transaction(() => {
    if (existsSync(campaignsPath)) {
      try {
        const raw = JSON.parse(readFileSync(campaignsPath, 'utf8'));
        for (const c of (raw.campaigns || [])) {
          try {
            insertOrReplace(db, 'campaigns', campaignToRow(c, projectId));
            for (const m of (c.milestones || [])) {
              insertOrReplace(db, 'milestones', milestoneToRow(m, c.id, projectId));
              milestonesMigrated++;
            }
            campaignsMigrated++;
          } catch (err) {
            log.error('Failed to migrate campaign', { id: c.id, error: err.message });
          }
        }
      } catch (err) {
        log.error('Failed to read campaigns.json', { error: err.message });
      }
    }

    if (existsSync(tasksPath)) {
      try {
        const raw = JSON.parse(readFileSync(tasksPath, 'utf8'));
        for (const t of (raw.tasks || [])) {
          insertOrReplace(db, 'tasks', taskToRow(t, projectId));
          for (const s of (t.subtasks || [])) {
            insertOrReplace(db, 'subtasks', subtaskToRow(s, t.id, projectId));
            subtasksMigrated++;
          }
          tasksMigrated++;
        }
      } catch (err) {
        log.error('Failed to migrate tasks', { error: err.message });
      }
    }
  });

  migrateAll();
  db.close();

  log.info('Migration complete', { projectDir, campaignsMigrated, milestonesMigrated, tasksMigrated, subtasksMigrated });
  return { migrated: true, campaignsMigrated, milestonesMigrated, tasksMigrated, subtasksMigrated };
}

const projectDir = process.argv[2];
if (projectDir) {
  const result = migrateProject(projectDir);
  console.log(JSON.stringify(result, null, 2));
}
