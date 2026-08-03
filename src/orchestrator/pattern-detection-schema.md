# Pattern Detection Schema Reference

## Overview
This document catalogs the exact field schemas from `.synapse/projects/*/tasks.json` and `campaigns.json` that pattern detectors will key on. It defines the 3 pattern types and maps them to specific data fields.

---

## Data Schema

### tasks.json Structure
```javascript
{
  "schemaVersion": "1",
  "version": <integer>,  // increments with each update
  "tasks": [ /* array of task objects */ ]
}
```

### Task Object (top-level)
```javascript
{
  // Identity
  "id": "task_<timestamp>_<hash>",
  "title": string,
  "description": string,
  "type": "oneshot" | "recurring" | other,
  "project": string,
  "channel": string,
  "owner": string,

  // Status and lifecycle
  "status": "pending" | "in_progress" | "done" | "failed" | "blocked",
  "createdAt": ISO8601 timestamp,
  "startedAt": ISO8601 timestamp | null,
  "completedAt": ISO8601 timestamp | null,
  "updatedAt": ISO8601 timestamp,

  // Campaign context
  "campaignId": string | null,
  "milestoneId": string | null,

  // Execution details
  "subtasks": [ /* array of subtask objects */ ],
  "dependencies": array,
  "sharedWith": array,
  "context": object | null,
  "delegationContext": object | null,
  "traceContext": object | null,

  // Review and iteration
  "reviewCycle": integer,
  "maxReviewCycles": integer,
  "reviewFindings": array | null,
  "plan": object | null,
  "touchedFiles": array,
  "gitBaseline": object | null,
  "threadId": string | null,
  "doneCriteria": string
}
```

### Subtask Object
```javascript
{
  // Identity
  "id": "st_<number>",
  "text": string,
  "suggestedRole": "implementer" | "reviewer" | "researcher" | "strategist",

  // Assignment and execution
  "assignee": "loco" | "lola" | "nia" | null,
  "status": "pending" | "in_progress" | "done" | "failed",
  "complexity": "low" | "medium" | "high",
  "claimedUntil": ISO8601 timestamp | null,

  // Results and errors
  "result": string | null,
  "error": string | null,  // e.g. "Escalated: medium → high, excluding []"
  "retryCount": integer,
  "failedProviders": array,  // e.g. ["ollama"] when provider fails

  // Timestamps
  "createdAt": ISO8601 timestamp,
  "startedAt": ISO8601 timestamp | null,
  "completedAt": ISO8601 timestamp | null,
  "updatedAt": ISO8601 timestamp,

  // Metadata
  "meta": object | null
}
```

### campaigns.json Structure
```javascript
{
  "schemaVersion": "1",
  "version": <integer>,
  "campaigns": [ /* array of campaign objects */ ]
}
```

### Campaign Object
```javascript
{
  // Identity
  "id": "campaign_<timestamp>_<hash>",
  "title": string,
  "description": string,
  "doneCriteria": string,
  "contingency": string,

  // Status
  "status": "active" | "in_progress" | "completed" | "failed" | "paused",

  // Milestones
  "milestones": [ /* array of milestone objects */ ]
}
```

### Milestone Object
```javascript
{
  // Identity
  "id": "ms_<timestamp>_<hash>",
  "title": string,
  "description": string,
  "doneCriteria": string,
  "contingency": string,
  "order": integer,

  // Status and dependencies
  "status": "pending" | "in_progress" | "completed" | "blocked",
  "blockedBy": array,  // array of milestone IDs
  "tasks": array,  // array of task IDs

  // Timestamps
  "createdAt": ISO8601 timestamp,
  "updatedAt": ISO8601 timestamp,
  "completedAt": ISO8601 timestamp | null
}
```

---

## Pattern Type Definitions

### 1. Recurring Failures Pattern
**Description:** Detects tasks or subtasks that repeatedly fail with errors or require multiple retry attempts.

**Trigger Conditions:**
- Subtask `retryCount >= 2`
- Subtask `error` field is non-null and contains "Escalated" or other failure indicators
- Subtask `failedProviders.length > 0`
- Task has multiple subtasks with `status: "failed"`

**Key Fields to Scan:**
```javascript
// Subtask level
subtask.retryCount       // integer, 0+ retries attempted
subtask.error            // string | null, error message
subtask.failedProviders  // array, providers that failed this subtask
subtask.status           // "failed" indicates terminal failure

// Task level
task.status              // "failed" indicates entire task failed
task.subtasks            // scan for multiple failed subtasks
```

**Evidence Structure:**
```javascript
{
  type: "recurring_failure",
  description: "Task 'X' has subtask with 3 retries and error 'Y'",
  confidence: 0.8,  // higher with more retries or failed providers
  evidence: [
    {
      project: "synapse",
      dataPoint: "task_id/subtask_id",
      value: { retryCount: 3, error: "...", failedProviders: [...] }
    }
  ]
}
```

### 2. Cross-Project Metric Anomalies Pattern
**Description:** Detects metric drops or anomalies that appear across multiple projects simultaneously.

**Trigger Conditions:**
- Success rate drop: ≥2 projects show increased failure rates in same time window
- Completion velocity drop: ≥2 projects show increased task duration in same window
- Provider failures: Same provider fails across ≥2 projects in same window

**Key Fields to Scan:**
```javascript
// Calculate per-project metrics:
// Success rate = done_tasks / total_tasks (recent window)
// Average completion time = avg(completedAt - startedAt) for recent tasks
// Provider reliability = failedProviders frequency across subtasks

// Time window fields (for recent analysis)
task.createdAt           // ISO8601 timestamp
task.startedAt           // ISO8601 timestamp | null
task.completedAt         // ISO8601 timestamp | null
task.updatedAt           // ISO8601 timestamp
subtask.createdAt        // ISO8601 timestamp
subtask.completedAt      // ISO8601 timestamp | null

// Status for aggregation
task.status              // "done" vs "failed" for success rate
subtask.status           // "done" vs "failed" for success rate
subtask.failedProviders  // aggregate across projects
```

**Evidence Structure:**
```javascript
{
  type: "cross_project_anomaly",
  description: "Success rate dropped in 3 projects: synapse (90%→60%), projA (85%→55%), prompt_research (95%→70%)",
  confidence: 0.9,  // higher with more projects affected
  evidence: [
    { project: "synapse", dataPoint: "success_rate", value: { before: 0.90, after: 0.60 } },
    { project: "projA", dataPoint: "success_rate", value: { before: 0.85, after: 0.55 } },
    { project: "prompt_research", dataPoint: "success_rate", value: { before: 0.95, after: 0.70 } }
  ]
}
```

### 3. Stalled Progress Pattern
**Description:** Detects tasks or milestones stuck in non-terminal status beyond a time threshold.

**Trigger Conditions:**
- Task: `status: "in_progress"` and `(now - startedAt) > threshold` (e.g., 48 hours)
- Task: `status: "pending"` and `(now - createdAt) > threshold` (e.g., 72 hours)
- Subtask: `status: "in_progress"` and `(now - startedAt) > threshold` (e.g., 6 hours)
- Milestone: `status: "in_progress"` and `(now - updatedAt) > threshold` with no recent task completions

**Key Fields to Scan:**
```javascript
// Task level
task.status              // "in_progress" | "pending" | "blocked"
task.createdAt           // ISO8601 timestamp
task.startedAt           // ISO8601 timestamp | null
task.updatedAt           // ISO8601 timestamp
task.completedAt         // null for stalled tasks
task.subtasks            // check if all subtasks also stalled

// Subtask level
subtask.status           // "in_progress" | "pending"
subtask.startedAt        // ISO8601 timestamp | null
subtask.claimedUntil     // ISO8601 timestamp | null - claim expired?
subtask.updatedAt        // ISO8601 timestamp

// Milestone level
milestone.status         // "in_progress" | "blocked"
milestone.updatedAt      // ISO8601 timestamp
milestone.completedAt    // null for stalled milestones
milestone.blockedBy      // array - check if blockers are cleared
milestone.tasks          // cross-reference with tasks.json to check progress
```

**Evidence Structure:**
```javascript
{
  type: "stalled_progress",
  description: "Task 'Fix API authentication' has been in_progress for 52 hours with no subtask activity",
  confidence: 0.85,  // higher with longer stall duration
  evidence: [
    {
      project: "synapse",
      dataPoint: "task_1234/duration",
      value: {
        status: "in_progress",
        startedAt: "2026-03-15T10:00:00Z",
        now: "2026-03-17T14:00:00Z",
        stalledHours: 52,
        lastSubtaskUpdate: "2026-03-15T12:30:00Z"
      }
    }
  ]
}
```

---

## Time Threshold Guidelines

**Recommended thresholds for stalled progress detection:**
- Subtask in_progress: 6-12 hours
- Task in_progress: 48 hours
- Task pending (not started): 72 hours
- Milestone in_progress: 7 days
- Subtask claimed but not started: `claimedUntil` expiry + 1 hour

**Recommended time windows for cross-project anomaly detection:**
- Recent window: last 24 hours
- Comparison baseline: 24-48 hours prior
- Minimum sample size: 10 tasks per project per window

---

## Edge Cases and Resilience

### Data Loading
- **Missing files:** `tasks.json` or `campaigns.json` may not exist in all projects → return empty data, don't throw
- **Malformed JSON:** Files may contain syntax errors → skip file gracefully, log warning
- **Empty directories:** `.synapse/projects/` may have subdirs with no data files → return empty arrays
- **Version mismatches:** `schemaVersion` may differ → handle defensively, required fields only

### Timestamp Handling
- **Null timestamps:** `startedAt`, `completedAt` may be null → handle explicitly in duration calculations
- **Future timestamps:** Clock skew may cause `createdAt > now` → clamp to now
- **Invalid ISO8601:** Malformed timestamp strings → catch parse errors, skip record

### Cross-Project Comparisons
- **Single project:** If only 1 project has data, cross-project anomaly detector should return `[]`
- **Insufficient data:** If project has <10 tasks in window, exclude from cross-project metrics
- **Varying activity levels:** Normalize metrics by project size (% not absolute counts)

### Filtering and Confidence
- **Minimum confidence threshold:** 0.6 (patterns below this are noise)
- **Deduplicate findings:** If same pattern detected multiple ways, merge into single finding with highest confidence
- **Prioritize patterns:** Recurring failures > Stalled progress > Cross-project anomalies (when presenting to operator)

---

## Performance Targets

- **Data loading:** <200ms for 5 projects with ~1000 tasks each
- **Pattern detection:** <500ms per detector function on full dataset
- **Full pipeline:** <2s total (load + detect + filter) for typical deployment (5 projects, 5000 tasks)
- **Memory usage:** <100MB peak for full dataset processing

---

## Testing Fixtures Design

### Minimal Valid Fixtures
```javascript
// Clean data - should NOT trigger any patterns
const cleanProject = {
  tasks: [
    {
      id: "task_1", status: "done", createdAt: "2026-03-17T10:00:00Z",
      startedAt: "2026-03-17T10:05:00Z", completedAt: "2026-03-17T11:00:00Z",
      subtasks: [
        { id: "st_1", status: "done", retryCount: 0, error: null, failedProviders: [] }
      ]
    }
  ],
  campaigns: [
    {
      id: "camp_1", status: "completed",
      milestones: [
        { id: "ms_1", status: "completed", completedAt: "2026-03-17T12:00:00Z" }
      ]
    }
  ]
};

// Recurring failure fixture
const recurringFailureProject = {
  tasks: [
    {
      id: "task_fail", status: "done",
      subtasks: [
        {
          id: "st_1", status: "done", retryCount: 3,
          error: "Escalated: medium → high, excluding []",
          failedProviders: ["ollama"]
        }
      ]
    }
  ]
};

// Stalled progress fixture (task in_progress for 50 hours)
const stalledProgressProject = {
  tasks: [
    {
      id: "task_stalled", status: "in_progress",
      createdAt: "2026-03-15T10:00:00Z",
      startedAt: "2026-03-15T10:30:00Z",
      completedAt: null,
      updatedAt: "2026-03-15T11:00:00Z",  // no updates for 2+ days
      subtasks: []
    }
  ]
};
```

### Cross-Project Anomaly Fixture
Requires ≥2 projects with same time window showing metric drops. Generate synthetically:
- Project A: 10 tasks in window, 3 failed (30% failure rate)
- Project B: 10 tasks in window, 4 failed (40% failure rate)
- Project C (baseline): 10 tasks in window, 1 failed (10% failure rate)
- Detection: Projects A & B both show elevated failure rates vs baseline

---

## Summary

**3 Pattern Types:**
1. **Recurring Failures:** `retryCount`, `error`, `failedProviders` fields on subtasks
2. **Cross-Project Anomalies:** Aggregate metrics (success rate, duration) across ≥2 projects
3. **Stalled Progress:** `status`, timestamp fields (duration since last activity) on tasks/milestones

**Critical Fields:**
- Status: `task.status`, `subtask.status`, `milestone.status`
- Timestamps: `createdAt`, `startedAt`, `completedAt`, `updatedAt`
- Errors: `subtask.retryCount`, `subtask.error`, `subtask.failedProviders`
- Structure: `task.subtasks`, `milestone.tasks`, `campaign.milestones`

**Implementation Requirements:**
- Resilient data loading (handle missing/malformed files)
- Evidence arrays with specific data point references
- Confidence scores (0.0-1.0) for each finding
- Empty array return when no significant patterns exist
- <2s runtime across 5 projects with typical data volumes
