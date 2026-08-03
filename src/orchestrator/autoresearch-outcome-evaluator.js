/**
 * Autoresearch outcome evaluator — normalize heterogeneous cycle result schemas,
 * compute statistical significance, and return structured evaluation for routing proposals.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Normalize metrics from heterogeneous autoresearch result schemas to a common format.
 * Handles: score/rawPassRate/retryFreeRate (nia/carl/kai) and variations.
 *
 * @param {Object} resultData - Raw cycle result JSON
 * @param {Object} postcycleData - Raw postcycle metrics JSON (may be null)
 * @returns {{ baseline: Object, post: Object }} Normalized { success_rate, avg_latency, quality_score }
 */
function normalizeMetrics(resultData, postcycleData) {
  const extractMetrics = (data) => {
    if (!data) return null;

    // Handle metrics.baseline or metrics.post structure (nia/carl style)
    let baselineRaw = data.metrics?.baseline || null;
    let postRaw = data.metrics?.post || null;

    // If postcycleData is provided as separate file, use it for post metrics
    if (postcycleData && postcycleData.metrics) {
      postRaw = postcycleData.metrics;
    } else if (postcycleData && postcycleData.score !== undefined) {
      // Flatten structure (carl/kai post.json style)
      postRaw = postcycleData;
    }

    const mapMetric = (raw) => {
      if (!raw) return null;
      return {
        success_rate: raw.rawPassRate ?? raw.score ?? null,
        avg_latency: raw.retryFreeRate ?? null,
        quality_score: raw.score ?? raw.qualityScore ?? null,
        sampleSize: raw.sampleSize ?? raw.totalDone ?? raw.totalAssigned ?? null,
        agentId: raw.agentId || null,
      };
    };

    return {
      baseline: mapMetric(baselineRaw),
      post: mapMetric(postRaw),
    };
  };

  return extractMetrics(resultData);
}

/**
 * Evaluate whether an autoresearch cycle shows statistically significant improvement.
 *
 * Primary check: ≥10% relative improvement in primary metric (quality_score) with ≥10 post-apply completions
 * Fallback: ≥15% relative improvement, ≥8 data points + needsOperatorReview: true
 *
 * @param {string} cycleDir - Directory containing cycle result files (e.g., 'autoresearch/nia')
 * @param {number} cycleNumber - Cycle number to evaluate (e.g., 2)
 * @returns {{ significant: boolean, agentId: string, cycleId: string, cycleDir: string, metrics: { baseline: Object, post: Object, relativeImprovement: number, absoluteDelta: number }, sampleSize: number, needsOperatorReview: boolean, reason: string }}
 */
export function evaluateAutoresearchOutcome(cycleDir, cycleNumber) {
  const resultPath = join(cycleDir, `cycle_${cycleNumber}_result.json`);
  const postcyclePath = join(cycleDir, `cycle_${cycleNumber}_postcycle_metrics.json`);

  // Load cycle result file
  if (!existsSync(resultPath)) {
    return {
      significant: false,
      agentId: null,
      cycleId: `cycle_${cycleNumber}`,
      cycleDir,
      metrics: { baseline: null, post: null, relativeImprovement: 0, absoluteDelta: 0 },
      sampleSize: 0,
      needsOperatorReview: false,
      reason: `Cycle result file not found: ${resultPath}`,
    };
  }

  const resultData = JSON.parse(readFileSync(resultPath, 'utf-8'));

  // Load optional postcycle metrics file
  let postcycleData = null;
  if (existsSync(postcyclePath)) {
    postcycleData = JSON.parse(readFileSync(postcyclePath, 'utf-8'));
  }

  // Normalize metrics
  const normalized = normalizeMetrics(resultData, postcycleData);

  if (!normalized.baseline || !normalized.post) {
    return {
      significant: false,
      agentId: resultData.metrics?.baseline?.agentId || null,
      cycleId: `cycle_${cycleNumber}`,
      cycleDir,
      metrics: { baseline: normalized.baseline, post: normalized.post, relativeImprovement: 0, absoluteDelta: 0 },
      sampleSize: 0,
      needsOperatorReview: false,
      reason: 'Missing baseline or post metrics in cycle data',
    };
  }

  const agentId = normalized.baseline.agentId || normalized.post.agentId || resultData.metrics?.baseline?.agentId || null;
  const primaryMetric = 'quality_score';
  const baselineValue = normalized.baseline[primaryMetric];
  const postValue = normalized.post[primaryMetric];

  if (baselineValue === null || postValue === null) {
    return {
      significant: false,
      agentId,
      cycleId: `cycle_${cycleNumber}`,
      cycleDir,
      metrics: { baseline: normalized.baseline, post: normalized.post, relativeImprovement: 0, absoluteDelta: 0 },
      sampleSize: 0,
      needsOperatorReview: false,
      reason: `Primary metric (${primaryMetric}) not available in baseline or post data`,
    };
  }

  // Calculate sample size - prefer postApplyCompletions from result data, fallback to post metrics sampleSize
  const postApplyCompletions = resultData.postApplyCompletions || 0;
  const postMetricsSampleSize = normalized.post.sampleSize || 0;
  const sampleSize = postApplyCompletions > 0 ? postApplyCompletions : postMetricsSampleSize;

  // Calculate improvement metrics
  const absoluteDelta = postValue - baselineValue;
  const relativeImprovement = baselineValue !== 0 ? (absoluteDelta / Math.abs(baselineValue)) * 100 : 0;

  // Apply significance check
  let significant = false;
  let needsOperatorReview = false;
  let reason = '';

  // Primary threshold: ≥10% relative improvement with ≥10 completions
  if (relativeImprovement >= 10 && sampleSize >= 10) {
    significant = true;
    reason = `Primary threshold met: ${relativeImprovement.toFixed(2)}% improvement with ${sampleSize} samples (≥10% with ≥10 completions)`;
  }
  // Fallback threshold: ≥15% relative improvement, ≥8 completions + operator review
  // Used when primary check fails solely due to small sample size
  else if (relativeImprovement >= 15 && postMetricsSampleSize >= 8) {
    significant = true;
    needsOperatorReview = true;
    reason = `Fallback threshold met: ${relativeImprovement.toFixed(2)}% improvement with ${postMetricsSampleSize} data points, requires operator review (≥15% with ≥8 completions)`;
  }
  // Below threshold
  else if (sampleSize < 10) {
    significant = false;
    reason = `Insufficient sample size: ${sampleSize} completions (need ≥10 for significance check)`;
  } else {
    significant = false;
    reason = `Improvement below threshold: ${relativeImprovement.toFixed(2)}% relative improvement (need ≥10% primary or ≥15% fallback)`;
  }

  return {
    significant,
    agentId,
    cycleId: `cycle_${cycleNumber}`,
    cycleDir,
    metrics: {
      baseline: normalized.baseline,
      post: normalized.post,
      relativeImprovement,
      absoluteDelta,
    },
    sampleSize,
    needsOperatorReview,
    reason,
  };
}

/**
 * Discover completed autoresearch cycles not yet evaluated.
 * Scans autoresearch subdirectories for cycle_N_result.json files with result: 'complete',
 * excluding those marked as evaluated (presence of a _evaluated flag or evaluation output marker).
 *
 * @param {string} baseDir - Base directory containing agent subdirectories (e.g., 'autoresearch')
 * @returns {Array} Array of unresolved cycle entries, each with cycleDir, cycleNumber, agentId
 */
export function discoverCycles(baseDir) {
  const cycles = [];

  if (!existsSync(baseDir) || !statSync(baseDir).isDirectory()) {
    return cycles;
  }

  // Get all agent directories
  const agents = readdirSync(baseDir).filter((name) => {
    const path = join(baseDir, name);
    return statSync(path).isDirectory();
  });

  for (const agentId of agents) {
    const agentDir = join(baseDir, agentId);

    // Find all cycle result files
    try {
      const files = readdirSync(agentDir).filter((file) => file.match(/^cycle_\d+_result\.json$/));

      for (const file of files) {
        const match = file.match(/^cycle_(\d+)_result\.json$/);
        if (!match) continue;

        const cycleNumber = parseInt(match[1], 10);
        const resultPath = join(agentDir, file);

        // Load and check result status
        const resultData = JSON.parse(readFileSync(resultPath, 'utf-8'));

        // Skip non-complete cycles
        if (resultData.result !== 'complete') {
          continue;
        }

        // Check if already evaluated (look for _evaluated marker or evaluation output)
        const evaluatedMarker = join(agentDir, `cycle_${cycleNumber}_evaluated`);
        const evaluationOutput = join(agentDir, `cycle_${cycleNumber}_evaluation.json`);
        const postcycleFile = join(agentDir, `cycle_${cycleNumber}_postcycle_metrics.json`);

        // Consider cycle as evaluated if:
        // 1. Has explicit _evaluated marker file, OR
        // 2. Has evaluation output file, OR
        // 3. Has postcycle metrics file (implies evaluation was done)
        const isEvaluated = existsSync(evaluatedMarker) ||
          existsSync(evaluationOutput) ||
          existsSync(postcycleFile);

        if (isEvaluated) {
          continue;
        }

        cycles.push({
          cycleDir: agentDir,
          cycleNumber,
          agentId,
        });
      }
    } catch (err) {
      // Skip agents with read errors
      continue;
    }
  }

  return cycles;
}

export default {
  evaluateAutoresearchOutcome,
  discoverCycles,
  normalizeMetrics,
};
