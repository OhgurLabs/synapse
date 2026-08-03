import { randomUUID, timingSafeEqual } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('mcp-server');

const PROTOCOL_VERSION = '2025-03-26';

function jsonRpcError(id, code, message, data = null) {
  const err = { jsonrpc: '2.0', id, error: { code, message } };
  if (data) err.error.data = data;
  return err;
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// TTL sweep — sessions were only ever removed via explicit DELETE, so
// clients that never sent one leaked a session entry per initialize forever.
const sessionSweep = setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.lastActivity < cutoff) sessions.delete(id);
  }
}, 60 * 60 * 1000);
sessionSweep.unref?.();

function createSession(identity) {
  const sessionId = randomUUID();
  sessions.set(sessionId, {
    id: sessionId,
    identity,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  });
  return sessionId;
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) session.lastActivity = Date.now();
  return session || null;
}

function deleteSession(sessionId) {
  sessions.delete(sessionId);
}

export function createMcpServer(deps) {
  const {
    credentialVault, stateManager, campaignManager, taskManager,
    addMessage, agents, config, auth,
    mergeCampaignBranch, rollbackLastMerge,
    queueTurn, handleUserMessage,
  } = deps;

  const operatorName = config.operator?.name || 'operator';

  const TOOLS = {
    'chat.send': {
      description: 'Send a message to a channel',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project ID' },
          channel: { type: 'string', description: 'Channel ID' },
          content: { type: 'string', description: 'Message content' },
          replyTo: { type: 'string', description: 'Message ID to reply to' },
          mode: { type: 'string', description: 'Routing mode: solo | pair | council (default: auto-classify)' },
        },
        required: ['content'],
      },
      roles: ['operator', 'agent_operator'],
    },
    'chat.read': {
      description: 'Read recent messages from a channel',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project ID' },
          channel: { type: 'string', description: 'Channel ID' },
          limit: { type: 'number', description: 'Max messages to return (default 50)' },
        },
      },
      roles: ['operator', 'agent_operator'],
    },
    'campaign.list': {
      description: 'List campaigns for a project',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project ID' },
          status: { type: 'string', description: 'Filter by status' },
        },
      },
      roles: ['operator', 'agent_operator'],
    },
    'campaign.approve': {
      description: 'Approve and merge a campaign branch',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project ID' },
          campaign: { type: 'string', description: 'Campaign ID' },
        },
        required: ['project', 'campaign'],
      },
      roles: ['operator'],
    },
    'campaign.reject': {
      description: 'Reject a campaign',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project ID' },
          campaign: { type: 'string', description: 'Campaign ID' },
          reason: { type: 'string', description: 'Rejection reason' },
        },
        required: ['project', 'campaign'],
      },
      roles: ['operator'],
    },
    'campaign.rollback': {
      description: 'Rollback the last merge for a campaign',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project ID' },
          campaign: { type: 'string', description: 'Campaign ID' },
        },
        required: ['project', 'campaign'],
      },
      roles: ['operator'],
    },
    'task.read': {
      description: 'Read task details',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project ID' },
          task: { type: 'string', description: 'Task ID' },
        },
        required: ['project', 'task'],
      },
      roles: ['operator', 'agent_operator'],
    },
    'agent.list': {
      description: 'List registered agents',
      inputSchema: { type: 'object', properties: {} },
      roles: ['operator', 'agent_operator'],
    },
  };

  function authenticate(req) {
    if (!auth) return { authenticated: true, identity: { name: operatorName, role: 'operator' } };
    const authResult = auth.isAuthenticated(req);
    if (!authResult.authenticated) return { authenticated: false, identity: null };

    // Check for agent token in vault
    const bearer = req.headers?.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7) : null;
    if (bearer && credentialVault) {
      try {
        const bearerBuf = Buffer.from(bearer);
        const projects = stateManager.listProjects();
        for (const proj of projects) {
          const pId = proj.id || proj;
          // Agent tokens are stored as agent-token-<name> credentials whose
          // value IS the bearer. Compare timing-safe — a plain === leaks
          // prefix-match timing.
          const allCreds = credentialVault.list(pId);
          for (const cred of allCreds) {
            if (!String(cred.name).startsWith('agent-token-')) continue;
            const val = credentialVault.resolve(pId, cred.name);
            if (typeof val !== 'string') continue;
            const valBuf = Buffer.from(val);
            if (valBuf.length === bearerBuf.length && timingSafeEqual(valBuf, bearerBuf)) {
              const agentName = cred.name.replace('agent-token-', '');
              return {
                authenticated: true,
                identity: { name: agentName, role: 'agent_operator', agentId: agentName },
              };
            }
          }
        }
      } catch {}
    }

    // API keys carry their own role — a viewer/reviewer key must not get
    // the full operator MCP toolset. Master token / session fall through to
    // operator (single-tenant trust).
    if (authResult.role && authResult.role !== 'operator' && authResult.role !== 'admin') {
      return { authenticated: true, identity: { name: authResult.userId || 'api-key', role: authResult.role } };
    }
    return { authenticated: true, identity: { name: authResult.userId && authResult.userId.startsWith('apikey:') ? authResult.userId : operatorName, role: 'operator' } };
  }

  async function handleToolCall(name, args, identity) {
    const toolDef = TOOLS[name];
    if (!toolDef) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    if (!toolDef.roles.includes(identity.role)) {
      return { content: [{ type: 'text', text: `Permission denied: role '${identity.role}' cannot call ${name}` }], isError: true };
    }

    const projectId = args.project || 'synapse';
    const channelId = args.channel || 'general';

    switch (name) {
      case 'chat.send': {
        if (!args.content) return { content: [{ type: 'text', text: 'content is required' }], isError: true };
        // Route through the SAME dispatch pipeline as a typed UI message so
        // agents actually respond. The old addMessage-only path persisted the
        // text into the transcript and nothing ever answered — an external
        // harness talking into the void.
        if (queueTurn && handleUserMessage) {
          const threadMeta = { mode: args.mode || undefined };
          queueTurn(projectId, channelId, identity.name, () =>
            handleUserMessage(args.content, projectId, channelId, threadMeta, identity.name, identity.name)
          );
          return { content: [{ type: 'text', text: `Message dispatched as ${identity.name} in ${projectId}/${channelId} — agents will respond in-channel (use chat.read to poll)` }] };
        }
        addMessage(projectId, channelId, identity.name, args.content, 'message', {
          replyTo: args.replyTo || null,
          source: 'mcp',
        });
        return { content: [{ type: 'text', text: `Message sent as ${identity.name} in ${projectId}/${channelId}` }] };
      }
      case 'chat.read': {
        const limit = args.limit || 50;
        const messages = stateManager.getMessages(projectId, channelId, limit);
        return { content: [{ type: 'text', text: JSON.stringify(messages.slice(-limit), null, 2) }] };
      }
      case 'campaign.list': {
        if (!campaignManager) return { content: [{ type: 'text', text: 'Campaign manager not available' }], isError: true };
        const data = campaignManager.load(projectId);
        let camps = data.campaigns || [];
        if (args.status) camps = camps.filter(c => c.status === args.status);
        return { content: [{ type: 'text', text: JSON.stringify(camps.map(c => ({
          id: c.id, title: c.title, status: c.status, branch: c.branch, milestoneCount: c.milestones?.length,
        })), null, 2) }] };
      }
      case 'campaign.approve': {
        if (!campaignManager) return { content: [{ type: 'text', text: 'Campaign manager not available' }], isError: true };
        const campaign = campaignManager.getCampaign(projectId, args.campaign);
        if (!campaign) return { content: [{ type: 'text', text: 'Campaign not found' }], isError: true };
        if (!campaign.branch) return { content: [{ type: 'text', text: 'Campaign has no branch to merge' }], isError: true };
        const projectDir = stateManager.getProject(projectId)?.projectDir;
        if (!projectDir) return { content: [{ type: 'text', text: 'Project directory not found' }], isError: true };
        const repoConfig = stateManager.getProjectRepoConfig?.(projectId);
        const result = mergeCampaignBranch(projectDir, args.campaign, campaign.title, repoConfig);
        if (!result.success) return { content: [{ type: 'text', text: `Merge failed: ${result.error}` }], isError: true };
        campaignManager.updateCampaignStatus(projectId, args.campaign, 'completed', 'Merged via MCP');
        return { content: [{ type: 'text', text: `Campaign "${campaign.title}" merged and completed` }] };
      }
      case 'campaign.reject': {
        if (!campaignManager) return { content: [{ type: 'text', text: 'Campaign manager not available' }], isError: true };
        // Pass taskManager → cascade-cancel queued+planning child tasks (executing left to finish).
        campaignManager.updateCampaignStatus(projectId, args.campaign, 'failed', args.reason || 'Rejected via MCP', null, taskManager);
        return { content: [{ type: 'text', text: `Campaign ${args.campaign} rejected` }] };
      }
      case 'campaign.rollback': {
        if (!campaignManager) return { content: [{ type: 'text', text: 'Campaign manager not available' }], isError: true };
        const projectDir = stateManager.getProject(projectId)?.projectDir;
        if (!projectDir) return { content: [{ type: 'text', text: 'Project directory not found' }], isError: true };
        const result = rollbackLastMerge(projectDir);
        if (!result.success) return { content: [{ type: 'text', text: `Rollback failed: ${result.error}` }], isError: true };
        campaignManager.updateCampaignStatus(projectId, args.campaign, 'failed', 'Rolled back via MCP', null, taskManager);
        return { content: [{ type: 'text', text: 'Last merge rolled back' }] };
      }
      case 'task.read': {
        if (!taskManager) return { content: [{ type: 'text', text: 'Task manager not available' }], isError: true };
        const task = taskManager.getTask(projectId, args.task);
        if (!task) return { content: [{ type: 'text', text: 'Task not found' }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify({
          id: task.id, title: task.title, status: task.status, campaignId: task.campaignId,
          subtasks: (task.subtasks || []).map(s => ({ id: s.id, status: s.status, assignee: s.assignee })),
          trustScore: task.trustScore, validationReport: task.validationReport ? {
            overallPass: task.validationReport.overallPass,
            stats: task.validationReport.stats,
          } : null,
        }, null, 2) }] };
      }
      case 'agent.list': {
        const agentList = Object.entries(agents).map(([id, a]) => ({
          id, name: a.name, provider: a.provider, model: a.model, status: a._status,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(agentList, null, 2) }] };
      }
      default:
        return { content: [{ type: 'text', text: `Unhandled tool: ${name}` }], isError: true };
    }
  }

  async function handleRequest(req, res) {
    const authResult = authenticate(req);
    if (!authResult.authenticated) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(null, -32001, 'Unauthorized')));
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')));
      return;
    }

    // Guard the shape before destructuring: a body of `null`, an array, or a
    // scalar is valid JSON but destructuring it threw OUTSIDE any try/catch,
    // and api.js calls handleRequest without .catch — on Node 20 that
    // unhandled rejection can take the whole orchestrator down.
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(null, -32600, 'Invalid Request')));
      return;
    }
    const { jsonrpc, id, method, params } = body;

    if (jsonrpc !== '2.0') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(id, -32600, 'Invalid Request')));
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const session = sessionId ? getSession(sessionId) : null;

    // Handle methods
    switch (method) {
      case 'initialize': {
        const newSessionId = createSession(authResult.identity);
        const result = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'synapse', version: '0.1.0-beta' },
        };
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': newSessionId,
        });
        res.end(JSON.stringify(jsonRpcResult(id, result)));
        log.info('MCP session initialized', { sessionId: newSessionId, identity: authResult.identity.name });
        return;
      }
      case 'notifications/initialized': {
        res.writeHead(202);
        res.end();
        return;
      }
      case 'tools/list': {
        const identity = session?.identity || authResult.identity;
        const filteredTools = Object.entries(TOOLS)
          .filter(([, def]) => def.roles.includes(identity.role))
          .map(([name, def]) => ({ name, description: def.description, inputSchema: def.inputSchema }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcResult(id, { tools: filteredTools })));
        return;
      }
      case 'tools/call': {
        const identity = session?.identity || authResult.identity;
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        try {
          const result = await handleToolCall(toolName, toolArgs, identity);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(jsonRpcResult(id, { content: result.content, isError: result.isError || false })));
        } catch (err) {
          log.error('MCP tool call failed', { tool: toolName, error: err.message });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(jsonRpcResult(id, {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          })));
        }
        return;
      }
      case 'ping': {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcResult(id, {})));
        return;
      }
      default: {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcError(id, -32601, `Method not found: ${method}`)));
      }
    }
  }

  return { handleRequest, TOOLS, authenticate };
}

const MAX_MCP_BODY_BYTES = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    const onData = chunk => {
      received += chunk.length;
      if (received > MAX_MCP_BODY_BYTES) {
        req.removeListener('data', onData);
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
