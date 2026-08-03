/**
 * Snapshot Restore Protocol — Design Document
 * =============================================
 *
 * Restores a full project state from a snapshot produced by the snapshot export
 * endpoint (GET /api/projects/:id/snapshot). The restore is atomic: either all
 * state is replaced successfully, or the previous state is left intact.
 *
 *
 * 1. SNAPSHOT PAYLOAD SCHEMA
 * --------------------------
 * The restore endpoint accepts the same JSON structure that the export produces.
 * It can be provided in two ways:
 *
 *   A) Inline JSON body:
 *      POST /api/projects/:id/snapshot/restore
 *      Content-Type: application/json
 *      Body: { <full snapshot object> }
 *
 *   B) Filename reference (load from disk):
 *      POST /api/projects/:id/snapshot/restore
 *      Content-Type: application/json
 *      Body: { "filename": "2026-02-22T22:11:00.000Z.json" }
 *
 *      Filenames are resolved relative to .synapse/snapshots/{projectId}/.
 *      Path traversal is rejected (no "..", no absolute paths, no slashes).
 *
 * Expected snapshot structure (matches export format):
 *
 *   {
 *     "manifest": {
 *       "version": 1,                    // Snapshot schema version
 *       "projectId": "synapse",          // Must match :id in URL
 *       "timestamp": "ISO-8601",         // When the snapshot was taken
 *       "counts": {                      // For quick validation
 *         "campaigns": <number>,
 *         "milestones": <number>,
 *         "tasks": <number>,
 *         "channels": <number>
 *       }
 *     },
 *     "projectConfig": {                 // → config.json
 *       "name": "synapse",
 *       "displayName": "...",
 *       "projectDir": "...",
 *       "channels": [...],
 *       "defaultChannel": "...",
 *       "vision": "...",
 *       "visionHistory": [...]
 *     },
 *     "campaigns": {                     // → campaigns.json
 *       "schemaVersion": "1",
 *       "version": <number>,             // CAS version preserved from snapshot
 *       "campaigns": [...]
 *     },
 *     "tasks": {                         // → tasks.json
 *       "schemaVersion": "1",
 *       "version": <number>,             // CAS version preserved from snapshot
 *       "tasks": [...]
 *     },
 *     "threads": {                       // → threads.json (optional, may be absent)
 *       ...
 *     },
 *     "events": {                        // Append-only logs (optional)
 *       "campaignEvents": "line\nline\n...",   // → campaign-events.jsonl (raw text)
 *       "taskEvents": "line\nline\n..."        // → task-events.jsonl (raw text)
 *     }
 *   }
 *
 * The `events` section is optional. If omitted, event JSONL files are not
 * replaced — the restore only updates the main state files. This allows
 * lightweight "state-only" restores without rewriting potentially large
 * append-only logs.
 *
 *
 * 2. VALIDATION RULES
 * -------------------
 * Before any writes occur, the snapshot is validated:
 *
 *   a) manifest.version === 1 (only known schema version)
 *   b) manifest.projectId matches the :id URL parameter
 *   c) manifest.timestamp is a valid ISO-8601 string
 *   d) manifest.counts.campaigns matches campaigns.campaigns.length
 *   e) manifest.counts.tasks matches tasks.tasks.length
 *   f) projectConfig exists and has required fields: name, channels
 *   g) campaigns.schemaVersion === "1"
 *   h) tasks.schemaVersion === "1"
 *   i) campaigns.version and tasks.version are positive integers
 *   j) projectConfig.name matches manifest.projectId
 *   k) If "filename" mode: filename contains no "..", "/", or "\" characters
 *   l) Payload size guard: reject payloads > 50 MB (configurable)
 *
 * If any check fails, return 400 with details. No files are touched.
 *
 *
 * 3. WRITE-AHEAD SEQUENCE
 * -----------------------
 * Files are written in dependency order. Each file is written to a temporary
 * path first (.tmp.<pid>), then committed via atomic rename in a separate pass.
 *
 * Step 1 — Back up current state (safety net for rollback):
 *   For each file that will be replaced, read current contents into memory.
 *   This is the rollback buffer. No files created on disk yet.
 *
 * Step 2 — Write .tmp files (write-ahead phase):
 *   Order matters — write in reverse dependency order so the most critical
 *   files (campaigns, tasks) are written last:
 *
 *   2a. threads.json.tmp.<pid>           (if threads present in snapshot)
 *   2b. campaign-events.jsonl.tmp.<pid>  (if events.campaignEvents present)
 *   2c. task-events.jsonl.tmp.<pid>      (if events.taskEvents present)
 *   2d. campaigns.json.tmp.<pid>
 *   2e. tasks.json.tmp.<pid>
 *   2f. config.json.tmp.<pid>
 *
 *   If ANY write fails (disk full, permissions), go to Rollback.
 *
 * Step 3 — Commit (atomic rename phase):
 *   Rename all .tmp files to their final paths in the same order:
 *
 *   3a. threads.json
 *   3b. campaign-events.jsonl
 *   3c. task-events.jsonl
 *   3d. campaigns.json
 *   3e. tasks.json
 *   3f. config.json
 *
 *   renameSync is atomic on POSIX (same filesystem). If a rename fails
 *   mid-sequence, some files will be updated and some won't — but each
 *   individual file is either fully old or fully new (no corruption).
 *   Go to Rollback for any remaining uncommitted .tmp files.
 *
 * Step 4 — Cleanup:
 *   Remove any leftover .tmp files (should be none on success).
 *
 *
 * 4. ROLLBACK STRATEGY
 * --------------------
 * Rollback handles two failure scenarios:
 *
 *   A) Write-ahead failure (step 2 fails):
 *      Only .tmp files exist. Delete all .tmp.<pid> files. Original state
 *      files are untouched. Restore is fully reverted.
 *
 *   B) Commit failure (step 3 fails mid-rename):
 *      Some files are already renamed (committed), others are still .tmp.
 *      - Delete remaining .tmp files
 *      - For already-renamed files, restore from the in-memory rollback
 *        buffer: write the original content back via writeFileSync
 *      - This means a commit-phase failure requires a second write pass
 *        to undo, but it preserves atomicity at the project level
 *
 *   Rollback buffer contents:
 *   {
 *     'config.json': <original content string or null if file didn't exist>,
 *     'campaigns.json': ...,
 *     'tasks.json': ...,
 *     'threads.json': ...,
 *     'campaign-events.jsonl': ...,
 *     'task-events.jsonl': ...
 *   }
 *
 *   Files that were null (didn't exist before restore) are deleted on rollback
 *   rather than written.
 *
 *
 * 5. IN-PROGRESS CAMPAIGNS & ACTIVE TASK HANDLING
 * ------------------------------------------------
 * The restore is a state replacement, not a merge. Whatever state the snapshot
 * contains is what the project will have after restore. This means:
 *
 *   - If the snapshot has a campaign with status "active" and milestones in
 *     various states, those exact states are restored. The strategist's next
 *     tick will pick up where the snapshot left off.
 *
 *   - If the snapshot has tasks with status "executing" and subtasks "claimed"
 *     by agents, those states are restored. However, no agents are actually
 *     running those tasks after restore. The heartbeat will detect stale
 *     claims (claimedUntil in the past) and requeue them.
 *
 *   - Active agent processes are NOT killed by restore. If an agent is mid-
 *     execution on a task that no longer exists in the restored state, it will
 *     fail gracefully when it tries to update the task (task not found).
 *
 *   After disk commit, the restore module:
 *   a) Appends a restore event to campaign-events.jsonl:
 *      { action: "snapshot_restored", timestamp, snapshotTimestamp, ... }
 *   b) Appends a restore event to task-events.jsonl:
 *      { action: "snapshot_restored", timestamp, snapshotTimestamp, ... }
 *   c) Reloads in-memory state:
 *      - Re-reads config.json into StateManager.projects Map
 *      - Campaign and Task managers re-read from their files on next access
 *        (they load() from disk on every operation due to CAS pattern)
 *      - Since CampaignManager and TaskManager always load() fresh from disk
 *        before any _saveWithRetry, the CAS version from the snapshot is
 *        automatically picked up. No manual version sync needed.
 *
 *
 * 6. CAS VERSION HANDLING
 * -----------------------
 * The snapshot preserves the exact CAS versions from the export moment.
 * On restore, those versions are written to disk as-is. Since CampaignManager
 * and TaskManager always call load() before _saveWithRetry, the next write
 * will read the restored version and increment from there.
 *
 * If a concurrent write happens between the restore's commit and the first
 * post-restore operation, the CAS mechanism handles it naturally — the
 * concurrent writer will see the restored version and either succeed or
 * retry, as designed.
 *
 *
 * 7. API ENDPOINT
 * ---------------
 * POST /api/projects/:id/snapshot/restore
 *
 * Request body (inline):
 *   { "manifest": {...}, "projectConfig": {...}, "campaigns": {...}, ... }
 *
 * Request body (from file):
 *   { "filename": "2026-02-22T22:11:00.000Z.json" }
 *
 * Success response (200):
 *   {
 *     "ok": true,
 *     "restored": {
 *       "projectId": "synapse",
 *       "snapshotTimestamp": "2026-02-22T22:11:00.000Z",
 *       "filesRestored": ["config.json", "campaigns.json", "tasks.json", ...],
 *       "campaigns": <count>,
 *       "tasks": <count>
 *     }
 *   }
 *
 * Validation failure (400):
 *   { "error": "Snapshot validation failed: manifest.projectId mismatch" }
 *
 * Rollback after failure (500):
 *   { "error": "Restore failed: disk write error, rolled back to previous state" }
 *
 * Project not found (404):
 *   { "error": "Project not found" }
 *
 *
 * 8. SECURITY CONSIDERATIONS
 * --------------------------
 *   - Filename parameter: reject any value containing "..", "/", or "\"
 *   - Payload size: enforced at 50 MB (configurable) before JSON.parse
 *   - Auth: same token check as all other API endpoints
 *   - projectId in URL must match manifest.projectId (no cross-project restore)
 *   - projectConfig.projectDir from snapshot is IGNORED on restore — the
 *     current project's projectDir is preserved. This prevents a snapshot
 *     from one machine overwriting the project directory path on another.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from './logger.js';
import { getDb, persistCampaigns, persistTasks } from './orchestrator/state-db.js';

const log = createLogger('snapshot-restore');

const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

// Files managed by snapshot restore, in write-ahead order (reverse dependency).
// Optional files are only written if present in the snapshot.
const STATE_FILES = [
  { key: 'threads',        filename: 'threads.json',           optional: true,  serialize: JSON.stringify },
  { key: 'campaignEvents', filename: 'campaign-events.jsonl',  optional: true,  serialize: null }, // raw text
  { key: 'taskEvents',     filename: 'task-events.jsonl',      optional: true,  serialize: null }, // raw text
  { key: 'campaigns',      filename: 'campaigns.json',         optional: false, serialize: JSON.stringify },
  { key: 'tasks',          filename: 'tasks.json',             optional: false, serialize: JSON.stringify },
  { key: 'projectConfig',  filename: 'config.json',            optional: false, serialize: JSON.stringify },
];

/**
 * Validate a snapshot against the protocol rules.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validateSnapshot(snapshot, projectId) {
  // manifest exists and is an object
  if (!snapshot || typeof snapshot !== 'object') {
    return { valid: false, error: 'Snapshot must be a non-null object' };
  }

  const { manifest } = snapshot;
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, error: 'Missing or invalid manifest' };
  }

  // (a) schema version
  if (manifest.version !== 1) {
    return { valid: false, error: `Unsupported manifest.version: ${manifest.version} (expected 1)` };
  }

  // (b) projectId match
  if (manifest.projectId !== projectId) {
    return { valid: false, error: `manifest.projectId "${manifest.projectId}" does not match project "${projectId}"` };
  }

  // (c) valid ISO-8601 timestamp
  if (!manifest.timestamp || isNaN(Date.parse(manifest.timestamp))) {
    return { valid: false, error: 'manifest.timestamp is missing or not a valid ISO-8601 string' };
  }

  // (f) projectConfig required fields
  const pc = snapshot.projectConfig;
  if (!pc || typeof pc !== 'object') {
    return { valid: false, error: 'Missing or invalid projectConfig' };
  }
  if (!pc.name || typeof pc.name !== 'string') {
    return { valid: false, error: 'projectConfig.name is required and must be a string' };
  }
  if (!Array.isArray(pc.channels) || pc.channels.length === 0) {
    return { valid: false, error: 'projectConfig.channels is required and must be a non-empty array' };
  }

  // (j) projectConfig.name matches manifest.projectId
  if (pc.name !== manifest.projectId) {
    return { valid: false, error: `projectConfig.name "${pc.name}" does not match manifest.projectId "${manifest.projectId}"` };
  }

  // campaigns section
  const campaigns = snapshot.campaigns;
  if (!campaigns || typeof campaigns !== 'object') {
    return { valid: false, error: 'Missing or invalid campaigns section' };
  }
  if (!Array.isArray(campaigns.campaigns)) {
    return { valid: false, error: 'campaigns.campaigns must be an array' };
  }

  // (g) campaigns schema version
  if (campaigns.schemaVersion !== '1') {
    return { valid: false, error: `Unsupported campaigns.schemaVersion: "${campaigns.schemaVersion}" (expected "1")` };
  }

  // (i) campaigns CAS version
  if (!Number.isInteger(campaigns.version) || campaigns.version < 0) {
    return { valid: false, error: 'campaigns.version must be a non-negative integer' };
  }

  // tasks section
  const tasks = snapshot.tasks;
  if (!tasks || typeof tasks !== 'object') {
    return { valid: false, error: 'Missing or invalid tasks section' };
  }
  if (!Array.isArray(tasks.tasks)) {
    return { valid: false, error: 'tasks.tasks must be an array' };
  }

  // (h) tasks schema version
  if (tasks.schemaVersion !== '1') {
    return { valid: false, error: `Unsupported tasks.schemaVersion: "${tasks.schemaVersion}" (expected "1")` };
  }

  // (i) tasks CAS version
  if (!Number.isInteger(tasks.version) || tasks.version < 0) {
    return { valid: false, error: 'tasks.version must be a non-negative integer' };
  }

  // (d, e) count verification
  const counts = manifest.counts;
  if (counts && typeof counts === 'object') {
    if (typeof counts.campaigns === 'number' && counts.campaigns !== campaigns.campaigns.length) {
      return { valid: false, error: `manifest.counts.campaigns (${counts.campaigns}) does not match campaigns.campaigns.length (${campaigns.campaigns.length})` };
    }
    if (typeof counts.tasks === 'number' && counts.tasks !== tasks.tasks.length) {
      return { valid: false, error: `manifest.counts.tasks (${counts.tasks}) does not match tasks.tasks.length (${tasks.tasks.length})` };
    }
  }

  return { valid: true };
}

/**
 * Validate a filename for path traversal.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validateFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0) {
    return { valid: false, error: 'filename must be a non-empty string' };
  }
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return { valid: false, error: 'filename must not contain "..", "/", or "\\"' };
  }
  return { valid: true };
}

/**
 * Load a snapshot from a filename on disk.
 * Resolves relative to .synapse/snapshots/{projectId}/.
 */
export function loadSnapshotFromFile(baseDir, projectId, filename) {
  const check = validateFilename(filename);
  if (!check.valid) throw new Error(check.error);

  const snapshotPath = join(baseDir, '.synapse', 'snapshots', projectId, filename);
  if (!existsSync(snapshotPath)) {
    throw new Error(`Snapshot file not found: ${filename}`);
  }

  const raw = readFileSync(snapshotPath, 'utf-8');
  if (raw.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`Snapshot file exceeds ${MAX_PAYLOAD_BYTES} byte limit`);
  }

  return JSON.parse(raw);
}

/**
 * Extract the data content for each state file from the snapshot.
 * Returns an array of { key, filename, content } for files that should be written.
 * Content is the string to write to disk.
 *
 * IMPORTANT: projectConfig.projectDir is replaced with the current project's
 * projectDir to prevent cross-machine path issues.
 */
function prepareFileContents(snapshot, currentProjectDir) {
  const files = [];

  for (const fileDef of STATE_FILES) {
    let data;

    if (fileDef.key === 'campaignEvents') {
      data = snapshot.events?.campaignEvents;
    } else if (fileDef.key === 'taskEvents') {
      data = snapshot.events?.taskEvents;
    } else {
      data = snapshot[fileDef.key];
    }

    // Skip optional files not present in the snapshot
    if (data == null && fileDef.optional) continue;
    if (data == null && !fileDef.optional) {
      throw new Error(`Required snapshot section "${fileDef.key}" is missing`);
    }

    let content;
    if (fileDef.key === 'projectConfig') {
      // Preserve current projectDir — never overwrite from snapshot
      const configToWrite = { ...data, projectDir: currentProjectDir };
      content = JSON.stringify(configToWrite, null, 2) + '\n';
    } else if (fileDef.serialize) {
      content = JSON.stringify(data, null, 2) + '\n';
    } else {
      // Raw text (JSONL event logs) — ensure trailing newline
      content = typeof data === 'string' ? data : String(data);
      if (content.length > 0 && !content.endsWith('\n')) {
        content += '\n';
      }
    }

    files.push({ key: fileDef.key, filename: fileDef.filename, content });
  }

  return files;
}

/**
 * Build the rollback buffer by reading current state of each file that will be replaced.
 * Returns a Map<finalPath, originalContent | null>.
 */
function buildRollbackBuffer(projDir, filesToWrite) {
  const buffer = new Map();
  for (const { filename } of filesToWrite) {
    const finalPath = join(projDir, filename);
    if (existsSync(finalPath)) {
      buffer.set(finalPath, readFileSync(finalPath, 'utf-8'));
    } else {
      buffer.set(finalPath, null);
    }
  }
  return buffer;
}

/**
 * Write all state files to .tmp.<pid> paths.
 * Returns an array of { tmpPath, finalPath } for the commit phase.
 * Throws on any write failure.
 */
export function writeAhead(projDir, filesToWrite) {
  const pid = process.pid;
  const written = [];

  for (const { filename, content } of filesToWrite) {
    const finalPath = join(projDir, filename);
    const tmpPath = finalPath + '.tmp.' + pid;
    writeFileSync(tmpPath, content);
    written.push({ tmpPath, finalPath });
  }

  return written;
}

/**
 * Atomically rename all .tmp files to their final paths.
 * Tracks which files were committed so rollback knows what to undo.
 * Returns the list of committed final paths.
 */
export function commitRestore(tmpFiles) {
  const committed = [];

  for (const { tmpPath, finalPath } of tmpFiles) {
    renameSync(tmpPath, finalPath);
    committed.push(finalPath);
  }

  return committed;
}

/**
 * Roll back a failed restore.
 *
 * - Deletes any remaining .tmp files
 * - For files that were already committed (renamed), restores original content
 *   from the rollback buffer
 * - Files that didn't exist before restore are deleted
 */
export function rollback(tmpFiles, committedPaths, rollbackBuffer) {
  const errors = [];

  // 1. Clean up uncommitted .tmp files
  for (const { tmpPath, finalPath } of tmpFiles) {
    if (committedPaths.includes(finalPath)) continue; // already renamed
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch (err) {
      errors.push(`Failed to delete tmp file ${tmpPath}: ${err.message}`);
    }
  }

  // 2. Restore already-committed files from rollback buffer
  for (const committedPath of committedPaths) {
    const original = rollbackBuffer.get(committedPath);
    try {
      if (original === null) {
        // File didn't exist before restore — delete it
        if (existsSync(committedPath)) unlinkSync(committedPath);
      } else {
        // Restore original content
        writeFileSync(committedPath, original);
      }
    } catch (err) {
      errors.push(`Failed to rollback ${committedPath}: ${err.message}`);
    }
  }

  if (errors.length > 0) {
    log.error('Rollback completed with errors', { errors });
  }

  return errors;
}

/**
 * Append restore event markers to the JSONL event logs.
 * Called after successful commit so the event trail records the restore.
 * Includes counts of active campaigns and executing tasks from the restored snapshot
 * so the audit trail shows what state was loaded.
 */
function appendRestoreEvents(projDir, projectId, snapshot) {
  const now = new Date().toISOString();
  const snapshotTimestamp = snapshot.manifest.timestamp;

  // Count active campaigns and executing tasks in the restored snapshot
  const activeCampaigns = snapshot.campaigns.campaigns.filter(c => c.status === 'active').length;
  const executingTasks = snapshot.tasks.tasks.filter(t => t.status === 'executing').length;
  const claimedSubtasks = snapshot.tasks.tasks.reduce((count, t) =>
    count + t.subtasks.filter(s => s.status === 'claimed' || s.status === 'executing').length, 0);

  const baseEvent = {
    schemaVersion: '1',
    timestamp: now,
    project: projectId,
    action: 'snapshot_restored',
    snapshotTimestamp,
    agent: 'system',
    activeCampaigns,
    executingTasks,
    claimedSubtasks,
  };

  const campaignEventsPath = join(projDir, 'campaign-events.jsonl');
  const taskEventsPath = join(projDir, 'task-events.jsonl');

  // Unique event IDs for each log
  const campaignEvent = { ...baseEvent, eventId: `evt_${Date.now()}_restore_campaign` };
  const taskEvent = { ...baseEvent, eventId: `evt_${Date.now()}_restore_task` };

  appendFileSync(campaignEventsPath, JSON.stringify(campaignEvent) + '\n');
  appendFileSync(taskEventsPath, JSON.stringify(taskEvent) + '\n');
}

/**
 * Reload in-memory state after a successful restore.
 *
 * - Re-reads config.json into StateManager.projects Map
 * - CampaignManager and TaskManager reload from disk on next access automatically
 *   (they call load() on every operation due to CAS pattern), so no explicit
 *   file re-read is needed. However, TaskManager holds in-memory counters
 *   (_requeueCounts, _completedSinceAudit) that must be cleared because the
 *   restored snapshot contains a different task set.
 * - CAS versions from the snapshot are preserved on disk and will be picked up
 *   by the next load() call in CampaignManager/TaskManager.
 */
function reloadInMemoryState(stateManager, projectId, { taskManager } = {}) {
  // 1. Reload project config into StateManager's in-memory Map
  stateManager._loadProject(projectId);

  // 2. Reset TaskManager's in-memory counters for this project.
  //    The restored snapshot may have different tasks, so requeue tracking
  //    and audit counters from the pre-restore state are stale.
  if (taskManager) {
    taskManager._requeueCounts.clear();
    taskManager._completedSinceAudit.delete(projectId);
  }

  log.info('In-memory state reloaded', { projectId });
}

/**
 * Sync SQLite state from the snapshot after JSON commit.
 *
 * Why this exists: Synapse is currently in a dual-write architecture —
 * campaigns/tasks mutations go to BOTH campaigns.json/tasks.json (the
 * durable source of truth, recoverable via migrate-json-to-sqlite) AND
 * state.sqlite (the hot read path used by managers and several
 * downstream readers). Without this step, snapshot-restore would update
 * JSON but leave SQLite stale, so the live read path would silently
 * keep serving pre-restore state.
 *
 * persistCampaigns / persistTasks (from state-db.js) wrap a SQLite
 * transaction that DELETEs all rows for the project then INSERTs from
 * the snapshot — same end state as the JSON write, atomic at the SQLite
 * layer. Both are idempotent: a retry after partial failure produces
 * the same final state as a clean first run.
 *
 * getDb is cache-shared: every manager in the orchestrator that already
 * holds a getDb reference for this project sees the new state
 * immediately after our call returns. No reload hook needed.
 *
 * Throws on failure. Caller is responsible for rolling back the JSON
 * commit so JSON and SQLite stay in sync.
 */
function syncSqliteFromSnapshot(projDir, projectId, snapshot) {
  const db = getDb(projDir);
  persistCampaigns(db, projectId, snapshot.campaigns.campaigns);
  persistTasks(db, projectId, snapshot.tasks.tasks);
}

/**
 * Main entry point: restore a project's state from a snapshot.
 *
 * @param {Object} options
 * @param {Object} options.stateManager - StateManager instance
 * @param {string} options.projectId - target project ID
 * @param {Object} [options.snapshot] - inline snapshot object (mutually exclusive with filename)
 * @param {string} [options.filename] - snapshot filename to load from disk (mutually exclusive with snapshot)
 * @param {string} [options.baseDir] - base directory for resolving snapshot files (defaults to stateManager.baseDir parent)
 * @param {Object} [options.taskManager] - TaskManager instance (for clearing in-memory counters on restore)
 * @returns {{ ok: true, restored: Object }} on success
 * @throws {Error} with .code = 'VALIDATION_ERROR' for validation failures
 * @throws {Error} with .code = 'RESTORE_FAILED' for write/commit failures (after rollback)
 */
export function restoreSnapshot({ stateManager, projectId, snapshot, filename, baseDir, taskManager }) {
  // Resolve base directory
  const resolvedBaseDir = baseDir || join(stateManager.baseDir, '..');

  // Verify project exists
  const currentProject = stateManager.getProject(projectId);
  if (!currentProject) {
    const err = new Error(`Project not found: ${projectId}`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  // Load snapshot from file if filename provided
  if (filename && !snapshot) {
    try {
      snapshot = loadSnapshotFromFile(resolvedBaseDir, projectId, filename);
    } catch (loadErr) {
      const err = new Error(`Failed to load snapshot file: ${loadErr.message}`);
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
  }

  if (!snapshot) {
    const err = new Error('No snapshot provided (supply snapshot object or filename)');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  // Validate
  const validation = validateSnapshot(snapshot, projectId);
  if (!validation.valid) {
    const err = new Error(`Snapshot validation failed: ${validation.error}`);
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  // Prepare file contents (preserving current projectDir)
  const currentProjectDir = currentProject.projectDir;
  let filesToWrite;
  try {
    filesToWrite = prepareFileContents(snapshot, currentProjectDir);
  } catch (prepErr) {
    const err = new Error(`Snapshot preparation failed: ${prepErr.message}`);
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const projDir = join(stateManager.projectsDir, projectId);

  // Step 1: Build rollback buffer (read current state into memory)
  const rollbackBuffer = buildRollbackBuffer(projDir, filesToWrite);

  // Step 2: Write-ahead phase
  let tmpFiles;
  try {
    tmpFiles = writeAhead(projDir, filesToWrite);
  } catch (writeErr) {
    // Write-ahead failed — clean up .tmp files, originals untouched
    log.error('Write-ahead failed, rolling back', { projectId, error: writeErr.message });
    rollback(tmpFiles || [], [], rollbackBuffer);
    const err = new Error(`Restore failed during write-ahead: ${writeErr.message}`);
    err.code = 'RESTORE_FAILED';
    throw err;
  }

  // Step 3: Commit phase (atomic renames)
  let committedPaths;
  try {
    committedPaths = commitRestore(tmpFiles);
  } catch (commitErr) {
    // Commit failed mid-rename — rollback both .tmp and already-committed files
    log.error('Commit failed, rolling back', { projectId, error: commitErr.message });
    const partiallyCommitted = [];
    // Determine which files were already committed before the failure
    for (const { tmpPath, finalPath } of tmpFiles) {
      if (!existsSync(tmpPath)) {
        // tmp is gone → it was renamed successfully
        partiallyCommitted.push(finalPath);
      }
    }
    const rollbackErrors = rollback(tmpFiles, partiallyCommitted, rollbackBuffer);
    const err = new Error(`Restore failed during commit: ${commitErr.message}${rollbackErrors.length ? '; rollback errors: ' + rollbackErrors.join('; ') : ''}`);
    err.code = 'RESTORE_FAILED';
    throw err;
  }

  // Step 3.5: SQLite sync — mirror restored JSON state into state.sqlite so
  // the orchestrator's hot read path (managers, alert-monitor,
  // pattern-detection, cross-project-aggregator, etc.) sees the new state.
  // Treated as fatal because JSON-only restore is the original bug this
  // task fixes; better to fail loud and roll JSON back than leave a
  // silent divergence.
  try {
    syncSqliteFromSnapshot(projDir, projectId, snapshot);
  } catch (sqlErr) {
    log.error('SQLite sync failed after JSON commit, rolling back JSON', {
      projectId,
      error: sqlErr.message,
    });
    // committedPaths contains every file that was atomically renamed; the
    // rollback buffer has the original content for each. Pass tmpFiles
    // unchanged so rollback knows which final paths to touch.
    const rollbackErrors = rollback(tmpFiles, committedPaths, rollbackBuffer);
    const err = new Error(
      `Restore failed during SQLite sync: ${sqlErr.message}` +
      (rollbackErrors.length ? '; rollback errors: ' + rollbackErrors.join('; ') : ''),
    );
    err.code = 'RESTORE_FAILED';
    throw err;
  }

  // Step 4: Post-commit — append restore events and reload in-memory state
  try {
    appendRestoreEvents(projDir, projectId, snapshot);
  } catch (eventErr) {
    // Non-fatal: state is already committed, just log the event failure
    log.warn('Failed to append restore events (state was committed successfully)', { error: eventErr.message });
  }

  reloadInMemoryState(stateManager, projectId, { taskManager });

  const filesRestored = filesToWrite.map(f => f.filename);
  log.info('Snapshot restored successfully', {
    projectId,
    snapshotTimestamp: snapshot.manifest.timestamp,
    filesRestored,
    campaigns: snapshot.campaigns.campaigns.length,
    tasks: snapshot.tasks.tasks.length,
  });

  return {
    ok: true,
    restored: {
      projectId,
      snapshotTimestamp: snapshot.manifest.timestamp,
      filesRestored,
      campaigns: snapshot.campaigns.campaigns.length,
      tasks: snapshot.tasks.tasks.length,
    },
  };
}
