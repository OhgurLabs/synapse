import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assertSafeProjectId } from '../safe-id.js';
import { openDatabase } from './sqlite-provider.js';

function statIfPresent(path) {
  try { return lstatSync(path); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function checkDirectory(path, create) {
  const info = statIfPresent(path);
  if (info) {
    if (!info.isDirectory() || realpathSync(path) !== path) throw new Error('Unsafe project storage directory');
    return true;
  }
  if (!create) return false;
  checkDirectory(dirname(path), true);
  mkdirSync(path, { recursive: true });
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('Unsafe project storage directory');
  return true;
}

export function assertRegularProjectFile(path) {
  if (!checkDirectory(dirname(path), false)) return false;
  const info = statIfPresent(path);
  if (!info) return false;
  if (!info.isFile() || info.nlink !== 1) throw new Error('Unsafe project storage file');
  return true;
}

export function withProjectLocalDb(synapseDir, projectId, filename, { write = false } = {}, operation) {
  if (typeof filename !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}\.sqlite$/.test(filename)) {
    throw new Error('Invalid project storage filename');
  }
  const directory = resolve(synapseDir, 'projects', assertSafeProjectId(projectId));
  const path = join(directory, filename);
  if (!checkDirectory(directory, write)) return null;
  const exists = assertRegularProjectFile(path);
  for (const suffix of ['-wal', '-shm', '-journal']) assertRegularProjectFile(path + suffix);
  if (!exists && !write) return null;
  const db = openDatabase(path, { readonly: !write });
  try {
    return operation(db);
  } finally {
    db.close();
  }
}
