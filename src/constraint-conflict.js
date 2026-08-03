// Constraint conflict detection — simulates routing with proposed constraints
// to detect deadlocks before they block real dispatches.

import { ROUTING_MATRIX, applyConstraints } from './router.js';

/**
 * Convert constraint from {type, value, id} format to flat format expected by applyConstraints.
 * @param {{ type: string, value: any, id?: string }} constraint
 * @returns {Object} flat constraint { [type]: value, id }
 */
function convertConstraintToFlat(constraint) {
  if (!constraint || !constraint.type) return {};
  return {
    [constraint.type]: constraint.value,
    id: constraint.id || null,
  };
}

/**
 * Build candidate pool for a routing spec.
 * @param {{ role?: string, provider?: string }} spec - primary spec from ROUTING_MATRIX
 * @param {Object} agentRegistry - { id: { provider, role, status, ... } }
 * @returns {string[]} candidate agent IDs
 */
function buildCandidatePool(spec, agentRegistry) {
  if (!spec) return [];

  const allAgents = Object.keys(agentRegistry).filter(
    id => agentRegistry[id]?.status === 'active'
  );

  const nonGovernorAgents = allAgents.filter(id => agentRegistry[id]?.role !== 'governor');

  // role: 'relevance' → all active agents
  if (spec.role === 'relevance') {
    return nonGovernorAgents;
  }

  // role: 'ops' → filter by provider (spec.provider)
  if (spec.role === 'ops') {
    if (spec.provider) {
      return nonGovernorAgents.filter(id => agentRegistry[id]?.provider === spec.provider);
    }
    return nonGovernorAgents;
  }

  // Otherwise: filter by primary.role
  if (spec.role) {
    return allAgents.filter(id => agentRegistry[id]?.role === spec.role);
  }

  // If provider is specified without role, filter by provider
  if (spec.provider) {
    return nonGovernorAgents.filter(id => agentRegistry[id]?.provider === spec.provider);
  }

  return nonGovernorAgents;
}

/**
 * Identify which constraint IDs caused a deadlock for a category.
 * Tests removing each constraint individually to see if it restores candidates.
 * @param {string} category - routing category
 * @param {string[]} candidatePool - base candidate pool
 * @param {Object} agentMap - agent registry
 * @param {Object[]} flatConstraints - merged flat constraints
 * @returns {string[]} constraint IDs that contribute to the deadlock
 */
function identifyDeadlockingConstraints(category, candidatePool, agentMap, flatConstraints) {
  const deadlockingIds = [];
  const constraintIds = flatConstraints.filter(c => c.id).map(c => c.id);

  // If no constraints with IDs, all constraints contribute
  if (constraintIds.length === 0) {
    return [];
  }

  // Test: remove each constraint individually to see if it restores candidates
  for (const constraintId of constraintIds) {
    const withoutThisConstraint = flatConstraints.filter(c => c.id !== constraintId);
    const { filtered } = applyConstraints(candidatePool, agentMap, withoutThisConstraint);

    // If removing this constraint restores candidates, it's a deadlocker
    if (filtered.length > 0) {
      deadlockingIds.push(constraintId);
    }
  }

  // If no constraints individually fix it, all constraints contribute to deadlock
  if (deadlockingIds.length === 0 && flatConstraints.length > 0) {
    return constraintIds;
  }

  return deadlockingIds;
}

/**
 * Build a human-readable diagnostic message for a conflict.
 * @param {string[]} affectedCategories - categories with zero viable agents
 * @param {Object} agentMap - agent registry
 * @param {Object[]} flatConstraints - merged flat constraints
 * @returns {string} diagnostic message
 */
function buildDiagnosticMessage(affectedCategories, agentMap, flatConstraints) {
  const parts = [];

  // Check for require_provider constraints
  const requireProvider = flatConstraints.find(c => c.require_provider);
  if (requireProvider) {
    parts.push(`require_provider(${requireProvider.require_provider})`);
  }

  // Check for exclude_agents constraints
  const excludeLists = flatConstraints
    .filter(c => Array.isArray(c.exclude_agents) && c.exclude_agents.length > 0)
    .map(c => c.exclude_agents);

  if (excludeLists.length > 0) {
    const allExcluded = [...new Set(excludeLists.flat())];
    parts.push(`exclude_agents([${allExcluded.join(', ')}])`);
  }

  const constraintDesc = parts.length > 0
    ? parts.join(' + ')
    : 'constraint combination';

  const categoriesDesc = affectedCategories.length === 1
    ? `category: ${affectedCategories[0]}`
    : `categories: ${affectedCategories.join(', ')}`;

  return `${constraintDesc} removes all viable agents for ${categoriesDesc}`;
}

/**
 * Check if a time_window constraint covers all time (would block routing at all times).
 * For RECURRING: days includes all 7 days AND (startHour: 0, endHour: 23 covers all hours,
 * OR startHour === endHour meaning midnight-wrap covers 24h, OR hours omitted meaning full-day).
 * For ABSOLUTE: (before - after) spans > 7 days.
 * @param {Object} timeWindow - time_window constraint value
 * @returns {boolean} true if the constraint covers all time
 */
function isTimeWindowAllCovering(timeWindow) {
  if (!timeWindow) return false;

  const { type, days, startHour, endHour, after, before } = timeWindow;

  // Handle RECURRING time_window
  if (type === 'recurring') {
    // Check if all 7 days are covered
    const allDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const daysSet = new Set((days || []).map(d => d.toLowerCase()));
    const hasAllDays = allDays.every(day => daysSet.has(day));

    if (!hasAllDays) return false;

    // Check if all 24 hours are covered
    // Case 1: startHour and endHour both present
    if (startHour !== undefined && endHour !== undefined) {
      // startHour === endHour means midnight-wrap (covers 24h)
      if (startHour === endHour) return true;
      // startHour: 0, endHour: 23 covers all hours
      if (startHour === 0 && endHour === 23) return true;
    }
    // Case 2: hours omitted means full-day coverage
    if (startHour === undefined && endHour === undefined) return true;

    return false;
  }

  // Handle ABSOLUTE time_window
  if (type === 'absolute') {
    // Check if (before - after) spans more than 7 days
    if (after !== undefined && before !== undefined) {
      const afterDate = new Date(after);
      const beforeDate = new Date(before);
      const diffMs = beforeDate.getTime() - afterDate.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays > 7) return true;
    }
    return false;
  }

  return false;
}

/**
 * Check if multiple time_window constraints together create full coverage.
 * Currently handles RECURRING time_windows; simplified check for combined coverage.
 * @param {Array<{id: string, value: Object}>} activeTimeWindows - active time_window constraints
 * @param {{id: string, value: Object}} proposedTimeWindow - proposed time_window constraint
 * @returns {null|{conflict: boolean, diagnostic: string, affectedCategories: string[], deadlockedBy: string[]}}
 */
function detectCombinedTimeWindowConflict(activeTimeWindows, proposedTimeWindow) {
  const allTimeWindows = [...activeTimeWindows, proposedTimeWindow];

  // Collect all recurring time_windows
  const recurringWindows = allTimeWindows.filter(tw => tw.value?.type === 'recurring');

  if (recurringWindows.length === 0) {
    return null; // No recurring windows to combine
  }

  // Union all days covered by recurring windows
  const allDayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const coveredDays = new Set();

  for (const tw of recurringWindows) {
    const days = tw.value.days || [];
    days.forEach(day => coveredDays.add(day.toLowerCase()));
  }

  // Check if all 7 days are covered
  const hasAllDays = allDayNames.every(day => coveredDays.has(day));
  if (!hasAllDays) {
    return null; // Not all days covered, can't be full blockage
  }

  // Check if all hours are covered
  // Simplified: check if any window covers all hours, or if combined ranges create full coverage
  let hasFullHourCoverage = false;

  // Check if any single window covers all hours
  for (const tw of recurringWindows) {
    const { startHour, endHour } = tw.value;

    // Hours omitted = full day
    if (startHour === undefined && endHour === undefined) {
      hasFullHourCoverage = true;
      break;
    }

    // startHour === endHour means midnight-wrap (24h)
    if (startHour === endHour) {
      hasFullHourCoverage = true;
      break;
    }

    // startHour: 0, endHour: 23 covers all hours
    if (startHour === 0 && endHour === 23) {
      hasFullHourCoverage = true;
      break;
    }
  }

  // If we have all days covered and all hours covered, it's a conflict
  if (hasFullHourCoverage) {
    const deadlockingIds = allTimeWindows.map(tw => tw.id).filter(id => id != null);
    return {
      conflict: true,
      diagnostic: 'combined time_window constraints cover all hours on all days, effectively blocking all routing',
      affectedCategories: ['all'],
      deadlockedBy: deadlockingIds,
    };
  }

  // Check absolute time_windows that together span > 7 days
  const absoluteWindows = allTimeWindows.filter(tw => tw.value?.type === 'absolute');

  if (absoluteWindows.length > 0) {
    // Collect all time ranges
    const ranges = [];
    for (const tw of absoluteWindows) {
      const { after, before } = tw.value;
      if (after !== undefined && before !== undefined) {
        ranges.push({
          id: tw.id,
          start: new Date(after).getTime(),
          end: new Date(before).getTime(),
        });
      }
    }

    // Check if combined ranges span > 7 days
    if (ranges.length > 0) {
      // Sort ranges by start time
      ranges.sort((a, b) => a.start - b.start);

      // Merge overlapping/adjacent ranges
      const merged = [ranges[0]];
      for (let i = 1; i < ranges.length; i++) {
        const current = ranges[i];
        const last = merged[merged.length - 1];

        // If ranges overlap or are adjacent, merge them
        if (current.start <= last.end) {
          last.end = Math.max(last.end, current.end);
          if (!last.ids) last.ids = [last.id];
          last.ids.push(current.id);
        } else {
          merged.push(current);
        }
      }

      // Check if any merged range spans > 7 days
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      for (const range of merged) {
        const span = range.end - range.start;
        if (span > sevenDaysMs) {
          const deadlockingIds = (range.ids || [range.id]).filter(id => id != null);
          return {
            conflict: true,
            diagnostic: 'combined time_window constraints span more than 7 days, effectively blocking all routing',
            affectedCategories: ['all'],
            deadlockedBy: deadlockingIds,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Detect if a proposed constraint would create routing deadlocks.
 * Simulates routing for all task categories with the proposed constraint applied.
 *
 * @param {Object} agentRegistry - agent map { id: { provider, role, status, ... } }
 * @param {Object[]} activeConstraints - existing constraints in {type, value, id} format
 * @param {Object} proposedConstraint - new constraint in {type, value, id} format
 * @returns {null|{conflict: boolean, diagnostic: string, affectedCategories: string[], deadlockedBy: string[]}}
 */
export function detectConstraintConflict(agentRegistry, activeConstraints, proposedConstraint) {
  if (!agentRegistry || !proposedConstraint) {
    return null;
  }

  // Skip non-routing constraint types — they don't affect agent selection
  // error_pattern_penalty adjusts weights but never removes candidates, so it cannot deadlock
  const nonRoutingTypes = ['pause_campaign', 'max_concurrent', 'priority_override', 'error_pattern_penalty'];
  if (nonRoutingTypes.includes(proposedConstraint.type)) {
    return null;
  }

  // Check for pathological time_window constraints BEFORE routing simulation
  if (proposedConstraint.type === 'time_window') {
    if (isTimeWindowAllCovering(proposedConstraint.value)) {
      return {
        conflict: true,
        diagnostic: 'time_window covers all hours on all days, effectively blocking all routing',
        affectedCategories: ['all'],
        deadlockedBy: [proposedConstraint.id],
      };
    }

    // Check for combined time_window constraints that together create full coverage
    const activeTimeWindows = (activeConstraints || [])
      .filter(c => c.type === 'time_window')
      .map(c => ({ id: c.id, value: c.value }));

    if (activeTimeWindows.length > 0) {
      const combinedConflict = detectCombinedTimeWindowConflict(
        activeTimeWindows,
        { id: proposedConstraint.id, value: proposedConstraint.value }
      );

      if (combinedConflict) {
        return combinedConflict;
      }
    }
  }

  // Convert constraints to flat format
  // Exclude time_window constraints from routing simulation since they're validated separately
  const flatActive = (activeConstraints || [])
    .filter(c => c.type !== 'pause_campaign' && c.type !== 'time_window')
    .map(convertConstraintToFlat);

  const flatProposed = proposedConstraint.type === 'time_window'
    ? {}
    : convertConstraintToFlat(proposedConstraint);
  const mergedConstraints = [...flatActive, flatProposed].filter(c => Object.keys(c).length > 0);

  const affectedCategories = [];
  const deadlockMap = new Map(); // category → deadlocking constraint IDs

  // Test each category in ROUTING_MATRIX (skip 'delegation')
  for (const [category, route] of Object.entries(ROUTING_MATRIX)) {
    if (category === 'delegation') continue;

    const candidatePool = buildCandidatePool(route.primary, agentRegistry);
    const { filtered, paused } = applyConstraints(candidatePool, agentRegistry, mergedConstraints);

    // Deadlock if no viable agents and not paused
    if (filtered.length === 0 && !paused) {
      affectedCategories.push(category);
      const deadlockingIds = identifyDeadlockingConstraints(
        category,
        candidatePool,
        agentRegistry,
        mergedConstraints
      );
      deadlockMap.set(category, deadlockingIds);
    }
  }

  // No conflicts detected
  if (affectedCategories.length === 0) {
    return null;
  }

  // Collect all unique deadlocking constraint IDs
  const allDeadlockingIds = new Set();
  for (const ids of deadlockMap.values()) {
    ids.forEach(id => allDeadlockingIds.add(id));
  }

  const diagnostic = buildDiagnosticMessage(affectedCategories, agentRegistry, mergedConstraints);

  return {
    conflict: true,
    diagnostic,
    affectedCategories,
    deadlockedBy: [...allDeadlockingIds].filter(id => id != null),
  };
}
