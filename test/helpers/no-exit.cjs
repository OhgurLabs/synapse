// Preloaded into the mocha stage via --require.
//
// Twelve test files in this repo are hybrids: they declare describe blocks, so
// mocha loads them, AND they carry a hand-rolled runner that executes at import
// time and ends with `if (failed > 0) process.exit(1)`. One failing assertion
// in any of them terminates the mocha process during the load phase, so every
// file scheduled after it never runs. The report shows a handful of failures
// and gives no hint that ~100 files were skipped — the sieve in task #37.
//
// This makes that impossible. A process.exit() from test code becomes a thrown
// error, which mocha attributes to the offending file and then carries on with
// the rest. The run stays whole, and the culprit is named instead of silently
// truncating everything behind it.
//
// mocha's OWN exit must still work, or the process would never terminate — so
// calls originating inside mocha (or node's internals) pass through untouched.

const realExit = process.exit.bind(process);

// Frames that legitimately end the process: the runner itself, not test code.
const ALLOWED = /node_modules[/\\](mocha|nyc|c8)[/\\]|node:internal[/\\]/;

// Blocking must NOT throw. These exits sit at the top level of a file, so a
// throw propagates out of mocha's loadFilesAsync and aborts loading entirely —
// that just trades a silent truncation for a loud one, with the same files
// unrun. Returning instead lets the file finish loading and register its
// describe blocks, so the run stays whole. In every case here the exit is the
// file's last statement, so there is nothing meaningful after it to skip.
//
// The offence is recorded and printed in a summary, and test.mjs fails the
// stage on it, so nothing is quietly forgiven.
const blocked = [];

process.exit = function guardedExit(code) {
  const stack = new Error().stack || '';
  // Drop the first two lines ("Error" + this function) so the check looks at
  // the actual caller rather than at this file.
  const callerFrames = stack.split('\n').slice(2);
  const where = (callerFrames[0] || '').trim();

  if (ALLOWED.test(where)) return realExit(code);

  blocked.push({ code, where });
  // stdout, not stderr: test.mjs captures stdout and fails the stage on this marker.
  console.log(`✗ BLOCKED process.exit(${code}) from test code — ${where}`);
  return undefined; // deliberately not throwing; see note above
};

process.on('exit', () => {
  process.exit = realExit;
  if (!blocked.length) return;
  console.log(
    `\n✗ ${blocked.length} blocked process.exit() call(s) during the mocha run.\n` +
    '  Each would have killed the process and silently skipped every file after it.\n' +
    '  Convert these files to describe/it, or guard the exit behind a main-module check:\n' +
    blocked.map(b => `    exit(${b.code})  ${b.where}`).join('\n') + '\n',
  );
});

module.exports = {};
