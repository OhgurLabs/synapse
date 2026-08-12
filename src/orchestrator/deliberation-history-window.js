// Bounding the deliberation history that goes into a reviewer's prompt.
//
// Extracted from lifecycle.js so it can actually be tested. The first two
// attempts at this were both wrong, and neither was catchable in place:
//
//   1. `history.slice(-maxHistory)` — keeps only the tail, so on any session
//      longer than the cap the reviewer gets verdicts about a PROPOSAL it
//      cannot see.
//   2. `[history[0], ...history.slice(-(maxHistory - 1))]` — anchors on index
//      0, but index 0 is a 'session_initiated' record carrying only { topic }
//      (deliberation-protocol _createInitialState). The PROPOSAL is the NEXT
//      substantive message, so this preserved the envelope and dropped the
//      contents. It also degenerates at maxHistory === 1, where slice(-0) is
//      slice(0) and returns the WHOLE array, silently disabling the cap.

import { MESSAGE_TYPES } from './deliberation-protocol.js';

/**
 * Choose which deliberation messages to show a reviewer.
 *
 * Always keeps the topic record and the first PROPOSAL, then fills the
 * remaining budget from the most recent messages. Any gap is in the middle,
 * and the caller is told how large it is so the prompt can say so — a silently
 * clipped history reads as a complete one.
 *
 * @param {Array<{type: string}>} history - session.messageHistory
 * @param {number} maxHistory - soft cap on returned messages
 * @returns {{bounded: Array, truncated: number}}
 */
export function boundDeliberationHistory(history, maxHistory) {
  const msgs = Array.isArray(history) ? history : [];
  const cap = Number.isFinite(maxHistory) && maxHistory > 0 ? Math.floor(maxHistory) : 20;

  if (msgs.length <= cap) return { bounded: msgs, truncated: 0 };

  // Indices, so an anchor that already falls inside the tail is not duplicated.
  const keep = new Set([0]);
  const proposalIdx = msgs.findIndex(m => m?.type === MESSAGE_TYPES.PROPOSAL);
  if (proposalIdx >= 0) keep.add(proposalIdx);

  // If cap is smaller than the anchor count the anchors still win: topic +
  // proposal is strictly more useful than an arbitrary trailing message.
  const tailBudget = Math.max(0, cap - keep.size);
  for (let i = Math.max(0, msgs.length - tailBudget); i < msgs.length; i++) keep.add(i);

  const bounded = [...keep].sort((a, b) => a - b).map(i => msgs[i]);
  return { bounded, truncated: msgs.length - bounded.length };
}
