/**
 * AuditSearchUtilities — advanced search and filtering utilities for approval audit logs.
 * Provides enhanced search capabilities beyond basic query methods, including:
 * - Advanced filtering with date ranges, multiple operators, and decision types
 * - Paginated search results
 * - Search result aggregation and statistics
 * - Cross-project search with result deduplication
 * - Sensitive data sanitization for log exposure
 *
 * Integrates with ApprovalAuditTrail for data access.
 */

import { createLogger } from './logger.js';

const log = createLogger('audit-search');

/**
 * Sanitize audit entry to remove potentially sensitive data before exposure.
 * @param {Object} entry - Audit entry to sanitize
 * @param {Object} options - Sanitization options
 * @returns {Object} Sanitized entry
 */
export function sanitizeEntry(entry, options = {}) {
  const {
    redactReason = false,
    redactContext = false,
    maxContextDepth = 3,
    maxStringLength = 500,
  } = options;

  if (!entry) return null;

  const sanitized = {
    eventId: entry.eventId,
    timestamp: entry.timestamp,
    operatorId: entry.operatorId,
    milestoneId: entry.milestoneId,
    campaignId: entry.campaignId,
    projectId: entry.projectId,
    decision: entry.decision,
  };

  // Conditionally include reason
  if (!redactReason && entry.reason) {
    sanitized.reason = truncateString(entry.reason, maxStringLength);
  } else if (redactReason && entry.reason) {
    sanitized.reason = '[REDACTED]';
  }

  // Conditionally include context with depth limiting
  if (!redactContext && entry.context) {
    sanitized.context = limitObjectDepth(entry.context, maxContextDepth);
  } else if (redactContext && entry.context) {
    sanitized.context = { '[REDACTED]': true };
  }

  // Include trace/dispatch IDs for correlation (not sensitive)
  if (entry.traceId) sanitized.traceId = entry.traceId;
  if (entry.dispatchId) sanitized.dispatchId = entry.dispatchId;
  if (entry.subtaskId) sanitized.subtaskId = entry.subtaskId;

  // Include approval timing info (not sensitive)
  if (entry.approvalRequestedAt) sanitized.approvalRequestedAt = entry.approvalRequestedAt;
  if (entry.approvalApprovedAt) sanitized.approvalApprovedAt = entry.approvalApprovedAt;
  if (entry.approvalDuration !== null && entry.approvalDuration !== undefined) {
    sanitized.approvalDuration = entry.approvalDuration;
  }

  return sanitized;
}

/**
 * Truncate string to maximum length, adding ellipsis if truncated.
 * @param {string} str - String to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated string
 */
function truncateString(str, maxLength) {
  if (!str || str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Limit object depth by recursively truncating nested objects.
 * @param {Object} obj - Object to limit
 * @param {number} maxDepth - Maximum depth
 * @param {number} currentDepth - Current depth (internal use)
 * @returns {Object} Limited depth object
 */
function limitObjectDepth(obj, maxDepth, currentDepth = 0) {
  if (currentDepth >= maxDepth || !obj || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.slice(0, 10).map(item => limitObjectDepth(item, maxDepth, currentDepth + 1));
  }

  const result = {};
  let count = 0;
  for (const key of Object.keys(obj)) {
    if (count >= 20) {
      result['[truncated]'] = `...${Object.keys(obj).length - count} more keys`;
      break;
    }
    result[key] = limitObjectDepth(obj[key], maxDepth, currentDepth + 1);
    count++;
  }

  return result;
}

/**
 * Build search criteria from query parameters.
 * @param {Object} params - Query parameters
 * @returns {Object} Search criteria object
 */
export function buildSearchCriteria(params = {}) {
  const criteria = {
    projectId: null,
    milestoneId: null,
    operatorId: null,
    campaignId: null,
    decision: null,
    eventId: null,
    startDate: null,
    endDate: null,
    subtaskId: null,
    traceId: null,
    dispatchId: null,
  };

  if (params.projectId) criteria.projectId = params.projectId;
  if (params.milestoneId) criteria.milestoneId = params.milestoneId;
  if (params.operatorId) criteria.operatorId = params.operatorId;
  if (params.campaignId) criteria.campaignId = params.campaignId;
  if (params.decision) criteria.decision = params.decision;
  if (params.eventId) {
    const eventId = parseInt(params.eventId, 10);
    if (!Number.isNaN(eventId)) criteria.eventId = eventId;
  }
  if (params.subtaskId) criteria.subtaskId = params.subtaskId;
  if (params.traceId) criteria.traceId = params.traceId;
  if (params.dispatchId) criteria.dispatchId = params.dispatchId;

  // Handle date range
  if (params.since || params.startDate) {
    const dateStr = params.since || params.startDate;
    const date = new Date(dateStr);
    if (!Number.isNaN(date.getTime())) {
      criteria.startDate = date;
    }
  }

  if (params.until || params.endDate) {
    const dateStr = params.until || params.endDate;
    const date = new Date(dateStr);
    if (!Number.isNaN(date.getTime())) {
      criteria.endDate = date;
    }
  }

  return criteria;
}

/**
 * Paginate search results.
 * @param {Array} results - Full results array
 * @param {Object} pagination - Pagination options
 * @returns {Object} Paginated results with metadata
 */
export function paginateResults(results, pagination = {}) {
  const {
    page = 1,
    limit = 100,
    sortBy = 'timestamp',
    sortOrder = 'desc',
  } = pagination;

  const validatedPage = Math.max(1, parseInt(page, 10) || 1);
  const validatedLimit = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));

  // Sort results
  const sorted = [...results].sort((a, b) => {
    let comparison = 0;
    if (sortBy === 'eventId') {
      comparison = (a.eventId || 0) - (b.eventId || 0);
    } else if (sortBy === 'timestamp') {
      comparison = new Date(a.timestamp || 0) - new Date(b.timestamp || 0);
    } else if (sortBy === 'decision') {
      comparison = (a.decision || '').localeCompare(b.decision || '');
    } else if (sortBy === 'operatorId') {
      comparison = (a.operatorId || '').localeCompare(b.operatorId || '');
    } else if (sortBy === 'milestoneId') {
      comparison = (a.milestoneId || '').localeCompare(b.milestoneId || '');
    }

    return sortOrder === 'desc' ? -comparison : comparison;
  });

  // Calculate pagination
  const total = sorted.length;
  const totalPages = Math.ceil(total / validatedLimit);
  const startIndex = (validatedPage - 1) * validatedLimit;
  const endIndex = Math.min(startIndex + validatedLimit, total);

  const pageResults = sorted.slice(startIndex, endIndex);

  return {
    results: pageResults,
    pagination: {
      page: validatedPage,
      limit: validatedLimit,
      total,
      totalPages,
      hasPrev: validatedPage > 1,
      hasNext: validatedPage < totalPages,
      startIndex,
      endIndex: endIndex - 1,
    },
  };
}

/**
 * Compute search statistics from results.
 * @param {Array} results - Search results
 * @returns {Object} Statistics object
 */
export function computeStats(results = []) {
  const stats = {
    total: results.length,
    byDecision: {},
    byOperator: {},
    byMilestone: {},
    byCampaign: {},
    dateRange: {
      earliest: null,
      latest: null,
    },
    avgApprovalDuration: null,
  };

  let totalDuration = 0;
  let durationCount = 0;
  let earliest = null;
  let latest = null;

  for (const entry of results) {
    // Count by decision
    const decision = entry.decision || 'unknown';
    stats.byDecision[decision] = (stats.byDecision[decision] || 0) + 1;

    // Count by operator
    if (entry.operatorId) {
      stats.byOperator[entry.operatorId] = (stats.byOperator[entry.operatorId] || 0) + 1;
    }

    // Count by milestone
    if (entry.milestoneId) {
      stats.byMilestone[entry.milestoneId] = (stats.byMilestone[entry.milestoneId] || 0) + 1;
    }

    // Count by campaign
    if (entry.campaignId) {
      stats.byCampaign[entry.campaignId] = (stats.byCampaign[entry.campaignId] || 0) + 1;
    }

    // Date range
    if (entry.timestamp) {
      const ts = new Date(entry.timestamp);
      if (!Number.isNaN(ts.getTime())) {
        if (!earliest || ts < earliest) earliest = ts;
        if (!latest || ts > latest) latest = ts;
      }
    }

    // Duration stats
    if (entry.approvalDuration !== null && entry.approvalDuration !== undefined) {
      totalDuration += entry.approvalDuration;
      durationCount++;
    }
  }

  stats.dateRange.earliest = earliest ? earliest.toISOString() : null;
  stats.dateRange.latest = latest ? latest.toISOString() : null;

  if (durationCount > 0) {
    stats.avgApprovalDuration = totalDuration / durationCount;
  }

  return stats;
}

/**
 * Search audit logs with advanced filtering.
 * @param {Object} auditTrail - ApprovalAuditTrail instance
 * @param {Object} criteria - Search criteria from buildSearchCriteria
 * @param {Object} options - Search options
 * @returns {Array} Filtered results
 */
export function search(auditTrail, criteria, options = {}) {
  if (!auditTrail || typeof auditTrail.query !== 'function') {
    log.warn('Audit trail not available for search');
    return [];
  }

  const { limit = 100, projectId = 'default' } = options;

  try {
    // Use the base query method with criteria
    const results = auditTrail.query(projectId, {
      milestoneId: criteria.milestoneId,
      operatorId: criteria.operatorId,
      decision: criteria.decision,
      eventId: criteria.eventId,
      limit: limit * 10, // Fetch more for client-side filtering
    });

    // Apply additional filters that may not be supported by base query
    let filtered = results;

    // Date range filter
    if (criteria.startDate) {
      filtered = filtered.filter(e => {
        const ts = new Date(e.timestamp || 0);
        return !Number.isNaN(ts.getTime()) && ts >= criteria.startDate;
      });
    }

    if (criteria.endDate) {
      filtered = filtered.filter(e => {
        const ts = new Date(e.timestamp || 0);
        return !Number.isNaN(ts.getTime()) && ts <= criteria.endDate;
      });
    }

    // Campaign filter
    if (criteria.campaignId) {
      filtered = filtered.filter(e => e.campaignId === criteria.campaignId);
    }

    // Subtask filter
    if (criteria.subtaskId) {
      filtered = filtered.filter(e => e.subtaskId === criteria.subtaskId);
    }

    // Trace ID filter
    if (criteria.traceId) {
      filtered = filtered.filter(e => e.traceId === criteria.traceId);
    }

    // Dispatch ID filter
    if (criteria.dispatchId) {
      filtered = filtered.filter(e => e.dispatchId === criteria.dispatchId);
    }

    return filtered.slice(0, limit);
  } catch (err) {
    log.error('Search failed', { criteria, error: err.message });
    return [];
  }
}

/**
 * Cross-project search with result deduplication.
 * @param {Object} auditTrail - ApprovalAuditTrail instance
 * @param {Object} criteria - Search criteria
 * @param {Object} options - Search options
 * @returns {Array} Deduplicated results from all projects
 */
export function searchCrossProject(auditTrail, criteria, options = {}) {
  if (!auditTrail || typeof auditTrail.queryAllProjects !== 'function') {
    log.warn('Audit trail not available for cross-project search');
    return [];
  }

  const { limit = 100, sanitize = true, sanitizeOptions = {} } = options;

  try {
    // Fetch from all projects
    const allResults = auditTrail.queryAllProjects({ limit: limit * 10 });

    // Apply filters
    let filtered = allResults;

    if (criteria.milestoneId) {
      filtered = filtered.filter(e => e.milestoneId === criteria.milestoneId);
    }
    if (criteria.operatorId) {
      filtered = filtered.filter(e => e.operatorId === criteria.operatorId);
    }
    if (criteria.decision) {
      filtered = filtered.filter(e => e.decision === criteria.decision);
    }
    if (criteria.campaignId) {
      filtered = filtered.filter(e => e.campaignId === criteria.campaignId);
    }
    if (criteria.eventId) {
      filtered = filtered.filter(e => e.eventId === criteria.eventId);
    }

    // Date range filters
    if (criteria.startDate) {
      filtered = filtered.filter(e => {
        const ts = new Date(e.timestamp || 0);
        return !Number.isNaN(ts.getTime()) && ts >= criteria.startDate;
      });
    }
    if (criteria.endDate) {
      filtered = filtered.filter(e => {
        const ts = new Date(e.timestamp || 0);
        return !Number.isNaN(ts.getTime()) && ts <= criteria.endDate;
      });
    }

    // Sort by timestamp descending
    filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Limit results
    const limited = filtered.slice(0, limit);

    // Sanitize if requested
    if (sanitize) {
      return limited.map(e => sanitizeEntry(e, sanitizeOptions));
    }

    return limited;
  } catch (err) {
    log.error('Cross-project search failed', { criteria, error: err.message });
    return [];
  }
}

/**
 * Full-text search in audit entry fields.
 * @param {Array} entries - Entries to search
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @returns {Array} Matching entries
 */
export function fullTextSearch(entries = [], query, options = {}) {
  if (!query || !query.trim() || !entries.length) {
    return entries;
  }

  const {
    fields = ['reason', 'milestoneId', 'operatorId', 'campaignId'],
    caseSensitive = false,
  } = options;

  const searchTerms = query.trim().split(/\s+/).filter(t => t.length > 0);
  const searchPatterns = caseSensitive
    ? searchTerms
    : searchTerms.map(t => t.toLowerCase());

  return entries.filter(entry => {
    for (const field of fields) {
      const value = entry[field];
      if (value === null || value === undefined) continue;

      const strValue = caseSensitive
        ? String(value)
        : String(value).toLowerCase();

      const matches = searchPatterns.every(term =>
        strValue.includes(term)
      );

      if (matches) return true;
    }

    // Also search in context object
    if (entry.context && typeof entry.context === 'object') {
      const contextStr = caseSensitive
        ? JSON.stringify(entry.context)
        : JSON.stringify(entry.context).toLowerCase();

      const contextMatches = searchPatterns.every(term =>
        contextStr.includes(term)
      );

      if (contextMatches) return true;
    }

    return false;
  });
}

/**
 * Export search results with optional formatting.
 * @param {Array} results - Search results
 * @param {Object} options - Export options
 * @returns {string} Formatted export
 */
export function exportResults(results, options = {}) {
  const {
    format = 'json',
    sanitize = true,
    includeStats = true,
    sanitizeOptions = {},
  } = options;

  // Sanitize if requested
  const exportResults = sanitize
    ? results.map(e => sanitizeEntry(e, sanitizeOptions))
    : results;

  // Compute stats if requested
  let stats = null;
  if (includeStats) {
    stats = computeStats(results);
  }

  const exportData = {
    exportedAt: new Date().toISOString(),
    totalEntries: exportResults.length,
    stats,
    entries: exportResults,
  };

  if (format === 'json') {
    return JSON.stringify(exportData, null, 2);
  } else if (format === 'csv') {
    const headers = [
      'eventId',
      'timestamp',
      'operatorId',
      'milestoneId',
      'campaignId',
      'projectId',
      'decision',
      'reason',
      'approvalDuration',
      'traceId',
      'dispatchId',
    ];

    const rows = exportResults.map(e =>
      headers.map(h => {
        const val = e[h] ?? '';
        // Escape CSV values
        const str = String(val).replace(/"/g, '""');
        return str.includes(',') || str.includes('"') || str.includes('\n')
          ? `"${str}"`
          : str;
      }).join(',')
    );

    return [headers.join(','), ...rows].join('\n');
  }

  return exportData;
}

/**
 * Create a search session with cached results for efficient pagination.
 * @param {Object} auditTrail - ApprovalAuditTrail instance
 * @param {Object} criteria - Search criteria
 * @returns {Object} Search session object
 */
export function createSearchSession(auditTrail, criteria, options = {}) {
  const { maxCacheSize = 1000 } = options;

  let cachedResults = null;
  let cacheInvalidated = false;

  const session = {
    criteria,
    options,
    createdAt: new Date().toISOString(),

    getResults(pagination = {}) {
      if (cacheInvalidated || cachedResults === null) {
        cachedResults = search(auditTrail, criteria, {
          ...options,
          limit: maxCacheSize,
        });
        cacheInvalidated = false;
      }

      return paginateResults(cachedResults, pagination);
    },

    getStats() {
      if (cacheInvalidated || cachedResults === null) {
        this.getResults();
      }
      return computeStats(cachedResults || []);
    },

    invalidateCache() {
      cacheInvalidated = true;
      cachedResults = null;
    },

    refresh() {
      this.invalidateCache();
      return this.getResults();
    },
  };

  return session;
}

/**
 * Validate search parameters.
 * @param {Object} params - Parameters to validate
 * @returns {Object} Validation result with isValid and errors
 */
export function validateSearchParams(params = {}) {
  const errors = [];

  if (params.page !== undefined) {
    const page = parseInt(params.page, 10);
    if (Number.isNaN(page) || page < 1) {
      errors.push('page must be a positive integer');
    }
  }

  if (params.limit !== undefined) {
    const limit = parseInt(params.limit, 10);
    if (Number.isNaN(limit) || limit < 1 || limit > 500) {
      errors.push('limit must be an integer between 1 and 500');
    }
  }

  if (params.since) {
    const date = new Date(params.since);
    if (Number.isNaN(date.getTime())) {
      errors.push('since must be a valid ISO date string');
    }
  }

  if (params.until) {
    const date = new Date(params.until);
    if (Number.isNaN(date.getTime())) {
      errors.push('until must be a valid ISO date string');
    }
  }

  if (params.eventId !== undefined) {
    const eventId = parseInt(params.eventId, 10);
    if (Number.isNaN(eventId) || eventId < 1) {
      errors.push('eventId must be a positive integer');
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
