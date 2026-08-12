#!/usr/bin/env node
// Test runner — discovers and runs all *.test.js files under src/, test/, and test subdirectories.
//
// Two kinds of test files coexist in this repo and they CANNOT share a process:
//   - mocha suites (top-level describe blocks), and
//   - self-running scripts that execute their own asserts on load and call
//     process.exit() when done.
// Feeding both to one mocha invocation lets the first script's process.exit(0)
// kill the run mid-load with a green exit code — every file loading after it
// silently never runs (this shipped real bugs; see task #37). The runner
// therefore partitions: describe-based files go to a single mocha process
// (whose "N passing" summary is verified — a missing summary is a hard
// failure), and each self-running script gets its own node process with a
// timeout and an exit-code check.

import { spawn } from 'child_process';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';

const TEST_FILE_RE = /\.(?:test|spec)\.(?:js|mjs)$/;
const UI_TEST_RE = /^(?:test\/ui\/playwright|tests\/ui)(?:\/|$)/;
let files = [];
for (const root of ['src', 'test', 'tests']) {
  if (!existsSync(root)) continue;
  for (const file of readdirSync(root, { recursive: true })) {
    const relativePath = join(root, file);
    if (TEST_FILE_RE.test(file) && !UI_TEST_RE.test(relativePath)) {
      files.push(join(process.cwd(), relativePath));
    }
  }
}
files = [...new Set(files)];

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
  if (arg === '--allow-dispatch' || arg === '--list') continue; // runner flags, not mocha's
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

// ── Partition ──
// A file is a mocha suite iff it declares a top-level describe block. Note:
// grepping for process.exit() would misclassify — mocha suites legitimately
// embed process.exit inside child-process probe strings.
//
// Dispatch guard: some test files spawn real `claude`/provider CLI sessions.
// Those sessions draw from the operator's shared subscription concurrency
// pool and can evict their interactive terminals (this happened — twice).
// Such files are SKIPPED by default and only run with --allow-dispatch or
// TEST_ALLOW_DISPATCH=1, during an agreed quiet window.
// Three separate signals, because the single combined pattern this replaces was
// wrong in BOTH directions.
//
// It alternated on the bare identifiers `probeAgent` and `dispatchToAgent`,
// which match a mock property as readily as a real call:
//
//     probeAgent: async () => ({ ok: true }),      <-- skipped the whole file
//
// Measured across all 861 test files: 77 were skipped, and 76 of them matched
// ONLY those bare identifiers. Every one of the 76 DEFINES the name as a mock
// property; none imports the real probeAgent (agents.js:225); none matches a
// spawn pattern. So the identifier alternatives never once caught a genuine
// dispatcher -- they only ever hid working tests.
//
// It also had no notion of a process API at all, so 26 files that reach
// child_process or ProcessSandbox were RUNNING by default -- including
// sandbox-orphan-reaping and stress-validation, which is the exact class of
// file behind this week's two session-kill incidents.
//
// Net effect: 77 skipped -> 27. 76 freed to run, 26 newly protected.
const DISPATCH_SPAWN =
  /(spawn|execSync|execFileSync|exec)\s*\(\s*['"`](claude|codex|gemini|opencode)\b|['"`]claude['"`]\s*,\s*\[/;
// Importing the real dispatcher, as opposed to naming a mock after it.
const DISPATCH_IMPORT =
  /import[^;]*\{[^}]*\b(probeAgent|dispatchToAgent)\b[^}]*\}[^;]*from|require\([^)]+\)\s*\.\s*(probeAgent|dispatchToAgent)\b/;
// Any route to a real child process. Deliberately broad: a file that can spawn
// anything can spawn a provider CLI, and being wrong here costs the operator
// their terminals.
const DISPATCH_PROCESS =
  /\bProcessSandbox\b|from\s*['"](node:)?child_process['"]|require\(\s*['"](node:)?child_process['"]\s*\)/;
// Spawning node ITSELF is not dispatch. A test that runs `spawn(process.execPath,
// ...)` to exercise cross-process locking or start our own MCP server cannot
// draw on the operator's provider subscription, which is the entire thing this
// guard exists to protect.
//
// Found by reviewing a peer's commit: agent-memory-store-locking.test.js spawns
// process.execPath with inline --eval source and was being skipped by the
// broad child_process rule below. Exempting it frees 4 files with no loss of
// protection -- the exemption is void if the file mentions ProcessSandbox or
// any provider CLI name, so a file that spawns node AND claude stays skipped.
const SPAWNS_NODE_ITSELF = /process\.execPath|process\.argv\[0\]/;
const MENTIONS_PROVIDER = /['"`](claude|codex|gemini|opencode)\b/;
const DISPATCH_PATTERNS = {
  test: (text) => {
    if (DISPATCH_SPAWN.test(text) || DISPATCH_IMPORT.test(text)) return true;
    if (!DISPATCH_PROCESS.test(text)) return false;
    // child_process is present — allow it only when the target is provably node
    // and nothing in the file names a sandbox or a provider CLI.
    const nodeOnly = SPAWNS_NODE_ITSELF.test(text)
      && !/\bProcessSandbox\b/.test(text)
      && !MENTIONS_PROVIDER.test(text);
    return !nodeOnly;
  },
};
const allowDispatch = rawArgs.includes('--allow-dispatch') || process.env.TEST_ALLOW_DISPATCH === '1';
const listOnly = rawArgs.includes('--list');

const mochaFiles = [];
const nativeFiles = [];
const scriptFiles = [];
const dispatchSkipped = [];
for (const f of files.sort()) {
  let text = '';
  try {
    text = readFileSync(f, 'utf-8');
  } catch {
    scriptFiles.push(f); // unreadable → let its own node process report the error
    continue;
  }
  if (!allowDispatch && DISPATCH_PATTERNS.test(text)) {
    dispatchSkipped.push(f);
    continue;
  }
  if (/\bfrom\s+['"]node:test['"]|\brequire\(['"]node:test['"]\)/m.test(text)) nativeFiles.push(f);
  else if (/^\s*describe(\.only|\.skip)?\s*\(/m.test(text)) mochaFiles.push(f);
  else scriptFiles.push(f);
}

const runnableScriptFiles = [...nativeFiles, ...scriptFiles];

console.log(
  `Running ${mochaFiles.length + runnableScriptFiles.length}/${files.length} test file(s): ` +
  `${mochaFiles.length} mocha suite(s), ${nativeFiles.length} node:test file(s), ` +
  `${scriptFiles.length} self-running script(s)` +
  (dispatchSkipped.length
    ? `\n⚠ ${dispatchSkipped.length} dispatch-capable file(s) SKIPPED (they spawn real agent CLI sessions ` +
      `and can evict the operator's terminals). Run with --allow-dispatch in a quiet window for full coverage.`
    : '') +
  '\n',
);

if (listOnly) {
  const tag = (arr, label) => arr.forEach(f => console.log(`${label}  ${relative(process.cwd(), f)}`));
  tag(mochaFiles, 'mocha   ');
  tag(nativeFiles, 'node:test');
  tag(scriptFiles, 'script  ');
  tag(dispatchSkipped, 'DISPATCH');
  process.exit(0);
}

const rel = f => relative(process.cwd(), f);

// ── Stage 1: mocha suites (one process, summary verified) ──
// Cap on quarantine retries. Each pass removes exactly one poisoned file, so
// this bounds the stage at 11 mocha invocations in the worst case rather than
// looping forever on a tree that is broken everywhere.
const MAX_QUARANTINE = 10;

// Wall-clock ceiling for one mocha invocation. Generous — this is a backstop
// against a hung stage, not a per-test limit (mocha's own --timeout handles
// those). Raise via TEST_MOCHA_TIMEOUT_MS on a slow machine.
const MOCHA_TIMEOUT_MS = Number(process.env.TEST_MOCHA_TIMEOUT_MS || 900_000);

function runMochaOnce(files) {
  return new Promise(resolve => {
    const hasTimeout = mochaArgs.includes('--timeout') || mochaArgs.includes('-t');
    const timeoutArgs = hasTimeout ? [] : ['--timeout', '10000'];
    // Blocks a loaded file from calling process.exit() and killing the whole
    // stage mid-run. Without it, one hybrid file's `if (failed > 0)
    // process.exit(1)` silently skips every file scheduled after it.
    const guardArgs = ['--require', join(process.cwd(), 'test/helpers/no-exit.cjs')];
    // --exit: force the process down once the suite (and its hooks) finish.
    // Several API suites build a server harness that leaves handles open —
    // sqlite stores, intervals, listening sockets — so mocha completes, prints
    // its summary, and then sits there. The stage only recovered by burning the
    // full MOCHA_TIMEOUT_MS backstop below, turning a 3-second file into a
    // 15-minute stall. Verified compatible with no-exit.cjs: that guard allows
    // exits originating inside node_modules/mocha, which is where --exit's call
    // comes from, so mocha can still terminate while test code cannot.
    const exitArgs = mochaArgs.includes('--exit') ? [] : ['--exit'];
    // stderr must be PIPED, not inherited. mocha prints "Exception during run"
    // — the only record of a file that threw on import — to stderr, so leaving
    // it inherited meant the truncation detector below could see that the run
    // died but never which file killed it.
    // detached + tracked, exactly as the script stage does: `npx mocha` is
    // really npx -> sh -> node, so killing the direct child would leave two
    // generations behind.
    const child = spawn('npx', ['mocha', ...files, ...mochaArgs, ...timeoutArgs, ...guardArgs, ...exitArgs], {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: process.cwd(),
      detached: true,
    });
    liveGroups.add(child.pid);

    let out = '';
    let settled = false;
    const finish = (r) => { liveGroups.delete(child.pid); if (!settled) { settled = true; resolve(r); } };
    const verdict = (timedOut) => {
      // The summary line is the tripwire: if any loaded file kills the
      // process before mocha finishes, "N passing" never prints and we must
      // fail regardless of the exit code.
      const sawSummary = /\d+ passing/.test(out);
      // A blocked exit means the run completed only because the guard stopped a
      // file from killing it. mocha reports success, so the stage must fail here
      // or the offending files stay in the tree forever.
      const blockedExit = /BLOCKED process\.exit/.test(out);
      return { code: timedOut && !sawSummary ? 1 : (timedOut ? 0 : undefined), sawSummary, blockedExit, out, timedOut };
    };

    child.stdout.on('data', d => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', d => {
      out += d;
      process.stderr.write(d); // still shown live, just captured too
    });

    // Stage 1 previously had NO timeout at all. A suite that prints its summary
    // and then holds a handle open (leaked watcher, unclosed server) left the
    // whole run blocked forever on 'close' — observed live at ~10 minutes with
    // mocha idle and done. A finished-but-hung mocha still counts by its
    // summary; a hung mocha with no summary is a failure.
    const timer = setTimeout(() => {
      const v = verdict(true);
      console.error(
        `\n${v.sawSummary
          ? '⚠ mocha finished but did not exit within ' + MOCHA_TIMEOUT_MS / 1000 + 's (leaked handle); using its printed summary.'
          : '✗ mocha stage timed out after ' + MOCHA_TIMEOUT_MS / 1000 + 's with no summary.'}\n`,
      );
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      setTimeout(() => finish(v), CLOSE_GRACE_MS).unref?.();
    }, MOCHA_TIMEOUT_MS);

    child.on('close', code => {
      clearTimeout(timer);
      const v = verdict(false);
      finish({ ...v, code: code ?? 1 });
    });
  });
}

/**
 * Identify the file that poisoned a truncated run.
 *
 * mocha loads every suite into one process, so a file that THROWS at import
 * (a ReferenceError in a module it pulls in, a missing dependency) aborts
 * loadFilesAsync and takes the whole stage with it — the same truncation as a
 * rogue process.exit, through a different door. The no-exit guard cannot help
 * here: there is no exit to block.
 *
 * mocha prints "Exception during run:" followed by a stack. The first frame
 * naming one of the candidate files is the file to quarantine.
 */
function findPoisonedFiles(out, candidates) {
  const marker = out.lastIndexOf('Exception during run');
  if (marker === -1) return [];
  const tail = out.slice(marker, marker + 4000);

  // Case 1: ERR_MODULE_NOT_FOUND names the importer explicitly.
  const importedFrom = tail.match(/imported from (\S+)/);
  if (importedFrom) {
    const path = importedFrom[1].replace(/^file:\/\//, '');
    const hit = candidates.find(f => f === path || f.includes(path) || path.includes(f));
    if (hit) return [hit];
  }

  // Case 2: the stack names a test file directly.
  const direct = candidates.filter(f => tail.includes(f));
  if (direct.length) return [direct[0]];

  // Case 3 — the common one. A test file imported a SOURCE module that throws
  // at import, and the stack names only that module: mocha's requireModule
  // frame carries no filename, so the test file appears nowhere. Identify the
  // failing module from the first non-node frame, then quarantine every
  // candidate that imports it — each would poison the run in turn otherwise,
  // costing one retry apiece.
  const frame = tail
    .split('\n')
    .map(l => (l.match(/at (?:.*\()?(?:file:\/\/)?(\/[^\s):]+\.js)/) || [])[1])
    .find(p => p && !p.includes('node_modules') && !p.startsWith('/node:'));
  if (!frame) return [];

  const moduleName = frame.split('/').pop().replace(/\.js$/, '');
  const importers = candidates.filter(f => {
    if (f === frame) return true;
    try {
      return new RegExp(`from\\s+['"\`][^'"\`]*${moduleName}\\.js['"\`]`).test(readFileSync(f, 'utf-8'));
    } catch { return false; }
  });
  if (importers.length) {
    console.error(`  (module ${rel(frame)} throws on import; quarantining its ${importers.length} importer(s))`);
  }
  return importers;
}

async function runMocha() {
  if (mochaFiles.length === 0) return { code: 0, sawSummary: true, skipped: true, quarantined: [] };

  let files = [...mochaFiles];
  const quarantined = [];
  let result;

  for (let attempt = 0; ; attempt += 1) {
    result = await runMochaOnce(files);
    if (result.sawSummary) break;

    const poisoned = findPoisonedFiles(result.out, files);
    if (!poisoned.length || attempt >= MAX_QUARANTINE) {
      if (!poisoned.length) {
        console.error(
          '\n✗ The mocha run was truncated and the offending file could not be identified ' +
          'from the output. Run mocha directly on these files to find it.',
        );
      } else {
        console.error(`\n✗ Quarantine limit (${MAX_QUARANTINE}) reached — the tree has too many unloadable files.`);
      }
      break;
    }

    quarantined.push(...poisoned);
    files = files.filter(f => !poisoned.includes(f));
    console.error(
      `\n✗ ${poisoned.map(rel).join(', ')} THROWS ON IMPORT and truncated the run. ` +
      `Quarantining and re-running the remaining ${files.length} file(s) so they are not lost.\n`,
    );
  }

  // A quarantined file is a hard failure: the run only completed because we
  // removed it, and pretending otherwise is how it stays broken forever.
  const code = quarantined.length || result.blockedExit ? (result.code || 1) : result.code;
  return { ...result, code, quarantined };
}

// ── Stage 2: self-running scripts (own process each, worker pool) ──
const SCRIPT_TIMEOUT_MS = Number(process.env.TEST_SCRIPT_TIMEOUT_MS || 90_000);
const POOL = Number(process.env.TEST_SCRIPT_CONCURRENCY || 6);

// A killed-on-timeout script still counts as a pass when its output proves the
// tests completed cleanly before the hang — many of these hold watcher/handle
// leaks open after finishing (tracked separately as a warning, not a failure).
const CLEAN_FINISH = /(\b\d+ passed, 0 failed\b)|(\bAll [A-Za-z0-9 ]{0,30}tests? passed\b)|(\bTests failed: 0\b)/;
const FAILURE_MARK = /(\b[1-9]\d* failed\b)|(\bFAIL(?:URE)?\b(?!.*: 0))/;

// Grace period after SIGKILL before we stop waiting for the stdio pipes.
const CLOSE_GRACE_MS = 2_000;

// Spawning detached (below) buys tree-kill on timeout, but costs the safety net
// that came free before: children used to share this process's group, so
// `kill -- -<runner pgid>` reaped everything. Now each child leads its own
// group and would SURVIVE the runner being killed — orphans burning CPU with no
// parent, which is the exact mess this file is meant to prevent. So track the
// groups and tear them down on the way out, however we leave.
const liveGroups = new Set();

function killAllGroups() {
  for (const pid of liveGroups) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  liveGroups.clear();
}

process.on('exit', killAllGroups);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { killAllGroups(); process.exit(sig === 'SIGINT' ? 130 : 143); });
}

function runScript(file) {
  return new Promise(resolve => {
    // detached: the child leads its own process group, so a timeout can kill
    // the whole tree. Several test files spawn further node processes
    // (`sh -c node some-other.test.js`); killing only the direct child leaves
    // those grandchildren running, and because they inherit the stdout pipe
    // the 'close' event NEVER FIRES — close waits for stdio EOF, not exit. The
    // worker then awaits forever and the 90s timeout cannot end the run. That
    // is exactly what stalled a full run at 453/454 with orphans still burning
    // CPU 14 minutes later.
    const child = spawn(process.execPath, [file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
      detached: true,
    });
    liveGroups.add(child.pid);
    let out = '';
    let timedOut = false;
    let settled = false;
    const finish = (r) => { liveGroups.delete(child.pid); if (!settled) { settled = true; resolve(r); } };

    const killTree = () => {
      // Negative pid = the whole process group. Falls back to the lone child if
      // the group is already gone (ESRCH) or was never created.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already dead */ } }
    };

    const verdict = () => {
      if (timedOut && CLEAN_FINISH.test(out) && !FAILURE_MARK.test(out)) return { file, status: 'pass-hung' };
      return { file, status: 'hung', code: null, tail: out.slice(-2000) };
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // Do not depend on 'close' arriving: a surviving grandchild holding the
      // pipe would keep this promise pending forever, which is the bug above.
      setTimeout(() => finish(verdict()), CLOSE_GRACE_MS).unref?.();
    }, SCRIPT_TIMEOUT_MS);

    const collect = d => {
      out += d;
      if (out.length > 1_000_000) out = out.slice(-500_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', code => {
      clearTimeout(timer);
      if (!timedOut && code === 0) return finish({ file, status: 'pass' });
      if (timedOut) return finish(verdict());
      finish({ file, status: 'fail', code, tail: out.slice(-2000) });
    });
    child.on('error', err => {
      clearTimeout(timer);
      finish({ file, status: 'fail', code: -1, tail: String(err) });
    });
  });
}

async function runScripts() {
  const results = [];
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < runnableScriptFiles.length) {
      const file = runnableScriptFiles[next++];
      const r = await runScript(file);
      done += 1;
      results.push(r);
      const mark = { pass: '✓', 'pass-hung': '✓ (hung after finish)', hung: '✗ HUNG', fail: '✗ FAIL' }[r.status];
      console.log(`  [${done}/${runnableScriptFiles.length}] ${mark} ${rel(r.file)}`);
      if (r.status === 'fail' || r.status === 'hung') {
        console.log(`    ── output tail ──\n${(r.tail || '').split('\n').map(l => '    ' + l).join('\n')}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, runnableScriptFiles.length) }, worker));
  return results;
}

const mochaResult = await runMocha();
if (!mochaResult.skipped && !mochaResult.sawSummary) {
  console.error(
    '\n✗ mocha exited without printing an aggregate summary — a loaded file ' +
    'killed the process mid-run. Its files were NOT all executed.',
  );
}

const scriptResults = runnableScriptFiles.length ? await runScripts() : [];
const failed = scriptResults.filter(r => r.status === 'fail' || r.status === 'hung');
const hungPass = scriptResults.filter(r => r.status === 'pass-hung');

console.log('\n── test.mjs summary ──');
console.log(
  `mocha suites: ${mochaFiles.length} file(s), exit ${mochaResult.code}` +
  (mochaResult.skipped ? ' (none matched)' : mochaResult.sawSummary ? '' : ' — NO SUMMARY (truncated run)') +
  (mochaResult.blockedExit ? ' — CONTAINS FILES THAT TRIED TO KILL THE RUN (see blocked process.exit list above)' : '') +
  (mochaResult.quarantined?.length
    ? `\n  ⚠ ${mochaResult.quarantined.length} file(s) QUARANTINED (threw on import; the rest were re-run without them):\n` +
      mochaResult.quarantined.map(f => `    - ${rel(f)}`).join('\n')
    : ''),
);
console.log(
  `scripts: ${scriptResults.length - failed.length}/${scriptResults.length} passed` +
  (hungPass.length ? ` (${hungPass.length} finished but left handles open)` : ''),
);
if (dispatchSkipped.length) {
  console.log(
    `⚠ NOT RUN: ${dispatchSkipped.length} dispatch-capable file(s) — coverage is INCOMPLETE until ` +
    `a quiet-window run with --allow-dispatch.`,
  );
}
if (failed.length) {
  console.log(`failed scripts:`);
  for (const r of failed) console.log(`  - ${rel(r.file)} (${r.status}${r.code != null ? `, exit ${r.code}` : ''})`);
}

const ok = mochaResult.code === 0 && (mochaResult.skipped || mochaResult.sawSummary) && failed.length === 0;
process.exit(ok ? 0 : 1);
