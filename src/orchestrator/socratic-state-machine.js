import { SharedStateStore } from './shared-state-store.js';
import { validateProposal, validateChallenge, validateSynthesis, MESSAGE_TYPES } from './deliberation-message-schema.js';

const SocraticStates = {
  IDLE: 'idle',
  PROPOSE: 'propose',
  CRITIQUE: 'critique',
  MEDIATE: 'mediate',
  CONSENSUS_REACHED: 'consensus_reached',
  MAX_TURNS_EXCEEDED: 'max_turns_exceeded',
};

const STATE_ROLES = {
  [SocraticStates.IDLE]: null,
  [SocraticStates.PROPOSE]: 'proposer',
  [SocraticStates.CRITIQUE]: 'critic',
  [SocraticStates.MEDIATE]: 'mediator',
  [SocraticStates.CONSENSUS_REACHED]: null,
  [SocraticStates.MAX_TURNS_EXCEEDED]: null,
};

const VALID_TRANSITIONS = {
  [SocraticStates.IDLE]: [SocraticStates.PROPOSE, SocraticStates.MAX_TURNS_EXCEEDED],
  [SocraticStates.PROPOSE]: [SocraticStates.CRITIQUE, SocraticStates.MAX_TURNS_EXCEEDED],
  [SocraticStates.CRITIQUE]: [SocraticStates.MEDIATE, SocraticStates.MAX_TURNS_EXCEEDED],
  [SocraticStates.MEDIATE]: [SocraticStates.PROPOSE, SocraticStates.CONSENSUS_REACHED, SocraticStates.MAX_TURNS_EXCEEDED],
  [SocraticStates.CONSENSUS_REACHED]: [],
  [SocraticStates.MAX_TURNS_EXCEEDED]: [],
};

class StateMachineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateMachineError';
  }
}

class InvalidActorError extends StateMachineError {
  constructor(deliberationId, expectedActor, actualActor, state) {
    super(`Invalid actor for state "${state}" in deliberation "${deliberationId}": expected "${expectedActor}", got "${actualActor}"`);
    this.name = 'InvalidActorError';
    this.deliberationId = deliberationId;
    this.expectedActor = expectedActor;
    this.actualActor = actualActor;
    this.state = state;
  }
}

class InvalidTransitionError extends StateMachineError {
  constructor(deliberationId, currentState, attemptedAction, message = null) {
    const msg = message || `Invalid transition for "${deliberationId}": cannot perform "${attemptedAction}" from "${currentState}"`;
    super(msg);
    this.name = 'InvalidTransitionError';
    this.deliberationId = deliberationId;
    this.currentState = currentState;
    this.attemptedAction = attemptedAction;
  }
}

class InvalidPayloadError extends StateMachineError {
  constructor(errors) {
    super(`Invalid payload: ${errors.join(', ')}`);
    this.name = 'InvalidPayloadError';
    this.errors = errors;
  }
}

class SocraticStateMachine {
  /**
   * Validates a payload for a given action type
   *
   * @param {string} actionType - The action type (propose, critique, mediate, signal_consensus)
   * @param {Object} payload - The payload to validate
   * @returns {{valid: boolean, errors: string[]}} Validation result
   *
   * @example
   * const result = SocraticStateMachine.validateTransitionPayload('propose', { content: 'My proposal' });
   * if (!result.valid) {
   *   console.error('Validation failed:', result.errors);
   * }
   */
  static validateTransitionPayload(actionType, payload) {
    switch (actionType) {
      case 'propose':
        return validateProposal(payload);
      case 'critique':
        return validateChallenge(payload);
      case 'mediate':
        return validateSynthesis(payload);
      case 'signal_consensus':
        if (!payload || typeof payload.reasoning !== 'string') {
          return { valid: false, errors: ['Missing or invalid "reasoning" field'] };
        }
        return { valid: true, errors: [] };
      default:
        return { valid: false, errors: [`Unknown action type: ${actionType}`] };
    }
  }

  constructor(options) {
    const { maxTurns = 10, participantRoles, store, deliberationId } = options;

    this.maxTurns = maxTurns;
    this.participantRoles = participantRoles;
    this.store = store;
    this.deliberationId = deliberationId;

    this.stateKey = `socratic-state:${deliberationId}`;
    this._loadState();
  }
  
  _loadState() {
    const persisted = this.store.get(this.stateKey);
    
    if (persisted) {
      const record = JSON.parse(persisted.value);
      this.currentState = record.currentState;
      this.turnCount = record.turnCount || 0;
      this.stateHistory = record.stateHistory || [];
      this.maxTurns = record.maxTurns || this.maxTurns;
      this.participantRoles = record.participantRoles || this.participantRoles;
    } else {
      this.currentState = SocraticStates.IDLE;
      this.turnCount = 0;
      this.stateHistory = [];
    }
  }
  
  _saveState(actorId) {
    const record = {
      deliberationId: this.deliberationId,
      currentState: this.currentState,
      turnCount: this.turnCount,
      maxTurns: this.maxTurns,
      participantRoles: this.participantRoles,
      stateHistory: this.stateHistory,
      version: 0,
      createdAt: this.stateHistory.length > 0 ? this.stateHistory[0].timestamp : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    this.store.set(this.stateKey, JSON.stringify(record), actorId);
  }
  
  _validateActor(actorId, state) {
    const expectedRole = STATE_ROLES[state];
    if (!expectedRole) {
      return true;
    }
    
    const expectedActor = this.participantRoles[`${expectedRole}Id`];
    if (!expectedActor) {
      throw new StateMachineError(`No ${expectedRole} role assigned for deliberation "${this.deliberationId}"`);
    }
    
    return actorId === expectedActor;
  }
  
  _getExpectedActor(state) {
    const expectedRole = STATE_ROLES[state];
    if (!expectedRole) {
      if (state === SocraticStates.IDLE) {
        return this.participantRoles.proposerId;
      }
      return null;
    }
    return this.participantRoles[`${expectedRole}Id`];
  }
  
  _validateTransition(currentState, nextState) {
    const allowedNextStates = VALID_TRANSITIONS[currentState];
    if (!allowedNextStates || !allowedNextStates.includes(nextState)) {
      throw new InvalidTransitionError(
        this.deliberationId,
        currentState,
        nextState,
        `State machine does not allow transition from "${currentState}" to "${nextState}". Allowed: ${allowedNextStates ? allowedNextStates.join(', ') : 'none (terminal state)'}`
      );
    }
  }
  
  _appendStateHistory(nextState, actorId, turnCount) {
    const timestamp = new Date().toISOString();
    
    this.stateHistory.push({
      state: nextState,
      timestamp,
      actorId,
      turnCount,
    });
  }
  
  _checkMaxTurns(actorId) {
    if (this.turnCount >= this.maxTurns) {
      this._validateTransition(this.currentState, SocraticStates.MAX_TURNS_EXCEEDED);
      this._appendStateHistory(SocraticStates.MAX_TURNS_EXCEEDED, actorId, this.turnCount);
      this.currentState = SocraticStates.MAX_TURNS_EXCEEDED;
      this._saveState(actorId);
      return true;
    }
    return false;
  }
  
  _incrementTurn() {
    this.turnCount++;
  }
  
  advance(actorId, actionType, payload = {}) {
    const previousState = this.currentState;

    if (this.isTerminal()) {
      return {
        success: false,
        error: 'Terminal state',
        previousState,
        newState: this.currentState,
        turnCount: this.turnCount,
        isTerminal: true,
      };
    }

    if (this._checkMaxTurns(actorId)) {
      return {
        success: true,
        previousState,
        newState: this.currentState,
        turnCount: this.turnCount,
        isTerminal: true,
        reason: 'max_turns_exceeded',
      };
    }

    // Validate payload using static helper
    const payloadValidation = SocraticStateMachine.validateTransitionPayload(actionType, payload);
    if (!payloadValidation.valid) {
      throw new InvalidPayloadError(payloadValidation.errors);
    }

    let nextState;
    let validatedPayload = null;

    switch (actionType) {
      case 'propose':
        if (!this._validateActor(actorId, SocraticStates.PROPOSE) && !this._validateActor(actorId, SocraticStates.IDLE)) {
          const expectedActor = this._getExpectedActor(previousState) || this.participantRoles.proposerId;
          throw new InvalidActorError(this.deliberationId, expectedActor, actorId, previousState);
        }
        this._validateActor(actorId, SocraticStates.PROPOSE);
        this._validateTransition(previousState, SocraticStates.PROPOSE);
        validatedPayload = payload;
        nextState = SocraticStates.PROPOSE;
        break;

      case 'critique':
        if (!this._validateActor(actorId, SocraticStates.CRITIQUE)) {
          const expectedActor = this._getExpectedActor(SocraticStates.CRITIQUE);
          throw new InvalidActorError(this.deliberationId, expectedActor, actorId, previousState);
        }
        this._validateTransition(previousState, SocraticStates.CRITIQUE);
        validatedPayload = payload;
        nextState = SocraticStates.CRITIQUE;
        break;

      case 'mediate':
        if (!this._validateActor(actorId, SocraticStates.MEDIATE)) {
          const expectedActor = this._getExpectedActor(SocraticStates.MEDIATE);
          throw new InvalidActorError(this.deliberationId, expectedActor, actorId, previousState);
        }
        this._validateTransition(previousState, SocraticStates.MEDIATE);
        validatedPayload = payload;
        nextState = SocraticStates.MEDIATE;
        break;

      case 'signal_consensus':
        if (!this._validateActor(actorId, SocraticStates.MEDIATE)) {
          const expectedActor = this._getExpectedActor(SocraticStates.MEDIATE);
          throw new InvalidActorError(this.deliberationId, expectedActor, actorId, previousState);
        }
        this._validateTransition(previousState, SocraticStates.CONSENSUS_REACHED);
        nextState = SocraticStates.CONSENSUS_REACHED;
        break;

      default:
        throw new InvalidTransitionError(this.deliberationId, previousState, actionType, `Unknown action type: ${actionType}`);
    }

    this._incrementTurn();
    this._appendStateHistory(nextState, actorId, this.turnCount);
    this.currentState = nextState;
    this._saveState(actorId);

    return {
      success: true,
      previousState,
      newState: nextState,
      turnCount: this.turnCount,
      isTerminal: this.isTerminal(),
      validatedPayload,
    };
  }
  
  getCurrentState() {
    return this.currentState;
  }
  
  getTurnCount() {
    return this.turnCount;
  }
  
  isTerminal() {
    return this.currentState === SocraticStates.CONSENSUS_REACHED || 
           this.currentState === SocraticStates.MAX_TURNS_EXCEEDED;
  }
  
  getStateHistory() {
    return [...this.stateHistory];
  }
  
  getCurrentTurnActor() {
    return this._getExpectedActor(this.currentState);
  }
  
  getParticipantRoles() {
    return { ...this.participantRoles };
  }
  
  reset() {
    this.currentState = SocraticStates.IDLE;
    this.turnCount = 0;
    this.stateHistory = [];
    const actorId = this.participantRoles.proposerId || 'system';
    this._saveState(actorId);
  }
  
  getMaxTurns() {
    return this.maxTurns;
  }
  
  _cycle(actorId) {
    const previousState = this.currentState;
    const previousTurnCount = this.turnCount;
    
    if (this.isTerminal()) {
      return {
        success: false,
        error: 'Cannot cycle from terminal state',
        previousState,
        newState: this.currentState,
      };
    }
    
    this.reset();
    
    return {
      success: true,
      previousState,
      newState: this.currentState,
      previousTurnCount,
      currentTurnCount: this.turnCount,
    };
  }
}

export {
  SocraticStateMachine,
  SocraticStates,
  StateMachineError,
  InvalidActorError,
  InvalidTransitionError,
  InvalidPayloadError,
};