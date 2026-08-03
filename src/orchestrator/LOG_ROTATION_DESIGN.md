# Log Rotation Module Interface Design

## Overview
This document defines the interface for the log rotation module (`src/orchestrator/log-rotation.js`) that will handle size-based and time-based rotation of log files with atomic file operations.

## Design Rationale

### Atomic Operations Pattern
Based on codebase research, the established pattern for atomic file operations is:
1. Write to a temporary file (`.tmp.{pid}` or similar)
2. Use `fsyncSync()` to ensure durability
3. Use `renameSync()` for atomic POSIX rename
4. Clean up orphaned temp files on startup

Sources:
- `src/dispatch-log.js` - SQLite-backed with atomic JSONL fallback
- `src/orchestrator/dispatch-log.js` - Debounced atomic writes with flush()
- `src/orchestrator/alert-rotation.js` - Current rotation (uses simple rename)
- `src/config.js:622-626` - Existing `anomalyAlerts` config section

### Archive Naming Convention
Current implementation uses: `anomaly-alerts.YYYY-MM-DDTHH:mm:ssZ.jsonl`

**Proposed change to match task spec**: `anomaly-alerts-YYYYMMDD-HHMMSS.jsonl`
- More compact (no colons/dots in timestamp)
- Better filesystem compatibility
- Clearer separation between base name and timestamp

## Module Interface

### Configuration Schema

```javascript
/**
 * LogRotationConfig - Configuration for log rotation
 * @typedef {Object} LogRotationConfig
 * @property {number} sizeThresholdBytes - Maximum file size before rotation (default: 10MB)
 * @property {number} rotationIntervalMs - Time-based rotation interval (default: 86400000 = 24h)
 * @property {string} archiveDir - Directory for archived logs (default: '.synapse/alerts-archive')
 * @property {string} strategy - Rotation strategy: 'size', 'time', or 'both' (default: 'size')
 * @property {number} maxArchives - Maximum number of archived files to retain (default: 10)
 * @property {boolean} compressArchives - Whether to compress archived files (default: false)
 */
```

### Environment Variable Mapping

| Config Key | ENV Variable | Default | Validation |
|------------|--------------|---------|------------|
| `sizeThresholdBytes` | `SYNAPSE_LOG_ROTATION_SIZE_THRESHOLD` | `10 * 1024 * 1024` (10MB) | min: 1MB, max: 1GB |
| `rotationIntervalMs` | `SYNAPSE_LOG_ROTATION_INTERVAL_MS` | `86400000` (24h) | min: 60000 (1m), max: 604800000 (7d) |
| `archiveDir` | `SYNAPSE_LOG_ROTATION_ARCHIVE_DIR` | `.synapse/alerts-archive` | non-empty string |
| `strategy` | `SYNAPSE_LOG_ROTATION_STRATEGY` | `size` | enum: size\|time\|both |
| `maxArchives` | `SYNAPSE_LOG_ROTATION_MAX_ARCHIVES` | `10` | min: 1, max: 100 |
| `compressArchives` | `SYNAPSE_LOG_ROTATION_COMPRESS` | `false` | boolean |

### Public API

#### 1. `rotateLogFile(filePath, config)`

**Purpose**: Check if rotation is needed and perform it if thresholds are exceeded.

**Signature**:
```javascript
/**
 * Check and rotate a log file based on configured thresholds.
 * @param {string} filePath - Absolute or relative path to the log file.
 * @param {LogRotationConfig} config - Rotation configuration.
 * @returns {Promise<RotationResult>} Result of rotation check/operation.
 */
export function rotateLogFile(filePath: string, config: LogRotationConfig): Promise<RotationResult>;
```

**Returns**:
```javascript
/**
 * @typedef {Object} RotationResult
 * @property {boolean} rotated - Whether rotation occurred.
 * @property {string|null} archivedFile - Path to archived file if rotated.
 * @property {number} sizeBytes - Size of file that was rotated.
 * @property {string} timestamp - ISO timestamp of rotation.
 * @property {string|null} error - Error message if rotation failed.
 */
```

**Behavior**:
- If file doesn't exist: return `{ rotated: false }`
- If under thresholds: return `{ rotated: false }`
- If rotation triggered: perform atomic rotation, return result
- If rotation fails: return `{ rotated: false, error: '...' }`

#### 2. `rotateFileNow(filePath, config)`

**Purpose**: Force immediate rotation regardless of thresholds.

**Signature**:
```javascript
/**
 * Force immediate rotation of a log file.
 * @param {string} filePath - Path to the log file.
 * @param {LogRotationConfig} config - Rotation configuration.
 * @returns {Promise<RotationResult>} Result of rotation.
 */
export function rotateFileNow(filePath: string, config: LogRotationConfig): Promise<RotationResult>;
```

#### 3. `formatArchiveName(baseName, timestamp)`

**Purpose**: Generate archive filename with timestamp.

**Signature**:
```javascript
/**
 * Generate archive filename with timestamp.
 * @param {string} baseName - Base filename without extension.
 * @param {Date|string|number} timestamp - Timestamp (Date, ISO string, or epoch ms).
 * @returns {string} Formatted archive name (e.g., 'anomaly-alerts-20260401-143022.jsonl').
 */
export function formatArchiveName(baseName: string, timestamp: Date|string|number): string;
```

**Example**:
```javascript
formatArchiveName('anomaly-alerts', new Date()) 
// => 'anomaly-alerts-20260401-143022.jsonl'

formatArchiveName('anomaly-alerts', '2026-04-01T14:30:22Z')
// => 'anomaly-alerts-20260401-143022.jsonl'
```

#### 4. `getRotationStatus(filePath, config)`

**Purpose**: Get current file status without rotating.

**Signature**:
```javascript
/**
 * Get current rotation status without performing rotation.
 * @param {string} filePath - Path to the log file.
 * @param {LogRotationConfig} config - Rotation configuration.
 * @returns {object} Status object.
 */
export function getRotationStatus(filePath: string, config: LogRotationConfig): object;
```

**Returns**:
```javascript
{
  exists: boolean,
  sizeBytes: number,
  lastModifiedMs: number,
  ageMs: number,
  exceedsSizeThreshold: boolean,
  exceedsTimeThreshold: boolean,
  shouldRotate: boolean,
  archiveCount: number  // Number of existing archives
}
```

#### 5. `cleanupOldArchives(archiveDir, config)`

**Purpose**: Remove old archives beyond `maxArchives` limit.

**Signature**:
```javascript
/**
 * Clean up old archived files beyond retention limit.
 * @param {string} archiveDir - Directory containing archived files.
 * @param {LogRotationConfig} config - Rotation configuration.
 * @returns {object} Cleanup result.
 */
export function cleanupOldArchives(archiveDir: string, config: LogRotationConfig): object;
```

**Returns**:
```javascript
{
  deleted: string[],  // List of deleted archive paths
  retained: string[], // List of retained archive paths
  error: string|null
}
```

#### 6. `createRotationScheduler(filePath, config, callback)`

**Purpose**: Create a scheduled rotation checker.

**Signature**:
```javascript
/**
 * Create a rotation scheduler that checks and rotates at configured intervals.
 * @param {string} filePath - Path to the log file.
 * @param {LogRotationConfig} config - Rotation configuration.
 * @param {function(object): void} callback - Callback invoked with rotation result.
 * @returns {object} Scheduler with start(), stop(), and getStatus() methods.
 */
export function createRotationScheduler(
  filePath: string,
  config: LogRotationConfig,
  callback: (result: RotationResult) => void
): {
  start(): void,
  stop(): void,
  getStatus(): { running: boolean, lastCheckMs: number|null, nextCheckMs: number|null }
};
```

**Usage**:
```javascript
const scheduler = createRotationScheduler(
  '/path/to/anomaly-alerts.jsonl',
  config,
  (result) => {
    if (result.rotated) {
      console.log('Log rotated:', result.archivedFile);
    }
  }
);

scheduler.start();  // Begin periodic checks
// ...
scheduler.stop();   // Stop scheduler
```

## Implementation Details

### Atomic Rotation Algorithm

```javascript
async function performAtomicRotation(filePath, archivePath) {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  
  try {
    // Step 1: Atomic rename of current file to archive
    fs.renameSync(filePath, archivePath);
    
    // Step 2: Create fresh empty file
    fs.writeFileSync(filePath, '', 'utf-8');
    
    // Step 3: Ensure durability with fsync
    const fd = fs.openSync(filePath, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    
    return true;
  } catch (err) {
    // Rollback: if archive was created but new file failed, restore from archive
    if (fs.existsSync(archivePath)) {
      try {
        fs.renameSync(archivePath, filePath);
      } catch (rollbackErr) {
        // Best-effort cleanup of orphaned archive
        try { fs.unlinkSync(archivePath); } catch {}
      }
    }
    throw err;
  }
}
```

### Size-Based Rotation Logic

```javascript
function shouldRotateBySize(filePath, sizeThresholdBytes) {
  if (!fs.existsSync(filePath)) return false;
  const stats = fs.statSync(filePath);
  return stats.size >= sizeThresholdBytes;
}
```

### Time-Based Rotation Logic

```javascript
function shouldRotateByTime(filePath, rotationIntervalMs) {
  if (!fs.existsSync(filePath)) return false;
  const stats = fs.statSync(filePath);
  const ageMs = Date.now() - stats.mtimeMs;
  return ageMs >= rotationIntervalMs;
}
```

### Combined Strategy

```javascript
function shouldRotate(filePath, config) {
  const { strategy, sizeThresholdBytes, rotationIntervalMs } = config;
  
  if (strategy === 'size') {
    return shouldRotateBySize(filePath, sizeThresholdBytes);
  }
  
  if (strategy === 'time') {
    return shouldRotateByTime(filePath, rotationIntervalMs);
  }
  
  // 'both' strategy: rotate if EITHER threshold is exceeded
  return shouldRotateBySize(filePath, sizeThresholdBytes) ||
         shouldRotateByTime(filePath, rotationIntervalMs);
}
```

## Config Integration

Add to `src/config.js` (after line 626, in the `anomalyAlerts` section):

```javascript
anomalyAlerts: Object.freeze({
  maxSizeBytes: envInt('SYNAPSE_ANOMALY_ALERTS_MAX_SIZE_BYTES', 10 * 1024 * 1024),
  archiveDir:   envStr('SYNAPSE_ANOMALY_ALERTS_ARCHIVE_DIR', '.synapse/alerts-archive'),
  rotationIntervalMs: envInt('SYNAPSE_ANOMALY_ALERTS_ROTATION_INTERVAL_MS', 86400000),
  strategy: Object.freeze({
    // Rotation strategy: 'size', 'time', or 'both'
    type: (['size', 'time', 'both'].includes(envStr('SYNAPSE_LOG_ROTATION_STRATEGY', 'size')))
      ? envStr('SYNAPSE_LOG_ROTATION_STRATEGY', 'size')
      : 'size',
  }),
  maxArchives: envInt('SYNAPSE_LOG_ROTATION_MAX_ARCHIVES', 10, 1, 100),
  compressArchives: envBool('SYNAPSE_LOG_ROTATION_COMPRESS', false),
}),
```

## Testing Strategy

### Unit Tests (`src/orchestrator/log-rotation.test.js`)

1. **Size threshold triggers rotation**: Create file > threshold, verify rotation
2. **Time threshold triggers rotation**: Create old file, verify time-based rotation
3. **Atomic operations prevent data loss**: Simulate crash mid-rotation, verify no corruption
4. **Archive naming format**: Verify `formatArchiveName` produces correct format
5. **No rotation under threshold**: Create file < threshold, verify no rotation
6. **Concurrent rotation safety**: Multiple concurrent calls don't corrupt data
7. **Cleanup old archives**: Verify `cleanupOldArchives` removes excess files
8. **Strategy modes**: Test 'size', 'time', and 'both' strategies
9. **Config validation**: Invalid values are clamped/rejected
10. **Scheduler lifecycle**: start/stop/getStatus work correctly

### Integration Tests

1. **End-to-end rotation**: Full rotation with real file I/O
2. **No data loss**: Verify all records preserved after rotation
3. **Archive integrity**: Archived files are valid JSONL
4. **Concurrent writes during rotation**: No lost writes during rotation

## Migration Path

The existing `src/orchestrator/alert-rotation.js` will be:
1. Updated to use the new `log-rotation.js` module
2. Changed archive naming from `YYYY-MM-DDTHH:mm:ssZ` to `YYYYMMDD-HHMMSS`
3. Enhanced with atomic write-rename pattern (currently just uses `renameSync`)
4. Made async to support future compression feature

## Dependencies

- Node.js `fs` module (sync operations for atomicity)
- `path` module for path manipulation
- `src/logger.js` for logging
- Optional: `zlib` for compression (future feature)

## Error Handling

| Error | Handling |
|-------|----------|
| File doesn't exist | Return `{ rotated: false }`, no error |
| Permission denied | Log error, return `{ rotated: false, error: '...' }` |
| Disk full during rotation | Rollback to original file, throw error |
| Archive dir doesn't exist | Create recursively, continue |
| Invalid config values | Clamp to valid range, log warning |
