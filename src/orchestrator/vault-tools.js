/**
 * Scoped Vault Pull and Propose Tools.
 *
 * Security invariants (hardened per GPT-6.2 Sol review):
 *  - assertSafeProjectId rejects traversal / slashes / null bytes
 *  - Vault root MUST be a real (non-symlink) subdirectory strictly inside <projectDir>
 *    (never <projectDir> itself, never a symlink redirecting elsewhere)
 *  - `.proposals` MUST be a real (non-symlink) subdirectory strictly inside <vaultRoot>
 *  - Post-realpathSync canonical exclusion blocks ANY in-vault symlink targeting `.proposals`, `.git`, or `node_modules`
 *  - Bounded fd reads (`readBoundedUtf8`) prevent large-file OOM; visited inode tracking prevents symlink cycles
 */

import {
  existsSync, mkdirSync, opendirSync, realpathSync, renameSync,
  statSync, writeFileSync, lstatSync, openSync, readSync, closeSync, fstatSync, constants,
} from 'fs';
import { join, dirname, resolve as pathResolve, sep, relative } from 'path';
import { createHash, randomUUID } from 'crypto';
import { withProjectLocalDb } from '../persistence/project-local-db.js';

const SAFE_PROJECT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const DEFAULT_MAX_SEARCH_RESULTS = 20;
const DEFAULT_MAX_READ_CHARS = 16_000;
const MAX_WALK_ENTRIES = 5000;
const EXCLUDED_SEGMENTS = new Set(['.proposals', '.git', 'node_modules']);

export function assertSafeProjectId(projectId) {
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new Error('Invalid projectId: must be a non-empty string');
  }
  const trimmed = projectId.trim();
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0') || !SAFE_PROJECT_ID_RE.test(trimmed)) {
    throw new Error(`Unsafe projectId rejected: "${trimmed}"`);
  }
  return trimmed;
}

/**
 * Bounded UTF-8 file read without loading an entire huge file into memory.
 */
function readBoundedUtf8(filePath, maxBytes, { strict = false } = {}) {
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (strict && realpathSync(`/proc/self/fd/${fd}`) !== filePath)) {
      throw new Error('Vault read requires a confined regular file');
    }
    if (strict) {
      const entry = lstatSync(filePath);
      if (!entry.isFile() || entry.dev !== st.dev || entry.ino !== st.ino) {
        throw new Error('Vault read requires a confined regular file');
      }
      if (entry.nlink !== 1 || st.nlink !== 1) throw new Error('Vault read refuses hardlinks');
    }
    const totalBytes = st.size;
    const toRead = Math.min(totalBytes, Math.max(1, maxBytes));
    const buf = Buffer.allocUnsafe(toRead);
    let offset = 0;
    while (offset < toRead) {
      const n = readSync(fd, buf, offset, toRead - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return {
      text: buf.subarray(0, offset).toString('utf8'),
      bytesRead: offset,
      totalBytes,
    };
  } finally {
    closeSync(fd);
  }
}

function realpathNearestExisting(targetPath) {
  const abs = pathResolve(targetPath);
  const tail = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cur = parent;
  }
  const realBase = existsSync(cur) ? realpathSync(cur) : cur;
  return tail.length > 0 ? join(realBase, ...tail) : realBase;
}

/**
 * Verify every existing path component from `baseDir` down to `targetDir` is NOT a symlink
 * and that `targetDir` is strictly a descendant of `baseDir` (never equal to `baseDir`).
 */
function assertStrictNonSymlinkSubdir(baseDir, relPath, label) {
  const canonicalBase = existsSync(baseDir) ? realpathSync(baseDir) : pathResolve(baseDir);
  const segs = String(relPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (segs.length === 0 || segs.some(s => s === '.' || s === '..')) {
    throw new Error(`${label} must be a non-empty relative subdirectory inside projectDir`);
  }
  let cur = canonicalBase;
  for (const seg of segs) {
    cur = join(cur, seg);
    let lst = null;
    try { lst = lstatSync(cur); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    if (lst) {
      if (lst.isSymbolicLink()) {
        throw new Error(`${label} must not traverse or be a symlink: "${seg}"`);
      }
      if (!lst.isDirectory()) {
        throw new Error(`${label} component is not a directory: "${seg}"`);
      }
    }
  }
  const expected = pathResolve(canonicalBase, ...segs);
  if (expected === canonicalBase || !expected.startsWith(canonicalBase + sep)) {
    throw new Error(`${label} escapes base directory`);
  }
  if (existsSync(expected) && realpathSync(expected) !== expected) {
    throw new Error(`${label} canonical path mismatch (symlink redirect rejected)`);
  }
  return expected;
}

function hasExcludedCanonicalSegment(canonicalRoot, canonicalTarget) {
  const rel = relative(canonicalRoot, canonicalTarget).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || rel.startsWith('/')) return true;
  return rel.split('/').some(seg => EXCLUDED_SEGMENTS.has(seg));
}

/**
 * Resolve and strictly confine the vault root for `projectId`.
 * Refuses `<projectDir>` itself and refuses any symlinked `vault` directory.
 */
export function resolveProjectVault(projectId, { stateManager = null, projectDir = null, vaultRelPath = null } = {}) {
  const safeId = assertSafeProjectId(projectId);
  const proj = stateManager?.getProject?.(safeId) || null;
  const ctxCfg = stateManager?.getProjectContextConfig?.(safeId) || proj?.contextConfig || null;

  if (ctxCfg && ctxCfg.vault && ctxCfg.vault.enabled === false) {
    throw new Error(`Vault access is disabled for project "${safeId}"`);
  }

  const baseDirRaw = projectDir || proj?.projectDir;
  if (!baseDirRaw || typeof baseDirRaw !== 'string') {
    throw new Error(`Project "${safeId}" has no projectDir configured`);
  }
  const canonicalProject = existsSync(baseDirRaw) ? realpathSync(baseDirRaw) : pathResolve(baseDirRaw);
  const relVault = (vaultRelPath ?? ctxCfg?.vault?.path ?? 'vault');
  if (
    typeof relVault !== 'string' ||
    !relVault.trim() ||
    relVault.trim() === '.' ||
    relVault.startsWith('/') ||
    /^[a-zA-Z]:/.test(relVault) ||
    relVault.split(/[\\/]/).includes('..') ||
    /[\u0000-\u001F\u007F]/.test(relVault)
  ) {
    throw new Error(`Unsafe vault path configuration for project "${safeId}"`);
  }

  const vaultRoot = assertStrictNonSymlinkSubdir(canonicalProject, relVault.trim(), `Vault root for "${safeId}"`);
  return {
    projectId: safeId,
    projectDir: canonicalProject,
    vaultRoot,
  };
}

/**
 * Confine a relative path strictly under `vaultRoot` via realpath verification.
 * Applies `.proposals` / `.git` / `node_modules` exclusion AFTER realpathSync so
 * in-vault symlinks cannot bypass confidentiality!
 */
export function assertConfinedVaultPath(vaultRoot, relPath, { allowMissingLeaf = false, disallowProposals = true } = {}) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error('relPath must be a non-empty relative path');
  }
  const normalized = relPath.replace(/\\/g, '/').trim();
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    /[\u0000-\u001F\u007F]/.test(normalized) ||
    normalized.split('/').some(seg => seg === '..' || seg === '.')
  ) {
    throw new Error(`Unsafe vault relPath rejected: "${relPath}"`);
  }
  if (disallowProposals && normalized.split('/').some(seg => EXCLUDED_SEGMENTS.has(seg))) {
    throw new Error(`Direct access to excluded vault path is prohibited: "${relPath}"`);
  }

  const canonicalRoot = realpathNearestExisting(vaultRoot);
  const candidate = pathResolve(canonicalRoot, normalized);

  if (!allowMissingLeaf && !existsSync(candidate)) {
    throw new Error(`Vault note not found: "${relPath}"`);
  }

  const canonicalTarget = allowMissingLeaf
    ? realpathNearestExisting(candidate)
    : realpathSync(candidate);

  if (canonicalTarget === canonicalRoot || !canonicalTarget.startsWith(canonicalRoot + sep)) {
    throw new Error(`Vault path escapes project vault root: "${relPath}"`);
  }

  // P1 #2: Enforce excluded directory check on the CANONICAL resolved target (blocks in-vault symlinks into .proposals!)
  if (disallowProposals && hasExcludedCanonicalSegment(canonicalRoot, canonicalTarget)) {
    throw new Error(`Vault path resolves into excluded directory (.proposals/.git/node_modules): "${relPath}"`);
  }

  return {
    relPath: relative(canonicalRoot, canonicalTarget).replace(/\\/g, '/'),
    absPath: canonicalTarget,
    vaultRoot: canonicalRoot,
  };
}

function extractMarkdownHeadings(content) {
  const headings = [];
  for (const line of String(content || '').split('\n')) {
    const m = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (m) headings.push(m[1]);
    if (headings.length >= 12) break;
  }
  return headings;
}

/**
 * Search filenames & headings inside a project's vault.
 * Tracks visited dir inodes (cycle-safe), caps traversal budget, uses bounded reads,
 * and rejects canonical targets under `.proposals` / `.git` / `node_modules`.
 */
export function vaultSearch({ projectId, query = '', limit = DEFAULT_MAX_SEARCH_RESULTS, stateManager = null, projectDir = null, vaultRelPath = null } = {}) {
  const { projectId: safeId, vaultRoot } = resolveProjectVault(projectId, { stateManager, projectDir, vaultRelPath });
  const cappedLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_MAX_SEARCH_RESULTS), DEFAULT_MAX_SEARCH_RESULTS);
  const q = String(query || '').trim().toLowerCase();

  if (!existsSync(vaultRoot)) {
    return { projectId: safeId, query: q, results: [] };
  }

  const results = [];
  const visitedDirs = new Set();
  let scannedEntries = 0;

  const walk = (dir) => {
    if (results.length >= cappedLimit || scannedEntries >= MAX_WALK_ENTRIES) return;
    let dirStat;
    try { dirStat = statSync(dir); } catch { return; }
    const dirKey = `${dirStat.dev}:${dirStat.ino}`;
    if (visitedDirs.has(dirKey)) return;
    visitedDirs.add(dirKey);

    let dirHandle;
    try {
      dirHandle = opendirSync(dir);
    } catch {
      return;
    }
    try {
      while (results.length < cappedLimit && scannedEntries < MAX_WALK_ENTRIES) {
        const ent = dirHandle.readSync();
        if (ent === null) break;
        scannedEntries++;
        if (EXCLUDED_SEGMENTS.has(ent.name)) continue;

      const full = join(dir, ent.name);
      let real;
      try {
        real = realpathSync(full);
      } catch {
        continue;
      }

      // P1 #2: Check containment AND excluded segments AFTER realpathSync!
      if (!real.startsWith(vaultRoot + sep) || hasExcludedCanonicalSegment(vaultRoot, real)) {
        continue;
      }

      let st;
      try { st = statSync(real); } catch { continue; }
      if (st.isDirectory()) {
        walk(real);
      } else if (st.isFile() && /\.(md|txt|json)$/i.test(ent.name)) {
        const rel = relative(vaultRoot, real).replace(/\\/g, '/');
        let headings = [];
        try {
          const { text } = readBoundedUtf8(real, 8192);
          headings = extractMarkdownHeadings(text);
        } catch { /* ignore unreadable */ }

        const haystack = `${rel} ${headings.join(' ')}`.toLowerCase();
        if (!q || haystack.includes(q)) {
          results.push({
            relPath: rel,
            title: headings[0] || ent.name,
            headings,
          });
        }
      }
      }
    } finally {
      try { dirHandle.closeSync(); } catch {}
    }
  };

  walk(vaultRoot);
  return { projectId: safeId, query: q, results };
}

/**
 * Confined bounded read of a single note inside `<projectDir>/vault`.
 */
export function vaultRead({
  projectId, relPath, maxChars = DEFAULT_MAX_READ_CHARS, stateManager = null, projectDir = null,
  vaultRelPath = null, actor = null, runId = null,
} = {}) {
  const vault = resolveProjectVault(projectId, { stateManager, projectDir, vaultRelPath });
  const { absPath, relPath: cleanRel } = assertConfinedVaultPath(vault.vaultRoot, relPath);
  const requested = relPath.replace(/\\/g, '/').trim();
  if (pathResolve(vault.vaultRoot, requested) !== absPath || Buffer.byteLength(cleanRel) > 4096) {
    throw new Error('Vault read refuses a symlink or overlong document path');
  }
  // Compare each component to reject symlinks even when they resolve to the same canonical path.
  let component = vault.vaultRoot;
  for (const segment of requested.split('/').filter(Boolean)) {
    component = join(component, segment);
    if (lstatSync(component).isSymbolicLink()) throw new Error('Vault read refuses symlinks');
  }

  const cap = Math.trunc(Math.min(Math.max(1, Number(maxChars) || DEFAULT_MAX_READ_CHARS), 64_000));
  const { text, totalBytes, bytesRead } = readBoundedUtf8(absPath, cap * 4, { strict: true });
  const content = text.slice(0, cap);
  const returned = Buffer.from(content, 'utf8');
  const safeOptionalId = value => typeof value === 'string' && Buffer.byteLength(value) <= 256 ? value : null;
  const storageDir = stateManager?.baseDir || join(vault.projectDir, '.synapse');
  withProjectLocalDb(storageDir, vault.projectId, 'vault-read-receipts.sqlite', { write: true }, db => {
    db.exec(`CREATE TABLE IF NOT EXISTS vault_read_receipt (
      id INTEGER PRIMARY KEY,
      doc_path TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      actor TEXT,
      run_id TEXT
    )`);
    db.prepare(`INSERT INTO vault_read_receipt (doc_path, bytes, sha256, timestamp, actor, run_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      cleanRel, returned.length, createHash('sha256').update(returned).digest('hex'),
      new Date().toISOString(), safeOptionalId(actor), safeOptionalId(runId),
    );
  });
  return { projectId: vault.projectId, relPath: cleanRel, content, truncated: text.length > cap || bytesRead < totalBytes, totalBytes };
}

/**
 * Proposal-only write path: writes ONLY to `<vaultRoot>/.proposals/<id>.json`.
 * Verifies `.proposals` is NOT a symlink and stays strictly inside `vaultRoot`.
 */
export function vaultPropose({ projectId, relPath, body, agentId = 'unknown', rationale = null, stateManager = null, projectDir = null, vaultRelPath = null } = {}) {
  const { projectId: safeId, vaultRoot } = resolveProjectVault(projectId, { stateManager, projectDir, vaultRelPath });
  const { relPath: cleanRel } = assertConfinedVaultPath(vaultRoot, relPath, { allowMissingLeaf: true, disallowProposals: true });

  if (typeof body !== 'string' || !body.trim()) {
    throw new Error('Proposal body must be a non-empty string');
  }

  // P1 #1: Ensure vaultRoot itself is not a symlink and .proposals is strictly a real non-symlink child of vaultRoot
  mkdirSync(vaultRoot, { recursive: true });
  if (lstatSync(vaultRoot).isSymbolicLink() || realpathSync(vaultRoot) !== vaultRoot) {
    throw new Error('Refusing proposal write: vaultRoot is a symlink or redirected');
  }
  const expectedProposalsDir = assertStrictNonSymlinkSubdir(vaultRoot, '.proposals', 'Proposals directory');
  mkdirSync(expectedProposalsDir, { recursive: true });
  if (lstatSync(expectedProposalsDir).isSymbolicLink() || realpathSync(expectedProposalsDir) !== expectedProposalsDir) {
    throw new Error('Refusing proposal write: .proposals directory is a symlink or redirected');
  }

  const proposalId = `prop_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const proposalPath = join(expectedProposalsDir, `${proposalId}.json`);
  const tmpPath = `${proposalPath}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
  const payload = {
    id: proposalId,
    projectId: safeId,
    targetRelPath: cleanRel,
    agentId: String(agentId || 'unknown'),
    rationale: rationale ? String(rationale) : null,
    body,
    status: 'pending_review',
    createdAt: new Date().toISOString(),
  };

  writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' });
  renameSync(tmpPath, proposalPath);

  return {
    proposalId,
    proposalPath,
    targetRelPath: cleanRel,
    status: 'pending_review',
    agentId: payload.agentId,
  };
}
