/**
 * Structured exit-signal classifier (Findings #3 & #4).
 *
 * Precedence:
 *  1. Structured `err.exitCode` (or numeric/null `err.code`) ALWAYS wins:
 *     - `null` => `{ isExit143: false, isExitNull: true, exitCode: null }` (local signal exempt)
 *     - number => `{ isExit143: code === 143, isExitNull: false, exitCode: code }`
 *  2. Only when structured exit status is `undefined`, inspect message text:
 *     - Explicit `exit null` / `exit code null` takes precedence over any 143 mention.
 *     - Only match strict word-bounded `exit 143` / `exit code 143` (never `exit 1430` or `"previous 143"`).
 */
export function classifyExitSignal(errOrInput) {
  if (!errOrInput) {
    return { isExit143: false, isExitNull: false, exitCode: undefined };
  }

  let structuredCode = undefined;
  if (typeof errOrInput === 'object') {
    if (Object.prototype.hasOwnProperty.call(errOrInput, 'exitCode') && errOrInput.exitCode !== undefined) {
      structuredCode = errOrInput.exitCode;
    } else if (
      Object.prototype.hasOwnProperty.call(errOrInput, 'code') &&
      (errOrInput.code === null || typeof errOrInput.code === 'number')
    ) {
      structuredCode = errOrInput.code;
    }
  }

  if (structuredCode === null) {
    return { isExit143: false, isExitNull: true, exitCode: null };
  }
  if (typeof structuredCode === 'number') {
    return {
      isExit143: structuredCode === 143,
      isExitNull: false,
      exitCode: structuredCode,
    };
  }

  const msg = typeof errOrInput === 'string'
    ? errOrInput
    : String(errOrInput.message || errOrInput.reason || '');

  // Explicit exit null in message takes precedence over any stderr mention of 143
  if (/(?:^|[\s(:])exit(?:\s+code)?\s*[:=]?\s*null(?:\s|$|[):,])/i.test(msg)) {
    return { isExit143: false, isExitNull: true, exitCode: null };
  }
  // Strict start-anchored exit 143 match (never matches exit 1430 or prose like "stderr mentions previous exit 143")
  if (/^\s*(?:(?:providererror|error|command failed|process\s+(?:exited|terminated)(?:\s+with)?)\s*[:\-]?\s*)?exit(?:\s+code)?\s*[:=]?\s*143(?:\s|$|[):,])/i.test(msg)) {
    return { isExit143: true, isExitNull: false, exitCode: 143 };
  }

  return { isExit143: false, isExitNull: false, exitCode: undefined };
}
