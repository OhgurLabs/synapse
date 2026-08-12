// agent-priority.js — per-project agent priority (#105).
// Design: vault/design/project-agent-priority.md. Roster answers who MAY
// work on a project; priority answers in what ORDER; strict collapses the
// candidate set to the single highest-ranked eligible agent (existing
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
