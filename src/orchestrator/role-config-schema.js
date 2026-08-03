// src/orchestrator/role-config-schema.js

export const ROLE_CONFIG_SCHEMA_VERSION = '1';

export const TOOL_ACCESS_ROLES = [
  'researcher',
  'executor',
  'reviewer',
  'architect',
  'governor',
];

export const DEFAULT_TOOL_ACCESS_ROLE = 'researcher';

export const DEFAULT_ROLE_TOOL_ACCESS = {
  architect: 'architect',
  developer: 'executor',
  reviewer: 'reviewer',
  governor: 'governor',
  researcher: 'researcher',
};

export const DEFAULT_ROLE_CONFIG = {
  architect: {
    permissions: ['code:execute', 'task:execute', 'task:plan'],
    toolAccessRole: 'architect',
    tools: { allow: [], deny: [], allow_all_tools: false },
  },
  developer: {
    permissions: ['code:execute', 'task:execute', 'task:plan'],
    toolAccessRole: 'executor',
    tools: { allow: [], deny: [], allow_all_tools: false },
  },
  reviewer: {
    permissions: ['code:execute', 'task:execute', 'task:plan'],
    toolAccessRole: 'reviewer',
    tools: { allow: [], deny: [], allow_all_tools: false },
  },
  governor: {
    permissions: ['code:execute', 'task:execute'],
    toolAccessRole: 'governor',
    tools: { allow: [], deny: [], allow_all_tools: false },
  },
  researcher: {
    permissions: ['code:execute', 'task:execute', 'task:plan'],
    toolAccessRole: 'researcher',
    tools: { allow: [], deny: [], allow_all_tools: false },
  },
};

export function resolveToolAccessRole(role, fallback = DEFAULT_TOOL_ACCESS_ROLE) {
  if (!role || typeof role !== 'string') {
    return fallback;
  }

  const normalized = role.trim().toLowerCase();
  if (TOOL_ACCESS_ROLES.includes(normalized)) {
    return normalized;
  }

  const mapped = DEFAULT_ROLE_TOOL_ACCESS[normalized];
  if (mapped && TOOL_ACCESS_ROLES.includes(mapped)) {
    return mapped;
  }

  return normalized;
}

export const ROLE_CONFIG_FALLBACK_POLICY = {
  missingFile: 'Use DEFAULT_ROLE_CONFIG and log at info level.',
  invalidJson: 'Use DEFAULT_ROLE_CONFIG and log a clear parse error.',
  invalidTopLevelSchema: 'Use DEFAULT_ROLE_CONFIG and log all schema validation errors.',
  missingRoleEntry: 'Use DEFAULT_ROLE_CONFIG[roleName] when present, otherwise permissions: [] and default tool access.',
  missingPermissions: 'Use [] for that role entry.',
  invalidPermissions: 'Ignore that role entry, warn, and use the matching built-in role default when present.',
  missingToolAccessRole: 'Use DEFAULT_ROLE_TOOL_ACCESS[roleName] when present; otherwise use the role name if it is a valid tool-access role; otherwise use DEFAULT_TOOL_ACCESS_ROLE.',
  invalidToolAccessRole: 'Warn and use the same fallback as missingToolAccessRole.',
  missingTools: 'Use an empty role-level tool policy with allow_all_tools disabled.',
  invalidTools: 'Ignore the role-level tool policy and use the matching built-in default when present.',
};

const permissionArraySchema = {
  type: 'array',
  items: {
    type: 'string',
    minLength: 1,
  },
  uniqueItems: true,
  default: [],
};

const roleDefinitionSchema = {
  type: 'object',
  description: 'Agent role definition. toolAccessRole is optional so loaders can apply deterministic per-role fallbacks.',
  properties: {
    permissions: permissionArraySchema,
    toolAccessRole: {
      type: 'string',
      enum: TOOL_ACCESS_ROLES,
      description: 'Tool distribution role used by ToolRegistry.listApprovedToolsForRole().',
    },
    tools: {
      type: 'object',
      description: 'Role-level MCP tool policy inherited by agents with this role. Agent-level tools config may tighten or explicitly override it.',
      additionalProperties: false,
      properties: {
        allow: permissionArraySchema,
        deny: permissionArraySchema,
        allow_all_tools: {
          type: 'boolean',
          default: false,
          description: 'Escape hatch: expose all approved MCP tools for this role. Distribution must audit every use.',
        },
        allowAllTools: {
          type: 'boolean',
          default: false,
          description: 'Camel-case alias for allow_all_tools.',
        },
      },
      default: {
        allow: [],
        deny: [],
        allow_all_tools: false,
      },
    },
  },
  additionalProperties: false,
  default: {
    permissions: [],
    tools: {
      allow: [],
      deny: [],
      allow_all_tools: false,
    },
  },
};

/**
 * JSON Schema for .synapse/role-config.json.
 *
 * Shape:
 * {
 *   "schemaVersion": "1",
 *   "roles": {
 *     "developer": {
 *       "permissions": ["code:execute"],
 *       "toolAccessRole": "executor"
 *     }
 *   }
 * }
 *
 * This schema validates the file shape. Per-role fallback behavior is defined
 * in ROLE_CONFIG_FALLBACK_POLICY because JSON Schema cannot express dynamic
 * "fall back to this role name" normalization.
 */
export const ROLE_CONFIG_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://synapse.local/schemas/role-config.schema.json',
  title: 'Synapse Agent Role Configuration',
  description: 'JSON-configurable agent role definitions for action permissions and MCP tool-access role mapping.',
  type: 'object',
  required: ['schemaVersion', 'roles'],
  additionalProperties: false,
  properties: {
    schemaVersion: {
      type: 'string',
      enum: [ROLE_CONFIG_SCHEMA_VERSION],
      default: ROLE_CONFIG_SCHEMA_VERSION,
      description: 'Role config schema version. Version 1 is the initial MCP tool-access role mapping schema.',
    },
    roles: {
      type: 'object',
      minProperties: 1,
      description: 'Mapping from agent role name to permissions and tool-access role.',
      patternProperties: {
        '^[a-z][a-z0-9_-]*$': roleDefinitionSchema,
      },
      additionalProperties: false,
      default: DEFAULT_ROLE_CONFIG,
    },
    defaults: {
      type: 'object',
      description: 'Optional loader defaults for unknown or partially specified custom roles.',
      additionalProperties: false,
      properties: {
        toolAccessRole: {
          type: 'string',
          enum: TOOL_ACCESS_ROLES,
          default: DEFAULT_TOOL_ACCESS_ROLE,
        },
      },
      default: {
        toolAccessRole: DEFAULT_TOOL_ACCESS_ROLE,
      },
    },
  },
  examples: [
    {
      schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
      roles: DEFAULT_ROLE_CONFIG,
    },
  ],
};

