/**
 * main.js — ES Module Entry Point
 *
 * Orchestrates initialization of all Synapse UI modules in correct dependency
 * order. Contains NO business logic — only initialization sequencing.
 *
 * Load order (IIFE scripts must be loaded before this module via <script> tags
 * in index.html, or imported here as side-effect imports):
 *
 *   Phase 1 — Standalone UI (no deps):
 *     theme.js      → window.SynapseTheme
 *     sidebar.js    → window.SynapseSidebar
 *
 *   Phase 2 — Core Infrastructure:
 *     health.js     → window.SynapseHealth   (provides escapeHtml, formatters)
 *     agents.js     → window.SynapseAgents   (needs health utilities)
 *     budget.js     → window.SynapseBudget   (needs health.escapeHtml)
 *     guardrails.js → window.SynapseGuardrails (needs health utilities)
 *     checkpoints.js → window.SynapseCheckpoints (needs guardrails)
 *     (routing-storage/timeline/routing-outcomes/routing-audit/
 *      routing-analytics were removed in the dead-UI cleanup — their panels'
 *      markup was stripped from index.html in the dashboard consolidation)
 *     analytics-dashboard.js → window.SynapseAnalyticsDashboard (needs health utilities)
 *
 *   Phase 3 — Message & Task Systems:
 *     messages.js   → window.SynapseMessages (needs agents.agentColors)
 *     tasks.js      → window.SynapseTasks    (needs health utilities)
 *     campaigns.js  → window.SynapseCampaigns (needs tasks + health)
 *
 *   Phase 4 — Input & Modals:
 *     input.js      → window.SynapseInput    (needs messages + agents)
 *     modal-base.js → window.SynapseModalBase (standalone reusable component)
 *     modals.js     → window.SynapseModals   (needs input + health + modal-base)
 *     onboarding.js → window.SynapseOnboarding (needs modals + websocket)
 *
 *   Phase 5 — WebSocket (last — connects and triggers all modules):
 *     websocket.js  → window.SynapseWebSocket
 *
 * Because these are IIFEs (not ES modules), they attach to window.* on load.
 * main.js coordinates init() calls after DOMContentLoaded.
 */

// Side-effect imports: each IIFE attaches to window.SynapseXxx
import './theme.js';
import './sidebar.js';
import './auth.js';
import './health.js';
import './agents.js';
import './budget.js';
import './guardrails.js';
import './checkpoints.js';
import './tracing-utils.js';
import './reviewer-metrics.js';
import './messages.js';
import './tasks.js';
import './conversation.js';
import './campaigns.js';
import './loops.js';
import './prs.js';
import './input.js';
import './modal-base.js';
import './modals.js';
import './onboarding.js';
import './websocket.js';

document.addEventListener('DOMContentLoaded', function () {
  // Phase 1: Standalone UI — apply theme and restore sidebar width immediately
  if (window.SynapseTheme) window.SynapseTheme.init();
  if (window.SynapseSidebar) window.SynapseSidebar.init();

  // Phase 2: Core Infrastructure
  if (window.SynapseHealth) window.SynapseHealth.init();
  if (window.SynapseAgents) window.SynapseAgents.init();
  if (window.SynapseBudget) window.SynapseBudget.init();
  if (window.SynapseGuardrails) window.SynapseGuardrails.configure({ enabled: true });
  if (window.SynapseCheckpoints) window.SynapseCheckpoints.configure({ enabled: true });
  // Removed inits (dashboard-consolidation cleanup): routing-storage prefetch
  // (its event had zero listeners), timeline / routing-outcomes /
  // routing-audit / routing-analytics / dispatch-detail (their panels'
  // markup was stripped from index.html and the modules were DOM-dead), and
  // SynapseOperatorAudit / SynapseAnalyticsDashboard / SynapseDashboard /
  // SynapseKeyboardShortcuts (globals that no file ever defined).
  if (window.SynapseReviewerMetrics) window.SynapseReviewerMetrics.init();

  // Phase 3: Message & Task Systems
  if (window.SynapseMessages) window.SynapseMessages.init();
  if (window.SynapseTasks) window.SynapseTasks.init();
  if (window.SynapseConversation) window.SynapseConversation.init();
  if (window.SynapseCampaigns) window.SynapseCampaigns.init();
  if (window.SynapseLoops) window.SynapseLoops.init();
  if (window.SynapsePrs) {
    const tabProjects = document.getElementById('nav-tab-projects');
    const tabLoops = document.getElementById('nav-tab-loops');
    const tabPrs = document.getElementById('nav-tab-prs');
    const loopsView = document.getElementById('loops-view');
    const prsView = document.getElementById('prs-view');
    const messagesEl = document.getElementById('messages');
    const threadBar = document.getElementById('thread-filter-bar');
    const inputArea = document.getElementById('input-area');
    const prsAuthFetch = (url, opts = {}) => (
      window.SynapseWebSocket && typeof window.SynapseWebSocket.authFetch === 'function'
        ? window.SynapseWebSocket.authFetch(url, opts)
        : fetch(url, { credentials: 'same-origin', ...opts })
    );
    const openPrsView = () => {
      if (tabProjects) { tabProjects.classList.remove('active'); tabProjects.setAttribute('aria-selected', 'false'); }
      if (tabLoops) { tabLoops.classList.remove('active'); tabLoops.setAttribute('aria-selected', 'false'); }
      if (tabPrs) { tabPrs.classList.add('active'); tabPrs.setAttribute('aria-selected', 'true'); }
      if (loopsView) loopsView.style.display = 'none';
      if (messagesEl) messagesEl.style.display = 'none';
      if (threadBar) threadBar.style.display = 'none';
      if (inputArea) inputArea.style.display = 'none';
      if (prsView) prsView.style.display = 'flex';
      const activeProj = window.SynapseState?.currentProject || null;
      window.SynapsePrs.open(activeProj);
    };
    window.SynapsePrs.init({
      view: prsView,
      navTab: tabPrs,
      authFetch: prsAuthFetch,
      projectId: window.SynapseState?.currentProject || null,
      activateTab: openPrsView,
    });
    const tabs = [tabProjects, tabLoops, tabPrs].filter(Boolean);
    tabs.forEach((tab, idx) => {
      tab.addEventListener('keydown', (ev) => {
        let next = null;
        if (ev.key === 'ArrowRight') next = tabs[(idx + 1) % tabs.length];
        else if (ev.key === 'ArrowLeft') next = tabs[(idx - 1 + tabs.length) % tabs.length];
        else if (ev.key === 'Home') next = tabs[0];
        else if (ev.key === 'End') next = tabs[tabs.length - 1];
        if (next) { ev.preventDefault(); next.focus(); next.click(); }
      });
    });
    window.addEventListener('synapse:project-changed', (ev) => {
      if (ev?.detail?.projectId) window.SynapsePrs.setProject(ev.detail.projectId);
    });
  }

  // Phase 4: Input & Modals
  if (window.SynapseInput) window.SynapseInput.init();
  if (window.SynapseModalBase) window.SynapseModalBase.init();
  if (window.SynapseModals) window.SynapseModals.init();
  if (window.SynapseOnboarding) window.SynapseOnboarding.init();

  // Phase 5: WebSocket — connect last, after all handlers are registered
  // (guardrails/checkpoints configured in Phase 2, WebSocket triggers real-time updates)
  if (window.SynapseWebSocket) window.SynapseWebSocket.init();
});
