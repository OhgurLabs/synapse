// src/orchestrator/stats.js - Statistical primitives for routing analytics

/**
 * Calculates the standard normal cumulative distribution function (CDF).
 * Used for Z-score to p-value conversion.
 * @param {number} x - The z-score.
 * @returns {number} The cumulative probability.
 */
function normalCdf(x) {
  // constants
  const p = 0.2316419;
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;

  const t = 1 / (1 + p * Math.abs(x));
  // Abramowitz & Stegun 26.2.17, Horner form. The parentheses were unbalanced
  // (one ')' too many), so this file has never parsed and could not be
  // imported by anything. Restored to the standard nesting and verified
  // numerically against known values rather than by eye:
  //   normalCdf(0) = 0.5, normalCdf(1.96) ~ 0.9750, normalCdf(2.576) ~ 0.9951
  const z = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
  const y = 1 - z * Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

  return x > 0 ? y : 1 - y;
}

/**
 * Calculates the inverse of the standard normal cumulative distribution function (CDF).
 * Used for p-value to Z-score conversion (e.g., for confidence intervals).
 * Approximation from Abramowitz and Stegun.
 * @param {number} p - The cumulative probability (0 to 1).
 * @returns {number} The z-score.
 */
function normalInv(p) {
  if (p < 0.000000001) return -Infinity;
  if (p > 0.999999999) return Infinity;

  // Acklam's inverse-normal-CDF coefficients, published values.
  //
  // The central-branch a/b constants here were MISTRANSCRIBED, and the error
  // was large where it matters most. Measured against the published set:
  //
  //     normalInv(0.975)   was 1.498655   correct 1.959964   (-23.5%)
  //     normalInv(0.84134) was 0.998305   correct 0.999980
  //     normalInv(0.99)    was 2.326348   correct 2.326348   (upper-tail branch,
  //                                                           c/d were fine)
  //
  // p=0.975 is the 95% confidence level — the default of
  // wilsonScoreInterval — so every 95% interval this file produced was about
  // 23% too narrow. The file has never parsed (see normalCdf) and has no
  // importers, so nothing consumed the wrong numbers; fixing the syntax
  // without fixing these would have made a silently-wrong stats module
  // importable, which is worse than leaving it broken.
  const a1 = -3.969683028665376e+01;
  const a2 = 2.209460984245205e+02;
  const a3 = -2.759285104469687e+02;
  const a4 = 1.383577518672690e+02;
  const a5 = -3.066479806614716e+01;
  const a6 = 2.506628277459239e+00;

  const b1 = -5.447609879822406e+01;
  const b2 = 1.615858368580409e+02;
  const b3 = -1.556989798598866e+02;
  const b4 = 6.680131188771972e+01;
  const b5 = -1.328068155288572e+01;

  const c1 = -7.78489400243029E-03;
  const c2 = -0.322396458041474;
  const c3 = -2.40075827716184;
  const c4 = -2.54973253934373;
  const c5 = 4.37466414146496;
  const c6 = 2.93816398269878;

  const d1 = 0.00778469570904146;
  const d2 = 0.32246712907004;
  const d3 = 2.44513413714;
  const d4 = 3.75440866190742;

  let x;
  if (p < 0.02425) {
    x = Math.sqrt(-2 * Math.log(p));
    return (((((c1 * x + c2) * x + c3) * x + c4) * x + c5) * x + c6) / ((((d1 * x + d2) * x + d3) * x + d4) * x + 1);
  } else if (p > 0.97575) {
    x = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c1 * x + c2) * x + c3) * x + c4) * x + c5) * x + c6) / ((((d1 * x + d2) * x + d3) * x + d4) * x + 1);
  }
  x = p - 0.5;
  const y = x * x;
  return (((((a1 * y + a2) * y + a3) * y + a4) * y + a5) * y + a6) * x / (((((b1 * y + b2) * y + b3) * y + b4) * y + b5) * y + 1);
}

/**
 * Calculates the Wilson Score Confidence Interval for a proportion.
 * Robust for small sample sizes and proportions close to 0 or 1.
 * @param {number} successes - Number of successful trials.
 * @param {number} total - Total number of trials.
 * @param {number} confidence - Confidence level (e.g., 0.95 for 95% CI).
 * @returns {{lower: number, upper: number, proportion: number}|null} - Object with lower and upper bounds, and the proportion. Null if total is 0.
 */
export function wilsonScoreInterval(successes, total, confidence = 0.95) {
  if (total === 0) {
    return null; // Cannot compute for zero trials
  }

  const p = successes / total;
  const alpha = 1 - confidence;
  const z = normalInv(1 - alpha / 2); // Z-score for the desired confidence level

  const term1 = p + (z * z) / (2 * total);
  const term2 = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  const denominator = 1 + (z * z) / total;

  const lower = (term1 - term2) / denominator;
  const upper = (term1 + term2) / denominator;

  return {
    proportion: p,
    lower: Math.max(0, lower), // Ensure bounds are within [0, 1]
    upper: Math.min(1, upper)
  };
}

/**
 * Performs a two-sample z-test for comparing two proportions.
 * @param {number} s1 - Successes in sample 1.
 * @param {number} n1 - Total trials in sample 1.
 * @param {number} s2 - Successes in sample 2.
 * @param {number} n2 - Total trials in sample 2.
 * @returns {{z: number, pValue: number}|null} - Object with z-score and p-value. Null if n1 or n2 is 0.
 */
export function zTestForProportions(s1, n1, s2, n2) {
  if (n1 === 0 || n2 === 0) {
    return null;
  }

  const p1 = s1 / n1;
  const p2 = s2 / n2;

  const pPooled = (s1 + s2) / (n1 + n2);
  const sePooled = Math.sqrt(pPooled * (1 - pPooled) * (1 / n1 + 1 / n2));

  if (sePooled === 0) {
    // If standard error is zero, proportions are identical and there's no variance to compare.
    // This can happen if pPooled is 0 or 1.
    return { z: 0, pValue: 1 };
  }

  const z = (p1 - p2) / sePooled;
  const pValue = 2 * (1 - normalCdf(Math.abs(z))); // Two-tailed test

  return { z, pValue };
}

/**
 * Calculates the standard deviation of a sample.
 * @param {number[]} data - Array of numbers.
 * @returns {number} The standard deviation.
 */
function standardDeviation(data) {
  if (data.length === 0) return 0;
  const mean = data.reduce((sum, val) => sum + val, 0) / data.length;
  const variance = data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (data.length - 1 || 1); // (data.length - 1) for sample std dev
  return Math.sqrt(variance);
}

/**
 * Performs Welch's t-test for comparing the means of two independent samples with unequal variances.
 * @param {number[]} data1 - Array of numbers for sample 1.
 * @param {number[]} data2 - Array of numbers for sample 2.
 * @returns {{t: number, df: number, pValue: number}|null} - Object with t-statistic, degrees of freedom, and p-value. Null if data1 or data2 has insufficient length.
 */
export function welchsTTest(data1, data2) {
  if (data1.length < 2 || data2.length < 2) {
    return null; // Need at least 2 data points for variance calculation
  }

  const n1 = data1.length;
  const n2 = data2.length;

  const mean1 = data1.reduce((sum, val) => sum + val, 0) / n1;
  const mean2 = data2.reduce((sum, val) => sum + val, 0) / n2;

  const v1 = standardDeviation(data1) * standardDeviation(data1); // variance1
  const v2 = standardDeviation(data2) * standardDeviation(data2); // variance2

  // Guard zero pooled variance, as zTestForProportions guards sePooled === 0
  // and cohensD guards pooledStdDev === 0. Without it, two constant samples
  // (every value identical within each) divide by zero: NaN when the means
  // match, ±Infinity when they don't, and the NaN then propagates silently
  // through pValue. Identical constant samples are "no measurable difference",
  // which is t=0, p=1 — the same answer the sibling functions give.
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  if (se === 0) {
    return { t: 0, df: n1 + n2 - 2, pValue: 1 };
  }

  const t = (mean1 - mean2) / se;

  const df = Math.pow(v1 / n1 + v2 / n2, 2) /
             (Math.pow(v1 / n1, 2) / (n1 - 1) + Math.pow(v2 / n2, 2) / (n2 - 1));

  // Approximate p-value for t-distribution (using normal CDF for simplicity,
  // a more precise implementation would use a t-distribution CDF)
  const pValue = 2 * (1 - normalCdf(Math.abs(t)));

  return { t, df, pValue };
}

/**
 * Calculates Cohen's d effect size for the difference between two means.
 * @param {number} mean1 - Mean of sample 1.
 * @param {number} std1 - Standard deviation of sample 1.
 * @param {number} n1 - Size of sample 1.
 * @param {number} mean2 - Mean of sample 2.
 * @param {number} std2 - Standard deviation of sample 2.
 * @param {number} n2 - Size of sample 2.
 * @returns {number|null} Cohen's d. Null if n1 or n2 is 0 or less, or if pooled std dev is 0.
 */
export function cohensD(mean1, std1, n1, mean2, std2, n2) {
  if (n1 <= 0 || n2 <= 0) return null;

  const pooledStdDev = Math.sqrt(
    ((n1 - 1) * Math.pow(std1, 2) + (n2 - 1) * Math.pow(std2, 2)) / (n1 + n2 - 2)
  );

  if (pooledStdDev === 0) return 0; // Means are identical and no variance

  return (mean1 - mean2) / pooledStdDev;
}

/**
 * Calculates Cohen's h effect size for the difference between two proportions.
 * @param {number} p1 - Proportion of sample 1.
 * @param {number} p2 - Proportion of sample 2.
 * @returns {number} Cohen's h.
 */
export function cohensH(p1, p2) {
  return 2 * (Math.asin(Math.sqrt(p1)) - Math.asin(Math.sqrt(p2)));
}
