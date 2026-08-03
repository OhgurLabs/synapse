// Alert monitor — evaluates health conditions and emits alert:firing / alert:resolved events.

import { join } from 'path';
import { createLogger } from '../logger.js';
import { loadAlertHistory, appendAlertEntry } from './alert-history-store.js';
import { getDb, rowToCampaign, rowToMilestone, stateDbExists } from './state-db.js';

const log = createLogger('alert-monitor');

// Condition thresholds (ms). 0 = immediate.
const THRESHOLDS = {
  'agents-all-down':                    300_000,    // 5 minutes
  'heartbeat-stalled':                  120_000,    // 2 minutes
  'rag-paused':                         0,          // immediate
  'disk-corruption':                    0,          // immediate
  'analytics-signals-stale':            0,          // immediate (staleness already determined by 48h threshold)
  'backup-mirror-stale':                0,          // immediate (staleness already determined by 24h threshold)
  'milestone-approval-pending':         12 * 60 * 60 * 1000,  // 12 hours
  'milestone-approval-timeout':         24 * 60 * 60 * 1000,  // 24 hours
};

// Maps subsystem conditions to their health-subsystems key.
const SUBSYSTEM_MAP = {
  'agents-all-down':      'agents',
  'heartbeat-stalled':    'scheduler',
  'rag-paused':           'rag',
  'backup-mirror-stale':  'backupMirrors',
};

// Severity levels for each alert condition.
const SEVERITY_MAP = {
  'disk-corruption':                'critical',
  'agents-all-down':                'critical',
  'milestone-approval-timeout':     'critical',
  'heartbeat-stalled':              'warning',
  'rag-paused':                     'warning',
  'analytics-signals-stale':         'warning',
  'backup-mirror-stale':             'warning',
  'milestone-approval-pending':      'warning',
};

function getSeverityForCondition(condition) {
  if (SEVERITY_MAP[condition]) {
    return SEVERITY_MAP[condition];
  }
  const baseCondition = condition.split(':')[0];
  if (SEVERITY_MAP[baseCondition]) {
    return SEVERITY_MAP[baseCondition];
  }
  const baseConditionWithPrefix = condition.split(':', 2).join(':');
  if (SEVERITY_MAP[baseConditionWithPrefix]) {
    return SEVERITY_MAP[baseConditionWithPrefix];
  }
  return 'warning';
}

export function createAlertMonitor({ events, stateManager, computeSubsystemStatuses, healthDeps, config, performanceStore, analyticsSignalsStore, filePath } = {}) {
  const activeAlerts = new Map();   // condition → alert object
  const redSince = new Map();       // condition → timestamp first observed red
  const alertHistory = [];          // in-memory array of fired+resolved events (capped at 500)
  const retentionDays = config?.alertMonitor?.retentionDays ?? 7;
  const maxHistorySize = 500;
  let interval = null;

  // Load persisted alert history with retention pruning and activeAlerts reconstruction
  if (filePath) {
    try {
      const loaded = loadAlertHistory(filePath);
      const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);

      // Track fired conditions and their latest alert objects
      const firedConditions = new Map(); // condition → alert object
      const resolvedConditions = new Set(); // conditions that have been resolved

      for (const entry of loaded) {
        const timestamp = new Date(entry.firedAt || entry.resolvedAt).getTime();
        if (timestamp >= cutoff) {
          alertHistory.push(entry);

          // Track fired/resolved state to reconstruct activeAlerts
          if (entry.firedAt) {
            firedConditions.set(entry.condition, entry);
          } else if (entry.resolvedAt) {
            resolvedConditions.add(entry.condition);
          }
        }
      }

      // Reconstruct activeAlerts from unresolved fired entries
      let restoredCount = 0;
      for (const [condition, alert] of firedConditions.entries()) {
        if (!resolvedConditions.has(condition)) {
          activeAlerts.set(condition, alert);
          restoredCount++;
        }
      }

      // Enforce history cap (per learnings: must cap after loading)
      if (alertHistory.length > maxHistorySize) {
        alertHistory.splice(0, alertHistory.length - maxHistorySize);
      }

      log.info('Alert history loaded', {
        total: loaded.length,
        retained: alertHistory.length,
        pruned: loaded.length - alertHistory.length,
        activeAlertsRestored: restoredCount
      });
    } catch (err) {
      log.warn('Failed to load alert history', { filePath, error: err.message });
    }
  }

  function fireAlert(condition, detail) {
    if (activeAlerts.has(condition)) return; // dedup — already firing
    const severity = getSeverityForCondition(condition);
    const alert = { projectId: null, condition, detail, severity, firedAt: new Date().toISOString() };
    activeAlerts.set(condition, alert);
    events.emit('alert:firing', alert);
    log.warn('Alert fired', { condition, detail });

    // Persist to history
    alertHistory.push(alert);
    if (alertHistory.length > maxHistorySize) {
      alertHistory.shift(); // Remove oldest entry
    }
    if (filePath) {
      try {
        appendAlertEntry(filePath, alert);
      } catch (err) {
        log.warn('Failed to persist alert', { condition, error: err.message });
      }
    }
  }

  function resolveAlert(condition) {
    if (!activeAlerts.has(condition)) return;
    activeAlerts.delete(condition);
    const payload = { projectId: null, condition, resolvedAt: new Date().toISOString() };
    events.emit('alert:resolved', payload);
    log.info('Alert resolved', { condition });

    // Persist to history
    alertHistory.push(payload);
    if (alertHistory.length > maxHistorySize) {
      alertHistory.shift(); // Remove oldest entry
    }
    if (filePath) {
      try {
        appendAlertEntry(filePath, payload);
      } catch (err) {
        log.warn('Failed to persist alert resolution', { condition, error: err.message });
      }
    }
  }

  function evaluateSubsystemConditions(health) {
    for (const [condition, subsystemKey] of Object.entries(SUBSYSTEM_MAP)) {
      const subsystem = health.subsystems?.[subsystemKey];
      if (!subsystem) continue;

      // Special handling for backup-mirror-stale: fire on yellow status (stale mirrors)
      // since staleness is already determined by the 24h threshold in the health check script
      const fireOnYellow = condition === 'backup-mirror-stale';
      
      if (subsystem.status === 'red' || (fireOnYellow && subsystem.status === 'yellow')) {
        // Use sinceRed from health result if available (tests inject this),
        // otherwise track internally from first observation.
        if (!redSince.has(condition)) {
          redSince.set(condition, subsystem.sinceRed || Date.now());
        }
        const elapsed = Date.now() - redSince.get(condition);
        if (elapsed >= THRESHOLDS[condition]) {
          fireAlert(condition, subsystem.detail || `${subsystemKey} is ${subsystem.status}`);
        }
      } else {
        redSince.delete(condition);
        resolveAlert(condition);
      }
    }
  }

  function fireAnomalyAlert(agentId, category, rollingRate, dispatchCount, trend) {
    const condition = `agent-anomaly:${agentId}:${category}`;
    if (activeAlerts.has(condition)) return; // dedup — already firing
    const severity = rollingRate < 0.5 ? 'critical' : 'warning';
    const alert = {
      projectId: null,
      condition,
      agentId,
      taskCategory: category,
      rollingRate,
      dispatchCount,
      trend,
      severity,
      detail: `Agent ${agentId} (${category}) rolling success rate ${(rollingRate * 100).toFixed(1)}% — ${trend}`,
      firedAt: new Date().toISOString(),
    };
    activeAlerts.set(condition, alert);
    events.emit('alert:firing', alert);
    log.warn('Agent anomaly alert fired', { agentId, category, rollingRate, severity, trend });
  }

  function evaluateAgentAnomalies() {
    if (!performanceStore) return;
    const threshold = config?.router?.alertAnomalyThreshold ?? 0.7;
    const allRates = performanceStore.getAllRollingRates();

    for (const { agentId, category, rollingRate, dispatchCount, trend } of allRates) {
      const condition = `agent-anomaly:${agentId}:${category}`;

      if (rollingRate === null) {
        // Insufficient history — clear any stale alert
        resolveAlert(condition);
        continue;
      }

      if (rollingRate < threshold) {
        fireAnomalyAlert(agentId, category, rollingRate, dispatchCount, trend);
      } else {
        resolveAlert(condition);
      }
    }
  }

  function evaluateAnalyticsSignalStaleness() {
    const condition = 'analytics-signals-stale';

    if (!analyticsSignalsStore) {
      // No store available - cannot evaluate staleness
      // Resolve any existing alert since we can't detect staleness
      resolveAlert(condition);
      return;
    }

    try {
      const freshnessStatus = analyticsSignalsStore.getFreshnessStatus();

      if (freshnessStatus.hasStaleSignals && freshnessStatus.stale.length > 0) {
        const staleProviderNames = freshnessStatus.stale.map(p => p.provider).join(', ');
        const maxAgeHours = Math.max(...freshnessStatus.stale.map(p => p.ageMs)) / (60 * 60 * 1000);
        const detail = `Analytics signals stale for ${freshnessStatus.stale.length} provider(s): ${staleProviderNames}. ` +
                      `Max age: ${maxAgeHours.toFixed(1)}h (threshold: ${(freshnessStatus.stalenessThresholdMs / (60 * 60 * 1000)).toFixed(0)}h). ` +
                      `Using last-known-good weights.`;

        fireAlert(condition, detail);

        // Log staleness details for operator visibility
        log.warn('Analytics signals staleness detected', {
          staleCount: freshnessStatus.stale.length,
          staleProviders: freshnessStatus.stale.map(s => ({
            provider: s.provider,
            ageHours: (s.ageMs / (60 * 60 * 1000)).toFixed(1),
            generatedAt: s.generatedAt,
          })),
          freshCount: freshnessStatus.fresh.length,
          thresholdHours: (freshnessStatus.stalenessThresholdMs / (60 * 60 * 1000)).toFixed(0),
        });
      } else {
        // All signals are fresh or no signals exist - resolve any existing alert
        resolveAlert(condition);
      }
    } catch (err) {
      log.error('Failed to evaluate analytics signal staleness', { error: err.message });
      // Don't fire an alert on evaluation failure - preserve existing alert state
    }
  }

  function evaluateDiskCorruption() {
    // ── disk-corruption check (#18 design call) ─────────────────────────
    // Pre-#18 this checked tasks.json for a 'version' field — that was the
    // JSON-CAS counter and missing-version meant a truncated/corrupted
    // mid-write. Post-#18 the canonical store is state.sqlite which has
    // no top-level CAS version (per-row transactions provide the same
    // property at a lower layer).
    //
    // The legitimate "tasks state is corrupted" detection path in the
    // SQLite era is now handled at process startup by state-db's
    // getDb(): it runs PRAGMA integrity_check on every open and refuses
    // to start the orchestrator if the DB is 0 bytes, can't be opened,
    // or fails integrity. That guard fires LOUDER and EARLIER than this
    // alert ever could — it process.exit(1)s rather than soft-alerts.
    //
    // We resolve this alert unconditionally (rather than removing it
    // entirely) so dashboards/alert-history clients that listen for
    // disk-corruption transitions see a clean resolved state on the
    // first scan post-migration. The condition stays in THRESHOLDS for
    // potential future use; the runtime check is now a no-op.
    const condition = 'disk-corruption';
    resolveAlert(condition);
  }

  function evaluateMilestoneApprovalTimeouts() {
    if (!stateManager?.listProjects) {
      return;
    }

    const now = Date.now();
    const projects = stateManager.listProjects();
    const pendingMilestones = new Set();
    const timeoutMilestones = new Set();

    for (const p of projects) {
      const pid = p.id || p;
      try {
        const campaignsData = loadCampaigns(stateManager.projectsDir, pid);
        if (!campaignsData?.campaigns) continue;

        for (const campaign of campaignsData.campaigns) {
          if (campaign.status !== 'active') continue;

          for (const milestone of campaign.milestones) {
            if (milestone.status !== 'waiting_approval' || !milestone.approvalRequestedAt) continue;

            const milestoneKey = `${pid}:${campaign.id}:${milestone.id}`;
            pendingMilestones.add(milestoneKey);

            const elapsed = now - new Date(milestone.approvalRequestedAt).getTime();
            const elapsedHours = elapsed / (60 * 60 * 1000);

            if (elapsed >= THRESHOLDS['milestone-approval-timeout']) {
              timeoutMilestones.add(milestoneKey);
              const condition = `milestone-approval-timeout:${milestoneKey}`;
              fireAlert(condition, `Milestone "${milestone.title}" in campaign "${campaign.title}" has been waiting for approval for ${elapsedHours.toFixed(1)}h (threshold: 24h)`);
            } else if (elapsed >= THRESHOLDS['milestone-approval-pending']) {
              const condition = `milestone-approval-pending:${milestoneKey}`;
              fireAlert(condition, `Milestone "${milestone.title}" in campaign "${campaign.title}" has been waiting for approval for ${elapsedHours.toFixed(1)}h (threshold: 12h)`);
            }
          }
        }
      } catch (err) {
        log.warn('Failed to evaluate milestone approval timeouts for project', { projectId: pid, error: err.message });
      }
    }

    for (const [condition, alert] of activeAlerts.entries()) {
      if (condition.startsWith('milestone-approval-timeout:') || condition.startsWith('milestone-approval-pending:')) {
        const milestoneKey = condition.slice(condition.indexOf(':') + 1);
        if (!pendingMilestones.has(milestoneKey)) {
          resolveAlert(condition);
        }
      }
    }
  }

  function loadCampaigns(projectsDir, projectId) {
    // Migrated to state.sqlite reads (#18, 2026-05-30). Returns the same
    // shape the caller expects ({ campaigns: [...] }) with milestones
    // hydrated per campaign so the approval-timeout loop can iterate
    // campaign.milestones unchanged.
    const projectDir = join(projectsDir, projectId);
    // 0-byte safety — see stateDbExists doc in state-db.js. Added
    // 2026-05-31 after enclave crash loop on corrupt fixtures.
    if (!stateDbExists(projectDir)) {
      return null;
    }
    try {
      const db = getDb(projectDir);
      // Only need active campaigns for approval-timeout evaluation; filter
      // at the SQL layer to avoid loading completed/failed campaigns.
      const campaignRows = db
        .prepare("SELECT * FROM campaigns WHERE project_id = ? AND status = 'active'")
        .all(projectId);
      const milestoneStmt = db.prepare(
        'SELECT * FROM milestones WHERE campaign_id = ? AND project_id = ?',
      );
      const campaigns = campaignRows.map((row) => {
        const campaign = rowToCampaign(row);
        campaign.milestones = milestoneStmt.all(campaign.id, projectId).map(rowToMilestone);
        return campaign;
      });
      return { campaigns };
    } catch (err) {
      // Match the previous loadCampaigns behavior — log on real errors,
      // swallow on ENOENT-equivalent (missing DB handled above).
      if (err.code !== 'ENOENT') {
        log.warn('Failed to load campaigns file', { projectId, error: err.message });
      }
      return null;
    }
  }

  async function tick() {
    try {
      const health = await computeSubsystemStatuses(healthDeps);
      evaluateSubsystemConditions(health);
      evaluateDiskCorruption();
      evaluateAgentAnomalies();
      evaluateAnalyticsSignalStaleness();
      evaluateMilestoneApprovalTimeouts();
    } catch (err) {
      log.error('Alert monitor tick failed', { error: err.message });
    }
  }

  function start() {
    const intervalMs = config?.alertMonitor?.intervalMs || 60_000;
    tick(); // first tick immediately
    interval = setInterval(tick, intervalMs);
    log.info('Alert monitor started', { intervalMs });
  }

  function stop() {
    if (interval) { clearInterval(interval); interval = null; }
  }

  function getActiveAlerts() {
    return [...activeAlerts.values()];
  }

  function acknowledgeAlert({ condition, agentId, taskCategory, operatorId, correlationId } = {}) {
    let alert = null;

    if (condition && activeAlerts.has(condition)) {
      alert = activeAlerts.get(condition);
    }

    if (!alert && (condition || agentId || taskCategory)) {
      alert = [...activeAlerts.values()].find((entry) => {
        if (condition && entry.condition !== condition) return false;
        if (agentId && entry.agentId !== agentId) return false;
        if (taskCategory && entry.taskCategory !== taskCategory) return false;
        return true;
      }) || null;
    }

    if (!alert) return null;

    const acknowledgedAt = new Date().toISOString();
    const ackEntry = {
      ...alert,
      acknowledgedAt,
      acknowledgedBy: operatorId || 'system',
      correlationId: correlationId || null,
      type: 'acknowledged',
    };

    alertHistory.push(ackEntry);
    if (alertHistory.length > maxHistorySize) {
      alertHistory.shift();
    }

    if (filePath) {
      try {
        appendAlertEntry(filePath, ackEntry);
      } catch (err) {
        log.warn('Failed to persist alert acknowledgement', { condition: ackEntry.condition, error: err.message });
      }
    }

    return ackEntry;
  }

  function clearAlert({ condition, agentId, taskCategory, operatorId, correlationId } = {}) {
    let alert = null;

    if (condition && activeAlerts.has(condition)) {
      alert = activeAlerts.get(condition);
    }

    if (!alert && (condition || agentId || taskCategory)) {
      alert = [...activeAlerts.values()].find((entry) => {
        if (condition && entry.condition !== condition) return false;
        if (agentId && entry.agentId !== agentId) return false;
        if (taskCategory && entry.taskCategory !== taskCategory) return false;
        return true;
      }) || null;
    }

    if (!alert) return null;

    activeAlerts.delete(alert.condition); // Forcefully remove from active alerts

    const clearedAt = new Date().toISOString();
    const clearEntry = {
      ...alert,
      clearedAt,
      clearedBy: operatorId || 'system',
      correlationId: correlationId || null,
      type: 'cleared',
    };

    events.emit('alert:cleared', clearEntry); // Emit a distinct event for operator-cleared alerts
    log.info('Alert cleared by operator', { condition: clearEntry.condition, clearedBy: operatorId });

    alertHistory.push(clearEntry);
    if (alertHistory.length > maxHistorySize) {
      alertHistory.shift();
    }

    if (filePath) {
      try {
        appendAlertEntry(filePath, clearEntry);
      } catch (err) {
        log.warn('Failed to persist alert clear action', { condition: clearEntry.condition, error: err.message });
      }
    }

    return clearEntry;
  }

  function getAlertHistory() {
    return [...alertHistory];
  }

  /**
   * Flush pending writes to disk immediately.
   * Since writes are synchronous, this is effectively a no-op but provided for API consistency.
   * @returns {Promise<void>}
   */
  async function flush() {
    // All writes are synchronous (appendAlertEntry blocks until fsync completes)
    // This method exists for test determinism and API consistency with DispatchLog
    return Promise.resolve();
  }

  return { start, stop, tick, getActiveAlerts, getAlertHistory, flush, acknowledgeAlert, clearAlert };
}
