// Webhook Approval Handler — parses external approval payloads (Slack, generic webhooks)
// and extracts structured approval data for campaign milestone resumption.

import { createHmac } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('webhook-approval-handler');

// Slack-specific constants
const SLACK_SIGNING_SECRET_HEADER = 'X-Slack-Signature';
const SLACK_TIMESTAMP_HEADER = 'X-Slack-Request-Timestamp';
const SLACK_CHANNEL_HEADER = 'X-Slack-Request-Timestamp';

/**
 * Parse Slack interactive message payloads (button clicks, modal submissions)
 * Expected payload formats:
 * 1. Button click: { type: 'block_actions', actions: [{ type: 'button', value: 'approve|reject:ms_...:proj_...' }] }
 * 2. Modal submission: { type: 'view_submission', view: { values: { milestoneId: {...}, decision: {...} } } }
 * 
 * @param {Object} payload - Slack webhook payload
 * @param {string} signingSecret - Slack signing secret for verification (optional)
 * @param {Object} requestHeaders - HTTP headers for signature verification (optional)
 * @returns {Object} Parsed approval data: { milestoneId, projectId, decision, operatorId, reason, source: 'slack', slackData: {...} }
 * @throws {Error} If payload format is invalid or signature verification fails
 */
export function parseSlackPayload(payload, signingSecret = null, requestHeaders = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid payload: expected object');
  }

  // Verify Slack signature if secret provided
  if (signingSecret && requestHeaders[SLACK_SIGNING_SECRET_HEADER]) {
    const timestamp = requestHeaders[SLACK_TIMESTAMP_HEADER];
    const signature = requestHeaders[SLACK_SIGNING_SECRET_HEADER];
    if (!verifySlackSignature(payload, timestamp, signature, signingSecret)) {
      throw new Error('Slack signature verification failed');
    }
  }

  let parsed = null;

  // Handle block_actions (button clicks)
  if (payload.type === 'block_actions') {
    parsed = parseSlackBlockActions(payload);
  }
  // Handle view_submission (modal submissions)
  else if (payload.type === 'view_submission') {
    parsed = parseSlackViewSubmission(payload);
  }
  // Handle interactive_message (legacy attachments)
  else if (payload.type === 'interactive_message') {
    parsed = parseSlackInteractiveMessage(payload);
  }
  else {
    throw new Error(`Unsupported Slack payload type: ${payload.type || 'unknown'}`);
  }

  // Validate required fields
  if (!parsed.milestoneId) {
    throw new Error('Missing milestoneId in payload');
  }
  if (!parsed.projectId) {
    throw new Error('Missing projectId in payload');
  }
  if (!['approve', 'reject'].includes(parsed.decision)) {
    throw new Error(`Invalid decision: ${parsed.decision}. Must be 'approve' or 'reject'`);
  }

  return {
    ...parsed,
    source: 'slack',
    webhookProvider: 'slack',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Parse Slack block_actions payloads (button clicks)
 * Value format: "approve:ms_123:proj_456" or "reject:ms_123:proj_456"
 */
function parseSlackBlockActions(payload) {
  const actions = payload.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('No actions found in block_actions payload');
  }

  const action = actions[0];
  if (!action.value) {
    throw new Error('Action value is empty');
  }

  // Parse value format: "decision:ms_id:proj_id" or "decision:ms_id:proj_id:reason"
  const parts = action.value.split(':');
  if (parts.length < 3) {
    throw new Error('Invalid action value format. Expected: decision:ms_id:proj_id[:reason]');
  }

  const [decision, milestoneId, projectId, ...reasonParts] = parts;
  const reason = reasonParts.length > 0 ? reasonParts.join(':') : null;

  return {
    milestoneId,
    projectId,
    decision,
    operatorId: payload.user?.id || payload.user?.name || 'unknown',
    reason,
    slackData: {
      actionId: action.action_id,
      blockId: action.block_id,
      channelId: payload.channel?.id,
      responseUrl: payload.response_url,
      triggerId: payload.trigger_id,
    },
  };
}

/**
 * Parse Slack view_submission payloads (modal submissions)
 */
function parseSlackViewSubmission(payload) {
  const view = payload.view;
  const values = view.values || {};

  // Extract values from modal fields
  const extractValue = (blockId, actionId) => {
    const block = values[blockId];
    if (!block) return null;
    const field = block[actionId];
    return field ? field.value : null;
  };

  // Try common field names
  const milestoneId = extractValue('milestoneBlock', 'milestoneId') ||
                     extractValue('milestone', 'id') ||
                     extractValue('meta', 'milestoneId') ||
                     payload.user?.id; // fallback (not ideal)
  
  const projectId = extractValue('projectBlock', 'projectId') ||
                    extractValue('project', 'id') ||
                    extractValue('meta', 'projectId');

  const decision = extractValue('decisionBlock', 'decision') ||
                   extractValue('decision', 'select');

  const reason = extractValue('reasonBlock', 'reason') ||
                 extractValue('reason', 'textarea') ||
                 extractValue('feedback', 'textarea');

  if (!milestoneId || !projectId || !decision) {
    throw new Error('Missing required fields in view_submission. Expected milestoneId, projectId, and decision blocks.');
  }

  return {
    milestoneId,
    projectId,
    decision,
    operatorId: payload.user?.id || payload.user?.name || 'unknown',
    reason,
    slackData: {
      viewId: view.id,
      viewType: view.type,
      channelId: payload.team?.id,
      responseUrl: payload.response_url,
      triggerId: payload.trigger_id,
    },
  };
}

/**
 * Parse legacy interactive_message payloads
 */
function parseSlackInteractiveMessage(payload) {
  const callbackId = payload.callback_id;
  const actions = payload.actions || [];

  // Extract from callback_id format: "approve:ms_123:proj_456"
  if (callbackId && callbackId.includes(':')) {
    const parts = callbackId.split(':');
    if (parts.length >= 3) {
      const [prefix, milestoneId, projectId] = parts;
      const action = actions[0];
      const decision = action?.value || (payload.selected_option?.value || 'approve');
      
      return {
        milestoneId,
        projectId,
        decision,
        operatorId: payload.user?.id || payload.user?.name || 'unknown',
        reason: null,
        slackData: {
          callbackId,
          channelId: payload.channel?.id,
        },
      };
    }
  }

  throw new Error('Unable to parse interactive_message payload');
}

/**
 * Verify Slack signature using HMAC-SHA256
 * @param {Object} payload - Request body as JSON
 * @param {string} timestamp - X-Slack-Request-Timestamp header
 * @param {string} signature - X-Slack-Signature header
 * @param {string} signingSecret - Slack signing secret
 * @returns {boolean}
 */
function verifySlackSignature(payload, timestamp, signature, signingSecret) {
  if (!timestamp || !signature || !signingSecret) {
    log.warn('Missing signature verification parameters');
    return false;
  }

  const body = JSON.stringify(payload);
  const sigBase = `${timestamp}:${body}`;
  const expectedSignature = `v0=${createHmac('sha256', signingSecret).update(sigBase).digest('hex')}`;
  
  return signature === expectedSignature;
}

/**
 * Parse generic webhook payloads (custom approval systems, REST APIs)
 * Expected payload format:
 * {
 *   milestoneId: string,
 *   projectId: string,
 *   decision: 'approve' | 'reject',
 *   operatorId: string (optional),
 *   reason: string (optional),
 *   deliveryId: string (optional, for webhook tracking),
 *   metadata: Object (optional, provider-specific data)
 * }
 * 
 * @param {Object} payload - Generic webhook payload
 * @param {string} webhookSecret - Shared secret for HMAC verification (optional)
 * @param {Object} requestHeaders - HTTP headers including X-Signature (optional)
 * @returns {Object} Parsed approval data: { milestoneId, projectId, decision, operatorId, reason, source: 'webhook', webhookData: {...} }
 * @throws {Error} If payload format is invalid or signature verification fails
 */
export function parseGenericWebhookPayload(payload, webhookSecret = null, requestHeaders = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid payload: expected object');
  }

  // Verify signature if secret provided
  if (webhookSecret && requestHeaders['X-Signature']) {
    if (!verifyGenericSignature(payload, requestHeaders['X-Signature'], webhookSecret)) {
      throw new Error('Webhook signature verification failed');
    }
  }

  // Extract and validate required fields
  const milestoneId = payload.milestoneId || payload.milestone_id;
  const projectId = payload.projectId || payload.project_id;
  const decision = payload.decision;
  const operatorId = payload.operatorId || payload.operator_id || payload.userId || payload.user_id || 'webhook';
  const reason = payload.reason || payload.comment || null;
  const deliveryId = payload.deliveryId || payload.delivery_id || requestHeaders['X-Delivery-ID'] || null;

  if (!milestoneId) {
    throw new Error('Missing milestoneId in payload');
  }
  if (!projectId) {
    throw new Error('Missing projectId in payload');
  }
  if (!['approve', 'reject'].includes(decision)) {
    throw new Error(`Invalid decision: ${decision}. Must be 'approve' or 'reject'`);
  }

  return {
    milestoneId,
    projectId,
    decision,
    operatorId,
    reason,
    source: 'webhook',
    webhookProvider: 'generic',
    deliveryId,
    timestamp: new Date().toISOString(),
    webhookData: {
      headers: {
        'X-Delivery-ID': deliveryId,
        'User-Agent': requestHeaders['User-Agent'] || null,
      },
      metadata: payload.metadata || {},
    },
  };
}

/**
 * Verify generic webhook signature using HMAC-SHA256
 * @param {Object} payload - Request body as JSON
 * @param {string} signature - X-Signature header value
 * @param {string} secret - Shared secret
 * @returns {boolean}
 */
function verifyGenericSignature(payload, signature, secret) {
  if (!signature || !secret) {
    log.warn('Missing signature verification parameters');
    return false;
  }

  const body = JSON.stringify(payload);
  const expectedSignature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  
  return signature === expectedSignature;
}

/**
 * Unified approval parser that auto-detects payload type
 * @param {Object} payload - Webhook payload
 * @param {Object} options - Parsing options including secrets and headers
 * @returns {Object} Parsed approval data with source identification
 */
export function parseApprovalPayload(payload, options = {}) {
  const { slackSigningSecret, webhookSecret, requestHeaders = {} } = options;

  // Auto-detect Slack payloads
  if (payload.type === 'block_actions' || 
      payload.type === 'view_submission' || 
      payload.type === 'interactive_message' ||
      requestHeaders[SLACK_SIGNING_SECRET_HEADER]) {
    return parseSlackPayload(payload, slackSigningSecret, requestHeaders);
  }

  // Default to generic webhook parser
  return parseGenericWebhookPayload(payload, webhookSecret, requestHeaders);
}
