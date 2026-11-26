// agent-priority.js — per-project agent priority (#105).
// The roster determines who may work on a project. Priority orders eligible
// agents. Strict mode selects only the highest-ranked eligible agent (existing
// no-agent deferral paths handle "busy" — no new waiting machinery).
//
// Pure functions, no imports: routing sites (tasks.js routeSubtask,
// router.js selectAgent) call these with the project's normalised
// agentPriority ({ ranks, strict } | null from getProjectAgentPriority).

/**
 * Build a rank-index lookup. Lower index = higher priority.
 * @param {{ranks: string[]}|null} priority
 * @returns {Map<string, number>|null}
 */
export function rankIndexOf(priority) {
  if (!priority || !Array.isArray(priority.ranks) || priority.ranks.length === 0) return null;
  const m = new Map();
  priority.ranks.forEach((id, i) => { if (!m.has(id)) m.set(id, i); });
  return m;
}

/**
 * Reorder candidate ids by priority. Ranked candidates come first, in rank
 * order; unranked candidates keep their existing relative order AFTER the
 * ranked ones (partial ranking composes with the legacy default ordering).
 * With strict, collapses to [highest-ranked candidate] — or [] when no
 * ranked candidate is present (the project queues for its ranked agents;
 * callers' existing empty-pool deferral applies).
 * No priority ⇒ candidates returned unchanged (legacy behavior, by identity).
 *
 * @param {string[]} candidateIds
 * @param {{ranks: string[], strict: boolean}|null} priority
 * @returns {string[]}
 */
export function prioritizeCandidates(candidateIds, priority) {
  const idx = rankIndexOf(priority);
  if (!idx) return candidateIds;
  if (priority.strict === true) {
    let best = null;
    let bestRank = Infinity;
    for (const id of candidateIds) {
      const r = idx.get(id);
      if (r !== undefined && r < bestRank) { best = id; bestRank = r; }
    }
    return best === null ? [] : [best];
  }
  const ranked = [];
  const unranked = [];
  for (const id of candidateIds) {
    (idx.has(id) ? ranked : unranked).push(id);
  }
  ranked.sort((a, b) => idx.get(a) - idx.get(b));
  return [...ranked, ...unranked];
}

/**
 * Comparator factory for sort sites that must keep their OWN tiebreaks
 * (reviewer cross-model preference, cheapest-of cost fallback): rank is the
 * primary key; entries tie (0) when both unranked or equally ranked, letting
 * the site's legacy comparator decide. Accepts [id, agent] entries or ids.
 */
export function priorityComparator(priority) {
  const idx = rankIndexOf(priority);
  if (!idx) return () => 0;
  const rank = (x) => {
    const id = Array.isArray(x) ? x[0] : x;
    const r = idx.get(id);
    return r === undefined ? Infinity : r;
  };
  return (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra === rb) return 0;
    return ra - rb;
  };
}

/**
 * Decide whether a polling agent should YIELD a queued subtask to a
 * higher-ranked contender - "Grandma picks the order, not the kids"
 * (operator ruling 2026-08-20).
 *
 * The executor stays a pull model (agents poll and claim). This makes the ORDER
 * of pickup the operator's rank list instead of first-poller-wins. Pure and
 * side-effect free so the decision is testable away from the dispatch loop.
 *
 * @param {object}   args
 * @param {string}   args.agentId       the agent currently polling
 * @param {string[]} args.contenders    every agent that could claim THIS subtask right
 *                                      now (already filtered for eligibility, role, roster)
 * @param {{ranks:string[],strict:boolean}|null} args.priority effective rank (project over global)
 * @param {number|null} args.queuedSinceMs epoch ms the subtask has been waiting since
 * @param {number}   args.nowMs
 * @param {number}   args.graceMs       non-strict grace window; 0 disables it
 * @returns {{yield: boolean, reason: string, preferred?: string}}
 */
export function rankPickupDecision({
  agentId,
  contenders = [],
  priority = null,
  queuedSinceMs = null,
  nowMs = Date.now(),
  graceMs = 0,
  fallbackActive = false,
}) {
  // Circuit-breaker rescue is NEVER rank-gated. An agent reaches the claim path
  // through resolveFallbackExecution precisely when it cannot handle the role
  // normally - which means it is absent from its own contender set, so a rank
  // gate would make it yield forever and the rescue path would silently stop
  // working. Caught by audit before this shipped (2026-08-20).
  if (fallbackActive) return { yield: false, reason: 'circuit-breaker-fallback' };

  const idx = rankIndexOf(priority);
  // No ranks configured: behave exactly as before, no gate.
  if (!idx) return { yield: false, reason: 'no-ranks' };

  const strict = priority.strict === true;

  // Non-strict: after the grace window any eligible agent may claim, so a top
  // rank that is eligible but never polls cannot starve the queue. Strict mode
  // deliberately has no escape - the operator accepted that risk.
  if (!strict && graceMs > 0 && Number.isFinite(queuedSinceMs)
      && (nowMs - queuedSinceMs) > graceMs) {
    return { yield: false, reason: 'grace-expired' };
  }

  const ordered = prioritizeCandidates(contenders, priority);
  // Strict with no ranked contender: the project queues for its ranked agents.
  if (ordered.length === 0) return { yield: true, reason: 'strict-no-ranked-contender' };
  if (ordered[0] !== agentId) {
    return { yield: true, reason: 'higher-ranked-available', preferred: ordered[0] };
  }
  return { yield: false, reason: 'top-ranked' };
}
