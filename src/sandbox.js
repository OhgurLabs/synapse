// Process sandbox — isolation, resource limits, and monitoring for agent child processes.
// Process isolation with resource limits (#8). Zero external dependencies.
//
// Features:
//   - Output buffer cap: prevents OOM from runaway agent stdout/stderr
//   - Concurrent process limit: prevents resource exhaustion
//   - Environment filtering: strips sensitive env vars from child processes
//   - Global process registry: tracks all active agent processes for monitoring
//   - Graceful cleanup: SIGTERM → grace → SIGKILL on all tracked processes

import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { createLogger } from './logger.js';

const log = createLogger('sandbox');

// ─── Sensitive env var patterns to strip from child processes ──────────
const DEFAULT_ENV_DENY = [
  /^SYNAPSE_AUTH/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GCP_/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
  /^DATABASE_URL$/i,
  /^DB_/i,
  /^REDIS_/i,
  /^MONGO/i,
  /^POSTGRES/i,
  /^MYSQL/i,
  /^SECRET/i,
  /^PRIVATE_KEY/i,
  /TOKEN$/i,          // but not PATH or HOME which end differently
  /PASSWORD/i,
  /^NPM_TOKEN$/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
];

// Env vars that should NEVER be stripped (override deny patterns)
const ENV_ALLOW = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',  // needed for Claude CLI auth
  'GEMINI_API_KEY',           // needed for Gemini CLI auth
  'OLLAMA_HOST',              // needed for Ollama endpoint
  'HOME',
  'PATH',
  'SHELL',
  'USER',
  'LANG',
  'LC_ALL',
  'TERM',
  'NODE_ENV',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
]);

/**
 * Filter environment variables — remove sensitive vars, keep allowed ones.
 * @param {Object} env - source environment (default: process.env)
 * @param {RegExp[]} denyPatterns - patterns to match against env var names
 * @returns {Object} filtered environment
 */
export function filterEnv(env = process.env, denyPatterns = DEFAULT_ENV_DENY) {
  const filtered = {};
  for (const [key, value] of Object.entries(env)) {
    if (ENV_ALLOW.has(key)) {
      filtered[key] = value;
      continue;
    }
    const denied = denyPatterns.some(re => re.test(key));
    if (!denied) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Capped string buffer — accumulates string data up to a byte limit.
 * When the limit is exceeded, further writes are silently dropped and
 * a truncation notice is appended.
 */
export class CappedBuffer {
  constructor(maxBytes) {
    this._maxBytes = maxBytes;
    this._data = '';
    this._bytes = 0;
    this._truncated = false;
  }

  append(chunk) {
    if (this._truncated) return;
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    const chunkBytes = Buffer.byteLength(str);
    if (this._bytes + chunkBytes > this._maxBytes) {
      // Take what fits
      const remaining = this._maxBytes - this._bytes;
      if (remaining > 0) {
        this._data += str.slice(0, remaining);
        this._bytes = this._maxBytes;
      }
      this._truncated = true;
      this._data += `\n[output truncated at ${(this._maxBytes / 1024 / 1024).toFixed(1)}MB]`;
      return;
    }
    this._data += str;
    this._bytes += chunkBytes;
  }

  toString() { return this._data; }
  get truncated() { return this._truncated; }
  get bytes() { return this._bytes; }
}

/**
 * Global process sandbox — tracks and limits all agent child processes.
 */
export class ProcessSandbox {
  constructor(config = {}) {
    this._maxConcurrent = config.maxConcurrentProcesses || 8;
    this._maxOutputBytes = config.maxOutputBytes || 10 * 1024 * 1024; // 10MB default
    this._envFilterEnabled = config.envFilter !== false;
    this._enabled = config.enabled !== false;
    this._stopGraceMs = config.stopGraceMs || 5000;
    this._maxLifetimeMs = config.maxProcessLifetimeMs || 900000; // 15 min default
    this._maxPerProvider = config.maxPerProvider || {};  // provider → max concurrent

    // Global registry: pid → { child, agent, cmd, startedAt, stdout, stderr }
    this._processes = new Map();
    // Track last process group ID per agent — reaper backstop kills orphaned groups
    this._lastPgid = new Map(); // agentId (lowercase) → pgid (= root pid for detached processes)
    this._onEvent = null;
    this._reaperInterval = null;

    // Startup: kill orphaned agent processes from prior runs, then start reaper
    if (this._enabled) {
      this._cleanupOrphans();
      this._startReaper();
    }
  }

  /**
   * Kill orphaned agent CLI processes left over from a prior Synapse run.
   * Anything matching agent CLI patterns that is NOT a child of our process tree is an orphan.
   */
  _cleanupOrphans() {
    const patterns = ['claude', 'codex', 'gemini', 'opencode', 'test-api-server', 'mcp-server'];
    const myPid = process.pid;

    for (const pattern of patterns) {
      try {
        // pgrep -af returns "pid command..." lines
        const output = execSync(`pgrep -af "${pattern}" 2>/dev/null || true`, {
          encoding: 'utf8', stdio: 'pipe', timeout: 5000,
        }).trim();
        if (!output) continue;

        for (const line of output.split('\n')) {
          const pid = parseInt(line.trim().split(/\s+/)[0], 10);
          if (!pid || pid === myPid) continue;

          // Check if this PID is a descendant of our process — if so, skip
          try {
            const ppidChain = execSync(`ps -o ppid= -p ${pid} 2>/dev/null || true`, {
              encoding: 'utf8', stdio: 'pipe', timeout: 3000,
            }).trim();
            const ppid = parseInt(ppidChain, 10);
            if (ppid === myPid) continue; // direct child, not an orphan
          } catch { /* can't check, treat as orphan */ }

          // Kill the orphan
          try {
            process.kill(pid, 'SIGTERM');
            log.warn('Killed orphaned agent process', { pid, pattern, command: line.substring(0, 120) });
          } catch { /* already dead */ }
        }
      } catch (err) {
        log.debug('Orphan scan failed for pattern', { pattern, error: err.message });
      }
    }
  }

  /**
   * Periodic reaper — removes stale entries from the process map where the PID has died
   * without emitting a 'close' event, AND kills processes that exceed max lifetime.
   */
  _startReaper() {
    this._reaperInterval = setInterval(() => {
      const now = Date.now();
      for (const [pid, info] of this._processes) {
        // Check if process is actually alive (not just a zombie/stale PID)
        let alive = true;
        try {
          process.kill(pid, 0);
          // kill(0) succeeds for zombies too — also check /proc for actual state
          try {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            if (stat.includes(' Z ') || stat.includes(') Z')) {
              alive = false; // Zombie process
              log.warn('Reaped zombie process', { pid, agent: info.agent });
            }
          } catch {
            alive = false; // /proc entry gone — truly dead
          }
        } catch {
          alive = false;
        }
        if (!alive) {
          this._processes.delete(pid);
          log.warn('Reaped stale process entry', { pid, agent: info.agent });
        }

        // Max-lifetime enforcement — kill zombie processes
        const lifetimeLimitMs = info.maxLifetimeMs || this._maxLifetimeMs;
        if (alive && (now - info.startedAt) > lifetimeLimitMs) {
          const runningMs = now - info.startedAt;
          log.warn('Killing process exceeding max lifetime', {
            pid, agent: info.agent, taskId: info.taskId,
            runningMs, maxLifetimeMs: lifetimeLimitMs,
          });

          // SIGTERM → grace → SIGKILL (same pattern as killAll/agent.stop)
          try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
          setTimeout(() => {
            try {
              process.kill(-pid, 0); // still alive?
              process.kill(-pid, 'SIGKILL');
              log.warn('Force-killed process after grace period', { pid, agent: info.agent });
            } catch { /* already dead */ }
          }, this._stopGraceMs);

          if (this._onEvent) {
            this._onEvent('sandbox:process_killed', {
              pid, agent: info.agent, taskId: info.taskId,
              reason: 'max_lifetime_exceeded', runningMs,
            });
          }
        }
      }
      // PGID backstop REMOVED — was killing active agent processes.
      // The cookie system + per-agent exclusivity in spawn() handles
      // process lifecycle. The exit handler's group kill (SIGTERM+SIGKILL)
      // cleans up orphan children when a process exits normally.
      // See: incident 2026-03-25 — reaper PGID backstop killed every
      // agent process because _processes was empty by the time it ran.
      // See: incident 2026-04-02 — disabled reaper left stale entries blocking
      // agent spawns (Ollie/Olive stuck for hours).
    }, 30000); // REAPER ENABLED: runs every 30s to clean stale entries
    // Don't hold the event loop open for the reaper
    if (this._reaperInterval.unref) this._reaperInterval.unref();
  }

  setOnEvent(fn) { this._onEvent = fn; }

  /**
   * Spawn a sandboxed child process.
   *
   * @param {string} cmd - command to run
   * @param {string[]} args - command arguments
   * @param {Object} spawnOpts - options for child_process.spawn (cwd, env, stdio, detached)
   * @param {Object} meta - metadata: { agent, taskId }
   * @returns {{ child, stdout, stderr, promise, abort }}
   *   - child: the ChildProcess
   *   - stdout: CappedBuffer
   *   - stderr: CappedBuffer
   *   - promise: Promise<{ code, stdout, stderr, stats }>
   *   - abort: Function to kill the process group
   */
  spawn(cmd, args, spawnOpts = {}, meta = {}) {
    // Per-agent exclusivity: one process per agent at all times.
    // Registry check only — the process group kill on exit (below) ensures
    // orphan children are cleaned up, so detection at spawn time is unnecessary.
    if (this._enabled && meta.agent) {
      const agentId = meta.agent.toLowerCase();
      const alreadyRunning = [...this._processes.values()].some(
        p => p.agent && p.agent.toLowerCase() === agentId
      );
      if (alreadyRunning) {
        const err = new Error(
          `Sandbox: agent ${meta.agent} already has an active process`
        );
        log.warn('Per-agent exclusivity: duplicate spawn blocked', { agent: meta.agent });
        return {
          child: null,
          stdout: new CappedBuffer(0),
          stderr: new CappedBuffer(0),
          promise: Promise.reject(err),
          abort: () => {},
        };
      }
    }

    // Concurrent process limit check
    if (this._enabled && this._processes.size >= this._maxConcurrent) {
      const err = new Error(
        `Sandbox: concurrent process limit reached (${this._maxConcurrent}). ` +
        `Active: ${[...this._processes.values()].map(p => p.agent || p.cmd).join(', ')}`
      );
      log.warn('Concurrent limit reached', {
        limit: this._maxConcurrent,
        active: this._processes.size,
        agent: meta.agent,
      });
      return {
        child: null,
        stdout: new CappedBuffer(0),
        stderr: new CappedBuffer(0),
        promise: Promise.reject(err),
        abort: () => {},
      };
    }

    // Per-provider concurrency limit — prevents overwhelming single-GPU backends like llama.cpp
    if (this._enabled && meta.provider && this._maxPerProvider[meta.provider]) {
      const cap = this._maxPerProvider[meta.provider];
      const active = [...this._processes.values()].filter(p => p.provider === meta.provider).length;
      if (active >= cap) {
        const err = new Error(
          `Sandbox: per-provider limit reached for ${meta.provider} (${cap}). ` +
          `Active: ${[...this._processes.values()].filter(p => p.provider === meta.provider).map(p => p.agent).join(', ')}`
        );
        log.warn('Per-provider concurrent limit reached', {
          provider: meta.provider, limit: cap, active, agent: meta.agent,
        });
        return {
          child: null,
          stdout: new CappedBuffer(0),
          stderr: new CappedBuffer(0),
          promise: Promise.reject(err),
          abort: () => {},
        };
      }
    }

    // CWD existence check — fail fast with clear message instead of cryptic ENOENT
    if (spawnOpts.cwd && !existsSync(spawnOpts.cwd)) {
      const err = new Error(`Sandbox: cwd does not exist: "${spawnOpts.cwd}" (agent: ${meta.agent || 'unknown'})`);
      log.error('Spawn rejected — cwd missing', { cwd: spawnOpts.cwd, agent: meta.agent, cmd });
      return {
        child: null,
        stdout: new CappedBuffer(0),
        stderr: new CappedBuffer(0),
        promise: Promise.reject(err),
        abort: () => {},
      };
    }

    // Environment filtering
    const env = this._envFilterEnabled
      ? filterEnv(spawnOpts.env || process.env)
      : (spawnOpts.env || process.env);

    // Spawn with filtered env
    const child = spawn(cmd, args, {
      ...spawnOpts,
      env,
      stdio: spawnOpts.stdio || ['ignore', 'pipe', 'pipe'],
      detached: spawnOpts.detached !== false, // default true
    });

    const stdoutBuf = new CappedBuffer(this._maxOutputBytes);
    const stderrBuf = new CappedBuffer(this._maxOutputBytes);
    const startedAt = Date.now();

    // Register in global process map
    const entry = {
      child,
      agent: meta.agent || 'unknown',
      provider: meta.provider || null,
      taskId: meta.taskId || null,
      kind: meta.kind || null,  // 'probe' = validation/introduction/test dispatch
      // Per-process lifetime override (ms). Verbatim one-shot dispatches run
      // uncapped-by-design; without this the reaper would kill them at the
      // global 45-min default mid-build.
      maxLifetimeMs: meta.maxLifetimeMs || null,
      cmd,
      startedAt,
      stdout: stdoutBuf,
      stderr: stderrBuf,
    };
    if (child.pid) {
      this._processes.set(child.pid, entry);
      // Track PGID for process-group-level exclusivity checks.
      // Detached processes get PGID = their own PID.
      if (meta.agent) {
        this._lastPgid.set(meta.agent.toLowerCase(), child.pid);
      }
    }

    // Pipe stdout/stderr through capped buffers
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdoutBuf.append(chunk);
        if (stdoutBuf.truncated) {
          log.warn('Output truncated', {
            pid: child.pid,
            agent: meta.agent,
            stream: 'stdout',
            maxBytes: this._maxOutputBytes,
          });
        }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrBuf.append(chunk);
      });
    }

    // Promise that resolves when process exits.
    // On exit, kill the entire process group to clean up orphaned children
    // (e.g., opencode's MCP servers, ESLint, language servers). detached:true
    // means PGID = child.pid. Children retain this PGID even after reparenting
    // to init, so kill(-pid, SIGTERM) reaches them. Safe no-op for agents
    // whose children already exited (ESRCH caught by try/catch).
    const promise = new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (code) => {
        if (settled) return;
        settled = true;
        // Kill surviving children in the process group before clearing registry.
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { /* group already dead */ }
          const pgid = child.pid;
          setTimeout(() => {
            try { process.kill(-pgid, 'SIGKILL'); } catch { /* already dead */ }
          }, 2000);
        }
        if (child.pid) this._processes.delete(child.pid);
        const durationMs = Date.now() - startedAt;
        const stats = {
          pid: child.pid,
          exitCode: code,
          durationMs,
          stdoutBytes: stdoutBuf.bytes,
          stderrBytes: stderrBuf.bytes,
          stdoutTruncated: stdoutBuf.truncated,
          stderrTruncated: stderrBuf.truncated,
        };

        if (this._onEvent) {
          this._onEvent('sandbox:process_exit', {
            ...stats, agent: meta.agent, taskId: meta.taskId,
          });
        }

        resolve({ code, stdout: stdoutBuf, stderr: stderrBuf, stats });
      };

      child.on('exit', (code, signal) => { console.log('SANDBOX CHILD EXIT:', child.pid, code, signal); cleanup(code); });
      child.on('close', (code, signal) => { console.log('SANDBOX CHILD CLOSE:', child.pid, code, signal); cleanup(code); });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        if (child.pid) this._processes.delete(child.pid);
        reject(new Error(`Sandbox spawn error (${meta.agent || cmd}): ${err.message}`));
      });
    });

    // Abort function — kills entire process group (SIGTERM → grace → SIGKILL)
    const abort = () => { console.log('SANDBOX ABORT CALLED for PID:', child.pid);
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch (e) { /* already dead */ return; }
      // SIGKILL fallback after grace period
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 0); // still alive?
          process.kill(-child.pid, 'SIGKILL');
          log.warn('Force-killed aborted process', { pid: child.pid, agent: meta.agent });
        } catch { /* already dead */ }
      }, this._stopGraceMs);
    };

    log.info('Process spawned', {
      pid: child.pid,
      agent: meta.agent,
      cmd,
      concurrent: this._processes.size,
    });

    return { child, stdout: stdoutBuf, stderr: stderrBuf, promise, abort };
  }

  /**
   * Get snapshot of all active processes for monitoring/health endpoint.
   */
  getActiveProcesses() {
    const now = Date.now();
    return [...this._processes.entries()].map(([pid, entry]) => ({
      pid,
      agent: entry.agent,
      taskId: entry.taskId,
      kind: entry.kind || null,
      cmd: entry.cmd,
      runningMs: now - entry.startedAt,
      stdoutBytes: entry.stdout.bytes,
      stderrBytes: entry.stderr.bytes,
    }));
  }

  /**
   * Kill a single process by PID — used by cookie reconciliation for stuck/orphan processes.
   * SIGTERM → grace → SIGKILL. Removes from process registry and emits event.
   *
   * @param {number} pid - process ID to kill
   * @param {string} [reason='reconcile'] - reason for the kill (logged + emitted)
   */
  killProcess(pid, reason = 'reconcile') {
    const info = this._processes.get(pid);
    if (!info) {
      log.debug('killProcess: pid not in registry', { pid, reason });
      return;
    }

    log.warn('Killing single process', { pid, agent: info.agent, taskId: info.taskId, reason });

    // SIGTERM the process group
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }

    // SIGKILL fallback after grace period
    setTimeout(() => {
      try {
        process.kill(-pid, 0); // still alive?
        process.kill(-pid, 'SIGKILL');
        log.warn('Force-killed process after grace period', { pid, agent: info.agent, reason });
      } catch { /* already dead */ }
    }, this._stopGraceMs);

    // Remove from registry
    this._processes.delete(pid);

    // Emit event so sandbox listeners (error registry, etc.) are notified
    if (this._onEvent) {
      this._onEvent('sandbox:process_killed', {
        pid, agent: info.agent, taskId: info.taskId,
        reason, runningMs: Date.now() - info.startedAt,
      });
    }
  }

  /**
   * Kill all active processes — for graceful shutdown.
   */
  async killAll(reason = 'shutdown') {
    // Stop reaper before cleanup
    if (this._reaperInterval) {
      clearInterval(this._reaperInterval);
      this._reaperInterval = null;
    }

    if (this._processes.size === 0) return { cleaned: 0, forced: 0 };

    const count = this._processes.size;
    log.info('Killing all processes', { count, reason });

    // Phase 1: SIGTERM all process groups
    for (const [pid] of this._processes) {
      try { process.kill(-pid, 'SIGTERM'); } catch (e) { /* already dead */ }
    }

    // Phase 2: Wait grace period
    await new Promise(r => setTimeout(r, this._stopGraceMs));

    // Phase 3: SIGKILL survivors
    let forced = 0;
    for (const [pid] of this._processes) {
      try {
        process.kill(-pid, 0); // check alive
        process.kill(-pid, 'SIGKILL');
        forced++;
      } catch (e) { /* already dead */ }
    }
    this._processes.clear();
    return { cleaned: count, forced };
  }

  /**
   * Kill every registered process belonging to an agent (case-insensitive).
   * Used by probe/validation timeouts: an abandoned probe CLI holds the
   * per-agent exclusivity slot, wedging every later dispatch with
   * "already has an active process" until the process dies on its own.
   *
   * @param {string} agentName - agent name or id as recorded at spawn
   * @param {string} [reason='probe_timeout']
   * @returns {number} count of processes killed
   */
  killByAgent(agentName, reason = 'probe_timeout') {
    if (!agentName) return 0;
    const needle = String(agentName).toLowerCase();
    let killed = 0;
    for (const [pid, info] of [...this._processes]) {
      if (info.agent && String(info.agent).toLowerCase() === needle) {
        this.killProcess(pid, reason);
        killed++;
      }
    }
    return killed;
  }

  get activeCount() { return this._processes.size; }
  get maxConcurrent() { return this._maxConcurrent; }
  get maxOutputBytes() { return this._maxOutputBytes; }
}
