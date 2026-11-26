// Project-local snapshot envelopes for campaign, task, and channel state.
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, unlinkSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSafeProjectId } from './safe-id.js';
import { assertRegularProjectFile } from './persistence/project-local-db.js';

const STATE_FILES = [
  'config.json', 'campaigns.json', 'campaign-events.jsonl', 'tasks.json', 'task-events.jsonl',
  'telemetry.jsonl', 'learnings.jsonl', 'permission-audit.jsonl', 'threads.json',
];
const PROJECT_METADATA = ['displayName', 'description', 'channels', 'defaultChannel', 'vision', 'visionHistory'];
const SNAPSHOT_ID = /^snap_\d+_[a-f0-9]{8}$/;
const TRANSCRIPT = /^channels\/[a-zA-Z0-9_-]{1,100}\/transcript\.jsonl$/;

function recoveryError(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

function unsafeSnapshot() {
  return recoveryError('RECOVERY_UNSAFE_SNAPSHOT', 'Snapshot or project storage failed recovery validation', 400);
}

function directoryExists(path) {
  try {
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw unsafeSnapshot();
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      directoryExists(dirname(path));
      return false;
    }
    throw err;
  }
}

export function assertRecoveryFile(path) {
  try { return directoryExists(dirname(path)) && assertRegularProjectFile(path); }
  catch { throw unsafeSnapshot(); }
}

export function assertRecoveryStateDb(projectDir) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    assertRecoveryFile(join(projectDir, 'state.sqlite' + suffix));
  }
}

export function prepareRecoveryConfig(snapshotConfig, currentConfig, projectId) {
  if (snapshotConfig.name != null && snapshotConfig.name !== projectId) throw unsafeSnapshot();
  if ((snapshotConfig.channels !== undefined && (!Array.isArray(snapshotConfig.channels) ||
      snapshotConfig.channels.some(channel => typeof channel !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(channel)))) ||
      (snapshotConfig.defaultChannel !== undefined && (typeof snapshotConfig.defaultChannel !== 'string' ||
       !/^[a-zA-Z0-9_-]{1,100}$/.test(snapshotConfig.defaultChannel)))) throw unsafeSnapshot();
  const config = { ...currentConfig, name: projectId };
  for (const field of PROJECT_METADATA) {
    if (Object.hasOwn(snapshotConfig, field)) config[field] = snapshotConfig[field];
    else delete config[field];
  }
  return config;
}

/** Read the live execution contract (including processes still exiting) and running Loop records. */
export function listProjectRecoveryAttempts(projectId, { executionContract, loopStore } = {}) {
  const attempts = [];
  for (const attemptId of executionContract?.getActiveAttemptIds() ?? []) {
    const attempt = executionContract.getAttempt(attemptId);
    if (attempt?.projectId === projectId) {
      attempts.push({ attemptId, taskId: attempt.taskId, subtaskId: attempt.subtaskId, status: attempt.status });
    }
  }
  for (const run of loopStore?.listRuns() ?? []) {
    if (run.provenance?.scope?.projectId === projectId && ['running', 'cancelling', 'finalizing'].includes(run.phase)) {
      attempts.push({ runId: run.runId, status: run.phase });
    }
  }
  return attempts;
}

export function assertRecoveryIdle(blockingLiveAttempts) {
  if (!Array.isArray(blockingLiveAttempts)) throw recoveryError('RECOVERY_ATTEMPTS_UNAVAILABLE', 'Could not verify live runtime attempts');
  if (blockingLiveAttempts.length) {
    throw Object.assign(recoveryError('RECOVERY_BLOCKED_LIVE_ATTEMPTS', 'Project has live runtime attempts'), { blockingLiveAttempts });
  }
}

function readText(path) {
  return assertRecoveryFile(path) ? readFileSync(path, 'utf8') : null;
}

function atomicWrite(path, content) {
  const tmp = path + '.tmp.' + randomUUID();
  try {
    writeFileSync(tmp, content, { flag: 'wx', mode: 0o600, flush: true });
    renameSync(tmp, path);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      try { unlinkSync(tmp); } catch { /* error preserved */ }
    }
    throw err;
  }
}

function parseObject(content) {
  let data;
  try { data = JSON.parse(content); } catch { throw unsafeSnapshot(); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw unsafeSnapshot();
  return data;
}

export function createSnapshotManager({ stateManager, campaignManager, taskManager, listLiveAttempts = () => [] }) {
  const managed = new Map([
    ['campaigns.json', { manager: campaignManager, key: 'campaigns' }],
    ['tasks.json', { manager: taskManager, key: 'tasks' }],
  ]);

  function projectDir(projectId) {
    return resolve(stateManager.projectsDir, assertSafeProjectId(projectId));
  }

  function snapshotsDir(projectId) {
    return join(projectDir(projectId), 'snapshots');
  }

  function assertEntry(projDir, path) {
    if (typeof path !== 'string' || (!STATE_FILES.includes(path) && !TRANSCRIPT.test(path))) throw unsafeSnapshot();
    assertRecoveryFile(join(projDir, path));
    if (managed.get(path)?.manager) assertRecoveryStateDb(projDir);
  }

  function discoverTranscripts(projDir) {
    const channels = join(projDir, 'channels');
    if (!directoryExists(channels)) return [];
    return readdirSync(channels, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => `channels/${entry.name}/transcript.jsonl`)
      .filter(path => TRANSCRIPT.test(path));
  }

  function captureFiles(projectId, paths) {
    const projDir = projectDir(projectId);
    const data = [];
    const absentFiles = [];
    // Finish path validation before loading either state manager.
    for (const path of paths) assertEntry(projDir, path);
    for (const path of paths) {
      const entry = managed.get(path);
      let content;
      if (entry?.manager) {
        const current = entry.manager.load(projectId);
        if (current?._loadFailed || !Array.isArray(current?.[entry.key])) {
          throw recoveryError('RECOVERY_BACKUP_FAILED', 'Project state could not be captured');
        }
        content = JSON.stringify(current, null, 2);
      } else {
        content = readText(join(projDir, path));
      }
      if (content === null) absentFiles.push(path);
      else data.push({ path, content });
    }
    return { data, absentFiles };
  }

  function writeSnapshot(projectId, { data, absentFiles, reason, verify = false }) {
    const projDir = projectDir(projectId);
    const snapDir = snapshotsDir(projectId);
    if (!directoryExists(projDir) && verify) throw unsafeSnapshot();
    if (!directoryExists(snapDir)) mkdirSync(snapDir, { recursive: true, mode: 0o700 });
    if (!directoryExists(snapDir)) throw unsafeSnapshot();
    const snapshotId = `snap_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const metadata = {
      snapshotId, projectId, createdAt: new Date().toISOString(), reason: reason || null, files: data.map(f => f.path),
    };
    const envelope = { ...metadata, data, ...(absentFiles?.length ? { absentFiles } : {}) };
    const path = join(snapDir, `${snapshotId}.json`);
    const serialized = JSON.stringify(envelope, null, 2) + '\n';
    atomicWrite(path, serialized);
    if (verify && readText(path) !== serialized) {
      throw recoveryError('RECOVERY_BACKUP_FAILED', 'Pre-restore snapshot failed read-back verification');
    }
    return metadata;
  }

  function createSnapshot(projectId, { reason } = {}) {
    const projDir = projectDir(projectId);
    const { data } = captureFiles(projectId, [...STATE_FILES, ...discoverTranscripts(projDir)]);
    const metadata = writeSnapshot(projectId, { data, reason });
    pruneSnapshots(projectId);
    return metadata;
  }

  function readEnvelope(projectId, snapshotId) {
    if (typeof snapshotId !== 'string' || !SNAPSHOT_ID.test(snapshotId)) throw unsafeSnapshot();
    const raw = readText(join(snapshotsDir(projectId), `${snapshotId}.json`));
    if (raw === null) return null;
    const envelope = parseObject(raw);
    if (envelope.projectId !== projectId || envelope.snapshotId !== snapshotId ||
        !Number.isFinite(Date.parse(envelope.createdAt))) throw unsafeSnapshot();
    return envelope;
  }

  function getSnapshot(projectId, snapshotId) {
    try { return readEnvelope(projectId, snapshotId); } catch { return null; }
  }

  function listSnapshots(projectId) {
    const snapDir = snapshotsDir(projectId);
    if (!directoryExists(snapDir)) return [];
    return readdirSync(snapDir)
      .filter(filename => filename.endsWith('.json'))
      .map(filename => getSnapshot(projectId, filename.slice(0, -5)))
      .filter(Boolean)
      .map(({ snapshotId, projectId, createdAt, reason, files }) => ({ snapshotId, projectId, createdAt, reason, files }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function inspectRestore({ projectId, snapshotId }) {
    const projDir = projectDir(projectId);
    const snapshot = readEnvelope(projectId, snapshotId);
    const blockingLiveAttempts = listLiveAttempts(projectId);
    if (!Array.isArray(blockingLiveAttempts)) assertRecoveryIdle(blockingLiveAttempts);
    const entries = new Map();
    if (snapshot) {
      const { files, data, createdAt, absentFiles = [] } = snapshot;
      if (!Number.isFinite(Date.parse(createdAt)) || !Array.isArray(data) || !Array.isArray(absentFiles) ||
          !Array.isArray(files) || files.length !== data.length) throw unsafeSnapshot();
      for (const [i, entry] of data.entries()) {
        const { path, content } = entry ?? {};
        assertEntry(projDir, path);
        if (files[i] !== path || entries.has(path) || typeof content !== 'string') throw unsafeSnapshot();
        const parsed = path.endsWith('.json') ? parseObject(content) : null;
        const spec = managed.get(path);
        if (spec && !Array.isArray(parsed[spec.key])) throw unsafeSnapshot();
        if (path === 'config.json') {
          const currentText = readText(join(projDir, path));
          const current = currentText === null ? stateManager.getProject?.(projectId) : parseObject(currentText);
          const safeConfig = prepareRecoveryConfig(parsed, current, projectId);
          entries.set(path, { content: JSON.stringify(safeConfig, null, 2) + '\n', parsed: safeConfig });
        } else {
          entries.set(path, { content, parsed });
        }
      }
      for (const path of absentFiles) {
        assertEntry(projDir, path);
        if (entries.has(path) || managed.get(path)?.manager) throw unsafeSnapshot();
        entries.set(path, null);
      }
    }
    return { entries, preview: {
      projectId, snapshotId, exists: Boolean(snapshot), safeToRestore: Boolean(snapshot) && !blockingLiveAttempts.length,
      willReplace: [...entries.keys()], blockingLiveAttempts, scope: 'project-local-only', preRestoreSnapshotWillBeCreated: true,
    } };
  }

  function previewProjectRestore(options) {
    return inspectRestore(options).preview;
  }

  function createPreRestoreSnapshot(projectId, paths, restoredSnapshotId) {
    const captured = captureFiles(projectId, paths);
    const backup = writeSnapshot(projectId, {
      ...captured, reason: `pre-restore: ${restoredSnapshotId}`, verify: true,
    });
    const { preview } = inspectRestore({ projectId, snapshotId: backup.snapshotId });
    assertRecoveryIdle(preview.blockingLiveAttempts);
    if (!preview.exists || preview.willReplace.length !== paths.length) {
      throw recoveryError('RECOVERY_BACKUP_FAILED', 'Pre-restore snapshot failed recovery validation');
    }
    return { ...captured, preRestoreSnapshotId: backup.snapshotId };
  }

  function applyEntry(projectId, path, entry) {
    const projDir = projectDir(projectId);
    assertEntry(projDir, path);
    const manager = managed.get(path)?.manager;
    if (manager) {
      manager.restoreState(projectId, entry.parsed);
      return;
    }
    const target = join(projDir, path);
    if (entry) {
      mkdirSync(dirname(target), { recursive: true });
      atomicWrite(target, entry.content);
    } else if (assertRecoveryFile(target)) {
      unlinkSync(target);
    }
  }

  function restoreSnapshot(projectId, snapshotId) {
    const { entries, preview } = inspectRestore({ projectId, snapshotId });
    if (!preview.exists) throw recoveryError('RECOVERY_SNAPSHOT_NOT_FOUND', 'Snapshot not found', 404);
    assertRecoveryIdle(preview.blockingLiveAttempts);
    const paths = [...entries.keys()];
    const { data, preRestoreSnapshotId } = createPreRestoreSnapshot(projectId, paths, snapshotId);
    const original = new Map(data.map(({ path, content }) => [path, {
      content, parsed: managed.get(path)?.manager ? parseObject(content) : null,
    }]));
    const applied = [];
    try {
      for (const [path, entry] of entries) {
        applied.push(path);
        applyEntry(projectId, path, entry);
      }
      if (entries.get('config.json')) stateManager._loadProject?.(projectId);
      taskManager?._requeueCounts?.clear?.();
      taskManager?._completedSinceAudit?.delete?.(projectId);
    } catch {
      let rollbackFailed = false;
      for (const path of applied.reverse()) {
        try { applyEntry(projectId, path, original.get(path) ?? null); }
        catch { rollbackFailed = true; }
      }
      if (!rollbackFailed) {
        taskManager?._requeueCounts?.clear?.();
        taskManager?._completedSinceAudit?.delete?.(projectId);
      }
      throw Object.assign(recoveryError('RECOVERY_RESTORE_FAILED', rollbackFailed
        ? 'Restore failed and rollback was incomplete' : 'Restore failed and was rolled back', 500), { preRestoreSnapshotId });
    }
    return {
      restored: paths.length, files: paths,
      versions: {
        campaigns: entries.get('campaigns.json')?.parsed?.version ?? null,
        tasks: entries.get('tasks.json')?.parsed?.version ?? null,
      },
      restoredSnapshotId: snapshotId, preRestoreSnapshotId,
    };
  }

  function deleteSnapshot(projectId, snapshotId) {
    if (!getSnapshot(projectId, snapshotId)) return false;
    try { unlinkSync(join(snapshotsDir(projectId), `${snapshotId}.json`)); return true; }
    catch { return false; }
  }

  function pruneSnapshots(projectId, maxCount = 10) {
    let deleted = 0;
    for (const { snapshotId } of listSnapshots(projectId).slice(maxCount)) {
      if (deleteSnapshot(projectId, snapshotId)) deleted++;
    }
    return deleted;
  }

  return {
    createSnapshot, listSnapshots, getSnapshot, listLiveAttempts, previewProjectRestore,
    createPreRestoreSnapshot, restoreSnapshot, deleteSnapshot, pruneSnapshots,
  };
}
