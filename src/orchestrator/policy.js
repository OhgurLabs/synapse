/**
 * RBAC Policy Engine for Synapse control plane.
 * Enforces role-based access for operator actions and audits denials.
 * Implementation based on docs/rbac-policy-matrix.md.
 */

import { createLogger } from '../logger.js';

const log = createLogger('policy-engine');

export class PolicyEngine {
  /**
   * @param {object} deps
   * @param {object} deps.config - Orchestrator config (config.auth.userRoles, config.auth.roles)
   * @param {object} deps.operatorAuditStore - Store for audit logs
   */
  constructor({ config, operatorAuditStore }) {
    this.config = config;
    this.operatorAuditStore = operatorAuditStore;
    // Roles are defined in config.auth.roles; defaults per matrix taxonomy
    this.roles = config?.auth?.roles || {
      ADMIN: 'admin',
      OPERATOR: 'operator',
      REVIEWER: 'reviewer',
      SUPPORT: 'support',
      VIEWER: 'viewer'
    };
  }

  resolveRole(requestUserId, roleHint) {
    const userRoles = this.config?.auth?.userRoles || {};
    const mapped = requestUserId && Object.hasOwn(userRoles, requestUserId) ? userRoles[requestUserId] : null;
    if (!roleHint || !mapped || roleHint === mapped) return roleHint || mapped || (requestUserId ? this.roles.OPERATOR : null);
    // An explicit principal policy can narrow the permissions of an API key.
    const admin = this.roles.ADMIN || 'admin';
    if (roleHint === admin || (roleHint === this.roles.OPERATOR && mapped !== admin)) return mapped;
    if (mapped === admin || mapped === this.roles.OPERATOR) return roleHint;
    return this.roles.VIEWER || 'viewer';
  }

  allowsAction(userRole, action) {
    const isAdmin = userRole === (this.roles.ADMIN || 'admin');
    if (action === 'auth_token_rotate') return isAdmin;
    return isAdmin || userRole === this.roles.OPERATOR
      || action === 'routing_recommendation'
      || (userRole === this.roles.REVIEWER && action === 'campaign_pause');
  }

  /** Enforce the request policy and audit denials. */
  authorize(req, requestUserId, { action, projectId, campaignId, roleHint, ...additionalContext }) {
    const userRole = this.resolveRole(requestUserId, roleHint);
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!this.allowsAction(userRole, action)) {
      log.warn('RBAC denied', { userId: requestUserId, role: userRole, action, path });

      if (this.operatorAuditStore) {
        // Extract audit context from headers
        const source = req.headers['x-audit-source'] || null;
        const auditReason = req.headers['x-audit-reason'] || null;
        const correlationId = req.headers['x-correlation-id'] || null;
        const traceId = req.headers['x-trace-id'] || null;
        const dispatchId = req.headers['x-dispatch-id'] || null;

        // Construct resource identifier
        const resource = campaignId
          ? `campaign:${campaignId}`
          : projectId
            ? `project:${projectId}`
            : path;

        // Ensure we include projectId and campaignId in the entry if available
        const entry = {
          action: 'rbac_denied',
          operatorId: requestUserId || 'anonymous',
          role: userRole || 'none',
          path,
          method: req.method,
          status: 'failure',
          decision: 'deny',
          requestedAction: action || 'unknown',
          resource,
          timestamp: new Date().toISOString(),
          details: additionalContext?.details || `Unauthorized attempt for ${action || 'unknown action'}`,
          source,
          reason: auditReason,
          correlationId,
          traceId,
          dispatchId,
          ...additionalContext
        };

        if (projectId) entry.projectId = projectId;
        if (campaignId) entry.campaignId = campaignId;

        // Use single-argument append for maximum compatibility with mocks
        this.operatorAuditStore.append(entry);
      }
      return false;
    }

    return true;
  }

  /**
   * Simplified authorization check without HTTP request context.
   * Used for programmatic authorization checks (e.g., rollback endpoint).
   *
   * @param {object} params
   * @param {string} params.action - Action identifier (e.g., 'routing:rollback')
   * @param {string} params.resource - Resource identifier (e.g., 'routing_weights')
   * @param {string} params.operatorId - User ID attempting the action
   * @param {string} [params.projectId] - Optional project ID for scoping
   * @returns {object} - { allowed: boolean, reason?: string }
   */
  enforce({ action, resource, operatorId, projectId }) {
    const userRoles = this.config?.auth?.userRoles || {};
    // Default to 'operator' if not explicitly assigned
    const userRole = operatorId ? (userRoles[operatorId] || this.roles.OPERATOR) : null;

    let isAuthorized = false;
    let reason = null;

    // RBAC Policy Matrix Enforcement
    // Implementation of inheritance: admin > operator > reviewer > viewer

    // 1. admin role always authorized
    if (userRole === this.roles.ADMIN) {
      isAuthorized = true;
    }
    // 2. operator role authorized for all control-plane actions
    else if (userRole === this.roles.OPERATOR) {
      isAuthorized = true;
    }
    // 3. reviewer role (conditional)
    else if (userRole === this.roles.REVIEWER) {
      // Reviewers can only generate routing recommendations and pause campaigns
      if (action === 'routing_recommendation' || action === 'campaign_pause') {
        isAuthorized = true;
      } else {
        reason = `Role '${userRole}' is not authorized for action '${action}'`;
      }
    }
    // 4. support and viewer roles
    else {
      // Read-only actions like routing_recommendation are allowed for all
      if (action === 'routing_recommendation') {
        isAuthorized = true;
      } else {
        reason = `Role '${userRole}' is not authorized for action '${action}'`;
      }
    }

    if (!isAuthorized && !reason) {
      reason = `Insufficient permissions: role '${userRole || 'none'}' cannot perform '${action}'`;
    }

    return {
      allowed: isAuthorized,
      reason: reason || undefined,
    };
  }
}

export function createPolicyEngine(deps) {
  return new PolicyEngine(deps);
}
