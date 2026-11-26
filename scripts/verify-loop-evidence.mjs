#!/usr/bin/env node
/** Zero-network offline verifier for an extracted packet or standalone archive. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  captureEvidencePacketSnapshot, MAX_EVIDENCE_ARCHIVE_BYTES,
  verifyEvidenceArchive, verifyEvidencePacketSnapshot,
} from '../src/loop-evidence.js';
import { normalizeSafeRelativePath } from '../src/loops.js';

let input;
let archivePrivatePaths;
try {
  const { values, positionals } = parseArgs({
    options: { 'private-path': { type: 'string', multiple: true } },
    allowPositionals: true,
  });
  archivePrivatePaths = (values['private-path'] || []).map(path => {
    try {
      return normalizeSafeRelativePath(path);
    } catch (err) {
      throw new Error(`Invalid --private-path value: ${err.message}`);
    }
  });
  if (positionals.length !== 1) throw new Error('Expected one evidence packet directory or archive');
  [input] = positionals;
} catch (err) {
  console.error(err.message);
  console.error('Usage: node scripts/verify-loop-evidence.mjs [--private-path <relPath>]... <packet-dir-or-archive.json>');
  process.exit(2);
}

function verifyPath(input, archivePrivatePaths) {
  const path = resolve(input);
  if (realpathSync(path) !== path) throw new Error('Evidence path must not traverse symlinks');
  const info = lstatSync(path);
  if (info.isDirectory()) {
    // Verify the captured bytes, including the bundle's private-path history scan.
    const snapshot = captureEvidencePacketSnapshot(path);
    return verifyEvidencePacketSnapshot(snapshot, { archivePrivatePaths });
  }
  if (!info.isFile()) throw new Error('Evidence archive must be a regular file');

  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (realpathSync(`/proc/self/fd/${fd}`) !== path) throw new Error('Evidence archive path changed while being opened');
    if (!stat.isFile() || stat.size > MAX_EVIDENCE_ARCHIVE_BYTES) {
      throw new Error('Invalid evidence archive size or file type');
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read === 0) throw new Error('Evidence archive changed while being read');
      offset += read;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) {
      throw new Error('Evidence archive changed while being read');
    }
    return verifyEvidenceArchive(bytes, { archivePrivatePaths });
  } finally {
    closeSync(fd);
  }
}

let result;
try {
  result = verifyPath(input, archivePrivatePaths);
} catch (err) {
  result = { ok: false, errors: [err.message] };
}
if (result.ok) console.log(JSON.stringify(result, null, 2));
else console.error(JSON.stringify({ ok: false, errors: result.errors }, null, 2));
process.exitCode = result.ok ? 0 : 1;
