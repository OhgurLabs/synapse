// Per-project agent roster resolution: specific agents, model-tier classes,
// role-scoped constraints, or ALL. One predicate used by every enforcement
// site (task pickup, planning/decomposition, review) so a roster can never
// mean different things in different places.
//
// RosterSpec shape (all fields optional; absent/null field = no constraint):
//   {
//     agents:  ['alice', 'bob'],            // explicit agent ids
//     classes: ['opus-5', 'gpt-5.6-sol'],   // model-tier classes (see modelClass)
//     roles:   { reviewer: { classes: ['opus-5'] },
//                developer: { agents: ['local-agent'] } }
//   }
// Semantics:
//   - agents + classes are a UNION: an agent is on-roster if its id is listed
//     OR its model class is listed. Both absent = every agent is on-roster.
//   - roles[role], when present for the role being filled, REPLACES the
//     top-level spec for that decision ("only opus-5 reviews" means exactly
//     that, even if the top-level roster is wider).
//   - Legacy: a bare array of ids (the original project.agents feature) is
//     normalized to { agents: [...] }.

/**
 * Derive the model-tier class from an agent's model identifier.
 * GGUF files reduce to family grain (quant level is NOT part of class
 * identity — operator ruling 2026-08-01; it is recorded elsewhere for
 * result interpretation). Provider prefixes and vendor paths are stripped.
 *
 *   'claude-opus-5'                → 'opus-5'
 *   'claude-fable-5'               → 'fable-5'
 *   'gpt-5.6-sol'                  → 'gpt-5.6-sol'
 *   'zai-coding-plan/glm-5.2'      → 'glm-5.2'
 *   'Qwen3.5-27B-UD-Q4_K_XL.gguf'  → 'qwen3.5-27b'
 */
export function modelClass(model) {
  let m = String(model || '').trim();
  if (!m) return null;
  if (/\.gguf$/i.test(m)) {
    m = m.replace(/\.gguf$/i, '');
    // Cut at the first quant/precision token — everything before it is family
    const cut = m.search(/[-_.](UD[-_.])?(I?Q\d|F16|BF16|FP16|F32)/i);
    if (cut > 0) m = m.slice(0, cut);
  } else {
    if (m.includes('/')) m = m.split('/').pop();
    m = m.replace(/^claude-/i, '');
  }
  return m.toLowerCase();
}

const VALID_ROLE_KEYS = new Set(['architect', 'developer', 'reviewer', 'researcher', 'governor']);

function normalizeIdList(value, label) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const out = value.map(v => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} entries must be non-empty strings`);
    return v.trim();
  });
  return out.length > 0 ? out : null;
}

/**
 * Normalize any accepted roster input to a canonical spec or null (= ALL).
 * Accepts: null | string[] (legacy) | { agents?, classes?, roles? }.
 * Throws on malformed input — callers surface this as a 400.
 */
export function normalizeRosterSpec(input) {
  if (input === undefined || input === null) return null;
  if (Array.isArray(input)) {
    const agents = normalizeIdList(input, 'agents');
    return agents ? { agents, classes: null, roles: null } : null;
  }
  if (typeof input !== 'object') throw new Error('roster must be null, an array of agent ids, or a spec object');
  const agents = normalizeIdList(input.agents, 'roster.agents');
  const classes = normalizeIdList(input.classes, 'roster.classes')?.map(c => c.toLowerCase()) ?? null;
  let roles = null;
  if (input.roles !== undefined && input.roles !== null) {
    if (typeof input.roles !== 'object' || Array.isArray(input.roles)) {
      throw new Error('roster.roles must be an object of { role: { agents?, classes? } }');
    }
    roles = {};
    for (const [role, sub] of Object.entries(input.roles)) {
      if (!VALID_ROLE_KEYS.has(role)) throw new Error(`roster.roles has unknown role "${role}"`);
      if (typeof sub !== 'object' || sub === null || Array.isArray(sub)) {
        throw new Error(`roster.roles.${role} must be an object with agents/classes`);
      }
      const rAgents = normalizeIdList(sub.agents, `roster.roles.${role}.agents`);
      const rClasses = normalizeIdList(sub.classes, `roster.roles.${role}.classes`)?.map(c => c.toLowerCase()) ?? null;
      if (rAgents || rClasses) roles[role] = { agents: rAgents, classes: rClasses };
    }
    if (Object.keys(roles).length === 0) roles = null;
  }
  if (!agents && !classes && !roles) return null;
  return { agents, classes, roles };
}

function matchesFlat(flat, agentId, agentDef) {
  const byId = flat.agents?.includes(agentId) || false;
  const byClass = flat.classes ? flat.classes.includes(modelClass(agentDef?.model)) : false;
  // A flat spec with neither agents nor classes constrains nothing.
  if (!flat.agents && !flat.classes) return true;
  return byId || byClass;
}

/**
 * The single roster predicate. `role` is the role being filled for THIS
 * decision (subtask.suggestedRole, 'architect' for planning, 'reviewer' for
 * review selection); pass null when no role applies.
 */
export function rosterAllowsAgent(spec, agentId, agentDef, role = null) {
  // Tolerate un-migrated legacy arrays reaching the predicate directly.
  if (Array.isArray(spec)) spec = spec.length ? { agents: spec, classes: null, roles: null } : null;
  if (!spec) return true; // null spec = ALL agents
  if (role && spec.roles && spec.roles[role]) {
    return matchesFlat(spec.roles[role], agentId, agentDef);
  }
  return matchesFlat(spec, agentId, agentDef);
}

/** Resolve a spec to the concrete agent ids allowed (for a role, if given). */
export function resolveRosterAgentIds(spec, agentsMap, role = null) {
  const ids = Object.keys(agentsMap || {});
  if (!spec || (Array.isArray(spec) && spec.length === 0)) return ids;
  return ids.filter(id => rosterAllowsAgent(spec, id, agentsMap[id], role));
}

/**
 * Project-level pre-filter: is this agent allowed under ANY role of the spec?
 * (A role entry can widen beyond the top-level spec — "opus only reviews" on
 * a sol-only project — so a top-level-only check would wrongly exclude the
 * reviewer at project granularity.)
 */
export function rosterAllowsAgentAnyRole(spec, agentId, agentDef) {
  if (Array.isArray(spec)) spec = spec.length ? { agents: spec, classes: null, roles: null } : null;
  if (!spec) return true;
  if (rosterAllowsAgent(spec, agentId, agentDef, null)) return true;
  for (const role of Object.keys(spec.roles || {})) {
    if (rosterAllowsAgent(spec, agentId, agentDef, role)) return true;
  }
  return false;
}

/** Distinct classes present in an agents map — for the UI class picker. */
export function availableClasses(agentsMap) {
  const seen = new Map(); // class → [agentIds]
  for (const [id, def] of Object.entries(agentsMap || {})) {
    const cls = modelClass(def?.model);
    if (!cls) continue;
    if (!seen.has(cls)) seen.set(cls, []);
    seen.get(cls).push(id);
  }
  return [...seen.entries()].map(([cls, agentIds]) => ({ class: cls, agentIds })).sort((a, b) => a.class.localeCompare(b.class));
}
