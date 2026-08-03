import {
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  statSync,
  mkdirSync,
  existsSync,
  rmSync,
  copyFileSync,
  lstatSync,
  symlinkSync,
  readlinkSync
} from 'fs';
import { join, dirname, relative } from 'path';
import { randomUUID, createHash } from 'crypto';
import { createLogger } from './logger.js';
import { DangerousCommandDetector } from './orchestrator/dangerous-command-detector.js';
// import { proposeChange } from './governance.js';

const log = createLogger('filesystem-checkpoint');

// Singleton detector instance for obfuscation-aware dangerous command detection
let _detectorInstance = null;
function getDetectorInstance() {
  if (!_detectorInstance) {
    _detectorInstance = new DangerousCommandDetector();
    _detectorInstance.loadAllowlist();
  }
  return _detectorInstance;
}

const CHECKPOINTS_BASE_DIR = '.synapse/fs-checkpoints';
const MAX_CHECKPOINTS = 10;
const PERFORMANCE_THRESHOLD_MS = 100;
const DEFAULT_TARGETED_MAX_FILE_SIZE = 512 * 1024; // 512KB
const DEFAULT_TARGETED_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.json', '.yaml', '.yml', '.toml', '.md',
  '.py', '.rb', '.sh', '.bash',
  '.css', '.html', '.sql', '.env',
  '.config', '.lock'
]);

// Track per-project performance to auto-switch to targeted mode
const projectPerformanceCache = new Map();

const DANGEROUS_COMMAND_PATTERNS = [
  { pattern: /rm\s+-rf/, severity: 'critical', description: 'Recursive directory deletion' },
  { pattern: /git\s+reset\s+--hard/, severity: 'critical', description: 'Git hard reset destroying uncommitted changes' },
  { pattern: /git\s+push\s+--force/, severity: 'high', description: 'Forceful git push' },
  { pattern: /DROP\s+TABLE/i, severity: 'critical', description: 'Database table deletion' },
  { pattern: /DROP\s+DATABASE/i, severity: 'critical', description: 'Database deletion' },
  { pattern: /TRUNCATE\s+TABLE/i, severity: 'high', description: 'Database table truncation' },
  { pattern: /mkfs\s+/, severity: 'critical', description: 'Filesystem formatting' },
  { pattern: /dd\s+if=\/dev\//, severity: 'critical', description: 'Raw device write' },
  { pattern: /chmod\s+-R\s+777/, severity: 'high', description: 'Dangerous permission change' },
  { pattern: /find.*-exec\s+rm/, severity: 'critical', description: 'Find with recursive delete' }
];

/**
 * Ensures the base directory for filesystem checkpoints exists for a given project.
 * @param {string} baseDir - The root directory of the repository (e.g., /path/to/synapse).
 * @param {string} projectId - The ID of the project.
 * @returns {string} The absolute path to the project's checkpoint directory.
 */
function ensureProjectCheckpointDir(baseDir, projectId) {
  const dir = join(baseDir, CHECKPOINTS_BASE_DIR, projectId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    log.debug(`Created project checkpoint directory: ${dir}`);
  }
  return dir;
}

/**
 * Gets the absolute path for a specific checkpoint.
 * @param {string} baseDir - The root directory of the repository.
 * @param {string} projectId - The ID of the project.
 * @param {string} checkpointId - The ID of the checkpoint.
 * @returns {string} The absolute path to the checkpoint directory.
 */
function getCheckpointPath(baseDir, projectId, checkpointId) {
  return join(baseDir, CHECKPOINTS_BASE_DIR, projectId, checkpointId);
}

/**
 * Recursively copies files and directories.
 * @param {string} src - The source path.
 * @param {string} dest - The destination path.
 * @param {string} [rootSrc] - The root source directory to calculate relative paths.
 */
function hashFile(filePath) {
  const hash = createHash('sha256');
  const content = readFileSync(filePath);
  hash.update(content);
  return hash.digest('hex');
}

export function detectDangerousCommand(command) {
  // Use orchestrator's detector which handles obfuscation (base64, URL encoding, command substitution)
  const detector = getDetectorInstance();
  const result = detector.detectDangerous(command);

  // Map orchestrator's result format to the expected format
  if (!result.isDangerous) {
    return { isDangerous: false };
  }

  // Determine severity based on pattern description to match original expectations
  const criticalPatterns = [
    'Recursive force file deletion',
    'Destructive git reset',
    'SQL drop operation',
    'Raw device write operation',
    'Find with recursive delete'
  ];

  const highPatterns = [
    'Force push to remote',
    'Force clean untracked files',
    'Force delete git branch',
    'Discard all local changes',
    'SQL truncate table',
    'SQL delete without proper WHERE',
    'Setting overly permissive file permissions'
  ];

  // Check if any match is critical or high priority
  let severity = result.risk; // default to orchestrator's risk level

  for (const match of result.matches) {
    if (criticalPatterns.some(cp => match.pattern.includes(cp))) {
      severity = 'critical';
      break;
    } else if (highPatterns.some(hp => match.pattern.includes(hp))) {
      severity = 'high';
    }
  }

  // Fallback mapping for cases not covered above
  if (severity === 'medium' && result.matches.length > 0) {
    severity = 'medium';
  } else if (severity === 'low') {
    severity = 'low';
  }

  return {
    isDangerous: true,
    severity,
    description: result.pattern || 'Dangerous command detected',
    matches: result.matches,
    obfuscationDetected: result.obfuscationDetected
  };
}

export async function escalateDangerousCommand(projectId, command, detection) {
  // TODO: Restore this once governance.js exports proposeChange or equivalent
  /*
  const proposal = await proposeChange(projectId, {
    type: 'dangerous_command_detected',
    severity: detection.severity,
    command,
    description: detection.description,
    timestamp: Date.now(),
    requiresApproval: true
  });
  log.warn(`Dangerous command escalated: ${command}. Proposal ID: ${proposal.id}`);
  return proposal;
  */
  log.warn(`Dangerous command detected but escalation temporarily disabled: ${command}`);
  return { id: 'mock_proposal_id', status: 'pending' };
}

/**
 * Checks if a file should be included in targeted backup mode.
 * @param {string} filePath - The file path to check.
 * @param {number} fileSize - The file size in bytes.
 * @param {object} targetedOpts - Targeted mode options.
 * @returns {boolean} Whether to include the file.
 */
function shouldIncludeInTargetedMode(filePath, fileSize, targetedOpts) {
  const { maxFileSize, extensions, includePatterns, excludePatterns } = targetedOpts;

  // Check exclude patterns first
  if (excludePatterns) {
    for (const pat of excludePatterns) {
      if (pat.test(filePath)) return false;
    }
  }

  // Check include patterns (if specified, overrides extension check)
  if (includePatterns && includePatterns.length > 0) {
    for (const pat of includePatterns) {
      if (pat.test(filePath)) return true;
    }
    return false;
  }

  // Size check
  if (fileSize > maxFileSize) return false;

  // Extension check
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  if (extensions && !extensions.has(ext)) return false;

  return true;
}

function copyRecursiveSync(src, dest, rootSrc, manifest = [], targetedOpts = null) {
  // Prevent infinite recursion by skipping the checkpoints directory
  if (src.includes(CHECKPOINTS_BASE_DIR)) return;

  // If rootSrc not provided, use src as root
  if (!rootSrc) rootSrc = src;

  const stats = lstatSync(src);
  const isSymlink = stats.isSymbolicLink();
  const isDirectory = stats.isDirectory();

  if (isSymlink) {
    const linkTarget = readlinkSync(src);
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(linkTarget, dest);
    manifest.push({
      path: relative(rootSrc, src),
      type: 'symlink',
      target: linkTarget
    });
  } else if (isDirectory) {
    mkdirSync(dest, { recursive: true });
    readdirSync(src).forEach(item => {
      copyRecursiveSync(join(src, item), join(dest, item), rootSrc, manifest, targetedOpts);
    });
  } else {
    // In targeted mode, skip files that don't match criteria
    if (targetedOpts && !shouldIncludeInTargetedMode(src, stats.size, targetedOpts)) {
      return;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    manifest.push({
      path: relative(rootSrc, src),
      type: 'file',
      size: stats.size,
      mtime: stats.mtimeMs,
      hash: hashFile(src)
    });
  }
}


function pruneCheckpoints(baseDir, projectId) {
  const projectCheckpointDir = join(baseDir, CHECKPOINTS_BASE_DIR, projectId);
  if (!existsSync(projectCheckpointDir)) return;

  try {
    const checkpoints = readdirSync(projectCheckpointDir)
      .filter(name => name.startsWith('fsckpt_'))
      .map(name => ({ name, path: join(projectCheckpointDir, name) }))
      .sort((a, b) => {
         const timeA = parseInt(a.name.split('_')[1] || '0');
         const timeB = parseInt(b.name.split('_')[1] || '0');
         return timeA - timeB;
      });

    if (checkpoints.length > MAX_CHECKPOINTS) {
      const toDelete = checkpoints.slice(0, checkpoints.length - MAX_CHECKPOINTS);
      for (const ckpt of toDelete) {
        rmSync(ckpt.path, { recursive: true, force: true });
        log.info(`Pruned old checkpoint: ${ckpt.name}`);
      }
    }
  } catch (err) {
    log.warn(`Error during checkpoint pruning: ${err.message}`);
  }
}

/**
 * Creates a filesystem checkpoint for specified paths.
 * If previous checkpoints for this project exceeded the performance threshold,
 * automatically switches to targeted mode which filters files by extension and size.
 *
 * @param {string} baseDir - The root directory of the repository.
 * @param {string} projectId - The ID of the project.
 * @param {Array<string>} paths - An array of absolute paths to files or directories to checkpoint.
 * @param {object} [options] - Optional checkpoint configuration.
 * @param {boolean} [options.targeted] - Force targeted mode (only back up files matching criteria).
 * @param {number} [options.maxFileSize] - Max file size in bytes for targeted mode (default 512KB).
 * @param {Set<string>} [options.extensions] - File extensions to include in targeted mode.
 * @param {RegExp[]} [options.includePatterns] - Regex patterns to include (overrides extensions).
 * @param {RegExp[]} [options.excludePatterns] - Regex patterns to exclude.
 * @returns {string} The unique ID of the created checkpoint.
 */
export function createCheckpoint(baseDir, projectId, paths, options = {}) {
  const checkpointId = `fsckpt_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const checkpointDir = getCheckpointPath(baseDir, projectId, checkpointId);

  ensureProjectCheckpointDir(baseDir, projectId);
  mkdirSync(checkpointDir, { recursive: true });

  // Determine if targeted mode should be used
  const prevPerf = projectPerformanceCache.get(projectId);
  const useTargeted = options.targeted === true ||
    (options.targeted !== false && !!prevPerf && prevPerf.lastDurationMs > PERFORMANCE_THRESHOLD_MS);

  const targetedOpts = useTargeted ? {
    maxFileSize: options.maxFileSize || DEFAULT_TARGETED_MAX_FILE_SIZE,
    extensions: options.extensions || DEFAULT_TARGETED_EXTENSIONS,
    includePatterns: options.includePatterns || null,
    excludePatterns: options.excludePatterns || null,
  } : null;

  const startTime = process.hrtime.bigint();
  const manifest = {
    checkpointId,
    projectId,
    created: Date.now(),
    targeted: useTargeted,
    paths: [],
    files: []
  };

  for (const path of paths) {
    if (!existsSync(path)) {
      log.warn(`Path to checkpoint does not exist, skipping: ${path}`);
      continue;
    }
    const relativePath = relative(baseDir, path);
    const destPath = join(checkpointDir, relativePath);
    manifest.paths.push(relativePath);
    copyRecursiveSync(path, destPath, baseDir, manifest.files, targetedOpts);
  }

  const endTime = process.hrtime.bigint();
  const durationMs = Number(endTime - startTime) / 1_000_000;
  manifest.durationMs = durationMs;

  writeFileSync(join(checkpointDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Update performance cache for auto-targeted switching
  projectPerformanceCache.set(projectId, {
    lastDurationMs: durationMs,
    lastFileCount: manifest.files.length,
    wasTargeted: useTargeted,
  });

  if (durationMs > PERFORMANCE_THRESHOLD_MS && !useTargeted) {
    log.warn(`Checkpoint exceeded ${PERFORMANCE_THRESHOLD_MS}ms threshold (${durationMs.toFixed(2)} ms). Next checkpoint will auto-switch to targeted mode.`);
  } else if (useTargeted) {
    log.info(`Targeted checkpoint '${checkpointId}' created for project '${projectId}' in ${durationMs.toFixed(2)} ms (${manifest.files.length} files).`);
  }

  pruneCheckpoints(baseDir, projectId);

  log.info(`Filesystem checkpoint '${checkpointId}' created for project '${projectId}' in ${durationMs.toFixed(2)} ms (${manifest.files.length} files, targeted: ${useTargeted}).`);
  return checkpointId;
}

/**
 * Restores the filesystem to a previously created checkpoint.
 * @param {string} baseDir - The root directory of the repository.
 * @param {string} projectId - The ID of the project.
 * @param {string} checkpointId - The ID of the checkpoint to restore from.
 */
export function restoreCheckpoint(baseDir, projectId, checkpointId) {
  const checkpointDir = getCheckpointPath(baseDir, projectId, checkpointId);

  if (!existsSync(checkpointDir)) {
    throw new Error(`Checkpoint '${checkpointId}' not found for project '${projectId}'.`);
  }

  const startTime = process.hrtime.bigint();

  // Read manifest to know what paths were checkpointed
  const manifestPath = join(checkpointDir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf-8')) : null;

  // Only clean up if manifest exists and has paths
  // Skip cleanup if paths don't exist to save time
  if (manifest && manifest.paths) {
    for (const relPath of manifest.paths) {
      const fullPath = join(baseDir, relPath);
      if (existsSync(fullPath)) {
        rmSync(fullPath, { recursive: true, force: true });
      }
    }
  }

  // Iterate through checkpoint contents and copy back to original locations
  const checkpointContents = readdirSync(checkpointDir, { recursive: true, withFileTypes: true });

  for (const entry of checkpointContents) {
    const srcPath = join(entry.path, entry.name);
    const relativePath = relative(checkpointDir, srcPath);
    const destPath = join(baseDir, relativePath);

    if (entry.isFile()) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
    } else if (entry.isDirectory()) {
      // Directories will be created as part of file copying if they don't exist
      // No need to explicitly create them here unless they are empty.
      // For simplicity, we rely on mkdirSync in copyFileSync.
    }
  }

  const endTime = process.hrtime.bigint();
  const durationMs = Number(endTime - startTime) / 1_000_000;
  
  if (durationMs > 100) {
    log.warn(`Restore exceeded 100ms threshold (${durationMs.toFixed(2)} ms). Consider targeted backup for high-risk paths only.`);
  }
  
  log.info(`Filesystem checkpoint '${checkpointId}' restored for project '${projectId}' in ${durationMs.toFixed(2)} ms.`);
}

/**
 * Cleans up (removes) a specific filesystem checkpoint.
 * @param {string} baseDir - The root directory of the repository.
 * @param {string} projectId - The ID of the project.
 * @param {string} checkpointId - The ID of the checkpoint to clean up.
 */
export function cleanupCheckpoint(baseDir, projectId, checkpointId) {
  const checkpointDir = getCheckpointPath(baseDir, projectId, checkpointId);

  if (existsSync(checkpointDir)) {
    rmSync(checkpointDir, { recursive: true, force: true });
    log.info(`Filesystem checkpoint '${checkpointId}' cleaned up for project '${projectId}'.`);
  } else {
    log.warn(`Attempted to clean up non-existent checkpoint '${checkpointId}' for project '${projectId}'.`);
  }
}

// Export for testing purposes
export const _test = {
  ensureProjectCheckpointDir,
  getCheckpointPath,
  copyRecursiveSync,
  shouldIncludeInTargetedMode,
  projectPerformanceCache,
  PERFORMANCE_THRESHOLD_MS,
  DEFAULT_TARGETED_MAX_FILE_SIZE,
  DEFAULT_TARGETED_EXTENSIONS,
};