
const CATEGORIES = Object.freeze({
  PERMISSION_DENIED: 'permission-denied',
  SPAWN_FAILURE: 'spawn-failure',
  CIRCUIT_BREAKER_OPEN: 'circuit-breaker-open',
  TIMEOUT: 'timeout',
  AUTH_EXPIRED: 'auth-expired',
  PERSONA_INVALID: 'persona-invalid',
  CLI_NOT_FOUND: 'cli-not-found',
});

const ERROR_SCHEMA = {
  type: 'object',
  required: ['category', 'agentId', 'message', 'suggestedFix'],
  properties: {
    category: {
      type: 'string',
      enum: Object.values(CATEGORIES),
    },
    agentId: {
      type: 'string',
      minLength: 1,
    },
    timestamp: {
      type: 'number',
    },
    message: {
      type: 'string',
      minLength: 1,
    },
    suggestedFix: {
      type: 'string',
      minLength: 1,
    },
    context: {
      type: 'object',
      additionalProperties: true,
    },
  },
};

class ErrorRegistry {
  constructor(maxSizePerAgent = 200) {
    this.maxSizePerAgent = maxSizePerAgent;
    this.agentErrors = new Map();
    this.listeners = new Set();
  }

  /**
   * Get circular buffer for an agent, creating if needed
   * @private
   */
  _getCircularBuffer(agentId) {
    if (!this.agentErrors.has(agentId)) {
      this.agentErrors.set(agentId, []);
    }
    return this.agentErrors.get(agentId);
  }

  /**
   * Generate unique error ID
   * @private
   */
  _generateId() {
    return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Validate error object against schema
   * @private
   */
  _validateError(error) {
    const required = ERROR_SCHEMA.required;
    for (const field of required) {
      if (!(field in error)) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    if (!Object.values(CATEGORIES).includes(error.category)) {
      throw new Error(`Invalid category: ${error.category}`);
    }

    if (typeof error.agentId !== 'string' || error.agentId.length === 0) {
      throw new Error('agentId must be a non-empty string');
    }

    if (typeof error.message !== 'string' || error.message.length === 0) {
      throw new Error('message must be a non-empty string');
    }

    if (typeof error.suggestedFix !== 'string' || error.suggestedFix.length === 0) {
      throw new Error('suggestedFix must be a non-empty string');
    }
  }

  /**
   * Broadcast error to all subscribers
   * @private
   */
  _broadcastError(error) {
    for (const listener of this.listeners) {
      try {
        listener(error);
      } catch (err) {
        console.error('Error registry listener error:', err);
      }
    }
  }

  /**
   * Records a classified error for a specific agent
   * @param {object} error - The error object
   * @param {string} error.category - Category enum value
   * @param {string} error.agentId - Agent identifier
   * @param {number} error.timestamp - Unix timestamp
   * @param {string} error.message - Error message
   * @param {string} error.suggestedFix - Suggested fix
   * @param {object} [error.context] - Optional context object
   * @returns {object} The recorded error with ID
   */
  record(error) {
    this._validateError(error);

    const { agentId, category, message, timestamp, suggestedFix, context } = error;
    const entry = {
      id: this._generateId(),
      category,
      agentId,
      timestamp: timestamp || Date.now(),
      message,
      suggestedFix,
      context: context || {},
    };

    const errorsBuffer = this._getCircularBuffer(agentId);
    errorsBuffer.push(entry);

    if (errorsBuffer.length > this.maxSizePerAgent) {
      errorsBuffer.shift();
    }

    this._broadcastError(entry);

    return entry;
  }

  /**
   * Retrieves errors for a specific agent with pagination and filtering
   * @param {string} agentId - Agent identifier
   * @param {object} [options] - Query options
   * @param {number} [options.limit] - Max errors to return
   * @param {number} [options.offset=0] - Pagination offset
   * @param {string[]} [options.categories] - Filter by category
   * @returns {object} Paginated error results
   */
  getForAgent(agentId, options = {}) {
    const { limit, offset = 0, categories } = options;
    const errors = this.agentErrors.get(agentId) || [];

    let filtered = errors;
    if (categories && categories.length > 0) {
      filtered = errors.filter(e => categories.includes(e.category));
    }

    const total = filtered.length;
    const paginated = filtered.slice(offset, offset + (limit || total));

    return {
      errors: paginated,
      total,
      offset,
      limit: limit || total,
    };
  }

  /**
   * Get all agents with errors
   * @returns {object} Map of agentId to error count
   */
  getAgentsWithErrors() {
    const result = {};
    for (const [agentId, errors] of this.agentErrors.entries()) {
      if (errors.length > 0) {
        result[agentId] = errors.length;
      }
    }
    return result;
  }

  /**
   * Subscribe to error stream (SSE)
   * @param {Function} listener - Callback function
   * @returns {Function} Unsubscribe function
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Get a specific error by ID
   * @param {string} errorId - Error identifier
   * @param {string} agentId - Agent identifier
   * @returns {object|null} Error entry or null
   */
  getById(errorId, agentId) {
    const errors = this.agentErrors.get(agentId);
    if (!errors) {
      return null;
    }
    return errors.find(e => e.id === errorId) || null;
  }

  /**
   * Clears all errors for a specific agent.
   * @param {string} agentId - The ID of the agent.
   */
  clearForAgent(agentId) {
    this.agentErrors.delete(agentId);
  }

  /**
   * Clears all errors for all agents.
   */
  clearAll() {
    this.agentErrors.clear();
  }
}

export {
  ErrorRegistry,
  CATEGORIES,
  ERROR_SCHEMA,
};
