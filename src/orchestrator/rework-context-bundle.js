/**
 * Rework Context Bundle Store
 * 
 * Serializes and deserializes full task context bundles for rejection->rework cycles.
 * This is the fallback path for preserving agent context across review rejections.
 * 
 * The bundle captures:
 * - Task metadata (id, title, description, plan, context)
 * - Subtask information (status, assignee, result, error)
 * - Message history (user/assistant interactions)
 * - Tool outputs and attachments
 * - Session metadata (agent ID, provider, trace context, touched files, git baseline)
 * - Review cycle information (cycle number, findings)
 */

import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';
import { serializeTaskBundle, rehydrateTaskBundle, BundleNotFoundError as TasksBundleNotFoundError } from '../tasks.js';

const log = createLogger('rework-context-bundle');

/**
 * Custom error for bundle store operations
 */
export class BundleStoreError extends Error {
  constructor(message, code = 'BUNDLE_STORE_ERROR') {
    super(message);
    this.name = 'BundleStoreError';
    this.code = code;
  }
}

/**
 * Error thrown when rehydrateContextBundle receives null/undefined input
 */
export class BundleNotFoundError extends Error {
  constructor(message = 'Context bundle not found or is null') {
    super(message);
    this.name = 'BundleNotFoundError';
    this.code = 'BUNDLE_NOT_FOUND';
  }
}

/**
 * Serialize a full task context bundle for durable storage.
 * 
 * Captures the complete agent session state including messages, tool outputs,
 * attachments, and session metadata needed to rehydrate the agent context.
 * 
 * @param {Object} task - Task object from tasks.js shape
 * @param {Object} messages - Array of message objects (from state.js addMessage)
 * @param {Object} sessionMeta - Session metadata with agentId, provider, traceContext, touchedFiles, gitBaseline
 * @param {Array} [attachments=[]] - Optional array of attachment objects
 * @param {Array} [toolOutputs=[]] - Optional array of tool output objects
 * @returns {Object} Serialized bundle object ready for JSON.stringify()
 */
export function serializeContextBundle(task, messages = [], sessionMeta = {}, attachments = [], toolOutputs = []) {
  if (!task || !task.id) {
    throw new BundleStoreError('Task object with id is required for serialization', 'INVALID_TASK');
  }

  const bundle = {
    // Task-level context (from serializeTaskBundle)
    taskId: task.id,
    title: task.title || '',
    description: task.description || '',
    context: task.context || null,
    plan: task.plan || null,
    delegationContext: task.delegationContext || null,
    reviewCycle: task.reviewCycle || 0,
    reviewFindings: Array.isArray(task.reviewFindings) ? task.reviewFindings : [],
    touchedFiles: Array.isArray(task.touchedFiles) ? task.touchedFiles : [],
    gitBaseline: task.gitBaseline || null,
    traceContext: task.traceContext || null,
    doneCriteria: task.doneCriteria || null,
    campaignId: task.campaignId || null,
    milestoneId: task.milestoneId || null,

    // Message history (from state.js addMessage shape)
    messages: Array.isArray(messages) ? messages.map(msg => ({
      id: msg.id || randomUUID(),
      role: msg.role || 'assistant',
      content: msg.content || '',
      timestamp: msg.timestamp || new Date().toISOString(),
      metadata: msg.metadata || null,
    })) : [],

    // Attachments (file references, tool outputs as attachments)
    attachments: Array.isArray(attachments) ? attachments.map(att => ({
      id: att.id || randomUUID(),
      type: att.type || 'file',
      name: att.name || 'attachment',
      path: att.path || null,
      content: att.content || null,
      size: typeof att.size === 'number' ? att.size : null,
      mimeType: att.mimeType || 'application/octet-stream',
      createdAt: att.createdAt || new Date().toISOString(),
    })) : [],

    // Tool outputs (separate from attachments for clarity)
    toolOutputs: Array.isArray(toolOutputs) ? toolOutputs.map(output => ({
      id: output.id || randomUUID(),
      toolName: output.toolName || output.name || 'unknown',
      input: output.input || null,
      output: output.output !== undefined ? output.output : output.result || null,
      status: output.status || 'success',
      timestamp: output.timestamp || output.createdAt || new Date().toISOString(),
      error: output.error || null,
    })) : [],

    // Session metadata (agent state for rehydration)
    sessionMeta: sessionMeta && typeof sessionMeta === 'object' ? {
      agentId: sessionMeta.agentId || null,
      provider: sessionMeta.provider || null,
      traceContext: sessionMeta.traceContext || null,
      touchedFiles: Array.isArray(sessionMeta.touchedFiles) ? sessionMeta.touchedFiles : [],
      gitBaseline: sessionMeta.gitBaseline || null,
      claimTime: sessionMeta.claimTime || new Date().toISOString(),
      retryCount: typeof sessionMeta.retryCount === 'number' ? sessionMeta.retryCount : 0,
      maxRetries: sessionMeta.maxRetries || 3,
      sessionId: sessionMeta.sessionId || randomUUID(),
      workspaceId: sessionMeta.workspaceId || null,
    } : {
      agentId: null,
      provider: null,
      traceContext: null,
      touchedFiles: [],
      gitBaseline: null,
      claimTime: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
      sessionId: randomUUID(),
      workspaceId: null,
    },

    // Bundle metadata for versioning and debugging
    bundleVersion: '1.0',
    serializedAt: new Date().toISOString(),
    serializationMetadata: {
      messageCount: Array.isArray(messages) ? messages.length : 0,
      attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
      toolOutputCount: Array.isArray(toolOutputs) ? toolOutputs.length : 0,
    },
  };

  log.debug('Context bundle serialized', {
    taskId: bundle.taskId,
    messageCount: bundle.messages.length,
    attachmentCount: bundle.attachments.length,
    toolOutputCount: bundle.toolOutputs.length,
  });

  return bundle;
}

/**
 * Rehydrate a serialized context bundle from durable storage.
 * 
 * Validates the bundle shape, restores messages, attachments, tool outputs,
 * and session metadata, returning an object matching the original serialization.
 * 
 * @param {Object|null|undefined} serializedBundle - Output of serializeContextBundle or JSON.parse
 * @returns {{
 *   taskId: string,
 *   title: string,
 *   description: string,
 *   context: string|null,
 *   plan: string|null,
 *   delegationContext: string|null,
 *   reviewCycle: number,
 *   reviewFindings: array,
 *   touchedFiles: array,
 *   gitBaseline: string|null,
 *   traceContext: object|null,
 *   doneCriteria: string|null,
 *   campaignId: string|null,
 *   milestoneId: string|null,
 *   messages: array,
 *   attachments: array,
 *   toolOutputs: array,
 *   sessionMeta: object,
 *   bundleVersion: string,
 *   serializedAt: string,
 *   serializationMetadata: object
 * }}
 * @throws {BundleNotFoundError} if serializedBundle is null/undefined
 * @throws {BundleStoreError} if the bundle is missing required fields (corrupt bundle)
 */
export function rehydrateContextBundle(serializedBundle) {
  if (serializedBundle == null) {
    throw new BundleNotFoundError();
  }

  // Validate required fields
  if (!serializedBundle.taskId || typeof serializedBundle.taskId !== 'string') {
    throw new BundleStoreError('Invalid context bundle: missing or invalid taskId', 'INVALID_BUNDLE');
  }

  if (!serializedBundle.title || typeof serializedBundle.title !== 'string') {
    throw new BundleStoreError('Invalid context bundle: missing or invalid title', 'INVALID_BUNDLE');
  }

  // Restore top-level task fields with defaults
  const rehydrated = {
    taskId: serializedBundle.taskId,
    title: serializedBundle.title,
    description: serializedBundle.description || '',
    context: serializedBundle.context || null,
    plan: serializedBundle.plan || null,
    delegationContext: serializedBundle.delegationContext || null,
    reviewCycle: typeof serializedBundle.reviewCycle === 'number' ? serializedBundle.reviewCycle : 0,
    reviewFindings: Array.isArray(serializedBundle.reviewFindings) ? serializedBundle.reviewFindings : [],
    touchedFiles: Array.isArray(serializedBundle.touchedFiles) ? serializedBundle.touchedFiles : [],
    gitBaseline: serializedBundle.gitBaseline || null,
    traceContext: serializedBundle.traceContext || null,
    doneCriteria: serializedBundle.doneCriteria || null,
    campaignId: serializedBundle.campaignId || null,
    milestoneId: serializedBundle.milestoneId || null,

    // Restore messages array
    messages: Array.isArray(serializedBundle.messages) ? serializedBundle.messages.map(msg => ({
      id: msg.id || randomUUID(),
      role: msg.role || 'assistant',
      content: msg.content || '',
      timestamp: msg.timestamp || new Date().toISOString(),
      metadata: msg.metadata || null,
    })) : [],

    // Restore attachments array
    attachments: Array.isArray(serializedBundle.attachments) ? serializedBundle.attachments.map(att => ({
      id: att.id || randomUUID(),
      type: att.type || 'file',
      name: att.name || 'attachment',
      path: att.path || null,
      content: att.content || null,
      size: typeof att.size === 'number' ? att.size : null,
      mimeType: att.mimeType || 'application/octet-stream',
      createdAt: att.createdAt || new Date().toISOString(),
    })) : [],

    // Restore toolOutputs array
    toolOutputs: Array.isArray(serializedBundle.toolOutputs) ? serializedBundle.toolOutputs.map(output => ({
      id: output.id || randomUUID(),
      toolName: output.toolName || output.name || 'unknown',
      input: output.input || null,
      output: output.output !== undefined ? output.output : output.result || null,
      status: output.status || 'success',
      timestamp: output.timestamp || output.createdAt || new Date().toISOString(),
      error: output.error || null,
    })) : [],

    // Restore sessionMeta object
    sessionMeta: serializedBundle.sessionMeta && typeof serializedBundle.sessionMeta === 'object' ? {
      agentId: serializedBundle.sessionMeta.agentId || null,
      provider: serializedBundle.sessionMeta.provider || null,
      traceContext: serializedBundle.sessionMeta.traceContext || null,
      touchedFiles: Array.isArray(serializedBundle.sessionMeta.touchedFiles)
        ? serializedBundle.sessionMeta.touchedFiles
        : [],
      gitBaseline: serializedBundle.sessionMeta.gitBaseline || null,
      claimTime: serializedBundle.sessionMeta.claimTime || new Date().toISOString(),
      retryCount: typeof serializedBundle.sessionMeta.retryCount === 'number'
        ? serializedBundle.sessionMeta.retryCount
        : 0,
      maxRetries: typeof serializedBundle.sessionMeta.maxRetries === 'number'
        ? serializedBundle.sessionMeta.maxRetries
        : 3,
      sessionId: serializedBundle.sessionMeta.sessionId || randomUUID(),
      workspaceId: serializedBundle.sessionMeta.workspaceId || null,
    } : {
      agentId: null,
      provider: null,
      traceContext: null,
      touchedFiles: [],
      gitBaseline: null,
      claimTime: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
      sessionId: randomUUID(),
      workspaceId: null,
    },

    // Bundle metadata
    bundleVersion: serializedBundle.bundleVersion || '1.0',
    serializedAt: serializedBundle.serializedAt || new Date().toISOString(),
    serializationMetadata: serializedBundle.serializationMetadata || {
      messageCount: Array.isArray(serializedBundle.messages) ? serializedBundle.messages.length : 0,
      attachmentCount: Array.isArray(serializedBundle.attachments) ? serializedBundle.attachments.length : 0,
      toolOutputCount: Array.isArray(serializedBundle.toolOutputs) ? serializedBundle.toolOutputs.length : 0,
    },
  };

  log.debug('Context bundle rehydrated', {
    taskId: rehydrated.taskId,
    messageCount: rehydrated.messages.length,
    attachmentCount: rehydrated.attachments.length,
    toolOutputCount: rehydrated.toolOutputs.length,
  });

  return rehydrated;
}

/**
 * Save a context bundle to JSON file using atomic write-rename pattern.
 * 
 * @param {string} storagePath - Directory path for storing bundles
 * @param {string} taskId - Task identifier (used as filename)
 * @param {Object} bundle - Serialized bundle object
 * @throws {BundleStoreError} If write or rename fails
 */
export async function saveContextBundleToFile(storagePath, taskId, bundle) {
  const { mkdirSync, writeFileSync, renameSync, existsSync, unlinkSync } = await import('fs');
  const { join } = await import('path');

  const bundleDir = storagePath;
  const bundlePath = join(bundleDir, `${taskId}.json`);
  const tmpPath = `${bundlePath}.tmp.${process.pid}`;

  try {
    mkdirSync(bundleDir, { recursive: true });
    const content = JSON.stringify(bundle, null, 2) + '\n';
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, bundlePath);
    log.debug('Context bundle saved to file', { taskId, path: bundlePath });
  } catch (err) {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw new BundleStoreError(`Failed to save context bundle: ${err.message}`, 'SAVE_FAILED');
  }
}

/**
 * Load a context bundle from JSON file.
 * 
 * @param {string} storagePath - Directory path for storing bundles
 * @param {string} taskId - Task identifier (used as filename)
 * @returns {Object|null} The deserialized bundle, or null if not found
 * @throws {BundleStoreError} If read or parse fails (except for missing file)
 */
export async function loadContextBundleFromFile(storagePath, taskId) {
  const { readFileSync, existsSync } = await import('fs');
  const { join } = await import('path');

  const bundlePath = join(storagePath, `${taskId}.json`);

  if (!existsSync(bundlePath)) {
    log.debug('Context bundle file not found', { taskId, path: bundlePath });
    return null;
  }

  try {
    const content = readFileSync(bundlePath, 'utf-8');
    const bundle = JSON.parse(content);
    log.debug('Context bundle loaded from file', { taskId, path: bundlePath });
    return bundle;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    if (err instanceof SyntaxError) {
      throw new BundleStoreError(`Corrupted context bundle JSON: ${err.message}`, 'PARSE_ERROR');
    }
    throw new BundleStoreError(`Failed to load context bundle: ${err.message}`, 'LOAD_FAILED');
  }
}

/**
 * Export all functions for use in other modules
 */
export default {
  serializeContextBundle,
  rehydrateContextBundle,
  saveContextBundleToFile,
  loadContextBundleFromFile,
  BundleStoreError,
  BundleNotFoundError,
};
