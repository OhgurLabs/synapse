// Snapshot system — export/import full project state as self-contained JSON envelopes.
// Atomic writes prevent partial restores. Auto-prune keeps snapshot count bounded.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'fs';
import { join, dirname, relative } from 'path';
import { randomUUID } from 'crypto';

/** Files included in every snapshot (relative to project dir). */
const STATE_FILES = [
  'config.json',
  'campaigns.json',
  'campaign-events.jsonl',
  'tasks.json',
  'task-events.jsonl',
  'telemetry.jsonl',
  'learnings.jsonl',
  'permission-audit.jsonl',
  'threads.json',
];

/**
 * Discover channel transcript files under channels/{name}/transcript.jsonl.
 * Returns array of relative paths like 'channels/general/transcript.jsonl'.
 */
function discoverChannelTranscripts(projectDir) {
  const channelsDir = join(projectDir, 'channels');
  if (!existsSync(channelsDir)) return [];

  const paths = [];
  let entries;
  try {
    entries = readdirSync(channelsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const transcriptPath = join(channelsDir, entry.name, 'transcript.jsonl');
    if (existsSync(transcriptPath)) {
      paths.push(join('channels', entry.name, 'transcript.jsonl'));
    }
  }
  return paths;
}

/**
 * Read a file's contents, returning null if it doesn't exist or can't be read.
 */
function safeReadFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Atomic write: write to .tmp.{pid} then rename.
 * Prevents partial writes on crash.
 */
function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp.' + process.pid;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, filePath);
  } catch (err) {
    // Clean up tmp on failure
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Generate a snapshot ID: snap_{timestamp}_{hex8}
 */
function generateSnapshotId() {
  return `snap_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

/**
 * Create a SnapshotManager for managing project state snapshots.
 *
 * @param {Object} deps
 * @param {Object} deps.stateManager - must expose .projectsDir
 * @returns {Object} SnapshotManager with createSnapshot, listSnapshots, getSnapshot, restoreSnapshot, deleteSnapshot, pruneSnapshots
 */
export function createSnapshotManager(deps) {
  const { stateManager } = deps;

  function projectDir(projectId) {
    return join(stateManager.projectsDir, projectId);
  }

  function snapshotsDir(projectId) {
    return join(projectDir(projectId), 'snapshots');
  }

  /**
   * Create a snapshot of all project state files.
   *
   * @param {string} projectId
   * @param {Object} options
   * @param {string} options.reason - why the snapshot was created
   * @returns {Object} snapshot metadata { snapshotId, projectId, createdAt, reason, files }
   */
  function createSnapshot(projectId, { reason } = {}) {
    const projDir = projectDir(projectId);
    const snapDir = snapshotsDir(projectId);
    mkdirSync(snapDir, { recursive: true });

    const snapshotId = generateSnapshotId();
    const createdAt = new Date().toISOString();

    // Collect all state files
    const allRelPaths = [
      ...STATE_FILES,
      ...discoverChannelTranscripts(projDir),
    ];

    const files = [];
    for (const relPath of allRelPaths) {
      const content = safeReadFile(join(projDir, relPath));
      if (content === null) continue; // skip missing files
      files.push({ path: relPath, content });
    }

    const metadata = {
      snapshotId,
      projectId,
      createdAt,
      reason: reason || null,
      files: files.map(f => f.path),
    };

    const envelope = {
      ...metadata,
      data: files,
    };

    const snapshotPath = join(snapDir, `${snapshotId}.json`);
    atomicWrite(snapshotPath, JSON.stringify(envelope, null, 2) + '\n');

    // Auto-prune after creating
    pruneSnapshots(projectId);

    return metadata;
  }

  /**
   * List all snapshots for a project, sorted newest-first.
   *
   * @param {string} projectId
   * @returns {Array<Object>} array of metadata objects { snapshotId, projectId, createdAt, reason, files }
   */
  function listSnapshots(projectId) {
    const snapDir = snapshotsDir(projectId);
    if (!existsSync(snapDir)) return [];

    let entries;
    try {
      entries = readdirSync(snapDir).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }

    const snapshots = [];
    for (const filename of entries) {
      try {
        const raw = readFileSync(join(snapDir, filename), 'utf-8');
        const parsed = JSON.parse(raw);
        snapshots.push({
          snapshotId: parsed.snapshotId,
          projectId: parsed.projectId,
          createdAt: parsed.createdAt,
          reason: parsed.reason,
          files: parsed.files || parsed.data?.map(f => f.path) || [],
        });
      } catch {
        // Skip corrupt files
        continue;
      }
    }

    // Sort newest-first by createdAt
    snapshots.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return snapshots;
  }

  /**
   * Get the full snapshot envelope (including file data).
   *
   * @param {string} projectId
   * @param {string} snapshotId
   * @returns {Object|null} full snapshot envelope or null if not found
   */
  function getSnapshot(projectId, snapshotId) {
    // Validate snapshotId format to prevent path traversal
    if (!snapshotId || !/^snap_\d+_[a-f0-9]{8}$/.test(snapshotId)) {
      return null;
    }

    const snapshotPath = join(snapshotsDir(projectId), `${snapshotId}.json`);
    if (!existsSync(snapshotPath)) return null;

    try {
      return JSON.parse(readFileSync(snapshotPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Restore project state from a snapshot.
   * Writes each file atomically to prevent partial restores.
   *
   * @param {string} projectId
   * @param {string} snapshotId
   * @returns {Object} result metadata { restored: number, files: string[], versions: { campaigns, tasks } }
   */
  function restoreSnapshot(projectId, snapshotId) {
    const snapshot = getSnapshot(projectId, snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    const projDir = projectDir(projectId);
    const restoredFiles = [];
    let campaignsVersion = null;
    let tasksVersion = null;

    for (const fileEntry of (snapshot.data || [])) {
      const relPath = fileEntry.path;

      // Security: reject absolute paths or path traversal
      if (relPath.startsWith('/') || relPath.includes('..')) {
        continue;
      }

      const targetPath = join(projDir, relPath);

      // Ensure parent directory exists (handles channels/*/transcript.jsonl)
      mkdirSync(dirname(targetPath), { recursive: true });

      // JSON files: re-parse and pretty-print for consistent formatting
      // JSONL files: write raw content strings (newline-delimited, not valid JSON as a whole)
      let content = fileEntry.content;
      if (relPath.endsWith('.json')) {
        try {
          content = JSON.stringify(JSON.parse(content), null, 2) + '\n';
        } catch {
          // If parse fails (corrupt snapshot data), write raw content as fallback
        }
      }

      // Write atomically: .tmp.{pid} then rename
      atomicWrite(targetPath, content);
      restoredFiles.push(relPath);

      // Extract CAS versions for campaigns.json and tasks.json
      // so the orchestrator can reconcile CAS state after restore
      if (relPath === 'campaigns.json') {
        try {
          campaignsVersion = JSON.parse(fileEntry.content).version ?? null;
        } catch { /* ignore parse errors */ }
      }
      if (relPath === 'tasks.json') {
        try {
          tasksVersion = JSON.parse(fileEntry.content).version ?? null;
        } catch { /* ignore parse errors */ }
      }
    }

    return {
      restored: restoredFiles.length,
      files: restoredFiles,
      versions: {
        campaigns: campaignsVersion,
        tasks: tasksVersion,
      },
    };
  }

  /**
   * Delete a single snapshot by ID.
   *
   * @param {string} projectId
   * @param {string} snapshotId
   * @returns {boolean} true if deleted, false if not found
   */
  function deleteSnapshot(projectId, snapshotId) {
    // Validate snapshotId format to prevent path traversal
    if (!snapshotId || !/^snap_\d+_[a-f0-9]{8}$/.test(snapshotId)) {
      return false;
    }

    const snapshotPath = join(snapshotsDir(projectId), `${snapshotId}.json`);
    if (!existsSync(snapshotPath)) return false;

    try {
      unlinkSync(snapshotPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Prune snapshots beyond maxCount, keeping newest.
   *
   * @param {string} projectId
   * @param {number} maxCount - max snapshots to retain (default 10)
   * @returns {number} number of snapshots deleted
   */
  function pruneSnapshots(projectId, maxCount = 10) {
    const snapshots = listSnapshots(projectId);
    if (snapshots.length <= maxCount) return 0;

    // snapshots is sorted newest-first, so slice off the oldest
    const toDelete = snapshots.slice(maxCount);
    const snapDir = snapshotsDir(projectId);
    let deleted = 0;

    for (const snap of toDelete) {
      try {
        unlinkSync(join(snapDir, `${snap.snapshotId}.json`));
        deleted++;
      } catch {
        // Skip if file already deleted
      }
    }

    return deleted;
  }

  return {
    createSnapshot,
    listSnapshots,
    getSnapshot,
    restoreSnapshot,
    deleteSnapshot,
    pruneSnapshots,
  };
}
