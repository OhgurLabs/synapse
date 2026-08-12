// SSRF Config Store — file-backed policy store with hot-reload support.
// Manages allowlist/denylist for outbound HTTP requests.

import { existsSync, readFileSync, writeFileSync, mkdirSync, watch, unlinkSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('ssrf-config-store');
const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_FILE_PATH = join(config.server.projectDir, '.synapse', 'ssrf-policy.json');
const LOCK_DIR_PATH = join(config.server.projectDir, '.synapse', '.ssrf-config.lock');
const TEMP_PREFIX = '.ssrf-config-temp-';

// Default policy - blocks private IPs and cloud metadata endpoints
const DEFAULT_POLICY = {
  enabled: true,
  blockPrivateRanges: true,
  allowlist: [],
  denylist: [
    '127.0.0.0/8',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.169.254/32',
    '169.254.169.253/32',
    '0.0.0.0/8',
    '224.0.0.0/4',
    '240.0.0.0/4',
    '::1/128',
    'fc00::/7',
    'fe80::/10',
  ],
};

// Config version tracking for change detection
let _configVersion = 0;

class SsrfConfigStore extends EventEmitter {
  constructor() {
    super();
    this._policy = null;
    this._watcher = null;
    this._reloadTimer = null;
    this._isLocked = false;
    this._loadPolicy();
    this._startWatcher();
  }

  _loadPolicy() {
    if (existsSync(CONFIG_FILE_PATH)) {
      try {
        const content = readFileSync(CONFIG_FILE_PATH, 'utf8');
        const filePolicy = JSON.parse(content);
        this._policy = { ...DEFAULT_POLICY, ...filePolicy };
        _configVersion = filePolicy._version || 0;
        log.info('Loaded SSRF policy', { 
          enabled: this._policy.enabled, 
          allowlistCount: this._policy.allowlist?.length || 0, 
          denylistCount: this._policy.denylist?.length || 0,
          version: _configVersion
        });
        return;
      } catch (err) {
        log.warn(`Failed to load SSRF policy from ${CONFIG_FILE_PATH}, using defaults. Error: ${err.message}`);
      }
    } else {
      log.info(`SSRF policy file not found at ${CONFIG_FILE_PATH}, using defaults.`);
    }

    this._policy = { ...DEFAULT_POLICY };
  }

  _startWatcher() {
    const dir = dirname(CONFIG_FILE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    try {
      this._watcher = watch(CONFIG_FILE_PATH, (eventType) => {
        if (eventType === 'change') {
          // Debounce rapid changes with 10-second delay
          if (this._reloadTimer) {
            clearTimeout(this._reloadTimer);
          }

          this._reloadTimer = setTimeout(() => {
            log.info('SSRF policy file changed, reloading after 10s delay...');
            const oldPolicy = { ...this._policy };
            this._loadPolicy();
            this.emit('reload', { oldPolicy, newPolicy: this._policy });
            log.info('SSRF policy reloaded and event emitted');
          }, 10000);
          // Pending reload must not be the only reason the process stays up.
          this._reloadTimer.unref?.();
        }
      });
      // This store is a module-load singleton and guarded-fetch/tracing import
      // it, so the watcher is started in essentially every process that touches
      // Synapse code — including short-lived ones. Without unref() the watcher
      // alone keeps the event loop alive and the process NEVER EXITS: test
      // scripts printed their results and then hung until SIGKILL, which the
      // suite reported as a hang with no failing assertion to point at.
      //
      // unref() costs nothing in the orchestrator, where the HTTP server holds
      // the loop open anyway, so reload-on-change behaves exactly as before.
      this._watcher.unref?.();
      log.info('Watching SSRF policy file for changes', { path: CONFIG_FILE_PATH });
    } catch (err) {
      log.warn('Failed to start file watcher for SSRF policy', { error: err.message });
    }
  }

  /**
   * Acquire file lock using atomic mkdir (POSIX atomic operation)
   * @returns {boolean} true if lock acquired
   */
  _acquireLock() {
    try {
      mkdirSync(dirname(LOCK_DIR_PATH), { recursive: true });
      // Non-recursive mkdir is the atomic operation: EEXIST means another
      // process owns the lock. recursive:true would report success for both.
      mkdirSync(LOCK_DIR_PATH);
      return true;
    } catch (err) {
      // Lock already exists (mkdir failed because dir exists)
      return false;
    }
  }

  /**
   * Release file lock
   */
  _releaseLock() {
    try {
      if (existsSync(LOCK_DIR_PATH)) {
        rmSync(LOCK_DIR_PATH, { recursive: true, force: true });
      }
      this._isLocked = false;
    } catch (err) {
      log.warn('Failed to release lock', { error: err.message });
    }
  }

  /**
   * Atomic file write using temp file + rename pattern
   * @param {string} filePath 
   * @param {string} data 
   * @returns {boolean} true if successful
   */
  _atomicWrite(filePath, data) {
    const tempPath = join(dirname(filePath), `${TEMP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`);

    try {
      // Write to temp file first.
      writeFileSync(tempPath, data, 'utf8');
      // POSIX rename is atomic and replaces the destination if it exists. The
      // earlier implementation called unlinkSync(filePath) which threw ENOENT
      // on the first-ever write (no policy file yet) — that bubbled up as an
      // unhandled rejection and crashed the Node process.
      renameSync(tempPath, filePath);
      log.debug('Atomic write completed', { path: filePath });
      return true;
    } catch (err) {
      log.error('Atomic write failed', { path: filePath, error: err.message });
      // Clean up temp file
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch (cleanupErr) {
        log.warn('Failed to cleanup temp file', { error: cleanupErr.message });
      }
      return false;
    }
  }

  /**
   * Get current SSRF policy
   * @returns {{ enabled: boolean, blockPrivateRanges: boolean, allowlist: string[], denylist: string[] }}
   */
  getPolicy() {
    if (!this._policy) {
      this._loadPolicy();
    }
    return { ...this._policy };
  }

  /**
   * Update SSRF policy (partial updates supported) with atomic writes and locking
   * @param {{ enabled?: boolean, blockPrivateRanges?: boolean, allowlist?: string[], denylist?: string[] }} updates
   */
  async update(updates) {
    // Bound lock acquisition so a crashed writer cannot create an infinite
    // retry chain. Stale-lock recovery belongs to startup/operator tooling.
    const deadline = Date.now() + 5_000;
    while (!this._acquireLock()) {
      if (Date.now() >= deadline) throw new Error('Timed out acquiring SSRF policy lock');
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this._isLocked = true;
    const currentPolicy = this.getPolicy();
    this._policy = { ...currentPolicy, ...updates };
    
    // Increment version
    _configVersion++;
    this._policy._version = _configVersion;

    const dir = dirname(CONFIG_FILE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    try {
      const serialized = JSON.stringify(this._policy, null, 2);
      const success = this._atomicWrite(CONFIG_FILE_PATH, serialized);
      
      if (!success) {
        throw new Error('Atomic write failed');
      }

      log.info('Saved SSRF policy', { 
        enabled: this._policy.enabled, 
        allowlistCount: this._policy.allowlist?.length || 0, 
        denylistCount: this._policy.denylist?.length || 0,
        version: _configVersion
      });
      this.emit('reload', this._policy);
      return;
    } catch (err) {
      log.error(`Failed to save SSRF policy to ${CONFIG_FILE_PATH}. Error: ${err.message}`);
      this._policy = currentPolicy;
      throw err;
    } finally {
      this._releaseLock();
    }
  }

  /**
   * Get config version for change detection
   * @returns {number}
   */
  getVersion() {
    return _configVersion;
  }

  /**
   * Stop watching for file changes
   */
  close() {
    this._releaseLock();
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    if (this._reloadTimer) {
      clearTimeout(this._reloadTimer);
      this._reloadTimer = null;
    }
  }
}

// Singleton instance
const store = new SsrfConfigStore();

export default store;
export { SsrfConfigStore };
