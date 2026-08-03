// src/orchestrator/dispatch-window-validator.js — Validates event timestamps against dispatch windows.
// Stub: full implementation will be provided by the dispatch-window-validator subtask.

/**
 * Validate that an event's timestamp falls within its associated dispatch window.
 *
 * @param {object} options
 * @param {object} options.dispatchLog - DispatchLog instance with getById(id)
 * @param {string} options.dispatchId - The dispatch ID to look up
 * @param {string} options.eventTimestamp - ISO timestamp of the event
 * @param {string} options.eventType - Type of the event
 * @returns {{ valid: boolean, dispatchStart?: string, dispatchEnd?: string }|null}
 */
export function validateDispatchWindow({ dispatchLog, dispatchId, eventTimestamp, eventType }) {
  if (!dispatchLog || !dispatchId || !eventTimestamp) return null;

  let record;
  try {
    record = dispatchLog.getById(dispatchId);
  } catch {
    return null;
  }

  if (!record) return null;

  const eventTs = new Date(eventTimestamp).getTime();
  if (Number.isNaN(eventTs)) return null;

  const start = record.startedAt || record.timestamp;
  const end = record.completedAt || record.endedAt;

  if (!start) return null;

  const startTs = new Date(start).getTime();
  if (Number.isNaN(startTs)) return null;

  // If no end time, allow any event after start
  if (!end) {
    return { valid: eventTs >= startTs, dispatchStart: start, dispatchEnd: null };
  }

  const endTs = new Date(end).getTime();
  if (Number.isNaN(endTs)) return { valid: eventTs >= startTs, dispatchStart: start, dispatchEnd: null };

  return {
    valid: eventTs >= startTs && eventTs <= endTs,
    dispatchStart: start,
    dispatchEnd: end,
  };
}

export default validateDispatchWindow;
