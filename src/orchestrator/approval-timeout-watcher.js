// Approval timeout watcher — scans for milestones pending approval > 24h and auto-resumes them.
// Implements circuit breaker pattern to prevent system overload during timeout events.

import { createLogger } from '../logger.js';

const log = createLogger('approval-timeout-watcher');

const DEFAULT_SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const CIRCUIT_BREAKER_THRESHOLD = 3; // Trip after 3 timeouts in 24h per campaign
const CIRCUIT_BREAKER_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h window

/**
 * Circuit breaker state tracking per campaign
 * @typedef {Object} CircuitBreakerState
 * @property {boolean} open - Whether breaker is tripped
 * @property {number} trippedAt - Timestamp when opened
 * @property {Array} timeoutHistory - Array of timeout timestamps in window
 */

export function createApprovalTimeoutWatcher({
  campaignManager,
  stateManager,
  events,
  config,
  alertMonitor = null,
  circuitBreaker = null, // Centralized CircuitBreaker instance from orchestrator
}) {
  const scanIntervalMs = config?.approvalTimeoutWatcher?.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  const timeoutMs = config?.campaigns?.approvalTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  
  let interval = null;
  let isRunning = false;

  /**
   * Check if circuit breaker is open (tripped) for a campaign's approval timeouts
   * Uses centralized CircuitBreaker if available, otherwise returns false (allow)
   */
  function isCircuitBreakerOpen(campaignId) {
    if (!circuitBreaker || typeof circuitBreaker.canCampaignRequestApproval !== 'function') {
      return false; // No circuit breaker available, allow operation
    }
    // canCampaignRequestApproval returns false when circuit is OPEN (blocked)
    return !circuitBreaker.canCampaignRequestApproval(campaignId);
  }

  /**
   * Record a timeout event in the centralized circuit breaker
   */
  function recordTimeoutEvent(campaignId, milestoneId) {
    if (!circuitBreaker || typeof circuitBreaker.recordApprovalTimeout !== 'function') {
      return;
    }
    
    circuitBreaker.recordApprovalTimeout(campaignId, {
      milestoneId,
      correlationKeys: { campaignId },
    });
  }

  /**
   * Handle a single timeout event
   */
  async function handleTimeout(projectId, campaignId, milestoneId, milestone) {
    // Check circuit breaker
    if (isCircuitBreakerOpen(campaignId)) {
      log.warn('Skipping timeout auto-resume: circuit breaker open', {
        projectId,
        campaignId,
        milestoneId,
      });
      
      // Emit event for blocked timeout
      if (events) {
        events.emit('approval:timeout_blocked', {
          projectId,
          campaignId,
          milestoneId,
          reason: 'circuit_breaker_open',
        });
      }
      return false;
    }

    try {
      log.info('Processing approval timeout', {
        projectId,
        campaignId,
        milestoneId,
        title: milestone.title,
        approvalRequestedAt: milestone.approvalRequestedAt,
      });

      // Record the timeout event for circuit breaker
      recordTimeoutEvent(campaignId, milestoneId);

      // Re-check if we just tripped the breaker
      if (isCircuitBreakerOpen(campaignId)) {
        log.warn('Circuit breaker tripped during timeout processing', {
          campaignId,
          milestoneId,
        });
        
        // Emit event for blocked timeout
        if (events) {
          events.emit('approval:timeout_blocked', {
            projectId,
            campaignId,
            milestoneId,
            reason: 'circuit_breaker_open',
          });
        }
        return false;
      }

      // Auto-resume the milestone
      const reason = `Auto-resumed after approval timeout (${Math.round(timeoutMs / 3600000)}h)`;
      
      // Update approvalState to timeout before transitioning to active
      if (campaignManager && typeof campaignManager._saveWithRetryScoped === 'function') {
        campaignManager._saveWithRetryScoped(projectId, 'system',
          (d) => d.campaigns.find(c => c.id === campaignId),
          (d) => {
            const campaign = d.campaigns.find(c => c.id === campaignId);
            if (!campaign) return d;
            const ms = campaign.milestones.find(m => m.id === milestoneId);
            if (ms) {
              ms.approvalState = 'timeout';
              ms.updatedAt = new Date().toISOString();
            }
            campaign.updatedAt = new Date().toISOString();
            return d;
          }
        );
      }
      
      if (campaignManager && typeof campaignManager.updateMilestoneStatus === 'function') {
        await campaignManager.updateMilestoneStatus(
          projectId,
          campaignId,
          milestoneId,
          'active',
          reason,
          'system'
        );
      } else {
        log.error('CampaignManager not available for updateMilestoneStatus', {
          projectId,
          campaignId,
          milestoneId,
        });
        return false;
      }

      // Emit notification event
      if (events) {
        events.emit('approval:timeout_autoresume', {
          projectId,
          campaignId,
          milestoneId,
          reason,
          timeoutMs,
        });

        // Also emit to chat if available
        if (typeof events.emitMessage === 'function') {
          events.emitMessage({
            role: 'system',
            content: `⏰ **Approval Timeout Auto-Resume**\n\nMilestone "${milestone.title}" in campaign ${campaignId} has been automatically resumed after ${Math.round(timeoutMs / 3600000)}h of pending approval.\n\n**Action**: The milestone has transitioned from \`waiting_approval\` → \`active\`\n**Reason**: No operator approval received within timeout window`,
            metadata: {
              type: 'approval_timeout',
              projectId,
              campaignId,
              milestoneId,
            },
          });
        }
      }

      log.info('Milestone auto-resumed successfully', {
        projectId,
        campaignId,
        milestoneId,
        reason,
      });

      return true;
    } catch (err) {
      log.error('Failed to handle approval timeout', {
        projectId,
        campaignId,
        milestoneId,
        error: err.message,
      });
      return false;
    }
  }

  /**
   * Scan all campaigns for timeout candidates
   */
  async function scan() {
    if (!stateManager || typeof stateManager.listProjects !== 'function') {
      log.debug('StateManager not available, skipping scan');
      return;
    }

    const now = Date.now();
    const projects = stateManager.listProjects();
    const timeoutCandidates = [];

    // Collect all timeout candidates across all projects
    for (const proj of projects) {
      const pid = proj.id || proj;
      try {
        const campaigns = campaignManager.listCampaigns(pid, 'active');
        
        for (const campaign of campaigns) {
          // Skip if circuit breaker is open for this campaign
          if (isCircuitBreakerOpen(campaign.id)) {
            log.debug('Skipping campaign with open circuit breaker', { campaignId: campaign.id });
            continue;
          }

          for (const milestone of campaign.milestones) {
            if (milestone.status !== 'waiting_approval' || !milestone.approvalRequestedAt) {
              continue;
            }

            const elapsed = now - new Date(milestone.approvalRequestedAt).getTime();
            if (elapsed > timeoutMs) {
              timeoutCandidates.push({
                projectId: pid,
                campaignId: campaign.id,
                milestoneId: milestone.id,
                milestone,
                elapsed,
              });
            }
          }
        }
      } catch (err) {
        log.error('Error scanning project for timeouts', {
          projectId: pid,
          error: err.message,
        });
      }
    }

    // Process timeouts
    if (timeoutCandidates.length > 0) {
      log.info('Found approval timeout candidates', {
        count: timeoutCandidates.length,
        timeoutMs,
      });

      // Process sequentially to avoid race conditions
      for (const candidate of timeoutCandidates) {
        await handleTimeout(
          candidate.projectId,
          candidate.campaignId,
          candidate.milestoneId,
          candidate.milestone
        );
      }
    }
  }

  /**
   * Start the watcher
   */
  function start() {
    if (isRunning) {
      log.debug('Approval timeout watcher already running');
      return;
    }

    isRunning = true;
    log.info('Starting approval timeout watcher', {
      scanIntervalMs,
      timeoutMs,
      circuitBreakerEnabled: !!circuitBreaker,
    });

    // Initial scan
    scan().catch(err => {
      log.error('Initial scan failed', { error: err.message });
    });

    // Scheduled scans
    interval = setInterval(() => {
      scan().catch(err => {
        log.error('Scheduled scan failed', { error: err.message });
      });
    }, scanIntervalMs);

    // Handle unref to allow graceful shutdown
    if (typeof interval.unref === 'function') {
      interval.unref();
    }
  }

  /**
   * Stop the watcher
   */
  function stop() {
    if (!isRunning) {
      return;
    }

    if (interval) {
      clearInterval(interval);
      interval = null;
    }

    isRunning = false;
    log.info('Approval timeout watcher stopped');
  }

  /**
   * Manual trigger for testing
   */
  async function triggerScan() {
    log.info('Manual scan triggered');
    await scan();
  }

  /**
   * Get circuit breaker status for a campaign
   */
  function getCircuitBreakerStatus(campaignId) {
    if (circuitBreaker && typeof circuitBreaker.getCampaignApprovalStatus === 'function') {
      const status = circuitBreaker.getCampaignApprovalStatus(campaignId);
      return status || {
        open: false,
        state: 'closed',
        timeouts: 0,
        threshold: 3,
        windowMs: 24 * 60 * 60 * 1000,
      };
    }
    // Fallback: no circuit breaker available
    return {
      open: false,
      state: 'closed',
      timeouts: 0,
      threshold: 3,
      windowMs: 24 * 60 * 60 * 1000,
    };
  }

  /**
   * Reset circuit breaker manually (for operators)
   */
  function resetCircuitBreaker(campaignId, userId = 'system') {
    if (circuitBreaker && typeof circuitBreaker.resetCampaignApprovalBreaker === 'function') {
      circuitBreaker.resetCampaignApprovalBreaker(campaignId, { userId });
      log.info('Circuit breaker reset by operator', { campaignId, userId });
      return true;
    }
    log.warn('Cannot reset circuit breaker: not available', { campaignId });
    return false;
  }

  return {
    start,
    stop,
    scan: triggerScan,
    getCircuitBreakerStatus,
    resetCircuitBreaker,
    isRunning: () => isRunning,
  };
}
