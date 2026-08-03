/**
 * Session Management System — tracks agent conversations and prevents memory leaks.
 * Manages conversation history, enforces max turns, handles interruptions, and cleans up
 * on crashes or shutdowns. Integrates with rate limiting and heartbeat to detect stuck sessions.
 */

import { isOperatorSpeaker } from './conversation.js';
import { createLogger } from '../logger.js';
const log = createLogger('session');

// Constants
const DEFAULT_MAX_TURNS = 50;
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes of inactivity

export function createSessionManager(deps) {
  const {
    config,
    rateLimiter,
    thinkingAgents,
    busyAgents,
  } = deps;

  // In-memory session store: { projectId } => { agentId => session }
  // session: { agentId, projectId, channelId, createdAt, updatedAt, maxTurns, turns: number, context: string }
  const sessions = new Map();
  const agentSessionKeys = new Map(); // { agentId } => [sessionKey]

  /**
   * Get or create a session for an agent.
   * Returns session object with metadata.
   */
  function getSession(agentId, projectId, channelId) {
    const sessionKey = `${projectId}#${channelId}#${agentId}`;
    let sessionStore = sessions.get(projectId);
    
    if (!sessionStore) {
      sessionStore = new Map();
      sessions.set(projectId, sessionStore);
    }
    
    if (!sessionStore.has(sessionKey)) {
      sessionStore.set(sessionKey, {
        agentId,
        projectId,
        channelId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        turns: 0,
        maxTurns: DEFAULT_MAX_TURNS,
        history: [],
      });
      agentSessionKeys.set(agentId, [...(agentSessionKeys.get(agentId) || []), sessionKey]);
    }
    
    return { sessionKey, session: sessionStore.get(sessionKey) };
  }

  /**
   * Mark session as active (update timestamps).
   */
  function touchSession(agentId, projectId, channelId) {
    const { sessionKey, session } = getSession(agentId, projectId, channelId);
    session.updatedAt = new Date().toISOString();
    return sessionKey;
  }

  /**
   * Increment turn count for a session.
   * Returns { overLimit: boolean, overBy: number }
   */
  function incrementTurn(agentId, projectId, channelId) {
    const { session } = getSession(agentId, projectId, channelId);
    session.turns++;
    const overBy = session.turns - session.maxTurns;
    return { overLimit: overBy > 0, overBy };
  }

  /**
   * Record message in session history.
   * Keeps only most recent messages for efficiency.
   */
  function recordInSession(sessionKey, message, isSystem = false) {
    const sessionStore = sessions.get(sessionKey.split('#')[0]);
    if (sessionStore && sessionStore.has(sessionKey)) {
      const session = sessionStore.get(sessionKey);
      // Keep only last 100 messages to prevent unbounded growth
      while (session.history.length >= 100) {
        session.history.shift();
      }
      session.history.push({ timestamp: new Date().toISOString(), message, isSystem });
    }
  }

  /**
   * Close a session.
   * Removes from tracking and cleans up references.
   */
  function closeSession(agentId, projectId, channelId) {
    const sessionKey = `${projectId}#${channelId}#${agentId}`;
    log.debug('Closing session', { agentId, projectId, channelId, sessionKey });
    
    // Remove from project store
    const sessionStore = sessions.get(projectId);
    if (sessionStore && sessionStore.has(sessionKey)) {
      sessionStore.delete(sessionKey);
      log.debug('Removed session from project store', { projectId, sessionKey });
    }
    
    // Remove from agent index
    const agentKeys = agentSessionKeys.get(agentId) || [];
    const updatedKeys = agentKeys.filter(k => k !== sessionKey);
    if (updatedKeys.length === 0) {
      agentSessionKeys.delete(agentId);
    } else {
      agentSessionKeys.set(agentId, updatedKeys);
    }
    
    // Clean up empty project stores
    if (sessionStore && sessionStore.size === 0) {
      sessions.delete(projectId);
    }
  }

  /**
   * Check if agent has an active session.
   */
  function hasActiveSession(agentId, projectId, channelId) {
    const sessionKey = `${projectId}#${channelId}#${agentId}`;
    return !!sessions.get(projectId)?.get(sessionKey);
  }

  /**
   * Get active sessions for an agent across all projects/channels.
   */
  function getAgentSessions(agentId) {
    const keys = agentSessionKeys.get(agentId) || [];
    const sessionsList = [];
    
    for (const key of keys) {
      const [projectId, channelId] = key.split('#');
      const sessionStore = sessions.get(projectId);
      if (sessionStore) {
        const session = sessionStore.get(key);
        if (session) {
          sessionsList.push({ projectId, channelId, ...session });
        }
      }
    }
    
    return sessionsList;
  }

  /**
   * Check for stale sessions (timed out, over max turns, or rate limited).
   * Returns array of stale session keys.
   */
  function findStaleSessions() {
    const now = Date.now();
    const stale = [];
    
    for (const [projectId, sessionStore] of sessions) {
      for (const [sessionKey, session] of sessionStore) {
        const updatedAt = new Date(session.updatedAt).getTime();
        const age = now - updatedAt;
        
        // Session is stale if:
        // 1. Over max turns
        // 2. Timed out (15 min inactivity)
        // 3. Agent is rate limited (via deps.rateLimiter)
        const overMaxTurns = session.turns >= session.maxTurns;
        const timedOut = age > SESSION_TIMEOUT_MS;
        const isRateLimited = rateLimiter && rateLimiter.isLimited(session.agentId);
        
        if (overMaxTurns || timedOut || isRateLimited) {
          stale.push({ sessionKey, reason: overMaxTurns ? 'max_turns' : timedOut ? 'timeout' : 'rate_limited' });
        }
      }
    }
    
    return stale;
  }

  /**
   * Cleanup function to remove stale sessions and reconcile with thinkingAgents.
   */
  function cleanupStaleSessions() {
    const now = Date.now();
    let cleaned = 0;
    
    // First pass: remove sessions that don't exist in thinkingAgents anymore
    for (const [projectId, sessionStore] of sessions) {
      for (const [sessionKey, session] of sessionStore) {
        if (!thinkingAgents.has(sessionKey)) {
          closeSession(session.agentId, projectId, session.channelId);
          cleaned++;
        }
      }
    }
    
    // Second pass: check for stale sessions and clean them up
    const stale = findStaleSessions();
    for (const { sessionKey } of stale) {
      const [projectId, channelId, agentId] = sessionKey.split('#');
      closeSession(agentId, projectId, channelId);
      cleaned++;
      log.warn('Stale session cleaned up', { sessionKey, agentId });
    }
    
    log.debug('Session cleanup complete', { totalCleaned: cleaned });
    return cleaned;
  }

  /**
   * Startup recovery: reconcile session state with persisted task state.
   * Ensures we don't have stale sessions pointing to tasks that have already moved on.
   */
  function recoverSessions() {
    let recovered = 0;
    
    // Clean up any sessions that don't match current thinkingAgents
    for (const [projectId, sessionStore] of [...sessions.entries()]) {
      for (const [sessionKey] of [...sessionStore.entries()]) {
        if (!thinkingAgents.has(sessionKey)) {
          const [, channelId, agentId] = sessionKey.split('#');
          closeSession(agentId, projectId, channelId);
          recovered++;
        }
      }
    }
    
    // Also clean up busy agents that are no longer in sessions
    for (const agentId of [...busyAgents.keys()]) {
      const hasSession = agentSessionKeys.has(agentId);
      if (!hasSession) {
        busyAgents.delete(agentId);
        recovered++;
        log.debug('Removed stale busy agent', { agentId });
      }
    }
    
    if (recovered > 0) {
      log.info('Session recovery complete', { recovered });
    }
    
    return recovered;
  }

  /**
   * Shutdown preparation: notify active sessions of shutdown imminent.
   * Called before graceful shutdown begins.
   */
  function prepareForShutdown(addMessage, broadcastToChannel) {
    let notified = 0;
    
    for (const [projectId, sessionStore] of sessions) {
      for (const [sessionKey, session] of sessionStore) {
        const [, channelId] = sessionKey.split('#');
        try {
          addMessage(projectId, channelId, 'System',
            `Synapse shutting down — finishing current ${session.turns} turn(s) then stopping.`, 'system');
          broadcastToChannel(projectId, channelId, { type: 'shutdown_warning', message: 'Server shutting down shortly' });
          notified++;
        } catch (err) {
          log.warn('Failed to notify session of shutdown', { sessionKey, error: err.message });
        }
      }
    }
    
    return notified;
  }

  /**
   * Integrate with heartbeat: check for stuck sessions during each tick.
   */
  function heartbeatSessionCheck(taskManager) {
    const stale = findStaleSessions();
    if (stale.length > 0) {
      log.warn('Heartbeat detected stale sessions', { count: stale.length });
      // Don't auto-clean during heartbeat to avoid interrupting in-progress work
      // Just log for monitoring
    }
  }

  // Register session-aware rate limiter callbacks if available
  if (rateLimiter && typeof rateLimiter.registerSessionCallback === 'function') {
    rateLimiter.registerSessionCallback((agentId) => {
      const agentSessions = getAgentSessions(agentId);
      return agentSessions.length > 0;
    });
  }

  return {
    // Core session management
    getSession,
    touchSession,
    incrementTurn,
    recordInSession,
    closeSession,
    hasActiveSession,
    getAgentSessions,
    findStaleSessions,
    
    // Cleanup and recovery
    cleanupStaleSessions,
    recoverSessions,
    prepareForShutdown,
    heartbeatSessionCheck,
    
    // Internal state for integration
    get sessions() {
      return new Map([...sessions].map(([k, v]) => [k, new Map(v)]));
    },
    get sessionCount() {
      let count = 0;
      for (const sessionStore of sessions.values()) {
        count += sessionStore.size;
      }
      return count;
    },
  };
}

/**
 * Backward-compatible session command system used by orchestrator wiring.
 * Keep this exported while createSessionManager is being integrated.
 */
export function createSessionSystem(deps) {
  const { addMessage, stateManager, compactionManager, agendaManager, events, broadcastToChannel, getAgents, PROJECT_DIR } = deps;

  // Track active session topics per project
  const sessionTopics = new Map(); // projectId -> { topic, startedAt }

  function startSession(projectId, channelId, topic, userId = 'default') {
    sessionTopics.set(projectId, { topic, startedAt: new Date().toISOString() });
    addMessage(projectId, channelId, 'System', `Session started: "${topic}"`, 'system', { userId });

    // Inject cross-session context if available
    const ctx = stateManager.getProjectContext(projectId);
    if (ctx) {
      addMessage(projectId, channelId, 'System',
        `Previous session context loaded (${ctx.length} chars). Agents will have this context.`, 'system', { userId });
    }

    log.info('Session started', { projectId, topic, userId });
    events.emit('session:start', { projectId, channelId, topic, userId }).catch(() => {});
  }

  function resumeSession(projectId, channelId, userId = 'default') {
    const ctx = stateManager.getProjectContext(projectId);
    if (!ctx) {
      addMessage(projectId, channelId, 'System',
        'No previous session context found. Use "/session start <topic>" to begin.', 'system', { userId });
      return;
    }

    // Check if there's an active topic
    const active = sessionTopics.get(projectId);
    if (active) {
      addMessage(projectId, channelId, 'System',
        `Session already active: "${active.topic}" (started ${active.startedAt})`, 'system', { userId });
      return;
    }

    sessionTopics.set(projectId, { topic: 'Resumed session', startedAt: new Date().toISOString() });
    addMessage(projectId, channelId, 'System',
      `Session resumed. Previous context loaded (${ctx.length} chars).`, 'system', { userId });
    log.info('Session resumed', { projectId, userId });
  }

  function sessionStatus(projectId, channelId, userId = 'default') {
    const active = sessionTopics.get(projectId);
    const ctx = stateManager.getProjectContext(projectId);
    const proj = stateManager.getProject(projectId);

    const lines = [];
    lines.push(`Project: ${projectId} (${proj?.displayName || projectId})`);
    lines.push(`Channels: ${proj?.channels.join(', ') || 'none'}`);
    lines.push(`Active session: ${active ? `"${active.topic}" (started ${active.startedAt})` : 'none'}`);
    lines.push(`Cross-session context: ${ctx ? `${ctx.length} chars` : 'none'}`);

    // Count messages per channel
    if (proj) {
      for (const ch of proj.channels) {
        const msgs = stateManager.getMessages(projectId, ch, 9999);
        const agentMsgs = msgs.filter(m => m.type === 'message' && !isOperatorSpeaker(m.speaker));
        lines.push(`  #${ch}: ${msgs.length} messages (${agentMsgs.length} from agents)`);
      }
    }

    addMessage(projectId, channelId, 'System', lines.join('\n'), 'system', { userId });
  }

  async function endSession(projectId, channelId, userId = 'default') {
    const topic = sessionTopics.get(projectId)?.topic || 'Unnamed session';
    sessionTopics.delete(projectId);
    addMessage(projectId, channelId, 'System', `Ending session "${topic}" — generating cross-session context...`, 'system', { userId });

    // Gather messages from all channels, organized by thread
    const proj = stateManager.getProject(projectId);
    if (!proj) {
      addMessage(projectId, channelId, 'System', 'Project not found.', 'system', { userId });
      return;
    }

    // Build thread-organized conversation sections
    const sections = [];

    for (const ch of proj.channels) {
      // Skip test channels
      if (ch.startsWith('test-')) continue;

      const threadSummaries = compactionManager.getThreadSummaries(projectId, ch);
      const allMsgs = stateManager.getMessages(projectId, ch, 200);

      if (threadSummaries.length > 0) {
        // Channel has threads — organize by thread
        for (const ts of threadSummaries) {
          if (ts.messageCount === 0) continue;
          sections.push(
            `### Thread: ${ts.label} (${ts.status}, ${ts.messageCount} msgs, participants: ${ts.participants.join(', ') || 'none'})\n` +
            `Channel: #${ch}\n` +
            ts.preview
          );
        }

        // Include unthreaded messages if any
        const unthreaded = allMsgs.filter(m => m.type === 'message' && m.content && !m.threadId);
        if (unthreaded.length > 0) {
          sections.push(
            `### Unthreaded messages in #${ch} (${unthreaded.length} msgs)\n` +
            unthreaded.slice(-15).map(m => `[${m.speaker}]: ${m.content.slice(0, 200)}`).join('\n')
          );
        }
      } else {
        // No threads — flat dump (legacy behavior)
        const msgs = allMsgs.filter(m => m.type === 'message' && m.content);
        if (msgs.length > 0) {
          sections.push(
            `### #${ch} (${msgs.length} messages, no threads)\n` +
            msgs.slice(-15).map(m => `[${m.speaker}]: ${m.content.slice(0, 200)}`).join('\n')
          );
        }
      }
    }

    if (sections.length === 0) {
      addMessage(projectId, channelId, 'System', 'No messages to summarize.', 'system', { userId });
      return;
    }

    const existingContext = stateManager.getProjectContext(projectId) || '';

    const prompt = `You are generating a cross-session context file for the project "${projectId}".
This file will be read by AI agents at the start of their next session to understand what happened previously.

The conversation is organized by THREADS (topic-grouped discussions). Preserve the thread structure in your summary.

Summarize into a structured context file. Be thorough but concise.
Preserve all key decisions, action items, technical details, and state.

Format:

## What Happened
Brief summary of what was discussed and accomplished.

## Active Threads
For each thread that was discussed:
### [Thread Name] (status)
- What was discussed
- Key decisions
- Current state
- Next steps

## Decisions Made
- Decision 1
- Decision 2

## Current State
What exists now — files created, services running, config changes, etc.

## Open Items / Next Steps
- What needs to happen next
- Any blockers or questions

## Key Technical Details
- File paths, commands, configurations
- Architecture decisions

---

${agendaManager.getSessionSummary(projectId) ? `AGENDA STATUS:\n${agendaManager.getSessionSummary(projectId)}\n\n---\n\n` : ''}${existingContext ? `PREVIOUS CONTEXT (update/merge, don't discard):\n${existingContext}\n\n---\n\n` : ''}CONVERSATION TO SUMMARIZE (organized by threads):

${sections.join('\n\n---\n\n')}

---

Write the context.md content now. This will be saved as-is.`;

    // Use the first available agent to generate the summary
    const allAgents = getAgents();
    const agentName = Object.keys(allAgents)[0];
    const agent = allAgents[agentName];
    if (!agent) {
      addMessage(projectId, channelId, 'System', 'No agents available to generate context.', 'system', { userId });
      return;
    }

    broadcastToChannel(projectId, channelId, { type: 'status', speaker: agentName, status: 'thinking' });

    try {
      const workingDir = stateManager.getProject(projectId)?.projectDir || PROJECT_DIR;
      const rawContext = await agent.send(prompt, workingDir);
      // Normalize ResponseObject → string. See orchestrator.js compaction
      // path and lifecycle.js:2046 for the same pattern. Without this the
      // saved project context for descriptor-backed agents would be
      // '[object Object]' instead of the model's actual summary text.
      const context = typeof rawContext === 'string' ? rawContext
        : (rawContext?.text != null ? String(rawContext.text) : String(rawContext ?? ''));
      if (context && context.length > 50) {
        stateManager.saveProjectContext(projectId, context);
        addMessage(projectId, channelId, 'System',
          `Session context saved for ${projectId} (${context.length} chars). Agents will see this next session.`, 'system', { userId });
        log.info('Session context saved', { projectId, chars: context.length, userId });
      }
    } catch (err) {
      log.error('Session end error', { error: err.message, userId });
      addMessage(projectId, channelId, 'System', `Failed to generate context: ${err.message}`, 'system', { userId });
    }

    broadcastToChannel(projectId, channelId, { type: 'status', speaker: agentName, status: 'passed' });
    events.emit('session:end', { projectId, channelId, topic, userId }).catch(() => {});
  }

  return { startSession, resumeSession, sessionStatus, endSession };
}
