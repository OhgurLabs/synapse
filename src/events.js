// Lightweight event bus for Synapse plugins
// Plugins subscribe to events and can modify data in 'before' hooks
import { createLogger } from './logger.js';

const log = createLogger('events');

export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  // Subscribe to an event. Returns unsubscribe function.
  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  }

  // Emit an event. Handlers run in order. Returns the (possibly modified) data.
  // 'before' events can modify data by returning a new value.
  // If any handler returns { cancel: true }, the event chain stops.
  async emit(event, data = {}) {
    const handlers = this._handlers.get(event);
    if (!handlers || handlers.length === 0) return data;

    let result = data;
    for (const handler of handlers) {
      try {
        const ret = await handler(result);
        if (ret === undefined || ret === null) continue;
        if (ret.cancel) return { ...result, _cancelled: true };
        result = ret;
      } catch (err) {
        log.error(`Plugin error on "${event}"`, { error: err.message });
      }
    }
    return result;
  }

  // List registered events (for debugging)
  events() {
    return [...this._handlers.keys()].filter(k => (this._handlers.get(k)?.length || 0) > 0);
  }
}
