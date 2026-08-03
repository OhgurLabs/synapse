// Workflow DAGs — reusable multi-step automation pipelines.
// Closes the n8n "workflow orchestration" gap. Zero external dependencies.
//
// A Workflow is a directed acyclic graph (DAG) of nodes:
//   - task: create + execute a Synapse task, wait for completion
//   - message: inject a system message into a channel
//   - prompt: dispatch as user message → triggers agent routing
//   - condition: branch based on previous node results
//   - webhook: fire an outbound webhook (via webhook manager)
//   - http: make an HTTP request (GET/POST/PUT/DELETE), store response in context
//
// Nodes have dependsOn edges. Execution advances topologically:
// root nodes run first, then dependents are unblocked as predecessors complete.
//
// Persistence: CAS-protected workflows.json per project (same pattern as tasks/campaigns/triggers).
// Execution: createWorkflowLoop() subscribes to task:completed events and advances runs.

import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import http from 'http';
import https from 'https';
import { createLogger } from './logger.js';
import { computeBackoffWithJitter } from './utils/backoff.js';
import { createCheckpoint, restoreCheckpoint, cleanupCheckpoint } from './filesystem-checkpoint.js';
import { detectDangerousCommands, formatForCheckpoint, createDangerousCommandProposal, createDangerousCommandCheckpoint, checkAllowlist } from './dangerous-command-detector.js';

const log = createLogger('workflows');

const VALID_NODE_TYPES = new Set(['task', 'message', 'prompt', 'condition', 'webhook', 'http', 'action', 'shell']);
const VALID_WF_STATUSES = new Set(['active', 'paused', 'archived']);
const VALID_RUN_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled']);
const VALID_NODE_STATUSES = new Set(['pending', 'ready', 'running', 'completed', 'failed', 'skipped']);

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

/**
 * Simple template interpolation: replaces {{field}} with data[field].
 */
function interpolate(template, data) {
  if (!template || !data) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = data[key];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}

/**
 * Evaluate a simple condition against context data.
 * Supports: equals, notEquals, in, notIn, exists, truthy.
 * Returns true if no condition set.
 */
export function evaluateCondition(condition, data) {
  if (!condition) return true;
  const value = data?.[condition.field];
  if (condition.equals !== undefined) return value === condition.equals;
  if (condition.notEquals !== undefined) return value !== condition.notEquals;
  if (condition.in && Array.isArray(condition.in)) return condition.in.includes(value);
  if (condition.notIn && Array.isArray(condition.notIn)) return !condition.notIn.includes(value);
  if (condition.exists !== undefined) return condition.exists ? value !== undefined : value === undefined;
  if (condition.truthy !== undefined) return condition.truthy ? !!value : !value;
  return true;
}

/**
 * Validate a DAG — check for cycles, missing deps, valid node types.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validateDAG(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { valid: false, error: 'Workflow must have at least one node' };
  }

  const ids = new Set(nodes.map(n => n.id));

  // Check for duplicate IDs
  if (ids.size !== nodes.length) {
    return { valid: false, error: 'Duplicate node IDs' };
  }

  // Check node types and deps
  for (const node of nodes) {
    if (!node.id || !node.type) {
      return { valid: false, error: `Node missing id or type` };
    }
    if (!VALID_NODE_TYPES.has(node.type)) {
      return { valid: false, error: `Invalid node type: ${node.type}` };
    }
    for (const dep of (node.dependsOn || [])) {
      if (!ids.has(dep)) {
        return { valid: false, error: `Node "${node.id}" depends on unknown node "${dep}"` };
      }
    }
  }

  // Cycle detection via topological sort (Kahn's algorithm)
  const inDegree = new Map();
  const adj = new Map();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adj.set(node.id, []);
  }
  for (const node of nodes) {
    for (const dep of (node.dependsOn || [])) {
      adj.get(dep).push(node.id);
      inDegree.set(node.id, inDegree.get(node.id) + 1);
    }
  }
  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  let visited = 0;
  while (queue.length > 0) {
    const curr = queue.shift();
    visited++;
    for (const next of adj.get(curr)) {
      const newDeg = inDegree.get(next) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }
  if (visited !== nodes.length) {
    return { valid: false, error: 'Workflow contains a cycle' };
  }

  return { valid: true };
}

/**
 * Compute topological order of nodes. Returns array of node IDs.
 */
export function topologicalSort(nodes) {
  const inDegree = new Map();
  const adj = new Map();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adj.set(node.id, []);
  }
  for (const node of nodes) {
    for (const dep of (node.dependsOn || [])) {
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


export class WorkflowManager {
  constructor(stateManager) {
    this._stateManager = stateManager;
    this._onEvent = null;
  }

  setOnEvent(fn) { this._onEvent = fn; }

  _emit(event, data) {
    if (this._onEvent) this._onEvent(event, data).catch(() => {});
  }

  _path(projectId) {
    return this._stateManager._filePath(projectId, 'workflows.json');
  }

  _eventPath(projectId) {
    return this._stateManager._filePath(projectId, 'workflow-events.jsonl');
  }

  _load(projectId) {
    try {
      const raw = readFileSync(this._path(projectId), 'utf-8');
      return JSON.parse(raw);
    } catch {
      return { schemaVersion: '1', version: 0, workflows: [], runs: [] };
    }
  }

  _save(projectId, data) {
    mkdirSync(dirname(this._path(projectId)), { recursive: true });
    writeFileSync(this._path(projectId), JSON.stringify(data, null, 2) + '\n');
  }

  _logEvent(projectId, event) {
    mkdirSync(dirname(this._eventPath(projectId)), { recursive: true });
    const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() });
    appendFileSync(this._eventPath(projectId), line + '\n');
  }

  _withCAS(projectId, fn) {
    const data = this._load(projectId);
    const result = fn(data);
    if (result !== false) {
      data.version++;
      this._save(projectId, data);
    }
    return result;
  }

  // --- Workflow CRUD ---

  createWorkflow(projectId, opts) {
    const { title, description, nodes } = opts;
    if (!title) throw new Error('Workflow title required');
    if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
      throw new Error('Workflow must have at least one node');
    }

    // Assign node IDs if missing
    const enrichedNodes = nodes.map(n => ({
      id: n.id || generateId('node'),
      title: n.title || n.id || 'Untitled',
      type: n.type,
      config: n.config || {},
      dependsOn: n.dependsOn || [],
    }));

    const validation = validateDAG(enrichedNodes);
    if (!validation.valid) throw new Error(validation.error);

    const workflow = {
      id: generateId('wf'),
      title,
      description: description || null,
      status: 'active',
      nodes: enrichedNodes,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this._withCAS(projectId, (data) => {
      data.workflows.push(workflow);
    });

    this._logEvent(projectId, { type: 'workflow_created', workflowId: workflow.id, title });
    this._emit('workflow:created', { projectId, workflowId: workflow.id, title });
    log.info('Workflow created', { projectId, workflowId: workflow.id, title, nodes: enrichedNodes.length });
    return workflow;
  }

  getWorkflow(projectId, workflowId) {
    const data = this._load(projectId);
    return data.workflows.find(w => w.id === workflowId) || null;
  }

  listWorkflows(projectId, status) {
    const data = this._load(projectId);
    let workflows = data.workflows;
    if (status) workflows = workflows.filter(w => w.status === status);
    return workflows;
  }

  updateWorkflowStatus(projectId, workflowId, newStatus) {
    if (!VALID_WF_STATUSES.has(newStatus)) {
      throw new Error(`Invalid workflow status: ${newStatus}`);
    }
    return this._withCAS(projectId, (data) => {
      const wf = data.workflows.find(w => w.id === workflowId);
      if (!wf) return false;
      wf.status = newStatus;
      wf.updatedAt = new Date().toISOString();
      return wf;
    });
  }

  deleteWorkflow(projectId, workflowId) {
    return this._withCAS(projectId, (data) => {
      const idx = data.workflows.findIndex(w => w.id === workflowId);
      if (idx === -1) return false;
      data.workflows.splice(idx, 1);
      return true;
    });
  }

  // --- Workflow Runs ---

  startRun(projectId, workflowId, trigger = { type: 'manual' }) {
    const data = this._load(projectId);
    const wf = data.workflows.find(w => w.id === workflowId);
    if (!wf) throw new Error(`Workflow not found: ${workflowId}`);
    if (wf.status !== 'active') throw new Error(`Workflow is ${wf.status}, cannot run`);

    // Initialize node states — root nodes start as "ready"
    const nodeStates = {};
    for (const node of wf.nodes) {
      const deps = node.dependsOn || [];
      nodeStates[node.id] = {
        status: deps.length === 0 ? 'ready' : 'pending',
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
        taskId: null, // for task nodes: the created Synapse task ID
        retryCount: 0, // number of retry attempts made
        lastAttemptAt: null, // ISO timestamp of last execution attempt
        checkpointId: null, // Filesystem checkpoint ID if enabled
      };
    }

    const run = {
      id: generateId('run'),
      workflowId,
      status: 'running',
      trigger,
      nodeStates,
      context: {}, // accumulated results from completed nodes
      startedAt: new Date().toISOString(),
      completedAt: null,
    };

    this._withCAS(projectId, (d) => {
      d.runs.push(run);
    });

    this._logEvent(projectId, { type: 'run_started', runId: run.id, workflowId, trigger });
    this._emit('workflow:run_started', { projectId, workflowId, runId: run.id });
    log.info('Workflow run started', { projectId, workflowId, runId: run.id });
    return run;
  }

  getRun(projectId, runId) {
    const data = this._load(projectId);
    return data.runs.find(r => r.id === runId) || null;
  }

  listRuns(projectId, workflowId, status) {
    const data = this._load(projectId);
    let runs = data.runs;
    if (workflowId) runs = runs.filter(r => r.workflowId === workflowId);
    if (status) runs = runs.filter(r => r.status === status);
    return runs;
  }

  /**
   * Update a node's status within a run. Returns the list of newly-ready node IDs.
   */
  updateNodeStatus(projectId, runId, nodeId, status, result = null, error = null, retryCount = null, lastAttemptAt = null) {
    if (!VALID_NODE_STATUSES.has(status)) {
      throw new Error(`Invalid node status: ${status}`);
    }

    let newlyReady = [];

    this._withCAS(projectId, (data) => {
      const run = data.runs.find(r => r.id === runId);
      if (!run) return false;
      const ns = run.nodeStates[nodeId];
      if (!ns) return false;

      ns.status = status;
      if (status === 'running') ns.startedAt = new Date().toISOString();
      if (status === 'completed' || status === 'failed' || status === 'skipped') {
        ns.completedAt = new Date().toISOString();
      }
      if (result !== null) ns.result = result;
      if (error !== null) ns.error = error;
      if (retryCount !== null) ns.retryCount = retryCount;
      if (lastAttemptAt !== null) ns.lastAttemptAt = lastAttemptAt;

      // Store result in run context for downstream nodes to reference
      if (status === 'completed' && result !== null) {
        run.context[nodeId] = result;
      }
      // Store error in run context for fallback nodes to reference
      if (status === 'failed' && error !== null) {
        run.context[`${nodeId}_error`] = error;
      }

      // If completed/skipped, check which dependent nodes are now unblocked
      if (status === 'completed' || status === 'skipped') {
        const wf = data.workflows.find(w => w.id === run.workflowId);
        if (wf) {
          for (const node of wf.nodes) {
            const state = run.nodeStates[node.id];
            if (state.status !== 'pending') continue;
            const allDepsDone = (node.dependsOn || []).every(depId => {
              const depState = run.nodeStates[depId];
              return depState && (depState.status === 'completed' || depState.status === 'skipped');
            });
            if (allDepsDone) {
              state.status = 'ready';
              newlyReady.push(node.id);
            }
          }
        }
      }

      // Check if run is done (all nodes completed/failed/skipped)
      const allDone = Object.values(run.nodeStates).every(s =>
        s.status === 'completed' || s.status === 'failed' || s.status === 'skipped'
      );
      if (allDone) {
        const anyFailed = Object.values(run.nodeStates).some(s => s.status === 'failed');
        run.status = anyFailed ? 'failed' : 'completed';
        run.completedAt = new Date().toISOString();
      }
    });

    this._logEvent(projectId, { type: 'node_status_changed', runId, nodeId, status, result, error });

    // Emit events for completed/failed nodes
    if (status === 'completed') {
      this._emit('workflow:node_completed', { projectId, runId, nodeId, result });
    }
    if (status === 'failed') {
      this._emit('workflow:node_failed', { projectId, runId, nodeId, error });
    }

    return newlyReady;
  }

  /**
   * Set the filesystem checkpoint ID for a node.
   */
  setNodeCheckpointId(projectId, runId, nodeId, checkpointId) {
    this._withCAS(projectId, (data) => {
      const run = data.runs.find(r => r.id === runId);
      if (!run) return false;
      const ns = run.nodeStates[nodeId];
      if (!ns) return false;
      ns.checkpointId = checkpointId;
    });
  }

  /**
   * Mark a node's linked taskId (for task-type nodes that create Synapse tasks).
   */
  setNodeTaskId(projectId, runId, nodeId, taskId) {
    this._withCAS(projectId, (data) => {
      const run = data.runs.find(r => r.id === runId);
      if (!run) return false;
      const ns = run.nodeStates[nodeId];
      if (!ns) return false;
      ns.taskId = taskId;
    });
  }

  /**
   * Find all running runs that have a task-type node waiting on a specific taskId.
   * Used by the workflow loop to advance nodes when tasks complete.
   */
  findRunsByTaskId(projectId, taskId) {
    const data = this._load(projectId);
    const matches = [];
    for (const run of data.runs) {
      if (run.status !== 'running') continue;
      for (const [nodeId, ns] of Object.entries(run.nodeStates)) {
        if (ns.taskId === taskId && ns.status === 'running') {
          matches.push({ runId: run.id, nodeId, workflowId: run.workflowId });
        }
      }
    }
    return matches;
  }

  /**
   * Cancel a running workflow run.
   */
  cancelRun(projectId, runId) {
    return this._withCAS(projectId, (data) => {
      const run = data.runs.find(r => r.id === runId);
      if (!run || run.status !== 'running') return false;
      run.status = 'cancelled';
      run.completedAt = new Date().toISOString();
      // Mark all pending/ready nodes as skipped
      for (const ns of Object.values(run.nodeStates)) {
        if (ns.status === 'pending' || ns.status === 'ready') {
          ns.status = 'skipped';
          ns.completedAt = new Date().toISOString();
        }
      }
      return run;
    });
  }

  /**
   * Get all "ready" nodes for a given run.
   */
  getReadyNodes(projectId, runId) {
    const data = this._load(projectId);
    const run = data.runs.find(r => r.id === runId);
    if (!run || run.status !== 'running') return [];

    const wf = data.workflows.find(w => w.id === run.workflowId);
    if (!wf) return [];

    const ready = [];
    for (const node of wf.nodes) {
      const ns = run.nodeStates[node.id];
      if (ns && ns.status === 'ready') {
        ready.push(node);
      }
    }
    return ready;
  }

  // --- Formatting ---

  formatWorkflowList(projectId) {
    const workflows = this.listWorkflows(projectId);
    if (workflows.length === 0) return 'No workflows defined.';
    const lines = ['**Workflows:**'];
    for (const wf of workflows) {
      const nodeCount = wf.nodes.length;
      lines.push(`  ${wf.status === 'active' ? '●' : '○'} **${wf.title}** (${wf.id}) — ${nodeCount} nodes, ${wf.status}`);
    }
    return lines.join('\n');
  }

  formatWorkflowDetail(projectId, workflowId) {
    const wf = this.getWorkflow(projectId, workflowId);
    if (!wf) return 'Workflow not found.';

    const lines = [
      `**${wf.title}** (${wf.id})`,
      wf.description ? `${wf.description}` : null,
      `Status: ${wf.status} | Nodes: ${wf.nodes.length} | Created: ${wf.createdAt}`,
      '',
      '**Nodes:**',
    ].filter(l => l !== null);

    const order = topologicalSort(wf.nodes);
    const nodeMap = new Map(wf.nodes.map(n => [n.id, n]));
    for (const nodeId of order) {
      const node = nodeMap.get(nodeId);
      const deps = (node.dependsOn || []).length > 0 ? ` ← [${node.dependsOn.join(', ')}]` : ' (root)';
      lines.push(`  ${node.type === 'condition' ? '◇' : '■'} **${node.title}** [${node.type}]${deps}`);
    }

    // Show recent runs
    const runs = this.listRuns(projectId, workflowId).slice(-3);
    if (runs.length > 0) {
      lines.push('', '**Recent runs:**');
      for (const run of runs) {
        const completedNodes = Object.values(run.nodeStates).filter(s => s.status === 'completed').length;
        const totalNodes = Object.keys(run.nodeStates).length;
        lines.push(`  ${run.status === 'running' ? '▶' : run.status === 'completed' ? '✓' : '✗'} ${run.id} — ${run.status} (${completedNodes}/${totalNodes} nodes) — ${run.startedAt}`);
      }
    }

    return lines.join('\n');
  }

  formatRunDetail(projectId, runId) {
    const run = this.getRun(projectId, runId);
    if (!run) return 'Run not found.';

    const wf = this.getWorkflow(projectId, run.workflowId);
    const wfTitle = wf ? wf.title : run.workflowId;
    const nodeMap = wf ? new Map(wf.nodes.map(n => [n.id, n])) : new Map();

    const lines = [
      `**Run ${run.id}** of "${wfTitle}"`,
      `Status: ${run.status} | Trigger: ${run.trigger?.type || 'unknown'} | Started: ${run.startedAt}`,
      run.completedAt ? `Completed: ${run.completedAt}` : null,
      '',
      '**Nodes:**',
    ].filter(l => l !== null);

    for (const [nodeId, ns] of Object.entries(run.nodeStates)) {
      const node = nodeMap.get(nodeId);
      const title = node ? node.title : nodeId;
      const icon = ns.status === 'completed' ? '✓' : ns.status === 'failed' ? '✗' :
        ns.status === 'running' ? '▶' : ns.status === 'skipped' ? '⊘' :
        ns.status === 'ready' ? '◉' : '○';
      const taskRef = ns.taskId ? ` (task: ${ns.taskId})` : '';
      const errorRef = ns.error ? ` — ${ns.error}` : '';
      const ckptRef = ns.checkpointId ? ` [ckpt: ${ns.checkpointId}]` : '';
      lines.push(`  ${icon} **${title}** — ${ns.status}${taskRef}${errorRef}${ckptRef}`);
    }

    return lines.join('\n');
  }
}


/**
 * Create the workflow execution loop. Executes ready nodes and advances runs.
 *
 * @param {Object} deps
 * @param {WorkflowManager} deps.workflowManager
 * @param {Object} deps.stateManager
 * @param {Object} deps.taskManager
 * @param {Function} deps.addMessage
 * @param {Function} deps.broadcastToChannel
 * @param {Function} deps.queueTurn
 * @param {Function} deps.handleUserMessage
 * @param {Object} deps.events - EventBus instance
 * @param {Object} deps.config
 * @param {Object} deps.governanceManager - Governance manager for dangerous command escalation
 */
export function createWorkflowLoop(deps) {
  const { workflowManager, stateManager, taskManager, addMessage, broadcastToChannel,
    queueTurn, handleUserMessage, events, config, credentialVault, governanceManager } = deps;

  const CHECK_INTERVAL_MS = config.workflows?.checkIntervalMs || 10000;
  let tickInterval = null;
  let lastTickAt = null;
  const handlers = [];

  // Resolve both {{key}} template vars and {{credential:name}} secrets
  function resolveAll(projectId, template, context) {
    let result = interpolate(template, context);
    if (credentialVault) result = credentialVault.interpolate(projectId, result);
    return result;
  }

  /**
   * Load and check dangerous command allowlist.
   * Returns true if the detected command is allowlisted.
   */
  function checkAllowlist(projectId, detection, context) {
    try {
      const project = stateManager.getProject(projectId);
      const baseDir = project ? project.projectDir : process.cwd();
      const allowlistPath = resolve(baseDir, '.synapse/dangerous-commands-allowlist.json');

      if (!existsSync(allowlistPath)) {
        return false;
      }

      const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf-8'));

      // Check exact command matches
      for (const entry of allowlist.entries || []) {
        // Check if command matches and context restrictions are satisfied
        const matchesProject = !entry.projectIds || entry.projectIds.length === 0 || entry.projectIds.includes(projectId);
        const matchesAgent = !entry.agentIds || entry.agentIds.length === 0 || entry.agentIds.includes(context.agentId);

        if (matchesProject && matchesAgent) {
          // Check if any detected command matches this allowlist entry
          for (const match of detection.matches) {
            if (match.matched.trim() === entry.command.trim()) {
              log.info('Dangerous command allowlisted (exact match)', {
                projectId,
                command: match.matched,
                reason: entry.reason,
              });
              return true;
            }
          }
        }
      }

      // Check pattern matches (glob patterns)
      for (const patternEntry of allowlist.patterns || []) {
        const matchesProject = !patternEntry.projectIds || patternEntry.projectIds.length === 0 || patternEntry.projectIds.includes(projectId);
        const matchesAgent = !patternEntry.agentIds || patternEntry.agentIds.length === 0 || patternEntry.agentIds.includes(context.agentId);

        if (matchesProject && matchesAgent) {
          // Convert glob pattern to regex (simple implementation)
          const regexPattern = patternEntry.pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
          const regex = new RegExp(`^${regexPattern}$`);

          for (const match of detection.matches) {
            if (regex.test(match.matched.trim())) {
              log.info('Dangerous command allowlisted (pattern match)', {
                projectId,
                command: match.matched,
                pattern: patternEntry.pattern,
                reason: patternEntry.reason,
              });
              return true;
            }
          }
        }
      }

      return false;
    } catch (err) {
      log.warn('Failed to check allowlist', { projectId, error: err.message });
      return false;
    }
  }

  /**
   * Wait for governance approval on a proposal.
   * Returns true if approved, false if rejected or timed out.
   */
  async function waitForGovernanceApproval(projectId, proposalId, timeoutMs = 300000) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let resolved = false;

      const approvalHandler = (data) => {
        if (data.projectId === projectId && data.proposalId === proposalId) {
          if (!resolved) {
            resolved = true;
            cleanup();
            log.info('Dangerous command governance proposal approved', { projectId, proposalId });
            resolve(true);
          }
        }
      };

      const rejectionHandler = (data) => {
        if (data.projectId === projectId && data.proposalId === proposalId) {
          if (!resolved) {
            resolved = true;
            cleanup();
            log.warn('Dangerous command governance proposal rejected', { projectId, proposalId });
            resolve(false);
          }
        }
      };

      const cleanup = () => {
        events.off('governance:proposal_approved', approvalHandler);
        events.off('governance:proposal_rejected', rejectionHandler);
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };

      // Listen for approval/rejection events
      events.on('governance:proposal_approved', approvalHandler);
      events.on('governance:proposal_rejected', rejectionHandler);

      // Set timeout
      const timeoutHandle = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          log.warn('Dangerous command governance approval timed out', {
            projectId,
            proposalId,
            timeoutMs
          });
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  /**
   * Execute a single node's logic (no retry/error handling — raw execution).
   */
  async function executeNodeCore(projectId, run, node, runContext, channel) {
    const { id: runId } = run;
    const wf = workflowManager.getWorkflow(projectId, run.workflowId);

    switch (node.type) {
      case 'message': {
        const content = resolveAll(projectId, node.config.content || '', runContext);
        addMessage(projectId, channel, 'System', `[Workflow] ${content}`, 'system');
        broadcastToChannel(projectId, channel, {
          type: 'message', speaker: 'System', content: `[Workflow] ${content}`, messageType: 'system',
        });
        workflowManager.updateNodeStatus(projectId, runId, node.id, 'completed', content);
        break;
      }

      case 'task': {
        const title = resolveAll(projectId, node.config.title || node.title, runContext);
        const description = node.config.description ? resolveAll(projectId, node.config.description, runContext) : title;

        // Detect dangerous commands in task node before execution
        if (governanceManager) {
          const textToScan = [
            title,
            description,
            node.config.command || '',
            node.config.script || '',
            JSON.stringify(node.config.payload || {}),
          ].filter(Boolean).join('\n');

          const detection = detectDangerousCommands(textToScan, {
            projectId,
            workflowId: run.workflowId,
            runId,
            nodeId: node.id,
            nodeType: node.type,
          });

          if (detection.isDangerous) {
            // Check if command is allowlisted
            const isAllowlisted = checkAllowlist(projectId, detection, {
              agentId: null, // workflow execution has no specific agent
            });

            if (isAllowlisted) {
              log.info('Dangerous command detected but allowlisted — proceeding', {
                projectId,
                runId,
                nodeId: node.id,
                matchCount: detection.matches.length,
              });
            } else {
              // Not allowlisted — escalate to governance
              log.warn('Dangerous command detected in task node — escalating to governance', {
                projectId,
                runId,
                nodeId: node.id,
                risk: detection.risk,
                matchCount: detection.matches.length,
                recommendation: detection.recommendation,
              });

              // Create checkpoint before escalation if high risk and not already created
              const currentState = run.nodeStates[node.id];
              let checkpointId = currentState?.checkpointId || null;

              if (detection.risk === 'high' && !checkpointId) {
                log.info('Creating checkpoint before governance escalation', {
                  projectId,
                  runId,
                  nodeId: node.id,
                });

                const project = stateManager.getProject(projectId);
                const baseDir = project ? project.projectDir : process.cwd();
                const fsPaths = [resolve(baseDir, '.synapse'), resolve(baseDir, 'src')];

                const ckptResult = createDangerousCommandCheckpoint({
                  projectId,
                  createFsCheckpoint: createCheckpoint,
                  baseDir,
                  fsPaths,
                  detection,
                  context: { workflowId: run.workflowId, runId, nodeId: node.id },
                });

                // Use the filesystem checkpoint ID for workflow node state (enables restore)
                checkpointId = ckptResult.fsCheckpointId;
                if (checkpointId) {
                  workflowManager.setNodeCheckpointId(projectId, runId, node.id, checkpointId);
                  log.info('Checkpoint created before governance escalation', {
                    projectId,
                    runId,
                    nodeId: node.id,
                    checkpointId,
                  });
                }
              }

              // Create governance proposal
              const proposal = createDangerousCommandProposal(governanceManager, projectId, detection, {
                workflowId: run.workflowId,
                runId,
                nodeId: node.id,
                nodeTitle: node.title,
                fullText: textToScan,
                checkpointId,
                agentId: 'workflow-engine',
              });

              // Emit event for audit trail
              events.emit('workflow:dangerous_command_blocked', {
                projectId,
                runId,
                workflowId: run.workflowId,
                nodeId: node.id,
                nodeTitle: node.title,
                detection,
                proposalId: proposal.id,
                checkpointId,
              });

              // Add message to channel notifying operator
              addMessage(projectId, channel, 'System',
                `⚠️ [Workflow] Dangerous command detected in node "${node.title}" — governance approval required (proposal: ${proposal.id})`, 'warning');
              broadcastToChannel(projectId, channel, {
                type: 'message',
                speaker: 'System',
                content: `⚠️ Dangerous command detected in workflow node — governance approval required (proposal: ${proposal.id})`,
                messageType: 'warning',
              });

              // Wait for governance decision (5 minute timeout)
              const approved = await waitForGovernanceApproval(projectId, proposal.id, 300000);

              if (!approved) {
                // Governance rejected or timed out — fail the node
                const errorMsg = `Dangerous command execution blocked by governance or timed out (proposal: ${proposal.id})`;
                workflowManager.updateNodeStatus(projectId, runId, node.id, 'failed', null, errorMsg);

                addMessage(projectId, channel, 'System',
                  `❌ [Workflow] Node "${node.title}" failed: ${errorMsg}`, 'error');
                broadcastToChannel(projectId, channel, {
                  type: 'message',
                  speaker: 'System',
                  content: `❌ Workflow node failed: ${errorMsg}`,
                  messageType: 'error',
                });

                events.emit('workflow:node:dangerous_command_rejected', {
                  projectId,
                  runId,
                  workflowId: run.workflowId,
                  nodeId: node.id,
                  proposalId: proposal.id,
                });

                throw new Error(errorMsg);
              }

              // Approved — log and proceed
              log.info('Dangerous command approved by governance — proceeding with execution', {
                projectId,
                runId,
                nodeId: node.id,
                proposalId: proposal.id,
              });

              addMessage(projectId, channel, 'System',
                `✅ [Workflow] Dangerous command approved by governance — proceeding with "${node.title}"`, 'system');
              broadcastToChannel(projectId, channel, {
                type: 'message',
                speaker: 'System',
                content: `✅ Dangerous command approved — proceeding with workflow execution`,
                messageType: 'system',
              });

              events.emit('workflow:node:dangerous_command_approved', {
                projectId,
                runId,
                workflowId: run.workflowId,
                nodeId: node.id,
                proposalId: proposal.id,
              });
            }
          }
        }

        // Proceed with task creation
        const task = taskManager.createTask(projectId, {
          title,
          description,
          doneCriteria: node.config.doneCriteria || null,
          channel,
        });
        workflowManager.setNodeTaskId(projectId, runId, node.id, task.id);
        addMessage(projectId, channel, 'System',
          `[Workflow] Created task "${title}" (${task.id}) for node "${node.title}"`, 'system');
        break;
      }

      case 'prompt': {
        const content = resolveAll(projectId, node.config.content || '', runContext);
        queueTurn(projectId, channel, () =>
          handleUserMessage(content, projectId, channel, {}, node.config.speaker || 'Workflow')
        );
        workflowManager.updateNodeStatus(projectId, runId, node.id, 'completed', content);
        break;
      }

      case 'condition': {
        const condition = node.config.condition;
        const result = evaluateCondition(condition, runContext);
        workflowManager.updateNodeStatus(projectId, runId, node.id, 'completed', result);
        if (wf) {
          const skipBranch = result ? node.config.elseBranch : node.config.thenBranch;
          if (skipBranch) {
            const toSkip = Array.isArray(skipBranch) ? skipBranch : [skipBranch];
            for (const skipNodeId of toSkip) {
              const skipNs = run.nodeStates[skipNodeId];
              if (skipNs && (skipNs.status === 'pending' || skipNs.status === 'ready')) {
                workflowManager.updateNodeStatus(projectId, runId, skipNodeId, 'skipped');
              }
            }
          }
        }
        break;
      }

      case 'webhook': {
        const payload = node.config.payload ? resolveAll(projectId, JSON.stringify(node.config.payload), runContext) : '{}';
        events.emit('workflow:webhook', {
          projectId, runId: run.id, nodeId: node.id,
          url: node.config.url,
          payload: JSON.parse(payload),
        });
        workflowManager.updateNodeStatus(projectId, runId, node.id, 'completed', payload);
        break;
      }

      case 'http': {
        // Scan URL, body, and headers for dangerous commands before execution
        const url = resolveAll(projectId, node.config.url || '', runContext);
        const bodyContent = node.config.body ? (typeof node.config.body === 'string' ? node.config.body : JSON.stringify(node.config.body)) : null;
        const headersContent = node.config.headers ? JSON.stringify(node.config.headers) : null;
        
        const textToScan = [
          url,
          bodyContent || '',
          headersContent || '',
          node.config.method || '',
        ].filter(Boolean).join('\n');

        if (governanceManager && textToScan) {
          const detection = detectDangerousCommands(textToScan, {
            projectId,
            workflowId: run.workflowId,
            runId,
            nodeId: node.id,
            nodeType: node.type,
          });

          if (detection.isDangerous) {
            const isAllowlisted = checkAllowlist(projectId, detection, { agentId: null });

            if (!isAllowlisted) {
              log.warn('Dangerous command detected in http node — escalating to governance', {
                projectId,
                runId,
                nodeId: node.id,
                risk: detection.risk,
                matchCount: detection.matches.length,
              });

              let checkpointId = null;
              if (detection.risk === 'high') {
                const project = stateManager.getProject(projectId);
                const baseDir = project ? project.projectDir : process.cwd();
                const fsPaths = [resolve(baseDir, '.synapse'), resolve(baseDir, 'src')];

                const ckptResult = createDangerousCommandCheckpoint({
                  projectId,
                  createFsCheckpoint: createCheckpoint,
                  baseDir,
                  fsPaths,
                  detection,
                  context: { workflowId: run.workflowId, runId, nodeId: node.id },
                });

                checkpointId = ckptResult.fsCheckpointId;
                if (checkpointId) {
                  workflowManager.setNodeCheckpointId(projectId, runId, node.id, checkpointId);
                }
              }

              const proposal = createDangerousCommandProposal(governanceManager, projectId, detection, {
                workflowId: run.workflowId,
                runId,
                nodeId: node.id,
                nodeTitle: node.title,
                fullText: textToScan,
                checkpointId,
                agentId: 'workflow-engine',
              });

              const approval = await governanceManager.waitForGovernanceApproval(projectId, proposal.id, 300000);

              if (!approval || approval.status !== 'approved') {
                log.error('Governance rejected dangerous command in http node', {
                  projectId,
                  runId,
                  nodeId: node.id,
                  proposalId: proposal.id,
                  status: approval?.status,
                });
                workflowManager.updateNodeStatus(projectId, runId, node.id, 'failed', 'Governance rejected');
                return;
              }

              log.info('Dangerous command in http node approved by governance', {
                projectId,
                runId,
                nodeId: node.id,
                proposalId: proposal.id,
              });
            } else {
              log.info('Dangerous command in http node detected but allowlisted — proceeding', {
                projectId,
                runId,
                nodeId: node.id,
                matchCount: detection.matches.length,
              });
            }
          }
        }

        const method = (node.config.method || 'GET').toUpperCase();
        const headers = {};
        if (node.config.headers) {
          for (const [k, v] of Object.entries(node.config.headers)) {
            headers[k] = resolveAll(projectId, String(v), runContext);
          }
        }
        let body = null;
        if (node.config.body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
          body = typeof node.config.body === 'string'
            ? resolveAll(projectId, node.config.body, runContext)
            : resolveAll(projectId, JSON.stringify(node.config.body), runContext);
          if (!headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'application/json';
          }
        }

        const response = await httpRequest(url, method, headers, body);
        const result = { status: response.status, headers: response.headers, body: response.body };

        if (node.config.expectStatus && response.status !== node.config.expectStatus) {
          throw new Error(`HTTP ${method} ${url} returned ${response.status}, expected ${node.config.expectStatus}`);
        }
        if (!node.config.allowFailure && response.status >= 400) {
          throw new Error(`HTTP ${method} ${url} returned ${response.status}: ${(response.body || '').slice(0, 200)}`);
        }

        workflowManager.updateNodeStatus(projectId, runId, node.id, 'completed', result);
        break;
      }

      case 'action': {
        const actionName = resolveAll(projectId, node.config.action || '', runContext);
        const actionPayload = node.config.payload ? resolveAll(projectId, JSON.stringify(node.config.payload), runContext) : '{}';

        // Detect dangerous commands in action node before execution
        if (governanceManager) {
          const textToScan = [
            actionName,
            actionPayload,
            node.config.args || '',
          ].filter(Boolean).join('\n');

          if (textToScan) {
            const detection = detectDangerousCommands(textToScan, {
              projectId,
              workflowId: run.workflowId,
              runId,
              nodeId: node.id,
              nodeType: node.type,
            });

            if (detection.isDangerous) {
              const isAllowlisted = checkAllowlist(projectId, detection, { agentId: null });

              if (!isAllowlisted) {
                log.warn('Dangerous command detected in action node — escalating to governance', {
                  projectId, runId, nodeId: node.id, risk: detection.risk, matchCount: detection.matches.length,
                });

                const currentNodeState = run.nodeStates[node.id];
                let checkpointId = currentNodeState?.checkpointId || null;

                if (detection.risk === 'high' && !checkpointId) {
                  const project = stateManager.getProject(projectId);
                  const baseDir = project ? project.projectDir : process.cwd();
                  const ckptResult = createDangerousCommandCheckpoint({
                    projectId, createFsCheckpoint: createCheckpoint,
                    baseDir, fsPaths: [resolve(baseDir, '.synapse'), resolve(baseDir, 'src')],
                    detection, context: { workflowId: run.workflowId, runId, nodeId: node.id },
                  });
                  checkpointId = ckptResult.fsCheckpointId;
                  if (checkpointId) workflowManager.setNodeCheckpointId(projectId, runId, node.id, checkpointId);
                }

                const proposal = createDangerousCommandProposal(governanceManager, projectId, detection, {
                  workflowId: run.workflowId, runId, nodeId: node.id, nodeTitle: node.title,
                  fullText: textToScan, checkpointId, agentId: 'workflow-engine',
                });

                events.emit('workflow:dangerous_command_blocked', {
                  projectId, runId, workflowId: run.workflowId,
                  nodeId: node.id, nodeTitle: node.title, detection, proposalId: proposal.id, checkpointId,
                });

                addMessage(projectId, channel, 'System',
                  `⚠️ [Workflow] Dangerous command detected in action node "${node.title}" — governance approval required (proposal: ${proposal.id})`, 'warning');

                const approved = await waitForGovernanceApproval(projectId, proposal.id, 300000);

                if (!approved) {
                  const errorMsg = `Dangerous command execution blocked by governance or timed out (proposal: ${proposal.id})`;
                  workflowManager.updateNodeStatus(projectId, runId, node.id, 'failed', null, errorMsg);
                  events.emit('workflow:node:dangerous_command_rejected', {
                    projectId, runId, workflowId: run.workflowId, nodeId: node.id, proposalId: proposal.id,
                  });
                  throw new Error(errorMsg);
                }

                events.emit('workflow:node:dangerous_command_approved', {
                  projectId, runId, workflowId: run.workflowId, nodeId: node.id, proposalId: proposal.id,
                });
              } else {
                log.info('Dangerous command in action node detected but allowlisted — proceeding', {
                  projectId, runId, nodeId: node.id, matchCount: detection.matches.length,
                });
              }
            }
          }
        }

        // Execute action via event — consumers handle registered action handlers
        events.emit('workflow:action', {
          projectId, runId: run.id, nodeId: node.id,
          action: actionName, payload: JSON.parse(actionPayload),
        });
        workflowManager.updateNodeStatus(projectId, runId, node.id, 'completed', { action: actionName, payload: JSON.parse(actionPayload) });
        break;
      }

      case 'shell': {
        const command = resolveAll(projectId, node.config.command || '', runContext);

        if (!command) {
          workflowManager.updateNodeStatus(projectId, runId, node.id, 'failed', null, 'Shell node missing required config.command');
          return;
        }

        // Shell nodes always scan for dangerous commands — shell is the highest-risk execution context
        const shellTextToScan = [command, node.config.args || ''].filter(Boolean).join('\n');
        const shellDetection = detectDangerousCommands(shellTextToScan, {
          projectId,
          workflowId: run.workflowId,
          runId,
          nodeId: node.id,
          nodeType: node.type,
        });

        if (shellDetection.isDangerous) {
          const isAllowlisted = checkAllowlist(projectId, shellDetection, { agentId: null });

          if (!isAllowlisted) {
            if (!governanceManager) {
              // No governance manager — block all dangerous shell commands unconditionally
              const errorMsg = `Dangerous shell command blocked (no governance manager available): ${command}`;
              log.error(errorMsg, { projectId, runId, nodeId: node.id, risk: shellDetection.risk });
              workflowManager.updateNodeStatus(projectId, runId, node.id, 'failed', null, errorMsg);
              events.emit('workflow:dangerous_command_blocked', {
                projectId, runId, workflowId: run.workflowId,
                nodeId: node.id, nodeTitle: node.title, detection: shellDetection, proposalId: null, checkpointId: null,
              });
              throw new Error(errorMsg);
            }

            log.warn('Dangerous command detected in shell node — escalating to governance', {
              projectId, runId, nodeId: node.id, risk: shellDetection.risk, matchCount: shellDetection.matches.length,
            });

            const currentNodeState = run.nodeStates[node.id];
            let shellCheckpointId = currentNodeState?.checkpointId || null;

            if (shellDetection.risk === 'high' && !shellCheckpointId) {
              const project = stateManager.getProject(projectId);
              const baseDir = project ? project.projectDir : process.cwd();
              const ckptResult = createDangerousCommandCheckpoint({
                projectId, createFsCheckpoint: createCheckpoint,
                baseDir, fsPaths: [resolve(baseDir, '.synapse'), resolve(baseDir, 'src')],
                detection: shellDetection, context: { workflowId: run.workflowId, runId, nodeId: node.id },
              });
              shellCheckpointId = ckptResult.fsCheckpointId;
              if (shellCheckpointId) workflowManager.setNodeCheckpointId(projectId, runId, node.id, shellCheckpointId);
            }

            const shellProposal = createDangerousCommandProposal(governanceManager, projectId, shellDetection, {
              workflowId: run.workflowId, runId, nodeId: node.id, nodeTitle: node.title,
              fullText: shellTextToScan, checkpointId: shellCheckpointId, agentId: 'workflow-engine',
            });

            events.emit('workflow:dangerous_command_blocked', {
              projectId, runId, workflowId: run.workflowId,
              nodeId: node.id, nodeTitle: node.title, detection: shellDetection,
              proposalId: shellProposal.id, checkpointId: shellCheckpointId,
            });

            addMessage(projectId, channel, 'System',
              `⚠️ [Workflow] Dangerous shell command detected in "${node.title}" — governance approval required (proposal: ${shellProposal.id})`, 'warning');

            const shellApproved = await waitForGovernanceApproval(projectId, shellProposal.id, 300000);

            if (!shellApproved) {
              const errorMsg = `Dangerous shell command blocked by governance or timed out (proposal: ${shellProposal.id})`;
              workflowManager.updateNodeStatus(projectId, runId, node.id, 'failed', null, errorMsg);
              events.emit('workflow:node:dangerous_command_rejected', {
                projectId, runId, workflowId: run.workflowId, nodeId: node.id, proposalId: shellProposal.id,
              });
              throw new Error(errorMsg);
            }

            events.emit('workflow:node:dangerous_command_approved', {
              projectId, runId, workflowId: run.workflowId, nodeId: node.id, proposalId: shellProposal.id,
            });
          } else {
            log.info('Dangerous shell command detected but allowlisted — proceeding', {
              projectId, runId, nodeId: node.id, matchCount: shellDetection.matches.length,
            });
          }
        }

        // Execute shell command via event — consumers handle actual execution
        events.emit('workflow:shell', {
          projectId, runId: run.id, nodeId: node.id,
          command, args: node.config.args || null,
        });
        workflowManager.updateNodeStatus(projectId, runId, node.id, 'completed', { command });
        break;
      }

      default:
        throw new Error(`Unknown node type: ${node.type}`);
    }
  }

  /**
   * Make an HTTP/HTTPS request. Returns { status, headers, body }.
   */
  function httpRequest(url, method, headers, body) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;
      const opts = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
      };

      const req = transport.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy(new Error('HTTP request timed out after 30s'));
      });

      if (body) req.write(body);
      req.end();
    });
  }

  /**
    * Execute a node with retry logic, timeout, and error fallback.
    *
    * Node config options:
    *   retries:            number (default 0) — retry count on failure (alias: max_retries)
    *   retryDelayMs:       number (default 1000) — base delay between retries (alias: backoff_ms)
    *   maxBackoffMs:       number (default 30000) — cap for exponential backoff growth
    *   timeoutMs:          number (default 0/unlimited) — abort execution after this
    *   onError:            string (node ID) — fallback node to execute on final failure
    *   checkpoint:         boolean/array — create filesystem checkpoint before execution
    *   
    * Backoff strategy: Exponential backoff with full jitter, capped at maxBackoffMs
    */
  async function executeNode(projectId, run, node) {
    const { id: runId, context: runContext } = run;
    const wf = workflowManager.getWorkflow(projectId, run.workflowId);
    if (!wf) return;

    const channel = node.config?.channel || 'general';
    const maxRetries = node.config?.max_retries ?? node.config?.retries ?? 0;
    const baseDelay = node.config?.backoff_ms ?? node.config?.retryDelayMs ?? 1000;
    const maxBackoffMs = node.config?.maxBackoffMs ?? 30000;
    const timeoutMs = node.config?.timeoutMs || 0;

    // Read current retry state from node (survives restarts)
    const currentState = run.nodeStates[node.id];
    const startingRetryCount = currentState?.retryCount || 0;

    // Create filesystem checkpoint if requested and not already present
    if (node.config.checkpoint && !currentState?.checkpointId) {
      try {
        const project = stateManager.getProject(projectId);
        const baseDir = project ? project.projectDir : process.cwd();
        let paths = [];

        if (Array.isArray(node.config.checkpoint)) {
          paths = node.config.checkpoint.map(p => resolve(baseDir, p));
        } else {
          // If true (boolean), we cannot safely checkpoint the entire baseDir because:
          // 1. It would include .synapse/fs-checkpoints, causing circular issues
          // 2. During restore, deleting baseDir would delete the checkpoint itself
          // Solution: Skip checkpoint creation and log warning
          log.warn('Checkpoint requires array of specific paths, skipping checkpoint', {
            projectId, runId, nodeId: node.id
          });
          paths = null; // Signal to skip checkpoint creation
        }

        // Skip checkpoint creation if paths is null
        if (paths !== null) {
          // Detect dangerous commands in node configuration before checkpoint
          const nodeText = [
            node.title,
            node.config.title,
            node.config.description,
            node.config.content,
            node.config.command || '',
            node.config.script || '',
            JSON.stringify(node.config.payload || {})
          ].filter(Boolean).join('\n');

          const dangerousDetection = detectDangerousCommands(nodeText, {
            projectId,
            workflowId: run.workflowId,
            runId,
            nodeId: node.id,
            nodeType: node.type
          });

          if (dangerousDetection.isDangerous) {
            const checkpointMeta = formatForCheckpoint(dangerousDetection);
            log.warn('Dangerous command detected before checkpoint creation', {
              projectId,
              runId,
              nodeId: node.id,
              risk: dangerousDetection.risk,
              matchCount: dangerousDetection.matches.length,
              patterns: dangerousDetection.matches.map(m => m.description),
              recommendation: dangerousDetection.recommendation
            });

            // Emit event for governance/audit trail
            events.emit('workflow:dangerous_command_detected', {
              projectId,
              runId,
              workflowId: run.workflowId,
              nodeId: node.id,
              nodeTitle: node.title,
              detection: dangerousDetection,
              checkpointMeta
            });
          }

          log.info('Creating filesystem checkpoint before node execution', { projectId, runId, nodeId: node.id });
          const checkpointId = createCheckpoint(baseDir, projectId, paths);
          workflowManager.setNodeCheckpointId(projectId, runId, node.id, checkpointId);
          // Update local state copy
          currentState.checkpointId = checkpointId;
        }
      } catch (err) {
        log.error('Failed to create checkpoint', { projectId, runId, nodeId: node.id, error: err.message });
        workflowManager.updateNodeStatus(projectId, runId, node.id, 'failed', null, `Checkpoint creation failed: ${err.message}`, startingRetryCount, new Date().toISOString());
        return;
      }
    }

    // If node has already exhausted retries (shouldn't happen in normal flow, but handle gracefully)
    if (startingRetryCount > maxRetries) {
      const existingError = currentState?.error || 'Node already exceeded max retries';
      workflowManager.updateNodeStatus(projectId, runId, node.id, 'failed', null, existingError, startingRetryCount, new Date().toISOString());
      return;
    }

    workflowManager.updateNodeStatus(projectId, runId, node.id, 'running', null, null, startingRetryCount, new Date().toISOString());

    let lastError = null;
    for (let attempt = startingRetryCount; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const backoffDelay = computeBackoffWithJitter(attempt - 1, baseDelay, maxBackoffMs);
          log.info('Node retry with exponential backoff', {
            projectId,
            runId,
            nodeId: node.id,
            attempt,
            maxRetries,
            baseDelay,
            maxBackoffMs,
            backoffDelay
          });
          // Emit timeline event for retry attempt
          events.emit('workflow:node:retry', {
            projectId,
            runId,
            workflowId: run.workflowId,
            nodeId: node.id,
            nodeTitle: node.title,
            attempt,
            maxRetries,
            backoffDelay,
            error: lastError?.message || 'Unknown error'
          });
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          const now = new Date().toISOString();
          workflowManager.updateNodeStatus(projectId, runId, node.id, 'running', null, null, attempt, now);
        }

        if (timeoutMs > 0) {
          await Promise.race([
            executeNodeCore(projectId, run, node, runContext, channel),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Node timed out after ${timeoutMs}ms`)), timeoutMs)),
          ]);
        } else {
          await executeNodeCore(projectId, run, node, runContext, channel);
        }
        
        // Success - executeNodeCore already set status='completed'

        // Cleanup checkpoint if successful (get fresh reference in case run was reloaded)
        const nodeState = run.nodeStates[node.id];
        if (nodeState?.checkpointId) {
            const project = stateManager.getProject(projectId);
            const baseDir = project ? project.projectDir : process.cwd();
            cleanupCheckpoint(baseDir, projectId, nodeState.checkpointId);
        }

        // If we had any retries, update the node state to clear error and preserve retry count
        if (attempt > 0) {
          const successState = run.nodeStates[node.id];
          workflowManager.updateNodeStatus(projectId, runId, node.id, 'completed',
            successState.result, '', attempt, new Date().toISOString());
        }
        return;
      } catch (err) {
        lastError = err;
        log.error('Node execution failed', { projectId, runId, nodeId: node.id, attempt, error: err.message });
        // Persist retry count after each failure
        const now = new Date().toISOString();
        workflowManager.updateNodeStatus(projectId, runId, node.id, 'running', null, err.message, attempt + 1, now);
      }
    }

    // Restore from checkpoint if one exists (revert filesystem to pre-execution state)
    // Get fresh reference in case run was reloaded during execution
    const failedNodeState = run.nodeStates[node.id];
    if (failedNodeState?.checkpointId) {
      try {
        const project = stateManager.getProject(projectId);
        const baseDir = project ? project.projectDir : process.cwd();
        log.info('Restoring filesystem from checkpoint due to node failure', {
          projectId,
          runId,
          nodeId: node.id,
          checkpointId: failedNodeState.checkpointId,
          attempts: maxRetries + 1
        });
        restoreCheckpoint(baseDir, projectId, failedNodeState.checkpointId);
        log.info('Checkpoint restored successfully', { projectId, runId, nodeId: node.id });
      } catch (restoreErr) {
        log.error('Failed to restore checkpoint after node failure', {
          projectId,
          runId,
          nodeId: node.id,
          checkpointId: failedNodeState.checkpointId,
          error: restoreErr.message
        });
        // Continue with failure handling even if restore fails
      }
    }

    workflowManager.updateNodeStatus(projectId, runId, node.id, 'failed', null, lastError.message, maxRetries + 1, new Date().toISOString());

    const onErrorNodeId = node.config?.onError;
    if (onErrorNodeId) {
      const fallbackNode = wf.nodes.find(n => n.id === onErrorNodeId);
      if (fallbackNode) {
        log.info('Triggering error fallback', { projectId, runId, nodeId: node.id, fallbackNodeId: onErrorNodeId });
        addMessage(projectId, channel, 'System',
          `[Workflow] Node "${node.title}" failed, executing fallback "${fallbackNode.title}"`, 'system');
        await executeNode(projectId, run, fallbackNode);
      }
    }
  }

  /**
   * Process all ready nodes across all running workflow runs.
   */
  async function tick() {
    lastTickAt = Date.now();
    const projects = stateManager.listProjects();
    for (const proj of projects) {
      const runs = workflowManager.listRuns(proj.id, null, 'running');
      for (const run of runs) {
        const readyNodes = workflowManager.getReadyNodes(proj.id, run.id);
        for (const node of readyNodes) {
          await executeNode(proj.id, run, node);
        }
      }
    }
  }

  /**
   * Handle task completion — advance any workflow nodes waiting on this task.
   */
  function onTaskCompleted(eventData) {
    const { projectId, project, taskId } = eventData;
    const pid = projectId || project;
    if (!pid || !taskId) return;

    const matches = workflowManager.findRunsByTaskId(pid, taskId);
    for (const { runId, nodeId } of matches) {
      const task = taskManager.getTask(pid, taskId);
      const result = task?.status === 'done' ? 'done' : 'failed';
      const status = result === 'done' ? 'completed' : 'failed';
      const error = result === 'failed' ? `Task ${taskId} failed` : null;
      const newlyReady = workflowManager.updateNodeStatus(pid, runId, nodeId, status, result, error);

      if (newlyReady.length > 0) {
        log.info('Workflow advanced', { projectId: pid, runId, newlyReady });
      }

      const run = workflowManager.getRun(pid, runId);
      if (run && (run.status === 'completed' || run.status === 'failed')) {
        log.info('Workflow run finished', { projectId: pid, runId, status: run.status });
        workflowManager._emit(`workflow:run_${run.status}`, { projectId: pid, runId, workflowId: run.workflowId });
      }
    }
  }

  function start() {
    // Subscribe to task completion events
    const taskHandler = (data) => onTaskCompleted(data);
    events.on('task:completed', taskHandler);
    handlers.push(['task:completed', taskHandler]);

    // Periodic tick to pick up ready nodes (handles race conditions + retry)
    tickInterval = setInterval(() => tick().catch(err => {
      log.error('Workflow tick error', { error: err.message });
    }), CHECK_INTERVAL_MS);

    log.info('Workflow loop started', { intervalMs: CHECK_INTERVAL_MS });
  }

  function stop() {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
    for (const [event, handler] of handlers) {
      events.off(event, handler);
    }
    handlers.length = 0;
    log.info('Workflow loop stopped');
  }

  return {
    start,
    stop,
    tick,
    executeNode,
    get lastTickAt() { return lastTickAt; },
    checkIntervalMs: CHECK_INTERVAL_MS,
  };
}


/**
 * Parse a /workflow CLI command.
 */
export function parseWorkflowCommand(text) {
  const parts = text.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase();
  if (!subcommand) return null;

  switch (subcommand) {
    case 'list':
      return { subcommand: 'list', args: {} };

    case 'show':
      return { subcommand: 'show', args: { workflowId: parts[1] || null } };

    case 'run':
      return { subcommand: 'run', args: { workflowId: parts[1] || null } };

    case 'runs':
      return { subcommand: 'runs', args: { workflowId: parts[1] || null } };

    case 'run-detail':
      return { subcommand: 'run-detail', args: { runId: parts[1] || null } };

    case 'cancel':
      return { subcommand: 'cancel', args: { runId: parts[1] || null } };

    case 'pause':
      return { subcommand: 'pause', args: { workflowId: parts[1] || null } };

    case 'resume':
      return { subcommand: 'resume', args: { workflowId: parts[1] || null } };

    case 'delete':
      return { subcommand: 'delete', args: { workflowId: parts[1] || null } };

    case 'create': {
      // /workflow create --title "My Pipeline" --json '{"nodes": [...]}'
      const args = { title: null, description: null, json: null };
      for (let i = 1; i < parts.length; i++) {
        const flag = parts[i];
        const rest = parts.slice(i + 1).join(' ');

        if (flag === '--title') {
          const match = rest.match(/^"([^"]+)"/);
          if (match) { args.title = match[1]; i += match[0].split(/\s+/).length; continue; }
          if (parts[i + 1]) { args.title = parts[++i]; }
          continue;
        }
        if (flag === '--desc' || flag === '--description') {
          const match = rest.match(/^"([^"]+)"/);
          if (match) { args.description = match[1]; i += match[0].split(/\s+/).length; continue; }
          if (parts[i + 1]) { args.description = parts[++i]; }
          continue;
        }
        if (flag === '--json') {
          // Everything after --json is the JSON body
          args.json = rest;
          break;
        }
      }
      return { subcommand: 'create', args };
    }

    default:
      return null;
  }
}

// Re-export for tests
export { interpolate };
