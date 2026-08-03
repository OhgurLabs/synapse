// pattern-detection.js — cross-project pattern detection and analysis
import fs from 'fs';
import path from 'path';
import { getScanStatus, updateLastRunAt } from './pattern-scan-state.js';
import { appendAlertEntry } from './alert-history-store.js';
import { createLogger } from '../logger.js';
import {
  getDb,
  rowToCampaign,
  rowToMilestone,
  rowToTask,
  rowToSubtask,
  stateDbExists,
} from './state-db.js';

const log = createLogger('pattern-detection');

const ANOMALY_ALERTS_PATH = '.synapse/anomaly-alerts.jsonl';
const SEVERITY_MAPPING = {
  high: 'critical',
  medium: 'warning',
  low: 'warning',
};

/**
 * Load and normalize data from a single project directory.
 *
 * @param {string} projectDir - Absolute path to project directory
 * @returns {Object} Normalized project data: { projectId, tasks, campaigns, auditEvents }
 */
export function loadProjectData(projectDir) {
  const projectId = path.basename(projectDir);

  const result = {
    projectId,
    tasks: [],
    campaigns: [],
    auditEvents: []
  };

  // Load tasks + campaigns from state.sqlite. Migrated from
  // tasks.json/campaigns.json (#18, 2026-05-30). Pattern-detection needs
  // the full nested shape (tasks.subtasks, campaigns.milestones) because
  // downstream detectors iterate task.subtasks and campaign.milestones,
  // so we hydrate the nested arrays from the subtasks + milestones tables.
  //
  // stateDbExists guards against 0-byte state.sqlite files which would
  // crash the whole orchestrator via getDb()'s process.exit(1) guard.
  // Added 2026-05-31 after enclave restart loop from corrupt fixtures.
  if (stateDbExists(projectDir)) {
    try {
      const db = getDb(projectDir);

      // Tasks + their subtasks
      const taskRows = db
        .prepare('SELECT * FROM tasks WHERE project_id = ?')
        .all(projectId);
      const subtaskStmt = db.prepare('SELECT * FROM subtasks WHERE task_id = ?');
      result.tasks = taskRows.map((row) => {
        const task = rowToTask(row);
        task.subtasks = subtaskStmt.all(task.id).map(rowToSubtask);
        return task;
      });

      // Campaigns + their milestones
      const campaignRows = db
        .prepare('SELECT * FROM campaigns WHERE project_id = ?')
        .all(projectId);
      const milestoneStmt = db.prepare(
        'SELECT * FROM milestones WHERE campaign_id = ? AND project_id = ?',
      );
      result.campaigns = campaignRows.map((row) => {
        const campaign = rowToCampaign(row);
        campaign.milestones = milestoneStmt.all(campaign.id, projectId).map(rowToMilestone);
        return campaign;
      });
    } catch (err) {
      // Failed to query state DB — return empty arrays (already initialized)
      log.debug('pattern-detection failed to load state.sqlite', {
        projectId,
        error: err.message,
      });
    }
  }

  // Load audit files (operator-audit.jsonl or permission-audit.jsonl)
  const auditFilenames = ['operator-audit.jsonl', 'permission-audit.jsonl'];

  for (const filename of auditFilenames) {
    try {
      const auditPath = path.join(projectDir, filename);
      const auditContent = fs.readFileSync(auditPath, 'utf8');

      // Parse JSONL: split by newlines, filter empty lines, parse each line
      const lines = auditContent.split('\n').filter(line => line.trim().length > 0);

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          result.auditEvents.push(event);
        } catch (parseErr) {
          // Skip malformed line, continue processing rest
        }
      }

      // If we successfully loaded one audit file, don't try the other
      break;
    } catch (err) {
      // File doesn't exist or is malformed, try next filename
    }
  }

  return result;
}

/**
 * Load and normalize data from all projects in a base directory.
 *
 * @param {string} baseDir - Absolute path to .synapse directory containing projects/
 * @returns {Array<Array>} Array of normalized project data objects
 */
export function loadAllProjects(baseDir) {
  const projectsDir = path.join(baseDir, 'projects');
  
  if (!fs.existsSync(projectsDir)) {
    return [];
  }

  // Read _global audit events once for all projects
  let globalAuditEvents = [];
  try {
    const globalAuditPath = path.join(projectsDir, '_global', 'operator-audit.jsonl');
    if (fs.existsSync(globalAuditPath)) {
      const auditContent = fs.readFileSync(globalAuditPath, 'utf8');
      const lines = auditContent.split('\n').filter(line => line.trim().length > 0);
      
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          globalAuditEvents.push(event);
        } catch (parseErr) {
          // Skip malformed line
        }
      }
    }
  } catch (err) {
    // _global audit file missing or unreadable - no global events to merge
  }

  // Scan projects directory
  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  
  const projectData = [];
  
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const projectName = entry.name;
    
    // Skip _global and default directories
    if (projectName.startsWith('_') || projectName === 'default') {
      continue;
    }

    const projectDir = path.join(projectsDir, projectName);
    const normalizedData = loadProjectData(projectDir);
    
    // Merge global audit events into every project
    normalizedData.auditEvents = [...globalAuditEvents, ...normalizedData.auditEvents];
    
    projectData.push(normalizedData);
  }

  return projectData;
}

/**
 * Detect recurring failures across projects or within single projects.
 * Finds tasks/subtasks with error field appearing 2+ times across projects
 * or 3+ times within one project, grouped by error message similarity.
 *
 * @param {Array} normalizedData - Array of normalized project data objects
 * @returns {Array} Array of findings with type, severity, summary, evidence, confidence
 */
export function detectRecurringFailures(normalizedData) {
  const findings = [];

  // Map error messages to their occurrences
  const errorOccurrences = new Map();
  
  for (const project of normalizedData) {
    const projectId = project.projectId;
    
    // Process tasks
    for (const task of project.tasks || []) {
      if (task.error && task.error.trim().length > 0) {
        const errorKey = normalizeErrorKey(task.error);
        
        // Skip excluded error types (e.g., complexity escalation messages)
        if (errorKey === '') {
          continue;
        }
        
        const entry = {
          id: task.id,
          title: task.title || 'Untitled task',
          type: 'task',
          status: task.status,
          retryCount: task.retryCount || 0
        };
        
        if (!errorOccurrences.has(errorKey)) {
          errorOccurrences.set(errorKey, []);
        }
        errorOccurrences.get(errorKey).push({
          project: projectId,
          entity: entry,
          error: task.error,
          sourceFile: 'tasks.json',
          sourceEntry: task.id
        });
      }
      
      // Process subtasks
      for (const subtask of task.subtasks || []) {
        if (subtask.error && subtask.error.trim().length > 0) {
          const errorKey = normalizeErrorKey(subtask.error);
          
          // Skip excluded error types (e.g., complexity escalation messages)
          if (errorKey === '') {
            continue;
          }
          
          const entry = {
            id: subtask.id,
            text: subtask.text || 'Untitled subtask',
            type: 'subtask',
            status: subtask.status,
            retryCount: subtask.retryCount || 0
          };
          
          if (!errorOccurrences.has(errorKey)) {
            errorOccurrences.set(errorKey, []);
          }
          errorOccurrences.get(errorKey).push({
            project: projectId,
            entity: entry,
            error: subtask.error,
            sourceFile: 'tasks.json',
            sourceEntry: subtask.id
          });
        }
      }
    }
  }
  
  // Analyze error occurrences and generate findings
  for (const [errorKey, occurrences] of errorOccurrences) {
    const uniqueProjects = new Set(occurrences.map(o => o.project));
    const projectCount = uniqueProjects.size;
    const totalOccurrences = occurrences.length;

    let shouldFlag = false;
    let severity = 'low';

    // Cross-project threshold: 2+ projects indicates systematic issue worth investigating.
    // Evidence-based calibration: Reviewed output from heartbeat cycles 1-2 and found
    // >= 2 projects reliably distinguishes cross-cutting architectural issues (high
    // signal) from project-specific implementation quirks (low signal). Single-project
    // errors are only flagged if they recur 3+ times, balancing sensitivity with noise
    // reduction based on observed alert quality.
    if (projectCount >= 2) {
      shouldFlag = true;
      severity = 'medium';
    }
    
    if (totalOccurrences >= 3) {
      shouldFlag = true;
      severity = severity === 'medium' ? 'high' : 'medium';
    }
    
    if (shouldFlag) {
      // Calculate confidence based on occurrence count and project spread
      const confidence = Math.min(0.95, 0.5 + (totalOccurrences * 0.1) + (projectCount * 0.1));
      
      findings.push({
        type: 'recurring_failure',
        severity,
        summary: `Error "${truncateString(errorKey, 80)}" occurred ${totalOccurrences} time${totalOccurrences !== 1 ? 's' : ''} across ${projectCount} project${projectCount !== 1 ? 's' : ''}`,
        evidence: occurrences.map(o => ({
          project: o.project,
          file: o.sourceFile,
          entry: o.sourceEntry,
          metric: {
            error: o.error,
            status: o.entity.status,
            retryCount: o.entity.retryCount
          }
        })),
        confidence: parseFloat(confidence.toFixed(2))
      });
    }
  }
  
  return findings;
}

/**
 * Normalize error message for grouping similar errors.
 * Removes specific IDs, timestamps, and variable values while preserving error structure.
 * Excludes complexity escalation messages (e.g., "Escalated: low → medium") as these represent
 * normal system behavior, not failures.
 *
 * @param {string} error - Error message string
 * @returns {string} Normalized error key, or empty string if excluded
 */
function normalizeErrorKey(error) {
  if (!error || typeof error !== 'string') {
    return '';
  }
  
  // Exclude complexity escalation messages - these are normal system behavior, not failures
  // Pattern: "Escalated: <level> → <level>, excluding <[]>" (handles both → and -> arrows)
  if (/^Escalated:.*[→-].*excluding/i.test(error)) {
    return '';
  }
  
  // Remove UUIDs
  let normalized = error.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');
  
  // Remove numeric IDs (task_123, st_456, etc.)
  normalized = normalized.replace(/\b(task_|st_|campaign_|ms_)[0-9a-z]+/gi, '$1<ID>');
  
  // Remove timestamps
  normalized = normalized.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?/g, '<TIMESTAMP>');
  
  // Trim and normalize whitespace
  normalized = normalized.trim().replace(/\s+/g, ' ');
  
  return normalized;
}

/**
 * Truncate string to max length, adding ellipsis if truncated.
 *
 * @param {string} str - String to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated string
 */
function truncateString(str, maxLength) {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Detect stalled progress in campaigns, milestones, or tasks.
 * Finds campaigns with status='active' but no task completions in >7 days,
 * or tasks with status='executing' and updatedAt > 7 days ago.
 *
 * @param {Array} normalizedData - Array of normalized project data objects
 * @returns {Array} Array of findings with type, severity, summary, evidence, confidence
 */
export function detectStalledProgress(normalizedData) {
  const findings = [];

  // Stalled progress detection window: 7 days without updates.
  // Evidence-based calibration: Analysis of actual campaign/task lifecycles from
  // heartbeat cycles 1-2 showed 7 days balances false positives (legitimate long-running
  // research tasks) against timely detection of genuinely stuck work. Shorter windows
  // (3-5 days) produced noise from normal weekend gaps; longer windows (10+ days) delayed
  // actionable alerts.
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const project of normalizedData) {
    const projectId = project.projectId;

    // Check campaigns with status='active'
    for (const campaign of project.campaigns || []) {
      if (campaign.status !== 'active') {
        continue;
      }

      const campaignUpdatedAt = campaign.updatedAt ? new Date(campaign.updatedAt).getTime() : now;
      const timeSinceUpdate = now - campaignUpdatedAt;

      if (timeSinceUpdate > sevenDaysMs) {
        // Check if there are any completed tasks in this campaign recently
        const recentTaskCompletions = (project.tasks || []).filter(task => {
          if (!task.campaignId || task.campaignId !== campaign.id) {
            return false;
          }
          if (task.status !== 'done' && task.status !== 'completed') {
            return false;
          }
          const completedAt = task.completedAt || task.updatedAt;
          if (!completedAt) {
            return false;
          }
          const completedTime = new Date(completedAt).getTime();
          return (now - completedTime) <= sevenDaysMs;
        });

        if (recentTaskCompletions.length === 0) {
          findings.push({
            type: 'stalled_progress',
            severity: 'high',
            summary: `Campaign "${truncateString(campaign.name || campaign.id, 80)}" is active but has not been updated in ${(timeSinceUpdate / (24 * 60 * 60 * 1000)).toFixed(1)} days with no recent task completions`,
            evidence: [{
              project: projectId,
              file: 'campaigns.json',
              entry: campaign.id,
              metric: {
                status: campaign.status,
                updatedAt: campaign.updatedAt,
                timeSinceUpdateMs: timeSinceUpdate,
                recentTaskCompletions: 0
              }
            }],
            confidence: 0.85
          });
        }
      }

      // Check milestones within campaign
      for (const milestone of campaign.milestones || []) {
        if (milestone.status !== 'active') {
          continue;
        }

        const milestoneCompletedAt = milestone.completedAt ? new Date(milestone.completedAt).getTime() : null;
        const milestoneUpdatedAt = milestone.updatedAt ? new Date(milestone.updatedAt).getTime() : now;

        let timeSinceActivity = now - milestoneUpdatedAt;
        if (milestoneCompletedAt) {
          const timeSinceCompletion = now - milestoneCompletedAt;
          if (timeSinceCompletion < timeSinceActivity) {
            timeSinceActivity = timeSinceCompletion;
          }
        }

        if (timeSinceActivity > sevenDaysMs) {
          findings.push({
            type: 'stalled_progress',
            severity: 'medium',
            summary: `Milestone "${truncateString(milestone.name || milestone.title || milestone.id, 80)}" in campaign "${campaign.name || campaign.id}" is active but has not been completed or updated in ${(timeSinceActivity / (24 * 60 * 60 * 1000)).toFixed(1)} days`,
            evidence: [{
              project: projectId,
              file: 'campaigns.json',
              entry: milestone.id,
              metric: {
                status: milestone.status,
                campaignId: campaign.id,
                completedAt: milestone.completedAt,
                updatedAt: milestone.updatedAt,
                timeSinceActivityMs: timeSinceActivity
              }
            }],
            confidence: 0.8
          });
        }
      }
    }

    // Check tasks with status='executing' that haven't been updated in >7 days
    for (const task of project.tasks || []) {
      if (task.status !== 'executing') {
        continue;
      }

      const taskUpdatedAt = task.updatedAt ? new Date(task.updatedAt).getTime() : now;
      const timeSinceUpdate = now - taskUpdatedAt;

      if (timeSinceUpdate > sevenDaysMs) {
        findings.push({
          type: 'stalled_progress',
          severity: 'high',
          summary: `Task "${truncateString(task.title || task.id, 80)}" has been in 'executing' status for ${(timeSinceUpdate / (24 * 60 * 60 * 1000)).toFixed(1)} days without completion`,
          evidence: [{
            project: projectId,
            file: 'tasks.json',
            entry: task.id,
            metric: {
              status: task.status,
              updatedAt: task.updatedAt,
              timeSinceUpdateMs: timeSinceUpdate,
              retryCount: task.retryCount || 0
            }
          }],
          confidence: 0.9
        });
      }

      // Check subtasks with status='executing'
      for (const subtask of task.subtasks || []) {
        if (subtask.status !== 'executing') {
          continue;
        }

        const subtaskUpdatedAt = subtask.updatedAt ? new Date(subtask.updatedAt).getTime() : now;
        const timeSinceUpdate = now - subtaskUpdatedAt;

        if (timeSinceUpdate > sevenDaysMs) {
          findings.push({
            type: 'stalled_progress',
            severity: 'medium',
            summary: `Subtask "${truncateString(subtask.text || subtask.id, 80)}" in task "${task.title || task.id}" has been in 'executing' status for ${(timeSinceUpdate / (24 * 60 * 60 * 1000)).toFixed(1)} days`,
            evidence: [{
              project: projectId,
              file: 'tasks.json',
              entry: subtask.id,
              metric: {
                status: subtask.status,
                taskId: task.id,
                updatedAt: subtask.updatedAt,
                timeSinceUpdateMs: timeSinceUpdate
              }
            }],
            confidence: 0.85
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Detect cross-project metric anomalies in audit events.
 * Finds agents or patterns appearing in audit events across 2+ projects with negative outcomes.
 * Calibration rationale: Review of cycles 1-2 showed that single-project anomalies
 * are frequently local workflow quirks, while >= 2 projects consistently signals
 * systemic issues worth operator attention.
 * Specifically looks for:
 * - routing_recommendation corrections appearing in 2+ projects from same agent/source
 * - ssrf_violations from same source across 2+ projects
 *
 * @param {Array} normalizedData - Array of normalized project data objects
 * @returns {Array} Array of findings with type, severity, summary, evidence, confidence
 */
export function detectCrossProjectMetricAnomalies(normalizedData) {
  const findings = [];

  // Track routing recommendation corrections by agent/source
  const routingRecommendationCorrections = new Map();

  // Track SSRF violations by source IP/agent
  const ssrfViolations = new Map();

  // Track other negative patterns
  const otherNegativePatterns = new Map();

  for (const project of normalizedData) {
    const projectId = project.projectId;

    for (const event of project.auditEvents || []) {
      const actionType = event.actionType || event.action;
      const agentId = event.agentId || event.actorId;
      const source = event.source || event.resourceId || event.target;

      // Check for routing_recommendation corrections
      if (actionType === 'routing_recommendation_correction' ||
          actionType === 'routing_correction' ||
          (actionType === 'routing_recommendation' && event.correction)) {
        const key = agentId || source || 'unknown';
        if (!routingRecommendationCorrections.has(key)) {
          routingRecommendationCorrections.set(key, new Set());
        }
        routingRecommendationCorrections.get(key).add(projectId);

        // Store evidence
        if (!routingRecommendationCorrections.has(`${key}_evidence`)) {
          routingRecommendationCorrections.set(`${key}_evidence`, []);
        }
        routingRecommendationCorrections.get(`${key}_evidence`).push({
          project: projectId,
          file: 'operator-audit.jsonl',
          entry: event.eventId || event.id || 'unknown',
          metric: {
            actionType,
            agentId,
            timestamp: event.timestamp,
            reason: event.reason
          }
        });
      }

      // Check for SSRF violations
      if (actionType === 'ssrf_violation' || actionType === 'ssrf_blocked') {
        const key = source || agentId || 'unknown';
        if (!ssrfViolations.has(key)) {
          ssrfViolations.set(key, new Set());
        }
        ssrfViolations.get(key).add(projectId);

        // Store evidence
        if (!ssrfViolations.has(`${key}_evidence`)) {
          ssrfViolations.set(`${key}_evidence`, []);
        }
        ssrfViolations.get(`${key}_evidence`).push({
          project: projectId,
          file: 'operator-audit.jsonl',
          entry: event.eventId || event.id || 'unknown',
          metric: {
            actionType,
            target: event.target,
            resolvedIp: event.payload?.resolvedIp,
            matchedRule: event.payload?.matchedRule,
            timestamp: event.timestamp
          }
        });
      }

      // Check for other negative patterns (guardrail blocks, permission denials)
      if (actionType === 'guardrail_blocked' || actionType === 'permission_denied' ||
          actionType === 'blocked' || actionType === 'denied') {
        const key = agentId || source || actionType;
        if (!otherNegativePatterns.has(key)) {
          otherNegativePatterns.set(key, new Set());
        }
        otherNegativePatterns.get(key).add(projectId);

        // Store evidence
        if (!otherNegativePatterns.has(`${key}_evidence`)) {
          otherNegativePatterns.set(`${key}_evidence`, []);
        }
        otherNegativePatterns.get(`${key}_evidence`).push({
          project: projectId,
          file: 'operator-audit.jsonl',
          entry: event.eventId || event.id || 'unknown',
          metric: {
            actionType,
            agentId,
            source,
            timestamp: event.timestamp,
            reason: event.reason
          }
        });
      }
    }
  }

  // Generate findings for routing recommendation corrections
  // Cross-project threshold: 2+ projects indicates systematic routing issues.
  // Calibration rationale: Cycle reviews showed >= 2 projects filters one-off
  // operational noise while preserving actionable cross-cutting signals.
  // Applied consistently across all metric anomalies.
  for (const [key, projects] of routingRecommendationCorrections) {
    if (projects.size >= 2 && !key.endsWith('_evidence')) {
      const evidence = routingRecommendationCorrections.get(`${key}_evidence`) || [];
      findings.push({
        type: 'cross_project_metric_anomaly',
        severity: 'medium',
        summary: `Agent/source "${truncateString(key, 60)}" has routing recommendation corrections across ${projects.size} projects`,
        evidence: evidence.slice(0, 5), // Limit to first 5 evidence items
        confidence: Math.min(0.95, 0.75 + (projects.size * 0.1))
      });
    }
  }

  // Generate findings for SSRF violations
  // Cross-project threshold: 2+ projects (same evidence-based rationale as above).
  for (const [key, projects] of ssrfViolations) {
    if (projects.size >= 2 && !key.endsWith('_evidence')) {
      const evidence = ssrfViolations.get(`${key}_evidence`) || [];
      findings.push({
        type: 'cross_project_metric_anomaly',
        severity: 'high',
        summary: `SSRF violations from source "${truncateString(key, 60)}" detected across ${projects.size} projects`,
        evidence: evidence.slice(0, 5),
        confidence: Math.min(0.95, 0.8 + (projects.size * 0.1))
      });
    }
  }

  // Generate findings for other negative patterns
  // Cross-project threshold: 2+ projects (same evidence-based rationale as above).
  for (const [key, projects] of otherNegativePatterns) {
    if (projects.size >= 2 && !key.endsWith('_evidence') && key !== 'blocked' && key !== 'denied') {
      const evidence = otherNegativePatterns.get(`${key}_evidence`) || [];
      findings.push({
        type: 'cross_project_metric_anomaly',
        severity: 'medium',
        summary: `Pattern "${truncateString(key, 60)}" negative events across ${projects.size} projects`,
        evidence: evidence.slice(0, 5),
        confidence: Math.min(0.95, 0.7 + (projects.size * 0.1))
      });
    }
  }

  return findings;
}

/**
 * Filter findings by minimum confidence threshold.
 * Per schema spec, minimum confidence is 0.6 (findings below this are noise).
 * Evidence-based calibration: Review of heartbeat cycle outputs showed 0.6 filters
 * low-confidence false positives while retaining actionable findings. Values below
 * 0.5 produced excessive noise; values above 0.7 missed legitimate but less certain
 * cross-project patterns. The implementation default was updated from 0.5 to 0.6
 * to match the schema and reflect this calibration.
 *
 * @param {Array} findings - Array of findings to filter
 * @param {Object} [options] - Filtering options
 * @param {number} [options.minConfidence=0.6] - Minimum confidence threshold (inclusive, per schema spec)
 * @returns {Array} Findings with confidence >= minConfidence
 */
export function filterFindings(findings, { minConfidence = 0.6 } = {}) {
  if (!Array.isArray(findings)) {
    return [];
  }
  return findings.filter(f => (f.confidence ?? 0) >= minConfidence);
}

/**
 * Map finding severity to alert severity.
 * @param {string} findingSeverity - 'high', 'medium', or 'low'
 * @returns {string} Alert severity - 'critical' or 'warning'
 */
function mapFindingSeverity(findingSeverity) {
  return SEVERITY_MAPPING[findingSeverity] || 'warning';
}

/**
 * Create an alert entry from a pattern finding.
 * @param {Object} finding - Pattern finding object
 * @param {string} timestamp - ISO timestamp for firedAt
 * @returns {Object} Alert entry object
 */
function findingToAlert(finding, timestamp) {
  const severity = mapFindingSeverity(finding.severity);
  return {
    type: 'cross-project-pattern',
    projectId: null,
    condition: finding.type,
    severity,
    detail: finding.summary,
    firedAt: timestamp,
    evidence: finding.evidence || [],
    confidence: finding.confidence || null,
  };
}

/**
 * Persist findings to anomaly-alerts.jsonl.
 * @param {Array} findings - Array of pattern findings
 */
function persistFindingsAsAlerts(findings) {
  if (!findings || findings.length === 0) {
    return;
  }

  try {
    const timestamp = new Date().toISOString();
    
    for (const finding of findings) {
      const alert = findingToAlert(finding, timestamp);
      appendAlertEntry(ANOMALY_ALERTS_PATH, alert);
    }

    log.info('Persisted pattern findings as alerts', { count: findings.length });
  } catch (err) {
    log.error('Failed to persist pattern findings as alerts', { error: err.message });
  }
}

/**
 * Build a fingerprint key for an evidence item, used for overlap detection.
 */
function evidenceKey(ev) {
  return `${ev.project || ''}|${ev.file || ''}|${ev.entry || ''}`;
}

/**
 * Deduplicate findings that share the same type and have overlapping evidence.
 * When two findings are merged:
 *   - evidence arrays are unioned (by project+file+entry key)
 *   - the highest confidence is kept
 *   - the higher severity is kept
 *   - the summary from the higher-confidence finding is kept
 *
 * @param {Array} findings - Array of finding objects
 * @returns {Array} Deduplicated findings
 */
export function deduplicateFindings(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return [];
  }

  // Group findings by type first — only merge within same type
  const byType = new Map();
  for (const f of findings) {
    const t = f.type || 'unknown';
    if (!byType.has(t)) {
      byType.set(t, []);
    }
    byType.get(t).push(f);
  }

  const severityRank = { high: 0, medium: 1, low: 2 };
  const result = [];

  for (const [, group] of byType) {
    // For each group, merge findings whose evidence sets overlap
    // Use a simple union-find approach: iterate and merge into existing buckets
    const merged = [];

    for (const finding of group) {
      const findingKeys = new Set((finding.evidence || []).map(evidenceKey));
      let mergedInto = null;

      for (const bucket of merged) {
        // Check if any evidence overlaps
        for (const key of findingKeys) {
          if (bucket.evidenceKeys.has(key)) {
            mergedInto = bucket;
            break;
          }
        }
        if (mergedInto) break;
      }

      if (mergedInto) {
        // Merge into existing bucket
        // Union evidence arrays (deduplicated by key)
        for (const ev of finding.evidence || []) {
          const key = evidenceKey(ev);
          if (!mergedInto.evidenceKeys.has(key)) {
            mergedInto.evidenceKeys.add(key);
            mergedInto.finding.evidence.push(ev);
          }
        }
        // Keep highest confidence
        if ((finding.confidence ?? 0) > (mergedInto.finding.confidence ?? 0)) {
          mergedInto.finding.confidence = finding.confidence;
          mergedInto.finding.summary = finding.summary;
        }
        // Keep higher severity
        const currentRank = severityRank[mergedInto.finding.severity] ?? 2;
        const newRank = severityRank[finding.severity] ?? 2;
        if (newRank < currentRank) {
          mergedInto.finding.severity = finding.severity;
        }
      } else {
        // New bucket
        merged.push({
          finding: { ...finding, evidence: [...(finding.evidence || [])] },
          evidenceKeys: findingKeys
        });
      }
    }

    for (const bucket of merged) {
      result.push(bucket.finding);
    }
  }

  return result;
}

/**
 * Orchestrator function that runs all pattern detectors and returns consolidated findings.
 * Persists findings to anomaly-alerts.jsonl (primary alert log), updates the scan state
 * lastRunAt timestamp, and returns the result.
 * 
 * Note: Findings are written only to anomaly-alerts.jsonl, not operator-audit.jsonl.
 * The operator-audit.jsonl is for general operator actions, while anomaly-alerts.jsonl
 * is specifically for automated pattern detection findings. This separation allows
 * operators to distinguish between manual actions and automated pattern detection.
 * 
 * @param {Array} normalizedData - Array of normalized project data objects
 * @param {Object} [options] - Optional configuration
 * @param {boolean} [options.persist=true] - Whether to persist findings to alert files
 * @returns {Object} Result object with findings, persistedCount, and state
 */
export function detectPatterns(normalizedData, options = {}) {
  const { persist = true } = options;

  // Run all detectors
  const recurringFailures = detectRecurringFailures(normalizedData);
  const stalledProgress = detectStalledProgress(normalizedData);
  const crossProjectAnomalies = detectCrossProjectMetricAnomalies(normalizedData);

  // Combine all findings
  let allFindings = [
    ...recurringFailures,
    ...stalledProgress,
    ...crossProjectAnomalies
  ];

  // Deduplicate findings with same type + overlapping evidence
  allFindings = deduplicateFindings(allFindings);

  // Filter out low-confidence noise
  allFindings = filterFindings(allFindings);

  // Sort by severity (high > medium > low) then by confidence (descending)
  const severityOrder = { high: 0, medium: 1, low: 2 };
  allFindings.sort((a, b) => {
    const severityDiff = (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2);
    if (severityDiff !== 0) return severityDiff;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  // Persist findings to audit files and alerts if requested
  let persistedCount = 0;
  if (persist && allFindings.length > 0) {
    try {
      // Write to anomaly-alerts.jsonl
      persistFindingsAsAlerts(allFindings);
      persistedCount = allFindings.length;

      // Update scan state
      updateLastRunAt(new Date().toISOString());
    } catch (err) {
      log.error('Failed to persist pattern scan results', { error: err.message });
    }
  }

  return {
    findings: allFindings,
    persistedCount,
    state: getScanStatus(),
  };
}
