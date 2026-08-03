# Socratic Agent Orchestration Module

## Overview

The `socratic-agent.js` module orchestrates Socratic research campaigns by coordinating the three-phase pipeline:

1. **Domain Research** - Gather context from learnings, timeline events, and pattern findings
2. **Assumption Identification** - Extract implicit and explicit assumptions from the research data
3. **Question Generation** - Synthesize Socratic questions with evidence citations

## Key Design Principles

- **Coordination, not execution**: This module orchestrates the flow but does not directly invoke LLM APIs
- **Fast and lightweight**: Avoids complex async operations and long-running tasks to prevent timeouts
- **Structured output**: Returns parseable JSON matching the Socratic question schema
- **Error boundaries**: All phases have explicit error handling and logging

## API

### `detectSocraticTask(task, campaignManager)`

Check if a task belongs to a Socratic campaign.

**Parameters:**
- `task` (object): Task object with `campaignId` field
- `campaignManager` (object): CampaignManager instance

**Returns:** `boolean` - `true` if task belongs to a Socratic campaign

**Example:**
```javascript
import { detectSocraticTask } from './socratic-agent.js';

const isSocratic = detectSocraticTask(task, campaignManager);
if (isSocratic) {
  console.log('This is a Socratic research task');
}
```

---

### `executeSocraticResearch(task, deps)`

Execute the Socratic research pipeline for a task.

**Parameters:**
- `task` (object): The Socratic task to execute
- `deps` (object): Dependencies object with:
  - `campaignManager`: CampaignManager instance
  - `learningsManager`: LearningsManager instance
  - `timelineStore`: TimelineStore instance
  - `patternScanner`: Pattern scanner instance

**Returns:** `Promise<object>` - Research execution result with:
```javascript
{
  taskId: string,
  campaignId: string,
  projectId: string,
  timestamp: string (ISO 8601),
  phases: {
    research: { status: 'completed' | 'failed', data: object },
    assumptions: { status: 'completed' | 'failed', data: array },
    questions: { status: 'completed' | 'failed', data: array }
  },
  output: {
    questions: array,          // 5-15 Socratic questions
    validation: object,        // Validation result
    domain: string,
    researchSummary: object    // Metrics about the research
  },
  errors: array                // Any errors encountered
}
```

**Example:**
```javascript
import { executeSocraticResearch } from './socratic-agent.js';

const deps = {
  campaignManager,
  learningsManager,
  timelineStore,
  patternScanner,
};

const result = await executeSocraticResearch(task, deps);

if (result.errors.length === 0 && result.output.validation.valid) {
  console.log(`Generated ${result.output.questions.length} valid questions`);
  // Persist to campaign
  campaignManager.setQuestions(
    result.projectId,
    result.campaignId,
    result.output.questions
  );
}
```

---

### `getSocraticStatus(projectId, campaignId, campaignManager)`

Get the current status of a Socratic campaign.

**Parameters:**
- `projectId` (string): Project ID
- `campaignId` (string): Campaign ID
- `campaignManager` (object): CampaignManager instance

**Returns:** `object | null` - Status object or `null` if not a Socratic campaign

**Example:**
```javascript
import { getSocraticStatus } from './socratic-agent.js';

const status = getSocraticStatus('project_1', 'campaign_123', campaignManager);
if (status) {
  console.log(`Domain: ${status.domain}, Questions: ${status.questionCount}`);
}
```

---

## Integration Points

### Lifecycle Integration

In `lifecycle.js`, before the standard `planTask` decomposition:

```javascript
import { detectSocraticTask, executeSocraticResearch } from './socratic-agent.js';

async function planTask(task, taskSpan) {
  // Check if Socratic task
  if (detectSocraticTask(task, campaignManager)) {
    const deps = { campaignManager, learningsManager, timelineStore, patternScanner };
    const result = await executeSocraticResearch(task, deps);

    if (result.output && result.output.validation.valid) {
      // Persist questions
      campaignManager.setQuestions(
        task.project,
        task.campaignId,
        result.output.questions
      );

      // Update task status
      taskManager.updateTaskStatus(
        task.project,
        task.id,
        'curating',
        'socratic-agent',
        `Generated ${result.output.questions.length} questions`
      );

      return; // Skip standard decomposition
    }
  }

  // Continue with standard planTask logic
  // ...
}
```

### Dispatch Integration

In `dispatch.js`, when routing Socratic campaign tasks:

```javascript
import { detectSocraticTask } from './socratic-agent.js';

function routeTask(task) {
  if (detectSocraticTask(task, campaignManager)) {
    // Route to specialized Socratic execution path
    return executeSocraticPipeline(task);
  }

  // Standard task routing
  return standardDispatch(task);
}
```

---

## Current Implementation Status

### ✅ Completed

- **Detection**: `detectSocraticTask()` correctly identifies Socratic campaigns
- **Orchestration**: `executeSocraticResearch()` sequences all three phases
- **Validation**: Output is validated against the Socratic question schema
- **Error handling**: All phases have error boundaries and logging
- **Tests**: Full test coverage with passing tests

### 🚧 Placeholder Logic

The following functions use **placeholder implementations** and should be replaced with real agent invocations:

1. **`extractAssumptionsPlaceholder()`** - Currently generates mock assumptions
   - Should invoke an LLM agent with an assumption-extraction prompt
   - Agent should analyze research data and identify implicit/explicit assumptions

2. **`generateQuestionsPlaceholder()`** - Currently generates mock questions
   - Should invoke an LLM agent with a question-generation prompt
   - Agent should synthesize Socratic questions with evidence citations

### 📋 Next Steps

1. **Create prompt templates** (`socratic-prompts.js`):
   - Domain research prompt (how to query data sources)
   - Assumption identification prompt (extract assumptions from research)
   - Question generation prompt (synthesize questions with evidence)

2. **Wire agent invocations**:
   - Replace placeholder functions with real agent calls
   - Use the standard dispatch/lifecycle agent execution pattern
   - Add timeout handling and retry logic

3. **Lifecycle integration**:
   - Add detection logic to `lifecycle.js` `planTask()`
   - Route Socratic tasks through `executeSocraticResearch()`
   - Update campaign state transitions (created → researching → curating)

4. **End-to-end testing**:
   - Create a test Socratic campaign via API
   - Verify task execution produces questions
   - Validate questions persist to campaign.questions array

---

## Question Schema

All generated questions must match this schema:

```javascript
{
  question: string,              // The critical thinking question
  assumptionChallenged: string,  // The assumption being challenged
  evidenceFor: string[],         // Supporting evidence (optional)
  evidenceAgainst: string[],     // Contradicting evidence (optional)
  impactIfWrong: string,         // Consequences if assumption is wrong
  priority: number,              // 1-10 (integer)
  domain: string                 // Domain context
}
```

**Validation constraints:**
- Minimum 5 questions, maximum 15 questions
- All required fields must be non-empty strings
- `priority` must be an integer between 1-10
- At least one of `evidenceFor` or `evidenceAgainst` should be present

See `socratic-validation.js` for full validation logic.

---

## Error Handling

The module uses structured error handling:

1. **Phase-level errors**: Each phase (research, assumptions, questions) has its own status
2. **Global errors array**: All errors are collected in `result.errors`
3. **Graceful degradation**: Failures in one phase don't block subsequent phases
4. **Logging**: All errors are logged with context via the logger module

**Example error result:**
```javascript
{
  taskId: 'task_123',
  errors: [
    'Research phase failed: Pattern scanner unavailable',
    'Validation failed: Only 3 questions generated, minimum is 5'
  ],
  phases: {
    research: { status: 'failed', error: 'Pattern scanner unavailable' },
    assumptions: { status: 'completed', data: [...] },
    questions: { status: 'completed', data: [...] }
  }
}
```

---

## Performance Considerations

- **Fast coordination**: The module itself executes in < 50ms (placeholder mode)
- **Parallel data gathering**: Research package queries run in parallel
- **No blocking calls**: All async operations have proper await handling
- **Memory efficient**: Placeholder questions are generated algorithmically, not stored

When real LLM agents are wired in:
- Add explicit timeouts (30-60s per phase)
- Implement retry logic for transient failures
- Consider caching research packages for repeated queries

---

## Testing

Run the test suite:

```bash
node src/orchestrator/socratic-agent.test.js
```

All tests should pass with output:
```
✓ detectSocraticTask correctly identifies Socratic campaign
✓ detectSocraticTask correctly rejects non-Socratic campaign
✓ detectSocraticTask handles missing campaign gracefully
✓ executeSocraticResearch completes all phases and generates valid output
✓ executeSocraticResearch handles non-Socratic campaign with error
✓ getSocraticStatus returns campaign status
✓ getSocraticStatus returns null for non-Socratic campaign

✅ All socratic-agent tests passed!
```
