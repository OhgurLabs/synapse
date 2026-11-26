import { randomUUID } from 'node:crypto';
import { parseMentions, parseDirectedSegments } from '../context.js';
import { buildRoutingPlan } from '../router.js';
import { rosterAllowsAgentAnyRole } from '../roster.js';
import { buildThreadLabel, resolveThread, updateThreadKeywords } from '../threading.js';
import { createLogger } from '../logger.js';
import { isAgentPaused } from './agents.js';
import { FAILURE_RESPONSES } from './agent-interaction.js';
import { isNoiseResponse, rankAgentsByRelevance } from './conversation.js';
import { parseConversationOptions, runChatProtocol } from './chat-protocol.js';

const log = createLogger('chat-protocol');
const PHASE_LABELS = {
  discussion: 'Discussion',
  roundtable: 'Roundtable',
  opening: 'Debate openings',
  rebuttal: 'Debate rebuttals',
};
const TURN_LABELS = {
  passed: 'passed',
  timed_out: 'timed out',
  unavailable: 'was unavailable',
  error: 'could not answer',
};

function transcriptText(entries) {
  return entries.slice(-16).map(({ agentId, side, content }) =>
    `${agentId}${side ? ` (${side})` : ''}: ${content.slice(0, 1500)}`).join('\n\n');
}

function turnPrompt(question, turn, history) {
  const rules = {
    discussion: 'Contribute when you have something relevant to add. You may reply PASS.',
    roundtable: 'It is your turn. Build on the earlier speakers where useful. You may reply PASS.',
    opening: 'Present your side’s opening argument. State a claim and give the reasoning for it.',
    rebuttal: 'Respond to a specific claim from another side in the published openings.',
  };
  return [
    'Respond in chat using plain text. Keep your turn concise. Do not use tools or modify files.',
    rules[turn.phase],
    turn.side ? `Your side: ${turn.side}` : null,
    `Operator brief:\n${question}`,
    history.length ? `Earlier messages:\n${transcriptText(history)}` : null,
    turn.transcript.length ? `Protocol transcript:\n${transcriptText(turn.transcript)}` : null,
  ].filter(Boolean).join('\n\n');
}

export function createChatProtocolDispatch({
  agents, stateManager, addMessage, broadcastToChannel, events,
  getAgentResponse, isAgentCoolingDown, circuitBreaker,
}) {
  const activeRuns = new Set();
  const activeSeats = new Set();

  function matchesRoster(id, roster) {
    const agent = agents[id];
    return !!agent && agent.role !== 'governor' && rosterAllowsAgentAnyRole(roster, id, agent);
  }

  function canAnswer(id, projectId) {
    const project = stateManager.getProject(projectId);
    return !!project && matchesRoster(id, project.agents ?? null)
      && (!agents[id]._status || agents[id]._status === 'active')
      && !isAgentPaused(id);
  }

  function selectParticipants(options, mode, text, roster) {
    const fixed = options.order || options.sides?.map(side => side.opener);
    if (fixed) {
      const excluded = fixed.filter(id => !matchesRoster(id, roster));
      if (excluded.length) throw new Error(`Agents outside the conversation roster: ${excluded.join(', ')}.`);
      return fixed;
    }
    const candidates = Object.fromEntries(Object.entries(agents).filter(([id, agent]) =>
      matchesRoster(id, roster) && (!agent._status || agent._status === 'active') && !isAgentPaused(id)));
    const mentions = parseMentions(text, candidates);
    const { directed } = parseDirectedSegments(text, candidates);
    const available = Object.keys(candidates);
    const audience = mode || (mentions.length ? null : 'council');
    const plan = buildRoutingPlan(text, mentions, directed, candidates, isAgentCoolingDown || (() => false),
      query => rankAgentsByRelevance(query, () => candidates), audience, null, null, {}, circuitBreaker, roster);
    // A one-seat council still has one seat, while an explicit address with no
    // viable agent is reported instead of silently changing the audience.
    return plan?.participants ?? (audience === 'council' && available.length === 1 ? available : []);
  }

  function announceTurn(event, options, participants, postSystem, projectId, threadId) {
    const { type, phase, round, agentId, status, missing = [] } = event;
    if (type === 'phase') {
      const suffix = phase === 'roundtable' ? ` round ${round}` : '';
      const seats = phase === 'opening'
        ? ` ${options.sides.map(({ label, opener }) => `${label} (${agents[opener]?.name || opener})`).join(', ')}.`
        : '';
      postSystem(`${PHASE_LABELS[phase]}${suffix} started.${seats}`);
    } else if (type === 'turn' && Object.hasOwn(TURN_LABELS, status)) {
      postSystem(`${agents[agentId]?.name || agentId} ${TURN_LABELS[status]}.`);
    } else if (type === 'outcome') {
      stateManager.updateThread(projectId, threadId, { conversationRun: { state: status, participants, missing } });
      if (missing.length) {
        const names = missing.map(id => agents[id]?.name || id);
        postSystem(`Missing debate openings: ${names.join(', ')}. ${status === 'incomplete' ? 'Rebuttals stayed closed.' : 'The debate proceeded with the available sides.'}`);
      }
    }
  }

  function dispatch(text, projectId, channelId, meta, speaker, userId) {
    const raw = meta.conversation;
    const ref = meta.replyTo
      ? stateManager.getMessages(projectId, channelId, 200).find(message => message.id === meta.replyTo)
      : null;
    const pinnedId = !meta.replyTo && raw == null
      ? stateManager.getChannelActiveThread?.(projectId, channelId)
      : null;
    const targetId = ref?.threadId || pinnedId;
    let thread = targetId ? stateManager.getThread(projectId, targetId) : null;
    if (thread?.channel !== channelId) thread = null;
    if (raw == null && !thread?.conversation) return false;

    const postError = message => addMessage(projectId, channelId, 'System', message, 'system',
      { threadId: thread?.id, replyTo: meta.replyTo });
    try {
      const requested = parseConversationOptions(raw);
      if (thread?.conversation && requested && requested.mode !== thread.conversation.mode) {
        throw new Error('Start a new thread to use a different conversation mode.');
      }
      if (thread?.taskId) throw new Error('Start a channel conversation outside the task thread.');
      const options = requested || thread?.conversation;
      const project = stateManager.getProject(projectId);
      if (!project) throw new Error('The conversation project does not exist.');
      const identity = meta.authIdentity;
      const agentPost = identity?.role === 'agent_operator';
      if (identity?.role !== 'operator' && !agentPost) throw new Error('Conversation chat requires an operator or agent token.');
      if (identity.scopedProjectId && identity.scopedProjectId !== projectId) throw new Error('This token is scoped to another project.');
      if (agentPost && (!canAnswer(identity.agentId || identity.principalId, projectId) || options.mode !== 'discussion')) {
        throw new Error('Agent tokens can join discussions as an eligible project agent.');
      }
      if (options.mode === 'discussion' && !thread && !meta.replyTo) {
        const active = stateManager.getActiveThreads(projectId, channelId).filter(item => item.conversation?.mode === 'discussion');
        const resolution = resolveThread(text, active);
        if (!resolution.isNew && resolution.threadId) thread = stateManager.getThread(projectId, resolution.threadId);
      }
      const threadId = thread?.id || `thread_${Date.now()}_${randomUUID()}`;
      const threadLabel = thread?.label || buildThreadLabel(text);
      const key = `${projectId}/${threadId}`;
      const isDiscussion = options.mode === 'discussion';
      if (!isDiscussion && activeRuns.has(key)) {
        throw new Error('This conversation is taking scheduled turns. Wait for the current run to finish.');
      }
      const startRun = !agentPost && (!thread?.conversation || isDiscussion || !!requested);
      const participants = startRun ? selectParticipants(options, meta.mode, text, project.agents ?? null) : [];
      const history = isDiscussion && thread
        ? stateManager.getThreadMessages(projectId, channelId, threadId, 12)
          .filter(message => message.type === 'message')
          .map(message => ({ agentId: message.speaker, content: message.content }))
        : [];

      if (!thread) {
        thread = stateManager.createThread(projectId, { id: threadId, label: threadLabel, channel: channelId });
        broadcastToChannel(projectId, channelId, { type: 'thread_created', threadId, label: threadLabel, channel: channelId });
        events.emit('thread:created', { projectId, channelId, threadId, label: threadLabel }).catch(() => {});
      }
      if (agentPost) speaker = agents[identity.agentId || identity.principalId].name;
      const { keywords, anchorKeywords } = updateThreadKeywords(thread, text, !thread.messageCount);
      stateManager.updateThread(projectId, threadId, {
        conversation: options, keywords, anchorKeywords,
        participants: [...new Set([...(thread.participants || []), speaker])],
        messageCount: (thread.messageCount || 0) + 1,
      });

      const msg = addMessage(projectId, channelId, speaker, text, 'message', { threadId, replyTo: ref?.id, userId });
      const postSystem = content => addMessage(projectId, channelId, 'System', content, 'system', { threadId, replyTo: msg.id });
      if (!isDiscussion && thread.conversationRun?.state === 'active' && !activeRuns.has(key)) {
        stateManager.updateThread(projectId, threadId, {
          conversationRun: { ...thread.conversationRun, state: 'interrupted' },
        });
        postSystem('The previous conversation run was interrupted.');
      }
      if (!startRun) return true;
      if (!participants.length) {
        postSystem('No eligible agent is available for this audience.');
        return true;
      }

      if (!isDiscussion) {
        activeRuns.add(key);
        stateManager.updateThread(projectId, threadId, { conversationRun: { state: 'active', participants } });
      }
      const run = async () => {
        await runChatProtocol({
          options, participants,
          respond: async (agentId, turn) => {
            if (!canAnswer(agentId, projectId) || activeSeats.has(agentId)) return { status: 'unavailable' };
            activeSeats.add(agentId);
            try {
              const result = await getAgentResponse(agentId, agents[agentId], projectId, channelId, text, null,
                turnPrompt(text, turn, history), {
                  threadId, threadLabel, replyTo: msg.id,
                  silent: true, sealed: !isDiscussion, _noHandoff: true, chatOnly: true,
                  turnTimeoutMs: options.turnTimeoutMs, localTurnTimeoutMs: options.localTurnTimeoutMs,
                });
              const response = result?.response?.trim();
              if (response === 'timed_out') return { status: 'timed_out' };
              if (FAILURE_RESPONSES.has(response) || response === 'transient_error' || response === 'busy_skipped') {
                return { status: 'unavailable' };
              }
              if (isNoiseResponse(response) || /^pass[.!]?$/i.test(response)) return { status: 'passed' };
              return { status: 'answered', content: response };
            } finally {
              activeSeats.delete(agentId);
            }
          },
          publish: (agentId, result) => addMessage(projectId, channelId, agents[agentId]?.name || agentId,
            result.content, 'message', { model: agents[agentId]?.model, threadId, replyTo: msg.id }),
          announce: event => {
            if (!isDiscussion) announceTurn(event, options, participants, postSystem, projectId, threadId);
          },
        });
      };
      run().catch(error => {
        log.error('Conversation protocol failed', { projectId, channelId, threadId, error: error.message });
        if (stateManager.getProject(projectId)) {
          if (!isDiscussion) stateManager.updateThread(projectId, threadId, { conversationRun: { state: 'error', participants } });
          postSystem('The conversation could not finish.');
        }
      }).finally(() => {
        activeRuns.delete(key);
      }).catch(error => {
        log.error('Could not record the conversation failure', { projectId, channelId, threadId, error: error.message });
      });
    } catch (error) {
      postError(error.message);
    }
    return true;
  }

  return { dispatch };
}
