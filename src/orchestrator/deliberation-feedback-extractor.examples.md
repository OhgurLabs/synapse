# Deliberation Feedback Extractor - Usage Examples

This document demonstrates how to use the deliberation feedback extraction service in the review-revise loop.

## Basic Usage

### 1. Extract all review feedback from a session

```javascript
import { DeliberationProtocol } from './deliberation-protocol.js';
import { extractReviewFeedback } from './deliberation-feedback-extractor.js';

// Get session state from protocol
const protocol = new DeliberationProtocol(sharedStateStore);
const session = protocol.getState('dsession_12345');

// Extract all review feedback (excluding approved by default)
const feedbackList = extractReviewFeedback(session);

console.log(`Found ${feedbackList.length} feedback items`);
feedbackList.forEach(feedback => {
  console.log(`Iteration ${feedback.iteration}: ${feedback.status}`);
  console.log(`  Feedback: ${feedback.feedback}`);
  console.log(`  Reviewer: ${feedback.reviewerId}`);
});
```

### 2. Get the most recent feedback for a specific review request

```javascript
import { getLatestFeedbackForRequest } from './deliberation-feedback-extractor.js';

const session = protocol.getState('dsession_12345');
const latestFeedback = getLatestFeedbackForRequest(session, 'req-456');

if (latestFeedback) {
  if (latestFeedback.status === 'rejected') {
    console.log('Revision required:', latestFeedback.feedback);
    console.log('Suggested changes:', latestFeedback.suggestedChanges);
  } else if (latestFeedback.status === 'approved') {
    console.log('Review approved! Task can complete.');
  }
}
```

### 3. Format feedback for executor agent prompt injection

```javascript
import { extractReviewFeedback, formatFeedbackForPrompt } from './deliberation-feedback-extractor.js';

const session = protocol.getState('dsession_12345');
const feedbackList = extractReviewFeedback(session, {
  maxFeedbackItems: 3,  // Only most recent 3 items
  includeApproved: false,
});

const formattedText = formatFeedbackForPrompt(feedbackList);

// Inject into agent prompt
const agentPrompt = `
${taskDescription}

${formattedText}

Please revise your output based on the reviewer's feedback above.
`;

// Send to executor agent for revision
await executeAgent(executorAgentId, agentPrompt);
```

### 4. Track review iteration count

```javascript
import { countReviewIterations } from './deliberation-feedback-extractor.js';

const session = protocol.getState('dsession_12345');
const iterationCount = countReviewIterations(session);
const maxIterations = 5;

if (iterationCount >= maxIterations) {
  console.warn(`Max review iterations (${maxIterations}) exceeded`);
  // Escalate or allow completion with review-incomplete flag
}
```

### 5. Check current review status

```javascript
import { getCurrentReviewStatus } from './deliberation-feedback-extractor.js';

const session = protocol.getState('dsession_12345');
const currentStatus = getCurrentReviewStatus(session);

if (currentStatus) {
  console.log(`Latest review status: ${currentStatus.status}`);
  console.log(`By: ${currentStatus.reviewerId}`);
  console.log(`At: ${currentStatus.timestamp}`);

  if (currentStatus.status === 'approved') {
    // Mark task as complete
    await completeTask(taskId);
  } else if (currentStatus.status === 'rejected') {
    // Trigger revision cycle
    await triggerRevision(taskId);
  }
}
```

## Integration with Lifecycle.js

Example of how this will be integrated into the agent execution lifecycle:

```javascript
// In src/orchestrator/lifecycle.js

import { extractReviewFeedback, formatFeedbackForPrompt } from './deliberation-feedback-extractor.js';

async function executeSubtask(subtask, agent) {
  let prompt = buildBasePrompt(subtask);

  // Check if this is a revision subtask
  if (subtask.meta?.fixForReview && subtask.meta?.deliberationSessionId) {
    // Extract reviewer feedback from deliberation session
    const session = protocol.getState(subtask.meta.deliberationSessionId);
    const feedbackList = extractReviewFeedback(session);

    if (feedbackList.length > 0) {
      // Inject feedback into prompt
      const feedbackContext = formatFeedbackForPrompt(feedbackList);
      prompt += `\n\n[REVISION_CONTEXT_START]\n${feedbackContext}\n[REVISION_CONTEXT_END]\n`;
    }
  }

  // Execute agent with feedback-enhanced prompt
  const result = await agent.execute(prompt);
  return result;
}
```

## Advanced: Filter and Extract Specific Feedback

```javascript
import { extractReviewFeedback } from './deliberation-feedback-extractor.js';

const session = protocol.getState('dsession_12345');

// Only get rejected feedback (needs revision)
const rejectedFeedback = extractReviewFeedback(session, {
  includeApproved: false,  // default, excludes approved
}).filter(f => f.status === 'rejected');

// Only get feedback for a specific review request (multi-round review)
const roundOneFeedback = extractReviewFeedback(session, {
  targetReviewRequestId: 'req-001',
});

// Get the 5 most recent feedback items including all statuses
const recentAll = extractReviewFeedback(session, {
  maxFeedbackItems: 5,
  includeApproved: true,
});
```

## Example Output Format

When `formatFeedbackForPrompt` is called, it produces output like:

```
=== REVIEWER FEEDBACK (Iteration 2) ===
Reviewer: reviewer-agent-cara
Status: rejected
Timestamp: 2026-04-01T12:34:56Z

The implementation is missing proper error handling for the edge case where
the API returns a 429 rate limit response. This could cause the entire
workflow to crash instead of gracefully retrying.

Suggested Changes:
- File: src/orchestrator/api.js, Line: 142 - Add try-catch block around fetch call
- File: src/orchestrator/api.js, Line: 150 - Implement exponential backoff retry logic
- File: test/integration/api.test.js, Line: 67 - Add test case for rate limit handling
======================================

=== REVIEWER FEEDBACK (Iteration 1) ===
Reviewer: reviewer-agent-cara
Status: rejected
Timestamp: 2026-04-01T11:15:23Z

The function signature doesn't match the API documentation. The parameter
order is incorrect and will cause runtime errors when called from other modules.

Suggested Changes:
- File: src/orchestrator/api.js, Line: 42 - Change parameter order to (sessionId, payload, agentId)
- File: docs/api-reference.md, Line: 15 - Update documentation to reflect correct signature
======================================
```

## Testing

Run the unit tests:

```bash
node src/orchestrator/deliberation-feedback-extractor.test.js
```

Expected output: `✅ All deliberation-feedback-extractor tests passed`
