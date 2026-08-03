/**
 * @file api-monitoring.js
 * @description HTTP query endpoint for historical monitoring metrics
 * 
 * Provides endpoints for querying system health metrics stored in MonitoringStore.
 * Supports time-range queries with optional filtering by agent ID.
 */

import { createLogger } from '../logger.js';

const log = createLogger('api-monitoring');

/**
 * Create monitoring metrics query endpoint handler
 * 
 * @param {Object} deps - Dependencies
 * @param {MonitoringStore} deps.monitoringStore - MonitoringStore instance for querying metrics
 * @param {Function} deps.json - JSON response helper function
 * @returns {Function} Express-like route handler
 */
export function createMetricsQueryHandler(deps) {
  const { monitoringStore, json } = deps;

  return function handleMetricsQuery(req, res) {
    const url = new URL(req.url, `http://localhost${req.socket ? `:${req.socket.localPort}` : ''}`);
    const path = url.pathname;

    if (path === '/api/monitoring/metrics' && req.method === 'GET') {
      if (!monitoringStore) {
        json(res, { error: 'Monitoring store not available' }, 503);
        return true;
      }

      try {
        const startTimeParam = url.searchParams.get('startTime');
        const endTimeParam = url.searchParams.get('endTime');
        const agentId = url.searchParams.get('agentId') || null;

        if (!startTimeParam || !endTimeParam) {
          json(res, { 
            error: 'Missing required parameters',
            message: 'startTime and endTime query parameters are required (Unix timestamp in milliseconds)',
          }, 400);
          return true;
        }

        const startTime = parseInt(startTimeParam, 10);
        const endTime = parseInt(endTimeParam, 10);

        if (isNaN(startTime) || isNaN(endTime)) {
          json(res, { 
            error: 'Invalid timestamp format',
            message: 'startTime and endTime must be valid Unix timestamps in milliseconds',
          }, 400);
          return true;
        }

        if (startTime >= endTime) {
          json(res, { 
            error: 'Invalid time range',
            message: 'startTime must be less than endTime',
          }, 400);
          return true;
        }

        const timeWindowMs = endTime - startTime;
        const maxWindowDays = 30;
        const maxWindowMs = maxWindowDays * 24 * 60 * 60 * 1000;

        if (timeWindowMs > maxWindowMs) {
          json(res, { 
            error: 'Time range too large',
            message: `Time range cannot exceed ${maxWindowDays} days. Use rollup endpoints for longer ranges.`,
          }, 400);
          return true;
        }

        const metrics = monitoringStore.queryMetrics({ startTime, endTime, agentId });

        json(res, {
          metrics,
          query: {
            startTime: new Date(startTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
            agentId,
            count: metrics.length,
          },
          timestamp: new Date().toISOString(),
        });
        return true;
      } catch (err) {
        log.error('Failed to query monitoring metrics', { error: err.message, stack: err.stack });
        json(res, { error: 'Failed to query monitoring metrics' }, 500);
        return true;
      }
    }

    if (path === '/api/monitoring/metrics/latest' && req.method === 'GET') {
      if (!monitoringStore) {
        json(res, { error: 'Monitoring store not available' }, 503);
        return true;
      }

      try {
        const metric = monitoringStore.getLatestMetric();

        if (!metric) {
          json(res, { 
            error: 'No metrics available',
            message: 'No metrics have been recorded yet',
          }, 404);
          return true;
        }

        json(res, {
          metric,
          timestamp: new Date().toISOString(),
        });
        return true;
      } catch (err) {
        log.error('Failed to get latest monitoring metric', { error: err.message, stack: err.stack });
        json(res, { error: 'Failed to get latest monitoring metric' }, 500);
        return true;
      }
    }

    if (path === '/api/monitoring/rollups' && req.method === 'GET') {
      if (!monitoringStore) {
        json(res, { error: 'Monitoring store not available' }, 503);
        return true;
      }

      try {
        const period = url.searchParams.get('period') || 'hourly';

        if (period !== 'hourly' && period !== 'daily') {
          json(res, { 
            error: 'Invalid period',
            message: 'Period must be either "hourly" or "daily"',
          }, 400);
          return true;
        }

        const rollups = monitoringStore.queryRollups(period);

        json(res, {
          rollups,
          query: {
            period,
            count: rollups.length,
          },
          timestamp: new Date().toISOString(),
        });
        return true;
      } catch (err) {
        log.error('Failed to query monitoring rollups', { error: err.message, stack: err.stack });
        json(res, { error: 'Failed to query monitoring rollups' }, 500);
        return true;
      }
    }

    return false;
  };
}

/**
 * Initialize monitoring API endpoints in the main API handler
 * 
 * This function should be called during API initialization to register
 * the monitoring endpoints with the monitoring store.
 * 
 * @param {Object} deps - Dependencies
 * @param {string} deps.projectDir - Project directory path
 * @param {Object} deps.config - Application configuration
 * @returns {Object|null} MonitoringStore instance or null if initialization fails
 */
export function initializeMonitoringApi(deps) {
  const { projectDir, config } = deps;

  if (!projectDir || !config) {
    log.warn('Cannot initialize monitoring API: missing projectDir or config');
    return null;
  }

  try {
    const { MonitoringStore } = import('./monitoring-store.js');
    const monitoringDbPath = config.monitoring?.dbPath 
      ? (config.monitoring.dbPath.startsWith('/') 
          ? config.monitoring.dbPath 
          : `${projectDir}/${config.monitoring.dbPath}`)
      : `${projectDir}/.synapse/monitoring/metrics.db`;

    const monitoringStore = new MonitoringStore({ dbPath: monitoringDbPath });
    log.info('Monitoring API initialized', { dbPath: monitoringDbPath });
    return monitoringStore;
  } catch (err) {
    log.warn('Failed to initialize monitoring store for API, monitoring endpoints will return 503', { error: err.message });
    return null;
  }
}
