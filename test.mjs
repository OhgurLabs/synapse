#!/usr/bin/env node
// Test runner — discovers and runs all *.test.js files under src/, test/, and test subdirectories
// Uses Mocha for test discovery and execution

import { spawn } from 'child_process';
import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const __dirname = new URL('.', import.meta.url).pathname;

const srcFiles = readdirSync('src', { recursive: true })
  .filter(f => f.endsWith('.test.js'))
  .map(f => join(process.cwd(), 'src', f));

// Release trees ship a subset of test/ — every directory scan is optional.
const integrationFiles = existsSync('test/integration')
  ? readdirSync('test/integration', { recursive: true })
      .filter(f => f.endsWith('.test.js'))
      .map(f => join(process.cwd(), 'test/integration', f))
  : [];

const topLevelTestFiles = existsSync('test')
  ? readdirSync('test')
      .filter(f => f.endsWith('.test.js'))
      .map(f => join(process.cwd(), 'test', f))
  : [];

// Also scan test subdirectories (excluding integration which is handled separately)
const testSubdirs = (existsSync('test') ? readdirSync('test') : [])
  .filter(f => {
    const stat = statSync(join('test', f));
    return stat.isDirectory() && f !== 'integration';
  });

const subDirTestFiles = [];
for (const subdir of testSubdirs) {
  const filesInSubdir = readdirSync(join('test', subdir), { recursive: true })
    .filter(f => f.endsWith('.test.js'))
    .map(f => join(process.cwd(), 'test', subdir, f));
  subDirTestFiles.push(...filesInSubdir);
}

let files = [...srcFiles, ...integrationFiles, ...topLevelTestFiles, ...subDirTestFiles];

// Apply filter from CLI arguments (e.g., npm test -- deliberation-protocol)
// Forward recognized Mocha options while keeping bare args as file filters.
const rawArgs = process.argv.slice(2);
const mochaArgs = [];
const filters = [];
const valueOptions = new Set([
  '--grep',
  '-g',
  '--fgrep',
  '--reporter',
  '-R',
  '--timeout',
  '-t',
  '--require',
  '-r',
  '--ui',
  '-u',
  '--extension',
  '--slow',
  '-s',
  '--retries',
  '--package',
]);

for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg === '--') continue;
  if (arg === '--filter' || arg === '-f' || arg === '--files') {
    const value = rawArgs[i + 1];
    if (value) {
      filters.push(value);
      i += 1;
    }
    continue;
  }
  if (arg.startsWith('-')) {
    mochaArgs.push(arg);
    if (valueOptions.has(arg) && rawArgs[i + 1]) {
      mochaArgs.push(rawArgs[i + 1]);
      i += 1;
    }
    continue;
  }
  filters.push(arg);
}

if (filters.length > 0) {
  const originalCount = files.length;
  files = files.filter(f => filters.some(filter => f.includes(filter)));
  console.log(
    `Filter "${filters.join(', ')}" matched ${files.length}/${originalCount} test file(s)\n`,
  );
}

if (files.length === 0) {
  console.log('No test files found.');
  process.exit(0);
}

console.log(`Running ${files.length} test file(s)...\n`);

const hasTimeout = mochaArgs.includes('--timeout') || mochaArgs.includes('-t');
const timeoutArgs = hasTimeout ? [] : ['--timeout', '10000'];
const mocha = spawn('npx', ['mocha', ...files, ...mochaArgs, ...timeoutArgs], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

mocha.on('close', (code) => {
  if (code !== 0) {
    process.exit(code);
  }
});
