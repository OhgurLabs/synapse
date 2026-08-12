#!/usr/bin/env node
// Synapse MCP Server — stdio transport, thin adapter over running Synapse instance.
// v2: full automation surface — projects, messages, tasks, campaigns, workflows, schedules, triggers.
// Usage: node src/mcp-server.js [--synapse-url http://localhost:8080] [--agent-id external] [--synapse-token TOKEN]

import { createInterface } from 'readline';
import http from 'http';
import https from 'https';
import WebSocket from 'ws';
import { pathToFileURL } from 'url';
import { resolve } from 'path';

// --- Config ---
const args = process.argv.slice(2);
const SYNAPSE_URL = getArg('--synapse-url') || process.env.SYNAPSE_URL || 'http://localhost:8080';
const AGENT_ID = getArg('--agent-id') || process.env.SYNAPSE_AGENT_ID || 'mcp-client';
const AUTH_TOKEN = getArg('--synapse-token') || process.env.SYNAPSE_AUTH_TOKEN || null;

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

// --- HTTP Client ---
function getTransport(url) {
  return url.protocol === 'https:' ? https : http;
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SYNAPSE_URL);
    const headers = {};
    if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    getTransport(url).get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SYNAPSE_URL);
    const payload = JSON.stringify(body);
    const reqHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (AUTH_TOKEN) reqHeaders['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    const req = getTransport(url).request(url, {
      method: 'POST',
      headers: reqHeaders,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpDelete(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SYNAPSE_URL);
    const headers = {};
    if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    const req = getTransport(url).request(url, { method: 'DELETE', headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// --- WebSocket Client (persistent, for sending messages) ---
let ws = null;
let wsReady = false;
let wsQueue = [];

function connectWs() {
  let wsUrl = SYNAPSE_URL.replace(/^http/, 'ws');
  if (AUTH_TOKEN) {
    const sep = wsUrl.includes('?') ? '&' : '?';
    wsUrl += `${sep}token=${encodeURIComponent(AUTH_TOKEN)}`;
  }
  ws = new WebSocket(wsUrl);
  ws.on('open', () => {
    wsReady = true;
    // Drain queued messages
    for (const msg of wsQueue) ws.send(msg);
    wsQueue = [];
  });
  ws.on('close', () => {
    wsReady = false;
    // Reconnect after 2s
    setTimeout(connectWs, 2000);
  });
  ws.on('error', () => {
    wsReady = false;
  });
  // We don't process incoming WS messages in v1 — fire and forget
}

function wsSend(obj) {
  const msg = JSON.stringify(obj);
  if (wsReady && ws) ws.send(msg);
  else wsQueue.push(msg);
}

// --- MCP Tool Definitions ---
const TOOLS = [
  {
    name: 'synapse_list_projects',
    description: 'List all projects in the Synapse workspace.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'synapse_create_project',
    description: 'Create a new project in the Synapse workspace. Returns the project config.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Project ID (alphanumeric, hyphens, underscores)' },
        displayName: { type: 'string', description: 'Human-readable project name' },
        projectDir: { type: 'string', description: 'Working directory for the project (default: cwd)' },
        channels: { type: 'array', items: { type: 'string' }, description: 'Initial channels (default: ["general"])' },
        mode: { type: 'string', enum: ['continuous', 'static'], description: 'Project mode (default: static)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'synapse_list_channels',
    description: 'List channels in a project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Project ID' } },
      required: ['projectId'],
    },
  },
  {
    name: 'synapse_get_messages',
    description: 'Get recent messages from a channel, optionally filtered by thread.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        channelId: { type: 'string', description: 'Channel ID' },
        threadId: { type: 'string', description: 'Optional thread ID to filter messages' },
        limit: { type: 'number', description: 'Number of messages to return (default 30)' },
      },
      required: ['projectId', 'channelId'],
    },
  },
  {
    name: 'synapse_get_threads',
    description: 'List threads in a project, optionally filtered by channel.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        channelId: { type: 'string', description: 'Optional channel to filter threads' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'synapse_get_agents',
    description: 'List all agents registered in Synapse.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'synapse_post_message',
    description: 'Post a message to a Synapse channel. This triggers the multi-agent deliberation loop — all agents will see and respond to the message.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        channelId: { type: 'string', description: 'Channel ID' },
        content: { type: 'string', description: 'Message content (supports @mentions, /commands, and markdown)' },
        threadId: { type: 'string', description: 'Optional thread ID to post in' },
        agentId: { type: 'string', description: 'Optional: your Synapse agent ID, so the message is attributed to you instead of the operator. Must match a registered agent.' },
      },
      required: ['projectId', 'channelId', 'content'],
    },
  },
  {
    name: 'synapse_get_agenda',
    description: 'Get the current agenda for a project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Project ID' } },
      required: ['projectId'],
    },
  },
  {
    name: 'synapse_get_preferences',
    description: 'Get current preferences and available schema (keys, types, defaults).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Optional project for project-scoped prefs' },
      },
      required: [],
    },
  },
  {
    name: 'synapse_health',
    description: 'Get Synapse server health: uptime, agent statuses, active threads, memory usage.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'synapse_get_budget',
    description: 'Get budget status: used, max, remaining, and per-provider breakdown with dispatches and cost tiers.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'synapse_get_deliberation_status',
    description: 'Get current deliberation status for a channel: which agents are thinking, active votes, queue state.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        channelId: { type: 'string', description: 'Channel ID' },
      },
      required: ['projectId', 'channelId'],
    },
  },
  {
    name: 'synapse_list_tasks',
    description: 'List tasks for a project. Optional status filter.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        status: { type: 'string', description: 'Filter by status: queued, planning, executing, reviewing, done, failed, cancelled' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'synapse_get_task',
    description: 'Get detailed information about a specific task including subtasks and progress.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        taskId: { type: 'string', description: 'Task ID' },
      },
      required: ['projectId', 'taskId'],
    },
  },
  {
    name: 'synapse_create_task',
    description: 'Create a new autonomous task. The heartbeat will automatically plan and execute it.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        channelId: { type: 'string', description: 'Channel ID for status updates' },
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Detailed task description' },
        doneCriteria: { type: 'string', description: 'What "done" looks like' },
        context: { type: 'string', description: 'Additional context for agents' },
      },
      required: ['projectId', 'channelId', 'title'],
    },
  },
  // --- Campaign tools ---
  {
    name: 'synapse_list_campaigns',
    description: 'List all campaigns for a project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Project ID' } },
      required: ['projectId'],
    },
  },
  {
    name: 'synapse_get_campaign',
    description: 'Get detailed campaign info including milestones, progress, and strategist state.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        campaignId: { type: 'string', description: 'Campaign ID' },
      },
      required: ['projectId', 'campaignId'],
    },
  },
  {
    name: 'synapse_create_campaign',
    description: 'Create a new campaign with a goal. The architect will decompose it into milestones.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        goal: { type: 'string', description: 'Campaign goal' },
        context: { type: 'string', description: 'Additional context for the architect' },
      },
      required: ['projectId', 'goal'],
    },
  },
  {
    name: 'synapse_inject_campaign',
    description: 'Inject a new idea or change into an active campaign for the architect to evaluate.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        campaignId: { type: 'string', description: 'Campaign ID' },
        idea: { type: 'string', description: 'The idea to inject' },
      },
      required: ['projectId', 'campaignId', 'idea'],
    },
  },
  {
    name: 'synapse_campaign_action',
    description: 'Pause or resume a campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        campaignId: { type: 'string', description: 'Campaign ID' },
        action: { type: 'string', enum: ['pause', 'resume'], description: 'Action to take' },
      },
      required: ['projectId', 'campaignId', 'action'],
    },
  },
  {
    name: 'synapse_get_campaign_closeout',
    description: 'Get the closeout summary for a completed or failed campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        campaignId: { type: 'string', description: 'Campaign ID' },
      },
      required: ['projectId', 'campaignId'],
    },
  },
  // --- Workflow tools ---
  {
    name: 'synapse_list_workflows',
    description: 'List all workflows for a project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Project ID' } },
      required: ['projectId'],
    },
  },
  {
    name: 'synapse_get_workflow',
    description: 'Get detailed workflow info including nodes and dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        workflowId: { type: 'string', description: 'Workflow ID' },
      },
      required: ['projectId', 'workflowId'],
    },
  },
  {
    name: 'synapse_run_workflow',
    description: 'Start a workflow run. Returns the run ID for tracking.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        workflowId: { type: 'string', description: 'Workflow ID' },
      },
      required: ['projectId', 'workflowId'],
    },
  },
  {
    name: 'synapse_list_workflow_runs',
    description: 'List recent runs for a workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        workflowId: { type: 'string', description: 'Workflow ID' },
      },
      required: ['projectId', 'workflowId'],
    },
  },
  // --- Schedule tools ---
  {
    name: 'synapse_list_schedules',
    description: 'List all schedules for a project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Project ID' } },
      required: ['projectId'],
    },
  },
  {
    name: 'synapse_create_schedule',
    description: 'Create a cron-based schedule to automate actions.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        name: { type: 'string', description: 'Schedule name' },
        cron: { type: 'string', description: 'Cron expression (5-field: min hour dom mon dow)' },
        actionType: { type: 'string', enum: ['message', 'task', 'workflow'], description: 'Type of action to trigger' },
        actionConfig: { type: 'object', description: 'Action configuration (channel, content, title, workflowId, etc.)' },
      },
      required: ['projectId', 'name', 'cron', 'actionType', 'actionConfig'],
    },
  },
  {
    name: 'synapse_schedule_action',
    description: 'Pause or resume a schedule.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        scheduleId: { type: 'string', description: 'Schedule ID' },
        action: { type: 'string', enum: ['pause', 'resume'], description: 'Action to take' },
      },
      required: ['projectId', 'scheduleId', 'action'],
    },
  },
  // --- Trigger tools ---
  {
    name: 'synapse_list_triggers',
    description: 'List all event-driven triggers for a project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Project ID' } },
      required: ['projectId'],
    },
  },
  {
    name: 'synapse_create_trigger',
    description: 'Create an event-driven trigger that fires an action when conditions are met.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        name: { type: 'string', description: 'Trigger name' },
        event: { type: 'string', description: 'Event to listen for (e.g. task_completed, message, campaign:milestone_completed)' },
        conditions: { type: 'object', description: 'Conditions to match (field → value/pattern)' },
        actionType: { type: 'string', enum: ['message', 'task', 'workflow'], description: 'Type of action to fire' },
        actionConfig: { type: 'object', description: 'Action configuration' },
      },
      required: ['projectId', 'name', 'event', 'actionType', 'actionConfig'],
    },
  },
  {
    name: 'synapse_trigger_action',
    description: 'Pause or resume an event-driven trigger.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        triggerId: { type: 'string', description: 'Trigger ID' },
        action: { type: 'string', enum: ['pause', 'resume'], description: 'Action to take' },
      },
      required: ['projectId', 'triggerId', 'action'],
    },
  },
  // --- Delete tools ---
  {
    name: 'synapse_delete_schedule',
    description: 'Delete a schedule.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        scheduleId: { type: 'string', description: 'Schedule ID' },
      },
      required: ['projectId', 'scheduleId'],
    },
  },
  {
    name: 'synapse_delete_trigger',
    description: 'Delete an event-driven trigger.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        triggerId: { type: 'string', description: 'Trigger ID' },
      },
      required: ['projectId', 'triggerId'],
    },
  },
  {
    name: 'synapse_delete_workflow',
    description: 'Delete a workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        workflowId: { type: 'string', description: 'Workflow ID' },
      },
      required: ['projectId', 'workflowId'],
    },
  },
  {
    name: 'synapse_delete_webhook',
    description: 'Delete a webhook subscription.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        webhookId: { type: 'string', description: 'Webhook ID' },
      },
      required: ['projectId', 'webhookId'],
    },
  },
  // --- Credential tools ---
  {
    name: 'synapse_list_credentials',
    description: 'List credential names for a project (values are never exposed).',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Project ID' } },
      required: ['projectId'],
    },
  },
  {
    name: 'synapse_set_credential',
    description: 'Create or update a credential (encrypted secret). Reference in workflows as {{credential:name}}.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        name: { type: 'string', description: 'Credential name (used in {{credential:name}} references)' },
        value: { type: 'string', description: 'Secret value (will be encrypted at rest)' },
        description: { type: 'string', description: 'Optional description' },
      },
      required: ['projectId', 'name', 'value'],
    },
  },
  {
    name: 'synapse_delete_credential',
    description: 'Delete a credential.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        name: { type: 'string', description: 'Credential name to delete' },
      },
      required: ['projectId', 'name'],
    },
  },
  // --- Webhook tools ---
  {
    name: 'synapse_list_webhooks',
    description: 'List webhook subscriptions for a project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Project ID' } },
      required: ['projectId'],
    },
  },
  {
    name: 'synapse_create_webhook',
    description: 'Create a webhook subscription to receive Synapse events at a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        url: { type: 'string', description: 'Webhook delivery URL' },
        events: { type: 'array', items: { type: 'string' }, description: 'Events to subscribe to (e.g. message, task_completed)' },
        description: { type: 'string', description: 'Optional description' },
      },
      required: ['projectId', 'url', 'events'],
    },
  },
];

// --- Tool Handlers ---
const enc = encodeURIComponent;

async function handleTool(name, args) {
  switch (name) {
    case 'synapse_list_projects': {
      const projects = await httpGet('/api/projects');
      return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
    }

    case 'synapse_create_project': {
      if (!args.id) {
        return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };
      }
      // agents roster is required at creation (defaults to null = all agents
      // when the MCP caller doesn't specify — still an explicit choice here).
      const body = { id: args.id, agents: args.agents !== undefined ? args.agents : null };
      if (args.displayName) body.displayName = args.displayName;
      if (args.projectDir) body.projectDir = args.projectDir;
      if (args.channels) body.channels = args.channels;
      if (args.mode) body.mode = args.mode;
      const resp = await httpPost('/api/projects', body);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }

    case 'synapse_list_channels': {
      const channels = await httpGet(`/api/projects/${encodeURIComponent(args.projectId)}/channels`);
      return { content: [{ type: 'text', text: JSON.stringify(channels, null, 2) }] };
    }

    case 'synapse_get_messages': {
      const limit = args.limit || 30;
      let path = `/api/projects/${encodeURIComponent(args.projectId)}/channels/${encodeURIComponent(args.channelId)}/messages?limit=${limit}`;
      if (args.threadId) path += `&threadId=${encodeURIComponent(args.threadId)}`;
      const msgs = await httpGet(path);
      return { content: [{ type: 'text', text: JSON.stringify(msgs, null, 2) }] };
    }

    case 'synapse_get_threads': {
      let path = `/api/projects/${encodeURIComponent(args.projectId)}/threads`;
      if (args.channelId) path += `?channel=${encodeURIComponent(args.channelId)}`;
      const threads = await httpGet(path);
      return { content: [{ type: 'text', text: JSON.stringify(threads, null, 2) }] };
    }

    case 'synapse_get_agents': {
      const agents = await httpGet('/api/agents');
      return { content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }] };
    }

    case 'synapse_get_preferences': {
      let path = '/api/preferences';
      if (args.projectId) path += `?project=${encodeURIComponent(args.projectId)}`;
      const prefs = await httpGet(path);
      return { content: [{ type: 'text', text: JSON.stringify(prefs, null, 2) }] };
    }

    case 'synapse_post_message': {
      if (!args.content || args.content.length > 50000) {
        return { content: [{ type: 'text', text: 'Error: content required and must be under 50KB' }], isError: true };
      }
      wsSend({
        type: 'user_message',
        content: args.content,
        project: args.projectId,
        channel: args.channelId,
        replyToThreadId: args.threadId || null,
        speaker: args.agentId || null,
      });
      return {
        content: [{ type: 'text', text: `Message posted to ${args.projectId}#${args.channelId}. Deliberation loop triggered — agents will respond asynchronously. Use synapse_get_messages to check for responses.` }],
      };
    }

    case 'synapse_get_agenda': {
      // Agenda is stored per-project. We read it via the agenda.json file path convention.
      // Since we can't import agenda.js directly (different process), we use the REST approach.
      // The agenda endpoint doesn't exist yet, so we post /agenda show and read the response.
      // Better: just read the file directly.
      try {
        const resp = await httpGet(`/api/projects/${encodeURIComponent(args.projectId)}/agenda`);
        return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: 'No agenda endpoint available. Post "/agenda" via synapse_post_message to view agenda.' }] };
      }
    }

    case 'synapse_health': {
      // Post /health --json to a temp context and read back
      // Better: add a REST health endpoint. For now, proxy the existing data.
      try {
        const resp = await httpGet('/api/health');
        return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: 'Health endpoint not available. Post "/health" via synapse_post_message.' }] };
      }
    }

    case 'synapse_get_budget': {
      try {
        const resp = await httpGet('/api/budget');
        return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: 'Budget endpoint not available.' }] };
      }
    }

    case 'synapse_get_deliberation_status': {
      try {
        const resp = await httpGet(`/api/projects/${encodeURIComponent(args.projectId)}/channels/${encodeURIComponent(args.channelId)}/status`);
        return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: 'Deliberation status endpoint not available yet. Use synapse_get_messages to check for recent agent activity.' }] };
      }
    }

    case 'synapse_list_tasks': {
      let path = `/api/projects/${encodeURIComponent(args.projectId)}/tasks`;
      if (args.status) path += `?status=${encodeURIComponent(args.status)}`;
      const tasks = await httpGet(path);
      return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
    }

    case 'synapse_get_task': {
      const task = await httpGet(`/api/projects/${encodeURIComponent(args.projectId)}/tasks/${encodeURIComponent(args.taskId)}`);
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    }

    case 'synapse_create_task': {
      // Create task via posting a /task create command through WS
      const title = args.title;
      const desc = args.description ? ` --desc "${args.description}"` : '';
      const done = args.doneCriteria ? ` --done "${args.doneCriteria}"` : '';
      const ctx = args.context ? ` --context "${args.context}"` : '';
      wsSend({
        type: 'user_message',
        content: `/task create ${title}${done}${ctx}`,
        project: args.projectId,
        channel: args.channelId,
      });
      return {
        content: [{ type: 'text', text: `Task creation requested: "${title}" in ${args.projectId}#${args.channelId}. The heartbeat will pick it up and begin planning. Use synapse_list_tasks to check status.` }],
      };
    }

    // --- Campaign handlers ---
    case 'synapse_list_campaigns': {
      const resp = await httpGet(`/api/projects/${enc(args.projectId)}/campaigns`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_get_campaign': {
      const resp = await httpGet(`/api/projects/${enc(args.projectId)}/campaigns/${enc(args.campaignId)}`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_create_campaign': {
      const body = { goal: args.goal };
      if (args.context) body.context = args.context;
      const resp = await httpPost(`/api/projects/${enc(args.projectId)}/campaigns`, body);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_inject_campaign': {
      const resp = await httpPost(`/api/projects/${enc(args.projectId)}/campaigns/${enc(args.campaignId)}/inject`, { idea: args.idea });
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_campaign_action': {
      const resp = await httpPost(`/api/projects/${enc(args.projectId)}/campaigns/${enc(args.campaignId)}/${args.action}`, {});
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_get_campaign_closeout': {
      const resp = await httpGet(`/api/projects/${enc(args.projectId)}/campaigns/${enc(args.campaignId)}/closeout`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }

    // --- Workflow handlers ---
    case 'synapse_list_workflows': {
      const resp = await httpGet(`/api/projects/${enc(args.projectId)}/workflows`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_get_workflow': {
      const resp = await httpGet(`/api/projects/${enc(args.projectId)}/workflows/${enc(args.workflowId)}`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_run_workflow': {
      const resp = await httpPost(`/api/projects/${enc(args.projectId)}/workflows/${enc(args.workflowId)}/run`, {});
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_list_workflow_runs': {
      const resp = await httpGet(`/api/projects/${enc(args.projectId)}/workflows/${enc(args.workflowId)}/runs`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }

    // --- Schedule handlers ---
    case 'synapse_list_schedules': {
      const resp = await httpGet(`/api/projects/${enc(args.projectId)}/schedules`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_create_schedule': {
      const body = { name: args.name, cron: args.cron, actionType: args.actionType, actionConfig: args.actionConfig };
      const resp = await httpPost(`/api/projects/${enc(args.projectId)}/schedules`, body);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_schedule_action': {
      const resp = await httpPost(`/api/projects/${enc(args.projectId)}/schedules/${enc(args.scheduleId)}/${args.action}`, {});
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }

    // --- Trigger handlers ---
    case 'synapse_list_triggers': {
      const resp = await httpGet(`/api/projects/${enc(args.projectId)}/triggers`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_create_trigger': {
      const body = {
        name: args.name, event: args.event, actionType: args.actionType,
        actionConfig: args.actionConfig,
      };
      if (args.conditions) body.conditions = args.conditions;
      const resp = await httpPost(`/api/projects/${enc(args.projectId)}/triggers`, body);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_trigger_action': {
      const resp = await httpPost(`/api/projects/${enc(args.projectId)}/triggers/${enc(args.triggerId)}/${args.action}`, {});
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }

    // --- Delete handlers ---
    case 'synapse_delete_schedule': {
      const resp = await httpDelete(`/api/projects/${enc(args.projectId)}/schedules/${enc(args.scheduleId)}`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_delete_trigger': {
      const resp = await httpDelete(`/api/projects/${enc(args.projectId)}/triggers/${enc(args.triggerId)}`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_delete_workflow': {
      const resp = await httpDelete(`/api/projects/${enc(args.projectId)}/workflows/${enc(args.workflowId)}`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_delete_webhook': {
      const resp = await httpDelete(`/api/projects/${enc(args.projectId)}/webhooks/${enc(args.webhookId)}`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }

    // --- Credential handlers ---
    case 'synapse_list_credentials': {
      const resp = await httpGet(`/api/projects/${enc(args.projectId)}/credentials`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_set_credential': {
      const body = { name: args.name, value: args.value };
      if (args.description) body.description = args.description;
      const resp = await httpPost(`/api/projects/${enc(args.projectId)}/credentials`, body);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_delete_credential': {
      const resp = await httpDelete(`/api/projects/${enc(args.projectId)}/credentials/${enc(args.name)}`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }

    // --- Webhook handlers ---
    case 'synapse_list_webhooks': {
      const resp = await httpGet(`/api/projects/${enc(args.projectId)}/webhooks`);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }
    case 'synapse_create_webhook': {
      const body = { url: args.url, events: args.events };
      if (args.description) body.description = args.description;
      const resp = await httpPost(`/api/projects/${enc(args.projectId)}/webhooks`, body);
      return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

// --- MCP JSON-RPC Protocol ---
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'synapse-mcp', version: '1.0.0' };
const CAPABILITIES = {
  tools: {},
};

function makeResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRequest(req) {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      return makeResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      });

    case 'notifications/initialized':
      // Client confirms initialization — no response needed
      return null;

    case 'tools/list':
      return makeResponse(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: toolArgs } = params;
      try {
        const result = await handleTool(name, toolArgs || {});
        return makeResponse(id, result);
      } catch (err) {
        return makeResponse(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }

    case 'ping':
      return makeResponse(id, {});

    default:
      // Unknown method — return error for requests with id, ignore notifications
      if (id != null) {
        return makeError(id, -32601, `Method not found: ${method}`);
      }
      return null;
  }
}

// --- stdio Transport ---
export function startMcpStdioServer() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    try {
      const req = JSON.parse(line);
      const resp = await handleRequest(req);
      if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
    } catch {
      process.stdout.write(JSON.stringify(makeError(null, -32700, 'Parse error')) + '\n');
    }
  });

  connectWs();
  // Log to stderr (stdout is for MCP protocol)
  process.stderr.write(`Synapse MCP server started (${AGENT_ID}) → ${SYNAPSE_URL}\n`);
  return rl;
}

const isDirectEntry = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectEntry) startMcpStdioServer();

export { TOOLS };
