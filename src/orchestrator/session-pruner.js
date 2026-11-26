/**
 * Phase 1B.2 — Attributable-Only Harness Session Pruner.
 *
 * Hardened per GPT-6.2 Sol Round 1 & Round 2 reviews:
 *  - Records file identity (`ino`, `dev`, `mtimeMs`, `size`) alongside `absPath`
 *    and verifies `ino`/`dev` match before deletion.
 *  - Groups ledger rows by `(dev, ino)` using `max(createdAt)` and the union of
 *    active sessionIds before pruning, so an older row for a resumed session NEVER
 *    deletes an inode refreshed by a newer row.
 *  - Uses an owner-token O_EXCL lockfile (never evicts a live PID's lock; verifies
 *    exact owner token before unlinking in `finally`).
 *  - Uses atomic non-clobbering `linkSync` + inode verification + `unlinkSync`
 *    so deletion never overwrites an existing sibling file.
 */

import {
  appendFileSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'fs';
import { dirname, resolve as pathResolve, sep } from 'path';
import { randomUUID } from 'crypto';

const LOCK_STALE_DEAD_PID_MS = 30_000;

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function withFileLock(targetPath, fn) {
  const lockPath = `${targetPath}.lock`;
  mkdirSync(dirname(targetPath), { recursive: true });
  const ownerToken = `${process.pid}:${Date.now()}:${randomUUID()}`;
  const deadline = Date.now() + 5000;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, ownerToken, 'utf8');
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const st = statSync(lockPath);
        const ageMs = Date.now() - st.mtimeMs;
        const holderRaw = readFileSync(lockPath, 'utf8').trim();
        const holderPid = Number(holderRaw.split(':')[0]);
        const holderAlive = isPidAlive(holderPid);
        // Only evict a stale lock when its owning PID is no longer alive.
        if (!holderAlive && ageMs > LOCK_STALE_DEAD_PID_MS) {
          try {
            if (readFileSync(lockPath, 'utf8').trim() === holderRaw) {
              unlinkSync(lockPath);
            }
          } catch {}
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring lock: ${lockPath}`);
      }
      const waitUntil = Date.now() + 10;
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch {}
    // Only unlink if the lockfile still belongs to this ownerToken!
    try {
      if (readFileSync(lockPath, 'utf8') === ownerToken) {
        unlinkSync(lockPath);
      }
    } catch {}
  }
}

/**
 * Append a Synapse-created session attribution record (with file identity ino/dev)
 * to the JSONL ledger under the owner-verified ledger lock.
 */
export function recordAttributedSession({
  ledgerPath,
  sessionId,
  harness,
  absPath,
  projectId = null,
  createdAt = new Date().toISOString(),
} = {}) {
  if (!ledgerPath || !sessionId || !absPath) {
    throw new Error('recordAttributedSession requires ledgerPath, sessionId, and absPath');
  }
  const resolved = pathResolve(String(absPath));
  let ino = null;
  let dev = null;
  let size = null;
  let mtimeMs = null;
  if (existsSync(resolved)) {
    const lst = lstatSync(resolved);
    if (lst.isFile() && !lst.isSymbolicLink()) {
      ino = lst.ino;
      dev = lst.dev;
      size = lst.size;
      mtimeMs = lst.mtimeMs;
    }
  }

  const entry = {
    sessionId: String(sessionId),
    harness: String(harness || 'unknown'),
    absPath: resolved,
    ino,
    dev,
    size,
    mtimeMs,
    projectId: projectId ? String(projectId) : null,
    createdAt: typeof createdAt === 'number' ? new Date(createdAt).toISOString() : String(createdAt),
  };

  return withFileLock(ledgerPath, () => {
    appendFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  });
}

/**
 * Prune ONLY ledger-attributed inactive session files whose LATEST attribution
 * for that `(dev, ino)` is older than `maxAgeHours` and whose realpath is strictly
 * confined under one of `roots`.
 */
export function pruneAttributedSessions({
  ledgerPath,
  roots = [],
  activeSessionIds = new Set(),
  now = Date.now(),
  maxAgeHours = 72,
  dryRun = false,
} = {}) {
  if (!ledgerPath || !existsSync(ledgerPath)) {
    return { scanned: 0, pruned: [], skipped: [], kept: [] };
  }

  const activeSet = activeSessionIds instanceof Set
    ? activeSessionIds
    : new Set(Array.isArray(activeSessionIds) ? activeSessionIds : []);

  const canonicalRoots = (roots || [])
    .filter(Boolean)
    .map(r => {
      try {
        return existsSync(r) ? realpathSync(r) : pathResolve(r);
      } catch {
        return pathResolve(r);
      }
    });

  const maxAgeMs = Math.max(0, Number(maxAgeHours) || 0) * 3600_000;

  return withFileLock(ledgerPath, () => {
    if (!existsSync(ledgerPath)) {
      return { scanned: 0, pruned: [], skipped: [], kept: [] };
    }

    const rawLines = readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter(Boolean);
    const pruned = [];
    const skipped = [];
    const keptEntries = [];

    // Group rows by (dev, ino) so repeat attributions of a resumed session use max(createdAt)
    // and protect the inode if ANY sessionId on that inode is active.
    const groups = new Map();

    for (const line of rawLines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        skipped.push({ reason: 'corrupt_ledger_line' });
        continue;
      }
      if (!entry || !entry.absPath || !entry.sessionId) {
        skipped.push({ reason: 'incomplete_ledger_entry' });
        continue;
      }
      if (entry.ino == null || entry.dev == null) {
        skipped.push({ sessionId: entry.sessionId, absPath: entry.absPath, reason: 'inode_identity_mismatch' });
        continue;
      }

      const ts = Date.parse(entry.createdAt || '');
      const validTs = Number.isFinite(ts) ? ts : null;
      const key = `${entry.dev}:${entry.ino}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          dev: entry.dev,
          ino: entry.ino,
          maxCreatedAtMs: validTs,
          hasInvalidTs: validTs === null,
          hasActive: activeSet.has(entry.sessionId),
          latestEntry: entry,
          latestTs: validTs ?? -Infinity,
          entries: [entry],
        });
      } else {
        existing.entries.push(entry);
        if (activeSet.has(entry.sessionId)) existing.hasActive = true;
        if (validTs === null) {
          existing.hasInvalidTs = true;
        } else if (existing.maxCreatedAtMs === null || validTs > existing.maxCreatedAtMs) {
          existing.maxCreatedAtMs = validTs;
          existing.latestEntry = entry;
          existing.latestTs = validTs;
        }
      }
    }

    for (const group of groups.values()) {
      const entry = group.latestEntry;
      if (group.hasActive) {
        skipped.push({ sessionId: entry.sessionId, absPath: entry.absPath, reason: 'active_session' });
        for (const ge of group.entries) keptEntries.push(ge);
        continue;
      }

      if (group.maxCreatedAtMs === null) {
        skipped.push({ sessionId: entry.sessionId, absPath: entry.absPath, reason: 'invalid_timestamp' });
        for (const ge of group.entries) keptEntries.push(ge);
        continue;
      }

      if (now - group.maxCreatedAtMs < maxAgeMs) {
        skipped.push({ sessionId: entry.sessionId, absPath: entry.absPath, reason: 'not_expired' });
        for (const ge of group.entries) keptEntries.push(ge);
        continue;
      }

      const targetPath = pathResolve(String(entry.absPath));
      if (!existsSync(targetPath)) {
        skipped.push({ sessionId: entry.sessionId, absPath: targetPath, reason: 'missing_on_disk' });
        continue;
      }

      let lst;
      let realTarget;
      try {
        lst = lstatSync(targetPath);
        if (lst.isSymbolicLink() || !lst.isFile()) {
          skipped.push({ sessionId: entry.sessionId, absPath: targetPath, reason: 'not_regular_file' });
          for (const ge of group.entries) keptEntries.push(ge);
          continue;
        }
        realTarget = realpathSync(targetPath);
      } catch {
        skipped.push({ sessionId: entry.sessionId, absPath: targetPath, reason: 'stat_failed' });
        for (const ge of group.entries) keptEntries.push(ge);
        continue;
      }

      // Verify inode identity matches recorded attribution (never delete a replacement file!)
      if (lst.ino !== group.ino || lst.dev !== group.dev) {
        skipped.push({ sessionId: entry.sessionId, absPath: targetPath, reason: 'inode_identity_mismatch' });
        continue;
      }

      const canonicalParent = realpathSync(dirname(targetPath));
      const leaf = targetPath.slice(dirname(targetPath).length + (dirname(targetPath).endsWith(sep) ? 0 : 1));
      const canonicalLedgerPath = canonicalParent + sep + leaf;
      const inAllowedRoot = canonicalRoots.length > 0 && canonicalRoots.some(root => realTarget.startsWith(root + sep));
      if (!inAllowedRoot || realTarget !== canonicalLedgerPath) {
        skipped.push({ sessionId: entry.sessionId, absPath: targetPath, reason: 'outside_allowed_roots' });
        for (const ge of group.entries) keptEntries.push(ge);
        continue;
      }

      if (dryRun) {
        pruned.push({ sessionId: entry.sessionId, absPath: realTarget, dryRun: true });
        for (const ge of group.entries) keptEntries.push(ge);
        continue;
      }

      // Atomic non-clobbering quarantine via hard link (POSIX link() fails with EEXIST if dest exists)
      const deletingPath = `${realTarget}.deleting.${process.pid}.${randomUUID().slice(0, 8)}`;
      let stagedCreated = false;
      try {
        linkSync(realTarget, deletingPath);
        stagedCreated = true;
        const qStat = lstatSync(deletingPath);
        if (qStat.ino !== group.ino || qStat.dev !== group.dev) {
          skipped.push({ sessionId: entry.sessionId, absPath: realTarget, reason: 'inode_identity_mismatch' });
          continue;
        }
        // Re-verify target still points to the same inode right before unlinking
        const preUnlink = lstatSync(realTarget);
        if (preUnlink.ino !== group.ino || preUnlink.dev !== group.dev) {
          skipped.push({ sessionId: entry.sessionId, absPath: realTarget, reason: 'inode_identity_mismatch' });
          continue;
        }
        unlinkSync(realTarget);
        pruned.push({ sessionId: entry.sessionId, absPath: realTarget, dryRun: false });
      } catch (err) {
        if (err?.code === 'ENOENT') {
          skipped.push({ sessionId: entry.sessionId, absPath: realTarget, reason: 'enoent' });
        } else {
          skipped.push({ sessionId: entry.sessionId, absPath: realTarget, reason: `prune_error:${err.message}` });
          for (const ge of group.entries) keptEntries.push(ge);
        }
      } finally {
        // ONLY unlink deletingPath if THIS call created it (never delete a pre-existing file on EEXIST!)
        if (stagedCreated) {
          try { unlinkSync(deletingPath); } catch {}
        }
      }
    }

    if (!dryRun) {
      const tmpLedger = `${ledgerPath}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
      const body = keptEntries.length > 0 ? keptEntries.map(e => JSON.stringify(e)).join('\n') + '\n' : '';
      writeFileSync(tmpLedger, body, 'utf8');
      renameSync(tmpLedger, ledgerPath);
    }

    return {
      scanned: rawLines.length,
      pruned,
      skipped,
      kept: keptEntries,
    };
  });
}
