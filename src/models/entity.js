// Entity — base class for all domain entities.
// Provides: id (UUID v4), createdAt/updatedAt (ISO-8601), serialization, validation stub.

import { randomUUID } from 'node:crypto';

export class Entity {
  /**
   * @param {object} [props] - Optional property overrides (used by fromJSON).
   */
  constructor(props = {}) {
    const now = new Date().toISOString();
    this.id = props.id ?? randomUUID();
    this.createdAt = props.createdAt ?? now;
    this.updatedAt = props.updatedAt ?? now;
  }

  /**
   * Touch the updatedAt timestamp.
   */
  touch() {
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Validate the entity.  Base implementation always passes;
   * subclasses override with schema-backed validation.
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate() {
    return { valid: true, errors: [] };
  }

  /**
   * Serialize to a plain JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Deserialize from a plain object.
   * @param {object} json
   * @returns {Entity}
   */
  static fromJSON(json) {
    return new Entity(json);
  }
}
