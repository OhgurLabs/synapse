/**
 * Memory Isolation Monitor for Agent Context
 * Detects memory leaks and state contamination between concurrent campaigns in different projects.
 * Monitors: agent context objects, session state, memory store references, and closure captures.
 */

import { createHash } from 'crypto';

/**
 * Memory isolation monitor tracks agent context allocations and detects cross-project contamination.
 * Identifies when agent instances share mutable state across project boundaries.
 */
export class MemoryIsolationMonitor {
  constructor() {
    // Project-scoped memory tracking: projectId -> { agentId -> contextSnapshot }
    this._projectMemory = new Map();
    
    // Global agent instance tracking: agentId -> { projectIds: Set, lastSeenProject: string }
    this._agentInstances = new Map();
    
    // Closure capture tracking for detecting shared references
    this._closureCaptures = new Map(); // referenceId -> { projectId, agentId, type, snapshot }
    
    // Detected violations
    this._violations = [];
    
    // Monitoring state
    this._enabled = true;
    this._snapshotInterval = null;
    this._baselineSnapshots = new Map(); // projectId -> baseline snapshot
  }

  /**
   * Start monitoring for a specific project.
   * Captures baseline memory state.
   */
  startProject(projectId) {
    if (!this._projectMemory.has(projectId)) {
      this._projectMemory.set(projectId, new Map());
    }
    this._captureBaseline(projectId);
  }

  /**
   * Stop monitoring and cleanup for a project.
   */
  stopProject(projectId) {
    if (this._projectMemory.has(projectId)) {
      this._projectMemory.delete(projectId);
    }
    if (this._baselineSnapshots.has(projectId)) {
      this._baselineSnapshots.delete(projectId);
    }
  }

  /**
   * Register an agent instance for a project.
   * Tracks which projects each agent instance serves to detect cross-contamination.
   */
  registerAgent(agentId, projectId, context = {}) {
    if (!this._enabled) return;

    // Initialize project memory map if needed
    if (!this._projectMemory.has(projectId)) {
      this._projectMemory.set(projectId, new Map());
    }

    // Store context snapshot
    const snapshot = this._snapshotContext(context);
    this._projectMemory.get(projectId).set(agentId, {
      snapshot,
      registeredAt: Date.now(),
      projectId,
      references: new Set(),
    });

    // Track agent instance across projects
    if (!this._agentInstances.has(agentId)) {
      this._agentInstances.set(agentId, {
        projectIds: new Set(),
        lastSeenProject: projectId,
        firstSeenAt: Date.now(),
      });
    }

    const agentInfo = this._agentInstances.get(agentId);
    const previousProject = agentInfo.lastSeenProject;
    agentInfo.projectIds.add(projectId);
    agentInfo.lastSeenProject = projectId;

    // Detect if agent is being shared across projects (potential contamination vector)
    if (previousProject && previousProject !== projectId) {
      this._checkForCrossProjectAgent(agentId, previousProject, projectId);
    }
  }

  /**
   * Record a memory allocation or reference for tracking.
   */
  recordReference(agentId, projectId, refType, value) {
    if (!this._enabled) return;
    if (value === undefined || value === null) return;

    const refId = this._computeRefId(agentId, projectId, refType, value);
    
    this._closureCaptures.set(refId, {
      projectId,
      agentId,
      type: refType,
      snapshot: this._snapshotValue(value),
      recordedAt: Date.now(),
    });

    // Link reference to project memory
    if (this._projectMemory.has(projectId) && this._projectMemory.get(projectId).has(agentId)) {
      this._projectMemory.get(projectId).get(agentId).references.add(refId);
    }
  }

  /**
   * Check for memory isolation violations.
   * Returns array of detected violations.
   */
  checkViolations() {
    const violations = [];

    // Check 1: Cross-project agent instance sharing
    for (const [agentId, info] of this._agentInstances) {
      if (info.projectIds.size > 1) {
        violations.push({
          type: 'cross_project_agent_sharing',
          severity: 'high',
          agentId,
          projectIds: Array.from(info.projectIds),
          message: `Agent ${agentId} shared across ${info.projectIds.size} projects: ${Array.from(info.projectIds).join(', ')}`,
          detectedAt: new Date().toISOString(),
        });
      }
    }

    // Check 2: Session context leakage between projects
    const sessionViolations = this._checkSessionLeakage();
    violations.push(...sessionViolations);

    // Check 3: Memory store contamination
    const memoryViolations = this._checkMemoryStoreContamination();
    violations.push(...memoryViolations);

    // Check 4: Closure capture leakage
    const closureViolations = this._checkClosureLeakage();
    violations.push(...closureViolations);

    this._violations = violations;
    return violations;
  }

  /**
   * Check for session context leakage between projects.
   * Detects when session state from one project appears in another.
   */
  _checkSessionLeakage() {
    const violations = [];
    const projectIds = Array.from(this._projectMemory.keys());

    for (let i = 0; i < projectIds.length; i++) {
      for (let j = i + 1; j < projectIds.length; j++) {
        const projA = projectIds[i];
        const projB = projectIds[j];

        const agentsA = this._projectMemory.get(projA);
        const agentsB = this._projectMemory.get(projB);

        // Check for shared agent instances with overlapping context
        for (const [agentId, dataA] of agentsA) {
          if (agentsB.has(agentId)) {
            const dataB = agentsB.get(agentId);
            
            // Check if context snapshots share references
            if (this._contextsOverlap(dataA.snapshot, dataB.snapshot)) {
              violations.push({
                type: 'session_context_leakage',
                severity: 'critical',
                agentId,
                sourceProject: projA,
                targetProject: projB,
                message: `Session context from ${projA} leaked into ${projB} via agent ${agentId}`,
                detectedAt: new Date().toISOString(),
              });
            }
          }
        }
      }
    }

    return violations;
  }

  /**
   * Check for memory store contamination.
   * Detects when agent memory entries reference data from other projects.
   */
  _checkMemoryStoreContamination() {
    const violations = [];
    const projectIds = Array.from(this._projectMemory.keys());

    for (const projectId of projectIds) {
      const agents = this._projectMemory.get(projectId);
      
      for (const [agentId, data] of agents) {
        // Check if any references point to other projects
        for (const refId of data.references) {
          const refData = this._closureCaptures.get(refId);
          if (refData && refData.projectId !== projectId) {
            violations.push({
              type: 'memory_store_contamination',
              severity: 'critical',
              agentId,
              projectId,
              foreignProject: refData.projectId,
              refType: refData.type,
              message: `Agent ${agentId} in ${projectId} references data from ${refData.projectId} (${refData.type})`,
              detectedAt: new Date().toISOString(),
            });
          }
        }
      }
    }

    return violations;
  }

  /**
   * Check for closure capture leakage.
   * Detects when closures capture variables from wrong project context.
   */
  _checkClosureLeakage() {
    const violations = [];
    const projectRefs = new Map(); // projectId -> Set of refIds

    // Group references by project
    for (const [refId, data] of this._closureCaptures) {
      if (!projectRefs.has(data.projectId)) {
        projectRefs.set(data.projectId, new Set());
      }
      projectRefs.get(data.projectId).add(refId);
    }

    // Check for duplicate snapshots across projects (same object captured in multiple projects)
    const snapshotMap = new Map(); // snapshotHash -> [refIds]
    for (const [refId, data] of this._closureCaptures) {
      const hash = data.snapshot.hash;
      if (!snapshotMap.has(hash)) {
        snapshotMap.set(hash, []);
      }
      snapshotMap.get(hash).push(refId);
    }

    // Find snapshots shared across projects
    for (const [hash, refIds] of snapshotMap) {
      if (refIds.length > 1) {
        const projects = new Set(refIds.map(refId => this._closureCaptures.get(refId).projectId));
        if (projects.size > 1) {
          const refData = this._closureCaptures.get(refIds[0]);
          violations.push({
            type: 'closure_capture_leakage',
            severity: 'high',
            refIds,
            projects: Array.from(projects),
            refType: refData.type,
            message: `Closure capture shared across projects ${Array.from(projects).join(', ')}`,
            detectedAt: new Date().toISOString(),
          });
        }
      }
    }

    return violations;
  }

  /**
   * Check if agent is being inappropriately shared across projects.
   */
  _checkForCrossProjectAgent(agentId, projectA, projectB) {
    // This is a warning condition - agents should be instantiated per project
    // or properly isolated if shared
    this._violations.push({
      type: 'cross_project_agent_sharing',
      severity: 'warning',
      agentId,
      projects: [projectA, projectB],
      message: `Agent ${agentId} detected in both ${projectA} and ${projectB}`,
      detectedAt: new Date().toISOString(),
    });
  }

  /**
   * Capture baseline memory snapshot for a project.
   */
  _captureBaseline(projectId) {
    const baseline = {
      projectId,
      timestamp: Date.now(),
      agentCount: this._projectMemory.has(projectId) ? this._projectMemory.get(projectId).size : 0,
      referenceCount: 0,
    };

    if (this._projectMemory.has(projectId)) {
      let refCount = 0;
      for (const [agentId, data] of this._projectMemory.get(projectId)) {
        refCount += data.references.size;
        baseline.agents = baseline.agents || {};
        baseline.agents[agentId] = {
          snapshotHash: data.snapshot.hash,
          referenceCount: data.references.size,
        };
      }
      baseline.referenceCount = refCount;
    }

    this._baselineSnapshots.set(projectId, baseline);
  }

  /**
   * Compare current state against baseline to detect drift.
   */
  detectDrift(projectId) {
    if (!this._baselineSnapshots.has(projectId)) {
      return { hasDrift: false, reason: 'no_baseline' };
    }

    const baseline = this._baselineSnapshots.get(projectId);
    const currentAgents = this._projectMemory.get(projectId) || new Map();

    const drift = {
      hasDrift: false,
      baseline,
      current: {
        agentCount: currentAgents.size,
        referenceCount: 0,
      },
      differences: [],
    };

    // Check for modified snapshots (only for agents that existed in baseline)
    for (const [agentId, data] of currentAgents) {
      if (baseline.agents && baseline.agents[agentId]) {
        if (data.snapshot.hash !== baseline.agents[agentId].snapshotHash) {
          drift.hasDrift = true;
          drift.differences.push({
            type: 'modified_context',
            agentId,
            baselineHash: baseline.agents[agentId].snapshotHash,
            currentHash: data.snapshot.hash,
          });
        }
      }
    }

    return drift;
  }

  /**
   * Create a snapshot of context object for comparison.
   */
  _snapshotContext(context) {
    if (!context || typeof context !== 'object') {
      return { hash: 'null', size: 0 };
    }

    // Create a hash of the context to detect mutations
    const serialized = JSON.stringify(context, (key, value) => {
      // Exclude functions and circular references
      if (typeof value === 'function') return '[Function]';
      if (value instanceof Map) return '[Map:' + value.size + ']';
      if (value instanceof Set) return '[Set:' + value.size + ']';
      return value;
    });

    const hash = createHash('sha256').update(serialized).digest('hex').slice(0, 16);
    const size = new TextEncoder().encode(serialized).length;

    return { hash, size, serialized };
  }

  /**
   * Create a snapshot of a value for tracking.
   */
  _snapshotValue(value) {
    if (value === null || value === undefined) {
      return { hash: 'null', type: typeof value };
    }

    if (typeof value === 'object') {
      return this._snapshotContext(value);
    }

    const str = String(value);
    const hash = createHash('sha256').update(str).digest('hex').slice(0, 16);
    return { hash, type: typeof value, size: str.length };
  }

  /**
   * Compute unique reference ID.
   */
  _computeRefId(agentId, projectId, refType, value) {
    const str = `${projectId}:${agentId}:${refType}:${this._snapshotValue(value).hash}`;
    return createHash('sha256').update(str).digest('hex').slice(0, 12);
  }

  /**
   * Check if two context snapshots overlap (share data).
   */
  _contextsOverlap(snapshotA, snapshotB) {
    if (!snapshotA || !snapshotB) return false;
    // If hashes match, they're the same data
    if (snapshotA.hash === snapshotB.hash) return true;
    // Additional checks could go here for deep comparison
    return false;
  }

  /**
   * Get report of all detected issues.
   */
  getReport() {
    return {
      timestamp: new Date().toISOString(),
      projectsMonitored: Array.from(this._projectMemory.keys()),
      agentInstances: Array.from(this._agentInstances.entries()).map(([id, info]) => ({
        agentId: id,
        projectCount: info.projectIds.size,
        projects: Array.from(info.projectIds),
      })),
      violations: this._violations,
      summary: {
        totalViolations: this._violations.length,
        critical: this._violations.filter(v => v.severity === 'critical').length,
        high: this._violations.filter(v => v.severity === 'high').length,
        warning: this._violations.filter(v => v.severity === 'warning').length,
      },
    };
  }

  /**
   * Reset all tracking state.
   */
  reset() {
    this._projectMemory.clear();
    this._agentInstances.clear();
    this._closureCaptures.clear();
    this._violations = [];
    this._baselineSnapshots.clear();
  }

  set enabled(value) {
    this._enabled = value;
  }

  get enabled() {
    return this._enabled;
  }
}

export default MemoryIsolationMonitor;
