// Domain Entities — concrete entities extending the Entity base class.
// Each defines a static schema, validates via that schema, and supports
// full round-trip serialization (toJSON / fromJSON).

import { Entity } from './entity.js';
import { Schema } from '../validation/schema.js';

// ── RateLimitPolicy ────────────────────────────────────────────────────

/**
 * Defines how rate limiting is applied for a given scope.
 */
export class RateLimitPolicy extends Entity {
  /** @type {import('../validation/schema.js').Schema} */
  static schema = Schema.object({
    name: Schema.string().min(1).max(255),
    maxTokens: Schema.number().min(0),
    refillRate: Schema.number().min(0),
    ttlMs: Schema.number().min(0),
    scope: Schema.enum(['user', 'ip', 'apikey']),
  });

  /**
   * @param {object} props
   * @param {string}  props.name       - Human-readable policy name
   * @param {number}  props.maxTokens  - Maximum tokens in the bucket
   * @param {number}  props.refillRate - Tokens added per refill interval
   * @param {number}  props.ttlMs     - Time-to-live in milliseconds
   * @param {'user'|'ip'|'apikey'} props.scope - Rate-limit scope
   */
  constructor(props = {}) {
    super(props);
    this.name = props.name;
    this.maxTokens = props.maxTokens;
    this.refillRate = props.refillRate;
    this.ttlMs = props.ttlMs;
    this.scope = props.scope;
  }

  validate() {
    return RateLimitPolicy.schema.validate({
      name: this.name,
      maxTokens: this.maxTokens,
      refillRate: this.refillRate,
      ttlMs: this.ttlMs,
      scope: this.scope,
    });
  }

  toJSON() {
    return {
      ...super.toJSON(),
      name: this.name,
      maxTokens: this.maxTokens,
      refillRate: this.refillRate,
      ttlMs: this.ttlMs,
      scope: this.scope,
    };
  }

  /**
   * @param {object} json
   * @returns {RateLimitPolicy}
   */
  static fromJSON(json) {
    return new RateLimitPolicy(json);
  }
}

// ── TrackedClient ──────────────────────────────────────────────────────

/**
 * A client being tracked for rate limiting.
 */
export class TrackedClient extends Entity {
  static schema = Schema.object({
    key: Schema.string().min(1),
    policyId: Schema.string().min(1),
    status: Schema.enum(['active', 'suspended', 'expired']),
  });

  /**
   * @param {object} props
   * @param {string} props.key      - Client identifier (IP, API key, etc.)
   * @param {string} props.policyId - ID of the associated RateLimitPolicy
   * @param {'active'|'suspended'|'expired'} [props.status='active']
   */
  constructor(props = {}) {
    super(props);
    this.key = props.key;
    this.policyId = props.policyId;
    this.status = props.status ?? 'active';
  }

  validate() {
    return TrackedClient.schema.validate({
      key: this.key,
      policyId: this.policyId,
      status: this.status,
    });
  }

  toJSON() {
    return {
      ...super.toJSON(),
      key: this.key,
      policyId: this.policyId,
      status: this.status,
    };
  }

  /**
   * @param {object} json
   * @returns {TrackedClient}
   */
  static fromJSON(json) {
    return new TrackedClient(json);
  }
}

// ── AuditEvent ─────────────────────────────────────────────────────────

/**
 * Records a rate-limiting decision for auditability.
 */
export class AuditEvent extends Entity {
  static schema = Schema.object({
    clientKey: Schema.string().min(1),
    action: Schema.enum(['allow', 'deny', 'reset', 'evict']),
    cost: Schema.number().min(0),
    remaining: Schema.number(),
    metadata: Schema.object().optional(),
  });

  /**
   * @param {object} props
   * @param {string} props.clientKey - Client identifier
   * @param {'allow'|'deny'|'reset'|'evict'} props.action - Decision made
   * @param {number} props.cost      - Token cost of the request
   * @param {number} props.remaining - Tokens remaining after decision
   * @param {object} [props.metadata={}] - Arbitrary extra context
   */
  constructor(props = {}) {
    super(props);
    this.clientKey = props.clientKey;
    this.action = props.action;
    this.cost = props.cost;
    this.remaining = props.remaining;
    this.metadata = props.metadata ?? {};
  }

  validate() {
    return AuditEvent.schema.validate({
      clientKey: this.clientKey,
      action: this.action,
      cost: this.cost,
      remaining: this.remaining,
      metadata: this.metadata,
    });
  }

  toJSON() {
    return {
      ...super.toJSON(),
      clientKey: this.clientKey,
      action: this.action,
      cost: this.cost,
      remaining: this.remaining,
      metadata: this.metadata,
    };
  }

  /**
   * @param {object} json
   * @returns {AuditEvent}
   */
  static fromJSON(json) {
    return new AuditEvent(json);
  }
}
