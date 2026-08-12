/**
 * PubSubChannelService — protocol contract (documentation-only; implementation follows below)
 *
 * Purpose
 * - Provide a durable, auditable pub/sub channel system for agent-to-agent coordination
 * - Prevent duplicate work by allowing agents to publish/subscribe to work queues
 * - Track message acknowledgments to ensure work items are processed exactly once
 * - Persist all state in SharedStateStore for dashboard and health check visibility
 *
 * Channel Lifecycle
 *   createChannel() -> Channel created with metadata
 *   publish() -> Message added to channel
 *   subscribe() -> Get unacknowledged messages for subscriber
 *   acknowledge() -> Mark message as processed by subscriber
 *   listChannels() -> Get all active channels
 *   getUnacknowledgedCount() -> Count unacknowledged messages per channel
 *
 * Persistence layout (all JSON strings in SharedStateStore)
 *   Channel Metadata key: `channel:{name}:metadata`
 *   {
 *     channelName: string,
 *     createdAt: string,              // ISO-8601
 *     createdBy: string,               // Agent ID that created the channel
 *     description: string,             // Purpose of the channel
 *     subscribers: string[],           // List of agent IDs subscribed
 *     messageCount: number,            // Total messages published
 *     lastPublishedAt: string | null   // Last message timestamp
 *   }
 *
 *   Message Acknowledgment key: `channel:{name}:ack:{messageId}:{subscriberId}`
 *   {
 *     messageId: string,               // Message sequence number
 *     subscriberId: string,            // Agent that acknowledged
 *     acknowledgedAt: string,          // ISO-8601
 *     channelName: string
 *   }
 *
 * Response shapes
 * - createChannel  -> { channelName, createdAt, subscribers, messageCount }
 * - publish        -> { channelName, messageId, sequence, publishedAt }
 * - subscribe      -> { channelName, messages: Array<{id, senderId, payload, sequence, createdAt}> }
 * - acknowledge    -> { channelName, messageId, subscriberId, acknowledgedAt }
 * - listChannels   -> Array<{ channelName, messageCount, subscribers, lastPublishedAt }>
 * - getUnacknowledgedCount -> { channelName, unacknowledgedCount }
 *
 * Audit + Trace hooks
 * - Each operation emits audit events for tracking pub/sub activity
 * - Compatible with distributed tracing when traceId/spanId provided
 *
 * Concurrency + idempotency
 * - SharedStateStore versions guard against lost updates
 * - Multiple subscribers can read the same message; each tracks their own acknowledgment
 * - Acknowledging a message twice is idempotent
 *
 * Operator visibility
 * - Health endpoints can read channel stats and unacknowledged counts
 * - Dashboard can show active channels, message flow, and subscriber activity
 */

import { randomUUID } from 'crypto';
import { VersionConflictError } from './shared-state-store.js';

class ChannelNotFoundError extends Error {
  constructor(channelName) {
    super(`Channel "${channelName}" not found`);
    this.name = 'ChannelNotFoundError';
    this.channelName = channelName;
  }
}

class MessageNotFoundError extends Error {
  constructor(channelName, messageId) {
    super(`Message "${messageId}" not found in channel "${channelName}"`);
    this.name = 'MessageNotFoundError';
    this.channelName = channelName;
    this.messageId = messageId;
  }
}

class ChannelAlreadyExistsError extends Error {
  constructor(channelName) {
    super(`Channel "${channelName}" already exists`);
    this.name = 'ChannelAlreadyExistsError';
    this.channelName = channelName;
  }
}

/**
 * PubSubChannelService - Manages pub/sub channels for agent coordination
 *
 * @class
 */
class PubSubChannelService {
  /**
   * Create a PubSubChannelService
   *
   * @param {Object} options
   * @param {import('./shared-state-store.js').SharedStateStore} options.sharedStateStore - SharedStateStore instance for persistence
   * @param {import('./audit-logger.js').AuditLogger} [options.auditLogger] - Optional audit logger for pub/sub events
   * @param {import('./trace-store.js').TraceStore} [options.traceStore] - Optional trace store for distributed tracing
   */
  constructor(options = {}) {
    if (!options.sharedStateStore) {
      throw new TypeError('sharedStateStore is required');
    }

    this.sharedStateStore = options.sharedStateStore;
    this.auditLogger = options.auditLogger || null;
    this.traceStore = options.traceStore || null;
  }

  /** Parse both current object values and legacy double-serialized metadata. */
  _parseChannelMetadata(value) {
    let metadata = value;
    for (let i = 0; i < 2 && typeof metadata === 'string'; i++) {
      metadata = JSON.parse(metadata);
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new TypeError('Invalid channel metadata');
    }
    return metadata;
  }

  /** Compare-and-swap a channel metadata record, retrying concurrent writers. */
  _updateChannelMetadata(channelName, agentId, mutator) {
    const metadataKey = `channel:${channelName}:metadata`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = this.sharedStateStore.get(metadataKey);
      if (!entry) throw new ChannelNotFoundError(channelName);
      const current = this._parseChannelMetadata(entry.value);
      const next = mutator({ ...current, subscribers: [...(current.subscribers || [])] });
      try {
        this.sharedStateStore.set(metadataKey, next, agentId, { expectedVersion: entry.version });
        return next;
      } catch (err) {
        if (!(err instanceof VersionConflictError) || attempt === 4) throw err;
      }
    }
    throw new Error(`Unable to update channel "${channelName}"`);
  }

  /**
   * Create a new pub/sub channel
   *
   * @param {Object} channelConfig
   * @param {string} channelConfig.channelName - Unique channel name
   * @param {string} channelConfig.createdBy - Agent ID creating the channel
   * @param {string} [channelConfig.description] - Purpose of the channel
   * @param {string[]} [channelConfig.subscribers] - Initial subscriber list
   * @param {string} [channelConfig.traceId] - Distributed trace correlation ID
   * @param {string} [channelConfig.spanId] - Current span ID
   * @returns {Promise<Object>} { channelName, createdAt, subscribers, messageCount }
   * @public
   */
  async createChannel(channelConfig) {
    const {
      channelName,
      createdBy,
      description = '',
      subscribers = [],
      traceId = null,
      spanId = null
    } = channelConfig;

    if (!channelName) {
      throw new TypeError('channelName is required');
    }

    if (!createdBy) {
      throw new TypeError('createdBy is required');
    }

    // Check if channel already exists
    const metadataKey = `channel:${channelName}:metadata`;
    const existing = this.sharedStateStore.get(metadataKey);
    if (existing) {
      throw new ChannelAlreadyExistsError(channelName);
    }

    const now = new Date().toISOString();

    const channelMetadata = {
      channelName,
      createdAt: now,
      createdBy,
      description,
      subscribers: [...subscribers],
      messageCount: 0,
      lastPublishedAt: null
    };

    // Store channel metadata
    this.sharedStateStore.set(
      metadataKey,
      channelMetadata,
      createdBy
    );

    // Create trace span if trace store is available
    let channelSpanId = spanId;
    if (this.traceStore && traceId) {
      const span = this.traceStore.startSpan(
        traceId,
        spanId,
        createdBy,
        'channel.create',
        {
          channelName,
          subscriberCount: subscribers.length
        },
        null,
        channelName
      );
      channelSpanId = span.spanId;

      this.traceStore.endSpan(span.spanId, 'success', {
        channelName,
        subscriberCount: subscribers.length
      });
    }

    // Log audit event
    if (this.auditLogger) {
      await this.auditLogger.logAction({
        traceId,
        agentId: createdBy,
        actionType: 'channel',
        timestamp: now,
        outcome: 'success',
        inputSummary: `create channel ${channelName}`,
        outputSummary: `channel created with ${subscribers.length} subscribers`,
        contextMetadata: {
          channelName,
          createdBy,
          subscriberCount: subscribers.length,
          traceId,
          spanId: channelSpanId
        }
      });
    }

    return {
      channelName,
      createdAt: now,
      subscribers: [...subscribers],
      messageCount: 0
    };
  }

  /**
   * Publish a message to a channel
   *
   * @param {Object} publishConfig
   * @param {string} publishConfig.channelName - Channel to publish to
   * @param {string} publishConfig.senderId - Agent publishing the message
   * @param {Object} publishConfig.payload - Message payload
   * @param {string} [publishConfig.traceId] - Distributed trace correlation ID
   * @param {string} [publishConfig.spanId] - Current span ID
   * @returns {Promise<Object>} { channelName, messageId, sequence, publishedAt }
   * @public
   */
  async publish(publishConfig) {
    const {
      channelName,
      senderId,
      payload,
      traceId = null,
      spanId = null
    } = publishConfig;

    if (!channelName) {
      throw new TypeError('channelName is required');
    }

    if (!senderId) {
      throw new TypeError('senderId is required');
    }

    // Get channel metadata to verify it exists
    const metadataKey = `channel:${channelName}:metadata`;
    const metadataData = this.sharedStateStore.get(metadataKey);

    if (!metadataData) {
      throw new ChannelNotFoundError(channelName);
    }

    const now = new Date().toISOString();

    const sequence = this.sharedStateStore.publishToChannel(channelName, senderId, payload);
    this._updateChannelMetadata(channelName, senderId, metadata => ({
      ...metadata,
      messageCount: (metadata.messageCount || 0) + 1,
      lastPublishedAt: now,
    }));

    const messageId = `${sequence}`;

    // Create trace span if trace store is available
    let publishSpanId = spanId;
    if (this.traceStore && traceId) {
      const span = this.traceStore.startSpan(
        traceId,
        spanId,
        senderId,
        'channel.publish',
        {
          channelName,
          messageId,
          sequence
        },
        null,
        channelName
      );
      publishSpanId = span.spanId;

      this.traceStore.endSpan(span.spanId, 'success', {
        channelName,
        messageId,
        sequence
      });
    }

    // Log audit event
    if (this.auditLogger) {
      await this.auditLogger.logAction({
        traceId,
        agentId: senderId,
        actionType: 'channel',
        timestamp: now,
        outcome: 'success',
        inputSummary: `publish to channel ${channelName}`,
        outputSummary: `message ${messageId} published (sequence ${sequence})`,
        contextMetadata: {
          channelName,
          senderId,
          messageId,
          sequence,
          traceId,
          spanId: publishSpanId
        }
      });
    }

    return {
      channelName,
      messageId,
      sequence,
      publishedAt: now
    };
  }

  /**
   * Subscribe to a channel and get new messages
   *
   * @param {Object} subscribeConfig
   * @param {string} subscribeConfig.channelName - Channel to subscribe to
   * @param {string} subscribeConfig.subscriberId - Agent subscribing
   * @param {string} [subscribeConfig.traceId] - Distributed trace correlation ID
   * @param {string} [subscribeConfig.spanId] - Current span ID
   * @returns {Promise<Object>} { channelName, messages: Array }
   * @public
   */
  async subscribe(subscribeConfig) {
    const {
      channelName,
      subscriberId,
      traceId = null,
      spanId = null
    } = subscribeConfig;

    if (!channelName) {
      throw new TypeError('channelName is required');
    }

    if (!subscriberId) {
      throw new TypeError('subscriberId is required');
    }

    // Verify channel exists
    const metadataKey = `channel:${channelName}:metadata`;
    const metadataData = this.sharedStateStore.get(metadataKey);

    if (!metadataData) {
      throw new ChannelNotFoundError(channelName);
    }

    // Use SharedStateStore's pollChannel to get ALL messages from the beginning (afterSeq = 0)
    // We'll filter based on acknowledgments, not position tracking
    const messages = this.sharedStateStore.pollChannel(channelName, 0);

    // Filter out acknowledged messages
    const unacknowledgedMessages = [];
    for (const msg of messages) {
      const ackKey = `channel:${channelName}:ack:${msg.sequence}:${subscriberId}`;
      const ackData = this.sharedStateStore.get(ackKey);

      if (!ackData) {
        unacknowledgedMessages.push(msg);
      }
    }

    // Create trace span if trace store is available
    let subscribeSpanId = spanId;
    if (this.traceStore && traceId) {
      const span = this.traceStore.startSpan(
        traceId,
        spanId,
        subscriberId,
        'channel.subscribe',
        {
          channelName,
          subscriberId,
          messageCount: unacknowledgedMessages.length
        },
        null,
        channelName
      );
      subscribeSpanId = span.spanId;

      this.traceStore.endSpan(span.spanId, 'success', {
        channelName,
        messageCount: unacknowledgedMessages.length
      });
    }

    // Log audit event
    if (this.auditLogger) {
      const now = new Date().toISOString();
      await this.auditLogger.logAction({
        traceId,
        agentId: subscriberId,
        actionType: 'channel',
        timestamp: now,
        outcome: 'success',
        inputSummary: `subscribe to channel ${channelName}`,
        outputSummary: `received ${unacknowledgedMessages.length} unacknowledged messages`,
        contextMetadata: {
          channelName,
          subscriberId,
          messageCount: unacknowledgedMessages.length,
          traceId,
          spanId: subscribeSpanId
        }
      });
    }

    return {
      channelName,
      messages: unacknowledgedMessages
    };
  }

  /**
   * Acknowledge a message (mark as processed)
   *
   * @param {Object} ackConfig
   * @param {string} ackConfig.channelName - Channel containing the message
   * @param {string} ackConfig.messageId - Message ID (sequence number as string)
   * @param {string} ackConfig.subscriberId - Agent acknowledging the message
   * @param {string} [ackConfig.traceId] - Distributed trace correlation ID
   * @param {string} [ackConfig.spanId] - Current span ID
   * @returns {Promise<Object>} { channelName, messageId, subscriberId, acknowledgedAt }
   * @public
   */
  async acknowledge(ackConfig) {
    const {
      channelName,
      messageId,
      subscriberId,
      traceId = null,
      spanId = null
    } = ackConfig;

    if (!channelName) {
      throw new TypeError('channelName is required');
    }

    if (!messageId) {
      throw new TypeError('messageId is required');
    }

    if (!subscriberId) {
      throw new TypeError('subscriberId is required');
    }

    // Verify channel exists
    const metadataKey = `channel:${channelName}:metadata`;
    const metadataData = this.sharedStateStore.get(metadataKey);

    if (!metadataData) {
      throw new ChannelNotFoundError(channelName);
    }

    const now = new Date().toISOString();

    // Store acknowledgment (idempotent - same subscriberId can ack multiple times)
    const ackKey = `channel:${channelName}:ack:${messageId}:${subscriberId}`;
    const existingAck = this.sharedStateStore.get(ackKey);

    const ackRecord = {
      messageId,
      subscriberId,
      acknowledgedAt: existingAck ? existingAck.value.acknowledgedAt : now,
      channelName
    };

    if (!existingAck) {
      try {
        this.sharedStateStore.set(
          ackKey,
          ackRecord,
          subscriberId
        );
      } catch (err) {
        // Another process can win the create between get() and set(). Treat a
        // now-present acknowledgement as the same idempotent success.
        const racedAck = this.sharedStateStore.get(ackKey);
        const isConstraint = err.code === 'SQLITE_CONSTRAINT'
          || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
          || err.code === 'SQLITE_CONSTRAINT_UNIQUE';
        if (!isConstraint || !racedAck) throw err;
        ackRecord.acknowledgedAt = racedAck.value.acknowledgedAt;
      }
    }

    // Create trace span if trace store is available
    let ackSpanId = spanId;
    if (this.traceStore && traceId) {
      const span = this.traceStore.startSpan(
        traceId,
        spanId,
        subscriberId,
        'channel.acknowledge',
        {
          channelName,
          messageId,
          subscriberId
        },
        null,
        channelName
      );
      ackSpanId = span.spanId;

      this.traceStore.endSpan(span.spanId, 'success', {
        channelName,
        messageId
      });
    }

    // Log audit event
    if (this.auditLogger) {
      await this.auditLogger.logAction({
        traceId,
        agentId: subscriberId,
        actionType: 'channel',
        timestamp: now,
        outcome: 'success',
        inputSummary: `acknowledge message ${messageId} in channel ${channelName}`,
        outputSummary: `message acknowledged by ${subscriberId}`,
        contextMetadata: {
          channelName,
          messageId,
          subscriberId,
          traceId,
          spanId: ackSpanId
        }
      });
    }

    return {
      channelName,
      messageId,
      subscriberId,
      acknowledgedAt: ackRecord.acknowledgedAt
    };
  }

  /**
   * List all active channels
   *
   * @returns {Array} Array of channel metadata objects
   * @public
   */
  listChannels() {
     const allKeys = this.sharedStateStore.listKeys();
     const metadataKeys = allKeys.filter(key => key.startsWith('channel:') && key.endsWith(':metadata'));

     const channels = [];

     for (const key of metadataKeys) {
       const metadataData = this.sharedStateStore.get(key);

       if (!metadataData) {
         continue;
       }

       try {
         const metadata = this._parseChannelMetadata(metadataData.value);
         const channelName = metadata.channelName;
         
         const messages = this.sharedStateStore.pollChannel(channelName, 0);
         const now = new Date();
         const oneMinuteAgo = new Date(now.getTime() - 60000).toISOString();
         const messagesInLastMinute = messages.filter(m => m.createdAt >= oneMinuteAgo).length;

         channels.push({
           channelName: metadata.channelName,
           createdAt: metadata.createdAt,
           createdBy: metadata.createdBy,
           description: metadata.description,
           subscribers: metadata.subscribers,
           messageCount: metadata.messageCount,
           lastPublishedAt: metadata.lastPublishedAt,
           messageFlowRate: messagesInLastMinute
         });
       } catch (error) {
         continue;
       }
     }

     return channels;
   }

  /**
   * Get count of unacknowledged messages for a channel and subscriber
   *
   * @param {Object} countConfig
   * @param {string} countConfig.channelName - Channel to check
   * @param {string} countConfig.subscriberId - Subscriber to check
   * @returns {Object} { channelName, subscriberId, unacknowledgedCount }
   * @public
   */
  getUnacknowledgedCount(countConfig) {
    const { channelName, subscriberId } = countConfig;

    if (!channelName) {
      throw new TypeError('channelName is required');
    }

    if (!subscriberId) {
      throw new TypeError('subscriberId is required');
    }

    // Verify channel exists
    const metadataKey = `channel:${channelName}:metadata`;
    const metadataData = this.sharedStateStore.get(metadataKey);

    if (!metadataData) {
      throw new ChannelNotFoundError(channelName);
    }

    // Get all messages from the beginning
    const messages = this.sharedStateStore.pollChannel(channelName, 0);

    // Count unacknowledged messages
    let unacknowledgedCount = 0;
    for (const msg of messages) {
      const ackKey = `channel:${channelName}:ack:${msg.sequence}:${subscriberId}`;
      const ackData = this.sharedStateStore.get(ackKey);

      if (!ackData) {
        unacknowledgedCount++;
      }
    }

    return {
      channelName,
      subscriberId,
      unacknowledgedCount
    };
  }

  /**
   * Get the N most recent messages from a channel.
   *
   * @param {Object} config
   * @param {string} config.channelName - The channel name
   * @param {number} [config.limit=10] - The maximum number of recent messages to retrieve
   * @returns {Promise<Array<{id, channel, senderId, payload, sequence, createdAt}>>} Array of messages
   * @public
   */
  async getRecentMessages(config) {
    const { channelName, limit = 10 } = config;

    if (!channelName) {
      throw new TypeError('channelName is required');
    }

    // Verify channel exists
    const metadataKey = `channel:${channelName}:metadata`;
    const metadataData = this.sharedStateStore.get(metadataKey);

    if (!metadataData) {
      throw new ChannelNotFoundError(channelName);
    }

    return this.sharedStateStore.getRecentChannelMessages(channelName, limit);
  }

  /**
   * Get the count of messages in a channel since a given timestamp
   *
   * @param {Object} config
   * @param {string} config.channelName - The channel name
   * @param {string} config.sinceISO - ISO timestamp to count from
   * @returns {number} Count of messages
   * @public
   */
  getMessageCountSince(config) {
    const { channelName, sinceISO } = config;

    if (!channelName) {
      throw new TypeError('channelName is required');
    }

    if (!sinceISO) {
      throw new TypeError('sinceISO is required');
    }

    // Verify channel exists
    const metadataKey = `channel:${channelName}:metadata`;
    const metadataData = this.sharedStateStore.get(metadataKey);

    if (!metadataData) {
      throw new ChannelNotFoundError(channelName);
    }

    return this.sharedStateStore.getMessageCountSince(channelName, sinceISO);
  }

  /**
   * Get a channel's metadata
   *
   * @param {string} channelName - The channel name
   * @returns {Object|null} Channel metadata or null if not found
   * @public
   */
  getChannel(channelName) {
    const metadataKey = `channel:${channelName}:metadata`;
    const metadataData = this.sharedStateStore.get(metadataKey);

    if (!metadataData) {
      return null;
    }

    try {
      const metadata = this._parseChannelMetadata(metadataData.value);
      return {
        channelName: metadata.channelName,
        createdAt: metadata.createdAt,
        createdBy: metadata.createdBy,
        description: metadata.description,
        subscribers: metadata.subscribers,
        messageCount: metadata.messageCount,
        lastPublishedAt: metadata.lastPublishedAt
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Add a subscriber to a channel
   *
   * @param {Object} config
   * @param {string} config.channelName - Channel to subscribe to
   * @param {string} config.subscriberId - Agent to add as subscriber
   * @param {string} [config.addedBy] - Agent adding the subscriber (defaults to subscriberId)
   * @returns {Promise<Object>} Updated channel metadata
   * @public
   */
 /**
   * Get detailed channel statistics for dashboard display
   *
   * @param {string} channelName - The channel name
   * @returns {Object|null} Channel statistics or null if not found
   * @public
   */
  getChannelStats(channelName) {
    const metadataKey = `channel:${channelName}:metadata`;
    const metadataData = this.sharedStateStore.get(metadataKey);

    if (!metadataData) {
      return null;
    }

    try {
      const metadata = this._parseChannelMetadata(metadataData.value);
      const messages = this.sharedStateStore.pollChannel(channelName, 0);

      const now = new Date();
      const oneMinuteAgo = new Date(now.getTime() - 60000).toISOString();
      const fiveMinutesAgo = new Date(now.getTime() - 300000).toISOString();
      const oneHourAgo = new Date(now.getTime() - 3600000).toISOString();

      const messagesInLastMinute = messages.filter(m => m.createdAt >= oneMinuteAgo).length;
      const messagesInLast5Minutes = messages.filter(m => m.createdAt >= fiveMinutesAgo).length;
      const messagesInLastHour = messages.filter(m => m.createdAt >= oneHourAgo).length;

      const uniqueSenders = new Set(messages.map(m => m.senderId));

      let recentMessages = [];
      if (messages.length > 0) {
        recentMessages = messages.slice(-5).map(msg => ({
          sequence: msg.sequence,
          senderId: msg.senderId,
          createdAt: msg.createdAt,
          payloadPreview: this._getPayloadPreview(msg.payload)
        }));
      }

      return {
        channelName: metadata.channelName,
        createdAt: metadata.createdAt,
        createdBy: metadata.createdBy,
        description: metadata.description,
        subscriberCount: metadata.subscribers.length,
        subscribers: metadata.subscribers,
        messageCount: metadata.messageCount,
        lastPublishedAt: metadata.lastPublishedAt,
        messageFlowRate: messagesInLastMinute,
        messagesInLast5Minutes: messagesInLast5Minutes,
        messagesInLastHour: messagesInLastHour,
        uniqueSenderCount: uniqueSenders.size,
        uniqueSenders: Array.from(uniqueSenders),
        recentMessages
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Get preview of message payload for dashboard display
   *
   * @param {Object} payload - Message payload
   * @returns {string} Preview string
   * @private
   */
  _getPayloadPreview(payload) {
    if (!payload) {
      return '';
    }

    if (typeof payload === 'string') {
      return payload.slice(0, 100);
    }

    try {
      const str = JSON.stringify(payload);
      return str.slice(0, 100);
    } catch (error) {
      return String(payload).slice(0, 100);
    }
  }

  async addSubscriber(config) {
    const {
      channelName,
      subscriberId,
      addedBy = subscriberId
    } = config;

    if (!channelName) {
      throw new TypeError('channelName is required');
    }

    if (!subscriberId) {
      throw new TypeError('subscriberId is required');
    }

    const metadataKey = `channel:${channelName}:metadata`;
    const metadataData = this.sharedStateStore.get(metadataKey);

    if (!metadataData) {
      throw new ChannelNotFoundError(channelName);
    }

    const metadata = this._updateChannelMetadata(channelName, addedBy, current => {
      if (!current.subscribers.includes(subscriberId)) current.subscribers.push(subscriberId);
      return current;
    });

    return {
      channelName: metadata.channelName,
      subscribers: metadata.subscribers,
      messageCount: metadata.messageCount
    };
  }
}

export {
  PubSubChannelService,
  ChannelNotFoundError,
  MessageNotFoundError,
  ChannelAlreadyExistsError
};
