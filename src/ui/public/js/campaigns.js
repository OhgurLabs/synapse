/**
 * @module campaigns.js
 * @domain Campaign Management & Detail View
 * @description Campaign list, detail overlay, pause/resume, constraints,
 *   routing decisions, closeout view, and campaign selector utilities.
 *
 * @namespace window.SynapseCampaigns
 * @exports {
 *   refreshCampaigns(): void,
 *   refreshCampaignList(projectId: string, shouldRender: boolean): void,
 *   openCampaignDetail(projectId: string, campaignId: string): void,
 *   closeCampaignDetail(): void,
 *   renderCampaigns(): void,
 *   renderCampaignDetail(camp: Object, projectId: string): void,
 *   pauseCampaign(projectId: string, campaignId: string): void,
 *   resumeCampaign(projectId: string, campaignId: string): void,
 *   submitConstraint(): void,
 *   appendLiveRoutingDecision(projectId: string, campaignId: string): void,
 *   campaignAction(projectId: string, campaignId: string, action: string): void,
 *   campaignsCache: Object
 * }
 * @depends window.SynapseWebSocket.authFetch
 *          window.SynapseTasks.tasksCache
 *          window.SynapseHealth.escapeHtml, formatDuration, formatTimestamp
 *          window.SynapseTracing.getJaegerUrlSync
 * @init init() — call after DOMContentLoaded
 */
(function () {
  'use strict';

  // --- State ---
  let campaignsCache = {};
  let openDispatchDecisionId = null;
  let openDispatchDetailRow = null;
  let dispatchDecisionFetchSeq = 0;
  let campaignOverlayListenersBound = false;

  function getEscapeHtml() {
    const esc = window.SynapseHealth && typeof window.SynapseHealth.escapeHtml === 'function'
      ? window.SynapseHealth.escapeHtml
      : null;
    if (esc) return esc;
    return function (value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };
  }

  function clearOpenDispatchDetailRow() {
    if (openDispatchDetailRow && openDispatchDetailRow.parentNode) {
      openDispatchDetailRow.parentNode.removeChild(openDispatchDetailRow);
    }
    openDispatchDetailRow = null;
    openDispatchDecisionId = null;
    dispatchDecisionFetchSeq += 1;
  }

  function createDispatchDetailRow(anchorRow) {
    if (!anchorRow || !anchorRow.parentNode) return null;
    const detailRow = document.createElement('tr');
    detailRow.className = 'rd-detail-row';
    const detailCell = document.createElement('td');
    detailCell.colSpan = 5;
    detailCell.innerHTML = '<div class="routing-rationale-panel"><div class="rd-loading">Loading routing rationale...</div></div>';
    detailRow.appendChild(detailCell);
    anchorRow.parentNode.insertBefore(detailRow, anchorRow.nextSibling);
    openDispatchDetailRow = detailRow;
    return detailRow.querySelector('.routing-rationale-panel');
  }

  function renderDecisionError(message, dispatchId, allowRetry, esc) {
    const safe = esc || getEscapeHtml();
    let html = '<div class="rr-error">' + safe(message) + '</div>';
    if (allowRetry && dispatchId) {
      html += '<div class="rr-error-actions"><button type="button" class="rr-retry" data-dispatch-id="' + safe(dispatchId) + '">Retry</button></div>';
    }
    return html;
  }

  function fetchDispatchDecision(dispatchId, panel) {
    if (!dispatchId || !panel) return;
    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    const esc = getEscapeHtml();
    if (!authFetch) {
      panel.innerHTML = renderDecisionError('Failed to load decision details', dispatchId, true, esc);
      return;
    }

    panel.innerHTML = '<div class="rd-loading">Loading routing rationale...</div>';
    const requestSeq = ++dispatchDecisionFetchSeq;
    authFetch('/api/dispatch-log/' + encodeURIComponent(dispatchId) + '/decision')
      .then(function (r) {
        if (requestSeq !== dispatchDecisionFetchSeq) return null;
        if (r.status === 404) return { __notFound: true };
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (decision) {
        if (requestSeq !== dispatchDecisionFetchSeq) return;
        if (!decision || !openDispatchDetailRow || !panel.isConnected) return;
        if (decision.__notFound) {
          panel.innerHTML = renderDecisionError('Record not available', null, false, esc);
          return;
        }
        panel.innerHTML = renderRoutingRationale(decision, esc);
        panel.__routingDecision = decision;
      })
      .catch(function () {
        if (requestSeq !== dispatchDecisionFetchSeq) return;
        if (!openDispatchDetailRow || !panel.isConnected) return;
        panel.innerHTML = renderDecisionError('Failed to load decision details', dispatchId, true, esc);
      });
  }

  // --- Trace Link Utilities ---
  function renderTraceLink(traceId) {
    if (!traceId || typeof traceId !== 'string' || traceId.trim().length === 0) {
      return null;
    }

    const jaegerUrl = window.SynapseTracing && window.SynapseTracing.getJaegerUrlSync
      ? window.SynapseTracing.getJaegerUrlSync(traceId)
      : null;

    if (!jaegerUrl) {
      return {
        disabled: true,
        text: 'Tracing disabled',
      };
    }

    return {
      disabled: false,
      url: jaegerUrl,
      text: 'View Trace',
    };
  }

  function buildTraceLinkHtml(traceId, esc) {
    const traceLink = renderTraceLink(traceId);
    if (!traceLink) {
      return '<span class="trace-link trace-link-disabled" title="No trace ID available">No trace ID</span>';
    }
    if (traceLink.disabled) {
      return '<span class="trace-link trace-link-disabled" title="Tracing is not configured">' + esc(traceLink.text || 'Tracing disabled') + '</span>';
    }
    return '<a href="' + esc(traceLink.url) + '" target="_blank" rel="noopener noreferrer" class="trace-link-btn" data-trace-id="' + esc(traceId) + '">' +
      '<span class="trace-link-icon">\uD83D\uDD0D</span>' +
      '<span class="trace-link-text">' + esc(traceLink.text) + '</span></a>';
  }

  // --- Pure calculation helpers ---

  function countTaskStatuses(tasks) {
    if (!Array.isArray(tasks)) return {};
    const counts = {};
    for (let i = 0; i < tasks.length; i++) {
      const s = tasks[i].status || 'unknown';
      counts[s] = (counts[s] || 0) + 1;
    }
    return counts;
  }

  function calculateMilestoneProgress(tasks, milestoneStatus) {
    if (milestoneStatus === 'completed') return 100;
    if (!Array.isArray(tasks) || tasks.length === 0) return 0;
    const done = tasks.filter(function (t) {
      return t.status === 'completed' || t.status === 'done';
    }).length;
    return Math.round((done / tasks.length) * 100);
  }

  function calculateCampaignProgress(milestones) {
    if (!Array.isArray(milestones) || milestones.length === 0) return 0;
    const total = milestones.reduce(function (sum, m) {
      return sum + (m.progress != null ? m.progress : (m.status === 'completed' ? 100 : 0));
    }, 0);
    return Math.round(total / milestones.length);
  }

  function aggregateTaskPipeline(milestones) {
    if (!Array.isArray(milestones)) return {};
    const totals = {};
    for (let i = 0; i < milestones.length; i++) {
      const tasks = milestones[i].tasks || [];
      for (let j = 0; j < tasks.length; j++) {
        const s = tasks[j].status || 'unknown';
        totals[s] = (totals[s] || 0) + 1;
      }
    }
    return totals;
  }

  function normalizeMilestones(milestones, taskMap) {
    if (!Array.isArray(milestones)) return [];
    return milestones.map(function (m) {
      const tasks = (m.taskIds || []).map(function (tid) {
        return (taskMap && taskMap[tid]) ? taskMap[tid] : { id: tid, status: 'unknown' };
      });
      return {
        id: m.id,
        title: m.title || m.name || 'Untitled',
        status: m.status || 'pending',
        tasks: tasks,
        progress: calculateMilestoneProgress(tasks, m.status),
        blockedBy: m.blockedBy || [],
      };
    });
  }

  function normalizeCampaign(campaign, allTasks) {
    if (!campaign) return createEmptyCampaignViewModel();
    // Build a task lookup map
    const taskMap = {};
    if (Array.isArray(allTasks)) {
      for (let i = 0; i < allTasks.length; i++) {
        taskMap[allTasks[i].id] = allTasks[i];
      }
    }
    const milestones = normalizeMilestones(campaign.milestones || [], taskMap);
    const progress = calculateCampaignProgress(milestones);
    return {
      id: campaign.id,
      title: campaign.title || campaign.name || 'Untitled',
      description: campaign.description || '',
      status: campaign.status || 'unknown',
      milestones: milestones,
      progress: progress,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
      completedAt: campaign.completedAt,
      traceContext: campaign.traceContext || null,
    };
  }

  function createEmptyCampaignViewModel() {
    return {
      id: null,
      title: '',
      description: '',
      status: 'unknown',
      milestones: [],
      progress: 0,
      createdAt: null,
      updatedAt: null,
      completedAt: null,
      traceContext: null,
    };
  }

  // --- Campaign Management ---

  function closeCampaignDetail() {
    const overlay = document.getElementById('campaign-detail-overlay');
    if (overlay) overlay.classList.remove('visible');
    clearOpenDispatchDetailRow();
  }

  function refreshCampaigns() {
    const projects = window.SynapseInput ? window.SynapseInput.projects : [];
    if (!Array.isArray(projects) || projects.length === 0) return;
    const promises = [];
    for (let i = 0; i < projects.length; i++) {
      const proj = projects[i];
      const projId = proj.id || proj;
      promises.push(
        new Promise(function (resolve) {
          refreshCampaignList(projId, resolve);
        })
      );
    }
    Promise.all(promises).then(function () {
      renderCampaigns();
    });
  }

  function refreshCampaignList(projectId, callback) {
    // Callers pass either a callback OR `true` meaning "re-render the
    // sidebar when done" (the JSDoc's original shouldRender flag). Invoking
    // `true()` threw a swallowed TypeError, so the campaign sidebar never
    // re-rendered after pause/resume/approve/reject.
    if (callback === true) callback = function () { renderCampaigns(); };
    else if (typeof callback !== 'function') callback = null;
    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    if (!authFetch || !projectId) { if (callback) callback(); return; }
    authFetch('/api/projects/' + encodeURIComponent(projectId) + '/campaigns')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (Array.isArray(data)) {
          campaignsCache[projectId] = data;
        } else if (data && Array.isArray(data.campaigns)) {
          campaignsCache[projectId] = data.campaigns;
        }
        // U9b: seed the Checkpoints panel from the API for this project's
        // campaigns (loadCheckpoints dedupes + only fetches each once).
        var cps = campaignsCache[projectId] || [];
        if (window.SynapseCheckpoints && window.SynapseCheckpoints.loadCheckpoints) {
          for (var i = 0; i < cps.length; i++) {
            if (cps[i] && cps[i].id) window.SynapseCheckpoints.loadCheckpoints(projectId, cps[i].id);
          }
        }
        if (callback) callback();
      })
      .catch(function (e) {
        console.warn('[campaigns] refreshCampaignList failed for', projectId, ':', e.message);
        if (callback) callback();
      });
  }

  // ─── Group-collapse state (persisted) ────────────────────────────────────
  // Per-project collapse state for the campaigns panel.
  const CAMPS_COLLAPSED_KEY = 'synapse:ui:campaigns-groups-collapsed';
  function loadCollapsedCampGroups() {
    try { return new Set(JSON.parse(localStorage.getItem(CAMPS_COLLAPSED_KEY) || '[]')); }
    catch (_) { return new Set(); }
  }
  function saveCollapsedCampGroups(set) {
    try { localStorage.setItem(CAMPS_COLLAPSED_KEY, JSON.stringify([...set])); } catch (_) {}
  }

  function renderCampaigns() {
    const panel = document.getElementById('campaigns-panel');
    if (!panel) return;
    panel.innerHTML = '';

    const esc = window.SynapseHealth ? window.SynapseHealth.escapeHtml : (s) => String(s || '');

    const campaignList = [];
    for (const [projId, camps] of Object.entries(campaignsCache)) {
      for (const c of camps) {
        campaignList.push({ ...c, _projId: projId });
      }
    }
    if (campaignList.length === 0) return;

    const statusOrder = { active: 0, paused: 1, failed: 2, completed: 3 };
    campaignList.sort((a, b) => {
      const oa = statusOrder[a.status] ?? 99;
      const ob = statusOrder[b.status] ?? 99;
      if (oa !== ob) return oa - ob;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });

    const header = document.createElement('div');
    header.className = 'campaigns-header';
    header.innerHTML = `Campaigns <span class="camp-count">(${campaignList.length})</span>`;
    panel.appendChild(header);

    const multiProject = Object.keys(campaignsCache).length > 1;

    // Group campaigns by project. Each project gets a collapsible sub-header.
    // The sort above already runs over the flat list; preserve that order
    // within each group by walking campaignList in order and bucketing.
    const groups = new Map();  // projId → { displayName, campaigns: [] }
    for (const camp of campaignList) {
      if (!groups.has(camp._projId)) {
        const displayName = (window.SynapseInput?.projects?.find(p => p.id === camp._projId)?.displayName)
          || camp._projId;
        groups.set(camp._projId, { displayName, campaigns: [] });
      }
      groups.get(camp._projId).campaigns.push(camp);
    }

    const collapsed = loadCollapsedCampGroups();

    for (const [projId, group] of groups) {
      const isCollapsed = collapsed.has(projId);
      const shortName = (group.displayName || '').length > 22
        ? group.displayName.substring(0, 20) + '…' : group.displayName;

      const groupEl = document.createElement('div');
      groupEl.className = 'camp-group';
      groupEl.dataset.projId = projId;

      const groupHeader = document.createElement('div');
      groupHeader.className = 'camp-group-header' + (isCollapsed ? ' collapsed' : '');
      groupHeader.title = group.displayName;
      groupHeader.innerHTML =
        `<span class="camp-group-chevron">${isCollapsed ? '▶' : '▼'}</span>` +
        `<span class="camp-group-title">${esc(shortName)}</span>` +
        `<span class="camp-group-count">${group.campaigns.length}</span>`;

      const groupBody = document.createElement('div');
      groupBody.className = 'camp-group-body';
      if (isCollapsed) groupBody.style.display = 'none';

      groupHeader.addEventListener('click', () => {
        const nowCollapsed = !groupHeader.classList.contains('collapsed');
        groupHeader.classList.toggle('collapsed');
        groupBody.style.display = nowCollapsed ? 'none' : '';
        const chev = groupHeader.querySelector('.camp-group-chevron');
        if (chev) chev.textContent = nowCollapsed ? '▶' : '▼';
        const s = loadCollapsedCampGroups();
        if (nowCollapsed) s.add(projId); else s.delete(projId);
        saveCollapsedCampGroups(s);
      });

      groupEl.appendChild(groupHeader);

      for (const camp of group.campaigns) {
      const item = document.createElement('div');
      item.className = 'camp-item';

      const ms = camp.milestones || [];
      const total = ms.length;
      const completedMs = ms.filter(m => m.status === 'completed').length;
      const activeMs = ms.find(m => m.status === 'active');
      const pct = total > 0 ? Math.round((completedMs / total) * 100) : (camp.percentComplete || 0);

      const shortTitle = (camp.title || '').length > 28
        ? camp.title.substring(0, 26) + '...' : (camp.title || 'Untitled');

      const projDisplay = multiProject
        ? (window.SynapseInput?.projects?.find(p => p.id === camp._projId)?.displayName || camp._projId)
        : '';

      const priorityBadge = camp.priority && camp.priority !== 'normal'
        ? `<span class="camp-status priority-badge ${esc(camp.priority)}" style="background:var(--accent-bg);color:var(--accent)">${esc(camp.priority)}</span>`
        : '';

      // Recovery scan verdict (campaign-recovery.js): interrupted campaigns
      // with non-resumable tasks need an operator decision.
      const recoveryBadge = camp.recoveryStatus === 'needs_review'
        ? `<span class="camp-status failed" title="Interrupted with non-resumable tasks — review, then resume or fail">needs review</span>`
        : '';

      let html = `<div class="camp-title">
        <span class="camp-name" title="${esc(camp.title || '')}">${esc(shortTitle)}</span>
        ${priorityBadge}${recoveryBadge}
        <span class="camp-status ${esc(camp.status)}">${esc(camp.status)}</span>
      </div>`;
      html += `<div class="camp-progress"><div class="camp-progress-fill" style="width:${pct}%"></div></div>`;

      const metaRight = multiProject
        ? `<span class="camp-proj-label">${esc(projDisplay)}</span>`
        : (activeMs ? `<span>${esc((activeMs.title || '').length > 20 ? (activeMs.title || '').slice(0, 18) + '...' : (activeMs.title || ''))}</span>` : '');
      html += `<div class="camp-meta"><span>${completedMs}/${total} milestones</span>${metaRight}</div>`;

      // "View Closeout" button removed: it had no handler of its own (only
      // worked by bubbling to the row click) and the detail overlay it lands
      // on already renders the Closeout section — a redundant faux control.
      item.innerHTML = html;
      item.addEventListener('click', () => openCampaignDetail(camp._projId, camp.id));
      groupBody.appendChild(item);
      }  // end inner: for (const camp of group.campaigns)

      groupEl.appendChild(groupBody);
      panel.appendChild(groupEl);
    }  // end outer: for (const [projId, group] of groups)
  }

    function openCampaignDetail(projectId, campaignId) {
    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    if (!authFetch) return;
    Promise.all([
      authFetch('/api/projects/' + encodeURIComponent(projectId) + '/campaigns/' + encodeURIComponent(campaignId))
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      // Summary view: this map is only read for task.status and task.title, and
      // the full list carries multi-MB subtask/plan/gitBaseline payloads.
      authFetch('/api/projects/' + encodeURIComponent(projectId) + '/tasks?view=summary')
        .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }),
    ])
      .then(function (results) {
        var camp = results[0];
        var tasks = Array.isArray(results[1]) ? results[1] : [];
        var taskMap = {};
        for (var i = 0; i < tasks.length; i++) taskMap[tasks[i].id] = tasks[i];
        renderCampaignDetail(camp, projectId, taskMap);
      })
      .catch(function (e) {
        console.warn('[campaigns] openCampaignDetail failed:', e.message);
      });
  }

  function pauseCampaign(projectId, campaignId) {
    campaignAction(projectId, campaignId, 'pause');
  }

  function resumeCampaign(projectId, campaignId) {
    campaignAction(projectId, campaignId, 'resume');
  }

  // Clear a recovery-scan 'needs_review' flag after operator review.
  function ackRecovery(projectId, campaignId) {
    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    if (!authFetch) return;
    authFetch(
      '/api/projects/' + encodeURIComponent(projectId) +
        '/campaigns/' + encodeURIComponent(campaignId) + '/recovery-status',
      { method: 'DELETE' }
    ).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (window.SynapseMessages && window.SynapseMessages.showToast) {
        window.SynapseMessages.showToast('Review flag cleared', 'success');
      }
      refreshCampaigns();
      openCampaignDetail(projectId, campaignId);
    }).catch(function (e) {
      if (window.SynapseMessages && window.SynapseMessages.showToast) {
        window.SynapseMessages.showToast('Failed to clear flag: ' + e.message, 'error');
      }
    });
  }

  function approveMilestone(projectId, campaignId, milestoneId, reason) {
    milestoneApprovalAction(projectId, campaignId, milestoneId, 'approve', reason || 'Approved via campaign detail');
  }

  function rejectMilestone(projectId, campaignId, milestoneId, reason) {
    const note = reason || window.prompt('Reason for rejection (optional):', '');
    if (note === null) return; // operator cancelled
    milestoneApprovalAction(projectId, campaignId, milestoneId, 'reject', note || 'Rejected via campaign detail');
  }

  function milestoneApprovalAction(projectId, campaignId, milestoneId, action, reason) {
    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    if (!authFetch) return;
    authFetch(
      '/api/projects/' + encodeURIComponent(projectId) +
        '/campaigns/' + encodeURIComponent(campaignId) +
        '/milestones/' + encodeURIComponent(milestoneId) +
        '/' + encodeURIComponent(action),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason }) }
    )
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json().catch(function () { return {}; });
      })
      .then(function () {
        openCampaignDetail(projectId, campaignId);
        refreshCampaignList(projectId, true);
      })
      .catch(function (e) {
        console.warn('[campaigns] milestone ' + action + ' failed:', e.message);
        window.alert('Could not ' + action + ' milestone: ' + e.message);
      });
  }

  function campaignAction(projectId, campaignId, action) {
    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    if (!authFetch) return;
    authFetch(
      '/api/projects/' + encodeURIComponent(projectId) + '/campaigns/' + encodeURIComponent(campaignId) + '/' + encodeURIComponent(action),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    )
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok || data.error) throw new Error(data.error || 'HTTP ' + r.status);
        });
      })
      .then(function () {
        refreshCampaignList(projectId, true);
        // Re-render the detail overlay if it's open on this same campaign, so
        // the Pause/Resume button updates immediately without re-clicking.
        const overlay = document.getElementById('campaign-detail-overlay');
        if (overlay && overlay.classList.contains('visible')
            && overlay.dataset.projectId === projectId
            && overlay.dataset.campaignId === campaignId) {
          openCampaignDetail(projectId, campaignId);
        }
      })
      .catch(function (e) {
        console.warn('[campaigns] campaignAction(' + action + ') failed:', e.message);
        window.SynapseMessages?.showToast?.('Campaign ' + action + ' failed: ' + e.message, 'error');
      });
  }

  function submitConstraint() {
    // Find the active campaign detail overlay to extract projectId/campaignId
    const overlay = document.getElementById('campaign-detail-overlay');
    if (!overlay || !overlay.classList.contains('visible')) return;
    const input = document.getElementById('constraint-input');
    const text = input ? input.value.trim() : '';
    if (!text) return;

    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    if (!authFetch) return;

    // projectId/campaignId stored on the overlay as data attributes by renderCampaignDetail
    const projectId = overlay.dataset.projectId;
    const campaignId = overlay.dataset.campaignId;
    if (!projectId || !campaignId) return;

    authFetch(
      '/api/projects/' + encodeURIComponent(projectId) + '/campaigns/' + encodeURIComponent(campaignId) + '/constraints',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text }) }
    )
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok || data.error) throw new Error(data.error || 'HTTP ' + r.status);
        });
      })
      .then(function () {
        // Clear the input only on success — the failure path used to wipe
        // the operator's typed constraint along with the error.
        if (input) input.value = '';
        openCampaignDetail(projectId, campaignId);
      })
      .catch(function (e) {
        console.warn('[campaigns] submitConstraint failed:', e.message);
        window.SynapseMessages?.showToast?.('Constraint not saved: ' + e.message, 'error');
      });
  }

  function appendLiveRoutingDecision(projectId, campaignId, decision) {
    if (!decision || !decision.id) return;

    const overlay = document.getElementById('campaign-detail-overlay');
    // 'visible' is the class every open/close/CSS path uses — 'is-visible'
    // was never set anywhere, so live routing decisions never appended.
    if (!overlay || !overlay.classList.contains('visible')) return;

    if (overlay.dataset.projectId !== projectId || overlay.dataset.campaignId !== String(campaignId)) return;

    const esc = getEscapeHtml();
    const safeId = esc(String(decision.id));

    const existingRow = document.querySelector('tr[data-dispatch-id="' + safeId + '"]');
    if (existingRow) return;

    const formatTimeSince = window.SynapseHealth ? window.SynapseHealth.formatTimeSince : function () { return ''; };
    const timeLabel = formatTimeSince ? formatTimeSince(decision.timestamp) : '';
    const traceHtml = buildTraceLinkHtml(decision.traceId || null, esc);

    const newRow = document.createElement('tr');
    newRow.setAttribute('data-dispatch-id', safeId);
    newRow.innerHTML =
      '<td>' + esc(timeLabel || '') + '</td>' +
      '<td><span class="rd-category">' + esc(decision.taskCategory || 'N/A') + '</span></td>' +
      '<td><span class="rd-agent">' + esc(decision.selectedAgent || 'N/A') + '</span></td>' +
      '<td><span class="rd-reason">' + esc(decision.selectionReason || 'N/A') + '</span></td>' +
      '<td>' + traceHtml + '</td>';

    const table = document.getElementById('campaign-rd-table');
    const tbody = table ? table.querySelector('tbody') : null;
    if (tbody) {
      tbody.insertBefore(newRow, tbody.firstChild);
    }

    const countEl = document.getElementById('campaign-rd-count');
    if (countEl) {
      const currentCount = parseInt(countEl.textContent, 10) || 0;
      countEl.textContent = String(currentCount + 1);
    }

    const emptyEl = document.getElementById('campaign-rd-empty');
    if (emptyEl) {
      emptyEl.style.display = 'none';
    }
  }

  function renderDispatchRows(decisions, esc, formatTimeSince) {
    if (!Array.isArray(decisions) || decisions.length === 0) return '';
    return decisions.map(function (decision) {
      const timeLabel = formatTimeSince ? formatTimeSince(decision.timestamp) : '';
      const traceHtml = buildTraceLinkHtml(decision.traceId || null, esc);
      const dispatchId = decision && decision.id != null ? String(decision.id) : '';
      return '<tr data-dispatch-id="' + esc(dispatchId) + '">' +
        '<td>' + esc(timeLabel || '') + '</td>' +
        '<td><span class="rd-category">' + esc(decision.taskCategory || 'N/A') + '</span></td>' +
        '<td><span class="rd-agent">' + esc(decision.selectedAgent || 'N/A') + '</span></td>' +
        '<td><span class="rd-reason">' + esc(decision.selectionReason || 'N/A') + '</span></td>' +
        '<td>' + traceHtml + '</td>' +
      '</tr>';
    }).join('');
  }

  function renderRoutingRationale(decision, esc) {
    const safe = esc || getEscapeHtml();
    const data = decision || {};
    const weights = Array.isArray(data.weights) ? data.weights : [];
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const constraints = Array.isArray(data.constraintsApplied) ? data.constraintsApplied : [];
    const selectedAgent = data.selectedAgent || '';
    const rollValue = data.roll;

    if (candidates.length === 0 && weights.length === 0 && rollValue == null) {
      const enrichmentDate = data.auditEnrichmentDate || data.enrichmentDate || '2026-03-03';
      let preAuditHtml = '';
      preAuditHtml += '<div class="rr-panel-head">' +
        '<div class="rr-panel-title">Routing Rationale</div>' +
        '<button type="button" class="rr-panel-close" aria-label="Close routing rationale panel">&#x00D7;</button>' +
      '</div>';
      preAuditHtml += '<div class="rr-pre-audit">Audit data unavailable for dispatches before ' +
        safe(enrichmentDate) + '</div>';
      return preAuditHtml;
    }

    const removedAgents = new Set();
    constraints.forEach(function (c) {
      const removed = c && Array.isArray(c.agentsRemoved) ? c.agentsRemoved : [];
      removed.forEach(function (agentId) {
        if (agentId == null) return;
        removedAgents.add(String(agentId));
      });
    });

    function toNumber(value) {
      const n = (typeof value === 'number') ? value : parseFloat(value);
      return Number.isFinite(n) ? n : null;
    }

    function formatPercent(value) {
      const n = toNumber(value);
      if (n == null) return 'N/A';
      const pct = (n > 1 && n <= 100) ? n : n * 100;
      const fixed = pct.toFixed(1);
      return (fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed) + '%';
    }

    function formatNumber(value, digits) {
      const n = toNumber(value);
      if (n == null) return 'N/A';
      const fixed = n.toFixed(digits);
      return fixed.replace(/\.?0+$/, '');
    }

    const rowSourceByAgent = new Map();
    function ensureRow(agentId) {
      if (!rowSourceByAgent.has(agentId)) {
        rowSourceByAgent.set(agentId, { agentId: agentId });
      }
      return rowSourceByAgent.get(agentId);
    }

    candidates.forEach(function (candidate) {
      if (!candidate || candidate.agentId == null) return;
      const agentId = String(candidate.agentId);
      const row = ensureRow(agentId);
      row.successRate = candidate.successRate;
      row.decayFactor = candidate.decayFactor;
      row.totalDispatches = candidate.totalDispatches;
      row.weight = candidate.weight;
    });

    weights.forEach(function (weightEntry) {
      if (!weightEntry || weightEntry.agentId == null) return;
      const agentId = String(weightEntry.agentId);
      const row = ensureRow(agentId);
      row.successRate = weightEntry.successRate != null ? weightEntry.successRate : row.successRate;
      row.decayFactor = weightEntry.decayFactor != null ? weightEntry.decayFactor : row.decayFactor;
      row.totalDispatches = weightEntry.totalDispatches != null ? weightEntry.totalDispatches : row.totalDispatches;
      row.weight = weightEntry.weight != null ? weightEntry.weight : row.weight;
      row.confidenceScore = weightEntry.confidenceScore != null ? weightEntry.confidenceScore : row.confidenceScore;
    });

    removedAgents.forEach(function (agentId) {
      ensureRow(agentId);
    });

    const rowSource = Array.from(rowSourceByAgent.values());
    const maxWeight = rowSource.reduce(function (acc, row) {
      const val = toNumber(row && row.weight);
      return val != null && val > acc ? val : acc;
    }, 0);

    let rowsHtml = '';
    rowSource.forEach(function (entry) {
      if (!entry) return;
      const agentId = entry.agentId != null ? String(entry.agentId) : '';
      const successRate = entry.successRate;
      const decayFactor = entry.decayFactor;
      const totalDispatches = entry.totalDispatches;
      const weightVal = entry.weight;
      const weightNum = toNumber(weightVal) || 0;
      const barWidth = maxWeight > 0 ? Math.min(100, Math.max(0, (weightNum / maxWeight) * 100)) : 0;
      const isSelected = selectedAgent && agentId === selectedAgent;
      const isFiltered = removedAgents.has(agentId);
      const rowClass = (isSelected ? ' selected' : '') + (isFiltered ? ' filtered' : '');

      rowsHtml += '<tr class="' + rowClass.trim() + '">' +
        '<td>' + safe(agentId || 'N/A') + '</td>' +
        '<td>' + safe(formatPercent(successRate)) + '</td>' +
        '<td>' + safe(formatNumber(decayFactor, 2)) + '</td>' +
        '<td>' + safe(formatNumber(totalDispatches, 0)) + '</td>' +
        '<td>' +
          '<div class="rr-weight-bar"><div class="rr-weight-fill" style="width:' + barWidth.toFixed(1) + '%"></div></div>' +
          '<span class="rr-weight-value">' + safe(formatNumber(weightVal, 3)) + '</span>' +
        '</td>' +
      '</tr>';
    });

    if (!rowsHtml) {
      rowsHtml = '<tr><td colspan="5" class="rr-empty">No candidates recorded</td></tr>';
    }

    let constraintsHtml = '';
    if (constraints.length) {
      constraintsHtml = constraints.map(function (c) {
        const type = c && c.type ? String(c.type) : 'constraint';
        const agentsRemoved = c && Array.isArray(c.agentsRemoved) && c.agentsRemoved.length
          ? c.agentsRemoved.map(function (a) { return safe(String(a)); }).join(', ')
          : 'None';
        return '<div class="rr-constraint-item">' +
          '<span class="rr-constraint-badge">' + safe(type) + '</span>' +
          '<span class="rr-constraint-agents">' + agentsRemoved + '</span>' +
        '</div>';
      }).join('');
    } else {
      constraintsHtml = '<div class="rr-empty">No active constraints</div>';
    }

    let confidenceScore = toNumber(data.confidenceScore);
    if (confidenceScore == null && selectedAgent) {
      const match = weights.find(function (w) { return w && String(w.agentId) === selectedAgent; }) ||
        candidates.find(function (c) { return c && String(c.agentId) === selectedAgent; });
      if (match && match.confidenceScore != null) {
        confidenceScore = toNumber(match.confidenceScore);
      }
    }
    const confidenceLabel = confidenceScore == null ? 'N/A' : formatNumber(confidenceScore, 2);
    let confidenceClass = 'rr-confidence-bad';
    if (confidenceScore == null) confidenceClass = 'rr-confidence-unknown';
    else if (confidenceScore >= 0.8) confidenceClass = 'rr-confidence-good';
    else if (confidenceScore >= 0.4) confidenceClass = 'rr-confidence-warn';

    const selectionReason = data.selectionReason != null ? String(data.selectionReason) : 'N/A';
    const rollVal = data.hasOwnProperty('roll') ? data.roll : null;
    const rollNumber = toNumber(rollVal);

    const totalWeight = weights.reduce(function (acc, w) {
      const rawVal = toNumber(w && w.weight);
      const val = rawVal != null ? Math.max(0, rawVal) : null;
      return val != null ? acc + val : acc;
    }, 0);

    let rollSegments = '';
    let rollLegend = '';
    let cumWeight = 0;
    if (weights.length && totalWeight > 0) {
      rollSegments = weights.map(function (w) {
        const agentId = w && w.agentId != null ? String(w.agentId) : '';
        const weight = Math.max(0, toNumber(w && w.weight) || 0);
        const start = cumWeight;
        cumWeight += weight;
        const widthPct = Math.max(0, (weight / totalWeight) * 100);
        const startPct = Math.max(0, (start / totalWeight) * 100);
        const endPct = Math.max(0, (cumWeight / totalWeight) * 100);
        const selectedClass = agentId && agentId === selectedAgent ? ' selected' : '';
        rollLegend += '<div class="rr-roll-legend-item">' +
          '<span class="rr-roll-legend-swatch' + selectedClass + '"></span>' +
          '<span class="rr-roll-legend-label">' + safe(agentId || 'N/A') + '</span>' +
          '<span class="rr-roll-legend-range">' + safe(startPct.toFixed(1)) + '% - ' + safe(endPct.toFixed(1)) + '%</span>' +
        '</div>';
        return '<div class="rr-roll-seg' + selectedClass + '" style="width:' + widthPct.toFixed(3) + '%" title="' +
          safe(agentId || 'N/A') + '"></div>';
      }).join('');
    } else {
      rollSegments = '<div class="rr-empty">No weight ranges available</div>';
    }

    const rollMarkerPct = (rollNumber != null && totalWeight > 0)
      ? Math.min(100, Math.max(0, (rollNumber / totalWeight) * 100))
      : null;
    const rollValueLabel = rollNumber == null ? 'N/A' : formatNumber(rollNumber, 3);

    let html = '';
    html += '<div class="rr-panel-head">' +
      '<div class="rr-panel-title">Routing Rationale</div>' +
      '<button type="button" class="rr-panel-close" aria-label="Close routing rationale panel">&#x00D7;</button>' +
    '</div>';

    html += '<div class="rr-section">' +
      '<div class="rr-title">Candidate Pool</div>';
    if (candidates.length === 0 || rowSource.length === 0) {
      html += '<div class="rr-section-na">N/A</div>';
    } else {
      html += '<table class="rr-table">' +
        '<thead><tr>' +
          '<th>Agent</th>' +
          '<th>Success Rate</th>' +
          '<th>Decay Factor</th>' +
          '<th>Total Dispatches</th>' +
          '<th>Weight</th>' +
        '</tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>';
    }
    html += '</div>';

    html += '<div class="rr-section">' +
      '<div class="rr-title">Active Constraints</div>' +
      '<div class="rr-constraints">' + constraintsHtml + '</div>' +
    '</div>';

    html += '<div class="rr-section">' +
      '<div class="rr-title">Confidence Score</div>' +
      '<div class="rr-confidence-badge ' + confidenceClass + '">' + safe(confidenceLabel) + '</div>' +
    '</div>';

    html += '<div class="rr-section">' +
      '<div class="rr-title">Selection Reason</div>' +
      '<div class="rr-selection-reason">' + safe(selectionReason) + '</div>' +
    '</div>';

    html += '<div class="rr-section">' +
      '<div class="rr-title">Roll Value</div>';
    if (rollNumber == null && weights.length === 0) {
      html += '<div class="rr-section-na">N/A</div>';
    } else {
      html += '<div class="rr-roll-value">' + safe(rollValueLabel) + '</div>' +
        '<div class="rr-roll-bar">' +
          '<div class="rr-roll-track">' + rollSegments + '</div>' +
          (rollMarkerPct == null ? '' : '<div class="rr-roll-marker" style="left:' + rollMarkerPct.toFixed(2) + '%"></div>') +
        '</div>' +
        '<div class="rr-roll-legend">' + rollLegend + '</div>';
    }
    html += '</div>';

    return html;
  }

  function handleDispatchTableClick(e) {
    const closeButton = e.target && e.target.closest ? e.target.closest('.rr-panel-close') : null;
    if (closeButton) {
      clearOpenDispatchDetailRow();
      return;
    }

    const retryButton = e.target && e.target.closest ? e.target.closest('.rr-retry') : null;
    if (retryButton) {
      const dispatchId = retryButton.getAttribute('data-dispatch-id') || openDispatchDecisionId;
      const panel = openDispatchDetailRow ? openDispatchDetailRow.querySelector('.routing-rationale-panel') : null;
      if (dispatchId && panel) {
        fetchDispatchDecision(dispatchId, panel);
      }
      return;
    }

    const row = e.target && e.target.closest ? e.target.closest('tr[data-dispatch-id]') : null;
    if (!row || row.classList.contains('rd-detail-row')) {
      if (openDispatchDecisionId && openDispatchDetailRow) {
        const clickedInsidePanel = !!(e.target && e.target.closest && e.target.closest('.routing-rationale-panel'));
        const clickedDispatchRow = !!(e.target && e.target.closest && e.target.closest('tr[data-dispatch-id]'));
        if (!clickedInsidePanel && !clickedDispatchRow) {
          clearOpenDispatchDetailRow();
        }
      }
      return;
    }
    if (e.target && e.target.closest && e.target.closest('a,button')) return;

    const table = document.getElementById('campaign-rd-table');
    if (!table || !table.contains(row)) return;

    const dispatchId = row.getAttribute('data-dispatch-id');
    if (!dispatchId) return;

    if (openDispatchDecisionId === dispatchId) return;

    clearOpenDispatchDetailRow();
    const panel = createDispatchDetailRow(row);
    if (!panel) return;
    openDispatchDecisionId = dispatchId;
    fetchDispatchDecision(dispatchId, panel);
  }

  function loadCampaignDispatches(projectId, campaignId) {
    const storage = window.SynapseRoutingStorage;
    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    if (!campaignId) return;
    if (!storage && !authFetch) return;

    clearOpenDispatchDetailRow();

    const overlay = document.getElementById('campaign-detail-overlay');
    if (!overlay || overlay.dataset.campaignId !== campaignId) return;

    const table = document.getElementById('campaign-rd-table');
    const tbody = table ? table.querySelector('tbody') : null;
    const countEl = document.getElementById('campaign-rd-count');
    const emptyEl = document.getElementById('campaign-rd-empty');

    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="5" class="trace-link trace-link-disabled">Loading...</td></tr>';
    }

    const fetchPromise = (storage && typeof storage.getDecisions === 'function')
      ? storage.getDecisions({ campaignId: campaignId, limit: 25 })
      : authFetch('/api/dispatch-log?campaignId=' + encodeURIComponent(campaignId) + '&limit=25').then(function (r) { return r.json(); });

    fetchPromise
      .then(function (data) {
        const payload = Array.isArray(data) ? { decisions: data, total: data.length } : (data || {});
        const decisions = (payload && Array.isArray(payload.decisions)) ? payload.decisions : [];
        const esc = getEscapeHtml();
        const formatTimeSince = window.SynapseHealth ? window.SynapseHealth.formatTimeSince : function () { return ''; };

        if (countEl) countEl.textContent = String((payload && payload.total) || decisions.length || 0);

        if (!tbody) return;
        if (!decisions.length) {
          tbody.innerHTML = '';
          if (emptyEl) emptyEl.style.display = 'block';
          return;
        }

        if (emptyEl) emptyEl.style.display = 'none';
        tbody.innerHTML = renderDispatchRows(decisions, esc, formatTimeSince);
      })
      .catch(function (err) {
        if (tbody) {
          tbody.innerHTML = '<tr><td colspan="5" class="trace-link trace-link-disabled">Not configured</td></tr>';
        }
        console.warn('Failed to load campaign dispatches', err);
      });
  }

  function renderCampaignDetail(camp, projectId, taskMap) {
    const overlay = document.getElementById('campaign-detail-overlay');
    const panel = document.getElementById('campaign-detail-panel');
    if (!overlay || !panel) return;

    clearOpenDispatchDetailRow();

    overlay.dataset.projectId = projectId || '';
    overlay.dataset.campaignId = (camp && camp.id) ? camp.id : '';

    const esc = getEscapeHtml();
    const ms = (camp && camp.milestones) || [];
    const completedMs = ms.filter(function (m) { return m.status === 'completed'; }).length;
    const total = ms.length;
    const pct = total > 0 ? Math.round((completedMs / total) * 100) : 0;
    const status = (camp && camp.status) || 'unknown';
    const title = esc((camp && (camp.title || camp.name)) || 'Untitled Campaign');

    let html = '<div class="td-header">' +
      '<div class="td-title">' + title + '</div>' +
      '<button class="td-close" data-camp-action="close-detail">&#x00D7;</button>' +
      '</div>' +
      '<span class="td-status ' + esc(status) + '">' + esc(status.toUpperCase()) + '</span>';

    // Recovery-scan verdict banner: interrupted campaign with non-resumable
    // tasks. Operator reviews, then acks here (or resumes, which also clears).
    if (camp && camp.recoveryStatus === 'needs_review') {
      html += '<div class="cd-lifecycle-row" style="background:var(--error-bg,rgba(200,60,60,.12));border:1px solid var(--error,#c05050);border-radius:6px;padding:8px;margin:8px 0">' +
        '<span style="flex:1">⚠ Interrupted with non-resumable tasks — review task states before continuing.</span>' +
        '<button class="cd-lifecycle-btn" ' +
        'data-camp-action="ack-recovery" data-project="' + esc(projectId) + '" data-campaign="' + esc(camp.id) + '" ' +
        'title="Clear the needs-review flag">Mark reviewed</button></div>';
    }

    // Campaign-lifecycle action buttons: surfaces Pause/Resume at the campaign
    // level (was previously only on timeline events — UI oversight where an
    // operator viewing a paused campaign in the campaigns list had no Resume
    // button without round-tripping through the timeline panel). Shows:
    //   - "Pause"  when status === 'active'
    //   - "Resume" when status === 'paused'
    //   - nothing for terminal/transitional states
    if (status === 'active' || status === 'paused') {
      const safeProj = esc(projectId);
      const safeCamp = esc(camp.id);
      html += '<div class="cd-lifecycle-row">';
      if (status === 'active') {
        html += '<button class="cd-lifecycle-btn cd-pause-btn" ' +
          'data-camp-action="pause" data-project="' + safeProj + '" data-campaign="' + safeCamp + '" ' +
          'title="Pause this campaign — agents stop picking up its tasks">Pause Campaign</button>';
      } else {
        html += '<button class="cd-lifecycle-btn cd-resume-btn" ' +
          'data-camp-action="resume" data-project="' + safeProj + '" data-campaign="' + safeCamp + '" ' +
          'title="Resume this campaign — agents may pick up its tasks again">Resume Campaign</button>';
      }
      html += '</div>';
    }

    // Approval banner — surfaces any milestone gated on operator review at the top of the panel.
    const pendingApprovals = ms.filter(function (m) { return m.status === 'waiting_approval'; });
    if (pendingApprovals.length > 0) {
      html += '<div class="cd-approval-banner">' +
        '<div class="cd-approval-banner-title">' +
          pendingApprovals.length + ' milestone' + (pendingApprovals.length > 1 ? 's' : '') + ' awaiting approval' +
        '</div>';
      for (const m of pendingApprovals) {
        const safeProj = esc(projectId);
        const safeCamp = esc(camp.id);
        const safeMs = esc(m.id);
        html += '<div class="cd-approval-row">' +
          '<span class="cd-approval-title">' + esc(m.title || m.name || 'Untitled') + '</span>' +
          '<button class="cd-approve-btn" data-camp-action="approve-milestone" data-project="' + safeProj + '" data-campaign="' + safeCamp + '" data-milestone="' + safeMs + '">Approve</button>' +
          '<button class="cd-reject-btn" data-camp-action="reject-milestone" data-project="' + safeProj + '" data-campaign="' + safeCamp + '" data-milestone="' + safeMs + '">Reject</button>' +
          '</div>';
      }
      html += '</div>';
    }

    // Campaign priority selector
    const currentPriority = (camp && camp.priority) || 'normal';
    const priorityLevels = ['critical', 'high', 'elevated', 'normal'];
    const priorityLabels = { critical: 'CRITICAL', high: 'HIGH', elevated: 'ELEVATED', normal: 'NORMAL' };
    html += '<div class="cd-priority-row">';
    html += '<span class="cd-priority-label">Priority:</span>';
    html += '<div class="cd-priority-buttons">';
    for (const lvl of priorityLevels) {
      const isActive = lvl === currentPriority;
      html += '<button class="cd-priority-btn ' + esc(lvl) + (isActive ? ' active' : '') + '" data-priority="' + esc(lvl) + '">' + priorityLabels[lvl] + '</button>';
    }
    html += '</div></div>';

    // Progress bar
    html += '<div class="camp-progress" style="margin:10px 0 4px"><div class="camp-progress-fill" style="width:' + pct + '%"></div></div>';
    html += '<div class="td-meta"><span>' + completedMs + '/' + total + ' milestones</span><span>' + pct + '%</span></div>';

    // Description (if distinct from title)
    const desc = camp && camp.description;
    if (desc && desc !== (camp.title || camp.name)) {
      html += '<div class="td-desc">' + esc(desc) + '</div>';
    }

    // Goal / doneCriteria
    if (camp && camp.doneCriteria) {
      html += '<div class="td-section">Goal</div><div class="td-desc">' + esc(camp.doneCriteria) + '</div>';
    }

    // Milestones
    if (ms.length > 0) {
      html += '<div class="td-section">Milestones</div><div class="cd-scroll-body">';
      for (var i = 0; i < ms.length; i++) {
        var m = ms[i];
        var mStatus = m.status || 'pending';
        var iconChar = mStatus === 'completed' ? '&#x2714;'
          : mStatus === 'active' ? '&#x25B6;'
          : mStatus === 'failed' ? '&#x2716;'
          : mStatus === 'skipped' ? '&#x2014;'
          : mStatus === 'waiting_approval' ? '&#x23F8;'
          : mStatus === 'rejected' ? '&#x2716;' : '&#x25CB;';
        var taskCount = Array.isArray(m.tasks) ? m.tasks.length : 0;
        html += '<div class="cd-milestone ' + esc(mStatus) + '">' +
          '<div class="ms-header">' +
          '<span class="ms-icon ' + esc(mStatus) + '">' + iconChar + '</span>' +
          '<span class="ms-title">' + esc(m.title || m.name || 'Untitled') + '</span>' +
          (taskCount > 0 ? '<span class="ms-tasks">' + taskCount + ' task' + (taskCount !== 1 ? 's' : '') + '</span>' : '') +
          '</div>' +
          '<div class="ms-priority-row">' +
          '<span class="ms-priority-label">Priority:</span>' +
          '<div class="ms-priority-buttons">' +
          priorityLevels.map(lvl => {
            const isActive = lvl === (m.priority || 'normal');
            return '<button class="ms-priority-btn ' + esc(lvl) + (isActive ? ' active' : '') + '" data-ms-id="' + esc(m.id) + '" data-priority="' + esc(lvl) + '">' + priorityLabels[lvl] + '</button>';
          }).join('') +
          '</div></div>' +
          (mStatus === 'waiting_approval'
            ? '<div class="ms-approval-row">' +
                '<span class="ms-approval-label">Action required</span>' +
                '<button class="ms-approve-btn" data-camp-action="approve-milestone" data-project="' + esc(projectId) + '" data-campaign="' + esc(camp.id) + '" data-milestone="' + esc(m.id) + '">Approve</button>' +
                '<button class="ms-reject-btn" data-camp-action="reject-milestone" data-project="' + esc(projectId) + '" data-campaign="' + esc(camp.id) + '" data-milestone="' + esc(m.id) + '">Reject</button>' +
              '</div>'
            : '') +
          (m.doneCriteria ? '<div class="ms-criteria">' + esc(m.doneCriteria) + '</div>' : '') +
          (function () {
            var tids = Array.isArray(m.tasks) ? m.tasks : [];
            if (!tids.length || !taskMap) return '';
            var items = '';
            for (var j = 0; j < tids.length; j++) {
              var task = taskMap[tids[j]];
              if (!task) continue;
              var tStatus = task.status || 'queued';
              var isDone = tStatus === 'done' || tStatus === 'completed';
              var isFailed = tStatus === 'failed';
              var isExec = tStatus === 'executing';
              var tClass = isDone ? 'done' : isFailed ? 'failed' : isExec ? 'executing' : 'pending';
              var tIcon = isDone ? '&#x2714;' : isFailed ? '&#x2716;' : isExec ? '&#x25B6;' : '&#x25CB;';
              items += '<div class="ms-task-item ' + tClass + '">' +
                '<span class="ms-task-icon">' + tIcon + '</span>' +
                '<span class="ms-task-title">' + esc(task.title || 'Untitled') + '</span>' +
                '</div>';
            }
            return items ? '<div class="ms-task-list">' + items + '</div>' : '';
          })() +
          '</div>';
      }
      html += '</div>';
    }

    // Strategist fields
    if (camp && camp.lastReviewSummary) {
      html += '<div class="td-section">Last Strategist Review</div><div class="td-desc">' + esc(camp.lastReviewSummary) + '</div>';
    }
    if (camp && camp.nextAction) {
      html += '<div class="td-section">Next Action</div><div class="td-desc">' + esc(camp.nextAction) + '</div>';
    }
    if (camp && camp.contingency) {
      html += '<div class="td-section">Contingency</div><div class="td-desc">' + esc(camp.contingency) + '</div>';
    }
    if (camp && camp.closeoutSummary) {
      html += '<div class="td-section">Closeout</div><div class="td-desc">' + esc(camp.closeoutSummary) + '</div>';
    }

    // Constraint input
    html += '<div style="margin-top:16px">' +
      '<div class="td-section">Add Constraint</div>' +
      '<div style="display:flex;gap:8px;margin-top:6px">' +
      '<input id="constraint-input" type="text" placeholder="Describe a constraint..." style="flex:1;padding:6px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:5px;color:var(--text);font-size:13px;font-family:inherit;outline:none">' +
      '<button data-camp-action="submit-constraint" style="padding:6px 12px;background:var(--primary);color:#fff;border:none;border-radius:5px;font-size:12px;cursor:pointer">Add</button>' +
      '</div>' +
      '</div>';

    // Socratic questions section. Labeled experimental: the socratic flow is
    // heuristic-driven and has not been validated end to end — don't present
    // it as finished agent research (ship-honestly rule).
    if ((camp && camp.type) === 'socratic' && Array.isArray(camp.questions) && camp.questions.length > 0) {
      html += '<div class="cd-section" style="margin-top:24px">' +
        '<div class="td-section">Socratic Questions (<span id="question-count">' + camp.questions.length + '</span>)' +
        ' <span style="font-size:10px;border:1px solid var(--border,#666);border-radius:3px;padding:0 4px;opacity:.7" title="The socratic campaign flow is heuristic-driven and not yet validated end to end">experimental</span></div>';
      
      for (let qi = 0; qi < camp.questions.length; qi++) {
        const q = camp.questions[qi];
        const qNum = qi + 1;
        const qPriority = q.priority != null ? q.priority : 5;
        const priorityLabel = qPriority <= 3 ? 'Critical' : qPriority <= 7 ? 'High' : 'Normal';
        const priorityClass = qPriority <= 3 ? 'priority-critical' : qPriority <= 7 ? 'priority-high' : 'priority-normal';
        
        html += '<div class="cd-question-item">' +
          '<div class="cd-question-header">' +
          '<span class="cd-question-number">Q' + qNum + '</span>' +
          '<span class="cd-question-priority ' + priorityClass + '">' + priorityLabel + ' (P' + qPriority + ')</span>' +
          '</div>';
        
        html += '<div class="cd-question-text">' + esc((q.question || q.assumptionChallenged || 'Untitled Question')) + '</div>';
        
        if (q.assumptionChallenged && q.assumptionChallenged !== (q.question || '')) {
          html += '<div class="cd-question-assumption">' +
            '<strong>Challenges:</strong> ' + esc(q.assumptionChallenged) +
          '</div>';
        }
        
        if (q.evidenceFor && q.evidenceFor.length > 0) {
          html += '<div class="cd-question-evidence cd-evidence-for">' +
            '<strong>Supporting Evidence:</strong>' +
            '<ul>' +
            q.evidenceFor.map(function(ef) { return '<li>' + esc(ef) + '</li>'; }).join('') +
            '</ul>' +
          '</div>';
        }
        
        if (q.evidenceAgainst && q.evidenceAgainst.length > 0) {
          html += '<div class="cd-question-evidence cd-evidence-against">' +
            '<strong>Contradictory Evidence:</strong>' +
            '<ul>' +
            q.evidenceAgainst.map(function(ea) { return '<li>' + esc(ea) + '</li>'; }).join('') +
            '</ul>' +
          '</div>';
        }
        
        if (q.impactIfWrong) {
          html += '<div class="cd-question-impact">' +
            '<strong>Impact if Wrong:</strong> ' + esc(q.impactIfWrong) +
          '</div>';
        }
        
        html += '</div>';
      }
      html += '</div>';
    }

    // Dispatches section
    html += '<div class="rd-panel expanded" id="campaign-rd-section">' +
      '<div class="rd-title"><span class="rd-chevron">&#x25B6;</span> ROUTING DECISIONS (<span id="campaign-rd-count">0</span>)</div>' +
      '<div class="rd-body" id="campaign-rd-body">' +
      '<div class="rd-scroll-container">' +
      '<table class="rd-table" id="campaign-rd-table">' +
      '<thead><tr><th>Time</th><th>Category</th><th>Agent</th><th>Reason</th><th>Trace</th></tr></thead>' +
      '<tbody></tbody>' +
      '</table>' +
      '</div>' +
      '<div id="campaign-rd-empty" class="rd-empty" style="display:none;">No dispatches yet</div>' +
      '</div>' +
      '</div>';

    panel.innerHTML = html;
    overlay.classList.add('visible');
    loadCampaignDispatches(projectId, (camp && camp.id) ? camp.id : null);

    // Wire campaign priority buttons
    const campId = camp && camp.id;
    panel.querySelectorAll('.cd-priority-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newPriority = btn.dataset.priority;
        const af = window.SynapseWebSocket?.authFetch;
        if (!af || !campId) return;
        try {
          const r = await af(`/api/projects/${encodeURIComponent(projectId)}/campaigns/${encodeURIComponent(campId)}/priority`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ priority: newPriority })
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          panel.querySelectorAll('.cd-priority-btn').forEach(b => b.classList.toggle('active', b.dataset.priority === newPriority));
          if (window.SynapseMessages?.showToast) window.SynapseMessages.showToast(`Campaign priority set to ${newPriority}`, 'success');
        } catch (e) { console.warn('Failed to set campaign priority:', e); }
      });
    });

    // Wire milestone priority buttons
    panel.querySelectorAll('.ms-priority-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const msId = btn.dataset.msId;
        const newPriority = btn.dataset.priority;
        const af = window.SynapseWebSocket?.authFetch;
        if (!af || !campId) return;
        try {
          const r = await af(`/api/projects/${encodeURIComponent(projectId)}/campaigns/${encodeURIComponent(campId)}/milestones/${encodeURIComponent(msId)}/priority`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ priority: newPriority === 'normal' ? null : newPriority })
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const row = btn.closest('.ms-priority-buttons');
          if (row) row.querySelectorAll('.ms-priority-btn').forEach(b => b.classList.toggle('active', b.dataset.priority === newPriority));
          if (window.SynapseMessages?.showToast) window.SynapseMessages.showToast(`Milestone priority set to ${newPriority}`, 'success');
        } catch (e) { console.warn('Failed to set milestone priority:', e); }
      });
    });
  }

  // Delegated dispatch for rendered action buttons. Inline onclick attributes
  // are blocked by the CSP (script-src carries no 'unsafe-inline'), so every
  // render path emits data-camp-action + data-project/-campaign/-milestone
  // instead. One document-level listener survives all re-renders.
  let campActionListenerBound = false;
  function handleCampAction(e) {
    const btn = e.target.closest('[data-camp-action]');
    if (!btn) return;
    const { campAction, project, campaign, milestone } = btn.dataset;
    switch (campAction) {
      case 'close-detail': closeCampaignDetail(); break;
      case 'ack-recovery': ackRecovery(project, campaign); break;
      case 'pause': pauseCampaign(project, campaign); break;
      case 'resume': resumeCampaign(project, campaign); break;
      case 'approve-milestone': approveMilestone(project, campaign, milestone); break;
      case 'reject-milestone': rejectMilestone(project, campaign, milestone); break;
      case 'submit-constraint': submitConstraint(); break;
    }
  }

  function init() {
    if (!campActionListenerBound) {
      document.addEventListener('click', handleCampAction);
      campActionListenerBound = true;
    }
    if (campaignOverlayListenersBound) return;

    // Wire overlay backdrop click and delegated dispatch table click once.
    const overlay = document.getElementById('campaign-detail-overlay');
    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeCampaignDetail();
      });
      overlay.addEventListener('click', handleDispatchTableClick);
      campaignOverlayListenersBound = true;
    }
  }

  // --- Public API ---
  window.SynapseCampaigns = {
    refreshCampaigns,
    refreshCampaignList,
    openCampaignDetail,
    closeCampaignDetail,
    renderCampaigns,
    renderCampaignDetail,
    pauseCampaign,
    resumeCampaign,
    ackRecovery,
    approveMilestone,
    rejectMilestone,
    submitConstraint,
    appendLiveRoutingDecision,
    campaignAction,
    normalizeCampaign,
    normalizeMilestones,
    countTaskStatuses,
    calculateMilestoneProgress,
    calculateCampaignProgress,
    aggregateTaskPipeline,
    createEmptyCampaignViewModel,
    get campaignsCache() { return campaignsCache; },
    init,
  };
})();
