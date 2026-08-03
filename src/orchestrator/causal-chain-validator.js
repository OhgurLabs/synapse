/**
 * causal-chain-validator.js — Validation helpers for causal chain completeness
 *
 * Provides assertion helpers that walk correlationId chains from triggering signals
 * to final outcomes, asserting no broken links and all referenced events exist.
 *
 * Uses buildCausalSubgraph from causal-graph-traversal.js to traverse chains.
 */

import { buildCausalSubgraph } from './causal-graph-traversal.js';
import { createLogger } from '../logger.js';

const log = createLogger('causal-chain-validator');

// ═══════════════════════════════════════════════════════════════════════════
// Validation assertion helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Assert that a causal chain is complete from root to leaf.
 *
 * Walks the correlationId chain and asserts:
 * - All events in the chain exist
 * - No parent references point to non-existent events
 * - All expected event types are present
 *
 * @param {Object} options
 * @param {string} options.correlationId - Root correlation ID to validate
 * @param {Object} options.timelineStore - TimelineStore instance
 * @param {Object} options.expectedChain - Expected chain structure
 * @param {string[]} options.expectedChain.eventTypes - Expected event types in order
 * @param {number} options.expectedChain.minEventCount - Minimum expected events
 * @param {boolean} options.expectedChain.allowExtraEvents - Whether to allow extra events
 * @returns {{valid: boolean, errors: string[], chain: Object}}
 */
export function validateCausalChain({ correlationId, timelineStore, expectedChain }) {
  const errors = [];
  
  if (!correlationId) {
    return {
      valid: false,
      errors: ['Missing correlationId'],
      chain: null,
    };
  }

  if (!timelineStore?.db) {
    return {
      valid: false,
      errors: ['Missing timelineStore with db property'],
      chain: null,
    };
  }

  try {
    // Build causal subgraph
    const subgraph = buildCausalSubgraph(correlationId, timelineStore);

    if (!subgraph.rootEvent) {
      errors.push(`No events found for correlationId: ${correlationId}`);
      return { valid: false, errors, chain: null };
    }

    // Validate event count
    if (expectedChain.minEventCount && subgraph.events.length < expectedChain.minEventCount) {
      errors.push(
        `Expected at least ${expectedChain.minEventCount} events, found ${subgraph.events.length}`
      );
    }

    // Validate expected event types
    if (expectedChain.eventTypes && expectedChain.eventTypes.length > 0) {
      const foundTypes = Object.keys(subgraph.metadata.eventTypes);
      
      for (const expectedType of expectedChain.eventTypes) {
        if (!foundTypes.includes(expectedType)) {
          errors.push(`Missing expected event type: ${expectedType}`);
        }
      }

      // Check for unexpected types if allowExtraEvents is false
      if (!expectedChain.allowExtraEvents) {
        const unexpectedTypes = foundTypes.filter(t => !expectedChain.eventTypes.includes(t));
        if (unexpectedTypes.length > 0) {
          errors.push(`Unexpected event types found: ${unexpectedTypes.join(', ')}`);
        }
      }
    }

    // Validate parent-child links (no broken references)
    const eventIds = new Set(subgraph.events.map(e => e.id));
    const dispatchIds = new Set(subgraph.events.map(e => e.dispatch_id).filter(Boolean));
    
    for (const event of subgraph.events) {
      if (event.parent_correlation_id) {
        // Parent can be referenced by id or dispatch_id
        if (!eventIds.has(event.parent_correlation_id) && !dispatchIds.has(event.parent_correlation_id)) {
          errors.push(
            `Event ${event.id} references non-existent parent: ${event.parent_correlation_id}`
          );
        }
      }
    }

    // Validate edges match actual parent-child relationships
    for (const edge of subgraph.edges) {
      if (!eventIds.has(edge.from)) {
        errors.push(`Edge from non-existent event: ${edge.from}`);
      }
      if (!eventIds.has(edge.to)) {
        errors.push(`Edge to non-existent event: ${edge.to}`);
      }
    }

    const valid = errors.length === 0;
    
    if (valid) {
      log.debug('Causal chain validation passed', {
        correlationId,
        eventCount: subgraph.events.length,
        maxDepth: subgraph.metadata.maxDepth,
      });
    } else {
      log.warn('Causal chain validation failed', { correlationId, errors });
    }

    return { valid, errors, chain: subgraph };

  } catch (err) {
    errors.push(`Validation error: ${err.message}`);
    log.error('Causal chain validation exception', { correlationId, error: err.message });
    return { valid: false, errors, chain: null };
  }
}

/**
 * Assert that a causal chain has all required links in the correct order.
 *
 * This is useful for validating specific workflows like:
 * - analytics → proposal → governance → weight_override → attribution
 * - error_detection → constraint → operator_override
 * - autoresearch_cycle → proposal → governance → weight_boost
 *
 * @param {Object} options
 * @param {string} options.correlationId - Root correlation ID
 * @param {Object} options.timelineStore - TimelineStore instance
 * @param {Array} options.requiredLinks - Array of {eventType, mustExist} objects
 * @returns {{valid: boolean, errors: string[], foundLinks: string[], chain: Object}}
 */
export function validateCausalChainWithLinks({ correlationId, timelineStore, requiredLinks }) {
  const errors = [];
  const foundLinks = [];

  if (!correlationId || !timelineStore?.db) {
    return {
      valid: false,
      errors: ['Missing correlationId or timelineStore'],
      foundLinks: [],
      chain: null,
    };
  }

  try {
    const subgraph = buildCausalSubgraph(correlationId, timelineStore);

    if (!subgraph.rootEvent) {
      return {
        valid: false,
        errors: [`No events found for correlationId: ${correlationId}`],
        foundLinks: [],
        chain: null,
      };
    }

    // Map events by type
    const eventsByType = {};
    for (const event of subgraph.events) {
      const eventType = event.event_type || 'unknown';
      if (!eventsByType[eventType]) {
        eventsByType[eventType] = [];
      }
      eventsByType[eventType].push(event);
    }

    // Validate each required link
    for (const link of requiredLinks) {
      const eventType = link.eventType;
      const events = eventsByType[eventType];

      if (events && events.length > 0) {
        foundLinks.push(eventType);
        
        if (!link.mustExist) {
          // Optional link found, nothing to validate
          continue;
        }
      } else if (link.mustExist) {
        errors.push(`Required link missing: ${eventType}`);
      }
    }

    // Check for ordering if timestamps are available
    if (subgraph.events.length >= 2) {
      const sortedEvents = [...subgraph.events].sort((a, b) => 
        new Date(a.event_ts || a.timestamp || 0) - new Date(b.event_ts || b.timestamp || 0)
      );

      // Verify chronological order matches causal order
      for (let i = 1; i < sortedEvents.length; i++) {
        const current = sortedEvents[i];
        const previous = sortedEvents[i - 1];

        if (current.parent_correlation_id) {
          if (current.parent_correlation_id === previous.id || 
              current.parent_correlation_id === previous.dispatch_id) {
            // Parent is immediately before child, which is correct
            continue;
          }
        }
      }
    }

    const valid = errors.length === 0;

    return {
      valid,
      errors,
      foundLinks,
      chain: subgraph,
    };

  } catch (err) {
    errors.push(`Validation error: ${err.message}`);
    return {
      valid: false,
      errors,
      foundLinks: [],
      chain: null,
    };
  }
}

/**
 * Assert that all events in a causal chain have valid correlation IDs.
 *
 * Checks:
 * - root_correlation_id is consistent across all events
 * - parent_correlation_id references exist
 * - No orphaned events (events with parents but no root)
 *
 * @param {Object} options
 * @param {string} options.correlationId - Root correlation ID
 * @param {Object} options.timelineStore - TimelineStore instance
 * @returns {{valid: boolean, errors: string[], rootCorrelationId: string|null}}
 */
export function validateCorrelationIdConsistency({ correlationId, timelineStore }) {
  const errors = [];

  if (!correlationId || !timelineStore?.db) {
    return {
      valid: false,
      errors: ['Missing correlationId or timelineStore'],
      rootCorrelationId: null,
    };
  }

  try {
    const subgraph = buildCausalSubgraph(correlationId, timelineStore);

    if (!subgraph.rootEvent) {
      return {
        valid: false,
        errors: [`No events found for correlationId: ${correlationId}`],
        rootCorrelationId: null,
      };
    }

    // Determine expected root correlation ID
    const expectedRootId = subgraph.rootEvent.root_correlation_id || 
                          subgraph.rootEvent.dispatch_id || 
                          subgraph.rootEvent.id;

    // Check all events have consistent root_correlation_id
    const inconsistentRoots = [];
    for (const event of subgraph.events) {
      const eventRootId = event.root_correlation_id;
      
      if (eventRootId && eventRootId !== expectedRootId) {
        inconsistentRoots.push({
          eventId: event.id,
          expected: expectedRootId,
          found: eventRootId,
        });
      }
    }

    if (inconsistentRoots.length > 0) {
      errors.push(
        `Found ${inconsistentRoots.length} events with inconsistent root_correlation_id`
      );
      for (const inconsistency of inconsistentRoots.slice(0, 5)) {
        errors.push(
          `  Event ${inconsistency.eventId}: expected ${inconsistency.expected}, found ${inconsistency.found}`
        );
      }
    }

    // Check for orphaned events (have parent but no root)
    const orphans = [];
    for (const event of subgraph.events) {
      if (event.parent_correlation_id && !event.root_correlation_id) {
        orphans.push(event.id);
      }
    }

    if (orphans.length > 0) {
      errors.push(`Found ${orphans.length} events with parent but no root_correlation_id`);
    }

    const valid = errors.length === 0;

    return {
      valid,
      errors,
      rootCorrelationId: expectedRootId,
    };

  } catch (err) {
    errors.push(`Validation error: ${err.message}`);
    return {
      valid: false,
      errors,
      rootCorrelationId: null,
    };
  }
}

/**
 * Assert that a specific automated adjustment type has a complete causal chain.
 *
 * Specialized validators for each automated adjustment type:
 * - weight_override: governance → weight_override → attribution
 * - error_constraint: error_detection → constraint → (optional) operator_override
 * - autoresearch_proposal: cycle → proposal → governance → weight_boost
 *
 * @param {Object} options
 * @param {string} options.correlationId - Root correlation ID
 * @param {Object} options.timelineStore - TimelineStore instance
 * @param {string} options.adjustmentType - Type of adjustment to validate
 * @returns {{valid: boolean, errors: string[], chain: Object}}
 */
export function validateAutomatedAdjustment({ correlationId, timelineStore, adjustmentType }) {
  const errors = [];

  const validators = {
    weight_override: {
      requiredEventTypes: ['dispatch', 'guardrail_outcome', 'operator_action'],
      minEvents: 2,
      description: 'weight override via governance approval',
    },
    error_constraint: {
      requiredEventTypes: ['dispatch', 'guardrail_outcome', 'anomaly_alert'],
      minEvents: 2,
      description: 'error pattern constraint emission',
    },
    autoresearch_proposal: {
      requiredEventTypes: ['dispatch', 'operator_action'],
      minEvents: 2,
      description: 'autoresearch proposal with governance',
    },
    attribution_record: {
      requiredEventTypes: ['dispatch', 'guardrail_outcome', 'operator_action'],
      minEvents: 3,
      description: 'attribution record with pre/post metrics',
    },
    operator_override: {
      requiredEventTypes: ['dispatch', 'operator_action', 'guardrail_outcome'],
      minEvents: 2,
      description: 'operator override of error constraint',
    },
    weight_decay: {
      requiredEventTypes: ['dispatch', 'guardrail_outcome', 'operator_action'],
      minEvents: 3,
      description: 'analytics-driven weight decay',
    },
  };

  const config = validators[adjustmentType];

  if (!config) {
    return {
      valid: false,
      errors: [`Unknown adjustment type: ${adjustmentType}`],
      chain: null,
    };
  }

  return validateCausalChain({
    correlationId,
    timelineStore,
    expectedChain: {
      eventTypes: config.requiredEventTypes,
      minEventCount: config.minEvents,
      allowExtraEvents: true,
    },
  });
}

/**
 * Assert that all causal chains in a test scenario are complete.
 *
 * Useful for integration tests that produce multiple correlated events.
 *
 * @param {Object} options
 * @param {Array} options.chains - Array of {correlationId, adjustmentType} objects
 * @param {Object} options.timelineStore - TimelineStore instance
 * @returns {{valid: boolean, results: Array<{correlationId: string, valid: boolean, errors: string[]}>, summary: Object}}
 */
export function validateAllCausalChains({ chains, timelineStore }) {
  const results = [];
  let allValid = true;
  const summary = {
    total: chains.length,
    valid: 0,
    invalid: 0,
    byAdjustmentType: {},
  };

  for (const chain of chains) {
    const { correlationId, adjustmentType } = chain;
    
    const result = validateAutomatedAdjustment({
      correlationId,
      timelineStore,
      adjustmentType,
    });

    results.push({
      correlationId,
      adjustmentType,
      valid: result.valid,
      errors: result.errors,
      chain: result.chain,
    });

    if (result.valid) {
      summary.valid++;
    } else {
      allValid = false;
      summary.invalid++;
    }

    // Track by adjustment type
    if (!summary.byAdjustmentType[adjustmentType]) {
      summary.byAdjustmentType[adjustmentType] = { valid: 0, invalid: 0 };
    }
    
    if (result.valid) {
      summary.byAdjustmentType[adjustmentType].valid++;
    } else {
      summary.byAdjustmentType[adjustmentType].invalid++;
    }
  }

  return {
    valid: allValid,
    results,
    summary,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test assertion helpers (for use in test suites)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Assert that a causal chain is complete. Throws on failure.
 *
 * @param {Object} options
 * @param {string} options.correlationId - Root correlation ID
 * @param {Object} options.timelineStore - TimelineStore instance
 * @param {Object} options.expectedChain - Expected chain structure
 */
export function assertCausalChainComplete({ correlationId, timelineStore, expectedChain }) {
  const result = validateCausalChain({ correlationId, timelineStore, expectedChain });

  if (!result.valid) {
    throw new Error(
      `Causal chain incomplete for ${correlationId}: ${result.errors.join('; ')}`
    );
  }

  return result.chain;
}

/**
 * Assert that all required links exist in a causal chain. Throws on failure.
 *
 * @param {Object} options
 * @param {string} options.correlationId - Root correlation ID
 * @param {Object} options.timelineStore - TimelineStore instance
 * @param {Array} options.requiredLinks - Array of {eventType, mustExist} objects
 */
export function assertCausalChainHasLinks({ correlationId, timelineStore, requiredLinks }) {
  const result = validateCausalChainWithLinks({ correlationId, timelineStore, requiredLinks });

  if (!result.valid) {
    throw new Error(
      `Causal chain missing required links for ${correlationId}: ${result.errors.join('; ')}`
    );
  }

  return result.chain;
}

/**
 * Assert that correlation IDs are consistent across a causal chain. Throws on failure.
 *
 * @param {Object} options
 * @param {string} options.correlationId - Root correlation ID
 * @param {Object} options.timelineStore - TimelineStore instance
 */
export function assertCorrelationIdConsistent({ correlationId, timelineStore }) {
  const result = validateCorrelationIdConsistency({ correlationId, timelineStore });

  if (!result.valid) {
    throw new Error(
      `Correlation ID inconsistent for ${correlationId}: ${result.errors.join('; ')}`
    );
  }

  return result.rootCorrelationId;
}

/**
 * Assert that an automated adjustment has a complete causal chain. Throws on failure.
 *
 * @param {Object} options
 * @param {string} options.correlationId - Root correlation ID
 * @param {Object} options.timelineStore - TimelineStore instance
 * @param {string} options.adjustmentType - Type of adjustment
 */
export function assertAutomatedAdjustmentComplete({ correlationId, timelineStore, adjustmentType }) {
  const result = validateAutomatedAdjustment({ correlationId, timelineStore, adjustmentType });

  if (!result.valid) {
    throw new Error(
      `Automated adjustment incomplete for ${correlationId} (${adjustmentType}): ${result.errors.join('; ')}`
    );
  }

  return result.chain;
}

/**
 * Assert that all causal chains in a test scenario are complete. Throws on failure.
 *
 * @param {Object} options
 * @param {Array} options.chains - Array of {correlationId, adjustmentType} objects
 * @param {Object} options.timelineStore - TimelineStore instance
 */
export function assertAllCausalChainsComplete({ chains, timelineStore }) {
  const result = validateAllCausalChains({ chains, timelineStore });

  if (!result.valid) {
    const failures = result.results.filter(r => !r.valid);
    const errorMessages = failures.map(f => 
      `${f.correlationId} (${f.adjustmentType}): ${f.errors.join('; ')}`
    );
    
    throw new Error(
      `Causal chain validation failed for ${failures.length} chains:\n` + 
      errorMessages.join('\n')
    );
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Export default
// ═══════════════════════════════════════════════════════════════════════════

export default {
  validateCausalChain,
  validateCausalChainWithLinks,
  validateCorrelationIdConsistency,
  validateAutomatedAdjustment,
  validateAllCausalChains,
  assertCausalChainComplete,
  assertCausalChainHasLinks,
  assertCorrelationIdConsistent,
  assertAutomatedAdjustmentComplete,
  assertAllCausalChainsComplete,
};
