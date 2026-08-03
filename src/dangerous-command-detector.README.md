# Dangerous Command Detector

Pattern-based detection of destructive operations with governance escalation and checkpoint integration.

## Overview

The dangerous command detector scans text (task descriptions, workflow nodes, prompts) for potentially destructive command patterns and provides:

- **Pattern matching** for dangerous commands (rm -rf, git reset --hard, DROP TABLE, etc.)
- **Risk classification** (high/medium/low)
- **Governance integration** to require approval before execution
- **Checkpoint metadata** for restoration if things go wrong

## Detected Patterns

### High Risk (requires governance approval)
- `rm -rf` / `rm -fr` - Recursive force deletion
- `git reset --hard` - Destructive git reset
- `DROP TABLE` / `DROP DATABASE` - SQL destructive operations
- `TRUNCATE TABLE` - SQL truncate
- `DELETE FROM ... WHERE 1=1` - Dangerous SQL deletes

### Medium Risk (checkpoint + review)
- `git push --force` / `git push -f` - Force push
- `git clean -f` / `git clean -fd` - Force clean untracked files
- `git branch -D` - Force delete branch
- `git checkout -- .` - Discard all changes
- `chmod 777` / `chmod 666` - Overly permissive permissions

## API

### detectDangerousCommands(text, context)

Scan text for dangerous command patterns.

```javascript
import { detectDangerousCommands } from './dangerous-command-detector.js';

const result = detectDangerousCommands('rm -rf /tmp/cache', {
  taskId: 'task_123',
  nodeId: 'node_456'
});

// Result:
{
  isDangerous: true,
  matches: [
    {
      pattern: 'Recursive force file deletion (rm -rf)',
      matched: 'rm -rf ',
      risk: 'high',
      category: 'filesystem',
      snippet: 'rm -rf /tmp/cache',
      position: 0
    }
  ],
  risk: 'high',
  recommendation: 'governance_approval_required',
  context: { taskId: 'task_123', nodeId: 'node_456' },
  detectedAt: '2026-03-24T02:00:00.000Z'
}
```

### createDangerousCommandProposal(governanceManager, projectId, detection, additionalContext)

Create a governance proposal for dangerous command approval.

```javascript
import {
  detectDangerousCommands,
  createDangerousCommandProposal
} from './dangerous-command-detector.js';

const detection = detectDangerousCommands('DROP TABLE users;');

const proposal = createDangerousCommandProposal(
  governanceManager,
  'proj_123',
  detection,
  {
    taskId: 'task_789',
    agentId: 'local-agent',
    fullText: 'Clean up test data: DROP TABLE users;'
  }
);

// Returns: { id: 'gov_...', proposal: {...} }
```

### formatForCheckpoint(detection)

Format detection result for checkpoint metadata.

```javascript
import {
  detectDangerousCommands,
  formatForCheckpoint
} from './dangerous-command-detector.js';

const detection = detectDangerousCommands('rm -rf /tmp && git reset --hard');
const metadata = formatForCheckpoint(detection);

// Include in checkpoint:
checkpointManager.createSubtaskCheckpoint(
  projectId,
  campaignId,
  completedSubtaskIds,
  milestones,
  { dangerousCommandDetection: metadata }
);

// Metadata:
{
  dangerousCommandDetected: true,
  risk: 'high',
  matchCount: 2,
  categories: ['filesystem', 'git'],
  patterns: [...],
  detectedAt: '2026-03-24T02:00:00.000Z',
  recommendation: 'governance_approval_required'
}
```

### waitForGovernanceDecision(params)

Wait for a governance proposal decision with timeout. Listens for governance events and polls proposal status.

```javascript
import { waitForGovernanceDecision } from './dangerous-command-detector.js';

const decision = await waitForGovernanceDecision({
  proposalId: 'gov_1234567890_abc123',
  governanceManager,
  events,  // event emitter
  projectId: 'proj_123',
  timeoutMs: 300000,  // 5 minutes
  pollIntervalMs: 1000,  // 1 second
});

// Returns:
{
  outcome: 'approved' | 'rejected' | 'timeout' | 'invariant_violation',
  reason?: string,
  votes?: Array,
  violations?: Array,
  timedOut?: boolean
}
```

**How it works:**
- Listens for `governance:proposal_applied` and `governance:proposal_rejected` events
- Polls proposal status as fallback (in case events don't fire)
- Times out if no decision received within `timeoutMs`
- Automatically cleans up listeners and timers
- Returns immediately when a decision is made

### requestDangerousCommandApproval(params)

**Full workflow wrapper** — detects, creates checkpoint, proposes, and waits for approval in one call.

```javascript
import { detectDangerousCommands, requestDangerousCommandApproval } from './dangerous-command-detector.js';

const detection = detectDangerousCommands('git reset --hard HEAD');

if (detection.isDangerous) {
  const result = await requestDangerousCommandApproval({
    projectId: 'proj_123',
    detection,
    governanceManager,
    events,
    checkpointManager,  // optional
    campaignId: 'campaign_456',  // optional, for checkpoint
    additionalContext: {
      nodeId: 'node_789',
      workflowId: 'wf_abc',
      fullText: 'Reset repository to clean state',
    },
    timeoutMs: 300000,  // 5 minutes
  });

  // Returns:
  {
    outcome: 'approved' | 'rejected' | 'timeout' | 'invariant_violation',
    proposalId: string,
    checkpointId?: string,      // if checkpoint created
    fsCheckpointId?: string,    // if filesystem checkpoint created
    reason?: string,
    votes?: Array,
    violations?: Array
  }

  if (result.outcome === 'approved') {
    console.log('✅ Approved — proceeding with caution');
    // ... execute dangerous command ...
  } else if (result.outcome === 'rejected') {
    throw new Error(`Blocked: ${result.reason}`);
  } else if (result.outcome === 'timeout') {
    throw new Error('Governance decision timed out');
  }
}
```

**What it does:**
1. Creates checkpoint (if `checkpointManager` + `campaignId` provided)
2. Creates governance proposal with type `dangerous_command`
3. Waits for governor votes (all must approve)
4. Returns outcome with full context

## Integration

### Workflow Engine (src/workflows.js)

Add dangerous command detection before node execution in `executeNodeCore()`:

```javascript
import {
  detectDangerousCommands,
  requestDangerousCommandApproval
} from './dangerous-command-detector.js';

async function executeNodeCore(projectId, run, node, runContext, channel, deps) {
  // ... existing code ...

  if (node.type === 'task') {
    // Extract text to scan
    const textToScan = [
      node.config?.description || '',
      node.config?.command || '',
      node.config?.script || '',
    ].join(' ');

    // Detect dangerous commands
    const detection = detectDangerousCommands(textToScan, {
      nodeId: node.id,
      workflowId: run.workflowId,
    });

    if (detection.isDangerous) {
      // Request governance approval (creates checkpoint + proposal + waits)
      const result = await requestDangerousCommandApproval({
        projectId,
        detection,
        governanceManager: deps.governanceManager,
        events: deps.events,
        checkpointManager: deps.checkpointManager,
        campaignId: run.workflowId,
        additionalContext: {
          nodeId: node.id,
          workflowId: run.workflowId,
          runId: run.id,
          fullText: textToScan,
        },
        timeoutMs: 300000,  // 5 minutes
      });

      if (result.outcome !== 'approved') {
        throw new Error(
          `Dangerous command blocked: ${result.outcome}. ` +
          `Proposal: ${result.proposalId}. ` +
          `Reason: ${result.reason || 'Rejected by governors'}`
        );
      }

      // Approved — log and continue
      log.warn('Dangerous command approved by governance — executing with caution', {
        nodeId: node.id,
        proposalId: result.proposalId,
        risk: detection.risk,
        checkpointId: result.checkpointId,
      });
    }

    // Proceed with execution
    // ...
  }
}
```

## Testing

Run the test suite:

```bash
node src/dangerous-command-detector.test.js
```

Run the integration example:

```bash
node src/dangerous-command-detector-integration-example.js
```

## Pattern Coverage

The detector includes patterns for:

- **Filesystem:** rm -rf, chmod 777/666
- **Git:** reset --hard, push --force, clean -f, branch -D, checkout -- .
- **SQL:** DROP TABLE/DATABASE, TRUNCATE, dangerous DELETE
- **Case insensitive:** Matches regardless of case
- **Context aware:** Captures surrounding text for review

## False Positive Mitigation

The detector is designed to minimize false positives:

- Patterns require word boundaries (`\b`) to avoid substring matches
- Commands must match exact patterns (e.g., "formatted" won't match "rm -rf")
- Context snippets help governors review actual usage
- Safe variants (e.g., `DELETE FROM users WHERE id = 123`) are not flagged

## Extensibility

To add new patterns, edit `DANGEROUS_PATTERNS` in `dangerous-command-detector.js`:

```javascript
{
  pattern: /\bmycommand\s+--dangerous\b/gi,
  risk: 'high',
  description: 'Dangerous mycommand operation',
  category: 'custom',
}
```

## Security

- **Fail-safe:** Detection errors default to blocking execution
- **Pre-checkpoint:** Checkpoints created BEFORE governance escalation
- **Audit trail:** All detections logged with timestamp and context
- **No bypass:** Dangerous commands cannot execute without approval

## Performance

- **Fast:** Regex-based matching, <10ms for typical inputs
- **Non-blocking:** Detection runs synchronously, governance waits async
- **Memory efficient:** No state storage, pure function detection

## Future Enhancements

- Allowlist mechanism for approved patterns
- Command obfuscation detection (base64, hex encoding)
- Context-aware risk adjustment (dev vs prod)
- Automatic rollback on failure after approval
