/**
 * Dispatch — main user message handler and supporting utilities.
 *
 * Extracted from orchestrator.js (Session 39, #9 refactor).
 * Handles thread resolution, model switching, cross-references,
 * channel routing, execution detection, and routing plan dispatch.
 */

import { createLogger } from '../logger.js';
const log = createLogger('dispatch');

import { randomUUID } from 'crypto';
import { parseMentions, parseDirectedSegments } from '../context.js';
import { resolveThread, updateThreadKeywords, buildThreadLabel } from '../threading.js';
import { buildRoutingPlan, classifyMessage } from '../router.js';
import { isExecutionIntent, rankAgentsByRelevance, DISCUSSION_OVERRIDE_RE } from './conversation.js';
import { emitRoutingWeightsUpdated } from './health-aggregator.js';
import { isWithinTimeWindow } from '../utils/time.js';
import { isAgentPaused } from './agents.js';
import config from '../config.js';
import { DispatchLog } from '../dispatch-log.js';
import { startSpan, endSpan } from '../tracing.js';
import { join } from 'path';
import { classifyFailure } from '../failure-classification.js';
import { AnalyticsSignalsStore } from './analytics-signals-store.js';
import { CategoryCostConfigStore } from './category-cost-config-store.js';
import { ProviderCostStore } from './provider-cost-store.js';
import { ErrorPatternDetector } from './error-pattern-detector.js';
import { initWriteInterception, setAdvisoryMode, getAdvisoryMode, interceptWrite, PermissionError } from './write-interception.js';
import { AgentMemoryStore } from './agent-memory-store.js';
import { MemoryRetrievalService } from './memory-retrieval-service.js';

function getTraceId(span) {
  const traceId = span?.spanContext?.().traceId;
  if (!traceId || /^0+$/.test(traceId)) return null;
  return traceId;
}

// ─── Model Switching ─────────────────────────────────────────────
const MODEL_CMD_RE = /(?:@(\w+)\s+(?:use|switch\s+to|model)\s+(.+?)(?:\s*$|,))|(?:\/model\s+(\w+)\s+(.+?)(?:\s*$|,))/gi;

function parseModelCommands(text, agents) {
  const commands = [];
  let match;
  const re = new RegExp(MODEL_CMD_RE.source, 'gi');
  while ((match = re.exec(text)) !== null) {
    const agentName = (match[1] || match[3])?.toLowerCase();
    const modelName = (match[2] || match[4])?.trim();
    if (agentName && modelName && agents[agentName]) {
      commands.push({ agent: agentName, model: modelName });
    }
  }
  return commands;
}

// ─── Cross-reference & Channel Routing ───────────────────────────
function parseCrossReference(text, stateManager) {
  const match = text.match(/\bfrom\s+(\w+)(?:#(\w[\w-]*))?/i);
  if (!match) return null;
  const project = match[1];
  const channel = match[2] || null;
  if (!stateManager.getProject(project)) return null;
  return { project, channel };
}

function parseChannelRoute(text) {
  const match = text.match(/\b(?:respond|reply|post|answer)\s+in\s+#(\w[\w-]*)/i);
  return match ? match[1] : null;
}

// ─── Turn Queue ──────────────────────────────────────────────────
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

export function createTurnQueue({ timeoutMs = TURN_TIMEOUT_MS } = {}) {
  const turnQueues = new Map();

  function queueTurn(projectId, channelId, userIdOrFn, maybeFn) {
    let userId = 'default';
    let fn = maybeFn;
    if (typeof userIdOrFn === 'function') {
      fn = userIdOrFn;
    } else if (typeof userIdOrFn === 'string' && userIdOrFn.trim()) {
      userId = userIdOrFn;
    }
    if (typeof fn !== 'function') {
      throw new TypeError('queueTurn requires a function callback');
    }
    const key = `${userId}#${projectId}#${channelId}`;
    const prev = turnQueues.get(key) || Promise.resolve();
    const next = prev.then(async () => {
      // Promises cannot cancel fn(), so a hung execution keeps running — but
      // holding the queue key would starve this channel until process restart.
      // Same trade bb46a609 settled for the heartbeat watchdog: possible
      // overlap with a hung-but-eventually-completing turn beats permanent
      // starvation. The delete is unconditional: whatever chain is registered
      // under the key is queued BEHIND this hung turn and equally stuck, so
      // releasing lets new turns start fresh. Turns already chained keep
      // their ordering (they wait on the promise, not the map).
      const timer = setTimeout(() => {
        log.error('Turn exceeded execution timeout; releasing queue key so new turns can start', { key, timeoutMs });
        turnQueues.delete(key);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        return await Promise.resolve().then(fn);
      } finally {
        clearTimeout(timer);
      }
    }).catch(err => {
      log.error('Turn error', { key, error: err.message });
    }).finally(() => {
      if (turnQueues.get(key) === next) turnQueues.delete(key);
    });
    turnQueues.set(key, next);
    return next;
  }

  return { queueTurn, turnQueues };
}

// ─── Dispatch System ─────────────────────────────────────────────
export function createDispatchSystem(deps) {
  const {
    agents, stateManager, config: depsConfig, events,
    addMessage, broadcast, broadcastToChannel,
    commandHandlers, getWss,
    dispatchSolo, dispatchPair, conversationLoop, dispatchExecution,
    EXECUTION_CAPABLE, performanceStore, timelineStore,
    taskManager, campaignManager, anomalyDetector,
    dispatchLog: dispatchLogOverride,
    weightOverrides,
    errorPatternDetector,
    circuitBreaker,
    writeInterceptionConfig,
  } = deps;

  initWriteInterception({
    advisoryMode: writeInterceptionConfig?.advisoryMode || false,
    projectRoot: config.server.projectDir || '',
    protectedPatterns: writeInterceptionConfig?.protectedPatterns,
    auditLogCallback: (auditEvent) => {
      events.emit('governance:write_blocked', auditEvent).catch(() => {});
    },
  });
  log.info('Write interception middleware initialized', {
    advisoryMode: getAdvisoryMode(),
    projectRoot: config.server.projectDir,
  });

  function interceptStateManagerWrite(operation, filePath, context = {}) {
    try {
      interceptWrite(filePath, operation, 'governance', {
        ...context,
        agentId: context.agentId || null,
        taskId: context.taskId || null,
        campaignId: context.campaignId || null,
      });
    } catch (err) {
      if (err instanceof PermissionError) throw err;
      log.error('Write interception error', { operation, filePath, error: err.message });
      throw err;
    }
  }

  const dispatchLog = dispatchLogOverride || new DispatchLog({
    dbPath: join(config.server.projectDir, '.synapse', 'projects', '_dispatch-log.sqlite'),
    legacyJsonlPath: join(config.server.projectDir, '.synapse', 'projects', '_dispatch-log.jsonl'),
  });

  // Initialize analytics signals store for routing weight signals
  let analyticsSignalsStore = null;
  try {
    const timelineDbPath = config.timeline.dbPath.startsWith('/')
      ? config.timeline.dbPath
      : join(config.server.projectDir, config.timeline.dbPath);
    analyticsSignalsStore = new AnalyticsSignalsStore({ dbPath: timelineDbPath });
    log.info('Analytics signals store initialized', { dbPath: timelineDbPath });
  } catch (err) {
    log.warn('Failed to initialize analytics signals store, routing will proceed without signal-based weights', { error: err.message });
  }

  // Initialize category cost config store for per-category cost/quality tradeoff preferences
  const categoryCostConfigStore = new CategoryCostConfigStore(
    join(config.server.projectDir, '.synapse', 'projects')
  );

  // Initialize provider cost store for configurable per-provider cost model
  const providerCostStore = new ProviderCostStore(
    join(config.server.projectDir, '.synapse', 'projects')
  );

  const agentMemoryStore = new AgentMemoryStore(stateManager);
  const memoryRetrievalService = new MemoryRetrievalService({
    agentMemoryStore,
    getAgents: () => agents,
  });

  /**
   * Load and merge provider weights from analytics signals and weight overrides.
   * Returns { providerWeights, hasStaleness, staleProviders, freshnessMetadata }
   *
   * Priority: Weight overrides > Analytics signals > null (backward compat)
   * Analytics signals are used as last-known-good even when stale.
   */
  async function loadProviderWeights() {
    let providerWeights = null;
    let hasStaleness = false;
    let staleProviders = [];
    let freshnessMetadata = null;

    // Step 1: Load analytics signals (if store is available)
    let analyticsWeights = null;
    if (analyticsSignalsStore) {
      try {
        const signals = analyticsSignalsStore.getAllLatestSignals();
        if (signals && Object.keys(signals).length > 0) {
          analyticsWeights = {};
          for (const [provider, signal] of Object.entries(signals)) {
            if (signal.routingWeight !== null && signal.routingWeight !== undefined) {
              analyticsWeights[provider] = signal.routingWeight;
              if (signal.isStale) {
                staleProviders.push({
                  provider,
                  ageMs: signal.ageMs,
                  generatedAt: signal.generatedAt,
                });
              }
            }
          }
          hasStaleness = staleProviders.length > 0;
          freshnessMetadata = {
            source: 'analytics_signals',
            hasStale: hasStaleness,
            staleCount: staleProviders.length,
          };
        }
      } catch (err) {
        log.warn('Failed to load analytics signals for routing weights', { error: err.message });
      }
    }

    // Step 2: Load weight overrides (manual operator overrides)
    let overrideWeights = null;
    if (weightOverrides) {
      try {
        const activeOverride = await weightOverrides.getActive();
        if (activeOverride?.weights && typeof activeOverride.weights === 'object') {
          overrideWeights = activeOverride.weights;
          freshnessMetadata = {
            source: 'weight_override',
            appliedAt: activeOverride.appliedAt,
            reason: activeOverride.reason,
          };
        }
      } catch (err) {
        log.warn('Failed to load weight overrides for routing', { error: err.message });
      }
    }

    // Step 3: Merge weights (overrides take precedence)
    if (overrideWeights) {
      providerWeights = { ...overrideWeights };
      // If override exists, analytics staleness is irrelevant (override wins)
      hasStaleness = false;
      staleProviders = [];
    } else if (analyticsWeights) {
      providerWeights = { ...analyticsWeights };
    }

    return { providerWeights, hasStaleness, staleProviders, freshnessMetadata };
  }

  async function handleUserMessage(text, projectId, channelId, wsThreadMeta = {}, speaker = config.operator.name, userId = 'default') {
    const trimmed = text.trim().toLowerCase();

    // /execute forces execution mode on directed segments
    let forceExecute = false;
    if (trimmed.startsWith('/execute')) {
      forceExecute = true;
      text = text.trim().replace(/^\/execute\s*/i, '');
    }

    // Handle commands via extracted module
    const wss = getWss();
    if (await commandHandlers.handleCommand(text, projectId, channelId, wsThreadMeta, speaker, wss)) {
      return;
    }

    // --- Thread resolution ---
    const activeThreads = stateManager.getActiveThreads(projectId, channelId);
    const channelActiveThread = stateManager.getChannelActiveThread(projectId, channelId);

    // Derive replyToThreadId server-side from the actual replyTo message
    let replyToThreadId = null;
    if (wsThreadMeta.replyTo) {
      const allMsgs = stateManager.getMessages(projectId, channelId, 200);
      const refMsg = allMsgs.find(m => m.id === wsThreadMeta.replyTo);
      if (refMsg && refMsg.threadId) {
        replyToThreadId = refMsg.threadId;
      }
    }

    const resolution = resolveThread(text, activeThreads, {
      replyToThreadId, channelActiveThread,
    });

    let threadId = resolution.threadId;
    let threadLabel = null;

    // Create new thread if needed
    if (resolution.isNew && threadId) {
      const label = buildThreadLabel(text);
      stateManager.createThread(projectId, { id: threadId, label, channel: channelId });
      threadLabel = label;
      const thread = stateManager.getThread(projectId, threadId);
      if (thread) {
        const { keywords, anchorKeywords } = updateThreadKeywords(thread, text, true);
        stateManager.updateThread(projectId, threadId, {
          keywords, anchorKeywords, participants: [speaker], messageCount: 1,
        });
      }
      addMessage(projectId, channelId, 'System', `New thread: "${label}"`, 'system', { threadId });
      broadcastToChannel(projectId, channelId, { type: 'thread_created', threadId, label, channel: channelId });
      events.emit('thread:created', { projectId, channelId, threadId, label }).catch(() => {});
    } else if (threadId) {
      const thread = stateManager.getThread(projectId, threadId);
      if (thread) {
        threadLabel = thread.label;
        const { keywords, anchorKeywords } = updateThreadKeywords(thread, text);
        const participants = new Set(thread.participants || []);
        participants.add(speaker);
        stateManager.updateThread(projectId, threadId, {
          keywords, anchorKeywords,
          participants: [...participants],
          messageCount: (thread.messageCount || 0) + 1,
        });
      }
    }

    // Resolve campaignId from thread (if thread belongs to a task in a campaign)
    let campaignId = null;
    if (threadId && taskManager) {
      const task = taskManager.listTasks(projectId).find(t => t.threadId === threadId);
      if (task) campaignId = task.campaignId;
    }

    // Record user message
    const userMsg = addMessage(projectId, channelId, speaker, text, 'message', {
      threadId, replyTo: wsThreadMeta.replyTo || null, userId,
    });

    // No-eligible-agents guard (Block #30). A fresh user with a failed agent
    // (e.g. ENOENT on the wrong CLI binary) types `hello` and gets silence —
    // the closer-of-tabs moment. Post a system message naming the issue so
    // they know to click the badge and fix Settings. Eligibility mirrors the
    // header "X ready" counter: skip failed/inactive/registered and the
    // paused-flag overlay.
    const eligibleAgents = Object.entries(agents).filter(([id, a]) => {
      const status = a._status;
      if (status === 'failed' || status === 'inactive' || status === 'registered') return false;
      if (isAgentPaused(id)) return false;
      return true;
    });
    if (eligibleAgents.length === 0 && Object.keys(agents).length > 0) {
      // Build a short status line listing each agent and why it's unavailable.
      const summary = Object.entries(agents).map(([id, a]) => {
        const name = a.name || id;
        let reason;
        if (a._status === 'failed') reason = 'failed';
        else if (a._status === 'inactive') reason = 'inactive';
        else if (a._status === 'registered') reason = 'starting';
        else if (isAgentPaused(id)) reason = 'paused';
        else reason = a._status || 'unavailable';
        return `**${name}** (${reason})`;
      }).join(', ');
      addMessage(projectId, channelId, 'System',
        `No agents available to respond. ${summary}. Click an agent badge to open Settings and fix or resume it.`,
        'system', { threadId });
      return;
    }

    // Model switch commands
    const modelCmds = parseModelCommands(text, agents);
    if (modelCmds.length > 0) {
      for (const cmd of modelCmds) {
        const agent = agents[cmd.agent];
        const oldModel = agent.model;
        agent.model = cmd.model;
        log.info('Model changed', { agent: agent.name, from: oldModel, to: cmd.model });
        addMessage(projectId, channelId, 'System', `${agent.name} model changed: ${oldModel} → ${cmd.model}`, 'system');
      }
    }
    const strippedText = text.replace(new RegExp(MODEL_CMD_RE.source, 'gi'), '').trim();
    if (modelCmds.length > 0 && strippedText.length === 0) return;

    // Cross-reference detection
    const crossRef = parseCrossReference(text, stateManager);

    // Channel routing — if user says "respond in #audit", route output there
    const routeChannel = parseChannelRoute(text);
    const targetChannel = routeChannel || channelId;

    if (routeChannel) {
      const proj = stateManager.getProject(projectId);
      if (proj && !proj.channels.includes(routeChannel)) {
        stateManager.createChannel(projectId, routeChannel);
        broadcast({ type: 'channel_created', project: projectId, channel: routeChannel });
      }
      threadId = null;
      threadLabel = null;
    }

    const mentioned = parseMentions(text, agents);
    const { directed, broadcast: broadcastText } = parseDirectedSegments(text, agents);
    const hasMentions = mentioned.length > 0;
    const hasDirectedSegments = Object.keys(directed).length > 0;

    // --- Constraint lookup (before any dispatch path) ---
    let activeConstraints = null;
    if (campaignId && campaignManager) {
      activeConstraints = campaignManager.getActiveConstraints(projectId, campaignId);
      if (activeConstraints && activeConstraints.length > 0) {
        // Check for pause_campaign before any routing — skip dispatch entirely
        const hasPause = activeConstraints.some(c => c.pause_campaign);
        if (hasPause) {
          const reason = activeConstraints.find(c => c.pause_campaign)?.reason || 'operator constraint';
          log.info('Dispatch skipped: campaign paused by constraint', { projectId, campaignId, reason });
          addMessage(projectId, targetChannel, 'System',
            `Campaign paused by constraint: ${reason}. New assignments are halted until the constraint is removed.`,
            'system', { threadId });
          return;
        }

        // --- max_concurrent constraint check ---
        const maxConcurrentEntry = activeConstraints.find(c => (c.type === 'max_concurrent' && typeof c.value === 'number') || typeof c.max_concurrent === 'number');
        if (maxConcurrentEntry) {
          const maxConcurrent = maxConcurrentEntry.type === 'max_concurrent' ? maxConcurrentEntry.value : maxConcurrentEntry.max_concurrent;
          if (typeof maxConcurrent === 'number') {
            const activeTasks = taskManager.listTasks(projectId).filter(t => 
              t.campaignId === campaignId && 
              ['planning', 'executing', 'reviewing'].includes(t.status)
            );
            
            // Check if current thread is already part of an active task for this campaign
            const isThreadActive = activeTasks.some(t => t.threadId === threadId);
            
            if (activeTasks.length >= maxConcurrent && !isThreadActive) {
               const skipReason = `max_concurrent limit reached (${activeTasks.length}/${maxConcurrent})`;
               log.info('Dispatch skipped: campaign constraint', { projectId, campaignId, skipReason });
               addMessage(projectId, targetChannel, 'System',
                 `Dispatch skipped: campaign max_concurrent limit (${maxConcurrent}) reached. ${activeTasks.length} tasks are currently active.`,
                 'system', { threadId });
               return;
            }
          }
        }
      }
    }

    // --- time_window constraint check ---
    if (activeConstraints && activeConstraints.length > 0) {
      const timeWindowConstraints = activeConstraints.filter(c => c.type === 'time_window');
      if (timeWindowConstraints.length > 0) {
        const now = new Date();
        const blockedByTimeWindow = [];
        
        for (const constraint of timeWindowConstraints) {
          if (!isWithinTimeWindow(constraint.value, now)) {
            blockedByTimeWindow.push(constraint);
          }
        }
        
        if (blockedByTimeWindow.length > 0) {
          const skipReason = `outside time window (${blockedByTimeWindow.map(c => c.reason || 'operator constraint').join('; ')})`;
          log.info('Dispatch skipped: blocked by time_window constraint', { projectId, campaignId, skipReason });
          
          events.emit('telemetry:dispatch_skipped', {
            event: 'telemetry:dispatch_skipped',
            agentId: null,
            taskId: null,
            projectId,
            phase: 'constraint_check',
            timestamp: now.toISOString(),
            payload: {
              reason: 'time_window',
              skipReason,
              campaignId,
              constraintCount: blockedByTimeWindow.length,
              constraints: blockedByTimeWindow.map(c => ({ id: c.id, type: c.type, reason: c.reason })),
            },
          }).catch(() => {});
          
          addMessage(projectId, targetChannel, 'System',
            `Dispatch blocked by time_window constraint: ${skipReason}. Routing is paused until the configured time window is active.`,
            'system', { threadId });
          return;
        }
      }
    }

    // Thread metadata — declared BEFORE the execution-dispatch branch so the
    // `dispatchExecution(..., threadMeta.parentSpanContext)` call inside the
    // hasDirectedSegments block doesn't hit a TDZ ("Cannot access threadMeta
    // before initialization"). A prior commit had moved this up for the same
    // reason; commit 7d0dbfd9 (2026-04-12) reverted that move and reintroduced
    // the latent bug. Surfaced 2026-05-31 when a directed @agent execution
    // message hit the chat dispatch path.
    const threadMeta = { threadId, threadLabel, replyTo: userMsg.id, parentSpanContext: null };

    // --- Execution mode detection ---
    const firstDirectedText = Object.values(directed)[0] || '';
    const preambleSuppresses = (broadcastText && DISCUSSION_OVERRIDE_RE.test(broadcastText))
      || DISCUSSION_OVERRIDE_RE.test(firstDirectedText);
    if (hasDirectedSegments) {
      const executionTasks = {};
      for (const [agentName, task] of Object.entries(directed)) {
        if ((forceExecute || (!preambleSuppresses && isExecutionIntent(task))) && EXECUTION_CAPABLE.has(agentName)) {
          executionTasks[agentName] = task;
        }
      }

      if (Object.keys(executionTasks).length > 0) {
        const execStats = await dispatchExecution(executionTasks, forceExecute, projectId, targetChannel, threadId, threadLabel, userMsg, userId, threadMeta.parentSpanContext);

        // --- Outcome tracking for execution mode (moved outside performanceStore guard) ---
        if (execStats) {
          for (const s of execStats) {
            if (dispatchLog?.updateOutcome && s.dispatchId) {
              dispatchLog.updateOutcome(s.dispatchId, s.success ? 'success' : 'failure');
            }
          }
        }
        // --- End outcome tracking ---

        // --- Persist cost events for execution mode ---
        if (timelineStore && execStats && campaignId) {
          const task = taskManager?.listTasks(projectId).find(t => t.threadId === threadId);
          const taskId = task?.id || null;
          const milestoneId = task?.milestoneId || null;
          const subtaskId = task?.subtaskId || null;
          for (const s of execStats) {
            const idempotencyKey = `${s.dispatchId}-${s.agentId}`;
            timelineStore.appendCostEvent({
              agentId: s.agentId,
              inputTokens: s.inputTokens || 0,
              outputTokens: s.outputTokens || 0,
              costUsd: s.costUsd || 0,
              dispatchId: s.dispatchId,
              traceId: getTraceId(s.spanContext),
              campaignId,
              milestoneId,
              taskId,
              subtaskId,
              provider: s.provider || null,
              model: s.model || null,
              idempotencyKey,
            });
            
            events.emit('cost_updated', {
              agentId: s.agentId,
              campaignId,
              provider: s.provider || null,
              costUsd: s.costUsd || 0,
              dispatchId: s.dispatchId,
              timestamp: new Date().toISOString(),
            }).catch(() => {});
          }
        }
        // --- End cost events ---

        if (performanceStore && execStats) {
          for (const s of execStats) {
            const tokenCostData = {
              inputTokens: s.inputTokens,
              outputTokens: s.outputTokens,
              costUsd: s.costUsd,
            };
            performanceStore.updateAgentPerformance(s.agentId, s.category, s.success, s.durationMs, campaignId, s.failureType, tokenCostData);
            
            // Record failure in error pattern detector for constraint detection
            if (!s.success && s.failureType && errorPatternDetector && s.dispatchId) {
              const classified = classifyFailure(s.agentId, s.failureType, s.category, s.dispatchId);
              errorPatternDetector.recordFailure(
                s.agentId,
                classified.category,
                classified.errorClassification,
                s.dispatchId,
                getTraceId(s.spanContext)
              );
            }
            
            const stats = performanceStore.getStatsByAgentCategory(s.agentId, s.category);
            broadcastToChannel(projectId, targetChannel, {
              type: 'performance_update', agent_id: s.agentId, category: s.category, stats,
            });
          }
          emitRoutingWeightsUpdated();
          anomalyDetector?.checkAll();
        }
        return;
      }
    }

    // threadMeta is declared earlier (above the execution-dispatch branch)
    // to avoid the TDZ that fires when hasDirectedSegments path reaches it.

    // --- Directed routing ---
    const modeOverride = wsThreadMeta.mode || null;

    if (config.router.enabled) {
      const _rank = (text) => rankAgentsByRelevance(text, () => agents);
      const effectivePerformanceStore = config.orchestrator.dynamicRoutingEnabled ? performanceStore : null;

      // Load provider weights from analytics signals and weight overrides
      const { providerWeights, hasStaleness, staleProviders, freshnessMetadata } = await loadProviderWeights();

      // Pre-classify message to determine task category for cost coefficient lookup
      const preClassification = classifyMessage(text, mentioned, agents);
      const taskCategory = preClassification?.type || null;
      const categoryConfig = (taskCategory ? await categoryCostConfigStore.get(taskCategory) : null) ?? { costCoefficient: config.router.cost_weight };

      // Load provider costs for cost-aware routing
      const providerCosts = await providerCostStore.getCosts();

      // Build routing config with provider weights, staleness metadata, cost coefficient, and cost map
      const routingConfig = {
        floorWeight: config.router.floorWeight,
        sensitivityThreshold: config.router.sensitivityThreshold,
        costCoefficient: categoryConfig.costCoefficient,
        providerCostMap: providerCosts,
        providerWeights: providerWeights ? {
          weights: providerWeights,
          status: hasStaleness ? 'stale' : 'fresh',
          reason: freshnessMetadata?.reason || (hasStaleness ? 'stale_signals' : 'fresh_signals'),
          source: freshnessMetadata?.source || 'analytics_signals',
          fallbackUsed: hasStaleness,
          asOf: freshnessMetadata?.appliedAt || (staleProviders.length > 0 ? Math.min(...staleProviders.map(p => new Date(p.generatedAt).getTime())) : Date.now()),
          staleByMs: staleProviders.length > 0 ? Math.max(...staleProviders.map(p => p.ageMs)) : 0,
        } : null,
      };

      const projectRosterSpec = stateManager.getProject(projectId)?.agents ?? null;
      const plan = buildRoutingPlan(text, mentioned, directed, agents, deps.isAgentCoolingDown, _rank, modeOverride, effectivePerformanceStore, activeConstraints, routingConfig, circuitBreaker, projectRosterSpec);

      if (plan) {
        const modeSource = plan.autoClassified ? 'auto' : 'user';
        const logMeta = { type: plan.type, complexity: plan.complexity || null, confidence: plan.confidence.toFixed(2), mode: plan.mode, modeSource, agents: plan.participants, routing_metadata: plan.routing_metadata };

        // Include provider weights in log when present
        if (providerWeights) {
          logMeta.providerWeights = providerWeights;
          logMeta.weightSource = freshnessMetadata?.source || 'unknown';
          if (hasStaleness) {
            logMeta.staleness = {
              staleCount: staleProviders.length,
              providers: staleProviders.map(s => s.provider),
            };
          }
        }

        log.info('Routing plan', logMeta);

        // Council plans convene the round-table directly — there is no
        // primary/secondary machinery in a council; every participant
        // speaks for itself in conversationLoop's rounds.
        if (plan.mode === 'council') {
          await conversationLoop(
            plan.participants, text, projectId, targetChannel, threadMeta, crossRef,
            plan.budget, hasMentions, directed, broadcastText, userMsg,
            userId
          );
          return;
        }

        const primarySelection = plan.routing_metadata?.primary_selection || null;
        const secondarySelection = plan.routing_metadata?.secondary_selection || null;
        const constraintApplied = plan.routing_metadata?.constraint_applied || null;

        const candidates = primarySelection?.weights || [];
        const candidatesWithProvider = candidates.map(c => {
          const agent = agents[c.id];
          return {
            agentId: c.id,
            provider: agent?.provider || null,
            successRate: c.successRate,
            decayedRate: c.successRate,
          };
        });

        const constraintsApplied = constraintApplied ? constraintApplied.map(rule => {
          const parts = rule.split(':');
          const type = parts[0];
          const value = parts.length > 1 ? parts.slice(1).join(':') : null;
          const agentsRemoved = [];
          if (type === 'exclude_agents' && value) {
            agentsRemoved.push(...value.split(','));
          }
          return { type, value, agentsRemoved };
        }) : [];

        const weights = candidates.map(c => ({
          agentId: c.id,
          weight: c.weight,
          reason: c.reason || 'weighted_selection',
          successRate: c.successRate,
        }));

        const dispatchStartTime = Date.now();
        const dispatchSpan = startSpan('dispatch.router', {
          agentId: plan.primary,
          provider: agents[plan.primary]?.provider || 'unknown',
          model: agents[plan.primary]?.model || 'unknown',
          taskCategory: plan.type,
          projectId,
          channelId: targetChannel,
          success: false,
          durationMs: 0,
        }, null);
        const dispatchTraceId = getTraceId(dispatchSpan);

        const auditRecord = {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          taskCategory: plan.type,
          campaignId: campaignId || null,
          candidates: candidatesWithProvider,
          constraintsApplied,
          weights,
          roll: primarySelection?.roll || null,
          selectedAgent: plan.primary,
          selectionReason: primarySelection?.reason || 'explicit_mention',
          traceId: dispatchTraceId,
          inputs: text,
        };

        // Retrieve agent memories with relevance ranking and caching
        const agentIdForMemory = plan.primary;
        const retrievedMemories = await memoryRetrievalService.getRelevantMemories(agentIdForMemory, {
          maxResults: 10,
          recencyHours: 72,
        });
        log.debug('Retrieved agent memories for dispatch', { agentId: agentIdForMemory, memoryCount: retrievedMemories.length, memories: retrievedMemories.map(m => m.id) });

        // Wire steer metadata into audit record for timeline traceability
        if (wsThreadMeta.steer) {
          const s = wsThreadMeta.steer;
          auditRecord.parentDispatchId = s.parentDispatchId || null;
          auditRecord.steer = {
            parentDispatchId: s.parentDispatchId || null,
            operatorId: s.operatorId || null,
            targetAgent: s.targetAgent || null,
            targetProvider: s.targetProvider || null,
          };

          // Set replayed_from_id for dispatch-log linkage
          if (s.parentDispatchId) {
            auditRecord.replayed_from_id = s.parentDispatchId;
            auditRecord.is_replay = true;
          }
        }

        if (secondarySelection && plan.mode === 'pair') {
          auditRecord.secondary_selection = {
            candidates: secondarySelection.candidates || [],
            roll: secondarySelection.roll || null,
            reason: secondarySelection.reason || null,
          };
        }

        const persisted = await dispatchLog.append(auditRecord);
        if (persisted?.id) auditRecord.id = persisted.id;
        if (events?.emit) {
          events.emit('dispatch:decision', {
            ...auditRecord,
            provider: agents[plan.primary]?.provider || null,
            projectId,
            channelId: targetChannel,
            threadId,
          }).catch(() => {});
        }

        broadcastToChannel(projectId, targetChannel, {
          type: 'routing', classification: plan.type, mode: plan.mode,
          autoClassified: plan.autoClassified, primary: plan.primary,
          secondary: plan.secondary, participants: plan.participants, threadId,
          routing_metadata: plan.routing_metadata,
        });

        broadcastToChannel(projectId, targetChannel, {
          type: 'dispatch_decision',
          id: auditRecord.id,
          timestamp: auditRecord.timestamp,
          taskCategory: auditRecord.taskCategory,
          campaignId: auditRecord.campaignId,
          selectedAgent: auditRecord.selectedAgent,
          selectionReason: auditRecord.selectionReason,
          traceId: auditRecord.traceId,
          projectId: auditRecord.projectId,
        });

        let stats = [];
        if (plan.mode === 'solo') {
          stats = await dispatchSolo(plan, text, projectId, targetChannel, crossRef, threadMeta, userMsg.id, userId);
        } else if (plan.mode === 'pair') {
          stats = await dispatchPair(plan, text, projectId, targetChannel, crossRef, threadMeta, userMsg.id, userId);
        }

        // Update dispatch decision outcome based on stats
        if (stats && stats.length > 0) {
          const allSuccess = stats.every(s => s.success === true);
          const allFailure = stats.every(s => s.success === false);
          let outcome;
          if (allSuccess) {
            outcome = 'success';
          } else if (allFailure) {
            outcome = 'failure';
          } else {
            outcome = 'partial';
          }
          dispatchLog.updateOutcome(auditRecord.id, outcome);
        }

        if (dispatchSpan) {
          const durationMs = Date.now() - dispatchStartTime;
          dispatchSpan.setAttribute('durationMs', durationMs);
          dispatchSpan.setAttribute('success', true);
          dispatchSpan.setAttribute('selectionReason', primarySelection?.reason || 'explicit_mention');
          dispatchSpan.setAttribute('weights', JSON.stringify(weights));
          endSpan(dispatchSpan, { success: true });
        }

        // --- Persist cost events for router-based dispatch ---
        if (timelineStore && stats && stats.length > 0 && campaignId) {
          const task = taskManager?.listTasks(projectId).find(t => t.threadId === threadId);
          const taskId = task?.id || null;
          const milestoneId = task?.milestoneId || null;
          const subtaskId = task?.subtaskId || null;
          for (const s of stats) {
            const idempotencyKey = `${auditRecord.id}-${s.agentId}`;
            timelineStore.appendCostEvent({
              agentId: s.agentId,
              inputTokens: s.inputTokens || 0,
              outputTokens: s.outputTokens || 0,
              costUsd: s.costUsd || 0,
              dispatchId: auditRecord.id,
              traceId: dispatchTraceId,
              campaignId,
              milestoneId,
              taskId,
              subtaskId,
              provider: s.provider || null,
              model: s.model || null,
              idempotencyKey,
            });
            
            events.emit('cost_updated', {
              agentId: s.agentId,
              campaignId,
              provider: s.provider || null,
              costUsd: s.costUsd || 0,
              inputTokens: s.inputTokens || 0,
              outputTokens: s.outputTokens || 0,
              dispatchId: auditRecord.id,
              timestamp: new Date().toISOString(),
            }).catch(() => {});
          }
        }
        // --- End cost events ---

        if (performanceStore && stats) {
          for (const s of stats) {
            const tokenCostData = {
              inputTokens: s.inputTokens,
              outputTokens: s.outputTokens,
              costUsd: s.costUsd,
            };
            performanceStore.updateAgentPerformance(s.agentId, s.category, s.success, s.durationMs, campaignId, s.failureType, tokenCostData);
            
            // Record failure in error pattern detector for constraint detection
            if (!s.success && s.failureType && errorPatternDetector && s.dispatchId) {
              const classified = classifyFailure(s.agentId, s.failureType, s.category, s.dispatchId);
              errorPatternDetector.recordFailure(
                s.agentId,
                classified.category,
                classified.errorClassification,
                s.dispatchId,
                getTraceId(s.spanContext)
              );
            }
            
            const updatedStats = performanceStore.getStatsByAgentCategory(s.agentId, s.category);
            broadcastToChannel(projectId, targetChannel, {
              type: 'performance_update', agent_id: s.agentId, category: s.category, stats: updatedStats,
            });
          }
          emitRoutingWeightsUpdated();
          anomalyDetector?.checkAll();
        }
        return;
      }
    }

    // --- Legacy path (router disabled or plan null) ---
    let respondents;
    if (hasMentions) {
      respondents = mentioned;
    } else {
      const _rank = (text2) => rankAgentsByRelevance(text2, () => agents);
      const ranked = _rank(text);
      respondents = ranked.map(r => r.id);
      if (ranked[0]?.score > 0) {
        log.info('Delegation ranking', { agents: Object.fromEntries(ranked.filter(r => r.score > 0).map(r => [r.id, r.score])) });
      }
    }

    await conversationLoop(
      respondents, text, projectId, targetChannel, threadMeta, crossRef,
      null, hasMentions, directed, broadcastText, userMsg,
      userId
    );
  }

  return { handleUserMessage, dispatchLog };
}
