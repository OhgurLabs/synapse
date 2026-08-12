# Agent Roles & Minimum Setup

**One working agent is enough.** Roles are *optional specialization*: an agent
with **no role is a generalist** and may claim any subtask (implementer,
reviewer, architect, researcher). A fresh install's seeded agents carry no
roles and complete full campaigns — build, review, and play-verify — on their
own. Assign roles when you want division of labor, not because Synapse
requires them.

Once an agent HAS a role, it claims only what that role allows. The one hard
rule: **governors never pick up work** regardless of anything else.

## Roles

| Role | What it claims | Typical work |
|---|---|---|
| *(none)* | **anything** (generalist) | the fresh-install default; full campaign lifecycle |
| **developer** | implementer subtasks | writing/editing code, running commands, creating files |
| **architect** | planner subtasks + reviewer fallback | decomposing a task into subtasks, designing approaches |
| **reviewer** | reviewer + audit subtasks | inspecting diffs, approving or rejecting completed work |
| **researcher** | research + implementer-class subtasks | investigation, comparisons, findings docs |
| **governor** | no work claim | manual operator-level controls only (does not pick up tasks) |

Roles are set in the agent settings modal (click an agent badge) or in
`.synapse/agents.json`.

## Minimum setup

**Minimum: one working agent, no roles.** It plans, builds, and reviews its
own campaigns as a generalist.

**For cross-provider review** — a second agent (different provider) reviewing
the first one's work — run at least two agents. With explicit roles, the
classic trio below gives full division of labor; architects can act as a
reviewer fallback when no dedicated reviewer is available.

```jsonc
// .synapse/agents.json — minimum viable
{
  "agents": [
    { "id": "dev",  "provider": "claude", "role": "developer",  ... },
    { "id": "arch", "provider": "codex",  "role": "architect",  ... },
    { "id": "rev",  "provider": "gemini", "role": "reviewer",   ... }
  ]
}
```

## Recommended setup

Multi-provider coverage so a per-provider rate limit, circuit-breaker open, or
account outage doesn't stop the pipeline. The mix below is what the maintainers
run day-to-day:

| Role | Agent | Provider | Why this slot |
|---|---|---|---|
| developer | Claude Sonnet/Opus | claude (Pro sub) | strongest code-write, reads diffs cleanly |
| architect | GPT-5 Codex | codex (Plus sub) | fast planner, complements Claude on review |
| reviewer | Gemini Flash | gemini (Pro sub) | cheap, fast verdicts on small diffs |
| developer | Local LLM (Ollama / opencode) | ollama / opencode | free fallback when cloud agents are saturated |
| architect | GLM-4.7 (Z.AI Coding Plan) | opencode | low-cost second architect for breadth |

Two architects + one reviewer is the **cross-provider review** sweet spot —
audit subtasks need a different provider than the implementer/first-reviewer,
and a single architect pool of one means the audit step often has no candidate
and stalls.

## What fails if you skip a role

- **No developer** — planning succeeds, decomposes a task into subtasks with
  `suggestedRole: 'implementer'`, but no agent ever claims them. Task sits in
  `executing` with `queued` subtasks indefinitely.
- **No architect** — the strategist can't decompose campaigns into milestones
  or tasks. Vision sits unrealised; nothing enters the work pipeline.
- **No reviewer** — implementer subtasks complete, but the per-task reviewer
  step (and the cross-provider audit step at end of milestone) has no claimant.
  Tasks pile up in `reviewing` status. The campaign cannot close out.
- **No reviewer AND no second architect** — the cross-provider audit at end
  of milestone gates with no eligible agent. The campaign hangs in
  `awaiting_approval` even after operator approval, because audit never
  resolves. (Fixed in v0.1.0-beta.X by adding a watchdog that clears
  role-incompatible assignees so the manual `/approve` chat command still
  works.)

## Verifying your setup

```bash
synapse agent list
```

Look for at least one row each in `role: developer`, `role: architect`,
`role: reviewer`. If the orchestrator is running, the dashboard's agent panel
shows each role with a coloured badge.

## Adding roles via the wizard

`synapse agent add` detects installed harness CLIs and prompts for a role
assignment per agent. Pick the role that matches the model's strength — the
suggestions in the wizard are reasonable defaults, not requirements.

## Related

- `docs/cross-provider-review.md` — how the audit step picks a second reviewer
- `incident-2026-05-13-audit-task-wrong-role-assignee.md` (vault) — the
  failure mode this document was written to prevent
