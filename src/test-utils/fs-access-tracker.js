/**
 * File System Access Tracker and Leakage Detection
 * 
 * Monitors file system operations across projects to detect cross-project file access violations.
 * Tracks: file reads/writes, directory traversals, symlink resolution, and path normalization.
 * 
 * Leakage vectors monitored:
 *  - Cross-project file reads (reading files from another project's directory)
 *  - Cross-project file writes (writing files to another project's directory)
 *  - Shared file references (same file accessed by multiple projects)
 *  - Path traversal attempts (escaping project boundaries via ..)
 *  - Symlink following across project boundaries
 */

import { createHash } from 'crypto';
import { createLogger } from '../logger.js';
import { existsSync, statSync, readFileSync, realpathSync } from 'fs';
import { join, resolve, relative, dirname } from 'path';

const log = createLogger('fs-access-tracker');

export class FSAccessTracker {
  constructor(options = {}) {
    this.options = {
      trackReads: options.trackReads ?? true,
      trackWrites: options.trackWrites ?? true,
      trackDirectories: options.trackDirectories ?? true,
      normalizePaths: options.normalizePaths ?? true,
      resolveSymlinks: options.resolveSymlinks ?? true,
      maxHistoryLength: options.maxHistoryLength ?? 10000,
      enableRealtimeDetection: options.enableRealtimeDetection ?? true,
      ...options
    };
    
    // Project directory mappings: projectId -> projectDir
    this._projectDirs = new Map();
    
    // Access history: [{ path, operation, projectId, timestamp, stackTrace }]
    this._accessHistory = [];
    
    // File ownership tracking: normalizedPath -> { projectId, firstAccessedAt, accessCount }
    this._fileOwnership = new Map();
    
    // Detected violations
    this._violations = [];
    
    // Monitoring state
    this._enabled = false;
    this._activeProjectId = null;
    
    // Original fs module methods for wrapping
    this._originalFs = null;
  }

  /**
   * Initialize tracker with project directory mappings
   * @param {Map} projectDirs - Map of projectId -> projectDir
   */
  initialize(projectDirs) {
    this._projectDirs = new Map(projectDirs);
    log.debug('FS access tracker initialized', {
      projectCount: this._projectDirs.size,
      projects: Array.from(this._projectDirs.keys())
    });
  }

  /**
   * Start monitoring with optional active project context
   * @param {string} activeProjectId - Current project context for attribution
   */
  start(activeProjectId = null) {
    if (this._enabled) {
      log.warn('FS access tracker already enabled');
      return;
    }

    this._enabled = true;
    this._activeProjectId = activeProjectId;
    
    log.info('FS access tracking started', {
      activeProjectId,
      trackedProjects: Array.from(this._projectDirs.keys())
    });
  }

  /**
   * Stop monitoring
   */
  stop() {
    this._enabled = false;
    this._activeProjectId = null;
    
    log.info('FS access tracking stopped', {
      totalAccesses: this._accessHistory.length,
      violationsDetected: this._violations.length
    });
  }

  /**
   * Set the active project context for subsequent operations
   * @param {string} projectId - Current project ID
   */
  setActiveProject(projectId) {
    if (!this._projectDirs.has(projectId)) {
      log.warn('Setting active project not in tracked list', { projectId });
    }
    this._activeProjectId = projectId;
  }

  /**
   * Record a file access operation
   * @param {string} path - File path accessed
   * @param {string} operation - 'read', 'write', 'create', 'delete', 'stat'
   * @param {Object} metadata - Additional metadata (optional)
   */
  recordAccess(path, operation, metadata = {}) {
    if (!this._enabled) return;

    const projectId = metadata.projectId || this._activeProjectId;
    const normalizedPath = this._normalizePath(path);
    
    const accessRecord = {
      path,
      normalizedPath,
      operation,
      projectId,
      timestamp: Date.now(),
      isoTimestamp: new Date().toISOString(),
      metadata,
      stackTrace: this._captureStackTrace(),
    };

    this._accessHistory.push(accessRecord);
    this._pruneHistory();

    // Track file ownership
    this._trackOwnership(normalizedPath, projectId, operation);

    // Real-time violation detection
    if (this.options.enableRealtimeDetection) {
      const violations = this._detectViolationsForAccess(accessRecord);
      if (violations.length > 0) {
        this._violations.push(...violations);
        log.warn('FS access violation detected', {
          projectId,
          operation,
          path,
          violationType: violations[0].type
        });
      }
    }
  }

  /**
   * Wrap fs module methods to automatically track access
   * Returns proxy object with tracked methods
   */
  wrapFsModule() {
    if (!this._originalFs) {
      this._originalFs = {
        readFileSync: globalThis.fs?.readFileSync,
        writeFileSync: globalThis.fs?.writeFileSync,
        appendFileSync: globalThis.fs?.appendFileSync,
        existsSync: globalThis.fs?.existsSync,
        statSync: globalThis.fs?.statSync,
        realpathSync: globalThis.fs?.realpathSync,
      };
    }

    const self = this;
    
    return new Proxy({}, {
      get(target, prop) {
        if (prop === 'readFileSync') {
          return function(path, ...args) {
            self.recordAccess(path, 'read');
            return self._originalFs.readFileSync.call(this, path, ...args);
          };
        }
        if (prop === 'writeFileSync') {
          return function(path, ...args) {
            self.recordAccess(path, 'write');
            return self._originalFs.writeFileSync.call(this, path, ...args);
          };
        }
        if (prop === 'appendFileSync') {
          return function(path, ...args) {
            self.recordAccess(path, 'write');
            return self._originalFs.appendFileSync.call(this, path, ...args);
          };
        }
        if (prop === 'existsSync') {
          return function(path) {
            self.recordAccess(path, 'stat');
            return self._originalFs.existsSync.call(this, path);
          };
        }
        if (prop === 'statSync') {
          return function(path) {
            self.recordAccess(path, 'stat');
            return self._originalFs.statSync.call(this, path);
          };
        }
        if (prop === 'realpathSync') {
          return function(path) {
            self.recordAccess(path, 'realpath');
            return self._originalFs.realpathSync.call(this, path);
          };
        }
        return target[prop] ?? self._originalFs[prop];
      }
    });
  }

  /**
   * Check for violations in current state
   * @returns {Array} Array of violation objects
   */
  checkViolations() {
    if (!this._enabled) {
      return [];
    }

    const newViolations = [];

    // Check all access history for cross-project violations
    for (const access of this._accessHistory) {
      const violations = this._detectViolationsForAccess(access);
      newViolations.push(...violations);
    }

    // Check for shared file references across projects
    const sharingViolations = this._detectSharedFileReferences();
    newViolations.push(...sharingViolations);

    // Check for path traversal attempts
    const traversalViolations = this._detectPathTraversal();
    newViolations.push(...traversalViolations);

    this._violations = [...this._violations, ...newViolations];
    
    return newViolations;
  }

  /**
   * Detect violations for a specific access record
   */
  _detectViolationsForAccess(access) {
    const violations = [];
    const { normalizedPath, projectId, operation, path } = access;

    if (!projectId) {
      // Access without project context
      violations.push({
        type: 'unattributed_access',
        severity: 'medium',
        path,
        normalizedPath,
        operation,
        message: `File access without project context: ${path} (${operation})`,
        detectedAt: access.isoTimestamp,
        details: {
          path,
          operation,
          stackTrace: access.stackTrace
        }
      });
      return violations;
    }

    // Check if path is within project directory
    const projectDir = this._projectDirs.get(projectId);
    if (!projectDir) {
      violations.push({
        type: 'unknown_project_access',
        severity: 'low',
        path,
        normalizedPath,
        operation,
        projectId,
        message: `File access from unknown project: ${projectId}`,
        detectedAt: access.isoTimestamp,
      });
      return violations;
    }

    // Check for cross-project access
    const accessedProject = this._findProjectForPath(normalizedPath);
    if (accessedProject && accessedProject !== projectId) {
      violations.push({
        type: 'cross_project_file_access',
        severity: 'critical',
        path,
        normalizedPath,
        operation,
        sourceProject: projectId,
        targetProject: accessedProject,
        message: `Cross-project ${operation} detected: ${projectId} accessed file in ${accessedProject}: ${path}`,
        detectedAt: access.isoTimestamp,
        details: {
          sourceProject: projectId,
          targetProject: accessedProject,
          path,
          normalizedPath,
          operation,
          projectDir: this._projectDirs.get(accessedProject)
        }
      });
    }

    // Check for access outside any project directory (but within base dir)
    if (!accessedProject && !this._isSystemPath(normalizedPath)) {
      const relativePath = relative(projectDir, normalizedPath);
      if (!relativePath.startsWith('..')) {
        // File is outside project but not a system path
        violations.push({
          type: 'unscoped_file_access',
          severity: 'medium',
          path,
          normalizedPath,
          operation,
          projectId,
          message: `File access outside project scope: ${projectId} accessed ${path}`,
          detectedAt: access.isoTimestamp,
          details: {
            projectId,
            projectDir,
            path,
            normalizedPath,
            operation
          }
        });
      }
    }

    return violations;
  }

  /**
   * Detect shared file references across projects
   */
  _detectSharedFileReferences() {
    const violations = [];
    const fileAccesses = new Map(); // normalizedPath -> [{projectId, operation, timestamp}]

    // Group accesses by normalized path
    for (const access of this._accessHistory) {
      const { normalizedPath, projectId, operation, timestamp } = access;
      if (!fileAccesses.has(normalizedPath)) {
        fileAccesses.set(normalizedPath, []);
      }
      fileAccesses.get(normalizedPath).push({ projectId, operation, timestamp });
    }

    // Find files accessed by multiple projects
    for (const [path, accesses] of fileAccesses) {
      const projects = new Set(accesses.map(a => a.projectId).filter(p => p));
      
      if (projects.size > 1) {
        const writeAccesses = accesses.filter(a => a.operation === 'write');
        const hasWriteFromMultiple = new Set(writeAccesses.map(a => a.projectId)).size > 1;
        
        violations.push({
          type: 'shared_file_reference',
          severity: hasWriteFromMultiple ? 'critical' : 'high',
          path,
          projects: Array.from(projects),
          accessCount: accesses.length,
          writeCount: writeAccesses.length,
          message: `File accessed by multiple projects: ${path} (${Array.from(projects).join(', ')})`,
          detectedAt: new Date().toISOString(),
          details: {
            path,
            projects: Array.from(projects),
            accesses: accesses.map(a => ({
              projectId: a.projectId,
              operation: a.operation,
              timestamp: a.timestamp
            }))
          }
        });
      }
    }

    return violations;
  }

  /**
   * Detect path traversal attempts
   */
  _detectPathTraversal() {
    const violations = [];

    for (const access of this._accessHistory) {
      const { path, projectId } = access;
      
      // Check for .. in path
      if (path.includes('..')) {
        const projectDir = this._projectDirs.get(projectId);
        const normalized = this._normalizePath(path);
        
        if (projectDir && !normalized.startsWith(projectDir)) {
          violations.push({
            type: 'path_traversal_attempt',
            severity: 'high',
            path,
            normalizedPath: normalized,
            projectId,
            projectDir,
            message: `Potential path traversal detected from ${projectId}: ${path} resolves to ${normalized}`,
            detectedAt: access.isoTimestamp,
            details: {
              originalPath: path,
              normalizedPath: normalized,
              projectDir,
              projectId
            }
          });
        }
      }
    }

    return violations;
  }

  /**
   * Track file ownership per project
   */
  _trackOwnership(normalizedPath, projectId, operation) {
    if (!this._fileOwnership.has(normalizedPath)) {
      this._fileOwnership.set(normalizedPath, {
        projectId,
        firstAccessedAt: Date.now(),
        accessCount: 0,
        operations: new Set()
      });
    }

    const ownership = this._fileOwnership.get(normalizedPath);
    ownership.accessCount++;
    ownership.operations.add(operation);
    
    // If file was previously owned by another project and now written to by different project
    if (ownership.projectId && ownership.projectId !== projectId && operation === 'write') {
      log.warn('File ownership conflict detected', {
        path: normalizedPath,
        originalOwner: ownership.projectId,
        newWriter: projectId
      });
    }
  }

  /**
   * Find which project a path belongs to
   */
  _findProjectForPath(normalizedPath) {
    for (const [projectId, projectDir] of this._projectDirs) {
      if (normalizedPath.startsWith(projectDir + '/') || normalizedPath === projectDir) {
        return projectId;
      }
    }
    return null;
  }

  /**
   * Check if path is a system/internal path (not project-specific)
   */
  _isSystemPath(path) {
    const systemPaths = [
      '/node_modules',
      '/.synapse',
      'package.json',
      'node:',
      'fs:',
    ];
    
    return systemPaths.some(sp => path.includes(sp));
  }

  /**
   * Normalize path for comparison
   */
  _normalizePath(path) {
    if (!path) return path;
    
    let normalized = resolve(path);
    
    if (this.options.resolveSymlinks && existsSync(normalized)) {
      try {
        normalized = realpathSync(normalized);
      } catch (err) {
        // realpath might fail for some files, keep resolved path
      }
    }
    
    return normalized;
  }

  /**
   * Capture stack trace for debugging
   */
  _captureStackTrace() {
    try {
      const err = new Error();
      Error.captureStackTrace(err, this._captureStackTrace);
      return err.stack.split('\n').slice(1, 5).join('\n');
    } catch (e) {
      return null;
    }
  }

  /**
   * Prune old history entries
   */
  _pruneHistory() {
    if (this._accessHistory.length > this.options.maxHistoryLength) {
      const removeCount = this._accessHistory.length - this.options.maxHistoryLength;
      this._accessHistory = this._accessHistory.slice(removeCount);
    }
  }

  /**
   * Get access statistics
   */
  getStatistics() {
    const stats = {
      totalAccesses: this._accessHistory.length,
      reads: 0,
      writes: 0,
      stats: 0,
      byProject: {},
      byPath: new Map(),
      uniquePaths: 0,
    };

    for (const access of this._accessHistory) {
      // Map operations to plural form for stats
      const op = access.operation === 'read' ? 'reads' : 
                 access.operation === 'write' ? 'writes' : 
                 access.operation;
      stats[op] = (stats[op] || 0) + 1;
      
      if (!stats.byProject[access.projectId]) {
        stats.byProject[access.projectId] = 0;
      }
      stats.byProject[access.projectId]++;
      
      if (!stats.byPath.has(access.normalizedPath)) {
        stats.byPath.set(access.normalizedPath, 0);
      }
      const currentCount = stats.byPath.get(access.normalizedPath);
      stats.byPath.set(access.normalizedPath, currentCount + 1);
    }

    stats.uniquePaths = stats.byPath.size;
    stats.byPath = Object.fromEntries(stats.byPath);

    return stats;
  }

  /**
   * Get all violations
   */
  getViolations() {
    return [...this._violations];
  }

  /**
   * Get violations by severity
   */
  getViolationsBySeverity(severity) {
    return this._violations.filter(v => v.severity === severity);
  }

  /**
   * Get violations by type
   */
  getViolationsByType(type) {
    return this._violations.filter(v => v.type === type);
  }

  /**
   * Get access history
   */
  getAccessHistory() {
    return [...this._accessHistory];
  }

  /**
   * Get access history filtered by project
   */
  getAccessHistoryByProject(projectId) {
    return this._accessHistory.filter(a => a.projectId === projectId);
  }

  /**
   * Get file ownership map
   */
  getFileOwnership() {
    const ownership = {};
    for (const [path, data] of this._fileOwnership) {
      ownership[path] = {
        projectId: data.projectId,
        firstAccessedAt: data.firstAccessedAt,
        accessCount: data.accessCount,
        operations: Array.from(data.operations)
      };
    }
    return ownership;
  }

  /**
   * Generate comprehensive report
   */
  generateReport() {
    const stats = this.getStatistics();
    const violations = this.getViolations();
    
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalAccesses: stats.totalAccesses,
        reads: stats.reads,
        writes: stats.writes,
        uniquePaths: stats.uniquePaths,
        projectsTracked: this._projectDirs.size,
        totalViolations: violations.length,
        criticalViolations: violations.filter(v => v.severity === 'critical').length,
        highViolations: violations.filter(v => v.severity === 'high').length,
        mediumViolations: violations.filter(v => v.severity === 'medium').length,
        lowViolations: violations.filter(v => v.severity === 'low').length,
      },
      statistics: stats,
      violations: violations,
      violationBreakdown: this._generateViolationBreakdown(violations),
      recommendations: this._generateRecommendations(violations),
      isolationVerified: violations.filter(v => v.severity === 'critical' || v.severity === 'high').length === 0
    };

    return report;
  }

  /**
   * Generate violation breakdown by type
   */
  _generateViolationBreakdown(violations) {
    const breakdown = {};
    
    for (const v of violations) {
      if (!breakdown[v.type]) {
        breakdown[v.type] = {
          count: 0,
          severityBreakdown: {},
          paths: new Set()
        };
      }
      breakdown[v.type].count++;
      breakdown[v.type].severityBreakdown[v.severity] = 
        (breakdown[v.type].severityBreakdown[v.severity] || 0) + 1;
      if (v.path) breakdown[v.type].paths.add(v.path);
    }

    // Convert sets to arrays for JSON serialization
    for (const type in breakdown) {
      breakdown[type].paths = Array.from(breakdown[type].paths);
    }

    return breakdown;
  }

  /**
   * Generate recommendations based on violations
   */
  _generateRecommendations(violations) {
    const recommendations = [];

    const crossProjectViolations = violations.filter(v => v.type === 'cross_project_file_access');
    if (crossProjectViolations.length > 0) {
      recommendations.push({
        priority: 'critical',
        message: 'Cross-project file access detected',
        count: crossProjectViolations.length,
        action: 'Review file system isolation between projects. Ensure each campaign only accesses files within its project directory.',
        affectedPaths: [...new Set(crossProjectViolations.map(v => v.path))]
      });
    }

    const sharedFileViolations = violations.filter(v => v.type === 'shared_file_reference');
    if (sharedFileViolations.length > 0) {
      recommendations.push({
        priority: 'high',
        message: 'Shared file references detected across projects',
        count: sharedFileViolations.length,
        action: 'Investigate shared file access patterns. Consider using project-scoped temporary directories.',
        affectedPaths: [...new Set(sharedFileViolations.map(v => v.path))]
      });
    }

    const traversalViolations = violations.filter(v => v.type === 'path_traversal_attempt');
    if (traversalViolations.length > 0) {
      recommendations.push({
        priority: 'high',
        message: 'Path traversal attempts detected',
        count: traversalViolations.length,
        action: 'Review file path validation logic. Ensure all paths are validated against project boundaries.',
        affectedPaths: [...new Set(traversalViolations.map(v => v.path))]
      });
    }

    if (recommendations.length === 0) {
      recommendations.push({
        priority: 'info',
        message: 'No file system access violations detected',
        action: 'Continue monitoring to maintain isolation'
      });
    }

    return recommendations;
  }

  /**
   * Reset tracker state
   */
  reset() {
    this._accessHistory = [];
    this._violations = [];
    this._fileOwnership.clear();
    this._enabled = false;
    this._activeProjectId = null;
    log.debug('FS access tracker reset');
  }

  /**
   * Get current active project
   */
  getActiveProject() {
    return this._activeProjectId;
  }

  /**
   * Get tracked projects
   */
  getTrackedProjects() {
    return new Map(this._projectDirs);
  }

  set enabled(value) {
    this._enabled = value;
  }

  get enabled() {
    return this._enabled;
  }
}

/**
 * Factory function to create FS access tracker
 */
export function createFSAccessTracker(options) {
  return new FSAccessTracker(options);
}

export default FSAccessTracker;
