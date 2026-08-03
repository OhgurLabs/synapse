// Webhook dispatch engine — listens to EventBus, delivers signed HTTP POST callbacks.
// Zero dependencies — native fetch + crypto.createHmac.

import { createHmac, randomBytes } from 'crypto';
import { WebhookStore } from './webhooks-store.js';
import { createLogger } from '../logger.js';
import { guardedFetch } from '../guarded-fetch.js';

const log = createLogger('webhooks');

// Event types per design doc (WEBHOOKS.md section 2).
// Convention: namespace:action via colon. Single-word events ('message')
// have no separator. Underscore-separated names were normalized to colon
// notation as part of the v1 beta cleanup so the API surface is uniform.
const WEBHOOK_EVENTS = [
  'message', 'session:start', 'session:end',
  'agent:dispatch', 'vote:completed',
  'project:created', 'channel:created', 'agents:updated',
  'task:created', 'task:status_changed', 'task:completed',
  'campaign:created', 'campaign:status_changed', 'campaign:milestone_completed',
  'campaign:paused', 'campaign:resumed',
  'campaign:approval_requested',
  'schedule:fired',
  'thread:created',
  'alert:firing', 'alert:resolved',
  'alert:sla_breach', 'alert:sla_resolved',
  // Audit events for enterprise observability
  'timeline:insert',
];

const RETRY_DELAYS = [5000, 30000, 120000]; // 5s, 30s, 120s
const DELIVERY_TIMEOUT_MS = 10000;
const MAX_DELIVERY_LOG = 1000;

// Retryable HTTP status codes
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function generateDeliveryId() {
  return 'dlv_' + randomBytes(6).toString('hex');
}

function signPayload(secret, body) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

// Provider compatibility shim. Slack/Discord/Teams incoming-webhook
// receivers accept arbitrary JSON but require ONE renderable top-level
// field — Slack wants `text` (or blocks/attachments/fallback), Discord
// wants `content` (or embeds), Teams wants `text`. Without it Slack
// returns 400 `missing_text_or_fallback_or_attachments` and Discord
// returns 400 `Cannot send an empty message` (proven via direct probe).
// Inject a human-readable summary so the full Synapse envelope still
// rides along for advanced consumers parsing the JSON, while the
// provider gets the field it needs to render.
function applyProviderShim(payload, hookUrl) {
  if (!hookUrl) return payload;
  const event = payload.event || 'event';
  const data = payload.data || {};
  const detail = data.text || data.message || data.summary || data.title
    || data.name || data.speaker || data.agentId || data.taskId
    || data.campaignId || '';
  const summary = detail ? `${event} — ${String(detail).slice(0, 240)}` : event;

  if (hookUrl.includes('hooks.slack.com')) {
    if (!payload.text && !payload.blocks && !payload.attachments && !payload.fallback) {
      payload.text = `*Synapse* ${summary}`;
    }
  } else if (hookUrl.includes('discord.com/api/webhooks') || hookUrl.includes('discordapp.com/api/webhooks')) {
    if (!payload.content && !payload.embeds) {
      payload.content = `**Synapse** ${summary}`;
    }
  } else if (hookUrl.includes('webhook.office.com') || hookUrl.includes('office365.webhook.office.com')) {
    // Microsoft Teams legacy connector — same shape as Slack.
    if (!payload.text) {
      payload.text = `**Synapse** ${summary}`;
    }
  }
  return payload;
}

export function createWebhookDispatcher({ events, stateManager, config, baseDir }) {
  const store = new WebhookStore(baseDir);
  const deliveryLog = new Map(); // deliveryId → status record

  function trimDeliveryLog() {
    if (deliveryLog.size > MAX_DELIVERY_LOG) {
      const oldest = [...deliveryLog.keys()].slice(0, deliveryLog.size - MAX_DELIVERY_LOG);
      for (const k of oldest) deliveryLog.delete(k);
    }
  }

  async function deliver(hook, projectId, eventName, data, deliveryId, attempt) {
    const payload = applyProviderShim({
      event: eventName,
      timestamp: new Date().toISOString(),
      projectId,
      deliveryId,
      data,
    }, hook.url);

    const body = JSON.stringify(payload);
    const signature = signPayload(hook.secret, body);

    const record = deliveryLog.get(deliveryId) || {
      deliveryId, webhookId: hook.id, event: eventName,
      status: 'pending', attempts: 0,
      lastAttemptAt: null, lastStatusCode: null, lastError: null,
      createdAt: new Date().toISOString(),
    };
    record.attempts = attempt + 1;
    record.lastAttemptAt = new Date().toISOString();
    deliveryLog.set(deliveryId, record);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

      // SSRF Protection: guardedFetch checks URL against SSRF policy before making request.
      // If blocked: throws error with code='SSRF_BLOCKED' AND automatically logs:
      //   - timeline guardrail_event (outcome='block', rule_name='SSRF Denylist Guard')
      //   - operator_audit entry (actionType='ssrf_violation')
      // See: src/guarded-fetch.js, src/ssrf-filter.js, src/ssrf-config-store.js
      const res = await guardedFetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Synapse-Webhook/1.0',
          'X-Synapse-Event': eventName,
          'X-Synapse-Delivery': deliveryId,
          'X-Synapse-Signature': signature,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      record.lastStatusCode = res.status;

      if (res.ok) {
        record.status = 'delivered';
        log.info('Delivered', { event: eventName, url: hook.url, deliveryId });
        return;
      }

      // 410 Gone — auto-deactivate webhook
      if (res.status === 410) {
        record.status = 'failed';
        record.lastError = 'HTTP 410 Gone — webhook deactivated';
        store.deactivate(projectId, hook.id);
        log.warn('410 Gone — deactivated webhook', { url: hook.url, webhookId: hook.id });
        return;
      }

      // Non-retryable 4xx
      if (res.status >= 400 && res.status < 500 && !RETRYABLE_STATUSES.has(res.status)) {
        record.status = 'failed';
        record.lastError = `HTTP ${res.status} (non-retryable)`;
        log.warn('Non-retryable error', { statusCode: res.status, url: hook.url });
        return;
      }

      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      record.lastError = err.message;

      // SSRF policy violations are not retried — timeline + audit logs already written by guardedFetch
      if (err.code === 'SSRF_BLOCKED') {
        record.status = 'failed';
        log.warn('Delivery blocked by SSRF policy', { url: hook.url, rule: err.matchedRule, reason: err.message });
        return;
      }

      if (attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt];
        log.warn('Retrying delivery', { attempt: attempt + 1, maxRetries: RETRY_DELAYS.length, url: hook.url, delaySec: delay / 1000, error: err.message });
        setTimeout(() => deliver(hook, projectId, eventName, data, deliveryId, attempt + 1), delay);
      } else {
        record.status = 'failed';
        log.warn('Gave up on delivery', { url: hook.url, retries: RETRY_DELAYS.length, error: err.message });
      }
    }

    trimDeliveryLog();
  }

  function dispatch(eventName, eventData) {
    const projectId = eventData?.projectId || eventData?.project || null;
    if (!projectId) return;

    // Verify project exists
    if (!stateManager.getProject(projectId)) return;

    const allHooks = store._load(projectId);
    const matching = allHooks.filter(h =>
      h.active && (h.events.includes(eventName) || h.events.includes('*'))
    );

    for (const hook of matching) {
      const deliveryId = generateDeliveryId();
      deliver(hook, projectId, eventName, eventData, deliveryId, 0);
    }
  }

  // Test endpoint helper — delivers a test event and returns result
  async function testWebhook(projectId, webhookId) {
    const hook = store.get(projectId, webhookId);
    if (!hook) return { ok: false, error: 'Webhook not found' };

    const deliveryId = generateDeliveryId();
    const payload = applyProviderShim({
      event: 'webhook:test',
      timestamp: new Date().toISOString(),
      projectId,
      deliveryId,
      data: { webhookId, message: 'Webhook test from Synapse' },
    }, hook.url);

    const body = JSON.stringify(payload);
    const signature = signPayload(hook.secret, body);
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

      // SSRF Protection: guardedFetch validates URL against SSRF policy (see deliver() for details)
      const res = await guardedFetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Synapse-Webhook/1.0',
          'X-Synapse-Event': 'webhook:test',
          'X-Synapse-Delivery': deliveryId,
          'X-Synapse-Signature': signature,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      return { ok: res.ok, statusCode: res.status, latencyMs: Date.now() - start };
    } catch (err) {
      // SSRF blocks include err.code='SSRF_BLOCKED' and err.matchedRule
      const ssrfBlocked = err.code === 'SSRF_BLOCKED';
      return {
        ok: false,
        error: err.message,
        statusCode: null,
        latencyMs: Date.now() - start,
        ssrfBlocked,
      };
    }
  }

  function start(timelineStore = null) {
    for (const event of WEBHOOK_EVENTS) {
      events.on(event, (data) => dispatch(event, data));
    }
    // Wire timeline store insert events for audit event forwarding
    if (timelineStore && typeof timelineStore.on === 'function') {
      timelineStore.on('insert', (event) => {
        // Extract projectId from correlationKeys or data
        const projectId = event.correlationKeys?.projectId || event.data?.projectId || null;
        if (projectId) {
          // Wrap timeline event in webhook-compatible format
          dispatch('timeline:insert', {
            projectId,
            timelineEvent: event,
          });
        }
      });
      log.info('Wired timeline store for audit event forwarding');
    }
    log.info('Listening for events', { count: WEBHOOK_EVENTS.length });
  }

  return { start, dispatch, testWebhook, store, getDeliveryLog: () => deliveryLog };
}
