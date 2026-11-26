// Type declarations for src/models/domain-entities.js

import { Entity, EntityJSON, ValidationResult } from './entity.js';
import { Validator } from '../validation/schema.js';

// ── RateLimitPolicy ────────────────────────────────────────────────────

export type RateLimitScope = 'user' | 'ip' | 'apikey';

export interface RateLimitPolicyJSON extends EntityJSON {
  name: string;
  maxTokens: number;
  refillRate: number;
  ttlMs: number;
  scope: RateLimitScope;
}

export declare class RateLimitPolicy extends Entity {
  static schema: Validator;

  name: string;
  maxTokens: number;
  refillRate: number;
  ttlMs: number;
  scope: RateLimitScope;

  constructor(props?: Partial<RateLimitPolicyJSON>);
  validate(): ValidationResult;
  toJSON(): RateLimitPolicyJSON;
  static fromJSON(json: RateLimitPolicyJSON): RateLimitPolicy;
}

// ── TrackedClient ──────────────────────────────────────────────────────

export type ClientStatus = 'active' | 'suspended' | 'expired';

export interface TrackedClientJSON extends EntityJSON {
  key: string;
  policyId: string;
  status: ClientStatus;
}

export declare class TrackedClient extends Entity {
  static schema: Validator;

  key: string;
  policyId: string;
  status: ClientStatus;

  constructor(props?: Partial<TrackedClientJSON>);
  validate(): ValidationResult;
  toJSON(): TrackedClientJSON;
  static fromJSON(json: TrackedClientJSON): TrackedClient;
}

// ── AuditEvent ─────────────────────────────────────────────────────────

export type AuditAction = 'allow' | 'deny' | 'reset' | 'evict';

export interface AuditEventJSON extends EntityJSON {
  clientKey: string;
  action: AuditAction;
  cost: number;
  remaining: number;
  metadata: Record<string, unknown>;
}

export declare class AuditEvent extends Entity {
  static schema: Validator;

  clientKey: string;
  action: AuditAction;
  cost: number;
  remaining: number;
  metadata: Record<string, unknown>;

  constructor(props?: Partial<AuditEventJSON>);
  validate(): ValidationResult;
  toJSON(): AuditEventJSON;
  static fromJSON(json: AuditEventJSON): AuditEvent;
}
