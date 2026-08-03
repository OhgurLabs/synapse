/**
 * @module reviewer-metrics.js
 * @domain Reviewer Accountability & Quality Metrics
 * @description Reviewer accuracy dashboard panel with WebSocket updates.
 *   Displays per-reviewer accuracy stats (total reviews, overturned count, accuracy %)
 *   and subscribes to real-time updates when rejections are overturned.
 *
 * @namespace window.SynapseReviewerMetrics
 * @exports {
 *   init(): void,
 *   renderReviewerMetrics(): void,
 *   refreshReviewerMetrics(): void,
 *   handleReviewerAccuracyUpdate(data: Object): void
 * }
 * @depends window.SynapseWebSocket.authFetch
 *          window.SynapseHealth.escapeHtml
 * @init init() — call after DOMContentLoaded
 */
(function () {
  'use strict';

  // --- State ---
  let reviewerMetricsPanel = null;
  let reviewerAccuracyData = [];
  let teamWideAccuracy = null;
  let metricsWindow = '30d';
  let fetchError = null;
  let lastRefreshTime = 0;
  const REFRESH_THROTTLE_MS = 5000; // 5 seconds

  // --- Constants ---
  const ACCURACY_THRESHOLDS = {
    excellent: 95, // >= 95% → green
    good: 85,      // >= 85% → yellow
    poor: 0        // < 85% → red
  };

  // --- Utility Functions ---
  function getEscapeHtml() {
    return window.SynapseHealth?.escapeHtml || (str => String(str || ''));
  }

  function getAuthFetch() {
    return window.SynapseWebSocket?.authFetch;
  }

  function toFiniteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeReviewerMetricsPayload(payload) {
    if (!payload) {
      return { reviewers: [], teamWideAccuracy: null, window: metricsWindow };
    }

    const rawReviewers = Array.isArray(payload.reviewers)
      ? payload.reviewers
      : Array.isArray(payload)
        ? payload
        : Object.values(payload);

    const reviewers = rawReviewers
      .filter((reviewer) => reviewer && typeof reviewer === 'object')
      .map((reviewer) => {
        const totalReviews = toFiniteNumber(reviewer.total_reviews);
        const overturnedCount = toFiniteNumber(reviewer.overturned_count);
        const correctReviews = reviewer.correct_reviews !== undefined
          ? toFiniteNumber(reviewer.correct_reviews)
          : Math.max(totalReviews - overturnedCount, 0);
        const accuracyPercentage = reviewer.accuracy_percentage !== undefined
          ? toFiniteNumber(reviewer.accuracy_percentage)
          : totalReviews > 0
            ? +((correctReviews / totalReviews) * 100).toFixed(2)
            : 0;

        return {
          reviewer_id: String(reviewer.reviewer_id || reviewer.reviewerId || 'unknown'),
          total_reviews: totalReviews,
          overturned_count: overturnedCount,
          correct_reviews: correctReviews,
          accuracy_percentage: accuracyPercentage,
        };
      })
      .sort((a, b) => {
        const countDiff = b.total_reviews - a.total_reviews;
        if (countDiff !== 0) return countDiff;
        return a.reviewer_id.localeCompare(b.reviewer_id);
      });

    const rawTeamAccuracy = payload.team_wide_accuracy ?? payload.teamWideAccuracy ?? null;
    return {
      reviewers,
      teamWideAccuracy: rawTeamAccuracy === null ? null : toFiniteNumber(rawTeamAccuracy, null),
      window: payload.window || metricsWindow,
    };
  }

  /**
   * Format accuracy percentage with color coding based on thresholds.
   * @param {number} accuracy - Accuracy percentage (0-100)
   * @returns {string} CSS class name for color coding
   */
  function getAccuracyClass(accuracy) {
    if (accuracy >= ACCURACY_THRESHOLDS.excellent) return 'excellent';
    if (accuracy >= ACCURACY_THRESHOLDS.good) return 'good';
    return 'poor';
  }

  // --- Refresh Logic ---
  async function refreshReviewerMetrics() {
    const now = Date.now();
    if (now - lastRefreshTime < REFRESH_THROTTLE_MS) {
      return; // Throttle requests
    }
    lastRefreshTime = now;

    const authFetch = getAuthFetch();
    if (!authFetch) return;

    try {
      const res = await authFetch('/api/metrics/reviewer-accuracy?window=30d');

      if (res.ok) {
        const payload = await res.json();
        const normalized = normalizeReviewerMetricsPayload(payload);
        reviewerAccuracyData = normalized.reviewers;
        teamWideAccuracy = normalized.teamWideAccuracy;
        metricsWindow = normalized.window || metricsWindow;
        fetchError = null;
        renderReviewerMetrics();
      } else {
        fetchError = `Reviewer metrics unavailable (${res.status})`;
        renderReviewerMetrics();
      }
    } catch (err) {
      fetchError = 'Reviewer metrics unavailable';
      console.error('Failed to fetch reviewer accuracy data:', err);
      renderReviewerMetrics();
    }
  }

  // --- Rendering ---
  function renderReviewerMetrics() {
    if (!reviewerMetricsPanel) return;

    const escapeHtml = getEscapeHtml();

    // Build header
    let html = `<div class="reviewer-metrics-header">📊 Reviewer Accuracy <span class="reviewer-window-label">(${escapeHtml(metricsWindow)})</span></div>`;

    if (fetchError) {
      html += `<div class="reviewer-metrics-empty">${escapeHtml(fetchError)}</div>`;
      reviewerMetricsPanel.innerHTML = html;
      return;
    }

    // If no data available
    if (!reviewerAccuracyData || reviewerAccuracyData.length === 0) {
      html += '<div class="reviewer-metrics-empty">No reviewer data available</div>';
      reviewerMetricsPanel.innerHTML = html;
      return;
    }

    if (teamWideAccuracy !== null) {
      const teamAccuracyClass = getAccuracyClass(teamWideAccuracy);
      html += '<div class="reviewer-team-summary">';
      html += '<span class="reviewer-stat-label">Team Accuracy</span>';
      html += `<span class="reviewer-stat-value reviewer-accuracy ${teamAccuracyClass}">${teamWideAccuracy.toFixed(1)}%</span>`;
      html += '</div>';
    }

    // Build metrics grid
    html += '<div class="reviewer-metrics-list">';

    for (const reviewer of reviewerAccuracyData) {
      const accuracyClass = getAccuracyClass(reviewer.accuracy_percentage);
      const reviewerId = escapeHtml(reviewer.reviewer_id);
      const totalReviews = reviewer.total_reviews;
      const overturnedCount = reviewer.overturned_count;
      const accuracyPct = toFiniteNumber(reviewer.accuracy_percentage).toFixed(1);

      html += '<div class="reviewer-metric-item">';
      html += `  <div class="reviewer-name">${reviewerId}</div>`;
      html += '  <div class="reviewer-stats">';
      html += `    <div class="reviewer-stat-row">`;
      html += `      <span class="reviewer-stat-label">Reviews:</span>`;
      html += `      <span class="reviewer-stat-value">${totalReviews}</span>`;
      html += `    </div>`;
      html += `    <div class="reviewer-stat-row">`;
      html += `      <span class="reviewer-stat-label">Overturned:</span>`;
      html += `      <span class="reviewer-stat-value reviewer-overturned">${overturnedCount}</span>`;
      html += `    </div>`;
      html += `    <div class="reviewer-stat-row">`;
      html += `      <span class="reviewer-stat-label">Accuracy:</span>`;
      html += `      <span class="reviewer-stat-value reviewer-accuracy ${accuracyClass}">${accuracyPct}%</span>`;
      html += `    </div>`;
      html += '  </div>';
      html += '</div>';
    }

    html += '</div>';
    reviewerMetricsPanel.innerHTML = html;
  }

  // --- WebSocket Event Handler ---
  /**
   * Handle real-time reviewer accuracy updates from WebSocket.
   * Called when an overturn event occurs or periodic updates are pushed.
   * @param {Object} data - Updated reviewer accuracy data
   */
  function handleReviewerAccuracyUpdate(data) {
    if (!data) return;

    const normalized = normalizeReviewerMetricsPayload(data);
    reviewerAccuracyData = normalized.reviewers;
    teamWideAccuracy = normalized.teamWideAccuracy;
    metricsWindow = normalized.window || metricsWindow;
    fetchError = null;
    renderReviewerMetrics();
  }

  // --- Initialization ---
  function init() {
    reviewerMetricsPanel = document.getElementById('reviewer-metrics-panel');
    if (!reviewerMetricsPanel) {
      console.warn('reviewer-metrics.js: #reviewer-metrics-panel not found in DOM');
      return;
    }

    // Initial fetch
    refreshReviewerMetrics();

    // Refresh periodically (every 60 seconds)
    setInterval(refreshReviewerMetrics, 60000);
  }

  // --- Exports ---
  window.SynapseReviewerMetrics = {
    init,
    renderReviewerMetrics,
    refreshReviewerMetrics,
    handleReviewerAccuracyUpdate
  };
})();
