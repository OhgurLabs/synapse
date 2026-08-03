/**
 * Temporal Correlation Detection Engine
 * Identifies cross-project failure patterns by detecting when ≥2 projects
 * experience similar event types within a sliding time window.
 */

import { randomUUID } from 'crypto';
import { appendAlertEntry } from './alert-history-store.js';
import { createLogger } from '../logger.js';

const log = createLogger('pattern-detector');

const ANOMALY_ALERTS_PATH = '.synapse/anomaly-alerts.jsonl';

const DEFAULT_WINDOW_MS = 300000; // 5 minutes
const DEFAULT_MIN_CO_OCCURRENCE = 2;
const DEFAULT_MIN_PROJECTS = 2;

/**
 * TemporalCorrelationDetector identifies correlated failure patterns across projects.
 */
export class TemporalCorrelationDetector {
  /**
   * Create a new TemporalCorrelationDetector.
   * @param {Object} config - Configuration options
   * @param {number} [config.windowMs=300000] - Sliding time window in milliseconds (default: 5 min)
   * @param {number} [config.minCoOccurrence=2] - Minimum co-occurrence count to report a pattern
   * @param {number} [config.minProjects=2] - Minimum number of distinct projects required for correlation
   */
  constructor(config = {}) {
    this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    this.minCoOccurrence = config.minCoOccurrence ?? DEFAULT_MIN_CO_OCCURRENCE;
    this.minProjects = config.minProjects ?? DEFAULT_MIN_PROJECTS;

    // In-memory event buffer
    this.eventBuffer = [];

    // Store of detected patterns (for API retrieval)
    this._detectedPatterns = [];

    // Continuous polling state
    this._intervalHandle = null;

    log.info('TemporalCorrelationDetector initialized', {
      windowMs: this.windowMs,
      minCoOccurrence: this.minCoOccurrence,
      minProjects: this.minProjects
    });
  }

  /**
   * Start continuous polling mode.
   * Calls eventSourceFn on each interval and feeds results into detectPatterns.
   * Idempotent: clears any existing interval before starting a new one.
   *
   * @param {number} intervalMs - Polling interval in milliseconds
   * @param {Function} eventSourceFn - Async or sync function returning an array of events
   * @returns {void}
   */
  startContinuous(intervalMs, eventSourceFn) {
    // Idempotent: clear existing interval first
    this.stopContinuous();

    log.info('Starting continuous polling', { intervalMs });

    this._intervalHandle = setInterval(async () => {
      try {
        const events = await eventSourceFn();
        this.detectPatterns(events || []);
      } catch (err) {
        log.error('Error in continuous polling cycle', { error: err.message });
      }
    }, intervalMs);
  }

  /**
   * Stop continuous polling mode.
   * Safe to call even if not currently polling.
   *
   * @returns {void}
   */
  stopContinuous() {
    if (this._intervalHandle !== null) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
      log.info('Continuous polling stopped');
    }
  }

  /**
   * On-demand single-shot pattern detection.
   * Equivalent to calling detectPatterns directly but named for API clarity.
   *
   * @param {Array} events - Array of event objects
   * @returns {Array} Correlated pattern objects
   */
  detectOnce(events) {
    return this.detectPatterns(events);
  }

  /**
   * Persist detected patterns to .synapse/anomaly-alerts.jsonl.
   * Transforms pattern objects into the alert schema format.
   *
   * @param {Array} patterns - Array of correlated pattern objects
   * @private
   */
  _persistPatterns(patterns) {
    if (!patterns || patterns.length === 0) {
      return;
    }

    try {
      for (const pattern of patterns) {
        // Transform pattern object into alert schema
        const alert = {
          type: 'cross_project_pattern',
          projectId: null, // Cross-project patterns have no single projectId
          condition: pattern.eventType,
          severity: this._computeSeverity(pattern),
          detail: `Cross-project pattern detected: ${pattern.eventType} across ${pattern.affectedProjects.length} projects (${pattern.affectedProjects.join(', ')})`,
          firedAt: pattern.detectedAt,
          evidence: pattern.events.map(event => ({
            projectId: event.projectId || event.project,
            eventType: event.eventType || event.condition || event.type,
            timestamp: event.timestamp || event.firedAt || event.detectedAt,
            detail: event.detail || event.summary || ''
          })),
          confidence: pattern.confidence
        };

        appendAlertEntry(ANOMALY_ALERTS_PATH, alert);
      }

      log.info('Persisted correlated patterns to anomaly alerts log', {
        count: patterns.length
      });
    } catch (err) {
      log.error('Failed to persist patterns to anomaly alerts log', {
        error: err.message
      });
    }
  }

  /**
   * Compute severity for a pattern based on confidence and project count.
   * @param {Object} pattern - Pattern object
   * @returns {string} Severity level: 'critical', 'warning', or 'info'
   * @private
   */
  _computeSeverity(pattern) {
    // High confidence + many projects = critical
    if (pattern.confidence >= 0.8 && pattern.affectedProjects.length >= 3) {
      return 'critical';
    }
    // Medium confidence or 2-3 projects = warning
    if (pattern.confidence >= 0.6 || pattern.affectedProjects.length >= 2) {
      return 'warning';
    }
    // Low confidence = info
    return 'info';
  }

  /**
   * Detect correlated patterns in the provided events.
   * Groups events by eventType within the sliding time window,
   * counts distinct affectedProjects per group, and computes confidence
   * from co-occurrence count.
   *
   * @param {Array} events - Array of event objects with { projectId, eventType, timestamp, ...otherFields }
   * @returns {Array} Array of correlated pattern objects, empty if no patterns meet thresholds
   */
  detectPatterns(events) {
    if (!events || events.length === 0) {
      return [];
    }

    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Filter events within the sliding time window
    const recentEvents = events.filter(event => {
      const eventTime = new Date(event.timestamp || event.firedAt || event.detectedAt).getTime();
      return eventTime >= windowStart && eventTime <= now;
    });

    if (recentEvents.length === 0) {
      return [];
    }

    // Group events by eventType
    const eventGroups = new Map();

    for (const event of recentEvents) {
      const eventType = event.eventType || event.condition || event.type || 'unknown';

      if (!eventGroups.has(eventType)) {
        eventGroups.set(eventType, []);
      }

      eventGroups.get(eventType).push(event);
    }

    // Analyze each group for cross-project correlation
    const correlatedPatterns = [];

    for (const [eventType, groupEvents] of eventGroups.entries()) {
      // Count distinct projects in this event type group
      const affectedProjects = new Set();

      for (const event of groupEvents) {
        const projectId = event.projectId || event.project;
        if (projectId) {
          affectedProjects.add(projectId);
        }
      }

      const projectCount = affectedProjects.size;
      const coOccurrenceCount = groupEvents.length;

      // Check if this group meets both thresholds
      if (projectCount >= this.minProjects && coOccurrenceCount >= this.minCoOccurrence) {
        // Compute confidence score from co-occurrence count
        // Simple formula: scale from minCoOccurrence to max observed (capped at 1.0)
        // More occurrences = higher confidence, with diminishing returns
        const confidence = Math.min(
          0.5 + (coOccurrenceCount / (this.minCoOccurrence * 10)) * 0.5,
          1.0
        );

        const pattern = {
          patternId: randomUUID(),
          detectedAt: new Date().toISOString(),
          affectedProjects: Array.from(affectedProjects),
          eventType,
          confidence: Math.round(confidence * 100) / 100, // Round to 2 decimal places
          windowMs: this.windowMs,
          events: groupEvents
        };

        correlatedPatterns.push(pattern);

        log.info('Correlated pattern detected', {
          patternId: pattern.patternId,
          eventType,
          projectCount,
          coOccurrenceCount,
          confidence: pattern.confidence
        });
      }
    }

    // Persist detected patterns to anomaly alerts log
    this._persistPatterns(correlatedPatterns);

    // Store detected patterns in memory for API retrieval
    this._detectedPatterns = correlatedPatterns;

    return correlatedPatterns;
  }

  /**
   * Get all detected patterns from memory.
   * Returns patterns from the most recent detection run.
   *
   * @returns {Array} Array of correlated pattern objects
   */
  getDetectedPatterns() {
    return this._detectedPatterns || [];
  }
}
