/**
 * Session Context Leakage Detection
 * 
 * Monitors session state across projects to detect cross-project context leakage.
 * Tracks both agent sessions (from session.js) and deliberation sessions (from deliberation-coordinator.js).
 * 
 * Leakage vectors monitored:
 *  - Agent sessions appearing in wrong project scope
 *  - Deliberation sessions crossing project boundaries
 *  - Cross-session context contamination
 *  - Agent session keys referencing wrong projects
 */

import { createLogger } from '../logger.js';
import { DELIBERATION_STATES } from '../orchestrator/deliberation-protocol.js';

const log = createLogger('session-monitor');

export class SessionMonitor {
  constructor(options = {}) {
    this.options = {
      maxHistoryLength: 1000,
      enableSnapshot: true,
      snapshotIntervalMs: 5000,
      ...options
    };
    
    this.snapshots = new Map();
    this.leakageEvents = [];
    this.isMonitoring = false;
    this.snapshotTimer = null;
  }

  /**
   * Start monitoring session state
   * @param {Object} sessionManager - Session manager instance
   * @param {Object} deliberationCoordinator - DeliberationCoordinator instance (optional)
   */
  start(sessionManager, deliberationCoordinator = null) {
    if (this.isMonitoring) {
      log.warn('Session monitor already active');
      return;
    }

    this.sessionManager = sessionManager;
    this.deliberationCoordinator = deliberationCoordinator;
    this.isMonitoring = true;

    log.info('Session context leakage detection started', {
      hasDeliberationCoordinator: !!deliberationCoordinator
    });

    if (this.options.enableSnapshot) {
      this.snapshotTimer = setInterval(() => {
        this.captureSnapshot();
      }, this.options.snapshotIntervalMs);
    }

    this.captureInitialBaseline();
  }

  /**
   * Stop monitoring and generate final report
   */
  stop() {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;

    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    log.info('Session context leakage detection stopped', {
      totalSnapshots: this.snapshots.size,
      leakageEventsDetected: this.leakageEvents.length
    });

    return this.generateReport();
  }

  /**
   * Capture initial baseline before any operations
   */
  captureInitialBaseline() {
    const baseline = this.captureCurrentState();
    this.snapshots.set('baseline', baseline);
    log.debug('Session baseline captured', {
      agentSessions: baseline.agentSessions.size,
      deliberationSessions: baseline.deliberationSessions.size
    });
  }

  /**
   * Capture current session state snapshot
   */
  captureSnapshot() {
    const snapshotId = `snapshot_${Date.now()}`;
    const state = this.captureCurrentState();
    
    this.snapshots.set(snapshotId, state);
    
    const leakage = this.detectLeakage(state);
    if (leakage.length > 0) {
      this.leakageEvents.push(...leakage);
      log.warn('Session context leakage detected', {
        snapshotId,
        leakageCount: leakage.length,
        details: leakage
      });
    }

    this.pruneOldSnapshots();
  }

  /**
   * Capture complete current session state
   */
  captureCurrentState() {
    const state = {
      timestamp: Date.now(),
      agentSessions: new Map(),
      deliberationSessions: new Map(),
      crossSessionContext: new Map(),
      agentSessionKeys: new Map()
    };

    if (this.sessionManager) {
      state.agentSessions = this.sessionManager.sessions || new Map();
      state.agentSessionKeys = this.collectAgentSessionKeys();
    }

    if (this.deliberationCoordinator) {
      state.deliberationSessions = this.collectDeliberationSessions();
    }

    state.crossSessionContext = this.collectCrossSessionContext();

    return state;
  }

  /**
   * Collect all agent session keys per agent
   */
  collectAgentSessionKeys() {
    const keys = new Map();
    if (this.sessionManager && this.sessionManager.sessions) {
      for (const [projectId, sessionStore] of this.sessionManager.sessions) {
        for (const [sessionKey, session] of sessionStore) {
          const agentKeys = keys.get(session.agentId) || [];
          agentKeys.push({ sessionKey, projectId, channelId: session.channelId });
          keys.set(session.agentId, agentKeys);
        }
      }
    }
    return keys;
  }

  /**
   * Collect all deliberation sessions across all projects
   */
  collectDeliberationSessions() {
    const sessions = new Map();
    if (!this.deliberationCoordinator || !this.deliberationCoordinator.store) {
      return sessions;
    }

    try {
      const store = this.deliberationCoordinator.store;
      
      for (const [key, value] of store.entries()) {
        if (key.startsWith('deliberation:')) {
          const sessionId = key.replace('deliberation:', '');
          sessions.set(sessionId, {
            sessionId,
            state: value,
            projectId: this.extractProjectIdFromDeliberation(value)
          });
        }
        if (key.startsWith('deliberation_session:')) {
          const taskId = key.replace('deliberation_session:', '');
          const linkedSessionId = value.sessionId || taskId;
          
          if (!sessions.has(linkedSessionId)) {
            sessions.set(linkedSessionId, {
              taskId,
              coordinatorRecord: value,
              projectId: this.extractProjectIdFromCoordinator(value)
            });
          } else {
            sessions.get(linkedSessionId).coordinatorRecord = value;
          }
        }
      }
    } catch (err) {
      log.warn('Failed to collect deliberation sessions', { error: err.message });
    }

    return sessions;
  }

  /**
   * Extract projectId from deliberation protocol state
   */
  extractProjectIdFromDeliberation(deliberationState) {
    return deliberationState?.metadata?.projectId || deliberationState?.projectId || 'unknown';
  }

  /**
   * Extract projectId from coordinator record
   */
  extractProjectIdFromCoordinator(coordinatorRecord) {
    return coordinatorRecord?.metadata?.projectId || coordinatorRecord?.projectId || 'unknown';
  }

  /**
   * Collect cross-session context per project
   */
  collectCrossSessionContext() {
    const context = new Map();
    
    if (this.sessionManager && this.sessionManager.stateManager) {
      try {
        const stateManager = this.sessionManager.stateManager;
        for (const projectId of stateManager.projects.keys()) {
          const ctx = stateManager.getProjectContext(projectId);
          if (ctx) {
            context.set(projectId, {
              projectId,
              contextLength: ctx.length,
              contextPreview: ctx.substring(0, 100)
            });
          }
        }
      } catch (err) {
        log.warn('Failed to collect cross-session context', { error: err.message });
      }
    }

    return context;
  }

  /**
   * Detect session context leakage across projects
   */
  detectLeakage(currentState) {
    const leakage = [];

    leakage.push(...this.detectAgentSessionCrossProject(currentState));
    leakage.push(...this.detectAgentSessionKeyMismatch(currentState));
    leakage.push(...this.detectDeliberationSessionCrossProject(currentState));
    leakage.push(...this.detectCrossSessionContextLeakage(currentState));

    return leakage;
  }

  /**
   * Detect agent sessions appearing in wrong project scope
   */
  detectAgentSessionCrossProject(state) {
    const leakage = [];

    for (const [projectId, sessionStore] of state.agentSessions) {
      for (const [sessionKey, session] of sessionStore) {
        const expectedProjectId = session.projectId;
        
        if (expectedProjectId && expectedProjectId !== projectId) {
          leakage.push({
            type: 'agent_session_wrong_project',
            severity: 'critical',
            sessionKey,
            expectedProjectId,
            actualProjectId: projectId,
            agentId: session.agentId,
            timestamp: state.timestamp
          });
        }
      }
    }

    return leakage;
  }

  /**
   * Detect agent session keys referencing wrong projects
   */
  detectAgentSessionKeyMismatch(state) {
    const leakage = [];

    for (const [agentId, sessionKeys] of state.agentSessionKeys) {
      for (const { sessionKey, projectId, channelId } of sessionKeys) {
        const keyParts = sessionKey.split('#');
        if (keyParts.length >= 1) {
          const keyProjectId = keyParts[0];
          
          if (keyProjectId !== projectId) {
            leakage.push({
              type: 'agent_session_key_mismatch',
              severity: 'high',
              agentId,
              sessionKey,
              keyProjectId,
              actualProjectId: projectId,
              channelId,
              timestamp: state.timestamp
            });
          }
        }
      }
    }

    return leakage;
  }

  /**
   * Detect deliberation sessions crossing project boundaries
   */
  detectDeliberationSessionCrossProject(state) {
    const leakage = [];

    for (const [sessionId, sessionData] of state.deliberationSessions) {
      const protocolProjectId = sessionData.projectId || 'unknown';
      const coordinatorProjectId = sessionData.coordinatorRecord?.metadata?.projectId || sessionData.coordinatorRecord?.projectId || 'unknown';

      if (coordinatorProjectId !== 'unknown' && protocolProjectId !== coordinatorProjectId) {
        leakage.push({
          type: 'deliberation_session_project_mismatch',
          severity: 'critical',
          sessionId,
          protocolProjectId,
          coordinatorProjectId,
          timestamp: state.timestamp
        });
      }

      if (sessionData.state?.participants) {
        for (const participant of sessionData.state.participants) {
          if (participant.projectId && participant.projectId !== protocolProjectId) {
            leakage.push({
              type: 'deliberation_participant_wrong_project',
              severity: 'high',
              sessionId,
              participantAgentId: participant.agentId,
              sessionProjectId: protocolProjectId,
              participantProjectId: participant.projectId,
              timestamp: state.timestamp
            });
          }
        }
      }
    }

    return leakage;
  }

  /**
   * Detect cross-session context leakage
   */
  detectCrossSessionContextLeakage(state) {
    const leakage = [];

    for (const [projectId, ctxData] of state.crossSessionContext) {
      const ctx = ctxData.contextPreview || '';
      
      for (const [otherProjectId, otherCtxData] of state.crossSessionContext) {
        if (projectId === otherProjectId) continue;

        const otherCtx = otherCtxData.contextPreview || '';

        if (ctx.includes(otherProjectId) && !ctx.includes('mentioned in')) {
          leakage.push({
            type: 'cross_session_context_leakage',
            severity: 'medium',
            projectId,
            leakedProjectId: otherProjectId,
            contextSnippet: ctx.substring(0, 200),
            timestamp: state.timestamp
          });
        }
      }
    }

    return leakage;
  }

  /**
   * Prune old snapshots to prevent memory bloat
   */
  pruneOldSnapshots() {
    const maxSnapshots = 100;
    const snapshotIds = Array.from(this.snapshots.keys()).filter(id => id !== 'baseline');
    
    if (snapshotIds.length > maxSnapshots) {
      const toRemove = snapshotIds.slice(0, snapshotIds.length - maxSnapshots);
      for (const id of toRemove) {
        this.snapshots.delete(id);
      }
    }
  }

  /**
   * Get leakage events by severity
   */
  getLeakageBySeverity(severity) {
    return this.leakageEvents.filter(e => e.severity === severity);
  }

  /**
   * Get leakage events by type
   */
  getLeakageByType(type) {
    return this.leakageEvents.filter(e => e.type === type);
  }

  /**
   * Generate comprehensive leakage report
   */
  generateReport() {
    const report = {
      timestamp: Date.now(),
      summary: {
        totalSnapshots: this.snapshots.size,
        totalLeakageEvents: this.leakageEvents.length,
        critical: this.getLeakageBySeverity('critical').length,
        high: this.getLeakageBySeverity('high').length,
        medium: this.getLeakageBySeverity('medium').length,
        low: this.getLeakageBySeverity('low').length
      },
      leakageEvents: this.leakageEvents,
      typeBreakdown: this.generateTypeBreakdown(),
      recommendations: this.generateRecommendations()
    };

    return report;
  }

  /**
   * Generate breakdown by leakage type
   */
  generateTypeBreakdown() {
    const breakdown = {};
    
    for (const event of this.leakageEvents) {
      const type = event.type;
      if (!breakdown[type]) {
        breakdown[type] = {
          count: 0,
          severityBreakdown: {}
        };
      }
      breakdown[type].count++;
      
      const severity = event.severity;
      if (!breakdown[type].severityBreakdown[severity]) {
        breakdown[type].severityBreakdown[severity] = 0;
      }
      breakdown[type].severityBreakdown[severity]++;
    }

    return breakdown;
  }

  /**
   * Generate recommendations based on detected leakage
   */
  generateRecommendations() {
    const recommendations = [];

    if (this.getLeakageBySeverity('critical').length > 0) {
      recommendations.push({
        priority: 'immediate',
        message: 'Critical session context leakage detected. Immediate investigation required.',
        action: 'Review and fix session initialization and project scoping logic.'
      });
    }

    if (this.getLeakageByType('agent_session_wrong_project').length > 0) {
      recommendations.push({
        priority: 'high',
        message: 'Agent sessions appearing in wrong project scope.',
        action: 'Verify sessionManager.getSession() correctly scopes sessions by projectId.'
      });
    }

    if (this.getLeakageByType('deliberation_session_project_mismatch').length > 0) {
      recommendations.push({
        priority: 'high',
        message: 'Deliberation sessions have mismatched project IDs between protocol and coordinator.',
        action: 'Ensure DeliberationCoordinator initializes sessions with consistent projectId.'
      });
    }

    if (this.getLeakageByType('cross_session_context_leakage').length > 0) {
      recommendations.push({
        priority: 'medium',
        message: 'Cross-session context may be leaking between projects.',
        action: 'Review context generation logic to ensure project isolation.'
      });
    }

    if (recommendations.length === 0) {
      recommendations.push({
        priority: 'info',
        message: 'No session context leakage detected.',
        action: 'Continue monitoring to maintain isolation.'
      });
    }

    return recommendations;
  }

  /**
   * Reset monitor state (useful for test isolation)
   */
  reset() {
    this.snapshots.clear();
    this.leakageEvents = [];
    log.debug('Session monitor reset');
  }

  /**
   * Get current session state snapshot (for testing)
   */
  getCurrentState() {
    return this.captureCurrentState();
  }

  /**
   * Manually check for leakage without capturing snapshot
   */
  checkLeakage() {
    const state = this.captureCurrentState();
    return this.detectLeakage(state);
  }
}

/**
 * Factory function to create session monitor with default configuration
 */
export function createSessionMonitor(options) {
  return new SessionMonitor(options);
}

export default SessionMonitor;
