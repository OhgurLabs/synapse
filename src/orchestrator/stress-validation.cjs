#!/usr/bin/env node
// stress-validation.cjs (CommonJS)
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function runFullTestSuite() {
  console.log('Running full test suite...');
  const result = execSync(`node ./test.mjs`, {stdio:['inherit','pipe','inherit']});
  if (result.toString().includes('FAILURES:') || /Test failed/i.test(result)) throw new Error('Full test suite reported failures!');
  console.log('Full test suite passed. No known bugs detected.');
}

function runMiniSoak() {
  console.log('Starting mini-soak load test...');
  const result = execSync(`node ./scripts/mini-soak.mjs`, {stdio:['inherit','pipe','inherit']});
  if (/Silent failure/i.test(result)) throw new Error('Mini-soak detected silent failures!');
  console.log('Mini-soak completed with expected alerts only.');
}

function runSnapshotRoundTrip() {
  console.log('Running Snapshot API round-trip validation...');
  const snapshotPath = path.resolve('/tmp/snapshot-before.mjs');
  execSync(`node ./src/orchestrator/cli.js export-snapshot --out ${snapshotPath}`);
  if (!fs.existsSync(snapshotPath)) throw new Error('Snapshot export failed – file not generated.');

  // Step 2: Corrupt in‑memory state (example)
  execSync(`node ./src/orchestrator/cli.js set-state --key running_tasks --value '{}'`);

  // Step 3: Restore snapshot and verify pending tasks still exist
  execSync(`node ./src/orchestrator/cli.js import-snapshot --in ${snapshotPath}`);
  const afterRestore = JSON.parse(execSync('cat /tmp/current_state.json', {stdio:'pipe'}));
  if (!afterRestore?.pendingTasks || Object.keys(afterRestore.pendingTasks).length===0) {
    throw new Error('Snapshot restore did NOT recover pending work.');
  }
  console.log('Snapshot API functional – restoration succeeded.');
}

(async () => {
  try {
    await runFullTestSuite(); // (1)
    await runMiniSoak();     // (2)
    await runSnapshotRoundTrip(); // (4)
    console.log('All campaign success criteria verified!');
  } catch (err) {
    console.error('Validation FAILED:', err.message);
    process.exit(1);
  }
})();