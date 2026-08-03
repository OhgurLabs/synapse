// Event-driven triggers — react to EventBus events with configurable actions.
// Closes the n8n "automation triggers" gap. Zero external dependencies.
//
// Trigger types:
//   - message: inject a system message into a channel
//   - task: create a task on the fly
//   - prompt: dispatch a message as if a user sent it (triggers agent loop)
//
// Persistence: CAS-protected triggers.json per project (same pattern as tasks/campaigns/schedules).
// Execution: createTriggerLoop() subscribes to EventBus events and fires matching triggers.

import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from './logger.js';
import config from './config.js';

const log = createLogger('triggers');

const VALID_ACTIONS = new Set(['message', 'task', 'prompt', 'workflow', 'campaign']);

// All events the trigger system can listen for.
// Names normalized to colon notation (namespace:action) for v1 beta.
export const TRIGGER_EVENTS = [
  'message', 'session:start', 'session:end',
  'agent:dispatch', 'vote:completed',
  'project:created', 'channel:created', 'agents:updated',
  'task:created', 'task:status_changed', 'task:completed',
  'campaign:created', 'campaign:status_changed', 'campaign:milestone_completed',
  'schedule:fired',
  'thread:created',
  'workflow:created', 'workflow:run_started', 'workflow:run_completed', 'workflow:run_failed',
  'workflow:node_completed', 'workflow:node_failed',
];

const TRIGGER_EVENTS_SET = new Set(TRIGGER_EVENTS);

function generateTriggerId() {
  return 'trig_' + Date.now() + '_' + randomBytes(4).toString('hex');
}

/**
 * Evaluate a simple condition against event data.
 * Supports: { field: "status", equals: "done" } or { field: "agent", in: ["alice", "bob"] }
 * Returns true if no condition set (unconditional trigger).
 */
function evaluateCondition(condition, eventData) {
  if (!condition) return true;
  const value = eventData?.[condition.field];
  if (condition.equals !== undefined) return value === condition.equals;
  if (condition.notEquals !== undefined) return value !== condition.notEquals;
  if (condition.in && Array.isArray(condition.in)) return condition.in.includes(value);
  if (condition.notIn && Array.isArray(condition.notIn)) return !condition.notIn.includes(value);
  return true; // unknown condition → pass
}

export class TriggerManager {
  constructor(stateManager) {
    this._stateManager = stateManager;
  }

  _path(projectId) {
    return this._stateManager._filePath(projectId, 'triggers.json');
  }

  _load(projectId) {
    try {
      const raw = readFileSync(this._path(projectId), 'utf-8');
      return JSON.parse(raw);
    } catch {
      return { version: 0, triggers: [] };
    }
  }

  _save(projectId, data) {
    mkdirSync(dirname(this._path(projectId)), { recursive: true });
    writeFileSync(this._path(projectId), JSON.stringify(data, null, 2));
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

  createTrigger(projectId, opts) {
    const { event, action, config: actionConfig, description, channel, condition } = opts;

    if (!event || (!TRIGGER_EVENTS_SET.has(event) && !event.startsWith('external:'))) {
      throw new Error(`Invalid event: ${event}. Valid: ${TRIGGER_EVENTS.join(', ')} or external:*`);
    }
    if (!action || !VALID_ACTIONS.has(action)) {
      throw new Error(`Invalid action: ${action}. Valid: ${[...VALID_ACTIONS].join(', ')}`);
    }
    if (!actionConfig || typeof actionConfig !== 'object') {
      throw new Error('config object required');
    }

    // Validate action-specific config
    if (action === 'message' && !actionConfig.content) {
      throw new Error('message action requires config.content');
    }
    if (action === 'task' && !actionConfig.title) {
      throw new Error('task action requires config.title');
    }
    if (action === 'prompt' && !actionConfig.content) {
      throw new Error('prompt action requires config.content');
    }
    if (action === 'campaign' && !actionConfig.title) {
      throw new Error('campaign action requires config.title');
    }

    const trigger = {
      id: generateTriggerId(),
      event,
      action,
      config: actionConfig,
      condition: condition || null,
      description: description || null,
      channel: channel || 'general',
      status: 'active',
      fireCount: 0,
      lastFiredAt: null,
      createdAt: new Date().toISOString(),
    };

    this._withCAS(projectId, (data) => {
      data.triggers.push(trigger);
    });

    log.info('Trigger created', { projectId, triggerId: trigger.id, event, action });
    return trigger;
  }

  listTriggers(projectId, status) {
    const data = this._load(projectId);
    let triggers = data.triggers;
    if (status) triggers = triggers.filter(t => t.status === status);
    return triggers;
  }

  getTrigger(projectId, triggerId) {
    const data = this._load(projectId);
    return data.triggers.find(t => t.id === triggerId) || null;
  }

  updateTriggerStatus(projectId, triggerId, newStatus) {
    return this._withCAS(projectId, (data) => {
      const trigger = data.triggers.find(t => t.id === triggerId);
      if (!trigger) return false;
      trigger.status = newStatus;
      return trigger;
    });
  }

  deleteTrigger(projectId, triggerId) {
    return this._withCAS(projectId, (data) => {
      const idx = data.triggers.findIndex(t => t.id === triggerId);
      if (idx === -1) return false;
      data.triggers.splice(idx, 1);
      return true;
    });
  }

  recordFire(projectId, triggerId) {
    this._withCAS(projectId, (data) => {
      const trigger = data.triggers.find(t => t.id === triggerId);
      if (!trigger) return false;
      trigger.fireCount++;
      trigger.lastFiredAt = new Date().toISOString();
    });
  }

  getActiveTriggers(projectId, eventName) {
    const data = this._load(projectId);
    return data.triggers.filter(t =>
      t.status === 'active' && t.event === eventName
    );
  }
}

/**
 * Create the trigger execution loop. Subscribes to EventBus events and fires matching triggers.
 *
 * @param {Object} deps
 * @param {TriggerManager} deps.triggerManager
 * @param {Object} deps.stateManager
 * @param {Function} deps.addMessage
 * @param {Function} deps.broadcastToChannel
 * @param {Object} deps.taskManager
 * @param {Function} deps.queueTurn
 * @param {Function} deps.handleUserMessage
 * @param {Object} deps.events - EventBus instance
 * @returns {{ start: Function, stop: Function }}
 */
export function createTriggerLoop(deps) {
  const { triggerManager, stateManager, addMessage, broadcastToChannel, taskManager, queueTurn, handleUserMessage, events, credentialVault } = deps;

  const handlers = new Map(); // eventName → handler function
  let lastTickAt = Date.now();
  let heartbeatInterval = null;
  const CHECK_INTERVAL_MS = config.triggers?.checkIntervalMs || 60000;

  // Resolve both {{key}} template vars and {{credential:name}} secrets
  function resolveAll(projectId, template, data) {
    let result = interpolate(template, data);
    if (credentialVault) result = credentialVault.interpolate(projectId, result);
    return result;
  }

  async function fireTrigger(trigger, projectId, eventData) {
    lastTickAt = Date.now();
    const { action, config: cfg, channel } = trigger;

    try {
      // Evaluate condition
      if (!evaluateCondition(trigger.condition, eventData)) {
        return; // condition not met — skip
      }

      switch (action) {
        case 'message': {
          // Interpolate event data into message content
          const content = resolveAll(projectId, cfg.content, eventData);
          addMessage(projectId, channel, 'System', content, 'system');
          broadcastToChannel(projectId, channel, {
            type: 'message', speaker: 'System', content, messageType: 'system',
          });
          break;
        }

        case 'task': {
          taskManager.createTask(projectId, {
            title: resolveAll(projectId, cfg.title, eventData),
            description: cfg.description ? resolveAll(projectId, cfg.description, eventData) : undefined,
            doneCriteria: cfg.doneCriteria || undefined,
            channel,
          });
          break;
        }

        case 'prompt': {
          // Queue a turn as if a user sent a message — triggers the full agent loop
          const content = resolveAll(projectId, cfg.content, eventData);
          queueTurn(projectId, channel, () =>
            handleUserMessage(content, projectId, channel, {}, cfg.speaker || 'Trigger')
          );
          break;
        }

        case 'workflow': {
          // Start a workflow run — requires workflowManager in deps
          const { workflowManager } = deps;
          if (workflowManager && cfg.workflowId) {
            const run = workflowManager.startRun(projectId, cfg.workflowId, {
              type: 'trigger', triggerId: trigger.id, event: trigger.event,
            });
            addMessage(projectId, channel, 'System',
              `[Trigger] Started workflow run: ${run.id}`, 'system');
          } else {
            log.warn('Workflow trigger missing workflowManager or workflowId', { triggerId: trigger.id });
          }
          break;
        }

        case 'campaign': {
          const { campaignManager } = deps;
          if (campaignManager) {
            const title = resolveAll(projectId, cfg.title, eventData);
            const campaign = campaignManager.createCampaign(projectId, {
              title,
              description: cfg.description ? resolveAll(projectId, cfg.description, eventData) : title,
              doneCriteria: cfg.doneCriteria || undefined,
              priority: cfg.priority || 'medium',
            });
            addMessage(projectId, channel, 'System',
              `[Trigger] Created campaign: **${campaign.title}**`, 'system');
          } else {
            log.warn('Campaign trigger missing campaignManager', { triggerId: trigger.id });
          }
          break;
        }
      }

      triggerManager.recordFire(projectId, trigger.id);
      log.info('Trigger fired', { projectId, triggerId: trigger.id, event: trigger.event, action });
    } catch (err) {
      log.error('Trigger fire failed', { projectId, triggerId: trigger.id, error: err.message });
    }
  }

  function onEvent(eventName, eventData) {
    lastTickAt = Date.now();
    const projectId = eventData?.projectId || eventData?.project || null;
    if (!projectId) return;

    // Get active triggers for this event in this project
    const triggers = triggerManager.getActiveTriggers(projectId, eventName);
    for (const trigger of triggers) {
      fireTrigger(trigger, projectId, eventData);
    }
  }

  /** Subscribe to a single event if not already subscribed. */
  function subscribe(eventName) {
    if (handlers.has(eventName)) return;
    const handler = (data) => onEvent(eventName, data);
    handlers.set(eventName, handler);
    events.on(eventName, handler);
  }

  function start() {
    for (const event of TRIGGER_EVENTS) {
      subscribe(event);
    }
    // Also subscribe to any external:* events from existing triggers
    for (const proj of stateManager.listProjects()) {
      const projId = proj.id || proj;
      for (const trigger of triggerManager.listTriggers(projId, 'active')) {
        if (trigger.event.startsWith('external:')) {
          subscribe(trigger.event);
        }
      }
    }
    heartbeatInterval = setInterval(() => { lastTickAt = Date.now(); }, CHECK_INTERVAL_MS);
    log.info('Trigger loop started', { events: handlers.size });
  }

  function stop() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    for (const [event, handler] of handlers) {
      events.off(event, handler);
    }
    handlers.clear();
    log.info('Trigger loop stopped');
  }

  return {
    start,
    stop,
    fireTrigger,
    subscribe,
    get lastTickAt() { return lastTickAt; },
    checkIntervalMs: CHECK_INTERVAL_MS,
  };
}

/**
 * Simple template interpolation: replaces {{field}} with eventData.field.
 * @param {string} template
 * @param {Object} data
 * @returns {string}
 */
function interpolate(template, data) {
  if (!template || !data) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = data[key];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}

/**
 * Parse a /trigger CLI command.
 * @param {string} text - raw command text after "/trigger "
 * @returns {{ subcommand: string, args: Object } | null}
 */
export function parseTriggerCommand(text) {
  const parts = text.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase();

  if (!subcommand) return null;

  switch (subcommand) {
    case 'list':
      return { subcommand: 'list', args: {} };

    case 'create': {
      // /trigger create --event task:completed --action message --content "Task {{taskId}} done!" --channel general
      const args = { event: null, action: null, config: {}, channel: null, condition: null, description: null };
      for (let i = 1; i < parts.length; i++) {
        const flag = parts[i];
        const next = parts.slice(i + 1).join(' ');

        if (flag === '--event' && parts[i + 1]) { args.event = parts[++i]; continue; }
        if (flag === '--action' && parts[i + 1]) { args.action = parts[++i]; continue; }
        if (flag === '--channel' && parts[i + 1]) { args.channel = parts[++i]; continue; }
        if (flag === '--desc' || flag === '--description') {
          const match = next.match(/^"([^"]+)"/);
          if (match) { args.description = match[1]; i += match[0].split(/\s+/).length; continue; }
          if (parts[i + 1]) { args.description = parts[++i]; }
          continue;
        }
        if (flag === '--content') {
          const match = next.match(/^"([^"]+)"/);
          if (match) { args.config.content = match[1]; i += match[0].split(/\s+/).length; continue; }
          if (parts[i + 1]) { args.config.content = parts[++i]; }
          continue;
        }
        if (flag === '--title') {
          const match = next.match(/^"([^"]+)"/);
          if (match) { args.config.title = match[1]; i += match[0].split(/\s+/).length; continue; }
          if (parts[i + 1]) { args.config.title = parts[++i]; }
          continue;
        }
        if (flag === '--url' && parts[i + 1]) { args.config.url = parts[++i]; continue; }
        if (flag === '--condition') {
          // --condition status=done
          const condStr = parts[++i];
          if (condStr?.includes('=')) {
            const [field, value] = condStr.split('=', 2);
            args.condition = { field, equals: value };
          }
          continue;
        }
      }
      return { subcommand: 'create', args };
    }

    case 'show': {
      return { subcommand: 'show', args: { triggerId: parts[1] || null } };
    }

    case 'pause': {
      return { subcommand: 'pause', args: { triggerId: parts[1] || null } };
    }

    case 'resume': {
      return { subcommand: 'resume', args: { triggerId: parts[1] || null } };
    }

    case 'delete': {
      return { subcommand: 'delete', args: { triggerId: parts[1] || null } };
    }

    default:
      return null;
  }
}

// Re-export for tests
export { evaluateCondition, interpolate };
