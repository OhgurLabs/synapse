/**
 * Shared Kahn DAG validation and topological sort helpers.
 * Extracted from src/workflows.js (Phase 2A) so both legacy Workflows
 * and static Loops share one cycle-detection and ordering core.
 */

export const VALID_NODE_TYPES = new Set(['task', 'message', 'prompt', 'condition', 'webhook', 'http', 'action', 'shell']);

function toDepsArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw[Symbol.iterator] === 'function' && typeof raw !== 'string') {
    return Array.from(raw);
  }
  return [];
}

/**
 * Validate a generic DAG with configurable id/dependency field names.
 * Returns { valid: true, order, predecessors, descendants }
 * or { valid: false, error: string }.
 */
export function validateGraphDAG(nodes, {
  idField = 'id',
  depsField = 'dependsOn',
  emptyError = 'DAG must have at least one node',
  duplicateError = 'Duplicate node IDs',
  cycleError = 'DAG contains a cycle',
  stableOrder = false,
  requireStringIds = true,
  rejectDuplicateDeps = false,
} = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { valid: false, error: emptyError };
  }

  const ids = new Set();
  for (const node of nodes) {
    const id = node?.[idField];
    if (requireStringIds ? (!id || typeof id !== 'string') : !id) {
      return { valid: false, error: `Node missing ${idField}` };
    }
    if (ids.has(id)) {
      return { valid: false, error: duplicateError };
    }
    ids.add(id);
  }

  const inDegree = new Map();
  const adj = new Map();
  const directDeps = new Map();
  for (const node of nodes) {
    const id = node[idField];
    inDegree.set(id, 0);
    adj.set(id, []);
    directDeps.set(id, new Set());
  }

  for (const node of nodes) {
    const id = node[idField];
    const deps = toDepsArray(node[depsField]);
    const seenDeps = new Set();
    for (const dep of deps) {
      if (!ids.has(dep)) {
        return { valid: false, error: `Node "${id}" depends on unknown node "${dep}"` };
      }
      if (dep === id) {
        return { valid: false, error: cycleError };
      }
      if (seenDeps.has(dep)) {
        if (rejectDuplicateDeps) {
          return { valid: false, error: `Node "${id}" declares duplicate dependency "${dep}"` };
        }
        continue;
      }
      seenDeps.add(dep);
      adj.get(dep).push(id);
      directDeps.get(id).add(dep);
      inDegree.set(id, inDegree.get(id) + 1);
    }
  }

  const cmp = (a, b) => String(a).localeCompare(String(b));
  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  if (stableOrder) queue.sort(cmp);

  const order = [];
  while (queue.length > 0) {
    const curr = queue.shift();
    order.push(curr);
    const nexts = stableOrder ? [...adj.get(curr)].sort(cmp) : adj.get(curr);
    for (const next of nexts) {
      const newDeg = inDegree.get(next) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) {
        queue.push(next);
        if (stableOrder) queue.sort(cmp);
      }
    }
  }

  if (order.length !== nodes.length) {
    return { valid: false, error: cycleError };
  }

  const predecessors = new Map();
  for (const id of order) {
    const anc = new Set();
    for (const dep of directDeps.get(id)) {
      anc.add(dep);
      for (const p of predecessors.get(dep) || []) anc.add(p);
    }
    predecessors.set(id, anc);
  }

  const descendants = new Map();
  for (const id of order) descendants.set(id, new Set());
  for (const id of order) {
    for (const anc of predecessors.get(id)) {
      descendants.get(anc).add(id);
    }
  }

  return { valid: true, order, predecessors, descendants };
}

/**
 * Legacy Workflow DAG validation — preserves exact error strings, numeric IDs, and iterable deps (Set/Array).
 */
export function validateDAG(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { valid: false, error: 'Workflow must have at least one node' };
  }

  const ids = new Set(nodes.map(n => n.id));
  if (ids.size !== nodes.length) {
    return { valid: false, error: 'Duplicate node IDs' };
  }

  for (const node of nodes) {
    if (!node.id || !node.type) {
      return { valid: false, error: 'Node missing id or type' };
    }
    if (!VALID_NODE_TYPES.has(node.type)) {
      return { valid: false, error: `Invalid node type: ${node.type}` };
    }
    for (const dep of toDepsArray(node.dependsOn)) {
      if (!ids.has(dep)) {
        return { valid: false, error: `Node "${node.id}" depends on unknown node "${dep}"` };
      }
    }
  }

  const graphRes = validateGraphDAG(nodes, {
    idField: 'id',
    depsField: 'dependsOn',
    emptyError: 'Workflow must have at least one node',
    duplicateError: 'Duplicate node IDs',
    cycleError: 'Workflow contains a cycle',
    stableOrder: false,
    requireStringIds: false,
    rejectDuplicateDeps: false,
  });
  if (!graphRes.valid) {
    return { valid: false, error: graphRes.error };
  }
  return { valid: true };
}

/**
 * Legacy Workflow topological sort — preserves exact input order tie-breaking and iterable deps.
 */
export function topologicalSort(nodes) {
  const inDegree = new Map();
  const adj = new Map();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adj.set(node.id, []);
  }
  for (const node of nodes) {
    for (const dep of toDepsArray(node.dependsOn)) {
      adj.get(dep).push(node.id);
      inDegree.set(node.id, inDegree.get(node.id) + 1);
    }
  }
  const result = [];
  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  while (queue.length > 0) {
    const curr = queue.shift();
    result.push(curr);
    for (const next of adj.get(curr)) {
      const newDeg = inDegree.get(next) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }
  return result;
}
