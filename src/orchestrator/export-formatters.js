/**
 * Export Formatters for Audit Trail System
 * Provides streaming CSV and JSON formatters for large dataset exports
 */

/**
 * Escape a string value for CSV output
 * Handles commas, quotes, newlines, and carriage returns
 * @param {string} value - The value to escape
 * @returns {string} - CSV-escaped value
 */
function escapeCSVValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const str = String(value);
  
  // If value contains comma, quote, newline, or carriage return, wrap in quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    // Escape quotes by doubling them
    const escaped = str.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  
  return str;
}

/**
 * Stream events as CSV format
 * Writes header row followed by data rows, properly escaped
 * @param {Array} events - Array of event objects to format
 * @param {Function} writeCallback - Callback to receive each line of CSV output
 * @param {string} [delimiter=','] - Field delimiter (default: comma)
 */
function streamCSV(events, writeCallback, delimiter = ',') {
  if (!events || !Array.isArray(events) || events.length === 0) {
    // Write empty CSV with headers only
    const headers = [
      'timestamp',
      'id',
      'type',
      'agent_id',
      'project',
      'campaign_id',
      'dispatch_id',
      'trace_id',
      'task_id',
      'milestone_id',
      'subtask_id',
      'provider',
      'action_type',
      'severity',
      'reasoning',
      'outcome',
      'inputs',
      'outputs',
      'event_data'
    ].join(delimiter);
    
    writeCallback(headers + '\n');
    return;
  }

  // Write header row
  const headers = [
    'timestamp',
    'id',
    'type',
    'agent_id',
    'project',
    'campaign_id',
    'dispatch_id',
    'trace_id',
    'task_id',
    'milestone_id',
    'subtask_id',
    'provider',
    'action_type',
    'severity',
    'reasoning',
    'outcome',
    'inputs',
    'outputs',
    'event_data'
  ].join(delimiter);
  
  writeCallback(headers + '\n');

  // Write data rows
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    
    const row = [
      escapeCSVValue(event.event_ts || event.timestamp || ''),
      escapeCSVValue(event.id || ''),
      escapeCSVValue(event.type || ''),
      escapeCSVValue(event.agent_id || ''),
      escapeCSVValue(event.project || ''),
      escapeCSVValue(event.campaign_id || ''),
      escapeCSVValue(event.dispatch_id || ''),
      escapeCSVValue(event.trace_id || ''),
      escapeCSVValue(event.task_id || ''),
      escapeCSVValue(event.milestone_id || ''),
      escapeCSVValue(event.subtask_id || ''),
      escapeCSVValue(event.provider || ''),
      escapeCSVValue(event.action_type || ''),
      escapeCSVValue(event.severity || ''),
      escapeCSVValue(event.reasoning || ''),
      escapeCSVValue(event.outcome || ''),
      escapeCSVValue(event.inputs || ''),
      escapeCSVValue(event.outputs || ''),
      escapeCSVValue(event.event_data || '')
    ].join(delimiter);
    
    writeCallback(row + '\n');
  }
}

/**
 * Stream events as JSON array format
 * Writes opening bracket, comma-separated objects, closing bracket
 * @param {Array} events - Array of event objects to format
 * @param {Function} writeCallback - Callback to receive each chunk of JSON output
 */
function formatJSONArray(events, writeCallback) {
  if (!events || !Array.isArray(events)) {
    writeCallback('[]');
    return;
  }

  if (events.length === 0) {
    writeCallback('[]');
    return;
  }

  // Write opening bracket
  writeCallback('[');

  // Write each event as JSON object
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    
    // Add comma before all events except the first
    if (i > 0) {
      writeCallback(',');
    }
    
    // Stringify the event object
    const jsonString = JSON.stringify(event);
    writeCallback(jsonString);
  }

  // Write closing bracket
  writeCallback(']');
}

/**
 * Stream JSON array with pretty formatting (for smaller datasets)
 * @param {Array} events - Array of event objects to format
 * @param {Function} writeCallback - Callback to receive each chunk of JSON output
 * @param {number} [indent=2] - Indentation level for pretty print
 */
function formatJSONArrayPretty(events, writeCallback, indent = 2) {
  if (!events || !Array.isArray(events)) {
    writeCallback('[]');
    return;
  }

  if (events.length === 0) {
    writeCallback('[]');
    return;
  }

  const indentStr = ' '.repeat(indent);
  const innerIndent = ' '.repeat(indent * 2);

  // Write opening bracket
  writeCallback('[\n');

  // Write each event as JSON object
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    
    // Add comma before all events except the first
    if (i > 0) {
      writeCallback(',\n');
    } else {
      writeCallback('\n');
    }
    
    // Pretty print the event object
    const jsonString = JSON.stringify(event, null, indent);
    const prefixed = jsonString
      .split('\n')
      .map((line, idx) => {
        if (idx === 0) return innerIndent + line;
        return innerIndent + line;
      })
      .join('\n');
    
    writeCallback(prefixed);
  }

  // Write closing bracket
  writeCallback('\n' + indentStr + ']');
}

export {
  escapeCSVValue,
  streamCSV,
  formatJSONArray,
  formatJSONArrayPretty
};
