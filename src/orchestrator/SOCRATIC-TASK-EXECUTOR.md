# Socratic Task Executor

## Overview

The Socratic Task Executor is the integration layer that connects campaign tasks with the Socratic research orchestration system. It provides a complete end-to-end workflow for generating critical thinking questions from domain analysis.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Campaign System                          │
│  (creates Socratic campaigns with domain specification)     │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Socratic Task Executor                         │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 1. createSocraticTask()                               │  │
│  │    - Creates task linked to campaign                  │  │
│  │    - Sets metadata with domain                        │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 2. executeSocraticTask()                              │  │
│  │    - Phase 1: Research (socratic-agent.js)            │  │
│  │    - Phase 2: Curation (socratic-curation.js)         │  │
│  │    - Phase 3: Validation (socratic-validation.js)     │  │
│  │    - Phase 4: Persistence (campaignManager)           │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 3. runSocraticCampaign()                              │  │
│  │    - Convenience function for full workflow           │  │
│  │    - Creates campaign + executes task                 │  │
│  └───────────────────────────────────────────────────────┘  │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Question Output Schema                         │
│  {                                                           │
│    "question": string,              // The Socratic question │
│    "assumptionChallenged": string,  // What's being challenged│
│    "evidenceFor": string[],         // Supporting evidence   │
│    "evidenceAgainst": string[],     // Contradictory evidence│
│    "impactIfWrong": string,         // Consequences          │
│    "priority": number,              // 1-10 integer          │
│    "domain": string                 // Context domain        │
│  }                                                          │
└─────────────────────────────────────────────────────────────┘
```

## Components

### 1. Task Creation (`createSocraticTask`)

Creates a task within the campaign system that will execute Socratic research.

**Parameters:**
- `taskManager`: TaskManager instance
- `projectId`: Project identifier
- `channelId`: Channel for task execution
- `campaignId`: Parent campaign ID
- `options`: 
  - `domain` (required): Domain being explored
  - `title` (optional): Custom task title
  - `description` (optional): Task description

**Returns:** Created task object with metadata

### 2. Task Execution (`executeSocraticTask`)

Main execution function that coordinates all phases of Socratic research.

**Parameters:**
- `task`: The Socratic task to execute
- `deps`: Dependencies container containing:
  - `campaignManager`: For campaign operations
  - `learningsManager`: For learning data access
  - `timelineStore`: For timeline events
  - `patternScanner`: For pattern analysis
  - `taskManager`: For task status updates
  - `projectId`, `channelId`: Context identifiers
  - `addMessage`: Function to add system messages
  - `broadcastToChannel`: Function for broadcasts

**Phases:**
1. **Research**: Calls `executeSocraticResearch()` from socratic-agent.js
2. **Curation**: Calls `curateQuestions()` from socratic-curation.js
3. **Validation**: Calls `validateQuestionSchema()` from socratic-validation.js
4. **Persistence**: Persists questions to campaign via `updateSocraticQuestions()`

**Returns:** Execution result with output, phases status, and errors

### 3. Full Campaign Execution (`runSocraticCampaign`)

Convenience function that creates a campaign and executes the full workflow.

**Parameters:**
- All manager instances (campaignManager, taskManager, etc.)
- `projectId`, `channelId`: Context identifiers
- `campaignOptions`: 
  - `domain` (required)
  - `title` (optional)
  - `description` (optional)
- `addMessage`, `broadcastToChannel`: Message handlers

**Returns:** Complete campaign result with questions

## Workflow Example

```javascript
import { runSocraticCampaign } from './orchestrator/socratic-task-executor.js';

// Execute complete Socratic campaign
const result = await runSocraticCampaign(
  campaignManager,
  taskManager,
  learningsManager,
  timelineStore,
  patternScanner,
  'my-project',
  'general',
  {
    domain: 'agent routing performance',
    title: 'Critical Analysis of Agent Routing',
  },
  addMessage,
  broadcastToChannel
);

// Access results
console.log(`Generated ${result.questionCount} questions`);
console.log(result.questions); // Array of validated questions
```

## Integration Points

### With Campaign System
- Creates tasks linked to Socratic campaigns
- Updates campaign status through lifecycle states:
  - `created` → `researching` → `curating` → `reviewed` → `done`
- Persists questions via `campaignManager.updateSocraticQuestions()`

### With Task System
- Marks task status: `planning` → `executing` → `completed`/`failed`
- Updates task metadata with phase information
- Logs errors to task metadata on failure

### With Dispatch System
- Can be triggered by heartbeat/strategy loop
- Uses standard message broadcast pattern
- Integrates with existing channel communication

## Quality Assurance

### Validation
Questions are validated against schema requirements:
- **Count**: 5-15 questions (strict requirement)
- **Required fields**: question, assumptionChallenged, impactIfWrong, priority, domain
- **Optional fields**: evidenceFor, evidenceAgainst (at least one required)
- **Priority**: Integer 1-10

### Curation Pipeline
1. **Quality filtering**: Removes questions without required fields
2. **Deduplication**: Groups similar questions by assumptionChallenged
3. **Merging**: Combines duplicate groups into single high-quality questions
4. **Constraint enforcement**: Ensures 5-15 question output

### Evidence Requirements
Each question must have:
- At least one evidenceFor item OR evidenceAgainst item
- Preferably both for balanced analysis
- Evidence should cite specific data points when possible

## Testing

Run the end-to-end test:

```bash
node scripts/test-socratic-e2e.js [projectId] [channelId]
```

This will:
1. Create a test project (if needed)
2. Run a Socratic campaign with domain "agent routing performance"
3. Validate output against schema
4. Check question quality
5. Report results

## Error Handling

The executor implements comprehensive error handling:
- Phase failures are logged but don't halt execution
- Validation errors prevent persistence
- Task status updated to `failed` on errors
- Campaign status updated if critical failure occurs
- All errors captured in result.errors array

## Future Enhancements

Potential improvements:
1. **Two-pass generation**: First pass generates candidates, second pass critiques
2. **Evidence strengthening**: Require ≥2 specific data points per question
3. **Question ranking**: Use self-ranking to prioritize high-impact questions
4. **Incremental curation**: Allow manual review between phases
5. **Pattern integration**: Enhance research with cross-project pattern findings

## Files

- `socratic-task-executor.js`: Main executor implementation
- `socratic-agent.js`: Orchestration of research phases
- `socratic-curation.js`: Question deduplication and merging
- `socratic-validation.js`: Schema validation
- `socratic-prompts.js`: LLM prompt templates
- `test-socratic-e2e.js`: End-to-end test script
