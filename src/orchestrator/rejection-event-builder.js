/**
 * rejection-event-builder.js
 *
 * Helper to construct valid review_rejection_event payloads for the timeline store.
 * Validates required fields and applies sensible defaults to ensure events conform
 * to the schema documented in event-schema.js (lines 192-297).
 */

import { randomUUID } from 'crypto';

/**
 * Build a review_rejection_event payload with all required fields.
 *
 * @param {Object} params - Event parameters
 * @param {string} params.taskId - Original task ID (preserved across rework)
 * @param {string} params.reviewerId - Reviewer identity (e.g., 'human_reviewer', 'auto_reviewer')
 * @param {Array} params.findings - Array of finding objects with { id, severity, category, description, location, evidence, suggested_fix }
 * @param {number} params.cycleNumber - Rework cycle number (1 = first rejection)
 * @param {string} [params.reworkStatus='pending'] - Rework state: 'pending', 'in_progress', 'completed'
 * @param {Object} [params.reworkContext] - Serialized task context bundle (from serializeTaskBundle)
 * @param {string} [params.campaignId] - Campaign correlation ID
 * @param {string} [params.dispatchId] - Dispatch ID being reviewed
 * @param {string} [params.traceId] - Distributed trace ID
 * @param {string} [params.agentId] - Agent whose work was rejected
 * @param {string} [params.provider] - LLM provider (e.g., 'gemini', 'claude', 'ollama')
 * @param {string} [params.verdict='rejection'] - Review verdict
 * @param {Object} [params.data] - Additional metadata: { previous_state, transition_reason, priority }
 * @param {string} [params.id] - Event ID (generated if not provided)
 * @param {string} [params.eventTs] - Event timestamp (ISO 8601, generated if not provided)
 *
 * @returns {Object} Event payload ready to pass to TimelineStore.appendReviewRejectionEvent()
 * @throws {Error} If required fields are missing or invalid
 */
function buildReviewRejectionEvent(params = {}) {
  // Validate required fields
  if (!params.taskId || typeof params.taskId !== 'string') {
    throw new Error('taskId is required and must be a string');
  }
  if (!params.reviewerId || typeof params.reviewerId !== 'string') {
    throw new Error('reviewerId is required and must be a string');
  }
  if (!Array.isArray(params.findings)) {
    throw new Error('findings is required and must be an array');
  }
  if (!Number.isFinite(params.cycleNumber) || params.cycleNumber < 1) {
    throw new Error('cycleNumber is required and must be a positive integer');
  }

  // Validate findings structure (basic validation)
  for (const finding of params.findings) {
    if (!finding.id || !finding.severity || !finding.category || !finding.description) {
      throw new Error('Each finding must have id, severity, category, and description fields');
    }
  }

  const reworkStatus = params.reworkStatus || 'pending';
  const validStatuses = ['pending', 'in_progress', 'completed'];
  if (!validStatuses.includes(reworkStatus)) {
    throw new Error(`reworkStatus must be one of: ${validStatuses.join(', ')}`);
  }

  // Build the event payload
  const event = {
    // Identity fields
    id: params.id || `review-rejection-${randomUUID()}`,
    eventTs: params.eventTs || new Date().toISOString(),

    // Correlation fields (optional but recommended)
    campaignId: params.campaignId || null,
    dispatchId: params.dispatchId || null,
    traceId: params.traceId || null,
    agentId: params.agentId || null,
    provider: params.provider || null,

    // Core rejection fields (required)
    taskId: params.taskId,
    reviewerId: params.reviewerId,
    findingsCount: params.findings.length,
    cycleNumber: params.cycleNumber,
    reworkStatus: reworkStatus,
    verdict: params.verdict || 'rejection',

    // Payload fields
    findings: params.findings,
    reworkContext: params.reworkContext || null,

    // Metadata
    data: params.data || {
      previous_state: 'completed',
      transition_reason: 'quality_gate_failed',
      priority: 'medium'
    }
  };

  return event;
}

/**
 * Create a finding object with proper structure.
 *
 * @param {Object} params - Finding parameters
 * @param {string} [params.id] - Finding ID (generated if not provided)
 * @param {string} params.severity - Severity: 'low', 'medium', 'high', 'critical'
 * @param {string} params.category - Category: 'functional', 'style', 'security', 'performance'
 * @param {string} params.description - Human-readable description
 * @param {Object} [params.location] - { file, line, column } or null
 * @param {string} [params.evidence] - Code snippet or log excerpt
 * @param {string} [params.suggestedFix] - Optional suggested fix
 *
 * @returns {Object} Finding object
 * @throws {Error} If required fields are missing
 */
function createFinding(params = {}) {
  const validSeverities = ['low', 'medium', 'high', 'critical'];
  const validCategories = ['functional', 'style', 'security', 'performance'];

  if (!params.severity || !validSeverities.includes(params.severity)) {
    throw new Error(`severity is required and must be one of: ${validSeverities.join(', ')}`);
  }
  if (!params.category || !validCategories.includes(params.category)) {
    throw new Error(`category is required and must be one of: ${validCategories.join(', ')}`);
  }
  if (!params.description || typeof params.description !== 'string') {
    throw new Error('description is required and must be a string');
  }

  return {
    id: params.id || `finding-${randomUUID()}`,
    severity: params.severity,
    category: params.category,
    description: params.description,
    location: params.location || null,
    evidence: params.evidence || null,
    suggested_fix: params.suggestedFix || null
  };
}

export {
  buildReviewRejectionEvent,
  createFinding
};
