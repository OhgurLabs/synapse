/**
 * Telemetry helper — emits consistently-shaped events on the EventBus
 * under the `telemetry:` namespace.
 *
 * Schema: { event, agentId, taskId, projectId, phase, timestamp, payload }
 */

import { createLogger } from './logger.js';

const log = createLogger('telemetry');

/**
 * Emit a telemetry event on the EventBus.
 *
 * @param {import('./events.js').EventBus} eventBus
 * @param {string} category  — bare name, e.g. "subtask_claimed" (prefixed automatically)
 * @param {object} fields
 * @param {string} [fields.agentId]
 * @param {string} [fields.taskId]
 * @param {string} [fields.projectId]
 * @param {string} [fields.phase]
 * @param {object} [fields.payload]
 */
export function emitTelemetry(eventBus, category, { agentId = null, taskId = null, projectId = null, phase = null, payload = {} } = {}) {
  const event = `telemetry:${category}`;
  const data = {
    event,
    agentId,
    taskId,
    projectId,
    phase,
    timestamp: new Date().toISOString(),
    payload,
  };

  eventBus.emit(event, data).catch(err =>
    log.warn('Telemetry emission failed', { event, error: err.message })
  );
}
