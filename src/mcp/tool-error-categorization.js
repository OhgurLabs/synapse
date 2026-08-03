/**
 * Tool-Specific Error Categorization
 *
 * Provides detailed error categorization and classification specific to tool types
 * and MCP server implementations. Enables fine-grained error handling and recovery
 * strategies based on tool characteristics and error patterns.
 *
 * Features:
 * - Tool category detection (filesystem, network, database, search, etc.)
 * - Error severity classification based on context
 * - Tool-specific error patterns and recommendations
 * - Recovery strategy hints per tool/error combination
 * - Error code mapping across different MCP implementations
 */

import { createLogger } from '../logger.js';

const log = createLogger('tool-error-categorization');

/**
 * Tool categories with their characteristics
 */
export const ToolCategories = Object.freeze({
  FILESYSTEM: 'filesystem',
  NETWORK: 'network',
  DATABASE: 'database',
  SEARCH: 'search',
  DATA_PROCESSING: 'data-processing',
  AUTHENTICATION: 'authentication',
  AUTHORIZATION: 'authorization',
  NOTIFICATION: 'notification',
  UTILITY: 'utility',
  CUSTOM: 'custom'
});

/**
 * Tool-specific error patterns and classifications
 */
export const ToolErrorPatterns = Object.freeze({
  // Filesystem tools
  [ToolCategories.FILESYSTEM]: {
    commonErrors: {
      FILE_NOT_FOUND: {
        code: 'FILE_NOT_FOUND',
        severity: 'low',
        retryable: false,
        recovery: 'check_file_path_or_create_file',
        message: 'File not found at specified path'
      },
      PERMISSION_DENIED: {
        code: 'PERMISSION_DENIED',
        severity: 'high',
        retryable: false,
        recovery: 'check_file_permissions',
        message: 'Insufficient permissions to access file'
      },
      DISK_FULL: {
        code: 'DISK_FULL',
        severity: 'high',
        retryable: false,
        recovery: 'free_disk_space_or_change_location',
        message: 'Disk is full, cannot write file'
      },
      LOCKED: {
        code: 'LOCKED',
        severity: 'medium',
        retryable: true,
        recovery: 'retry_after_delay',
        message: 'File is locked by another process'
      },
      INVALID_PATH: {
        code: 'INVALID_PATH',
        severity: 'low',
        retryable: false,
        recovery: 'validate_file_path',
        message: 'File path is invalid or malformed'
      },
      TOO_LARGE: {
        code: 'TOO_LARGE',
        severity: 'medium',
        retryable: false,
        recovery: 'use_streaming_or_split_file',
        message: 'File size exceeds limit'
      }
    }
  },

  // Network tools
  [ToolCategories.NETWORK]: {
    commonErrors: {
      CONNECTION_REFUSED: {
        code: 'CONNECTION_REFUSED',
        severity: 'high',
        retryable: true,
        recovery: 'retry_with_backoff_check_server_status',
        message: 'Connection refused by remote server'
      },
      CONNECTION_TIMEOUT: {
        code: 'CONNECTION_TIMEOUT',
        severity: 'medium',
        retryable: true,
        recovery: 'increase_timeout_or_retry',
        message: 'Connection attempt timed out'
      },
      DNS_RESOLUTION_FAILED: {
        code: 'DNS_RESOLUTION_FAILED',
        severity: 'high',
        retryable: false,
        recovery: 'check_dns_configuration_or_use_ip',
        message: 'Failed to resolve hostname'
      },
      SSL_ERROR: {
        code: 'SSL_ERROR',
        severity: 'high',
        retryable: false,
        recovery: 'check_ssl_certificate_or_disable_verification',
        message: 'SSL/TLS handshake failed'
      },
      RATE_LIMITED: {
        code: 'RATE_LIMITED',
        severity: 'medium',
        retryable: true,
        recovery: 'implement_exponential_backoff',
        message: 'Rate limit exceeded'
      },
      PROXY_ERROR: {
        code: 'PROXY_ERROR',
        severity: 'high',
        retryable: false,
        recovery: 'check_proxy_configuration',
        message: 'Proxy connection failed'
      }
    }
  },

  // Database tools
  [ToolCategories.DATABASE]: {
    commonErrors: {
      CONNECTION_FAILED: {
        code: 'CONNECTION_FAILED',
        severity: 'high',
        retryable: true,
        recovery: 'retry_with_backoff_check_db_status',
        message: 'Failed to connect to database'
      },
      QUERY_TIMEOUT: {
        code: 'QUERY_TIMEOUT',
        severity: 'medium',
        retryable: true,
        recovery: 'optimize_query_or_increase_timeout',
        message: 'Query execution exceeded timeout'
      },
      CONSTRAINT_VIOLATION: {
        code: 'CONSTRAINT_VIOLATION',
        severity: 'medium',
        retryable: false,
        recovery: 'fix_data_or_relax_constraints',
        message: 'Database constraint violation'
      },
      DEADLOCK: {
        code: 'DEADLOCK',
        severity: 'high',
        retryable: true,
        recovery: 'retry_with_delay',
        message: 'Database deadlock detected'
      },
      DUPLICATE_KEY: {
        code: 'DUPLICATE_KEY',
        severity: 'low',
        retryable: false,
        recovery: 'use_upsert_or_handle_duplicate',
        message: 'Duplicate key violation'
      },
      INSUFFICIENT_RESOURCES: {
        code: 'INSUFFICIENT_RESOURCES',
        severity: 'high',
        retryable: false,
        recovery: 'free_resources_or_scale_database',
        message: 'Database out of resources'
      }
    }
  },

  // Search tools
  [ToolCategories.SEARCH]: {
    commonErrors: {
      QUERY_TOO_LONG: {
        code: 'QUERY_TOO_LONG',
        severity: 'low',
        retryable: false,
        recovery: 'shorten_query_or_use_filters',
        message: 'Search query exceeds maximum length'
      },
      SYNTAX_ERROR: {
        code: 'SYNTAX_ERROR',
        severity: 'low',
        retryable: false,
        recovery: 'fix_query_syntax',
        message: 'Invalid search query syntax'
      },
      INDEX_NOT_READY: {
        code: 'INDEX_NOT_READY',
        severity: 'medium',
        retryable: true,
        recovery: 'retry_after_delay',
        message: 'Search index is being built or updated'
      },
      NO_RESULTS: {
        code: 'NO_RESULTS',
        severity: 'low',
        retryable: false,
        recovery: 'broaden_search_criteria',
        message: 'Search returned no results'
      },
      TIMEOUT: {
        code: 'TIMEOUT',
        severity: 'medium',
        retryable: true,
        recovery: 'optimize_query_or_increase_timeout',
        message: 'Search query timed out'
      }
    }
  },

  // Data processing tools
  [ToolCategories.DATA_PROCESSING]: {
    commonErrors: {
      INVALID_FORMAT: {
        code: 'INVALID_FORMAT',
        severity: 'medium',
        retryable: false,
        recovery: 'validate_input_format',
        message: 'Input data format is invalid'
      },
      PARSING_ERROR: {
        code: 'PARSING_ERROR',
        severity: 'low',
        retryable: false,
        recovery: 'fix_data_format',
        message: 'Failed to parse input data'
      },
      OUT_OF_MEMORY: {
        code: 'OUT_OF_MEMORY',
        severity: 'high',
        retryable: false,
        recovery: 'reduce_data_size_or_stream',
        message: 'Insufficient memory for processing'
      },
      UNSUPPORTED_TYPE: {
        code: 'UNSUPPORTED_TYPE',
        severity: 'medium',
        retryable: false,
        recovery: 'convert_data_type_or_use_different_tool',
        message: 'Unsupported data type'
      },
      TRANSFORMATION_ERROR: {
        code: 'TRANSFORMATION_ERROR',
        severity: 'low',
        retryable: false,
        recovery: 'check_transformation_rules',
        message: 'Data transformation failed'
      }
    }
  }
});

/**
 * ToolSpecificErrorCategorizer - Categorizes errors based on tool type and context
 */
export class ToolSpecificErrorCategorizer {
  constructor() {
    this._customPatterns = new Map();
    log.info('ToolSpecificErrorCategorizer initialized');
  }

  /**
   * Categorize an error based on tool name and error details.
   *
   * @param {string} toolName - Tool name
   * @param {Object} error - Error object
   * @param {string} [error.code] - Error code
   * @param {string} [error.message] - Error message
   * @param {Object} [context] - Additional context
   * @returns {Object} Categorized error with severity, retryability, and recovery hints
   */
  categorizeError(toolName, error, context = {}) {
    const category = this._detectToolCategory(toolName);
    const errorInfo = this._classifyError(category, toolName, error, context);

    return {
      toolName,
      category,
      ...errorInfo,
      customPatternApplied: errorInfo.customPatternApplied || false
    };
  }

  /**
   * Get tool category from tool name.
   *
   * @param {string} toolName - Tool name
   * @returns {string} Tool category
   */
  getToolCategory(toolName) {
    return this._detectToolCategory(toolName);
  }

  /**
   * Get common error patterns for a tool category.
   *
   * @param {string} category - Tool category
   * @returns {Object|null} Error patterns or null if not found
   */
  getErrorPatterns(category) {
    return ToolErrorPatterns[category] || null;
  }

  /**
   * Register a custom error pattern for a tool or category.
   *
   * @param {string} toolNameOrCategory - Tool name or category
   * @param {string} errorCode - Error code
   * @param {Object} pattern - Error pattern definition
   * @param {string} pattern.code - Error code
   * @param {string} pattern.severity - Error severity (low, medium, high)
   * @param {boolean} pattern.retryable - Whether error is retryable
   * @param {string} pattern.recovery - Recovery strategy
   * @param {string} pattern.message - Error message
   */
  registerCustomPattern(toolNameOrCategory, errorCode, pattern) {
    const key = `${toolNameOrCategory}:${errorCode}`;
    this._customPatterns.set(key, {
      ...pattern,
      custom: true
    });

    log.debug({
      toolNameOrCategory,
      errorCode,
      pattern
    }, 'Custom error pattern registered');
  }

  /**
   * Unregister a custom error pattern.
   *
   * @param {string} toolNameOrCategory - Tool name or category
   * @param {string} errorCode - Error code
   * @returns {boolean} True if pattern was found and removed
   */
  unregisterCustomPattern(toolNameOrCategory, errorCode) {
    const key = `${toolNameOrCategory}:${errorCode}`;
    const removed = this._customPatterns.delete(key);

    if (removed) {
      log.debug({
        toolNameOrCategory,
        errorCode
      }, 'Custom error pattern unregistered');
    }

    return removed;
  }

  /**
   * Get recovery recommendations for an error.
   *
   * @param {string} toolName - Tool name
   * @param {Object} error - Error object
   * @returns {Object} Recovery recommendations
   */
  getRecoveryRecommendations(toolName, error) {
    const categorized = this.categorizeError(toolName, error);
    const recommendations = [];

    // Add primary recovery recommendation
    if (categorized.recovery) {
      recommendations.push({
        type: 'primary',
        action: categorized.recovery,
        description: this._formatRecoveryAction(categorized.recovery)
      });
    }

    // Add retry recommendation if retryable
    if (categorized.retryable) {
      recommendations.push({
        type: 'retry',
        action: 'retry_with_backoff',
        description: 'Retry the operation with exponential backoff'
      });
    }

    // Add user intervention recommendation if high severity
    if (categorized.severity === 'high') {
      recommendations.push({
        type: 'intervention',
        action: 'user_intervention',
        description: 'Manual intervention may be required'
      });
    }

    return {
      severity: categorized.severity,
      retryable: categorized.retryable,
      recommendations
    };
  }

  /**
   * Detect tool category from tool name.
   *
   * @private
   * @param {string} toolName - Tool name
   * @returns {string} Tool category
   */
  _detectToolCategory(toolName) {
    if (!toolName) {
      return ToolCategories.CUSTOM;
    }

    const toolNameLower = toolName.toLowerCase();

    // Check for network tools first (they have priority)
    if (toolNameLower.includes('http') ||
        toolNameLower.includes('fetch') ||
        toolNameLower.includes('request') ||
        toolNameLower.includes('download') ||
        toolNameLower.includes('upload') ||
        toolNameLower.includes('connect')) {
      return ToolCategories.NETWORK;
    }

    // Check for database tools
    if (toolNameLower.includes('database') ||
        toolNameLower.includes(':db:') ||
        toolNameLower.startsWith('db:') ||
        toolNameLower.includes('sql')) {
      return ToolCategories.DATABASE;
    }

    // Check for search tools
    if (toolNameLower.includes('search') ||
        toolNameLower.includes(':find:') ||
        toolNameLower.includes('filter') ||
        toolNameLower.includes('index') ||
        toolNameLower.includes('lookup')) {
      return ToolCategories.SEARCH;
    }

    // Check for data processing tools
    if (toolNameLower.includes('parse') ||
        toolNameLower.includes('transform') ||
        toolNameLower.includes('convert') ||
        toolNameLower.includes('process') ||
        toolNameLower.includes('encode') ||
        toolNameLower.includes('decode')) {
      return ToolCategories.DATA_PROCESSING;
    }

    // Check for filesystem tools
    if (toolNameLower.includes('file') ||
        toolNameLower.includes('directory') ||
        toolNameLower.includes('path')) {
      return ToolCategories.FILESYSTEM;
    }

    // Check for filesystem by operation type (but exclude database tools)
    if ((toolNameLower.includes('read') || toolNameLower.includes('write') || toolNameLower.includes('delete')) &&
        !toolNameLower.includes('db') && !toolNameLower.includes('sql') &&
        !toolNameLower.includes('database')) {
      return ToolCategories.FILESYSTEM;
    }

    // Check for database tools
    if (toolNameLower.includes('database') ||
        toolNameLower.includes('db') ||
        toolNameLower.includes('query') ||
        toolNameLower.includes('sql') ||
        toolNameLower.includes('insert') ||
        toolNameLower.includes('update') ||
        toolNameLower.includes('delete')) {
      return ToolCategories.DATABASE;
    }

    // Check for search tools
    if (toolNameLower.includes('search') ||
        toolNameLower.includes('find') ||
        toolNameLower.includes('filter') ||
        toolNameLower.includes('index') ||
        toolNameLower.includes('lookup')) {
      return ToolCategories.SEARCH;
    }

    // Check for data processing tools
    if (toolNameLower.includes('parse') ||
        toolNameLower.includes('transform') ||
        toolNameLower.includes('convert') ||
        toolNameLower.includes('process') ||
        toolNameLower.includes('encode') ||
        toolNameLower.includes('decode')) {
      return ToolCategories.DATA_PROCESSING;
    }

    // Check for authentication tools
    if (toolNameLower.includes('auth') ||
        toolNameLower.includes('login') ||
        toolNameLower.includes('credential') ||
        toolNameLower.includes('token')) {
      return ToolCategories.AUTHENTICATION;
    }

    // Check for notification tools
    if (toolNameLower.includes('notify') ||
        toolNameLower.includes('alert') ||
        toolNameLower.includes('message') ||
        toolNameLower.includes('email') ||
        toolNameLower.includes('sms')) {
      return ToolCategories.NOTIFICATION;
    }

    return ToolCategories.UTILITY;
  }

  /**
   * Classify error based on category and error details.
   *
   * @private
   * @param {string} category - Tool category
   * @param {Object} error - Error object
   * @param {Object} context - Additional context
   * @returns {Object} Error classification
   */
  _classifyError(category, toolName, error, context) {
    const errorPatterns = ToolErrorPatterns[category];

    // Handle null/undefined errors
    if (!error) {
      return this._getDefaultClassification({});
    }

    // Check for custom patterns first (using tool name if available, otherwise skip)
    if (toolName && error.code) {
      const customPatternKey = `${toolName}:${error.code}`;
      if (this._customPatterns.has(customPatternKey)) {
        const customPattern = this._customPatterns.get(customPatternKey);
        return {
          ...customPattern,
          customPatternApplied: true
        };
      }
    }

    // Check category-specific patterns
    if (errorPatterns) {
      const commonErrors = errorPatterns.commonErrors;

      // Match by error code
      if (error.code && commonErrors[error.code]) {
        return { ...commonErrors[error.code] };
      }

      // Match by message pattern
      if (error.message) {
        const messageLower = error.message.toLowerCase();
        for (const [code, pattern] of Object.entries(commonErrors)) {
          if (messageLower.includes(pattern.message.toLowerCase()) ||
              messageLower.includes(code.toLowerCase())) {
            return { ...pattern };
          }
        }
      }
    }

    // Default classification
    return this._getDefaultClassification(error);
  }

  /**
   * Get default error classification.
   *
   * @private
   * @param {Object} error - Error object
   * @returns {Object} Default classification
   */
  _getDefaultClassification(error) {
    const message = (error.message || error.toString() || '').toLowerCase();

    // Default classifications based on message content
    if (message.includes('timeout') || message.includes('timed out')) {
      return {
        code: 'TIMEOUT',
        severity: 'medium',
        retryable: true,
        recovery: 'increase_timeout_or_retry',
        message: 'Operation timed out'
      };
    }

    if (message.includes('permission') || message.includes('denied') || message.includes('forbidden')) {
      return {
        code: 'PERMISSION_DENIED',
        severity: 'high',
        retryable: false,
        recovery: 'check_permissions',
        message: 'Permission denied'
      };
    }

    if (message.includes('not found') || message.includes('does not exist')) {
      return {
        code: 'NOT_FOUND',
        severity: 'low',
        retryable: false,
        recovery: 'verify_resource_exists',
        message: 'Resource not found'
      };
    }

    if (message.includes('invalid') || message.includes('malformed')) {
      return {
        code: 'INVALID_INPUT',
        severity: 'low',
        retryable: false,
        recovery: 'validate_input',
        message: 'Invalid input'
      };
    }

    if (message.includes('connection') || message.includes('connect')) {
      return {
        code: 'CONNECTION_ERROR',
        severity: 'high',
        retryable: true,
        recovery: 'retry_with_backoff',
        message: 'Connection error'
      };
    }

    // Generic unknown error
    return {
      code: 'UNKNOWN_ERROR',
      severity: 'medium',
      retryable: false,
      recovery: 'investigate_and_fix',
      message: 'Unknown error occurred'
    };
  }

  /**
   * Format recovery action for human readability.
   *
   * @private
   * @param {string} recovery - Recovery action
   * @returns {string} Formatted description
   */
  _formatRecoveryAction(recovery) {
    const actions = {
      'check_file_path_or_create_file': 'Verify the file path is correct or create the file if it does not exist',
      'check_file_permissions': 'Verify file and directory permissions allow the requested operation',
      'free_disk_space_or_change_location': 'Free up disk space or save to a different location',
      'retry_after_delay': 'Retry the operation after a short delay',
      'retry_with_delay': 'Retry with delay',
      'validate_file_path': 'Ensure the file path format is valid and accessible',
      'use_streaming_or_split_file': 'Use streaming mode or split the file into smaller chunks',
      'retry_with_backoff_check_server_status': 'Retry with exponential backoff and verify server status',
      'increase_timeout_or_retry': 'Increase timeout duration or retry the operation',
      'check_dns_configuration_or_use_ip': 'Verify DNS configuration or use IP address directly',
      'check_ssl_certificate_or_disable_verification': 'Verify SSL certificate validity or temporarily disable verification',
      'implement_exponential_backoff': 'Implement exponential backoff with jitter',
      'check_proxy_configuration': 'Verify proxy settings and connectivity',
      'optimize_query_or_increase_timeout': 'Optimize query performance or increase timeout',
      'fix_data_or_relax_constraints': 'Correct data values or relax validation constraints',
      'use_upsert_or_handle_duplicate': 'Use upsert operation or handle duplicate keys gracefully',
      'free_resources_or_scale_database': 'Free database resources or scale the database instance',
      'shorten_query_or_use_filters': 'Simplify the search query or apply filters',
      'fix_query_syntax': 'Correct the search query syntax',
      'broaden_search_criteria': 'Expand search parameters or reduce specificity',
      'validate_input_format': 'Ensure input data matches expected format',
      'fix_data_format': 'Correct the data format',
      'reduce_data_size_or_stream': 'Reduce data volume or use streaming processing',
      'convert_data_type_or_use_different_tool': 'Convert data type or select an appropriate tool',
      'check_transformation_rules': 'Review and correct transformation rules',
      'check_permissions': 'Verify user/agent has required permissions',
      'verify_resource_exists': 'Ensure the requested resource exists',
      'validate_input': 'Review and validate input parameters',
      'retry_with_backoff': 'Retry operation with exponential backoff and jitter',
      'investigate_and_fix': 'Investigate error details and fix the underlying issue',
      'user_intervention': 'Manual intervention required to resolve the issue'
    };

    return actions[recovery] || recovery.replace(/_/g, ' ').toUpperCase();
  }
}

/**
 * Create a ToolSpecificErrorCategorizer instance.
 *
 * @returns {ToolSpecificErrorCategorizer}
 */
export function createToolSpecificErrorCategorizer() {
  return new ToolSpecificErrorCategorizer();
}

// Export singleton instance for convenience
export const toolErrorCategorizer = new ToolSpecificErrorCategorizer();
