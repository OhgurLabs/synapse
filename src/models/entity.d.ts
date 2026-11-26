// Type declarations for src/models/entity.js

/** JSON-safe representation of an Entity. */
export interface EntityJSON {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/** Validation result returned by validate(). */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Base class for all domain entities.
 * Provides auto-generated UUID id, ISO-8601 timestamps, and serialization.
 */
export declare class Entity {
  id: string;
  createdAt: string;
  updatedAt: string;

  constructor(props?: Partial<EntityJSON>);

  /** Update the updatedAt timestamp to now. */
  touch(): void;

  /** Validate the entity. Base implementation always returns valid. */
  validate(): ValidationResult;

  /** Serialize to a plain JSON-safe object. */
  toJSON(): EntityJSON;

  /** Deserialize from a plain object. */
  static fromJSON(json: EntityJSON): Entity;
}
