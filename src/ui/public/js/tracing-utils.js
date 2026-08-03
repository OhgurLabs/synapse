/**
 * @module tracing-utils.js
 * @domain Trace Correlation & Observability
 * @description Utilities for constructing Jaeger deep-link URLs and checking tracing availability.
 *
 * @namespace window.SynapseTracing
 * @exports {
 *   getJaegerUrl(traceId: string): string|null,
 *   isTracingEnabled(): boolean
 * }
 * @depends window.SynapseWebSocket.authFetch
 * @init No init required; functions work standalone
 */
(function () {
  'use strict';

  // --- State ---
  let healthCache = null;
  let healthCacheTime = 0;
  const HEALTH_CACHE_TTL_MS = 5000; // Cache health data for 5 seconds

  /**
   * Fetches health data from /api/health, with caching.
   * @returns {Promise<Object>} Health data object
   */
  async function fetchHealthData() {
    const now = Date.now();
    if (healthCache && (now - healthCacheTime) < HEALTH_CACHE_TTL_MS) {
      return healthCache;
    }

    try {
      const authFetch = window.SynapseWebSocket?.authFetch || fetch;
      const response = await authFetch('/api/health');
      if (!response.ok) {
        console.warn('[tracing-utils] Failed to fetch health data:', response.status);
        return null;
      }
      const data = await response.json();
      healthCache = data;
      healthCacheTime = now;
      return data;
    } catch (error) {
      console.warn('[tracing-utils] Error fetching health data:', error);
      return null;
    }
  }

  /**
   * Checks if tracing is enabled based on /api/health configuration.
   * @returns {Promise<boolean>} True if tracing is enabled, false otherwise
   */
  async function isTracingEnabled() {
    const healthData = await fetchHealthData();
    return healthData?.tracing?.enabled === true;
  }

  /**
   * Constructs a Jaeger deep-link URL for the given trace ID.
   * Returns null if tracing is disabled or trace ID is invalid.
   *
   * @param {string} traceId - The trace ID to link to
   * @returns {Promise<string|null>} Jaeger URL or null
   */
  async function getJaegerUrl(traceId) {
    if (!traceId || typeof traceId !== 'string' || traceId.trim().length === 0) {
      return null;
    }

    const enabled = await isTracingEnabled();
    if (!enabled) {
      return null;
    }

    // Default Jaeger UI endpoint
    const jaegerBaseUrl = window.__SYNAPSE_JAEGER_URL__ || 'http://localhost:16686';
    return `${jaegerBaseUrl}/trace/${traceId.trim()}`;
  }

  /**
   * Synchronous version that checks cached health data only.
   * Use this when you've already fetched health data recently.
   * Returns null if cache is stale or tracing is disabled.

   *
   * @param {string} traceId - The trace ID to link to
   * @returns {string|null} Jaeger URL or null
   */
  function getJaegerUrlSync(traceId) {
    if (!traceId || typeof traceId !== 'string' || traceId.trim().length === 0) {
      return null;
    }

    const now = Date.now();
    if (!healthCache || (now - healthCacheTime) >= HEALTH_CACHE_TTL_MS) {
      return null; // Cache stale or unavailable
    }

    const enabled = healthCache?.tracing?.enabled === true;
    if (!enabled) {
      return null;
    }

    const jaegerBaseUrl = window.__SYNAPSE_JAEGER_URL__ || 'http://localhost:16686';
    return `${jaegerBaseUrl}/trace/${traceId.trim()}`;
  }

  /**
   * Invalidates the health cache, forcing a fresh fetch on next call.
   */
  function invalidateCache() {
    healthCache = null;
    healthCacheTime = 0;
  }

  // --- Public API ---
  window.SynapseTracing = {
    getJaegerUrl,
    getJaegerUrlSync,
    isTracingEnabled,
    invalidateCache,
  };
})();
