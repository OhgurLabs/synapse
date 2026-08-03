/**
 * deliberation-feedback-extractor.js
 *
 * Service for extracting and formatting reviewer feedback from deliberation sessions.
 * Converts REVIEW_FEEDBACK messages in messageHistory into structured reviewContext
 * objects for prompt injection into executor agents.
 *
 * Core responsibility: Parse deliberation session messageHistory, identify REVIEW_FEEDBACK
 * messages, and transform them into a format suitable for context injection.
 */

import { createLogger } from '../logger.js';

const log = createLogger('deliberation-feedback-extractor');

/**
 * Extract all REVIEW_FEEDBACK messages from a deliberation session's messageHistory
 * and format them as reviewContext objects for executor agent prompt injection.
 *
 * @param {Object} deliberationSession - Full deliberation session state from DeliberationProtocol.getState()
 * @param {Object} [options] - Optional configuration
 * @param {number} [options.maxFeedbackItems=10] - Maximum number of feedback items to return (most recent first)
 * @param {boolean} [options.includeApproved=false] - Include approved feedback (default: only needs-revision and rejected)
 * @param {string} [options.targetReviewRequestId=null] - Filter to specific review request ID
 * @returns {Array<{
 *   type: 'revision_feedback',
 *   feedback: string,
 *   suggestedChanges: Array<Object>,
 *   reviewerId: string,
 *   iteration: number,
 *   timestamp: string,
 *   status: string,
 *   reviewRequestId: string
 * }>}
 *
 * @example
 * const session = protocol.getState('session-123');
 * const feedbackList = extractReviewFeedback(session);
 * // Returns: [
 * //   {
 * //     type: 'revision_feedback',
 * //     feedback: 'The implementation is missing error handling for edge cases...',
 * //     suggestedChanges: [{ file: 'api.js', line: 42, suggestion: 'Add try-catch' }],
 * //     reviewerId: 'reviewer-agent-1',
 * //     iteration: 2,
 * //     timestamp: '2026-04-01T12:34:56Z',
 * //     status: 'rejected',
 * //     reviewRequestId: 'req-456'
 * //   }
 * // ]
 */
export function extractReviewFeedback(deliberationSession, options = {}) {
  const {
    maxFeedbackItems = 10,
    includeApproved = false,
    targetReviewRequestId = null,
  } = options;

  if (!deliberationSession) {
    log.warn('extractReviewFeedback called with null/undefined session');
    return [];
  }

  const messageHistory = deliberationSession.messageHistory || [];

  if (!Array.isArray(messageHistory)) {
    log.warn({ sessionId: deliberationSession.sessionId }, 'messageHistory is not an array');
    return [];
  }

  // Track iteration count per review request to support multi-round review cycles
  const reviewRequestIterations = new Map();

  const feedbackItems = [];

  for (const message of messageHistory) {
    const messageType = message.type || message.messageType;

    // Only process REVIEW_FEEDBACK messages
    if (messageType !== 'review_feedback') {
      continue;
    }

    const payload = message.payload || {};
    const status = payload.status;
    const reviewRequestId = payload.reviewRequestId || payload.originalMessageId || null;

    // Filter by review request ID if specified
    if (targetReviewRequestId && reviewRequestId !== targetReviewRequestId) {
      continue;
    }

    // Skip approved feedback unless explicitly requested
    if (!includeApproved && status === 'approved') {
      continue;
    }

    // Use stored iteration if available (added by protocol), otherwise compute it
    let iteration;
    if (typeof message.iteration === 'number') {
      // Iteration is already stored in the message by deliberation-protocol
      iteration = message.iteration;
    } else {
      // Fallback: compute iteration for older messages without stored iteration
      if (reviewRequestId) {
        const currentIteration = reviewRequestIterations.get(reviewRequestId) || 0;
        reviewRequestIterations.set(reviewRequestId, currentIteration + 1);
        iteration = reviewRequestIterations.get(reviewRequestId);
      } else {
        iteration = feedbackItems.length + 1;
      }
    }

    // Extract and format feedback
    const feedbackContext = {
      type: 'revision_feedback',
      feedback: payload.content || payload.feedback || '',
      suggestedChanges: Array.isArray(payload.suggestedChanges)
        ? payload.suggestedChanges
        : [],
      reviewerId: message.agentId || message.senderId || 'unknown',
      iteration,
      timestamp: message.timestamp || new Date().toISOString(),
      status: status || 'commented',
      reviewRequestId: reviewRequestId || null,
    };

    feedbackItems.push(feedbackContext);
  }

  // Return most recent items first, limited by maxFeedbackItems
  const recentFeedback = feedbackItems.slice(-maxFeedbackItems).reverse();

  log.debug({
    sessionId: deliberationSession.sessionId,
    totalMessages: messageHistory.length,
    feedbackCount: feedbackItems.length,
    returnedCount: recentFeedback.length,
  }, 'extracted review feedback');

  return recentFeedback;
}

/**
 * Extract the most recent REVIEW_FEEDBACK for a specific review request.
 * Convenience wrapper around extractReviewFeedback for single-item retrieval.
 *
 * @param {Object} deliberationSession - Full deliberation session state
 * @param {string} reviewRequestId - ID of the review request to find feedback for
 * @returns {Object|null} Most recent feedback object or null if not found
 *
 * @example
 * const feedback = getLatestFeedbackForRequest(session, 'req-123');
 * if (feedback && feedback.status === 'rejected') {
 *   console.log('Revision required:', feedback.feedback);
 * }
 */
export function getLatestFeedbackForRequest(deliberationSession, reviewRequestId) {
  if (!reviewRequestId) {
    log.warn('getLatestFeedbackForRequest called without reviewRequestId');
    return null;
  }

  const feedbackList = extractReviewFeedback(deliberationSession, {
    maxFeedbackItems: 1,
    includeApproved: true,
    targetReviewRequestId: reviewRequestId,
  });

  return feedbackList.length > 0 ? feedbackList[0] : null;
}

/**
 * Format review feedback as a structured text block suitable for prompt injection.
 * Converts reviewContext objects into markdown-formatted feedback sections.
 *
 * @param {Array<Object>} reviewContextList - Array of review feedback objects from extractReviewFeedback
 * @param {Object} [options] - Formatting options
 * @param {boolean} [options.includeIterationNumbers=true] - Show iteration numbers in output
 * @param {boolean} [options.includeSuggestedChanges=true] - Include detailed suggested changes
 * @returns {string} Formatted feedback text block
 *
 * @example
 * const feedback = extractReviewFeedback(session);
 * const formattedText = formatFeedbackForPrompt(feedback);
 * // Returns:
 * // === REVIEWER FEEDBACK (Iteration 2) ===
 * // Reviewer: reviewer-agent-1
 * // Status: needs-revision
 * //
 * // The implementation is missing error handling...
 * //
 * // Suggested Changes:
 * // - File: api.js, Line: 42 - Add try-catch block
 * // ======================================
 */
export function formatFeedbackForPrompt(reviewContextList, options = {}) {
  const {
    includeIterationNumbers = true,
    includeSuggestedChanges = true,
  } = options;

  if (!Array.isArray(reviewContextList) || reviewContextList.length === 0) {
    return '';
  }

  const sections = reviewContextList.map((ctx) => {
    const parts = [];

    // Header with iteration number
    const iterationLabel = includeIterationNumbers ? ` (Iteration ${ctx.iteration})` : '';
    parts.push(`=== REVIEWER FEEDBACK${iterationLabel} ===`);
    parts.push(`Reviewer: ${ctx.reviewerId}`);
    parts.push(`Status: ${ctx.status}`);

    if (ctx.timestamp) {
      parts.push(`Timestamp: ${ctx.timestamp}`);
    }

    parts.push(''); // blank line

    // Feedback content
    if (ctx.feedback) {
      parts.push(ctx.feedback);
    }

    // Suggested changes
    if (includeSuggestedChanges && Array.isArray(ctx.suggestedChanges) && ctx.suggestedChanges.length > 0) {
      parts.push('');
      parts.push('Suggested Changes:');
      ctx.suggestedChanges.forEach((change) => {
        const fileInfo = change.file ? `File: ${change.file}` : '';
        const lineInfo = change.line ? `, Line: ${change.line}` : '';
        const suggestion = change.suggestion || change.description || '';
        parts.push(`- ${fileInfo}${lineInfo}${fileInfo || lineInfo ? ' - ' : ''}${suggestion}`);
      });
    }

    parts.push('======================================');

    return parts.join('\n');
  });

  return sections.join('\n\n');
}

/**
 * Count the total number of review iterations for a deliberation session.
 * Useful for tracking review cycle depth and termination conditions.
 *
 * @param {Object} deliberationSession - Full deliberation session state
 * @returns {number} Total count of REVIEW_FEEDBACK messages
 *
 * @example
 * const iterations = countReviewIterations(session);
 * if (iterations >= maxIterations) {
 *   console.log('Max review iterations exceeded');
 * }
 */
export function countReviewIterations(deliberationSession) {
  if (!deliberationSession?.messageHistory) {
    return 0;
  }

  const messageHistory = Array.isArray(deliberationSession.messageHistory)
    ? deliberationSession.messageHistory
    : [];

  return messageHistory.filter(msg =>
    (msg.type || msg.messageType) === 'review_feedback'
  ).length;
}

/**
 * Get the current review status from the most recent REVIEW_FEEDBACK message.
 * Returns null if no feedback exists yet.
 *
 * @param {Object} deliberationSession - Full deliberation session state
 * @returns {{ status: string, reviewerId: string, timestamp: string }|null}
 *
 * @example
 * const currentStatus = getCurrentReviewStatus(session);
 * if (currentStatus?.status === 'approved') {
 *   completeTask();
 * }
 */
export function getCurrentReviewStatus(deliberationSession) {
  const feedbackList = extractReviewFeedback(deliberationSession, {
    maxFeedbackItems: 1,
    includeApproved: true,
  });

  if (feedbackList.length === 0) {
    return null;
  }

  const latest = feedbackList[0];
  return {
    status: latest.status,
    reviewerId: latest.reviewerId,
    timestamp: latest.timestamp,
  };
}
