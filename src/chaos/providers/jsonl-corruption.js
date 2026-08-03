/**
 * JSONLCorruptionProvider - File-level JSON/JSONL corruption via FaultProvider.
 *
 * Wraps the test-support JSONFaultInjector as a first-class FaultProvider so that
 * the chaos framework can inject truncation, malformed JSON, partial writes,
 * missing files, and permission revocation into any JSON/JSONL file on disk.
 *
 * Snapshot/restore is handled transparently: inject() snapshots before
 * corrupting, recover() restores from the snapshot.
 *
 * context.metadata contract:
 *   filePath       {string}  - Absolute path to the target file (required)
 *   corruptionMode {string}  - One of: truncate, malformed, partial_write,
 *                              missing_file, permissions (required)
 *   keepBytes      {number}  - For truncate mode (default: 0)
 *   malformedType  {string}  - For malformed mode: syntax | binary | random (default: syntax)
 *   writeRatio     {number}  - For partial_write mode: 0.0-1.0 (default: 0.7)
 *
 * @module chaos/providers/jsonl-corruption
 */

import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import { FaultProvider, FaultInjectionError, FaultRecoveryError } from '../fault-provider.js';
import { JSONFaultInjector } from '../../../test/support/json-fault-injection.js';

/**
 * Supported corruption modes.
 * @type {Set<string>}
 */
const VALID_MODES = new Set([
  'truncate',
  'malformed',
  'partial_write',
  'missing_file',
  'permissions',
]);

/**
 * JSONLCorruptionProvider - Injects file-level corruption into JSON/JSONL files.
 *
 * @extends FaultProvider
 */
export class JSONLCorruptionProvider extends FaultProvider {
  /**
   * @param {Object} [options]
   * @param {string}  [options.type='jsonl_corruption'] - Fault type identifier
   * @param {number}  [options.recoveryTimeout=30000]   - Recovery timeout in ms
   * @param {boolean} [options.emitEvents=true]          - Emit lifecycle events
   * @param {string}  [options.snapshotDir]              - Custom snapshot directory
   */
  constructor(options = {}) {
    super({
      type: options.type || 'jsonl_corruption',
      recoveryTimeout: options.recoveryTimeout || 30000,
      emitEvents: options.emitEvents !== false,
    });

    /**
     * Underlying JSONFaultInjector instance.
     * @private
     * @type {JSONFaultInjector}
     */
    this._injector = new JSONFaultInjector({
      snapshotDir: options.snapshotDir,
    });

    /**
     * File path currently under corruption (for recovery).
     * @private
     * @type {string|null}
     */
    this._activeFilePath = null;

    /**
     * Corruption mode applied (for state reporting).
     * @private
     * @type {string|null}
     */
    this._activeMode = null;

    /**
     * Whether permissions were revoked (needs separate restore step).
     * @private
     * @type {boolean}
     */
    this._permissionsRevoked = false;
  }

  // ---------------------------------------------------------------------------
  // FaultProvider contract
  // ---------------------------------------------------------------------------

  /**
   * Check whether corruption can be injected.
   *
   * @param {Object} context - Fault context
   * @param {Object} context.metadata
   * @param {string} context.metadata.filePath       - Target file path
   * @param {string} context.metadata.corruptionMode - Corruption mode
   * @returns {boolean}
   */
  canInject(context) {
    const meta = context.metadata;
    if (!meta || !meta.filePath || !meta.corruptionMode) {
      return false;
    }

    if (!VALID_MODES.has(meta.corruptionMode)) {
      return false;
    }

    // For modes that corrupt existing content the file must exist.
    // missing_file mode is valid even if the file doesn't exist yet
    // (it will delete the file to simulate the missing scenario).
    if (meta.corruptionMode !== 'missing_file' && !existsSync(meta.filePath)) {
      return false;
    }

    return true;
  }

  /**
   * Inject corruption into the target file.
   *
   * Automatically snapshots the file before applying corruption so that
   * recover() can restore the original content.
   *
   * @param {Object} context - Fault context
   * @returns {Promise<void>}
   * @throws {FaultInjectionError}
   */
  async inject(context) {
    const { filePath, corruptionMode, keepBytes, malformedType, writeRatio } =
      context.metadata;

    try {
      // Snapshot before any mutation
      await this._injector.snapshot(filePath);

      switch (corruptionMode) {
        case 'truncate':
          await this._injector.truncate(filePath, keepBytes ?? 0);
          break;

        case 'malformed':
          await this._injector.injectMalformed(filePath, malformedType || 'syntax');
          break;

        case 'partial_write':
          await this._injector.simulatePartialWrite(filePath, writeRatio ?? 0.7);
          break;

        case 'missing_file':
          // Delete the file to simulate a missing checkpoint / state file
          if (existsSync(filePath)) {
            await fs.unlink(filePath);
          }
          break;

        case 'permissions':
          await this._injector.revokePermissions(filePath);
          this._permissionsRevoked = true;
          break;

        default:
          throw new Error(`Unsupported corruption mode: ${corruptionMode}`);
      }
    } catch (err) {
      // If the error is already a FaultInjectionError, rethrow
      if (err instanceof FaultInjectionError) {
        throw err;
      }
      throw new FaultInjectionError(
        `JSONL corruption injection failed (${corruptionMode}): ${err.message}`,
        context.faultId,
        context
      );
    }

    this._activeFilePath = filePath;
    this._activeMode = corruptionMode;
    this.active = true;
    this.injectedAt = context.now;

    if (this.emitEvents) {
      this.emit('faultApplied', {
        faultId: context.faultId,
        filePath,
        corruptionMode,
      });
    }
  }

  /**
   * Recover the file to its pre-corruption state.
   *
   * @param {Object} context - Fault context
   * @returns {Promise<void>}
   * @throws {FaultRecoveryError}
   */
  async recover(context) {
    const filePath = this._activeFilePath;
    if (!filePath) {
      // Nothing to recover
      this.active = false;
      this.injectedAt = null;
      return;
    }

    try {
      // Restore permissions first so we can write the file
      if (this._permissionsRevoked) {
        await this._injector.restorePermissions(filePath);
        this._permissionsRevoked = false;
      }

      // Restore file content from snapshot
      await this._injector.restore(filePath);

      // Discard snapshot to free disk space
      await this._injector.discardSnapshot(filePath);
    } catch (err) {
      throw new FaultRecoveryError(
        `JSONL corruption recovery failed for ${filePath}: ${err.message}`,
        context.faultId,
        context,
        err
      );
    }

    this._activeFilePath = null;
    this._activeMode = null;
    this.active = false;
    this.injectedAt = null;

    if (this.emitEvents) {
      this.emit('faultRecovered', {
        faultId: context.faultId,
        filePath,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // State & cleanup
  // ---------------------------------------------------------------------------

  /**
   * Extended state including corruption details.
   *
   * @returns {Object}
   */
  getState() {
    return {
      ...super.getState(),
      filePath: this._activeFilePath,
      corruptionMode: this._activeMode,
      permissionsRevoked: this._permissionsRevoked,
    };
  }

  /**
   * Best-effort cleanup — delegates to FaultProvider.cleanup which calls
   * recover() if the fault is still active.
   *
   * @param {Object} context - Fault context
   * @returns {Promise<void>}
   */
  async cleanup(context) {
    await super.cleanup(context);
  }
}

export default JSONLCorruptionProvider;
