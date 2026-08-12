/**
 * onboarding.js — Onboarding Wizard Controller
 *
 * Multi-step wizard for agent validation, configuration, and test dispatch.
 * Manages step navigation, progress persistence, and API integration.
 */

(function () {
  'use strict';

  // Step icons dropped — the step-number indicator (1, 2, 3, 4) already fills
  // that role in the UI. Emojis add visual noise without carrying information.
  // Configure step removed: agent configuration is owned by the heavy
  // openAgentSettings() modal (the canonical edit path). The wizard's job is
  // "is your setup working?" — validate and test, not edit settings.
  // Order matters (operator ruling, 2026-08-01): Test Dispatch runs BEFORE
  // First Project. Creating the project first starts a real build
  // immediately, so on a single-agent install the test could never dispatch
  // — the only agent was already busy building. Prove routing works while
  // agents are guaranteed free, then hand them the first project.
  const STEPS = [
    { id: 'validate', label: 'Validate Agents' },
    { id: 'test',     label: 'Test Dispatch' },
    { id: 'project',  label: 'First Project' },
    { id: 'complete', label: 'Done' }
  ];

  const STORAGE_KEY = 'synapse_onboarding_progress';

  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    const tokenMeta = document.querySelector('meta[name="synapse-token"]');
    if (tokenMeta) h['Authorization'] = 'Bearer ' + tokenMeta.content;
    return h;
  }

  let currentState = {
    currentStep: 0,
    completedSteps: [],
    agentData: {},
    validationResults: {},
    testResult: null,
    inFlightValidations: {},
    asyncValidationPromises: {}
  };

  let dom = {};

  /**
   * Initialize the wizard
   */
  function init() {
    cacheElements();
    loadProgress();
    bindEvents();
    const DISMISSED_KEY = 'synapse_onboarding_dismissed';
    if (localStorage.getItem(DISMISSED_KEY)) return;
    // Auto-launch policy:
    //   0 agents  → show the wizard as a FIRST-AGENT BUILDER: it lists the
    //               coding-agent CLIs detected on this host and walks the
    //               user through creating their first agent, then flows
    //               straight into validation. (Earlier design hid the wizard
    //               at 0 agents, stranding new users at an empty screen with
    //               a hunt for the + button.)
    //   1+ agents → show wizard so the user can verify setup is working.
    //   Dismissal is sticky either way.
    const token = document.querySelector('meta[name="synapse-token"]')?.content;
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    fetch('/api/health', { headers })
      .then(r => r.json())
      .then(data => {
        const agentCount = Object.keys(data.agents || {}).length;
        if (agentCount === 0) {
          loadDetectedHarnesses();
          startRosterWatch();
          render();
          return;
        }
        // Preload the roster BEFORE first render — the validate step's
        // empty-state card previously asserted "No agents yet" to users
        // with a full roster, because agentData was only populated when
        // Continue kicked off validation.
        return fetch('/api/agents', { headers })
          .then(r2 => r2.json())
          .then(agents => {
            if (Array.isArray(agents)) currentState.agentData.agents = agents;
          })
          .catch(() => { /* cards fall back to empty-state copy */ })
          .then(() => {
            render();
            // Auto-start validation: the step says "Checking agent
            // availability…" and Continue is gated on results — with a
            // preloaded roster, nothing else can start the check (Continue
            // is disabled until validations complete).
            const onValidate = currentState.currentStep === 0
              && (currentState.agentData.agents || []).length > 0
              && Object.keys(currentState.validationResults || {}).length === 0
              && Object.keys(currentState.inFlightValidations || {}).length === 0;
            if (onValidate) runValidation();
          });
      })
      .catch(() => { /* API unavailable — don't show wizard */ });
  }

  /**
   * Handle validation:complete WebSocket events
   * Updates in-flight validation steps and syncs wizard state
   * @param {Object} event - Validation result event from WebSocket
   */
  function handleValidationComplete(event) {
    const { agentId, ...result } = event;

    if (!agentId) {
      console.warn('validation:complete event missing agentId');
      return;
    }

    // Mark validation as complete in in-flight tracking. Both maps must clear
    // here — runValidation only clears them on the catch path, so a successful
    // completion would otherwise leave isRetrying stuck true and the Retry
    // button never re-renders for failed agents.
    delete currentState.asyncValidationPromises[agentId];
    delete currentState.inFlightValidations[agentId];

    // Refresh the cached roster — cards and the test-dispatch audit render
    // model/provider from agentData, which goes stale the moment the user
    // edits an agent mid-wizard (a fixed codex model kept displaying its old
    // failing id after it validated green).
    fetch('/api/agents', { headers: authHeaders() })
      .then(r => r.json())
      .then(a => { if (Array.isArray(a)) currentState.agentData.agents = a; })
      .catch(() => {});

    // Update validation results. Surface the FAILING STEP's actual message —
    // the flat 'Validation failed' hid the pipeline's diagnosis (which step,
    // why, and the fix instruction it already computed).
    const failingStep = (result.steps || []).find(s => s.status === 'fail');
    currentState.validationResults[agentId] = {
      ...result,
      status: result.overallStatus || 'unknown',
      complete: result.overallStatus === 'pass',
      error: result.overallStatus === 'fail'
        ? ((failingStep && failingStep.message) || 'Validation failed')
        : null,
      fixInstruction: (failingStep && failingStep.fixInstruction) || null
    };

    // Re-render the entire validate panel so error/fix sub-elements get
    // created (updateValidationCard can't add nodes that didn't exist on the
    // initial pending render — it only toggles visibility on existing ones).
    if (currentState.currentStep === 0) {
      renderCurrentPanel();
      renderFooter();
    } else {
      // Off the validate step — keep the partial in-place update
      const agentCard = dom.wizard?.querySelector(`[data-agent-id="${agentId}"]`);
      if (agentCard) {
        updateValidationCard(agentCard, currentState.validationResults[agentId]);
      }
    }

    // If all validations are complete and we're on validation step, enable Next button
    checkAllValidationsComplete();
  }

  /**
   * Update a single validation card in the UI
   * @param {HTMLElement} card - The validation card element
   * @param {Object} result - Validation result object
   */
  function updateValidationCard(card, result) {
    const iconEl = card.querySelector('.onboarding-validation-card-icon');
    const statusEl = card.querySelector('.onboarding-validation-card-status');
    const errorEl = card.querySelector('.onboarding-validation-card-error');
    const fixEl = card.querySelector('.onboarding-validation-card-fix');

    if (!iconEl || !statusEl) return;

    // Update icon and status
    const isComplete = result.complete === true;
    const hasError = result.error || result.status === 'error' || result.overallStatus === 'fail';

    let iconClass = 'pending';
    let iconChar = '•';
    if (isComplete && !hasError) {
      iconClass = 'success';
      iconChar = '✓';
    } else if (hasError) {
      iconClass = 'error';
      iconChar = '✗';
    }

    iconEl.className = `onboarding-validation-card-icon ${iconClass}`;
    iconEl.innerHTML = `<span>${iconChar}</span>`;
    statusEl.textContent = result.status || result.overallStatus || 'unknown';

    // Update error display
    if (hasError && errorEl) {
      errorEl.innerHTML = `<strong>Error:</strong> ${result.error || result.message || 'Validation failed'}`;
      errorEl.style.display = 'block';
    } else if (errorEl) {
      errorEl.style.display = 'none';
    }

    // Update fix instruction
    if (hasError && result.fixInstruction && fixEl) {
      fixEl.innerHTML = `<strong>Fix:</strong> ${result.fixInstruction}`;
      fixEl.style.display = 'block';
    } else if (fixEl) {
      fixEl.style.display = 'none';
    }
  }

  /**
   * Check if all validations are complete and update wizard state
   */
  function checkAllValidationsComplete() {
    const agents = currentState.agentData.agents || [];
    if (agents.length === 0) return;

    const allComplete = agents.every(agent => {
      const result = currentState.validationResults[agent.id];
      return result && (result.complete === true || result.status === 'skip');
    });

    // Only mark step as complete if all validations pass or are skipped
    // Do NOT allow progression when all validations fail
    if (allComplete && !currentState.completedSteps.includes('validate')) {
      currentState.completedSteps.push('validate');
      saveProgress();
    }
  }

  /**
   * Cache DOM elements
   */
  function cacheElements() {
    dom.wizard = document.getElementById('onboarding-wizard');
    dom.closeBtn = document.getElementById('onboarding-close-btn');
    dom.progressBar = document.getElementById('onboarding-progress-bar');
    dom.content = document.getElementById('onboarding-wizard-content');
    dom.footer = document.getElementById('onboarding-wizard-footer');
    dom.footerProgress = document.getElementById('onboarding-footer-progress');
    dom.prevBtn = document.getElementById('onboarding-prev-btn');
    dom.nextBtn = document.getElementById('onboarding-next-btn');
    dom.skipBtn = document.getElementById('onboarding-skip-btn');
    dom.footerActions = document.getElementById('onboarding-footer-actions');
  }

  /**
   * Load progress from localStorage
   */
  function loadProgress() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        currentState = { ...currentState, ...parsed };
      }
    } catch (e) {
      console.warn('Failed to load onboarding progress:', e);
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  /**
   * Save progress to localStorage
   */
  function saveProgress() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(currentState));
    } catch (e) {
      console.warn('Failed to save onboarding progress:', e);
    }
  }

  /**
   * Reset wizard progress
   */
  function resetProgress() {
    currentState = {
      currentStep: 0,
      completedSteps: [],
      agentData: {},
      validationResults: {},
      testResult: null
    };
    localStorage.removeItem(STORAGE_KEY);
  }

  /**
   * Escape HTML to prevent XSS
   */
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Render the wizard UI
   */
  function render() {
    if (!dom.wizard) return;

    dom.wizard.classList.add('visible');
    renderProgressBar();
    renderCurrentPanel();
    renderFooter();
  }

  /**
   * Render progress bar
   */
  function renderProgressBar() {
    if (!dom.progressBar) return;

    dom.progressBar.innerHTML = STEPS.map((step, index) => {
      const isCompleted = currentState.completedSteps.includes(step.id);
      const isActive = index === currentState.currentStep;
      const isDisabled = index > currentState.currentStep && !isCompleted;

      let statusHtml = '';
      if (isCompleted) {
        statusHtml = '<span class="step-icon">✓</span>';
      }
      // Active step is already marked by its own styling (blue pill + step
      // number); the redundant hourglass glyph is gone.

      return `
        <div class="onboarding-progress-step ${isCompleted ? 'completed' : ''} ${isActive ? 'active' : ''} ${isDisabled ? 'disabled' : ''}"
             data-step-index="${index}"
             ${isDisabled ? '' : 'data-onb-action="goto-step"'}>
          <div class="step-number">${isCompleted ? '✓' : index + 1}</div>
          <div class="step-info">
            <div class="step-label">${step.label}</div>
            ${statusHtml}
          </div>
        </div>
      `;
    }).join('');
  }

  /**
   * Render current step panel
   */
  function renderCurrentPanel() {
    const stepId = STEPS[currentState.currentStep].id;

    // Remove all panels
    const existingPanels = dom.content.querySelectorAll('.onboarding-wizard-panel');
    existingPanels.forEach(p => p.remove());

    let panelHtml = '';

    switch (stepId) {
      case 'validate':
        panelHtml = renderValidationPanel();
        break;
      case 'project':
        panelHtml = renderProjectPanel();
        if (!currentState.projectTemplates) loadProjectTemplates();
        break;
      case 'test':
        panelHtml = renderTestPanel();
        break;
      case 'complete':
        panelHtml = renderCompletePanel();
        break;
    }

    if (panelHtml) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = panelHtml;
      const panel = tempDiv.firstElementChild;
      if (panel) {
        dom.content.appendChild(panel);
      }
    }
  }

  /**
   * Render validation panel
   */
  function renderValidationPanel() {
    const agents = currentState.agentData.agents || [];
    const validationResults = currentState.validationResults;

    let cardsHtml = '';

    if (agents.length === 0) {
      // First-agent builder: show which coding-agent CLIs this host already
      // has (BYOH — Synapse plugs into what's installed) and open the
      // create-agent form. startRosterWatch() flows into validation the
      // moment the first agent exists.
      const det = currentState.detectedHarnesses;
      let harnessListHtml;
      if (!det) {
        harnessListHtml = '<div class="onboarding-validation-card-details">Scanning this machine for installed coding-agent CLIs…</div>';
      } else {
        const found = det.filter(h => h.found);
        const missing = det.filter(h => !h.found);
        // Offers come from scanning each harness's OWN config files
        // (opencode.json, ~/.pi/agent/models.json, codex config.toml, auth
        // presence). The model strings are the exact identifiers the
        // harness resolves — one click, no hand-typing.
        const offers = found.flatMap(h => (h.offers || []).map(o => ({ ...o, harness: h.label, harnessId: h.id })));
        currentState.agentOffers = offers;
        // Lazily ask each harness for its LIVE model list (opencode models /
        // pi --list-models…) so the user can pick — static defaults are only
        // the fallback. Options append to the row's <select> when they land.
        loadOfferModelLists([...new Set(offers.map(o => o.harnessId))]);
        const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        harnessListHtml = `
          <div class="onboarding-validation-card-details">
            ${found.length > 0 ? `
              <div style="margin-bottom:6px"><strong>Detected on this machine:</strong></div>
              ${found.map(h => `<div>✓ ${esc(h.label)} <span style="opacity:.6">(${esc(h.path)})</span></div>`).join('')}
            ` : `
              <div><strong>No coding-agent CLIs detected.</strong> Install and authenticate one
              (Claude Code, Codex, opencode, Pi, Aider, …), then come back — Synapse connects
              to the agents you already have; it doesn't install them for you.</div>
            `}
            ${missing.length > 0 && found.length > 0 ? `
              <div style="margin-top:8px;opacity:.65">Not detected: ${missing.map(h => esc(h.label)).join(', ')}</div>
            ` : ''}
            ${offers.length > 0 ? `
              <div style="margin-top:12px;margin-bottom:6px"><strong>Found in your harness configs — ready to create:</strong></div>
              ${offers.map((o, i) => `
                <div style="display:flex;align-items:center;gap:6px;margin:3px 0">
                  <label style="cursor:pointer;white-space:nowrap">
                    <input type="checkbox" class="onboarding-offer-cb" data-offer-idx="${i}" checked>
                    <strong>${esc(o.harness)}</strong>
                  </label>
                  <select class="onboarding-offer-model" data-offer-idx="${i}" data-harness-id="${esc(o.harnessId)}"
                          style="flex:1;min-width:0;padding:2px 4px">
                    <option value="${esc(o.model)}" selected>${esc(o.model)}</option>
                  </select>
                  <span style="opacity:.6;white-space:nowrap">(${esc(o.why)})</span>
                </div>`).join('')}
            ` : ''}
          </div>`;
      }
      cardsHtml = `
        <div class="onboarding-validation-card">
          <div class="onboarding-validation-card-header">
            <div class="onboarding-validation-card-icon pending">
              <span>1</span>
            </div>
            <div>
              <div class="onboarding-validation-card-title">Create your first agent</div>
              <div class="onboarding-validation-card-status">Bring your own harness — one agent is enough to start</div>
            </div>
          </div>
          ${harnessListHtml}
          <div class="onboarding-validation-card-actions" style="margin-top:10px">
            ${(currentState.agentOffers || []).length > 0 ? `
              <button class="onboarding-btn onboarding-btn-primary" data-onb-action="create-selected">
                Create selected agents
              </button>
              <button class="onboarding-btn onboarding-btn-secondary" data-onb-action="open-first-agent-form">
                + Add manually
              </button>
            ` : `
              <button class="onboarding-btn onboarding-btn-primary" data-onb-action="open-first-agent-form">
                + Add your first agent
              </button>
            `}
          </div>
        </div>
      `;
    } else {
      cardsHtml = agents.map(agent => {
        const result = validationResults[agent.id] || {};
        const isComplete = result.complete === true;
        const hasError = result.error || result.status === 'error';

        let iconClass = 'pending';
        let iconChar = '•';
        if (isComplete && !hasError) {
          iconClass = 'success';
          iconChar = '✓';
        } else if (hasError) {
          iconClass = 'error';
          iconChar = '✗';
        }

        const canRetry = result.status === 'error' || result.overallStatus === 'fail' || !result.complete;
        const isRetrying = currentState.inFlightValidations[agent.id];

        return `
          <div class="onboarding-validation-card" data-agent-id="${agent.id}">
            <div class="onboarding-validation-card-header">
              <div class="onboarding-validation-card-icon ${iconClass}">
                <span>${iconChar}</span>
              </div>
              <div>
                <div class="onboarding-validation-card-title">${agent.name || agent.id}</div>
                <div class="onboarding-validation-card-status">${result.status || (isRetrying ? 'Retrying...' : 'pending')}</div>
              </div>
            </div>
            <div class="onboarding-validation-card-details">
              <div>Provider: ${agent.provider || 'unknown'}</div>
              <div>Model: ${agent.model || 'default'}</div>
            </div>
            ${hasError ? `
              <div class="onboarding-validation-card-error">
                <strong>Error:</strong> ${result.error || result.message || 'Validation failed'}
              </div>
            ` : ''}
            ${hasError && result.fixInstruction ? `
              <div class="onboarding-validation-card-fix">
                <strong>Fix:</strong> ${result.fixInstruction}
              </div>
            ` : ''}
            ${canRetry && !isRetrying ? `
              <div class="onboarding-validation-card-actions">
                <button class="onboarding-btn onboarding-btn-secondary onboarding-btn-sm" data-onb-action="retry-validation" data-arg="${agent.id}">
                  Retry Validation
                </button>
              </div>
            ` : ''}
          </div>
        `;
      }).join('');
    }

    return `
      <div class="onboarding-wizard-panel visible" data-step="validate">
        <div class="onboarding-wizard-panel-header">
          <h3 class="onboarding-wizard-panel-title">
Agent Validation
          </h3>
          <p class="onboarding-wizard-panel-description">
            Checking agent availability and connectivity before configuration.
          </p>
          <button class="onboarding-wizard-help-tooltip" data-onb-action="show-tooltip" data-arg="validate">
What does this do?
          </button>
        </div>
        <div class="onboarding-validation-grid">
          ${cardsHtml}
        </div>
      </div>
    `;
  }

  /**
   * Render test dispatch panel
   */
  function renderTestPanel() {
    const testResult = currentState.testResult;

    // Initial state - no test run yet
    if (!testResult) {
      return `
        <div class="onboarding-wizard-panel visible" data-step="test">
          <div class="onboarding-wizard-panel-header">
            <h3 class="onboarding-wizard-panel-title">
Test Dispatch
            </h3>
            <p class="onboarding-wizard-panel-description">
              Send a test message to verify agent routing and dispatch are working correctly.
            </p>
            <button class="onboarding-wizard-help-tooltip" data-onb-action="show-tooltip" data-arg="test">
    What happens here?
            </button>
          </div>
          <div class="onboarding-test-display">
            <div class="onboarding-test-display-header">
              <div class="onboarding-test-display-icon">
                <span>✎</span>
              </div>
              <div class="onboarding-test-display-title">Test Message</div>
            </div>
            <div class="onboarding-test-message">
              Each agent was already validated individually in the previous step. This sends one message through the full routing pipeline — selection, dispatch, and response handling — to prove the system works end to end.
            </div>
            ${(currentState.agentData.agents || []).length > 1 ? `
            <div style="margin:8px 0">
              <label for="onboarding-test-agent" style="font-size:12px;display:block;margin-bottom:4px">Test with agent</label>
              <select id="onboarding-test-agent" class="settings-select" style="width:100%">
                <option value="">Auto (prefers a validated agent)</option>
                ${(currentState.agentData.agents || []).map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name || a.id)}</option>`).join('')}
              </select>
            </div>` : ''}
            <div class="onboarding-test-status">
              <div class="status-dot pending"></div>
              <span>Ready to send test message. Click "Continue" to run it.</span>
            </div>
          </div>
        </div>
      `;
    }

    // Test in progress - show spinner
    if (testResult.inProgress) {
      return `
        <div class="onboarding-wizard-panel visible" data-step="test">
          <div class="onboarding-wizard-panel-header">
            <h3 class="onboarding-wizard-panel-title">
Test Dispatch
            </h3>
            <p class="onboarding-wizard-panel-description">
              Running test dispatch...
            </p>
          </div>
          <div class="onboarding-test-display">
            <div class="wizard-loading">
              <div class="wizard-spinner"></div>
            </div>
            <div class="onboarding-test-status" style="text-align: center; margin-top: 16px;">
              <div class="status-dot pending" style="margin: 0 auto 8px;"></div>
              <span>Dispatching test message through routing system...</span>
            </div>
          </div>
        </div>
      `;
    }

    const isSuccess = testResult.success === true;
    const statusClass = isSuccess ? 'success' : 'error';
    const statusIcon = isSuccess ? '✓' : '✗';

    // Build audit details HTML for success case.
    // The API returns selectedAgent as the agent ID (string) and
    // routingDecision as a human-readable string — this renderer assumed
    // objects and printed "undefined". Resolve the ID against the loaded
    // roster for name/provider/model; keep object support for robustness.
    let auditDetailsHtml = '';
    if (isSuccess && testResult.selectedAgent) {
      const raw = testResult.selectedAgent;
      const roster = currentState.agentData.agents || [];
      const agent = typeof raw === 'string'
        ? (roster.find(a => a.id === raw) || { id: raw })
        : raw;
      const routing = (testResult.routingDecision && typeof testResult.routingDecision === 'object')
        ? testResult.routingDecision
        : { reason: testResult.routingDecision || null };

      auditDetailsHtml = `
        <div class="onboarding-audit-section">
          <h4 class="onboarding-audit-title">Dispatch Audit Record</h4>

          <div class="onboarding-audit-field">
            <div class="audit-label">Selected Agent:</div>
            <div class="audit-value">
              <strong>${agent.name || agent.id}</strong>
              ${agent.provider ? `<span class="agent-provider-badge">${agent.provider}</span>` : ''}
              ${agent.model ? `<span class="audit-model">(${agent.model})</span>` : ''}
            </div>
          </div>

          ${routing.reason ? `
            <div class="onboarding-audit-field">
              <div class="audit-label">Selection Reason:</div>
              <div class="audit-value">${routing.reason}</div>
            </div>
          ` : ''}

          ${routing.weights && Object.keys(routing.weights).length > 0 ? `
            <div class="onboarding-audit-field">
              <div class="audit-label">Routing Weights:</div>
              <div class="audit-value audit-weights">
                ${Object.entries(routing.weights).map(([agentId, weight]) => `
                  <div class="weight-item">
                    <span class="weight-agent">${agentId}:</span>
                    <span class="weight-value">${typeof weight === 'number' ? weight.toFixed(3) : weight}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          ${routing.constraints && routing.constraints.length > 0 ? `
            <div class="onboarding-audit-field">
              <div class="audit-label">Constraints Applied:</div>
              <div class="audit-value">
                <ul class="audit-constraints-list">
                  ${routing.constraints.map(c => `<li>${c}</li>`).join('')}
                </ul>
              </div>
            </div>
          ` : ''}

          ${testResult.dispatchId ? `
            <div class="onboarding-audit-field">
              <div class="audit-label">Dispatch ID:</div>
              <div class="audit-value"><code>${testResult.dispatchId}</code></div>
            </div>
          ` : ''}
        </div>
      `;
    }

    // Build error details HTML for failure case
    let errorDetailsHtml = '';
    if (!isSuccess && testResult.classifiedError) {
      const err = testResult.classifiedError;
      errorDetailsHtml = `
        <div class="onboarding-error-section">
          <div class="onboarding-error-header">
            <span class="error-icon">!</span>
<div>
              <div class="error-category">${err.category || 'error'}</div>
              <div class="error-message">${err.message || testResult.error}</div>
            </div>
          </div>
          ${err.suggestedFix ? `
            <div class="onboarding-error-fix">
              <div class="fix-label">Suggested Fix:</div>
              <div class="fix-content">${err.suggestedFix}</div>
            </div>
          ` : ''}
          <div class="onboarding-error-actions">
            <button class="onboarding-btn onboarding-btn-primary" data-onb-action="run-test">
              Retry Test
            </button>
          </div>
        </div>
      `;
    }

    return `
      <div class="onboarding-wizard-panel visible" data-step="test">
        <div class="onboarding-wizard-panel-header">
          <h3 class="onboarding-wizard-panel-title">
Test Dispatch Result
          </h3>
          <p class="onboarding-wizard-panel-description">
            ${isSuccess ? 'Agent successfully processed the test message!' : 'Test failed. Review the error below.'}
          </p>
        </div>
        <div class="onboarding-test-display">
          <div class="onboarding-test-display-header">
            <div class="onboarding-test-display-icon ${statusClass}">
              <span>${statusIcon}</span>
            </div>
            <div class="onboarding-test-display-title">${isSuccess ? 'Test Successful' : 'Test Failed'}</div>
          </div>

          ${isSuccess ? `
            <div class="onboarding-test-result ${statusClass}">
              <div class="result-title ${statusClass}">
                Agent responded correctly
              </div>
              ${testResult.response ? `
                <div class="result-detail">
                  <strong>Response:</strong><br>
                  <div class="response-content">${escapeHtml(testResult.response)}</div>
                </div>
              ` : ''}
              ${testResult.duration ? `
                <div class="result-detail" style="margin-top: 8px;">
                  <strong>Duration:</strong> ${testResult.duration}ms
                </div>
              ` : ''}
            </div>
            ${auditDetailsHtml}
          ` : `
            <div class="onboarding-test-result ${statusClass}">
              <div class="result-title ${statusClass}">
                ❌ ${testResult.error || 'Test failed'}
              </div>
            </div>
            ${errorDetailsHtml}
          `}
        </div>
      </div>
    `;
  }

  /**
   * First Project step — guided starter templates (fun build prompts from
   * community genres, with shout-out credits when a template adopts
   * someone's shared prompt) or Custom (expert) for a blank name + vision.
   */
  function renderProjectPanel() {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const templates = currentState.projectTemplates;
    const createdName = currentState.firstProject?.displayName;

    let bodyHtml;
    if (createdName) {
      bodyHtml = `
        <div class="onboarding-validation-card">
          <div class="onboarding-validation-card-header">
            <div class="onboarding-validation-card-icon success"><span>✓</span></div>
            <div>
              <div class="onboarding-validation-card-title">${esc(createdName)}</div>
              <div class="onboarding-validation-card-status">Project created — vision is set. Your agents pick it up from here; continue to finish.</div>
            </div>
          </div>
        </div>`;
    } else if (!templates) {
      bodyHtml = '<div class="onboarding-validation-card-details">Loading starter projects…</div>';
    } else if (currentState.showCustomProject) {
      bodyHtml = `
        <div class="onboarding-validation-card">
          <div class="onboarding-validation-card-header">
            <div class="onboarding-validation-card-icon pending"><span>✎</span></div>
            <div>
              <div class="onboarding-validation-card-title">Custom project (expert)</div>
              <div class="onboarding-validation-card-status">Name it and write the vision your agents will build toward</div>
            </div>
          </div>
          <div class="onboarding-validation-card-details" style="margin-top:8px">
            <input id="onboarding-custom-project-name" type="text" placeholder="Project name (e.g. my-tool)" maxlength="40"
                   style="width:100%;margin-bottom:8px;padding:6px 8px">
            <textarea id="onboarding-custom-project-vision" rows="5" placeholder="What should the agents build? Concrete deliverables work best."
                      style="width:100%;padding:6px 8px"></textarea>
          </div>
          <div class="onboarding-validation-card-actions" style="margin-top:10px">
            <button class="onboarding-btn onboarding-btn-primary" data-onb-action="create-custom-project">Create project</button>
            <button class="onboarding-btn onboarding-btn-secondary" data-onb-action="toggle-custom" data-arg="false">← Back to starters</button>
          </div>
        </div>`;
    } else {
      bodyHtml = `
        ${templates.map((t, i) => `
          <div class="onboarding-validation-card" style="cursor:pointer" data-onb-action="choose-template" data-arg="${i}">
            <div class="onboarding-validation-card-header">
              <div class="onboarding-validation-card-icon pending"><span>${esc((t.title || '?').charAt(0))}</span></div>
              <div>
                <div class="onboarding-validation-card-title">${esc(t.title)}</div>
                <div class="onboarding-validation-card-status">${esc(t.tagline)}</div>
              </div>
            </div>
            ${t.credit ? `<div class="onboarding-validation-card-details" style="opacity:.7">Prompt by ${esc(t.credit.handle)}${t.credit.note ? ` — ${esc(t.credit.note)}` : (t.credit.url ? ` — ${esc(t.credit.url)}` : '')}</div>` : ''}
          </div>`).join('')}
        <div class="onboarding-validation-card" style="cursor:pointer" data-onb-action="toggle-custom" data-arg="true">
          <div class="onboarding-validation-card-header">
            <div class="onboarding-validation-card-icon pending"><span>✎</span></div>
            <div>
              <div class="onboarding-validation-card-title">Custom (expert)</div>
              <div class="onboarding-validation-card-status">Blank project — bring your own vision</div>
            </div>
          </div>
        </div>`;
    }

    return `
      <div class="onboarding-wizard-panel visible" data-step="project">
        <div class="onboarding-wizard-panel-header">
          <h3 class="onboarding-wizard-panel-title">First Project</h3>
          <p class="onboarding-wizard-panel-description">
            Pick something fun to point your agents at — or go custom if you already know what you're building.
          </p>
        </div>
        <div class="onboarding-validation-cards">${bodyHtml}</div>
      </div>
    `;
  }

  function loadProjectTemplates() {
    fetch('/api/onboarding/project-templates', { headers: authHeaders() })
      .then(r => r.json())
      .then(data => {
        currentState.projectTemplates = Array.isArray(data.templates) ? data.templates : [];
        if (STEPS[currentState.currentStep].id === 'project') renderCurrentPanel();
      })
      .catch(() => { currentState.projectTemplates = []; });
  }

  function toggleCustomProject(show) {
    currentState.showCustomProject = !!show;
    renderCurrentPanel();
  }

  async function chooseTemplate(idx) {
    const t = (currentState.projectTemplates || [])[idx];
    if (!t) return;
    await createFirstProject(t.id, t.title, t.vision);
  }

  async function createCustomProject() {
    const name = document.getElementById('onboarding-custom-project-name')?.value.trim();
    const vision = document.getElementById('onboarding-custom-project-vision')?.value.trim();
    if (!name) { showToast('Give the project a name', 'error'); return; }
    if (!vision) { showToast('Write a vision — it is what your agents build toward', 'error'); return; }
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'project';
    await createFirstProject(id, name, vision);
  }

  async function createFirstProject(baseId, displayName, vision) {
    try {
      // Create (suffix the id on collision) then set the vision.
      let id = baseId, resp, attempt = 0;
      for (;;) {
        resp = await fetch('/api/projects', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          // mode 'continuous': the strategist generates campaigns from the
          // vision automatically. The default ('static') waits for MANUAL
          // campaign creation — a first project whose vision never turned
          // into work broke the wizard's whole promise (found live: four
          // template projects sat inert while csvtool, created 'continuous'
          // by the test harness, built happily).
          // firstBuildHold: after the FIRST campaign completes, the project
          // flips to static and the user is told where to review the result
          // — instead of silently rolling into perpetual improvement.
          // agents: null = explicitly ALL agents — the wizard's step-1 roster
          // IS the whole install, so the first project belongs to all of it.
          // (Roster choice is required at creation; see operator ruling.)
          body: JSON.stringify({ id, displayName, mode: 'continuous', firstBuildHold: true, agents: null }),
        });
        if (resp.status !== 400 || attempt >= 3) break;
        const errBody = await resp.json().catch(() => ({}));
        if (!/exist/i.test(errBody.error || '')) { showToast(errBody.error || 'Could not create project', 'error'); return; }
        attempt++; id = `${baseId}-${attempt + 1}`;
      }
      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        showToast(errBody.error || `Could not create project (HTTP ${resp.status})`, 'error');
        return;
      }
      const vResp = await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ vision }),
      });
      if (!vResp.ok) showToast('Project created, but setting the vision failed — set it from the sidebar', 'error');
      currentState.firstProject = { id, displayName };
      if (!currentState.completedSteps.includes('project')) currentState.completedSteps.push('project');
      saveProgress();
      showToast(`Project "${displayName}" created`, 'success');
      renderCurrentPanel();
      renderFooter();
    } catch (e) {
      showToast(`Could not create project: ${e.message}`, 'error');
    }
  }

  /**
   * Render completion panel
   */
  function renderCompletePanel() {
    return `
      <div class="onboarding-wizard-panel visible" data-step="complete">
        <div class="onboarding-completion">
          <div class="onboarding-completion-wordmark" aria-hidden="true">SYNAPSE</div>
          <h3 class="onboarding-completion-title">Onboarding Complete!</h3>
          <p class="onboarding-completion-description">
            Your Synapse agents are validated and configured. You're ready to start using Synapse.
          </p>
          <div class="onboarding-completion-actions">
            <button class="onboarding-btn onboarding-btn-primary" data-onb-action="close">
              Start Using Synapse
            </button>
            <button class="onboarding-btn onboarding-btn-secondary" data-onb-action="reset">
              Reset Onboarding
            </button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render footer buttons
   */
  function renderFooter() {
    const stepIndex = currentState.currentStep;
    const isLastStep = stepIndex === STEPS.length - 1;
    const isFirstStep = stepIndex === 0;

    // Update progress indicator
    if (dom.footerProgress) {
      dom.footerProgress.innerHTML = `
        <span class="progress-current">${stepIndex + 1}</span>
        <span class="progress-total">/ ${STEPS.length}</span>
      `;
    }

    // Hide the footer button row on the Done step. The complete panel
    // already has "Start Using Synapse" + "Reset Onboarding" CTAs;
    // showing Skip/Back/Finish in the footer too produced two buttons
    // that did the same thing (Finish === Start Using Synapse).
    if (dom.footerActions) {
      dom.footerActions.style.display = isLastStep ? 'none' : '';
    }

    // Update buttons
    if (dom.prevBtn) {
      dom.prevBtn.disabled = isFirstStep;
    }

    if (dom.nextBtn) {
      const currentStepId = STEPS[stepIndex].id;
      let canProceed = true;
      let blockingFailures = [];

      // Validation step: can only proceed if all validations pass OR user explicitly skipped
      if (currentStepId === 'validate') {
        const agents = currentState.agentData.agents || [];
        
        // Check if user explicitly skipped this step
        const wasSkipped = currentState.completedSteps.includes('validate') && 
                          currentState.currentStep > 0;
        
        if (!wasSkipped) {
          // Count failures
          const failures = agents.filter(a => {
            const result = currentState.validationResults[a.id] || {};
            return result.overallStatus === 'fail' || result.status === 'error';
          });
          
          blockingFailures = failures;
          
          // Can only proceed if all validations pass or are skipped
          canProceed = agents.every(a => {
            const result = currentState.validationResults[a.id] || {};
            return result.complete === true || result.status === 'skip';
          });
        }
      }

      // Test step: can only proceed if test hasn't been run or was successful
      if (currentStepId === 'test') {
        if (currentState.testResult) {
          canProceed = currentState.testResult.success === true;
        } else {
          canProceed = true;
        }
      }

      dom.nextBtn.disabled = !canProceed;
      dom.nextBtn.textContent = isLastStep ? 'Finish' : 'Continue';
      
      // Update Next button title to show blocking failures if any
      if (currentStepId === 'validate' && blockingFailures.length > 0 && !canProceed) {
        dom.nextBtn.title = `${blockingFailures.length} validation${blockingFailures.length > 1 ? 's' : ''} failed. Fix issues or click Skip to continue.`;
      } else {
        dom.nextBtn.title = '';
      }
    }

    // Skip should always be available — its handler at line ~884 explicitly
    // handles every step including 0. Disabling it on step 0 contradicts the
    // handler and traps users on the validate step when they want to bypass it
    // (e.g. validation is slow or unauthenticated).
    if (dom.skipBtn) {
      dom.skipBtn.disabled = false;
    }
  }

  /**
   * Bind event handlers
   */
  function bindEvents() {
    if (!dom.wizard) return;

    // Delegated dispatch for buttons the wizard renders as HTML strings.
    // Inline onclick attributes are blocked by the CSP (script-src has no
    // 'unsafe-inline'), so rendered controls carry data-onb-action (+ data-arg
    // where a value is needed). Bound on the wizard root: bindEvents runs once
    // per cacheElements pass, and scoping to the wizard keeps re-binding safe.
    dom.wizard.addEventListener('click', (e) => {
      const el = e.target.closest('[data-onb-action]');
      if (!el || !dom.wizard.contains(el)) return;
      const arg = el.dataset.arg;
      switch (el.dataset.onbAction) {
        case 'goto-step': goToStep(Number(el.dataset.stepIndex)); break;
        case 'create-selected': createSelectedAgents(); break;
        case 'open-first-agent-form': openFirstAgentForm(); break;
        case 'retry-validation': retryValidation(arg); break;
        case 'show-tooltip': showTooltip(arg); break;
        case 'run-test': runTest(); break;
        case 'create-custom-project': createCustomProject(); break;
        case 'toggle-custom': toggleCustomProject(arg === 'true'); break;
        case 'choose-template': chooseTemplate(Number(arg)); break;
        case 'close': close(); break;
        case 'reset': reset(); break;
      }
    });

    // Close button
    if (dom.closeBtn) {
      dom.closeBtn.addEventListener('click', () => SynapseOnboarding.close());
    }

    // Previous button
    if (dom.prevBtn) {
      dom.prevBtn.addEventListener('click', () => {
        if (currentState.currentStep > 0) {
          goToStep(currentState.currentStep - 1);
        }
      });
    }

    // Next button. If the current step is already completed, ADVANCE —
    // previously this only ever re-ran the step's action, so with ≥1 agent
    // the wizard could never move forward except via Skip (re-running the
    // live test dispatch on every click of "Continue").
    if (dom.nextBtn) {
      dom.nextBtn.addEventListener('click', () => {
        const currentStepId = STEPS[currentState.currentStep].id;

        if (currentStepId !== 'complete' && currentState.completedSteps.includes(currentStepId)) {
          currentState.currentStep = Math.min(currentState.currentStep + 1, STEPS.length - 1);
          saveProgress();
          render();
          return;
        }

        switch (currentStepId) {
          case 'validate':
            SynapseOnboarding.runValidation();
            break;
          case 'project':
            showToast('Pick a starter project, go Custom, or use Skip', 'info');
            break;
          case 'test':
            SynapseOnboarding.runTest();
            break;
          case 'complete':
            SynapseOnboarding.close();
            break;
        }
      });
    }

    // Skip button — generic: mark the current step complete and advance.
    // (Was index-hardcoded; adding the project step made that a trap.)
    if (dom.skipBtn) {
      dom.skipBtn.addEventListener('click', () => {
        const stepId = STEPS[currentState.currentStep].id;
        if (stepId === 'complete') return;
        if (!currentState.completedSteps.includes(stepId)) {
          currentState.completedSteps.push(stepId);
        }
        currentState.currentStep = Math.min(currentState.currentStep + 1, STEPS.length - 1);
        saveProgress();
        render();
      });
    }

    // Escape hides for this session only — permanent dismissal is reserved
    // for the explicit ✕ / "Start Using Synapse" actions.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dom.wizard?.classList.contains('visible')) {
        close({ persist: false });
      }
    });
  }

  /**
   * Go to a specific step
   */
  function goToStep(stepIndex) {
    if (stepIndex < 0 || stepIndex >= STEPS.length) return;
    if (stepIndex > currentState.currentStep && !currentState.completedSteps.includes(STEPS[stepIndex].id)) {
      // Cannot jump ahead without completing steps
      return;
    }

    currentState.currentStep = stepIndex;
    saveProgress();
    render();
  }

  /**
   * Run agent validation
   * Uses async validation via WebSocket events for real-time updates
   */
  async function runValidation() {
    const nextBtn = dom.nextBtn;
    if (nextBtn) {
      nextBtn.disabled = true;
      nextBtn.textContent = 'Validating...';
    }

    try {
      // Fetch agents from API
      const response = await fetch('/api/agents', { headers: authHeaders() });
      const agents = await response.json();

      currentState.agentData.agents = agents;

      // Clear previous validation results
      currentState.validationResults = {};
      currentState.inFlightValidations = {};
      currentState.asyncValidationPromises = {};

      // Empty-state: nothing to validate. Mark this step complete and advance
      // to test (now step 1 since the configure step was removed).
      // No agents → runTest will also auto-skip itself, so the user lands on
      // Done after one more click rather than getting stuck on a spinner.
      if (!Array.isArray(agents) || agents.length === 0) {
        if (!currentState.completedSteps.includes('validate')) {
          currentState.completedSteps.push('validate');
        }
        currentState.currentStep = 1;
        saveProgress();
        render();
        return;
      }

      // Render initial pending state for all agents.
      // renderValidationPanel() returns HTML — by itself it doesn't touch the
      // DOM. renderCurrentPanel() removes existing panels and appends the
      // freshly-rendered one, which is what we actually need so per-agent
      // updateValidationCard() calls can find each agent's data-agent-id.
      renderCurrentPanel();

      // Validate agents SEQUENTIALLY. Parallel validation fired every
      // canary at once: same-provider agents collided with the sandbox's
      // per-provider/per-agent process caps and shared local backends
      // serialized anyway — three healthy agents reported "Validation
      // failed" purely from the stampede. Setup is a one-time step;
      // one-at-a-time is slower but tells the truth.
      for (const agent of agents) {
        currentState.inFlightValidations[agent.id] = true;
        updateValidationCard(dom.wizard?.querySelector(`[data-agent-id="${agent.id}"]`), { status: 'validating' });

        try {
          const validateResponse = await fetch(`/api/agents/${agent.id}/validate`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ skipCanary: false })
          });

          if (validateResponse.status === 409) {
            // A validation for this agent is already in flight (duplicate
            // request: browser retry after a dropped socket, double-click…).
            // The running validation is the truth — leave the card in its
            // validating state and let the validation:complete WS event
            // finish it. Painting this as an error showed "failed: 409"
            // over canaries that went on to pass.
            continue;
          }
          if (!validateResponse.ok) {
            throw new Error(`Validation request failed: ${validateResponse.status}`);
          }

          // The POST resolves with the full result; WebSocket events also
          // stream per-step updates in parallel.
          currentState.asyncValidationPromises[agent.id] = validateResponse.json();
          await currentState.asyncValidationPromises[agent.id];
        } catch (e) {
          currentState.validationResults[agent.id] = {
            agentId: agent.id,
            status: 'error',
            error: e.message,
            overallStatus: 'fail',
            complete: false
          };
          delete currentState.inFlightValidations[agent.id];
          delete currentState.asyncValidationPromises[agent.id];
          updateValidationCard(dom.wizard?.querySelector(`[data-agent-id="${agent.id}"]`), currentState.validationResults[agent.id]);
        }
      }

      // Validation results will arrive via WebSocket validation:complete events
      // The handleValidationComplete function will update the UI in real-time

    } catch (error) {
      console.error('Validation failed:', error);
      showToast('Failed to start validation', 'error');
      if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.textContent = 'Retry Validation';
      }
    }
  }

  /**
   * Run test dispatch
   */
  async function runTest() {
    const nextBtn = dom.nextBtn;

    // No agents → nothing to dispatch to. Mark complete and advance to Done so
    // the user finishes the tour rather than hitting a network error from
    // /api/onboarding/test-dispatch. Direct assignment bypasses goToStep's
    // "can't jump ahead" guard, which blocks forward motion when the
    // destination step isn't yet in completedSteps.
    const agents = currentState.agentData.agents || [];
    if (agents.length === 0) {
      if (!currentState.completedSteps.includes('test')) {
        currentState.completedSteps.push('test');
      }
      currentState.testResult = { success: true, skipped: true };
      currentState.currentStep = STEPS.findIndex(s => s.id === 'complete');
      saveProgress();
      render();
      return;
    }

    if (nextBtn) {
      nextBtn.disabled = true;
      nextBtn.textContent = 'Running Test...';
    }

    // Read the operator's agent choice BEFORE re-rendering: the spinner
    // render destroys the dropdown, so reading after it silently discarded
    // every selection and the dispatch fell through to first-available.
    const chosenAgent = document.getElementById('onboarding-test-agent')?.value || undefined;

    // Show spinner in the test panel
    currentState.testResult = { inProgress: true };
    renderCurrentPanel();

    try {
      const response = await fetch('/api/onboarding/test-dispatch', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          prompt: 'Hello! This is a test dispatch to verify the agent is working correctly.',
          agentId: chosenAgent
        })
      });

      const result = await response.json();

      if (response.ok && result.success) {
        // Success case with audit details
        currentState.testResult = {
          success: true,
          dispatchId: result.dispatchId,
          selectedAgent: result.selectedAgent,
          routingDecision: result.routingDecision,
          response: result.response || result.message,
          duration: result.duration,
          timestamp: result.timestamp || new Date().toISOString()
        };

        // Mark step as complete
        if (!currentState.completedSteps.includes('test')) {
          currentState.completedSteps.push('test');
        }

        saveProgress();
        renderCurrentPanel();
        renderFooter();

        // Enable next button
        if (nextBtn) {
          nextBtn.disabled = false;
          nextBtn.textContent = 'Continue';
        }
      } else {
        // Failure case with classified error
        currentState.testResult = {
          success: false,
          error: result.error || 'Test dispatch failed',
          classifiedError: result.classifiedError || null,
          timestamp: result.timestamp || new Date().toISOString()
        };

        renderCurrentPanel();
        renderFooter();

        if (nextBtn) {
          nextBtn.disabled = false;
          nextBtn.textContent = 'Retry Test';
        }
      }
    } catch (error) {
      console.error('Test dispatch failed:', error);
      currentState.testResult = {
        success: false,
        error: error.message || 'Network error - could not reach server',
        classifiedError: {
          category: 'network',
          message: 'Failed to connect to the dispatch system',
          suggestedFix: 'Check that the Synapse server is running and accessible.'
        },
        timestamp: new Date().toISOString()
      };

      renderCurrentPanel();
      renderFooter();

      if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.textContent = 'Retry Test';
      }
    }
  }

  /**
   * Show contextual tooltip
   */
  function showTooltip(stepId) {
    const tooltips = {
      validate: 'Validation checks that each agent is installed, authenticated, and can execute commands. Failed validations show actionable fixes.',
      test: 'A test dispatch sends a simple /test command to verify the agent can receive and respond to messages before you start using it.'
    };

    const tooltip = tooltips[stepId];
    if (tooltip) {
      showToast(tooltip, 'info', 5000);
    }
  }

  /**
   * Close the wizard
   */
  function close({ persist = true } = {}) {
    if (dom.wizard) {
      dom.wizard.classList.remove('visible');
    }
    // Persist dismissal so wizard does not reappear on next page load.
    // Escape passes persist:false — an accidental keypress must not
    // permanently bury the wizard (there is no re-opener in the header).
    if (persist) localStorage.setItem('synapse_onboarding_dismissed', '1');
  }

  /**
   * Reset onboarding progress
   */
  function reset() {
    resetProgress();
    // A reset is an explicit "start over" — un-bury the wizard too.
    localStorage.removeItem('synapse_onboarding_dismissed');
    currentState.currentStep = 0;
    render();
  }

  /**
   * Show toast notification
   */
  function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // Expose public API
  // ── First-agent builder helpers (0-agent onboarding path) ───────────

  /** Fetch which coding-agent CLIs the host has; re-render when known. */
  function loadDetectedHarnesses() {
    fetch('/api/harnesses/detected', { headers: authHeaders() })
      .then(r => r.json())
      .then(data => {
        currentState.detectedHarnesses = Array.isArray(data.harnesses) ? data.harnesses : [];
        if (currentState.currentStep === 0) renderCurrentPanel();
      })
      .catch(() => { currentState.detectedHarnesses = []; });
  }

  /**
   * Populate each offer row's model <select> with the harness's LIVE model
   * list (queried from the harness when it supports listing, static
   * defaults otherwise). Selection is preserved; options just appear.
   */
  function loadOfferModelLists(harnessIds) {
    for (const hid of harnessIds) {
      fetch(`/api/harnesses/${encodeURIComponent(hid)}/models`, { headers: authHeaders() })
        .then(r => r.json())
        .then(data => {
          const models = Array.isArray(data.models) ? data.models : [];
          if (!models.length) return;
          dom.wizard?.querySelectorAll(`.onboarding-offer-model[data-harness-id="${hid}"]`).forEach(sel => {
            const have = new Set([...sel.options].map(o => o.value));
            for (const m of models) {
              if (have.has(m)) continue;
              const opt = document.createElement('option');
              opt.value = m;
              opt.textContent = data.source === 'queried' ? m : `${m} (default)`;
              sel.appendChild(opt);
            }
          });
        })
        .catch(() => { /* static option already rendered */ });
    }
  }

  /**
   * Create agents from the checked config-scan offers. Names are suggested
   * per provider and uniquified; the model comes from the row's <select> —
   * the user's pick from the harness's own model list. Flows into
   * startRosterWatch() → validation, same as the manual path.
   */
  async function createSelectedAgents() {
    const offers = currentState.agentOffers || [];
    const checked = [...(dom.wizard?.querySelectorAll('.onboarding-offer-cb:checked') || [])]
      .map(cb => {
        const idx = Number(cb.dataset.offerIdx);
        const offer = offers[idx];
        if (!offer) return null;
        // The row's <select> holds the user's model pick (defaults to the
        // offer's config-sourced model).
        const sel = dom.wizard?.querySelector(`.onboarding-offer-model[data-offer-idx="${idx}"]`);
        return { ...offer, model: sel?.value || offer.model };
      })
      .filter(Boolean);
    if (checked.length === 0) {
      showToast('Select at least one agent to create', 'error');
      return;
    }
    const NAME_BY_PROVIDER = { claude: 'Claude', codex: 'Codex', gemini: 'Gem', glm: 'Glm', opencode: 'Local', pi: 'Pi', omp: 'Omp' };
    // Seed with the EXISTING roster — offers can be used with agents already
    // present (wizard re-run, partial rosters); without this every suggested
    // name collides with its previous incarnation and all creates 400.
    const used = new Set();
    try {
      const existing = await fetch('/api/agents', { headers: authHeaders() }).then(r => r.json());
      for (const a of (Array.isArray(existing) ? existing : [])) {
        if (a?.id) used.add(String(a.id).toLowerCase());
        if (a?.name) used.add(String(a.name).toLowerCase());
      }
    } catch { /* best-effort; the server still rejects true duplicates */ }
    let created = 0, failed = 0;
    for (const offer of checked) {
      let base = NAME_BY_PROVIDER[offer.provider] || offer.provider.slice(0, 10);
      let name = base, n = 2;
      while (used.has(name.toLowerCase())) name = `${base}${n++}`;
      used.add(name.toLowerCase());
      try {
        const resp = await fetch('/api/agents', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ id: name.toLowerCase(), name, provider: offer.provider, model: offer.model }),
        });
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `HTTP ${resp.status}`);
        created++;
      } catch (e) {
        failed++;
        console.error(`Create agent failed (${offer.provider}/${offer.model}):`, e);
        showToast(`Could not create ${name}: ${e.message}`, 'error');
      }
    }
    if (created > 0) {
      showToast(`Created ${created} agent${created > 1 ? 's' : ''}${failed ? ` (${failed} failed)` : ''}`, 'success');
      startRosterWatch();
    }
  }

  /** Open the existing create-agent modal in create mode. */
  function openFirstAgentForm() {
    if (window.SynapseAgents?.openAgentSettings) {
      window.SynapseAgents.openAgentSettings(null);
      // The shared modal ships at z-index 100; the wizard overlay sits at
      // 2000 — without this lift the form opens INVISIBLY underneath it.
      const m = document.getElementById('modal-agent-settings');
      if (m) m.style.zIndex = '2100';
    } else if (window.SynapseMessages?.showToast) {
      window.SynapseMessages.showToast('Agent form unavailable — use the + button in the header', 'error');
    }
  }

  let rosterWatchTimer = null;

  /**
   * While the wizard sits on the 0-agent builder, poll the roster; the
   * moment the first agent exists, preload it and flow into validation —
   * the user never has to find their way back to the wizard.
   */
  function startRosterWatch() {
    if (rosterWatchTimer) return;
    rosterWatchTimer = setInterval(() => {
      const wizardVisible = dom.wizard?.classList.contains('visible');
      if (!wizardVisible) { clearInterval(rosterWatchTimer); rosterWatchTimer = null; return; }
      fetch('/api/agents', { headers: authHeaders() })
        .then(r => r.json())
        .then(agents => {
          if (!Array.isArray(agents) || agents.length === 0) return;
          // Wait for the creation-time INTRODUCTION dispatch to settle
          // (status 'registered' → active/failed) before validating —
          // firing the canary alongside the introduction collides on
          // per-agent exclusivity and one of them spuriously fails.
          const settling = agents.some(a => a.status === 'registered' || a.status === 'introducing');
          currentState.agentData.agents = agents;
          renderCurrentPanel();
          if (settling) return;
          clearInterval(rosterWatchTimer);
          rosterWatchTimer = null;
          renderFooter();
          runValidation();
        })
        .catch(() => { /* keep polling */ });
    }, 3000);
  }

  window.SynapseOnboarding = {
    init,
    goToStep,
    runValidation,
    retryValidation,
    runTest,
    showTooltip,
    close,
    reset,
    handleValidationComplete,
    openFirstAgentForm,
    createSelectedAgents,
    chooseTemplate,
    createCustomProject,
    toggleCustomProject
  };

  /**
   * Retry validation for a specific agent
   * @param {string} agentId - The agent ID to retry
   */
  async function retryValidation(agentId) {
    // The roster may have changed since this panel rendered (agent edited
    // or deleted via the header/API). Re-sync before revalidating —
    // otherwise we revalidate a ghost and gate Continue on a 404 card.
    try {
      const rosterResp = await fetch('/api/agents', { headers: authHeaders() });
      const roster = await rosterResp.json();
      if (Array.isArray(roster)) {
        currentState.agentData.agents = roster;
        if (!roster.some(a => a.id === agentId)) {
          // Agent is gone — drop its ghost card and let the footer gate
          // recompute against the real roster.
          delete currentState.validationResults[agentId];
          delete currentState.inFlightValidations[agentId];
          saveProgress();
          renderCurrentPanel();
          renderFooter();
          return;
        }
      }
    } catch { /* API hiccup — fall through to the plain retry */ }

    const agentCard = dom.wizard?.querySelector(`[data-agent-id="${agentId}"]`);
    if (!agentCard) return;

    // Update card to show retry state
    const iconEl = agentCard.querySelector('.onboarding-validation-card-icon');
    if (iconEl) {
      iconEl.className = 'onboarding-validation-card-icon pending';
      iconEl.innerHTML = '<span>•</span>';
    }

    const statusEl = agentCard.querySelector('.onboarding-validation-card-status');
    if (statusEl) {
      statusEl.textContent = 'Retrying...';
    }

    try {
      // Clear previous result
      delete currentState.validationResults[agentId];
      currentState.inFlightValidations[agentId] = true;

      // Start validation
      const response = await fetch(`/api/agents/${agentId}/validate`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ skipCanary: false })
      });

      if (response.status === 409) {
        // Already validating (duplicate request) — the in-flight run is the
        // truth; keep the retrying state and let the WS completion land.
        return;
      }
      if (!response.ok) {
        throw new Error(`Validation request failed: ${response.status}`);
      }

      // Store promise for WebSocket resolution
      currentState.asyncValidationPromises[agentId] = response.json();

    } catch (error) {
      console.error(`Retry validation failed for ${agentId}:`, error);
      currentState.validationResults[agentId] = {
        agentId,
        status: 'error',
        error: error.message,
        overallStatus: 'fail',
        complete: false
      };
      delete currentState.inFlightValidations[agentId];
      delete currentState.asyncValidationPromises[agentId];
      updateValidationCard(agentCard, currentState.validationResults[agentId]);
    }
  }

  // Initialization is coordinated by main.js's DOMContentLoaded handler,
  // which calls SynapseOnboarding.init() in dependency order. Calling init()
  // here too caused bindEvents() to attach the click listener twice — every
  // single click on Continue then advanced the wizard *two* steps because the
  // handlers ran in sequence and each read the (already-mutated) currentStep.

})();