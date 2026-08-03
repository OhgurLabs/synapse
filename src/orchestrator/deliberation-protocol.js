import { SharedStateStore, VersionConflictError } from './shared-state-store.js';

/**
 * Deliberation Protocol State Machine
 * 
 * ============================================================================
 *                      STATE TRANSITION DIAGRAM
 * ============================================================================
 * 
 *                              +---------+
 *                              |  INIT   |
 *                              +----+----+
 *                                   |
 *                                   | first PROPOSAL message submitted
 *                                   v
 *                          +---------+------+
 *                          |    PROPOSAL    |
 *                          +----+-----------+
 *                               |
 *                               | CHALLENGE message submitted
 *                               v
 *                          +---------+------+
 *                          |    CHALLENGE   |<------------------+
 *                          +----+-----------+                  |
 *                               |                               |
 *          +--------------------+-------------------------------+
 *          |                    |                               |
 *          | CHALLENGE          | SYNTHESIS (consensus          | COUNTER_ARGUMENT
 *          | (new challenge)    |  reached)                    | (response to challenge)
 *          |                    |                               |
 *          v                    v                               v
 *          +---------+      +---------+                   +---------+------+
 *          | CHALLENGE |<-----|SYNTHESIS|<------------------| COUNTER_ARGUMENT|
 *          +----+----+      +----+----+                   +--------+--------+
 *               |                |                               |
 *               | COMPLETE       | SYNTHESIS message             |
 *               | (finalization) | submitted                     |
 *               v                |                               |
 *          +---------+           |                               |
 *          | COMPLETE|<----------+                               |
 *          +---------+                                           |
 *                                                               |
 *                    +------------------+                        |
 *                    |    ERROR         |<-----------------------+
 *                    +------------------+
 *                    (timeout, invalid transition, conflict)
 * 
 * ============================================================================
 *                              STATE DEFINITIONS
 * ============================================================================
 * 
 * INIT: Initial state when deliberation session is created
 *       - Waiting for first PROPOSAL message
 *       - Only participant agents can submit messages
 * 
 * PROPOSAL: Initial deliberation state with a topic/idea proposed
 *       - Open to CHALLENGE messages from participants
 *       - Can transition to CHALLENGE when challenged
 *       - Can transition to SYNTHESIS if consensus reached immediately
 * 
 * CHALLENGE: A challenge has been raised to the current proposal
 *       - Requires COUNTER_ARGUMENT or SYNTHESIS response
 *       - Can loop back to CHALLENGE for new challenges
 *       - Can transition to SYNTHESIS if consensus reached
 * 
 * COUNTER_ARGUMENT: Response to a challenge has been submitted
 *       - Open to new CHALLENGE or SYNTHESIS
 *       - Allows iterative refinement of arguments
 *       - Can transition to SYNTHESIS when agreement reached
 * 
 * SYNTHESIS: Consensus/synthesis message proposed
 *       - Final substantive state before completion
 *       - Requires COMPLETE message to finalize
 *       - Indicates agreement among participants
 *
 * REVIEW_PENDING: Review requested, awaiting reviewer feedback
 *       - Entered via REVIEW_REQUEST
 *       - Transitions to REVIEWING/REVISING/COMPLETE based on REVIEW_FEEDBACK
 *
 * REVIEWING: Review feedback delivered, awaiting revisions or approval
 *       - Can transition back to REVIEW_PENDING for another review cycle
 *       - Can transition to REVISING or COMPLETE based on feedback
 *
 * REVISING: Author revising output after review feedback
 *       - Returns to REVIEW_PENDING on revised REVIEW_REQUEST
 * 
 * COMPLETE: Terminal state - deliberation successfully completed
 *       - No further transitions allowed
 *       - Final synthesis is preserved
 * 
 * ERROR: Terminal state - deliberation failed or timed out
 *       - No further transitions allowed
 *       - Indicates timeout, invalid operation, or conflict
 * 
 * ============================================================================
 *                         VALID TRANSITIONS & GUARDS
 * ============================================================================
 * 
 * INIT -> PROPOSAL
 *   Guard: First substantive message must be a PROPOSAL
 *   Trigger: submitMessage(PROPOSAL, payload, agentId)
 *   Condition: Session must have participants, agent must be participant
 * 
 * PROPOSAL -> CHALLENGE
 *   Guard: Current state must be PROPOSAL
 *   Trigger: submitMessage(CHALLENGE, payload, agentId)
 *   Condition: Agent must be participant, payload must contain challenge details
 * 
 * CHALLENGE -> COUNTER_ARGUMENT
 *   Guard: Current state must be CHALLENGE
 *   Trigger: submitMessage(COUNTER_ARGUMENT, payload, agentId)
 *   Condition: Agent must be participant, payload must contain counter-argument
 * 
 * COUNTER_ARGUMENT -> CHALLENGE
 *   Guard: Current state must be COUNTER_ARGUMENT
 *   Trigger: submitMessage(CHALLENGE, payload, agentId)
 *   Condition: New challenge to the counter-argument, agent must be participant
 * 
 * CHALLENGE -> SYNTHESIS
 *   Guard: Current state must be CHALLENGE
 *   Trigger: submitMessage(SYNTHESIS, payload, agentId)
 *   Condition: Participant agrees to move to synthesis despite challenge
 * 
 * COUNTER_ARGUMENT -> SYNTHESIS
 *   Guard: Current state must be COUNTER_ARGUMENT
 *   Trigger: submitMessage(SYNTHESIS, payload, agentId)
 *   Condition: Participant proposes synthesis after counter-argument
 * 
 * SYNTHESIS -> COMPLETE
 *   Guard: Current state must be SYNTHESIS
 *   Trigger: submitMessage(COMPLETE, payload, agentId)
 *   Condition: Finalization of synthesis, marks deliberation complete
 *
 * SYNTHESIS -> REVIEW_PENDING
 *   Guard: Current state must be SYNTHESIS
 *   Trigger: submitMessage(REVIEW_REQUEST, payload, agentId)
 *   Condition: Request review of synthesized output
 *
 * REVIEW_PENDING -> REVIEWING
 *   Guard: Current state must be REVIEW_PENDING
 *   Trigger: submitMessage(REVIEW_FEEDBACK, payload, agentId) with status 'commented'
 *   Condition: Review feedback provided with non-final status
 *
 * REVIEW_PENDING -> REVISING
 *   Guard: Current state must be REVIEW_PENDING
 *   Trigger: submitMessage(REVIEW_FEEDBACK, payload, agentId) with status 'rejected'
 *   Condition: Review feedback requires revisions
 *
 * REVIEW_PENDING -> COMPLETE
 *   Guard: Current state must be REVIEW_PENDING
 *   Trigger: submitMessage(REVIEW_FEEDBACK, payload, agentId) with status 'approved'
 *   Condition: Review approved, marks deliberation complete
 *
 * REVIEWING -> REVIEW_PENDING
 *   Guard: Current state must be REVIEWING
 *   Trigger: submitMessage(REVIEW_REQUEST, payload, agentId)
 *   Condition: Revised output submitted for another review cycle
 *
 * REVIEWING -> REVISING
 *   Guard: Current state must be REVIEWING
 *   Trigger: submitMessage(REVIEW_FEEDBACK, payload, agentId) with status 'rejected'
 *   Condition: Additional revisions required
 *
 * REVIEWING -> COMPLETE
 *   Guard: Current state must be REVIEWING
 *   Trigger: submitMessage(REVIEW_FEEDBACK, payload, agentId) with status 'approved'
 *   Condition: Review approved, marks deliberation complete
 *
 * REVISING -> REVIEW_PENDING
 *   Guard: Current state must be REVISING
 *   Trigger: submitMessage(REVIEW_REQUEST, payload, agentId)
 *   Condition: Revised output submitted for review
 * 
 * Any State -> ERROR
 *   Guard: Triggered by timeout or invalid operation
 *   Trigger: checkTimeout() or invalid submitMessage()
 *   Condition: Timeout exceeded or attempt to make invalid transition
 * 
 * ============================================================================
 *                              MESSAGE TYPES
 * ============================================================================
 * 
 * PROPOSAL: Initial topic or idea being deliberated
 *   payload: { content: string, context?: object }
 * 
 * CHALLENGE: Objection or question to the current state
 *   payload: { content: string, target: string, reasoning?: string }
 * 
 * COUNTER_ARGUMENT: Response to a challenge
 *   payload: { content: string, addresses: string[], reasoning?: string }
 * 
 * SYNTHESIS: Proposed agreement or conclusion
 *   payload: { content: string, summary: string, supportingArguments?: string[] }
 * 
 * REVIEW_REQUEST: Request review of a generated output
 *   payload: { output: any, criteria: string[], originalMessageId: string }
 * 
 * REVIEW_FEEDBACK: Structured critique of a reviewed output
 *   payload: { content: string, status: 'approved' | 'rejected' | 'commented', suggestedChanges?: object[], reviewRequestId: string }
 * 
 * COMPLETE: Finalization marker
 *   payload: { finalSummary: string, signatures?: string[] }
 * 
 * ============================================================================
 *                            TIMEOUT CONFIGURATION
 * ============================================================================
 * 
 * timeoutMs: Maximum time between messages (default: 300000ms = 5 minutes)
 *   - Session transitions to ERROR state when timeout exceeded
 *   - Timer resets with each message submission
 * 
 * consensusThreshold: Number of participants needed for consensus (default: all)
 *   - Used by detectConsensus() to determine agreement
 *   - Can be set lower than total participants for partial consensus
 * 
 * ============================================================================
 *                          API USAGE EXAMPLES
 * ============================================================================
 * 
 * // Create a new deliberation session
 * const protocol = new DeliberationProtocol(sharedStateStore);
 * const session = protocol.initSession(
 *   'session-001',
 *   ['agent-alice', 'agent-bob', 'agent-charlie'],
 *   'Should we adopt microservices architecture?',
 *   'agent-alice',
 *   { timeoutMs: 600000 } // 10 minute timeout
 * );
 * 
 * // Submit a proposal
 * const proposal = protocol.submitMessage(
 *   'session-001',
 *   MESSAGE_TYPES.PROPOSAL,
 *   { content: 'We should adopt microservices for better scalability' },
 *   'agent-alice'
 * );
 * 
 * // Submit a challenge
 * const challenge = protocol.submitMessage(
 *   'session-001',
 *   MESSAGE_TYPES.CHALLENGE,
 *   { content: 'What about increased operational complexity?', target: 'scalability' },
 *   'agent-bob'
 * );
 * 
 * // Submit counter-argument
 * const counter = protocol.submitMessage(
 *   'session-001',
 *   MESSAGE_TYPES.COUNTER_ARGUMENT,
 *   { content: 'We can use container orchestration to manage complexity', addresses: ['operational complexity'] },
 *   'agent-alice'
 * );
 * 
 * // Check current state
 * const state = protocol.getState('session-001');
 * console.log(state.status); // 'counter_argument'
 * 
 * // Check if complete
 * const complete = protocol.isComplete('session-001');
 * console.log(complete); // false
 * 
 * // Detect consensus
 * const consensus = protocol.detectConsensus('session-001');
 * console.log(consensus.hasConsensus); // true/false
 * 
 * // Check for timeout
 * const timeout = protocol.checkTimeout('session-001');
 * console.log(timeout.timedOut); // true/false
 * 
 * ============================================================================
 */

const DELIBERATION_STATES = {
  INIT: 'init',
  PROPOSAL: 'proposal',
  CHALLENGE: 'challenge',
  COUNTER_ARGUMENT: 'counter_argument',
  SYNTHESIS: 'synthesis',
  REVIEW_PENDING: 'review_pending',
  REVIEWING: 'reviewing',
  REVISING: 'revising',
  COMPLETE: 'complete',
  ERROR: 'error',
};

const VALID_TRANSITIONS = {
  [DELIBERATION_STATES.INIT]: [DELIBERATION_STATES.PROPOSAL, DELIBERATION_STATES.REVIEW_PENDING],
  [DELIBERATION_STATES.PROPOSAL]: [DELIBERATION_STATES.CHALLENGE],
  [DELIBERATION_STATES.CHALLENGE]: [DELIBERATION_STATES.COUNTER_ARGUMENT, DELIBERATION_STATES.SYNTHESIS],
  [DELIBERATION_STATES.COUNTER_ARGUMENT]: [DELIBERATION_STATES.CHALLENGE, DELIBERATION_STATES.SYNTHESIS],
  [DELIBERATION_STATES.SYNTHESIS]: [DELIBERATION_STATES.COMPLETE, DELIBERATION_STATES.REVIEW_PENDING],
  [DELIBERATION_STATES.REVIEW_PENDING]: [DELIBERATION_STATES.REVIEWING, DELIBERATION_STATES.REVISING, DELIBERATION_STATES.COMPLETE],
  [DELIBERATION_STATES.REVIEWING]: [DELIBERATION_STATES.REVIEW_PENDING, DELIBERATION_STATES.REVISING, DELIBERATION_STATES.COMPLETE],
  [DELIBERATION_STATES.REVISING]: [DELIBERATION_STATES.REVIEW_PENDING],
  [DELIBERATION_STATES.COMPLETE]: [],
  [DELIBERATION_STATES.ERROR]: [],
};

const MESSAGE_TYPES = {
  PROPOSAL: 'proposal',
  CHALLENGE: 'challenge',
  COUNTER_ARGUMENT: 'counter_argument',
  SYNTHESIS: 'synthesis',
  REVIEW_REQUEST: 'review_request',
  REVIEW_FEEDBACK: 'review_feedback',
  COMPLETE: 'complete',
};

class InvalidDeliberationStateError extends Error {
  constructor(sessionId, currentState, attemptedState, message = null) {
    const msg = message || `Invalid deliberation transition for "${sessionId}": cannot transition from "${currentState}" to "${attemptedState}"`;
    super(msg);
    this.name = 'InvalidDeliberationStateError';
    this.code = 'INVALID_DELIBERATION_STATE';
    this.sessionId = sessionId;
    this.currentState = currentState;
    this.attemptedState = attemptedState;
  }
}

class DeliberationSessionNotFoundError extends Error {
  constructor(sessionId) {
    super(`Deliberation session "${sessionId}" not found`);
    this.name = 'DeliberationSessionNotFoundError';
    this.sessionId = sessionId;
  }
}

class InvalidMessageTypeError extends Error {
  constructor(sessionId, messageType, currentStage, message = null) {
    const msg = message || `Invalid message type "${messageType}" for session "${sessionId}" in stage "${currentStage}"`;
    super(msg);
    this.name = 'InvalidMessageTypeError';
    this.code = 'INVALID_MESSAGE_TYPE';
    this.sessionId = sessionId;
    this.messageType = messageType;
    this.currentStage = currentStage;
  }
}

class NonParticipantError extends Error {
  constructor(agentId, sessionId) {
    super(`Agent "${agentId}" is not a participant in deliberation session "${sessionId}"`);
    this.name = 'NonParticipantError';
    this.code = 'NON_PARTICIPANT';
    this.agentId = agentId;
    this.sessionId = sessionId;
  }
}

/**
 * DeliberationProtocol - Orchestrates multi-agent deliberation sessions
 * 
 * This class implements a state machine for managing structured agent-to-agent
 * deliberation. It enforces protocol rules, tracks message history, detects
 * consensus, and handles timeout scenarios.
 * 
 * @example
 * const protocol = new DeliberationProtocol(sharedStateStore);
 * const session = protocol.initSession('session-1', ['agent-1', 'agent-2'], 'Topic', 'agent-1');
 * protocol.submitMessage('session-1', MESSAGE_TYPES.PROPOSAL, { content: '...' }, 'agent-1');
 */
class DeliberationProtocol {
  /**
   * Creates a new DeliberationProtocol instance
   * @param {SharedStateStore} sharedStateStore - The shared state store for persistence
   * @param {Object} [options] - Configuration options
   * @param {AuditLogger} [options.auditLogger] - Optional audit logger for deliberation events
   * @param {EventEmitter} [options.events] - Optional EventEmitter for timeline integration
   */
  constructor(sharedStateStore, options = {}) {
    /** @private */
    this.store = sharedStateStore;
    /** @private */
    this.auditLogger = options.auditLogger || null;
    /** @private */
    this.events = options.events || null;
  }

  /**
   * Generates the Redis-style key for a deliberation session
   * @param {string} sessionId - Unique identifier for the session
   * @returns {string} The store key in format 'deliberation:{sessionId}'
   * @private
   */
  _getSessionKey(sessionId) {
    return `deliberation:${sessionId}`;
  }

  _createInitialState(sessionData) {
    const now = new Date().toISOString();
    return {
      sessionId: sessionData.sessionId,
      topic: sessionData.topic,
      initiatorAgentId: sessionData.initiatorAgentId,
      participantAgentIds: sessionData.participantAgentIds,
      status: DELIBERATION_STATES.INIT,
      messageHistory: [
        {
          type: 'session_initiated',
          payload: { topic: sessionData.topic },
          agentId: sessionData.initiatorAgentId,
          timestamp: now,
          version: 0,
        },
      ],
      currentTurn: 0,
      lastMessageAt: now,
      timeoutMs: sessionData.timeoutMs ?? 300000, // 5 minutes default
      consensusThreshold: sessionData.consensusThreshold ?? sessionData.participantAgentIds.length,
      minMessages: sessionData.minMessages ?? null,
      projectId: sessionData.projectId ?? null,
      stateHistory: [
        {
          state: DELIBERATION_STATES.INIT,
          timestamp: now,
          version: 0,
          actorId: sessionData.initiatorAgentId,
        },
      ],
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  _validateTransition(sessionId, currentState, nextState) {
    const allowedNextStates = VALID_TRANSITIONS[currentState];
    if (!allowedNextStates || !allowedNextStates.includes(nextState)) {
      throw new InvalidDeliberationStateError(
        sessionId,
        currentState,
        nextState,
        `State machine for deliberation session "${sessionId}" does not allow transition from "${currentState}" to "${nextState}". Allowed transitions: ${allowedNextStates ? allowedNextStates.join(', ') : 'none (terminal state)'}`
      );
    }
  }

  _getNextStateForMessage(messageType, payload) {
    const typeMapping = {
      [MESSAGE_TYPES.PROPOSAL]: DELIBERATION_STATES.PROPOSAL,
      [MESSAGE_TYPES.CHALLENGE]: DELIBERATION_STATES.CHALLENGE,
      [MESSAGE_TYPES.COUNTER_ARGUMENT]: DELIBERATION_STATES.COUNTER_ARGUMENT,
      [MESSAGE_TYPES.SYNTHESIS]: DELIBERATION_STATES.SYNTHESIS,
      [MESSAGE_TYPES.COMPLETE]: DELIBERATION_STATES.COMPLETE,
    };
    if (messageType === MESSAGE_TYPES.REVIEW_REQUEST) {
      return DELIBERATION_STATES.REVIEW_PENDING;
    }
    if (messageType === MESSAGE_TYPES.REVIEW_FEEDBACK) {
      const status = payload?.status;
      if (status === 'approved') {
        return DELIBERATION_STATES.COMPLETE;
      }
      if (status === 'rejected') {
        return DELIBERATION_STATES.REVISING;
      }
      return DELIBERATION_STATES.REVIEWING;
    }
    return typeMapping[messageType];
  }

  _getMessageTypeFromState(state) {
    const stateMapping = {
      [DELIBERATION_STATES.PROPOSAL]: MESSAGE_TYPES.PROPOSAL,
      [DELIBERATION_STATES.CHALLENGE]: MESSAGE_TYPES.CHALLENGE,
      [DELIBERATION_STATES.COUNTER_ARGUMENT]: MESSAGE_TYPES.COUNTER_ARGUMENT,
      [DELIBERATION_STATES.SYNTHESIS]: MESSAGE_TYPES.SYNTHESIS,
      [DELIBERATION_STATES.REVIEW_PENDING]: MESSAGE_TYPES.REVIEW_REQUEST,
      [DELIBERATION_STATES.REVIEWING]: MESSAGE_TYPES.REVIEW_FEEDBACK,
      [DELIBERATION_STATES.REVISING]: MESSAGE_TYPES.REVIEW_REQUEST,
      [DELIBERATION_STATES.COMPLETE]: MESSAGE_TYPES.COMPLETE,
    };
    return stateMapping[state];
  }

  /**
   * Score proposal candidates based on observed challenges and supports.
   * - Challenges against a proposal reduce its score.
   * - Concessions inside counter-arguments count as support (evidence a challenge was addressed).
   * - When a challenge/counter-argument does not explicitly reference a proposal, the most recent
   *   prior proposal is used as the target.
   *
   * @param {Array<Object>} messages - Full message history for the session
   * @param {string[]} participantAgentIds - Agent IDs allowed to propose
   * @returns {Array<Object>} Sorted candidates with scores
   *          [{ proposalIndex, agentId, content, challengeCount, supportCount, score }]
   * @private
   */
  _scoreCandidates(messages, participantAgentIds = []) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return [];
    }

    // Collect proposals in chronological order
    const proposals = messages
      .map((msg, idx) => ({ ...msg, messageIndex: idx }))
      .filter(msg => msg.type === MESSAGE_TYPES.PROPOSAL)
      .filter(msg =>
        !Array.isArray(participantAgentIds) || participantAgentIds.length === 0
          ? true
          : participantAgentIds.includes(msg.agentId)
      )
      .map((msg, proposalIdx) => ({
        proposalIndex: proposalIdx,
        agentId: msg.agentId,
        content: msg.payload?.content ?? '',
        messageIndex: msg.messageIndex,
        challengeCount: 0,
        supportCount: 0,
        score: 0,
      }));

    if (proposals.length === 0) {
      return [];
    }

    const findByContent = (needle) => {
      if (!needle) return null;
      const lower = needle.toLowerCase();
      return proposals.find(p => (p.content || '').toLowerCase().includes(lower)) || null;
    };

    const mostRecentBefore = (messageIndex) => {
      const prior = proposals
        .filter(p => p.messageIndex <= messageIndex)
        .sort((a, b) => b.messageIndex - a.messageIndex)[0];
      return prior || null;
    };

    // Tally challenges as negative signals
    messages.forEach((msg, idx) => {
      if (msg.type !== MESSAGE_TYPES.CHALLENGE) return;

      const target = msg.payload?.target || msg.payload?.content;
      const targetProposal = findByContent(target) || mostRecentBefore(idx);

      if (targetProposal) {
        targetProposal.challengeCount += 1;
      }
    });

    // Tally concessions in counter-arguments as support signals
    messages.forEach((msg, idx) => {
      if (msg.type !== MESSAGE_TYPES.COUNTER_ARGUMENT) return;

      const concessions = Array.isArray(msg.payload?.concessions)
        ? msg.payload.concessions.length
        : 0;
      if (concessions === 0) return;

      const addresses = msg.payload?.addresses;
      let targetProposal = null;
      if (Array.isArray(addresses) && addresses.length) {
        for (const addr of addresses) {
          targetProposal = findByContent(addr);
          if (targetProposal) break;
        }
      }

      if (!targetProposal) {
        targetProposal = mostRecentBefore(idx);
      }

      if (targetProposal) {
        targetProposal.supportCount += concessions;
      }
    });

    // Compute final score and drop internal fields
    const scored = proposals.map(p => ({
      proposalIndex: p.proposalIndex,
      agentId: p.agentId,
      content: p.content,
      challengeCount: p.challengeCount,
      supportCount: p.supportCount,
      score: p.supportCount - p.challengeCount,
    }));

    return scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.proposalIndex - b.proposalIndex; // stable by submission order
    });
  }

  /**
   * Aggregates supportingArguments, tradeoffs, and nextActions from SYNTHESIS
   * and COUNTER_ARGUMENT messages, deduplicating by string equality.
   * @param {Array} messages - The messageHistory array from a session
   * @returns {{ supportingArguments: string[], tradeoffs: string[], nextActions: string[] }}
   * @private
   */
  _aggregateArguments(messages) {
    const supportingSet = new Set();
    const tradeoffsSet = new Set();
    const nextActionsSet = new Set();

    if (!Array.isArray(messages)) {
      return { supportingArguments: [], tradeoffs: [], nextActions: [] };
    }

    for (const msg of messages) {
      if (msg.type !== MESSAGE_TYPES.SYNTHESIS && msg.type !== MESSAGE_TYPES.COUNTER_ARGUMENT) {
        continue;
      }
      const p = msg.payload;
      if (!p) continue;

      if (Array.isArray(p.supportingArguments)) {
        for (const arg of p.supportingArguments) supportingSet.add(arg);
      }
      if (Array.isArray(p.tradeoffs)) {
        for (const t of p.tradeoffs) tradeoffsSet.add(t);
      }
      if (Array.isArray(p.nextActions)) {
        for (const a of p.nextActions) nextActionsSet.add(a);
      }
    }

    return {
      supportingArguments: [...supportingSet],
      tradeoffs: [...tradeoffsSet],
      nextActions: [...nextActionsSet],
    };
  }

  _appendMessageHistory(sessionRecord, messageType, payload, agentId, version) {
    const timestamp = new Date().toISOString();
    
    return {
      ...sessionRecord,
      messageHistory: [
        ...sessionRecord.messageHistory,
        {
          type: messageType,
          payload,
          agentId,
          timestamp,
          version,
        },
      ],
      currentTurn: sessionRecord.currentTurn + 1,
      lastMessageAt: timestamp,
      version,
      updatedAt: timestamp,
    };
  }

  _appendStateHistory(sessionRecord, nextState, actorId, version) {
    const timestamp = new Date().toISOString();
    
    return {
      ...sessionRecord,
      status: nextState,
      stateHistory: [
        ...sessionRecord.stateHistory,
        {
          state: nextState,
          timestamp,
          version,
          actorId,
        },
      ],
      version,
      updatedAt: timestamp,
    };
  }

  initSession(sessionId, participantAgentIds, topic, initiatorAgentId, config = {}) {
    const { timeoutMs, consensusThreshold, minMessages, projectId } = config;
    const stateKey = this._getSessionKey(sessionId);

    const initialState = this._createInitialState({
      sessionId,
      participantAgentIds,
      topic,
      initiatorAgentId,
      timeoutMs,
      consensusThreshold,
      minMessages,
      projectId,
    });

    const newVersion = this.store.set(stateKey, JSON.stringify(initialState), initiatorAgentId);

    // Emit session_initiated event for timeline integration
    if (this.events) {
      this.events.emit('deliberation:session_initiated', {
        sessionId,
        topic,
        initiatorAgentId,
        participantAgentIds,
        timestamp: initialState.createdAt,
        projectId,
      });
    }

    return {
      sessionId,
      status: DELIBERATION_STATES.INIT,
      version: newVersion,
    };
  }

  submitMessage(sessionId, messageType, payload, agentId) {
    const stateKey = this._getSessionKey(sessionId);
    
    const current = this.store.get(stateKey);
    if (!current) {
      throw new DeliberationSessionNotFoundError(sessionId);
    }

    const sessionRecord = JSON.parse(current.value);

    // Verify agent is a participant
    if (!sessionRecord.participantAgentIds.includes(agentId)) {
      throw new NonParticipantError(agentId, sessionId);
    }

    // Determine expected state based on message type
    const nextState = this._getNextStateForMessage(messageType, payload);
    if (!nextState) {
      throw new InvalidMessageTypeError(sessionId, messageType, sessionRecord.status);
    }

    // Validate state transition
    this._validateTransition(sessionId, sessionRecord.status, nextState);

    // Append message and update state
    const updatedRecord = this._appendMessageHistory(sessionRecord, messageType, payload, agentId, current.version);
    const updatedRecordWithState = this._appendStateHistory(updatedRecord, nextState, agentId, updatedRecord.version);

    const storeVersion = this.store.set(stateKey, JSON.stringify(updatedRecordWithState), agentId, current.version);

    // Emit appropriate events for timeline integration
    if (this.events) {
      const timestamp = updatedRecordWithState.lastMessageAt;
      const baseEventData = {
        sessionId,
        agentId,
        timestamp,
        messageType,
        payload,
        currentState: nextState,
        projectId: sessionRecord.projectId,
      };

      // Emit general argument_submitted event for substantive messages
      if ([MESSAGE_TYPES.PROPOSAL, MESSAGE_TYPES.COUNTER_ARGUMENT, MESSAGE_TYPES.CHALLENGE, MESSAGE_TYPES.SYNTHESIS].includes(messageType)) {
        this.events.emit('deliberation:argument_submitted', baseEventData);
      }

      // Emit specific events based on message type
      if (messageType === MESSAGE_TYPES.CHALLENGE) {
        this.events.emit('deliberation:challenge_raised', {
          ...baseEventData,
          target: payload?.target,
          reasoning: payload?.reasoning,
        });
      } else if (messageType === MESSAGE_TYPES.SYNTHESIS) {
        this.events.emit('deliberation:synthesis_produced', {
          ...baseEventData,
          summary: payload?.summary,
          supportingArguments: payload?.supportingArguments,
        });
      } else if (messageType === MESSAGE_TYPES.REVIEW_REQUEST && sessionRecord.status === DELIBERATION_STATES.REVISING) {
        // Revision completed when submitting review request from REVISING state
        this.events.emit('deliberation:revision_completed', {
          ...baseEventData,
          output: payload?.output,
          criteria: payload?.criteria,
        });
      }
    }

    return {
      sessionId,
      status: nextState,
      version: storeVersion,
      message: {
        type: messageType,
        payload,
        agentId,
        timestamp: updatedRecordWithState.lastMessageAt,
      },
    };
  }

  getState(sessionId) {
    const stateKey = this._getSessionKey(sessionId);
    const current = this.store.get(stateKey);
    
    if (!current) {
      return null;
    }

    return JSON.parse(current.value);
  }

  isComplete(sessionId) {
    const state = this.getState(sessionId);
    if (!state) {
      return false;
    }

    const isTerminalState = state.status === DELIBERATION_STATES.COMPLETE || state.status === DELIBERATION_STATES.ERROR;

    if (state.minMessages !== null && state.minMessages !== undefined) {
      // If minMessages is configured, it must also be satisfied
      const messagesCount = state.messageHistory ? state.messageHistory.length : 0;
      return isTerminalState && (messagesCount >= state.minMessages);
    }

    // If no minMessages is configured, only the terminal state is required
    return isTerminalState;
  }

  checkTimeout(sessionId) {
    const stateKey = this._getSessionKey(sessionId);
    const current = this.store.get(stateKey);
    
    if (!current) {
      throw new DeliberationSessionNotFoundError(sessionId);
    }

    const sessionRecord = JSON.parse(current.value);

    if (sessionRecord.status === DELIBERATION_STATES.COMPLETE || sessionRecord.status === DELIBERATION_STATES.ERROR) {
      return { timedOut: false, reason: 'Session already in terminal state' };
    }

    const lastMessageTime = new Date(sessionRecord.lastMessageAt).getTime();
    const currentTime = Date.now();
    const timeoutMs = sessionRecord.timeoutMs;

    if (currentTime - lastMessageTime > timeoutMs) {
      // Transition to ERROR state
      const updatedRecord = this._appendStateHistory(
        sessionRecord,
        DELIBERATION_STATES.ERROR,
        'system',
        current.version
      );

      this.store.set(stateKey, JSON.stringify(updatedRecord), 'system', current.version);

      // Emit session_timeout event for timeline integration
      if (this.events) {
        this.events.emit('deliberation:session_timeout', {
          sessionId,
          timeoutMs,
          lastMessageAt: sessionRecord.lastMessageAt,
          timestamp: updatedRecord.updatedAt,
          projectId: sessionRecord.projectId,
          participantAgentIds: sessionRecord.participantAgentIds,
        });
      }

      return {
        timedOut: true,
        sessionId,
        reason: `Timeout exceeded (${timeoutMs}ms) since last message at ${sessionRecord.lastMessageAt}`,
      };
    }

    return { timedOut: false, remainingTime: timeoutMs - (currentTime - lastMessageTime) };
  }

  detectConsensus(sessionId) {
    const state = this.getState(sessionId);
    if (!state) {
      throw new DeliberationSessionNotFoundError(sessionId);
    }

    const { participantAgentIds, messageHistory, consensusThreshold } = state;
    const totalParticipants = participantAgentIds.length;

    // Get unique agents who have submitted synthesis messages
    const synthesisSubmissions = messageHistory.filter(m => m.type === MESSAGE_TYPES.SYNTHESIS);
    const uniqueSynthesisAgents = [...new Set(synthesisSubmissions.map(s => s.agentId))];

    // Check if all participants have submitted synthesis
    const allParticipantsSubmitted = participantAgentIds.every(
      agentId => uniqueSynthesisAgents.includes(agentId)
    );

    // Check for recent challenges (last 3 messages)
    const recentMessages = messageHistory.slice(-3);
    const recentChallenges = recentMessages.filter(m => m.type === MESSAGE_TYPES.CHALLENGE);

    // Check if counter-arguments have been addressed (no new challenges after counter-arguments)
    let challengesAddressed = true;
    for (let i = recentMessages.length - 1; i >= 0; i--) {
      if (recentMessages[i].type === MESSAGE_TYPES.COUNTER_ARGUMENT) {
        break;
      }
      if (recentMessages[i].type === MESSAGE_TYPES.CHALLENGE) {
        challengesAddressed = false;
        break;
      }
    }

    const hasConsensus = allParticipantsSubmitted && recentChallenges.length === 0;

    return {
      hasConsensus,
      reason: hasConsensus
        ? `All ${totalParticipants} participants have submitted synthesis; no recent challenges`
        : `Consensus not reached: ${uniqueSynthesisAgents.length}/${totalParticipants} participants submitted synthesis, ${recentChallenges.length} recent challenges`,
      synthesisCount: uniqueSynthesisAgents.length,
      totalParticipants,
      recentChallenges: recentChallenges.length,
    };
  }

  /**
   * Produce a synthesized payload from the current message history.
   * This does not submit a message; callers can decide whether to submit.
   *
   * @param {string} sessionId - Deliberation session identifier
   * @param {{strategy?: 'majority_vote'|'aggregation'}} [options] - Synthesis options
   * @returns {{
   *   content: string,
   *   summary: string,
   *   supportingArguments?: string[],
   *   tradeoffs?: string[],
   *   nextActions?: string[],
   *   strategyUsed: string,
   *   confidence: number
   * }}
   */
  synthesizeArguments(sessionId, options = {}) {
    const state = this.getState(sessionId);
    if (!state) {
      throw new DeliberationSessionNotFoundError(sessionId);
    }

    const { messageHistory, participantAgentIds, topic } = state;
    const history = Array.isArray(messageHistory) ? messageHistory : [];
    const requestedStrategy = options.strategy || 'majority_vote';
    const strategy =
      requestedStrategy === 'aggregation' || requestedStrategy === 'majority_vote'
        ? requestedStrategy
        : 'majority_vote';

    const summarize = (text, maxLen = 180) => {
      if (!text || typeof text !== 'string') return '';
      const trimmed = text.trim();
      if (trimmed.length <= maxLen) return trimmed;
      return `${trimmed.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
    };

    const fallbackContent = () => {
      if (topic && String(topic).trim().length) {
        return `Synthesis for topic: ${String(topic).trim()}`;
      }
      return 'Synthesis pending: no proposals available.';
    };

    const aggregated = this._aggregateArguments(history);

    if (strategy === 'aggregation') {
      const candidates = this._scoreCandidates(history, participantAgentIds);
      const top = candidates[0];

      const content = top?.content && String(top.content).trim().length
        ? String(top.content).trim()
        : fallbackContent();
      const summary =
        aggregated.supportingArguments.length ||
        aggregated.tradeoffs.length ||
        aggregated.nextActions.length
          ? `Aggregated inputs: ${aggregated.supportingArguments.length} supporting arguments, ${aggregated.tradeoffs.length} tradeoffs, ${aggregated.nextActions.length} next actions.`
          : summarize(content) || 'Aggregated inputs from participants.';

      return {
        content,
        summary,
        supportingArguments: aggregated.supportingArguments,
        tradeoffs: aggregated.tradeoffs,
        nextActions: aggregated.nextActions,
        strategyUsed: strategy,
        confidence: 0.45,
      };
    }

    const candidates = this._scoreCandidates(history, participantAgentIds);
    const winner = candidates[0];
    const content = winner?.content && String(winner.content).trim().length
      ? String(winner.content).trim()
      : fallbackContent();
    const summary = summarize(content) || fallbackContent();

    const support = winner?.supportCount ?? 0;
    const challenge = winner?.challengeCount ?? 0;
    const confidence = Math.max(
      0.2,
      Math.min(0.9, (support + 1) / (support + challenge + 2))
    );

    return {
      content,
      summary,
      supportingArguments: aggregated.supportingArguments,
      tradeoffs: aggregated.tradeoffs,
      nextActions: aggregated.nextActions,
      strategyUsed: strategy,
      confidence,
    };
  }

  getTransitionGraph() {
    return VALID_TRANSITIONS;
  }

  getStates() {
    return DELIBERATION_STATES;
  }
}

export {
  DeliberationProtocol,
  DELIBERATION_STATES,
  VALID_TRANSITIONS,
  MESSAGE_TYPES,
  InvalidDeliberationStateError,
  DeliberationSessionNotFoundError,
  InvalidMessageTypeError,
  NonParticipantError,
};
