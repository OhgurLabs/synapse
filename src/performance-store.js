// PerformanceStore — stores agent performance metrics per task category
// Tracks success/failure rates, durations, and campaign history for last 50 campaigns
// Used by adaptive routing to prefer higher-performing agents per category

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from './logger.js';
import config from './config.js';

const log = createLogger('performance-store');

const MAX_CAMPAIGNS = 50;
const PERSIST_DEBOUNCE_MS = 10_000;

export class PerformanceStore {
  constructor(baseDir) {
    this._path = join(baseDir, '.synapse', 'performance.json');
    this._data = {
      byAgentCategory: {},
      byCampaign: {},
      lastUpdated: null,
    };
    this._dirty = false;
    this._persistTimer = null;
    this._load();
  }

  _load() {
    try {
      const raw = readFileSync(this._path, 'utf-8');
      this._data = JSON.parse(raw);
      this._migrateLegacyTimestamps();
    } catch {
      this._data = {
        byAgentCategory: {},
        byCampaign: {},
        lastUpdated: null,
      };
    }
  }

  _migrateLegacyTimestamps() {
    for (const record of Object.values(this._data.byAgentCategory)) {
      const history = record.dispatchHistory;
      if (!history || history.length === 0) continue;
      const hasLegacy = history.some(entry => entry.timestamp === undefined);
      if (!hasLegacy) continue;
      const lastUpdated = record.lastUpdated || new Date().toISOString();
      const lastUpdatedMs = new Date(lastUpdated).getTime();
      const interval = 60000;
      for (let i = 0; i < history.length; i++) {
        if (history[i].timestamp === undefined) {
          const entryTimeMs = lastUpdatedMs - (history.length - 1 - i) * interval;
          history[i].timestamp = new Date(entryTimeMs).toISOString();
        }
      }
    }
  }

  _schedulePersist() {
    if (this._persistTimer) return;
    this._dirty = true;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  _persist() {
    if (!this._dirty) return;
    try {
      mkdirSync(dirname(this._path), { recursive: true });
      writeFileSync(this._path, JSON.stringify(this._data, null, 2));
      this._dirty = false;
    } catch (err) {
      log.warn('Performance store persist failed', { error: err.message });
    }
  }

  _getAgentCategoryKey(agentId, category) {
    return `${agentId}::${category}`;
  }

  _isInfrastructureFailure(failureType) {
    const infrastructureTypes = ['timeout', 'rate_limit', 'disconnect', 'killed', 'process_error', 'api_error', 'network_error'];
    return infrastructureTypes.includes(failureType);
  }

  _ensureAgentCategoryRecord(agentId, category) {
    const key = this._getAgentCategoryKey(agentId, category);
    if (!this._data.byAgentCategory[key]) {
      this._data.byAgentCategory[key] = {
        agentId,
        taskCategory: category,
        successCount: 0,
        failureCount: 0,
        capabilityFailureCount: 0,
        infrastructureFailureCount: 0,
        totalDispatches: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        campaignIds: [],
        dispatchHistory: [],
        durationHistory: [],
        lastUpdated: null,
      };
    }
    // Ensure dispatchHistory exists for records loaded from disk
    if (!this._data.byAgentCategory[key].dispatchHistory) {
      this._data.byAgentCategory[key].dispatchHistory = [];
    }
    // Ensure durationHistory exists for records loaded from disk
    if (!this._data.byAgentCategory[key].durationHistory) {
      this._data.byAgentCategory[key].durationHistory = [];
    }
    // Migrate legacy records: add capability/infrastructure counts (default to capability for old failures)
    if (this._data.byAgentCategory[key].capabilityFailureCount === undefined) {
      this._data.byAgentCategory[key].capabilityFailureCount = this._data.byAgentCategory[key].failureCount || 0;
      this._data.byAgentCategory[key].infrastructureFailureCount = 0;
    }
    return this._data.byAgentCategory[key];
  }

  _ensureCampaignRecord(campaignId) {
    if (!this._data.byCampaign[campaignId]) {
      this._data.byCampaign[campaignId] = {
        campaignId,
        dispatches: [],
        completedAt: null,
      };
    }
    return this._data.byCampaign[campaignId];
  }

  updateAgentPerformance(agentId, category, success, durationMs, campaignId, failureType = null, tokenCostData = {}) {
    const record = this._ensureAgentCategoryRecord(agentId, category);
    const now = new Date().toISOString();

    record.totalDispatches += 1;
    record.totalDurationMs += (durationMs || 0);
    record.avgDurationMs = record.totalDurationMs / record.totalDispatches;

    if (success) {
      record.successCount += 1;
    } else {
      record.failureCount += 1;
      // Track failure type for capability scoring
      if (failureType === 'capability' || failureType === 'bug' || failureType === 'incorrect') {
        record.capabilityFailureCount += 1;
      } else if (failureType === 'timeout' || failureType === 'disconnect' || failureType === 'rate_limit' || failureType === 'killed' || failureType === 'sandbox' || failureType === 'provider_error') {
        record.infrastructureFailureCount += 1;
      } else {
        // Default: treat unclassified failures as capability for backward compatibility
        record.capabilityFailureCount += 1;
      }
    }

    // Add to dispatch history ring buffer (most recent last)
    const dispatchEntry = { success, failureType, timestamp: now };
    if (tokenCostData && typeof tokenCostData === 'object') {
      if (tokenCostData.inputTokens !== undefined) {
        dispatchEntry.inputTokens = tokenCostData.inputTokens;
      }
      if (tokenCostData.outputTokens !== undefined) {
        dispatchEntry.outputTokens = tokenCostData.outputTokens;
      }
      if (tokenCostData.costUsd !== undefined) {
        dispatchEntry.costUsd = tokenCostData.costUsd;
      }
    }
    record.dispatchHistory.push(dispatchEntry);
    if (record.dispatchHistory.length > 200) {
      record.dispatchHistory = record.dispatchHistory.slice(-200);
    }

    // Add to duration history ring buffer
    if (durationMs !== undefined && durationMs !== null) {
      record.durationHistory.push(durationMs);
      if (record.durationHistory.length > 200) {
        record.durationHistory = record.durationHistory.slice(-200);
      }
    }

    if (campaignId && !record.campaignIds.includes(campaignId)) {
      record.campaignIds.push(campaignId);
      if (record.campaignIds.length > MAX_CAMPAIGNS) {
        record.campaignIds = record.campaignIds.slice(-MAX_CAMPAIGNS);
      }
    }

    record.lastUpdated = now;

    if (campaignId) {
      const campaign = this._ensureCampaignRecord(campaignId);
      const campaignDispatchEntry = {
        agentId,
        taskCategory: category,
        success,
        durationMs: durationMs || 0,
        recordedAt: now,
      };
      if (tokenCostData && typeof tokenCostData === 'object') {
        if (tokenCostData.inputTokens !== undefined) {
          campaignDispatchEntry.inputTokens = tokenCostData.inputTokens;
        }
        if (tokenCostData.outputTokens !== undefined) {
          campaignDispatchEntry.outputTokens = tokenCostData.outputTokens;
        }
        if (tokenCostData.costUsd !== undefined) {
          campaignDispatchEntry.costUsd = tokenCostData.costUsd;
        }
      }
      campaign.dispatches.push(campaignDispatchEntry);
    }

    this._schedulePersist();
    return record;
  }

  markCampaignCompleted(campaignId) {
    const campaign = this._ensureCampaignRecord(campaignId);
    campaign.completedAt = new Date().toISOString();
    this._schedulePersist();
  }

  getAgentStats(agentId, category) {
    if (category) {
      const key = this._getAgentCategoryKey(agentId, category);
      const record = this._data.byAgentCategory[key];
      if (!record) {
        return {
          agentId,
          taskCategory: category,
          successCount: 0,
          failureCount: 0,
          totalDispatches: 0,
          avgDurationMs: 0,
          successRate: 0,
          campaignIds: [],
          lastUpdated: null,
        };
      }
      return this._computeStats(record);
    }

    const allStats = [];
    for (const record of Object.values(this._data.byAgentCategory)) {
      if (record.agentId === agentId) {
        allStats.push(this._computeStats(record));
      }
    }
    return allStats;
  }

  _computeStats(record) {
    const total = record.totalDispatches;
    let successRate, failureRate;

    if (total === 0 || !record.dispatchHistory || record.dispatchHistory.length === 0) {
      successRate = 0;
      failureRate = 0;
    } else {
      const halfLife = config.router.decayHalfLife;
      const history = record.dispatchHistory;
      let sumWeight = 0;
      let sumWeightedSuccess = 0;

      const now = Date.now();
      for (let i = 0; i < history.length; i++) {
        const age = now - new Date(history[i].timestamp).getTime();
        const weight = Math.max(1e-10, Math.exp(-Math.LN2 * age / halfLife));
        sumWeight += weight;
        if (history[i].success) {
          sumWeightedSuccess += weight;
        }
      }

      successRate = sumWeightedSuccess / sumWeight;
      failureRate = total > 0 ? 1 - successRate : 0;
    }

    return {
      agentId: record.agentId,
      taskCategory: record.taskCategory,
      successCount: record.successCount,
      failureCount: record.failureCount,
      totalDispatches: total,
      avgDurationMs: record.avgDurationMs,
      successRate: successRate,
      failureRate: failureRate,
      campaignIds: record.campaignIds,
      lastUpdated: record.lastUpdated,
      durationHistory: record.durationHistory || [],
      dispatchHistory: record.dispatchHistory || [],
    };
  }

  getRollingSuccessRate(agentId, category, options = {}) {
    const { excludeInfrastructure = false } = options;
    const key = this._getAgentCategoryKey(agentId, category);
    const record = this._data.byAgentCategory[key];
    if (!record || !record.dispatchHistory || record.dispatchHistory.length === 0) {
      return { rollingRate: null, dispatchCount: 0, trend: 'stable' };
    }

    const windowSize = config.router.alertWindowSize;
    const history = record.dispatchHistory;
    const dispatchCount = history.length;
    const halfLife = config.router.decayHalfLife;

    if (dispatchCount < windowSize) {
      return { rollingRate: null, dispatchCount, trend: 'stable' };
    }

    const lastWindow = history.slice(-windowSize);
    let sumWeight = 0;
    let sumWeightedSuccess = 0;
    const useDecay = halfLife > 0;
    const now = Date.now();
    for (let i = 0; i < lastWindow.length; i++) {
      if (excludeInfrastructure && lastWindow[i].failureType && this._isInfrastructureFailure(lastWindow[i].failureType)) {
        continue;
      }
      let weight = 1;
      if (useDecay) {
        const age = now - new Date(lastWindow[i].timestamp).getTime();
        weight = Math.max(1e-10, Math.exp(-Math.LN2 * age / halfLife));
      }
      sumWeight += weight;
      if (lastWindow[i].success) {
        sumWeightedSuccess += weight;
      }
    }
    if (sumWeight === 0) {
      return { rollingRate: null, dispatchCount, trend: 'stable' };
    }
    const rollingRate = sumWeightedSuccess / sumWeight;

    if (dispatchCount < windowSize * 2) {
      return { rollingRate, dispatchCount, trend: 'stable' };
    }

    const priorWindow = history.slice(-windowSize * 2, -windowSize);
    let priorSumWeight = 0;
    let priorSumWeightedSuccess = 0;
    for (let i = 0; i < priorWindow.length; i++) {
      let priorWeight = 1;
      if (useDecay) {
        const age = now - new Date(priorWindow[i].timestamp).getTime();
        priorWeight = Math.max(1e-10, Math.exp(-Math.LN2 * age / halfLife));
      }
      priorSumWeight += priorWeight;
      if (priorWindow[i].success) {
        priorSumWeightedSuccess += priorWeight;
      }
    }
    const priorRate = priorSumWeightedSuccess / priorSumWeight;

    const diff = rollingRate - priorRate;
    const epsilon = 0.01;
    let trend;
    if (diff > epsilon) {
      trend = 'up';
    } else if (diff < -epsilon) {
      trend = 'down';
    } else {
      trend = 'stable';
    }

    return { rollingRate, dispatchCount, trend };
  }

  getAllRollingRates(windowSize) {
    const allRates = [];
    const effectiveWindowSize = windowSize || config.router.alertWindowSize;
    for (const record of Object.values(this._data.byAgentCategory)) {
      const history = record.dispatchHistory || [];
      const dispatchCount = history.length;
      
      let rollingRate = null;
      let trend = null;
      
      if (dispatchCount >= effectiveWindowSize) {
        const lastWindow = history.slice(-effectiveWindowSize);
        const successes = lastWindow.filter(entry => entry.success).length;
        rollingRate = successes / effectiveWindowSize;
        
        if (dispatchCount >= effectiveWindowSize) {
          const halfWindow = Math.floor(effectiveWindowSize / 2);
          const priorWindow = history.slice(0, halfWindow);
          const lastHalf = history.slice(-halfWindow);
          const priorSuccesses = priorWindow.filter(entry => entry.success).length;
          const lastSuccesses = lastHalf.filter(entry => entry.success).length;
          const priorRate = priorSuccesses / halfWindow;
          const lastRate = lastSuccesses / halfWindow;
          
          const diff = lastRate - priorRate;
          const epsilon = 0.01;
          if (diff > epsilon) {
            trend = 'improving';
          } else if (diff < -epsilon) {
            trend = 'degrading';
          } else {
            trend = 'stable';
          }
        }
      }
      
      allRates.push({
        agentId: record.agentId,
        category: record.taskCategory,
        rollingRate,
        totalDispatches: dispatchCount,
        trend,
      });
    }
    return allRates;
  }

  /**
   * Returns per-agent-category windowed success rates using flat-average (not exponential decay).
   * This is an intentional design choice for alert stability - the anomaly detector uses
   * a simple flat window to avoid the volatility of decayed weights when alerts need
   * sustained periods of good/bad performance before firing/resolving.
   * 
   * @param {number} windowSize - Number of recent dispatches to include (defaults to config.router.alertWindowSize)
   * @returns {Array} Array of window data objects with: agentId, category, successRate, dispatchCount, totalHistory, insufficientData
   */
  getDispatchWindows(windowSize, options = {}) {
    const { excludeInfrastructure = false } = options;
    const effectiveWindowSize = windowSize || config.router.alertWindowSize;
    const allWindows = [];
    
    for (const record of Object.values(this._data.byAgentCategory)) {
      const history = record.dispatchHistory || [];
      const dispatchCount = history.length;
      
      let windowData = null;
      if (dispatchCount >= effectiveWindowSize) {
        const window = history.slice(-effectiveWindowSize);
        let filteredWindow = window;
        if (excludeInfrastructure) {
          filteredWindow = window.filter(entry => {
            return !entry.failureType || !this._isInfrastructureFailure(entry.failureType);
          });
        }
        const successes = filteredWindow.filter(entry => entry.success).length;
        const successRate = filteredWindow.length > 0 ? successes / filteredWindow.length : 0;
        
        windowData = {
          agentId: record.agentId,
          category: record.taskCategory,
          successRate,
          dispatchCount: filteredWindow.length,
          totalHistory: dispatchCount,
        };
      } else if (dispatchCount > 0) {
        windowData = {
          agentId: record.agentId,
          category: record.taskCategory,
          successRate: null,
          dispatchCount: dispatchCount,
          totalHistory: dispatchCount,
          insufficientData: true,
        };
      }
      
      if (windowData) {
        allWindows.push(windowData);
      }
    }
    
    return allWindows;
  }

  _computeP95Latency(durations) {
    if (!durations || durations.length === 0) {
      return 0;
    }
    const sortedDurations = [...durations].sort((a, b) => a - b);
    const p95Index = Math.ceil(0.95 * sortedDurations.length) - 1;
    return sortedDurations[p95Index];
  }

  getStatsByAgentCategory(agentId, category) {
    const key = this._getAgentCategoryKey(agentId, category);
    const record = this._data.byAgentCategory[key];
    if (!record) {
      return {
        agentId,
        taskCategory: category,
        successCount: 0,
        failureCount: 0,
        totalDispatches: 0,
        avgDurationMs: 0,
        successRate: 0,
        failureRate: 0,
        campaignIds: [],
        lastUpdated: null,
      };
    }
    return this._computeStats(record);
  }

  getAllAgentStats() {
    const allStats = [];
    for (const record of Object.values(this._data.byAgentCategory)) {
      allStats.push(this._computeStats(record));
    }
    return allStats;
  }

  /**
   * Get capability-only stats (excludes infrastructure failures like timeout, rate_limit, etc.)
   * This is used for routing decisions to avoid penalizing agents for external failures
   */
  getCapabilityStats(agentId, category) {
    const key = this._getAgentCategoryKey(agentId, category);
    const record = this._data.byAgentCategory[key];
    if (!record) {
      return {
        agentId,
        taskCategory: category,
        successCount: 0,
        capabilityFailureCount: 0,
        infrastructureFailureCount: 0,
        totalDispatches: 0,
        avgDurationMs: 0,
        successRate: 0,
        capabilitySuccessRate: 0,
        campaignIds: [],
        lastUpdated: null,
      };
    }
    const total = record.successCount + record.capabilityFailureCount;
    const capabilitySuccessRate = total > 0 ? record.successCount / total : 0;
    return {
      agentId: record.agentId,
      taskCategory: record.taskCategory,
      successCount: record.successCount,
      capabilityFailureCount: record.capabilityFailureCount || 0,
      infrastructureFailureCount: record.infrastructureFailureCount || 0,
      totalDispatches: total,
      avgDurationMs: record.avgDurationMs,
      successRate: capabilitySuccessRate,
      capabilitySuccessRate: capabilitySuccessRate,
      campaignIds: record.campaignIds,
      lastUpdated: record.lastUpdated,
    };
  }

  getAllCapabilityStats() {
    const allStats = [];
    for (const record of Object.values(this._data.byAgentCategory)) {
      const total = record.successCount + (record.capabilityFailureCount || 0);
      const capabilitySuccessRate = total > 0 ? record.successCount / total : 0;
      allStats.push({
        agentId: record.agentId,
        taskCategory: record.taskCategory,
        successCount: record.successCount,
        capabilityFailureCount: record.capabilityFailureCount || 0,
        infrastructureFailureCount: record.infrastructureFailureCount || 0,
        totalDispatches: total,
        avgDurationMs: record.avgDurationMs,
        successRate: capabilitySuccessRate,
        capabilitySuccessRate: capabilitySuccessRate,
        campaignIds: record.campaignIds,
        lastUpdated: record.lastUpdated,
      });
    }
    return allStats;
  }

  getStatsByCategory(category) {
    const stats = [];
    for (const record of Object.values(this._data.byAgentCategory)) {
      if (record.taskCategory === category) {
        stats.push(this._computeStats(record));
      }
    }
    return stats;
  }

  getCampaignStats(campaignId) {
    const campaign = this._data.byCampaign[campaignId];
    if (!campaign) {
      return null;
    }
    return {
      campaignId: campaign.campaignId,
      dispatches: campaign.dispatches,
      completedAt: campaign.completedAt,
    };
  }

  getTopAgentsByCategory(category, limit = 5) {
    const stats = this.getStatsByCategory(category);
    stats.sort((a, b) => {
      if (a.totalDispatches < 5 || b.totalDispatches < 5) {
        return b.totalDispatches - a.totalDispatches;
      }
      return b.successRate - a.successRate;
    });
    return stats.slice(0, limit);
  }

  flush() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this._persist();
  }
}