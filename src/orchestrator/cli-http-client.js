import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('cli-http-client');

/**
 * HTTP client for CLI operator commands.
 * Handles communication with Synapse API endpoints for agent control,
 * provider failover, weight overrides, and circuit breaker management.
 */
export class CLIHttpClient {
  constructor(baseUrl = process.env.SYNAPSE_SERVER_URL || 'http://localhost:8080') {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
  }

  /**
   * Generate a unique correlation ID for tracking operator actions
   * @returns {string} Correlation ID in format cli-<timestamp>-<uuid>
   */
  generateCorrelationId() {
    return `cli-${Date.now()}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Generate an idempotency key for guard actions
   * @returns {string} Action ID UUID
   */
  generateActionId() {
    return randomUUID();
  }

  /**
   * Make HTTP request to API endpoint
   * @private
   */
  async _request(method, path, body = null) {
    const url = `${this.baseUrl}${path}`;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (body !== null) {
      options.body = JSON.stringify(body);
    }

    try {
      log.debug(`${method} ${url}`, { body });
      const response = await fetch(url, options);
      const responseBody = await response.text();

      let json;
      try {
        json = responseBody ? JSON.parse(responseBody) : {};
      } catch {
        json = { raw: responseBody };
      }

      if (!response.ok) {
        return {
          success: false,
          status: response.status,
          error: json.error || `HTTP ${response.status}: ${response.statusText}`,
          data: json,
        };
      }

      return {
        success: true,
        status: response.status,
        data: json,
      };
    } catch (err) {
      log.error(`Request failed: ${method} ${url}`, { error: err.message });
      return {
        success: false,
        error: err.message,
        data: null,
      };
    }
  }

  /**
   * Pause an agent
   * @param {string} agentId - Agent identifier (e.g., 'alice', 'bob')
   * @param {string} [reason] - Optional reason for pausing
   * @returns {Promise<{success: boolean, error?: string, data?: object}>}
   */
  async pauseAgent(agentId, reason = null) {
    const correlationId = this.generateCorrelationId();
    const payload = {
      correlationId,
      source: 'cli',
    };

    if (reason) {
      payload.reason = reason;
    }

    const result = await this._request('POST', `/api/agents/${encodeURIComponent(agentId)}/pause`, payload);

    if (result.success) {
      log.info(`Agent paused: ${agentId}`, { correlationId });
    } else {
      log.warn(`Failed to pause agent: ${agentId}`, { error: result.error });
    }

    return result;
  }

  /**
   * Resume a paused agent
   * @param {string} agentId - Agent identifier (e.g., 'alice', 'bob')
   * @param {string} [reason] - Optional reason for resuming
   * @returns {Promise<{success: boolean, error?: string, data?: object}>}
   */
  async resumeAgent(agentId, reason = null) {
    const correlationId = this.generateCorrelationId();
    const payload = {
      correlationId,
      source: 'cli',
    };

    if (reason) {
      payload.reason = reason;
    }

    const result = await this._request('POST', `/api/agents/${encodeURIComponent(agentId)}/resume`, payload);

    if (result.success) {
      log.info(`Agent resumed: ${agentId}`, { correlationId });
    } else {
      log.warn(`Failed to resume agent: ${agentId}`, { error: result.error });
    }

    return result;
  }

  /**
   * Approve a specific campaign milestone.
   * @param {string} projectId - Project identifier
   * @param {string} campaignId - Campaign identifier
   * @param {string} milestoneId - Milestone identifier
   * @param {string} [reason] - Optional reason for approval
   * @returns {Promise<{success: boolean, error?: string, data?: object}>}
   */
  async approveMilestone(projectId, campaignId, milestoneId, reason = null) {
    const correlationId = this.generateCorrelationId();
    const payload = {
      correlationId,
      source: 'cli',
    };

    if (reason) {
      payload.reason = reason;
    }

    const result = await this._request('POST',
      `/api/projects/${encodeURIComponent(projectId)}/campaigns/${encodeURIComponent(campaignId)}/milestones/${encodeURIComponent(milestoneId)}/approve`,
      payload);

    if (result.success) {
      log.info(`Milestone approved: ${milestoneId}`, { correlationId });
    } else {
      log.warn(`Failed to approve milestone: ${milestoneId}`, { error: result.error });
    }

    return result;
  }

  /**
   * Force provider failover by holding its circuit breaker
   * @param {string} provider - Provider name (e.g., 'claude', 'ollama', 'codex', 'gemini')
   * @returns {Promise<{success: boolean, error?: string, data?: object}>}
   */
  async failoverProvider(provider) {
    const actionId = this.generateActionId();
    const correlationId = this.generateCorrelationId();

    const payload = {
      actionId,
      correlationId,
      provider,
      source: 'cli',
    };

    const result = await this._request('POST', '/api/guard-actions/circuit-breaker/hold', payload);

    if (result.success) {
      log.info(`Provider failover initiated: ${provider}`, { correlationId, actionId });
    } else {
      log.warn(`Failed to failover provider: ${provider}`, { error: result.error });
    }

    return result;
  }

  /**
   * Override routing weight for an agent
   * @param {string} agentId - Agent identifier
   * @param {number} weight - Weight value (0.0 to 1.0)
   * @param {number} [ttlMinutes=60] - Time-to-live in minutes
   * @returns {Promise<{success: boolean, error?: string, data?: object}>}
   */
  async setWeightOverride(agentId, weight, ttlMinutes = 60) {
    const actionId = this.generateActionId();
    const correlationId = this.generateCorrelationId();

    const payload = {
      actionId,
      correlationId,
      weights: { [agentId]: weight },
      ttlMs: ttlMinutes * 60 * 1000,
      source: 'cli',
    };

    const result = await this._request('POST', '/api/guard-actions/weight-override', payload);

    if (result.success) {
      log.info(`Weight override set: ${agentId}=${weight}`, { correlationId, actionId, ttlMinutes });
    } else {
      log.warn(`Failed to set weight override: ${agentId}`, { error: result.error });
    }

    return result;
  }

  /**
   * Reset circuit breaker for a provider
   * @param {string} provider - Provider name (e.g., 'claude', 'ollama', 'codex', 'gemini')
   * @returns {Promise<{success: boolean, error?: string, data?: object}>}
   */
  async resetCircuitBreaker(provider) {
    const actionId = this.generateActionId();
    const correlationId = this.generateCorrelationId();

    const payload = {
      actionId,
      correlationId,
      provider,
      source: 'cli',
    };

    const result = await this._request('POST', '/api/guard-actions/circuit-breaker/reset', payload);

    if (result.success) {
      log.info(`Circuit breaker reset: ${provider}`, { correlationId, actionId });
    } else {
      log.warn(`Failed to reset circuit breaker: ${provider}`, { error: result.error });
    }

    return result;
  }

  /**
   * Test API connectivity
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async healthCheck() {
    try {
      const result = await this._request('GET', '/health');
      return result;
    } catch (err) {
      return {
        success: false,
        error: `Unable to connect to Synapse API at ${this.baseUrl}: ${err.message}`,
      };
    }
  }
}

export default CLIHttpClient;
