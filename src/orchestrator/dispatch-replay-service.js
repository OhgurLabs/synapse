/**
 * dispatch-replay-service.js — Reconstructs and replays dispatches from timeline events.
 *
 * Retrieves a dispatch by dispatch_id, reconstructs its full state
 * (message, routing decision, selected agent/provider, constraints, weights),
 * and re-executes via the existing dispatch pipeline while maintaining
 * dispatch_id continuity through a replayed_from_id linkage.
 */

import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';
import { reconstructDispatchState } from './dispatch-state-reconstructor.js';

const log = createLogger('dispatch-replay-service');

/**
 * @typedef {Object} ReplayOptions
 * @property {string} [operatorId='system'] - ID of operator initiating replay
 * @property {string} [targetAgent] - Override agent selection for replay
 * @property {string} [targetProvider] - Override provider for replay
 * @property {string} [projectId] - Project context (required for dispatch)
 * @property {string} [channelId] - Channel context (required for dispatch)
 */

/**
 * @typedef {Object} ReplayResult
 * @property {boolean} success - Whether replay completed
 * @property {string} replayDispatchId - New dispatch ID for the replay
 * @property {string} originalDispatchId - Source dispatch ID
 * @property {string} operatorId - Operator who initiated replay
 * @property {string} message - Original message that was replayed
 * @property {Object} reconstructedState - Full reconstructed state snapshot
 * @property {string} [error] - Error message if replay failed
 */

/**
 * Create the dispatch replay service.
 *
 * @param {Object} deps - Service dependencies
 * @param {Object} deps.dispatchLog - DispatchLog instance
 * @param {Object} deps.timelineStore - TimelineStore instance
 * @param {Function} deps.handleUserMessage - The dispatch system's handleUserMessage function
 * @returns {{ replayDispatch: Function, reconstructDispatchState: Function }}
 */
export function createDispatchReplayService(deps) {
  const { dispatchLog, timelineStore, handleUserMessage } = deps;

  if (!dispatchLog) throw new TypeError('dispatchLog is required');
  if (!timelineStore) throw new TypeError('timelineStore is required');
  if (!handleUserMessage) throw new TypeError('handleUserMessage is required');

  /**
   * Replay a dispatch by its ID.
   *
   * 1. Reconstructs original dispatch state from dispatch-log + timeline-store
   * 2. Generates a new dispatch_id linked to the original via steer metadata
   * 3. Re-executes the dispatch through handleUserMessage with replay context
   * 4. Logs an operator_action event to the timeline for auditability
   *
   * @param {string} dispatchId - Original dispatch ID to replay
   * @param {ReplayOptions} [options={}]
   * @returns {Promise<ReplayResult>}
   */
  async function replayDispatch(dispatchId, options = {}) {
    const {
      operatorId = 'system',
      targetAgent = null,
      targetProvider = null,
      projectId,
      channelId,
    } = options;

    if (!dispatchId) {
      return {
        success: false,
        replayDispatchId: null,
        originalDispatchId: dispatchId,
        operatorId,
        message: null,
        reconstructedState: null,
        error: 'dispatchId is required',
      };
    }

    // Step 1: Reconstruct state
    const state = reconstructDispatchState(dispatchId, { dispatchLog, timelineStore });
    if (!state) {
      return {
        success: false,
        replayDispatchId: null,
        originalDispatchId: dispatchId,
        operatorId,
        message: null,
        reconstructedState: null,
        error: `Dispatch not found: ${dispatchId}`,
      };
    }

    if (!state.message) {
      return {
        success: false,
        replayDispatchId: null,
        originalDispatchId: dispatchId,
        operatorId,
        message: null,
        reconstructedState: state,
        error: 'Original dispatch has no message to replay',
      };
    }

    // routingPlan is legitimately nullable and this code dereferenced it.
    //
    // reconstructDispatchState sets `routingPlan = record ? {...} : null` and
    // only fills it from the timeline when a 'dispatch'-type event exists. It
    // uses routingPlan?.primary internally, so the author knew — but this
    // service then read state.routingPlan.mode with no guard (the wsThreadMeta
    // build below), which is a TypeError whenever the dispatch-log record has
    // rotated out while timeline events survive.
    //
    // Failing explicitly rather than defaulting to 'solo': a pair dispatch
    // replayed as solo would silently drop the reviewer, and a replay whose
    // whole point is faithfulness must not quietly change the routing mode.
    if (!state.routingPlan || !state.routingPlan.mode) {
      return {
        success: false,
        replayDispatchId: null,
        originalDispatchId: dispatchId,
        operatorId,
        message: state.message,
        reconstructedState: state,
        error: 'Cannot reconstruct routing plan for this dispatch (record may have rotated out of the dispatch log)',
      };
    }

    const resolvedProjectId = projectId || 'default';
    const resolvedChannelId = channelId || 'general';
    const replayDispatchId = `replay-${randomUUID()}`;

    // Step 2: Log operator action (pre-dispatch, status=initiated)
    try {
      timelineStore.appendOperatorActionEvent({
        actionType: 'replay',
        operatorId,
        sourceDispatchId: dispatchId,
        targetDispatchId: replayDispatchId,
        campaignId: state.campaignId,
        dispatchId: replayDispatchId,
        status: 'initiated',
        targetParams: {
          targetAgent: targetAgent || state.selectedAgent,
          targetProvider: targetProvider || null,
          originalOutcome: state.outcome,
          originalAgent: state.selectedAgent,
        },
        data: {
          originalDispatchId: dispatchId,
          reconstructedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      log.warn('Failed to log replay operator action', {
        dispatchId,
        replayDispatchId,
        error: err.message,
      });
    }

    // Step 3: Build steer metadata so handleUserMessage routes correctly
    // and the new dispatch record links back to the original
    const steerMeta = {
      parentDispatchId: dispatchId,
      operatorId,
      targetAgent: targetAgent || state.selectedAgent,
      targetProvider: targetProvider || null,
    };

    const wsThreadMeta = {
      steer: steerMeta,
      mode: state.routingPlan.mode,
    };

    // Step 4: Re-dispatch through the standard pipeline
    let dispatchError = null;
    try {
      await handleUserMessage(
        state.message,
        resolvedProjectId,
        resolvedChannelId,
        wsThreadMeta,
        'Operator',  // speaker
        operatorId,  // userId
      );
    } catch (err) {
      dispatchError = err.message;
      log.error('Replay dispatch failed', {
        dispatchId,
        replayDispatchId,
        error: err.message,
      });
    }

    // Step 5: Log completion operator action
    const replaySuccess = !dispatchError;
    try {
      timelineStore.appendOperatorActionEvent({
        actionType: 'replay',
        operatorId,
        sourceDispatchId: dispatchId,
        targetDispatchId: replayDispatchId,
        campaignId: state.campaignId,
        dispatchId: replayDispatchId,
        status: replaySuccess ? 'completed' : 'failed',
        targetParams: {
          targetAgent: targetAgent || state.selectedAgent,
          targetProvider: targetProvider || null,
          error: dispatchError,
        },
        data: {
          originalDispatchId: dispatchId,
          completedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      log.warn('Failed to log replay completion', {
        dispatchId,
        replayDispatchId,
        error: err.message,
      });
    }

    return {
      success: replaySuccess,
      replayDispatchId,
      originalDispatchId: dispatchId,
      operatorId,
      message: state.message,
      reconstructedState: state,
      error: dispatchError,
    };
  }

  /**
   * Get the replay chain for a dispatch (all replays linked to it).
   *
   * @param {string} dispatchId - Dispatch ID to trace
   * @returns {{ chain: Object[], rootDispatchId: string }}
   */
  function getReplayChain(dispatchId) {
    if (!dispatchId) return { chain: [], rootDispatchId: null };

    // Query operator_action events linked to this dispatch as source
    const { events } = timelineStore.query({
      type: ['operator_action'],
      limit: 100,
    });

    // Filter to replay actions related to this dispatch
    const replayEvents = events.filter(e => {
      const row = e.row || {};
      return (
        row.action_type === 'replay' &&
        (row.source_dispatch_id === dispatchId || row.target_dispatch_id === dispatchId)
      );
    });

    // Build chain by following source -> target links
    const chain = replayEvents.map(e => {
      const row = e.row || {};
      const params = row.target_params ? JSON.parse(row.target_params) : {};
      return {
        sourceDispatchId: row.source_dispatch_id,
        targetDispatchId: row.target_dispatch_id,
        operatorId: row.operator_id,
        status: row.status,
        timestamp: e.event_ts,
        targetAgent: params.targetAgent || null,
      };
    });

    // Find root by tracing source_dispatch_id chain
    let rootDispatchId = dispatchId;
    const visited = new Set();
    while (!visited.has(rootDispatchId)) {
      visited.add(rootDispatchId);
      const parent = chain.find(c => c.targetDispatchId === rootDispatchId);
      if (parent) {
        rootDispatchId = parent.sourceDispatchId;
      } else {
        break;
      }
    }

    return { chain, rootDispatchId };
  }

  return {
    replayDispatch,
    getReplayChain,
    reconstructDispatchState: (id) => reconstructDispatchState(id, { dispatchLog, timelineStore }),
  };
}

export default createDispatchReplayService;
