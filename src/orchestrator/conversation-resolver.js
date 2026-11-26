/**
 * ConversationResolver — resolution detection & state machine.
 *
 * Adapted delta of archive 61cb9fa2 per docs/design/conversation-resolver-integration.md.
 * Stateless service: analyzes a conversation message array and returns a structured
 * resolution outcome. Consumed by conversationLoop to decide whether a thread has
 * reached a terminal state and whether it must escalate to the architect.
 *
 * Detection logic is NOT re-declared here. Agreement/closure/noise/delegation
 * detection lives in conversation.js and is imported; the ONLY predicate this
 * module owns is rejection (REJECTION_PATTERNS / isRejectionResponse).
 *
 * ## States
 *
 *   active              — in progress, no resolution detected.
 *   resolved_accepted   — agreement, majority closure, or lead delegation. taskStatus='done'.
 *   resolved_rejected   — explicit rejection keywords. taskStatus='failed'.
 *   escalated           — turn budget exhausted without resolution. taskStatus='escalated'.
 *   max_turns_exceeded  — compatibility alias accepted by isValidTransition() as a
 *                         target from 'active'; outcomeToState() never produces it.
 *
 *   All states except 'active' are terminal — no outbound transitions.
 *
 * ## Evaluation precedence (highest to lowest)
 *
 *   1. Max-turns escalation — turnCount > maxTurns short-circuits everything
 *      (turnCount === maxTurns stays active).
 *   2. Minimum message gate — fewer than 2 agent messages stays active.
 *   3. Lead delegation — architect @-mentions a target with an action verb.
 *   4. Rejection — takes priority over agreement in mixed-signal conversations.
 *   5. Majority closure — >50% of unique speakers sent closure responses.
 *   6. Simple agreement — at least one closure message.
 *   7. No match — remains active.
 *
 * NOTE on 'escalated': it is a value in the RESOLVER's namespace (outcome.taskStatus
 * and this state machine). It is NOT a task status — src/tasks.js TASK_TRANSITIONS
 * has no such state, and it must never be passed to taskManager.updateTaskStatus.
 */

import { createLogger } from '../logger.js';
import {
  isClosureResponse,
  isNoiseResponse,
  isOperatorSpeaker,
  DELEGATION_ROLES,
  DELEGATION_RE,
} from './conversation.js';

const log = createLogger('conversation-resolver');

// ─── Rejection predicate (the only detection logic owned by this module) ──

export const REJECTION_PATTERNS = /\b(rejected|still broken|not fixed|needs work|try again|broken|failing|failed|incorrect|wrong|issue remains|problem persists)\b/i;

export function isRejectionResponse(text) {
  if (!text) return false;
  return REJECTION_PATTERNS.test(text);
}

// ─── Message helpers ─────────────────────────────────────────────────

function isAgentContentMessage(msg) {
  return msg?.type === 'message' && !isOperatorSpeaker(msg.speaker);
}

function detectDelegation(messages, getAgents) {
  if (!getAgents) return null; // delegation detection is optional
  const agents = getAgents();
  for (const msg of messages) {
    if (!msg.speaker || !msg.content) continue;
    const speakerId = msg.speaker.toLowerCase();
    const agent = Object.hasOwn(agents, speakerId) ? agents[speakerId] : undefined;
    if (!agent || !DELEGATION_ROLES.has(agent.role)) continue;
    DELEGATION_RE.lastIndex = 0;
    const match = DELEGATION_RE.exec(msg.content);
    if (match) {
      return {
        from: speakerId,
        to: match[1].toLowerCase(),
        task: (match[3] || '').trim().slice(0, 100),
      };
    }
  }
  return null;
}

// ─── Resolution analysis ─────────────────────────────────────────────

/**
 * Analyze conversation messages and detect resolution state.
 *
 * @param {Object} input
 * @param {Array<Object>} input.messages - Conversation messages
 * @param {Object} [input.config]
 * @param {number} [input.config.maxTurns=10] - Agent turns before escalation (exclusive: escalates at maxTurns+1)
 * @param {number} [input.config.participantCount=2] - Expected agent count (rejection confidence denominator)
 * @param {Function} [input.getAgents] - Agent registry lookup, enables delegation detection
 * @returns {{resolved: boolean, resolution: string|null, turnCount: number,
 *   shouldEscalate: boolean, taskStatus: string, reason: string,
 *   matched_keywords: string[], confidence: number}}
 */
export function analyzeConversation(input) {
  const { messages, config = {}, getAgents = null } = input || {};
  const { maxTurns = 10, participantCount = 2 } = config;

  const outcome = {
    resolved: false,
    resolution: null,
    turnCount: 0,
    shouldEscalate: false,
    taskStatus: 'in_progress',
    reason: 'Conversation in progress',
    matched_keywords: [],
    confidence: 0.0,
  };

  const allMessages = Array.isArray(messages) ? messages : [];
  if (allMessages.length === 0) {
    outcome.reason = 'No messages in conversation';
    return outcome;
  }

  // Only agent messages count as turns; System/operator messages are excluded
  // from both turn counting and pattern matching.
  const agentMessages = allMessages.filter(isAgentContentMessage);
  outcome.turnCount = agentMessages.length;

  // 1. Max-turns escalation — checked first, short-circuits all other detection.
  if (outcome.turnCount > maxTurns) {
    outcome.shouldEscalate = true;
    outcome.taskStatus = 'escalated';
    outcome.reason = `Max conversation turns exceeded (${outcome.turnCount}/${maxTurns})`;
    outcome.confidence = 1.0;
    log.info('Escalation triggered', { turnCount: outcome.turnCount, maxTurns });
    return outcome;
  }

  // 2. Minimum message gate.
  if (agentMessages.length < 2) {
    outcome.reason = 'Insufficient messages for resolution detection';
    return outcome;
  }

  // 3. Lead delegation (architect @-mentions a target with an action verb).
  const delegation = detectDelegation(agentMessages, getAgents);
  if (delegation) {
    outcome.resolved = true;
    outcome.resolution = 'lead-delegation';
    outcome.taskStatus = 'done';
    outcome.reason = `Work delegated from @${delegation.from} to @${delegation.to}`;
    outcome.confidence = 0.95;
    outcome.matched_keywords = ['delegation'];
    log.info('Lead delegation detected', delegation);
    return outcome;
  }

  const closureMessages = [];
  const rejectionMessages = [];
  for (const msg of agentMessages) {
    const content = msg.content || '';
    if (isRejectionResponse(content)) {
      rejectionMessages.push(msg);
      const match = content.match(REJECTION_PATTERNS);
      if (match) outcome.matched_keywords.push(match[1].toLowerCase());
    }
    if (isClosureResponse(content)) {
      closureMessages.push(msg);
      outcome.matched_keywords.push('closure');
    }
    // Noise-only messages ("+1", "agreed") are not filtered out: they match
    // both isNoiseResponse and isClosureResponse, and agreement takes precedence.
  }

  // 4. Rejection takes precedence over agreement in mixed-signal conversations.
  if (rejectionMessages.length > 0) {
    outcome.resolved = true;
    outcome.resolution = 'rejection';
    outcome.taskStatus = 'failed';
    outcome.reason = `Explicit rejection detected (${rejectionMessages.length} message${rejectionMessages.length > 1 ? 's' : ''})`;
    outcome.confidence = Math.min(1.0, rejectionMessages.length / Math.max(1, participantCount));
    log.info('Rejection detected', { count: rejectionMessages.length, keywords: outcome.matched_keywords });
    return outcome;
  }

  const uniqueSpeakers = new Set(agentMessages.map(m => m.speaker).filter(Boolean));
  const actualParticipants = Math.max(1, uniqueSpeakers.size);
  const closureSpeakers = new Set(closureMessages.map(m => m.speaker).filter(Boolean));

  // 5. Majority closure (>50% of unique speakers sent closure responses).
  if (closureSpeakers.size > actualParticipants / 2 && closureSpeakers.size > 0) {
    outcome.resolved = true;
    outcome.resolution = 'majority-closure';
    outcome.taskStatus = 'done';
    outcome.reason = `Majority closure (${closureSpeakers.size}/${actualParticipants} participants agreed)`;
    outcome.confidence = closureSpeakers.size / actualParticipants;
    log.info('Majority closure detected', { closureSpeakers: closureSpeakers.size, total: actualParticipants });
    return outcome;
  }

  // 6. Simple agreement — any closure message resolves. (The archive's
  // confidenceThreshold gate was vacuous: its fallback clause `|| length >= 1`
  // was always true inside this branch, so the threshold is dropped here.)
  if (closureMessages.length > 0) {
    outcome.resolved = true;
    outcome.resolution = 'agreement';
    outcome.taskStatus = 'done';
    outcome.reason = `Agreement detected (${closureMessages.length} closure message${closureMessages.length > 1 ? 's' : ''})`;
    outcome.confidence = Math.min(1.0, closureSpeakers.size / actualParticipants);
    log.info('Agreement detected', { count: closureMessages.length, keywords: outcome.matched_keywords });
    return outcome;
  }

  // 7. No resolution detected.
  outcome.reason = `Active conversation (${outcome.turnCount}/${maxTurns} turns)`;
  return outcome;
}

// ─── State machine ───────────────────────────────────────────────────

export const TERMINAL_STATES = new Set([
  'resolved_accepted',
  'resolved_rejected',
  'escalated',
  'max_turns_exceeded',
]);

// Null prototype: currentState may be data-derived; '__proto__'/'constructor'
// must fall through to undefined, not reach Object.prototype.
const VALID_TRANSITIONS = Object.freeze(Object.assign(Object.create(null), {
  active: Object.freeze(['resolved_accepted', 'resolved_rejected', 'escalated', 'max_turns_exceeded']),
  resolved_accepted: Object.freeze([]),
  resolved_rejected: Object.freeze([]),
  escalated: Object.freeze([]),
  max_turns_exceeded: Object.freeze([]),
}));

/**
 * @param {string} currentState
 * @param {string} nextState
 * @returns {boolean} True if the transition is legal. Unknown states return false.
 */
export function isValidTransition(currentState, nextState) {
  return VALID_TRANSITIONS[currentState]?.includes(nextState) ?? false;
}

/**
 * Map an analyzeConversation outcome to a state machine state.
 *
 *   shouldEscalate                → 'escalated'
 *   resolution 'rejection'        → 'resolved_rejected'
 *   resolution 'agreement' /
 *     'majority-closure' /
 *     'lead-delegation'           → 'resolved_accepted'
 *   otherwise                     → 'active'
 */
export function outcomeToState(outcome) {
  if (!outcome) return 'active';
  if (outcome.shouldEscalate) return 'escalated';
  if (outcome.resolved) {
    return outcome.resolution === 'rejection' ? 'resolved_rejected' : 'resolved_accepted';
  }
  return 'active';
}

// ─── Escalation context (architect handoff) ─────────────────────────

/**
 * Build the structured escalation context for the architect agent.
 * Called when analyzeConversation returns shouldEscalate=true.
 *
 * @param {Object} input
 * @param {Array<Object>} input.messages - Full conversation message array
 * @param {Object} input.outcome - Outcome from analyzeConversation
 * @param {string} [input.architectAgentId='architect']
 * @param {string} [input.conversationId]
 * @param {string} [input.taskId]
 * @param {number} [input.maxTurns] - The limit that was exceeded (archive derived
 *   this from turnCount, which was wrong; callers pass the real configured value)
 * @returns {Object} Escalation context incl. formattedContext markdown brief
 */
export function formatEscalationContext(input) {
  const {
    messages,
    outcome = {},
    architectAgentId = 'architect',
    conversationId = null,
    taskId = null,
    maxTurns = null,
  } = input || {};

  const agentMessages = (Array.isArray(messages) ? messages : []).filter(isAgentContentMessage);
  const participants = extractParticipantHistory(agentMessages);
  const summary = buildConversationSummary(agentMessages);
  const unresolvedIssues = extractUnresolvedIssues(agentMessages);

  return {
    architectAgentId,
    conversationId,
    taskId,
    reason: outcome.reason || 'Max conversation turns exceeded',
    turnCount: outcome.turnCount ?? agentMessages.length,
    maxTurns,
    participants,
    summary,
    unresolvedIssues,
    formattedContext: formatForArchitect(summary, unresolvedIssues, participants, outcome),
  };
}

function extractParticipantHistory(agentMessages) {
  const participantMap = new Map();
  for (const msg of agentMessages) {
    const speaker = msg.speaker;
    if (!speaker) continue;
    if (!participantMap.has(speaker)) {
      participantMap.set(speaker, { agentId: speaker, messageCount: 0, firstSeen: msg.timestamp, lastSeen: msg.timestamp });
    }
    const entry = participantMap.get(speaker);
    entry.messageCount++;
    entry.lastSeen = msg.timestamp || entry.lastSeen;
  }
  return [...participantMap.values()];
}

function buildConversationSummary(agentMessages) {
  return agentMessages.map(msg => ({
    speaker: msg.speaker,
    content: (msg.content || '').slice(0, 500),
    timestamp: msg.timestamp,
    isRejection: isRejectionResponse(msg.content),
    isClosure: isClosureResponse(msg.content),
  }));
}

function extractUnresolvedIssues(agentMessages) {
  const issues = [];
  for (const msg of agentMessages) {
    const content = msg.content || '';
    if (isRejectionResponse(content) && !isClosureResponse(content)) {
      issues.push({
        raisedBy: msg.speaker,
        content: content.slice(0, 300),
        timestamp: msg.timestamp,
      });
    }
  }
  return issues;
}

function formatForArchitect(summary, unresolvedIssues, participants, outcome) {
  const lines = [];

  lines.push(`## Escalation: ${outcome.reason || 'Max turns exceeded'}`);
  lines.push('');

  lines.push('### Participants');
  for (const p of participants) {
    lines.push(`- **${p.agentId}**: ${p.messageCount} message${p.messageCount !== 1 ? 's' : ''}`);
  }
  lines.push('');

  lines.push('### Conversation Timeline');
  for (const entry of summary) {
    const tag = entry.isRejection ? ' [REJECTION]' : entry.isClosure ? ' [CLOSURE]' : '';
    lines.push(`[${entry.speaker}]${tag}: ${entry.content}`);
  }
  lines.push('');

  if (unresolvedIssues.length > 0) {
    lines.push('### Unresolved Issues');
    for (const issue of unresolvedIssues) {
      lines.push(`- **${issue.raisedBy}**: ${issue.content}`);
    }
    lines.push('');
  }

  lines.push('### Required Action');
  lines.push('Please review the conversation above and provide a final verdict. The agents could not reach resolution within the turn limit.');

  return lines.join('\n');
}

// Re-export the shared predicates so resolver consumers and tests have one import site.
export { isClosureResponse, isNoiseResponse };
