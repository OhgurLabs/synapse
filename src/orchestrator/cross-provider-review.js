import { createLogger } from '../logger.js';

const log = createLogger('cross-provider-review');

export function hasHadCrossProviderReview(task) {
  const subtasks = task.subtasks || [];
  return subtasks.some(st => st.meta?.crossProviderReview === true && st.status === 'done');
}

export function getFirstReviewProvider(task) {
  const subtasks = task.subtasks || [];
  const auditSubtask = subtasks.find(st => st.meta?.auditTask === true && !st.meta?.crossProviderReview);
  return auditSubtask?.assignee || null;
}

export function selectCrossProviderReviewer(agentMap, availableAgentIds, firstReviewerId, contributors, {
  isAgentCoolingDown = null,
  circuitBreaker = null,
  busyAgents = null,
} = {}) {
  const firstProvider = agentMap[firstReviewerId]?.provider;
  const firstModel = agentMap[firstReviewerId]?.model;
  const contributorIds = new Set(contributors);
  const contributorProviders = new Set(
    [...contributorIds].map(id => agentMap[id]?.provider).filter(Boolean)
  );

  // The audit subtask is created with role:'reviewer' and pinned to whichever
  // agent this returns. If the chosen agent's role can't handle 'reviewer'
  // (developer-role, architect-role), seekAndExecute will skip it forever and
  // the campaign wedges in `awaiting_approval` with no error. Require the
  // candidate to have reviewer OR architect role — those are the two role
  // classes that produce useful audit verdicts. Returning null is correct when
  // no eligible reviewer remains; the caller already logs and skips.
  const canReview = (a) => a.role === 'reviewer' || a.role === 'architect';

  const isEligible = ([id, a]) =>
    !!a &&
    (!a._status || a._status === 'active') &&
    a.role !== 'governor' &&
    canReview(a) &&
    id !== firstReviewerId &&
    !contributorIds.has(id) &&
    (!busyAgents || !busyAgents.has(id)) &&
    (!isAgentCoolingDown || !isAgentCoolingDown(id)) &&
    (!circuitBreaker || circuitBreaker.canRequest(id));

  const candidates = Object.entries(agentMap)
    .filter(([id]) => availableAgentIds.includes(id))
    .filter(isEligible)
    .sort(([, a], [, b]) => {
      const aDiffProvider = a.provider !== firstProvider ? 1 : 0;
      const bDiffProvider = b.provider !== firstProvider ? 1 : 0;
      if (bDiffProvider !== aDiffProvider) return bDiffProvider - aDiffProvider;

      const aReviewer = a.role === 'reviewer' ? 1 : 0;
      const bReviewer = b.role === 'reviewer' ? 1 : 0;
      if (bReviewer !== aReviewer) return bReviewer - aReviewer;

      const aDiffModel = a.model !== firstModel ? 1 : 0;
      const bDiffModel = b.model !== firstModel ? 1 : 0;
      return bDiffModel - aDiffModel;
    });

  return candidates[0] || null;
}

export function createCrossProviderReviewSubtask(firstReviewerId, taskTitle, diffStat, diffContent) {
  return {
    text: [
      `CROSS-PROVIDER VALIDATION for: ${taskTitle}`,
      '',
      'You are the second independent reviewer from a DIFFERENT provider.',
      'Focus on:',
      '  1. Correctness: Does the code do what was asked?',
      '  2. Completeness: Are edge cases handled?',
      '  3. Security: Any injection vectors, credential leaks?',
      '  4. Scope: Did it modify files outside the task scope?',
      '',
      'Review the git diff and report findings.',
      'If everything looks good, say PASS.',
    ].join('\n'),
    role: 'reviewer',
    complexity: 'high',
    assignee: firstReviewerId,
    meta: {
      auditTask: true,
      crossProviderReview: true,
    },
  };
}
