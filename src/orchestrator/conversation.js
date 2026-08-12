/**
 * Conversation loop & dispatch modes — solo, pair, legacy multi-agent fallback.
 * Extracted from orchestrator.js. Dependencies injected via createConversationSystem().
 */
import { join } from 'path';
import { createLogger } from '../logger.js';
const log = createLogger('conversation');

import { tokenize, jaccard } from '../threading.js';
import { recordDispatch, routedPromptSuffix, isLowConfidence, shouldAudit, selectAgent } from '../router.js';
import { isAgentPaused } from './agents.js';
import { FAILURE_RESPONSES } from './agent-interaction.js';
import { calculateCost } from './costModel.js';

// ─── Constants ───────────────────────────────────────────────────────
const AGREEMENT_PATTERNS = /^\s*(\+1|agree[d]?|confirmed|aligned|converge[d]?|pass|lgtm|looks good|no objection)/i;
const CLOSURE_PATTERNS = /nothing (else )?to add|no further (action|discussion|input)|thread is (converged|closed|done)|task (is )?(closed|complete|assigned)|moving on|standing by to review|no action needed|silence is.*correct/i;
const NOISE_RE = /^(pass\.?|no comment\.?|nothing to add\.?|no blockers?\.?|ready\.?|standing by\.?|\+1\.?|agreed\.?|i agree\.?|acknowledged\.?)$/i;
const EXECUTION_RE = /\b(implement|execute|build|fix|create|write|refactor|rename|deploy|install|configure|setup|migrate|modify|edit|patch|make|ship)\b/i;
const DISCUSSION_OVERRIDE_RE = /\b(what do you think|thoughts on|discuss|analyze|design|plan|consider|evaluate|opinion|perspective|delegate|assign|prioritize|review|audit|assess|recommend)\b/i;
const DELEGATION_ROLES = new Set(['architect']);
const DELEGATION_RE = /(?:^|\n)\s*@(\w+)\s+(implement|execute|build|fix|create|write|refactor|deploy|install|configure|setup|migrate|modify|edit|patch|ship|apply|update)\b\s+(.+?)(?=\n\s*@\w+\s+(?:implement|execute|build|fix|create|write|refactor|deploy|install|configure|setup|migrate|modify|edit|patch|ship|apply|update)\b|\n*$)/gis;

let _operatorSpeakers = new Set(['System']);

export function initOperatorSpeakers(operatorName) {
  _operatorSpeakers = new Set([operatorName, 'System']);
}

function isOperatorSpeaker(speaker) {
  return _operatorSpeakers.has(speaker);
}

// ─── Pure helpers ────────────────────────────────────────────────────
export function isClosureResponse(text) {
  if (!text) return false;
  return AGREEMENT_PATTERNS.test(text.trim()) || CLOSURE_PATTERNS.test(text);
}
export function isNoiseResponse(text) { return !text || NOISE_RE.test(text.trim()); }
export function isExecutionIntent(text) {
  if (DISCUSSION_OVERRIDE_RE.test(text)) return false;
  return EXECUTION_RE.test(text);
}
function isAgentContentMessage(msg) { return msg?.type === 'message' && !isOperatorSpeaker(msg.speaker); }

export function extractAgentDirectives(messages, getAgents, execCapable) {
  const agents = getAgents();
  const directives = new Map();
  for (const m of messages) {
    if (!m.speaker || !m.content) continue;
    const speakerId = m.speaker.toLowerCase();
    const agent = agents[speakerId];
    if (!agent || !DELEGATION_ROLES.has(agent.role)) continue;
    DELEGATION_RE.lastIndex = 0;
    let match;
    while ((match = DELEGATION_RE.exec(m.content)) !== null) {
      const targetId = match[1].toLowerCase();
      const task = match[3].trim();
      if (agents[targetId] && execCapable.has(targetId) && task) directives.set(targetId, task);
    }
  }
  return directives;
}

export function rankAgentsByRelevance(text, getAgents) {
  const agents = getAgents();
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(t => t.length >= 3);
  const scores = [];
  for (const [id, agent] of Object.entries(agents)) {
    if (!agent.skills || agent.skills.length === 0) { scores.push({ id, score: 0 }); continue; }
    let score = 0;
    for (const token of tokens) {
      for (const skill of agent.skills) { if (token.includes(skill) || skill.includes(token)) score++; }
    }
    scores.push({ id, score });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

// ─── Factory ─────────────────────────────────────────────────────────
export function createConversationSystem(deps) {
  const { config: cfg, getAgents, execCapable, stateManager, addMessage, broadcastToChannel,
    formatContext, formatFollowUp, agentSystemPrompt, getAgentResponse, isAgentCoolingDown,
    taskManager, auditDispatch, filterByPermission, PROJECT_DIR, getUserId } = deps;

  const projectsDir = PROJECT_DIR ? join(PROJECT_DIR, '.synapse', 'projects') : null;
  const MAX_TOTAL_TURNS = cfg.orchestrator.maxTotalTurns;
  const BASE_TURN_BUDGET = cfg.orchestrator.baseTurnBudget;
  const REPETITION_THRESHOLD = cfg.orchestrator.repetitionThreshold;
  const INFO_GAIN_THRESHOLD = cfg.orchestrator.infoGainThreshold;
  const REPETITION_PATIENCE = cfg.orchestrator.repetitionPatience;
  const WRAP_UP_BUDGET = cfg.orchestrator.wrapUpBudget;
  const MAX_CONSECUTIVE_PER_AGENT = cfg.orchestrator.maxConsecutivePerAgent;

  function getRecentAgentMessages(projectId, channelId, threadId = null, limit = cfg.orchestrator.defaultMessageLimit) {
    const all = threadId
      ? stateManager.getThreadMessages(projectId, channelId, threadId, 9999)
      : stateManager.getMessages(projectId, channelId, 9999);
    return all.filter(isAgentContentMessage).slice(-limit);
  }
  function getAgentMessageCount(projectId, channelId, threadId = null) {
    return getRecentAgentMessages(projectId, channelId, threadId, 9999).length;
  }

  async function dispatchSolo(plan, text, projectId, channelId, crossRef, threadMeta, userMsgId) {
    const agents = getAgents();
    const { primary, escalation } = plan;
    const agent = agents[primary];
    if (!agent) return [];

    const stats = [];

    // Audit: log dispatch decision
    if (auditDispatch && projectsDir) {
      auditDispatch(projectsDir, projectId, {
        type: 'conversation_dispatch', mode: 'solo', classification: plan.type,
        agents: [primary], escalation: escalation || null, channelId,
        threadId: threadMeta.threadId || null,
      });
    }

    recordDispatch(primary, agents);
    const suffix = routedPromptSuffix('solo', 'primary');
    const context = await formatContext(projectId, channelId, agent.name, text, crossRef, null, threadMeta.threadId, threadMeta.threadLabel);
    const contextWithRouting = context + suffix;

    const start = Date.now();
    const primaryResponse = await getAgentResponse(primary, agent, projectId, channelId, text, crossRef, contextWithRouting, threadMeta);
    const duration = Date.now() - start;
    const success = !FAILURE_RESPONSES.has(primaryResponse.response);
    const primaryInputTokens = primaryResponse.inputTokens || 0;
    const primaryOutputTokens = primaryResponse.outputTokens || 0;
    const primaryCost = calculateCost(primaryResponse.provider, primaryResponse.model, primaryInputTokens, primaryOutputTokens);
    stats.push({ 
      agentId: primary, 
      success, 
      durationMs: duration, 
      category: plan.type,
      inputTokens: primaryInputTokens,
      outputTokens: primaryOutputTokens,
      costUsd: primaryCost.costUsd,
      model: primaryResponse.model,
      provider: primaryResponse.provider,
      confidence: primaryResponse.confidence,
    });

    if (escalation && primaryResponse.response !== 'rate_limited' && primaryResponse.response !== 'timed_out') {
      const recentMsgs = getRecentAgentMessages(projectId, channelId, threadMeta.threadId, 1);
      const lastMsg = recentMsgs[recentMsgs.length - 1];
      if (lastMsg && isLowConfidence(lastMsg.content) && plan.confidence < cfg.router.confidenceThreshold) {
        log.info('Low confidence, escalating', { primary, escalation });
        const escAgent = agents[escalation];
        if (escAgent && !isAgentCoolingDown(escalation)) {
          recordDispatch(escalation, agents);
          const escSuffix = routedPromptSuffix('solo', 'escalation (second opinion)');
          const escContext = await formatContext(projectId, channelId, escAgent.name, text, crossRef, null, threadMeta.threadId, threadMeta.threadLabel);
          
          const escStart = Date.now();
          const escResponse = await getAgentResponse(escalation, escAgent, projectId, channelId, text, crossRef, escContext + escSuffix, threadMeta);
          const escDuration = Date.now() - escStart;
          const escSuccess = !FAILURE_RESPONSES.has(escResponse.response);
          const escInputTokens = escResponse.inputTokens || 0;
          const escOutputTokens = escResponse.outputTokens || 0;
          const escCost = calculateCost(escResponse.provider, escResponse.model, escInputTokens, escOutputTokens);
          stats.push({ 
            agentId: escalation, 
            success: escSuccess, 
            durationMs: escDuration, 
            category: 'escalation',
            inputTokens: escInputTokens,
            outputTokens: escOutputTokens,
            costUsd: escCost.costUsd,
            model: escResponse.model,
            provider: escResponse.provider,
            confidence: escResponse.confidence,
          });
        }
      }
    }

    return stats;
  }

  async function dispatchPair(plan, text, projectId, channelId, crossRef, threadMeta, userMsgId, userId) {
    const agents = getAgents();
    const { primary, secondary, escalation } = plan;
    const primaryAgent = agents[primary];
    const secondaryAgent = agents[secondary];
    
    if (!primaryAgent) return [];

    const stats = [];

    // Audit: log dispatch decision
    if (auditDispatch && projectsDir) {
      auditDispatch(projectsDir, projectId, {
        type: 'conversation_dispatch', mode: 'pair', classification: plan.type,
        agents: [primary, secondary].filter(Boolean), escalation: escalation || null, channelId,
        threadId: threadMeta.threadId || null,
      });
    }

    // Primary agent dispatch
    recordDispatch(primary, agents);
    const primarySuffix = routedPromptSuffix('pair', 'primary');
    const primaryContext = await formatContext(projectId, channelId, primaryAgent.name, text, crossRef, null, threadMeta.threadId, threadMeta.threadLabel);
    const primaryContextWithRouting = primaryContext + primarySuffix;

    const primaryStart = Date.now();
    const primaryResponse = await getAgentResponse(primary, primaryAgent, projectId, channelId, text, crossRef, primaryContextWithRouting, threadMeta);
    const primaryDuration = Date.now() - primaryStart;
    const primarySuccess = !FAILURE_RESPONSES.has(primaryResponse.response);
    const primaryInputTokens = primaryResponse.inputTokens || 0;
    const primaryOutputTokens = primaryResponse.outputTokens || 0;
    const primaryCost = calculateCost(primaryResponse.provider, primaryResponse.model, primaryInputTokens, primaryOutputTokens);
    
    stats.push({ 
      agentId: primary, 
      success: primarySuccess, 
      durationMs: primaryDuration, 
      category: 'primary',
      inputTokens: primaryInputTokens,
      outputTokens: primaryOutputTokens,
      costUsd: primaryCost.costUsd,
      model: primaryResponse.model,
      provider: primaryResponse.provider,
      confidence: primaryResponse.confidence,
    });

    // Secondary agent dispatch (if exists and not rate_limited/timed_out)
    if (secondary && primaryResponse.response !== 'rate_limited' && primaryResponse.response !== 'timed_out') {
      const secondaryAgentObj = agents[secondary];
      if (secondaryAgentObj && !isAgentCoolingDown(secondary)) {
        recordDispatch(secondary, agents);
        const secondarySuffix = routedPromptSuffix('pair', 'secondary');
        const secondaryContext = await formatContext(projectId, channelId, secondaryAgentObj.name, text, crossRef, null, threadMeta.threadId, threadMeta.threadLabel);
        // The reviewer's subject is the PRIMARY'S RESPONSE — hand it over
        // explicitly. Rebuilding context from channel history raced the
        // primary's message landing in the store: the reviewer dispatched
        // 9s after the primary posted and still reported "no primary
        // response was included in the thread" (settings-pass, 2026-08-02).
        const primaryAnswerBlock = (primarySuccess && typeof primaryResponse.response === 'string' && primaryResponse.response.trim())
          ? `\n\n=== PRIMARY RESPONSE (${primaryAgent.name}) — this is the answer you are reviewing ===\n${primaryResponse.response}`
          : '';
        const secondaryContextWithRouting = secondaryContext + secondarySuffix + primaryAnswerBlock;

        const secondaryStart = Date.now();
        const secondaryResponse = await getAgentResponse(secondary, secondaryAgentObj, projectId, channelId, text, crossRef, secondaryContextWithRouting, threadMeta);
        const secondaryDuration = Date.now() - secondaryStart;
        const secondarySuccess = !FAILURE_RESPONSES.has(secondaryResponse.response);
        const secondaryInputTokens = secondaryResponse.inputTokens || 0;
        const secondaryOutputTokens = secondaryResponse.outputTokens || 0;
        const secondaryCost = calculateCost(secondaryResponse.provider, secondaryResponse.model, secondaryInputTokens, secondaryOutputTokens);
        
        stats.push({ 
          agentId: secondary, 
          success: secondarySuccess, 
          durationMs: secondaryDuration, 
          category: 'secondary',
          inputTokens: secondaryInputTokens,
          outputTokens: secondaryOutputTokens,
          costUsd: secondaryCost.costUsd,
          model: secondaryResponse.model,
          provider: secondaryResponse.provider,
          confidence: secondaryResponse.confidence,
        });

        // Escalation if both agents have low confidence
        if (escalation && primaryResponse.confidence < cfg.router.confidenceThreshold && secondaryResponse.confidence < cfg.router.confidenceThreshold) {
          const escAgent = agents[escalation];
          if (escAgent && !isAgentCoolingDown(escalation)) {
            recordDispatch(escalation, agents);
            const escSuffix = routedPromptSuffix('pair', 'escalation (tiebreaker)');
            const escContext = await formatContext(projectId, channelId, escAgent.name, text, crossRef, null, threadMeta.threadId, threadMeta.threadLabel);
            
            const escStart = Date.now();
            const escResponse = await getAgentResponse(escalation, escAgent, projectId, channelId, text, crossRef, escContext + escSuffix, threadMeta);
            const escDuration = Date.now() - escStart;
            const escSuccess = !FAILURE_RESPONSES.has(escResponse.response);
            const escInputTokens = escResponse.inputTokens || 0;
            const escOutputTokens = escResponse.outputTokens || 0;
            const escCost = calculateCost(escResponse.provider, escResponse.model, escInputTokens, escOutputTokens);
            
            stats.push({ 
              agentId: escalation, 
              success: escSuccess, 
              durationMs: escDuration, 
              category: 'escalation',
              inputTokens: escInputTokens,
              outputTokens: escOutputTokens,
              costUsd: escCost.costUsd,
              model: escResponse.model,
              provider: escResponse.provider,
              confidence: escResponse.confidence,
            });
          }
        }
      }
    }

    return stats;
  }

  // ── Conversation loop (council + legacy) ─────────────────────────

  async function conversationLoop(participants, text, projectId, channelId, threadMeta, crossRef, budget, hasMentions, directed, broadcastText, userMsg, userId = 'default') {
    const agents = getAgents();
    const targetChannel = channelId;
    const threadId = threadMeta.threadId;
    const threadLabel = threadMeta.threadLabel;
    const hasDirectedSegments = Object.keys(directed).length > 0;

    const maxRounds = budget?.maxRounds || BASE_TURN_BUDGET;
    const maxBudget = budget?.maxResponses || BASE_TURN_BUDGET;

    // #13: Filter participants by denyActions — if execution intent detected,
    // remove agents that deny code:execute (e.g., Gem)
    let respondents = [...participants];
    if (filterByPermission && isExecutionIntent(text)) {
      const filtered = filterByPermission(respondents, 'code:execute', agents);
      if (filtered.length < respondents.length) {
        const removed = respondents.filter(id => !filtered.includes(id));
        log.info('Filtered agents by denyActions', { action: 'code:execute', removed });
      }
      respondents = filtered;
    }

    // Audit: log dispatch decision
    const mode = budget ? (respondents.length > 2 ? 'council' : 'pair') : 'legacy';
    if (auditDispatch && projectsDir) {
      auditDispatch(projectsDir, projectId, {
        type: 'conversation_dispatch', mode,
        agents: respondents, channelId, threadId: threadId || null,
        hasMentions, hasDirectedSegments,
      });
    }

    let totalResponses = 0;
    let lastMessageCount = getAgentMessageCount(projectId, targetChannel, threadId);
    let roundNewMsgs = [];
    let inFlightPromises = [];

    const roundFingerprints = [];
    const allSeenTokens = new Set();
    let consecutiveHighOverlap = 0;
    let consecutiveLowGain = 0;
    let wrapUpInjected = false;
    let effectiveBudget = maxRounds;

    for (let round = 0; round < effectiveBudget; round++) {
      const recentMsgs = threadId
        ? stateManager.getThreadMessages(projectId, targetChannel, threadId, 10)
        : stateManager.getMessages(projectId, targetChannel, 10);
      const eligible = respondents.filter(name => {
        const agent = agents[name];
        if (!agent) return false;
        if (agent._status && agent._status !== 'active') return false;
        // Paused is tracked separately from _status — without this check
        // paused agents kept answering councils (operator, live on the
        // enclave: "paused agents are responding. that is an oversight").
        // Recomputed every round, so a mid-debate pause takes effect on
        // the next round.
        if (isAgentPaused(name)) return false;
        if (isAgentCoolingDown(name)) return false;
        let consecutive = 0;
        for (let i = recentMsgs.length - 1; i >= 0; i--) {
          if (recentMsgs[i].speaker === agent.name) consecutive++;
          else break;
        }
        if (consecutive >= MAX_CONSECUTIVE_PER_AGENT) return false;
        return true;
      });

      if (eligible.length === 0) break;
      if (totalResponses >= maxBudget) break;

      const roundContexts = {};
      if (round === 0 && hasDirectedSegments) {
        for (const name of eligible) {
          if (directed[name]) {
            const preamble = broadcastText ? `${broadcastText}\n\n` : '';
            const directedMsg = `${preamble}Your task: ${directed[name]}`;
            roundContexts[name] = await formatContext(projectId, targetChannel, agents[name].name, text, crossRef, directedMsg, threadId, threadLabel);
          }
        }
      } else if (round > 0 && roundNewMsgs.length > 0) {
        for (const name of eligible) {
          const sameThreadMsgs = threadId
            ? roundNewMsgs.filter(m => m.threadId === threadId)
            : roundNewMsgs;
          const othersMessages = sameThreadMsgs.filter(m => m.speaker?.toLowerCase() !== name);
          if (othersMessages.length > 0) {
            roundContexts[name] = formatFollowUp(projectId, targetChannel, agents[name].name, othersMessages, threadLabel);
          }
        }
      }

      let toDispatch;
      if (round > 0) {
        toDispatch = eligible.filter(name => roundContexts[name]);
      } else if (!hasMentions && !hasDirectedSegments) {
        if (mode === 'council') {
          // Full round-table: the operator explicitly chose council — every
          // eligible agent opens. The relevance collapse below kept picking
          // ONE "most relevant" speaker (sol, repeatedly) and the debate
          // never had a second voice.
          toDispatch = eligible;
        } else {
          const ranked = rankAgentsByRelevance(text, getAgents);
          const top = ranked[0]?.score || 0;
          const second = ranked[1]?.score || 0;
          if (top > 0 && top >= second * 2 && eligible.includes(ranked[0].id)) {
            toDispatch = [ranked[0].id];
          } else {
            toDispatch = eligible;
          }
        }
      } else {
        toDispatch = eligible;
      }

      if (toDispatch.length === 0) break;

      const remainingBudget = maxBudget - totalResponses;
      if (remainingBudget <= 0) break;
      if (toDispatch.length > remainingBudget) {
        toDispatch = toDispatch.slice(0, remainingBudget);
      }

      const roundPromises = toDispatch
        .filter(name => agents[name])
        .map(name => {
          const ctx = roundContexts[name] || null;
          // In a conversation round each agent speaks ONLY for itself. A busy
          // or failing member must be skipped with an honest note — never
          // handed off to a peer. Handoff here made sol answer a turn
          // explicitly addressed to @Claude, five times (operator: "it was
          // not sol's place to do so"), and in round-tables it gives one
          // participant a double voice.
          return getAgentResponse(name, agents[name], projectId, targetChannel, text, crossRef, ctx,
            { ...threadMeta, _noHandoff: true, _explicitlyAddressed: !!directed[name] });
        });
      inFlightPromises = roundPromises;
      const roundResults = await Promise.all(roundPromises);
      inFlightPromises = [];
      const hadRateLimits = roundResults.some(r => r === 'rate_limited');
      const hadFailures = hadRateLimits || roundResults.some(r => r === 'timed_out');

      const currentCount = getAgentMessageCount(projectId, targetChannel, threadId);
      const newCount = currentCount - lastMessageCount;
      if (newCount > 0) {
        roundNewMsgs = getRecentAgentMessages(projectId, targetChannel, threadId, newCount);
      } else {
        roundNewMsgs = [];
      }
      totalResponses += newCount;
      lastMessageCount = currentCount;

      // ── Loop quality metrics ──
      if (roundNewMsgs.length > 0 && !wrapUpInjected) {
        const roundTokens = new Set();
        for (const m of roundNewMsgs) {
          if (m.content && !isOperatorSpeaker(m.speaker)) {
            for (const t of tokenize(m.content)) roundTokens.add(t);
          }
        }
        roundFingerprints.push(roundTokens);

        const newTokenCount = [...roundTokens].filter(t => !allSeenTokens.has(t)).length;
        const gain = roundTokens.size > 0 ? newTokenCount / roundTokens.size : 0;
        for (const t of roundTokens) allSeenTokens.add(t);

        if (gain < INFO_GAIN_THRESHOLD) consecutiveLowGain++;
        else { consecutiveLowGain = 0; }

        let overlap = null;
        if (roundFingerprints.length >= 2) {
          const prev = roundFingerprints[roundFingerprints.length - 2];
          const curr = roundFingerprints[roundFingerprints.length - 1];
          overlap = jaccard(prev, curr);
          if (overlap >= REPETITION_THRESHOLD) consecutiveHighOverlap++;
          else consecutiveHighOverlap = 0;
        }

        log.info('Loop metrics', { round, gain: gain.toFixed(3), overlap: overlap !== null ? overlap.toFixed(3) : 'N/A', newTokens: newTokenCount, totalTokens: roundTokens.size, budget: effectiveBudget, highOverlap: consecutiveHighOverlap, lowGain: consecutiveLowGain });

        if (gain >= INFO_GAIN_THRESHOLD && effectiveBudget < MAX_TOTAL_TURNS) {
          effectiveBudget = Math.min(effectiveBudget + newCount, MAX_TOTAL_TURNS);
        }

        if (consecutiveHighOverlap >= REPETITION_PATIENCE || consecutiveLowGain >= REPETITION_PATIENCE) {
          const reason = consecutiveHighOverlap >= REPETITION_PATIENCE ? 'repetition' : 'diminishing returns';
          log.info('Loop quality triggered', { reason, projectId, channel: targetChannel, round });
           addMessage(projectId, targetChannel, 'System',
             `Discussion is cycling (${reason}) — converge on a decision, raise new points, or I'll call a vote.`, 'system', { threadId, userId
           });
          wrapUpInjected = true;
          effectiveBudget = Math.min(round + WRAP_UP_BUDGET + 1, MAX_TOTAL_TURNS);
        }
      }

      // ── Thread participant tracking ──
      if (threadId && newCount > 0) {
        const thread = stateManager.getThread(projectId, threadId);
        if (thread) {
          const threadParticipants = new Set(thread.participants || []);
          for (const m of roundNewMsgs) {
            if (m.speaker && m.speaker !== 'System') threadParticipants.add(m.speaker);
          }
          stateManager.updateThread(projectId, threadId, {
            participants: [...threadParticipants],
            messageCount: (thread.messageCount || 0) + newCount,
          });
        }
      }

      // ── Early exit conditions ──
      if (newCount === 0) {
        if (hadFailures && round <= 1 && !hasMentions) {
          // Failure retry must stay within the originally invited seats.
          // Reseating from the full agent map here dispatched governors and
          // off-roster agents into councils (they were never in the routing
          // plan) — the invited list is already roster- and role-filtered.
          respondents = participants.filter(id =>
            agents[id] && (!agents[id]._status || agents[id]._status === 'active'));
          round = -1;
          continue;
        }
        break;
      }

      if (roundNewMsgs.length > 0 && round > 0) {
        const agentMsgs = roundNewMsgs.filter(m => m.type === 'message' && !isOperatorSpeaker(m.speaker));

        const leadMsg = agentMsgs.find(m => {
          const id = m.speaker?.toLowerCase();
          return id && agents[id] && DELEGATION_ROLES.has(agents[id].role);
        });
        if (leadMsg && leadMsg.content) {
          const hasDelegation = /\n\s*@\w+\s+(?:implement|execute|build|fix|create|write|refactor|deploy|install|configure|setup|migrate|modify|edit|patch|ship|apply|update)\b/is.test(leadMsg.content);
          if (hasDelegation) {
            log.info('Lead delegation detected, ending discussion', { round });
            break;
          }
        }

        if (leadMsg && isClosureResponse(leadMsg.content || '')) {
          log.info('Lead closure, ending discussion', { round });
          break;
        }

        if (agentMsgs.length > 0) {
          const closureCount = agentMsgs.filter(m => isClosureResponse(m.content || '')).length;
          if (closureCount > agentMsgs.length / 2) {
            log.info('Majority closure, ending discussion', { round, closureCount, totalAgentMsgs: agentMsgs.length });
            break;
          }
        }
      }

      if (round === 0 && !hasMentions) {
        // Round-1 widening must stay within the invited seats. Widening from
        // the full agent map dispatched governors and off-roster agents into
        // councils one round after a correctly-seated opening (the routing
        // plan is the sole seat of authority for who may speak).
        respondents = participants.filter(id =>
          agents[id] && (!agents[id]._status || agents[id]._status === 'active'));
      }
    }

    // ── Structured shutdown ──
    const hitBudget = totalResponses >= maxBudget;
    if (hitBudget) {
      log.info('Loop terminated, budget exhausted', { projectId, channel: targetChannel, totalResponses, maxBudget, hardCap: MAX_TOTAL_TURNS, wrapUp: wrapUpInjected });
    }

    for (const p of inFlightPromises) {
      if (typeof p?.abort === 'function') p.abort();
    }

    // Budget exhaustion notice (legacy path only — most messages use solo/pair dispatch now)
    if (wrapUpInjected && roundNewMsgs.length === 0) {
      log.info('Discussion fizzled after wrap-up', { projectId, channel: targetChannel, threadId, totalResponses });
    } else if (hitBudget && roundNewMsgs.length > 0) {
      const lastRoundSubstantive = roundNewMsgs
        .filter(m => m.type === 'message' && !isOperatorSpeaker(m.speaker))
        .some(m => !isClosureResponse(m.content || ''));
      if (lastRoundSubstantive) {
        addMessage(projectId, targetChannel, 'System',
          `Budget exhausted — agents are still debating after ${totalResponses} responses.\nConsider providing more specific guidance.`,
          'system', { threadId });
        broadcastToChannel(projectId, targetChannel, {
          type: 'deadlock', threadId, responseCount: totalResponses, reason: 'budget_exhausted',
        });
      }
    }

    // Agent-to-agent delegation: post-discussion task creation
    if (!wrapUpInjected || !hitBudget) {
      const allThreadMsgs = getRecentAgentMessages(projectId, targetChannel, threadId, 100);
      const directives = extractAgentDirectives(allThreadMsgs, getAgents, execCapable);

      if (directives.size > 0) {
        const executors = [...directives.keys()];
        log.info('Delegation directives extracted', { executors: Object.fromEntries(executors.map(e => [e, directives.get(e).slice(0, 60)])) });

        const threadContext = allThreadMsgs
          .filter(m => m.speaker !== 'System')
          .map(m => `[${m.speaker}]: ${(m.content || '').slice(0, 500)}`)
          .join('\n\n');

        const taskTitle = `Delegation: ${threadLabel || text.slice(0, 60)}`;
        const taskDesc = executors.map(e => `@${e}: ${directives.get(e)}`).join('\n');
        const task = taskManager.createTask(projectId, targetChannel, {
          title: taskTitle,
          description: taskDesc,
          context: `From discussion thread: ${threadId || 'main'}`,
          threadId: threadId || null,
          delegationContext: threadContext,
        });

        const subtasks = executors.map(agentName => ({
          text: directives.get(agentName),
          assignee: agentName,
        }));
        taskManager.addSubtasks(projectId, task.id, subtasks, 'system');
        taskManager.updateTaskStatus(projectId, task.id, 'executing', 'system', 'Delegation dispatch');

        addMessage(projectId, targetChannel, 'System',
          `Task created from delegation: \`${task.id}\`\nSubtasks: ${executors.map(e => `@${e}`).join(', ')}\nThe heartbeat will execute these sequentially.`,
          'system', { threadId });
        broadcastToChannel(projectId, targetChannel, {
          type: 'delegation_task_created', threadId, taskId: task.id, executors,
        });
      }
    }

    return { totalResponses, wrapUpInjected, hitBudget };
  }

  return {
    dispatchSolo,
    dispatchPair,
    conversationLoop,
    getRecentAgentMessages,
    getAgentMessageCount,
  };
}

// Re-export constants used by orchestrator.js
export { isOperatorSpeaker, EXECUTION_RE, DISCUSSION_OVERRIDE_RE, DELEGATION_ROLES };
