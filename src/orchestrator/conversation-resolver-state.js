/**
 * Persistent state for the conversation resolver.
 *
 * The resolver itself is stateless. This layer records its one-way transition
 * from `active` to a terminal state in ConversationStore. A generic get/set
 * dependency remains supported for focused state-machine tests. The layer does
 * not construct a concrete store, so partial-dependency boot/test harnesses can
 * leave persistence disabled.
 */

import {
  TERMINAL_STATES,
  isValidTransition,
} from './conversation-resolver.js';

export const CONVERSATION_RESOLVER_STATE_PREFIX = 'conversation-resolver';
export const CONVERSATION_RESOLVER_STATE_ACTOR = 'system';

export const ConversationStates = Object.freeze({
  ACTIVE: 'active',
  RESOLVED_ACCEPTED: 'resolved_accepted',
  RESOLVED_REJECTED: 'resolved_rejected',
  ESCALATED: 'escalated',
  MAX_TURNS_EXCEEDED: 'max_turns_exceeded',
});

export class StateMachineError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'StateMachineError';
  }
}

export class InvalidTransitionError extends StateMachineError {
  constructor(conversationId, currentState, nextState, message = null) {
    super(
      message
      || `Invalid transition for "${conversationId}": cannot transition from "${currentState}" to "${nextState}"`
    );
    this.name = 'InvalidTransitionError';
    this.conversationId = conversationId;
    this.currentState = currentState;
    this.nextState = nextState;
  }
}

/**
 * Build the compatibility key used by generic get/set test stores. Production
 * ConversationStore persistence uses the same project/thread identity as a
 * composite database key.
 */
export function conversationResolverStateKey(projectId, threadId) {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new StateMachineError('projectId is required');
  }
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new StateMachineError('threadId is required');
  }
  return `${CONVERSATION_RESOLVER_STATE_PREFIX}:${projectId}:${threadId}`;
}

function validateStore(store) {
  if (store == null) return null;
  if (typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new StateMachineError('store must implement get(key) and set(key, value, agentId)');
  }
  return store;
}

function conversationStoreAdapter(conversationStore, projectId, threadId, key) {
  if (conversationStore == null) return null;
  if (
    typeof conversationStore.getResolverState !== 'function'
    || typeof conversationStore.setResolverState !== 'function'
  ) {
    throw new StateMachineError(
      'conversationStore must implement getResolverState(projectId, threadId) and setResolverState(projectId, threadId, record)'
    );
  }
  return {
    get(requestedKey) {
      if (requestedKey !== key) {
        throw new StateMachineError(`Unexpected resolver state key "${requestedKey}"`);
      }
      const value = conversationStore.getResolverState(projectId, threadId);
      return value == null ? null : { key, value };
    },
    set(requestedKey, value) {
      if (requestedKey !== key) {
        throw new StateMachineError(`Unexpected resolver state key "${requestedKey}"`);
      }
      conversationStore.setResolverState(projectId, threadId, value);
    },
  };
}

function copyOutcome(outcome) {
  return {
    ...outcome,
    matched_keywords: Array.isArray(outcome.matched_keywords)
      ? [...outcome.matched_keywords]
      : [],
  };
}

function copyRecord(record) {
  return {
    ...record,
    outcome: record.outcome && typeof record.outcome === 'object'
      ? copyOutcome(record.outcome)
      : record.outcome,
    history: record.history.map(transition => ({ ...transition })),
  };
}

/**
 * Persist and reload terminal resolver state for one project/thread pair.
 *
 * A missing store is an intentional switch-off: loadState() returns null and
 * saveState() returns undefined. A supplied store is validated eagerly so a
 * wiring mistake cannot silently discard state.
 */
export class ConversationResolverState {
  constructor({
    projectId,
    threadId,
    store = null,
    conversationStore = null,
    now = () => new Date().toISOString(),
  } = {}) {
    this.key = conversationResolverStateKey(projectId, threadId);
    this.projectId = projectId;
    this.threadId = threadId;
    this.conversationId = `${projectId}:${threadId}`;
    if (store != null && conversationStore != null) {
      throw new StateMachineError('provide either store or conversationStore, not both');
    }
    this.store = conversationStore != null
      ? conversationStoreAdapter(conversationStore, projectId, threadId, this.key)
      : validateStore(store);

    if (typeof now !== 'function') {
      throw new StateMachineError('now must be a function');
    }
    this.now = now;
  }

  /**
   * Load the stored value from the persistence adapter row wrapper.
   *
   * @returns {{state: string, previousState: string|null, outcome: object,
   *   history: Array<object>, updatedAt: string}|null}
   */
  loadState() {
    if (!this.store) return null;

    const entry = this.store.get(this.key);
    if (entry == null) return null;

    const record = entry.value;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new StateMachineError(
        `Invalid persisted conversation resolver state for "${this.conversationId}"`
      );
    }
    if (record.state !== ConversationStates.ACTIVE && !TERMINAL_STATES.has(record.state)) {
      throw new StateMachineError(
        `Unknown persisted conversation resolver state "${record.state}" for "${this.conversationId}"`
      );
    }
    if (!Array.isArray(record.history)) {
      throw new StateMachineError(
        `Invalid persisted conversation resolver history for "${this.conversationId}"`
      );
    }

    return copyRecord(record);
  }

  /**
   * Transition from the persisted state (or `active` when absent) and append a
   * durable history record. Only legal active-to-terminal edges are accepted.
   *
   * @param {string} nextState
   * @param {object} outcome - Structured result from analyzeConversation().
   * @returns {object|undefined} persisted record, or undefined when disabled.
   * @throws {InvalidTransitionError} for every illegal edge, including all
   *   outbound transitions from terminal states.
   */
  saveState(nextState, outcome) {
    if (!this.store) return undefined;
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
      throw new StateMachineError('outcome must be an object');
    }

    const existing = this.loadState();
    const currentState = existing?.state ?? ConversationStates.ACTIVE;

    if (!isValidTransition(currentState, nextState)) {
      throw new InvalidTransitionError(
        this.conversationId,
        currentState,
        nextState,
        `State machine does not allow transition from "${currentState}" to "${nextState}" for "${this.conversationId}"`
      );
    }
    if (!TERMINAL_STATES.has(nextState)) {
      throw new InvalidTransitionError(this.conversationId, currentState, nextState);
    }

    const at = this.now();
    const outcomeSnapshot = copyOutcome(outcome);
    const history = existing ? existing.history.map(transition => ({ ...transition })) : [];
    history.push({
      from: currentState,
      to: nextState,
      reason: outcome.reason ?? null,
      at,
    });

    const record = {
      state: nextState,
      previousState: currentState,
      outcome: outcomeSnapshot,
      history,
      updatedAt: at,
    };

    // Persistence adapters serialise raw values themselves. Passing JSON here
    // would double-encode the record and break loadState().
    this.store.set(this.key, record, CONVERSATION_RESOLVER_STATE_ACTOR);
    return copyRecord(record);
  }

  transitionTo(nextState, outcome) {
    return this.saveState(nextState, outcome);
  }
}

// Compatibility with the archive class module's public constant alias.
export { ConversationStates as States };
