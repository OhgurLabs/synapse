/**
 * Monitoring Agent — System metrics collection and persistence
 *
 * Continuously collects system health metrics: CPU usage, memory consumption,
 * task queue depth, agent status, error rates. Stores metrics with timestamps
 * and provides query interface for historical analysis.
 *
 * Integrates with:
 * - TelemetryStore for persistence
 * - EventBus for real-time metric broadcasts
 * - HealthAggregator for system health data
 * - TaskManager for queue depth
 */

import { createLogger } from '../logger.js';
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'fs';
import { join } from 'path';
import { performance } from 'perf_hooks';
import os from 'os';
import { MonitoringStore } from './monitoring-store.js';

const log = createLogger('monitoring-agent');

const DEFAULT_COLLECTION_INTERVAL_MS = 10000;

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_IN_MEMORY_METRICS = 1000;

const WRITE_BUFFER_MAX_SIZE = 500;

const WRITE_BUFFER_FLUSH_SIZE = 10;

const WRITE_RETRY_MAX_ATTEMPTS = 3;

const WRITE_RETRY_BASE_DELAY_MS = 100;

const WRITE_RETRY_MAX_DELAY_MS = 5000;

const TIMER_DRIFT_COMPENSATION_ENABLED = true;

/**
 * Monitoring Agent Configuration Schema
 *
 * @typedef {Object} MonitoringAgentConfig
 * @property {number} collectionIntervalMs - Interval between metric collections (default: 10000)
 * @property {number} retentionMs - How long to retain metrics (default: 604800000 = 7 days)
 * @property {boolean} enabled - Whether monitoring is enabled (default: true)
 * @property {string} storagePath - Path to store metrics file (default: .synapse/monitoring/metrics.jsonl)
 * @property {boolean} broadcastEnabled - Whether to broadcast metrics via WebSocket (default: true)
 * @property {Object} thresholds - Alert thresholds for metrics
 * @property {number} thresholds.cpuWarningPercent - CPU usage warning threshold (default: 70)
 * @property {number} thresholds.cpuCriticalPercent - CPU usage critical threshold (default: 90)
 * @property {number} thresholds.memoryWarningPercent - Memory usage warning threshold (default: 70)
 * @property {number} thresholds.memoryCriticalPercent - Memory usage critical threshold (default: 90)
 * @property {number} thresholds.queueDepthWarning - Task queue depth warning threshold (default: 10)
 * @property {number} thresholds.queueDepthCritical - Task queue depth critical threshold (default: 20)
 * @property {number} thresholds.errorRateWarningPercent - Error rate warning threshold (default: 5)
 * @property {number} thresholds.errorRateCriticalPercent - Error rate critical threshold (default: 10)
 */

/**
 * Metric Entry Schema
 *
 * @typedef {Object} MetricEntry
 * @property {number} timestamp - Unix timestamp in milliseconds
 * @property {string} isoTimestamp - ISO 8601 timestamp string
 * @property {string} agentId - Agent identifier (always 'monitoring-agent')
 * @property {Object} system - System-level metrics
 * @property {number} system.cpuUsagePercent - CPU usage percentage (0-100)
 * @property {number} system.memoryUsedMB - Memory used in megabytes
 * @property {number} system.memoryTotalMB - Total memory in megabytes
 * @property {number} system.memoryUsagePercent - Memory usage percentage (0-100)
 * @property {number} system.heapUsedMB - Heap memory used in megabytes
 * @property {number} system.heapTotalMB - Total heap memory in megabytes
 * @property {number} system.heapUsagePercent - Heap memory usage percentage (0-100)
 * @property {number} system.uptimeSeconds - Process uptime in seconds
 * @property {Object} taskQueue - Task queue metrics
  * @property {number} taskQueue.depth - Total number of queued tasks
  * @property {Object} taskQueue.byStatus - Task count by status
  * @property {number} taskQueue.byStatus.queued - Number of queued tasks
  * @property {number} taskQueue.byStatus.planning - Number of tasks in planning
  * @property {number} taskQueue.byStatus.executing - Number of executing tasks
  * @property {number} taskQueue.byStatus.reviewing - Number of tasks in review
  * @property {number} taskQueue.byStatus.done - Number of completed tasks
  * @property {number} taskQueue.byStatus.failed - Number of failed tasks
  * @property {number} taskQueue.byStatus.cancelled - Number of cancelled tasks
  * @property {number} taskQueue.projectsScanned - Number of projects scanned
  * @property {number} taskQueue.errorCount - Number of errors during collection
  * @property {Object} agents - Agent status metrics
 * @property {number} agents.total - Total number of agents
 * @property {number} agents.idle - Number of idle agents
 * @property {number} agents.thinking - Number of thinking agents
 * @property {number} agents.rateLimited - Number of rate-limited agents
 * @property {number} agents.paused - Number of paused agents
 * @property {Object} errors - Error rate metrics
 * @property {number} errors.count - Total error count in current window
 * @property {number} errors.ratePercent - Error rate as percentage of total operations
 * @property {number} errors.windowSeconds - Time window for error rate calculation
 * @property {Object} performance - Performance metrics
 * @property {number} performance.eventLoopLagMs - Event loop lag in milliseconds
 * @property {number} performance.activeHandles - Number of active handles
 * @property {number} performance.activeRequests - Number of active requests
 * @property {Object} alerts - Active alerts
 * @property {Array<string>} alerts.warnings - Array of warning messages
 * @property {Array<string>} alerts.critical - Array of critical alert messages
 * @property {Object} metadata - Additional metadata
 * @property {string} metadata.hostname - System hostname
 * @property {string} metadata.platform - Node.js platform
 * @property {string} metadata.nodeVersion - Node.js version
 * @property {number} metadata.pid - Process ID
 */

/**
 * Default monitoring agent configuration
 */
export const DEFAULT_MONITORING_CONFIG = {
  collectionIntervalMs: DEFAULT_COLLECTION_INTERVAL_MS,
  retentionMs: DEFAULT_RETENTION_MS,
  enabled: true,
  storagePath: '.synapse/monitoring/metrics.jsonl',
  broadcastEnabled: true,
  thresholds: {
    cpuWarningPercent: 70,
    cpuCriticalPercent: 90,
    memoryWarningPercent: 70,
    memoryCriticalPercent: 90,
    queueDepthWarning: 10,
    queueDepthCritical: 20,
    errorRateWarningPercent: 5,
    errorRateCriticalPercent: 10,
  },
};

/**
 * Create a monitoring agent instance
 *
 * @param {Object} deps - Dependencies
 * @param {string} deps.projectDir - Project directory path
 * @param {MonitoringAgentConfig} [deps.config] - Monitoring configuration (optional)
 * @param {Object} [deps.telemetryStore] - TelemetryStore instance for persistence
 * @param {Object} [deps.eventBus] - EventBus instance for real-time broadcasts
 * @param {Object} [deps.taskManager] - TaskManager instance for queue metrics
 * @param {Object} [deps.stateManager] - StateManager instance for listing projects
 * @param {Object} [deps.agents] - Agent registry for agent status
 * @param {Set} [deps.thinkingAgents] - Set of currently thinking agents
 * @param {Function} [deps.getAgentCooldowns] - Function to get agent cooldowns
 * @param {Function} [deps.isAgentPaused] - Function to check if agent is paused
 * @returns {Object} Monitoring agent instance
 */
export function createMonitoringAgent(deps) {
  const {
    projectDir,
    config: userConfig = {},
    telemetryStore = null,
    eventBus = null,
    taskManager = null,
    stateManager = null,
    agents = {},
    thinkingAgents = new Set(),
    getAgentCooldowns = () => new Map(),
    isAgentPaused = () => false,
  } = deps;

  const config = { ...DEFAULT_MONITORING_CONFIG, ...userConfig };
  
  let _intervalId = null;
  let _isRunning = false;
  let _isShuttingDown = false;
  let _inMemoryMetrics = [];
  let _errorHistory = [];
  let _totalOperations = 0;
  let _errorCount = 0;
  let _collectionCount = 0;
  let _lastCollectionTimestamp = null;
  const _errorWindowMs = 60000;

  let _lastCpuUsage = null;
  let _lastCpuTime = null;

  let _writeBuffer = [];
  let _retryQueue = [];
  let _retryTimerId = null;
  let _isFlushing = false;
  let _monitoringStore = null;
  let _shutdownHandlerBound = null;
  let _missedCollections = 0;
  let _expectedNextCollection = null;

  const storagePath = join(projectDir, config.storagePath);
  const storageDir = join(projectDir, '.synapse', 'monitoring');
  const dbPath = join(storageDir, 'monitoring.db');

  if (!existsSync(storageDir)) {
    try {
      mkdirSync(storageDir, { recursive: true });
      log.info('Created monitoring storage directory', { path: storageDir });
    } catch (err) {
      log.error('Failed to create monitoring storage directory', { error: err.message });
    }
  }

  try {
    _monitoringStore = new MonitoringStore({ dbPath });
    log.info('MonitoringStore initialized', { dbPath });
  } catch (err) {
    log.warn('MonitoringStore initialization failed, using JSONL-only persistence', { error: err.message });
    _monitoringStore = null;
  }

  /**
   * Collect CPU usage metrics using delta calculation for accuracy
   * @returns {Object} CPU metrics including usage percentage and detailed breakdown
   */
  function collectCpuUsage() {
    const currentCpuUsage = process.cpuUsage();
    const currentTime = performance.now();
    
    let cpuUsagePercent = 0;
    
    if (_lastCpuUsage && _lastCpuTime) {
      const timeDeltaMs = currentTime - _lastCpuTime;
      const userDeltaMs = (currentCpuUsage.user - _lastCpuUsage.user) / 1000;
      const systemDeltaMs = (currentCpuUsage.system - _lastCpuUsage.system) / 1000;
      const totalCpuDeltaMs = userDeltaMs + systemDeltaMs;
      
      // Calculate CPU usage as percentage of elapsed time
      // Multiply by number of CPUs to get system-wide usage
      const cpuCount = os.cpus().length;
      cpuUsagePercent = Math.min(100, (totalCpuDeltaMs / timeDeltaMs) * 100 * cpuCount);
    }
    
    // Update state for next calculation
    _lastCpuUsage = currentCpuUsage;
    _lastCpuTime = currentTime;
    
    // Get load averages (1, 5, 15 minute averages)
    const loadAvg = os.loadavg();
    const cpuCount = os.cpus().length;
    
    return {
      usagePercent: Math.round(cpuUsagePercent * 100) / 100,
      loadAverage: {
        '1min': Math.round(loadAvg[0] * 100) / 100,
        '5min': Math.round(loadAvg[1] * 100) / 100,
        '15min': Math.round(loadAvg[2] * 100) / 100,
      },
      cpuCount: cpuCount,
      loadPercent: {
        '1min': Math.round((loadAvg[0] / cpuCount) * 10000) / 100,
        '5min': Math.round((loadAvg[1] / cpuCount) * 10000) / 100,
        '15min': Math.round((loadAvg[2] / cpuCount) * 10000) / 100,
      },
    };
  }

  /**
   * Collect memory usage metrics with detailed breakdown
   * @returns {Object} Memory metrics
   */
  function collectMemoryUsage() {
    const mem = process.memoryUsage();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    
    // Get detailed heap statistics if available
    let heapStats = {};
    try {
      heapStats = process.memoryUsage().heapStatistics || {};
    } catch (err) {
      // heapStatistics might not be available in all Node.js versions
    }
    
    return {
      system: {
        totalMB: Math.round(totalMemory / 1024 / 1024),
        usedMB: Math.round(usedMemory / 1024 / 1024),
        freeMB: Math.round(freeMemory / 1024 / 1024),
        usagePercent: Math.round((usedMemory / totalMemory) * 10000) / 100,
      },
      process: {
        rssMB: Math.round(mem.rss / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapUsagePercent: Math.round((mem.heapUsed / mem.heapTotal) * 10000) / 100,
        externalMB: Math.round(mem.external / 1024 / 1024),
        arrayBuffersMB: Math.round((mem.arrayBuffers || 0) / 1024 / 1024),
      },
      heapStats: heapStats,
    };
  }

  /**
   * Collect process statistics using Node.js built-in modules
   * @returns {Object} Process statistics
   */
  function collectProcessStats() {
    const uptime = process.uptime();
    const cpuUsage = process.cpuUsage();
    
    // Get CPU information
    const cpus = os.cpus();
    const cpuInfo = {
      count: cpus.length,
      model: cpus[0]?.model || 'unknown',
      speed: cpus[0]?.speed || 0,
    };
    
    // Get OS information
    const osInfo = {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      homedir: os.homedir(),
      tmpdir: os.tmpdir(),
    };
    
    // Get network interfaces
    let networkInterfaces = {};
    try {
      networkInterfaces = os.networkInterfaces();
    } catch (err) {
      // Might fail in some environments
    }
    
    return {
      pid: process.pid,
      ppid: process.ppid,
      uptime: {
        seconds: uptime,
        human: formatUptime(uptime),
      },
      cpuUsage: {
        user: cpuUsage.user,
        system: cpuUsage.system,
        userMicroseconds: cpuUsage.user,
        systemMicroseconds: cpuUsage.system,
      },
      versions: {
        node: process.version,
        v8: process.versions.v8,
        openssl: process.versions.openssl,
        uv: process.versions.uv,
        zlib: process.versions.zlib,
        brotli: process.versions.brotli,
        ares: process.versions.ares,
        modules: process.versions.modules,
        npm: process.versions.npm,
      },
      environment: {
        execPath: process.execPath,
        execArgv: process.execArgv,
        argv: process.argv,
        cwd: process.cwd(),
      },
      features: {
        inspector: process.features.inspector,
        uv: process.features.uv,
        ipv6: process.features.ipv6,
        tls_alpn: process.features.tls_alpn,
        tls_sni: process.features.tls_sni,
        tls_ocsp: process.features.tls_ocsp,
        tls: process.features.tls,
      },
      resourceUsage: process.resourceUsage ? process.resourceUsage() : null,
      cpuInfo,
      osInfo,
      networkInterfaces: Object.keys(networkInterfaces).length > 0 ? networkInterfaces : null,
    };
  }

  /**
   * Format uptime in human-readable format
   * @param {number} seconds - Uptime in seconds
   * @returns {string} Formatted uptime string
   */
  function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    
    return parts.join(' ');
  }

  /**
   * Collect task queue metrics
   * @returns {Object} Task queue metrics
   */
  function collectTaskQueueMetrics() {
    if (!taskManager || !stateManager) {
      log.debug('Task queue metrics unavailable: taskManager or stateManager not provided');
      return {
        depth: 0,
        byStatus: {
          queued: 0,
          planning: 0,
          executing: 0,
          reviewing: 0,
          done: 0,
          failed: 0,
          cancelled: 0,
        },
        projectsScanned: 0,
        errorCount: 0,
      };
    }

    const byStatus = {
      queued: 0,
      planning: 0,
      executing: 0,
      reviewing: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    };

    let totalDepth = 0;
    let projectsScanned = 0;
    let errorCount = 0;

    try {
      if (typeof stateManager.listProjects === 'function') {
        const projects = stateManager.listProjects();
        const projectIds = projects.map(p => p.id || p);

        for (const projectId of projectIds) {
          try {
            const tasks = taskManager.listTasks(projectId) || [];
            totalDepth += tasks.length;
            projectsScanned++;

            for (const task of tasks) {
              const status = task?.status;
              if (status && byStatus.hasOwnProperty(status)) {
                byStatus[status]++;
              }
            }
          } catch (err) {
            errorCount++;
            log.warn('Failed to collect task metrics for project', { projectId, error: err.message });
          }
        }
      }
    } catch (err) {
      log.error('Failed to collect task queue metrics', { error: err.message });
      errorCount++;
    }

    return {
      depth: totalDepth,
      byStatus,
      projectsScanned,
      errorCount,
    };
  }

  /**
   * Collect agent status metrics
   * @returns {Object} Agent status metrics
   */
  function collectAgentStatusMetrics() {
    const agentIds = Object.keys(agents);
    const cooldowns = getAgentCooldowns();
    
    let idle = 0;
    let thinking = 0;
    let rateLimited = 0;
    let paused = 0;
    const agentDetails = [];

    const now = Date.now();

    for (const agentId of agentIds) {
      const isThinking = Array.from(thinkingAgents).some(key => key.endsWith(`#${agentId}`));
      const cooldownEntry = cooldowns.get(agentId);
      const isRateLimited = cooldownEntry && cooldownEntry.until > now;
      const isPaused = isAgentPaused(agentId);

      let status = 'idle';
      if (isPaused) {
        paused++;
        status = 'paused';
      } else if (isRateLimited) {
        rateLimited++;
        status = 'rate_limited';
      } else if (isThinking) {
        thinking++;
        status = 'thinking';
      } else {
        idle++;
      }

      agentDetails.push({
        id: agentId,
        status,
        cooldownUntil: isRateLimited ? cooldownEntry.until : null,
      });
    }

    return {
      total: agentIds.length,
      idle,
      thinking,
      rateLimited,
      paused,
      details: agentDetails,
    };
  }

  /**
   * Collect error rate metrics
   * @returns {Object} Error rate metrics
   */
  function collectErrorMetrics() {
    const now = Date.now();
    
    // Clean old error history
    _errorHistory = _errorHistory.filter(ts => now - ts < _errorWindowMs);
    
    const count = _errorHistory.length;
    const ratePercent = _totalOperations > 0 ? (count / _totalOperations) * 100 : 0;
    
    return {
      count,
      ratePercent: Math.round(ratePercent * 100) / 100,
      windowSeconds: _errorWindowMs / 1000,
    };
  }

  /**
   * Collect performance metrics
   * @returns {Object} Performance metrics
   */
  function collectPerformanceMetrics() {
    return {
      eventLoopLagMs: measureEventLoopLag(),
      activeHandles: process._getActiveHandles?.().length || 0,
      activeRequests: process._getActiveRequests?.().length || 0,
    };
  }

  let _lastEventLoopLagMs = 0;

  function measureEventLoopLag() {
    const start = performance.now();
    setImmediate(() => {
      _lastEventLoopLagMs = performance.now() - start;
    });
    return _lastEventLoopLagMs;
  }

  /**
   * Check thresholds and generate alerts
   * @param {Object} metrics - Collected metrics
   * @returns {Object} Alerts object
   */
  function checkThresholds(metrics) {
    const warnings = [];
    const critical = [];

    // CPU thresholds
    const cpuUsage = metrics.cpu?.usagePercent || metrics.system?.cpuUsagePercent || 0;
    if (cpuUsage >= config.thresholds.cpuCriticalPercent) {
      critical.push(`CPU usage critical: ${cpuUsage}%`);
    } else if (cpuUsage >= config.thresholds.cpuWarningPercent) {
      warnings.push(`CPU usage high: ${cpuUsage}%`);
    }

    // Memory thresholds
    const memoryUsage = metrics.memory?.system?.usagePercent || metrics.system?.memoryUsagePercent || 0;
    if (memoryUsage >= config.thresholds.memoryCriticalPercent) {
      critical.push(`Memory usage critical: ${memoryUsage}%`);
    } else if (memoryUsage >= config.thresholds.memoryWarningPercent) {
      warnings.push(`Memory usage high: ${memoryUsage}%`);
    }

    // Queue depth thresholds
    if (metrics.taskQueue.depth >= config.thresholds.queueDepthCritical) {
      critical.push(`Task queue depth critical: ${metrics.taskQueue.depth}`);
    } else if (metrics.taskQueue.depth >= config.thresholds.queueDepthWarning) {
      warnings.push(`Task queue depth high: ${metrics.taskQueue.depth}`);
    }

    // Error rate thresholds
    if (metrics.errors.ratePercent >= config.thresholds.errorRateCriticalPercent) {
      critical.push(`Error rate critical: ${metrics.errors.ratePercent}%`);
    } else if (metrics.errors.ratePercent >= config.thresholds.errorRateWarningPercent) {
      warnings.push(`Error rate high: ${metrics.errors.ratePercent}%`);
    }

    return { warnings, critical };
  }

  /**
   * Record an error for error rate tracking
   */
  function recordError() {
    _errorHistory.push(Date.now());
    _errorCount++;
  }

  /**
   * Record an operation for error rate calculation
   */
  function recordOperation() {
    _totalOperations++;
  }

  /**
   * Collect all metrics
   * @returns {MetricEntry} Complete metric entry
   */
  function collectMetrics() {
    const now = Date.now();
    
    const cpuMetrics = collectCpuUsage();
    const memoryMetrics = collectMemoryUsage();
    const processStats = collectProcessStats();
    const taskQueueMetrics = collectTaskQueueMetrics();
    const agentMetrics = collectAgentStatusMetrics();
    const errorMetrics = collectErrorMetrics();
    const performanceMetrics = collectPerformanceMetrics();
    
    const metrics = {
      timestamp: now,
      isoTimestamp: new Date(now).toISOString(),
      agentId: 'monitoring-agent',
      system: {
        cpuUsagePercent: cpuMetrics.usagePercent,
        memoryUsedMB: memoryMetrics.system.usedMB,
        memoryTotalMB: memoryMetrics.system.totalMB,
        memoryUsagePercent: memoryMetrics.system.usagePercent,
        heapUsedMB: memoryMetrics.process.heapUsedMB,
        heapTotalMB: memoryMetrics.process.heapTotalMB,
        heapUsagePercent: memoryMetrics.process.heapUsagePercent,
        uptimeSeconds: processStats.uptime.seconds,
      },
      taskQueue: {
        depth: taskQueueMetrics.depth,
        byStatus: taskQueueMetrics.byStatus,
        projectsScanned: taskQueueMetrics.projectsScanned,
        errorCount: taskQueueMetrics.errorCount,
      },
      agents: {
        total: agentMetrics.total,
        idle: agentMetrics.idle,
        thinking: agentMetrics.thinking,
        rateLimited: agentMetrics.rateLimited,
        paused: agentMetrics.paused,
      },
      errors: errorMetrics,
      performance: performanceMetrics,
      alerts: checkThresholds({
        system: { cpuUsagePercent: cpuMetrics.usagePercent, memoryUsagePercent: memoryMetrics.system.usagePercent },
        taskQueue: taskQueueMetrics,
        errors: errorMetrics,
      }),
      metadata: {
        hostname: os.hostname(),
        platform: process.platform,
        nodeVersion: process.version,
        pid: process.pid,
      },
    };

    return metrics;
  }

  let _jsonlFd = null;

  function _getJsonlFd() {
    if (_jsonlFd) return _jsonlFd;
    try {
      _jsonlFd = openSync(storagePath, 'a');
      return _jsonlFd;
    } catch (err) {
      log.error('Failed to open JSONL file descriptor', { error: err.message });
      return null;
    }
  }

  function persistMetricsToJSONL(metrics) {
    try {
      const line = JSON.stringify(metrics) + '\n';
      const fd = _getJsonlFd();
      if (fd) {
        writeSync(fd, line);
        fsyncSync(fd);
      } else {
        appendFileSync(storagePath, line);
      }
      return true;
    } catch (err) {
      log.error('Failed to persist metrics to JSONL', { error: err.message });
      _jsonlFd = null;
      return false;
    }
  }

  function _closeJsonlFd() {
    if (_jsonlFd) {
      try {
        closeSync(_jsonlFd);
      } catch (err) {
        log.error('Failed to close JSONL file descriptor', { error: err.message });
      }
      _jsonlFd = null;
    }
  }

  function persistMetricsToStore(metrics) {
    if (!_monitoringStore) return false;
    try {
      _monitoringStore.recordMetric(metrics);
      return true;
    } catch (err) {
      log.error('Failed to persist metrics to MonitoringStore', { error: err.message });
      return false;
    }
  }

  function computeRetryDelay(attempt) {
    const delay = Math.min(
      WRITE_RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
      WRITE_RETRY_MAX_DELAY_MS
    );
    return delay + Math.random() * delay * 0.1;
  }

  function enqueueForRetry(metrics, attempts) {
    if (attempts >= WRITE_RETRY_MAX_ATTEMPTS) {
      log.error('Metric dropped after max retries', {
        timestamp: metrics.isoTimestamp,
        attempts,
      });
      _errorCount++;
      return;
    }
    _retryQueue.push({ metrics, attempts });
    if (!_retryTimerId) {
      const delay = computeRetryDelay(attempts);
      _retryTimerId = setTimeout(_drainRetryQueue, delay);
      _retryTimerId.unref();
    }
  }

  function _drainRetryQueue() {
    _retryTimerId = null;
    if (_retryQueue.length === 0) return;

    const batch = _retryQueue.splice(0, _retryQueue.length);
    const remaining = [];

    for (const { metrics, attempts } of batch) {
      const jsonlOk = persistMetricsToJSONL(metrics);
      const storeOk = persistMetricsToStore(metrics);
      if (!jsonlOk && !storeOk) {
        remaining.push({ metrics, attempts: attempts + 1 });
      }
    }

    if (remaining.length > 0) {
      _retryQueue.push(...remaining);
      const nextDelay = computeRetryDelay(remaining[0].attempts);
      _retryTimerId = setTimeout(_drainRetryQueue, nextDelay);
      _retryTimerId.unref();
    }
  }

  function persistMetrics(metrics) {
    const jsonlOk = persistMetricsToJSONL(metrics);
    const storeOk = persistMetricsToStore(metrics);

    if (!jsonlOk && !storeOk) {
      enqueueForRetry(metrics, 0);
    }
  }

  /**
   * Store metrics in memory
   * @param {MetricEntry} metrics - Metrics to store
   */
  function storeInMemory(metrics) {
    _inMemoryMetrics.push(metrics);
    
    // Enforce max size
    if (_inMemoryMetrics.length > MAX_IN_MEMORY_METRICS) {
      _inMemoryMetrics.shift();
    }
  }

  /**
   * Broadcast metrics via EventBus
   * @param {MetricEntry} metrics - Metrics to broadcast
   */
  function broadcastMetrics(metrics) {
    if (!eventBus || !config.broadcastEnabled) {
      return;
    }

    try {
      eventBus.emit('monitoring:metrics', metrics);
      log.debug('Metrics broadcasted', { timestamp: metrics.isoTimestamp });
    } catch (err) {
      log.error('Failed to broadcast metrics', { error: err.message });
    }
  }

  /**
   * Store metrics in TelemetryStore if available
   * @param {MetricEntry} metrics - Metrics to store
   */
  function storeInTelemetry(metrics) {
    if (!telemetryStore) {
      return;
    }

    try {
      telemetryStore.append('system', 'monitoring:metrics', metrics);
      log.debug('Metrics stored in telemetry', { timestamp: metrics.isoTimestamp });
    } catch (err) {
      log.error('Failed to store metrics in telemetry', { error: err.message });
    }
  }

  function collectionLoop() {
    try {
      const now = Date.now();
      if (_expectedNextCollection && now > _expectedNextCollection + config.collectionIntervalMs) {
        const missed = Math.floor((now - _expectedNextCollection) / config.collectionIntervalMs);
        _missedCollections += missed;
        log.warn('Collection gap detected', {
          missedCollections: missed,
          expectedAt: new Date(_expectedNextCollection).toISOString(),
          actualAt: new Date(now).toISOString(),
          totalMissed: _missedCollections,
        });
      }

      const metrics = collectMetrics();

      storeInMemory(metrics);
      broadcastMetrics(metrics);
      storeInTelemetry(metrics);

      if (_writeBuffer.length >= WRITE_BUFFER_MAX_SIZE) {
        log.warn('Write buffer overflow, forcing flush', {
          bufferSize: _writeBuffer.length,
          maxSize: WRITE_BUFFER_MAX_SIZE,
        });
        _flushBuffer();
      }

      _writeBuffer.push(metrics);

      if (_writeBuffer.length >= WRITE_BUFFER_FLUSH_SIZE || _isShuttingDown) {
        _flushBuffer();
      }

      recordOperation();
      _collectionCount++;
      _lastCollectionTimestamp = Date.now();
      _expectedNextCollection = _lastCollectionTimestamp + config.collectionIntervalMs;

      log.debug('Metrics collected', {
        cpu: metrics.system.cpuUsagePercent || 0,
        memory: metrics.system.memoryUsagePercent || 0,
        queueDepth: metrics.taskQueue.depth,
        agents: {
          total: metrics.agents.total,
          idle: metrics.agents.idle,
          thinking: metrics.agents.thinking,
          rateLimited: metrics.agents.rateLimited,
          paused: metrics.agents.paused,
        },
        errors: metrics.errors.ratePercent,
        bufferDepth: _writeBuffer.length,
        retryQueueDepth: _retryQueue.length,
      });
    } catch (err) {
      log.error('Failed to collect metrics', { error: err.message, stack: err.stack });
      recordError();
    }
  }

  function _flushBuffer() {
    if (_isFlushing || _writeBuffer.length === 0) return;
    _isFlushing = true;

    const batch = _writeBuffer.splice(0, _writeBuffer.length);

    for (const metrics of batch) {
      persistMetrics(metrics);
    }

    _isFlushing = false;
  }

  async function flush() {
    log.info('Flushing monitoring buffers', {
      writeBuffer: _writeBuffer.length,
      retryQueue: _retryQueue.length,
    });

    _flushBuffer();

    if (_retryQueue.length > 0) {
      if (_retryTimerId) {
        clearTimeout(_retryTimerId);
        _retryTimerId = null;
      }
      _drainRetryQueue();
    }

    if (_monitoringStore) {
      try {
        const latest = _monitoringStore.getLatestMetric();
        log.info('MonitoringStore flush complete', {
          latestTimestamp: latest?.isoTimestamp || 'none',
        });
      } catch (err) {
        log.error('MonitoringStore flush verification failed', { error: err.message });
      }
    }

    log.info('Monitoring flush complete');
  }

  function _driftCompensatedTimer() {
    const startTime = Date.now();

    collectionLoop();

    const elapsed = Date.now() - startTime;
    const nextDelay = Math.max(1, config.collectionIntervalMs - elapsed);

    if (_isRunning) {
      _intervalId = setTimeout(_driftCompensatedTimer, nextDelay);
      _intervalId.unref();
    }
  }

  function _installShutdownHooks() {
    _shutdownHandlerBound = _handleGracefulShutdown.bind(this);
    process.on('SIGTERM', _shutdownHandlerBound);
    process.on('SIGINT', _shutdownHandlerBound);
    process.on('beforeExit', _shutdownHandlerBound);
  }

  function _removeShutdownHooks() {
    if (_shutdownHandlerBound) {
      process.removeListener('SIGTERM', _shutdownHandlerBound);
      process.removeListener('SIGINT', _shutdownHandlerBound);
      process.removeListener('beforeExit', _shutdownHandlerBound);
      _shutdownHandlerBound = null;
    }
  }

  async function _handleGracefulShutdown(signal) {
    if (_isShuttingDown) return;
    _isShuttingDown = true;

    log.info('Graceful shutdown initiated', { signal });

    stop();

    try {
      await flush();
    } catch (err) {
      log.error('Error during flush on shutdown', { error: err.message });
    }

    if (_monitoringStore) {
      try {
        _monitoringStore.close();
      } catch (err) {
        log.error('Error closing MonitoringStore', { error: err.message });
      }
    }

    _removeShutdownHooks();

    if (signal === 'SIGTERM' || signal === 'SIGINT') {
      process.exit(0);
    }
  }

  function start() {
    if (_isRunning) {
      log.warn('Monitoring agent already running');
      return;
    }

    if (!config.enabled) {
      log.info('Monitoring agent disabled in config');
      return;
    }

    _isRunning = true;
    _isShuttingDown = false;

    collectionLoop();

    if (TIMER_DRIFT_COMPENSATION_ENABLED) {
      const startTime = Date.now();
      const firstDelay = Math.max(1, config.collectionIntervalMs - (Date.now() - startTime));
      _intervalId = setTimeout(_driftCompensatedTimer, firstDelay);
      _intervalId.unref();
    } else {
      _intervalId = setInterval(collectionLoop, config.collectionIntervalMs);
    }

    _installShutdownHooks();

    log.info('Monitoring agent started', {
      intervalMs: config.collectionIntervalMs,
      retentionMs: config.retentionMs,
      storagePath,
      dbPath,
      driftCompensation: TIMER_DRIFT_COMPENSATION_ENABLED,
    });
  }

  function stop() {
    if (!_isRunning) {
      log.warn('Monitoring agent not running');
      return;
    }

    _isRunning = false;

    if (_intervalId) {
      clearTimeout(_intervalId);
      clearInterval(_intervalId);
      _intervalId = null;
    }

    if (_retryTimerId) {
      clearTimeout(_retryTimerId);
      _retryTimerId = null;
    }

    _flushBuffer();
    _closeJsonlFd();

    const retryDrainBatch = _retryQueue.splice(0, _retryQueue.length);
    for (const { metrics, attempts } of retryDrainBatch) {
      const jsonlOk = persistMetricsToJSONL(metrics);
      const storeOk = persistMetricsToStore(metrics);
      if (!jsonlOk && !storeOk) {
        log.error('Metric lost on stop', { timestamp: metrics.isoTimestamp, attempts });
      }
    }
    _closeJsonlFd();

    if (_monitoringStore) {
      try {
        _monitoringStore.close();
        _monitoringStore = null;
      } catch (err) {
        log.error('Error closing MonitoringStore on stop', { error: err.message });
      }
    }

    _removeShutdownHooks();

    log.info('Monitoring agent stopped', {
      collectionsPerformed: _collectionCount,
      missedCollections: _missedCollections,
      lastCollection: _lastCollectionTimestamp ? new Date(_lastCollectionTimestamp).toISOString() : null,
    });
  }

  /**
   * Query metrics by time range
   * @param {number} startTime - Start timestamp (Unix ms)
   * @param {number} endTime - End timestamp (Unix ms)
   * @returns {Array<MetricEntry>} Array of metrics in time range
   */
  function queryMetrics(startTime, endTime) {
    let results = _inMemoryMetrics.filter(m => 
      m.timestamp >= startTime && m.timestamp <= endTime
    );

    if (results.length === 0 && _monitoringStore) {
      try {
        results = _monitoringStore.queryMetrics({ startTime, endTime });
      } catch (err) {
        log.error('Failed to query MonitoringStore', { error: err.message });
      }
    }

    if (results.length === 0 && existsSync(storagePath)) {
      try {
        const content = readFileSync(storagePath, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        
        for (const line of lines) {
          try {
            const metrics = JSON.parse(line);
            if (metrics.timestamp >= startTime && metrics.timestamp <= endTime) {
              results.push(metrics);
            }
          } catch (parseErr) {
            log.warn('Failed to parse metric line', { error: parseErr.message });
          }
        }
      } catch (err) {
        log.error('Failed to read metrics from storage', { error: err.message });
      }
    }

    const seen = new Set();
    results = results.filter(m => {
      if (seen.has(m.timestamp)) return false;
      seen.add(m.timestamp);
      return true;
    });

    results.sort((a, b) => a.timestamp - b.timestamp);

    return results;
  }

  /**
   * Get latest metrics
   * @returns {MetricEntry|null} Latest metrics entry
   */
  function getLatestMetrics() {
    if (_inMemoryMetrics.length > 0) {
      return _inMemoryMetrics[_inMemoryMetrics.length - 1];
    }
    return null;
  }

  /**
   * Get aggregated metrics summary
   * @param {number} startTime - Start timestamp (Unix ms)
   * @param {number} endTime - End timestamp (Unix ms)
   * @returns {Object} Aggregated metrics summary
   */
  function getMetricsSummary(startTime, endTime) {
    const metrics = queryMetrics(startTime, endTime);
    
    if (metrics.length === 0) {
      return null;
    }

    // Calculate averages - handle both old and new metric formats
    const avgCpu = metrics.reduce((sum, m) => sum + (m.system?.cpuUsagePercent || m.cpu?.usagePercent || 0), 0) / metrics.length;
    const avgMemory = metrics.reduce((sum, m) => sum + (m.system?.memoryUsagePercent || m.memory?.system?.usagePercent || 0), 0) / metrics.length;
    const avgQueueDepth = metrics.reduce((sum, m) => sum + m.taskQueue.depth, 0) / metrics.length;
    const avgErrorRate = metrics.reduce((sum, m) => sum + m.errors.ratePercent, 0) / metrics.length;

    // Find max values
    const maxCpu = Math.max(...metrics.map(m => m.system?.cpuUsagePercent || m.cpu?.usagePercent || 0));
    const maxMemory = Math.max(...metrics.map(m => m.system?.memoryUsagePercent || m.memory?.system?.usagePercent || 0));
    const maxQueueDepth = Math.max(...metrics.map(m => m.taskQueue.depth));
    const maxErrorRate = Math.max(...metrics.map(m => m.errors.ratePercent));

    return {
      period: {
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        sampleCount: metrics.length,
      },
      cpu: {
        avg: Math.round(avgCpu * 100) / 100,
        max: maxCpu,
      },
      memory: {
        avg: Math.round(avgMemory * 100) / 100,
        max: maxMemory,
      },
      queueDepth: {
        avg: Math.round(avgQueueDepth * 100) / 100,
        max: maxQueueDepth,
      },
      errorRate: {
        avg: Math.round(avgErrorRate * 100) / 100,
        max: maxErrorRate,
      },
    };
  }

  /**
   * Clean up old metrics based on retention policy
   */
  function cleanupOldMetrics() {
    if (!existsSync(storagePath)) {
      return;
    }

    const now = Date.now();
    const cutoff = now - config.retentionMs;
    
    try {
      const content = readFileSync(storagePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      
      const filteredLines = [];
      let removedCount = 0;

      for (const line of lines) {
        try {
          const metrics = JSON.parse(line);
          if (metrics.timestamp >= cutoff) {
            filteredLines.push(line);
          } else {
            removedCount++;
          }
        } catch (parseErr) {
          log.warn('Failed to parse metric line during cleanup', { error: parseErr.message });
        }
      }

      if (removedCount > 0) {
        const tmpPath = storagePath + '.tmp';
        writeFileSync(tmpPath, filteredLines.join('\n') + '\n');
        renameSync(tmpPath, storagePath);
        log.info('Cleaned up old metrics', { removedCount, cutoff: new Date(cutoff).toISOString() });
      }
    } catch (err) {
      log.error('Failed to cleanup old metrics', { error: err.message });
    }
  }

  /**
   * Get monitoring agent status
   * @returns {Object} Status information
   */
  function getStatus() {
    return {
      isRunning: _isRunning,
      isShuttingDown: _isShuttingDown,
      config: {
        enabled: config.enabled,
        collectionIntervalMs: config.collectionIntervalMs,
        retentionMs: config.retentionMs,
        storagePath,
        dbPath,
        driftCompensation: TIMER_DRIFT_COMPENSATION_ENABLED,
      },
      stats: {
        inMemoryMetricsCount: _inMemoryMetrics.length,
        totalErrors: _errorCount,
        totalOperations: _totalOperations,
        errorHistoryCount: _errorHistory.length,
        collectionsPerformed: _collectionCount,
        missedCollections: _missedCollections,
        lastCollectionTimestamp: _lastCollectionTimestamp,
        writeBufferDepth: _writeBuffer.length,
        retryQueueDepth: _retryQueue.length,
        monitoringStoreActive: _monitoringStore !== null,
      },
      latestMetrics: getLatestMetrics(),
    };
  }

  return {
    start,
    stop,
    flush,
    queryMetrics,
    getLatestMetrics,
    getMetricsSummary,
    cleanupOldMetrics,
    getStatus,
    recordError,
    recordOperation,
    config,
    collectCpuUsage,
    collectMemoryUsage,
    collectProcessStats,
    collectTaskQueueMetrics,
    collectAgentStatusMetrics,
    collectErrorMetrics,
    collectPerformanceMetrics,
    collectMetrics,
  };
}
