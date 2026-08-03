/**
 * Agent config validation schema and validator.
 *
 * Validates patch objects before applying them to an existing agent config.
 * Returns { valid: boolean, errors: string[] } with actionable messages.
 */

// Fields that may appear in a config patch
const ALLOWED_FIELDS = new Set([
  'model',
  'displayModel',
  'role',
  'permissions',
  'denyActions',
  'skills',
  'color',
  'name',
  'persona',
  'personaFile',
  'timeout',
  'sandboxLimits',
  'cliPath',
  'cliArgs',
  'harnessOptions',
  'endpoint',
  'baseUrl',
  'apiKeyEnv',
  'lastValidationError',
  'bypassCodeExecutionCheck',
  // 'provider' is immutable, handled separately for specific validation
]);

// Known action strings (keys of ACTION_PERMISSIONS in permissions.js)
const KNOWN_ACTIONS = new Set([
  'conversation:respond',
  'code:execute',
  'task:plan',
  'task:execute',
  'code:review',
  'research:web',
  'research:codebase',
]);

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Validate a config patch against the existing agent and project config.
 *
 * @param {Object} patch            - Partial agent config to apply
 * @param {Object} existingAgent    - The current agent config object
 * @param {Object} rolesConfig      - Map of role name → { permissions: [] }
 * @param {Object} [providerDefaults] - Map of provider name -> { model, color }
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateAgentConfig(patch, existingAgent, rolesConfig, providerDefaults = {}) {
  const errors = [];

  // Empty patch is always valid
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    errors.push('Patch must be a non-null object.');
    return { valid: false, errors };
  }

  const keys = Object.keys(patch);

  // Allow empty patch (no-op)
  if (keys.length === 0) {
    return { valid: true, errors: [] };
  }

  // Reject unknown fields
  for (const key of keys) {
    if (!ALLOWED_FIELDS.has(key) && key !== 'provider') { // 'provider' handled separately
      errors.push(`Unknown field "${key}". Allowed fields: ${[...ALLOWED_FIELDS, 'provider (immutable)'].join(', ')}.`);
    }
  }

  // provider: immutable, and must be a known provider if present in patch (for error clarity)
  if ('provider' in patch) {
    // If the provider is being changed, it's immutable
    if (patch.provider !== existingAgent.provider) {
      errors.push('Field "provider" is immutable and cannot be changed after agent creation.');
    }
    // Also validate if the provider is a known one. This covers cases where initial config
    // might have had an invalid provider, or if the patch is trying to set an invalid provider.
    if (!Object.prototype.hasOwnProperty.call(providerDefaults, patch.provider)) {
      errors.push(`Invalid provider "${patch.provider}". Known providers: ${Object.keys(providerDefaults).join(', ') || '(none defined)'}.`);
    }
  }

  // model: non-empty string
  if ('model' in patch) {
    if (typeof patch.model !== 'string' || patch.model.trim() === '') {
      errors.push('Field "model" must be a non-empty string (e.g. "claude-sonnet-4-6").');
    }
  }

  // name: non-empty string. Hard cap = 12 (≤8 displays without truncation
  // on the standard agent badge; 9-12 truncates with ellipsis but full name
  // shows in the tooltip and chat sender labels). Governors get 18 to fit
  // "governor-" (9) + 9-char identifier convention.
  if ('name' in patch) {
    if (typeof patch.name !== 'string' || patch.name.trim() === '') {
      errors.push('Field "name" must be a non-empty string.');
    } else {
      const trimmed = patch.name.trim();
      const isGovernor = /^governor-/i.test(trimmed);
      const max = isGovernor ? 18 : 12;
      if (trimmed.length > max) {
        errors.push(`Field "name" must be ${max} characters or fewer (got ${trimmed.length}).`);
      }
    }
  }

  // color: valid hex color
  if ('color' in patch) {
    if (typeof patch.color !== 'string' || !COLOR_RE.test(patch.color)) {
      errors.push(`Field "color" must be a valid 6-digit hex color string (e.g. "#a3b4c5"), got: ${JSON.stringify(patch.color)}.`);
    }
  }

  // timeout: positive integer
  if ('timeout' in patch) {
    const t = patch.timeout;
    if (!Number.isInteger(t) || t <= 0) { // Must be positive
      errors.push(`Field "timeout" must be a positive integer (milliseconds), got: ${JSON.stringify(t)}.`);
    }
  }

  // cliPath: non-empty string or null (null = revert to provider default)
  if ('cliPath' in patch) {
    if (patch.cliPath !== null && (typeof patch.cliPath !== 'string' || patch.cliPath.trim() === '')) {
      errors.push('Field "cliPath" must be a non-empty string (e.g. "claudecode", "opencode", "/usr/local/bin/hermes") or null to use the provider default.');
    }
  }

  // cliArgs: array of strings or null (null = revert to provider default)
  if ('cliArgs' in patch) {
    if (patch.cliArgs !== null && !Array.isArray(patch.cliArgs)) {
      errors.push('Field "cliArgs" must be an array of strings (e.g. ["--chrome", "-y"]) or null.');
    } else if (Array.isArray(patch.cliArgs)) {
      for (const arg of patch.cliArgs) {
        if (typeof arg !== 'string') {
          errors.push(`Each entry in "cliArgs" must be a string, got: ${JSON.stringify(arg)}.`);
        }
      }
    }
  }

  // harnessOptions: plain object or null (null = revert to provider default)
  if ('harnessOptions' in patch) {
    if (patch.harnessOptions !== null && (typeof patch.harnessOptions !== 'object' || Array.isArray(patch.harnessOptions))) {
      errors.push('Field "harnessOptions" must be a plain object (e.g. {"chrome": true}) or null.');
    }
  }

  // role: must exist in rolesConfig, or null (use provider/system default)
  if ('role' in patch) {
    if (patch.role === null) {
      // null is allowed — clears role and falls back to default
    } else if (typeof patch.role !== 'string' || patch.role.trim() === '') {
      errors.push('Field "role" must be a non-empty string or null.');
    } else if (rolesConfig && !Object.prototype.hasOwnProperty.call(rolesConfig, patch.role)) {
      const known = Object.keys(rolesConfig).join(', ') || '(none defined)';
      errors.push(`Unknown role "${patch.role}". Known roles: ${known}.`);
    }
  }

  // permissions: array of known action strings, or null (use role default)
  if ('permissions' in patch) {
    if (patch.permissions === null) {
      // null is allowed — clears explicit permissions, falls back to role default
    } else if (!Array.isArray(patch.permissions)) {
      errors.push('Field "permissions" must be an array of action strings or null.');
    } else {
      for (const action of patch.permissions) {
        if (typeof action !== 'string') {
          errors.push(`Each entry in "permissions" must be a string, got: ${JSON.stringify(action)}.`);
        } else if (!KNOWN_ACTIONS.has(action)) {
          errors.push(`Unknown action "${action}" in permissions. Known actions: ${[...KNOWN_ACTIONS].join(', ')}.`);
        }
      }
    }
  }

  // denyActions: array of known action strings, or null (no deny list)
  if ('denyActions' in patch) {
    if (patch.denyActions === null) {
      // null is allowed — clears the deny list
    } else if (!Array.isArray(patch.denyActions)) {
      errors.push('Field "denyActions" must be an array of action strings or null.');
    } else {
      for (const action of patch.denyActions) {
        if (typeof action !== 'string') {
          errors.push(`Each entry in "denyActions" must be a string, got: ${JSON.stringify(action)}.`);
        } else if (!KNOWN_ACTIONS.has(action)) {
          errors.push(`Unknown action "${action}" in denyActions. Known actions: ${[...KNOWN_ACTIONS].join(', ')}.`);
        }
      }
    }
  }

  // skills: array of strings (no further constraint defined)
  if ('skills' in patch) {
    if (!Array.isArray(patch.skills)) {
      errors.push('Field "skills" must be an array of strings.');
    } else {
      for (const skill of patch.skills) {
        if (typeof skill !== 'string') {
          errors.push(`Each entry in "skills" must be a string, got: ${JSON.stringify(skill)}.`);
        }
      }
    }
  }

  // persona: string or null (null = no inline persona)
  if ('persona' in patch) {
    if (patch.persona !== null && typeof patch.persona !== 'string') {
      errors.push('Field "persona" must be a string or null.');
    }
  }

  // personaFile: non-empty string path or null (null = no external persona file)
  if ('personaFile' in patch) {
    if (patch.personaFile !== null && (typeof patch.personaFile !== 'string' || patch.personaFile.trim() === '')) {
      errors.push('Field "personaFile" must be a non-empty string path or null.');
    }
  }

  // sandboxLimits: plain object, or null (use provider defaults)
  if ('sandboxLimits' in patch) {
    if (patch.sandboxLimits === null) {
      // null is allowed — falls back to provider/system default sandbox limits
    } else if (typeof patch.sandboxLimits !== 'object' || Array.isArray(patch.sandboxLimits)) {
      errors.push('Field "sandboxLimits" must be a plain object or null.');
    }
  }

  // displayModel: optional short label (≤20 chars) or null
  if ('displayModel' in patch) {
    if (patch.displayModel !== null && typeof patch.displayModel !== 'string') {
      errors.push('Field "displayModel" must be a string or null.');
    } else if (typeof patch.displayModel === 'string' && patch.displayModel.length > 20) {
      errors.push('Field "displayModel" must be 20 characters or fewer.');
    }
  }

  // baseUrl: optional URL string or null. No URL parsing — user is responsible for the syntax.
  if ('baseUrl' in patch) {
    if (patch.baseUrl !== null && typeof patch.baseUrl !== 'string') {
      errors.push('Field "baseUrl" must be a string or null.');
    }
  }

  // apiKeyEnv: optional env var name or null. Simple identifier check.
  if ('apiKeyEnv' in patch) {
    if (patch.apiKeyEnv !== null && typeof patch.apiKeyEnv !== 'string') {
      errors.push('Field "apiKeyEnv" must be a string or null.');
    } else if (typeof patch.apiKeyEnv === 'string' && patch.apiKeyEnv.trim() !== '' && !/^[A-Z_][A-Z0-9_]*$/i.test(patch.apiKeyEnv.trim())) {
      errors.push('Field "apiKeyEnv" must be a valid env var name (letters, digits, underscore; not starting with a digit).');
    }
  }

  // lastValidationError: optional string or null. Server-managed, but accept on patch for retry/clear flows.
  if ('lastValidationError' in patch) {
    if (patch.lastValidationError !== null && typeof patch.lastValidationError !== 'string') {
      errors.push('Field "lastValidationError" must be a string or null.');
    }
  }

  // bypassCodeExecutionCheck: boolean or null
  if ('bypassCodeExecutionCheck' in patch) {
    if (patch.bypassCodeExecutionCheck !== null && typeof patch.bypassCodeExecutionCheck !== 'boolean') {
      errors.push('Field "bypassCodeExecutionCheck" must be a boolean or null.');
    }
  }

  // Detect permissions / denyActions overlap
  if (
    Array.isArray(patch.permissions) &&
    Array.isArray(patch.denyActions)
  ) {
    const permSet = new Set(patch.permissions);
    const overlap = patch.denyActions.filter(a => permSet.has(a));
    if (overlap.length > 0) {
      errors.push(
        `Conflicting config: action(s) appear in both "permissions" and "denyActions": ${overlap.join(', ')}. Remove them from one list.`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
