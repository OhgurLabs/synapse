import { createLogger } from '../logger.js';
import { EVENT_TYPES } from './timeline-schema.js';

const DEFAULT_LOGGER = createLogger('event-ingestion-service');

function createEmptyStats() {
  return {
    [EVENT_TYPES.TOOL_INVOCATION_START]: { success: 0, failure: 0 },
    [EVENT_TYPES.TOOL_INVOCATION_SUCCESS]: { success: 0, failure: 0 },
    [EVENT_TYPES.TOOL_INVOCATION_ERROR]: { success: 0, failure: 0 },
  };
}

async function maybeAwait(value) {
  if (value && typeof value.then === 'function') {
    await value;
  }
}

export class EventIngestionService {
  constructor(options = {}) {
    const {
      events,
      timelineStore,
      sqliteTimelineStore = null,
      logger = DEFAULT_LOGGER,
    } = options;

    if (!events || typeof events.on !== 'function') {
      throw new TypeError('events with an on() method is required');
    }
    if (!timelineStore) {
      throw new TypeError('timelineStore is required');
    }

    this.events = events;
    this.timelineStore = timelineStore;
    this.sqliteTimelineStore = sqliteTimelineStore;
    this.log = logger;
    this._unsubscribe = null;
    this._stats = createEmptyStats();
  }

  start() {
    if (this._unsubscribe) {
      return this._unsubscribe;
    }

    const unsubscribers = [];
    unsubscribers.push(
      this.events.on(EVENT_TYPES.TOOL_INVOCATION_START, (payload) => this._ingestToolInvocation({
        eventType: EVENT_TYPES.TOOL_INVOCATION_START,
        payload,
        timelineMethod: 'ingestToolInvocationStart',
        sqliteMethod: 'appendToolInvocationStart',
      })),
    );
    unsubscribers.push(
      this.events.on(EVENT_TYPES.TOOL_INVOCATION_SUCCESS, (payload) => this._ingestToolInvocation({
        eventType: EVENT_TYPES.TOOL_INVOCATION_SUCCESS,
        payload,
        timelineMethod: 'ingestToolInvocationSuccess',
        sqliteMethod: 'appendToolInvocationSuccess',
      })),
    );
    unsubscribers.push(
      this.events.on(EVENT_TYPES.TOOL_INVOCATION_ERROR, (payload) => this._ingestToolInvocation({
        eventType: EVENT_TYPES.TOOL_INVOCATION_ERROR,
        payload,
        timelineMethod: 'ingestToolInvocationError',
        sqliteMethod: 'appendToolInvocationError',
      })),
    );

    this._unsubscribe = () => {
      for (const unsubscribe of unsubscribers) {
        if (typeof unsubscribe === 'function') {
          unsubscribe();
        }
      }
      this._unsubscribe = null;
    };

    this.log.info('Event ingestion service started', {
      bindings: [
        EVENT_TYPES.TOOL_INVOCATION_START,
        EVENT_TYPES.TOOL_INVOCATION_SUCCESS,
        EVENT_TYPES.TOOL_INVOCATION_ERROR,
      ],
    });

    return this._unsubscribe;
  }

  stop() {
    if (this._unsubscribe) {
      this._unsubscribe();
    }
  }

  stats() {
    return {
      started: Boolean(this._unsubscribe),
      events: {
        [EVENT_TYPES.TOOL_INVOCATION_START]: { ...this._stats[EVENT_TYPES.TOOL_INVOCATION_START] },
        [EVENT_TYPES.TOOL_INVOCATION_SUCCESS]: { ...this._stats[EVENT_TYPES.TOOL_INVOCATION_SUCCESS] },
        [EVENT_TYPES.TOOL_INVOCATION_ERROR]: { ...this._stats[EVENT_TYPES.TOOL_INVOCATION_ERROR] },
      },
    };
  }

  async _ingestToolInvocation({ eventType, payload, timelineMethod, sqliteMethod }) {
    try {
      const inMemoryStore = this.timelineStore?.[timelineMethod];
      if (typeof inMemoryStore !== 'function') {
        throw new TypeError(`timelineStore.${timelineMethod} is not available`);
      }
      await maybeAwait(inMemoryStore.call(this.timelineStore, payload));

      const persistentStore = this.sqliteTimelineStore?.[sqliteMethod];
      if (typeof persistentStore === 'function') {
        await maybeAwait(persistentStore.call(this.sqliteTimelineStore, payload));
      }

      this._stats[eventType].success += 1;
    } catch (error) {
      this._stats[eventType].failure += 1;
      this.log.error('Failed to ingest tool invocation event', {
        eventType,
        error: error.message,
        eventId: payload?.id ?? null,
        toolName: payload?.toolName ?? payload?.data?.toolName ?? null,
        taskId: payload?.taskId ?? payload?.correlationKeys?.taskId ?? null,
        dispatchId: payload?.dispatchId ?? payload?.correlationKeys?.dispatchId ?? null,
      });
    }
  }
}

export default EventIngestionService;
