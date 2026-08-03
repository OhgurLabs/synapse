// src/test-utils/state-isolation-monitor.js
// State isolation monitoring utilities for detecting cross-project state leakage

import { createLogger } from '../logger.js';
import { FSAccessTracker } from './fs-access-tracker.js';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { spawn, fork, exec, execSync, execFileSync } from 'child_process';
import { EventEmitter } from 'events';

const log = createLogger('state-isolation-monitor');

export class StateIsolationMonitor extends EventEmitter {
  constructor(stateManager, options = {}) {
    super();
    this.stateManager = stateManager;
    this.options = {
      trackSessionLeakage: options.trackSessionLeakage ?? true,
      trackMemoryLeakage: options.trackMemoryLeakage ?? true,
      trackFileSystemAccess: options.trackFileSystemAccess ?? true,
      trackAgentContext: options.trackAgentContext ?? true,
      trackIPC: options.trackIPC ?? true,
      trackResourceUsage: options.trackResourceUsage ?? true,
      trackSharedMemory: options.trackSharedMemory ?? true,
      trackFileDescriptors: options.trackFileDescriptors ?? true,
      trackEventListeners: options.trackEventListeners ?? true,
      maxMemoryGrowthRatio: options.maxMemoryGrowthRatio ?? 0.5,
      maxCPUUsagePercent: options.maxCPUUsagePercent ?? 80,
      maxResourceSampleInterval: options.maxResourceSampleInterval ?? 1000,
      maxFileDescriptorsPerProject: options.maxFileDescriptorsPerProject ?? 256,
      maxEventListenersPerEmitter: options.maxEventListenersPerEmitter ?? 50,
      enableRealtimeViolationEvents: options.enableRealtimeViolationEvents ?? true,
      projectResourceBudgets: options.projectResourceBudgets ?? {},
      ...options,
    };

    this.isMonitoring = false;
    this.snapshots = [];
    this.fileAccessLog = [];
    this.sessionAccessLog = [];
    this.memoryAccessLog = [];
    this.agentContextLog = [];
    this.ipcLog = [];
    this.resourceUsageLog = [];
    this.sharedMemoryLog = [];
    this.fileDescriptorLog = [];
    this.eventListenerLog = [];

    this._fsProxy = null;
    this._fs = null;
    this._fsTracker = null;
    this._childProcessProxy = null;
    this._workerThreadsProxy = null;
    this._originalChildProcess = null;
    this._originalMemoryUsage = null;
    this._originalCpuUsage = null;
    this._activeWorkers = new Map();
    this._activeProcesses = new Map();
    this._projectResourceUsage = new Map();
    this._resourceSampleTimers = new Map();
    this._ipcChannels = new Map();
    this._resourceHistory = new Map();
    this._sharedBuffers = new Map();
    this._messageChannels = new Map();
    this._projectFileDescriptors = new Map();
    this._projectEventListeners = new Map();
    this._handleSnapshots = [];
  }

  async startMonitoring() {
    if (this.isMonitoring) {
      log.warn('Monitoring already started');
      return;
    }

    this.isMonitoring = true;
    this.snapshots = [];
    this.fileAccessLog = [];
    this.sessionAccessLog = [];
    this.memoryAccessLog = [];
    this.agentContextLog = [];
    this.ipcLog = [];
    this.resourceUsageLog = [];
    this.sharedMemoryLog = [];
    this.fileDescriptorLog = [];
    this.eventListenerLog = [];
    this._activeWorkers.clear();
    this._activeProcesses.clear();
    this._projectResourceUsage.clear();
    this._ipcChannels.clear();
    this._resourceHistory.clear();
    this._resourceSampleTimers.clear();
    this._sharedBuffers.clear();
    this._messageChannels.clear();
    this._projectFileDescriptors.clear();
    this._projectEventListeners.clear();
    this._handleSnapshots = [];

    this._fs = await import('fs');

    log.debug('State isolation monitoring started', {
      trackSessionLeakage: this.options.trackSessionLeakage,
      trackMemoryLeakage: this.options.trackMemoryLeakage,
      trackFileSystemAccess: this.options.trackFileSystemAccess,
      trackAgentContext: this.options.trackAgentContext,
      trackIPC: this.options.trackIPC,
      trackResourceUsage: this.options.trackResourceUsage,
      trackSharedMemory: this.options.trackSharedMemory,
      trackFileDescriptors: this.options.trackFileDescriptors,
      trackEventListeners: this.options.trackEventListeners,
      enableRealtimeViolationEvents: this.options.enableRealtimeViolationEvents,
    });

    if (this.options.trackFileSystemAccess) {
      await this._setupFileSystemTracking();
      await this._setupFSAccessTracker();
    }

    if (this.options.trackIPC) {
      await this._setupIPCMonitoring();
    }

    if (this.options.trackResourceUsage) {
      await this._setupResourceTracking();
    }

    if (this.options.trackSharedMemory) {
      this._setupSharedMemoryTracking();
    }

    if (this.options.trackFileDescriptors) {
      this._captureFileDescriptorSnapshot('start');
    }

    if (this.options.trackEventListeners) {
      this._captureEventListenerSnapshot('start');
    }

    this.emit('monitoringStarted', { timestamp: Date.now() });
  }

  async stopMonitoring() {
    if (!this.isMonitoring) {
      log.warn('Monitoring not started');
      return [];
    }

    this.isMonitoring = false;

    if (this.options.trackFileSystemAccess) {
      await this._teardownFileSystemTracking();
      await this._teardownFSAccessTracker();
    }

    if (this.options.trackIPC) {
      await this._teardownIPCMonitoring();
    }

    if (this.options.trackResourceUsage) {
      await this._teardownResourceTracking();
    }

    if (this.options.trackSharedMemory) {
      this._teardownSharedMemoryTracking();
    }

    if (this.options.trackFileDescriptors) {
      this._captureFileDescriptorSnapshot('stop');
    }

    if (this.options.trackEventListeners) {
      this._captureEventListenerSnapshot('stop');
    }

    this._clearAllResourceTimers();

    const violations = this.detectAllViolations();
    
    log.debug('State isolation monitoring stopped', {
      snapshotsCaptured: this.snapshots.length,
      fileAccesses: this.fileAccessLog.length,
      ipcEvents: this.ipcLog.length,
      resourceSamples: this.resourceUsageLog.length,
      violationsDetected: violations.length,
    });

    this.emit('monitoringStopped', { 
      timestamp: Date.now(),
      violations,
      summary: this._generateMonitoringSummary()
    });

    return violations;
  }

  captureSnapshot() {
    if (!this.isMonitoring) {
      log.warn('Cannot capture snapshot: monitoring not started');
      return null;
    }

    const snapshot = {
      timestamp: Date.now(),
      isoTimestamp: new Date().toISOString(),
      projects: this._captureProjectState(),
      sessions: this._captureSessionState(),
      memory: this._captureMemoryState(),
      agentContext: this._captureAgentContextState(),
      ipc: this._captureIPCState(),
      resourceUsage: this._captureResourceUsageState(),
      sharedMemory: this._captureSharedMemoryState(),
      fileDescriptors: this._captureFileDescriptorState(),
      eventListeners: this._captureEventListenerState(),
    };

    this.snapshots.push(snapshot);
    return snapshot;
  }

  detectLeakage(snapshot) {
    if (!snapshot) {
      return [];
    }

    const violations = [];

    if (this.options.trackFileSystemAccess) {
      const fsViolations = this._detectFileSystemLeakage(snapshot);
      violations.push(...fsViolations);
    }

    if (this.options.trackSessionLeakage) {
      const sessionViolations = this._detectSessionLeakage(snapshot);
      violations.push(...sessionViolations);
    }

    if (this.options.trackMemoryLeakage) {
      const memoryViolations = this._detectMemoryLeakage(snapshot);
      violations.push(...memoryViolations);
    }

    if (this.options.trackAgentContext) {
      const contextViolations = this._detectAgentContextLeakage(snapshot);
      violations.push(...contextViolations);
    }

    if (this.options.trackIPC) {
      const ipcViolations = this._detectIPCLeakage(snapshot);
      violations.push(...ipcViolations);
    }

    if (this.options.trackSharedMemory) {
      const sharedMemViolations = this._detectSharedMemoryLeakage(snapshot);
      violations.push(...sharedMemViolations);
    }

    if (this.options.trackFileDescriptors) {
      const fdViolations = this._detectFileDescriptorLeakage(snapshot);
      violations.push(...fdViolations);
    }

    if (this.options.trackEventListeners) {
      const listenerViolations = this._detectEventListenerLeakage(snapshot);
      violations.push(...listenerViolations);
    }

    if (this.options.trackResourceUsage) {
      const resourceViolations = this._detectResourceUsageLeakage(snapshot);
      violations.push(...resourceViolations);
    }

    return violations;
  }

  detectAllViolations() {
    const allViolations = [];

    for (const snapshot of this.snapshots) {
      const violations = this.detectLeakage(snapshot);
      allViolations.push(...violations);
    }

    // Enhanced: Add IPC state leakage detection for concurrent execution
    if (this.options.trackIPC) {
      const ipcViolations = this.detectIPCStateLeakage();
      allViolations.push(...ipcViolations);
    }

    return allViolations;
  }

  // Enhanced: Validate concurrent execution isolation
  validateConcurrentExecution(projectA, projectB) {
    const results = {
      isolated: true,
      violations: [],
      sessionIsolation: true,
      memoryIsolation: true,
      ipcIsolation: true,
      filesystemIsolation: true,
      agentContextIsolation: true,
      details: {},
    };

    // Capture snapshot for analysis
    const snapshot = this.captureSnapshot();

    // Check session isolation (defensive check for null sessions)
    try {
      const sessionViolations = this._detectSessionLeakage(snapshot);
      const crossProjectSessions = sessionViolations.filter(v => v.type === 'session_leakage');
      if (crossProjectSessions.length > 0) {
        results.sessionIsolation = false;
        results.violations.push(...crossProjectSessions);
      }
    } catch (err) {
      log.warn('Failed to check session isolation', { error: err.message });
    }

    // Check memory isolation
    try {
      const memoryViolations = this._detectMemoryLeakage(snapshot);
      if (memoryViolations.length > 0) {
        results.memoryIsolation = false;
        results.violations.push(...memoryViolations);
      }
    } catch (err) {
      log.warn('Failed to check memory isolation', { error: err.message });
    }

    // Check IPC isolation
    try {
      const ipcViolations = this.detectIPCStateLeakage();
      const crossProjectIPC = ipcViolations.filter(v => 
        v.type === 'ipc_leakage' || 
        v.type === 'ipc_state_leakage' || 
        v.type === 'ipc_channel_leakage'
      );
      if (crossProjectIPC.length > 0) {
        results.ipcIsolation = false;
        results.violations.push(...crossProjectIPC);
      }
    } catch (err) {
      log.warn('Failed to check IPC isolation', { error: err.message });
    }

    // Check filesystem isolation
    if (this._fsTracker) {
      try {
        const fsViolations = this._fsTracker.checkViolations();
        if (fsViolations.length > 0) {
          results.filesystemIsolation = false;
          results.violations.push(...fsViolations.map(v => ({
            type: 'filesystem_leakage',
            description: v.message || `FS violation: ${v.type}`,
            details: v.details || {},
            severity: v.severity || 'high',
          })));
        }
      } catch (err) {
        log.warn('Failed to check filesystem isolation', { error: err.message });
      }
    }

    // Check agent context isolation
    try {
      const contextViolations = this._detectAgentContextLeakage(snapshot);
      if (contextViolations.length > 0) {
        results.agentContextIsolation = false;
        results.violations.push(...contextViolations);
      }
    } catch (err) {
      log.warn('Failed to check agent context isolation', { error: err.message });
    }

    results.isolated = results.violations.length === 0;
    results.details = {
      sessionViolations: results.violations.filter(v => v.type === 'session_leakage').length,
      memoryViolations: results.violations.filter(v => v.type === 'memory_leakage').length,
      ipcViolations: results.violations.filter(v => v.type.startsWith('ipc_')).length,
      filesystemViolations: results.violations.filter(v => v.type === 'filesystem_leakage').length,
      agentContextViolations: results.violations.filter(v => v.type === 'agent_context_leakage').length,
      totalViolations: results.violations.length,
      projectA,
      projectB,
      timestamp: Date.now(),
      isoTimestamp: new Date().toISOString(),
    };

    return results;
  }

  _captureProjectState() {
    const projects = {};

    try {
      const projectList = this.stateManager.listProjects?.() || [];
      
      for (const project of projectList) {
        const projectId = typeof project === 'string' ? project : project.id;
        
        projects[projectId] = {
          id: projectId,
          vision: this.stateManager.getProjectVision?.(projectId) || null,
          config: this.stateManager.getProject?.(projectId) || null,
          messageCount: this.stateManager.getMessages?.(projectId)?.length || 0,
        };
      }
    } catch (err) {
      log.warn('Failed to capture project state', { error: err.message });
    }

    return projects;
  }

  _captureSessionState() {
    const sessions = {};

    try {
      if (this.stateManager.sessions) {
        for (const [sessionId, session] of this.stateManager.sessions) {
          sessions[sessionId] = {
            id: sessionId,
            projectId: session.projectId || null,
            messageCount: session.messages?.length || 0,
            createdAt: session.createdAt || null,
          };
        }
      }
    } catch (err) {
      log.warn('Failed to capture session state', { error: err.message });
    }

    return sessions;
  }

  _captureMemoryState() {
    const memoryState = {
      heapUsed: process.memoryUsage?.().heapUsed || 0,
      heapTotal: process.memoryUsage?.().heapTotal || 0,
      external: process.memoryUsage?.().external || 0,
    };

    return memoryState;
  }

  _captureAgentContextState() {
    const agentContexts = {};

    try {
      if (this.stateManager.agentContexts) {
        for (const [agentId, context] of this.stateManager.agentContexts) {
          agentContexts[agentId] = {
            id: agentId,
            projectId: context.projectId || null,
            campaignId: context.campaignId || null,
            taskId: context.taskId || null,
          };
        }
      }
    } catch (err) {
      log.warn('Failed to capture agent context state', { error: err.message });
    }

    return agentContexts;
  }

  _captureIPCState() {
    const ipcState = {
      activeWorkers: new Map(this._activeWorkers),
      activeProcesses: new Map(this._activeProcesses),
      ipcChannels: new Map(this._ipcChannels),
      totalMessages: this.ipcLog.length,
      crossProjectMessages: 0,
      messagesByType: {},
      messagesByProject: {},
    };

    try {
      ipcState.crossProjectMessages = this.ipcLog.filter(msg => msg.crossProject).length;
      
      for (const msg of this.ipcLog) {
        ipcState.messagesByType[msg.type] = (ipcState.messagesByType[msg.type] || 0) + 1;
        if (msg.projectId) {
          ipcState.messagesByProject[msg.projectId] = (ipcState.messagesByProject[msg.projectId] || 0) + 1;
        }
      }
    } catch (err) {
      log.warn('Failed to calculate IPC statistics', { error: err.message });
    }

    return ipcState;
  }

  _captureResourceUsageState() {
    const resourceState = {
      projectUsage: new Map(this._projectResourceUsage),
      totalSamples: this.resourceUsageLog.length,
      currentMemory: process.memoryUsage ? process.memoryUsage() : null,
      currentCPU: process.cpuUsage ? process.cpuUsage() : null,
    };

    return resourceState;
  }

  _detectFileSystemLeakage(snapshot) {
    const violations = [];

    // Use FSAccessTracker if available for detailed detection
    if (this._fsTracker) {
      const fsViolations = this._fsTracker.checkViolations();
      for (const v of fsViolations) {
        violations.push({
          type: 'filesystem_leakage',
          description: v.message || `FS violation: ${v.type}`,
          details: {
            ...v.details,
            path: v.path,
            operation: v.operation,
            sourceProject: v.sourceProject || v.projectId,
            targetProject: v.targetProject,
            timestamp: v.detectedAt || Date.now(),
            violationType: v.type,
            severity: v.severity,
          },
          severity: v.severity || 'high',
        });
      }
    }

    // Fallback to legacy detection using fileAccessLog
    if (this.fileAccessLog.length > 0) {
      const projectDirs = new Set();
      
      for (const projectId in snapshot.projects) {
        const project = snapshot.projects[projectId];
        if (project.config?.projectDir) {
          projectDirs.add(project.config.projectDir);
        }
      }

      for (const access of this.fileAccessLog) {
        const accessedProject = this._findProjectForPath(access.path, snapshot.projects);
        
        if (accessedProject) {
          for (const otherProjectId in snapshot.projects) {
            if (otherProjectId !== accessedProject) {
              const otherProject = snapshot.projects[otherProjectId];
              
              if (otherProject.config?.projectDir && 
                  access.path.startsWith(otherProject.config.projectDir)) {
                violations.push({
                  type: 'filesystem_leakage',
                  description: `Cross-project file access detected from ${accessedProject} to ${otherProjectId}`,
                  details: {
                    accessPath: access.path,
                    operation: access.operation,
                    sourceProject: accessedProject,
                    targetProject: otherProjectId,
                    timestamp: access.timestamp,
                  },
                  severity: 'high',
                });
              }
            }
          }
        }
      }
    }

    return violations;
  }

  _detectSessionLeakage(snapshot) {
    const violations = [];

    // Defensive: Check if sessions exist in snapshot
    if (!snapshot || !snapshot.sessions) {
      return violations;
    }

    for (const sessionId in snapshot.sessions) {
      const session = snapshot.sessions[sessionId];
      
      if (!session.projectId) {
        violations.push({
          type: 'session_leakage',
          description: `Session ${sessionId} has no associated project`,
          details: {
            sessionId,
            session,
          },
          severity: 'medium',
        });
      }

      if (this.sessionAccessLog.some(log => log.sessionId === sessionId && log.crossProject)) {
        violations.push({
          type: 'session_leakage',
          description: `Session ${sessionId} accessed across project boundaries`,
          details: {
            sessionId,
            projectId: session.projectId,
          },
          severity: 'high',
        });
      }
    }

    return violations;
  }

  _detectMemoryLeakage(snapshot) {
    const violations = [];

    if (this.snapshots.length > 1) {
      const prevSnapshot = this.snapshots[this.snapshots.length - 2];
      const prevMemory = prevSnapshot.memory;
      const currentMemory = snapshot.memory;

      const heapGrowth = currentMemory.heapUsed - prevMemory.heapUsed;
      const growthRatio = heapGrowth / prevMemory.heapUsed;

      if (growthRatio > 0.5) {
        violations.push({
          type: 'memory_leakage',
          description: `Significant heap growth detected: ${(heapGrowth / 1024 / 1024).toFixed(2)}MB`,
          details: {
            previousHeap: prevMemory.heapUsed,
            currentHeap: currentMemory.heapUsed,
            growth: heapGrowth,
            growthRatio,
          },
          severity: 'medium',
        });
      }
    }

    return violations;
  }

  _detectAgentContextLeakage(snapshot) {
    const violations = [];

    // Defensive: Check if agentContexts exist
    if (!snapshot || !snapshot.agentContexts) {
      return violations;
    }

    for (const agentId in snapshot.agentContexts) {
      const context = snapshot.agentContexts[agentId];
      
      if (!context.projectId) {
        violations.push({
          type: 'agent_context_leakage',
          description: `Agent ${agentId} context has no associated project`,
          details: {
            agentId,
            context,
          },
          severity: 'medium',
        });
      }

      const projectSessions = Object.values(snapshot.sessions)
        .filter(s => s.projectId === context.projectId);

      if (projectSessions.length === 0 && context.projectId) {
        violations.push({
          type: 'agent_context_leakage',
          description: `Agent ${agentId} context references project ${context.projectId} but no sessions found`,
          details: {
            agentId,
            projectId: context.projectId,
          },
          severity: 'low',
        });
      }
    }

    return violations;
  }

  _detectIPCLeakage(snapshot) {
    const violations = [];
    const channelProjectMap = new Map();
    const messagePatternAnalysis = new Map();

    for (const ipcEvent of this.ipcLog) {
      if (ipcEvent.crossProject) {
        violations.push({
          type: 'ipc_leakage',
          description: `Cross-project IPC detected: ${ipcEvent.sourceProject} communicated with ${ipcEvent.targetProject}`,
          details: {
            sourceProject: ipcEvent.sourceProject,
            targetProject: ipcEvent.targetProject,
            messageType: ipcEvent.messageType,
            workerId: ipcEvent.workerId,
            processId: ipcEvent.processId,
            channel: ipcEvent.channel,
            messageSize: ipcEvent.messageSize,
            timestamp: ipcEvent.timestamp,
            isoTimestamp: ipcEvent.isoTimestamp,
            data: ipcEvent.data,
          },
          severity: 'high',
        });
      }

      if (ipcEvent.channel) {
        if (!channelProjectMap.has(ipcEvent.channel)) {
          channelProjectMap.set(ipcEvent.channel, new Set());
        }
        if (ipcEvent.sourceProject) {
          channelProjectMap.get(ipcEvent.channel).add(ipcEvent.sourceProject);
        }
        if (ipcEvent.targetProject) {
          channelProjectMap.get(ipcEvent.channel).add(ipcEvent.targetProject);
        }
      }

      // Enhanced: Track message patterns for data leakage detection
      if (ipcEvent.data && typeof ipcEvent.data === 'object') {
        const dataHash = this._hashMessageData(ipcEvent.data);
        if (!messagePatternAnalysis.has(dataHash)) {
          messagePatternAnalysis.set(dataHash, new Set());
        }
        messagePatternAnalysis.get(dataHash).add(ipcEvent.sourceProject || ipcEvent.targetProject);
      }
    }

    for (const [channel, projects] of channelProjectMap) {
      if (projects.size > 1) {
        violations.push({
          type: 'ipc_channel_sharing',
          description: `IPC channel ${channel} shared across multiple projects: ${Array.from(projects).join(', ')}`,
          details: {
            channel,
            projects: Array.from(projects),
            projectCount: projects.size,
          },
          severity: 'medium',
        });
      }
    }

    for (const [channel, channelInfo] of this._ipcChannels) {
      if (channelInfo.projects.size > 1) {
        violations.push({
          type: 'ipc_channel_cross_project',
          description: `IPC channel ${channel} used by multiple projects: ${Array.from(channelInfo.projects).join(', ')}`,
          details: {
            channel,
            projects: Array.from(channelInfo.projects),
            messageCount: channelInfo.messageCount,
            totalBytes: channelInfo.totalBytes,
            created: channelInfo.created,
          },
          severity: 'medium',
        });
      }
    }

    // Enhanced: Detect identical messages across projects (potential data leakage)
    for (const [dataHash, projects] of messagePatternAnalysis) {
      if (projects.size > 1) {
        violations.push({
          type: 'ipc_message_pattern_leakage',
          description: `Identical message pattern detected across multiple projects: ${Array.from(projects).join(', ')}`,
          details: {
            dataHash,
            projects: Array.from(projects),
            projectCount: projects.size,
          },
          severity: 'high',
        });
      }
    }

    return violations;
  }

  _hashMessageData(data) {
    try {
      const str = JSON.stringify(data);
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return `hash_${Math.abs(hash).toString(16).slice(0, 8)}`;
    } catch {
      return 'hash_unknown';
    }
  }

  _detectResourceUsageLeakage(snapshot) {
    const violations = [];

    const currentUsage = snapshot.resourceUsage;
    
    for (const [projectId, usage] of currentUsage.projectUsage) {
      const memUsage = usage.memoryUsage;
      const cpuUsage = usage.cpuUsage;

      if (memUsage && memUsage.heapUsed > (memUsage.limit || Infinity)) {
        violations.push({
          type: 'resource_leakage',
          description: `Project ${projectId} exceeded memory limit: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`,
          details: {
            projectId,
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            external: memUsage.external,
            limit: memUsage.limit,
            timestamp: Date.now(),
            isoTimestamp: new Date().toISOString(),
          },
          severity: 'high',
        });
      }

      if (cpuUsage && cpuUsage.percent > (cpuUsage.limit || this.options.maxCPUUsagePercent)) {
        violations.push({
          type: 'resource_leakage',
          description: `Project ${projectId} exceeded CPU limit: ${cpuUsage.percent.toFixed(2)}%`,
          details: {
            projectId,
            cpuPercent: cpuUsage.percent,
            user: cpuUsage.user,
            system: cpuUsage.system,
            limit: cpuUsage.limit || this.options.maxCPUUsagePercent,
            timestamp: Date.now(),
            isoTimestamp: new Date().toISOString(),
          },
          severity: 'medium',
        });
      }

      if (usage.peakHeapUsed && usage.peakHeapUsed > (usage.memoryLimit || Infinity)) {
        violations.push({
          type: 'resource_leakage',
          description: `Project ${projectId} peak memory exceeded limit: ${(usage.peakHeapUsed / 1024 / 1024).toFixed(2)}MB`,
          details: {
            projectId,
            peakHeapUsed: usage.peakHeapUsed,
            peakHeapTotal: usage.peakHeapTotal,
            peakExternal: usage.peakExternal,
            limit: usage.memoryLimit,
            timestamp: Date.now(),
            isoTimestamp: new Date().toISOString(),
          },
          severity: 'high',
        });
      }
    }

    if (this.snapshots.length >= 2) {
      const prevSnapshot = this.snapshots[this.snapshots.length - 2];
      const prevResource = prevSnapshot.resourceUsage;
      
      for (const [projectId, currentProjUsage] of currentUsage.projectUsage) {
        const prevProjUsage = prevResource.projectUsage.get(projectId);
        
        if (prevProjUsage && currentProjUsage.memoryUsage && prevProjUsage.memoryUsage) {
          const memGrowth = currentProjUsage.memoryUsage.heapUsed - prevProjUsage.memoryUsage.heapUsed;
          const growthRatio = prevProjUsage.memoryUsage.heapUsed > 0 ? memGrowth / prevProjUsage.memoryUsage.heapUsed : 0;
          
          if (growthRatio > this.options.maxMemoryGrowthRatio) {
            violations.push({
              type: 'resource_leakage',
              description: `Project ${projectId} memory growth exceeded threshold: ${(memGrowth / 1024 / 1024).toFixed(2)}MB (${(growthRatio * 100).toFixed(1)}%)`,
              details: {
                projectId,
                previousHeap: prevProjUsage.memoryUsage.heapUsed,
                currentHeap: currentProjUsage.memoryUsage.heapUsed,
                growth: memGrowth,
                growthMB: (memGrowth / 1024 / 1024).toFixed(2),
                growthRatio,
                threshold: this.options.maxMemoryGrowthRatio,
                timestamp: Date.now(),
                isoTimestamp: new Date().toISOString(),
              },
              severity: 'high',
            });
          }
        }
      }
    }

    for (const [projectId, projUsage] of this._projectResourceUsage) {
      if (projUsage.peakHeapUsed && projUsage.samples && projUsage.samples > 1) {
        const avgHeap = projUsage.history.reduce((sum, h) => sum + h.heapUsed, 0) / projUsage.history.length;
        const deviation = (projUsage.peakHeapUsed - avgHeap) / avgHeap;
        
        if (deviation > 0.5) {
          violations.push({
            type: 'resource_anomaly',
            description: `Project ${projectId} shows memory spike: peak ${(projUsage.peakHeapUsed / 1024 / 1024).toFixed(2)}MB vs avg ${(avgHeap / 1024 / 1024).toFixed(2)}MB (${(deviation * 100).toFixed(1)}% deviation)`,
            details: {
              projectId,
              peakHeap: projUsage.peakHeapUsed,
              avgHeap,
              deviation,
              samples: projUsage.samples,
              timestamp: Date.now(),
              isoTimestamp: new Date().toISOString(),
            },
            severity: 'medium',
          });
        }
      }
    }

    // Enhanced: Detect correlated resource usage across projects (potential shared state)
    if (this._projectResourceUsage.size >= 2) {
      const correlatedProjects = this._detectCorrelatedResourceUsage();
      for (const correlation of correlatedProjects) {
        violations.push({
          type: 'resource_correlation',
          description: `Correlated resource usage detected between ${correlation.projectA} and ${correlation.projectB} (correlation: ${correlation.correlation.toFixed(3)})`,
          details: {
            projectA: correlation.projectA,
            projectB: correlation.projectB,
            correlation: correlation.correlation,
            sharedPattern: correlation.sharedPattern,
            timestamp: Date.now(),
            isoTimestamp: new Date().toISOString(),
          },
          severity: 'medium',
        });
      }
    }

    return violations;
  }

  _detectCorrelatedResourceUsage() {
    const correlations = [];
    const projects = Array.from(this._projectResourceUsage.entries());
    
    if (projects.length < 2) return correlations;

    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        const [projA, usageA] = projects[i];
        const [projB, usageB] = projects[j];
        
        if (!usageA.history || !usageB.history || usageA.history.length < 3 || usageB.history.length < 3) {
          continue;
        }

        // Calculate correlation coefficient between memory usage patterns
        const minLen = Math.min(usageA.history.length, usageB.history.length);
        const aVals = usageA.history.slice(0, minLen).map(h => h.heapUsed || 0);
        const bVals = usageB.history.slice(0, minLen).map(h => h.heapUsed || 0);
        
        const correlation = this._pearsonCorrelation(aVals, bVals);
        
        if (correlation > 0.8) {
          correlations.push({
            projectA: projA,
            projectB: projB,
            correlation,
            sharedPattern: 'memory_usage_pattern',
          });
        }
      }
    }

    return correlations;
  }

  _pearsonCorrelation(x, y) {
    const n = x.length;
    if (n !== y.length || n === 0) return 0;
    
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);
    
    const num = (n * sumXY) - (sumX * sumY);
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    
    if (den === 0) return 0;
    return num / den;
  }

  _findProjectForPath(path, projects) {
    for (const projectId in projects) {
      const project = projects[projectId];
      if (project.config?.projectDir && path.startsWith(project.config.projectDir)) {
        return projectId;
      }
    }
    return null;
  }

  async _setupFileSystemTracking() {
    if (this._fsProxy) {
      return;
    }

    this._fsProxy = new Proxy({}, {
      get: (target, prop) => {
        if (prop === 'readFileSync') {
          return (path, ...args) => {
            this.fileAccessLog.push({
              path,
              operation: 'read',
              timestamp: Date.now(),
            });
            return this._fs.readFileSync(path, ...args);
          };
        }
        if (prop === 'writeFileSync') {
          return (path, ...args) => {
            this.fileAccessLog.push({
              path,
              operation: 'write',
              timestamp: Date.now(),
            });
            return this._fs.writeFileSync(path, ...args);
          };
        }
        return target[prop] ?? this._fs[prop];
      },
    });
  }

  async _teardownFileSystemTracking() {
    this._fsProxy = null;
  }

  async _setupFSAccessTracker() {
    if (this._fsTracker) {
      return;
    }

    // Build project directory map from state manager
    const projectDirs = new Map();
    for (const [projectId, project] of this.stateManager.projects) {
      if (project.projectDir) {
        projectDirs.set(projectId, project.projectDir);
      }
    }

    this._fsTracker = new FSAccessTracker({
      trackReads: true,
      trackWrites: true,
      enableRealtimeDetection: true,
    });
    
    this._fsTracker.initialize(projectDirs);
  }

  async _teardownFSAccessTracker() {
    if (this._fsTracker) {
      this._fsTracker.stop();
      // Collect violations from FS tracker
      const fsViolations = this._fsTracker.getViolations();
      if (fsViolations.length > 0) {
        log.debug('FS access violations detected', {
          count: fsViolations.length,
          violations: fsViolations
        });
      }
      this._fsTracker = null;
    }
  }

  async _setupIPCMonitoring() {
    this._originalChildProcess = {
      spawn,
      fork,
      exec,
      execSync,
      execFileSync,
    };

    const self = this;

    this._childProcessProxy = new Proxy({}, {
      get(target, prop) {
        if (prop === 'spawn') {
          return function(command, args = [], options = {}) {
            const process = self._originalChildProcess.spawn(command, args, options);
            const processId = process.pid;
            const projectId = self._getCurrentProjectContext();

            self._activeProcesses.set(processId, {
              command,
              args,
              options,
              projectId,
              startTime: Date.now(),
              messageCount: 0,
              bytesSent: 0,
              bytesReceived: 0,
            });

            self.ipcLog.push({
              type: 'process_spawn',
              processId,
              command,
              projectId,
              timestamp: Date.now(),
              isoTimestamp: new Date().toISOString(),
            });

            const originalSend = process.send.bind(process);
            process.send = function(message, ...args) {
              const procInfo = self._activeProcesses.get(processId);
              if (procInfo) {
                procInfo.messageCount++;
                procInfo.bytesSent += Buffer.byteLength(JSON.stringify(message));
              }
              self._logIPC('process_send', processId, null, message, projectId);
              return originalSend(message, ...args);
            };

            process.on('message', (message) => {
              const procInfo = self._activeProcesses.get(processId);
              if (procInfo) {
                procInfo.messageCount++;
                procInfo.bytesReceived += Buffer.byteLength(JSON.stringify(message));
              }
              self._logIPC('process_message', processId, null, message, projectId);
            });

            process.on('exit', (code, signal) => {
              const procInfo = self._activeProcesses.get(processId);
              self.ipcLog.push({
                type: 'process_exit',
                processId,
                code,
                signal,
                projectId,
                messageCount: procInfo?.messageCount || 0,
                bytesSent: procInfo?.bytesSent || 0,
                bytesReceived: procInfo?.bytesReceived || 0,
                timestamp: Date.now(),
                isoTimestamp: new Date().toISOString(),
              });
              self._activeProcesses.delete(processId);
            });

            return process;
          };
        }

        if (prop === 'fork') {
          return function(modulePath, args = [], options = {}) {
            const process = self._originalChildProcess.fork(modulePath, args, options);
            const processId = process.pid;
            const projectId = self._getCurrentProjectContext();

            self._activeProcesses.set(processId, {
              modulePath,
              args,
              options,
              projectId,
              startTime: Date.now(),
              type: 'fork',
              messageCount: 0,
              bytesSent: 0,
              bytesReceived: 0,
            });

            self.ipcLog.push({
              type: 'process_fork',
              processId,
              modulePath,
              projectId,
              timestamp: Date.now(),
              isoTimestamp: new Date().toISOString(),
            });

            const originalSend = process.send.bind(process);
            process.send = function(message, ...args) {
              const procInfo = self._activeProcesses.get(processId);
              if (procInfo) {
                procInfo.messageCount++;
                procInfo.bytesSent += Buffer.byteLength(JSON.stringify(message));
              }
              self._logIPC('process_send', processId, null, message, projectId);
              return originalSend(message, ...args);
            };

            process.on('message', (message) => {
              const procInfo = self._activeProcesses.get(processId);
              if (procInfo) {
                procInfo.messageCount++;
                procInfo.bytesReceived += Buffer.byteLength(JSON.stringify(message));
              }
              self._logIPC('process_message', processId, null, message, projectId);
            });

            process.on('exit', (code, signal) => {
              const procInfo = self._activeProcesses.get(processId);
              self._activeProcesses.delete(processId);
            });

            return process;
          };
        }

        if (prop === 'exec') {
          return function(command, options = {}, callback) {
            const projectId = self._getCurrentProjectContext();
            self.ipcLog.push({
              type: 'exec_command',
              command,
              projectId,
              timestamp: Date.now(),
              isoTimestamp: new Date().toISOString(),
            });
            return self._originalChildProcess.exec(command, options, callback);
          };
        }

        return target[prop] ?? self._originalChildProcess[prop];
      },
    });

    if (isMainThread) {
      const OriginalWorker = Worker;
      const wrappedWorker = function(scriptPath, options) {
        const worker = new OriginalWorker(scriptPath, options);
        const workerId = worker.threadId;
        const projectId = self._getCurrentProjectContext();

        self._activeWorkers.set(workerId, {
          scriptPath,
          options,
          projectId,
          startTime: Date.now(),
          messageCount: 0,
          bytesSent: 0,
          bytesReceived: 0,
        });

        self.ipcLog.push({
          type: 'worker_spawn',
          workerId,
          scriptPath,
          projectId,
          timestamp: Date.now(),
          isoTimestamp: new Date().toISOString(),
        });

        const originalSend = worker.postMessage.bind(worker);
        worker.postMessage = function(message, ...args) {
          const workerInfo = self._activeWorkers.get(workerId);
          if (workerInfo) {
            workerInfo.messageCount++;
            workerInfo.bytesSent += Buffer.byteLength(JSON.stringify(message));
          }
          self._logIPC('worker_send', null, workerId, message, projectId);
          return originalSend(message, ...args);
        };

        worker.on('message', (message) => {
          const workerInfo = self._activeWorkers.get(workerId);
          if (workerInfo) {
            workerInfo.messageCount++;
            workerInfo.bytesReceived += Buffer.byteLength(JSON.stringify(message));
          }
          self._logIPC('worker_message', null, workerId, message, projectId);
        });

        worker.on('exit', (code) => {
          const workerInfo = self._activeWorkers.get(workerId);
          self.ipcLog.push({
            type: 'worker_exit',
            workerId,
            code,
            projectId,
            messageCount: workerInfo?.messageCount || 0,
            bytesSent: workerInfo?.bytesSent || 0,
            bytesReceived: workerInfo?.bytesReceived || 0,
            timestamp: Date.now(),
            isoTimestamp: new Date().toISOString(),
          });
          self._activeWorkers.delete(workerId);
        });

        return worker;
      };

      this._workerThreadsProxy = wrappedWorker;
    }

    log.debug('IPC monitoring setup complete', {
      isMainThread,
      trackingChildProcess: true,
      trackingWorkerThreads: isMainThread,
      enhancedTracking: true,
    });
  }

  async _teardownIPCMonitoring() {
    this._childProcessProxy = null;
    this._workerThreadsProxy = null;
    
    log.debug('IPC monitoring teardown complete', {
      totalIPCEvents: this.ipcLog.length,
      activeWorkers: this._activeWorkers.size,
      activeProcesses: this._activeProcesses.size,
    });
  }

  _logIPC(type, processId, workerId, data, projectId) {
    const sourceProject = projectId;
    let targetProject = null;
    let crossProject = false;
    let channel = null;

    if (workerId !== null) {
      const workerInfo = this._activeWorkers.get(workerId);
      if (workerInfo) {
        channel = `worker:${workerId}`;
        if (workerInfo.projectId !== sourceProject) {
          targetProject = workerInfo.projectId;
          crossProject = true;
        }
      }
    }

    if (processId !== null) {
      const processInfo = this._activeProcesses.get(processId);
      if (processInfo) {
        channel = `process:${processId}`;
        if (processInfo.projectId !== sourceProject) {
          targetProject = processInfo.projectId;
          crossProject = true;
        }
      }
    }

    const messageSize = Buffer.byteLength(JSON.stringify(data));
    const ipcEvent = {
      type,
      processId,
      workerId,
      channel,
      sourceProject,
      targetProject,
      crossProject,
      data,
      messageSize,
      timestamp: Date.now(),
      isoTimestamp: new Date().toISOString(),
      messageType: typeof data,
    };

    this.ipcLog.push(ipcEvent);

    if (channel && !this._ipcChannels.has(channel)) {
      this._ipcChannels.set(channel, {
        created: Date.now(),
        messageCount: 0,
        totalBytes: 0,
        projects: new Set(),
      });
    }

    if (channel) {
      const channelInfo = this._ipcChannels.get(channel);
      if (channelInfo) {
        channelInfo.messageCount++;
        channelInfo.totalBytes += messageSize;
        if (sourceProject) channelInfo.projects.add(sourceProject);
        if (targetProject) channelInfo.projects.add(targetProject);
      }
    }

    if (crossProject && this.options.enableRealtimeViolationEvents) {
      this.emit('violation', {
        type: 'ipc_leakage',
        severity: 'high',
        details: ipcEvent,
      });
      log.warn('Cross-project IPC detected', {
        sourceProject,
        targetProject,
        type,
        channel,
        messageSize,
      });
    }
  }

  async _setupResourceTracking() {
    const self = this;

    if (typeof process.memoryUsage === 'function') {
      const originalMemoryUsage = process.memoryUsage;
      this._originalMemoryUsage = originalMemoryUsage;
      process.memoryUsage = function() {
        const result = originalMemoryUsage.apply(this, arguments);
        const projectId = self._getCurrentProjectContext();
        
        self.resourceUsageLog.push({
          type: 'memory_sample',
          projectId,
          heapUsed: result.heapUsed,
          heapTotal: result.heapTotal,
          external: result.external,
          rss: result.rss,
          timestamp: Date.now(),
          isoTimestamp: new Date().toISOString(),
        });

        if (!self._projectResourceUsage.has(projectId)) {
          self._projectResourceUsage.set(projectId, {
            memoryUsage: result,
            cpuUsage: null,
            samples: 0,
            history: [],
            peakHeapUsed: result.heapUsed,
            peakHeapTotal: result.heapTotal,
            peakExternal: result.external,
          });
        }

        const projUsage = self._projectResourceUsage.get(projectId);
        projUsage.memoryUsage = result;
        projUsage.samples = (projUsage.samples || 0) + 1;
        projUsage.history.push({
          heapUsed: result.heapUsed,
          heapTotal: result.heapTotal,
          external: result.external,
          timestamp: Date.now(),
        });
        if (result.heapUsed > projUsage.peakHeapUsed) {
          projUsage.peakHeapUsed = result.heapUsed;
        }
        if (result.heapTotal > projUsage.peakHeapTotal) {
          projUsage.peakHeapTotal = result.heapTotal;
        }
        if (result.external > projUsage.peakExternal) {
          projUsage.peakExternal = result.external;
        }

        return result;
      };
    }

    if (typeof process.cpuUsage === 'function') {
      const originalCPUUsage = process.cpuUsage;
      this._originalCpuUsage = originalCPUUsage;
      process.cpuUsage = function(prevUsage) {
        const result = originalCPUUsage.apply(this, arguments);
        const projectId = self._getCurrentProjectContext();
        
        self.resourceUsageLog.push({
          type: 'cpu_sample',
          projectId,
          user: result.user,
          system: result.system,
          timestamp: Date.now(),
          isoTimestamp: new Date().toISOString(),
        });

        if (!self._projectResourceUsage.has(projectId)) {
          self._projectResourceUsage.set(projectId, {
            memoryUsage: null,
            cpuUsage: result,
            samples: 0,
            history: [],
            peakCPUUser: result.user,
            peakCPUSystem: result.system,
          });
        }

        const projUsage = self._projectResourceUsage.get(projectId);
        projUsage.cpuUsage = result;
        projUsage.history.push({
          user: result.user,
          system: result.system,
          timestamp: Date.now(),
        });
        if (result.user > projUsage.peakCPUUser) {
          projUsage.peakCPUUser = result.user;
        }
        if (result.system > projUsage.peakCPUSystem) {
          projUsage.peakCPUSystem = result.system;
        }

        return result;
      };
    }

    if (typeof setInterval === 'function' && this.options.maxResourceSampleInterval) {
      const intervalId = setInterval(() => {
        if (!self.isMonitoring) {
          clearInterval(intervalId);
          return;
        }
        self._sampleResourceUsage();
      }, this.options.maxResourceSampleInterval);
      
      this._resourceSampleTimers.set('global', intervalId);
    }

    log.debug('Resource tracking setup complete', {
      trackingMemory: typeof process.memoryUsage === 'function',
      trackingCPU: typeof process.cpuUsage === 'function',
      periodicSampling: typeof setInterval === 'function' && this.options.maxResourceSampleInterval,
      sampleInterval: this.options.maxResourceSampleInterval,
    });
  }

  _sampleResourceUsage() {
    const projectId = this._getCurrentProjectContext();
    
    try {
      const memUsage = process.memoryUsage?.() || null;
      const cpuUsage = process.cpuUsage?.() || null;
      
      if (memUsage) {
        this.resourceUsageLog.push({
          type: 'memory_sample',
          projectId,
          heapUsed: memUsage.heapUsed,
          heapTotal: memUsage.heapTotal,
          external: memUsage.external,
          rss: memUsage.rss,
          timestamp: Date.now(),
          isoTimestamp: new Date().toISOString(),
          sampled: true,
        });

        if (!this._projectResourceUsage.has(projectId)) {
          this._projectResourceUsage.set(projectId, {
            memoryUsage: memUsage,
            cpuUsage: null,
            samples: 0,
            history: [],
            peakHeapUsed: memUsage.heapUsed,
            peakHeapTotal: memUsage.heapTotal,
            peakExternal: memUsage.external,
          });
        }

        const projUsage = this._projectResourceUsage.get(projectId);
        projUsage.memoryUsage = memUsage;
        projUsage.samples = (projUsage.samples || 0) + 1;
        if (memUsage.heapUsed > projUsage.peakHeapUsed) {
          projUsage.peakHeapUsed = memUsage.heapUsed;
        }
      }

      if (cpuUsage) {
        this.resourceUsageLog.push({
          type: 'cpu_sample',
          projectId,
          user: cpuUsage.user,
          system: cpuUsage.system,
          timestamp: Date.now(),
          isoTimestamp: new Date().toISOString(),
          sampled: true,
        });

        const projUsage = this._projectResourceUsage.get(projectId);
        if (projUsage) {
          projUsage.cpuUsage = cpuUsage;
          if (cpuUsage.user > projUsage.peakCPUUser) {
            projUsage.peakCPUUser = cpuUsage.user;
          }
          if (cpuUsage.system > projUsage.peakCPUSystem) {
            projUsage.peakCPUSystem = cpuUsage.system;
          }
        }
      }
    } catch (err) {
      log.warn('Failed to sample resource usage', { error: err.message });
    }
  }

_clearAllResourceTimers() {
    for (const [key, timerId] of this._resourceSampleTimers) {
      clearInterval(timerId);
    }
    this._resourceSampleTimers.clear();
  }

async _teardownResourceTracking() {
    this._clearAllResourceTimers();

    // Restore original process methods to avoid polluting subsequent tests
    if (this._originalMemoryUsage) {
      process.memoryUsage = this._originalMemoryUsage;
      this._originalMemoryUsage = null;
    }
    if (this._originalCpuUsage) {
      process.cpuUsage = this._originalCpuUsage;
      this._originalCpuUsage = null;
    }

    log.debug('Resource tracking teardown complete', {
      totalSamples: this.resourceUsageLog.length,
      trackedProjects: this._projectResourceUsage.size,
      projectStats: this._getProjectResourceSummary(),
    });
  }

_getProjectResourceSummary() {
    const summary = {};
    for (const [projectId, usage] of this._projectResourceUsage) {
      summary[projectId] = {
        samples: usage.samples,
        peakHeapUsed: usage.peakHeapUsed,
        peakHeapTotal: usage.peakHeapTotal,
        peakExternal: usage.peakExternal,
        peakCPUUser: usage.peakCPUUser,
        peakCPUSystem: usage.peakCPUSystem,
        currentMemory: usage.memoryUsage,
        currentCPU: usage.cpuUsage,
      };
    }
    return summary;
  }

_generateMonitoringSummary() {
    const summary = {
      monitoringDuration: this.snapshots.length > 0
        ? this.snapshots[this.snapshots.length - 1].timestamp - this.snapshots[0].timestamp
        : 0,
      snapshotsCaptured: this.snapshots.length,
      fileAccesses: this.fileAccessLog.length,
      ipcEvents: {
        total: this.ipcLog.length,
        crossProject: this.ipcLog.filter(msg => msg.crossProject).length,
        byType: {},
        byProject: {},
      },
      resourceSamples: this.resourceUsageLog.length,
      activeWorkers: this._activeWorkers.size,
      activeProcesses: this._activeProcesses.size,
      trackedProjects: this._projectResourceUsage.size,
      ipcChannels: this._ipcChannels.size,
      sharedMemory: {
        buffers: this._sharedBuffers.size,
        messageChannels: this._messageChannels.size,
        crossProjectBuffers: Array.from(this._sharedBuffers.values()).filter(b => b.accessedBy.size > 1).length,
        events: this.sharedMemoryLog.length,
      },
      fileDescriptors: {
        snapshots: this._handleSnapshots.length,
        currentHandles: this._getActiveHandles().length,
        trackedProjects: this._projectFileDescriptors.size,
      },
      eventListeners: {
        snapshots: this.eventListenerLog.length,
        trackedProjects: this._projectEventListeners.size,
      },
    };

    for (const msg of this.ipcLog) {
      summary.ipcEvents.byType[msg.type] = (summary.ipcEvents.byType[msg.type] || 0) + 1;
      if (msg.projectId) {
        summary.ipcEvents.byProject[msg.projectId] = (summary.ipcEvents.byProject[msg.projectId] || 0) + 1;
      }
    }

    return summary;
  }

  _getCurrentProjectContext() {
    if (this.stateManager && this.stateManager.currentProjectId) {
      return this.stateManager.currentProjectId;
    }
    if (this.stateManager && this.stateManager.projects && this.stateManager.projects.size > 0) {
      const firstProject = this.stateManager.projects.keys().next().value;
      return firstProject || null;
    }
    return 'unknown';
  }

  getFsProxy() {
    return this._fsProxy || this._fs;
  }

  getSnapshotCount() {
    return this.snapshots.length;
  }

  getFileAccessLog() {
    return [...this.fileAccessLog];
  }

  getSessionAccessLog() {
    return [...this.sessionAccessLog];
  }

  getIPCLog() {
    return [...this.ipcLog];
  }

  getIPCChannels() {
    const channels = {};
    for (const [channel, info] of this._ipcChannels) {
      channels[channel] = {
        created: info.created,
        messageCount: info.messageCount,
        totalBytes: info.totalBytes,
        projects: Array.from(info.projects),
      };
    }
    return channels;
  }

  getResourceUsageLog() {
    return [...this.resourceUsageLog];
  }

  getActiveWorkers() {
    return new Map(this._activeWorkers);
  }

  getActiveProcesses() {
    return new Map(this._activeProcesses);
  }

  getProjectResourceUsage() {
    const usage = {};
    for (const [projectId, data] of this._projectResourceUsage) {
      usage[projectId] = {
        memoryUsage: data.memoryUsage,
        cpuUsage: data.cpuUsage,
        samples: data.samples,
        peakHeapUsed: data.peakHeapUsed,
        peakHeapTotal: data.peakHeapTotal,
        peakExternal: data.peakExternal,
        peakCPUUser: data.peakCPUUser,
        peakCPUSystem: data.peakCPUSystem,
        history: data.history ? [...data.history] : [],
      };
    }
    return usage;
  }

  getResourceUsageSummary() {
    return this._getProjectResourceSummary();
  }

  getMonitoringSummary() {
    return this._generateMonitoringSummary();
  }

  // --- Shared Memory Tracking ---

  _setupSharedMemoryTracking() {
    const self = this;
    const OriginalSharedArrayBuffer = globalThis.SharedArrayBuffer;

    if (OriginalSharedArrayBuffer) {
      this._originalSharedArrayBuffer = OriginalSharedArrayBuffer;

      // We can't replace the constructor, but we can track allocations
      // by intercepting worker postMessage to detect SharedArrayBuffer transfers
      log.debug('Shared memory tracking enabled');
    }

    // Enhanced: Track Buffer and TypedArray transfers across IPC boundaries
    this._trackBufferTransfers();
  }

  _trackBufferTransfers() {
    const self = this;
    
    // Track Buffer creation and transfers
    const OriginalBuffer = Buffer;
    
    // Intercept Buffer.from and Buffer.alloc to track allocations by project
    if (typeof OriginalBuffer.from === 'function') {
      const originalFrom = OriginalBuffer.from;
      OriginalBuffer.from = function(data, ...args) {
        const buffer = originalFrom.apply(this, [data, ...args]);
        const projectId = self._getCurrentProjectContext();
        
        // Track large buffer allocations (> 1MB)
        if (buffer.byteLength > 1024 * 1024) {
          self.resourceUsageLog.push({
            type: 'large_buffer_allocation',
            projectId,
            byteLength: buffer.byteLength,
            timestamp: Date.now(),
            isoTimestamp: new Date().toISOString(),
          });
        }
        
        return buffer;
      };
    }

    // Track ArrayBuffer transfers
    if (typeof globalThis.ArrayBuffer === 'function') {
      const originalArrayBuffer = globalThis.ArrayBuffer;
      globalThis.ArrayBuffer = function(byteLength) {
        const buffer = new originalArrayBuffer(byteLength);
        const projectId = self._getCurrentProjectContext();
        
        if (byteLength > 1024 * 1024) {
          self.resourceUsageLog.push({
            type: 'large_arraybuffer_allocation',
            projectId,
            byteLength,
            timestamp: Date.now(),
            isoTimestamp: new Date().toISOString(),
          });
        }
        
        return buffer;
      };
    }
  }

  _teardownSharedMemoryTracking() {
    this._sharedBuffers.clear();
    this._messageChannels.clear();
  }

  registerSharedBuffer(projectId, buffer, label = '') {
    if (!this.isMonitoring) return;

    const bufferId = `sab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._sharedBuffers.set(bufferId, {
      projectId,
      byteLength: buffer.byteLength,
      label,
      createdAt: Date.now(),
      accessedBy: new Set([projectId]),
    });

    this.sharedMemoryLog.push({
      type: 'shared_buffer_created',
      bufferId,
      projectId,
      byteLength: buffer.byteLength,
      label,
      timestamp: Date.now(),
      isoTimestamp: new Date().toISOString(),
    });

    return bufferId;
  }

  recordSharedBufferAccess(bufferId, projectId, operation = 'read') {
    if (!this.isMonitoring) return;

    const bufferInfo = this._sharedBuffers.get(bufferId);
    if (!bufferInfo) return;

    const crossProject = bufferInfo.projectId !== projectId;
    bufferInfo.accessedBy.add(projectId);

    this.sharedMemoryLog.push({
      type: 'shared_buffer_access',
      bufferId,
      projectId,
      ownerProject: bufferInfo.projectId,
      operation,
      crossProject,
      timestamp: Date.now(),
      isoTimestamp: new Date().toISOString(),
    });

    if (crossProject && this.options.enableRealtimeViolationEvents) {
      this.emit('violation', {
        type: 'shared_memory_leakage',
        severity: 'critical',
        details: {
          bufferId,
          ownerProject: bufferInfo.projectId,
          accessingProject: projectId,
          operation,
        },
      });
      log.warn('Cross-project shared memory access detected', {
        bufferId,
        ownerProject: bufferInfo.projectId,
        accessingProject: projectId,
      });
    }
  }

  registerMessageChannel(projectId, label = '') {
    const channelId = `mc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._messageChannels.set(channelId, {
      projectId,
      label,
      createdAt: Date.now(),
      messageCount: 0,
      accessedBy: new Set([projectId]),
    });

    this.sharedMemoryLog.push({
      type: 'message_channel_created',
      channelId,
      projectId,
      label,
      timestamp: Date.now(),
      isoTimestamp: new Date().toISOString(),
    });

    return channelId;
  }

  recordMessageChannelAccess(channelId, projectId) {
    if (!this.isMonitoring) return;

    const channelInfo = this._messageChannels.get(channelId);
    if (!channelInfo) return;

    const crossProject = channelInfo.projectId !== projectId;
    channelInfo.accessedBy.add(projectId);
    channelInfo.messageCount++;

    this.sharedMemoryLog.push({
      type: 'message_channel_access',
      channelId,
      projectId,
      ownerProject: channelInfo.projectId,
      crossProject,
      timestamp: Date.now(),
      isoTimestamp: new Date().toISOString(),
    });

    if (crossProject && this.options.enableRealtimeViolationEvents) {
      this.emit('violation', {
        type: 'message_channel_leakage',
        severity: 'high',
        details: {
          channelId,
          ownerProject: channelInfo.projectId,
          accessingProject: projectId,
        },
      });
    }
  }

  _captureSharedMemoryState() {
    const state = {
      sharedBuffers: {},
      messageChannels: {},
      totalSharedBytes: 0,
      crossProjectBuffers: 0,
      crossProjectChannels: 0,
    };

    for (const [bufferId, info] of this._sharedBuffers) {
      state.sharedBuffers[bufferId] = {
        projectId: info.projectId,
        byteLength: info.byteLength,
        label: info.label,
        accessedBy: Array.from(info.accessedBy),
        crossProject: info.accessedBy.size > 1,
      };
      state.totalSharedBytes += info.byteLength;
      if (info.accessedBy.size > 1) state.crossProjectBuffers++;
    }

    for (const [channelId, info] of this._messageChannels) {
      state.messageChannels[channelId] = {
        projectId: info.projectId,
        label: info.label,
        messageCount: info.messageCount,
        accessedBy: Array.from(info.accessedBy),
        crossProject: info.accessedBy.size > 1,
      };
      if (info.accessedBy.size > 1) state.crossProjectChannels++;
    }

    return state;
  }

  _detectSharedMemoryLeakage(snapshot) {
    const violations = [];
    const sharedMem = snapshot.sharedMemory;
    if (!sharedMem) return violations;

    for (const [bufferId, info] of Object.entries(sharedMem.sharedBuffers)) {
      if (info.crossProject) {
        violations.push({
          type: 'shared_memory_leakage',
          description: `SharedArrayBuffer ${bufferId} accessed by multiple projects: ${info.accessedBy.join(', ')}`,
          details: {
            bufferId,
            ownerProject: info.projectId,
            accessedBy: info.accessedBy,
            byteLength: info.byteLength,
          },
          severity: 'critical',
        });
      }
    }

    for (const [channelId, info] of Object.entries(sharedMem.messageChannels)) {
      if (info.crossProject) {
        violations.push({
          type: 'message_channel_leakage',
          description: `MessageChannel ${channelId} shared across projects: ${info.accessedBy.join(', ')}`,
          details: {
            channelId,
            ownerProject: info.projectId,
            accessedBy: info.accessedBy,
            messageCount: info.messageCount,
          },
          severity: 'high',
        });
      }
    }

    return violations;
  }

  // Enhanced: Detect IPC-based state leakage for concurrent execution
  detectIPCStateLeakage() {
    const violations = [];
    
    // Check for cross-project message sharing
    const messageProjects = new Map();
    for (const msg of this.ipcLog) {
      if (msg.data && typeof msg.data === 'object') {
        const msgKey = this._getMessageFingerprint(msg.data);
        if (!messageProjects.has(msgKey)) {
          messageProjects.set(msgKey, new Set());
        }
        if (msg.projectId) messageProjects.get(msgKey).add(msg.projectId);
        if (msg.sourceProject) messageProjects.get(msgKey).add(msg.sourceProject);
        if (msg.targetProject) messageProjects.get(msgKey).add(msg.targetProject);
      }
    }

    for (const [msgKey, projects] of messageProjects) {
      if (projects.size > 1) {
        violations.push({
          type: 'ipc_state_leakage',
          description: `Identical message content detected across projects: ${Array.from(projects).join(', ')}`,
          details: {
            messageFingerprint: msgKey,
            projects: Array.from(projects),
            projectCount: projects.size,
            timestamp: Date.now(),
            isoTimestamp: new Date().toISOString(),
          },
          severity: 'high',
        });
      }
    }

    // Check for shared IPC channels between projects
    for (const [channel, info] of this._ipcChannels) {
      if (info.projects.size > 1) {
        const projects = Array.from(info.projects);
        violations.push({
          type: 'ipc_channel_leakage',
          description: `IPC channel '${channel}' shared between projects: ${projects.join(', ')}`,
          details: {
            channel,
            projects,
            messageCount: info.messageCount,
            totalBytes: info.totalBytes,
            created: info.created,
            timestamp: Date.now(),
            isoTimestamp: new Date().toISOString(),
          },
          severity: 'high',
        });
      }
    }

    // Check for suspicious IPC patterns (rapid cross-project communication)
    const timeWindows = this._detectRapidCrossProjectCommunication();
    for (const window of timeWindows) {
      violations.push({
        type: 'ipc_rapid_cross_project',
        description: `Rapid cross-project communication detected: ${window.messageCount} messages in ${window.duration}ms between ${window.projects.join(', ')}`,
        details: window,
        severity: 'medium',
      });
    }

    return violations;
  }

  _getMessageFingerprint(data) {
    try {
      const str = JSON.stringify(data);
      const truncated = str.slice(0, 100);
      let hash = 0;
      for (let i = 0; i < truncated.length; i++) {
        hash = ((hash << 5) - hash) + truncated.charCodeAt(i);
        hash &= hash;
      }
      return `fp_${Math.abs(hash).toString(16).slice(0, 12)}`;
    } catch {
      return 'fp_unknown';
    }
  }

  _detectRapidCrossProjectCommunication() {
    const windows = [];
    const windowSize = 1000; // 1 second windows
    const threshold = 10; // More than 10 messages per second is suspicious
    
    if (this.ipcLog.length < 2) return windows;

    // Group messages by time windows
    const timeGroups = new Map();
    for (const msg of this.ipcLog) {
      if (!msg.timestamp) continue;
      const windowKey = Math.floor(msg.timestamp / windowSize);
      if (!timeGroups.has(windowKey)) {
        timeGroups.set(windowKey, []);
      }
      timeGroups.get(windowKey).push(msg);
    }

    // Check each window for cross-project activity
    for (const [windowKey, messages] of timeGroups) {
      if (messages.length < threshold) continue;
      
      const projects = new Set();
      for (const msg of messages) {
        if (msg.projectId) projects.add(msg.projectId);
        if (msg.sourceProject) projects.add(msg.sourceProject);
        if (msg.targetProject) projects.add(msg.targetProject);
      }

      if (projects.size > 1) {
        windows.push({
          windowKey,
          messageCount: messages.length,
          duration: windowSize,
          projects: Array.from(projects),
          timestamp: windowKey * windowSize,
        });
      }
    }

    return windows;
  }

  // --- File Descriptor / Handle Tracking ---

  _captureFileDescriptorSnapshot(label) {
    const handles = this._getActiveHandles();
    const snapshot = {
      label,
      timestamp: Date.now(),
      isoTimestamp: new Date().toISOString(),
      handleCount: handles.length,
      handleTypes: {},
      projectId: this._getCurrentProjectContext(),
    };

    for (const handle of handles) {
      const type = handle.constructor?.name || 'Unknown';
      snapshot.handleTypes[type] = (snapshot.handleTypes[type] || 0) + 1;
    }

    this._handleSnapshots.push(snapshot);
    this.fileDescriptorLog.push(snapshot);

    const projectId = snapshot.projectId;
    if (!this._projectFileDescriptors.has(projectId)) {
      this._projectFileDescriptors.set(projectId, []);
    }
    this._projectFileDescriptors.get(projectId).push(snapshot);

    return snapshot;
  }

  _getActiveHandles() {
    if (typeof process._getActiveHandles === 'function') {
      return process._getActiveHandles();
    }
    return [];
  }

  _captureFileDescriptorState() {
    const currentHandles = this._getActiveHandles();
    const state = {
      currentHandleCount: currentHandles.length,
      handleTypes: {},
      projectSnapshots: {},
      leaked: false,
      leakedCount: 0,
    };

    for (const handle of currentHandles) {
      const type = handle.constructor?.name || 'Unknown';
      state.handleTypes[type] = (state.handleTypes[type] || 0) + 1;
    }

    for (const [projectId, snapshots] of this._projectFileDescriptors) {
      if (snapshots.length >= 2) {
        const first = snapshots[0];
        const last = snapshots[snapshots.length - 1];
        const growth = last.handleCount - first.handleCount;
        state.projectSnapshots[projectId] = {
          initialHandles: first.handleCount,
          currentHandles: last.handleCount,
          growth,
          samples: snapshots.length,
        };
        if (growth > this.options.maxFileDescriptorsPerProject) {
          state.leaked = true;
          state.leakedCount += growth;
        }
      }
    }

    return state;
  }

  _detectFileDescriptorLeakage(snapshot) {
    const violations = [];
    const fdState = snapshot.fileDescriptors;
    if (!fdState) return violations;

    for (const [projectId, stats] of Object.entries(fdState.projectSnapshots)) {
      if (stats.growth > this.options.maxFileDescriptorsPerProject) {
        violations.push({
          type: 'file_descriptor_leak',
          description: `Project ${projectId} leaked ${stats.growth} file descriptors (${stats.initialHandles} → ${stats.currentHandles})`,
          details: {
            projectId,
            initialHandles: stats.initialHandles,
            currentHandles: stats.currentHandles,
            growth: stats.growth,
            limit: this.options.maxFileDescriptorsPerProject,
          },
          severity: 'high',
        });
      }
    }

    // Detect cross-project handle growth correlation (two projects growing together suggests shared resources)
    const projectIds = Object.keys(fdState.projectSnapshots);
    for (let i = 0; i < projectIds.length; i++) {
      for (let j = i + 1; j < projectIds.length; j++) {
        const a = fdState.projectSnapshots[projectIds[i]];
        const b = fdState.projectSnapshots[projectIds[j]];
        if (a.growth > 5 && b.growth > 5) {
          const ratio = Math.min(a.growth, b.growth) / Math.max(a.growth, b.growth);
          if (ratio > 0.8) {
            violations.push({
              type: 'file_descriptor_correlation',
              description: `Projects ${projectIds[i]} and ${projectIds[j]} show correlated handle growth (ratio ${ratio.toFixed(2)}), suggesting shared resource leak`,
              details: {
                projectA: projectIds[i],
                projectB: projectIds[j],
                growthA: a.growth,
                growthB: b.growth,
                correlationRatio: ratio,
              },
              severity: 'medium',
            });
          }
        }
      }
    }

    return violations;
  }

  // --- Event Listener Leak Detection ---

  _captureEventListenerSnapshot(label) {
    const projectId = this._getCurrentProjectContext();
    const emitters = this._getTrackedEmitters();
    const snapshot = {
      label,
      timestamp: Date.now(),
      projectId,
      emitters: {},
      totalListeners: 0,
    };

    for (const [name, emitter] of emitters) {
      if (typeof emitter.eventNames === 'function' && typeof emitter.listenerCount === 'function') {
        const events = emitter.eventNames();
        let listenerCount = 0;
        const eventDetails = {};
        for (const event of events) {
          const count = emitter.listenerCount(event);
          eventDetails[event] = count;
          listenerCount += count;
        }
        snapshot.emitters[name] = {
          totalListeners: listenerCount,
          events: eventDetails,
          maxListeners: emitter.getMaxListeners?.() || 10,
        };
        snapshot.totalListeners += listenerCount;
      }
    }

    this.eventListenerLog.push(snapshot);

    if (!this._projectEventListeners.has(projectId)) {
      this._projectEventListeners.set(projectId, []);
    }
    this._projectEventListeners.get(projectId).push(snapshot);

    return snapshot;
  }

  _getTrackedEmitters() {
    const emitters = new Map();
    emitters.set('process', process);

    // Track the state manager if it's an EventEmitter
    if (this.stateManager && typeof this.stateManager.eventNames === 'function') {
      emitters.set('stateManager', this.stateManager);
    }

    // Track this monitor itself
    emitters.set('isolationMonitor', this);

    return emitters;
  }

  _captureEventListenerState() {
    const state = {
      projectListeners: {},
      leakedEmitters: [],
      totalGrowth: 0,
    };

    for (const [projectId, snapshots] of this._projectEventListeners) {
      if (snapshots.length >= 2) {
        const first = snapshots[0];
        const last = snapshots[snapshots.length - 1];
        const growth = last.totalListeners - first.totalListeners;
        state.projectListeners[projectId] = {
          initialListeners: first.totalListeners,
          currentListeners: last.totalListeners,
          growth,
          samples: snapshots.length,
        };
        state.totalGrowth += growth;
      }
    }

    // Check current emitters for exceeding limits
    const emitters = this._getTrackedEmitters();
    for (const [name, emitter] of emitters) {
      if (typeof emitter.eventNames === 'function' && typeof emitter.listenerCount === 'function') {
        const events = emitter.eventNames();
        for (const event of events) {
          const count = emitter.listenerCount(event);
          if (count > this.options.maxEventListenersPerEmitter) {
            state.leakedEmitters.push({
              emitter: name,
              event,
              listenerCount: count,
              limit: this.options.maxEventListenersPerEmitter,
            });
          }
        }
      }
    }

    return state;
  }

  _detectEventListenerLeakage(snapshot) {
    const violations = [];
    const listenerState = snapshot.eventListeners;
    if (!listenerState) return violations;

    for (const leaked of listenerState.leakedEmitters) {
      violations.push({
        type: 'event_listener_leak',
        description: `Emitter "${leaked.emitter}" has ${leaked.listenerCount} listeners for "${leaked.event}" (limit: ${leaked.limit})`,
        details: leaked,
        severity: 'medium',
      });
    }

    for (const [projectId, stats] of Object.entries(listenerState.projectListeners)) {
      if (stats.growth > this.options.maxEventListenersPerEmitter) {
        violations.push({
          type: 'event_listener_leak',
          description: `Project ${projectId} grew ${stats.growth} event listeners (${stats.initialListeners} → ${stats.currentListeners})`,
          details: {
            projectId,
            initialListeners: stats.initialListeners,
            currentListeners: stats.currentListeners,
            growth: stats.growth,
          },
          severity: 'medium',
        });
      }
    }

    return violations;
  }

  // --- Per-Project Resource Budget Enforcement ---

  setProjectResourceBudget(projectId, budget) {
    this.options.projectResourceBudgets[projectId] = {
      maxHeapMB: budget.maxHeapMB ?? null,
      maxCPUPercent: budget.maxCPUPercent ?? null,
      maxFileDescriptors: budget.maxFileDescriptors ?? null,
      maxEventListeners: budget.maxEventListeners ?? null,
      ...budget,
    };
  }

  checkProjectBudgets() {
    const violations = [];

    for (const [projectId, budget] of Object.entries(this.options.projectResourceBudgets)) {
      const projUsage = this._projectResourceUsage.get(projectId);
      if (!projUsage) continue;

      if (budget.maxHeapMB && projUsage.memoryUsage) {
        const heapMB = projUsage.memoryUsage.heapUsed / 1024 / 1024;
        if (heapMB > budget.maxHeapMB) {
          violations.push({
            type: 'resource_budget_exceeded',
            description: `Project ${projectId} exceeded heap budget: ${heapMB.toFixed(2)}MB > ${budget.maxHeapMB}MB`,
            details: { projectId, heapMB, budgetMB: budget.maxHeapMB },
            severity: 'high',
          });
        }
      }

      if (budget.maxFileDescriptors) {
        const fdSnapshots = this._projectFileDescriptors.get(projectId);
        if (fdSnapshots && fdSnapshots.length > 0) {
          const latest = fdSnapshots[fdSnapshots.length - 1];
          if (latest.handleCount > budget.maxFileDescriptors) {
            violations.push({
              type: 'resource_budget_exceeded',
              description: `Project ${projectId} exceeded file descriptor budget: ${latest.handleCount} > ${budget.maxFileDescriptors}`,
              details: { projectId, handleCount: latest.handleCount, budget: budget.maxFileDescriptors },
              severity: 'high',
            });
          }
        }
      }
    }

    return violations;
  }

  // --- Comprehensive Resource Report ---

  getResourceReport() {
    return {
      monitoring: this.isMonitoring,
      snapshots: this.snapshots.length,
      ipc: {
        totalEvents: this.ipcLog.length,
        crossProjectEvents: this.ipcLog.filter(e => e.crossProject).length,
        activeWorkers: this._activeWorkers.size,
        activeProcesses: this._activeProcesses.size,
        channels: this._ipcChannels.size,
        channelsByProject: this._getIPCChannelsByProject(),
      },
      sharedMemory: {
        buffers: this._sharedBuffers.size,
        channels: this._messageChannels.size,
        crossProjectBuffers: Array.from(this._sharedBuffers.values()).filter(b => b.accessedBy.size > 1).length,
        totalSharedBytes: Array.from(this._sharedBuffers.values()).reduce((sum, b) => sum + b.byteLength, 0),
      },
      resources: {
        trackedProjects: this._projectResourceUsage.size,
        totalSamples: this.resourceUsageLog.length,
        budgets: Object.keys(this.options.projectResourceBudgets),
        perProject: this._getProjectResourceSummary(),
        correlations: this._projectResourceUsage.size >= 2 ? this._detectCorrelatedResourceUsage() : [],
      },
      fileDescriptors: {
        snapshots: this._handleSnapshots.length,
        currentHandles: this._getActiveHandles().length,
        perProject: Object.fromEntries(
          Array.from(this._projectFileDescriptors.entries()).map(([pid, snaps]) => [
            pid,
            { samples: snaps.length, latest: snaps[snaps.length - 1]?.handleCount ?? 0 },
          ])
        ),
      },
      eventListeners: {
        snapshots: this.eventListenerLog.length,
        perProject: Object.fromEntries(
          Array.from(this._projectEventListeners.entries()).map(([pid, snaps]) => [
            pid,
            { samples: snaps.length, latest: snaps[snaps.length - 1]?.totalListeners ?? 0 },
          ])
        ),
      },
    };
  }

  _getIPCChannelsByProject() {
    const byProject = {};
    for (const [channel, info] of this._ipcChannels) {
      for (const project of info.projects) {
        if (!byProject[project]) {
          byProject[project] = [];
        }
        byProject[project].push({
          channel,
          messageCount: info.messageCount,
          totalBytes: info.totalBytes,
        });
      }
    }
    return byProject;
  }

  // Enhanced: Generate concurrent execution isolation report
  generateConcurrentExecutionReport(projectA, projectB) {
    const validation = this.validateConcurrentExecution(projectA, projectB);
    const resourceReport = this.getResourceReport();
    const summary = this.getMonitoringSummary();

    return {
      isolated: validation.isolated,
      zeroSharedState: validation.isolated,
      projects: {
        A: projectA,
        B: projectB,
      },
      isolationLayers: {
        session: validation.sessionIsolation,
        memory: validation.memoryIsolation,
        ipc: validation.ipcIsolation,
        filesystem: validation.filesystemIsolation,
        agentContext: validation.agentContextIsolation,
      },
      violations: validation.violations,
      statistics: {
        snapshotsCaptured: summary.snapshotsCaptured,
        ipcEvents: summary.ipcEvents,
        resourceSamples: summary.resourceSamples,
        activeWorkers: summary.activeWorkers,
        activeProcesses: summary.activeProcesses,
      },
      resourceUsage: resourceReport.resources,
      ipcChannels: resourceReport.ipc,
      timestamp: Date.now(),
      isoTimestamp: new Date().toISOString(),
    };
  }

  // --- Accessors for new logs ---

  getSharedMemoryLog() {
    return [...this.sharedMemoryLog];
  }

  getFileDescriptorLog() {
    return [...this.fileDescriptorLog];
  }

  getEventListenerLog() {
    return [...this.eventListenerLog];
  }

  getSharedBuffers() {
    const buffers = {};
    for (const [id, info] of this._sharedBuffers) {
      buffers[id] = {
        projectId: info.projectId,
        byteLength: info.byteLength,
        label: info.label,
        accessedBy: Array.from(info.accessedBy),
      };
    }
    return buffers;
  }

  getMessageChannels() {
    const channels = {};
    for (const [id, info] of this._messageChannels) {
      channels[id] = {
        projectId: info.projectId,
        label: info.label,
        messageCount: info.messageCount,
        accessedBy: Array.from(info.accessedBy),
      };
    }
    return channels;
  }

  clearLogs() {
    this.snapshots = [];
    this.fileAccessLog = [];
    this.sessionAccessLog = [];
    this.memoryAccessLog = [];
    this.agentContextLog = [];
    this.ipcLog = [];
    this.resourceUsageLog = [];
    this.sharedMemoryLog = [];
    this.fileDescriptorLog = [];
    this.eventListenerLog = [];
    this._activeWorkers.clear();
    this._activeProcesses.clear();
    this._projectResourceUsage.clear();
    this._ipcChannels.clear();
    this._resourceHistory.clear();
    this._sharedBuffers.clear();
    this._messageChannels.clear();
    this._projectFileDescriptors.clear();
    this._projectEventListeners.clear();
    this._handleSnapshots = [];
    this._clearAllResourceTimers();
  }

  reset() {
    this.clearLogs();
    this.isMonitoring = false;
  }

  // Getters for new enhanced tracking
  getBufferAllocations() {
    return this.resourceUsageLog.filter(
      e => e.type === 'large_buffer_allocation' || e.type === 'large_arraybuffer_allocation'
    );
  }

  getIPCStateLeakageViolations() {
    return this.detectIPCStateLeakage();
  }

  getCorrelatedResources() {
    return this._detectCorrelatedResourceUsage();
  }

  validateIsolation(projectA, projectB) {
    return this.validateConcurrentExecution(projectA, projectB);
  }

  getConcurrentExecutionReport(projectA, projectB) {
    return this.generateConcurrentExecutionReport(projectA, projectB);
  }
}

export default StateIsolationMonitor;
