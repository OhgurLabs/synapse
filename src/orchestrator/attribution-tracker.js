// attribution-tracker.js — Tracks effectiveness of weight decay overrides applied via governance approval
//
// Records pre-change success rates when weights are applied, then computes post-change
// attribution to measure effectiveness. Results are persisted to the operator audit trail.
//
// Usage:
//   const tracker = new AttributionTracker(baseDir, performanceStore, operatorAudit);
//   await tracker.recordPreChangeMetrics(proposalId, affectedAgents, category, weights);
//   const result = await tracker.checkAttribution(proposalId);
//   await tracker.runAttributionSweep();

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../logger.js';

const log = createLogger('attribution-tracker');

const ATTRIBUTION_FILE = '_routing-attribution-tracking.json';

/**
 * AttributionTracker — Tracks and evaluates the effectiveness of weight override applications.
 */
export class AttributionTracker {
  constructor(baseDir, performanceStore, operatorAudit) {
    this.baseDir = baseDir;
    this.performanceStore = performanceStore;
    this.operatorAudit = operatorAudit;
    this.filePath = join(baseDir, ATTRIBUTION_FILE);
    
    // Configuration
    this.minDispatchesForAttribution = 50;
    this.minHoursElapsed = 24;
    
    // Load existing tracking data
    this._trackingData = this._loadTrackingData();
  }

  _loadTrackingData() {
    try {
      if (existsSync(this.filePath)) {
        const data = readFileSync(this.filePath, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      log.warn('Failed to load attribution tracking data', { error: err.message });
    }
    return {
      proposals: {},
      lastSweep: null,
    };
  }

  _saveTrackingData() {
    try {
      mkdirSync(this.baseDir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this._trackingData, null, 2));
    } catch (err) {
      log.error('Failed to save attribution tracking data', { error: err.message });
    }
  }

  /**
   * Record pre-change success rates for affected agents when a weight override is applied.
   * @param {string} proposalId - The governance proposal ID
   * @param {Array} affectedAgents - Array of agent IDs affected by the weight change
   * @param {string} category - Task category (e.g., 'implementation', 'research')
   * @param {Object} weights - The applied weights object { agentId: weight, ... }
   * @param {Object} metadata - Additional metadata (appliedBy, reason, etc.)
   */
  recordPreChangeMetrics(proposalId, affectedAgents, category, weights, metadata = {}) {
    const preChangeRates = {};
    
    // Query performance store for current success rates for each agent
    for (const agentId of affectedAgents) {
      const stats = this.performanceStore.getStatsByAgentCategory(agentId, category);
      preChangeRates[agentId] = {
        successRate: stats.successRate || 0,
        totalDispatches: stats.totalDispatches || 0,
        timestamp: new Date().toISOString(),
      };
    }

    const record = {
      proposalId,
      category,
      affectedAgents,
      weights,
      preChangeRates,
      appliedAt: metadata.appliedAt || new Date().toISOString(),
      appliedBy: metadata.appliedBy || 'system',
      reason: metadata.reason || null,
      correlationId: metadata.correlationId || proposalId,
      status: 'applied',
    };

    this._trackingData.proposals[proposalId] = record;
    this._saveTrackingData();

    log.info('Recorded pre-change metrics for weight override', {
      proposalId,
      agents: affectedAgents.length,
      category,
    });

    return record;
  }

  /**
   * Check attribution for a specific proposal by comparing pre/post success rates.
   * @param {string} proposalId - The proposal ID to check
   * @returns {Object|null} Attribution result or null if not found
   */
  async checkAttribution(proposalId) {
    const record = this._trackingData.proposals[proposalId];
    if (!record) {
      log.warn('Attribution check requested for unknown proposal', { proposalId });
      return null;
    }

    if (record.status === 'evaluated') {
      // Return cached result
      return record.attributionResult;
    }

    const now = Date.now();
    const appliedAt = new Date(record.appliedAt).getTime();
    const hoursElapsed = (now - appliedAt) / (1000 * 60 * 60);
    
    // Check if sufficient data has accumulated
    let hasSufficientData = false;
    for (const agentId of record.affectedAgents) {
      const currentStats = this.performanceStore.getStatsByAgentCategory(agentId, record.category);
      const dispatchesSinceChange = currentStats.totalDispatches - (record.preChangeRates[agentId]?.totalDispatches || 0);
      
      if (dispatchesSinceChange >= this.minDispatchesForAttribution) {
        hasSufficientData = true;
        break;
      }
    }

    // Also check time-based threshold
    const sufficientTimeElapsed = hoursElapsed >= this.minHoursElapsed;

    if (!hasSufficientData && !sufficientTimeElapsed) {
      return {
        proposalId,
        category: record.category,
        status: 'insufficient_data',
        verdict: 'inconclusive',
        confidence: 0.0,
        reason: 'Insufficient post-change data',
        dispatchesSinceChange: null,
        hoursElapsed: hoursElapsed.toFixed(2),
        preRates: record.preChangeRates,
        currentRates: this._getCurrentRates(record.affectedAgents, record.category),
      };
    }

    // Compute attribution deltas
    const attributionResults = [];
    let totalDelta = 0;
    let sampleSize = 0;

    for (const agentId of record.affectedAgents) {
      const preRate = record.preChangeRates[agentId]?.successRate || 0;
      const currentStats = this.performanceStore.getStatsByAgentCategory(agentId, record.category);
      const postRate = currentStats.successRate || 0;
      const dispatchesSinceChange = currentStats.totalDispatches - (record.preChangeRates[agentId]?.totalDispatches || 0);
      
      const delta = postRate - preRate;
      sampleSize += dispatchesSinceChange;

      attributionResults.push({
        agentId,
        preSuccessRate: preRate,
        postSuccessRate: postRate,
        delta,
        dispatchesSinceChange,
      });

      totalDelta += delta;
    }

    // Compute overall delta and verdict
    const avgDelta = attributionResults.length > 0 ? totalDelta / attributionResults.length : 0;
    
    // Determine verdict based on delta and confidence
    let verdict = 'inconclusive';
    let confidence = 0.0;

    if (sampleSize >= this.minDispatchesForAttribution && hoursElapsed >= this.minHoursElapsed) {
      confidence = 1.0;
      if (avgDelta > 0.05) {
        verdict = 'effective';
      } else if (avgDelta < -0.05) {
        verdict = 'ineffective';
      } else {
        verdict = 'inconclusive';
      }
    } else if (sampleSize >= 20 || hoursElapsed >= 12) {
      confidence = 0.6;
      if (avgDelta > 0.08) {
        verdict = 'effective';
      } else if (avgDelta < -0.08) {
        verdict = 'ineffective';
      } else {
        verdict = 'inconclusive';
      }
    } else {
      confidence = Math.min(sampleSize / this.minDispatchesForAttribution, 0.3);
      verdict = 'inconclusive';
    }

    const result = {
      proposalId,
      category: record.category,
      status: 'evaluated',
      verdict,
      confidence,
      delta: avgDelta,
      sampleSize,
      hoursElapsed: hoursElapsed.toFixed(2),
      attributionResults,
      preRates: record.preChangeRates,
      currentRates: this._getCurrentRates(record.affectedAgents, record.category),
      evaluatedAt: new Date().toISOString(),
    };

    // Cache the result
    record.attributionResult = result;
    record.status = 'evaluated';
    this._saveTrackingData();

    return result;
  }

  _getCurrentRates(affectedAgents, category) {
    const rates = {};
    for (const agentId of affectedAgents) {
      const stats = this.performanceStore.getStatsByAgentCategory(agentId, category);
      rates[agentId] = {
        successRate: stats.successRate || 0,
        totalDispatches: stats.totalDispatches || 0,
        timestamp: new Date().toISOString(),
      };
    }
    return rates;
  }

  /**
   * Run attribution sweep across all applied overrides with sufficient data.
   * Persists results to the operator audit trail.
   * @returns {Promise<Object>} Summary of sweep results
   */
  async runAttributionSweep() {
    const now = Date.now();
    const evaluated = [];
    const skipped = [];
    const errors = [];

    for (const [proposalId, record] of Object.entries(this._trackingData.proposals)) {
      if (record.status === 'evaluated') {
        // Already evaluated, check if needs update
        const lastEvaluated = new Date(record.attributionResult?.evaluatedAt || record.appliedAt).getTime();
        const hoursSinceEval = (now - lastEvaluated) / (1000 * 60 * 60);
        
        if (hoursSinceEval < 24) {
          skipped.push({ proposalId, reason: 'evaluated_within_24h' });
          continue;
        }
      }

      try {
        const result = await this.checkAttribution(proposalId);
        
        if (result) {
          evaluated.push(result);
          
          // Persist to operator audit trail with full causal correlation
          if (this.operatorAudit) {
            this.operatorAudit.append({
              actionType: 'weight_attribution_result',
              correlationId: record.correlationId || proposalId,
              target: 'routing_weights',
              payload: {
                proposalId,
                category: record.category,
                verdict: result.verdict,
                confidence: result.confidence,
                delta: result.delta,
                sampleSize: result.sampleSize,
                hoursElapsed: parseFloat(result.hoursElapsed),
                attributionResults: result.attributionResults,
                preRates: result.preRates,
                currentRates: result.currentRates,
              },
            });
          }

          log.info('Attribution sweep: recorded result', {
            proposalId,
            verdict: result.verdict,
            delta: result.delta?.toFixed(4),
          });
        }
      } catch (err) {
        log.error('Attribution sweep failed for proposal', { proposalId, error: err.message });
        errors.push({ proposalId, error: err.message });
      }
    }

    this._trackingData.lastSweep = new Date().toISOString();
    this._saveTrackingData();

    return {
      evaluated: evaluated.length,
      skipped: skipped.length,
      errors: errors.length,
      evaluations: evaluated,
    };
  }

  /**
   * Get tracking data for a specific proposal.
   * @param {string} proposalId
   * @returns {Object|null}
   */
  getProposalTracking(proposalId) {
    return this._trackingData.proposals[proposalId] || null;
  }

  /**
   * Get all tracked proposals.
   * @returns {Object}
   */
  getAllProposals() {
    return this._trackingData.proposals;
  }

  /**
   * Get sweep history.
   * @returns {Object}
   */
  getSweepHistory() {
    return {
      lastSweep: this._trackingData.lastSweep,
      totalProposals: Object.keys(this._trackingData.proposals).length,
    };
  }
}
