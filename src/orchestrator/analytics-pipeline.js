// analytics-pipeline.js — Scheduled service that computes routing signals from timeline events.
//
// Lifecycle:
// - start(): runs initial tick, then schedules periodic ticks via setInterval
// - stop(): clears the interval
// - runOnce(): manual trigger for on-demand signal generation
//
// Each tick:
//   1. Loads timeline events for the window via analytics-signal-computer
//   2. Computes routing weights via computeWeightAdjustments()
//   3. Persists signals to analytics_signals via AnalyticsSignalsStore

import { createLogger } from '../logger.js';
import { computeSignalsForWindow } from './analytics-signal-computer.js';
import { AnalyticsSignalsStore } from './analytics-signals-store.js';
import { computeWeightAdjustments, generateRecommendations } from './routing-analytics.js';
import { detectSustainedDegradation, buildDecayProposalFromEvidence } from './degradation-detector.js';
import { createRoutingProposal } from './routing-proposal-pipeline.js';
import { AttributionTracker } from './attribution-tracker.js';
import { evaluatePendingCycles as evaluateAutoresearchCycles } from './autoresearch-proposal-bridge.js';
import { isAbsolute, join } from 'path';

const log = createLogger('analytics-pipeline');

/**
 * Compute weight confidence based on dispatch sample size.
 * Follows the 5-sample routing guard threshold from router.js.
 * @param {number} dispatchCount
 * @returns {number} 0.0–1.0
 */
function weightConfidence(dispatchCount) {
  if (dispatchCount >= 50) return 1.0;
  if (dispatchCount >= 20) return 0.6;
  if (dispatchCount >= 5) return 0.3;
  return 0.0;
}

function normalizeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function resolveTimelineDbPath(timelineStore, config) {
  if (timelineStore?.dbPath) return timelineStore.dbPath;
  const rawPath = config?.timeline?.dbPath;
  if (!rawPath) return null;
  if (isAbsolute(rawPath)) return rawPath;
  if (config?.server?.projectDir) return join(config.server.projectDir, rawPath);
  return rawPath;
}

/**
 * Query timeline events, compute per-provider signals,
 * derive routing weights, and persist to analytics_signals.
 *
 * @param {Object} deps
 * @param {import('./timeline-store.js').TimelineStore} deps.timelineStore
 * @param {AnalyticsSignalsStore} deps.analyticsSignalsStore
 * @param {string} windowStart - ISO timestamp (inclusive)
 * @param {string} windowEnd - ISO timestamp (inclusive)
 * @returns {Promise<{ signalsGenerated: number, signalsSkipped: number, windowStart: string, windowEnd: string }>} 
 */
async function computeAndPersistSignals({ timelineStore, analyticsSignalsStore, windowStart, windowEnd }) {
  const signalsMap = await computeSignalsForWindow(timelineStore, windowStart, windowEnd);
  const providers = Object.keys(signalsMap);

  if (providers.length === 0) {
    log.info('No events in window, no signals to generate', { windowStart, windowEnd });
    return { signalsGenerated: 0, signalsSkipped: 0, windowStart, windowEnd, weightRecords: [] };
  }

  const providerInputs = providers.map((provider) => {
    const signal = signalsMap[provider];
    return {
      provider,
      totalDispatches: normalizeNumber(signal.dispatch_count, 0),
      successRate: signal.success_rate ?? null,
      p95LatencyMs: signal.p95_latency ?? null,
      avgLatencyMs: signal.p50_latency ?? null,
    };
  });

  const { new_weights } = computeWeightAdjustments({ providers: providerInputs });
  const generatedAt = new Date().toISOString();
  let signalsGenerated = 0;
  let signalsSkipped = 0;
  const weightRecords = [];

  for (const provider of providers) {
    const signal = signalsMap[provider];
    const dispatchCount = normalizeNumber(signal.dispatch_count, 0);
    const baseWeight = new_weights[provider] ?? 1.0;
    const guardrailRate = normalizeNumber(signal.guardrail_violation_rate, 0);
    const effectiveWeight = +(baseWeight * (1 - guardrailRate)).toFixed(4);
    const confidence = weightConfidence(dispatchCount);

    // Determine weight reason based on dispatch count and confidence
    let weightReason = 'insufficient_data_fallback';
    if (dispatchCount >= 50) {
      weightReason = 'weighted_selection';
    } else if (dispatchCount >= 20) {
      weightReason = 'confidence_adjusted';
    } else if (dispatchCount >= 5) {
      weightReason = 'confidence_adjusted';
    }

    // Collect weight record for snapshotting
    weightRecords.push({
      provider,
      agentId: null, // Provider-level weight (not agent-specific)
      taskCategory: null, // Global weight (not category-specific)
      weight: baseWeight,
      effectiveWeight,
      weightReason,
      data: {
        dispatchCount,
        guardrailRate,
        confidence,
        successRate: signal.success_rate,
        p50LatencyMs: signal.p50_latency,
        p95LatencyMs: signal.p95_latency,
        source: 'analytics-pipeline-v1',
      },
    });

    try {
      analyticsSignalsStore.writeSignal({
        provider,
        taskCategory: null,
        windowStart,
        windowEnd,
        generatedAt: signal.computed_at || generatedAt,
        successRate: normalizeNumber(signal.success_rate, 0),
        p50LatencyMs: normalizeNumber(signal.p50_latency, 0),
        p95LatencyMs: normalizeNumber(signal.p95_latency, 0),
        guardrailViolationRate: guardrailRate,
        routingWeight: effectiveWeight,
        weightConfidence: confidence,
        source: 'analytics-pipeline-v1',
        notes: JSON.stringify({
          dispatchCount,
          rawRoutingWeight: baseWeight,
        }),
      });
      signalsGenerated++;
    } catch (err) {
      signalsSkipped++;
      log.warn('Failed to write analytics signal', {
        provider,
        windowStart,
        windowEnd,
        error: err.message,
      });
    }
  }

  return { signalsGenerated, signalsSkipped, windowStart, windowEnd, weightRecords };
}

/**
 * Create an analytics pipeline service with start/stop lifecycle.
 *
 * @param {Object} deps
 * @param {Object} deps.timelineStore - TimelineStore instance with .db property
 * @param {Object} deps.analyticsSignalsStore - AnalyticsSignalsStore instance (optional, created if not provided)
 * @param {Object} deps.operatorAuditStore - OperatorAuditStore instance (optional, for routing proposals)
 * @param {Object} deps.events - EventEmitter instance (optional, for governance events)
 * @param {Object} deps.config - Application config (uses config.analyticsPipeline)
 * @returns {{ start: Function, stop: Function, tick: Function, runOnce: Function }}
 */
export function createAnalyticsPipeline({ timelineStore, analyticsSignalsStore, operatorAuditStore, events, config, attributionTracker } = {}) {
  if (!timelineStore) {
    throw new TypeError('timelineStore is required');
  }
  if (!config) {
    throw new TypeError('config is required');
  }

  let signalsStore = analyticsSignalsStore;
  if (!signalsStore) {
    const dbPath = resolveTimelineDbPath(timelineStore, config);
    if (!dbPath) {
      throw new TypeError('analyticsSignalsStore or timeline dbPath is required');
    }
    signalsStore = new AnalyticsSignalsStore({ dbPath });
  }

  const cfg = config.analyticsPipeline || {};
  const intervalMs = cfg.intervalMs || 86400000;
  const windowMs = cfg.windowMs || 86400000;
  const enabled = cfg.enabled !== false;

  const degradationCfg = config.degradationDetector || {};
  const degradationEnabled = degradationCfg.enabled !== false && operatorAuditStore && events;
  const minConsecutiveDeclines = degradationCfg.minConsecutiveDeclines || 3;
  const ttlMs = 7 * 24 * 60 * 60 * 1000; // 7 days

  // Attribution sweep is always enabled if tracker is provided
  const attributionSweepEnabled = !!attributionTracker;

  // Autoresearch bridge configuration
  const autoresearchCfg = config.autoresearchBridge || {};
  const autoresearchEnabled = autoresearchCfg.enabled !== false;
  const autoresearchBaseDir = config.autoresearch?.baseDir || 'autoresearch';
  const stateFilePath = join(process.cwd(), autoresearchBaseDir, '.evaluated-cycles.json');

  let timer = null;
  let isRunning = false;

  /**
   * Execute one analytics computation cycle.
   * @returns {Promise<Object>} Result summary
   */
  async function tick() {
    if (isRunning) {
      log.warn('Tick already in progress, skipping overlapping execution');
      return { status: 'skipped', reason: 'already_running' };
    }

    isRunning = true;
    const tickStart = Date.now();

    try {
      if (!timelineStore?.db) {
        log.warn('No database connection available, skipping tick');
        return { status: 'error', signalsGenerated: 0, error: 'no_database' };
      }

      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - windowMs);
      const windowStartIso = windowStart.toISOString();
      const windowEndIso = windowEnd.toISOString();

      log.info('Starting analytics pipeline tick', { windowStart: windowStartIso, windowEnd: windowEndIso });

      const result = await computeAndPersistSignals({
        timelineStore,
        analyticsSignalsStore: signalsStore,
        windowStart: windowStartIso,
        windowEnd: windowEndIso,
      });

      // ── Routing Weight Snapshotting ──────────────────────────────────────
      let weightsSnapshotted = 0;
      if (result.weightRecords && result.weightRecords.length > 0) {
        try {
          const snapshots = timelineStore.snapshotRoutingWeights(result.weightRecords, {
            snapshotTs: windowEndIso,
          });
          weightsSnapshotted = snapshots.length;
          log.info('Routing weights snapshotted', {
            count: weightsSnapshotted,
            windowEnd: windowEndIso,
          });
        } catch (err) {
          log.error('Failed to snapshot routing weights', {
            error: err.message,
            stack: err.stack,
            recordCount: result.weightRecords.length,
          });
        }
      }

      // ── Degradation Detection & Proposal Creation ─────────────────────────
      let proposalsCreated = 0;
      let proposalsSkipped = 0;

      if (degradationEnabled) {
        try {
          // 1. Query recent signal snapshots (N+1 windows for minConsecutiveDeclines + 1 for history)
          const snapshotLimit = minConsecutiveDeclines + 2;
          const snapshots = signalsStore.getRecentSnapshots(snapshotLimit);

          // 2. Detect sustained degradation
          const degradations = detectSustainedDegradation(snapshots, degradationCfg);

          // 3. For each degradation, create a routing proposal
          for (const degradation of degradations) {
            const { agentId, category } = degradation;

            // Deduplication: check if an active proposal already exists
            // Deliberately NOT filtered by agent at the SQL level.
            //
            // This filtered `provider: agentId`, but createRoutingProposal
            // never set provider (or agentId) on the event, so the column was
            // NULL and `WHERE provider = ?` excluded the very proposals this
            // is meant to find — suppression could never fire, and every tick
            // created another duplicate.
            //
            // The event now carries agentId, but filtering on it would still
            // miss every proposal written BEFORE that change. The predicate
            // below already matches on provider OR context.agentId, so it
            // handles legacy and new rows alike; 50 recent proposals is a
            // cheap scan.
            const existingProposals = timelineStore.query({
              type: 'routing_proposal',
              limit: 50,
            });

            const hasActivePending = existingProposals.events.some(e => {
              const eventData = e.event_data || e.data || {};
              // Match on any identity a proposal can carry: the agent_id column
              // (populated by createRoutingProposal), the provider column, or
              // the agent recorded in the data blob. Checking only provider and
              // the blob missed rows whose identity lives in agent_id.
              const matchesAgent = e.agent_id === agentId
                || e.provider === agentId
                || eventData.context?.agentId === agentId;
              const matchesCategory = !category || eventData.context?.category === category;
              const isActive = e.state === 'pending' || e.state === 'approved';
              return matchesAgent && matchesCategory && isActive;
            });

            if (hasActivePending) {
              log.info('Skipping degradation proposal: active proposal already exists', {
                agentId,
                category,
              });
              proposalsSkipped++;
              continue;
            }

            // Build proposal from degradation evidence (new API signature)
            const proposalConfig = {
              defaultTtlMs: ttlMs,
              weightReductionScale: degradationCfg.weightReductionScale || 0.5,
            };
            const recommendation = buildDecayProposalFromEvidence(degradation, proposalConfig);

            // Create routing proposal with causal correlation
            const sourceCorrelationId = `analytics-signal-${result.windowStart}`;
            await createRoutingProposal(recommendation, sourceCorrelationId, {
              timelineStore,
              operatorAuditStore,
              events,
              projectId: 'default',
              skipGovernance: false,
            });

            proposalsCreated++;
            log.info('Created degradation proposal', {
              agentId,
              category,
              proposalId: recommendation.id,
              evidence: degradation.evidence,
              ttlMs,
            });
          }

          // 4. Wire generateRecommendations() output into proposal creation
          // Note: This would require dispatchLog and performanceStore which aren't
          // currently available in the pipeline context. Leaving as TODO for future
          // integration when those dependencies are passed to the pipeline factory.
          // For now, recommendations will be generated via the /api/routing-analytics
          // endpoint as designed.
        } catch (err) {
          log.error('Degradation detection failed', {
            error: err.message,
            stack: err.stack,
          });
        }
      }

      // ── Attribution Sweep ─────────────────────────────────────────────────────
      let attributionSweepResults = null;
      if (attributionSweepEnabled && attributionTracker) {
        try {
          attributionSweepResults = await attributionTracker.runAttributionSweep();
          log.info('Attribution sweep complete', {
            evaluated: attributionSweepResults.evaluated,
            skipped: attributionSweepResults.skipped,
            errors: attributionSweepResults.errors,
          });
        } catch (err) {
          log.error('Attribution sweep failed', { error: err.message, stack: err.stack });
        }
      }

      // ── Autoresearch Cycle Evaluation ────────────────────────────────────────
      let autoresearchResults = null;
      if (autoresearchEnabled && timelineStore && operatorAuditStore && events) {
        try {
          autoresearchResults = await evaluateAutoresearchCycles({
            timelineStore,
            operatorAuditStore,
            events,
            config,
            autoresearchBaseDir,
            stateFilePath,
          });
          log.info('Autoresearch cycle evaluation complete', {
            evaluated: autoresearchResults.evaluated,
            proposalsCreated: autoresearchResults.proposalsCreated,
            outcomesLogged: autoresearchResults.outcomesLogged,
            errors: autoresearchResults.errors,
          });
        } catch (err) {
          log.error('Autoresearch cycle evaluation failed', { error: err.message, stack: err.stack });
        }
      }

      const tickDuration = Date.now() - tickStart;

      log.info('Analytics pipeline tick complete', {
        signalsGenerated: result.signalsGenerated,
        signalsSkipped: result.signalsSkipped,
        weightsSnapshotted,
        proposalsCreated,
        proposalsSkipped,
        attributionSweep: attributionSweepResults,
        autoresearch: autoresearchResults,
        durationMs: tickDuration,
        windowStart: windowStartIso,
        windowEnd: windowEndIso,
      });

      return {
        status: 'success',
        signalsGenerated: result.signalsGenerated,
        signalsSkipped: result.signalsSkipped,
        weightsSnapshotted,
        proposalsCreated,
        proposalsSkipped,
        attributionSweep: attributionSweepResults,
        autoresearch: autoresearchResults,
        windowStart: windowStartIso,
        windowEnd: windowEndIso,
        durationMs: tickDuration,
      };
    } catch (err) {
      const tickDuration = Date.now() - tickStart;
      log.error('Analytics pipeline tick failed', {
        error: err.message,
        stack: err.stack,
        durationMs: tickDuration,
      });

      return {
        status: 'error',
        signalsGenerated: 0,
        error: err.message,
        durationMs: tickDuration,
      };
    } finally {
      isRunning = false;
    }
  }

  /**
   * Start the analytics pipeline with periodic execution.
   */
  function start() {
    if (!enabled) {
      log.info('Analytics pipeline disabled via config');
      return;
    }

    if (timer) {
      log.warn('Analytics pipeline already started');
      return;
    }

    log.info('Analytics pipeline started', { intervalMs, windowMs });

    // Run initial tick immediately
    tick().catch(err => {
      log.error('Initial tick failed', { error: err.message });
    });

    // Schedule periodic ticks
    timer = setInterval(() => {
      tick().catch(err => {
        log.error('Scheduled tick failed', { error: err.message });
      });
    }, intervalMs);
  }

  /**
   * Stop the analytics pipeline.
   */
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
      log.info('Analytics pipeline stopped');
    }
  }

  /**
   * Manual trigger for on-demand signal generation.
   * @returns {Promise<Object>} Result summary
   */
  async function runOnce(options = {}) {
    if (options.windowStart || options.windowEnd) {
      const runStart = Date.now();
      const now = new Date();
      const windowStartIso = options.windowStart || new Date(now.getTime() - windowMs).toISOString();
      const windowEndIso = options.windowEnd || now.toISOString();
      try {
        const result = await computeAndPersistSignals({
          timelineStore,
          analyticsSignalsStore: signalsStore,
          windowStart: windowStartIso,
          windowEnd: windowEndIso,
        });
        return {
          status: 'success',
          signalsGenerated: result.signalsGenerated,
          signalsSkipped: result.signalsSkipped,
          windowStart: windowStartIso,
          windowEnd: windowEndIso,
          durationMs: Date.now() - runStart,
        };
      } catch (err) {
        log.error('Analytics pipeline runOnce failed', { error: err.message, stack: err.stack });
        return {
          status: 'error',
          signalsGenerated: 0,
          error: err.message,
          durationMs: Date.now() - runStart,
        };
      }
    }
    return tick();
  }

  return { start, stop, tick, runOnce };
}
