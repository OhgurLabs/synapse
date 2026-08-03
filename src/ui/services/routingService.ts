// src/ui/services/routingService.ts

import {
  DispatchLogResponse,
  RoutingWeightsResponse,
  ApiError,
  ServiceError,
  ServiceErrorKind,
  AsyncState,
} from '../types/routing';

const API_BASE_URL = '/api';

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a caught error into a typed ServiceError.
 * Follows the error-handling discipline from routing-analytics.js (network vs
 * HTTP status vs abort) but adds parse and unknown buckets.
 */
export function classifyError(error: unknown): ServiceError {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { kind: 'abort', message: 'Request was aborted' };
  }
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return { kind: 'network', message: error.message };
  }
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const apiErr = error as ApiError;
    return { kind: 'api', message: apiErr.message, statusCode: apiErr.statusCode };
  }
  if (error instanceof SyntaxError) {
    return { kind: 'parse', message: 'Invalid JSON in response' };
  }
  const msg = error instanceof Error ? error.message : String(error);
  return { kind: 'unknown', message: msg };
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

async function handleApiResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `API error: ${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.message) message = body.message;
      if (body?.error) message = body.error;
    } catch { /* fall back to status text */ }
    const err: ApiError = { message, statusCode: response.status };
    throw err;
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Fetch parameter interfaces
// ---------------------------------------------------------------------------

export interface FetchDecisionLogParams {
  limit?: number;
  offset?: number;
  campaignId?: string;
  category?: string;
  agentId?: string;
  since?: string; // ISO 8601 timestamp
  signal?: AbortSignal;
}

export interface FetchRoutingWeightsParams {
  category?: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Raw fetch functions (stateless, throw on failure)
// ---------------------------------------------------------------------------

export async function fetchDecisionLog(
  params: FetchDecisionLogParams = {},
): Promise<DispatchLogResponse> {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.append('limit', String(params.limit));
  if (params.offset !== undefined) query.append('offset', String(params.offset));
  if (params.campaignId) query.append('campaignId', params.campaignId);
  if (params.category) query.append('category', params.category);
  if (params.agentId) query.append('agentId', params.agentId);
  if (params.since) query.append('since', params.since);

  const url = `${API_BASE_URL}/dispatch-log?${query.toString()}`;
  const response = await fetch(url, { signal: params.signal });
  return handleApiResponse<DispatchLogResponse>(response);
}

export async function fetchRoutingWeights(
  params: FetchRoutingWeightsParams = {},
): Promise<RoutingWeightsResponse> {
  const query = new URLSearchParams();
  if (params.category) query.append('category', params.category);

  const url = `${API_BASE_URL}/routing-weights?${query.toString()}`;
  const response = await fetch(url, { signal: params.signal });
  return handleApiResponse<RoutingWeightsResponse>(response);
}

// ---------------------------------------------------------------------------
// Stateful loader — mirrors routing-analytics.js loading/error/data pattern
// ---------------------------------------------------------------------------

type Listener<T> = (state: AsyncState<T>) => void;

/**
 * Manages async fetch lifecycle for a single resource: tracks loading,
 * success, and error states, deduplicates in-flight requests, and notifies
 * subscribers on state changes.  Modelled after the `loading` / `lastFetchTime`
 * / render() cycle in routing-analytics.js.
 */
export class AsyncLoader<T> {
  private _state: AsyncState<T> = { status: 'idle' };
  private _listeners: Set<Listener<T>> = new Set();
  private _abortController: AbortController | null = null;

  get state(): AsyncState<T> { return this._state; }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(fn: Listener<T>): () => void {
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  private _emit(): void {
    for (const fn of this._listeners) fn(this._state);
  }

  /**
   * Execute a fetch, managing loading/success/error transitions.
   * If a request is already in flight it is aborted before starting a new one
   * (same pattern as routing-analytics.js calling refresh() while loading).
   */
  async load(fetcher: (signal: AbortSignal) => Promise<T>): Promise<void> {
    // Abort any in-flight request
    if (this._abortController) {
      this._abortController.abort();
    }
    this._abortController = new AbortController();
    const { signal } = this._abortController;

    this._state = { status: 'loading' };
    this._emit();

    try {
      const data = await fetcher(signal);
      // Guard against stale responses after abort
      if (signal.aborted) return;
      this._state = { status: 'success', data, fetchedAt: Date.now() };
      this._emit();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this._state = { status: 'error', error: classifyError(err), failedAt: Date.now() };
      this._emit();
    } finally {
      if (this._abortController?.signal === signal) {
        this._abortController = null;
      }
    }
  }

  /** Reset to idle and abort any in-flight request. */
  reset(): void {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    this._state = { status: 'idle' };
    this._emit();
  }
}

// ---------------------------------------------------------------------------
// Pre-built loaders for the two routing endpoints
// ---------------------------------------------------------------------------

export const decisionLogLoader = new AsyncLoader<DispatchLogResponse>();
export const routingWeightsLoader = new AsyncLoader<RoutingWeightsResponse>();

/**
 * Convenience: load decision log through the shared loader.
 */
export function loadDecisionLog(params: FetchDecisionLogParams = {}): Promise<void> {
  return decisionLogLoader.load((signal) =>
    fetchDecisionLog({ ...params, signal }),
  );
}

/**
 * Convenience: load routing weights through the shared loader.
 */
export function loadRoutingWeights(params: FetchRoutingWeightsParams = {}): Promise<void> {
  return routingWeightsLoader.load((signal) =>
    fetchRoutingWeights({ ...params, signal }),
  );
}
