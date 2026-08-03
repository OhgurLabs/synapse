/**
 * Prometheus Registry
 *
 * Renders metrics in Prometheus text exposition format (version 0.0.4).
 * Provides a renderMetrics() function that returns valid Prometheus text
 * containing all required metric families, even when collectors are not initialized.
 */

/**
 * Render metrics in Prometheus text exposition format.
 *
 * Returns valid Prometheus format text containing six metric families:
 * - dispatch_duration_seconds (histogram): Duration of agent dispatches
 * - circuit_breaker_state (gauge): Circuit breaker state per service (0=closed, 1=half_open, 2=open)
 * - handoff_total (counter): Total handoffs by status
 * - deliberation_total (counter): Total deliberations by outcome
 * - alert_firing (gauge): Currently firing alerts by severity (0=not firing, 1=firing)
 * - agent_health_status (gauge): Agent health status (0=unhealthy, 1=healthy)
 *
 * If collectors are not provided, returns valid Prometheus output with zero-valued metrics.
 *
 * @param {Object} collectors - Optional collectors object from prometheus-collectors
 * @returns {string} Prometheus text format (version 0.0.4)
 */
export function renderMetrics(collectors) {
  const lines = [];

  // Prometheus text format header comments
  lines.push('# Prometheus metrics for Synapse multi-agent orchestrator');
  lines.push('');

  // ===== 1. dispatch_duration_seconds (histogram) =====
  lines.push('# HELP dispatch_duration_seconds Duration of agent dispatches in seconds');
  lines.push('# TYPE dispatch_duration_seconds histogram');

  if (collectors?.dispatchDuration) {
    // Render actual histogram data from collectors
    const histogramData = collectors.dispatchDuration;

    // Histogram buckets (standard buckets: 0.1, 0.5, 1, 5, 10, 30, 60, +Inf)
    const buckets = [0.1, 0.5, 1, 5, 10, 30, 60];

    // Group by labels if available
    const labelGroups = histogramData.byLabels || [{ labels: {}, buckets: {}, sum: 0, count: 0 }];

    for (const group of labelGroups) {
      const labelStr = formatLabels(group.labels);

      // Render buckets
      for (const le of buckets) {
        const count = group.buckets[le] || 0;
        lines.push(`dispatch_duration_seconds_bucket${labelStr ? `{${labelStr},le="${le}"}` : `{le="${le}"}`} ${count}`);
      }

      // +Inf bucket (total count)
      lines.push(`dispatch_duration_seconds_bucket${labelStr ? `{${labelStr},le="+Inf"}` : `{le="+Inf"}`} ${group.count || 0}`);

      // Sum and count
      lines.push(`dispatch_duration_seconds_sum${labelStr ? `{${labelStr}}` : ''} ${group.sum || 0}`);
      lines.push(`dispatch_duration_seconds_count${labelStr ? `{${labelStr}}` : ''} ${group.count || 0}`);
    }
  } else {
    // No collectors - return zero-valued histogram
    const buckets = [0.1, 0.5, 1, 5, 10, 30, 60];
    for (const le of buckets) {
      lines.push(`dispatch_duration_seconds_bucket{le="${le}"} 0`);
    }
    lines.push(`dispatch_duration_seconds_bucket{le="+Inf"} 0`);
    lines.push(`dispatch_duration_seconds_sum 0`);
    lines.push(`dispatch_duration_seconds_count 0`);
  }
  lines.push('');

  // ===== 2. circuit_breaker_state (gauge) =====
  lines.push('# HELP circuit_breaker_state Circuit breaker state per service (0=closed, 1=half_open, 2=open)');
  lines.push('# TYPE circuit_breaker_state gauge');

  if (collectors?.circuitBreakerState) {
    // Render actual circuit breaker states
    const states = collectors.circuitBreakerState;

    for (const [service, state] of Object.entries(states)) {
      const stateValue = stateToNumber(state);
      lines.push(`circuit_breaker_state{service="${escapeLabel(service)}"} ${stateValue}`);
    }

    // If no services, add a placeholder
    if (Object.keys(states).length === 0) {
      lines.push('# No circuit breakers registered');
    }
  } else {
    // No collectors - return zero-valued gauge
    lines.push('# No circuit breakers registered');
  }
  lines.push('');

  // ===== 3. handoff_total (counter) =====
  lines.push('# HELP handoff_total Total number of handoffs by status');
  lines.push('# TYPE handoff_total counter');

  if (collectors?.handoffTotal) {
    // Render actual handoff counts
    const handoffs = collectors.handoffTotal;

    for (const [status, count] of Object.entries(handoffs)) {
      lines.push(`handoff_total{status="${escapeLabel(status)}"} ${count}`);
    }

    // If no handoffs, add zero values for common statuses
    if (Object.keys(handoffs).length === 0) {
      lines.push('handoff_total{status="success"} 0');
      lines.push('handoff_total{status="failure"} 0');
    }
  } else {
    // No collectors - return zero-valued counter
    lines.push('handoff_total{status="success"} 0');
    lines.push('handoff_total{status="failure"} 0');
  }
  lines.push('');

  // ===== 4. deliberation_total (counter) =====
  lines.push('# HELP deliberation_total Total number of deliberations by outcome');
  lines.push('# TYPE deliberation_total counter');

  if (collectors?.deliberationTotal) {
    // Render actual deliberation counts
    const deliberations = collectors.deliberationTotal;

    for (const [outcome, count] of Object.entries(deliberations)) {
      lines.push(`deliberation_total{outcome="${escapeLabel(outcome)}"} ${count}`);
    }

    // If no deliberations, add zero values for common outcomes
    if (Object.keys(deliberations).length === 0) {
      lines.push('deliberation_total{outcome="consensus"} 0');
      lines.push('deliberation_total{outcome="timeout"} 0');
      lines.push('deliberation_total{outcome="failure"} 0');
    }
  } else {
    // No collectors - return zero-valued counter
    lines.push('deliberation_total{outcome="consensus"} 0');
    lines.push('deliberation_total{outcome="timeout"} 0');
    lines.push('deliberation_total{outcome="failure"} 0');
  }
  lines.push('');

  // ===== 5. alert_firing (gauge) =====
  lines.push('# HELP alert_firing Currently firing alerts by severity (0=not firing, 1=firing)');
  lines.push('# TYPE alert_firing gauge');

  if (collectors?.alertFiring) {
    // Render actual alert states
    const alerts = collectors.alertFiring;

    for (const [severity, firing] of Object.entries(alerts)) {
      lines.push(`alert_firing{severity="${escapeLabel(severity)}"} ${firing ? 1 : 0}`);
    }

    // If no alerts, add zero values for common severities
    if (Object.keys(alerts).length === 0) {
      lines.push('alert_firing{severity="critical"} 0');
      lines.push('alert_firing{severity="warning"} 0');
      lines.push('alert_firing{severity="info"} 0');
    }
  } else {
    // No collectors - return zero-valued gauge
    lines.push('alert_firing{severity="critical"} 0');
    lines.push('alert_firing{severity="warning"} 0');
    lines.push('alert_firing{severity="info"} 0');
  }
  lines.push('');

  // ===== 6. agent_health_status (gauge) =====
  lines.push('# HELP agent_health_status Agent health status by agent (0=unhealthy, 1=healthy)');
  lines.push('# TYPE agent_health_status gauge');

  if (collectors?.agentHealthStatus) {
    // Render actual agent health
    const agents = collectors.agentHealthStatus;

    for (const [agentId, healthy] of Object.entries(agents)) {
      lines.push(`agent_health_status{agent="${escapeLabel(agentId)}"} ${healthy ? 1 : 0}`);
    }

    // If no agents, add a placeholder
    if (Object.keys(agents).length === 0) {
      lines.push('# No agents registered');
    }
  } else {
    // No collectors - return zero-valued gauge
    lines.push('# No agents registered');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Convert circuit breaker state string to numeric value.
 * @param {string} state - State string (closed, half_open, open)
 * @returns {number} Numeric value (0=closed, 1=half_open, 2=open)
 */
function stateToNumber(state) {
  const normalized = String(state).toLowerCase().replace('-', '_').replace(' ', '_');

  if (normalized === 'closed') return 0;
  if (normalized === 'half_open' || normalized === 'halfopen') return 1;
  if (normalized === 'open') return 2;

  // Unknown state, return 0
  return 0;
}

/**
 * Escape label values for Prometheus format.
 * Escapes backslashes, newlines, and double quotes.
 * @param {string} value - Label value to escape
 * @returns {string} Escaped label value
 */
function escapeLabel(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

/**
 * Format label object into Prometheus label string.
 * @param {Object} labels - Label key-value pairs
 * @returns {string} Formatted label string (e.g., 'key1="value1",key2="value2"')
 */
function formatLabels(labels) {
  if (!labels || Object.keys(labels).length === 0) {
    return '';
  }

  const parts = [];
  for (const [key, value] of Object.entries(labels)) {
    parts.push(`${key}="${escapeLabel(value)}"`);
  }

  return parts.join(',');
}
