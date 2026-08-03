/**
 * @module guardrails.js
 * @domain Guardrail Violations Panel
 * @description Real-time guardrail violations feed with severity color-coding,
 *   filtering, and buffer management. Handles WebSocket events for
 *   guardrail:blocked and guardrail:advisory events.
 *
 * @namespace window.SynapseGuardrails
 * @exports {
 *   handleViolation(event: Object): void,
 *   renderViolationsPanel(): void,
 *   setFilter(field: string, value: string): void,
 *   resetFilters(): void,
 *   configure(config: Object): void
 * }
 * @depends window.SynapseMessages
 */
(function () {
  'use strict';

  // --- Configuration ---
  const CONFIG = {
    maxVisibleEntries: 100,
    severityOrder: { critical: 1, warning: 2, info: 3 },
  };

  // --- State ---
  // Filters persist across reloads (P7 — parity with routing-audit.js).
  const FILTERS_KEY = 'synapse:ui:guardrails-filters';
  let violations = [];
  let filters = (() => {
    try { return { severity: 'all', rule: 'all', ...JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}') }; }
    catch { return { severity: 'all', rule: 'all' }; }
  })();
  const persistFilters = () => { try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch {} };
  let isConfigured = false;
  let panelCollapsed = false;

  // --- Utility Functions ---
  function generateId() {
    return Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  }

  function formatTimestamp(date) {
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
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  }

  function truncateText(text, maxLength = 120) {
    if (typeof text !== 'string') return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  }

  function getSeverityClass(severity) {
    const normalized = (severity || '').toLowerCase();
    if (normalized === 'critical' || normalized === 'blocking') return 'critical';
    if (normalized === 'warning' || normalized === 'medium') return 'warning';
    return 'info';
  }

  function getSeverityIcon(severity) {
    const normalized = (severity || '').toLowerCase();
    if (normalized === 'critical' || normalized === 'blocking') return '⚠️';
    if (normalized === 'warning' || normalized === 'medium') return '⚡';
    return 'ℹ️';
  }

  function extractAgentName(agentInfo) {
    if (!agentInfo) return 'Unknown';
    if (typeof agentInfo === 'string') return agentInfo;
    if (agentInfo.name) return agentInfo.name;
    if (agentInfo.agentId) return agentInfo.agentId;
    return 'Unknown';
  }

  // --- Violation Buffer Management ---
  function addViolation(violation) {
    const entry = {
      id: generateId(),
      rule: violation.rule || 'unknown',
      agent: extractAgentName(violation.agent),
      severity: violation.severity || 'warning',
      message: violation.message || 'Guardrail violation detected',
      phase: violation.phase || 'pre',
      timestamp: new Date(),
      payloadExcerpt: violation.payloadExcerpt || null,
    };

    violations.unshift(entry);

    // Enforce buffer limit
    if (violations.length > CONFIG.maxVisibleEntries) {
      violations = violations.slice(0, CONFIG.maxVisibleEntries);
    }

    // Reapply filters after adding
    applyFilters();
  }

  function getFilteredViolations() {
    if (filters.severity === 'all' && filters.rule === 'all') {
      return violations;
    }

    return violations.filter(v => {
      const severityMatch = filters.severity === 'all' || 
        getSeverityClass(v.severity) === filters.severity;
      const ruleMatch = filters.rule === 'all' || v.rule === filters.rule;
      return severityMatch && ruleMatch;
    });
  }

  function applyFilters() {
    renderViolationsPanel();
  }

  function getUniqueRules() {
    const rules = new Set();
    violations.forEach(v => rules.add(v.rule));
    return Array.from(rules).sort();
  }

  // --- WebSocket Event Handlers ---
  function handleViolation(event) {
    if (!event) return;

    isConfigured = true;
    addViolation(event);
    renderViolationsPanel();
  }

  // --- DOM Element Accessors ---
  function getPanelElement() {
    return document.getElementById('guardrails-panel');
  }

  function getHeaderElement() {
    return document.getElementById('guardrails-header');
  }

  function getBadgeElement() {
    return document.getElementById('guardrails-badge');
  }

  function getControlsElement() {
    return document.getElementById('guardrails-controls');
  }

  function getListElement() {
    return document.getElementById('guardrails-list');
  }

  function getEmptyStateElement() {
    return document.getElementById('guardrails-empty-state');
  }

  function getNotConfiguredElement() {
    return document.getElementById('guardrails-not-configured');
  }

  // --- Rendering ---
  function renderViolationsPanel() {
    const panel = getPanelElement();
    if (!panel) return;

    const filtered = getFilteredViolations();
    const uniqueRules = getUniqueRules();

    // Update badge
    const badge = getBadgeElement();
    if (badge) {
      const visibleCount = filtered.length;
      const totalCount = violations.length;
      badge.textContent = visibleCount > 0 ? visibleCount : '';
      badge.style.display = visibleCount > 0 ? 'inline-flex' : 'none';
      
      if (visibleCount > 0) {
        const hasCritical = filtered.some(v => getSeverityClass(v.severity) === 'critical');
        const hasWarning = filtered.some(v => getSeverityClass(v.severity) === 'warning');
        badge.className = 'guardrails-badge ' + (hasCritical ? 'critical' : hasWarning ? 'warning' : 'info');
      }
    }

    // Update controls. Severity / rule filters are only meaningful once at
    // least one violation has fired. On a fresh sandbox they sit above an
    // empty list and beg the question "filter what?" (Block #22). Only
    // render them when there's something to filter.
    const controls = getControlsElement();
    if (controls) {
      controls.innerHTML = '';
    }
    if (controls && violations.length > 0) {

      // Severity filter
      const severitySelect = document.createElement('select');
      severitySelect.className = 'guardrails-filter-select';
      severitySelect.id = 'filter-severity';
      severitySelect.dataset.field = 'severity';
      severitySelect.setAttribute('aria-label', 'Filter by severity');
      
      const allOption = document.createElement('option');
      allOption.value = 'all';
      allOption.textContent = 'All Severities';
      allOption.selected = filters.severity === 'all';
      severitySelect.appendChild(allOption);

      const criticalOption = document.createElement('option');
      criticalOption.value = 'critical';
      criticalOption.textContent = 'Critical';
      criticalOption.selected = filters.severity === 'critical';
      severitySelect.appendChild(criticalOption);

      const warningOption = document.createElement('option');
      warningOption.value = 'warning';
      warningOption.textContent = 'Warning';
      warningOption.selected = filters.severity === 'warning';
      severitySelect.appendChild(warningOption);

      const infoOption = document.createElement('option');
      infoOption.value = 'info';
      infoOption.textContent = 'Info';
      infoOption.selected = filters.severity === 'info';
      severitySelect.appendChild(infoOption);

      if (filters.severity !== 'all') {
        severitySelect.classList.add('filter-active');
      }

      severitySelect.addEventListener('change', (e) => {
        setFilter('severity', e.target.value);
      });

      controls.appendChild(severitySelect);

      // Rule filter
      const ruleSelect = document.createElement('select');
      ruleSelect.className = 'guardrails-filter-select';
      ruleSelect.id = 'filter-rule';
      ruleSelect.dataset.field = 'rule';
      ruleSelect.setAttribute('aria-label', 'Filter by rule');

      const allRuleOption = document.createElement('option');
      allRuleOption.value = 'all';
      allRuleOption.textContent = 'All Rules';
      allRuleOption.selected = filters.rule === 'all';
      ruleSelect.appendChild(allRuleOption);

      uniqueRules.forEach(rule => {
        const option = document.createElement('option');
        option.value = rule;
        option.textContent = rule;
        option.selected = filters.rule === rule;
        ruleSelect.appendChild(option);
      });

      if (filters.rule !== 'all') {
        ruleSelect.classList.add('filter-active');
      }

      ruleSelect.addEventListener('change', (e) => {
        setFilter('rule', e.target.value);
      });

      controls.appendChild(ruleSelect);

      // Reset button
      const resetBtn = document.createElement('button');
      resetBtn.className = 'guardrails-filter-reset';
      resetBtn.textContent = '✕';
      resetBtn.title = 'Reset filters';
      resetBtn.addEventListener('click', () => {
        resetFilters();
      });

      controls.appendChild(resetBtn);
    }

    // Update list
    const list = getListElement();
    if (list) {
      list.innerHTML = '';

      if (!isConfigured) {
        // Render not-configured inline — the HTML template is a child of
        // #guardrails-list and gets detached by innerHTML = '' above, so
        // getElementById() returns null on the second render (Block #22).
        list.innerHTML = '<div class="guardrails-not-configured"><div class="config-icon">⚙️</div><div class="config-text">Guardrails not configured</div><div class="config-hint">Connection unavailable</div></div>';
        return;
      }

      if (filtered.length === 0) {
        // Render empty state inline (Block #22, same reason as above).
        list.innerHTML = '<div class="guardrails-empty"><div class="empty-icon">🛡️</div><div class="empty-text">No violations</div><div class="empty-hint">Guardrail events will appear here in real-time</div></div>';
        return;
      }

      filtered.forEach(violation => {
        const item = createViolationItem(violation);
        list.appendChild(item);
      });
    }
  }

  function createViolationItem(violation) {
    const item = document.createElement('div');
    item.className = 'violation-item';
    item.dataset.id = violation.id;

    const severityClass = getSeverityClass(violation.severity);
    const severityIcon = getSeverityIcon(violation.severity);

    item.innerHTML = `
      <div class="violation-severity ${severityClass}">
        ${severityIcon} ${violation.severity}
      </div>
      <div class="violation-content">
        <div class="violation-header">
          <span class="violation-rule">${violation.rule}</span>
          <span class="violation-agent">
            <span class="agent-icon">🤖</span>
            ${violation.agent}
          </span>
        </div>
        <div class="violation-details">
          <div class="violation-message">${truncateText(violation.message)}</div>
          <div class="violation-timestamp">
            <span class="timestamp-icon">🕐</span>
            ${formatTimestamp(violation.timestamp)}
            ${violation.phase ? `<span style="margin-left:8px;color:var(--text-faint)">${violation.phase}</span>` : ''}
          </div>
        </div>
        ${violation.payloadExcerpt ? `
          <div class="violation-payload">${escapeHtml(violation.payloadExcerpt)}</div>
          <button class="violation-expand" title="Expand details" aria-expanded="false" aria-label="Expand violation details">▸</button>
        ` : ''}
      </div>
    `;

    // Expand toggle
    const expandBtn = item.querySelector('.violation-expand');
    const payload = item.querySelector('.violation-payload');
    if (expandBtn && payload) {
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        item.classList.toggle('expanded');
        const isExpanded = item.classList.contains('expanded');
        expandBtn.textContent = isExpanded ? '▾' : '▸';
        expandBtn.setAttribute('aria-expanded', String(isExpanded));
      });
    }

    return item;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // --- Public API ---
  function setFilter(field, value) {
    if (field === 'severity') {
      filters.severity = value;
    } else if (field === 'rule') {
      filters.rule = value;
    }
    persistFilters();
    applyFilters();
  }

  function resetFilters() {
    filters = {
      severity: 'all',
      rule: 'all',
    };
    persistFilters();

    // Update UI
    const severitySelect = document.getElementById('filter-severity');
    if (severitySelect) {
      severitySelect.value = 'all';
    }
    
    const ruleSelect = document.getElementById('filter-rule');
    if (ruleSelect) {
      ruleSelect.value = 'all';
    }
    
    applyFilters();
  }

  function configure(config) {
    if (config && config.maxVisibleEntries) {
      CONFIG.maxVisibleEntries = config.maxVisibleEntries;
    }
    isConfigured = config?.enabled !== false;
    renderViolationsPanel();
  }

  function togglePanel() {
    panelCollapsed = !panelCollapsed;
    const panel = getPanelElement();
    const header = getHeaderElement();
    
    if (panel && header) {
      if (panelCollapsed) {
        panel.classList.add('collapsed');
        header.classList.add('collapsed');
      } else {
        panel.classList.remove('collapsed');
        header.classList.remove('collapsed');
      }
    }
  }

  // --- Public API ---
  window.SynapseGuardrails = {
    handleViolation,
    renderViolationsPanel,
    setFilter,
    resetFilters,
    configure,
    togglePanel,
  };

  // Header collapse — the CSS ships cursor:pointer + .collapsed rules and
  // togglePanel() existed, but nothing ever bound the click.
  const _grHeader = document.getElementById('guardrails-header');
  if (_grHeader) {
    _grHeader.addEventListener('click', togglePanel);
    _grHeader.setAttribute('role', 'button');
    _grHeader.setAttribute('tabindex', '0');
    _grHeader.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(); }
    });
  }

})();
