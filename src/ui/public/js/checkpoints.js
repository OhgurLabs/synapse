/**
 * @module checkpoints.js
 * @domain Checkpoint Timeline Panel
 * @description Real-time checkpoint timeline with status tracking, replay action,
 *   and connection state management. Handles WebSocket events for checkpoint:created
 *   and checkpoint:updated events.
 *
 * @namespace window.SynapseCheckpoints
 * @exports {
 *   handleCheckpoint(event: Object): void,
 *   renderCheckpointTimeline(): void,
 *   triggerReplay(checkpointId: string): void,
 *   configure(config: Object): void,
 *   getConnectionStatus(): string
 * }
 * @depends window.SynapseGuardrails
 */
(function () {
  'use strict';

  // --- Configuration ---
  const CONFIG = {
    maxVisibleCheckpoints: 50,
    statusOrder: { created: 1, persisted: 2, replayed: 3, failed: 4 },
  };

  // --- State ---
  let checkpoints = [];
  const backfilledCampaigns = new Set(); // U9b: campaigns already backfilled from the API (avoid refetch storms)
  let isConfigured = false;
  let connectionStatus = 'disconnected';
  let retryCount = 0;
  const MAX_RETRY_COUNT = 5;
  const RETRY_DELAY = 2000;

  // --- Utility Functions ---
  function generateId() {
    return Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  }

  function formatTimestamp(dateString) {
    try {
      const date = new Date(dateString);
      const now = Date.now();
      const diff = now - date.getTime();
      
      if (diff < 60000) {
        return 'Just now';
      } else if (diff < 3600000) {
        const seconds = Math.floor(diff / 1000);
        return `${seconds}s ago`;
      } else if (diff < 86400000) {
        const minutes = Math.floor(diff / 60000);
        return `${minutes}m ago`;
      } else {
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    } catch (_) {
      return dateString;
    }
  }

  function getStatusClass(status) {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'failed') return 'failed';
    if (normalized === 'replayed') return 'replayed';
    if (normalized === 'persisted') return 'persisted';
    return 'created';
  }

  function getStatusIcon(status) {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'failed') return '❌';
    if (normalized === 'replayed') return '↩️';
    if (normalized === 'persisted') return '💾';
    return '⏱️';
  }

  function truncateText(text, maxLength = 80) {
    if (typeof text !== 'string') return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  }

  function normalizeCheckpointPayload(event) {
    if (!event) return null;

    return {
      id: event.checkpointId || generateId(),
      projectId: event.projectId || 'unknown',
      campaignId: event.campaignId || 'unknown',
      campaignVersion: event.campaignVersion || 1,
      milestoneProgress: event.milestoneProgress || {},
      completedSubtasks: event.completedSubtasks || [],
      lastSubtaskId: event.lastSubtaskId || null,
      status: event.status || 'created',
      summary: event.summary || `Checkpoint ${event.checkpointId || checkpoints.length + 1}`,
      timestamp: new Date(event.createdAt || Date.now()),
      error: event.error || null,
    };
  }

  // --- Checkpoint Buffer Management ---
  function addCheckpoint(checkpoint) {
    const normalized = normalizeCheckpointPayload(checkpoint);
    if (!normalized) return;

    // Check if checkpoint already exists
    const existingIndex = checkpoints.findIndex(cp => cp.id === normalized.id);
    
    if (existingIndex >= 0) {
      // Update existing checkpoint
      checkpoints[existingIndex] = normalized;
    } else {
      // Add new checkpoint
      checkpoints.unshift(normalized);

      // Enforce buffer limit
      if (checkpoints.length > CONFIG.maxVisibleCheckpoints) {
        checkpoints = checkpoints.slice(0, CONFIG.maxVisibleCheckpoints);
      }
    }

    renderCheckpointTimeline();
  }

  function getCheckpointsByCampaign(campaignId) {
    if (!campaignId) return checkpoints;
    return checkpoints.filter(cp => cp.campaignId === campaignId);
  }

  function getLatestCheckpoint(campaignId) {
    const filtered = getCheckpointsByCampaign(campaignId);
    return filtered.length > 0 ? filtered[0] : null;
  }

  // --- WebSocket Event Handlers ---
  function handleCheckpoint(event) {
    if (!event) return;

    isConfigured = true;
    connectionStatus = 'connected';
    retryCount = 0;
    
    addCheckpoint(event);
  }

  function handleConnectionLost() {
    connectionStatus = 'disconnected';
    
    if (retryCount < MAX_RETRY_COUNT) {
      retryCount++;
      setTimeout(() => {
        if (window.SynapseWebSocket && window.SynapseWebSocket.connectWS) {
          window.SynapseWebSocket.connectWS();
        }
      }, RETRY_DELAY * retryCount);
    }
  }

  // --- DOM Element Accessors ---
  function getPanelElement() {
    return document.getElementById('checkpoints-panel');
  }

  function getHeaderElement() {
    return document.getElementById('checkpoints-header');
  }

  function getBadgeElement() {
    return document.getElementById('checkpoints-badge');
  }

  function getControlsElement() {
    return document.getElementById('checkpoints-controls');
  }

  function getListElement() {
    return document.getElementById('checkpoints-list');
  }

  function getEmptyStateElement() {
    return document.getElementById('checkpoints-empty-state');
  }

  function getNotConfiguredElement() {
    return document.getElementById('checkpoints-not-configured');
  }

  // --- Rendering ---
  function renderCheckpointTimeline() {
    const panel = getPanelElement();
    if (!panel) return;

    // Update badge
    const badge = getBadgeElement();
    if (badge) {
      const count = checkpoints.length;
      badge.textContent = count > 0 ? count : '';
      badge.style.display = count > 0 ? 'inline-flex' : 'none';
      
      if (count > 0) {
        const hasFailed = checkpoints.some(cp => cp.status === 'failed');
        badge.className = 'checkpoints-badge ' + (hasFailed ? 'failed' : 'success');
      }
    }

    // Update controls. The connection-status indicator + refresh button
    // only earn their place once at least one checkpoint has actually
    // arrived (checkpoints.length > 0). On a fresh sandbox `isConfigured`
    // is already true from configure() at boot, so it can't gate this —
    // a "○ Disconnected" line read as a broken-feature alarm (Block #22).
    // Activity-gated render preserves the disconnect signal for real
    // sessions while staying quiet for never-used ones.
    const controls = getControlsElement();
    if (controls) {
      controls.innerHTML = '';

      if (checkpoints.length > 0) {
        const statusIndicator = document.createElement('span');
        statusIndicator.className = 'checkpoint-connection-status';
        statusIndicator.textContent = connectionStatus === 'connected' ? '● Connected' : '○ Disconnected';
        statusIndicator.style.fontSize = '10px';
        statusIndicator.style.color = connectionStatus === 'connected' ? 'var(--success)' : 'var(--text-faint)';
        controls.appendChild(statusIndicator);

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'checkpoints-refresh-btn';
        refreshBtn.textContent = '↻';
        refreshBtn.title = 'Refresh checkpoints';
        refreshBtn.addEventListener('click', () => {
          // Actually refetch — clearing the backfill dedup set lets
          // loadCheckpoints hit the API again; the old handler only re-drew
          // the in-memory buffer, making "Refresh" a visual no-op.
          const keys = [...backfilledCampaigns];
          backfilledCampaigns.clear();
          for (const key of keys) {
            const slash = key.indexOf('/');
            if (slash > 0) loadCheckpoints(key.slice(0, slash), key.slice(slash + 1));
          }
          renderCheckpointTimeline();
        });
        controls.appendChild(refreshBtn);
      }
    }

    // Update list. "Not configured" is honest only when we've actually
    // had activity and then lost it — gate on checkpoints.length > 0 for
    // the same reason as the controls block above (Block #22). Pre-first-
    // event the panel is just empty.
    const list = getListElement();
    if (list) {
      list.innerHTML = '';

      // U9b: when checkpoints exist (incl. API-backfilled ones on a fresh
      // load, before the live WS checkpoint channel handshakes), render
      // them. Live-connection state is already conveyed by the ●/○
      // indicator in the controls block — blanking the whole list behind a
      // "Connection unavailable" placeholder hid backfilled checkpoints and
      // made the panel look empty after every page reload.
      if (checkpoints.length === 0) {
        // Render empty state inline (Block #22, same reason as above).
        list.innerHTML = '<div class="checkpoints-empty"><div class="empty-icon">⏱️</div><div class="empty-text">No checkpoints yet</div><div class="empty-hint">Checkpoints will appear here as milestones complete</div></div>';
        return;
      }

      checkpoints.forEach(checkpoint => {
        const item = createCheckpointItem(checkpoint);
        list.appendChild(item);
      });
    }
  }

  function createCheckpointItem(checkpoint) {
    const item = document.createElement('div');
    item.className = 'checkpoint-item';
    item.dataset.id = checkpoint.id;

    const statusClass = getStatusClass(checkpoint.status);
    const statusIcon = getStatusIcon(checkpoint.status);

    item.innerHTML = `
      <div class="checkpoint-status ${statusClass}">
        ${statusIcon} ${checkpoint.status}
      </div>
      <div class="checkpoint-content">
        <div class="checkpoint-header">
          <span class="checkpoint-id">${checkpoint.id.substring(0, 8)}...</span>
          <span class="checkpoint-campaign">
            <span class="campaign-icon">📁</span>
            ${truncateText(checkpoint.campaignId, 20)}
          </span>
        </div>
        <div class="checkpoint-details">
          <div class="checkpoint-summary">${truncateText(checkpoint.summary)}</div>
          <div class="checkpoint-timestamp">
            <span class="timestamp-icon">🕐</span>
            ${formatTimestamp(checkpoint.timestamp)}
            ${checkpoint.campaignVersion ? `<span style="margin-left:8px;color:var(--text-faint)">v${checkpoint.campaignVersion}</span>` : ''}
          </div>
        </div>
        ${checkpoint.error ? `
          <div class="checkpoint-error">${truncateText(checkpoint.error)}</div>
        ` : ''}
        <button class="checkpoint-replay" title="Replay from checkpoint">↺ Replay</button>
      </div>
    `;

    // Replay button handler
    const replayBtn = item.querySelector('.checkpoint-replay');
    if (replayBtn) {
      replayBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        triggerReplay(checkpoint.id);
      });
    }

    return item;
  }

  // --- Public API ---
  async function triggerReplay(checkpointId) {
    const checkpoint = checkpoints.find(cp => cp.id === checkpointId);
    if (!checkpoint) {
      console.error(`Checkpoint not found: ${checkpointId}`);
      if (window.SynapseMessages?.showToast) {
        window.SynapseMessages.showToast('Checkpoint not found', 'error');
      }
      return;
    }

    const authFetch = window.SynapseWebSocket?.authFetch;
    const showToast = window.SynapseMessages?.showToast;

    if (!authFetch) {
      console.error('authFetch not available');
      if (showToast) showToast('Cannot connect to server', 'error');
      return;
    }

    // Get button element for UI state management
    const item = document.querySelector(`.checkpoint-item[data-id="${checkpointId}"]`);
    const replayBtn = item?.querySelector('.checkpoint-replay');

    // Optimistic UI: disable button and show loading state
    if (replayBtn) {
      replayBtn.disabled = true;
      replayBtn.classList.add('loading');
      replayBtn.innerHTML = '<span class="spinner"></span> Replaying...';
    }

    // Visual feedback on checkpoint item
    if (item) {
      item.classList.add('replaying');
    }

    try {
      // Make API call to replay endpoint
      const response = await authFetch(
        `/api/campaigns/${encodeURIComponent(checkpoint.projectId)}/${encodeURIComponent(checkpoint.campaignId)}/replay/${encodeURIComponent(checkpointId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }
      );

      const result = await response.json().catch(() => ({}));

      // response.ok check matters: a 403 from the role gate previously fell
      // through to the success toast because only result.error was inspected.
      if (!response.ok || result.error) {
        throw new Error(result.error || 'HTTP ' + response.status);
      }

      if (result.mock) {
        // Server accepted the request but the checkpoint manager is
        // unavailable — only an intent record was written. Don't claim success.
        if (showToast) showToast('Replay recorded but not executed (checkpoint manager unavailable)', 'warning');
      } else if (showToast) {
        showToast(`✓ Replayed checkpoint ${checkpointId.substring(0, 8)}...`, 'success');
      }

      // Keep visual feedback for a moment
      setTimeout(() => {
        if (item) item.classList.remove('replaying');
      }, 1500);

      // Reset button to ready state
      if (replayBtn) {
        replayBtn.disabled = false;
        replayBtn.classList.remove('loading');
        replayBtn.innerHTML = '↺ Replay';
      }

    } catch (error) {
      // Error fallback: re-enable button and show error message
      console.error('Checkpoint replay failed:', error);

      if (showToast) {
        showToast(`Failed to replay: ${error.message}`, 'error');
      }

      // Remove replaying visual state
      if (item) {
        item.classList.remove('replaying');
      }

      // Reset button to error state, then back to ready
      if (replayBtn) {
        replayBtn.classList.remove('loading');
        replayBtn.classList.add('error');
        replayBtn.innerHTML = '✗ Failed';

        // Return to ready state after showing error
        setTimeout(() => {
          if (replayBtn) {
            replayBtn.disabled = false;
            replayBtn.classList.remove('error');
            replayBtn.innerHTML = '↺ Replay';
          }
        }, 2000);
      }
    }
  }

  // U9b: backfill existing checkpoints from the API on load. broadcast() is
  // real-time only, so without this the panel is empty after a page reload
  // until the next live checkpoint. addCheckpoint() dedupes by id, so a
  // backfilled checkpoint and a later live broadcast for the same id merge.
  function loadCheckpoints(projectId, campaignId) {
    if (!projectId || !campaignId) return;
    const key = projectId + '/' + campaignId;
    if (backfilledCampaigns.has(key)) return;
    backfilledCampaigns.add(key);
    const authFetch = (window.SynapseWebSocket && window.SynapseWebSocket.authFetch) || fetch.bind(window);
    authFetch('/api/projects/' + encodeURIComponent(projectId) + '/campaigns/' + encodeURIComponent(campaignId) + '/checkpoints')
      .then(r => (r.ok ? r.json() : []))
      .then(list => {
        if (!Array.isArray(list)) return;
        for (const cp of list) {
          // API shape → normalizeCheckpointPayload input (inject project/campaign
          // from the request — the per-item rows don't carry them).
          addCheckpoint({
            checkpointId: cp.id,
            projectId,
            campaignId,
            createdAt: cp.createdAt,
            milestoneProgress: cp.milestoneProgress || {},
            completedSubtasks: cp.completedSubtasks || [],
            status: 'created',
          });
        }
      })
      .catch(() => { backfilledCampaigns.delete(key); }); // allow a later retry
  }

  function configure(config) {
    if (config && config.maxVisibleCheckpoints) {
      CONFIG.maxVisibleCheckpoints = config.maxVisibleCheckpoints;
    }
    isConfigured = config?.enabled !== false;
    
    if (!isConfigured) {
      connectionStatus = 'disconnected';
    }
    
    renderCheckpointTimeline();
  }

  function getConnectionStatus() {
    return connectionStatus;
  }

  function getCheckpoints() {
    return [...checkpoints];
  }

  // --- Public API ---
  window.SynapseCheckpoints = {
    handleCheckpoint,
    handleConnectionLost,
    renderCheckpointTimeline,
    triggerReplay,
    configure,
    loadCheckpoints,
    getConnectionStatus,
    getCheckpoints,
  };

})();