# 0045. Add Supervisor Heartbeats and Stale Task Reconciliation

Date: 2026-06-23

## Status

Accepted

## Context

Orchestrator starts child agents through an internal watcher process. The
watcher captures logs and events, writes result files, and updates the durable
task status when the child exits.

The current task model is honest for normal agent outcomes:

```text
queued | starting | running | succeeded | failed | cancelled | timed_out
```

ADR 0044 added stop-request metadata so an interrupted task can be shown as
`stopping` while it is still shutting down. That fixed the case where
`cancelled` was being shown before the process had actually stopped.

There is still a separate failure mode: Orchestrator can lose the watcher
itself. If the watcher crashes, is killed, or disappears before writing final
state, the task file can keep saying `running` or `stopping` even though that is
no longer trustworthy. This is not the same as the agent failing. It means
Orchestrator lost supervision.

This matches a known orchestration pattern from systems like Kubernetes and
Nomad: do not trust old status forever. Use heartbeats, freshness checks, and
reconciliation to distinguish known state from stale observation.

## Decision

Add a small heartbeat and reconciliation layer. Do not add a daemon yet.

Keep durable task status outcome-oriented. Do not add `stale`, `orphaned`, or
`lost` as durable `TaskStatus` values in this decision.

Instead, replace the narrow display-state concept with an observed task state
concept exposed through the existing public JSON field `state`:

```text
TaskObservedState =
  queued | starting | running | stopping
  succeeded | failed | cancelled | timed_out
  stale | orphaned | lost
```

Meanings:

- `running`: watcher heartbeat is fresh and the task is active.
- `stopping`: stop was requested, heartbeat is fresh, and the task is still
  active.
- `stale`: heartbeat is old, and Orchestrator cannot confidently resolve
  liveness.
- `orphaned`: watcher is gone, but the child process is verified alive.
- `lost`: watcher is gone, child process is verified gone, and no terminal
  status was written.

`status` remains the durable outcome. `state` is what Orchestrator currently
observes.

Heartbeat data must be written to a separate `heartbeat.json` file, not
`task.json`. `task.json` is rewritten by task status, usage, interrupt, and
finalization paths; heartbeat ticks must not race those writes.

Supervision metadata must record process identity, not just numeric PIDs. PID
existence alone is not safe enough because PIDs can be reused. If Orchestrator
cannot verify a process identity strongly enough, it must degrade to `stale`
and must not classify the task as `orphaned` or send a signal to that PID.

Add a core observation helper, conceptually:

```ts
observeTaskState(input, task): Promise<TaskObservation>
```

`TaskObservation` should carry durable `status`, observed `state`, whether the
task should still appear in active operational views, liveness details, and a
human/machine-readable reason.

All control surfaces must consume this observation model:

- `ps`
- compact `ps`
- group summaries
- `--active` filtering
- stop target generation
- `list`
- `read`
- `read --wait`
- `interrupt`
- compact JSON
- parent-agent tool summaries

This must not be only a human-rendering change. Agents and scripts need the same
observed state and active semantics as humans.

`read --wait` and parent `read_agent({ wait: true })` must not wait forever on
tasks observed as `stale`, `orphaned`, or `lost`. Their retrieval status should
be extended beyond `completed | timeout`; use `unavailable` for these cases and
carry the observed `state` as `stale`, `orphaned`, or `lost`.

`interrupt` must distinguish `lost`, `stale`, and `orphaned`. In v1 it should
skip all three with explicit reasons instead of signaling a raw PID. Verified
orphan cleanup can be added later as a separate explicit operation if we need
it; the default interrupt path should stay conservative.

Implement in slices:

1. Passive heartbeat and observed state for `ps` and compact `ps`.
2. Observed state integration for `list`, `read`, `read --wait`, and parent
   tools.
3. Safe interrupt reconciliation and expanded skipped reasons.
4. Optional writeback events for reconciled `lost` or `orphaned` tasks.

## Consequences

Orchestrator will stop showing stale task records as confidently active work.
Humans and agents will be able to see when Orchestrator lost supervision and
decide whether to wait, inspect logs, interrupt, or relaunch work.

Durable task status stays honest. A lost task is not automatically `failed`,
`cancelled`, or `succeeded`; it is a task whose final outcome is unknown.

The implementation must touch more than rendering. Active filtering, compact
machine payloads, stop targets, read/wait behavior, and parent-agent tool
schemas all need to use the same observation model.

Heartbeat storage adds one small file per running task. This is preferable to a
database or daemon at this stage and avoids corrupting `task.json` with frequent
heartbeat writes.

Process identity checks are required before PID-based orphan cleanup. If
identity cannot be verified on a platform, Orchestrator must choose conservative
`stale` behavior rather than risk signaling the wrong process.

Legacy tasks without supervision metadata may remain less certain. They should
be marked legacy/unverified in observed state. Old running/stopping records
without supervision should be observed as `stale`, and must not be treated as
safe for direct orphan interruption unless process identity can be verified.

References:

- `adr/research/SPIKE-supervisor-heartbeats-and-stale-task-reconciliation-20260623-095805.md`
- `adr/research/synthesis-supervisor-heartbeats-and-stale-task-reconciliation-20260623-100342.md`
- `adr/specs/supervisor-heartbeats-and-stale-task-reconciliation-20260623-100342.md`
- `adr/decisions/0044-model-interrupt-as-stop-request-metadata-20260623-075635.md`
- `doc/internal/supervision-model.svg`
