/**
 * TimelineStore Performance Extensions
 * 
 * Provides optimized query methods for trace reconstruction and performance benchmarking.
 */

import { createLogger } from '../logger.js';

const log = createLogger('timeline-store-perf');

/**
 * Get all events for a campaign in a single batch query
 * This is optimized for trace reconstruction by fetching all events at once
 * and grouping them in memory rather than querying per node.
 * 
 * @param {string} campaignId - Campaign ID to fetch events for
 * @param {number} [limit=10000] - Maximum number of events to fetch
 * @returns {Promise<Array>} All events for the campaign
 */
export async function getAllCampaignEvents(timelineStore, campaignId, limit = 10000) {
  const startTime = performance.now();
  
  if (!campaignId || typeof campaignId !== 'string') {
    throw new TypeError('campaignId is required and must be a string');
  }
  
  if (!timelineStore || typeof timelineStore.query !== 'function') {
    throw new Error('timelineStore is required with query method');
  }
  
  // Fetch all events for the campaign in a single query
  const result = timelineStore.query({
    campaignId,
    limit: limit,
    offset: 0,
  });
  
  const events = result.events || [];
  const latencyMs = performance.now() - startTime;
  
  log.debug('Fetched all campaign events', {
    campaignId,
    eventCount: events.length,
    latencyMs: latencyMs.toFixed(2),
  });
  
  return events;
}

/**
 * Get all error propagation events for a campaign
 * Optimized version that fetches in a single query
 * 
 * @param {string} campaignId - Campaign ID
 * @param {Object} timelineStore - TimelineStore instance
 * @returns {Array} Error propagation events
 */
export function getAllErrorPropagationEvents(campaignId, timelineStore) {
  const startTime = performance.now();
  
  if (!campaignId || typeof campaignId !== 'string') {
    throw new TypeError('campaignId is required and must be a string');
  }
  
  if (!timelineStore || typeof timelineStore.getErrorChainsByCampaign !== 'function') {
    throw new Error('timelineStore is required with getErrorChainsByCampaign method');
  }
  
  const events = timelineStore.getErrorChainsByCampaign(campaignId) || [];
  const latencyMs = performance.now() - startTime;
  
  log.debug('Fetched error propagation events', {
    campaignId,
    eventCount: events.length,
    latencyMs: latencyMs.toFixed(2),
  });
  
  return events;
}

/**
 * Cache wrapper for campaign metadata lookups
 * Prevents repeated database queries for the same campaign/milestone/task data
 */
export class TraceMetadataCache {
  constructor() {
    this._campaignCache = new Map();
    this._milestoneCache = new Map();
    this._taskCache = new Map();
    this._accessCounts = new Map();
  }
  
  /**
   * Get or cache campaign metadata
   */
  getCampaign(campaignManager, projectId, campaignId) {
    const cacheKey = `${projectId}:${campaignId}`;
    
    if (this._campaignCache.has(cacheKey)) {
      this._incrementAccess(cacheKey);
      return this._campaignCache.get(cacheKey);
    }
    
    const campaign = campaignManager.getCampaign(projectId, campaignId);
    if (campaign) {
      this._campaignCache.set(cacheKey, campaign);
      this._incrementAccess(cacheKey);
    }
    
    return campaign;
  }
  
  /**
   * Get or cache milestone metadata
   */
  getMilestone(campaign, milestoneId) {
    if (!campaign || !milestoneId) return null;
    
    const cacheKey = `${campaign.id}:milestone:${milestoneId}`;
    
    if (this._milestoneCache.has(cacheKey)) {
      this._incrementAccess(cacheKey);
      return this._milestoneCache.get(cacheKey);
    }
    
    // Find milestone in campaign
    const milestone = campaign.milestones.find(m => m.id === milestoneId);
    if (milestone) {
      this._milestoneCache.set(cacheKey, milestone);
      this._incrementAccess(cacheKey);
    }
    
    return milestone;
  }
  
  /**
   * Get or cache task metadata
   */
  getTask(taskManager, projectId, taskId) {
    const cacheKey = `${projectId}:${taskId}`;
    
    if (this._taskCache.has(cacheKey)) {
      this._incrementAccess(cacheKey);
      return this._taskCache.get(cacheKey);
    }
    
    const task = taskManager.getTask(projectId, taskId);
    if (task) {
      this._taskCache.set(cacheKey, task);
      this._incrementAccess(cacheKey);
    }
    
    return task;
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    const totalAccesses = Array.from(this._accessCounts.values()).reduce((a, b) => a + b, 0);
    const hitRate = totalAccesses > 0 
      ? Array.from(this._accessCounts.values()).filter(c => c > 1).length / this._accessCounts.size * 100
      : 0;
    
    return {
      campaignCacheSize: this._campaignCache.size,
      milestoneCacheSize: this._milestoneCache.size,
      taskCacheSize: this._taskCache.size,
      totalCached: this._campaignCache.size + this._milestoneCache.size + this._taskCache.size,
      hitRate: hitRate.toFixed(2) + '%',
    };
  }
  
  /**
   * Clear all caches
   */
  clear() {
    this._campaignCache.clear();
    this._milestoneCache.clear();
    this._taskCache.clear();
    this._accessCounts.clear();
  }
  
  _incrementAccess(key) {
    const current = this._accessCounts.get(key) || 0;
    this._accessCounts.set(key, current + 1);
  }
}

/**
 * Group events by hierarchy level for efficient trace tree construction
 * 
 * @param {Array} events - All events for a campaign
 * @returns {Object} Grouped events by campaign/milestone/task/subtask
 */
export function groupEventsByHierarchy(events) {
  const startTime = performance.now();
  
  const grouped = {
    campaign: new Map(),
    milestone: new Map(),
    task: new Map(),
    subtask: new Map(),
  };
  
  for (const event of events) {
    const eventId = event.id || event.event_id;
    
    // Group by subtask_id if present
    if (event.subtask_id) {
      if (!grouped.subtask.has(event.subtask_id)) {
        grouped.subtask.set(event.subtask_id, []);
      }
      grouped.subtask.get(event.subtask_id).push(event);
    }
    
    // Group by task_id
    if (event.task_id) {
      if (!grouped.task.has(event.task_id)) {
        grouped.task.set(event.task_id, []);
      }
      grouped.task.get(event.task_id).push(event);
    }
    
    // Group by milestone_id
    if (event.milestone_id) {
      if (!grouped.milestone.has(event.milestone_id)) {
        grouped.milestone.set(event.milestone_id, []);
      }
      grouped.milestone.get(event.milestone_id).push(event);
    }
    
    // Group by campaign_id
    if (event.campaign_id) {
      if (!grouped.campaign.has(event.campaign_id)) {
        grouped.campaign.set(event.campaign_id, []);
      }
      grouped.campaign.get(event.campaign_id).push(event);
    }
  }
  
  const latencyMs = performance.now() - startTime;
  
  log.debug('Grouped events by hierarchy', {
    campaignCount: grouped.campaign.size,
    milestoneCount: grouped.milestone.size,
    taskCount: grouped.task.size,
    subtaskCount: grouped.subtask.size,
    latencyMs: latencyMs.toFixed(2),
  });
  
  return grouped;
}

/**
 * Build a pre-aggregated status map for all nodes in a campaign
 * This avoids multiple passes over the events data
 * 
 * @param {Object} groupedEvents - Events grouped by hierarchy level
 * @param {Object} campaignData - Campaign data with milestones/tasks/subtasks
 * @returns {Object} Status map with node status and event counts
 */
export function buildStatusMap(groupedEvents, campaignData) {
  const statusMap = new Map();
  
  // Process campaign status
  const campaignEvents = groupedEvents.campaign.get(campaignData.id) || [];
  statusMap.set(campaignData.id, {
    nodeType: 'campaign',
    status: campaignData.status,
    eventCount: campaignEvents.length,
  });
  
  // Process milestones
  for (const milestone of campaignData.milestones || []) {
    const milestoneEvents = groupedEvents.milestone.get(milestone.id) || [];
    statusMap.set(milestone.id, {
      nodeType: 'milestone',
      status: milestone.status,
      eventCount: milestoneEvents.length,
      childIds: milestone.tasks || [],
    });
  }
  
  // Process tasks and subtasks
  for (const milestone of campaignData.milestones || []) {
    for (const taskId of milestone.tasks || []) {
      const task = campaignData.tasks?.find(t => t.id === taskId);
      if (!task) continue;
      
      const taskEvents = groupedEvents.task.get(taskId) || [];
      statusMap.set(taskId, {
        nodeType: 'task',
        status: task.status,
        eventCount: taskEvents.length,
        childIds: task.subtasks || [],
      });
      
      // Process subtasks
      for (const subtaskId of task.subtasks || []) {
        const subtaskEvents = groupedEvents.subtask.get(subtaskId) || [];
        const subtask = campaignData.subtasks?.find(s => s.id === subtaskId);
        
        statusMap.set(subtaskId, {
          nodeType: 'subtask',
          status: subtask?.status || 'pending',
          eventCount: subtaskEvents.length,
        });
      }
    }
  }
  
  return statusMap;
}

/**
 * Benchmark trace reconstruction performance
 * 
 * @param {Object} options
 * @param {string} options.campaignId - Campaign ID to benchmark
 * @param {Object} options.timelineStore - TimelineStore instance
 * @param {Object} options.campaignManager - CampaignManager instance
 * @param {Object} options.taskManager - TaskManager instance
 * @param {Function} options.traceBuilder - buildCampaignTraceTree function
 * @param {number} options.iterations - Number of iterations to run (default: 10)
 * @returns {Object} Benchmark results with timing statistics
 */
export async function benchmarkTraceReconstruction(options) {
  const {
    campaignId,
    timelineStore,
    campaignManager,
    taskManager,
    traceBuilder,
    iterations = 10,
  } = options;
  
  if (!campaignId) {
    throw new TypeError('campaignId is required');
  }
  
  if (!traceBuilder || typeof traceBuilder !== 'function') {
    throw new TypeError('traceBuilder function is required');
  }
  
  const latencies = [];
  const errors = [];
  
  log.info('Starting trace reconstruction benchmark', {
    campaignId,
    iterations,
  });
  
  for (let i = 0; i < iterations; i++) {
    const startTime = performance.now();
    
    try {
      await traceBuilder(campaignId, timelineStore, campaignManager, taskManager);
      const latency = performance.now() - startTime;
      latencies.push(latency);
    } catch (err) {
      errors.push({
        iteration: i,
        error: err.message,
      });
      log.error('Benchmark iteration failed', { iteration: i, error: err.message });
    }
  }
  
  if (latencies.length === 0) {
    throw new Error('All benchmark iterations failed');
  }
  
  // Calculate statistics
  const sorted = [...latencies].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  
  const results = {
    campaignId,
    iterations,
    successCount: latencies.length,
    errorCount: errors.length,
    latencies: {
      min: min.toFixed(2) + 'ms',
      max: max.toFixed(2) + 'ms',
      avg: avg.toFixed(2) + 'ms',
      p50: p50.toFixed(2) + 'ms',
      p95: p95.toFixed(2) + 'ms',
      p99: p99.toFixed(2) + 'ms',
    },
    meetsTarget: avg < 100 && p99 < 500,
    errors: errors.length > 0 ? errors : undefined,
  };
  
  log.info('Benchmark complete', {
    campaignId,
    avgLatency: results.latencies.avg,
    p99Latency: results.latencies.p99,
    meetsTarget: results.meetsTarget,
  });
  
  return results;
}

/**
 * Validate trace reconstruction performance meets SLA requirements
 * 
 * @param {Object} benchmarkResults - Results from benchmarkTraceReconstruction
 * @param {Object} [options]
 * @param {number} [options.maxAvgLatency=100] - Maximum average latency in ms
 * @param {number} [options.maxP99Latency=500] - Maximum P99 latency in ms
 * @returns {Object} Validation result with pass/fail status
 */
export function validatePerformanceSLA(benchmarkResults, options = {}) {
  const {
    maxAvgLatency = 100,
    maxP99Latency = 500,
  } = options;
  
  const avgLatency = parseFloat(benchmarkResults.latencies.avg);
  const p99Latency = parseFloat(benchmarkResults.latencies.p99);
  
  const avgPass = avgLatency <= maxAvgLatency;
  const p99Pass = p99Latency <= maxP99Latency;
  
  return {
    passed: avgPass && p99Pass && benchmarkResults.successCount === benchmarkResults.iterations,
    metrics: {
      avgLatency: avgLatency.toFixed(2) + 'ms',
      p99Latency: p99Latency.toFixed(2) + 'ms',
      avgTarget: maxAvgLatency + 'ms',
      p99Target: maxP99Latency + 'ms',
    },
    details: {
      avgLatencyPass: avgPass,
      p99LatencyPass: p99Pass,
      allIterationsSucceeded: benchmarkResults.successCount === benchmarkResults.iterations,
    },
  };
}

export default {
  getAllCampaignEvents,
  getAllErrorPropagationEvents,
  TraceMetadataCache,
  groupEventsByHierarchy,
  buildStatusMap,
  benchmarkTraceReconstruction,
  validatePerformanceSLA,
};
