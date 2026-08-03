export function computeBackoffWithJitter(retryNum, baseDelayMs, maxDelayMs) {
  // Exponential backoff with equable jitter
  // Delay = min(maxDelay, baseDelay * 2^retryNum) + random(0, baseDelay)
  // This ensures delays generally increase while adding randomness
  const exponentialBase = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, retryNum));
  const jitter = Math.floor(Math.random() * baseDelayMs);
  const totalDelay = exponentialBase + jitter;
  // Cap at maxDelayMs and ensure minimum of 1ms
  return Math.max(1, Math.min(maxDelayMs, totalDelay));
}
