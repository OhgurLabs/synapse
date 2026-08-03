import { createLogger } from '../logger.js';

const log = createLogger('memory-writeback-listeners');

function getTaskCacheKey(projectId, taskId) {
  return `${projectId || 'unknown'}:${taskId || 'unknown'}`;
}

function normalizeAgentId(task, eventAgentId, cachedAgentId) {
  if (typeof eventAgentId === 'string' && eventAgentId.trim()) return eventAgentId;
  if (typeof cachedAgentId === 'string' && cachedAgentId.trim()) return cachedAgentId;
  if (typeof task?.owner === 'string' && task.owner.trim() && task.owner !== 'system') return task.owner;

  const matchingSubtask = (task?.subtasks || []).find(st => typeof st?.assignee === 'string' && st.assignee.trim());
  return matchingSubtask?.assignee || null;
}

function collectSubtaskResults(task) {
  return (task?.subtasks || [])
    .filter(st => st?.status === 'done' || st?.result !== undefined)
    .map(st => ({
      subtaskId: st.id,
      text: st.text,
      result: st.result,
      toolResults: st.toolResults,
      assignee: st.assignee,
      completedAt: st.completedAt,
    }));
}

function deriveFailureDetails(task, eventData) {
  const failedSubtask = (task?.subtasks || []).find(st => st?.status === 'failed' && (st?.error || st?.text));
  const errorMessage = failedSubtask?.error
    || task?.error
    || `Task failed${task?.title ? `: ${task.title}` : ''}`;

  return {
    errorMessage,
    failureContext: {
      projectId: eventData?.projectId,
      taskTitle: task?.title || eventData?.title,
      taskStatus: task?.status || eventData?.status,
      failedSubtaskId: failedSubtask?.id,
      subtaskText: failedSubtask?.text,
    },
  };
}

function persistCandidates(memoryWriteBackService, candidates) {
  if (!memoryWriteBackService || typeof memoryWriteBackService.add !== 'function') return;

  for (const candidate of candidates || []) {
    if (!candidate?.agentId || !candidate?.category || !candidate?.content) continue;
    memoryWriteBackService.add(
      candidate.agentId,
      candidate.category,
      candidate.content,
      candidate.source || {},
      candidate.tags || [],
      candidate.confidence
    );
  }
}

export function registerMemoryWriteBackEventListeners(deps = {}) {
  const {
    events,
    taskManager,
    memoryWriteBackService,
    extractors = {},
  } = deps;

  if (!events?.on || !taskManager?.getTask || !memoryWriteBackService?.add) {
    log.warn('Memory write-back listeners not registered due to missing dependencies');
    return () => {};
  }

  const recentDoneTransitions = new Map();

  const unsubscribeStatusChanged = events.on('task:status_changed', (eventData = {}) => {
    const { projectId, taskId, status } = eventData;
    if (!projectId || !taskId || !status) return;

    const cacheKey = getTaskCacheKey(projectId, taskId);

    if (status === 'done') {
      recentDoneTransitions.set(cacheKey, {
        agentId: eventData.agent || null,
        recordedAt: Date.now(),
      });
      return;
    }

    if (status !== 'failed') {
      recentDoneTransitions.delete(cacheKey);
      return;
    }

    if (typeof extractors.extractFromTaskFailure !== 'function') {
      log.debug('Task failure memory extractor unavailable; skipping task failure write-back', { projectId, taskId });
      return;
    }

    try {
      const task = taskManager.getTask(projectId, taskId);
      const agentId = normalizeAgentId(task, eventData.agent, null);
      if (!agentId) {
        log.debug('Skipping task failure memory write-back without agentId', { projectId, taskId });
        return;
      }

      const { errorMessage, failureContext } = deriveFailureDetails(task, eventData);
      const candidates = extractors.extractFromTaskFailure(taskId, agentId, errorMessage, failureContext);
      persistCandidates(memoryWriteBackService, candidates);
    } catch (err) {
      log.warn('Task failure memory write-back listener failed', { projectId, taskId, error: err.message });
    } finally {
      recentDoneTransitions.delete(cacheKey);
    }
  });

  const unsubscribeCompleted = events.on('task:completed', (eventData = {}) => {
    const { projectId, taskId } = eventData;
    if (!projectId || !taskId) return;

    const cacheKey = getTaskCacheKey(projectId, taskId);
    const doneTransition = recentDoneTransitions.get(cacheKey);

    if (typeof extractors.extractFromTaskCompletion !== 'function') {
      recentDoneTransitions.delete(cacheKey);
      log.debug('Task completion memory extractor unavailable; skipping task completion write-back', { projectId, taskId });
      return;
    }

    try {
      const task = taskManager.getTask(projectId, taskId);
      const agentId = normalizeAgentId(task, null, doneTransition?.agentId);
      if (!agentId) {
        log.debug('Skipping task completion memory write-back without agentId', { projectId, taskId });
        return;
      }

      const taskTitle = eventData.title || task?.title || taskId;
      const subtaskResults = collectSubtaskResults(task);
      const candidates = extractors.extractFromTaskCompletion(taskId, agentId, taskTitle, subtaskResults);
      persistCandidates(memoryWriteBackService, candidates);
    } catch (err) {
      log.warn('Task completion memory write-back listener failed', { projectId, taskId, error: err.message });
    } finally {
      recentDoneTransitions.delete(cacheKey);
    }
  });

  log.info('Memory write-back event listeners registered');

  return () => {
    unsubscribeStatusChanged?.();
    unsubscribeCompleted?.();
  };
}
