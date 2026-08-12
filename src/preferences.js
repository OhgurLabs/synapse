// Preferences system — layered overrides on top of config.js defaults.
// Council-designed v1: key registry, CAS-protected storage, /prefs commands.
// Storage: .synapse/config.json → preferences, per-project → preferences.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import { assertSafeProjectId } from './safe-id.js';

/**
 * v1 preference schema registry.
 * Each key defines type, validation, default, and description.
 * Adding a new pref = adding one entry here.
 */
const SCHEMA = {
  theme: {
    type: 'string',
    enum: ['dark', 'light'],
    default: 'dark',
    description: 'UI color theme',
    scope: 'global',
  },
  defaultProject: {
    type: 'string',
    default: null,
    description: 'Default project on startup (null = last used)',
    scope: 'global',
    nullable: true,
  },
  defaultChannel: {
    type: 'string',
    default: null,
    description: 'Default channel on startup (null = last used)',
    scope: 'global',
    nullable: true,
  },
  showTimestamps: {
    type: 'boolean',
    default: true,
    description: 'Show message timestamps in the UI',
    scope: 'global',
  },
  showModelNames: {
    type: 'boolean',
    default: true,
    description: 'Show model name after agent name',
    scope: 'global',
  },
  compactMessages: {
    type: 'boolean',
    default: false,
    description: 'Compact message display (less padding)',
    scope: 'global',
  },
};

/**
 * Validate a value against a schema entry.
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateValue(key, value) {
  const def = SCHEMA[key];
  if (!def) return { valid: false, error: `Unknown preference key: "${key}". Valid keys: ${Object.keys(SCHEMA).join(', ')}` };

  if (value === null || value === 'null') {
    if (def.nullable) return { valid: true, parsed: null };
    return { valid: false, error: `"${key}" cannot be null` };
  }

  // Parse string input to the correct type
  let parsed = value;
  if (def.type === 'boolean') {
    if (value === 'true' || value === true) parsed = true;
    else if (value === 'false' || value === false) parsed = false;
    else return { valid: false, error: `"${key}" must be true or false` };
  } else if (def.type === 'number') {
    parsed = Number(value);
    if (!Number.isFinite(parsed)) return { valid: false, error: `"${key}" must be a number` };
    if (def.min != null && parsed < def.min) return { valid: false, error: `"${key}" must be >= ${def.min}` };
    if (def.max != null && parsed > def.max) return { valid: false, error: `"${key}" must be <= ${def.max}` };
  } else if (def.type === 'string') {
    parsed = String(value);
    if (def.enum && !def.enum.includes(parsed)) {
      return { valid: false, error: `"${key}" must be one of: ${def.enum.join(', ')}` };
    }
  }

  return { valid: true, parsed };
}

/**
 * Parse /prefs commands from user input.
 * Returns { command, args } or null.
 *
 * Supported:
 *   /prefs                    — show all prefs
 *   /prefs show               — show all prefs
 *   /prefs set <key> <value>  — set a preference
 *   /prefs reset <key>        — reset to default
 *   /prefs keys               — list available keys with descriptions
 */
export function parsePrefsCommand(text) {
  const trimmed = text.trim();

  if (trimmed === '/prefs' || trimmed === '/prefs show') {
    return { command: 'show', args: null };
  }

  if (trimmed === '/prefs keys') {
    return { command: 'keys', args: null };
  }

  const setMatch = trimmed.match(/^\/prefs\s+set\s+(\S+)\s+(.+)$/);
  if (setMatch) {
    return { command: 'set', args: { key: setMatch[1], value: setMatch[2].trim() } };
  }

  const resetMatch = trimmed.match(/^\/prefs\s+reset\s+(\S+)$/);
  if (resetMatch) {
    return { command: 'reset', args: { key: resetMatch[1] } };
  }

  if (trimmed.startsWith('/prefs')) {
    return { command: 'help', args: null };
  }

  return null;
}

export class PreferencesManager {
  constructor(stateManager) {
    this.stateManager = stateManager;
  }

  /**
   * Load global preferences from .synapse/config.json → preferences.
   */
  _loadGlobal() {
    try {
      const data = JSON.parse(readFileSync(this.stateManager.configPath, 'utf-8'));
      return data.preferences || {};
    } catch {
      return {};
    }
  }

  /**
   * Save global preferences to .synapse/config.json → preferences.
   * Preserves other config keys.
   */
  _saveGlobal(prefs) {
    let data = {};
    try {
      data = JSON.parse(readFileSync(this.stateManager.configPath, 'utf-8'));
    } catch { /* new file */ }
    data.preferences = prefs;
    const tmp = this.stateManager.configPath + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, this.stateManager.configPath);
  }

  /**
   * Load per-project preferences.
   */
  _loadProject(projectId) {
    assertSafeProjectId(projectId);
    const cfgPath = join(this.stateManager.projectsDir, projectId, 'config.json');
    try {
      const data = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      return data.preferences || {};
    } catch {
      return {};
    }
  }

  /**
   * Save per-project preferences.
   */
  _saveProject(projectId, prefs) {
    assertSafeProjectId(projectId);
    const cfgPath = join(this.stateManager.projectsDir, projectId, 'config.json');
    let data = {};
    try {
      data = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    } catch { /* new file */ }
    data.preferences = prefs;
    const tmp = cfgPath + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, cfgPath);
  }

  /**
   * Get effective preference value (merged: defaults → global → project).
   */
  get(key, projectId = null) {
    const def = SCHEMA[key];
    if (!def) return undefined;

    // Start with default
    let value = def.default;

    // Global override
    const global = this._loadGlobal();
    if (key in global) value = global[key];

    // Project override
    if (projectId) {
      const proj = this._loadProject(projectId);
      if (key in proj) value = proj[key];
    }

    return value;
  }

  /**
   * Get all effective preferences (merged).
   */
  getAll(projectId = null) {
    const global = this._loadGlobal();
    const proj = projectId ? this._loadProject(projectId) : {};
    const result = {};
    for (const [key, def] of Object.entries(SCHEMA)) {
      let value = def.default;
      if (key in global) value = global[key];
      if (key in proj) value = proj[key];
      result[key] = value;
    }
    return result;
  }

  /**
   * Set a preference. Validates against schema.
   * Returns { ok: true, key, value } or { error: string }.
   */
  set(key, value, projectId = null) {
    const validation = validateValue(key, value);
    if (!validation.valid) return { error: validation.error };

    if (projectId) {
      const prefs = this._loadProject(projectId);
      prefs[key] = validation.parsed;
      this._saveProject(projectId, prefs);
    } else {
      const prefs = this._loadGlobal();
      prefs[key] = validation.parsed;
      this._saveGlobal(prefs);
    }

    return { ok: true, key, value: validation.parsed };
  }

  /**
   * Reset a preference to default.
   * Returns { ok: true, key, default: value } or { error: string }.
   */
  reset(key, projectId = null) {
    const def = SCHEMA[key];
    if (!def) return { error: `Unknown preference key: "${key}". Valid keys: ${Object.keys(SCHEMA).join(', ')}` };

    if (projectId) {
      const prefs = this._loadProject(projectId);
      delete prefs[key];
      this._saveProject(projectId, prefs);
    } else {
      const prefs = this._loadGlobal();
      delete prefs[key];
      this._saveGlobal(prefs);
    }

    return { ok: true, key, default: def.default };
  }

  /**
   * Format all preferences for display.
   */
  formatPrefs(projectId = null) {
    const global = this._loadGlobal();
    const proj = projectId ? this._loadProject(projectId) : {};
    const lines = ['**Preferences**'];

    for (const [key, def] of Object.entries(SCHEMA)) {
      let value = def.default;
      let source = 'default';
      if (key in global) { value = global[key]; source = 'global'; }
      if (key in proj) { value = proj[key]; source = 'project'; }
      const display = value === null ? 'null' : String(value);
      lines.push(`  \`${key}\` = \`${display}\` *(${source})*`);
    }

    return lines.join('\n');
  }

  /**
   * Format available keys and descriptions.
   */
  formatKeys() {
    const lines = ['**Available Preference Keys**'];
    for (const [key, def] of Object.entries(SCHEMA)) {
      const type = def.enum ? def.enum.join('|') : def.type;
      const dflt = def.default === null ? 'null' : String(def.default);
      lines.push(`  \`${key}\` (${type}, default: ${dflt}) — ${def.description}`);
    }
    return lines.join('\n');
  }

  /**
   * Get the schema for external consumers (MCP, API).
   */
  getSchema() {
    return { ...SCHEMA };
  }
}
