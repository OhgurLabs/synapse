import { mkdirSync } from 'fs';
import { dirname } from 'path';
import Database from '../persistence/sqlite-provider.js';
import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('tool-registry');

/**
 * ToolRegistry — SQLite persistence layer for MCP tool discovery and governance.
 *
 * Schema: tool_registry table
 * ──────────────────────────────────────────────────────────────────────
 *  Column              Type              Notes
 *  ─────────────────  ────────────────  ─────────────────────────────────────
 *  id                  TEXT              UUID primary key
 *  name                TEXT NOT NULL     Unique tool name (e.g. "fs.read_file")
 *  source              TEXT NOT NULL     MCP server that provided the tool
 *  approval_state      TEXT NOT NULL     pending/approved/denied (default: pending)
 *  allowed_roles       TEXT              JSON array of roles allowed to use
 *  metadata            TEXT              JSON object with description, inputSchema, etc.
 *  operation_category  TEXT              Category for fallback resolution (nullable)
 *  created_at          TEXT NOT NULL     ISO-8601 timestamp of insertion
 *  updated_at          TEXT NOT NULL     ISO-8601 timestamp of last update
 * ──────────────────────────────────────────────────────────────────────
 *
 * Indexes:
 *  - idx_tool_registry_name ON name (unique lookup)
 *  - idx_tool_registry_approval_state ON approval_state (filtering)
 *  - idx_tool_registry_operation_category ON operation_category (fallback lookup)
 *
 * Crash recovery: WAL journal mode + FULL synchronous ensures committed
 * writes survive process crashes. Uncommitted transactions are rolled
 * back automatically by SQLite on next open.
 */
class ToolRegistry {
  /**
   * @param {Object} options
   * @param {string} options.dbPath - Path to SQLite database file
   */
  constructor(options = {}) {
    if (!options.dbPath) {
      throw new TypeError('dbPath option is required');
    }

    this.dbPath = options.dbPath;

    this._ensureParentDir();
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');

    this._initializeSchema();
    this._prepareStatements();
  }

  _ensureParentDir() {
    if (this.dbPath === ':memory:') return;

    const dir = dirname(this.dbPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  _now() {
    return new Date().toISOString();
  }

  _initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_registry (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        approval_state TEXT NOT NULL DEFAULT 'pending' CHECK (approval_state IN ('pending', 'approved', 'denied')),
        allowed_roles TEXT,
        metadata TEXT,
        operation_category TEXT,
        transformation_rules TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this._migrateSchema();

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tool_registry_name ON tool_registry(name);
      CREATE INDEX IF NOT EXISTS idx_tool_registry_approval_state ON tool_registry(approval_state);
      CREATE INDEX IF NOT EXISTS idx_tool_registry_operation_category ON tool_registry(operation_category);
    `);
  }

  _prepareStatements() {
    this._insertToolStatement = this.db.prepare(`
      INSERT INTO tool_registry (id, name, source, approval_state, allowed_roles, metadata, operation_category, transformation_rules, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._getToolStatement = this.db.prepare(`
      SELECT id, name, source, approval_state, allowed_roles, metadata, operation_category, transformation_rules, created_at, updated_at
      FROM tool_registry
      WHERE id = ?
    `);

    this._getToolByNameStatement = this.db.prepare(`
      SELECT id, name, source, approval_state, allowed_roles, metadata, operation_category, transformation_rules, created_at, updated_at
      FROM tool_registry
      WHERE name = ?
    `);

    this._updateToolStatement = this.db.prepare(`
      UPDATE tool_registry
      SET name = ?, source = ?, approval_state = ?, allowed_roles = ?, metadata = ?, operation_category = ?, transformation_rules = ?, updated_at = ?
      WHERE id = ?
    `);

    this._deleteToolStatement = this.db.prepare(`
      DELETE FROM tool_registry WHERE id = ?
    `);

    this._setApprovalStateStatement = this.db.prepare(`
      UPDATE tool_registry SET approval_state = ?, updated_at = ? WHERE name = ?
    `);

    this._approveAllStatement = this.db.prepare(`
      UPDATE tool_registry SET approval_state = 'approved', updated_at = ? WHERE approval_state = 'pending'
    `);

    this._listToolsStatement = this.db.prepare(`
      SELECT id, name, source, approval_state, allowed_roles, metadata, operation_category, transformation_rules, created_at, updated_at
      FROM tool_registry
      WHERE 1=1
      ORDER BY created_at ASC
    `);

    this._upsertToolStatement = this.db.prepare(`
      INSERT INTO tool_registry (id, name, source, approval_state, allowed_roles, metadata, operation_category, transformation_rules, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        source = excluded.source,
        approval_state = tool_registry.approval_state,
        allowed_roles = excluded.allowed_roles,
        metadata = excluded.metadata,
        operation_category = excluded.operation_category,
        transformation_rules = excluded.transformation_rules,
        updated_at = excluded.updated_at
    `);

    this._getToolsByCategoryStatement = this.db.prepare(`
      SELECT id, name, source, approval_state, allowed_roles, metadata, operation_category, transformation_rules, created_at, updated_at
      FROM tool_registry
      WHERE operation_category = ?
      ORDER BY created_at ASC
    `);

    // Finds tools with the same base name (part after ':') but a different registered name.
    // Used for cross-server duplicate detection.
    this._findBaseNameConflictsStatement = this.db.prepare(`
      SELECT id, name, source FROM tool_registry
      WHERE (
        CASE WHEN INSTR(name, ':') > 0
          THEN SUBSTR(name, INSTR(name, ':') + 1)
          ELSE name
        END
      ) = ? AND name != ?
    `);
  }

  _migrateSchema() {
    const tableInfo = this.db.prepare("PRAGMA table_info(tool_registry)").all();
    const hasOperationCategory = tableInfo.some(col => col.name === 'operation_category');
    const hasTransformationRules = tableInfo.some(col => col.name === 'transformation_rules');

    if (!hasOperationCategory) {
      this.db.exec(`
        ALTER TABLE tool_registry
        ADD COLUMN operation_category TEXT
      `);
      log.info('migrated tool_registry: added operation_category column');
    }

    if (!hasTransformationRules) {
      this.db.exec(`
        ALTER TABLE tool_registry
        ADD COLUMN transformation_rules TEXT
      `);
      log.info('migrated tool_registry: added transformation_rules column');
    }
  }

  /**
   * Add a new tool to the registry.
   *
   * @param {string} name - Tool name (must be unique)
   * @param {string} source - MCP server that provided the tool
   * @param {Object} metadata - Additional tool metadata
   * @param {string} [metadata.approval_state] - Initial approval state (default: 'pending')
   * @param {Array<string>} [metadata.allowed_roles] - Roles allowed to use this tool
   * @param {string} [metadata.description] - Tool description
   * @param {Object} [metadata.inputSchema] - Tool input schema (JSON Schema format)
* @param {string} [metadata.operationCategory] - Category for fallback resolution
    * @param {Object} [metadata.transformationRules] - Per-tool transformation rules
    * @returns {Object} The created tool record
    * @throws {Error} If tool name already exists
    */
   addTool(name, source, metadata = {}) {
    if (!name) {
      throw new TypeError('name is required');
    }
    if (!source) {
      throw new TypeError('source is required');
    }

    // Check if tool already exists
    const existing = this._getToolByNameStatement.get(name);
    if (existing) {
      throw new Error(`Tool with name "${name}" already exists`);
    }

    const id = randomUUID();
    const approval_state = metadata.approval_state || 'pending';
    const allowed_roles = metadata.allowed_roles ? JSON.stringify(metadata.allowed_roles) : null;
    const operation_category = metadata.operationCategory || null;
    const transformation_rules = metadata.transformationRules ? JSON.stringify(metadata.transformationRules) : null;

    // Extract additional metadata (description, inputSchema, etc.) excluding governance fields
    const { approval_state: _, allowed_roles: __, operationCategory: ___, transformationRules: ____, ...additionalMetadata } = metadata;
    const metadataJson = Object.keys(additionalMetadata).length > 0
      ? JSON.stringify(additionalMetadata)
      : null;

    const now = this._now();

    this._insertToolStatement.run(
      id,
      name,
      source,
      approval_state,
      allowed_roles,
      metadataJson,
      operation_category,
      transformation_rules,
      now,
      now
    );

    log.info({ id, name, source, approval_state, operation_category }, 'tool added to registry');

    return this.getTool(id);
  }

  /**
   * Alias for upsertTool for backwards compatibility.
   * @deprecated Use upsertTool instead
   */
  registerTool(source, name, metadata = {}) {
    return this.upsertTool(name, source, metadata);
  }

  /**
   * Get a tool by ID.
   *
   * @param {string} id - Tool ID
   * @returns {Object|null} Tool record or null if not found
   */
  getTool(id) {
    if (!id) {
      throw new TypeError('id is required');
    }

    const row = this._getToolStatement.get(id);
    if (!row) {
      return null;
    }

    return this._deserializeTool(row);
  }

  /**
   * Get a tool by name.
   *
   * @param {string} name - Tool name
   * @returns {Object|null} Tool record or null if not found
   */
  getToolByName(name) {
    if (!name) {
      throw new TypeError('name is required');
    }

    const row = this._getToolByNameStatement.get(name);
    if (!row) {
      return null;
    }

    return this._deserializeTool(row);
  }

  /**
   * Update a tool's metadata.
   *
   * @param {string} id - Tool ID
   * @param {Object} updates - Fields to update
   * @param {string} [updates.name] - New tool name
   * @param {string} [updates.source] - New source
   * @param {string} [updates.approval_state] - New approval state
   * @param {Array<string>} [updates.allowed_roles] - New allowed roles
* @param {string} [updates.operationCategory] - New operation category
    * @param {Object} [updates.transformationRules] - New transformation rules
    * @returns {Object} Updated tool record
    * @throws {Error} If tool not found
    */
   updateTool(id, updates = {}) {
    if (!id) {
      throw new TypeError('id is required');
    }

    // Get current tool to ensure it exists
    const current = this.getTool(id);
    if (!current) {
      throw new Error(`Tool with id "${id}" not found`);
    }

    // Merge updates with current values
    const name = updates.name !== undefined ? updates.name : current.name;
    const source = updates.source !== undefined ? updates.source : current.source;
    const approval_state = updates.approval_state !== undefined ? updates.approval_state : current.approval_state;
    const allowed_roles = updates.allowed_roles !== undefined
      ? JSON.stringify(updates.allowed_roles)
      : (current.allowed_roles ? JSON.stringify(current.allowed_roles) : null);
    const operation_category = updates.operationCategory !== undefined
      ? updates.operationCategory
      : current.operation_category;
    const transformation_rules = updates.transformationRules !== undefined
      ? (updates.transformationRules ? JSON.stringify(updates.transformationRules) : null)
      : (current.transformation_rules ? JSON.stringify(current.transformation_rules) : null);

    // Handle metadata updates (merge with existing metadata)
    let metadataJson;
    if (updates.description !== undefined || updates.inputSchema !== undefined) {
      const currentMetadata = current.metadata || {};
      const newMetadata = {
        ...currentMetadata,
        ...(updates.description !== undefined && { description: updates.description }),
        ...(updates.inputSchema !== undefined && { inputSchema: updates.inputSchema })
      };
      metadataJson = Object.keys(newMetadata).length > 0 ? JSON.stringify(newMetadata) : null;
    } else {
      metadataJson = current.metadata ? JSON.stringify(current.metadata) : null;
    }

    const now = this._now();

    const result = this._updateToolStatement.run(
      name,
      source,
      approval_state,
      allowed_roles,
      metadataJson,
      operation_category,
      transformation_rules,
      now,
      id
    );

    if (result.changes === 0) {
      throw new Error(`Failed to update tool with id "${id}"`);
    }

    log.info({ id, updates }, 'tool updated');

    return this.getTool(id);
  }

  /**
   * Delete a tool from the registry.
   *
   * @param {string} id - Tool ID
   * @returns {boolean} true if deleted, false if not found
   */
  deleteTool(id) {
    if (!id) {
      throw new TypeError('id is required');
    }

    const result = this._deleteToolStatement.run(id);

    if (result.changes > 0) {
      log.info({ id }, 'tool deleted from registry');
      return true;
    }

    return false;
  }

  /**
   * Extract the base name from a potentially namespace-prefixed tool name.
   * For 'filesystem:read_file' returns 'read_file'. For 'read_file' returns 'read_file'.
   *
   * @private
   * @param {string} name - Tool name, optionally prefixed with 'serverId:'
   * @returns {string} Base name without namespace prefix
   */
  _extractBaseName(name) {
    const colonIdx = name.indexOf(':');
    return colonIdx !== -1 ? name.slice(colonIdx + 1) : name;
  }

  /**
   * Upsert a tool (insert or update based on name+source).
   *
   * @param {string} name - Tool name
   * @param {string} source - MCP server that provided the tool
   * @param {Object} metadata - Additional tool metadata
   * @param {string} [metadata.approval_state] - Approval state (preserved on update)
   * @param {Array<string>} [metadata.allowed_roles] - Roles allowed to use this tool
   * @param {string} [metadata.description] - Tool description
   * @param {Object} [metadata.inputSchema] - Tool input schema (JSON Schema format)
* @param {string} [metadata.operationCategory] - Category for fallback resolution
    * @param {Object} [metadata.transformationRules] - Per-tool transformation rules
    * @returns {Object} The created or updated tool record
    */
   upsertTool(name, source, metadata = {}) {
    if (!name) {
      throw new TypeError('name is required');
    }
    if (!source) {
      throw new TypeError('source is required');
    }

    // Duplicate detection: warn when two different servers register tools with the same base name.
    const baseName = this._extractBaseName(name);
    const conflicts = this._findBaseNameConflictsStatement.all(baseName, name);
    if (conflicts.length > 0) {
      for (const conflict of conflicts) {
        log.warn(
          {
            incomingName: name,
            incomingSource: source,
            existingName: conflict.name,
            existingSource: conflict.source,
            baseName
          },
          `duplicate base tool name "${baseName}" registered by multiple servers`
        );
      }
    }

    const existing = this._getToolByNameStatement.get(name);
    const now = this._now();
    const operation_category = metadata.operationCategory || null;

    if (existing) {
      const allowed_roles = metadata.allowed_roles ? JSON.stringify(metadata.allowed_roles) : null;
      const transformation_rules = metadata.transformationRules !== undefined
        ? (metadata.transformationRules ? JSON.stringify(metadata.transformationRules) : null)
        : existing.transformation_rules;

      // Merge new metadata with existing metadata
      const { approval_state: _, allowed_roles: __, operationCategory: ___, transformationRules: ____, ...newMetadata } = metadata;
      const existingMetadata = existing.metadata ? JSON.parse(existing.metadata) : {};
      const mergedMetadata = { ...existingMetadata, ...newMetadata };
      const metadataJson = Object.keys(mergedMetadata).length > 0
        ? JSON.stringify(mergedMetadata)
        : null;

      this._upsertToolStatement.run(
        existing.id,
        name,
        source,
        existing.approval_state,
        allowed_roles,
        metadataJson,
        operation_category,
        transformation_rules,
        existing.created_at,
        now
      );
      log.info({ id: existing.id, name, source, operation_category }, 'tool updated via upsert');
    } else {
      const id = randomUUID();
      const approval_state = metadata.approval_state || 'pending';
      const allowed_roles = metadata.allowed_roles ? JSON.stringify(metadata.allowed_roles) : null;
      const transformation_rules = metadata.transformationRules ? JSON.stringify(metadata.transformationRules) : null;

      // Extract additional metadata (description, inputSchema, etc.) excluding governance fields
      const { approval_state: _, allowed_roles: __, operationCategory: ___, transformationRules: ____, ...additionalMetadata } = metadata;
      const metadataJson = Object.keys(additionalMetadata).length > 0
        ? JSON.stringify(additionalMetadata)
        : null;

      this._upsertToolStatement.run(
        id,
        name,
        source,
        approval_state,
        allowed_roles,
        metadataJson,
        operation_category,
        transformation_rules,
        now,
        now
      );
      log.info({ id, name, source, approval_state, operation_category }, 'tool inserted via upsert');
    }

    return this.getToolByName(name);
  }

  /**
   * List tools with optional filtering.
   *
   * @param {Object} filters - Optional filters
   * @param {string} [filters.approval_state] - Filter by approval state
   * @param {string} [filters.source] - Filter by source
   * @returns {Array<Object>} Array of tool records
   */
  listTools(filters = {}) {
    let query = `
      SELECT id, name, source, approval_state, allowed_roles, metadata, operation_category, transformation_rules, created_at, updated_at
      FROM tool_registry
      WHERE 1=1
    `;
    const params = [];

    if (filters.approval_state) {
      query += ` AND approval_state = ?`;
      params.push(filters.approval_state);
    }

    if (filters.source) {
      query += ` AND source = ?`;
      params.push(filters.source);
    }

    query += ` ORDER BY created_at ASC`;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params);

    return rows.map(row => this._deserializeTool(row));
  }

  /**
   * List approved tools for a specific role.
   *
   * @param {string} role - Role to filter by
   * @returns {Array<Object>} Array of approved tools accessible by the role
   */
  listApprovedToolsForRole(role) {
    const tools = this.listTools({ approval_state: 'approved' });

    // A missing role means PUBLIC TOOLS ONLY, not an error.
    //
    // This used to `throw new TypeError('role is required')`, and the caller
    // hands it a null on purpose: tool-distribution-service.js:158 and :242 both
    // do `const role = agent.role || null` immediately before calling. So an
    // agent without a role threw — and distributeToAgent is invoked inside a
    // per-agent try/catch in the bulk distributor (:128-132) that only
    // log.error()s, so the throw was swallowed and that agent silently received
    // ZERO TOOLS while the run reported success. Silent tool starvation, visible
    // only as one log line.
    //
    // Returning the public subset is also the SAFE direction: tools carrying an
    // allowed_roles restriction stay excluded, so a role-less agent gets strictly
    // less than any role would grant, never more.
    if (typeof role !== 'string' || role.length === 0) {
      return tools.filter(tool => !tool.allowed_roles || tool.allowed_roles.length === 0);
    }

    if (role === 'admin') {
      return tools;
    }

    return tools.filter(tool => {
      if (!tool.allowed_roles || tool.allowed_roles.length === 0) {
        return true;
      }
      return tool.allowed_roles.includes(role);
    });
  }

  setApprovalState(name, state) {
    if (!name || typeof name !== 'string') {
      throw new TypeError('name is required');
    }
    if (!['pending', 'approved', 'denied'].includes(state)) {
      throw new TypeError('state must be pending, approved, or denied');
    }
    const now = this._now();
    const result = this._setApprovalStateStatement.run(state, now, name);
    return { name, state, changes: result.changes };
  }

  approveAll() {
    const now = this._now();
    const result = this._approveAllStatement.run(now);
    return { approved: result.changes };
  }

  /**
   * Remove all tools from a specific source (MCP server).
   * Used when a server disconnects to unregister its tools.
   *
   * @param {string} serverId - MCP server ID to remove tools from
   * @returns {number} Count of deleted tools
   */
  removeToolsBySource(serverId) {
    if (!serverId) {
      throw new TypeError('serverId is required');
    }

    const tools = this.listTools({ source: serverId });
    const count = tools.length;

    if (count === 0) {
      log.info({ serverId }, 'no tools found for source');
      return 0;
    }

    for (const tool of tools) {
      this._deleteToolStatement.run(tool.id);
    }

    log.info({ serverId, count }, 'tools removed from registry by source');
    return count;
  }

  /**
   * Deserialize a tool row from SQLite.
   *
   * @private
   * @param {Object} row - Raw row from SQLite
   * @returns {Object} Deserialized tool object
   */
  _deserializeTool(row) {
    return {
      id: row.id,
      name: row.name,
      source: row.source,
      approval_state: row.approval_state,
      allowed_roles: row.allowed_roles ? JSON.parse(row.allowed_roles) : null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      operation_category: row.operation_category || null,
      transformation_rules: row.transformation_rules ? JSON.parse(row.transformation_rules) : null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  /**
   * Get all tools by operation category.
   * Used for fallback resolution when circuit breaker opens.
   *
   * @param {string} category - Operation category to filter by
   * @returns {Array<Object>} Array of tool records in the category
   */
  getToolsByCategory(category) {
    if (!category) {
      throw new TypeError('category is required');
    }

    const rows = this._getToolsByCategoryStatement.all(category);
    return rows.map(row => this._deserializeTool(row));
  }

  close() {
    this.db.close();
  }
}

export { ToolRegistry };
