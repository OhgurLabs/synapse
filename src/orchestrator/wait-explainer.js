import { rosterAllowsAgentAnyRole } from '../roster.js';

const reason = (code, message, details = {}) => ({ code, message, ...details });

function withCooldown(code, message, cooldownUntil, now) {
  const resetMs = typeof cooldownUntil === 'string' ? Date.parse(cooldownUntil) : cooldownUntil;
  const resetAt = Number.isFinite(resetMs) && resetMs > now && resetMs <= 8.64e15
    ? new Date(resetMs).toISOString() : null;
  return reason(code, message, resetAt ? { resetAt } : {});
}

/** Explain current observed blockers without claiming slots, probing providers or mutating state. */
export function explainWait({
  run = null, manifest = null, project = null, roster = project?.agents, priority = null,
  agents = {}, isPaused = () => false, getPool = () => null, getCooldown = () => null,
  now = Date.now(),
} = {}) {
  if (run?.phase === 'terminal' || run?.phase === 'cancelling' || run?.phase === 'finalizing') return null;
  if (run?.phase === 'awaiting_approval') {
    return reason('awaiting_approval', 'Waiting for operator approval of the verified source.');
  }
  if (run?.phase === 'running') {
    const pending = (manifest?.nodes || []).find(node =>
      node.kind === 'anchor' && !run.selectedAttempts?.[node.nodeId] &&
      (node.dependsOn || []).every(id => Boolean(run.selectedAttempts?.[id])));
    return pending ? reason('pending_anchor', 'Waiting for Anchor proof.', { nodeId: pending.nodeId }) : null;
  }
  if (project?.allocation === 0) {
    return reason('allocation_zero', 'Project allocation is 0%.');
  }

  const configured = Object.entries(agents).filter(([, agent]) => agent && (!agent._status || ['active', 'idle'].includes(agent._status)));
  const onRoster = configured.filter(([id, agent]) => rosterAllowsAgentAnyRole(roster, id, agent));
  if (configured.length && !onRoster.length) {
    return reason('roster_filter', 'The project roster excludes all active agents.');
  }
  const strict = priority?.strict === true && Array.isArray(priority.ranks) && priority.ranks.length > 0;
  const candidates = strict ? onRoster.filter(([id]) => priority.ranks.includes(id)) : onRoster;
  if (onRoster.length && !candidates.length) {
    return reason('strict_rank_filter', 'Strict rank filtering excludes all active agents on the project roster.');
  }
  if (!candidates.length) return null;

  const blockers = candidates.map(([id, agent]) => {
    if (isPaused(id)) return reason('operator_pause', 'Eligible agents are paused by an operator.');
    const cooldown = getCooldown(id, agent, now);
    if (cooldown?.blocked) {
      return withCooldown('provider_cooldown', 'Eligible routes are blocked by provider or agent cooldown.',
        cooldown.pinCooldownUntil ?? cooldown.cooldownUntil, now);
    }
    const pool = getPool(id, agent, now);
    if (pool?.evicted) {
      return withCooldown('pool_eviction', 'Eligible shared pools are in eviction cooldown.', pool.cooldownUntil, now);
    }
    if (pool && Number.isFinite(pool.used) && Number.isFinite(pool.limit) && pool.used >= pool.limit) {
      return reason('pool_capacity', 'Eligible shared pools are at capacity.');
    }
    return null;
  });
  if (blockers.some(blocker => !blocker)) return null;
  const first = blockers[0];
  if (blockers.every(b => b.code === first.code)) {
    return blockers.every(b => b.resetAt === first.resetAt) ? first : reason(first.code, first.message);
  }
  return reason('multiple_blockers', 'Eligible routes have multiple blockers.',
    { blockers: [...new Set(blockers.map(b => b.code))] });
}
