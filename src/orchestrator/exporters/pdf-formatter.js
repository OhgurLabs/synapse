/**
 * PDF Formatters - Report data builders for PDF export
 * 
 * Transform raw events into structured report data for PDF templates.
 */

/**
 * Build activity summary report data from events
 * @param {Object[]} events - Array of events
 * @returns {Object} Report data
 */
export function buildActivitySummaryReport(events = []) {
  const summary = {
    totalEvents: events.length,
    successRate: 0,
    errorRate: 0,
  };

  const agentStats = {};
  const decisions = [];

  for (const event of events) {
    const agentId = event.agent_id || event.agentId || 'unknown';
    
    if (!agentStats[agentId]) {
      agentStats[agentId] = {
        agentId,
        totalDispatches: 0,
        successes: 0,
        failures: 0,
      };
    }

    agentStats[agentId].totalDispatches++;

    // Track success/failure from routing events
    if (event.export_type === 'routing' || event.type === 'routing') {
      const outcome = event.data?.outcome || event.outcome;
      if (outcome === 'success') {
        agentStats[agentId].successes++;
        summary.successes = (summary.successes || 0) + 1;
      } else if (outcome === 'failed' || outcome === 'failure') {
        agentStats[agentId].failures++;
        summary.failures = (summary.failures || 0) + 1;
      }
    }

    // Collect decision trail entries
    if (event.selection_reason || event.reasoning || event.outcome) {
      decisions.push({
        timestamp: event.event_ts || event.timestamp,
        agentId,
        summary: event.outcome || event.selection_reason || 'Decision',
        reasoning: event.selection_reason || event.reasoning || '',
      });
    }
  }

  // Calculate rates
  if (summary.totalEvents > 0) {
    const totalOutcomes = summary.successes + summary.failures;
    if (totalOutcomes > 0) {
      summary.successRate = summary.successes / totalOutcomes;
      summary.errorRate = summary.failures / totalOutcomes;
    }
  }

  // Build agent breakdown
  const agentBreakdown = Object.values(agentStats).map((stats) => ({
    ...stats,
    successRate:
      stats.totalDispatches > 0
        ? stats.successes / stats.totalDispatches
        : 0,
    errors: stats.failures,
  }));

  // Sort by total dispatches descending
  agentBreakdown.sort((a, b) => b.totalDispatches - a.totalDispatches);

  return {
    summary,
    agentBreakdown,
    decisionTrail: decisions.slice(0, 100),
  };
}

/**
 * Build incident timeline report data from events
 * @param {Object[]} events - Array of events
 * @returns {Object} Report data
 */
export function buildIncidentTimelineReport(events = []) {
  const incidents = [];
  const timelineEvents = [];

  for (const event of events) {
    const event_ts = event.event_ts || event.timestamp;
    const agentId = event.agent_id || event.agentId || 'unknown';
    const traceId = event.trace_id || event.traceId || null;

    // Categorize events as incidents or timeline events
    if (
      event.severity === 'critical' ||
      event.severity === 'high' ||
      event.outcome === 'block' ||
      event.new_state === 'open'
    ) {
      // This is an incident
      incidents.push({
        severity: event.severity || 'warning',
        title: event.anomaly_type || event.rule_name || 'Incident',
        summary: event.detail || event.outcome || 'Event occurred',
        timestamp: event_ts,
        agentId,
        traceId,
        description: event.detail || event.reasoning || null,
        reasoning: event.selection_reason || event.reasoning || null,
        failureChain: event.errorChain || event.propagationChain || null,
      });
    } else {
      // Regular timeline event
      timelineEvents.push({
        type: event.export_type || event.type || 'unknown',
        timestamp: event_ts,
        agentId,
        traceId,
        summary: event.outcome || event.selection_reason || null,
        reasoning: event.reasoning || null,
      });
    }
  }

  // Sort incidents by timestamp descending
  incidents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Sort timeline events by timestamp descending
  timelineEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return {
    incidents,
    timelineEvents,
  };
}

export default {
  buildActivitySummaryReport,
  buildIncidentTimelineReport,
};
