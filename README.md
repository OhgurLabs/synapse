# Synapse

**The nervous system between AI agent ecosystems.**

Every agent platform wants you inside its walls. Synapse connects them instead — a local-first orchestrator where your agents talk to each other, debate each other's work, and decompose goals into campaigns you can watch unfold.

Bring your own agent. Any harness, any provider. Subscription or API. Local or cloud. Agent-agnostic by design.

> Three Claude sessions once debated a trading prompt. The human copy-pasted between terminals. The result was better than any single session could produce. The question that built Synapse was: why is the human doing the routing?

## Quick Start

```bash
git clone https://github.com/ohgurlabs/synapse.git && cd synapse
npm install
npm install -g .      # provides the `synapse` command
synapse init          # interactive setup: detect CLIs, configure providers
synapse start         # or: node src/orchestrator.js
```

(An npm-registry package is planned; until then, install from the repo as above.)

First launch opens an onboarding wizard in the browser: Synapse seeds agents
for the coding CLIs it actually detects on your machine (or walks you through
creating your first agent if none are found), validates each one live,
proves the routing pipeline with a real test dispatch, and offers a set of
starter projects — community-format one-shot builds with their full prompts
and provenance on the card. Done means played: the first project isn't
"complete" until an agent has opened it and exercised it.

`synapse init` defaults the admin password to `synapse` for first-run review on a trusted network. You can keep it, type `random` to generate a secure one, or set your own. The chosen password is printed in the Setup Complete banner and saved to `.env` as `SYNAPSE_PASSWORD`.

Open `http://localhost:8080` and log in with the password from init.

## Supported Providers

| Provider | Agent CLI | Auth |
|----------|-----------|------|
| Anthropic Claude | `claude` CLI (`-p` flag) | Claude Max / Pro subscription · API key |
| OpenAI Codex | `codex exec --json` | ChatGPT Plus subscription · API key |
| Google Gemini | `gemini` CLI | Google AI subscription · API key |
| Ollama | HTTP API (`/api/chat`) | None — local |
| Z.ai GLM | HTTP API | API key |
| **Your provider** | CLI subprocess · HTTP · MCP endpoint | Subscription · API key · local — you choose |

Synapse adapts to the agent, not the other way around. Each agent runs in its own process group; the orchestrator manages lifecycle (spawn, heartbeat, SIGTERM/SIGKILL), tracks status (idle / thinking / rate_limited / unavailable), and routes messages based on availability, performance history, and operator constraints.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      SYNAPSE (:8080)                          │
│                                                               │
│  Browser ◄──► WebSocket ◄──► Orchestrator ◄──► MCP Server   │
│    UI           (human)        (routing)       (agent auth)  │
│                                                               │
│                         │                                     │
│          ┌──────────────┼──────────────┐                      │
│          ▼              ▼              ▼                      │
│     ┌─────────┐  ┌───────────┐  ┌──────────┐                │
│     │  State   │  │ Campaign  │  │   Task   │                │
│     │(SQLite)  │  │  Manager  │  │ Manager  │                │
│     └─────────┘  └───────────┘  └──────────┘                │
│                                                               │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ╭──────╮       │
│  │Claude│ │Codex │ │Gemini│ │Ollama│ │ GLM  │ │ your │  ···  │
│  │  CLI │ │  CLI │ │  CLI │ │ HTTP │ │ HTTP │ │ agent│       │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ ╰──────╯       │
└──────────────────────────────────────────────────────────────┘
```

- **Orchestrator** (`src/orchestrator.js`) — conversation loop, agent dispatch, WebSocket server
- **Campaign Manager** (`src/campaigns.js`) — decomposes goals into milestones → tasks → subtasks
- **Task Manager** (`src/tasks.js`) — task lifecycle with subtask execution and review gates
- **State Layer** (`src/state.js` + `src/orchestrator/state-db.js`) — SQLite persistence, project isolation
- **MCP Server** (`src/orchestrator/mcp-server.js`) — authenticated HTTP endpoint for external agent harnesses
- **CLI** (`src/cli.js`) — `synapse init`, `synapse agent add/list`, interactive wizard

## Key Concepts

### Projects
Top-level isolation boundary. Each project has its own agents, campaigns, tasks, channels, and SQLite database. Agents and campaigns never leak between projects.

**Allocation** (0–100%) controls how agent attention is distributed across projects:
- **Project selection**: When an idle agent seeks work, it does a weighted random draw across projects. A project at 100% gets proportionally more agent visits than one at 25%.
- **Concurrency cap**: Each project's max concurrent tasks is `ceil(allocation / 100 × maxConcurrentTasks)`. At 100% you get 3 concurrent tasks (default), at 25% you get 1.
- **0% pauses the project** — no work dispatched, but campaigns and state are preserved.

Example: main=100, sideproject=25, research=25 → main gets 67% of agent attention, others get 17% each.

**Mode**: Continuous projects auto-generate new campaigns from the vision when all milestones complete. Static projects pause when campaigns finish, waiting for manual new campaigns. One-shot projects dispatch the vision verbatim to a single agent — no planner, no ceremony — for 1:1 parity with community one-shot prompts.

**Roster** (required at creation): every project declares who may work it — specific agents, whole model classes ("all opus-5", "all gpt-5.6-sol"), or all agents. The pickup loop, planner, and review stages all enforce it; an unrestricted agent can never wander into a pinned project.

### Campaigns
Decomposed goals. A campaign has milestones, each milestone has tasks, each task has subtasks assigned to specific agents. The lifecycle engine drives campaigns through queued → active → completed/failed with automatic checkpointing.

### Routing
Chat messages route through four modes — Auto (classifier picks), Solo (one agent), Pair (primary answers, a second agent reviews the answer it is handed), and Council (full round-table with a convergence budget). `@everyone` in any message convenes a council; explicitly @mentioned agents are never silently substituted — a busy agent is skipped with an honest note, never impersonated. Dispatch weighs:
- Availability (circuit breaker state)
- Performance history (success rate per agent per project)
- Operator constraints (exclude agents, require providers, time windows)
- Allocation and per-provider dispatch caps (live usage visible in Settings → Pacing)

### Review & Validation
Agent code changes go through a multi-stage pipeline:
1. Cross-provider review (second agent reviews first agent's work)
2. Automated validation (syntax, lint, security)
3. Trust-score-based approval gate
4. Operator approval (for low-trust changes)

### Thread Management
Messages are classified into threads using Jaccard similarity on recent conversation context. Operators can pin threads, reply to specific messages, and filter by thread.

## Configuration

Synapse stores all state in a `.synapse/` directory relative to the working directory:

```
.synapse/
├── config.json              # global config, default project
├── .env                     # SYNAPSE_PASSWORD, SYNAPSE_OPERATOR_NAME, etc.
├── agents.json              # agent definitions (CLI path, model, endpoint)
└── projects/
    └── my-project/
        ├── config.json      # project settings (allocation, channels)
        ├── state.sqlite     # campaigns, tasks, milestones, subtasks
        └── channels/
            └── general/
                └── transcript.jsonl
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `SYNAPSE_PASSWORD` | Login password for the web UI (init default: `synapse` — change before exposing beyond localhost) |
| `SYNAPSE_OPERATOR_NAME` | Operator identity (replaces hardcoded names) |
| `SYNAPSE_EMBED_ENDPOINT` | Ollama endpoint for embedding generation |
| `SYNAPSE_SERVER_PORT` | HTTP server port (default 8080) |

## CLI

```
synapse init              # first-run wizard: detect CLIs, configure agents
synapse agent add         # interactively register a new agent
synapse agent list        # show registered agents
synapse start             # start the server
```

## API

Synapse exposes a REST API on the same port as the WebSocket server. Key endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | System health, agent status, circuit breaker state |
| `GET` | `/api/projects` | List projects |
| `PATCH` | `/api/projects/:id` | Update project (allocation, mode, vision, repoConfig, agents) |
| `GET` | `/api/projects/:id/campaigns` | List campaigns |
| `GET` | `/api/projects/:id/tasks` | List tasks |
| `GET` | `/api/agents` | List agents with status |
| `POST` | `/api/agents/:id/probe` | Test agent connectivity |
| `POST` | `/api/auth/login` | Authenticate, get session cookie |

MCP tools are available via HTTP at `/mcp` for authenticated external agent harnesses.

## Testing

```bash
npm test                  # full suite via mocha (node test.mjs)
npm test -- <name>        # filter to a single file/pattern, e.g. `npm test -- campaigns`
npm run test:ui           # Playwright UI tests
```

The suite is mocha-based and discovers `*.test.js` files under `src/`, `test/`, and
`test/integration/`. A subset of files are mid-migration from the legacy JSON-CAS
persistence layer to the current SQLite-backed storage and are tracked for cleanup.

## Requirements

- **Node.js** >= 20 (not the snap-packaged variant — see [Known issues](#known-issues))
- **Linux** (uses `/proc`, `pgrep`, process groups)
- One or more agents reachable. Any of: a CLI-based harness (`claude`, `codex`, `gemini`, your own), a local runtime (Ollama, llama.cpp, vLLM), or an HTTP endpoint (OpenAI-compatible, MCP, custom).
- One working agent is enough to start. Roles (developer / architect / reviewer / governor / researcher) are **optional specialization**: an agent with no role is a generalist and can pick up any work. Assign roles in the agent settings modal when you want division of labor — see [docs/agent-roles-and-minimums.md](docs/agent-roles-and-minimums.md).

## Known issues

- **Ubuntu's default `apt install nodejs` installs snap-packaged node.** Synapse refuses to start under it — snap confinement breaks the stdout/stderr pipes that the orchestrator uses to talk to harness CLIs. Install a non-snap node from [nodejs.org](https://nodejs.org/dist/) or via [NodeSource](https://deb.nodesource.com/) before running `synapse start`.

## License

Apache 2.0 — see [LICENSE](LICENSE)
