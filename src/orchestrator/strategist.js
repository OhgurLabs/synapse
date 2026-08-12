/**
 * Campaign Strategist System — evaluates milestones, decomposes campaigns, injects ideas.
 * Drives campaigns through: active → milestone decomposition → task creation → milestone completion.
 */
import { createLogger } from '../logger.js';
import { filterEligibleAgentEntries, isAgentEligibleNow } from './agent-availability.js';
import { parseStructuredJson } from './structured-json.js';
import { ingestCampaignPerformance } from '../closeout-pipeline.js';
import { isWithinTimeWindow } from '../utils/time.js';
import { rosterAllowsAgent } from '../roster.js';

const log = createLogger('strategist');

/**
 * Persist a confirmed strategist rate-limit cooldown without preventing the
 * caller from continuing to circuit-breaker and fallback handling.
 */
export function persistStrategistCooldown(agentId, reason, phaseLabel, setAgentCooldown, logger = log) {
  if (!agentId || typeof setAgentCooldown !== 'function') return false;
  try {
    setAgentCooldown(agentId, reason);
    return true;
  } catch (err) {
    logger.error('Failed to persist strategist agent cooldown', {
      agentId,
      phaseLabel,
      error: err?.message || String(err),
    });
    return false;
  }
}

export function createStrategistSystem(deps) {
  const {
    campaignManager, taskManager, stateManager, agents,
    addMessage, broadcastToChannel, withTimeout, config, PROJECT_DIR,
    getVectorStore, ragSearch, learningsManager, performanceStore,
    isAgentCoolingDown, circuitBreaker, setAgentCooldown,
    thinkingAgents,
  } = deps;
  const vaultWriter = deps.vaultWriter || null;
  const MODEL_NOT_FOUND_RE = deps.MODEL_NOT_FOUND_RE || /ModelNotFoundError|model.?not.?found|Requested entity was not found/i;
  const RATE_LIMIT_RE = deps.RATE_LIMIT_RE || /you've hit your(?: usage)? limit|rate limit exceeded|too many requests.*retry|HTTP 429.*retry|status 429|429.*resource_exhausted|exceeded.*quota|quota exceeded|terminal.?quota.?error|exhausted your capacity on this model|try again at \d{1,2}:\d{2}|resets \d{1,2}(?:am|pm)|reset(?:s)? after \d+[hms]/i;
  // NOTE: This regex intentionally excludes patterns that appear in status/usage output
  // to avoid false positives from Codex showing "weekly limit: 70% left" or "resets 16:22"
  // as rate limit errors. Only match actual error messages, not informational status.

  let strategistRunning = false;
  const decomposingMilestones = new Set();
  const decomposingCampaigns = new Set();
  const providerInFlight = new Map(); // provider -> count for strategist planner/research calls
  // Track milestone retry counts for auto-escalation (milestoneId → count)
  const milestoneRetryCounts = new Map();
  const backlogRetryCounts = new Map();    // taskId -> count (persisted mirror: task.backlogRetryCount)
  const MAX_BACKLOG_RETRIES = 3;           // idle-time salvage budget per task, then permanent
  const lastBacklogSweepAt = new Map();    // projectId -> timestamp
  let strategistInterval = null;
  const STRATEGIST_INTERVAL_MS = config.campaigns.strategistIntervalMs;
  const FAILED_BACKLOG_SWEEP_COOLDOWN_MS = 60_000;

  function providerConcurrencyCap(provider) {
    return provider === 'gemini' ? 1 : Number.POSITIVE_INFINITY;
  }

  function tryAcquireProviderSlot(provider) {
    const cap = providerConcurrencyCap(provider);
    if (!Number.isFinite(cap)) return true;
    const current = providerInFlight.get(provider) || 0;
    if (current >= cap) return false;
    providerInFlight.set(provider, current + 1);
    return true;
  }

  function releaseProviderSlot(provider) {
    const cap = providerConcurrencyCap(provider);
    if (!Number.isFinite(cap)) return;
    const current = providerInFlight.get(provider) || 0;
    if (current <= 1) providerInFlight.delete(provider);
    else providerInFlight.set(provider, current - 1);
  }

  /** Check if at least one non-Ollama (cloud) agent is available for work. */
  function isAnyCloudAgentAvailable() {
    return Object.entries(agents).some(([id, a]) =>
      a.provider !== 'ollama' &&
      isAgentEligibleNow(agents, id, { isAgentCoolingDown, circuitBreaker })
    );
  }

  function isAnyAgentAvailable() {
    const eligible = Object.entries(agents).filter(([id, a]) =>
      isAgentEligibleNow(agents, id, { isAgentCoolingDown, circuitBreaker })
    );
    log.info('isAnyAgentAvailable check', {
      totalAgents: Object.keys(agents).length,
      eligibleAgents: eligible.map(([id, a]) => id),
      eligibleCount: eligible.length
    });
    return eligible.length > 0;
  }

  /** Check if a campaign is within its time_window constraint. */
  function isCampaignWithinTimeWindow(campaign) {
    const constraints = campaign?.constraints || [];
    const timeWindowConstraint = constraints.find(
      c => c.active === true && c.type === 'time_window' && c.value
    );
    if (!timeWindowConstraint || !timeWindowConstraint.value) return true;
    return isWithinTimeWindow(timeWindowConstraint.value);
  }

  /** Get skip reason for time_window constraint. */
  function getTimeWindowSkipReason(campaign) {
    const constraints = campaign?.constraints || [];
    const timeWindowConstraint = constraints.find(
      c => c.active === true && c.type === 'time_window' && c.value
    );
    if (!timeWindowConstraint) return null;
    const value = timeWindowConstraint.value;
    if (value.after) {
      return `Campaign is scheduled to start after ${new Date(value.after).toISOString()}`;
    }
    if (value.before) {
      return `Campaign time window ended at ${new Date(value.before).toISOString()}`;
    }
    if (value.days) {
      return `Campaign is only active on ${value.days.join(', ')}`;
    }
    if (value.startHour !== undefined || value.endHour !== undefined) {
      const parts = [];
      if (value.startHour !== undefined) parts.push(`starting at ${value.startHour}:00`);
      if (value.endHour !== undefined) parts.push(`ending at ${value.endHour}:00`);
      return `Campaign is only active ${parts.join(' ')}`;
    }
    return 'Campaign is outside its configured time window';
  }

  /** Ordered architect/planner candidates for strategist work. */
  function orderedArchitectEntries() {
    const entries = filterEligibleAgentEntries(agents, { isAgentCoolingDown, circuitBreaker });
    const out = [];
    const seen = new Set();
    const pushFirst = (pred) => {
      for (const entry of entries) {
        const [id, a] = entry;
        if (seen.has(id)) continue;
        if (!pred(id, a)) continue;
        seen.add(id);
        out.push(entry);
        return;
      }
    };
    // Strategist preference: architect-role first within provider tiers,
    // then providers, then local architects. By role+provider only — never
    // by agent id.
    pushFirst((_id, a) => a.role === 'architect' && a.provider === 'claude');
    pushFirst((_id, a) => a.role === 'architect' && a.provider === 'gemini');
    pushFirst((_id, a) => a.role === 'architect' && a.provider === 'codex');
    pushFirst((_id, a) => a.provider === 'gemini');
    pushFirst((_id, a) => a.provider === 'codex');
    pushFirst((_id, a) => a.role === 'architect' && a.provider === 'ollama');
    pushFirst((_id, a) => a.role === 'architect');
    pushFirst((_id, a) => a.provider === 'claude');
    pushFirst(() => true);
    for (const entry of entries) {
      const [id] = entry;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(entry);
    }
    return out;
  }

  /** Pick the current best architect (single-choice helper used by legacy call sites). */
  function pickArchitect() {
    return orderedArchitectEntries()[0]?.[1];
  }

  function getAgentId(agentRef) {
    return Object.entries(agents).find(([, a]) => a === agentRef)?.[0] || null;
  }

  function handleStrategistRateLimit(agentRef, responseOrError, projectId, channelId, phaseLabel, opts = {}) {
    const { announce = true } = opts;
    const text = String(responseOrError || '');
    // Model-not-found is a config error, not a rate limit — don't cooldown, just fail through
    if (MODEL_NOT_FOUND_RE.test(text)) {
      log.error('Strategist planner model not found — config error', { agent: agentRef?.name, phaseLabel });
      return true; // signal to try fallback, but don't set cooldown
    }
    if (!RATE_LIMIT_RE.test(text)) return false;
    const id = getAgentId(agentRef);
    persistStrategistCooldown(id, text, phaseLabel, setAgentCooldown);
    if (circuitBreaker && id) {
      const agentProvider = agentRef?.provider || id;
      // This site only fires on a confirmed rate-limit text match (see the
      // RATE_LIMIT_RE check in the caller), so the CB reason is 'rate_limit'.
      circuitBreaker.recordFailure(agentProvider, null, 'rate_limit');
    }
    if (announce) {
      addMessage(projectId, channelId, 'System',
        `${agentRef?.name || 'Planner'} hit a rate limit during ${phaseLabel}. Deferring until fallback agents are available.`,
        'system');
    }
    return true;
  }

  /**
   * Normalize an architect response to its text. Agent .send() returns a
   * ResponseObject (string-like: .text, toString, .match) on the happy path,
   * but rare fallback/error paths can yield a bare string, null, or an error
   * object. Extract the text so downstream .match()/.JSON.parse work.
   * NOTE: must NOT coerce non-strings to '' — a ResponseObject is an object;
   * doing so silently empties every successful response (caused a 100%
   * campaign-generation stall in Iter5).
   */
  function responseText(r) {
    if (typeof r === 'string') return r;
    if (r == null) return '';
    if (typeof r.text === 'string') return r.text;
    try { return String(r); } catch { return ''; }
  }

  /**
   * Send a strategist/planner request through the architect fallback chain.
   * Returns { architect, response } on success, or null if all fallbacks failed/blocked.
   */
  async function sendWithArchitectFallback({
    projectId,
    channelId,
    phaseLabel,
    prompt,
    noArchitectMessage,
    responseValidator = null,
    onValidationExhausted = null,
  }) {
    let candidates = orderedArchitectEntries();
    // Per-project agent roster (RosterSpec — ids, model-tier classes, role
    // matrix): planning/decomposition is architect-role work and must stay
    // on-roster (model-vs-model showdowns must not leak planning to
    // off-roster models).
    const projRoster = stateManager.getProject(projectId)?.agents;
    if (projRoster) {
      candidates = candidates.filter(([id, a]) => rosterAllowsAgent(projRoster, id, a, 'architect'));
    }
    if (candidates.length === 0) {
      if (noArchitectMessage) addMessage(projectId, channelId, 'System', noArchitectMessage, 'system');
      return null;
    }

    let sawRateLimit = false;
    let lastError = null;
    let lastErrorAgent = null;
    let lastValidationFailure = null;

    for (let i = 0; i < candidates.length; i++) {
      const [, architect] = candidates[i];
      const provider = architect.provider || getAgentId(architect) || 'unknown';
      let acquiredSlot = false;
      if (!tryAcquireProviderSlot(provider)) {
        log.info('Strategist provider concurrency cap reached; trying fallback', {
          projectId, phaseLabel, architect: architect.name, provider, attempt: i + 1,
        });
        continue;
      }
      acquiredSlot = true;
      // Mark agent as thinking so cookie reconciler doesn't kill it as orphan
      const thinkingKey = thinkingAgents ? `strategist:${projectId}#${(architect.id || architect.name).toLowerCase()}` : null;
      if (thinkingKey) thinkingAgents.add(thinkingKey);
      try {
        const rawResponse = await withTimeout(
          architect.send(prompt, workingDir(projectId), { maxTurns: config.campaigns.decomposeMaxTurns }),
          config.campaigns.decomposeTimeoutMs,
          architect.name
        );
        // Normalize ResponseObject → string. handleStrategistRateLimit +
        // responseValidator below both expect string content; passing an
        // object causes silent rate-limit-detection misses and validator
        // false-negatives for descriptor-backed agents. Same pattern as
        // execution.js + orchestrator.js + session.js + lifecycle.js.
        const response = typeof rawResponse === 'string' ? rawResponse
          : (rawResponse?.text != null ? String(rawResponse.text) : String(rawResponse ?? ''));
        if (handleStrategistRateLimit(architect, response, projectId, channelId, phaseLabel, { announce: false })) {
          sawRateLimit = true;
          log.warn('Strategist planner rate limited; trying fallback', { projectId, phaseLabel, architect: architect.name, attempt: i + 1 });
          continue;
        }
        if (typeof responseValidator === 'function') {
          let validation;
          try {
            validation = await responseValidator(response, { architect, projectId, channelId, phaseLabel });
          } catch (err) {
            validation = { ok: false, reason: 'validator_error', error: err };
          }
          if (!validation?.ok) {
            lastValidationFailure = { architect, response, validation };
            log.warn('Strategist planner produced unusable response; trying fallback', {
              projectId,
              phaseLabel,
              architect: architect.name,
              attempt: i + 1,
              reason: validation?.reason || 'validation_failed',
              error: validation?.error?.message,
            });
            continue;
          }
          return { architect, response, validated: validation };
        }
        return { architect, response };
      } catch (err) {
        if (handleStrategistRateLimit(architect, err.message, projectId, channelId, phaseLabel, { announce: false })) {
          sawRateLimit = true;
          log.warn('Strategist planner error matched rate limit; trying fallback', { projectId, phaseLabel, architect: architect.name, attempt: i + 1 });
          continue;
        }
        lastError = err;
        lastErrorAgent = architect;
        log.warn('Strategist planner failed; trying fallback', {
          projectId, phaseLabel, architect: architect.name, error: err.message, attempt: i + 1,
        });
      } finally {
        if (acquiredSlot) releaseProviderSlot(provider);

      }
    }

    if (sawRateLimit) {
      addMessage(projectId, channelId, 'System',
        `Planner rate limits during ${phaseLabel} exhausted the planner fallback chain across all providers. Will retry later.`,
        'system');
      return null;
    }

    if (lastValidationFailure) {
      if (typeof onValidationExhausted === 'function') {
        try {
          onValidationExhausted(lastValidationFailure);
        } catch (hookErr) {
          log.warn('Strategist validation exhaustion hook failed', { phaseLabel, error: hookErr.message });
        }
      }
      return null;
    }

    if (lastError) {
      addMessage(projectId, channelId, 'System',
        `${lastErrorAgent?.name || 'Planner'} failed during ${phaseLabel}: ${lastError.message}`,
        'system');
    } else if (noArchitectMessage) {
      addMessage(projectId, channelId, 'System', noArchitectMessage, 'system');
    }

    return null;
  }

  /** Resolve working directory for a project. */
  function workingDir(projectId) {
    return stateManager.getProject(projectId)?.projectDir || PROJECT_DIR;
  }

  /** Retry a historical failed task (outside the active milestone path) when capacity permits. */
  function maybeSweepFailedBacklog(projectId) {
    const now = Date.now();
    const last = lastBacklogSweepAt.get(projectId) || 0;
    if ((now - last) < FAILED_BACKLOG_SWEEP_COOLDOWN_MS) return;

    const allTasks = taskManager.listTasks(projectId);
    const runnableStatuses = new Set(['queued', 'planning', 'reviewing', 'sleeping']);
    const inFlightStatuses = new Set(['executing']);
    const queuePressure = allTasks.some(t => runnableStatuses.has(t.status));
    if (queuePressure) return;

    const inFlightCount = allTasks.filter(t => inFlightStatuses.has(t.status)).length;
    const maxConcurrent = config.tasks?.maxConcurrentTasks || 3;
    // Keep this back-of-line: only sweep when at least one task slot is free.
    if (inFlightCount >= maxConcurrent) return;

    const deferredDueSoon = allTasks.some(t => {
      if (t.status !== 'deferred' || !t.nextAttemptAt) return false;
      const ts = Date.parse(t.nextAttemptAt);
      return Number.isFinite(ts) && ts <= (now + 30_000);
    });
    if (deferredDueSoon) return;

    const activeMilestoneTaskIds = new Set();
    for (const c of campaignManager.listCampaigns(projectId, 'active')) {
      const ms = c.milestones?.find(m => m.status === 'active');
      for (const taskId of (ms?.tasks || [])) activeMilestoneTaskIds.add(taskId);
    }

    // Hard stop: a backlog task gets at most MAX_BACKLOG_RETRIES idle-time
    // salvage attempts. The counter persists on the task (backlogRetryCount)
    // so restarts don't reset the budget — the in-memory map alone let a
    // permanently-broken task burn escalated dispatches forever.
    const failedBacklog = allTasks.filter(t =>
      t.status === 'failed' &&
      !activeMilestoneTaskIds.has(t.id) &&
      (t.backlogRetryCount || backlogRetryCounts.get(t.id) || 0) < MAX_BACKLOG_RETRIES
    );
    if (failedBacklog.length === 0) return;

    const scoreTask = (t) => {
      const subtasks = Array.isArray(t.subtasks) ? t.subtasks : [];
      const total = subtasks.length;
      const done = subtasks.filter(s => s.status === 'done').length;
      const failed = subtasks.filter(s => s.status === 'failed').length;
      const partial = done > 0 ? 1 : 0;
      const ratio = total > 0 ? done / total : 0;
      const updated = Date.parse(t.updatedAt || t.completedAt || t.createdAt || 0) || 0;
      return { partial, ratio, done, failed, updated, total };
    };

    failedBacklog.sort((a, b) => {
      const sa = scoreTask(a);
      const sb = scoreTask(b);
      if (sb.partial !== sa.partial) return sb.partial - sa.partial;
      if (sb.ratio !== sa.ratio) return sb.ratio - sa.ratio;
      if (sb.done !== sa.done) return sb.done - sa.done;
      if (sb.failed !== sa.failed) return sb.failed - sa.failed;
      return sa.updated - sb.updated; // older first
    });

    const task = failedBacklog[0];
    const retryCount = Math.max(task.backlogRetryCount || 0, backlogRetryCounts.get(task.id) || 0) + 1;
    const escalateComplexity = retryCount >= 2;
    let failedSubtasksReset = 0;

    if (Array.isArray(task.subtasks)) {
      for (const st of task.subtasks) {
        if (st.status !== 'failed') continue;
        const updates = { status: 'queued', error: `Backlog auto-retry #${retryCount}` };
        if (escalateComplexity) updates.complexity = 'high';
        try {
          taskManager.updateSubtask(projectId, task.id, st.id, updates, 'strategist');
          failedSubtasksReset++;
        } catch (err) {
          log.debug('Backlog sweep subtask reset skipped', {
            projectId, taskId: task.id, subtaskId: st.id, error: err.message,
          });
        }
      }
    }

    try {
      taskManager.updateTaskStatus(
        projectId,
        task.id,
        'queued',
        'strategist',
        `Backlog auto-retry #${retryCount}${escalateComplexity ? ' (escalated)' : ''}`
      );
      backlogRetryCounts.set(task.id, retryCount);
      taskManager._saveWithRetry(projectId, (d) => {
        const t = d.tasks.find(x => x.id === task.id);
        if (t) t.backlogRetryCount = retryCount;
        return d;
      });
      lastBacklogSweepAt.set(projectId, now);
      addMessage(projectId, 'general', 'System',
        `Backlog auto-retry: queued failed task **${task.title}** (#${retryCount})${failedSubtasksReset ? ` and reset ${failedSubtasksReset} failed subtask(s)` : ''}${escalateComplexity ? ' with escalated complexity' : ''}.`,
        'system');
      log.info('Backlog failed-task auto-retry queued', {
        projectId,
        taskId: task.id,
        retryCount,
        failedSubtasksReset,
        inFlightCount,
      });
    } catch (err) {
      log.warn('Backlog failed-task auto-retry skipped', {
        projectId,
        taskId: task.id,
        error: err.message,
      });
    }
  }

  /** Query RAG for relevant project history. Non-fatal — returns empty string on failure. */
  async function queryRAG(projectId, queryText, topK = 5) {
    try {
      const store = getVectorStore?.(projectId);
      if (!store || !ragSearch || store.count() === 0) return '';
      const results = await ragSearch(queryText, store, { topK });
      if (!results.length) return '';
      return results.map(r =>
        `[${r.meta?.speaker || 'unknown'} ${r.meta?.timestamp || ''}] ${r.meta?.snippet || r.msgId || ''}`
      ).join('\n');
    } catch (err) {
      log.debug('RAG query failed (non-fatal)', { projectId, error: err.message });
      return '';
    }
  }

  /** Evaluate campaign progress and advance milestones. */
  async function strategistEvaluate(projectId, campaignId) {
    const campaign = campaignManager.getCampaign(projectId, campaignId);
    if (!campaign || campaign.status !== 'active') return;
    const channelId = 'general';
    const activeMilestones = campaign.milestones.filter(m => m.status === 'active');

    for (const activeMilestone of activeMilestones) {
      const progress = campaignManager.checkMilestoneProgress(
        projectId, campaignId, activeMilestone.id, taskManager
      );
      if (!progress) continue;
      const milestoneTasks = activeMilestone.tasks
        .map(taskId => taskManager.getTask(projectId, taskId))
        .filter(Boolean);
      const milestoneStatuses = milestoneTasks.map(t => t.status);
      const milestoneHasDeferred = milestoneStatuses.includes('deferred');
      const milestoneHasFailed = milestoneStatuses.includes('failed');
      const milestoneHasRunnable = milestoneStatuses.some(s =>
        s === 'queued' || s === 'planning' || s === 'executing' || s === 'reviewing' || s === 'sleeping'
      );
      const milestoneFailedDeferredIdle = milestoneHasFailed && milestoneHasDeferred && !milestoneHasRunnable;

      // Active milestone with zero tasks — needs decomposition
      if (progress.total === 0) {
        log.info('Active milestone has no tasks — triggering decomposition', {
          projectId, campaignId, milestoneId: activeMilestone.id, title: activeMilestone.title,
        });
        await strategistDecompose(projectId, campaignId, activeMilestone.id);
        continue;
      }

      if (campaignManager.isMilestoneComplete(projectId, campaignId, activeMilestone.id, taskManager)) {
        campaignManager.updateMilestoneStatus(projectId, campaignId, activeMilestone.id, 'completed',
          `All ${progress.total} tasks completed`);
        addMessage(projectId, channelId, 'System',
          `Campaign milestone completed: **${activeMilestone.title}** (${progress.done}/${progress.total} tasks done)`, 'system');
        // Vault: record milestone completion
        if (vaultWriter) {
          try {
            vaultWriter.onMilestoneComplete({
              projectId, campaignId, milestoneId: activeMilestone.id, milestoneTitle: activeMilestone.title,
              projectIds: campaign.projectIds,
            });
          } catch (vErr) { log.warn('Vault milestone write failed', { error: vErr.message }); }
        }
                  broadcastToChannel(projectId, channelId, {
                    type: 'campaign_milestone_completed', campaignId, milestoneId: activeMilestone.id,
                  });
        
                  // Reload campaign to get updated milestone statuses
                  const currentCampaign = campaignManager.getCampaign(projectId, campaignId);
                  const nextMs = campaignManager.getNextUnblockedMilestone(projectId, campaignId);
                  if (nextMs) {
                    if (!isCampaignWithinTimeWindow(currentCampaign)) {
                      const skipReason = getTimeWindowSkipReason(currentCampaign);
                      log.info('Campaign outside time window after milestone completion — deferring next milestone', {
                        projectId, campaignId, nextMilestoneId: nextMs.id, skipReason,
                      });
                      addMessage(projectId, channelId, 'System',
                        `Campaign "${currentCampaign.title}" is outside its configured time window. Deferring next milestone "**${nextMs.title}**". Reason: ${skipReason}`, 'system');
                      campaignManager.updateCampaignReview(projectId, campaignId, {
                        lastReviewSummary: `Milestone "${activeMilestone.title}" completed but outside time window`,
                        nextAction: `Waiting for time window to open`,
                      });
                      continue;
                    }
                    campaignManager.updateMilestoneStatus(projectId, campaignId, nextMs.id, 'active',
                      'Unblocked — previous milestone completed');
                    addMessage(projectId, channelId, 'System',
                      `Campaign advancing: activating milestone **${nextMs.title}**`, 'system');
                    await strategistDecompose(projectId, campaignId, nextMs.id);
                  } else {
                    const allDone = currentCampaign.milestones.every(m =>
                      m.status === 'completed' || m.status === 'skipped'
                    );
                    if (allDone) await handleCampaignAllDone(projectId, campaignId, channelId);
        }
        campaignManager.updateCampaignReview(projectId, campaignId, {
          lastReviewSummary: `Milestone "${activeMilestone.title}" completed. ${nextMs ? `Activated: "${nextMs.title}"` : 'All milestones done.'}`,
          nextAction: nextMs ? `Executing milestone: ${nextMs.title}` : null,
        });

      } else if (
        campaignManager.isMilestoneFailed(projectId, campaignId, activeMilestone.id, taskManager) ||
        milestoneFailedDeferredIdle
      ) {
        const retryConfig = config.campaigns.autoRetryFailedTasks;
        const maxRetries = config.campaigns.maxAutoRetries;
        const retryCount = milestoneRetryCounts.get(activeMilestone.id) || 0;
        if (retryConfig && retryCount < maxRetries) {
          // Keep failed-task retries at the back of the line for runnable work.
          // If the only remaining work is deferred far in the future (cooldowns),
          // allow failed-task retries to avoid the system sitting idle.
          const failedTaskIds = new Set(
            activeMilestone.tasks.filter(taskId => taskManager.getTask(projectId, taskId)?.status === 'failed')
          );
          const allTasks = taskManager.listTasks(projectId);
          const runnableStatuses = new Set(['queued', 'planning', 'executing', 'reviewing', 'sleeping']);
          const otherRunnableWork = allTasks.filter(t =>
            !failedTaskIds.has(t.id) && runnableStatuses.has(t.status)
          );
          if (otherRunnableWork.length > 0) {
            log.info('Milestone failed but deferring auto-retry until other work completes', {
              projectId,
              campaignId,
              milestoneId: activeMilestone.id,
              retryCount,
              blockingCount: otherRunnableWork.length,
              blockingSample: otherRunnableWork.slice(0, 5).map(t => ({ id: t.id, status: t.status })),
            });
            continue;
          }
          const now = Date.now();
          const deferredTasks = allTasks.filter(t => !failedTaskIds.has(t.id) && t.status === 'deferred');
          const deferredDueSoon = deferredTasks.filter(t => {
            const ts = Date.parse(t.nextAttemptAt || '');
            return Number.isFinite(ts) && ts <= (now + 30000); // heartbeat-scale grace window
          });
          if (deferredDueSoon.length > 0) {
            log.info('Milestone failed but waiting for deferred task(s) due soon before auto-retry', {
              projectId,
              campaignId,
              milestoneId: activeMilestone.id,
              retryCount,
              deferredDueSoon: deferredDueSoon.slice(0, 5).map(t => ({ id: t.id, nextAttemptAt: t.nextAttemptAt })),
            });
            continue;
          }
          if (deferredTasks.length > 0) {
            log.info('Milestone failed and only deferred future work remains — proceeding with failed-task auto-retry to avoid idle', {
              projectId,
              campaignId,
              milestoneId: activeMilestone.id,
              retryCount,
              deferredCount: deferredTasks.length,
              earliestDeferredAt: deferredTasks
                .map(t => Date.parse(t.nextAttemptAt || ''))
                .filter(Number.isFinite)
                .sort((a, b) => a - b)[0]
                ? new Date(
                    deferredTasks
                      .map(t => Date.parse(t.nextAttemptAt || ''))
                      .filter(Number.isFinite)
                      .sort((a, b) => a - b)[0]
                  ).toISOString()
                : null,
            });
          }
          // Don't burn retries when no cloud agents can do work
          if (!isAnyAgentAvailable()) {
            log.info('Milestone has failures but no agents available — deferring retry', {
              projectId, campaignId, milestoneId: activeMilestone.id, retryCount,
            });
            continue;
          }
          const escalateComplexity = retryCount >= 1; // Only escalate after first retry fails
          for (const taskId of activeMilestone.tasks) {
            const task = taskManager.getTask(projectId, taskId);
            if (task && task.status === 'failed') {
              if (task.subtasks) {
                for (const st of task.subtasks) {
                  if (st.status === 'failed') {
                    const updates = { status: 'queued', error: `Campaign auto-retry #${retryCount + 1}` };
                    if (escalateComplexity) updates.complexity = 'high';
                    taskManager.updateSubtask(projectId, taskId, st.id, updates, 'strategist');
                  }
                }
              }
              taskManager.updateTaskStatus(projectId, taskId, 'queued', 'strategist',
                `Auto-retry #${retryCount + 1} from campaign strategist${escalateComplexity ? ' (escalated)' : ''}`);
            }
          }
          milestoneRetryCounts.set(activeMilestone.id, retryCount + 1);
          addMessage(projectId, channelId, 'System',
            `Campaign milestone "${activeMilestone.title}" has ${progress.failed} failed task(s). Auto-retrying (#${retryCount + 1}/${maxRetries})${escalateComplexity ? ' with escalated complexity' : ''}...`, 'system');
        } else {
          const contingencyMsg = activeMilestone.contingency
            ? `\nContingency plan: ${activeMilestone.contingency}`
            : '\nNo contingency plan defined.';
          addMessage(projectId, channelId, 'System',
            `Campaign milestone **${activeMilestone.title}** failed (${progress.failed}/${progress.total} tasks failed).${contingencyMsg}\n\nUse \`/campaign inject ${campaignId} <your idea>\` to adapt, or \`/task retry <task_id>\` to retry specific tasks.`, 'system');
          campaignManager.updateCampaignReview(projectId, campaignId, {
            lastReviewSummary: `Milestone "${activeMilestone.title}" has failures: ${progress.failed}/${progress.total} tasks failed.`,
            nextAction: `User intervention needed. ${activeMilestone.contingency || 'Define contingency plan.'}`,
          });
        }
      }
    }
    if (activeMilestones.length === 0) {
      // No milestones at all — campaign needs initial decomposition
      if (campaign.milestones.length === 0) {
        log.info('Active campaign has no milestones — triggering decomposition', { projectId, campaignId });
        await strategistDecomposeCampaign(projectId, campaignId);
        return;
      }
      // No active milestone — try to activate next unblocked one
      const nextMs = campaignManager.getNextUnblockedMilestone(projectId, campaignId);
      if (nextMs) {
        if (!isCampaignWithinTimeWindow(campaign)) {
          const skipReason = getTimeWindowSkipReason(campaign);
          log.info('Campaign outside time window — deferring milestone activation', {
            projectId, campaignId, milestoneId: nextMs.id, skipReason,
          });
          addMessage(projectId, channelId, 'System',
            `Campaign "${campaign.title}" is outside its configured time window. Deferring milestone "**${nextMs.title}**". Reason: ${skipReason}`, 'system');
          campaignManager.updateCampaignReview(projectId, campaignId, {
            lastReviewSummary: `Outside time window — deferring activation`,
            nextAction: `Waiting for time window to open`,
          });
          return;
        }
        campaignManager.updateMilestoneStatus(projectId, campaignId, nextMs.id, 'active',
          'Activated by strategist — no active milestone');
        addMessage(projectId, channelId, 'System',
          `Campaign "${campaign.title}": activating milestone **${nextMs.title}**`, 'system');
        await strategistDecompose(projectId, campaignId, nextMs.id);
        campaignManager.updateCampaignReview(projectId, campaignId, {
          lastReviewSummary: `Activated milestone: "${nextMs.title}"`,
          nextAction: `Executing milestone: ${nextMs.title}`,
        });
      } else {
        // All milestones done but campaign still active — trigger closeout
        const allDone = campaign.milestones.every(m =>
          m.status === 'completed' || m.status === 'skipped'
        );
        if (allDone) {
          log.info('All milestones completed (no active milestone) — triggering closeout', { projectId, campaignId });
          await handleCampaignAllDone(projectId, campaignId, channelId);
        }
      }
    }
  }

  /**
   * Handle campaign completion — fork between standard (closeout) and evergreen (cycle).
   * Extracted from two duplicated allDone blocks in strategistEvaluate.
   */
  async function handleCampaignAllDone(projectId, campaignId, channelId) {
    const campaign = campaignManager.getCampaign(projectId, campaignId);
    if (!campaign) return;

    const campaignType = campaign.type || 'standard';

    if (campaignType === 'evergreen') {
      // Evergreen: lightweight cycle closeout, then park in 'cycling' status
      let summaryText = `Cycle ${(campaign.cycleCount || 0) + 1}: ${campaign.milestones.length} milestones`;
      try {
        const closeoutSummary = campaignManager.generateCloseoutSummary(projectId, campaignId, taskManager, learningsManager);
        if (closeoutSummary) {
          const completed = closeoutSummary.milestoneOutcomes?.filter(m => m.status === 'completed').length || 0;
          const total = closeoutSummary.milestoneOutcomes?.length || 0;
          summaryText = `Cycle ${(campaign.cycleCount || 0) + 1}: ${completed}/${total} milestones completed, ${closeoutSummary.taskStats?.totalTasks || 0} tasks`;
        }
      } catch (err) {
        log.warn('Failed to generate cycle closeout summary', { projectId, campaignId, error: err.message });
      }

      campaignManager.cycleCampaign(projectId, campaignId, summaryText);
      performanceStore?.markCampaignCompleted(campaignId);
      broadcastToChannel(projectId, channelId, { type: 'campaign_cycling', campaignId, cycleCount: (campaign.cycleCount || 0) + 1 });
      addMessage(projectId, channelId, 'System',
        `Evergreen campaign **${campaign.title}** completed cycle ${(campaign.cycleCount || 0) + 1}. Awaiting operator approval for next cycle.\nUse \`POST /api/projects/${projectId}/campaigns/${campaignId}/approve-cycle\` to continue.`, 'system');
      return;
    }

    // Verbatim one-shot: complete, tell the operator where the result lives,
    // and STOP. No LLM closeout, no follow-on generation — the run must end
    // exactly where an outside one-shot ends (A/B parity).
    if (campaignType === 'verbatim') {
      campaignManager.updateCampaignStatus(projectId, campaignId, 'completed', 'Verbatim one-shot build completed');
      performanceStore?.markCampaignCompleted(campaignId);
      broadcastToChannel(projectId, channelId, { type: 'campaign_completed', campaignId });
      const projDir = stateManager.getProject(projectId)?.projectDir;
      // Merge the campaign branch back to main BEFORE announcing where the
      // result lives. The normal merge happens in closeout, which verbatim
      // skips — found live: 'the deliverables should be there' while
      // index.html sat on an unmerged synapse/campaign-* branch and the
      // workspace looked empty.
      if (projDir) {
        try {
          const { mergeCampaignBranch } = await import('./git-branches.js');
          const repoCfg = stateManager?.getProjectRepoConfig?.(projectId);
          // The campaign renderer regenerates CAMPAIGNS.md/TASKS.md as
          // UNTRACKED files on main while the branch tracks them — git's
          // ort strategy refuses to overwrite untracked files, failing the
          // merge every time (reproduced on the first live merge). They are
          // renderer-owned and regenerated on every change: safe to drop.
          try {
            const { execFileSync } = await import('child_process');
            for (const f of ['CAMPAIGNS.md', 'TASKS.md']) {
              const tracked = execFileSync('git', ['ls-files', '--', f], { cwd: projDir }).toString().trim();
              if (!tracked) execFileSync('rm', ['-f', f], { cwd: projDir });
            }
          } catch { /* best-effort pre-clean */ }
          const merged = mergeCampaignBranch(projDir, campaignId, campaign.title, repoCfg);
          if (!merged?.success && !merged?.skipped) {
            log.warn('Verbatim campaign branch merge failed — result stays on branch', { projectId, campaignId, error: merged?.error });
            addMessage(projectId, channelId, 'System',
              `Note: the build finished but its branch could not be merged automatically (${merged?.error || 'unknown'}). The result is on the campaign branch.`, 'system');
          }
        } catch (err) {
          log.warn('Verbatim campaign branch merge threw', { projectId, campaignId, error: err.message });
        }
      }
      addMessage(projectId, channelId, 'System',
        `One-shot build complete: **${campaign.title}**. ` +
        `Review the result in ${projDir || 'the project workspace'} — the deliverables the vision describes should be there. ` +
        `No closeout or follow-on campaigns will be generated (A/B parity mode).`, 'system');
      log.info('Verbatim one-shot campaign completed', { projectId, campaignId });
      return;
    }

    // Standard path: existing completion + closeout + promoteAndDecompose chain
    campaignManager.updateCampaignStatus(projectId, campaignId, 'completed', 'All milestones completed');
    performanceStore?.markCampaignCompleted(campaignId);
    broadcastToChannel(projectId, channelId, { type: 'campaign_completed', campaignId });
    try {
      const closeoutSummary = campaignManager.generateCloseoutSummary(projectId, campaignId, taskManager, learningsManager);
      if (closeoutSummary) {
        campaignManager.updateCampaignCloseout(projectId, campaignId, closeoutSummary);
        log.info('Structured closeout summary generated', { projectId, campaignId });
        if (performanceStore) {
          const freshCampaign = campaignManager.getCampaign(projectId, campaignId);
          if (freshCampaign) {
            ingestCampaignPerformance(performanceStore, freshCampaign);
            performanceStore.flush();
          }
        }
      }
    } catch (err) {
      log.warn('Failed to generate structured closeout summary', { projectId, campaignId, error: err.message });
    }
    // Vault: archive campaign note with outcomes
    if (vaultWriter) {
      try {
        const campaign = campaignManager.getCampaign(projectId, campaignId);
        const outcomes = campaign?.closeout?.summary || 'Campaign completed — all milestones done.';
        vaultWriter.onCampaignComplete({ projectId, campaignId, outcomes });
      } catch (vErr) { log.warn('Vault campaign archive failed', { error: vErr.message }); }
    }
    // First-build checkpoint: wizard-created starter projects hold after
    // their FIRST campaign completes — flip to static, tell the user where
    // the result lives, and wait for them to opt back into continuous
    // improvement. Build first, then ask.
    let projectMode = stateManager.getProject(projectId)?.mode || 'static';
    const projCfg = stateManager.getProject(projectId);
    if (projCfg?.firstBuildHold && projectMode === 'continuous') {
      try {
        stateManager.setProjectFirstBuildHold(projectId, false);
        stateManager.setProjectMode(projectId, 'static');
        projectMode = 'static';
        const campaign = campaignManager.getCampaign(projectId, campaignId);
        addMessage(projectId, channelId, 'System',
          `First build complete: "${campaign?.title || campaignId}". ` +
          `Review the result in ${projCfg.projectDir || 'the project workspace'} — the deliverables the vision describes should be there. ` +
          `Continuous improvement is paused for this project; set the project mode back to "continuous" when you want the agents to keep iterating.`, 'system');
        log.info('First-build hold: campaign complete, project flipped to static pending operator review', { projectId, campaignId });
      } catch (err) {
        log.warn('First-build hold handling failed', { projectId, error: err.message });
      }
    }
    strategistCloseout(projectId, campaignId)
      .then(() => {
        if (projectMode === 'continuous') {
          return promoteAndDecompose(projectId, channelId);
        } else {
          log.info('Campaign completed — static mode, skipping auto-generation', { projectId, campaignId, mode: projectMode });
        }
      })
      .catch(err => {
        log.error('Closeout failed', { projectId, campaignId, error: err.message });
        if (projectMode === 'continuous') {
          promoteAndDecompose(projectId, channelId).catch(e => log.error('promoteAndDecompose failed after closeout error', { projectId, channelId, error: e.message }));
        }
      });
  }

  /** Architect decomposes a milestone into concrete tasks. */
  async function strategistDecompose(projectId, campaignId, milestoneId) {
    if (decomposingMilestones.has(milestoneId)) {
      log.debug('Milestone decomposition already in progress, skipping', { milestoneId });
      return;
    }
    const campaign = campaignManager.getCampaign(projectId, campaignId);
    if (!campaign) return;
    const milestone = campaign.milestones.find(m => m.id === milestoneId);
    if (!milestone) return;
    decomposingMilestones.add(milestoneId);
    try {

    const channelId = 'general';
    const completedMs = campaign.milestones.filter(m => m.status === 'completed');
    const vision = stateManager.getProjectVision(projectId);
    const ragContext = await queryRAG(projectId, `${milestone.title} ${milestone.description || ''}`);
    addMessage(projectId, channelId, 'System',
      `Decomposing milestone **${milestone.title}** into tasks...`, 'system');

    const learningsCtx = learningsManager ? learningsManager.buildDecompositionContext(projectId) : '';

    const msOutputMode = campaign.outputMode || 'implementation';
    const researchInstructions = msOutputMode === 'research'
      ? [
          '',
          'RESEARCH MODE: All subtasks must have suggestedRole: "researcher".',
          'Each task is a specific research question. Output format:',
          '  ## Question',
          '  ### Evidence (cite specific sources)',
          '  ### Confidence (low/medium/high with justification)',
          'A finding without cited sources is NOT complete.',
        ]
      : [];

    const bigPictureCheck = [
      '',
      'SCOPE CHECK: Before generating tasks, re-read the FULL campaign goal above.',
      'Ensure your tasks address THIS milestone\'s scope in context of the broader campaign —',
      'do not tunnel-vision on one sub-area when the campaign spans multiple.',
      'RIGHT-SIZING: match task ceremony to the vision\'s scale — small/playful projects get',
      'build-first tasks that produce the working software the vision describes; add',
      'specification/contract tasks only when the vision itself demands them.',
    ];

    const prompt = [
      'You are the project architect. A milestone in an active campaign needs to be',
      'decomposed into concrete tasks.',
      '',
      vision ? `=== PROJECT VISION ===\n${vision}\n` : '',
      ragContext ? `=== RELEVANT PROJECT HISTORY ===\n${ragContext}\n` : '',
      learningsCtx || '',
      '=== CAMPAIGN ===',
      `Title: ${campaign.title}`,
      `Goal: ${campaign.doneCriteria || campaign.description}`,
      campaign.contingency ? `Campaign contingency: ${campaign.contingency}` : '',
      `Progress: ${completedMs.length}/${campaign.milestones.length} milestones done`,
      '',
      completedMs.length > 0 ? 'Completed milestones:' : '',
      ...completedMs.map(m => `- ${m.title}: ${m.doneCriteria || 'done'} [DONE]`),
      '',
      '=== CURRENT MILESTONE ===',
      `Title: ${milestone.title}`,
      `Description: ${milestone.description}`,
      milestone.doneCriteria ? `Done criteria: ${milestone.doneCriteria}` : '',
      milestone.contingency ? `If this fails: ${milestone.contingency}` : '',
      '',
      'Decompose this milestone into 2-6 concrete tasks. Each task should be',
      'completable by the task system (an agent decomposes it into subtasks and',
      'executes them). Include clear success criteria for each task.',
      ...researchInstructions,
      ...bigPictureCheck,
      '',
      'Return a JSON array:',
      '[{ "title": "...", "description": "...", "doneCriteria": "...", "requireApproval": false }]',
      '',
      'Note: Set requireApproval: true for tasks involving production changes, data migrations, or security-critical operations.',
      'JSON array only, no other text.',
    ].filter(Boolean).join('\n');

    const sendResult = await sendWithArchitectFallback({
      projectId,
      channelId,
      phaseLabel: 'milestone decomposition',
      prompt,
      noArchitectMessage: `Cannot decompose milestone — no architect agent available.`,
      responseValidator: (response) => {
        const parsed = parseStructuredJson(response, 'array');
        if (!parsed.ok) return { ok: false, reason: parsed.reason || 'invalid_json', parsed };
        if (!Array.isArray(parsed.value) || parsed.value.length === 0) return { ok: false, reason: 'empty_array', parsed };
        return { ok: true, parsed };
      },
      onValidationExhausted: ({ response, validation }) => {
        const parsed = validation?.parsed;
        if (parsed && !parsed.ok && parsed.reason === 'not_found') {
          addMessage(projectId, channelId, 'System',
            `Milestone decomposition failed — no structured output.\nResponse: ${String(response).substring(0, 300)}`, 'system');
          return;
        }
        if (validation?.reason === 'empty_array') {
          addMessage(projectId, channelId, 'System', `Milestone decomposition failed — empty task list.`, 'system');
          return;
        }
        addMessage(projectId, channelId, 'System', `Milestone decomposition failed — invalid JSON.`, 'system');
      },
    });
    if (!sendResult) return;
    const { response } = sendResult;

    try {
      let taskDefs = sendResult.validated.parsed.value;
      const maxTasks = config.campaigns.maxTasksPerMilestone;
      if (taskDefs.length > maxTasks) taskDefs.length = maxTasks;

      const createdTasks = [];
       for (const def of taskDefs) {
         const title = typeof def === 'string' ? def : def.title;
         const description = typeof def === 'string' ? def : (def.description || def.title);
         const doneCriteria = typeof def === 'string' ? null : (def.doneCriteria || null);
         const requireApproval = typeof def === 'object' && def.requireApproval === true;
         const task = taskManager.createTask(projectId, channelId, {
           title, description, doneCriteria, campaignId, milestoneId, requireApproval,
         });
         campaignManager.linkTaskToMilestone(projectId, campaignId, milestoneId, task.id);
         createdTasks.push(task);
       }
      const taskList = createdTasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
      addMessage(projectId, channelId, 'System',
        `Milestone **${milestone.title}** decomposed into ${createdTasks.length} tasks:\n${taskList}\n\nTasks entering heartbeat pipeline.`, 'system');
      broadcastToChannel(projectId, channelId, {
        type: 'campaign_milestone_decomposed', campaignId, milestoneId, taskCount: createdTasks.length,
      });
    } catch (err) {
      addMessage(projectId, channelId, 'System', `Milestone decomposition error: ${err.message}`, 'system');
    }

    } finally {
      decomposingMilestones.delete(milestoneId);
    }
  }

  /**
   * Verbatim one-shot campaign (A/B parity mode). No LLM is involved in
   * setup: the campaign, its single milestone, and its single task/subtask
   * are created programmatically, and the subtask TEXT IS THE VISION,
   * character-for-character. The dispatch path sends that text to the agent
   * with no wrapping, no turn cap, and an effectively-uncapped timeout —
   * the same method as an outside `claude -p < vision.txt` run. Planning,
   * decomposition, review, and closeout are all skipped: the one-shot IS
   * the campaign.
   */
  async function createVerbatimCampaign(proj, channelId) {
    const projectId = proj.id;
    const vision = stateManager.getProjectVision(projectId);
    if (!vision || !vision.trim()) {
      log.warn('One-shot project has no vision — nothing to dispatch', { projectId });
      return;
    }
    try {
      const campaign = campaignManager.createCampaign(projectId, {
        title: `${proj.name || projectId} — one-shot build`,
        description: 'Verbatim one-shot (A/B parity mode): the project vision is dispatched to a single agent exactly as written. No decomposition, no review, no closeout.',
        doneCriteria: 'The verbatim build subtask completes.',
        contingency: 'If the build fails, the campaign fails. Do not decompose or retry with a different prompt — a one-shot is only meaningful unmodified.',
        type: 'verbatim',
      });
      if (campaign.status === 'queued') {
        campaignManager.updateCampaignStatus(projectId, campaign.id, 'active', 'Verbatim one-shot activates immediately');
      }
      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'One-shot build',
        description: 'Single verbatim dispatch of the full project vision.',
        doneCriteria: 'The build subtask completes.',
        order: 1,
      });
      campaignManager.updateMilestoneStatus(projectId, campaign.id, milestone.id, 'active', 'Only milestone');
      const task = taskManager.createTask(projectId, channelId, {
        title: `${proj.name || projectId}: verbatim build`,
        description: 'One-shot dispatch of the project vision, verbatim. The subtask text is the exact prompt the agent receives.',
        doneCriteria: 'Agent reports the build complete.',
        campaignId: campaign.id,
        milestoneId: milestone.id,
      });
      campaignManager.linkTaskToMilestone(projectId, campaign.id, milestone.id, task.id);
      taskManager.addSubtasks(projectId, task.id, [{
        text: vision,
        role: 'developer',
        complexity: 'high',
        meta: { verbatim: true },
      }], 'system');
      // Straight to executing: the subtask is pre-planned by definition.
      taskManager.updateTaskStatus(projectId, task.id, 'executing', 'system', 'Verbatim one-shot: single pre-planned subtask');
      addMessage(projectId, channelId, 'System',
        `One-shot campaign created: **${campaign.title}**. The vision will be dispatched verbatim to one agent — no decomposition, no review. Wall-clock is recorded as a result.`, 'system');
      broadcastToChannel(projectId, channelId, { type: 'campaign_created', campaignId: campaign.id });
      log.info('Verbatim one-shot campaign created', { projectId, campaignId: campaign.id, taskId: task.id, visionChars: vision.length });
    } catch (err) {
      log.error('Failed to create verbatim one-shot campaign', { projectId, error: err.message });
    }
  }

  /** Periodic tick — catches edge cases the event-driven triggers miss. */
  async function strategistTick() {
    if (strategistRunning) return;
    strategistRunning = true;
    try {
      const projects = stateManager.listProjects();
      for (const proj of projects) {
        const maxActive = config.campaigns.maxActiveCampaigns;
        const campaigns = campaignManager.listCampaigns(proj.id, 'active');
        const channelId = proj.defaultChannel || 'general';

        // Promote queued campaigns up to the per-project cap.
        // Do NOT auto-generate a second campaign from vision — only promote already-queued ones.
        // The second slot absorbs agent capacity during Campaign 1 time-gates (48h/72h shadow runs etc.)
        if (campaigns.length < maxActive) {
          const queued = campaignManager.listCampaigns(proj.id, 'queued');
          if (queued.length > 0) {
            log.info('Project below active campaign cap — promoting queued campaign', {
              projectId: proj.id, active: campaigns.length, maxActive, queuedCount: queued.length,
            });
            await promoteAndDecompose(proj.id, channelId);
          } else if (campaigns.length === 0 && proj.mode === 'continuous') {
            // A PAUSED campaign blocks generation: the operator parked this
            // project's work deliberately. Without this check, pausing a
            // campaign in a continuous project made the strategist see an
            // empty queue and spawn a fresh replacement campaign — the pause
            // lever was generating MORE work (found live, 2026-08-01).
            const paused = campaignManager.listCampaigns(proj.id, 'paused');
            if (paused.length > 0) {
              log.info('No active campaigns but a paused campaign exists — honoring operator pause, not generating', { projectId: proj.id, paused: paused.length });
            } else {
              log.info('No active or queued campaigns — generating from vision (continuous mode)', { projectId: proj.id });
              await promoteAndDecompose(proj.id, channelId);
            }
          } else if (campaigns.length === 0 && proj.mode === 'oneshot') {
            // Verbatim one-shot (A/B parity mode): runs exactly ONCE. Any
            // existing campaign — completed, paused, failed — means the shot
            // was fired; never regenerate.
            const anyCampaign = campaignManager.listCampaigns(proj.id);
            if (anyCampaign.length === 0) {
              log.info('One-shot project with no campaign — creating verbatim campaign', { projectId: proj.id });
              await createVerbatimCampaign(proj, channelId);
            }
          } else if (campaigns.length === 0) {
            log.info('No active or queued campaigns — static mode, waiting for manual campaign creation', { projectId: proj.id, mode: proj.mode });
          }
          // If 1 active + 0 queued: don't auto-generate a second — let Campaign 1 finish first.
        }

        // Evaluate all active campaigns (milestone completion, time-gate checks, task decomposition)
        for (const campaign of campaignManager.listCampaigns(proj.id, 'active')) {
          await strategistEvaluate(proj.id, campaign.id);
        }

        // Resume approved cycling (evergreen) campaigns
        const allCampaigns = campaignManager.listCampaigns(proj.id);
        const cyclingCampaigns = allCampaigns.filter(c => c.status === 'cycling');
        for (const campaign of cyclingCampaigns) {
          if (!campaign.cycleApproved) continue;

          // Busywork detection: if 2+ consecutive cycles produced zero learnings, auto-pause
          const cycleHistory = campaign.cycleHistory || [];
          if (cycleHistory.length >= 2) {
            const lastTwoCycles = cycleHistory.slice(-2);
            const hasLearnings = lastTwoCycles.some(cycle => {
              const since = new Date(cycle.completedAt);
              since.setTime(since.getTime() - 7 * 24 * 60 * 60 * 1000); // look back 1 week from cycle end
              const entries = learningsManager?.query(proj.id, { campaignId: campaign.id }) || [];
              const recentEntries = entries.filter(e => new Date(e.timestamp) >= since);
              return recentEntries.length > 0;
            });
            if (!hasLearnings) {
              log.warn('Evergreen campaign staleness detected — auto-pausing', {
                projectId: proj.id, campaignId: campaign.id, cycleCount: campaign.cycleCount,
              });
              campaignManager.updateCampaignStatus(proj.id, campaign.id, 'paused',
                'Auto-paused: 2 consecutive cycles with zero learnings (busywork prevention)');
              addMessage(proj.id, channelId, 'System',
                `Evergreen campaign **${campaign.title}** auto-paused after ${campaign.cycleCount} cycles: no learnings in last 2 cycles. Resume manually if needed.`, 'system');
              continue;
            }
          }

          // Check active slot availability (cycling does NOT count as active)
          const activeCampaigns = campaignManager.listCampaigns(proj.id, 'active');
          if (activeCampaigns.length >= maxActive) {
            log.debug('Cycling campaign approved but active cap reached — deferring', {
              projectId: proj.id, campaignId: campaign.id, active: activeCampaigns.length, maxActive,
            });
            continue;
          }

          log.info('Resuming approved evergreen campaign', {
            projectId: proj.id, campaignId: campaign.id, cycleCount: campaign.cycleCount,
          });
          campaignManager.updateCampaignStatus(proj.id, campaign.id, 'active',
            `Cycle ${campaign.cycleCount + 1} approved by operator`);
          addMessage(proj.id, channelId, 'System',
            `Evergreen campaign **${campaign.title}** starting cycle ${(campaign.cycleCount || 0) + 1}...`, 'system');
          await strategistDecomposeCampaign(proj.id, campaign.id);
        }

        maybeSweepFailedBacklog(proj.id);
      }

      // Retry count decay: when agents recover, give exhausted milestones another chance
      if (milestoneRetryCounts.size > 0 && isAnyAgentAvailable()) {
        const maxRetries = config.campaigns.maxAutoRetries;
        for (const [msId, count] of milestoneRetryCounts) {
          if (count >= maxRetries) {
            milestoneRetryCounts.set(msId, Math.max(0, count - 1));
            log.info('Retry count decayed (agents recovered)', { milestoneId: msId, newCount: count - 1 });
          }
        }
      }
    } catch (err) {
      log.error('Periodic tick error', { error: err.message });
    } finally {
      strategistRunning = false;
    }
  }

  /** Generate an initial project vision when none exists. */
  async function generateProjectVision(projectId) {
    const channelId = 'general';
    const project = stateManager.getProject(projectId);
    const prompt = [
      'You are the project architect. This project has no vision statement yet.',
      'A vision guides all campaigns, task decomposition, and strategic reviews.',
      '',
      `Project: ${project?.displayName || projectId}`,
      `Working directory: ${project?.projectDir || 'unknown'}`,
      '',
      'Examine the project — read the codebase, docs, README, config — and write',
      'a vision statement (2-5 sentences) that captures:',
      '- What this project actually IS today',
      '- What it\'s becoming / where it\'s heading',
      '- The core principle or philosophy driving it',
      '',
      'Be grounded in reality, not aspirational fluff. Reference actual capabilities.',
      '',
      'Return the vision inside a code block exactly like this:',
      '',
      '```vision',
      '<your vision statement>',
      '```',
    ].join('\n');

    const sendResult = await sendWithArchitectFallback({
      projectId,
      channelId,
      phaseLabel: 'vision generation',
      prompt,
      noArchitectMessage: `Cannot generate vision — no architect agent available.`,
    });
    if (!sendResult) {
      log.warn('Cannot generate vision — no architect available or fallback chain exhausted', { projectId });
      return null;
    }
    const { architect, response: _resp } = sendResult;
    // Architect fallback (e.g. rate-limit path) can yield a non-string
    // response; coerce so downstream .match() degrades gracefully instead
    // of crashing campaign/vision generation.
    const response = responseText(_resp);
    addMessage(projectId, channelId, 'System',
      `No project vision set. ${architect.name} is generating one from the codebase...`, 'system');

    try {
      const visionMatch = response.match(/```vision\s*\n([\s\S]*?)```/);
      if (visionMatch) {
        const vision = visionMatch[1].trim();
        stateManager.setProjectVision(projectId, vision, { source: 'generated' });
        addMessage(projectId, channelId, 'System',
          `**Project vision established** (generated by ${architect.name}):\n\n> ${vision}`, 'system');
        broadcastToChannel(projectId, channelId, {
          type: 'vision_updated', projectId, vision, source: 'generated',
        });
        log.info('Project vision generated', { projectId, architect: architect.name });
        return vision;
      }
      log.warn('Vision generation returned no structured output', { projectId });
      return null;
    } catch (err) {
      log.warn('Vision generation failed', { projectId, error: err.message });
      addMessage(projectId, channelId, 'System',
        `Vision generation failed: ${err.message}. Set one manually with \`/project vision <text>\`.`, 'system');
      return null;
    }
  }

  /** Decompose a new campaign into milestones via the architect agent. */
  async function strategistDecomposeCampaign(projectId, campaignId) {
    if (decomposingCampaigns.has(campaignId)) {
      log.debug('Campaign decomposition already in progress, skipping', { campaignId });
      return;
    }
    const campaign = campaignManager.getCampaign(projectId, campaignId);
    if (!campaign) return;
    decomposingCampaigns.add(campaignId);
    const channelId = 'general';

    // Ensure project has a vision — generate one if missing
    let vision = stateManager.getProjectVision(projectId);
    if (!vision) {
      vision = await generateProjectVision(projectId);
    }

    const ragContext = await queryRAG(projectId, `${campaign.title} ${campaign.description || ''}`);
    const learningsCtx = learningsManager ? learningsManager.buildDecompositionContext(projectId) : '';

    // Cycle context for evergreen campaigns
    const campaignType = campaign.type || 'standard';
    const outputMode = campaign.outputMode || 'implementation';
    const cycleCtx = campaignType === 'evergreen' && campaign.cycleHistory?.length > 0
      ? '=== PREVIOUS CYCLES ===\n' + campaign.cycleHistory.map(c =>
          `Cycle ${c.cycle} (${c.completedAt}): ${c.summary}`
        ).join('\n') + '\n'
      : '';

    // Branch opening instructions based on outputMode
    const openingInstructions = outputMode === 'research'
      ? [
          'You are the project architect. Decompose this research campaign into investigation milestones.',
          'Output is analysis and findings, NOT code. Each milestone investigates a specific angle.',
          'Subtask roles should be "researcher". Each subtask is a specific research question.',
          'Findings must include cited evidence and confidence levels.',
        ]
      : [
          'You are the project architect. Decompose this campaign goal into milestones.',
          'Each milestone is a major deliverable that contains multiple tasks.',
          'Include clear success criteria and contingency plans for each milestone.',
        ];

    // Evergreen-specific guidelines
    const evergreenGuidelines = campaignType === 'evergreen'
      ? [
          '',
          'EVERGREEN CAMPAIGN GUIDELINES:',
          '- Focus on what is NEW this cycle — do not repeat milestones from previous cycles',
          '- If previous cycles found nothing novel, reduce milestone count (minimum 1)',
          '- Build on findings from previous cycles rather than starting fresh',
          '- Each cycle should deepen understanding or explore new angles',
        ]
      : [];

    // Big-picture alignment instruction
    const bigPictureInstruction = [
      '',
      'CRITICAL — BIG-PICTURE ALIGNMENT:',
      '- Before decomposing, step back and consider the FULL campaign scope.',
      '- Each milestone must serve the campaign\'s overall goal, not just one sub-domain.',
      '- If the campaign covers multiple areas (e.g. "strategy overhaul" covering signals, risk, execution),',
      '  ensure milestones span ALL areas — do not tunnel-vision on one area.',
      '- Ask yourself: "Does this set of milestones cover the full breadth of the campaign goal?"',
      '',
      'RIGHT-SIZING — match engineering ceremony to the VISION\'s own scale and tone:',
      '- A small or playful project (a single-file game, a static site, a one-page dashboard)',
      '  gets BUILD-FIRST milestones: working software early, polish after.',
      '- Do NOT create specification/contract/schema/versioning milestones unless the vision',
      '  itself calls for them. Specs are a means, not a deliverable, for small projects.',
      '  (A retro homepage does not need "Durable and Concurrent Storage" — the vision said',
      '  a JSON file and a tiny file-server.)',
      '- Enterprise ceremony (observability, audit, recovery, RFC-grade contracts) belongs',
      '  ONLY in projects whose vision asks for production-grade software.',
    ];

    const prompt = [
      ...openingInstructions,
      '',
      vision ? `=== PROJECT VISION ===\n${vision}\n` : '',
      ragContext ? `=== RELEVANT PROJECT HISTORY ===\n${ragContext}\n` : '',
      learningsCtx || '',
      cycleCtx || '',
      `Campaign: ${campaign.title}`,
      campaign.description !== campaign.title ? `Description: ${campaign.description}` : '',
      campaign.doneCriteria ? `Success criteria: ${campaign.doneCriteria}` : '',
      campaign.contingency ? `Campaign contingency: ${campaign.contingency}` : '',
      campaignType !== 'standard' ? `Type: ${campaignType}` : '',
      outputMode !== 'implementation' ? `Output mode: ${outputMode}` : '',
      '',
      'Return a JSON array of milestones with ordering and dependencies:',
      '[{ "title": "...", "description": "...", "doneCriteria": "...", "contingency": "...", "blockedBy": [], "order": 1, "requireApproval": false }]',
      '',
      'Guidelines:',
      '- Milestone COUNT scales with the vision: 3-7 for substantial multi-part visions;',
      '  a small single-deliverable vision (a game, a page, a script — something the',
      '  community one-shots) gets 2-3 AT MOST: build it, exercise/verify it, polish.',
      '  Do not stretch a one-sitting build into a week of milestones — these prompts',
      '  are meant to be REPRODUCED, and reproduction includes the pace.',
      '- Order them logically (order field = execution priority)',
      '- PARALLELISM IS PREFERRED: default to blockedBy: [] unless a milestone genuinely cannot begin without output from another',
      '- Only use blockedBy when a milestone literally needs the artifact, data, or live system from a prior milestone to function',
      '  Examples that REQUIRE blockedBy: "Deploy service" needs "Build service"; "Run live validation" needs "Deploy to staging"',
      '  Examples that do NOT need blockedBy: "Write tests" alongside "Write feature"; dashboard work alongside background validation; independent strategy tracks',
      '- A time-gated milestone (e.g. "run shadow validation for Xh") should NEVER block unrelated work — run it in parallel',
      '- Use blockedBy to express dependencies (reference titles of earlier milestones)',
      '- Include a contingency plan for each: what to do if it fails or gets blocked',
      '- Keep milestones concrete and measurable',
      '- APPROVAL GATES: Default to requireApproval: false. Only set true when',
      '  the milestone matches ONE of these specific patterns:',
      '  * Production deployments to live infrastructure',
      '  * Data migrations that mutate existing operator data',
      '  * Schema changes or breaking API modifications',
      '  * Security-critical changes (auth, permissions, encryption)',
      '  * High-risk operations that could cause data loss or service disruption',
      '',
      '  Design, specification, documentation, evaluation, and discovery',
      '  milestones do NOT need approval gates — agents can produce output',
      '  for the operator to review post-hoc. The operator already reviews',
      '  the full campaign closeout. Per-milestone gates are for halting',
      '  WHEN A WRONG STEP WOULD BE DESTRUCTIVE, not for routine sign-off.',
      '',
      '  If unsure, prefer false. The operator can pause the campaign',
      '  manually if they want to intervene.',
      ...evergreenGuidelines,
      ...bigPictureInstruction,
      '',
      'JSON array only, no other text.',
    ].filter(Boolean).join('\n');

    const sendResult = await sendWithArchitectFallback({
      projectId,
      channelId,
      phaseLabel: 'campaign decomposition',
      prompt,
      noArchitectMessage: `Cannot decompose campaign — no architect agent available.`,
      responseValidator: (response) => {
        const parsed = parseStructuredJson(response, 'array');
        if (!parsed.ok) return { ok: false, reason: parsed.reason || 'invalid_json', parsed };
        if (!Array.isArray(parsed.value) || parsed.value.length === 0) return { ok: false, reason: 'empty_array', parsed };
        return { ok: true, parsed };
      },
      onValidationExhausted: ({ response, validation }) => {
        const parsed = validation?.parsed;
        if (parsed && !parsed.ok && parsed.reason === 'not_found') {
          addMessage(projectId, channelId, 'System',
            `Campaign decomposition failed — no structured output.\nResponse: ${String(response).substring(0, 300)}`, 'system');
          return;
        }
        if (validation?.reason === 'empty_array') {
          addMessage(projectId, channelId, 'System', `Campaign decomposition failed — empty milestone list.`, 'system');
          return;
        }
        addMessage(projectId, channelId, 'System', `Campaign decomposition failed — invalid JSON.`, 'system');
      },
    });
    if (!sendResult) return;
    const { architect } = sendResult;

    try {
      let msDefs = sendResult.validated.parsed.value;
      // Deduplicate by title (LLMs sometimes return duplicate sets)
      const seenTitles = new Set();
      msDefs = msDefs.filter(def => {
        const t = (typeof def === 'string' ? def : def.title)?.toLowerCase();
        if (!t || seenTitles.has(t)) return false;
        seenTitles.add(t);
        return true;
      });

      const maxMs = config.campaigns.maxMilestonesPerCampaign;
      if (msDefs.length > maxMs) msDefs.length = maxMs;

      // Skip if campaign already has milestones (prevents duplicate creation on re-run)
      const existing = campaignManager.getCampaign(projectId, campaignId);
      if (existing?.milestones?.length > 0) {
        log.info('Campaign already has milestones, skipping creation', { projectId, campaignId, count: existing.milestones.length });
        return;
      }

      // Create milestones — resolve blockedBy from titles to IDs
       const titleToId = new Map();
       const createdMs = [];
       for (let i = 0; i < msDefs.length; i++) {
         const def = msDefs[i];
         const title = typeof def === 'string' ? def : def.title;
         const description = typeof def === 'string' ? def : (def.description || def.title);
         const doneCriteria = typeof def === 'string' ? null : (def.doneCriteria || null);
         const contingency = typeof def === 'string' ? null : (def.contingency || null);
         const rawBlockedBy = (typeof def === 'object' && Array.isArray(def.blockedBy)) ? def.blockedBy : [];
         const blockedBy = rawBlockedBy
           .map(ref => titleToId.get(ref) || titleToId.get(ref.toLowerCase()))
           .filter(Boolean);
         const requireApproval = typeof def === 'object' && def.requireApproval === true;
         const ms = campaignManager.addMilestone(projectId, campaignId, {
           title, description, doneCriteria, contingency, blockedBy,
           order: typeof def === 'object' && def.order != null ? def.order : i + 1,
           requireApproval,
         });
         titleToId.set(title, ms.id);
         titleToId.set(title.toLowerCase(), ms.id);
         createdMs.push(ms);
       }

      const msDisplay = createdMs.map((m, i) => {
         let line = `${i + 1}. ${m.title}`;
         if (m.doneCriteria) line += `\n   Done when: ${m.doneCriteria}`;
         if (m.contingency) line += `\n   If blocked: ${m.contingency}`;
         if (m.requireApproval) line += `\n   ⚠️ Requires operator approval before execution`;
         return line;
       }).join('\n');
      addMessage(projectId, channelId, 'System',
        `Campaign **${campaign.title}** decomposed into ${createdMs.length} milestones:\n${msDisplay}`, 'system');

      // Activate first unblocked milestone and decompose it into tasks
      const firstMs = campaignManager.getNextUnblockedMilestone(projectId, campaignId);
      if (firstMs) {
        const updatedCampaign = campaignManager.getCampaign(projectId, campaignId);
        if (!isCampaignWithinTimeWindow(updatedCampaign)) {
          const skipReason = getTimeWindowSkipReason(updatedCampaign);
          log.info('Campaign outside time window after decomposition — deferring first milestone', {
            projectId, campaignId, firstMilestoneId: firstMs.id, skipReason,
          });
          addMessage(projectId, channelId, 'System',
            `Campaign **${campaign.title}** decomposed but is outside its configured time window. Deferring first milestone "**${firstMs.title}**". Reason: ${skipReason}`, 'system');
          return;
        }
        campaignManager.updateMilestoneStatus(projectId, campaignId, firstMs.id, 'active', 'First unblocked milestone');
        await strategistDecompose(projectId, campaignId, firstMs.id);
      }
    } catch (err) {
      addMessage(projectId, channelId, 'System', `Campaign decomposition error: ${err.message}`, 'system');
      log.error('Campaign decomposition failed', { projectId, campaignId, error: err.message });
    } finally {
      decomposingCampaigns.delete(campaignId);
    }
  }

  /** Strategic closeout — two-step pipeline: research → synthesis on campaign completion. */
  async function strategistCloseout(projectId, campaignId) {
    const campaign = campaignManager.getCampaign(projectId, campaignId);
    if (!campaign) return;
    const channelId = 'general';
    const vision = stateManager.getProjectVision(projectId);

    // Compile campaign stats
    const totalMilestones = campaign.milestones.length;
    const completedMs = campaign.milestones.filter(m => m.status === 'completed');
    const failedMs = campaign.milestones.filter(m => m.status === 'failed');
    const skippedMs = campaign.milestones.filter(m => m.status === 'skipped');
    const allTaskIds = campaign.milestones.flatMap(m => m.tasks);
    let totalTasks = 0, doneTasks = 0, failedTasks = 0;
    for (const taskId of allTaskIds) {
      const task = taskManager.getTask(projectId, taskId);
      if (!task) continue;
      totalTasks++;
      if (task.status === 'done') doneTasks++;
      else if (task.status === 'failed') failedTasks++;
    }
    const startDate = campaign.createdAt?.split('T')[0] || 'unknown';
    const endDate = campaign.completedAt?.split('T')[0] || new Date().toISOString().split('T')[0];

    const milestoneReport = campaign.milestones
      .sort((a, b) => a.order - b.order)
      .map(m => `- ${m.title} [${m.status}]: ${m.doneCriteria || m.description || 'no criteria'}`)
      .join('\n');

    const campaignContext = [
      '=== COMPLETED CAMPAIGN ===',
      `Title: ${campaign.title}`,
      `Goal: ${campaign.doneCriteria || campaign.description}`,
      `Duration: ${startDate} → ${endDate}`,
      `Milestones: ${completedMs.length} completed, ${failedMs.length} failed, ${skippedMs.length} skipped (${totalMilestones} total)`,
      `Tasks: ${doneTasks} done, ${failedTasks} failed (${totalTasks} total)`,
      '',
      'Milestones:',
      milestoneReport,
    ].join('\n');

    addMessage(projectId, channelId, 'System',
      `Campaign **${campaign.title}** completed (${completedMs.length}/${totalMilestones} milestones, ${doneTasks}/${totalTasks} tasks). Starting strategic review...`, 'system');

    // ─── Step 1: Research (Gem or best researcher) ───
    const researcher = Object.values(agents).find(a => a.role === 'researcher')
      || Object.values(agents).find(a => a.provider === 'gemini');

    let researchReport = '';
    if (researcher) {
      const researchPrompt = [
        'A campaign has just been completed. Your job is to research and report facts',
        'that will inform a strategic review. Do NOT make recommendations — just gather information.',
        '',
        campaignContext,
        '',
        vision ? `=== PROJECT VISION ===\n${vision}\n` : '',
        'Research and report on:',
        '',
        '1. **Current product state** — What does this project actually do right now?',
        '   Read the codebase, docs, and config to describe the product as it exists today.',
        '',
        '2. **What shipped vs what was planned** — Compare what the campaign set out to do',
        '   against what actually got built. Note any gaps, partial implementations, or scope changes.',
        '',
        '3. **Landscape context** — What do comparable tools or projects in THIS product\'s',
        '   domain offer that it does or doesn\'t? Name real comparables based on what the',
        '   product actually is (read the vision and codebase first). Note emerging patterns',
        '   in that domain and gaps relative to them.',
        '',
        '4. **What changed during the campaign** — Did any assumptions shift? Did',
        '   dependencies or external constraints change?',
        '',
        '5. **Readiness gaps** — What stands between the product as it exists and the',
        '   quality bar its own vision sets? Scale this to the vision: a playful',
        '   single-file project is judged on fun and correctness, not enterprise ops.',
        '',
        '6. **Scope blind spots** — Look at the project vision and what has actually been built.',
        '   Are there major areas the vision calls for that the project has NOT explored at all?',
        '   List any significant opportunities, integrations, or market/use-case categories that:',
        '   - Exist in the codebase as dead code, skeletons, or research docs but were never activated',
        '   - Are called out in the vision or strategy docs but have zero active implementation',
        '   - Have been repeatedly deferred across multiple campaigns in favor of deepening existing work',
        '   Be specific: name the files, docs, or features. This is a tunnel-vision check, not a wishlist.',
        '',
        'Be factual and specific. Reference actual files, features, and capabilities.',
        'This research will feed into the architect\'s strategic synthesis.',
      ].filter(Boolean).join('\n');

      try {
        const researcherProvider = researcher.provider || getAgentId(researcher) || 'unknown';
        if (!tryAcquireProviderSlot(researcherProvider)) {
          log.info('Closeout research skipped due provider concurrency cap', {
            projectId, campaignId, researcher: researcher.name, provider: researcherProvider,
          });
          addMessage(projectId, channelId, 'System',
            `Research phase delayed/skipped — ${researcher.name} provider is busy. Proceeding with architect synthesis.`,
            'system');
          researchReport = '';
        } else {
        addMessage(projectId, channelId, 'System',
          `Research phase: ${researcher.name} analyzing product state and landscape...`, 'system');
        const rawResearchReport = await withTimeout(
          researcher.send(researchPrompt, workingDir(projectId), { maxTurns: config.campaigns.decomposeMaxTurns }),
          config.campaigns.decomposeTimeoutMs, researcher.name
        );
        // Normalize ResponseObject → string before researchReport feeds the
        // subsequent architect prompt (it gets concatenated into the next
        // dispatch's context). [object Object] in the architect's prompt
        // would silently degrade campaign decomposition for descriptor-backed
        // researchers.
        researchReport = typeof rawResearchReport === 'string' ? rawResearchReport
          : (rawResearchReport?.text != null ? String(rawResearchReport.text) : String(rawResearchReport ?? ''));
        if (handleStrategistRateLimit(researcher, researchReport, projectId, channelId, 'closeout research')) {
          researchReport = '';
        }
        log.info('Closeout research completed', { projectId, campaignId, researcher: researcher.name });
          releaseProviderSlot(researcherProvider);
        }
      } catch (err) {
        try {
          const researcherProvider = researcher.provider || getAgentId(researcher) || 'unknown';
          releaseProviderSlot(researcherProvider);
        } catch {}
        if (handleStrategistRateLimit(researcher, err.message, projectId, channelId, 'closeout research')) {
          researchReport = '';
          // Continue without research; synthesis can still proceed with fallback architect.
        } else {
          log.warn('Closeout research failed, continuing without', { error: err.message });
          addMessage(projectId, channelId, 'System',
            `Research phase skipped (${researcher.name}: ${err.message}). Proceeding with architect synthesis.`, 'system');
        }
      }
    }

    // ─── Step 2: Strategic synthesis (best available architect) ───
    const ragContext = await queryRAG(projectId, `${campaign.title} closeout strategic review`);

    const synthesisPrompt = [
      'You are the project architect. A campaign has just been completed.',
      'Based on the campaign results' + (researchReport ? ' and the research report below' : '') + ',',
      'provide a strategic review that captures what was learned.',
      '',
      'This is NOT a feature wishlist. Focus on what the campaign taught us',
      'and where the product naturally needs to go next. Continuous improvement',
      'should emerge from iteration, not from adding things just to add them.',
      '',
      campaignContext,
      '',
      vision ? `=== PROJECT VISION ===\n${vision}\n` : '',
      researchReport ? `=== RESEARCH REPORT ===\n${researchReport}\n` : '',
      ragContext ? `=== RELEVANT PROJECT HISTORY ===\n${ragContext}\n` : '',
      'Answer these four questions (2-4 sentences each, grounded in specifics):',
      '',
      '1. **What\'s next?** — Based on what we learned, what is the natural next step?',
      '   What emerged from this campaign that needs attention?',
      '',
      '2. **What is our product missing?** — Not a wishlist, but genuine gaps that',
      '   became apparent through building and using the product.',
      '',
      '3. **Have we met our vision?** — ' + (vision
        ? 'How far did this campaign move us toward the vision? What\'s real vs aspirational?'
        : 'What did this campaign actually achieve? Where does the product stand now?'),
      '',
      '4. **What do we need for our vision?** — ' + (vision
        ? 'What\'s the honest gap between where we are and the vision? What\'s blocking it?'
        : 'What would it take to make this product genuinely useful and complete?'),
      '',
      '4a. **Vision drift check** — Compare what the project actually does today to what the vision says it should do.',
      '    Has the project narrowed its scope relative to the vision? Are there areas the vision explicitly covers',
      '    that have received zero attention? Name them. If the project has drifted into a narrow sub-problem',
      '    while the vision calls for something broader, say so plainly. This is the tunnel-vision check.',
      '    IMPORTANT: The updated vision in step 5 must reflect the FULL intended scope, not just what has been built.',
      '',
      'Be honest, not optimistic. If something shipped but isn\'t battle-tested, say so.',
      'If something is genuinely done, acknowledge it. Reference concrete capabilities.',
      '',
      '5. **Vision refinement** — Based on everything above, write an updated project vision.',
      '   This replaces the current vision. It should be 2-5 sentences that capture where this',
      '   project is now and where it\'s heading. Sharpen what\'s real, drop what\'s aspirational',
      '   but unearned, add what emerged from this campaign. If there\'s no existing vision,',
      '   write one from scratch based on what the project actually is today.',
      '',
      'Format the first four answers as markdown with the numbered headers above.',
      'Then add a final section exactly like this:',
      '',
      '```vision',
      '<the updated project vision text, 2-5 sentences>',
      '```',
      '',
      '6. **Next campaign** — You MUST define the next campaign. Continuous improvement never stops.',
      '   The product is always evolving. Consider ALL of the following, not just what emerged from this campaign:',
      '   - What emerged from this campaign that needs follow-up?',
      '   - What does the VISION call for that has NOT been built yet? (scope blind spots from 4a)',
      '   - Has the project been deepening a narrow area for multiple campaigns? If so, the next campaign',
      '     should BROADEN scope — explore an untouched area rather than adding more depth to what exists.',
      '   - Dead code, research docs, and skeleton implementations that were never activated — are any worth pursuing?',
      '   - What do competing tools (n8n, CrewAI, AutoGen, LangGraph, OpenClaw) do that we don\'t?',
      '   - UX polish, reliability hardening, developer experience improvements',
      '   - Our unique advantages: subscription-based CLI auth (flat rate), cross-terminal agent communication,',
      '     multi-ecosystem orchestration (Claude + Codex + Gemini + Ollama). How do we push these further?',
      '   - Operator experience: can the operator see what\'s happening? Can they steer effectively?',
      '',
      '   This is REQUIRED. Output exactly this format:',
      '',
      '```campaign',
      '{ "title": "...", "description": "...", "doneCriteria": "...", "priority": "medium" }',
      '```',
    ].filter(Boolean).join('\n');

    const synthesisResult = await sendWithArchitectFallback({
      projectId,
      channelId,
      phaseLabel: 'campaign closeout synthesis',
      prompt: synthesisPrompt,
      noArchitectMessage: `Campaign completed but no architect available for strategic review.`,
    });
    if (!synthesisResult) return;
    const { architect, response: _resp } = synthesisResult;
    // Coerce: fallback paths may return a non-string response.
    const response = responseText(_resp);

    try {
      addMessage(projectId, channelId, 'System',
        `Synthesis phase: ${architect.name} generating strategic review...`, 'system');

      // Store the LLM-generated markdown in closeoutMarkdown (separate from structured closeoutSummary)
      const campaign = campaignManager.getCampaign(projectId, campaignId);
      campaignManager._saveWithRetry(projectId, (d) => {
        const c = d.campaigns.find(x => x.id === campaignId);
        if (c) {
          c.closeoutMarkdown = response;
          c.updatedAt = new Date().toISOString();
        }
        return d;
      });
      addMessage(projectId, channelId, 'System',
        `**Strategic Review — ${campaign.title}**\n\n${response}`, 'system');
      broadcastToChannel(projectId, channelId, {
        type: 'campaign_closeout', campaignId, summary: response,
      });

      // ─── Step 3: Vision refinement — extract and apply ───
      const visionMatch = response.match(/```vision\s*\n([\s\S]*?)```/);
      if (visionMatch) {
        const newVision = visionMatch[1].trim();
        const previousVision = stateManager.getProjectVision(projectId);
        if (newVision && newVision !== previousVision) {
          stateManager.setProjectVision(projectId, newVision, { source: 'closeout', campaignId });
          addMessage(projectId, channelId, 'System',
            `**Project vision updated** (refined by ${architect.name} after campaign closeout):\n\n> ${newVision}`, 'system');
          broadcastToChannel(projectId, channelId, {
            type: 'vision_updated', projectId, vision: newVision, source: 'closeout', campaignId,
          });
          log.info('Vision refined by closeout', { projectId, campaignId, architect: architect.name });
        }
      }

      // ─── Step 4: Auto-generate next campaign ───
      try {
        const campaignMatch = response.match(/```campaign\s*\n([\s\S]*?)```/);
        if (campaignMatch) {
          const def = JSON.parse(campaignMatch[1].trim());
          if (def.title) {
            const newCampaign = campaignManager.createCampaign(projectId, {
              title: def.title,
              description: def.description || def.title,
              doneCriteria: def.doneCriteria || undefined,
              priority: def.priority || 'medium',
            });
            addMessage(projectId, channelId, 'System',
              `Auto-generated next campaign: **${def.title}**`, 'system');
            log.info('Next campaign auto-generated from closeout', { projectId, campaignId: newCampaign.id, title: def.title });
          }
        } else {
          log.warn('Closeout did not produce a campaign block', { projectId, campaignId });
        }
      } catch (campErr) {
        log.warn('Auto-campaign generation failed (non-fatal)', { projectId, campaignId, error: campErr.message });
      }

      log.info('Campaign closeout completed', { projectId, campaignId, title: campaign.title });
    } catch (err) {
      log.error('Campaign closeout failed', { projectId, campaignId, error: err.message });
      addMessage(projectId, channelId, 'System',
        `Campaign completed but strategic review failed: ${err.message}\n\nUse \`/campaign show ${campaignId}\` to see final state.`, 'system');
    }
  }

  /** Inject a new idea into a campaign — architect evaluates impact. */
  async function strategistInject(projectId, campaignId, idea) {
    const campaign = campaignManager.getCampaign(projectId, campaignId);
    if (!campaign) return;
    const channelId = 'general';
    const msDescriptions = campaign.milestones.map(m =>
      `- ${m.title} [${m.status}]${m.doneCriteria ? `: ${m.doneCriteria}` : ''}`
    ).join('\n');

    const prompt = [
      'You are the project architect. A new requirement has been injected into an active campaign.',
      'Evaluate the impact and recommend changes.',
      '',
      `Campaign: ${campaign.title}`,
      `Goal: ${campaign.doneCriteria || campaign.description}`,
      '',
      'Current milestones:',
      msDescriptions,
      '',
      `NEW REQUIREMENT: ${idea}`,
      '',
      'Evaluate:',
      '1. Does this require a NEW milestone? If so, provide its definition.',
      '2. Does this MODIFY an existing milestone? If so, which one and how?',
      '3. Does this change priority/ordering?',
      '',
      'Respond with a JSON object:',
      '{ "action": "add_milestone" | "modify_existing" | "reprioritize" | "no_change",',
      '  "milestone": { "title": "...", "description": "...", "doneCriteria": "...", "contingency": "...", "order": N } | null,',
      '  "modifyMilestoneTitle": "..." | null,',
      '  "summary": "brief explanation" }',
      '',
      'JSON only, no other text.',
    ].join('\n');

    const sendResult = await sendWithArchitectFallback({
      projectId,
      channelId,
      phaseLabel: 'idea evaluation',
      prompt,
      noArchitectMessage: `Cannot evaluate idea — no architect agent available.`,
    });
    if (!sendResult) return;
    const { architect, response: _resp } = sendResult;
    // Coerce: fallback paths may return a non-string response.
    const response = responseText(_resp);

    try {
      const parsed = parseStructuredJson(response, 'object');
      if (!parsed.ok && parsed.reason === 'not_found') {
        addMessage(projectId, channelId, 'System',
          `Idea evaluation — architect response (non-structured):\n${response.substring(0, 500)}`, 'system');
        return;
      }
      if (!parsed.ok) {
        addMessage(projectId, channelId, 'System',
          `Idea evaluation — could not parse structured response. Raw:\n${response.substring(0, 500)}`, 'system');
        return;
      }
      let result = parsed.value;

      if (result.action === 'add_milestone' && result.milestone) {
         const existingMs = campaign.milestones;
         const order = result.milestone.order || (existingMs.length > 0 ? Math.max(...existingMs.map(m => m.order)) + 1 : 1);
         const ms = campaignManager.addMilestone(projectId, campaignId, {
           title: result.milestone.title,
           description: result.milestone.description || result.milestone.title,
           doneCriteria: result.milestone.doneCriteria || null,
           contingency: result.milestone.contingency || null,
           blockedBy: [],
           order,
           requireApproval: result.milestone.requireApproval || false,
         });
         addMessage(projectId, channelId, 'System',
           `Idea evaluated — new milestone added: **${ms.title}**\n${result.summary || ''}`, 'system');
       }
      campaignManager.updateCampaignReview(projectId, campaignId, {
        lastReviewSummary: `Idea injection: "${idea}" → ${result.action || 'no_change'}`,
        nextAction: result.summary || null,
      });
    } catch (err) {
      addMessage(projectId, channelId, 'System', `Idea evaluation error: ${err.message}`, 'system');
    }
  }

  /** Promote next queued campaign and kick off decomposition. */
  async function promoteAndDecompose(projectId, channelId) {
    const promoted = campaignManager.promoteNextCampaign(projectId);
    if (promoted) {
      addMessage(projectId, channelId, 'System',
        `Campaign **${promoted.title}** [${promoted.priority}] promoted from queue. Starting decomposition...`, 'system');
      broadcastToChannel(projectId, channelId, { type: 'campaign_promoted', campaignId: promoted.id });
      await strategistDecomposeCampaign(projectId, promoted.id);
      return;
    }

    // No queued campaigns — generate one from the vision. Continuous improvement never stops.
    log.info('No queued campaigns, generating next campaign from vision', { projectId });
    const vision = stateManager.getProjectVision(projectId);
    const completedCampaigns = campaignManager.listCampaigns(projectId, 'completed');
    const recentCampaigns = completedCampaigns.slice(-3).map(c =>
      `- ${c.title} [${c.completedAt?.split('T')[0] || 'unknown'}]`
    ).join('\n');
    const ragContext = await queryRAG(projectId, 'next campaign continuous improvement');

    // Stage-aware, vision-first. The previous prompt was written for the
    // lab's synapse-improving-synapse loop and shipped to EVERY project: it
    // told the architect "all campaigns are completed... continuous
    // improvement" (false for greenfield projects) and hardcoded Synapse's
    // own product landscape (n8n/CrewAI comparisons, subscription CLI auth,
    // enterprise gaps like audit trails and error recovery). Result, live:
    // a fresh retro-homepage project got "Build an Auditable Agent
    // Operations Control Plane", and two greenfield projects in a row got
    // "Reliability and Recovery Hardening" campaigns for software that did
    // not exist yet — all straight off the leaked checklist.
    const isGreenfield = completedCampaigns.length === 0;
    const prompt = [
      isGreenfield
        ? 'You are the project architect. This is a NEW project — no campaign has run yet.'
        : 'You are the project architect. All campaigns are completed and the queue is empty.',
      isGreenfield
        ? 'Define the FIRST campaign: it must deliver the project vision\'s core deliverables end to end.'
        : 'The project runs on continuous improvement — there is always more to do.',
      '',
      vision ? `=== PROJECT VISION ===\n${vision}\n` : '',
      recentCampaigns ? `=== RECENTLY COMPLETED CAMPAIGNS ===\n${recentCampaigns}\n` : '',
      ragContext ? `=== RELEVANT PROJECT HISTORY ===\n${ragContext}\n` : '',
      'Ground the campaign in the PROJECT VISION above: its deliverables and done',
      'criteria come from the vision, not from generic engineering best practices.',
      isGreenfield
        ? 'Do NOT propose hardening, monitoring, observability, or recovery work — none of the software exists yet. Build the thing the vision describes.'
        : 'Consider: vision items not yet delivered, quality gaps in shipped work, reliability of what exists, and the user experience of the product this project builds.',
      '',
      'Define the SINGLE most important next campaign. Output exactly:',
      '',
      '```campaign',
      '{ "title": "...", "description": "...", "doneCriteria": "...", "priority": "medium" }',
      '```',
    ].filter(Boolean).join('\n');

    const sendResult = await sendWithArchitectFallback({
      projectId,
      channelId,
      phaseLabel: 'next campaign generation',
      prompt,
      noArchitectMessage: `All campaigns completed and queue is empty. No architect available to generate next campaign.`,
    });
    if (!sendResult) return;
    const { architect, response: _resp } = sendResult;
    // Coerce: fallback paths may return a non-string response.
    const response = responseText(_resp);

    try {
      addMessage(projectId, channelId, 'System',
        `Queue empty — ${architect.name} generating next campaign from vision...`, 'system');

      const campaignMatch = response.match(/```campaign\s*\n([\s\S]*?)```/);
      if (campaignMatch) {
        const def = JSON.parse(campaignMatch[1].trim());
        if (def.title) {
          const newCampaign = campaignManager.createCampaign(projectId, {
            title: def.title,
            description: def.description || def.title,
            doneCriteria: def.doneCriteria || undefined,
            priority: def.priority || 'medium',
          });
          addMessage(projectId, channelId, 'System',
            `Auto-generated next campaign: **${def.title}**`, 'system');
          log.info('Campaign generated from vision (queue was empty)', { projectId, campaignId: newCampaign.id, title: def.title });
          // Promote and decompose the newly created campaign
          const freshPromoted = campaignManager.promoteNextCampaign(projectId);
          if (freshPromoted) {
            broadcastToChannel(projectId, channelId, { type: 'campaign_promoted', campaignId: freshPromoted.id });
            await strategistDecomposeCampaign(projectId, freshPromoted.id);
          }
        }
      } else {
        log.error('Vision-based campaign generation produced no campaign block', { projectId });
        addMessage(projectId, channelId, 'System',
          `Campaign generation failed — architect did not produce a campaign definition. ` +
          `Create one manually with \`/campaign create <title>\`.`, 'system');
      }
    } catch (err) {
      log.error('Vision-based campaign generation failed', { projectId, error: err.message });
      addMessage(projectId, channelId, 'System',
        `Campaign generation failed: ${err.message}. Create one manually with \`/campaign create <title>\`.`, 'system');
    }
  }

  /** Start the strategist periodic interval. Idempotent. */
  let strategistStartupTimer = null;
  function startStrategist() {
    if (strategistInterval) return;
    strategistInterval = setInterval(strategistTick, STRATEGIST_INTERVAL_MS);
    log.info('Campaign strategist started', { intervalSec: STRATEGIST_INTERVAL_MS / 1000 });
    // Startup scan: catch active campaigns/milestones that need work.
    // Tracked so stopStrategist can cancel it — an untracked timer here fires a
    // tick after shutdown/restart, overlapping the new instance's chain.
    strategistStartupTimer = setTimeout(strategistTick, 5_000);
  }

  /** Stop the strategist interval (graceful shutdown / testing). */
  function stopStrategist() {
    if (strategistInterval) { clearInterval(strategistInterval); strategistInterval = null; }
    if (strategistStartupTimer) { clearTimeout(strategistStartupTimer); strategistStartupTimer = null; }
  }

  return {
    strategistEvaluate, strategistDecompose, strategistTick,
    strategistDecomposeCampaign, strategistInject, strategistCloseout,
    generateProjectVision, promoteAndDecompose, startStrategist, stopStrategist,
  };
}
