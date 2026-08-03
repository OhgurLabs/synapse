/**
 * @module health.js
 * @domain Health Panel & Monitoring
 * @description System health metrics, agent health cards, circuit breaker state,
 *   alerts, routing weights, error history, SSE error stream. Also hosts shared
 *   formatting utilities (escapeHtml, formatDuration, formatTimestamp) used by
 *   tasks.js, campaigns.js, and modals.js.
 *
 * @namespace window.SynapseHealth
 * @exports {
 *   renderHealthPanel(force?: boolean): void,
 *   refreshAlerts(): void,
 *   renderAlerts(): void,
 *   fetchRoutingWeights(): void,
 *   renderRoutingWeightsTable(): void,
 *   startRoutingWeightsPolling(): void,
 *   stopRoutingWeightsPolling(): void,
 *   connectErrorStream(): void,
 *   escapeHtml(text: string): string,
 *   formatDuration(ms: number): string,
 *   formatTimestamp(ts: string|number): string,
 *   formatTimeUntil(targetDate: string|Date): string,
 *   formatTimeSince(targetDate: string|Date): string
 * }
 * @depends window.SynapseWebSocket.authFetch
 *          window.SynapseAgents.openAgentSettings
 * @init init() — call after DOMContentLoaded
 */
(function () {
  'use strict';

  // --- State ---
  let healthPanel = null;
  let alertsPanel = null;
  let routingWeightsData = null;
  let routingWeightsSortCol = 'computed_weight';
  let routingWeightsSortDir = 'desc';
  let routingWeightsPollTimer = null;
  let errorStreamSource = null;

  // --- Utility Functions (shared across modules) ---
  function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDuration(ms) {
    if (!ms || ms < 0) return '0s';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + sec + 's';
    return sec + 's';
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString();
    } catch (_) { return String(ts); }
  }

  function formatTimeUntil(targetDate) {
    if (!targetDate) return '';
    const diff = new Date(targetDate) - Date.now();
    if (diff <= 0) return 'now';
    return 'in ' + formatDuration(diff);
  }

  function formatTimeSince(targetDate) {
    if (!targetDate) return '';
    const diff = Date.now() - new Date(targetDate);
    if (diff <= 0) return 'just now';
    return formatDuration(diff) + ' ago';
  }

  // --- Health Panel ---
  var _lastHealthFetch = 0;
  function renderHealthPanel(force) {
    var now = Date.now();
    if (!force && (now - _lastHealthFetch) < 2000) return;
    _lastHealthFetch = now;

    const panel = healthPanel || document.getElementById('health-panel');
    if (!panel) return;

    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    if (!authFetch) return;

    authFetch('/api/health').then(function (r) { return r.json(); }).then(function (data) {
      const agents = data.agents || {};
      const cb = data.circuitBreaker || {};
      const mem = data.memory || {};
      const metrics = data.metrics || {};
      const uptime = (data.uptime && data.uptime.human) || '';

      // Group agents by provider
      const byProvider = {};
      const agentNames = Object.keys(agents);
      for (let i = 0; i < agentNames.length; i++) {
        const name = agentNames[i];
        const agent = agents[name];
        const prov = agent.provider || 'unknown';
        if (!byProvider[prov]) byProvider[prov] = [];
        if (name.toLowerCase().startsWith('governor') || agent.role === 'governor') continue;
        byProvider[prov].push({ name: name, status: agent.status, model: agent.model, _status: agent._status, provider: prov });
      }

      let html = '<div class="health-panel-header">\u26A1 Health';
      if (uptime) html += ' <span style="font-weight:400;opacity:0.5">' + escapeHtml(uptime) + '</span>';
      html += '</div>';

      // Metrics grid
      const memVal = mem.heapUsed || 0;
      const taskVal = (metrics.activeTasks != null) ? metrics.activeTasks : 0;
      const queueVal = (metrics.queueDepth != null) ? metrics.queueDepth : 0;
      const agentCount = data.agentCount || agentNames.length;
      html += '<div class="metrics-grid">';
      html += metricCardHtml('Tasks', taskVal, taskVal > 20 ? 'danger' : taskVal > 10 ? 'warning' : 'good');
      html += metricCardHtml('Queue', queueVal, queueVal > 50 ? 'danger' : queueVal > 20 ? 'warning' : '');
      html += metricCardHtml('Mem MB', memVal, memVal > 400 ? 'danger' : memVal > 200 ? 'warning' : '');
      html += metricCardHtml('Agents', agentCount, '');
      html += '</div>';

      // Agent cards grouped by provider
      const providerNames = Object.keys(byProvider);
      if (providerNames.length > 0) {
        html += '<div class="health-section">';
        html += '<div class="health-section-title"><span class="section-icon">\uD83E\uDD16</span>Agents</div>';
        for (let pi = 0; pi < providerNames.length; pi++) {
          const prov = providerNames[pi];
          const provAgents = byProvider[prov];
          const cbState = (cb[prov] && cb[prov].state) ? cb[prov].state : 'closed';
          html += '<div class="provider-group">';
          html += '<div class="provider-header">';
          html += '<span class="provider-name">' + escapeHtml(prov) + ' <span class="provider-agent-count">(' + provAgents.length + ')</span></span>';
          html += '<span class="circuit-breaker-badge ' + escapeHtml(cbState) + '">' + escapeHtml(cbState) + '</span>';
          html += '</div>';
          html += '<div class="agent-grid">';
          for (let ai = 0; ai < provAgents.length; ai++) {
            const a = provAgents[ai];
            const rawStatus = a.status || 'idle';
            const statusKey = rawStatus.split(' ')[0];
            const isUnavailable = a._status === 'inactive' || a._status === 'disabled';
            html += '<div class="agent-card provider-' + escapeHtml(prov) + (isUnavailable ? ' unavailable' : '') + '">';
            html += '<div class="agent-card-name">' + escapeHtml(a.name) + '</div>';
            html += '<div class="agent-card-model">' + escapeHtml(a.model || '') + '</div>';
            html += '<div class="agent-card-status">';
            html += '<span class="agent-status-dot ' + escapeHtml(statusKey) + '"></span>';
            html += '<span class="agent-status-label">' + escapeHtml(rawStatus) + '</span>';
            html += '</div></div>';
          }
          html += '</div></div>';
        }
        html += '</div>';
      }

      // Routing weights section (rendered inline when data is available)
      if (routingWeightsData && routingWeightsData.length > 0) {
        html += '<div class="health-section" id="routing-weights-section">';
        html += '<div class="health-section-title"><span class="section-icon">\u2696\uFE0F</span>Routing Weights</div>';
        html += buildRoutingWeightsTableHtml();
        html += '</div>';
      }

      panel.innerHTML = html;
      wireRoutingWeightsSorting(panel);
    }).catch(function (e) {
      console.warn('[health] renderHealthPanel failed:', e.message);
      if (!panel.hasChildNodes()) {
        panel.innerHTML = '<div class="health-empty">Health unavailable</div>';
      }
    });
  }

  function metricCardHtml(label, value, cls) {
    return '<div class="metric-card">' +
      '<div class="metric-label">' + escapeHtml(label) + '</div>' +
      '<div class="metric-value' + (cls ? ' ' + cls : '') + '">' + escapeHtml(String(value)) + '</div>' +
      '</div>';
  }

  // --- Routing Weights ---
  function fetchRoutingWeights() {
    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    if (!authFetch) return;
    authFetch('/api/routing-weights').then(function (r) { return r.json(); }).then(function (data) {
      routingWeightsData = data.stats || [];
      renderRoutingWeightsTable();
    }).catch(function (e) {
      console.warn('[health] fetchRoutingWeights failed:', e.message);
    });
  }

  function buildRoutingWeightsTableHtml() {
    if (!routingWeightsData || routingWeightsData.length === 0) {
      return '<div class="health-empty">No routing data yet</div>';
    }

    const sorted = routingWeightsData.slice().sort(function (a, b) {
      let va = a[routingWeightsSortCol] != null ? a[routingWeightsSortCol] : 0;
      let vb = b[routingWeightsSortCol] != null ? b[routingWeightsSortCol] : 0;
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return routingWeightsSortDir === 'asc' ? cmp : -cmp;
    });

    const maxWeight = routingWeightsData.reduce(function (m, r) {
      return Math.max(m, r.computed_weight || 0);
    }, 1);

    const cols = [
      { key: 'agent_id', label: 'Agent' },
      { key: 'task_category', label: 'Category' },
      { key: 'success_rate', label: 'Success' },
      { key: 'total_dispatches', label: 'Runs' },
      { key: 'computed_weight', label: 'Weight' },
    ];

    let html = '<div style="padding:0 8px 8px"><table class="routing-weights-table"><thead><tr>';
    for (let ci = 0; ci < cols.length; ci++) {
      const col = cols[ci];
      const isActive = routingWeightsSortCol === col.key;
      const arrow = isActive ? (routingWeightsSortDir === 'asc' ? '\u25B2' : '\u25BC') : '\u25BE';
      html += '<th data-col="' + escapeHtml(col.key) + '">' + escapeHtml(col.label) +
        ' <span class="sort-arrow' + (isActive ? ' active' : '') + '">' + arrow + '</span></th>';
    }
    html += '</tr></thead><tbody>';

    for (let ri = 0; ri < sorted.length; ri++) {
      const row = sorted[ri];
      const barW = Math.round(((row.computed_weight || 0) / maxWeight) * 60);
      const srStr = row.success_rate != null ? (row.success_rate * 100).toFixed(0) + '%' : '\u2013';
      const isInsufficient = row.weight_reason === 'insufficient_data_fallback';
      const wt = row.computed_weight != null ? (typeof row.computed_weight.toFixed === 'function' ? row.computed_weight.toFixed(2) : String(row.computed_weight)) : '0';
      html += '<tr>';
      html += '<td>' + escapeHtml(row.agent_id) + '</td>';
      html += '<td>' + escapeHtml(row.task_category) + '</td>';
      html += '<td class="' + (isInsufficient ? 'rw-insufficient' : '') + '">' + escapeHtml(srStr) + '</td>';
      html += '<td>' + escapeHtml(String(row.total_dispatches || 0)) + '</td>';
      html += '<td><span class="rw-weight-bar" style="width:' + barW + 'px"></span>' + escapeHtml(wt) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  function renderRoutingWeightsTable() {
    const section = document.getElementById('routing-weights-section');
    if (!section) {
      // Section doesn't exist yet — trigger a full panel re-render which will include it
      renderHealthPanel();
      return;
    }
    // Preserve the section title, replace only the table content
    const title = section.querySelector('.health-section-title');
    section.innerHTML = '';
    if (title) section.appendChild(title);
    const tmp = document.createElement('div');
    tmp.innerHTML = buildRoutingWeightsTableHtml();
    while (tmp.firstChild) section.appendChild(tmp.firstChild);
    wireRoutingWeightsSorting(section);
  }

  function wireRoutingWeightsSorting(root) {
    const table = (root || document).querySelector('.routing-weights-table');
    if (!table) return;
    const headers = table.querySelectorAll('th[data-col]');
    for (let i = 0; i < headers.length; i++) {
      (function (th) {
        th.addEventListener('click', function () {
          const col = th.dataset.col;
          if (routingWeightsSortCol === col) {
            routingWeightsSortDir = routingWeightsSortDir === 'asc' ? 'desc' : 'asc';
          } else {
            routingWeightsSortCol = col;
            routingWeightsSortDir = 'desc';
          }
          renderRoutingWeightsTable();
        });
      })(headers[i]);
    }
  }

  function startRoutingWeightsPolling() {
    if (routingWeightsPollTimer) return;
    fetchRoutingWeights();
    routingWeightsPollTimer = setInterval(fetchRoutingWeights, 10000);
  }

  function stopRoutingWeightsPolling() {
    if (routingWeightsPollTimer) {
      clearInterval(routingWeightsPollTimer);
      routingWeightsPollTimer = null;
    }
  }

  // --- Error Stream (SSE) ---
  function connectErrorStream() {
    if (errorStreamSource) return;
    try {
      const meta = document.querySelector('meta[name="synapse-token"]');
      const token = meta ? meta.getAttribute('content') : '';
      const url = token
        ? '/api/errors/stream?token=' + encodeURIComponent(token)
        : '/api/errors/stream';
      const src = new EventSource(url);
      src.addEventListener('error', function (e) {
        // Network/connection error — EventSource will auto-reconnect; don't crash
        if (src.readyState === EventSource.CLOSED) {
          errorStreamSource = null;
        }
      });
      src.addEventListener('error', function (e) {
        try {
          const err = JSON.parse(e.data);
          console.debug('[health] error-stream event:', err.category, err.agentId, err.message);
        } catch (_) { /* non-data error event */ }
      });
      errorStreamSource = src;
    } catch (e) {
      console.warn('[health] connectErrorStream failed:', e.message);
    }
  }

  // --- Alerts ---
  function refreshAlerts() {
    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    if (!authFetch) return;
    authFetch('/api/alerts').then(function (r) { return r.json(); }).then(function (data) {
      if (Array.isArray(data)) {
        window._synapseAlerts = data;
        renderAlerts();
      }
    }).catch(function (e) {
      console.warn('[health] refreshAlerts failed:', e.message);
    });
  }

  // Mark one alert read (identity key survives pattern-scan refires)
  function ackAlert(key) {
    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    if (!authFetch || !key) return;
    authFetch('/api/alerts/ack', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key }),
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      window._synapseAlerts = (window._synapseAlerts || []).filter(function (a) { return a._key !== key; });
      renderAlerts();
    }).catch(function (e) {
      if (window.SynapseMessages && window.SynapseMessages.showToast) {
        window.SynapseMessages.showToast('Failed to mark read: ' + e.message, 'error');
      }
    });
  }

  // Mark everything currently visible read
  function ackAllAlerts() {
    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    if (!authFetch) return;
    authFetch('/api/alerts/ack-all', { method: 'POST' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      window._synapseAlerts = [];
      renderAlerts();
      if (window.SynapseMessages && window.SynapseMessages.showToast) {
        window.SynapseMessages.showToast('All alerts marked read', 'success');
      }
    }).catch(function (e) {
      if (window.SynapseMessages && window.SynapseMessages.showToast) {
        window.SynapseMessages.showToast('Failed: ' + e.message, 'error');
      }
    });
  }

  var ALERTS_RENDER_CAP = 200;

  function renderAlerts() {
    const panel = alertsPanel || document.getElementById('alerts-panel');
    if (!panel) return;
    const alerts = window._synapseAlerts || [];
    if (alerts.length === 0) {
      panel.innerHTML = '';
      return;
    }

    let html = '<div class="alerts-header">\u26A0 Alerts <span style="font-weight:400;opacity:0.6">(' + alerts.length + ')</span>' +
      '<button id="alerts-ack-all-btn" title="Mark all alerts read" style="float:right;background:none;border:1px solid var(--border,#444);border-radius:4px;color:inherit;cursor:pointer;font-size:10px;padding:1px 6px;opacity:.8">clear all</button></div>';
    html += '<div class="alerts-grid">';
    const renderCount = Math.min(alerts.length, ALERTS_RENDER_CAP);
    for (let i = 0; i < renderCount; i++) {
      const alert = alerts[i];
      const sev = alert.severity || 'warning';
      const title = alert.name || alert.title || alert.condition || 'Alert';
      const detail = alert.description || alert.message || alert.detail || '';
      html += '<div class="alert-row severity-' + escapeHtml(sev) + '" data-key="' + escapeHtml(alert._key || '') + '">';
      html += '<span class="alert-severity-icon ' + escapeHtml(sev) + '">' + (sev === 'critical' ? '\uD83D\uDD34' : '\u26A0') + '</span>';
      html += '<span class="alert-title">' + escapeHtml(title) + '</span>';
      html += '<button class="alert-ack-btn" title="Mark read" style="background:none;border:none;color:inherit;cursor:pointer;opacity:.5;font-size:11px;padding:0 2px">\u2715</button>';
      html += '<span class="alert-expand-chevron">\u25B6</span>';
      html += '</div>';
      if (detail) {
        html += '<div class="alert-expanded-detail">';
        html += '<div class="alert-expanded-detail-inner"><div class="alert-full-detail">' + escapeHtml(detail) + '</div></div>';
        html += '</div>';
      }
    }
    if (alerts.length > renderCount) {
      html += '<div style="opacity:.6;font-size:10px;padding:4px 8px">+' + (alerts.length - renderCount) + ' more \u2014 use clear all to reset</div>';
    }
    html += '</div>';
    panel.innerHTML = html;

    const ackAllBtn = panel.querySelector('#alerts-ack-all-btn');
    if (ackAllBtn) ackAllBtn.addEventListener('click', function (e) { e.stopPropagation(); ackAllAlerts(); });

    // Wire expand/collapse on each alert row; \u2715 marks read
    const rows = panel.querySelectorAll('.alert-row');
    for (let i = 0; i < rows.length; i++) {
      (function (row) {
        const ackBtn = row.querySelector('.alert-ack-btn');
        if (ackBtn) ackBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          ackAlert(row.getAttribute('data-key'));
        });
        row.addEventListener('click', function () {
          const detailEl = row.nextElementSibling;
          if (detailEl && detailEl.classList.contains('alert-expanded-detail')) {
            const isOpen = detailEl.classList.contains('open');
            detailEl.classList.toggle('open', !isOpen);
            row.classList.toggle('expanded', !isOpen);
          }
        });
      })(rows[i]);
    }
  }

  function init() {
    healthPanel = document.getElementById('health-panel');
    alertsPanel = document.getElementById('alerts-panel');
  }

  // --- Public API ---
  window.SynapseHealth = {
    renderHealthPanel,
    refreshAlerts,
    renderAlerts,
    fetchRoutingWeights,
    renderRoutingWeightsTable,
    startRoutingWeightsPolling,
    stopRoutingWeightsPolling,
    connectErrorStream,
    escapeHtml,
    formatDuration,
    formatTimestamp,
    formatTimeUntil,
    formatTimeSince,
    init,
  };
})();
