window.SynapseCampaigns = (function() {
  'use strict';

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

  // CampaignSelectors Module - Modified to be part of window.SynapseCampaigns
  // Original from campaign-selectors.js
  const DEFAULT_PRIORITY = 'normal';
  const DEFAULT_STATUS = 'active';
  const DEFAULT_QUEUE_POSITION = 0;
  const DEFAULT_PERCENT_COMPLETE = 0;
  
  const TASK_STATUSES = ['queued', 'planning', 'executing', 'reviewing', 'done', 'failed', 'awaiting_approval'];
  const CAMPAIGN_STATUSES = ['active', 'paused', 'awaiting_approval', 'completed', 'failed'];
  
  function normalizeCampaign(campaign, allTasks = []) {
    if (!campaign || typeof campaign !== 'object') {
      return createEmptyCampaignViewModel();
    }
    
    const taskMap = {};
    allTasks.forEach(t => { taskMap[t.id] = t; });
    
    const priority = (campaign.priority || DEFAULT_PRIORITY).toLowerCase();
    const normalizedPriority = ['critical', 'high', 'normal', 'low'].includes(priority) 
      ? priority : DEFAULT_PRIORITY;
    
    const status = (campaign.status || DEFAULT_STATUS).toLowerCase();
    
    const queuePosition = typeof campaign.queuePosition === 'number' 
      ? campaign.queuePosition 
      : DEFAULT_QUEUE_POSITION;
    
    const milestones = normalizeMilestones(campaign.milestones || [], taskMap);
    
    const percentComplete = calculateCampaignProgress(milestones);
    
    const taskPipeline = aggregateTaskPipeline(milestones);
    
    return {
      id: campaign.id || '',
      title: campaign.title || 'Untitled Campaign',
      description: campaign.description || '',
      status: status,
      priority: normalizedPriority,
      queuePosition: queuePosition,
      percentComplete: percentComplete,
      milestones: milestones,
      taskPipeline: taskPipeline,
      doneCriteria: campaign.doneCriteria || '',
      contingency: campaign.contingency || '',
      lastReviewSummary: campaign.lastReviewSummary || '',
      nextAction: campaign.nextAction || '',
      createdAt: campaign.createdAt || null,
      completedAt: campaign.completedAt || null,
      lastReviewAt: campaign.lastReviewAt || null,
      channel: campaign.channel || null,
      closeoutSummary: campaign.closeoutSummary || null,
      closeoutMarkdown: campaign.closeoutMarkdown || '',
    };
  }
  
  function normalizeMilestones(milestones, taskMap) {
    return milestones.map(ms => {
      const taskRecords = (ms.tasks || [])
        .map(id => taskMap[id])
        .filter(Boolean);
      
      const statusCounts = countTaskStatuses(taskRecords);
      
      let milestoneStatus = (ms.status || 'pending').toLowerCase();
      if (milestoneStatus === 'waiting_approval') milestoneStatus = 'awaiting_approval';
      
      const progress = calculateMilestoneProgress(taskRecords, milestoneStatus);
      
      return {
        id: ms.id || '',
        title: ms.title || 'Untitled Milestone',
        status: milestoneStatus,
        requireApproval: !!ms.requireApproval,
        tasks: ms.tasks || [],
        taskRecords: taskRecords,
        statusCounts: statusCounts,
        progress: progress,
        doneCriteria: ms.doneCriteria || '',
        order: ms.order || 0,
      };
    });
  }
  
  function countTaskStatuses(tasks) {
    const counts = { queued: 0, planning: 0, executing: 0, reviewing: 0, done: 0, failed: 0, awaiting_approval: 0 };
    
    tasks.forEach(t => {
      let status = (t.status || 'queued').toLowerCase();
      if (status === 'waiting_approval') status = 'awaiting_approval';
      if (counts[status] !== undefined) {
        counts[status]++;
      } else if (status === 'sleeping') {
        counts.queued++;
      } else {
        counts.queued++;
      }
    });
    
    return counts;
  }
  
  function calculateMilestoneProgress(tasks, milestoneStatus) {
    if (tasks.length === 0) {
      return milestoneStatus === 'completed' ? 100 : 0;
    }
    
    const doneCount = tasks.filter(t => (t.status || '').toLowerCase() === 'done').length;
    return Math.round((doneCount / tasks.length) * 100);
  }
  
  function calculateCampaignProgress(milestones) {
    if (milestones.length === 0) return 0;
    
    const completed = milestones.filter(m => m.status === 'completed').length;
    return Math.round((completed / milestones.length) * 100);
  }
  
  function aggregateTaskPipeline(milestones) {
    const total = { queued: 0, planning: 0, executing: 0, reviewing: 0, done: 0, failed: 0, awaiting_approval: 0 };
    
    milestones.forEach(ms => {
      const counts = ms.statusCounts || {};
      TASK_STATUSES.forEach(status => {
        total[status] += (counts[status] || 0);
      });
    });
    
    return total;
  }
  
  function createEmptyCampaignViewModel() {
    return {
      id: '',
      title: '',
      description: '',
      status: DEFAULT_STATUS,
      priority: DEFAULT_PRIORITY,
      queuePosition: DEFAULT_QUEUE_POSITION,
      percentComplete: DEFAULT_PERCENT_COMPLETE,
      milestones: [],
      taskPipeline: { queued: 0, planning: 0, executing: 0, reviewing: 0, done: 0, failed: 0, awaiting_approval: 0 },
      doneCriteria: '',
      contingency: '',
      lastReviewSummary: '',
      nextAction: '',
      createdAt: null,
      completedAt: null,
      lastReviewAt: null,
      channel: null,
      closeoutSummary: null,
      closeoutMarkdown: '',
    };
  }
  
  function getPriorityBadge(priority) {
    const priorityLower = (priority || 'normal').toLowerCase();
    const badges = {
      critical: { label: 'CRITICAL', class: 'critical' },
      high: { label: 'HIGH', class: 'high' },
      normal: { label: 'NORMAL', class: 'normal' },
      low: { label: 'LOW', class: 'low' },
    };
    return badges[priorityLower] || badges.normal;
  }
  
  function getStatusClass(status) {
    const statusLower = (status || 'active').toLowerCase();
    if (CAMPAIGN_STATUSES.includes(statusLower)) {
      return statusLower;
    }
    return 'active';
  }

  // --- Campaign-specific State and DOM References ---
  // These were originally in index.html, lines 3461-3472
  let campaignsPanel;
  let activeCampaignDetailId = null;
  let activeCampaignDetailProject = null;
  let campaignDetailOverlay;
  let campaignDetailPanel;

  // Polling timers
  let campaignPollingTimer = null;
  let constraintPollingTimer = null;

  // Routing decision state
  let _routingDecisions = [];
  let _routingDecisionsTotal = 0;
  let _routingDecisionsPage = 0;
  const ROUTING_DECISIONS_PER_PAGE = 20;

  // --- Functions (to be extracted from index.html) ---

  function closeCampaignDetail() {
    activeCampaignDetailId = null;
    activeCampaignDetailProject = null;
    campaignDetailOverlay.classList.remove('visible');
    stopCampaignPolling();
    stopConstraintPolling();
  }

  function refreshCampaigns() {
    window.SynapseWebSocket.authFetch(`/api/campaigns`)
      .then(campaigns => {
        if (!campaigns || campaigns.length === 0) {
          campaignsPanel.innerHTML = '<div class="camp-item" style="padding: 12px; font-size: 13px; color: var(--text-faint);">No active campaigns.</div>';
          return;
        }
        renderCampaigns(campaigns);
      })
      .catch(error => console.error('Failed to fetch campaigns:', error));
  }

  function refreshCampaignList(campaigns) {
    const campaignList = campaignsPanel; // Assuming campaignsPanel is the parent for the list
    if (!campaignList) return;

    let html = '';
    campaigns.forEach(campaign => {
      const priorityBadge = getPriorityBadge(campaign.priority);
      const statusClass = getStatusClass(campaign.status);
      const percentComplete = campaign.percentComplete; // Already calculated by normalizeCampaign

      html += `
        <div class="camp-item" data-id="${campaign.id}" data-project="${campaign.channel.projectId}" onclick="window.SynapseCampaigns.openCampaignDetail('${campaign.channel.projectId}', '${campaign.id}')">
          <div class="camp-title">
            <span class="camp-name">${window.SynapseHealth.escapeHtml(campaign.title)}</span>
            <span class="camp-status ${statusClass}">${statusClass.toUpperCase()}</span>
            ${campaign.priority !== DEFAULT_PRIORITY ? `<span class="camp-status ${priorityBadge.class}" style="font-size:8px;">${priorityBadge.label}</span>` : ''}
          </div>
          <div class="camp-progress" title="${percentComplete}% Complete">
            <div class="camp-progress-fill" style="width: ${percentComplete}%;"></div>
          </div>
          <div class="camp-meta">
            <span>Project: <span class="camp-proj-label">${window.SynapseHealth.escapeHtml(campaign.channel.projectId)}</span></span>
            <span>Milestones: ${campaign.milestones.length}</span>
            <span>Done: ${campaign.taskPipeline.done} / Total: ${Object.values(campaign.taskPipeline).reduce((sum, count) => sum + count, 0)}</span>
          </div>
        </div>
      `;
    });
    campaignList.innerHTML = html;
  }

  function fetchCampaignEnriched(projectId, campaignId) {
    return window.SynapseWebSocket.authFetch(`/api/projects/${projectId}/campaigns/${campaignId}/enriched`)
      .then(data => {
        // Need tasksCache from SynapseTasks
        const allTasks = window.SynapseTasks.tasksCache; 
        return normalizeCampaign(data, allTasks);
      });
  }

  function refreshCampaignDetail(projectId, campaignId) {
    fetchCampaignEnriched(projectId, campaignId)
      .then(campaign => {
        renderCampaignDetail(campaign);
        refreshActiveCampaignModal(campaign); // Update the modal if it's open
      })
      .catch(error => {
        console.error('Failed to fetch campaign detail:', error);
        // Optionally show an error state in the detail panel
      });
  }

  function refreshActiveCampaignModal(campaign) {
    if (activeCampaignDetailId === campaign.id && activeCampaignDetailProject === campaign.channel.projectId) {
      // Logic to update the currently open modal if necessary
      // For now, renderCampaignDetail already handles this if the campaign is active.
      // This function might be needed for dynamic updates to buttons/status within the modal.
    }
  }

  function startCampaignPolling(projectId, campaignId) {
    if (campaignPollingTimer) {
      clearInterval(campaignPollingTimer);
    }
    campaignPollingTimer = setInterval(() => refreshCampaignDetail(projectId, campaignId), 15000); // Poll every 15 seconds
  }

  function stopCampaignPolling() {
    if (campaignPollingTimer) {
      clearInterval(campaignPollingTimer);
      campaignPollingTimer = null;
    }
  }

  function startConstraintPolling(projectId, campaignId) {
    if (constraintPollingTimer) {
      clearInterval(constraintPollingTimer);
    }
    constraintPollingTimer = setInterval(() => {
      // This will call loadActiveConstraints which will then re-render
      if (activeCampaignDetailId === campaignId && activeCampaignDetailProject === projectId) {
        loadActiveConstraints(projectId, campaignId);
      }
    }, 10000); // Poll every 10 seconds
  }

  function stopConstraintPolling() {
    if (constraintPollingTimer) {
      clearInterval(constraintPollingTimer);
      constraintPollingTimer = null;
    }
  }
  
  function renderCampaigns(campaigns) {
    const panel = campaignsPanel;
    if (!panel) return;

    // Filter to active campaigns first, then sort by priority, then queue position
    const sortedCampaigns = campaigns
      .filter(c => c.status !== 'completed' && c.status !== 'failed') // Show active, paused, awaiting_approval
      .sort((a, b) => {
        const priorityOrder = { 'critical': 0, 'high': 1, 'normal': 2, 'low': 3 };
        const pA = priorityOrder[a.priority] !== undefined ? priorityOrder[a.priority] : 99;
        const pB = priorityOrder[b.priority] !== undefined ? priorityOrder[b.priority] : 99;

        if (pA !== pB) return pA - pB;
        return a.queuePosition - b.queuePosition;
      });

    let html = `<div class="campaigns-header">Campaigns <span class="camp-count">${sortedCampaigns.length}</span></div>`;
    if (sortedCampaigns.length === 0) {
      html += '<div class="camp-item" style="padding: 12px; font-size: 13px; color: var(--text-faint);">No active campaigns.</div>';
    } else {
      sortedCampaigns.forEach(campaign => {
        const priorityBadge = getPriorityBadge(campaign.priority);
        const statusClass = getStatusClass(campaign.status);
        const percentComplete = campaign.percentComplete;

        html += `
          <div class="camp-item" data-id="${campaign.id}" data-project="${campaign.channel.projectId}" onclick="window.SynapseCampaigns.openCampaignDetail('${campaign.channel.projectId}', '${campaign.id}')">
            <div class="camp-title">
              <span class="camp-name">${window.SynapseHealth.escapeHtml(campaign.title)}</span>
              <span class="camp-status ${statusClass}">${statusClass.toUpperCase()}</span>
              ${campaign.priority !== DEFAULT_PRIORITY ? `<span class="camp-status ${priorityBadge.class}" style="font-size:8px;">${priorityBadge.label}</span>` : ''}
            </div>
            <div class="camp-progress" title="${percentComplete}% Complete">
              <div class="camp-progress-fill" style="width: ${percentComplete}%;"></div>
            </div>
            <div class="camp-meta">
              <span>Project: <span class="camp-proj-label">${window.SynapseHealth.escapeHtml(campaign.channel.projectId)}</span></span>
              <span>Milestones: ${campaign.milestones.length}</span>
              <span>Done: ${campaign.taskPipeline.done} / Total: ${Object.values(campaign.taskPipeline).reduce((sum, count) => sum + count, 0)}</span>
            </div>
          </div>
        `;
      });
    }
    panel.innerHTML = html;
  }
  
  function openCampaignDetail(projectId, campaignId) {
    activeCampaignDetailId = campaignId;
    activeCampaignDetailProject = projectId;
    campaignDetailOverlay.classList.add('visible');
    refreshCampaignDetail(projectId, campaignId); // Initial render
    startCampaignPolling(projectId, campaignId); // Start polling for updates
    loadActiveConstraints(projectId, campaignId); // Load initial constraints
    startConstraintPolling(projectId, campaignId); // Start polling for constraints
    loadRoutingDecisions(projectId, campaignId, true); // Load initial routing decisions
  }

  function pauseCampaign(projectId, campaignId) {
    campaignAction(projectId, campaignId, 'pause', 'Campaign paused successfully.')
      .then(() => refreshCampaignDetail(projectId, campaignId));
  }

  function resumeCampaign(projectId, campaignId) {
    campaignAction(projectId, campaignId, 'resume', 'Campaign resumed successfully.')
      .then(() => refreshCampaignDetail(projectId, campaignId));
  }

  function approveCampaign(projectId, campaignId) {
    campaignAction(projectId, campaignId, 'approve', 'Campaign approved and resumed.')
      .then(() => refreshCampaignDetail(projectId, campaignId));
  }

  function renderCampaignDetail(campaign) {
    const detailPanel = campaignDetailPanel;
    if (!detailPanel) return;

    const priorityBadge = getPriorityBadge(campaign.priority);
    const statusClass = getStatusClass(campaign.status);

    let milestoneHtml = '';
    campaign.milestones.sort((a, b) => a.order - b.order).forEach(milestone => {
      const milestoneStatusClass = milestone.status;
      let msIcon = '';
      if (milestone.status === 'completed') msIcon = '✔️';
      else if (milestone.status === 'active') msIcon = '✨';
      else if (milestone.status === 'failed') msIcon = '❌';
      else if (milestone.status === 'awaiting_approval' || milestone.status === 'waiting_approval') msIcon = '✋';
      else msIcon = '⏳';

      let taskStatusChipsHtml = '';
      TASK_STATUSES.forEach(statusKey => {
        const count = milestone.statusCounts[statusKey];
        if (count > 0) {
          taskStatusChipsHtml += `<span class="ms-status-chip ${statusKey}">${statusKey.toUpperCase()}: ${count}</span>`;
        }
      });
      
      let taskListHtml = '';
      if (milestone.taskRecords && milestone.taskRecords.length > 0) {
        milestone.taskRecords.forEach(task => {
          let taskIcon = '';
          let taskStatusClass = '';
          if (task.status === 'done') { taskIcon = '✔️'; taskStatusClass = 'done'; }
          else if (task.status === 'failed') { taskIcon = '❌'; taskStatusClass = 'failed'; }
          else if (task.status === 'executing') { taskIcon = '⚡'; taskStatusClass = 'executing'; }
          else if (task.status === 'planning') { taskIcon = '🧠'; taskStatusClass = 'planning'; }
          else if (task.status === 'reviewing') { taskIcon = '👀'; taskStatusClass = 'reviewing'; }
          else { taskIcon = '⏳'; taskStatusClass = 'queued'; } // queued or sleeping

          taskListHtml += `
            <div class="ms-task-row" onclick="window.SynapseTasks.openTaskDetail('${campaign.channel.projectId}', '${task.id}')">
              <span class="task-status-icon ${taskStatusClass}">${taskIcon}</span>
              <span class="task-title">${window.SynapseHealth.escapeHtml(task.title)}</span>
              <span class="task-status-label">${task.status.toUpperCase()}</span>
            </div>
          `;
        });
        taskListHtml = `<div class="ms-task-list">${taskListHtml}</div>`;
      } else {
        taskListHtml = '<div class="cd-no-tasks">No tasks for this milestone.</div>';
      }

      milestoneHtml += `
        <div class="cd-milestone ${milestoneStatusClass}">
          <div class="ms-header">
            <span class="ms-icon ${milestoneStatusClass}">${msIcon}</span>
            <span class="ms-title">${window.SynapseHealth.escapeHtml(milestone.title)} (${milestone.progress}%)</span>
            <span class="ms-tasks">Tasks: ${milestone.taskRecords.length}</span>
          </div>
          <div class="ms-status-counts">${taskStatusChipsHtml}</div>
          <div class="ms-criteria">${window.SynapseHealth.escapeHtml(milestone.doneCriteria || 'No criteria specified.')}</div>
          ${taskListHtml}
        </div>
      `;
    });

    // Action buttons for campaign control
    let actionButtonsHtml = '';
    if (campaign.status === 'active') {
      actionButtonsHtml = `<button class="sidebar-btn" onclick="window.SynapseCampaigns.pauseCampaign('${campaign.channel.projectId}', '${campaign.id}')">Pause Campaign</button>`;
    } else if (campaign.status === 'paused') {
      actionButtonsHtml = `<button class="sidebar-btn" onclick="window.SynapseCampaigns.resumeCampaign('${campaign.channel.projectId}', '${campaign.id}')">Resume Campaign</button>`;
    } else if (campaign.status === 'awaiting_approval') {
      actionButtonsHtml = `<button class="sidebar-btn" onclick="window.SynapseCampaigns.approveCampaign('${campaign.channel.projectId}', '${campaign.id}')">Awaiting Approval</button>`;
    }

    // Closeout Summary Button
    let closeoutSummaryButtonHtml = '';
    if (campaign.closeoutSummary) {
      closeoutSummaryButtonHtml = `<button class="cd-view-closeout-btn" onclick="window.SynapseCampaigns.renderCloseoutSummary(event, '${campaign.channel.projectId}', '${campaign.id}')"><i class="co-btn-icon">📋</i> View Closeout Summary</button>`;
    }


    detailPanel.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px;">
        <div>
          <h2 style="font-size: 18px; font-weight: 700; color: var(--text-strong); margin-bottom: 4px;">${window.SynapseHealth.escapeHtml(campaign.title)}</h2>
          <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 8px;">Project: <span style="font-weight: 600;">${window.SynapseHealth.escapeHtml(campaign.channel.projectId)}</span> | ID: ${campaign.id}</div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <span class="camp-status ${statusClass}" style="font-size: 11px;">${statusClass.toUpperCase()}</span>
            ${campaign.priority !== DEFAULT_PRIORITY ? `<span class="camp-status ${priorityBadge.class}" style="font-size: 10px;">${priorityBadge.label}</span>` : ''}
            <span style="font-size: 12px; color: var(--text-faint);">Created: ${window.SynapseHealth.formatTimestamp(campaign.createdAt)}</span>
          </div>
        </div>
        <button class="agent-settings-close" onclick="window.SynapseCampaigns.closeCampaignDetail()">×</button>
      </div>
      <div class="cd-scroll-body">
        <p style="font-size: 14px; color: var(--text-soft); line-height: 1.6; margin-bottom: 16px;">${window.SynapseHealth.escapeHtml(campaign.description || 'No description provided.')}</p>

        <h3 style="font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-bottom: 10px;">Milestones (${campaign.milestones.length})</h3>
        ${milestoneHtml || '<div class="cd-empty-state">No milestones defined for this campaign.</div>'}

        <div class="constraint-builder" id="constraint-builder-section">
          <div class="cb-title" onclick="window.SynapseCampaigns.toggleConstraintBuilder(this)">
            <span class="cb-chevron">▶</span> ADD CONSTRAINT
          </div>
          <div class="cb-body" id="constraint-builder-body">
            <form id="constraint-form" onsubmit="window.SynapseCampaigns.submitConstraint(event, '${campaign.channel.projectId}', '${campaign.id}')">
              <label for="constraint-type">Constraint Type</label>
              <select id="constraint-type" class="cb-type-select" onchange="window.SynapseCampaigns.updateConstraintFields()">
                <option value="">-- Select a type --</option>
                <option value="exclude_agents">Exclude Agents</option>
                <option value="require_provider">Require Provider</option>
                <option value="priority_override">Priority Override</option>
                <option value="max_concurrent">Max Concurrent Tasks</option>
                <option value="time_window">Time Window</option>
              </select>
              <div id="cb-dynamic-fields" class="cb-dynamic-fields">
                <!-- Dynamic fields based on constraint type -->
              </div>
              <div id="cb-error" class="cb-error"></div>
              <button type="submit" class="cb-submit-btn">Add Constraint</button>
            </form>
          </div>
        </div>

        <div class="ac-panel" id="active-constraints-panel">
          <div class="ac-title">
            <i class="ac-icon">🔒</i> ACTIVE CONSTRAINTS (<span id="active-constraints-count">0</span>)
          </div>
          <div id="active-constraints-list" class="ac-list">
            <div class="ac-empty">No active constraints.</div>
          </div>
        </div>

        <div class="rd-panel" id="routing-decisions-section">
          <div class="rd-title" onclick="window.SynapseCampaigns.toggleRoutingDecisions(this)">
            <span class="rd-chevron">▶</span> ROUTING DECISIONS (<span id="routing-decisions-count">0</span>)
          </div>
          <div class="rd-body" id="routing-decisions-body">
            <div id="rd-truncation-note" style="display:none;">Displaying last ${ROUTING_DECISIONS_PER_PAGE} decisions.</div>
            <div id="rd-scroll-container" class="rd-scroll-container">
              <table class="rd-table" id="routing-decisions-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Category</th>
                    <th>Agent</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  <!-- Routing decisions will be rendered here -->
                </tbody>
              </table>
            </div>
            <div class="rd-pagination">
              <span id="rd-showing-info" class="rd-showing"></span>
              <button id="rd-load-more" class="rd-load-more" onclick="window.SynapseCampaigns.loadMoreRoutingDecisions('${campaign.channel.projectId}', '${campaign.id}')" disabled>Load More</button>
            </div>
          </div>
        </div>

        <div style="margin-top: 24px; display: flex; gap: 12px; justify-content: flex-end;">
          ${closeoutSummaryButtonHtml}
          ${actionButtonsHtml}
        </div>
      </div>
    `;
  }
  
  function toggleRoutingDecisions(element) {
    const panel = element.closest('.rd-panel');
    if (!panel) return;

    const isExpanded = panel.classList.toggle('expanded');

    if (isExpanded) {
      const body = panel.querySelector('.rd-body');
      const scrollContainer = body && body.querySelector('.rd-scroll-container');
      if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }

  function loadRoutingDecisions(projectId, campaignId, reset = false) {
    if (reset) {
      _routingDecisionsPage = 0;
      _routingDecisions = [];
      const tbody = document.getElementById('routing-decisions-table').querySelector('tbody');
      if (tbody) tbody.innerHTML = '';
      document.getElementById('rd-truncation-note').style.display = 'none';
    }

    window.SynapseWebSocket.authFetch(`/api/dispatch-log?projectId=${projectId}&campaignId=${campaignId}&limit=${ROUTING_DECISIONS_PER_PAGE}&offset=${_routingDecisionsPage * ROUTING_DECISIONS_PER_PAGE}`)
      .then(data => {
        const newDecisions = data.decisions || [];
        _routingDecisions = [...newDecisions, ..._routingDecisions]; // Prepend new decisions
        _routingDecisionsTotal = data.total || _routingDecisions.length;

        renderRoutingDecisionsTable(projectId, campaignId);
      })
      .catch(error => console.error('Failed to load routing decisions:', error));
  }

  function renderRoutingDecisionsTable(projectId, campaignId) {
    const tbody = document.getElementById('routing-decisions-table').querySelector('tbody');
    if (!tbody) return;

    let html = '';
    _routingDecisions.forEach((decision, index) => {
      const isNew = decision._isNew; // Temporary flag for highlighting
      delete decision._isNew; // Remove flag after use

      const rowClass = isNew ? 'rd-row-new' : '';

      const traceId = decision.traceId || null;
      const traceLink = renderTraceLink(traceId);
      const traceLinkHtml = traceLink
        ? traceLink.disabled
          ? '<span class="trace-link trace-link-disabled" title="Tracing is not configured">Tracing disabled</span>'
          : '<a href="' + window.SynapseHealth.escapeHtml(traceLink.url) + '" target="_blank" rel="noopener noreferrer" class="trace-link-btn" data-trace-id="' + window.SynapseHealth.escapeHtml(traceId) + '">' +
            '<span class="trace-link-icon">\uD83D\uDD0D</span>' +
            '<span class="trace-link-text">' + window.SynapseHealth.escapeHtml(traceLink.text) + '</span></a>'
        : '<span class="trace-link trace-link-disabled" title="No trace ID available">No trace ID</span>';

      html += `
        <tr class="${rowClass}" onclick="window.SynapseCampaigns.expandRoutingRow(this, '${decision.id}')">
          <td>${window.SynapseHealth.formatTimeSince(decision.timestamp)} ago</td>
          <td><span class="rd-category">${window.SynapseHealth.escapeHtml(decision.category || 'N/A')}</span></td>
          <td><span class="rd-agent">${window.SynapseHealth.escapeHtml(decision.agentId || 'N/A')}</span></td>
          <td><span class="rd-reason">${window.SynapseHealth.escapeHtml(decision.reason || 'N/A')}</span></td>
          <td>${traceLinkHtml}</td>
        </tr>
        <tr class="rd-detail-row">
          <td colspan="5">
            <div class="rd-detail-panel" id="rd-detail-${decision.id}">
              <!-- Dynamic content for detailed decision info -->
            </div>
          </td>
        </tr>
      `;
    });
    tbody.innerHTML = html;

    document.getElementById('routing-decisions-count').textContent = _routingDecisionsTotal;
    const showingInfo = document.getElementById('rd-showing-info');
    if (showingInfo) {
      showingInfo.textContent = `Showing ${Math.min(_routingDecisions.length, _routingDecisionsTotal)} of ${_routingDecisionsTotal}`;
    }

    const loadMoreBtn = document.getElementById('rd-load-more');
    if (loadMoreBtn) {
      loadMoreBtn.disabled = _routingDecisions.length >= _routingDecisionsTotal;
    }

    if (_routingDecisionsTotal > ROUTING_DECISIONS_PER_PAGE && _routingDecisions.length < _routingDecisionsTotal) {
      document.getElementById('rd-truncation-note').style.display = 'block';
    } else {
      document.getElementById('rd-truncation-note').style.display = 'none';
    }
  }

  function loadMoreRoutingDecisions(projectId, campaignId) {
    _routingDecisionsPage++;
    loadRoutingDecisions(projectId, campaignId);
  }

  function appendLiveRoutingDecision(projectId, campaignId, decision) {
    // Only append if the campaign detail is open and matches
    if (activeCampaignDetailId === campaignId && activeCampaignDetailProject === projectId) {
      decision._isNew = true; // Mark as new for highlighting
      _routingDecisions.unshift(decision); // Add to the beginning
      if (_routingDecisions.length > ROUTING_DECISIONS_PER_PAGE * (_routingDecisionsPage + 1)) {
        _routingDecisions.pop(); // Keep array size manageable if not paginating
      }
      _routingDecisionsTotal++;
      renderRoutingDecisionsTable(projectId, campaignId);

      // Scroll to top to show new decision
      const scrollContainer = document.getElementById('rd-scroll-container');
      if (scrollContainer) scrollContainer.scrollTop = 0;
    }
  }
  
  function expandRoutingRow(row, decisionId) {
    const detailRow = row.nextElementSibling;
    if (!detailRow || !detailRow.classList.contains('rd-detail-row')) return;

    const detailPanel = document.getElementById(`rd-detail-${decisionId}`);
    if (!detailPanel) return;

    // Toggle the panel visibility
    const isOpen = detailPanel.classList.contains('open');
    if (isOpen) {
      detailPanel.classList.remove('open');
    } else {
      // Close any other open detail panels
      document.querySelectorAll('.rd-detail-panel.open').forEach(panel => {
        panel.classList.remove('open');
      });

      detailPanel.classList.add('open');
      // Fetch details if not already loaded
      if (detailPanel.innerHTML.trim() === '') {
        window.SynapseWebSocket.authFetch(`/api/dispatch-log/${decisionId}`)
          .then(detail => {
            let candidatesHtml = '';
            if (detail.candidates && detail.candidates.length > 0) {
              candidatesHtml = `
                <h4 class="rd-section-label">Candidates</h4>
                <table class="rd-candidate-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Model</th>
                      <th>Provider</th>
                      <th>Computed Weight</th>
                      <th>Final Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${detail.candidates.map(candidate => `
                      <tr class="rd-candidate-row ${candidate.id === detail.agentId ? 'selected' : ''} ${candidate.filteredOut ? 'filtered' : ''}">
                        <td>${window.SynapseHealth.escapeHtml(candidate.agentId)}</td>
                        <td>${window.SynapseHealth.escapeHtml(candidate.modelId)}</td>
                        <td>${window.SynapseHealth.escapeHtml(candidate.provider)}</td>
                        <td><span class="rd-weight-bar" style="width: ${Math.min(candidate.computedWeight / detail.maxComputedWeight * 100, 100)}px;"></span> ${candidate.computedWeight.toFixed(2)}</td>
                        <td>${candidate.finalScore.toFixed(2)}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              `;
            }

            let constraintsHtml = '';
            if (detail.appliedConstraints && detail.appliedConstraints.length > 0) {
              constraintsHtml = `
                <h4 class="rd-section-label">Applied Constraints</h4>
                ${detail.appliedConstraints.map(constraint => `
                  <div class="rd-constraint-item">
                    <span class="constraint-type">${window.SynapseHealth.escapeHtml(constraint.type.replace(/_/g, ' '))}</span>
                    <span>${window.SynapseHealth.escapeHtml(constraint.description)}</span>
                  </div>
                `).join('')}
              `;
            }

            let rollHtml = '';
            if (detail.roll) {
              rollHtml = `
                <h4 class="rd-section-label">Roll Details</h4>
                <div class="rd-roll">
                  <div>Roll Score: ${detail.roll.score.toFixed(2)}</div>
                  <div>Outcome: ${detail.roll.outcome}</div>
                </div>
              `;
            }

            detailPanel.innerHTML = `
              <div style="padding: 8px;">
                <h4 class="rd-section-label">Decision Details</h4>
                <div style="font-size: 12px; color: var(--text-soft);">
                  <p><strong>Timestamp:</strong> ${window.SynapseHealth.formatTimestamp(detail.timestamp)}</p>
                  <p><strong>Category:</strong> <span class="rd-category">${window.SynapseHealth.escapeHtml(detail.category || 'N/A')}</span></p>
                  <p><strong>Selected Agent:</strong> <span class="rd-selected-agent">${window.SynapseHealth.escapeHtml(detail.agentId || 'N/A')}</span></p>
                  <p><strong>Reason:</strong> ${window.SynapseHealth.escapeHtml(detail.reason || 'N/A')}</p>
                </div>
                ${candidatesHtml}
                ${constraintsHtml}
                ${rollHtml}
              </div>
            `;
          })
          .catch(error => {
            console.error('Failed to load routing decision detail:', error);
            detailPanel.innerHTML = `<div class="rd-error">Failed to load details.</div>`;
          });
      }
    }
  }

  // --- Constraint Builder Functions ---

  function toggleConstraintBuilder(element) {
    element.parentNode.classList.toggle('expanded');
    const body = document.getElementById('constraint-builder-body');
    if (body) {
      if (element.parentNode.classList.contains('expanded')) {
        body.style.display = 'block';
      } else {
        body.style.display = 'none';
      }
    }
  }

  function updateConstraintFields() {
    const typeSelect = document.getElementById('constraint-type');
    const dynamicFields = document.getElementById('cb-dynamic-fields');
    dynamicFields.innerHTML = ''; // Clear previous fields
    document.getElementById('cb-error').textContent = ''; // Clear errors

    const constraintType = typeSelect.value;
    let fieldsHtml = '';

    switch (constraintType) {
      case 'exclude_agents':
        fieldsHtml = `
          <label for="cb-exclude-agents">Agents (comma-separated IDs)</label>
          <input type="text" id="cb-exclude-agents" placeholder="agent1, agent2">
        `;
        break;
      case 'require_provider':
        fieldsHtml = `
          <label for="cb-require-provider">Provider</label>
          <select id="cb-require-provider">
            <option value="">-- Select a provider --</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="gemini">Gemini</option>
            <option value="ollama">Ollama</option>
            <option value="opencode">OpenCode</option>
          </select>
        `;
        break;
      case 'priority_override':
        fieldsHtml = `
          <label for="cb-priority-agent">Agent ID</label>
          <input type="text" id="cb-priority-agent" placeholder="agent-id">
          <label for="cb-priority-level">Priority Level</label>
          <select id="cb-priority-level">
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        `;
        break;
      case 'max_concurrent':
        fieldsHtml = `
          <label for="cb-max-concurrent">Max Concurrent Tasks</label>
          <input type="number" id="cb-max-concurrent" min="1" placeholder="1">
        `;
        break;
      case 'time_window':
        fieldsHtml = `
          <label for="cb-time-start">Start Time (HH:MM, 24-hour)</label>
          <input type="time" id="cb-time-start" value="09:00">
          <label for="cb-time-end">End Time (HH:MM, 24-hour)</label>
          <input type="time" id="cb-time-end" value="17:00">
          <div class="cb-checkbox-group">
            <label><input type="checkbox" value="mon"> Mon</label>
            <label><input type="checkbox" value="tue"> Tue</label>
            <label><input type="checkbox" value="wed"> Wed</label>
            <label><input type="checkbox" value="thu"> Thu</label>
            <label><input type="checkbox" value="fri"> Fri</label>
            <label><input type="checkbox" value="sat"> Sat</label>
            <label><input type="checkbox" value="sun"> Sun</label>
          </div>
        `;
        break;
    }
    dynamicFields.innerHTML = fieldsHtml;
  }

  function validateConstraintForm(constraintType, formData) {
    const errorDisplay = document.getElementById('cb-error');
    errorDisplay.textContent = ''; // Clear previous errors

    if (!constraintType) {
      errorDisplay.textContent = 'Please select a constraint type.';
      return false;
    }

    switch (constraintType) {
      case 'exclude_agents':
        if (!formData.agents || formData.agents.length === 0) {
          errorDisplay.textContent = 'Please specify at least one agent ID.';
          return false;
        }
        break;
      case 'require_provider':
        if (!formData.provider) {
          errorDisplay.textContent = 'Please select a provider.';
          return false;
        }
        break;
      case 'priority_override':
        if (!formData.agentId) {
          errorDisplay.textContent = 'Please specify an agent ID.';
          return false;
        }
        if (!formData.priority) {
          errorDisplay.textContent = 'Please select a priority level.';
          return false;
        }
        break;
      case 'max_concurrent':
        if (isNaN(formData.maxConcurrent) || formData.maxConcurrent <= 0) {
          errorDisplay.textContent = 'Max concurrent tasks must be a positive number.';
          return false;
        }
        break;
      case 'time_window':
        if (!formData.startTime || !formData.endTime) {
          errorDisplay.textContent = 'Please specify both start and end times.';
          return false;
        }
        if (formData.daysOfWeek.length === 0) {
          errorDisplay.textContent = 'Please select at least one day of the week.';
          return false;
        }
        // Basic time format validation (HH:MM)
        const timeRegex = /^(?:2[0-3]|[01]?[0-9]):[0-5][0-9]$/;
        if (!timeRegex.test(formData.startTime) || !timeRegex.test(formData.endTime)) {
          errorDisplay.textContent = 'Time format must be HH:MM (24-hour).';
          return false;
        }
        // Ensure end time is after start time if on the same day (simple check)
        const [startH, startM] = formData.startTime.split(':').map(Number);
        const [endH, endM] = formData.endTime.split(':').map(Number);
        if (startH * 60 + startM >= endH * 60 + endM) {
          errorDisplay.textContent = 'End time must be after start time.';
          return false;
        }
        break;
      default:
        errorDisplay.textContent = 'Invalid constraint type.';
        return false;
    }
    return true;
  }

  function submitConstraint(event, projectId, campaignId) {
    event.preventDefault();
    const typeSelect = document.getElementById('constraint-type');
    const constraintType = typeSelect.value;
    const formData = {};

    // Collect data based on type
    switch (constraintType) {
      case 'exclude_agents':
        formData.agents = document.getElementById('cb-exclude-agents').value.split(',').map(s => s.trim()).filter(Boolean);
        break;
      case 'require_provider':
        formData.provider = document.getElementById('cb-require-provider').value;
        break;
      case 'priority_override':
        formData.agentId = document.getElementById('cb-priority-agent').value;
        formData.priority = document.getElementById('cb-priority-level').value;
        break;
      case 'max_concurrent':
        formData.maxConcurrent = parseInt(document.getElementById('cb-max-concurrent').value, 10);
        break;
      case 'time_window':
        formData.startTime = document.getElementById('cb-time-start').value;
        formData.endTime = document.getElementById('cb-time-end').value;
        formData.daysOfWeek = Array.from(document.querySelectorAll('.cb-checkbox-group input[type="checkbox"]:checked')).map(cb => cb.value);
        break;
    }

    if (!validateConstraintForm(constraintType, formData)) {
      return; // Validation failed
    }

    window.SynapseWebSocket.authFetch(`/api/projects/${projectId}/campaigns/${campaignId}/constraints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: constraintType, config: formData })
    })
      .then(response => {
        window.SynapseModals.appendSystem(`Constraint "${constraintType}" added.`);
        // Reset form and refresh constraints
        document.getElementById('constraint-form').reset();
        updateConstraintFields(); // Clear dynamic fields
        loadActiveConstraints(projectId, campaignId);
      })
      .catch(error => {
        console.error('Failed to add constraint:', error);
        window.SynapseModals.appendSystem(`Error adding constraint: ${error.message}`, 'error');
      });
  }

  function loadActiveConstraints(projectId, campaignId) {
    window.SynapseWebSocket.authFetch(`/api/projects/${projectId}/campaigns/${campaignId}/constraints`)
      .then(constraints => {
        renderActiveConstraints(projectId, campaignId, constraints);
      })
      .catch(error => console.error('Failed to load active constraints:', error));
  }

  function renderActiveConstraints(projectId, campaignId, constraints) {
    const listContainer = document.getElementById('active-constraints-list');
    const countSpan = document.getElementById('active-constraints-count');
    if (!listContainer || !countSpan) return;

    countSpan.textContent = constraints.length;

    if (constraints.length === 0) {
      listContainer.innerHTML = '<div class="ac-empty">No active constraints.</div>';
      return;
    }

    let html = '';
    constraints.forEach(constraint => {
      let icon = '';
      let primaryDetail = '';
      let secondaryDetail = '';

      switch (constraint.type) {
        case 'exclude_agents':
          icon = '🚫';
          primaryDetail = `Exclude Agents: ${constraint.config.agents.join(', ')}`;
          secondaryDetail = 'Prevent specified agents from working on tasks.';
          break;
        case 'require_provider':
          icon = '🌍';
          primaryDetail = `Require Provider: ${constraint.config.provider}`;
          secondaryDetail = 'Only allow agents from this provider.';
          break;
        case 'priority_override':
          icon = '⬆️';
          primaryDetail = `Priority Override for ${constraint.config.agentId}: ${constraint.config.priority.toUpperCase()}`;
          secondaryDetail = 'Force a specific priority for an agent.';
          break;
        case 'max_concurrent':
          icon = '🔢';
          primaryDetail = `Max Concurrent Tasks: ${constraint.config.maxConcurrent}`;
          secondaryDetail = 'Limit simultaneous tasks for this campaign.';
          break;
        case 'time_window':
          icon = '⏰';
          primaryDetail = `Time Window: ${constraint.config.startTime} - ${constraint.config.endTime}`;
          secondaryDetail = `Days: ${constraint.config.daysOfWeek.join(', ').toUpperCase()}`;
          break;
        default:
          icon = '❓';
          primaryDetail = `Unknown Constraint: ${constraint.type}`;
          secondaryDetail = 'Configuration missing or invalid.';
      }

      html += `
        <div class="ac-row">
          <div class="ac-type-icon ${constraint.type}">${icon}</div>
          <div class="ac-details">
            <div class="ac-detail-primary">${primaryDetail}</div>
            <div class="ac-detail-secondary">${secondaryDetail}</div>
          </div>
          <button class="ac-remove-btn" onclick="window.SynapseCampaigns.removeConstraint('${projectId}', '${campaignId}', '${constraint.id}')">Remove</button>
        </div>
      `;
    });
    listContainer.innerHTML = html;
  }

  function removeConstraint(projectId, campaignId, constraintId) {
    if (!confirm('Are you sure you want to remove this constraint?')) {
      return;
    }

    window.SynapseWebSocket.authFetch(`/api/projects/${projectId}/campaigns/${campaignId}/constraints/${constraintId}`, {
      method: 'DELETE'
    })
      .then(() => {
        window.SynapseModals.appendSystem('Constraint removed successfully.');
        loadActiveConstraints(projectId, campaignId);
        // Also refresh campaign detail potentially if constraints impact display
        refreshCampaignDetail(projectId, campaignId);
      })
      .catch(error => {
        console.error('Failed to remove constraint:', error);
        window.SynapseModals.appendSystem(`Error removing constraint: ${error.message}`, 'error');
      });
  }

  function renderCloseoutSummary(event, projectId, campaignId) {
    // Prevent event from bubbling up and closing campaign detail if it's a child element
    if (event) event.stopPropagation();

    // The closeoutSummary is part of the campaign object itself,
    // so we fetch the campaign detail to get the latest summary.
    fetchCampaignEnriched(projectId, campaignId)
      .then(campaign => {
        if (!campaign.closeoutSummary) {
          window.SynapseModals.appendSystem('No closeout summary available for this campaign.', 'info');
          return;
        }

        const closeoutSummary = campaign.closeoutSummary;
        const closeoutMarkdown = campaign.closeoutMarkdown;

        let outcomeHtml = '';
        if (closeoutSummary.overallOutcome === 'success') {
          outcomeHtml = `<div class="co-outcome-header success">
            <h3 class="co-outcome-title">Campaign Successful! 🎉</h3>
            <p class="co-outcome-subtitle">All objectives met.</p>
          </div>`;
        } else if (closeoutSummary.overallOutcome === 'failed') {
          outcomeHtml = `<div class="co-outcome-header failed">
            <h3 class="co-outcome-title">Campaign Failed 😢</h3>
            <p class="co-outcome-subtitle">Objectives not fully met or critical issues encountered.</p>
          </div>`;
        } else {
          outcomeHtml = `<div class="co-outcome-header">
            <h3 class="co-outcome-title">Campaign Concluded</h3>
            <p class="co-outcome-subtitle">Final status: ${window.SynapseHealth.escapeHtml(closeoutSummary.overallOutcome || 'N/A')}</p>
          </div>`;
        }

        let milestonesBreakdownHtml = '';
        if (closeoutSummary.milestones && closeoutSummary.milestones.length > 0) {
          milestonesBreakdownHtml = `<div class="co-section">
            <h4 class="co-section-title"><i class="co-icon">🎯</i> Milestone Outcomes</h4>
            <div class="co-milestone-breakdown">
              ${closeoutSummary.milestones.map(ms => `
                <span class="co-ms-chip ${ms.status}">${window.SynapseHealth.escapeHtml(ms.title)}: ${ms.status.toUpperCase()}</span>
              `).join('')}
            </div>
          </div>`;
        }

        let agentPerformanceHtml = '';
        if (closeoutSummary.agentPerformance && closeoutSummary.agentPerformance.length > 0) {
          agentPerformanceHtml = `<div class="co-section">
            <h4 class="co-section-title"><i class="co-icon">🤖</i> Agent Performance</h4>
            <table class="co-agent-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Tasks Done</th>
                  <th>Tasks Failed</th>
                  <th>Success Rate</th>
                  <th>Total Cost</th>
                </tr>
              </thead>
              <tbody>
                ${closeoutSummary.agentPerformance.map(ap => {
                  const successRateClass = ap.successRate > 0.8 ? 'success-rate' : (ap.successRate > 0.5 ? 'success-rate med' : 'success-rate low');
                  return `
                    <tr>
                      <td class="agent-name">${window.SynapseHealth.escapeHtml(ap.agentId)}</td>
                      <td class="stat-value">${ap.tasksDone}</td>
                      <td class="stat-value">${ap.tasksFailed}</td>
                      <td class="${successRateClass}">${(ap.successRate * 100).toFixed(1)}%</td>
                      <td class="stat-value">$${ap.totalCost.toFixed(2)}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>`;
        }

        let durationHtml = '';
        if (closeoutSummary.durationMs) {
          durationHtml = `<div class="co-section">
            <h4 class="co-section-title"><i class="co-icon">⏱️</i> Duration</h4>
            <div class="co-duration-display">
              <div class="co-duration-item">
                <div class="co-duration-label">Total Time</div>
                <div class="co-duration-value">${window.SynapseHealth.formatDuration(closeoutSummary.durationMs)}</div>
              </div>
            </div>
          </div>`;
        }

        let learningsHtml = '';
        if (closeoutSummary.keyLearnings && closeoutSummary.keyLearnings.length > 0) {
          learningsHtml = `<div class="co-section">
            <h4 class="co-section-title"><i class="co-icon">💡</i> Key Learnings</h4>
            <div class="co-learnings-list">
              ${closeoutSummary.keyLearnings.map((learning, index) => `
                <div class="co-learning-item" onclick="this.classList.toggle('expanded')">
                  <div class="co-learning-header">
                    <span class="co-learning-icon">📖</span>
                    <span class="co-learning-title">${window.SynapseHealth.escapeHtml(learning.title)}</span>
                    <span class="co-learning-chevron">▶</span>
                  </div>
                  <div class="co-learning-details">${window.SynapseHealth.escapeHtml(learning.description)}</div>
                </div>
              `).join('')}
            </div>
          </div>`;
        }

        let narrativeSummaryHtml = '';
        if (closeoutMarkdown) {
          narrativeSummaryHtml = `<div class="co-section">
            <h4 class="co-section-title"><i class="co-icon">📝</i> Narrative Summary</h4>
            <div class="co-narrative-summary">${window.SynapseHealth.escapeHtml(closeoutMarkdown)}</div>
          </div>`;
        } else if (closeoutSummary.narrativeSummary) {
          narrativeSummaryHtml = `<div class="co-section">
            <h4 class="co-section-title"><i class="co-icon">📝</i> Narrative Summary</h4>
            <div class="co-narrative-summary">${window.SynapseHealth.escapeHtml(closeoutSummary.narrativeSummary)}</div>
          </div>`;
        }

        const modalContent = `
          <div style="padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
              <h2 style="font-size: 20px; font-weight: 700; color: var(--text-strong);">Campaign Closeout Report</h2>
              <button class="agent-settings-close" onclick="window.SynapseModals.closeModal('modal-closeout-summary')">×</button>
            </div>
            <div style="max-height: 70vh; overflow-y: auto; padding-right: 10px;">
              ${outcomeHtml}
              ${milestonesBreakdownHtml}
              ${agentPerformanceHtml}
              ${durationHtml}
              ${learningsHtml}
              ${narrativeSummaryHtml}
              ${!outcomeHtml && !milestonesBreakdownHtml && !agentPerformanceHtml && !durationHtml && !learningsHtml && !narrativeSummaryHtml ? '<div class="co-empty-state">No detailed closeout information available.</div>' : ''}
            </div>
          </div>
        `;
        window.SynapseModals.openModal('modal-closeout-summary', modalContent);
      })
      .catch(error => {
        console.error('Failed to load closeout summary:', error);
        window.SynapseModals.appendSystem(`Error loading closeout summary: ${error.message}`, 'error');
      });
  }

  function campaignAction(projectId, campaignId, action, successMessage) {
    return window.SynapseWebSocket.authFetch(`/api/projects/${projectId}/campaigns/${campaignId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
      .then(response => {
        window.SynapseModals.appendSystem(successMessage || `Campaign action "${action}" successful.`);
        return response;
      })
      .catch(error => {
        console.error(`Failed to perform campaign action "${action}":`, error);
        window.SynapseModals.appendSystem(`Error performing action "${action}": ${error.message}`, 'error');
        throw error; // Re-throw to allow further handling if needed
      });
  }

  // --- Initialization ---
  function init() {
    campaignsPanel = document.getElementById('campaigns-panel');
    campaignDetailOverlay = document.getElementById('campaign-detail-overlay');
    campaignDetailPanel = document.getElementById('campaign-detail-panel');

    // Attach event listeners for closing campaign detail
    if (campaignDetailOverlay) {
      campaignDetailOverlay.addEventListener('click', (event) => {
        if (event.target === campaignDetailOverlay) {
          closeCampaignDetail();
        }
      });
    }

    // Set up polling for campaigns list
    setInterval(refreshCampaigns, 60000); // Refresh campaigns list every 60 seconds
    refreshCampaigns(); // Initial load
  }

  // Initial setup for the module
  document.addEventListener('DOMContentLoaded', init);

  // Public API
  return {
    // CampaignSelectors exports
    normalizeCampaign,
    normalizeMilestones,
    countTaskStatuses,
    calculateMilestoneProgress,
    calculateCampaignProgress,
    aggregateTaskPipeline,
    getPriorityBadge,
    getStatusClass,
    createEmptyCampaignViewModel,
    CAMPAIGN_STATUSES,

    // Campaign UI functions
    activeCampaignDetailId, // Expose for external reference if needed
    activeCampaignDetailProject, // Expose for external reference if needed
    closeCampaignDetail,
    refreshCampaigns,
    refreshCampaignList,
    fetchCampaignEnriched,
    refreshCampaignDetail,
    refreshActiveCampaignModal,
    startCampaignPolling,
    stopCampaignPolling,
    startConstraintPolling,
    stopConstraintPolling,
    renderCampaigns,
    openCampaignDetail,
    pauseCampaign,
    resumeCampaign,
    approveCampaign,
    renderCampaignDetail,
    toggleRoutingDecisions,
    loadRoutingDecisions,
    renderRoutingDecisionsTable,
    loadMoreRoutingDecisions,
    appendLiveRoutingDecision,
    expandRoutingRow,
    toggleConstraintBuilder,
    updateConstraintFields,
    validateConstraintForm,
    submitConstraint,
    loadActiveConstraints,
    renderActiveConstraints,
    removeConstraint,
    renderCloseoutSummary,
    campaignAction,
  };
})();
