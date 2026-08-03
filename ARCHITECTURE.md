# Synapse Architecture

## System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         SYNAPSE (:8080)                               │
│                                                                       │
│  ┌───────────┐    ┌───────────┐    ┌────────────────┐               │
│  │ Browser UI │◄──►│ WebSocket │◄──►│  Orchestrator  │               │
│  │  (492 HTML │    │  Server   │    │ (orchestrator  │               │
│  │  + 29 JS,  │    │  (human)  │    │     .js)       │               │
│  │  30 CSS)   │    │           │    └───────┬────────┘               │
│  └───────────┘    └───────────┘            │                         │
│                                            │                         │
│  ┌───────────┐                             │    ┌──────────────┐     │
│  │ MCP Server│◄──── external agents ───────┤    │   Router     │     │
│  │  (HTTP)   │   (authenticated harnesses) │    │ (router.js)  │     │
│  └───────────┘                             │    └──────────────┘     │
│                                            │                         │
│          ┌─────────────┬───────────────┬───┴──────────┐              │
│          ▼             ▼               ▼              ▼              │
│   ┌────────────┐ ┌───────────┐ ┌────────────┐ ┌────────────┐       │
│   │   State    │ │ Campaign  │ │    Task    │ │  Lifecycle │       │
│   │  Manager   │ │  Manager  │ │  Manager   │ │  Engine    │       │
│  │ (state.js) │ │(campaigns │ │ (tasks.js) │ │(lifecycle  │       │
│  │  SQLite    │ │   .js)    │ │  SQLite    │ │   .js)     │       │
│  └────────────┘ └───────────┘ └────────────┘ └────────────┘       │
│                                                                       │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                      │
│  │Claude│ │Codex │ │Gemini│ │Ollama│ │ GLM  │                      │
│  │  CLI │ │  CLI │ │  CLI │ │ HTTP │ │ HTTP │                      │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Agent Subprocess Architecture

Each agent runs in its own detached process group. Synapse spawns, monitors, and terminates them.

```
Orchestrator
    │
    ├── spawn('claude', ['-p', msg, '--model', model, '--max-turns', '5'])
    │   └── ClaudeAgent (src/agents/claude.js)
    │       ├── detached: true (own process group via /proc tracking)
    │       ├── send(prompt, workingDir) → Promise<string>
    │       ├── stop(reason) → SIGTERM → 5s grace → SIGKILL
    │       └── env: strips CLAUDECODE + CLAUDE_CODE_ENTRYPOINT
    │
    ├── spawn('codex', ['exec', '--json', '-m', model, msg])
    │   └── CodexAgent (src/agents/codex.js)
    │       ├── detached: true
    │       ├── send(prompt, workingDir) → Promise<string>
    │       ├── stop(reason) → SIGTERM → 5s grace → SIGKILL
    │       └── _parseCodexOutput: JSONL → item.completed → text
    │
    ├── spawn('gemini', ['-m', model, msg])
    │   └── GeminiAgent (src/agents/gemini.js)
    │       ├── detached: true
    │       ├── send(prompt, workingDir) → Promise<string>
    │       └── filters: 'Loaded cached credentials', deprecated flags
    │
    ├── HTTP POST to Ollama /api/chat
    │   └── OllamaAgent (src/agents/ollama.js)
    │       ├── HTTP-based (no subprocess)
    │       ├── send(prompt, workingDir) → Promise<string>
    │       └── endpoint configurable per agent
    │
    └── HTTP POST to GLM API
        └── GlmAgent (src/agents/glm.js)
            ├── HTTP-based
            └── send(prompt, workingDir) → Promise<string>
```

## Conversation Loop

```
User Message
    │
    ▼
┌────────────────┐
│  queueTurn()   │◄── Per-channel promise chain (prevents overlap)
└───────┬────────┘
        ▼
┌────────────────┐
│ resolveThread() │── /thread cmd? → handle command
│  (threading.js) │── replyTo? → inherit thread
│                 │── pinned thread? → use it
│                 │── continuation cue? → most recent thread
│                 │── Jaccard > 0.10? → best match
│                 │── else → new thread
└───────┬────────┘
        ▼
┌────────────────┐
│ Record message  │── addMessage() → JSONL + broadcast
└───────┬────────┘
        ▼
┌────────────────┐
│ Parse routing   │── @codex → directed to Codex only
│                 │── @claude @codex → split tasks
│                 │── no mention → all agents
└───────┬────────┘
        ▼
┌─────────────────────────────────────────┐
│           CONVERSATION LOOP              │
│                                          │
│  for round in 0..MAX_TOTAL_TURNS(50):    │
│    ├── Build context per agent            │
│    │   ├── persona injection               │
│    │   ├── thread message history         │
│    │   └── cross-project refs             │
│    ├── Dispatch to agents (parallel)      │
│    │   └── withTimeout(send(), timeout)   │
│    ├── Record responses                   │
│    ├── Check: all agreement? → stop       │
│    ├── Check: consecutive cap (2)? → skip │
│    ├── Check: agent votes? → queue        │
│    └── Determine next respondents         │
│                                          │
│  On MAX_TOTAL_TURNS hit:                 │
│    ├── agent.stop('max_total_turns')     │
│    ├── Log cleanup results               │
│    └── Deadlock detection + system msg   │
└──────────────────────────────────────────┘
```

## Campaign Lifecycle

Campaigns decompose goals into milestones, tasks, and subtasks:

```
Campaign
├── Milestone 1
│   ├── Task 1.1
│   │   ├── Subtask (agent: claude, role: implementer)
│   │   ├── Subtask (agent: gemini, role: reviewer)
│   │   └── doneCriteria: ["tests pass", "no lint errors"]
│   └── Task 1.2
│       └── ...
├── Milestone 2
│   └── ...
└── doneCriteria: ["all milestones complete"]
```

### Campaign States

```
queued → active → completed
                 → failed
                 → paused → active (resume)
```

The lifecycle engine (`src/orchestrator/lifecycle.js`) drives campaigns forward:
- Picks the next incomplete milestone
- Dispatches subtasks to available agents
- Runs cross-provider review (second reviewer from different provider)
- Tracks trust scores based on validation outcomes
- Auto-merges high-trust changes, gates low-trust changes for operator approval

### Task States

```
queued → planning → executing → reviewing → done
                                        → failed
                  → sleeping (daemon tasks)
```

## Data Model

All persistent state is stored in SQLite (one database per project):

```
.synapse/
├── config.json              # Global config, default project
├── .env                     # SYNAPSE_PASSWORD, operator name, endpoints
├── agents.json              # Agent definitions (CLI path, model, endpoint)
└── projects/
    └── my-project/
        ├── config.json      # Project settings (allocation, channels, vision)
        ├── state.sqlite     # Campaigns, tasks, milestones, subtasks
        ├── channels/
        │   └── general/
        │       └── transcript.jsonl
        └── snapshots/       # Point-in-time state backups
```

### SQLite Schema

```sql
-- Composite primary keys handle cross-project ID collisions
CREATE TABLE campaigns (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT, status TEXT DEFAULT 'queued',
  metadata TEXT DEFAULT '{}',       -- JSON for flexible fields
  PRIMARY KEY (id, project_id)
);

CREATE TABLE milestones (
  id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT, status TEXT DEFAULT 'pending',
  task_ids TEXT DEFAULT '[]',       -- JSON array
  PRIMARY KEY (id, campaign_id)
);

CREATE TABLE tasks (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  campaign_id TEXT, status TEXT DEFAULT 'queued',
  subtasks TEXT DEFAULT '[]',       -- JSON array of subtask objects
  findings TEXT DEFAULT '[]',       -- JSON array of review findings
  PRIMARY KEY (id, project_id)
);
```

## Message Flow

### Project Allocation

Allocation (0–100%) controls how agent attention is distributed across projects. It affects two things:

**1. Project Selection Probability** (`lifecycle.js` seekAndExecute)
When an idle agent seeks work, it does a weighted random draw across all projects with allocation > 0:
```
totalAlloc = sum of all project allocations
draw = random() * totalAlloc
iterate projects, subtracting each allocation from draw
first project where draw <= 0 is selected
```

**2. Max Concurrent Tasks** (`lifecycle.js` heartbeat)
```
maxConcurrent = ceil(allocation / 100 * maxConcurrentTasks)
```

| Allocation | Selection Weight | Concurrent Tasks (default max=3) |
|-----------|-----------------|----------------------------------|
| 100%      | full            | 3                                |
| 75%       | 3/4             | 3 (ceil(2.25))                   |
| 50%       | 1/2             | 2                                |
| 25%       | 1/4             | 1                                |
| 0%        | paused          | 0 (no work dispatched)           |

Example: main=100, sideproject=25, research=25. Total=150. Main gets 100/150=67% of agent seeks and 3 concurrent tasks. Others get 17% each and 1 concurrent task.

### Project Mode

- **Continuous**: When all campaign milestones complete, the strategist auto-generates a new campaign from the project vision.
- **Static**: When all campaigns complete, the project pauses. Operator must manually add new campaigns to resume work.

## Message Flow

```
Browser → WebSocket → orchestrator.queueTurn()
                        │
                        ├─ resolveThread() → thread assignment
                        ├─ addMessage() → JSONL + broadcast
                        ├─ route determination
                        │
                        ▼
                   handleUserMessage()
                        │
                   ┌────┴────┐
                   │  Router  │
                   └────┬────┘
                        │ weighted random selection
                        │
              ┌─────────┼─────────┐
              ▼         ▼         ▼
           Agent A   Agent B   Agent C
           (spawn)   (spawn)   (HTTP)
              │         │         │
              ▼         ▼         ▼
           Response Response Response
              │         │         │
              └─────────┼─────────┘
                        ▼
                   Record + Broadcast
                        │
                   Next round or done
```

## Thread Classification

Messages are classified into threads using Jaccard similarity:

```
Input: "it sounds like we have consensus"
  │
  ├─ 1. /thread cmd?       → explicit thread
  ├─ 2. replyTo set?       → inherit parent thread
  ├─ 3. Pinned thread?     → use pinned
  ├─ 4. Continuation cue?  → most recent active thread
  ├─ 5. Jaccard > 0.10?    → best match
  └─ 6. None match         → new thread
```

## Routing

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full routing weights specification. Summary:

- **Delta-proportional weighting**: agents with higher success rates get materially more traffic
- **5-dispatch threshold**: new agents get uniform weights until sufficient data
- **Exploration floor** (5%): every agent gets minimum traffic regardless of performance
- **Circuit breakers**: agents in `open` state are excluded from routing
- **Operator constraints**: exclude agents, require providers, time windows, max concurrent

## MCP Server

The MCP server (`src/orchestrator/mcp-server.js`) provides authenticated HTTP access for external agent harnesses. It runs on the same port as the WebSocket server.

Protocol: Streamable HTTP (POST with SSE response). Authentication via session cookie.

Available tools:
- `list_projects`, `list_campaigns`, `list_tasks`
- `create_campaign`, `update_task`
- `send_message`, `get_state`
- `health_check`

## CLI

```
synapse init        # Interactive wizard: detect CLIs, create .env, agents.json, first project
synapse agent add   # Register an agent (name, provider, CLI path, model, endpoint)
synapse agent list  # Show registered agents
synapse start       # Start the server (equivalent to node src/orchestrator.js)
```

The init wizard detects installed CLIs (`claude`, `codex`, `gemini`) and Ollama endpoints, writes `.env` and `agents.json`.

## Constants & Limits

```
MAX_TOTAL_TURNS           = 50      # Total agent responses per user message
MAX_CONSECUTIVE_PER_AGENT = 2       # Same agent can't speak 2+ times in a row
STOP_GRACE_MS             = 5000    # Grace period before SIGKILL
JACCARD_THRESHOLD         = 0.10    # Thread classification similarity cutoff
VOTE_TIMEOUT              = 60s     # Per-agent vote response limit
CIRCUIT_BREAKER_THRESHOLD = 5       # Failures before opening circuit
CIRCUIT_BREAKER_RESET_MS  = 60000   # Time before half-open retry
```

## UI Architecture

The UI is a single-page app served from `src/ui/public/`:

- **index.html** (492 lines) — chat interface, campaign sidebar, task panels
- **29 JS modules** — campaigns, tasks, agents, health, timeline, dashboard, etc.
- **30 CSS files** — theme, layout, sidebar, campaign-specific styles

Separate pages:
- `/dashboard` — operator dashboard with campaign grid, agent cards, metrics
- `/dashboard/operator` — detailed operator controls
- `/audit-timeline` — searchable audit event timeline
