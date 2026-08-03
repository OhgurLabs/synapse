// Forcefully terminate all lingering worker processes
'use strict';

const { spawn } = require('child_process');
const os = require('os');

/**
 * Sends SIGTERM to every process listed in the given PID array. If a process does not respond within 5 seconds, it receives SIGKILL.
 */
function terminate(pidList) {
  const killTimeoutMs = 5000; // give each process time to shut down
  pidList.forEach((pid) => {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`SIGTERM sent to PID ${pid}`);
    } catch (err) {
      console.error(`Failed to send SIGTERM to PID ${pid}:`, err);
    }
  });

  // Wait then perform a forced kill on any that are still alive after the timeout
  const waitAndForce = () => new Promise((resolve, reject) => {
    setTimeout(() => {
      pidList.forEach((pid) => {
        try {
          // Check if process is still running (node can throw an exception for non‑existent PIDs)
          process.kill(pid, 0);
          console.log(`PID ${pid} still alive after SIGTERM – sending SIGKILL`);
          process.kill(pid, 'SIGKILL');
        } catch (e) {
          // Process already exited
        }
      });
      resolve();
    }, killTimeoutMs);
  });

  waitAndForce()
    .then(() => console.log('All workers terminated'))
    .catch((err) => {
      console.error('Error during forced termination:', err);
    });
}

/**
 * Public API – runs in Jest afterAll and CI teardown.
 */
module.exports = async function sigtermAll() {
  const pids = Object.values(process.send ? process._getActiveHandles().filter(h => h.pid).map(h=>h.pid) : []);
  if (!pids.length && os.platform() !== 'win32') {
    try {
      const { stdout } = await spawn('bash', ['-c', 'ps -eo pid | grep \bnode\b']);
      const rawPids = stdout.toString();
      pids.push(...rawPids.split('\n').map(Number).filter(n => !isNaN(n)));
    } catch (e) {/* ignore */}
  }
  if (!pids.length) {
    console.log('No lingering worker PIDs found');
    return;
  }
  try { require('child_process').spawn; } catch (_) {}
  await terminate(pids);
}
  if (!pids.length) {
    console.log('No lingering worker PIDs found');
    return;
  }
  await terminate(pids);
};