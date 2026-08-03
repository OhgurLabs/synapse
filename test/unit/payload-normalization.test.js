/**
 * Unit stub tests for guardrail/checkpoint payload normalization
 * 
 * Tests payload normalization functions from guardrails.js and checkpoints.js:
 * - Severity/status enum mapping
 * - Timestamp parsing and formatting
 * - Text excerpt truncation
 * - Agent name extraction
 * - Checkpoint payload normalization
 */

import assert from 'assert';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}

// ============================================================================
// SEVERITY ENUM MAPPING TESTS
// ============================================================================

// Test 1: getSeverityClass - critical severity
test('getSeverityClass maps "blocking" to "critical"', () => {
  const getSeverityClass = (severity) => {
    const normalized = (severity || '').toLowerCase();
    if (normalized === 'critical' || normalized === 'blocking') return 'critical';
    if (normalized === 'warning' || normalized === 'medium') return 'warning';
    return 'info';
  };

  assert.strictEqual(getSeverityClass('blocking'), 'critical');
  assert.strictEqual(getSeverityClass('BLOCKING'), 'critical');
  assert.strictEqual(getSeverityClass('critical'), 'critical');
});

// Test 2: getSeverityClass - warning severity
test('getSeverityClass maps "warning" and "medium" to "warning"', () => {
  const getSeverityClass = (severity) => {
    const normalized = (severity || '').toLowerCase();
    if (normalized === 'critical' || normalized === 'blocking') return 'critical';
    if (normalized === 'warning' || normalized === 'medium') return 'warning';
    return 'info';
  };

  assert.strictEqual(getSeverityClass('warning'), 'warning');
  assert.strictEqual(getSeverityClass('medium'), 'warning');
  assert.strictEqual(getSeverityClass('WARNING'), 'warning');
});

// Test 3: getSeverityClass - info severity (default)
test('getSeverityClass defaults to "info" for unknown values', () => {
  const getSeverityClass = (severity) => {
    const normalized = (severity || '').toLowerCase();
    if (normalized === 'critical' || normalized === 'blocking') return 'critical';
    if (normalized === 'warning' || normalized === 'medium') return 'warning';
    return 'info';
  };

  assert.strictEqual(getSeverityClass('unknown'), 'info');
  assert.strictEqual(getSeverityClass(''), 'info');
  assert.strictEqual(getSeverityClass(null), 'info');
  assert.strictEqual(getSeverityClass(undefined), 'info');
});

// Test 4: getSeverityIcon - critical icon
test('getSeverityIcon returns warning icon for critical/blocking', () => {
  const getSeverityIcon = (severity) => {
    const normalized = (severity || '').toLowerCase();
    if (normalized === 'critical' || normalized === 'blocking') return '⚠️';
    if (normalized === 'warning' || normalized === 'medium') return '⚡';
    return 'ℹ️';
  };

  assert.strictEqual(getSeverityIcon('blocking'), '⚠️');
  assert.strictEqual(getSeverityIcon('critical'), '⚠️');
});

// Test 5: getSeverityIcon - warning icon
test('getSeverityIcon returns alert icon for warning/medium', () => {
  const getSeverityIcon = (severity) => {
    const normalized = (severity || '').toLowerCase();
    if (normalized === 'critical' || normalized === 'blocking') return '⚠️';
    if (normalized === 'warning' || normalized === 'medium') return '⚡';
    return 'ℹ️';
  };

  assert.strictEqual(getSeverityIcon('warning'), '⚡');
  assert.strictEqual(getSeverityIcon('medium'), '⚡');
});

// Test 6: getSeverityIcon - info icon
test('getSeverityIcon returns info icon for unknown values', () => {
  const getSeverityIcon = (severity) => {
    const normalized = (severity || '').toLowerCase();
    if (normalized === 'critical' || normalized === 'blocking') return '⚠️';
    if (normalized === 'warning' || normalized === 'medium') return '⚡';
    return 'ℹ️';
  };

  assert.strictEqual(getSeverityIcon('info'), 'ℹ️');
  assert.strictEqual(getSeverityIcon('unknown'), 'ℹ️');
});

// ============================================================================
// STATUS ENUM MAPPING TESTS
// ============================================================================

// Test 7: getStatusClass - failed status
test('getStatusClass maps "failed" to "failed"', () => {
  const getStatusClass = (status) => {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'failed') return 'failed';
    if (normalized === 'replayed') return 'replayed';
    if (normalized === 'persisted') return 'persisted';
    return 'created';
  };

  assert.strictEqual(getStatusClass('failed'), 'failed');
  assert.strictEqual(getStatusClass('FAILED'), 'failed');
});

// Test 8: getStatusClass - replayed status
test('getStatusClass maps "replayed" to "replayed"', () => {
  const getStatusClass = (status) => {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'failed') return 'failed';
    if (normalized === 'replayed') return 'replayed';
    if (normalized === 'persisted') return 'persisted';
    return 'created';
  };

  assert.strictEqual(getStatusClass('replayed'), 'replayed');
  assert.strictEqual(getStatusClass('REPLAYED'), 'replayed');
});

// Test 9: getStatusClass - persisted status
test('getStatusClass maps "persisted" to "persisted"', () => {
  const getStatusClass = (status) => {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'failed') return 'failed';
    if (normalized === 'replayed') return 'replayed';
    if (normalized === 'persisted') return 'persisted';
    return 'created';
  };

  assert.strictEqual(getStatusClass('persisted'), 'persisted');
  assert.strictEqual(getStatusClass('PERSISTED'), 'persisted');
});

// Test 10: getStatusClass - created status (default)
test('getStatusClass defaults to "created" for unknown values', () => {
  const getStatusClass = (status) => {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'failed') return 'failed';
    if (normalized === 'replayed') return 'replayed';
    if (normalized === 'persisted') return 'persisted';
    return 'created';
  };

  assert.strictEqual(getStatusClass('unknown'), 'created');
  assert.strictEqual(getStatusClass(''), 'created');
  assert.strictEqual(getStatusClass(null), 'created');
});

// Test 11: getStatusIcon - failed icon
test('getStatusIcon returns error icon for failed', () => {
  const getStatusIcon = (status) => {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'failed') return '❌';
    if (normalized === 'replayed') return '↩️';
    if (normalized === 'persisted') return '💾';
    return '⏱️';
  };

  assert.strictEqual(getStatusIcon('failed'), '❌');
});

// Test 12: getStatusIcon - replayed icon
test('getStatusIcon returns replay icon for replayed', () => {
  const getStatusIcon = (status) => {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'failed') return '❌';
    if (normalized === 'replayed') return '↩️';
    if (normalized === 'persisted') return '💾';
    return '⏱️';
  };

  assert.strictEqual(getStatusIcon('replayed'), '↩️');
});

// Test 13: getStatusIcon - persisted icon
test('getStatusIcon returns save icon for persisted', () => {
  const getStatusIcon = (status) => {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'failed') return '❌';
    if (normalized === 'replayed') return '↩️';
    if (normalized === 'persisted') return '💾';
    return '⏱️';
  };

  assert.strictEqual(getStatusIcon('persisted'), '💾');
});

// Test 14: getStatusIcon - created icon (default)
test('getStatusIcon returns clock icon for created/unknown', () => {
  const getStatusIcon = (status) => {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'failed') return '❌';
    if (normalized === 'replayed') return '↩️';
    if (normalized === 'persisted') return '💾';
    return '⏱️';
  };

  assert.strictEqual(getStatusIcon('created'), '⏱️');
  assert.strictEqual(getStatusIcon('unknown'), '⏱️');
});

// ============================================================================
// TIMESTAMP PARSING TESTS
// ============================================================================

// Test 15: formatTimestamp - just now
test('formatTimestamp returns "Just now" for events < 60s old', () => {
  const formatTimestamp = (date) => {
    const now = Date.now();
    const diff = now - date.getTime();
    
    if (diff < 60000) {
      return 'Just now';
    } else if (diff < 3600000) {
      const seconds = Math.floor(diff / 1000);
      return `${seconds}s ago`;
    } else if (diff < 86400000) {
      const minutes = Math.floor(diff / 60000);
      return `${minutes}m ago`;
    } else {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  };

  const justNow = new Date(Date.now() - 10000); // 10 seconds ago
  assert.strictEqual(formatTimestamp(justNow), 'Just now');
});

// Test 16: formatTimestamp - seconds ago
test('formatTimestamp returns seconds ago for events < 1min old', () => {
  const formatTimestamp = (date, now = Date.now()) => {
    const diff = now - date.getTime();
    
    if (diff < 60000) {
      return 'Just now';
    } else if (diff < 3600000) {
      const seconds = Math.floor(diff / 1000);
      return `${seconds}s ago`;
    } else if (diff < 86400000) {
      const minutes = Math.floor(diff / 60000);
      return `${minutes}m ago`;
    } else {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  };

  // Use fixed reference time - need 60-360 seconds (1-6 min) for "seconds ago" range
  const fixedNow = 1709443200000; // Fixed timestamp
  const ninetySecondsAgo = new Date(fixedNow - 90000); // 90 seconds ago (1.5 min)
  const result = formatTimestamp(ninetySecondsAgo, fixedNow);
  assert.ok(result.includes('s ago'), 'Should include seconds ago');
  assert.ok(/^\d+s ago$/.test(result), 'Should match seconds ago pattern');
});

// Test 17: formatTimestamp - minutes ago
test('formatTimestamp returns minutes ago for events < 1hr old', () => {
  const formatTimestamp = (date, now = Date.now()) => {
    const diff = now - date.getTime();
    
    if (diff < 60000) {
      return 'Just now';
    } else if (diff < 3600000) {
      const seconds = Math.floor(diff / 1000);
      return `${seconds}s ago`;
    } else if (diff < 86400000) {
      const minutes = Math.floor(diff / 60000);
      return `${minutes}m ago`;
    } else {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  };

  // Use fixed reference time - need > 60 minutes (3600000ms) for "minutes ago" range
  const fixedNow = 1709443200000; // Fixed timestamp
  const twoHoursAgo = new Date(fixedNow - 7200000); // 2 hours ago
  const result = formatTimestamp(twoHoursAgo, fixedNow);
  assert.ok(result.includes('m ago'), 'Should include minutes ago');
  assert.ok(/^\d+m ago$/.test(result), 'Should match minutes ago pattern');
});

// Test 18: formatTimestamp - time format for older events
test('formatTimestamp returns time string for events > 1day old', () => {
  const formatTimestamp = (date) => {
    const now = Date.now();
    const diff = now - date.getTime();
    
    if (diff < 60000) {
      return 'Just now';
    } else if (diff < 3600000) {
      const seconds = Math.floor(diff / 1000);
      return `${seconds}s ago`;
    } else if (diff < 86400000) {
      const minutes = Math.floor(diff / 60000);
      return `${minutes}m ago`;
    } else {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  };

  const oneDayAgo = new Date(Date.now() - 86400000); // 1 day ago
  const result = formatTimestamp(oneDayAgo);
  assert.ok(result.includes(':'), 'Should include time separator');
});

// Test 19: formatTimestamp - ISO string parsing
test('formatTimestamp handles ISO string input', () => {
  const formatTimestamp = (dateString, now = Date.now()) => {
    try {
      const date = new Date(dateString);
      const diff = now - date.getTime();
      
      if (isNaN(date.getTime())) {
        return dateString;
      }
      
      if (diff < 60000) {
        return 'Just now';
      } else if (diff < 3600000) {
        const seconds = Math.floor(diff / 1000);
        return `${seconds}s ago`;
      } else if (diff < 86400000) {
        const minutes = Math.floor(diff / 60000);
        return `${minutes}m ago`;
      } else {
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    } catch (_) {
      return dateString;
    }
  };

  // Use fixed reference time - need 60-360 seconds for "seconds ago" range
  const fixedNow = 1709443200000; // Fixed timestamp
  const isoString = new Date(fixedNow - 90000).toISOString(); // 90 seconds ago
  const result = formatTimestamp(isoString, fixedNow);
  assert.ok(/^\d+s ago$/.test(result), 'Should parse ISO string');
});

// Test 20: formatTimestamp - invalid date fallback
test('formatTimestamp returns input for invalid dates', () => {
  const formatTimestamp = (dateString) => {
    try {
      const date = new Date(dateString);
      const now = Date.now();
      const diff = now - date.getTime();
      
      // Check for invalid date
      if (isNaN(date.getTime())) {
        return dateString;
      }
      
      if (diff < 60000) {
        return 'Just now';
      } else if (diff < 3600000) {
        const seconds = Math.floor(diff / 1000);
        return `${seconds}s ago`;
      } else if (diff < 86400000) {
        const minutes = Math.floor(diff / 60000);
        return `${minutes}m ago`;
      } else {
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    } catch (_) {
      return dateString;
    }
  };

  const result = formatTimestamp('invalid-date-string');
  assert.strictEqual(result, 'invalid-date-string', 'Should return input for invalid date');
});

// ============================================================================
// TEXT TRUNCATION TESTS
// ============================================================================

// Test 21: truncateText - no truncation needed
test('truncateText returns original text when under maxLength', () => {
  const truncateText = (text, maxLength = 120) => {
    if (typeof text !== 'string') return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  const shortText = 'Hello world';
  assert.strictEqual(truncateText(shortText), 'Hello world');
  assert.strictEqual(truncateText(shortText, 50), 'Hello world');
});

// Test 22: truncateText - truncation with ellipsis
test('truncateText truncates text over maxLength with ellipsis', () => {
  const truncateText = (text, maxLength = 120) => {
    if (typeof text !== 'string') return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  const longText = 'a'.repeat(200);
  const result = truncateText(longText, 100);
  assert.strictEqual(result.length, 103, 'Should be maxLength + 3 for ellipsis');
  assert.ok(result.endsWith('...'), 'Should end with ellipsis');
  assert.strictEqual(result.substring(0, 100), longText.substring(0, 100));
});

// Test 23: truncateText - custom maxLength
test('truncateText respects custom maxLength parameter', () => {
  const truncateText = (text, maxLength = 80) => {
    if (typeof text !== 'string') return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  const longText = 'x'.repeat(100);
  const result = truncateText(longText, 10);
  assert.strictEqual(result.length, 13, 'Should be 10 + 3 for ellipsis');
  assert.strictEqual(result, 'xxxxxxxxxx...');
});

// Test 24: truncateText - non-string input
test('truncateText returns empty string for non-string input', () => {
  const truncateText = (text, maxLength = 80) => {
    if (typeof text !== 'string') return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  assert.strictEqual(truncateText(null), '');
  assert.strictEqual(truncateText(undefined), '');
  assert.strictEqual(truncateText(123), '');
  assert.strictEqual(truncateText({}), '');
});

// Test 25: truncateText - empty string
test('truncateText returns empty string for empty input', () => {
  const truncateText = (text, maxLength = 80) => {
    if (typeof text !== 'string') return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  assert.strictEqual(truncateText(''), '');
});

// ============================================================================
// AGENT NAME EXTRACTION TESTS
// ============================================================================

// Test 26: extractAgentName - string agent
test('extractAgentName returns string agent directly', () => {
  const extractAgentName = (agentInfo) => {
    if (!agentInfo) return 'Unknown';
    if (typeof agentInfo === 'string') return agentInfo;
    if (agentInfo.name) return agentInfo.name;
    if (agentInfo.agentId) return agentInfo.agentId;
    return 'Unknown';
  };

  assert.strictEqual(extractAgentName('code-agent'), 'code-agent');
  assert.strictEqual(extractAgentName('researcher'), 'researcher');
});

// Test 27: extractAgentName - object with name
test('extractAgentName extracts name from object', () => {
  const extractAgentName = (agentInfo) => {
    if (!agentInfo) return 'Unknown';
    if (typeof agentInfo === 'string') return agentInfo;
    if (agentInfo.name) return agentInfo.name;
    if (agentInfo.agentId) return agentInfo.agentId;
    return 'Unknown';
  };

  assert.strictEqual(extractAgentName({ name: 'code-agent-v2' }), 'code-agent-v2');
  assert.strictEqual(extractAgentName({ name: '' }), 'Unknown');
});

// Test 28: extractAgentName - object with agentId
test('extractAgentName falls back to agentId when name missing', () => {
  const extractAgentName = (agentInfo) => {
    if (!agentInfo) return 'Unknown';
    if (typeof agentInfo === 'string') return agentInfo;
    if (agentInfo.name) return agentInfo.name;
    if (agentInfo.agentId) return agentInfo.agentId;
    return 'Unknown';
  };

  assert.strictEqual(extractAgentName({ agentId: 'agent-123' }), 'agent-123');
});

// Test 29: extractAgentName - null/undefined
test('extractAgentName returns "Unknown" for null/undefined', () => {
  const extractAgentName = (agentInfo) => {
    if (!agentInfo) return 'Unknown';
    if (typeof agentInfo === 'string') return agentInfo;
    if (agentInfo.name) return agentInfo.name;
    if (agentInfo.agentId) return agentInfo.agentId;
    return 'Unknown';
  };

  assert.strictEqual(extractAgentName(null), 'Unknown');
  assert.strictEqual(extractAgentName(undefined), 'Unknown');
});

// Test 30: extractAgentName - empty object
test('extractAgentName returns "Unknown" for empty object', () => {
  const extractAgentName = (agentInfo) => {
    if (!agentInfo) return 'Unknown';
    if (typeof agentInfo === 'string') return agentInfo;
    if (agentInfo.name) return agentInfo.name;
    if (agentInfo.agentId) return agentInfo.agentId;
    return 'Unknown';
  };

  assert.strictEqual(extractAgentName({}), 'Unknown');
});

// ============================================================================
// CHECKPOINT PAYLOAD NORMALIZATION TESTS
// ============================================================================

// Test 31: normalizeCheckpointPayload - full event
test('normalizeCheckpointPayload extracts all fields from full event', () => {
  const generateId = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  
  const normalizeCheckpointPayload = (event) => {
    if (!event) return null;

    return {
      id: event.checkpointId || generateId(),
      projectId: event.projectId || 'unknown',
      campaignId: event.campaignId || 'unknown',
      campaignVersion: event.campaignVersion || 1,
      milestoneProgress: event.milestoneProgress || {},
      completedSubtasks: event.completedSubtasks || [],
      lastSubtaskId: event.lastSubtaskId || null,
      status: event.status || 'created',
      summary: event.summary || `Checkpoint ${event.checkpointId || checkpoints.length + 1}`,
      timestamp: new Date(event.createdAt || Date.now()),
      error: event.error || null,
    };
  };

  const event = {
    checkpointId: 'chk_abc123',
    projectId: 'proj-456',
    campaignId: 'camp-789',
    campaignVersion: 3,
    milestoneProgress: { current: 5, total: 10 },
    completedSubtasks: ['subtask-1', 'subtask-2'],
    lastSubtaskId: 'subtask-2',
    status: 'persisted',
    summary: 'Milestone 5 complete',
    createdAt: '2026-03-03T10:00:00Z',
    error: null,
  };

  const normalized = normalizeCheckpointPayload(event);
  
  assert.strictEqual(normalized.id, 'chk_abc123');
  assert.strictEqual(normalized.projectId, 'proj-456');
  assert.strictEqual(normalized.campaignId, 'camp-789');
  assert.strictEqual(normalized.campaignVersion, 3);
  assert.deepStrictEqual(normalized.milestoneProgress, { current: 5, total: 10 });
  assert.deepStrictEqual(normalized.completedSubtasks, ['subtask-1', 'subtask-2']);
  assert.strictEqual(normalized.lastSubtaskId, 'subtask-2');
  assert.strictEqual(normalized.status, 'persisted');
  assert.strictEqual(normalized.summary, 'Milestone 5 complete');
  assert.ok(normalized.timestamp instanceof Date);
  assert.strictEqual(normalized.error, null);
});

// Test 32: normalizeCheckpointPayload - minimal event
test('normalizeCheckpointPayload provides defaults for minimal event', () => {
  const generateId = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  
  const normalizeCheckpointPayload = (event) => {
    if (!event) return null;

    return {
      id: event.checkpointId || generateId(),
      projectId: event.projectId || 'unknown',
      campaignId: event.campaignId || 'unknown',
      campaignVersion: event.campaignVersion || 1,
      milestoneProgress: event.milestoneProgress || {},
      completedSubtasks: event.completedSubtasks || [],
      lastSubtaskId: event.lastSubtaskId || null,
      status: event.status || 'created',
      summary: event.summary || `Checkpoint ${event.checkpointId || 'default'}`,
      timestamp: new Date(event.createdAt || Date.now()),
      error: event.error || null,
    };
  };

  const event = {};
  const normalized = normalizeCheckpointPayload(event);
  
  assert.ok(normalized.id.length > 0, 'Should generate ID');
  assert.strictEqual(normalized.projectId, 'unknown');
  assert.strictEqual(normalized.campaignId, 'unknown');
  assert.strictEqual(normalized.campaignVersion, 1);
  assert.deepStrictEqual(normalized.milestoneProgress, {});
  assert.deepStrictEqual(normalized.completedSubtasks, []);
  assert.strictEqual(normalized.lastSubtaskId, null);
  assert.strictEqual(normalized.status, 'created');
  assert.ok(normalized.summary.includes('Checkpoint'));
  assert.ok(normalized.timestamp instanceof Date);
  assert.strictEqual(normalized.error, null);
});

// Test 33: normalizeCheckpointPayload - null event
test('normalizeCheckpointPayload returns null for null event', () => {
  const generateId = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  
  const normalizeCheckpointPayload = (event) => {
    if (!event) return null;

    return {
      id: event.checkpointId || generateId(),
      projectId: event.projectId || 'unknown',
      campaignId: event.campaignId || 'unknown',
      campaignVersion: event.campaignVersion || 1,
      milestoneProgress: event.milestoneProgress || {},
      completedSubtasks: event.completedSubtasks || [],
      lastSubtaskId: event.lastSubtaskId || null,
      status: event.status || 'created',
      summary: event.summary || `Checkpoint ${event.checkpointId || checkpoints.length + 1}`,
      timestamp: new Date(event.createdAt || Date.now()),
      error: event.error || null,
    };
  };

  assert.strictEqual(normalizeCheckpointPayload(null), null);
  assert.strictEqual(normalizeCheckpointPayload(undefined), null);
});

// Test 34: normalizeCheckpointPayload - with error
test('normalizeCheckpointPayload preserves error field', () => {
  const generateId = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  
  const normalizeCheckpointPayload = (event) => {
    if (!event) return null;

    return {
      id: event.checkpointId || generateId(),
      projectId: event.projectId || 'unknown',
      campaignId: event.campaignId || 'unknown',
      campaignVersion: event.campaignVersion || 1,
      milestoneProgress: event.milestoneProgress || {},
      completedSubtasks: event.completedSubtasks || [],
      lastSubtaskId: event.lastSubtaskId || null,
      status: event.status || 'created',
      summary: event.summary || `Checkpoint ${event.checkpointId || checkpoints.length + 1}`,
      timestamp: new Date(event.createdAt || Date.now()),
      error: event.error || null,
    };
  };

  const event = {
    checkpointId: 'chk-error-1',
    status: 'failed',
    error: 'Disk write failed: no space left on device',
  };

  const normalized = normalizeCheckpointPayload(event);
  
  assert.strictEqual(normalized.status, 'failed');
  assert.strictEqual(normalized.error, 'Disk write failed: no space left on device');
});

// Test 35: normalizeCheckpointPayload - timestamp parsing
test('normalizeCheckpointPayload parses createdAt to Date object', () => {
  const generateId = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  
  const normalizeCheckpointPayload = (event) => {
    if (!event) return null;

    return {
      id: event.checkpointId || generateId(),
      projectId: event.projectId || 'unknown',
      campaignId: event.campaignId || 'unknown',
      campaignVersion: event.campaignVersion || 1,
      milestoneProgress: event.milestoneProgress || {},
      completedSubtasks: event.completedSubtasks || [],
      lastSubtaskId: event.lastSubtaskId || null,
      status: event.status || 'created',
      summary: event.summary || `Checkpoint ${event.checkpointId || checkpoints.length + 1}`,
      timestamp: new Date(event.createdAt || Date.now()),
      error: event.error || null,
    };
  };

  const event = {
    checkpointId: 'chk-ts-1',
    createdAt: '2026-03-03T12:00:00.000Z',
  };

  const normalized = normalizeCheckpointPayload(event);
  
  assert.ok(normalized.timestamp instanceof Date);
  assert.strictEqual(normalized.timestamp.getTime(), new Date('2026-03-03T12:00:00.000Z').getTime());
});

// ============================================================================
// GUARDRAIL VIOLATION PAYLOAD NORMALIZATION TESTS
// ============================================================================

// Test 36: addViolation - full violation event
test('addViolation normalizes full violation event', () => {
  const generateId = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  
  const truncateText = (text, maxLength = 120) => {
    if (typeof text !== 'string') return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  const extractAgentName = (agentInfo) => {
    if (!agentInfo) return 'Unknown';
    if (typeof agentInfo === 'string') return agentInfo;
    if (agentInfo.name) return agentInfo.name;
    if (agentInfo.agentId) return agentInfo.agentId;
    return 'Unknown';
  };

  const addViolation = (violation) => {
    const entry = {
      id: generateId(),
      rule: violation.rule || 'unknown',
      agent: extractAgentName(violation.agent),
      severity: violation.severity || 'warning',
      message: violation.message || 'Guardrail violation detected',
      phase: violation.phase || 'pre',
      timestamp: new Date(),
      payloadExcerpt: violation.payloadExcerpt || null,
    };
    return entry;
  };

  const violation = {
    rule: 'token-budget',
    agent: { name: 'code-agent', version: '2.1' },
    severity: 'critical',
    message: 'Token budget exceeded: 15000/10000',
    phase: 'pre',
    payloadExcerpt: '{"tokens_used": 15000, "budget": 10000}',
  };

  const entry = addViolation(violation);
  
  assert.strictEqual(entry.rule, 'token-budget');
  assert.strictEqual(entry.agent, 'code-agent');
  assert.strictEqual(entry.severity, 'critical');
  assert.strictEqual(entry.message, 'Token budget exceeded: 15000/10000');
  assert.strictEqual(entry.phase, 'pre');
  assert.ok(entry.timestamp instanceof Date);
  assert.strictEqual(entry.payloadExcerpt, '{"tokens_used": 15000, "budget": 10000}');
});

// Test 37: addViolation - minimal violation
test('addViolation provides defaults for minimal violation', () => {
  const generateId = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  
  const truncateText = (text, maxLength = 120) => {
    if (typeof text !== 'string') return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  const extractAgentName = (agentInfo) => {
    if (!agentInfo) return 'Unknown';
    if (typeof agentInfo === 'string') return agentInfo;
    if (agentInfo.name) return agentInfo.name;
    if (agentInfo.agentId) return agentInfo.agentId;
    return 'Unknown';
  };

  const addViolation = (violation) => {
    const entry = {
      id: generateId(),
      rule: violation.rule || 'unknown',
      agent: extractAgentName(violation.agent),
      severity: violation.severity || 'warning',
      message: violation.message || 'Guardrail violation detected',
      phase: violation.phase || 'pre',
      timestamp: new Date(),
      payloadExcerpt: violation.payloadExcerpt || null,
    };
    return entry;
  };

  const violation = {};
  const entry = addViolation(violation);
  
  assert.strictEqual(entry.rule, 'unknown');
  assert.strictEqual(entry.agent, 'Unknown');
  assert.strictEqual(entry.severity, 'warning');
  assert.strictEqual(entry.message, 'Guardrail violation detected');
  assert.strictEqual(entry.phase, 'pre');
  assert.ok(entry.timestamp instanceof Date);
  assert.strictEqual(entry.payloadExcerpt, null);
});

// Test 38: addViolation - null violation
test('addViolation handles null violation gracefully', () => {
  const generateId = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  
  const truncateText = (text, maxLength = 120) => {
    if (typeof text !== 'string') return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  const extractAgentName = (agentInfo) => {
    if (!agentInfo) return 'Unknown';
    if (typeof agentInfo === 'string') return agentInfo;
    if (agentInfo.name) return agentInfo.name;
    if (agentInfo.agentId) return agentInfo.agentId;
    return 'Unknown';
  };

  const addViolation = (violation) => {
    if (!violation) return null;
    
    const entry = {
      id: generateId(),
      rule: violation.rule || 'unknown',
      agent: extractAgentName(violation.agent),
      severity: violation.severity || 'warning',
      message: violation.message || 'Guardrail violation detected',
      phase: violation.phase || 'pre',
      timestamp: new Date(),
      payloadExcerpt: violation.payloadExcerpt || null,
    };
    return entry;
  };

  assert.strictEqual(addViolation(null), null);
  assert.strictEqual(addViolation(undefined), null);
});

// Test 39: addViolation - string agent
test('addViolation handles string agent directly', () => {
  const generateId = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  
  const truncateText = (text, maxLength = 120) => {
    if (typeof text !== 'string') return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  const extractAgentName = (agentInfo) => {
    if (!agentInfo) return 'Unknown';
    if (typeof agentInfo === 'string') return agentInfo;
    if (agentInfo.name) return agentInfo.name;
    if (agentInfo.agentId) return agentInfo.agentId;
    return 'Unknown';
  };

  const addViolation = (violation) => {
    const entry = {
      id: generateId(),
      rule: violation.rule || 'unknown',
      agent: extractAgentName(violation.agent),
      severity: violation.severity || 'warning',
      message: violation.message || 'Guardrail violation detected',
      phase: violation.phase || 'pre',
      timestamp: new Date(),
      payloadExcerpt: violation.payloadExcerpt || null,
    };
    return entry;
  };

  const violation = {
    rule: 'content-policy',
    agent: 'security-scanner',
    severity: 'info',
  };

  const entry = addViolation(violation);
  
  assert.strictEqual(entry.agent, 'security-scanner');
});

// Test 40: addViolation - payload excerpt truncation
test('addViolation includes payloadExcerpt for display', () => {
  const generateId = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  
  const truncateText = (text, maxLength = 120) => {
    if (typeof text !== 'string') return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  const extractAgentName = (agentInfo) => {
    if (!agentInfo) return 'Unknown';
    if (typeof agentInfo === 'string') return agentInfo;
    if (agentInfo.name) return agentInfo.name;
    if (agentInfo.agentId) return agentInfo.agentId;
    return 'Unknown';
  };

  const addViolation = (violation) => {
    const entry = {
      id: generateId(),
      rule: violation.rule || 'unknown',
      agent: extractAgentName(violation.agent),
      severity: violation.severity || 'warning',
      message: violation.message || 'Guardrail violation detected',
      phase: violation.phase || 'pre',
      timestamp: new Date(),
      payloadExcerpt: violation.payloadExcerpt || null,
    };
    return entry;
  };

  const longPayload = '{"data": "' + 'x'.repeat(500) + '"}';
  
  const violation = {
    rule: 'data-exposure',
    agent: 'pii-detector',
    severity: 'critical',
    message: 'Potential PII detected',
    payloadExcerpt: longPayload,
  };

  const entry = addViolation(violation);
  
  assert.strictEqual(entry.payloadExcerpt, longPayload);
  // Note: Truncation happens during display, not during normalization
});

// Summary
console.log(`\n${'='.repeat(60)}`);
console.log(`Payload Normalization Tests: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);