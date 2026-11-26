import { randomUUID, timingSafeEqual, createHash } from 'crypto';
import { vaultSearch, vaultRead, vaultPropose } from './vault-tools.js';
import { createLogger } from '../logger.js';
import { parseConversationOptions } from './chat-protocol.js';
import { assertSafeId, assertSafeProjectId } from '../safe-id.js';
import { createPolicyEngine } from './policy.js';

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
    identity: Object.freeze({ ...identity }),
    lastActivity: Date.now(),
  });
  return sessionId;
}

function checkSession(sessionId, identity) {
  const session = sessions.get(sessionId);
  if (!session || Date.now() - session.lastActivity >= SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return 404;
  }
  if (['credentialId', 'name', 'role', 'scopedProjectId'].some(key => session.identity[key] !== identity[key])) {
    return 403;
  }
  session.lastActivity = Date.now();
  return 200;
}

export function createMcpServer(deps) {
  const {
    credentialVault, stateManager, campaignManager, taskManager,
    addMessage, agents, config, auth,
    mergeCampaignBranch, rollbackLastMerge,
    queueTurn, handleUserMessage,
    timelineStore, eventBus, loopService, councilService,
  } = deps;

  function emitVaultChannelUsed(toolName, projectId, identity) {
    const evt = {
      channel: 'vault',
      tool: toolName,
      projectId: projectId || null,
      agentId: identity?.name || null,
      sessionId: null,
      timestamp: new Date().toISOString(),
    };
    if (timelineStore?.ingest) {
      try { timelineStore.ingest('context_channel_used', evt, { projectId: evt.projectId, agentId: evt.agentId }); } catch {}
    }
    if (eventBus?.emit) {
      try { eventBus.emit('context:channel_used', evt)?.catch?.(() => {}); } catch {}
    }
  }

  const operatorName = config.operator?.name || 'operator';
  const policyEngine = createPolicyEngine({ config });
  const allowsTool = (tool, role) => tool.roles.includes(role === 'admin' ? 'operator' : role);

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
          conversation: {
            type: 'object',
            description: 'Speaking rules and optional timeouts for this channel thread',
            required: ['mode'],
            properties: {
              mode: { enum: ['discussion', 'roundtable', 'debate'] },
              turnTimeoutMs: { type: 'integer', minimum: 1000, maximum: 1800000 },
              localTurnTimeoutMs: { type: 'integer', minimum: 1000, maximum: 1800000 },
              rounds: { type: 'integer', minimum: 1, maximum: 4 },
              order: { type: 'array', items: { type: 'string' } },
              sides: { type: 'array', items: {
                type: 'object', required: ['label', 'opener'],
                properties: { label: { type: 'string' }, opener: { type: 'string' } },
              } },
              missingOpening: { enum: ['stop', 'continue'] },
            },
          },
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
    // THE AGENT WRITE PATH (2026-08-20). Until now every MCP tool an agent
    // could reach was read-only apart from chat, so an agent that found real
    // work had no way to record it: it could only describe the finding in
    // channel and hope a human transcribed it. An agent demonstrated this on
    // 2026-08-19 -- it read the state directly, correctly refused to borrow
    // operator credentials, and stalled.
    //
    // Scope is deliberately CREATE ONLY. There is no status or verdict write
    // here, because taskManager exposes only a general updateTaskStatus and
    // handing that to agents makes false-completion easier, not harder:
    // agents could mark work complete even when verification is still failing.
    // Agents file work. The
    // operator and the review path decide what is finished.
    //
    // Tasks land in the normal 'queued' state and are attributed to the calling
    // identity rather than 'system', so the audit trail names the author.
    'task.create': {
      description: 'Create a queued task. Use to file a finding or follow-up work as yourself. Cannot set status.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project ID' },
          title: { type: 'string', description: 'Short task title' },
          description: { type: 'string', description: 'Full detail; defaults to the title' },
          doneCriteria: { type: 'string', description: 'Observable completion criteria' },
          campaign: { type: 'string', description: 'Optional campaign ID to attach the task to' },
          channel: { type: 'string', description: 'Channel/category (default: general)' },
        },
        required: ['project', 'title'],
      },
      roles: ['operator', 'agent_operator'],
    },
    'vault.search': {
      description: 'Search filenames and headings in the project knowledge vault (read-only)',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project ID' },
          query: { type: 'string', description: 'Search query (matches filenames and headings)' },
          limit: { type: 'number', description: 'Max results (capped at 20)' },
        },
        required: ['project'],
      },
      roles: ['operator', 'agent_operator'],
    },
    'vault.read': {
      description: 'Read a single note from the project knowledge vault (strictly confined to project vault)',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project ID' },
          relPath: { type: 'string', description: 'Vault-relative path to the note' },
          maxChars: { type: 'number', description: 'Max characters to return (default 16000)' },
        },
        required: ['project', 'relPath'],
      },
      roles: ['operator', 'agent_operator'],
    },
    'vault.propose': {
      description: 'Submit a proposed vault note edit for review (writes ONLY to vault/.proposals/, never mutates live notes)',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project ID' },
          relPath: { type: 'string', description: 'Target vault-relative path for the proposed note' },
          body: { type: 'string', description: 'Proposed markdown content' },
          rationale: { type: 'string', description: 'Why this update is proposed' },
        },
        required: ['project', 'relPath', 'body'],
      },
      roles: ['operator', 'agent_operator'],
    },
    'loop.list': {
      description: 'List authorized static Loops, optionally filtered by projectId or scope="global"',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Optional project or sub-project ID filter' },
          scope: { type: 'string', description: 'Pass "global" to list standalone Loops' },
        },
      },
      roles: ['operator', 'agent_operator'],
    },
    'loop.get': {
      description: 'Get details, current version, schedule preview, and recent runs for a Loop',
      inputSchema: {
        type: 'object',
        properties: {
          loopId: { type: 'string', description: 'Loop ID' },
        },
        required: ['loopId'],
      },
      roles: ['operator', 'agent_operator'],
    },
    'loop.runs': {
      description: 'List runs for a Loop',
      inputSchema: {
        type: 'object',
        properties: {
          loopId: { type: 'string', description: 'Loop ID' },
        },
        required: ['loopId'],
      },
      roles: ['operator', 'agent_operator'],
    },
    'loop.run_get': {
      description: 'Get full detail, attempts, and Anchor results for one LoopRun',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'LoopRun ID' },
          loopId: { type: 'string', description: 'Optional Loop ID assertion' },
        },
        required: ['runId'],
      },
      roles: ['operator', 'agent_operator'],
    },
    'loop.evidence': {
      description: 'Read verified finalized Evidence Packet summary and checksum manifest for a LoopRun',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'LoopRun ID' },
          loopId: { type: 'string', description: 'Optional Loop ID assertion' },
        },
        required: ['runId'],
      },
      roles: ['operator', 'agent_operator'],
    },
    'loop.publish': {
      description: 'Publish an immutable Loop version using optimistic CAS baseVersion (operator-only)',
      inputSchema: {
        type: 'object',
        properties: {
          loopId: { type: 'string', description: 'Optional Loop ID (must match manifest.loopId if provided)' },
          baseVersion: { type: 'number', description: 'Expected current version (0 for v1)' },
          manifest: { type: 'object', description: 'LoopManifest object' },
          projectId: { type: 'string', description: 'Optional bound project/sub-project ID' },
        },
        required: ['manifest'],
      },
      roles: ['operator'],
    },
    'loop.run': {
      description: 'Trigger a manual pinned LoopRun (operator-only)',
      inputSchema: {
        type: 'object',
        properties: {
          loopId: { type: 'string', description: 'Loop ID' },
          loopVersion: { type: 'number', description: 'Optional explicit Loop version' },
          projectId: { type: 'string', description: 'Optional target project ID' },
          subProjectId: { type: 'string', description: 'Optional target sub-project ID' },
          params: { type: 'object', description: 'Typed runtime parameters' },
          requestId: { type: 'string', description: 'Optional idempotency requestId' },
          source: { type: 'object', description: 'Optional Git source { repoId, baseSha, sourceRef, prId }' },
        },
        required: ['loopId'],
      },
      roles: ['operator'],
    },
    'loop.schedule': {
      description: 'Arm, update (preset/cron), or disarm a Loop schedule (operator-only)',
      inputSchema: {
        type: 'object',
        properties: {
          loopId: { type: 'string', description: 'Loop ID' },
          enabled: { type: 'boolean', description: 'true to arm, false to disarm' },
          loopVersion: { type: 'number', description: 'Version to arm' },
          cadence: { type: 'object', description: 'Optional cadence ({ preset, ... } or { cron })' },
          timezone: { type: 'string', description: 'Optional IANA timezone' },
          overlap: { type: 'string', description: 'skip | queue | cancel-prior' },
          missedRun: { type: 'string', description: 'skip | run-once-if-missed' },
        },
        required: ['loopId'],
      },
      roles: ['operator'],
    },
    'loop.cancel': {
      description: 'Request fenced cancellation of an active LoopRun (operator-only)',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'LoopRun ID' },
          loopId: { type: 'string', description: 'Optional Loop ID assertion' },
        },
        required: ['runId'],
      },
      roles: ['operator'],
    },
    'loop.approve': {
      description: 'Operator-gated approval of a LoopRun in awaiting_approval at exact source SHA & digests',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'LoopRun ID' },
          loopId: { type: 'string', description: 'Optional Loop ID assertion' },
          approvedSourceSha: { type: 'string', description: 'Exact Git SHA reviewed & anchored' },
          reviewSha256: { type: 'string', description: 'Checker review report SHA-256' },
          anchorSetSha256: { type: 'string', description: 'Computed Anchor set SHA-256' },
          approvalEventId: { type: 'string', description: 'Optional idempotent approvalEventId' },
        },
        required: ['runId', 'approvedSourceSha', 'reviewSha256', 'anchorSetSha256'],
      },
      roles: ['operator'],
    },
    'subproject.list': {
      description: 'List authorized child sub-projects and upward visibility summary under a parent project',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Parent project ID' },
        },
        required: ['projectId'],
      },
      roles: ['operator', 'agent_operator'],
    },
    'subproject.create': {
      description: 'Create a child sub-project under a parent project (operator-only)',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Parent project ID' },
          slug: { type: 'string', description: 'Child slug (unique under parent)' },
          title: { type: 'string', description: 'Optional display title' },
          params: { type: 'object', description: 'Optional child default parameters' },
          roster: { description: 'Omit to inherit parent roster, pass null for ALL, or a RosterSpec' },
          workspaceMode: { type: 'string', description: 'subdir | sibling (default subdir)' },
        },
        required: ['projectId', 'slug'],
      },
      roles: ['operator'],
    },
    'council.start': {
      description: 'Start a Lean Cross-Platform Council session (counsel | open_dialog | convergence; operator-only)',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID' },
          requestId: { type: 'string', description: 'Idempotent request ID' },
          subject: { type: 'object', description: '{ kind: "topic", text } or { kind: "task", taskId }' },
          mode: { type: 'string', description: 'counsel | open_dialog | convergence (default: counsel)' },
          maxTokens: { type: 'number', description: 'Optional positive integer token ceiling <= project cap' },
        },
        required: ['projectId', 'requestId', 'subject'],
      },
      roles: ['operator'],
    },
    'council.list': {
      description: 'List Council sessions and observed outcome metrics for a project',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID' },
          limit: { type: 'number', description: 'Max sessions to return' },
        },
        required: ['projectId'],
      },
      roles: ['operator', 'agent_operator'],
    },
    'council.verdict': {
      description: 'Record an operator verdict (adopted | rejected | partial) for a Council session (operator-only)',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID' },
          sessionId: { type: 'string', description: 'Council session ID' },
          verdict: { type: 'string', description: 'adopted | rejected | partial' },
          requestId: { type: 'string', description: 'Idempotent request ID' },
        },
        required: ['projectId', 'sessionId', 'verdict', 'requestId'],
      },
      roles: ['operator'],
    },
  };

  function constantTimeTokenMatch(expected, candidate) {
    if (typeof expected !== 'string' || typeof candidate !== 'string' || !expected || !candidate) return false;
    const hA = createHash('sha256').update(expected).digest();
    const hB = createHash('sha256').update(candidate).digest();
    if (!timingSafeEqual(hA, hB)) return false;
    const bA = Buffer.from(expected);
    const bB = Buffer.from(candidate);
    return bA.length === bB.length && timingSafeEqual(bA, bB);
  }

  function resolveAgentBearer(bearer) {
    if (!bearer || !credentialVault) return null;
    try {
      // 1. Check global agent tokens first (no project scan)
      if (typeof credentialVault.listGlobalAgentTokens === 'function') {
        for (const cred of credentialVault.listGlobalAgentTokens()) {
          if (!String(cred.name).startsWith('agent-token-')) continue;
          const val = credentialVault.resolveGlobalAgentToken(cred.name);
          if (constantTimeTokenMatch(val, bearer)) {
            const agentName = cred.name.replace(/^agent-token-/, '');
            return {
              name: agentName,
              role: 'agent_operator',
              agentId: agentName,
              scopedProjectId: null,
            };
          }
        }
      }
      // 2. Check project-scoped agent tokens
      const projects = stateManager?.listProjects?.() || [];
      for (const proj of projects) {
        const pId = proj.id || proj;
        const allCreds = credentialVault.list(pId);
        for (const cred of allCreds) {
          if (!String(cred.name).startsWith('agent-token-')) continue;
          const val = credentialVault.resolve(pId, cred.name);
          if (constantTimeTokenMatch(val, bearer)) {
            const agentName = cred.name.replace(/^agent-token-/, '');
            return {
              name: agentName,
              role: 'agent_operator',
              agentId: agentName,
              scopedProjectId: pId,
            };
          }
        }
      }
    } catch { /* fail closed */ }
    return null;
  }

  function authenticate(req) {
    if (!auth) return { authenticated: true, identity: { credentialId: 'local', name: operatorName, role: 'operator', scopedProjectId: null } };

    const authHeader = req.headers?.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    // 1. Existing master token / syn_* API key / session cookie check
    const authResult = auth.isAuthenticated(req);
    if (authResult.authenticated) {
      const name = authResult.userId || operatorName;
      const credential = authResult.credentialType === 'cookie'
        ? auth.getSessionCookie(req)
        : (auth.extractToken?.(req) || bearer);
      const credentialId = authResult.apiKeyId || (credential
        ? createHash('sha256').update(credential).digest('hex')
        : authResult.credentialType || 'local');
      return {
        authenticated: true,
        identity: {
          credentialId, name,
          role: policyEngine.resolveRole(name, authResult.role),
          scopedProjectId: authResult.scopedProjectId || null,
        },
      };
    }

    // 2. Phase 1B P0 Fix: when auth.isAuthenticated() returns false and a Bearer header is present,
    //    check CredentialVault agent-token-* credentials (timing-safe) BEFORE rejecting 401!
    if (bearer && credentialVault) {
      const agentIdentity = resolveAgentBearer(bearer);
      if (agentIdentity) {
        const credentialId = createHash('sha256').update(bearer).digest('hex');
        return { authenticated: true, identity: { ...agentIdentity, credentialId } };
      }
    }

    return { authenticated: false, identity: null };
  }

  async function handleToolCall(name, args, identity) {
    const toolDef = TOOLS[name];
    if (!toolDef) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    if (!allowsTool(toolDef, identity.role)) {
      return { content: [{ type: 'text', text: `Permission denied: role '${identity.role}' cannot call ${name}` }], isError: true };
    }

    const requestedProject = args?.project ?? null;
    if (identity?.scopedProjectId && requestedProject !== null && requestedProject !== identity.scopedProjectId) {
      return {
        content: [{ type: 'text', text: `Permission denied: agent token is scoped to project '${identity.scopedProjectId}', cannot access '${requestedProject}'` }],
        isError: true,
      };
    }
    const projectId = requestedProject ?? identity?.scopedProjectId ?? 'synapse';
    const channelId = args?.channel ?? 'general';
    if (name === 'chat.read' || name === 'chat.send') {
      assertSafeProjectId(projectId);
      assertSafeId(channelId, 'channel ID');
      if (!stateManager.getChannel(projectId, channelId)) throw new Error('Channel not found in project');
    }

    switch (name) {
      case 'chat.send': {
        if (typeof args.content !== 'string' || !args.content.trim() || args.content.length > 50000) {
          return { content: [{ type: 'text', text: 'content must be a non-empty string up to 50KB' }], isError: true };
        }
        try {
          parseConversationOptions(args.conversation);
        } catch (error) {
          return { content: [{ type: 'text', text: error.message }], isError: true };
        }
        // Route through the SAME dispatch pipeline as a typed UI message so
        // agents actually respond. The old addMessage-only path persisted the
        // text into the transcript and nothing ever answered — an external
        // harness talking into the void.
        if (queueTurn && handleUserMessage) {
          const threadMeta = {
            mode: args.mode || undefined,
            replyTo: args.replyTo || null,
            conversation: args.conversation,
            authIdentity: {
              principalId: identity.name,
              role: identity.role,
              agentId: identity.agentId || null,
              scopedProjectId: identity.scopedProjectId || null,
            },
          };
          queueTurn(projectId, channelId, identity.name, () =>
            handleUserMessage(args.content, projectId, channelId, threadMeta, identity.name, identity.name)
          );
          return { content: [{ type: 'text', text: `Message dispatched as ${identity.name} in ${projectId}/${channelId} — agents will respond in-channel (use chat.read to poll)` }] };
        }
        if (args.conversation != null) {
          return { content: [{ type: 'text', text: 'Conversation dispatch is unavailable' }], isError: true };
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
      case 'task.create': {
        if (!taskManager) return { content: [{ type: 'text', text: 'Task manager not available' }], isError: true };
        // createTask does NOT validate title -- an absent one persists a task
        // with title: undefined that renders as blank everywhere. Guard here.
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        if (!title) return { content: [{ type: 'text', text: 'title is required' }], isError: true };
        const campaignId = args.campaign || null;
        if (campaignId && campaignManager && !campaignManager.getCampaign(projectId, campaignId)) {
          return { content: [{ type: 'text', text: `Campaign not found: ${campaignId}` }], isError: true };
        }
        const created = taskManager.createTask(projectId, {
          title,
          description: args.description || title,
          doneCriteria: args.doneCriteria || null,
          channel: channelId,
          campaignId,
          type: 'oneshot',
          // Attribution, not 'system': the point of this tool is that an agent
          // files work as itself, so the queue shows who raised it.
          owner: identity.name,
        });
        log.info('Task created via MCP', {
          projectId, taskId: created.id, owner: identity.name, campaignId,
        });
        return { content: [{ type: 'text', text: JSON.stringify({
          id: created.id, title: created.title, status: created.status,
          project: projectId, channel: channelId, campaignId: created.campaignId,
          owner: created.owner,
        }, null, 2) }] };
      }
      case 'agent.list': {
        const agentList = Object.entries(agents).map(([id, a]) => ({
          id, name: a.name, provider: a.provider, model: a.model, status: a._status,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(agentList, null, 2) }] };
      }
      case 'vault.search': {
        try {
          const out = vaultSearch({
            projectId,
            query: args?.query || '',
            limit: args?.limit,
            stateManager,
          });
          emitVaultChannelUsed('vault.search', projectId, identity);
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `vault.search error: ${err.message}` }], isError: true };
        }
      }
      case 'vault.read': {
        try {
          const out = vaultRead({
            projectId,
            relPath: args?.relPath,
            maxChars: args?.maxChars,
            stateManager,
          });
          emitVaultChannelUsed('vault.read', projectId, identity);
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `vault.read error: ${err.message}` }], isError: true };
        }
      }
      case 'vault.propose': {
        try {
          // Derive proposer identity strictly from authenticated token (never payload!)
          const out = vaultPropose({
            projectId,
            relPath: args?.relPath,
            body: args?.body,
            rationale: args?.rationale || null,
            agentId: identity.name,
            stateManager,
          });
          emitVaultChannelUsed('vault.propose', projectId, identity);
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `vault.propose error: ${err.message}` }], isError: true };
        }
      }
      case 'loop.list':
      case 'loop.get':
      case 'loop.runs':
      case 'loop.run_get':
      case 'loop.evidence':
      case 'loop.publish':
      case 'loop.run':
      case 'loop.schedule':
      case 'loop.cancel':
      case 'loop.approve':
      case 'subproject.list':
      case 'subproject.create': {
        if (!loopService) {
          return { content: [{ type: 'text', text: 'Loop service not available' }], isError: true };
        }
        // Derive identity strictly from authenticated MCP token/session (NEVER toolArgs!)
        const svcIdentity = {
          principalId: identity.name,
          role: identity.role,
          scopedProjectId: identity.scopedProjectId || null,
        };
        try {
          let out;
          if (name === 'loop.list') {
            out = loopService.listLoops(svcIdentity, { projectId: args?.projectId, scope: args?.scope });
          } else if (name === 'loop.get') {
            out = loopService.getLoop(svcIdentity, args?.loopId);
          } else if (name === 'loop.runs') {
            out = loopService.listRuns(svcIdentity, args?.loopId);
          } else if (name === 'loop.run_get') {
            out = loopService.getRun(svcIdentity, args?.runId, { expectedLoopId: args?.loopId || null });
          } else if (name === 'loop.evidence') {
            out = loopService.getRunEvidence(svcIdentity, args?.runId, { expectedLoopId: args?.loopId || null });
          } else if (name === 'loop.publish') {
            out = loopService.publishLoopVersion(svcIdentity, {
              loopId: args?.loopId || null,
              baseVersion: args?.baseVersion ?? 0,
              manifest: args?.manifest,
              projectId: args?.projectId,
            });
          } else if (name === 'loop.run') {
            const started = loopService.startAndExecuteRun(svcIdentity, {
              loopId: args?.loopId,
              loopVersion: args?.loopVersion ?? null,
              projectId: args?.projectId ?? null,
              subProjectId: args?.subProjectId ?? null,
              params: args?.params ?? null,
              requestId: args?.requestId ?? null,
              source: args?.source ?? null,
            });
            const { executionPromise: _bg, ...serializable } = started;
            out = serializable;
          } else if (name === 'loop.schedule') {
            out = loopService.setLoopSchedule(svcIdentity, {
              loopId: args?.loopId,
              enabled: args?.enabled !== false,
              loopVersion: args?.loopVersion ?? null,
              cadence: args?.cadence ?? null,
              timezone: args?.timezone ?? null,
              overlap: args?.overlap ?? null,
              missedRun: args?.missedRun ?? null,
            });
          } else if (name === 'loop.cancel') {
            out = loopService.cancelRun(svcIdentity, args?.runId, { expectedLoopId: args?.loopId || null });
          } else if (name === 'loop.approve') {
            out = await loopService.approveRun(svcIdentity, {
              runId: args?.runId,
              expectedLoopId: args?.loopId || null,
              approvedSourceSha: args?.approvedSourceSha,
              reviewSha256: args?.reviewSha256,
              anchorSetSha256: args?.anchorSetSha256,
              approvalEventId: args?.approvalEventId || null,
            });
          } else if (name === 'subproject.list') {
            out = loopService.listSubprojects(svcIdentity, args?.projectId || args?.project);
          } else if (name === 'subproject.create') {
            const payload = {
              slug: args?.slug,
              title: args?.title ?? null,
              params: args?.params ?? {},
              workspaceMode: args?.workspaceMode || 'subdir',
            };
            if (args && Object.prototype.hasOwnProperty.call(args, 'roster')) {
              payload.roster = args.roster;
            }
            out = loopService.createSubproject(svcIdentity, args?.projectId || args?.project, payload);
          }
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `${name} error: ${err.message}` }], isError: true };
        }
      }
      case 'council.start':
      case 'council.list':
      case 'council.verdict': {
        if (!councilService) {
          return { content: [{ type: 'text', text: 'Council service not available' }], isError: true };
        }
        const svcIdentity = {
          principalId: identity.name,
          role: identity.role,
          scopedProjectId: identity.scopedProjectId || null,
        };
        try {
          let out;
          if (name === 'council.start') {
            const { projectId: _pid, project: _proj, ...rawRequest } = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
            const started = councilService.startSession(svcIdentity, {
              projectId: args?.projectId || args?.project,
              trigger: 'mcp',
              defaultMode: 'counsel',
              request: rawRequest,
            });
            const { executionPromise: _bg, ...serializable } = started;
            out = serializable;
          } else if (name === 'council.list') {
            out = councilService.listProjectSessions(svcIdentity, args?.projectId || args?.project, { limit: args?.limit });
          } else if (name === 'council.verdict') {
            out = councilService.recordOperatorVerdict(svcIdentity, {
              projectId: args?.projectId || args?.project,
              sessionId: args?.sessionId,
              verdict: args?.verdict,
              requestId: args?.requestId,
            });
          }
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `${name} error: ${err.message}` }], isError: true };
        }
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

    const identity = authResult.identity;
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId !== undefined) {
      const status = checkSession(sessionId, identity);
      if (status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcError(null, -32001, status === 403 ? 'Forbidden' : 'Session not found')));
        return;
      }
    }
    if (req.method === 'DELETE') {
      if (sessionId !== undefined) sessions.delete(sessionId);
      res.writeHead(sessionId === undefined ? 400 : 204);
      res.end();
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
        log.info('MCP session initialized', { identity: identity.name });
        return;
      }
      case 'notifications/initialized': {
        res.writeHead(202);
        res.end();
        return;
      }
      case 'tools/list': {
        const filteredTools = Object.entries(TOOLS)
          .filter(([, def]) => allowsTool(def, identity.role))
          .map(([name, def]) => ({ name, description: def.description, inputSchema: def.inputSchema }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcResult(id, { tools: filteredTools })));
        return;
      }
      case 'tools/call': {
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
