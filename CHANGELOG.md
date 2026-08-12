# Changelog

All notable changes to Synapse are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-release identifiers during beta).

## [0.1.0-beta.18] — 2026-08-12

### Added

- **Agent priority ranks** — replace the static cost-tier assumptions with a
  user-configurable priority system. Set a one-time default rank order in
  Settings, or override it per project for fine-grained control (cheapest-first
  on one project, a single pinned specialist on another). Rank is the primary
  ordering inside every role-eligible selection; an optional **strict mode**
  collapses selection to the highest-ranked available agent. Reviewer
  independence survives strict mode by design — priority never forces an agent
  to review its own work.
- **Rank-walk failover** — provider failover now walks the configured priority
  ranking instead of a hardcoded fallback chain. The project roster is a hard
  boundary: agents are never used as fallback on a project they aren't
  configured for, and a single-agent project simply has no fallback. Local
  (self-hosted) agents participate in failover only when explicitly ranked —
  GPU capacity is opt-in, never an accidental catch-all.
- **Architect starvation alerts** — when a project has work queued but no
  agent able to plan it, Synapse raises a targeted notification naming the
  project instead of stalling silently. Dismissible without nagging;
  structural gaps alert immediately, transient ones only after a grace
  window.
- **Provider capability layer** — provider metadata (locality, backend,
  concurrency class) is now derived from a single registry instead of
  scattered heuristics, with per-backend concurrency caps for local GPU
  serving and a `llamacpp` provider alias.
- **Schema self-reconciliation** — SQLite-backed stores now reconcile
  missing columns at startup, so databases created by earlier releases
  upgrade in place instead of failing to boot.
- This changelog.

### Fixed

- **Project snapshots silently excluded campaign and task state.** After the
  storage layer moved to SQLite, snapshots still captured the legacy JSON
  files — which no longer existed — so the automatic pre-change safety
  snapshots protected nothing and restore was a no-op for the very state it
  existed to revert. Snapshots now capture and restore through the live
  storage layer, and older snapshot archives restore through the same path.
- **SLA breach/resolution events were never persisted.** The monitor called a
  store method that was never implemented, behind an optional call that
  swallowed the absence. The table, indexes, and append path now exist.
- **Hourly-cost SLA breaches could never resolve once spending stopped.** An
  empty cost window was treated as "no data" rather than a true $0
  measurement, so the most common way a cost overrun ends — pausing the
  agents — left the alert stuck until restart.
- **Local-provider agents could silently stop picking up work** when the
  configuration had no sandbox section: an unguarded property access threw
  inside the work-seek loop's error handling, disabling local pickup with
  nothing logged.
- **Timeline pagination returned an empty second page.** Pagination was
  applied both inside each per-type query and again on the merged result,
  double-offsetting every page after the first. The paginated window is also
  now bounded; deep pagination should use cursor mode.
- **Anomaly history double-counted every alert.** The history endpoint
  returned raw fired + resolved ledger rows instead of one entry per alert
  lifecycle, diverging from its own filtered variant.
- **Planner-path circuit breaker failures were recorded under phantom
  provider keys** (the agent's id treated as a provider name), so planner
  rate-limit and auth failures neither tripped any breaker nor gated
  dispatch, and polluted the health status map. They now record under the
  real provider, matching the execution path.
- **A failed audit-log write could crash the orchestrator** when a
  fire-and-forget review chain raced project deletion. Event-log appends are
  best-effort; state transitions no longer abort on audit write failure.
- **A superseded run's late outcome could clobber its successor's claim.**
  When a stuck run was reclaimed by another agent, the dead run's failure
  handler could still escalate or retry the subtask, destroying the live
  claim — a self-sustaining loop that burned a dispatch per cycle and fed
  misattributed failures into the circuit breaker. Failure outcomes now
  carry the originating run's claim identity and are discarded once the
  claim has changed hands, including same-agent reclaims.
- **Claims could land on tasks in terminal states.** The claim path never
  checked task status, so a cancel racing an in-flight work scan could be
  silently resurrected. Claims on cancelled, done, or failed tasks are now
  rejected atomically inside the claim write.
- **Claim-timeout and escalation handling were not atomic.** A subtask that
  finished between the expiry scan and the requeue write could be yanked
  back from done; both paths now re-validate under compare-and-swap, and
  completed subtasks can no longer be resurrected by any writer.
- Test-suite overhaul: roughly two dozen suites brought from failing to
  green while surfacing the fixes above; suites now exercise live contracts
  instead of phantom APIs.

### Known issues

- On a fresh install, the onboarding wizard's first agent probe and first
  test dispatch can lose the race against server cold start and report
  failure or sit pending; **Retry** succeeds. A proper first-boot grace
  window is planned.

## [0.1.0-beta.17] — 2026-08-03

### Added

- Audited build: full codebase audit pass across all three release tiers,
  with fixes applied prior to the version bump.

[0.1.0-beta.18]: https://github.com/ohgurlabs/synapse/releases/tag/v0.1.0-beta.18
[0.1.0-beta.17]: https://github.com/ohgurlabs/synapse/releases/tag/v0.1.0-beta.17
