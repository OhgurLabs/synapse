/**
 * @module websocket.js
 * @domain WebSocket Connection & Message Routing
 * @description WebSocket lifecycle, exponential-backoff reconnection, message
 *   parsing and routing to domain modules. Also provides authFetch() used by
 *   all modules that call the REST API.
 *
 * @namespace window.SynapseWebSocket
 * @exports {
 *   authFetch(url: string, opts?: RequestInit): Promise<Response>,
 *   wsSend(data: Object): void,
 *   updateConnectionStatus(state: string): void,
 *   connectWS(): void
 * }
 * @depends window.SynapseMessages.appendMessage, appendSystem, appendVoteResult,
 *            appendDeadlockNotice, clearMessages
 *          window.SynapseAgents.initAgentBadges, updateAgentStatus, updateBadgeModel
 *          window.SynapseTasks.refreshTasks, markConversationUnread
 *          window.SynapseCampaigns.refreshCampaigns
 *          window.SynapseHealth.renderHealthPanel, refreshAlerts
 *          window.SynapseBudget.updateBudgetDisplay
 *          window.SynapseInput.updateContextLabel, renderSidebar
 *          window.SynapseOnboarding.handleValidationComplete
 *          window.SynapseGuardrails.handleViolation
 *          window.SynapseCheckpoints.handleCheckpoint, handleConnectionLost
 *          window.SynapseConversation.appendMessage, getCurrentThreadId, refetchIfOpen
 * @init init() — call last, after all other modules are initialized
 */
(function () {
  'use strict';

  // --- State ---
  function getAuthToken() {
    if (typeof document === 'undefined') return '';
    // api.js injects synapse-token for header/query auth; session cookie auth needs no token in URL
    const meta = document.querySelector('meta[name="synapse-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  let ws = null;
  let wsBackoff = 1000;
  let wsRetries = 0;
  const WS_MAX_BACKOFF = 30000;
  const WS_MAX_RETRIES = 50;
  let wsReconnectTimer = null;
  let connStatus = null;

  // --- authFetch ---
  function authFetch(url, opts) {
    opts = opts || {};
    // Session-cookie auth needs no header; only legacy token-injected pages
    // (meta synapse-token) still send a bearer.
    const token = getAuthToken();
    if (token) {
      opts.headers = Object.assign({}, opts.headers || {}, {
        'Authorization': 'Bearer ' + token,
      });
    }
    return fetch(url, opts);
  }

  // --- Connection Status ---
  function updateConnectionStatus(state) {
    if (!connStatus) return;
    connStatus.className = state;
    const label = connStatus.querySelector('.label');
    if (label) {
      label.textContent = state === 'connected' ? 'Connected'
        : state === 'reconnecting' ? 'Reconnecting...'
        : 'Disconnected';
    }
  }

  // --- Send ---
  function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // --- Message Router ---
  function handleWsMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_) {
      return;
    }

    const type = msg.type || '';

    if (type === 'init') {
      window.SynapseOperatorName = msg.operatorName || 'operator';
      if (window.SynapseAuth) {
        window.SynapseAuth.init({
          userId: msg.userId,
          userRole: msg.userRole
        });
      }
      // Render agent badges BEFORE switchChannel so the chat empty-state
      // placeholder can read the agent count and pick the right copy.
      // switchChannel calls clearMessages → renderEmptyState; without
      // agents being rendered first, the placeholder always says
      // "No agents yet" even when agents exist.
      if (window.SynapseAgents && msg.agents) window.SynapseAgents.initAgentBadges(msg.agents);
      if (window.SynapseInput) {
        const projects = msg.projects || [];
        window.SynapseInput.projects = projects;

        // Channel resolution priority:
        //   1. localStorage 'synapse_last_channel' if it still references
        //      a project + channel that exist server-side
        //   2. server-suggested activeProject + activeChannel from init
        //   3. first project's 'general' channel as a final fallback so
        //      the user always lands on something rather than empty chat
        let proj = msg.activeProject || null;
        let chan = msg.activeChannel || null;
        try {
          const saved = JSON.parse(localStorage.getItem('synapse_last_channel') || 'null');
          if (saved && saved.project && saved.channel) {
            const projObj = projects.find(p => p.id === saved.project);
            const channelExists = projObj && (projObj.channels || []).some(c => (typeof c === 'string' ? c : c.id) === saved.channel);
            if (channelExists) { proj = saved.project; chan = saved.channel; }
          }
        } catch { /* localStorage / JSON failure — ignore and use server defaults */ }

        if ((!proj || !chan) && projects.length > 0) {
          proj = projects[0].id;
          const firstChannels = projects[0].channels || [];
          const firstChan = firstChannels.find(c => (typeof c === 'string' ? c : c.id) === 'general') || firstChannels[0];
          if (firstChan) chan = typeof firstChan === 'string' ? firstChan : firstChan.id;
        }

        if (proj && chan) {
          // Use switchChannel so the WebSocket subscribes and the
          // sidebar highlights the active row. Setting state directly
          // would skip both.
          window.SynapseInput.switchChannel(proj, chan);
        } else {
          window.SynapseInput.activeProject = null;
          window.SynapseInput.activeChannel = null;
          window.SynapseInput.renderSidebar();
          window.SynapseInput.updateContextLabel();
        }
      }
      if (window.SynapseHealth) window.SynapseHealth.renderHealthPanel();
      if (window.SynapseTasks) window.SynapseTasks.refreshTasks();
      if (window.SynapseCampaigns) window.SynapseCampaigns.refreshCampaigns();
    } else if (type === 'channel_history') {
      if (window.SynapseMessages) {
        window.SynapseMessages.clearMessages();
        if (Array.isArray(msg.messages)) msg.messages.forEach(m => window.SynapseMessages.appendMessage(m));
      }
    } else if (type === 'message') {
      if (window.SynapseMessages) window.SynapseMessages.appendMessage(msg);
      // Real-time conversation routing: if this message belongs to a thread
      // and the conversation panel is currently open for that thread, append
      // it live. Otherwise, mark the thread as unread if it has a threadId.
      if (window.SynapseConversation && msg.threadId) {
        if (window.SynapseConversation.getCurrentThreadId() === msg.threadId) {
          window.SynapseConversation.appendMessage(msg);
        } else if (window.SynapseTasks) {
          window.SynapseTasks.markConversationUnread(msg.threadId);
        }
      }
    } else if (type === 'system') {
      // Field is 'content' on the wire (transcript.jsonl, channel_history,
      // messages.js appendMessage system branch all use 'content').
      // 'text' was a typo that silently rendered every live system message
      // as an empty 28x20 div — including 'New thread: ...', 'Agent X
      // couldn't introduce itself', and any other server-emitted notice.
      if (window.SynapseMessages) window.SynapseMessages.appendSystem(msg.content, msg.threadId, { timestamp: msg.timestamp });
    } else if (type === 'vote_result') {
      if (window.SynapseMessages) window.SynapseMessages.appendVoteResult(msg);
    } else if (type === 'deadlock') {
      if (window.SynapseMessages) window.SynapseMessages.appendDeadlockNotice(msg);
    } else if (type === 'agents_updated') {
      if (window.SynapseAgents) window.SynapseAgents.initAgentBadges(msg.agents || []);
    } else if (type === 'project_created') {
      // Server emitted after a successful create_project. renderSidebar()
      // iterates over an in-memory `projects` list — without mutating it
      // first, re-rendering produces the same sidebar (Block #20).
      if (msg.project && window.SynapseInput) {
        const list = (window.SynapseInput.projects || []).slice();
        if (!list.some(p => p.id === msg.project.id)) list.push(msg.project);
        window.SynapseInput.projects = list;
        if (window.SynapseInput.renderSidebar) window.SynapseInput.renderSidebar();
      }
      const name = msg.project?.displayName || msg.project?.id || 'project';
      if (window.SynapseMessages?.showToast) window.SynapseMessages.showToast(`Project "${name}" created`, 'success');
    } else if (type === 'channel_created') {
      // Companion to project_created. Server emits after create_channel.
      // Mutate the matching project's channels array in place.
      if (msg.project && msg.channel && window.SynapseInput) {
        const list = (window.SynapseInput.projects || []).map(p => {
          if (p.id !== msg.project) return p;
          const channels = (p.channels || []).slice();
          if (!channels.includes(msg.channel)) channels.push(msg.channel);
          return { ...p, channels };
        });
        window.SynapseInput.projects = list;
        if (window.SynapseInput.renderSidebar) window.SynapseInput.renderSidebar();
      }
      if (window.SynapseMessages?.showToast) window.SynapseMessages.showToast(`Channel "#${msg.channel}" created in ${msg.project}`, 'success');
    } else if (type === 'channels_updated') {
      // Server emits after channel DELETE with the authoritative list —
      // without this case a deleted channel stayed in the sidebar until a
      // full reload.
      if (msg.project && Array.isArray(msg.channels) && window.SynapseInput) {
        window.SynapseInput.projects = (window.SynapseInput.projects || []).map(p =>
          p.id === msg.project ? { ...p, channels: msg.channels } : p);
        if (window.SynapseInput.renderSidebar) window.SynapseInput.renderSidebar();
      }
    } else if (type === 'project_updated') {
      // Allocation/vision/repoConfig changed (possibly in another tab) —
      // keep the sidebar's in-memory list in sync.
      if (msg.projectId && window.SynapseInput) {
        window.SynapseInput.projects = (window.SynapseInput.projects || []).map(p => {
          if (p.id !== msg.projectId) return p;
          const next = { ...p };
          if (msg.allocation !== undefined) next.allocation = msg.allocation;
          if (msg.vision !== undefined) next.vision = msg.vision;
          if (msg.repoConfig !== undefined) next.repoConfig = msg.repoConfig;
          if (msg.agents !== undefined) next.agents = msg.agents; // RosterSpec or null
          if (msg.mode !== undefined) next.mode = msg.mode;
          return next;
        });
        if (window.SynapseInput.renderSidebar) window.SynapseInput.renderSidebar();
      }
    } else if (type === 'status') {
      if (window.SynapseAgents) window.SynapseAgents.updateAgentStatus(msg.speaker, msg.status);
    } else if (type === 'routing') {
      if (window.SynapseAgents) window.SynapseAgents.updateBadgeModel(msg.agent, msg.model);
    } else if (type === 'dispatch_decision') {
      if (window.SynapseCampaigns) {
        window.SynapseCampaigns.appendLiveRoutingDecision(msg.projectId, msg.campaignId, msg);
      }
    } else if (type && type.startsWith('task_')) {
      if (window.SynapseTasks) window.SynapseTasks.refreshTasks();
    } else if (type && type.startsWith('campaign_')) {
      if (window.SynapseCampaigns) window.SynapseCampaigns.refreshCampaigns();
    } else if (type === 'health:update' || type === 'health:agents_updated' || type === 'health:circuit_breaker_updated') {
      if (window.SynapseHealth) window.SynapseHealth.renderHealthPanel();
    } else if (type === 'budget_updated') {
      if (window.SynapseBudget) window.SynapseBudget.updateBudgetDisplay(msg.data);
    } else if (type === 'unread') {
      if (window.SynapseInput) {
        window.SynapseInput.updateUnreadBadge(msg.projectId, msg.channelId);
      }
    } else if (type === 'validation:complete') {
      if (window.SynapseOnboarding) {
        window.SynapseOnboarding.handleValidationComplete(msg);
      }
    } else if (type === 'reviewer_accuracy_update') {
      // Reviewer accuracy metrics updated (e.g., after rejection overturn)
      if (window.SynapseReviewerMetrics) {
        window.SynapseReviewerMetrics.handleReviewerAccuracyUpdate(msg.data);
      }
    } else if (type === 'guardrail:blocked' || type === 'guardrail:advisory') {
      if (window.SynapseGuardrails) {
        window.SynapseGuardrails.handleViolation(msg);
      }
    } else if (type === 'checkpoint') {
      // Checkpoint created/updated events
      if (window.SynapseCheckpoints) {
        window.SynapseCheckpoints.handleCheckpoint(msg);
      }
    } else if (type === 'checkpoint_replay') {
      // Checkpoint replay initiated, update checkpoint data and refresh timeline
      if (window.SynapseCheckpoints) {
        // Update checkpoint with replay status if checkpoint data is included
        if (msg.checkpoint) {
          window.SynapseCheckpoints.handleCheckpoint({
            ...msg.checkpoint,
            status: 'replayed',
            projectId: msg.projectId,
            campaignId: msg.campaignId,
          });
        } else {
          // Fallback: just refresh the timeline
          window.SynapseCheckpoints.renderCheckpointTimeline();
        }
      }
    } else if (type === 'steering:action') {
      // Steering action events (replay, weight override, CB hold/reset, alert ack)
    } else if (type === 'analytics-refresh' || type === 'analytics:refresh') {
      // Analytics signals updated, refresh dashboard
    } else if (type === 'deliberation_request' || type === 'deliberation_feedback' || type === 'deliberation_revision') {
      // Deliberation events from timeline
    } else if (type === 'ws:disconnect') {
      // WebSocket disconnected, notify modules
      if (window.SynapseCheckpoints) {
        window.SynapseCheckpoints.handleConnectionLost();
      }
      if (window.SynapseGuardrails) {
        // Guardrails also handles connection state
      }
    }
  }

  // --- Connect ---
  function connectWS() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = getAuthToken();
    const wsUrl = protocol + '//' + location.host + '/ws' + (token ? '?token=' + encodeURIComponent(token) : '');

    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      wsBackoff = 1000;
      wsRetries = 0;
      updateConnectionStatus('connected');
      wsSend({ type: 'subscribe' });
      if (window.SynapseConversation) window.SynapseConversation.refetchIfOpen();
    };

    ws.onmessage = handleWsMessage;

    ws.onclose = function () {
      updateConnectionStatus('disconnected');
      if (wsRetries >= WS_MAX_RETRIES) return;
      wsRetries++;
      wsBackoff = Math.min(wsBackoff * 2, WS_MAX_BACKOFF);
      wsReconnectTimer = setTimeout(connectWS, wsBackoff);
    };

    ws.onerror = function (err) {
      // Log error; onclose will handle reconnect
    };
  }

  function init() {
    connStatus = document.getElementById('conn-status');
    connectWS();
    if (window.SynapseHealth) window.SynapseHealth.connectErrorStream();
  }

  // --- Public API ---
  window.SynapseWebSocket = {
    authFetch,
    wsSend,
    updateConnectionStatus,
    connectWS,
    init,
  };
})();
