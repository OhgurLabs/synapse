/**
 * @module budget.js
 * @domain Quota Health Display
 * @description Per-provider agent availability panel. Shows which providers have
 *   agents ready to work, which are cooling down (soft/hard), and a header widget
 *   with total ready-agent count. Data sourced from /api/health.
 *
 * @namespace window.SynapseBudget
 * @exports {
 *   fetchBudgetStatus(): Promise<Object>,
 *   updateBudgetDisplay(data: Object): void,
 *   updateBudgetWidget(): void,
 *   renderBudgetPanel(): void
 * }
 * @depends window.SynapseWebSocket.authFetch
 *          window.SynapseHealth.escapeHtml
 * @init init() — call after DOMContentLoaded
 */
(function () {
  'use strict';

  // --- State ---
  let budgetWidget = null;
  let budgetPanel = null;

  // --- Utility Functions ---
  function escapeHtml(text) {
    const fn = window.SynapseHealth?.escapeHtml;
    if (fn) return fn(text);
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function authFetch(url, opts) {
    const fn = window.SynapseWebSocket?.authFetch;
    if (fn) return fn(url, opts);
    return fetch(url, opts);
  }

  // --- Core Functions ---

  async function fetchHealthData() {
    try {
      const res = await authFetch('/api/health');
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      console.error('Quota health fetch error:', err);
      return null;
    }
  }

  function renderQuotaPanel(agents) {
    if (!budgetPanel) return;

    // Group non-governor, dispatchable agents by provider. Skip lifecycle
    // states that are not dispatchable (matches updateQuotaWidget's exclusion
    // list — failed/paused/registered agents have their own per-badge visual
    // signal and shouldn't muddle "is this provider usable?")
    const byProvider = {};
    for (const [id, agent] of Object.entries(agents || {})) {
      if ((id || '').toLowerCase().startsWith('governor') || agent.role === 'governor') continue;
      if (agent._status === 'inactive') continue;
      if (agent._status === 'failed') continue;
      if (agent._status === 'paused') continue;
      if (agent._status === 'registered') continue;
      const prov = agent.provider || 'unknown';
      if (!byProvider[prov]) byProvider[prov] = [];
      byProvider[prov].push({ id, status: agent.status || 'idle' });
    }

    const providerOrder = ['claude', 'codex', 'gemini', 'ollama'];
    const allProviders = [
      ...providerOrder.filter(p => byProvider[p]),
      ...Object.keys(byProvider).filter(p => !providerOrder.includes(p)),
    ];

    let html = '<div class="budget-panel-header">Quota Health</div>';

    for (const prov of allProviders) {
      const provAgents = byProvider[prov];
      if (!provAgents || provAgents.length === 0) continue;

      const available = provAgents.filter(a =>
        !a.status.startsWith('rate_limited') && !a.status.startsWith('fallback')
      );
      const cooling = provAgents.filter(a =>
        a.status.startsWith('rate_limited') || a.status.startsWith('fallback')
      );

      let statusHtml;
      if (cooling.length === 0) {
        statusHtml = `<span class="quota-ok">&#9679; ${available.length} available</span>`;
      } else if (available.length === 0) {
        // All agents cooling — find remaining time and detect soft/hard
        let label = '';
        let isSoft = false;
        for (const a of cooling) {
          if (a.status.includes('(est.)')) isSoft = true;
          if (!label) {
            const m = a.status.match(/(\d+h(?:\s+\d+m)?|\d+m)/);
            if (m) label = m[1];
          }
        }
        const timeStr = label ? (isSoft ? `~${label} est.` : label) : '?';
        statusHtml = isSoft
          ? `<span class="quota-soft">&#10007; cooling ${escapeHtml(timeStr)}</span>`
          : `<span class="quota-hard">&#10007; cooling ${escapeHtml(timeStr)}</span>`;
      } else {
        // Mixed: some available, some cooling
        statusHtml = `<span class="quota-ok">&#9679; ${available.length} of ${provAgents.length}</span>`;
      }

      html += `<div class="quota-row">
        <span class="quota-prov">${escapeHtml(prov)}</span>
        ${statusHtml}
      </div>`;
    }

    if (allProviders.length === 0) {
      html += '<div class="budget-empty">No agents available</div>';
    }

    budgetPanel.innerHTML = html;
  }

  function updateQuotaWidget(agents) {
    if (!budgetWidget) return;

    let available = 0;
    let hasCooling = false;
    let hasPaused = false;
    for (const [id, agent] of Object.entries(agents || {})) {
      if ((id || '').toLowerCase().startsWith('governor') || agent.role === 'governor') continue;
      // Lifecycle states that are not dispatchable. Each has its own visual
      // signal on the badge (gray = inactive, amber = paused, red ring =
      // failed, blue pulse = registered) so the widget just needs to skip
      // them — the user already knows where each agent stands. Counting any
      // of these as "ready" misleads the user into expecting a response that
      // can't come.
      if (agent._status === 'inactive') continue;
      if (agent._status === 'failed') continue;
      if (agent._status === 'registered') continue;
      if (agent._status === 'paused') {
        hasPaused = true;
        continue;
      }
      if (!agent.status.startsWith('rate_limited') && !agent.status.startsWith('fallback')) {
        available++;
      } else {
        hasCooling = true;
      }
    }

    // The count is the truth: "X ready" works at any X including 0.
    // The agent strip immediately below shows WHY 0 — a paused badge,
    // an inactive badge, or rate-limited styling on individual agents.
    // We don't need the widget to repeat that context.
    //
    // CSS classes still differentiate visual states:
    //   .danger — agents exist but are cooling (transient warning)
    //   .empty  — nothing to show (no agents, or all inactive/paused)
    budgetWidget.className = 'budget-widget' +
      (available === 0 && hasCooling ? ' danger' : available === 0 ? ' empty' : '');
    budgetWidget.textContent = `${available} ready`;
  }

  /**
   * Legacy: called from websocket.js on budget_updated events.
   * Re-fetch health data and re-render quota panel.
   */
  function updateBudgetDisplay(_data) {
    renderBudgetPanel();
  }

  /**
   * Update quota widget in header (convenience function)
   */
  function updateBudgetWidget() {
    fetchHealthData().then(data => {
      if (data) updateQuotaWidget(data.agents || {});
    });
  }

  /**
   * Render quota health panel in sidebar
   */
  function renderBudgetPanel() {
    fetchHealthData().then(data => {
      if (!data) return;
      renderQuotaPanel(data.agents || {});
      updateQuotaWidget(data.agents || {});
    }).catch(err => {
      console.error('Quota panel render error:', err);
    });
  }

  /**
   * Legacy: kept for backward compat — subscription model has no cloud budget.
   * @returns {Promise<Object>} Empty budget object
   */
  function fetchBudgetStatus() {
    return Promise.resolve({ used: 0, max: 0, remaining: 0, percentage: 0, providers: {} });
  }

  function init() {
    budgetWidget = document.getElementById('budget-widget');
    budgetPanel = document.getElementById('budget-panel');
    renderBudgetPanel();
  }

  // --- Public API ---
  window.SynapseBudget = {
    fetchBudgetStatus,
    updateBudgetDisplay,
    updateBudgetWidget,
    renderBudgetPanel,
    init,
  };
})();
