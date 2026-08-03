// src/snapshots.js — Snapshot persistence, listing, and pruning.
//
// Snapshots are timestamped JSON files stored under .synapse/snapshots/{projectId}/.
// Each snapshot captures full project state at a point in time.
// Pruning retains only the most recent N snapshots (default 10).

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, unlinkSync, statSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { createLogger } from './logger.js';

const log = createLogger('snapshots');

const DEFAULT_RETENTION_LIMIT = 10;

// Snapshot filenames: ISO timestamp with colons replaced for filesystem safety,
// plus a 4-char random suffix to avoid collisions within the same millisecond.
// Format: 2026-02-22T22-11-00.000Z_a1b2.json
function makeFilename() {
  const ts = new Date().toISOString().replace(/:/g, '-');
  const suffix = randomBytes(2).toString('hex');
  return `${ts}_${suffix}.json`;
}

/**
 * Ensure the snapshot directory exists for a project.
 * @param {string} baseDir - repo root (e.g. /path/to/synapse)
 * @param {string} projectId
 * @returns {string} absolute path to .synapse/snapshots/{projectId}/
 */
function ensureDir(baseDir, projectId) {
  const dir = join(baseDir, '.synapse', 'snapshots', projectId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * List available snapshots for a project, sorted by timestamp descending (newest first).
 *
 * @param {string} baseDir - repo root
 * @param {string} projectId
 * @returns {Array<{ filename: string, timestamp: string, size: number }>}
 */
export function listSnapshots(baseDir, projectId) {
  const dir = join(baseDir, '.synapse', 'snapshots', projectId);
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const snapshots = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

    const filePath = join(dir, entry.name);
    try {
      const stat = statSync(filePath);
      // Recover ISO timestamp from filename: strip suffix, undo colon→hyphen replacement
      // Filename: 2026-02-22T22-11-00.000Z_a1b2.json → 2026-02-22T22:11:00.000Z
      const stem = entry.name.replace(/\.json$/, '').replace(/_[0-9a-f]{4}$/, '');
      const timestamp = stem.replace(/T(\d{2})-(\d{2})-(\d{2})\./, 'T$1:$2:$3.');
      snapshots.push({
        filename: entry.name,
        timestamp,
        size: stat.size,
      });
    } catch {
      // Skip files we can't stat (race condition with concurrent pruning)
    }
  }

  // Sort newest first by filename (ISO timestamps sort lexicographically)
  snapshots.sort((a, b) => b.filename.localeCompare(a.filename));
  return snapshots;
}

/**
 * Prune old snapshots, keeping only the most recent `limit` files.
 * Deletes the oldest files beyond the retention limit.
 *
 * @param {string} baseDir - repo root
 * @param {string} projectId
 * @param {number} [limit=10] - max snapshots to retain
 * @returns {string[]} filenames that were deleted
 */
export function pruneSnapshots(baseDir, projectId, limit = DEFAULT_RETENTION_LIMIT) {
  const snapshots = listSnapshots(baseDir, projectId);
  if (snapshots.length <= limit) return [];

  const dir = join(baseDir, '.synapse', 'snapshots', projectId);
  const toDelete = snapshots.slice(limit); // already sorted newest-first, so slice off the tail
  const deleted = [];

  for (const snap of toDelete) {
    try {
      unlinkSync(join(dir, snap.filename));
      deleted.push(snap.filename);
    } catch (err) {
      log.warn('Failed to prune snapshot', { filename: snap.filename, error: err.message });
    }
  }

  if (deleted.length > 0) {
    log.info('Pruned snapshots', { projectId, deleted: deleted.length, remaining: limit });
  }

  return deleted;
}

/**
 * Write a snapshot to disk and prune old snapshots beyond the retention limit.
 *
 * @param {string} baseDir - repo root
 * @param {string} projectId
 * @param {Object} data - snapshot payload (manifest + state)
 * @param {number} [limit=10] - max snapshots to retain after write
 * @returns {{ filename: string, path: string, pruned: string[] }}
 */
export function writeSnapshot(baseDir, projectId, data, limit = DEFAULT_RETENTION_LIMIT) {
  const dir = ensureDir(baseDir, projectId);
  const filename = makeFilename();
  const filePath = join(dir, filename);

  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  log.info('Snapshot written', { projectId, filename });

  const pruned = pruneSnapshots(baseDir, projectId, limit);

  return { filename, path: filePath, pruned };
}

/**
 * Collect full project state into a single atomic snapshot payload.
 * When baseDir is provided, persists the snapshot to disk and prunes old snapshots.
 * Returns null if the project doesn't exist.
 *
 * @param {string} projectId
 * @param {Object} deps
 * @param {Object} deps.stateManager - StateManager instance
 * @param {Object} deps.campaignManager - CampaignManager instance
 * @param {Object} deps.taskManager - TaskManager instance
 * @param {Object} [deps.workflowManager] - WorkflowManager instance (optional)
 * @param {string} [deps.baseDir] - repo root for filesystem persistence (omit to skip writing)
 * @returns {{ snapshot: Object, filePath: string|null }|null} snapshot + filePath, or null if project not found
 */
export function collectSnapshot(projectId, { stateManager, campaignManager, taskManager, workflowManager, baseDir }) {
  const projectConfig = stateManager.getProject(projectId);
  if (!projectConfig) return null;

  // Read all state before assembling (atomic-ish — all reads before any response)
  const campaignsData = campaignManager.load(projectId);
  const tasksData = taskManager.load(projectId);
  const threads = stateManager.loadThreads(projectId);
  const workflows = workflowManager ? workflowManager.listWorkflows(projectId) : [];

  // Count milestones across all campaigns
  let milestoneCount = 0;
  for (const campaign of campaignsData.campaigns) {
    milestoneCount += (campaign.milestones || []).length;
  }

  // Read event logs if they exist
  const projDir = join(stateManager.projectsDir, projectId);
  const campaignEventsPath = join(projDir, 'campaign-events.jsonl');
  const taskEventsPath = join(projDir, 'task-events.jsonl');
  let events;

  if (existsSync(campaignEventsPath) || existsSync(taskEventsPath)) {
    events = {};
    if (existsSync(campaignEventsPath)) {
      events.campaignEvents = execFileSync('tail', ['-n', '1000', campaignEventsPath], { encoding: 'utf-8' });
    }
    if (existsSync(taskEventsPath)) {
      events.taskEvents = execFileSync('tail', ['-n', '1000', taskEventsPath], { encoding: 'utf-8' });
    }
  }

  const manifest = {
    version: 1,
    projectId,
    timestamp: new Date().toISOString(),
    counts: {
      campaigns: campaignsData.campaigns.length,
      milestones: milestoneCount,
      tasks: tasksData.tasks.length,
      channels: (projectConfig.channels || []).length,
    },
  };

  const snapshot = {
    manifest,
    projectConfig,
    campaigns: campaignsData,
    tasks: tasksData,
    threads,
    workflows,
  };

  if (events) {
    snapshot.events = events;
  }

  // Persist to disk when baseDir is provided
  let filePath = null;
  if (baseDir) {
    const result = writeSnapshot(baseDir, projectId, snapshot);
    filePath = result.path;
  }

  return { snapshot, filePath };
}
