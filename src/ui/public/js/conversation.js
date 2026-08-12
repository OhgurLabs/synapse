/**
 * @module conversation.js
 * @domain Conversation Panel UI
 * @description Slide-out overlay displaying agent-to-agent conversation history
 *   for a given task. Shows participant roster, resolution status, and messages
 *   with agent color coding, timestamps, markdown rendering, and model tags.
 *   Supports real-time WebSocket updates via appendMessage().
 *
 * @namespace window.SynapseConversation
 * @exports {
 *   init(): void,
 *   openConversation(task: Object, projectId: string): Promise<void>,
 *   closeConversation(): void,
 *   getCurrentThreadId(): string|null,
 *   appendMessage(msg: Object): void,
 *   refetchIfOpen(): Promise<void>,
 *   openConversationPanel(projectId: string, taskId: string): void,  // legacy compat
 *   closeConversationPanel(): void  // legacy compat
 * }
 * @depends window.SynapseWebSocket.authFetch
 *          window.SynapseHealth.escapeHtml
 *          window.SynapseHealth.formatTimestamp
 *          window.SynapseMessages.renderMarkdown
 *          window.SynapseAgents.agentColors
 * @init init() — call after DOMContentLoaded
 */
(function () {
  'use strict';

  // --- State ---
  let overlay = null;
  let panel = null;
  let pollInterval = null;
  let currentProjectId = null;
  let currentTaskId = null;
  let currentThreadId = null;
  let currentChannelId = null;
  let seenMsgIds = new Set();  // dedup real-time messages
  let cachedData = null;  // last fetched conversation data

  // --- Utilities ---

  function shortModel(model) {
    if (!model) return '';
    return model
      .replace('claude-opus-4-6', 'Opus 4.6')
      .replace('claude-sonnet-4-6', 'Sonnet 4.6')
      .replace('claude-sonnet-4-5-20250929', 'Sonnet 4.5')
      .replace('claude-sonnet-4-5', 'Sonnet 4.5')
      .replace('claude-', 'Claude ')
      .replace('gpt-5.4-codex', 'gpt-5.4c')
      .replace('gpt-5.3-codex-spark', 'gpt-5.3-spark')
      .replace('gpt-5.2-codex', 'gpt-5.1c')
      .replace('gpt-5.1-codex-max', 'gpt-5.1-max')
      .replace('gpt-5.1-codex-mini', 'gpt-5.1m')
      .replace('gemini-3-auto', 'gem-3-auto')
      .replace('gemini-3-flash-preview', 'gem-3-flash')
      .replace('gemini-3-pro-preview', 'gem-3-pro')
      .replace('gemini-2.5-flash', 'gem-2.5-f')
      .replace('gemini-2.5-pro', 'gem-2.5-pro')
      .replace(/Qwen[\d.]*-(\d+B)(?:-[A-Z0-9]+)?-UD-.*\.gguf/i, 'Qwen3.5-$1')
      .replace(/\.gguf$/i, '')
      .replace('qwen3-72b', 'Qwen3 72B');
  }

  function esc(str) {
    if (window.SynapseHealth && window.SynapseHealth.escapeHtml) {
      return window.SynapseHealth.escapeHtml(str);
    }
    var s = String(str == null ? '' : str);
    return s.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
  }

  function fmt(ts) {
    return (window.SynapseHealth && window.SynapseHealth.formatTimestamp)
      ? window.SynapseHealth.formatTimestamp(ts)
      : String(ts || '');
  }

  function md(text) {
    return (window.SynapseMessages && window.SynapseMessages.renderMarkdown)
      ? window.SynapseMessages.renderMarkdown(text)
      : esc(text);
  }

  function agentColor(speaker) {
    const colors = window.SynapseAgents && window.SynapseAgents.agentColors;
    if (!colors) return '#888';
    return colors[speaker] || colors[(speaker || '').toLowerCase()] || '#888';
  }

  // --- Panel lifecycle ---

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  function closeConversation() {
    stopPolling();
    if (overlay) overlay.classList.remove('visible');
    currentProjectId = null;
    currentTaskId = null;
    currentThreadId = null;
    currentChannelId = null;
    seenMsgIds.clear();
    cachedData = null;
  }

  // Legacy API compatibility
  function closeConversationPanel() {
    closeConversation();
  }

  /**
   * Get the currently displayed thread ID (for WebSocket routing)
   * @returns {string|null}
   */
  function getCurrentThreadId() {
    return currentThreadId;
  }

  /**
   * Open conversation panel for a task (new API)
   * @param {Object} task - Task object with threadId, channel, id, title fields
   * @param {string} projectId - Project ID
   */
  async function openConversation(task, projectId) {
    if (!task || !task.threadId) {
      console.warn('SynapseConversation.openConversation: task has no threadId');
      return;
    }

    currentProjectId = projectId;
    currentTaskId = task.id;
    currentThreadId = task.threadId;
    currentChannelId = task.channel;
    seenMsgIds.clear();
    cachedData = null;

    ensureOverlay();
    overlay.classList.add('visible');
    renderLoading();

    await fetchAndRender();
    stopPolling();
    // Fallback polling for environments where WebSocket updates might not arrive
    pollInterval = setInterval(fetchAndRender, 4000);
  }

  // Legacy API compatibility
  function openConversationPanel(projectId, taskId) {
    // Fetch task to get threadId
    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    if (!authFetch) {
      console.error('SynapseConversation: authFetch not available');
      return;
    }

    authFetch('/api/projects/' + encodeURIComponent(projectId) + '/tasks/' + encodeURIComponent(taskId))
      .then(function(resp) {
        if (!resp.ok) throw new Error('Failed to fetch task');
        return resp.json();
      })
      .then(function(task) {
        openConversation(task, projectId);
      })
      .catch(function(err) {
        console.error('SynapseConversation.openConversationPanel error:', err);
      });
  }

  /**
   * Append a message to the open conversation (real-time WebSocket update)
   * @param {Object} msg - Message object from WebSocket with id, speaker, content, timestamp
   */
  function appendMessage(msg) {
    if (!currentThreadId || !msg || !msg.id) {
      return;
    }

    // Skip if already seen (dedup)
    if (seenMsgIds.has(msg.id)) {
      return;
    }

    seenMsgIds.add(msg.id);

    // Update cached data
    if (cachedData && cachedData.messages) {
      cachedData.messages.push(msg);

      // Update participant roster
      const speaker = msg.speaker || 'Unknown';
      let participant = cachedData.participants.find(function(p) {
        return (typeof p === 'string' ? p : p.name) === speaker;
      });

      if (!participant) {
        cachedData.participants.push({ name: speaker, messageCount: 1, lastActive: msg.timestamp });
      } else if (typeof participant === 'object') {
        participant.messageCount = (participant.messageCount || 0) + 1;
        participant.lastActive = msg.timestamp;
      }

      // Update metadata
      if (cachedData.metadata) {
        cachedData.metadata.turnCount = (cachedData.metadata.turnCount || 0) + 1;
      }
    }

    // Append message to DOM
    const messagesContainer = panel && panel.querySelector('.conv-messages');
    if (!messagesContainer) return;

    // Clear empty state if present
    const emptyState = messagesContainer.querySelector('.conv-empty-state');
    if (emptyState) {
      messagesContainer.innerHTML = '';
    }

    // Append message
    const messageHtml = buildMessageHtml(msg);
    messagesContainer.insertAdjacentHTML('beforeend', messageHtml);

    // Scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    // Re-render roster and metadata to update counts
    if (cachedData) {
      const rosterContainer = panel.querySelector('.conv-participants');
      if (rosterContainer) {
        rosterContainer.outerHTML = buildRosterHtml(cachedData.participants, cachedData.messages);
      }
      const metaContainer = panel.querySelector('.conv-meta');
      if (metaContainer && cachedData.metadata) {
        const meta = cachedData.metadata;
        metaContainer.outerHTML = buildMetaHtml(
          meta.turnCount,
          meta.state,
          meta.taskTitle,
          meta.taskStatus
        );
      }
    }

    console.log('SynapseConversation: appended message ' + msg.id + ' from ' + msg.speaker);
  }

  /**
   * Refetch conversation if panel is open (WebSocket reconnection recovery)
   */
  async function refetchIfOpen() {
    if (!currentThreadId || !currentProjectId || !currentTaskId) {
      return; // Panel not open, nothing to do
    }

    console.log('SynapseConversation: refetching conversation ' + currentThreadId + ' after reconnect');

    // Clear seenMsgIds to recover missed messages
    seenMsgIds.clear();

    await fetchAndRender();
  }

  // --- DOM helpers ---

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return;

    overlay = document.createElement('div');
    overlay.id = 'conversation-overlay';
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeConversation();
    });

    panel = document.createElement('div');
    panel.id = 'conversation-panel';
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  function renderLoading() {
    if (!panel) return;
    panel.innerHTML = '<div class="conv-loading">Loading conversation…</div>';
  }

  // --- Data fetching & rendering ---

  async function fetchAndRender() {
    if (!currentProjectId || !currentTaskId) return;

    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    if (!authFetch) return;

    let data;
    try {
      const resp = await authFetch(
        '/api/projects/' + encodeURIComponent(currentProjectId) +
        '/tasks/' + encodeURIComponent(currentTaskId) + '/conversation'
      );

      if (resp.status === 404) {
        renderNoConversation();
        stopPolling();
        return;
      }

      if (!resp.ok) {
        renderError('Failed to load conversation (HTTP ' + resp.status + ')');
        return;
      }

      data = await resp.json();
      cachedData = data;

      // Seed seenMsgIds from response
      const messages = Array.isArray(data.messages) ? data.messages : [];
      for (var i = 0; i < messages.length; i++) {
        if (messages[i].id) {
          seenMsgIds.add(messages[i].id);
        }
      }
    } catch (err) {
      renderError('Network error: ' + (err && err.message ? err.message : String(err)));
      return;
    }

    renderConversation(data);
  }

  function renderNoConversation() {
    if (!panel) return;
    panel.innerHTML =
      '<div class="conv-header">' +
        '<span class="conv-title">Agent Conversation</span>' +
        '<button class="conv-close" data-conv-action="close">✕</button>' +
      '</div>' +
      '<div class="conv-empty-state">' +
        '<div class="conv-empty-icon">💬</div>' +
        '<div class="conv-empty-title">No conversation linked</div>' +
        '<div class="conv-empty-desc">This task does not have an associated agent conversation yet.</div>' +
      '</div>';
  }

  function renderError(message) {
    if (!panel) return;
    panel.innerHTML =
      '<div class="conv-header">' +
        '<span class="conv-title">Agent Conversation</span>' +
        '<button class="conv-close" data-conv-action="close">✕</button>' +
      '</div>' +
      '<div class="conv-empty-state conv-error-state">' +
        '<div class="conv-empty-icon">⚠️</div>' +
        '<div class="conv-empty-title">Could not load conversation</div>' +
        '<div class="conv-empty-desc">' + esc(message) + '</div>' +
      '</div>';
  }

  function renderConversation(data) {
    if (!panel) return;

    const messages = Array.isArray(data.messages) ? data.messages : [];
    const participants = Array.isArray(data.participants) ? data.participants : [];
    const meta = data.metadata || data.meta || {};

    const taskTitle = meta.taskTitle || 'Untitled Task';
    const taskStatus = meta.taskStatus || '';
    const turnCount = meta.turnCount != null ? meta.turnCount : messages.length;
    const state = meta.state || 'in-progress';

    const rosterHtml = buildRosterHtml(participants, messages);
    const metaHtml = buildMetaHtml(turnCount, state, taskTitle, taskStatus);
    const msgsHtml = messages.length === 0
      ? buildNoMessagesHtml()
      : messages.map(buildMessageHtml).join('');

    panel.innerHTML =
      '<div class="conv-header">' +
        '<span class="conv-title">Agent Conversation</span>' +
        '<button class="conv-close" data-conv-action="close">✕</button>' +
      '</div>' +
      rosterHtml +
      metaHtml +
      '<div class="conv-messages">' + msgsHtml + '</div>';
  }

  function buildRosterHtml(participants, messages) {
    const speakerSet = new Set();
    for (var i = 0; i < participants.length; i++) {
      var p = participants[i];
      speakerSet.add(typeof p === 'string' ? p : (p.name || p.id || ''));
    }
    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];
      if (msg.speaker && msg.speaker !== 'System') speakerSet.add(msg.speaker);
    }
    if (speakerSet.size === 0) return '';

    var roleMap = {};
    for (var k = 0; k < participants.length; k++) {
      var part = participants[k];
      if (part && typeof part === 'object' && part.name) {
        roleMap[part.name] = part.role || null;
      }
    }

    var chips = '';
    speakerSet.forEach(function (name) {
      var color = agentColor(name);
      var role = roleMap[name] || '';
      var roleTag = role ? ' <span class="conv-chip-role">' + esc(role) + '</span>' : '';
      chips +=
        '<span class="conv-participant-chip" style="border-color:' + color + '22">' +
          '<span class="conv-chip-dot" style="background:' + color + '"></span>' +
          esc(name) + roleTag +
        '</span>';
    });

    return '<div class="conv-participants">' + chips + '</div>';
  }

  function buildMetaHtml(turnCount, state, taskTitle, taskStatus) {
    var stateClass = state === 'resolved' ? 'resolved'
      : state === 'escalated' ? 'escalated'
      : 'in-progress';
    var stateLabel = state === 'resolved' ? 'Resolved'
      : state === 'escalated' ? 'Escalated'
      : 'In Progress';

    var taskStatusBadge = taskStatus
      ? ' <span class="conv-task-status ' + esc((taskStatus).toLowerCase().replace(/\s+/g, '-')) + '">' + esc(taskStatus.toUpperCase()) + '</span>'
      : '';

    return '<div class="conv-meta">' +
      '<span class="conv-status-badge ' + stateClass + '">' + stateLabel + '</span>' +
      '<span class="conv-turn-count">' + turnCount + ' turn' + (turnCount !== 1 ? 's' : '') + '</span>' +
      '<span class="conv-task-link">' + esc(taskTitle) + taskStatusBadge + '</span>' +
    '</div>';
  }

  function buildMessageHtml(msg) {
    var speaker = msg.speaker || 'Unknown';
    var color = agentColor(speaker);
    var timestamp = fmt(msg.timestamp);
    var tsHtml = timestamp ? '<span class="conv-msg-ts">' + esc(timestamp) + '</span>' : '';
    var model = msg.model || '';
    var modelHtml = model ? '<span class="conv-msg-model">' + esc(shortModel(model)) + '</span>' : '';
    var bodyHtml = md(msg.content || '');

    return '<div class="conv-message" data-msg-id="' + esc(msg.id || '') + '">' +
      '<div class="conv-msg-header">' +
        '<span class="conv-msg-dot" style="background:' + color + '"></span>' +
        '<span class="conv-msg-speaker" style="color:' + color + '">' + esc(speaker) + '</span>' +
        modelHtml +
        tsHtml +
      '</div>' +
      '<div class="conv-msg-body">' + bodyHtml + '</div>' +
    '</div>';
  }

  function buildNoMessagesHtml() {
    return '<div class="conv-empty-state">' +
      '<div class="conv-empty-icon">📭</div>' +
      '<div class="conv-empty-title">No messages yet</div>' +
      '<div class="conv-empty-desc">The conversation thread exists but no messages have been posted.</div>' +
    '</div>';
  }

  // --- Init ---

  function init() {
    ensureOverlay();

    // Delegated close handler — inline onclick is blocked by the CSP; the
    // three render paths all emit data-conv-action="close" instead.
    document.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-conv-action="close"]');
      if (btn) closeConversation();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay && overlay.classList.contains('visible')) {
        closeConversation();
      }
    });
  }

  // --- Public API ---
  window.SynapseConversation = {
    init: init,
    openConversation: openConversation,
    closeConversation: closeConversation,
    getCurrentThreadId: getCurrentThreadId,
    appendMessage: appendMessage,
    refetchIfOpen: refetchIfOpen,
    // Legacy API compatibility
    openConversationPanel: openConversationPanel,
    closeConversationPanel: closeConversationPanel,
  };
})();
