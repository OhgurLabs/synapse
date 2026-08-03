// OpenTelemetry tracing infrastructure — spans for campaign→milestone→task→subtask→dispatch hierarchy.
//
// Usage:
//   import { initTracing, getTracer, startSpan, endSpan, setSpanStatus, addSpanEvent } from './tracing.js';
//
//   initTracing({ endpoint, enabled, samplingRate }); // call once on startup
//   const tracer = getTracer('my-component');
//   const span = startSpan('operation.name', { attr1: 'value1' });
//   addSpanEvent(span, 'event.name', { detail: 'info' });
//   setSpanStatus(span, { code: 'ok' });
//   endSpan(span);
//
// Configuration (see src/config.js):
//   - tracing.enabled: boolean (default: false)
//   - tracing.endpoint: string (OTLP HTTP endpoint, default: http://localhost:4318/v1/traces)
//   - tracing.samplingRate: number (0.0 to 1.0, default: 0.1)
//
// When tracing.enabled = false, all functions return no-op objects.

import resourcesPkg from '@opentelemetry/resources';
import sdkTracePkg from '@opentelemetry/sdk-trace-node';
import otlpExporterPkg from '@opentelemetry/exporter-trace-otlp-http';
import apiPkg from '@opentelemetry/api';
import { createLogger } from './logger.js';
import { checkUrl } from './ssrf-filter.js';
import ssrfConfigStore from './ssrf-config-store.js';

const { resourceFromAttributes } = resourcesPkg;
const { NodeTracerProvider, BatchSpanProcessor, ConsoleSpanExporter, TraceIdRatioBasedSampler } = sdkTracePkg;
const { OTLPTraceExporter } = otlpExporterPkg;
const { trace, SpanStatusCode, ROOT_CONTEXT } = apiPkg;

const logger = createLogger('tracing');

let tracerProvider = null;
let isEnabled = false;
let currentSamplingRate = 1.0;
let currentEndpoint = null;

/**
 * Initialize the OpenTelemetry TracerProvider.
 * Called once on server startup (from src/orchestrator.js or src/server.js).
 *
 * @param {object} options - Tracing configuration
 * @param {string} options.endpoint - OTLP HTTP endpoint (default: http://localhost:4318/v1/traces)
 * @param {boolean} options.enabled - Enable tracing (default: false)
 * @param {number} options.samplingRate - Sampling rate 0.0-1.0 (default: 0.1)
 */
export async function initTracing(options = {}) {
  // Merge options with config defaults
  const endpoint = options.endpoint ?? options.url;
  const enabled = options.enabled ?? false;
  // Use currentSamplingRate if setSamplingRate was called, otherwise use options or default
  const samplingRate = options.samplingRate ?? currentSamplingRate;

  isEnabled = enabled;
  currentSamplingRate = samplingRate;
  currentEndpoint = endpoint || null;

  if (!enabled) {
    logger.info('Tracing disabled via config');
    return;
  }

  // Prevent double-initialization
  if (tracerProvider) {
    logger.warn('TracerProvider already initialized; skipping re-init');
    return;
  }

  // SSRF guard: validate the OTLP endpoint before creating the exporter.
  // The OTel SDK uses Node http/https (not global fetch) so we guard at init time.
  if (endpoint) {
    const ssrfCheck = await checkUrl(endpoint, ssrfConfigStore.getPolicy());
    if (!ssrfCheck.allowed) {
      logger.error('OTLP endpoint blocked by SSRF policy — tracing disabled', {
        endpoint,
        reason: ssrfCheck.reason,
        matchedRule: ssrfCheck.matchedRule,
      });
      isEnabled = false;
      return;
    }
  }

  const resource = resourceFromAttributes({
    'service.name': 'synapse-orchestrator',
    'service.version': '0.1.0',
  });

  // OTLP HTTP exporter — sends spans to Jaeger or any OTLP-compatible backend
  const otlpExporter = new OTLPTraceExporter({
    url: endpoint,
    headers: {},
  });

  const spanProcessors = [new BatchSpanProcessor(otlpExporter)];

  // Optional: Console exporter for local debugging
  if (process.env.SYNAPSE_TRACING_CONSOLE === 'true') {
    spanProcessors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
  }

  // Create provider with span processors (SDK v2 requires passing in constructor)
  tracerProvider = new NodeTracerProvider({
    resource,
    sampler: new TraceIdRatioBasedSampler(samplingRate),
    spanProcessors,
  });

  tracerProvider.register();

  logger.info('OpenTelemetry initialized', { endpoint, samplingRate });

  // Install process shutdown hook
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down tracing');
    await shutdownTracing();
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down tracing');
    await shutdownTracing();
  });
}

/**
 * Get a named tracer instance.
 * Returns a no-op tracer if tracing is disabled or not initialized.
 *
 * @param {string} name - Tracer name (e.g., 'campaign-lifecycle', 'task-executor')
 * @returns {Tracer} Named tracer instance (or no-op if disabled)
 */
export function getTracer(name = 'synapse-orchestrator') {
  if (!isEnabled || !tracerProvider) {
    // Return no-op tracer from global API (works even without provider registration)
    return trace.getTracer('no-op');
  }
  return trace.getTracer(name, '0.1.0');
}

/**
 * Check if tracing is currently enabled.
 * @returns {boolean} True if tracing is enabled
 */
export function isTracingEnabled() {
  return isEnabled;
}

/**
 * Update the sampling rate at runtime.
 * Note: This only affects NEW TracerProviders created after calling setSamplingRate.
 * To apply the new rate, you must call shutdownTracing() and then re-initialize.
 * Values outside [0.0, 1.0] are clamped to valid range.
 *
 * @param {number} rate - Sampling rate 0.0-1.0
 * @returns {number} The clamped sampling rate that was set
 */
export function setSamplingRate(rate) {
  // Clamp to valid range [0.0, 1.0]
  const clampedRate = Math.max(0, Math.min(1, rate));

  if (clampedRate !== rate) {
    logger.warn('Sampling rate clamped to valid range [0.0, 1.0]', { requested: rate, clamped: clampedRate });
  }

  currentSamplingRate = clampedRate;
  logger.info('Sampling rate updated (will apply on next init)', { samplingRate: clampedRate });

  return clampedRate;
}

/**
 * Start a new span with the given name and attributes.
 * If parentSpanContext is provided, the new span becomes a child.
 * Returns a span object (or no-op if tracing disabled).
 *
 * @param {string} name - Span name (e.g., 'campaign.lifecycle', 'task.execute')
 * @param {object} attributes - Key-value attributes for the span
 * @param {object} [parentSpanContext] - Optional parent span context from span.spanContext()
 * @returns {Span} Active span (or no-op)
 */
export function startSpan(name, attributes = {}, parentSpanContext = null) {
  const t = getTracer();

  const spanOptions = { attributes };

  let activeContext = ROOT_CONTEXT;
  if (parentSpanContext) {
    activeContext = trace.setSpanContext(ROOT_CONTEXT, parentSpanContext);
  }

  const span = t.startSpan(name, spanOptions, activeContext);
  return span;
}

/**
 * End the given span with optional status.
 *
 * @param {Span} span - The span to end
 * @param {object} [options] - Optional { success: boolean, error: Error }
 */
export function endSpan(span, options = {}) {
  if (!span || typeof span.end !== 'function') {
    return; // no-op span
  }

  if (options.error) {
    span.recordException(options.error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: options.error.message });
  } else if (options.success === false) {
    span.setStatus({ code: SpanStatusCode.ERROR });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}

/**
 * Set the status of a span.
 * Useful for marking a span as error or blocked without ending it.
 *
 * @param {Span} span - The span to update
 * @param {object} status - Status object with { code: 'ok' | 'error' | 'blocked', message?: string }
 */
export function setSpanStatus(span, status) {
  if (!span || typeof span.setStatus !== 'function') {
    return; // no-op span
  }

  let statusCode;
  if (status.code === 'ok') {
    statusCode = SpanStatusCode.OK;
  } else if (status.code === 'blocked') {
    // Blocked is modeled as ERROR with a distinguishing message
    statusCode = SpanStatusCode.ERROR;
  } else {
    statusCode = SpanStatusCode.ERROR;
  }

  span.setStatus({ code: statusCode, message: status.message || '' });
}

/**
 * Add an event to the given span.
 *
 * @param {Span} span - The span to annotate
 * @param {string} eventName - Event name (e.g., 'task_status_change')
 * @param {object} [attributes] - Event attributes (e.g., { from: 'queued', to: 'planning' })
 */
export function addSpanEvent(span, eventName, attributes = {}) {
  if (!span || typeof span.addEvent !== 'function') {
    return; // no-op span
  }
  span.addEvent(eventName, attributes);
}

/**
 * Get current tracing configuration and state.
 * Returns { enabled, samplingRate, endpoint, activeSpanCount }.
 * @returns {object} Current tracing configuration
 */
export function getTracingConfig() {
  return {
    enabled: isEnabled,
    samplingRate: currentSamplingRate,
    endpoint: currentEndpoint,
    activeSpanCount: 0, // TODO: Track active spans if needed
  };
}

/**
 * Enable tracing at runtime.
 * Sets the enabled flag to true. To fully activate, must reinitialize with initTracing().
 */
export function enableTracing() {
  isEnabled = true;
  logger.info('Tracing enabled (reinit required to activate)');
}

/**
 * Disable tracing at runtime.
 * Sets the enabled flag to false. New spans will become no-ops.
 */
export function disableTracing() {
  isEnabled = false;
  logger.info('Tracing disabled');
}

/**
 * Shutdown tracing — flush pending spans and cleanup resources.
 * Call this on server shutdown.
 */
export async function shutdownTracing() {
  if (!tracerProvider) {
    return; // Already shutdown or never initialized
  }

  try {
    await tracerProvider.shutdown();
    logger.info('TracerProvider shutdown complete');
  } catch (err) {
    logger.error('Error during TracerProvider shutdown', { error: err.message });
  } finally {
    // Reset state
    tracerProvider = null;
  }
}
