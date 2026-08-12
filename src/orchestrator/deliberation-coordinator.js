/**
 * DeliberationCoordinator — Higher-level session manager for multi-agent deliberation.
 *
 * Sits above DeliberationProtocol and provides:
 *  - Task-scoped session creation (taskId → sessionId mapping)
 *  - Coordinator-level session state (participants, phase, argument history, termination conditions)
 *  - Phase transition management via onMessageSubmitted()
 *  - Pub/sub event emission for UI and audit trail
 *
 * Key patterns:
 *  - Coordinator records stored at 'deliberation_session:{taskId}'
 *  - Reverse index stored at 'deliberation_session_id:{sessionId}' → taskId
 *  - Protocol sessions stored at 'deliberation:{sessionId}' (managed by DeliberationProtocol)
 *
 * Events emitted (on the EventEmitter passed to constructor):
 *  - deliberation:session_created   { sessionId, taskId, participants, topic, phase }
 *  - deliberation:phase_changed     { sessionId, taskId, previousPhase, currentPhase, agentId }
 *  - deliberation:message_added     { sessionId, taskId, messageType, agentId, payload, phase }
 *  - deliberation:session_completed { sessionId, taskId, finalPhase, participants }
 */

import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';
import {
  DeliberationProtocol,
  DELIBERATION_STATES,
  MESSAGE_TYPES,
  DeliberationSessionNotFoundError,
} from './deliberation-protocol.js';
import { OperatorAuditStore } from '../operator-audit-store.js';

const log = createLogger('deliberation-coordinator');

// ── key helpers ──────────────────────────────────────────────────────────────

function sessionKey(taskId) {
  return `deliberation_session:${taskId}`;
}

function sessionIdIndexKey(sessionId) {
  return `deliberation_session_id:${sessionId}`;
}

function inboxKey(sessionId) {
  return `deliberation_inbox:${sessionId}`;
}

// ── exported error classes ───────────────────────────────────────────────────

export class CoordinatorSessionNotFoundError extends Error {
  constructor(ref) {
    super(`Deliberation coordinator session not found: "${ref}"`);
    this.name = 'CoordinatorSessionNotFoundError';
    this.ref = ref;
  }
}

export class CoordinatorSessionAlreadyExistsError extends Error {
  constructor(taskId) {
    super(`Deliberation session already exists for task "${taskId}"`);
    this.name = 'CoordinatorSessionAlreadyExistsError';
    this.taskId = taskId;
  }
}

// ── coordinator ──────────────────────────────────────────────────────────────

/**
 * DeliberationCoordinator manages deliberation sessions at the task level.
 *
 * @example
 * const coordinator = new DeliberationCoordinator(sharedStateStore, eventEmitter);
 * const { sessionId } = coordinator.initSession('task-123', ['agent-a', 'agent-b'], 'Arch decision');
 * coordinator.onMessageSubmitted(sessionId, 'proposal', { content: '...' }, 'agent-a');
 */
export class DeliberationCoordinator {
  /**
   * @param {import('./shared-state-store.js').SharedStateStore} store
   * @param {import('events').EventEmitter} events
   * @param {Object} [options]
   * @param {OperatorAuditStore} [options.auditStore] - Optional audit store for persisting deliberation events
   * @param {string} [options.projectId] - Project ID for audit entries (defaults to 'default')
   */
  constructor(store, events, options = {}) {
    this.store = store;
    this.events = events;
    this.auditStore = options.auditStore || null;
    this.projectId = options.projectId || 'default';
    // Pass events through so protocol-level emissions (argument_submitted,
    // challenge_raised, synthesis_produced) fire for coordinator-driven
    // sessions too — previously only the orchestrator's standalone protocol
    // instance was events-wired.
    this.protocol = new DeliberationProtocol(store, { events });
  }

  // ── session lifecycle ──────────────────────────────────────────────────────

  /**
   * Initialize a new deliberation session for a task.
   *
   * Creates the underlying protocol session and stores coordinator metadata.
   * Throws if a session already exists for this taskId.
   *
   * @param {string}   taskId              - Unique task identifier
   * @param {string[]} participantAgentIds - Agents participating in the deliberation
   * @param {string}   topic               - The question or decision being deliberated
   * @param {Object}   [config]
   * @param {string}   [config.sessionId]          - Override generated sessionId
   * @param {string}   [config.initiatorAgentId]   - Agent initiating the session (defaults to first participant)
   * @param {number}   [config.timeoutMs]          - Per-message timeout (default: 300000ms)
   * @param {number}   [config.maxTurns]           - Max argument turns (default: 20)
   * @param {number}   [config.consensusThreshold] - Participants needed for consensus (default: all)
   * @returns {{ sessionId, taskId, status, version }}
   * @throws {CoordinatorSessionAlreadyExistsError}
   */
  initSession(taskId, participantAgentIds, topic, config = {}) {
    if (!taskId) throw new TypeError('taskId is required');
    if (!Array.isArray(participantAgentIds) || participantAgentIds.length === 0) {
      throw new TypeError('participantAgentIds must be a non-empty array');
    }
    if (!topic) throw new TypeError('topic is required');

    // Reject duplicate sessions for the same task
    const existing = this.store.get(sessionKey(taskId));
    if (existing) {
      throw new CoordinatorSessionAlreadyExistsError(taskId);
    }

    const sessionId = config.sessionId || `dsession_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const initiatorAgentId = config.initiatorAgentId || participantAgentIds[0];
    const now = new Date().toISOString();

    // Initialize the protocol-level session
    const protocolResult = this.protocol.initSession(
      sessionId,
      participantAgentIds,
      topic,
      initiatorAgentId,
      {
        timeoutMs: config.timeoutMs,
        consensusThreshold: config.consensusThreshold,
        minMessages: config.minMessages,
        projectId: config.projectId,
      }
    );

    // Store coordinator record (keyed by taskId)
    const coordinatorRecord = {
      sessionId,
      taskId,
      topic,
      participants: participantAgentIds,
      initiatorAgentId,
      currentPhase: DELIBERATION_STATES.INIT,
      argumentHistory: [],
      terminationConditions: {
        maxTurns: config.maxTurns ?? 20,
        consensusThreshold: config.consensusThreshold ?? participantAgentIds.length,
        timeoutMs: config.timeoutMs ?? 300000,
        minMessages: config.minMessages ?? null,
      },
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    this.store.set(sessionKey(taskId), coordinatorRecord, initiatorAgentId);

    // Store reverse index: sessionId → taskId
    this.store.set(sessionIdIndexKey(sessionId), { taskId }, initiatorAgentId);

    // Emit creation event
    this._emit('deliberation:session_created', {
      sessionId,
      taskId,
      participants: participantAgentIds,
      topic,
      phase: DELIBERATION_STATES.INIT,
    });

    // Emit audit event for session creation
    this._emitAuditEvent(
      'deliberation_request',
      sessionId,
      taskId,
      initiatorAgentId,
      { topic, participants: participantAgentIds },
      null,
      { phase: DELIBERATION_STATES.INIT, participants: participantAgentIds }
    );

    log.info({ sessionId, taskId, participants: participantAgentIds.length }, 'deliberation session created');

    return {
      sessionId,
      taskId,
      status: DELIBERATION_STATES.INIT,
      version: protocolResult.version,
    };
  }

  /**
   * Retrieve the full protocol-level session state by sessionId.
   *
   * Returns the DeliberationProtocol state object (includes messageHistory,
   * stateHistory, currentTurn, etc.) or null if not found.
   *
   * @param {string} sessionId
   * @returns {Object|null}
   */
  getSessionState(sessionId) {
    return this.protocol.getState(sessionId);
  }

  /**
   * Get the current deliberation phase and turn information.
   *
   * Returns a summary of the current state including the phase, current turn
   * number, and which agents have participated so far.
   *
   * @param {string} sessionId
   * @returns {{ phase: string, currentTurn: number, participantCount: number, lastActor: string|null, messageCount: number }}
   * @throws {CoordinatorSessionNotFoundError}
   */
  getDeliberationStatus(sessionId) {
    const indexEntry = this.store.get(sessionIdIndexKey(sessionId));
    if (!indexEntry) {
      throw new CoordinatorSessionNotFoundError(sessionId);
    }

    const protocolState = this.protocol.getState(sessionId);
    if (!protocolState) {
      throw new CoordinatorSessionNotFoundError(sessionId);
    }

    const messageHistory = protocolState.messageHistory || [];
    const lastMessage = messageHistory[messageHistory.length - 1];

    return {
      phase: protocolState.status,
      currentTurn: protocolState.currentTurn || 0,
      participantCount: protocolState.participantAgentIds?.length || 0,
      lastActor: lastMessage?.agentId || null,
      messageCount: messageHistory.length,
      topic: protocolState.topic,
      isComplete: protocolState.status === DELIBERATION_STATES.COMPLETE ||
        protocolState.status === DELIBERATION_STATES.ERROR,
    };
  }

  /**
   * Retrieve coordinator metadata for a session by taskId.
   *
   * Returns the coordinator record (participants, currentPhase, argumentHistory,
   * terminationConditions) or null if no session exists for this task.
   *
   * @param {string} taskId
   * @returns {Object|null}
   */
  getSessionByTaskId(taskId) {
    const entry = this.store.get(sessionKey(taskId));
    if (!entry) return null;
    return entry.value;
  }

  /**
   * Synthesize final output from deliberation session.
   *
   * Uses DeliberationProtocol.synthesizeArguments to produce a synthesized
   * payload from the message history. This can be called when a cycle completes
   * to generate a consensus output without requiring a COMPLETE message.
   *
   * @param {string} sessionId
   * @param {Object} [options]
   * @param {'majority_vote'|'aggregation'} [options.strategy='majority_vote'] - Synthesis strategy
   * @returns {{
   *   content: string,
   *   summary: string,
   *   supportingArguments?: string[],
   *   tradeoffs?: string[],
   *   nextActions?: string[],
   *   strategyUsed: string,
   *   confidence: number
   * }}
   * @throws {CoordinatorSessionNotFoundError}
   * @throws {DeliberationSessionNotFoundError}
   */
  synthesizeOutput(sessionId, options = {}) {
    const { strategy = 'majority_vote' } = options;

    // Ensure session exists
    const indexEntry = this.store.get(sessionIdIndexKey(sessionId));
    if (!indexEntry) {
      throw new CoordinatorSessionNotFoundError(sessionId);
    }

    // Delegate to protocol for synthesis
    return this.protocol.synthesizeArguments(sessionId, { strategy });
  }

  /**
   * Close (terminate) a deliberation session.
   *
   * Looks up taskId via reverse index, marks the coordinator record as closed,
   * and emits a session_completed event. Does NOT force-transition the protocol
   * to COMPLETE — callers should submit a COMPLETE message via onMessageSubmitted
   * if a graceful protocol close is required.
   *
   * @param {string} sessionId
   * @returns {{ sessionId, taskId, closedAt }}
   * @throws {CoordinatorSessionNotFoundError}
   */
  closeSession(sessionId) {
    // Resolve taskId from reverse index
    const indexEntry = this.store.get(sessionIdIndexKey(sessionId));
    if (!indexEntry) {
      throw new CoordinatorSessionNotFoundError(sessionId);
    }

    const { taskId } = indexEntry.value;
    const coordEntry = this.store.get(sessionKey(taskId));
    if (!coordEntry) {
      throw new CoordinatorSessionNotFoundError(sessionId);
    }

    const now = new Date().toISOString();
    const updatedRecord = {
      ...coordEntry.value,
      status: 'closed',
      closedAt: now,
      updatedAt: now,
    };

    this.store.set(sessionKey(taskId), updatedRecord, 'coordinator');

    const finalPhase = updatedRecord.currentPhase;

    this._emit('deliberation:session_completed', {
      sessionId,
      taskId,
      finalPhase,
      participants: updatedRecord.participants,
    });

    log.info({ sessionId, taskId, finalPhase }, 'deliberation session closed');

    return { sessionId, taskId, closedAt: now };
  }

  // ── phase / message handling ───────────────────────────────────────────────

  /**
   * Progress one deliberation cycle by consuming queued agent messages.
   *
   * The coordinator polls an inbound message queue (either supplied directly
   * via options.messages or stored at deliberation_inbox:{sessionId}) and
   * routes each message through DeliberationProtocol.submitMessage().
   *
   * Cycle completion heuristic: we consider a cycle complete when the
   * state machine reaches SYNTHESIS or COMPLETE. Callers can override this
   * with `options.cycleCompletionStates`.
   *
   * @param {string} sessionId
   * @param {Object} [options]
   * @param {Array<Object>} [options.messages] - Pre-fetched messages to process
   * @param {number} [options.maxMessages=10] - Safety cap per invocation
   * @param {boolean} [options.consumeQueue=true] - Remove processed messages from the inbox key
   * @param {string[]} [options.cycleCompletionStates] - Custom completion states
   * @param {boolean} [options.checkTimeout=false] - Check for session timeout
   * @returns {Promise<{ sessionId: string, processed: number, phase: string|null, cycleComplete: boolean, consensus?: Object, timeout?: Object }>} 
   */
  async progressCycle(sessionId, options = {}) {
    const {
      messages: suppliedMessages,
      maxMessages = 10,
      consumeQueue = true,
      cycleCompletionStates = [DELIBERATION_STATES.SYNTHESIS, DELIBERATION_STATES.COMPLETE],
      checkTimeout = false,
    } = options;

    // Ensure session exists by resolving taskId; throws if missing
    const indexEntry = this.store.get(sessionIdIndexKey(sessionId));
    if (!indexEntry) {
      throw new CoordinatorSessionNotFoundError(sessionId);
    }

    // Fetch inbox messages (if not explicitly supplied)
    let inbox = suppliedMessages;
    let inboxSource = 'supplied';
    if (!Array.isArray(inbox)) {
      const inboxEntry = this.store.get(inboxKey(sessionId));
      inbox = Array.isArray(inboxEntry?.value) ? [...inboxEntry.value] : [];
      inboxSource = 'store';
    }

    if (!Array.isArray(inbox) || inbox.length === 0) {
      return { sessionId, processed: 0, phase: this.protocol.getState(sessionId)?.status ?? null, cycleComplete: false };
    }

    const toProcess = inbox.slice(0, maxMessages);
    const remaining = inbox.slice(toProcess.length);

    let lastPhase = this.protocol.getState(sessionId)?.status ?? null;
    let cycleComplete = false;
    let consensus = null;
    let timeout = null;
    let processed = 0;
    let examined = 0;

    for (const msg of toProcess) {
      examined += 1;
      const messageType = msg.messageType || msg.type;
      const payload = msg.payload ?? {};
      const agentId = msg.agentId || msg.senderId || msg.from;

      if (!messageType || !agentId) {
        log.warn({ sessionId, messageType, agentId }, 'skipping malformed deliberation message');
        continue;
      }

      const result = this.onMessageSubmitted(sessionId, messageType, payload, agentId);
      processed += 1;
      lastPhase = result.phase;

      // Detect consensus when synthesis reached
      if (result.phase === DELIBERATION_STATES.SYNTHESIS) {
        try {
          consensus = this.protocol.detectConsensus(sessionId);
        } catch (err) {
          log.warn({ sessionId, err: err.message }, 'consensus detection failed');
        }
      }

      // Check for timeout if enabled
      if (checkTimeout) {
        try {
          timeout = this.protocol.checkTimeout(sessionId);
          if (timeout.timedOut) {
            log.info({ sessionId, reason: timeout.reason }, 'deliberation session timed out');
            lastPhase = DELIBERATION_STATES.ERROR;
            cycleComplete = true;
            break;
          }
        } catch (err) {
          log.warn({ sessionId, err: err.message }, 'timeout check failed');
        }
      }

      if (cycleCompletionStates.includes(result.phase)) {
        cycleComplete = true;
        break;
      }
    }

    // Persist remaining inbox messages if we read from store and consumption enabled
    if (inboxSource === 'store' && consumeQueue) {
      // A cycle can finish before the maxMessages slice is exhausted. Preserve
      // every message we did not examine instead of dropping the rest of the
      // slice along with the messages that were consumed.
      const unexamined = toProcess.slice(examined).concat(remaining);
      this.store.set(inboxKey(sessionId), unexamined, 'coordinator');
    }

    return {
      sessionId,
      processed,
      phase: lastPhase,
      cycleComplete,
      consensus,
      timeout,
    };
  }

  /**
   * Poll for new messages from agents in the deliberation inbox.
   *
   * Retrieves messages from the deliberation_inbox:{sessionId} key and returns
   * them in chronological order. This method is useful for implementing
   * agent polling patterns where the coordinator actively checks for new
   * agent contributions.
   *
   * @param {string} sessionId
   * @param {Object} [options]
   * @param {number} [options.limit=100] - Maximum number of messages to retrieve
   * @param {boolean} [options.peek=true] - If true, do not remove messages from inbox
   * @returns {Array<{ messageType, payload, agentId, timestamp }>} Array of messages
   * @throws {CoordinatorSessionNotFoundError}
   */
  pollForMessages(sessionId, options = {}) {
    const { limit = 100, peek = true } = options;

    // Ensure session exists
    const indexEntry = this.store.get(sessionIdIndexKey(sessionId));
    if (!indexEntry) {
      throw new CoordinatorSessionNotFoundError(sessionId);
    }

    // Fetch messages from inbox
    const inboxEntry = this.store.get(inboxKey(sessionId));
    const messages = Array.isArray(inboxEntry?.value) ? [...inboxEntry.value] : [];

    // Return limited copy (peek mode) or slice for consumption
    const limited = messages.slice(0, limit);
    
    if (!peek && limited.length > 0) {
      // Remove consumed messages from inbox
      const remaining = messages.slice(limit);
      this.store.set(inboxKey(sessionId), remaining, 'coordinator');
    }

    return limited;
  }

  /**
   * Submit a message to the deliberation inbox for processing.
   *
   * This method allows agents or external systems to queue messages for
   * deliberation without directly invoking onMessageSubmitted. The messages
   * will be processed when progressCycle() is called.
   *
   * @param {string} sessionId
   * @param {string} messageType - One of MESSAGE_TYPES values
   * @param {Object} payload - Message payload
   * @param {string} agentId - ID of the agent submitting the message
   * @param {Object} [options]
   * @param {string} [options.inboxKey] - Custom inbox key (default: deliberation_inbox:{sessionId})
   * @returns {{ sessionId, messageId, queuedAt }}
   * @throws {CoordinatorSessionNotFoundError}
   */
  queueMessage(sessionId, messageType, payload, agentId, options = {}) {
    const { inboxKey: customInboxKey } = options;
    const inbox = customInboxKey || inboxKey(sessionId);

    // Ensure session exists
    const indexEntry = this.store.get(sessionIdIndexKey(sessionId));
    if (!indexEntry) {
      throw new CoordinatorSessionNotFoundError(sessionId);
    }

    const now = new Date().toISOString();
    const message = {
      messageType,
      payload: payload || {},
      agentId,
      timestamp: now,
      messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    };

    // Get existing inbox and append new message
    const inboxEntry = this.store.get(inbox);
    const existingMessages = Array.isArray(inboxEntry?.value) ? [...inboxEntry.value] : [];
    const updatedMessages = [...existingMessages, message];

    this.store.set(inbox, updatedMessages, agentId);

    log.debug({ sessionId, messageId: message.messageId, messageType, agentId }, 'message queued for deliberation');

    return {
      sessionId,
      messageId: message.messageId,
      queuedAt: now,
    };
  }

  /**
   * Process an incoming message from an agent, updating coordinator state.
   *
   * Delegates to DeliberationProtocol.submitMessage for validation and state
   * machine transitions, then syncs the coordinator record with the new phase
   * and appends to argumentHistory.
   *
   * Emits deliberation:message_added and deliberation:phase_changed events.
   *
   * @param {string} sessionId
   * @param {string} messageType - One of MESSAGE_TYPES values
   * @param {Object} payload
   * @param {string} agentId
   * @returns {{ sessionId, taskId, phase, version, message }}
   * @throws {CoordinatorSessionNotFoundError}
   * @throws {DeliberationSessionNotFoundError} (from protocol)
   */
  onMessageSubmitted(sessionId, messageType, payload, agentId) {
    // Resolve taskId
    const indexEntry = this.store.get(sessionIdIndexKey(sessionId));
    if (!indexEntry) {
      throw new CoordinatorSessionNotFoundError(sessionId);
    }
    const { taskId } = indexEntry.value;

    // Delegate to protocol (handles validation + state transitions)
    const protocolResult = this.protocol.submitMessage(sessionId, messageType, payload, agentId);

    // Sync coordinator record
    const coordEntry = this.store.get(sessionKey(taskId));
    if (!coordEntry) {
      throw new CoordinatorSessionNotFoundError(sessionId);
    }

    const previousPhase = coordEntry.value.currentPhase;
    const currentPhase = protocolResult.status;
    const now = new Date().toISOString();

    const historyEntry = {
      messageType,
      payload,
      agentId,
      phase: currentPhase,
      timestamp: now,
    };

    const updatedRecord = {
      ...coordEntry.value,
      currentPhase,
      argumentHistory: [...coordEntry.value.argumentHistory, historyEntry],
      updatedAt: now,
    };

    this.store.set(sessionKey(taskId), updatedRecord, agentId);

    // Emit message event
    this._emit('deliberation:message_added', {
      sessionId,
      taskId,
      messageType,
      agentId,
      payload,
      phase: currentPhase,
    });

    // Emit specific event for timeline integration based on message type
    this._emitDeliberationEvent(messageType, {
      sessionId,
      taskId,
      agentId,
      payload,
      phase: currentPhase,
    });

    // Emit phase change if it changed
    if (previousPhase !== currentPhase) {
      this._emit('deliberation:phase_changed', {
        sessionId,
        taskId,
        previousPhase,
        currentPhase,
        agentId,
      });
      log.info({ sessionId, taskId, previousPhase, currentPhase, agentId }, 'deliberation phase changed');
    }

    // Emit audit event for the message type
    const auditAction = this._mapMessageTypeToAuditAction(messageType);
    this._emitAuditEvent(
      auditAction,
      sessionId,
      taskId,
      agentId,
      { messageType, payload },
      { phase: previousPhase, turn: protocolResult.currentTurn - 1 },
      { phase: currentPhase, turn: protocolResult.currentTurn }
    );

    // Auto-close if terminal state
    const isTerminal = currentPhase === DELIBERATION_STATES.COMPLETE ||
      currentPhase === DELIBERATION_STATES.ERROR;
    if (isTerminal && updatedRecord.status !== 'closed') {
      this.closeSession(sessionId);
    }

    return {
      sessionId,
      taskId,
      phase: currentPhase,
      version: protocolResult.version,
      message: protocolResult.message,
    };
  }

  // ── private helpers ────────────────────────────────────────────────────────

  _emit(event, payload) {
    try {
      if (typeof this.events.emit === 'function') {
        this.events.emit(event, payload);
      }
    } catch (err) {
      log.warn({ event, err: err.message }, 'coordinator event emit failed');
    }
  }

  _emitDeliberationEvent(messageType, context) {
    const { sessionId, taskId, agentId, payload, phase } = context;
    const timestamp = new Date().toISOString();

    let eventName;
    let eventPayload;

    switch (messageType) {
      case MESSAGE_TYPES.PROPOSAL:
      case MESSAGE_TYPES.COUNTER_ARGUMENT:
        eventName = 'deliberation:argument_submitted';
        eventPayload = {
          timestamp,
          sessionId,
          taskId,
          agentId,
          argumentContent: payload.content || payload.argument || '',
          phase,
        };
        break;

      case MESSAGE_TYPES.CHALLENGE:
        eventName = 'deliberation:challenge_raised';
        eventPayload = {
          timestamp,
          sessionId,
          taskId,
          agentId,
          challengeReason: payload.reason || payload.challenge || '',
          targetArgumentId: payload.targetArgumentId || null,
          phase,
        };
        break;

      case MESSAGE_TYPES.SYNTHESIS:
        eventName = 'deliberation:synthesis_produced';
        eventPayload = {
          timestamp,
          sessionId,
          taskId,
          agentId,
          synthesisContent: payload.content || payload.synthesis || '',
          phase,
        };
        break;

      case MESSAGE_TYPES.REVIEW_REQUEST:
        eventName = 'deliberation:review_requested';
        eventPayload = {
          timestamp,
          sessionId,
          taskId,
          agentId,
          requesterId: payload.requesterId || agentId,
          primaryAgentId: payload.primaryAgentId || agentId,
          reviewerId: payload.reviewerId || payload.reviewer || 'unknown',
          argumentContent: payload.content || payload.requestText || payload.argumentContent || '',
          taskCategory: payload.taskCategory || null,
          iterationCount: payload.iterationCount || 0,
          phase,
          payload,
        };
        break;

      case MESSAGE_TYPES.REVIEW_FEEDBACK:
        eventName = 'deliberation:feedback_received';
        eventPayload = {
          timestamp,
          sessionId,
          taskId,
          agentId,
          reviewerId: payload.reviewerId || agentId,
          status: payload.status || 'unknown',
          feedbackSummary: payload.feedbackSummary || payload.feedbackContent || payload.feedbackText || payload.feedback || '',
          iterationCount: payload.iterationCount || 0,
          findingsCount: payload.findingsCount || 0,
          phase,
          payload,
        };
        break;

      case MESSAGE_TYPES.REVISION:
      case MESSAGE_TYPES.COMPLETE:
        eventName = 'deliberation:revision_completed';
        eventPayload = {
          timestamp,
          sessionId,
          taskId,
          agentId,
          revisedContent: payload.content || payload.revision || '',
          phase,
        };
        break;

      default:
        return;
    }

    this._emit(eventName, eventPayload);
  }

  _emitAuditEvent(actionType, sessionId, taskId, agentId, payload, beforeState, afterState) {
    if (!this.auditStore) return;

    const auditEntry = {
      projectId: this.projectId,
      timestamp: new Date().toISOString(),
      actorId: agentId,
      actionType,
      target: sessionId,
      correlationId: `deliberation:${sessionId}`,
      source: 'deliberation-coordinator',
      reason: payload.reason || null,
      beforeState,
      afterState,
      payload: {
        taskId,
        sessionId,
        ...payload,
      },
    };

    try {
      this.auditStore.append(auditEntry);
    } catch (err) {
      log.warn({ sessionId, actionType, err: err.message }, 'audit event write failed');
    }
  }

  _mapMessageTypeToAuditAction(messageType) {
    const mapping = {
      [MESSAGE_TYPES.PROPOSAL]: 'argument_submitted',
      [MESSAGE_TYPES.CHALLENGE]: 'challenge_raised',
      [MESSAGE_TYPES.COUNTER_ARGUMENT]: 'argument_submitted',
      [MESSAGE_TYPES.SYNTHESIS]: 'synthesis_produced',
      [MESSAGE_TYPES.REVIEW_REQUEST]: 'deliberation_request',
      [MESSAGE_TYPES.FEEDBACK]: 'deliberation_feedback',
      [MESSAGE_TYPES.REVISION]: 'revision_completed',
      [MESSAGE_TYPES.COMPLETE]: 'revision_completed',
    };
    return mapping[messageType] || 'deliberation_message';
  }
}

export { DELIBERATION_STATES, MESSAGE_TYPES, DeliberationSessionNotFoundError };
