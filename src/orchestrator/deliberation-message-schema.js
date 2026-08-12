/**
 * Deliberation Message Schema & Type Definitions
 *
 * Defines strongly-typed message schemas for the deliberation protocol.
 * All messages follow a common envelope structure with primitive-specific payloads.
 *
 * Message Envelope Structure:
 *   {
 *     messageType: string,      // Type of deliberation primitive
 *     version: string,          // Schema version for evolution
 *     senderId: string,         // Agent ID sending the message
 *     recipientId: string|null, // Target agent ID (null = broadcast)
 *     threadId: string,         // Deliberation session/thread identifier
 *     timestamp: string,        // ISO 8601 UTC timestamp
 *     payload: object,          // Primitive-specific content
 *     metadata: object          // Optional metadata for tracing/routing
 *   }
 *
 * Deliberation Flow (four primitives in order):
 *
 *   1. PROPOSAL  — Agent A opens the deliberation by stating a position with evidence.
 *   2. CHALLENGE — Agent B critiques a specific aspect of that position.
 *   3. COUNTER_ARGUMENT — Agent A rebuts the challenge, possibly conceding minor points.
 *   4. SYNTHESIS — Either agent (or a moderator) closes the thread with the final consensus.
 *
 * Quick-start example (all four types, same thread):
 *
 *   import {
 *     createProposal, createChallenge, createCounterArgument, createSynthesis,
 *     validateDeliberationMessage, EXAMPLES,
 *   } from './deliberation-message-schema.js';
 *
 *   const THREAD = 'delib-session-abc123';
 *
 *   // 1. Proposal
 *   const proposal = createProposal('agent-alice', THREAD,
 *     'Adopt microservices architecture for the new platform',
 *     { context: { rationale: 'Current monolith limits deployment velocity' } });
 *
 *   // 2. Challenge
 *   const challenge = createChallenge('agent-bob', THREAD,
 *     'Microservices will significantly increase operational complexity',
 *     'operational feasibility',
 *     { recipientId: 'agent-alice', concerns: ['No service mesh in place'] });
 *
 *   // 3. Counter-argument
 *   const counter = createCounterArgument('agent-alice', THREAD,
 *     'Phased rollout and tooling investment mitigate that risk',
 *     ['operational feasibility'],
 *     { recipientId: 'agent-bob', concessions: ['Short-term burden is real'] });
 *
 *   // 4. Synthesis
 *   const synthesis = createSynthesis('agent-bob', THREAD,
 *     'Adopt microservices with phased migration and platform investment',
 *     'Approved with risk mitigation',
 *     { nextActions: ['Deploy service mesh by Q2', 'Run pilot with 2 services'] });
 *
 *   // Validate any message
 *   const { valid, errors } = validateDeliberationMessage(proposal);
 *
 *   // Access pre-built examples
 *   console.log(EXAMPLES.PROPOSAL);      // complete example object
 *   console.log(EXAMPLES.CHALLENGE);
 *   console.log(EXAMPLES.COUNTER_ARGUMENT);
 *   console.log(EXAMPLES.SYNTHESIS);
 *
 * Version History:
 *   1.0.0 - Initial deliberation message schema with four primitives
 */

/** Current schema version */
export const SCHEMA_VERSION = '1.0.0';

/**
 * Message type constants for deliberation primitives
 * @enum {string}
 */
export const MESSAGE_TYPES = {
  PROPOSAL: 'proposal',
  CHALLENGE: 'challenge',
  COUNTER_ARGUMENT: 'counter_argument',
  SYNTHESIS: 'synthesis',
  REVIEW_REQUEST: 'review_request',
  REVIEW_FEEDBACK: 'review_feedback',
};

/**
 * Set of valid message types for fast membership checks
 */
export const VALID_MESSAGE_TYPES = new Set(Object.values(MESSAGE_TYPES));

// ============================================================================
//                         JSDOC TYPE DEFINITIONS
// ============================================================================

/**
 * Common message envelope fields present in all deliberation messages
 *
 * @typedef {Object} MessageEnvelope
 * @property {string} messageType - Type of deliberation primitive (proposal, challenge, etc.)
 * @property {string} version - Schema version string (e.g., "1.0.0")
 * @property {string} senderId - Agent ID of the sender
 * @property {string|null} recipientId - Target agent ID, or null for broadcast to all participants
 * @property {string} threadId - Deliberation session/thread identifier
 * @property {string} timestamp - ISO 8601 UTC timestamp when message was created
 * @property {Object} payload - Message type-specific content
 * @property {Object} [metadata] - Optional metadata for tracing, correlation, priority
 */

/**
 * Metadata bag for message routing, tracing, and correlation
 *
 * @typedef {Object} MessageMetadata
 * @property {string} [traceId] - Distributed trace ID for cross-agent correlation
 * @property {string} [campaignId] - Campaign identifier if part of a campaign task
 * @property {string} [dispatchId] - Dispatch decision ID if routed through orchestrator
 * @property {string} [priority] - Message priority: 'low', 'normal', 'high'
 * @property {number} [retryCount] - Number of delivery retry attempts (default: 0)
 * @property {number} [expiresAt] - Unix timestamp when message expires (optional TTL)
 */

/**
 * PROPOSAL payload - initial claim or idea with supporting evidence
 *
 * @typedef {Object} ProposalPayload
 * @property {string} content - The main proposal content (claim, idea, or position)
 * @property {Object} [context] - Optional context or supporting evidence
 * @property {string} [context.rationale] - Why this proposal is being made
 * @property {string[]} [context.evidence] - Supporting evidence or references
 * @property {string[]} [context.assumptions] - Key assumptions underlying the proposal
 */

/**
 * CHALLENGE payload - counter-claim or critique of current position
 *
 * @typedef {Object} ChallengePayload
 * @property {string} content - The main challenge content (objection or question)
 * @property {string} target - What aspect is being challenged (e.g., 'scalability', 'cost')
 * @property {string} [reasoning] - Explanation or rationale for the challenge
 * @property {string[]} [concerns] - Specific concerns or risks being raised
 */

/**
 * COUNTER_ARGUMENT payload - rebuttal with evidence addressing challenges
 *
 * @typedef {Object} CounterArgumentPayload
 * @property {string} content - The main counter-argument content (rebuttal)
 * @property {string[]} addresses - Array of challenge points being addressed
 * @property {string} [reasoning] - Explanation supporting the counter-argument
 * @property {string[]} [evidence] - Supporting evidence for the rebuttal
 * @property {string[]} [concessions] - Points where challenger's concerns are acknowledged
 */

/**
 * SYNTHESIS payload - final consensus with aggregated rationale
 *
 * @typedef {Object} SynthesisPayload
 * @property {string} content - The full synthesis content (final consensus position)
 * @property {string} summary - Brief summary of the consensus reached
 * @property {string[]} [supportingArguments] - Key arguments supporting the synthesis
 * @property {string[]} [tradeoffs] - Acknowledged trade-offs in the consensus
 * @property {string[]} [nextActions] - Proposed follow-up actions or decisions
 */

/**
 * REVIEW_REQUEST payload - request for review of a generated output
 *
 * @typedef {Object} ReviewRequestPayload
 * @property {any} output - The output to be reviewed (e.g., code, text, architectural diagram)
 * @property {string[]} criteria - Evaluation criteria for the reviewer
 * @property {string} originalMessageId - The ID of the message that produced the output
 */

/**
 * REVIEW_FEEDBACK payload - structured critique of a reviewed output
 *
 * @typedef {Object} ReviewFeedbackPayload
 * @property {string} content - The main feedback content (summary of critique)
 * @property {'approved' | 'rejected' | 'commented'} status - The outcome of the review
 * @property {Object[]} [suggestedChanges] - Specific, actionable changes
 * @property {string} reviewRequestId - The ID of the review request being addressed
 */

/**
 * Complete PROPOSAL message with envelope
 *
 * @typedef {Object} ProposalMessage
 * @property {string} messageType - Always MESSAGE_TYPES.PROPOSAL
 * @property {string} version - Schema version
 * @property {string} senderId - Agent ID sending the proposal
 * @property {string|null} recipientId - Target agent or null for broadcast
 * @property {string} threadId - Deliberation session identifier
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {ProposalPayload} payload - Proposal-specific content
 * @property {MessageMetadata} [metadata] - Optional metadata
 */

/**
 * Complete CHALLENGE message with envelope
 *
 * @typedef {Object} ChallengeMessage
 * @property {string} messageType - Always MESSAGE_TYPES.CHALLENGE
 * @property {string} version - Schema version
 * @property {string} senderId - Agent ID sending the challenge
 * @property {string|null} recipientId - Target agent or null for broadcast
 * @property {string} threadId - Deliberation session identifier
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {ChallengePayload} payload - Challenge-specific content
 * @property {MessageMetadata} [metadata] - Optional metadata
 */

/**
 * Complete COUNTER_ARGUMENT message with envelope
 *
 * @typedef {Object} CounterArgumentMessage
 * @property {string} messageType - Always MESSAGE_TYPES.COUNTER_ARGUMENT
 * @property {string} version - Schema version
 * @property {string} senderId - Agent ID sending the counter-argument
 * @property {string|null} recipientId - Target agent or null for broadcast
 * @property {string} threadId - Deliberation session identifier
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {CounterArgumentPayload} payload - Counter-argument-specific content
 * @property {MessageMetadata} [metadata] - Optional metadata
 */

/**
 * Complete SYNTHESIS message with envelope
 *
 * @typedef {Object} SynthesisMessage
 * @property {string} messageType - Always MESSAGE_TYPES.SYNTHESIS
 * @property {string} version - Schema version
 * @property {string} senderId - Agent ID sending the synthesis
 * @property {string|null} recipientId - Target agent or null for broadcast
 * @property {string} threadId - Deliberation session identifier
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {SynthesisPayload} payload - Synthesis-specific content
 * @property {MessageMetadata} [metadata] - Optional metadata
 */

/**
 * Complete REVIEW_REQUEST message with envelope
 *
 * @typedef {Object} ReviewRequestMessage
 * @property {string} messageType - Always MESSAGE_TYPES.REVIEW_REQUEST
 * @property {string} version - Schema version
 * @property {string} senderId - Agent ID sending the request
 * @property {string} recipientId - Agent ID of the designated reviewer
 * @property {string} threadId - Deliberation session identifier
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {ReviewRequestPayload} payload - Review request specific content
 * @property {MessageMetadata} [metadata] - Optional metadata
 */

/**
 * Complete REVIEW_FEEDBACK message with envelope
 *
 * @typedef {Object} ReviewFeedbackMessage
 * @property {string} messageType - Always MESSAGE_TYPES.REVIEW_FEEDBACK
 * @property {string} version - Schema version
 * @property {string} senderId - Agent ID sending the feedback
 * @property {string} recipientId - Agent ID of the original author
 * @property {string} threadId - Deliberation session identifier
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {ReviewFeedbackPayload} payload - Review feedback specific content
 * @property {MessageMetadata} [metadata] - Optional metadata
 */

// ============================================================================
//                           SCHEMA DEFINITIONS
// ============================================================================

/**
 * Schema definition for PROPOSAL messages
 *
 * Initial claim or idea with supporting evidence. Starts the deliberation
 * process by establishing a position to be examined.
 */
export const PROPOSAL_SCHEMA = {
  messageType: MESSAGE_TYPES.PROPOSAL,
  version: SCHEMA_VERSION,
  description: 'Initial claim or idea with supporting evidence',
  envelope: {
    required: ['messageType', 'version', 'senderId', 'recipientId', 'threadId', 'timestamp', 'payload'],
    optional: ['metadata'],
  },
  payload: {
    required: ['content'],
    optional: ['context'],
  },
  example: {
    messageType: MESSAGE_TYPES.PROPOSAL,
    version: SCHEMA_VERSION,
    senderId: 'agent-alice',
    recipientId: null,
    threadId: 'delib-session-abc123',
    timestamp: '2026-03-20T10:00:00.000Z',
    payload: {
      content: 'We should adopt microservices architecture for the new platform',
      context: {
        rationale: 'Current monolith limits team autonomy and deployment velocity',
        evidence: [
          'Deploy frequency down 40% over last 6 months',
          'Team survey shows coordination overhead as top friction',
        ],
        assumptions: [
          'Teams have capacity to manage distributed systems',
          'Infrastructure supports container orchestration',
        ],
      },
    },
    metadata: {
      traceId: 'trace-xyz789',
      campaignId: 'campaign-arch-decision',
      priority: 'high',
    },
  },
};

/**
 * Schema definition for CHALLENGE messages
 *
 * Counter-claim or critique targeting a specific aspect of the current
 * position. Drives critical examination of proposals.
 */
export const CHALLENGE_SCHEMA = {
  messageType: MESSAGE_TYPES.CHALLENGE,
  version: SCHEMA_VERSION,
  description: 'Counter-claim or critique of current position',
  envelope: {
    required: ['messageType', 'version', 'senderId', 'recipientId', 'threadId', 'timestamp', 'payload'],
    optional: ['metadata'],
  },
  payload: {
    required: ['content', 'target'],
    optional: ['reasoning', 'concerns'],
  },
  example: {
    messageType: MESSAGE_TYPES.CHALLENGE,
    version: SCHEMA_VERSION,
    senderId: 'agent-bob',
    recipientId: 'agent-alice',
    threadId: 'delib-session-abc123',
    timestamp: '2026-03-20T10:05:00.000Z',
    payload: {
      content: 'Microservices will significantly increase operational complexity',
      target: 'operational feasibility',
      reasoning: 'Team lacks distributed systems experience and monitoring tooling',
      concerns: [
        'No service mesh or observability platform in place',
        'On-call burden will increase with service sprawl',
        'Network latency and partial failure handling not addressed',
      ],
    },
    metadata: {
      traceId: 'trace-xyz789',
      campaignId: 'campaign-arch-decision',
      priority: 'high',
    },
  },
};

/**
 * Schema definition for COUNTER_ARGUMENT messages
 *
 * Rebuttal with evidence addressing specific challenges. Refines the
 * proposal by directly responding to concerns.
 */
export const COUNTER_ARGUMENT_SCHEMA = {
  messageType: MESSAGE_TYPES.COUNTER_ARGUMENT,
  version: SCHEMA_VERSION,
  description: 'Rebuttal with evidence addressing challenges',
  envelope: {
    required: ['messageType', 'version', 'senderId', 'recipientId', 'threadId', 'timestamp', 'payload'],
    optional: ['metadata'],
  },
  payload: {
    required: ['content', 'addresses'],
    optional: ['reasoning', 'evidence', 'concessions'],
  },
  example: {
    messageType: MESSAGE_TYPES.COUNTER_ARGUMENT,
    version: SCHEMA_VERSION,
    senderId: 'agent-alice',
    recipientId: 'agent-bob',
    threadId: 'delib-session-abc123',
    timestamp: '2026-03-20T10:10:00.000Z',
    payload: {
      content: 'We can mitigate operational complexity with phased rollout and tooling investment',
      addresses: [
        'operational feasibility',
        'monitoring tooling gaps',
        'service mesh requirements',
      ],
      reasoning: 'Complexity is manageable with proper planning and investment',
      evidence: [
        'Platform team committed to deploying service mesh in Q2',
        'Observability RFP approved, vendor selection in progress',
        'Phased migration plan limits blast radius to 2 services initially',
      ],
      concessions: [
        'Acknowledge increased operational burden in short term',
        'Will require dedicated platform engineering investment',
      ],
    },
    metadata: {
      traceId: 'trace-xyz789',
      campaignId: 'campaign-arch-decision',
      priority: 'high',
    },
  },
};

/**
 * Schema definition for SYNTHESIS messages
 *
 * Final consensus with aggregated rationale incorporating all perspectives.
 * Represents agreement reached after deliberation.
 */
export const SYNTHESIS_SCHEMA = {
  messageType: MESSAGE_TYPES.SYNTHESIS,
  version: SCHEMA_VERSION,
  description: 'Final consensus with aggregated rationale',
  envelope: {
    required: ['messageType', 'version', 'senderId', 'recipientId', 'threadId', 'timestamp', 'payload'],
    optional: ['metadata'],
  },
  payload: {
    required: ['content', 'summary'],
    optional: ['supportingArguments', 'tradeoffs', 'nextActions'],
  },
  example: {
    messageType: MESSAGE_TYPES.SYNTHESIS,
    version: SCHEMA_VERSION,
    senderId: 'agent-bob',
    recipientId: null,
    threadId: 'delib-session-abc123',
    timestamp: '2026-03-20T10:15:00.000Z',
    payload: {
      content: 'Adopt microservices architecture with phased migration and platform investment',
      summary: 'Microservices approved with risk mitigation through tooling and gradual rollout',
      supportingArguments: [
        'Addresses deployment velocity and team autonomy goals',
        'Operational risks mitigated through platform engineering investment',
        'Phased approach limits initial blast radius',
      ],
      tradeoffs: [
        'Higher operational complexity in exchange for deployment flexibility',
        'Upfront investment in service mesh and observability required',
        'Short-term velocity decrease during migration period',
      ],
      nextActions: [
        'Platform team to deploy service mesh by end of Q2',
        'Complete observability vendor selection by April 15',
        'Identify initial 2 services for migration pilot',
        'Develop service migration playbook and training materials',
      ],
    },
    metadata: {
      traceId: 'trace-xyz789',
      campaignId: 'campaign-arch-decision',
      priority: 'high',
    },
  },
};

// ============================================================================
//                    REVIEW_REQUEST / REVIEW_FEEDBACK
// ============================================================================
//
// These two were REFERENCED by SCHEMA_REGISTRY below but never declared, so
// importing this module threw "ReferenceError: REVIEW_REQUEST_SCHEMA is not
// defined" at module scope. That made the module, and everything importing it
// (socratic-state-machine.js), unloadable — and it truncated the mocha stage
// until the runner quarantined four test files to get past it.
//
// Left over from the REVIEW_* subsystem that shipped at 0/3 subtasks (#43).
//
// The required/optional sets are taken from the payloads production ACTUALLY
// sends, not invented:
//   REVIEW_REQUEST   lifecycle.js:2998 and :3975
//   REVIEW_FEEDBACK  lifecycle.js:2507 and :2612, plus the protocol's own
//                    submitMessage in the review-and-revise path
// Nothing validates against SCHEMA_REGISTRY at runtime — it is documentation
// and test-facing — so these describe the wire format rather than enforcing it.

export const REVIEW_REQUEST_SCHEMA = {
  messageType: MESSAGE_TYPES.REVIEW_REQUEST,
  version: SCHEMA_VERSION,
  description: 'Request review of a generated output against stated criteria',
  envelope: {
    required: ['messageType', 'version', 'senderId', 'recipientId', 'threadId', 'timestamp', 'payload'],
    optional: ['metadata'],
  },
  payload: {
    required: ['output', 'criteria', 'originalMessageId'],
    optional: ['outputDetails'],
  },
  example: {
    messageType: MESSAGE_TYPES.REVIEW_REQUEST,
    version: SCHEMA_VERSION,
    senderId: 'agent-architect',
    recipientId: 'agent-senior',
    threadId: 'delib-session-abc123',
    timestamp: '2026-03-20T10:05:00.000Z',
    payload: {
      output: 'Revision v2',
      outputDetails: 'diff --git a/src/retry.js b/src/retry.js\n+ jitter applied to backoff',
      criteria: ['correctness', 'tests'],
      originalMessageId: 'task-1773220445626',
    },
    metadata: {
      traceId: 'trace-xyz789',
      campaignId: 'campaign-arch-decision',
      iterationCount: 2,
    },
  },
};

export const REVIEW_FEEDBACK_SCHEMA = {
  messageType: MESSAGE_TYPES.REVIEW_FEEDBACK,
  version: SCHEMA_VERSION,
  description: 'Reviewer verdict on a REVIEW_REQUEST, with findings',
  envelope: {
    required: ['messageType', 'version', 'senderId', 'recipientId', 'threadId', 'timestamp', 'payload'],
    optional: ['metadata'],
  },
  payload: {
    // status drives the state machine: approved ends the cycle, rejected
    // returns to revision, max_iterations_reached stops it on the budget.
    required: ['status', 'findings', 'summary'],
    optional: ['content', 'reviewRequestId'],
  },
  example: {
    messageType: MESSAGE_TYPES.REVIEW_FEEDBACK,
    version: SCHEMA_VERSION,
    senderId: 'agent-senior',
    recipientId: 'agent-architect',
    threadId: 'delib-session-abc123',
    timestamp: '2026-03-20T10:10:00.000Z',
    payload: {
      status: 'rejected',
      findings: [
        { severity: 'high', issue: 'Missing dead letter queue' },
        { severity: 'medium', issue: 'No event versioning strategy' },
      ],
      summary: 'Two blocking issues before this can be approved',
      reviewRequestId: 'review-iter-1',
    },
    metadata: {
      traceId: 'trace-xyz789',
      iterationCount: 1,
    },
  },
};

// ============================================================================
//                           SCHEMA REGISTRY
// ============================================================================

/**
 * Schema registry mapping message types to their definitions
 */
export const SCHEMA_REGISTRY = {
  [MESSAGE_TYPES.PROPOSAL]: PROPOSAL_SCHEMA,
  [MESSAGE_TYPES.CHALLENGE]: CHALLENGE_SCHEMA,
  [MESSAGE_TYPES.COUNTER_ARGUMENT]: COUNTER_ARGUMENT_SCHEMA,
  [MESSAGE_TYPES.SYNTHESIS]: SYNTHESIS_SCHEMA,
  [MESSAGE_TYPES.REVIEW_REQUEST]: REVIEW_REQUEST_SCHEMA,
  [MESSAGE_TYPES.REVIEW_FEEDBACK]: REVIEW_FEEDBACK_SCHEMA,
};

/**
 * Get schema definition for a message type
 *
 * @param {string} messageType - The message type
 * @returns {Object|null} The schema definition or null if unknown
 */
export function getSchema(messageType) {
  return SCHEMA_REGISTRY[messageType] || null;
}

/**
 * Get all schema definitions
 *
 * @returns {Object[]} Array of all schema definitions
 */
export function getAllSchemas() {
  return Object.values(SCHEMA_REGISTRY);
}

/**
 * Check if a message type is valid
 *
 * @param {string} messageType - The message type to check
 * @returns {boolean} True if valid, false otherwise
 */
export function isValidMessageType(messageType) {
  return VALID_MESSAGE_TYPES.has(messageType);
}

// ============================================================================
//                         VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validate message envelope fields (common to all message types)
 *
 * @param {any} message - The message to validate
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
export function validateEnvelope(message) {
  const errors = [];

  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { valid: false, errors: ['Message must be a non-null object'] };
  }

  // Required envelope fields
  if (!message.messageType || typeof message.messageType !== 'string') {
    errors.push('Missing or invalid required field: messageType (must be a non-empty string)');
  } else if (!isValidMessageType(message.messageType)) {
    errors.push(`Invalid messageType: "${message.messageType}". Must be one of: ${[...VALID_MESSAGE_TYPES].join(', ')}`);
  }

  if (!message.version || typeof message.version !== 'string') {
    errors.push('Missing or invalid required field: version (must be a non-empty string)');
  }

  if (!message.senderId || typeof message.senderId !== 'string') {
    errors.push('Missing or invalid required field: senderId (must be a non-empty string)');
  }

  if (message.recipientId !== undefined && message.recipientId !== null && (typeof message.recipientId !== 'string' || message.recipientId.trim() === '')) {
    errors.push('Field "recipientId" must be a non-empty string, null, or undefined');
  }

  if (!message.threadId || typeof message.threadId !== 'string') {
    errors.push('Missing or invalid required field: threadId (must be a non-empty string)');
  }

  if (!message.timestamp || typeof message.timestamp !== 'string') {
    errors.push('Missing or invalid required field: timestamp (must be an ISO 8601 string)');
  } else {
    const d = new Date(message.timestamp);
    if (Number.isNaN(d.getTime())) {
      errors.push('Field "timestamp" must be a valid ISO 8601 date string');
    }
  }

  if (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) {
    errors.push('Missing or invalid required field: payload (must be an object)');
  }

  // Optional metadata field
  if (message.metadata !== undefined) {
    if (typeof message.metadata !== 'object' || Array.isArray(message.metadata) || message.metadata === null) {
      errors.push('Optional field "metadata" must be a plain object if provided');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate PROPOSAL payload
 *
 * @param {any} payload - The payload to validate
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
export function validateProposalPayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['Payload must be a non-null object'] };
  }

  if (!payload.content || typeof payload.content !== 'string') {
    errors.push('Missing or invalid required field: content (must be a non-empty string)');
  } else if (payload.content.trim().length === 0) {
    errors.push('Field "content" must not be empty');
  }

  if (payload.context !== undefined) {
    if (typeof payload.context !== 'object' || Array.isArray(payload.context) || payload.context === null) {
      errors.push('Optional field "context" must be a plain object if provided');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate CHALLENGE payload
 *
 * @param {any} payload - The payload to validate
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
export function validateChallengePayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['Payload must be a non-null object'] };
  }

  if (!payload.content || typeof payload.content !== 'string') {
    errors.push('Missing or invalid required field: content (must be a non-empty string)');
  } else if (payload.content.trim().length === 0) {
    errors.push('Field "content" must not be empty');
  }

  if (!payload.target || typeof payload.target !== 'string') {
    errors.push('Missing or invalid required field: target (must be a non-empty string)');
  } else if (payload.target.trim().length === 0) {
    errors.push('Field "target" must not be empty');
  }

  if (payload.reasoning !== undefined && typeof payload.reasoning !== 'string') {
    errors.push('Optional field "reasoning" must be a string if provided');
  }

  if (payload.concerns !== undefined) {
    if (!Array.isArray(payload.concerns)) {
      errors.push('Optional field "concerns" must be an array if provided');
    } else {
      payload.concerns.forEach((concern, idx) => {
        if (typeof concern !== 'string' || concern.trim().length === 0) {
          errors.push(`Field "concerns[${idx}]" must be a non-empty string`);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate COUNTER_ARGUMENT payload
 *
 * @param {any} payload - The payload to validate
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
export function validateCounterArgumentPayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['Payload must be a non-null object'] };
  }

  if (!payload.content || typeof payload.content !== 'string') {
    errors.push('Missing or invalid required field: content (must be a non-empty string)');
  } else if (payload.content.trim().length === 0) {
    errors.push('Field "content" must not be empty');
  }

  if (!Array.isArray(payload.addresses)) {
    errors.push('Missing or invalid required field: addresses (must be an array)');
  } else if (payload.addresses.length === 0) {
    errors.push('Field "addresses" must contain at least one element');
  } else {
    payload.addresses.forEach((addr, idx) => {
      if (typeof addr !== 'string' || addr.trim().length === 0) {
        errors.push(`Field "addresses[${idx}]" must be a non-empty string`);
      }
    });
  }

  if (payload.reasoning !== undefined && typeof payload.reasoning !== 'string') {
    errors.push('Optional field "reasoning" must be a string if provided');
  }

  if (payload.evidence !== undefined) {
    if (!Array.isArray(payload.evidence)) {
      errors.push('Optional field "evidence" must be an array if provided');
    } else {
      payload.evidence.forEach((ev, idx) => {
        if (typeof ev !== 'string' || ev.trim().length === 0) {
          errors.push(`Field "evidence[${idx}]" must be a non-empty string`);
        }
      });
    }
  }

  if (payload.concessions !== undefined) {
    if (!Array.isArray(payload.concessions)) {
      errors.push('Optional field "concessions" must be an array if provided');
    } else {
      payload.concessions.forEach((con, idx) => {
        if (typeof con !== 'string' || con.trim().length === 0) {
          errors.push(`Field "concessions[${idx}]" must be a non-empty string`);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate SYNTHESIS payload
 *
 * @param {any} payload - The payload to validate
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
/**
 * Validate a REVIEW_REQUEST payload.
 *
 * Required fields are taken from the payloads production actually sends
 * (lifecycle.js:2998 and :3975), not from the abandoned design: output,
 * criteria, originalMessageId. outputDetails is optional — only the re-review
 * path includes it.
 */
export function validateReviewRequestPayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['Payload must be a non-null object'] };
  }

  if (!payload.output || typeof payload.output !== 'string') {
    errors.push('Missing or invalid required field: output (must be a non-empty string)');
  } else if (payload.output.trim().length === 0) {
    errors.push('Field "output" must not be empty');
  }

  if (!Array.isArray(payload.criteria) || payload.criteria.length === 0) {
    errors.push('Missing or invalid required field: criteria (must be a non-empty array)');
  }

  if (!payload.originalMessageId || typeof payload.originalMessageId !== 'string') {
    errors.push('Missing or invalid required field: originalMessageId (must be a non-empty string)');
  }

  if (payload.outputDetails !== undefined && typeof payload.outputDetails !== 'string') {
    errors.push('Optional field "outputDetails" must be a string when present');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a REVIEW_FEEDBACK payload.
 *
 * status drives the review state machine — approved ends the cycle, rejected
 * returns to revision, max_iterations_reached stops it on the budget — so it is
 * checked against the set lifecycle.js actually emits rather than accepting any
 * string. findings must be an array even when empty: an approval carries [],
 * and collapsing that to undefined is what makes "approved with no findings"
 * indistinguishable from "findings were dropped".
 */
export function validateReviewFeedbackPayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['Payload must be a non-null object'] };
  }

  const STATUSES = ['approved', 'rejected', 'max_iterations_reached'];
  if (!payload.status || typeof payload.status !== 'string') {
    errors.push('Missing or invalid required field: status (must be a non-empty string)');
  } else if (!STATUSES.includes(payload.status)) {
    errors.push(`Field "status" must be one of: ${STATUSES.join(', ')}`);
  }

  if (!Array.isArray(payload.findings)) {
    errors.push('Missing or invalid required field: findings (must be an array, [] when there are none)');
  }

  if (!payload.summary || typeof payload.summary !== 'string') {
    errors.push('Missing or invalid required field: summary (must be a non-empty string)');
  } else if (payload.summary.trim().length === 0) {
    errors.push('Field "summary" must not be empty');
  }

  return { valid: errors.length === 0, errors };
}

export function validateSynthesisPayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['Payload must be a non-null object'] };
  }

  if (!payload.content || typeof payload.content !== 'string') {
    errors.push('Missing or invalid required field: content (must be a non-empty string)');
  } else if (payload.content.trim().length === 0) {
    errors.push('Field "content" must not be empty');
  }

  if (!payload.summary || typeof payload.summary !== 'string') {
    errors.push('Missing or invalid required field: summary (must be a non-empty string)');
  } else if (payload.summary.trim().length === 0) {
    errors.push('Field "summary" must not be empty');
  }

  const arrayFields = ['supportingArguments', 'tradeoffs', 'nextActions'];
  for (const field of arrayFields) {
    if (payload[field] !== undefined) {
      if (!Array.isArray(payload[field])) {
        errors.push(`Optional field "${field}" must be an array if provided`);
      } else {
        payload[field].forEach((item, idx) => {
          if (typeof item !== 'string' || item.trim().length === 0) {
            errors.push(`Field "${field}[${idx}]" must be a non-empty string`);
          }
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a complete deliberation message (envelope + payload)
 *
 * @param {any} message - The complete message to validate
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
export function validateDeliberationMessage(message) {
  // First validate envelope
  const envelopeResult = validateEnvelope(message);
  if (!envelopeResult.valid) {
    return envelopeResult;
  }

  // Then validate payload based on message type
  let payloadResult;
  switch (message.messageType) {
    case MESSAGE_TYPES.PROPOSAL:
      payloadResult = validateProposalPayload(message.payload);
      break;
    case MESSAGE_TYPES.CHALLENGE:
      payloadResult = validateChallengePayload(message.payload);
      break;
    case MESSAGE_TYPES.COUNTER_ARGUMENT:
      payloadResult = validateCounterArgumentPayload(message.payload);
      break;
    case MESSAGE_TYPES.SYNTHESIS:
      payloadResult = validateSynthesisPayload(message.payload);
      break;
    case MESSAGE_TYPES.REVIEW_REQUEST:
      payloadResult = validateReviewRequestPayload(message.payload);
      break;
    case MESSAGE_TYPES.REVIEW_FEEDBACK:
      payloadResult = validateReviewFeedbackPayload(message.payload);
      break;
    default:
      return {
        valid: false,
        errors: [`Unknown message type: ${message.messageType}`],
      };
  }

  return payloadResult;
}

/**
 * Validate a PROPOSAL message (convenience wrapper for type-specific validation)
 *
 * @param {any} message - The message to validate as a proposal
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
export function validateProposal(message) {
  if (!message || typeof message !== 'object') {
    return { valid: false, errors: ['Message must be a non-null object'] };
  }

  if (message.messageType !== MESSAGE_TYPES.PROPOSAL) {
    return {
      valid: false,
      errors: [`Expected messageType '${MESSAGE_TYPES.PROPOSAL}', got '${message.messageType}'`],
    };
  }

  return validateDeliberationMessage(message);
}

/**
 * Validate a CHALLENGE message (convenience wrapper for type-specific validation)
 *
 * @param {any} message - The message to validate as a challenge
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
export function validateChallenge(message) {
  if (!message || typeof message !== 'object') {
    return { valid: false, errors: ['Message must be a non-null object'] };
  }

  if (message.messageType !== MESSAGE_TYPES.CHALLENGE) {
    return {
      valid: false,
      errors: [`Expected messageType '${MESSAGE_TYPES.CHALLENGE}', got '${message.messageType}'`],
    };
  }

  return validateDeliberationMessage(message);
}

/**
 * Validate a COUNTER_ARGUMENT message (convenience wrapper for type-specific validation)
 *
 * @param {any} message - The message to validate as a counter-argument
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
export function validateCounterArgument(message) {
  if (!message || typeof message !== 'object') {
    return { valid: false, errors: ['Message must be a non-null object'] };
  }

  if (message.messageType !== MESSAGE_TYPES.COUNTER_ARGUMENT) {
    return {
      valid: false,
      errors: [`Expected messageType '${MESSAGE_TYPES.COUNTER_ARGUMENT}', got '${message.messageType}'`],
    };
  }

  return validateDeliberationMessage(message);
}

/**
 * Validate a SYNTHESIS message (convenience wrapper for type-specific validation)
 *
 * @param {any} message - The message to validate as a synthesis
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
export function validateSynthesis(message) {
  if (!message || typeof message !== 'object') {
    return { valid: false, errors: ['Message must be a non-null object'] };
  }

  if (message.messageType !== MESSAGE_TYPES.SYNTHESIS) {
    return {
      valid: false,
      errors: [`Expected messageType '${MESSAGE_TYPES.SYNTHESIS}', got '${message.messageType}'`],
    };
  }

  return validateDeliberationMessage(message);
}

// ============================================================================
//                           FACTORY FUNCTIONS
// ============================================================================

/**
 * Create a PROPOSAL message
 *
 * @param {string} senderId - Agent ID sending the proposal
 * @param {string} threadId - Deliberation session identifier
 * @param {string} content - The proposal content
 * @param {Object} [options] - Optional fields
 * @param {string|null} [options.recipientId] - Target agent or null for broadcast
 * @param {Object} [options.context] - Additional context
 * @param {Object} [options.metadata] - Message metadata
 * @returns {ProposalMessage} A complete proposal message
 * @example
 * // Minimal proposal (broadcast)
 * const proposal = createProposal(
 *   'agent-alice',
 *   'delib-session-abc123',
 *   'We should adopt microservices architecture for the new platform'
 * );
 *
 * @example
 * // Full proposal with all optional fields
 * const proposal = createProposal(
 *   'agent-alice',
 *   'delib-session-abc123',
 *   'We should adopt microservices architecture for the new platform',
 *   {
 *     recipientId: null, // broadcast to all participants
 *     context: {
 *       rationale: 'Current monolith limits team autonomy and deployment velocity',
 *       evidence: [
 *         'Deploy frequency down 40% over last 6 months',
 *         'Team survey shows coordination overhead as top friction'
 *       ],
 *       assumptions: [
 *         'Teams have capacity to manage distributed systems',
 *         'Infrastructure supports container orchestration'
 *       ]
 *     },
 *     metadata: {
 *       traceId: 'trace-xyz789',
 *       campaignId: 'campaign-arch-decision',
 *       priority: 'high'
 *     }
 *   }
 * );
 */
export function createProposal(senderId, threadId, content, options = {}) {
  return {
    messageType: MESSAGE_TYPES.PROPOSAL,
    version: SCHEMA_VERSION,
    senderId,
    recipientId: options.recipientId ?? null,
    threadId,
    timestamp: new Date().toISOString(),
    payload: {
      content,
      ...(options.context && { context: options.context }),
    },
    ...(options.metadata && { metadata: options.metadata }),
  };
}

/**
 * Create a CHALLENGE message
 *
 * @param {string} senderId - Agent ID sending the challenge
 * @param {string} threadId - Deliberation session identifier
 * @param {string} content - The challenge content
 * @param {string} target - What aspect is being challenged
 * @param {Object} [options] - Optional fields
 * @param {string|null} [options.recipientId] - Target agent or null for broadcast
 * @param {string} [options.reasoning] - Explanation for the challenge
 * @param {string[]} [options.concerns] - Specific concerns being raised
 * @param {Object} [options.metadata] - Message metadata
 * @returns {ChallengeMessage} A complete challenge message
 * @example
 * // Minimal challenge (directed at specific agent)
 * const challenge = createChallenge(
 *   'agent-bob',
 *   'delib-session-abc123',
 *   'Microservices will significantly increase operational complexity',
 *   'operational feasibility',
 *   { recipientId: 'agent-alice' }
 * );
 *
 * @example
 * // Full challenge with reasoning and concerns
 * const challenge = createChallenge(
 *   'agent-bob',
 *   'delib-session-abc123',
 *   'Microservices will significantly increase operational complexity',
 *   'operational feasibility',
 *   {
 *     recipientId: 'agent-alice',
 *     reasoning: 'Team lacks distributed systems experience and monitoring tooling',
 *     concerns: [
 *       'No service mesh or observability platform in place',
 *       'On-call burden will increase with service sprawl',
 *       'Network latency and partial failure handling not addressed'
 *     ],
 *     metadata: {
 *       traceId: 'trace-xyz789',
 *       campaignId: 'campaign-arch-decision',
 *       priority: 'high'
 *     }
 *   }
 * );
 */
export function createChallenge(senderId, threadId, content, target, options = {}) {
  return {
    messageType: MESSAGE_TYPES.CHALLENGE,
    version: SCHEMA_VERSION,
    senderId,
    recipientId: options.recipientId ?? null,
    threadId,
    timestamp: new Date().toISOString(),
    payload: {
      content,
      target,
      ...(options.reasoning && { reasoning: options.reasoning }),
      ...(options.concerns && { concerns: options.concerns }),
    },
    ...(options.metadata && { metadata: options.metadata }),
  };
}

/**
 * Create a COUNTER_ARGUMENT message
 *
 * @param {string} senderId - Agent ID sending the counter-argument
 * @param {string} threadId - Deliberation session identifier
 * @param {string} content - The counter-argument content
 * @param {string[]} addresses - Challenge points being addressed
 * @param {Object} [options] - Optional fields
 * @param {string|null} [options.recipientId] - Target agent or null for broadcast
 * @param {string} [options.reasoning] - Supporting reasoning
 * @param {string[]} [options.evidence] - Supporting evidence
 * @param {string[]} [options.concessions] - Acknowledged concerns
 * @param {Object} [options.metadata] - Message metadata
 * @returns {CounterArgumentMessage} A complete counter-argument message
 * @example
 * // Minimal counter-argument (addresses required challenges)
 * const counter = createCounterArgument(
 *   'agent-alice',
 *   'delib-session-abc123',
 *   'We can mitigate operational complexity with phased rollout and tooling investment',
 *   ['operational feasibility'],
 *   { recipientId: 'agent-bob' }
 * );
 *
 * @example
 * // Full counter-argument with evidence and concessions
 * const counter = createCounterArgument(
 *   'agent-alice',
 *   'delib-session-abc123',
 *   'We can mitigate operational complexity with phased rollout and tooling investment',
 *   ['operational feasibility', 'monitoring tooling gaps', 'service mesh requirements'],
 *   {
 *     recipientId: 'agent-bob',
 *     reasoning: 'Complexity is manageable with proper planning and investment',
 *     evidence: [
 *       'Platform team committed to deploying service mesh in Q2',
 *       'Observability RFP approved, vendor selection in progress',
 *       'Phased migration plan limits blast radius to 2 services initially'
 *     ],
 *     concessions: [
 *       'Acknowledge increased operational burden in short term',
 *       'Will require dedicated platform engineering investment'
 *     ],
 *     metadata: {
 *       traceId: 'trace-xyz789',
 *       campaignId: 'campaign-arch-decision',
 *       priority: 'high'
 *     }
 *   }
 * );
 */
export function createCounterArgument(senderId, threadId, content, addresses, options = {}) {
  return {
    messageType: MESSAGE_TYPES.COUNTER_ARGUMENT,
    version: SCHEMA_VERSION,
    senderId,
    recipientId: options.recipientId ?? null,
    threadId,
    timestamp: new Date().toISOString(),
    payload: {
      content,
      addresses,
      ...(options.reasoning && { reasoning: options.reasoning }),
      ...(options.evidence && { evidence: options.evidence }),
      ...(options.concessions && { concessions: options.concessions }),
    },
    ...(options.metadata && { metadata: options.metadata }),
  };
}

/**
 * Create a SYNTHESIS message
 *
 * @param {string} senderId - Agent ID sending the synthesis
 * @param {string} threadId - Deliberation session identifier
 * @param {string} content - The synthesis content
 * @param {string} summary - Brief summary of consensus
 * @param {Object} [options] - Optional fields
 * @param {string|null} [options.recipientId] - Target agent or null for broadcast
 * @param {string[]} [options.supportingArguments] - Supporting arguments
 * @param {string[]} [options.tradeoffs] - Acknowledged trade-offs
 * @param {string[]} [options.nextActions] - Proposed next actions
 * @param {Object} [options.metadata] - Message metadata
 * @returns {SynthesisMessage} A complete synthesis message
 * @example
 * // Minimal synthesis (broadcast to all)
 * const synthesis = createSynthesis(
 *   'agent-bob',
 *   'delib-session-abc123',
 *   'Adopt microservices architecture with phased migration and platform investment',
 *   'Microservices approved with risk mitigation through tooling and gradual rollout'
 * );
 *
 * @example
 * // Full synthesis with supporting arguments, tradeoffs, and next actions
 * const synthesis = createSynthesis(
 *   'agent-bob',
 *   'delib-session-abc123',
 *   'Adopt microservices architecture with phased migration and platform investment',
 *   'Microservices approved with risk mitigation through tooling and gradual rollout',
 *   {
 *     recipientId: null, // broadcast final consensus
 *     supportingArguments: [
 *       'Addresses deployment velocity and team autonomy goals',
 *       'Operational risks mitigated through platform engineering investment',
 *       'Phased approach limits initial blast radius'
 *     ],
 *     tradeoffs: [
 *       'Higher operational complexity in exchange for deployment flexibility',
 *       'Upfront investment in service mesh and observability required',
 *       'Short-term velocity decrease during migration period'
 *     ],
 *     nextActions: [
 *       'Platform team to deploy service mesh by end of Q2',
 *       'Complete observability vendor selection by April 15',
 *       'Identify initial 2 services for migration pilot',
 *       'Develop service migration playbook and training materials'
 *     ],
 *     metadata: {
 *       traceId: 'trace-xyz789',
 *       campaignId: 'campaign-arch-decision',
 *       priority: 'high'
 *     }
 *   }
 * );
 */
export function createSynthesis(senderId, threadId, content, summary, options = {}) {
  return {
    messageType: MESSAGE_TYPES.SYNTHESIS,
    version: SCHEMA_VERSION,
    senderId,
    recipientId: options.recipientId ?? null,
    threadId,
    timestamp: new Date().toISOString(),
    payload: {
      content,
      summary,
      ...(options.supportingArguments && { supportingArguments: options.supportingArguments }),
      ...(options.tradeoffs && { tradeoffs: options.tradeoffs }),
      ...(options.nextActions && { nextActions: options.nextActions }),
    },
    ...(options.metadata && { metadata: options.metadata }),
  };
}

// ============================================================================
//                      STANDALONE EXAMPLE MESSAGES
// ============================================================================

/**
 * Complete, validated example message for each deliberation primitive.
 *
 * These objects are ready-to-use references — copy, adapt for tests, or pass
 * directly to `validateDeliberationMessage()` to confirm the schema is working.
 *
 * All four examples belong to the same fictional thread ('delib-session-abc123')
 * so they illustrate a coherent end-to-end deliberation sequence:
 *
 *   PROPOSAL  → agent-alice proposes microservices adoption
 *   CHALLENGE → agent-bob questions operational feasibility
 *   COUNTER_ARGUMENT → agent-alice rebuts with a phased-rollout plan
 *   SYNTHESIS → agent-bob closes the thread with the agreed consensus
 *
 * @namespace EXAMPLES
 */
export const EXAMPLES = {
  /**
   * PROPOSAL — agent-alice opens the thread.
   *
   * Required fields:   messageType, version, senderId, recipientId,
   *                    threadId, timestamp, payload.content
   * Optional fields:   payload.context (rationale, evidence, assumptions), metadata
   *
   * @type {ProposalMessage}
   * @example
   * {
   *   messageType: 'proposal',
   *   version: '1.0.0',
   *   senderId: 'agent-alice',
   *   recipientId: null,                   // broadcast to all participants
   *   threadId: 'delib-session-abc123',
   *   timestamp: '2026-03-20T10:00:00.000Z',
   *   payload: {
   *     content: 'We should adopt microservices architecture for the new platform',
   *     context: {
   *       rationale: 'Current monolith limits team autonomy and deployment velocity',
   *       evidence: [
   *         'Deploy frequency down 40% over last 6 months',
   *         'Team survey shows coordination overhead as top friction',
   *       ],
   *       assumptions: [
   *         'Teams have capacity to manage distributed systems',
   *         'Infrastructure supports container orchestration',
   *       ],
   *     },
   *   },
   *   metadata: { traceId: 'trace-xyz789', campaignId: 'campaign-arch-decision', priority: 'high' },
   * }
   */
  PROPOSAL: PROPOSAL_SCHEMA.example,

  /**
   * CHALLENGE — agent-bob questions the proposal's operational feasibility.
   *
   * Required fields:   messageType, version, senderId, recipientId,
   *                    threadId, timestamp, payload.content, payload.target
   * Optional fields:   payload.reasoning, payload.concerns, metadata
   *
   * @type {ChallengeMessage}
   * @example
   * {
   *   messageType: 'challenge',
   *   version: '1.0.0',
   *   senderId: 'agent-bob',
   *   recipientId: 'agent-alice',           // directed at the proposer
   *   threadId: 'delib-session-abc123',
   *   timestamp: '2026-03-20T10:05:00.000Z',
   *   payload: {
   *     content: 'Microservices will significantly increase operational complexity',
   *     target: 'operational feasibility',  // the aspect under scrutiny
   *     reasoning: 'Team lacks distributed systems experience and monitoring tooling',
   *     concerns: [
   *       'No service mesh or observability platform in place',
   *       'On-call burden will increase with service sprawl',
   *       'Network latency and partial failure handling not addressed',
   *     ],
   *   },
   *   metadata: { traceId: 'trace-xyz789', campaignId: 'campaign-arch-decision', priority: 'high' },
   * }
   */
  CHALLENGE: CHALLENGE_SCHEMA.example,

  /**
   * COUNTER_ARGUMENT — agent-alice rebuts and acknowledges minor concessions.
   *
   * Required fields:   messageType, version, senderId, recipientId,
   *                    threadId, timestamp, payload.content, payload.addresses
   * Optional fields:   payload.reasoning, payload.evidence, payload.concessions, metadata
   *
   * @type {CounterArgumentMessage}
   * @example
   * {
   *   messageType: 'counter_argument',
   *   version: '1.0.0',
   *   senderId: 'agent-alice',
   *   recipientId: 'agent-bob',
   *   threadId: 'delib-session-abc123',
   *   timestamp: '2026-03-20T10:10:00.000Z',
   *   payload: {
   *     content: 'We can mitigate operational complexity with phased rollout and tooling investment',
   *     addresses: [                         // must list each challenge target responded to
   *       'operational feasibility',
   *       'monitoring tooling gaps',
   *       'service mesh requirements',
   *     ],
   *     reasoning: 'Complexity is manageable with proper planning and investment',
   *     evidence: [
   *       'Platform team committed to deploying service mesh in Q2',
   *       'Observability RFP approved, vendor selection in progress',
   *       'Phased migration plan limits blast radius to 2 services initially',
   *     ],
   *     concessions: [                       // honest acknowledgement of valid concerns
   *       'Acknowledge increased operational burden in short term',
   *       'Will require dedicated platform engineering investment',
   *     ],
   *   },
   *   metadata: { traceId: 'trace-xyz789', campaignId: 'campaign-arch-decision', priority: 'high' },
   * }
   */
  COUNTER_ARGUMENT: COUNTER_ARGUMENT_SCHEMA.example,

  /**
   * SYNTHESIS — agent-bob closes the thread with the agreed consensus.
   *
   * Required fields:   messageType, version, senderId, recipientId,
   *                    threadId, timestamp, payload.content, payload.summary
   * Optional fields:   payload.supportingArguments, payload.tradeoffs,
   *                    payload.nextActions, metadata
   *
   * @type {SynthesisMessage}
   * @example
   * {
   *   messageType: 'synthesis',
   *   version: '1.0.0',
   *   senderId: 'agent-bob',
   *   recipientId: null,                    // broadcast final consensus
   *   threadId: 'delib-session-abc123',
   *   timestamp: '2026-03-20T10:15:00.000Z',
   *   payload: {
   *     content: 'Adopt microservices architecture with phased migration and platform investment',
   *     summary: 'Microservices approved with risk mitigation through tooling and gradual rollout',
   *     supportingArguments: [
   *       'Addresses deployment velocity and team autonomy goals',
   *       'Operational risks mitigated through platform engineering investment',
   *       'Phased approach limits initial blast radius',
   *     ],
   *     tradeoffs: [
   *       'Higher operational complexity in exchange for deployment flexibility',
   *       'Upfront investment in service mesh and observability required',
   *       'Short-term velocity decrease during migration period',
   *     ],
   *     nextActions: [
   *       'Platform team to deploy service mesh by end of Q2',
   *       'Complete observability vendor selection by April 15',
   *       'Identify initial 2 services for migration pilot',
   *       'Develop service migration playbook and training materials',
   *     ],
   *   },
   *   metadata: { traceId: 'trace-xyz789', campaignId: 'campaign-arch-decision', priority: 'high' },
   * }
   */
  SYNTHESIS: SYNTHESIS_SCHEMA.example,

  /**
   * REVIEW_REQUEST — agent-coder requests a review of their code.
   *
   * @type {ReviewRequestMessage}
   */
  REVIEW_REQUEST: REVIEW_REQUEST_SCHEMA.example,

  /**
   * REVIEW_FEEDBACK — agent-reviewer provides feedback on the code.
   *
   * @type {ReviewFeedbackMessage}
   */
  REVIEW_FEEDBACK: REVIEW_FEEDBACK_SCHEMA.example,
};

export default {
  SCHEMA_VERSION,
  MESSAGE_TYPES,
  VALID_MESSAGE_TYPES,
  PROPOSAL_SCHEMA,
  CHALLENGE_SCHEMA,
  COUNTER_ARGUMENT_SCHEMA,
  SYNTHESIS_SCHEMA,
  REVIEW_REQUEST_SCHEMA,
  REVIEW_FEEDBACK_SCHEMA,
  SCHEMA_REGISTRY,
  getSchema,
  getAllSchemas,
  isValidMessageType,
  validateEnvelope,
  validateProposalPayload,
  validateChallengePayload,
  validateCounterArgumentPayload,
  validateSynthesisPayload,
  validateReviewRequestPayload,
  validateReviewFeedbackPayload,
  validateDeliberationMessage,
  createProposal,
  createChallenge,
  createCounterArgument,
  createSynthesis,
  EXAMPLES,
};
