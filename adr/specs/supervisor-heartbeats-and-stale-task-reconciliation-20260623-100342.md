# Supervisor Heartbeats and Stale Task Reconciliation

Date: 2026-06-23

## Goal

Make stale task records obvious and actionable when Orchestrator loses the
watcher process for a running task.

This should prevent fake forever-running or forever-stopping tasks without
claiming success, failure, or cancellation when Orchestrator cannot prove the
outcome.

## Non-Goals

- Do not add a daemon in this slice.
- Do not require a database.
- Do not make `stale`, `orphaned`, or `lost` durable task outcomes yet.
- Do not reconstruct missing final answers.
- Do not treat "watcher died" as "agent failed."

## Current Baseline

Durable status stays:

```text
queued | starting | running | succeeded | failed | cancelled | timed_out
```

Current display state is:

```text
TaskDisplayState = TaskStatus | "stopping"
```

`stopping` is derived from:

```text
non-terminal status + stopRequestedAt
```

The implementation should replace this narrow display concept with a single
observed state concept that still uses the public JSON field `state`.

## Proposed States

Extend the observed layer:

```text
TaskObservedState =
  queued | starting | running | stopping
  succeeded | failed | cancelled | timed_out
  stale | orphaned | lost
```

Public output should continue to use:

```json
{
  "status": "running",
  "state": "stale"
}
```

`status` is the durable task outcome. `state` is what Orchestrator currently
observes.

Definitions:

- `running`: non-terminal task, no stop request, watcher heartbeat fresh.
- `stopping`: non-terminal task, stop requested, watcher heartbeat fresh.
- `stale`: heartbeat is old and liveness could not be confidently resolved.
- `orphaned`: watcher appears gone, child process appears alive.
- `lost`: watcher appears gone, child process appears gone, no terminal status
  was written.

`lost` is not the same as `failed`. It means "final outcome unknown."

## Data Model

Add supervision metadata.

Heartbeat data must not be written into `task.json`. Heartbeats are high-churn,
and `task.json` is currently rewritten as a whole record by task status, usage,
interrupt, and finalization paths. A heartbeat write racing a final status write
could corrupt the durable outcome.

Use a separate file:

```text
~/.orchestrator/tasks/<task-id>/heartbeat.json
```

Static task metadata:

```ts
type TaskProcessIdentity = {
  pid: number;
  capturedAt: string;
  startedAtMs?: number;
  executable?: string;
};

type TaskSupervision = {
  supervisor: TaskProcessIdentity;
  child?: TaskProcessIdentity;
  processGroupId?: number;
  startedAt: string;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
};
```

Heartbeat metadata:

```ts
type TaskHeartbeat = {
  taskId: string;
  supervisorPid: number;
  childPid?: number;
  processGroupId?: number;
  lastHeartbeatAt: string;
};
```

`startedAtMs` should be the OS process start time when available. A numeric PID
alone is not enough proof of identity because PIDs can be reused. If the OS
cannot provide a process identity strong enough to compare against the recorded
identity, Orchestrator must degrade to `stale` and must not classify the task as
`orphaned` or send a signal based on that PID.

Suggested first values:

```text
heartbeatIntervalMs: 5000
staleAfterMs: 20000
```

These should be constants first, configurable later only if needed.

## Core API

Add a core helper:

```ts
observeTaskState(input, task): Promise<TaskObservation>
```

Possible shape:

```ts
type TaskObservation = {
  status: TaskStatus;
  state: TaskObservedState;
  active: boolean;
  actionable: boolean;
  checkedAt: string;
  reason?: string;
  heartbeat?: {
    lastHeartbeatAt?: string;
    staleAfterMs?: number;
  };
  liveness?: {
    supervisorAlive?: boolean;
    supervisorVerified?: boolean;
    childAlive?: boolean;
    childVerified?: boolean;
  };
};
```

`active` and stop affordances must be derived from observed state, not only
durable status. This is core behavior, not renderer behavior.

Suggested rule:

```text
active = queued | starting | running | stopping | stale | orphaned
actionable = queued | starting | running | stopping
inactive = succeeded | failed | cancelled | timed_out | lost
```

Here, `active` means "should still appear in active operational views." It does
not always mean "the agent is definitely still spending tokens." For `stale`,
it means "needs attention." `actionable` means Orchestrator can safely offer a
normal stop target.

## Reconciliation Logic

For terminal tasks:

```text
return durable status
```

For non-terminal tasks without supervision metadata:

```text
queued/starting -> keep queued/starting
recent running/stopping before first supervision heartbeat -> keep running/stopping
running/stopping -> stale with legacy/unverified reason
```

This preserves launch-startup compatibility while avoiding false confidence for
old running records. Do not use legacy PID metadata for direct orphan
interruption unless process identity can be verified.

For non-terminal tasks with fresh heartbeat:

```text
return running or stopping
```

For non-terminal tasks with old heartbeat:

1. Check supervisor process identity.
2. Check child process identity or process group when known.
3. Return:

```text
heartbeat fresh                         -> running/stopping
heartbeat old, supervisor verified alive -> stale
heartbeat old, child verified alive      -> orphaned
heartbeat old, child verified gone       -> lost
cannot verify process identity           -> stale
```

An old heartbeat must not become `running` or `stopping` merely because a PID
exists. Fresh heartbeat is what makes the observation trustworthy.

Do not write a terminal status unless a terminal event/result already proves it.

## Command Behavior

### ps

Use observed state in the status column.

`ps`, compact `ps`, group summaries, stop targets, and `--active` filtering must
all consume `TaskObservation`. It is not enough to compute observed state only
while rendering text.

Show separate summary counts when present:

```text
running
stopping
orphaned
stale
lost
done
failed
stopped
```

`ps --json --compact --active` should include `stale` and `orphaned`, because
they may still need action. It should not include `lost` as active, but
`views.recent.args` should make lost tasks easy to find.

Compact rows should expose:

```json
{
  "status": "running",
  "state": "lost",
  "active": false,
  "reason": "watcher gone, child gone, final outcome unknown"
}
```

### list

Show observed state instead of raw durable status for human rows.

`list --json` should not dump raw task records when observation is requested by
default behavior. It should either use the same observed summary contract as
`read`/`ps`, or explicitly remain a raw-record command. Prefer the observed
summary contract so agents do not have to know which command is stale-aware.

### read

For `lost`, `orphaned`, and `stale`, do not wait forever as if durable
`running` were still trustworthy.

Possible retrieval statuses:

```text
completed | timeout | unavailable
```

When retrieval is `unavailable`, include the observed `state` as `stale`,
`orphaned`, or `lost`. Return available logs/result fragments and explain that
the final outcome is unknown or no longer supervised.

Parent-agent `read_agent({ wait: true })` must use the same retrieval statuses
and stdout/result fallback rules as CLI `read`.

### interrupt

For `running` and `stopping`, keep current behavior.

For `stale`, `orphaned`, and `lost`, return a skipped result with the observed
state as the reason:

```json
{
  "reason": "lost",
  "message": "No safe process to interrupt."
}
```

Expand skipped reasons beyond `terminal`:

```text
terminal | stale | orphaned | lost
```

Compact interrupt JSON must include non-terminal skipped reasons. Agents need to
know when not to retry.

## Event Model

Add events only when reconciliation writes back:

```text
heartbeat_stale
task_orphaned
task_lost
reconciled
```

First implementation can be read-time only and avoid new events. If we persist
observed results, write an event so the timeline says this was reconciled, not
naturally completed.

## Implementation Slices

### Slice 1: Passive Heartbeat and Observed State

- Add supervision/heartbeat metadata.
- Store heartbeat data in `heartbeat.json`, not `task.json`.
- Store process identity, not only numeric PID.
- Start heartbeat timer inside `launchTask`.
- Stop heartbeat timer in the close handler.
- Add `observeTaskState`.
- Thread `TaskObservation` through `ps`, compact ps JSON, group summaries,
  `--active` filtering, and stop target generation.
- Add tests with synthetic stale heartbeat records.

Outcome: `ps` stops lying about stale active tasks, and compact machine output
does not keep treating `lost` work as active.

### Slice 2: Read/List/Interrupt Integration

- Use observed state in `list`.
- Use observed state in `read`.
- Teach `read --wait` not to wait forever on `stale`, `orphaned`, or `lost`.
- Add `unavailable` retrieval status to core wait, CLI read, batch read, and
  parent-agent tools, with `state` carrying `stale`, `orphaned`, or `lost`.
- Add parent-agent tool summary fields.

Outcome: agents get actionable results instead of polling blindly.

### Slice 3: Safe Interrupt Reconciliation

- Teach `interrupt` to distinguish `orphaned`, `lost`, and `stale`.
- Skip all three in normal interrupt flow with explicit reasons.
- Expand skipped reasons and compact JSON skipped details.

Outcome: agents stop retrying impossible interrupts, and Orchestrator does not
signal unverified PIDs.

### Slice 4: Optional Writeback

- Persist reconciliation metadata when a task becomes `lost` or `orphaned`.
- Append reconciliation events.
- Keep durable `status` unchanged unless we deliberately add a new status later.

Outcome: repeated reads do less work and timelines explain what happened.

## Tests

Add tests for:

- fresh heartbeat keeps task `running`;
- stop request plus fresh heartbeat shows `stopping`;
- old heartbeat plus verified live supervisor returns `stale`;
- dead supervisor plus verified live child returns `orphaned`;
- dead supervisor plus verified dead child returns `lost`;
- old heartbeat plus unverified PID returns `stale`;
- `ps --json --compact --active` includes stale/orphaned but excludes lost;
- `read --wait` exits with `retrievalStatus: "unavailable"` plus `state:
"stale"`, `"orphaned"`, or `"lost"` instead of waiting until timeout;
- `interrupt` skips stale, orphaned, and lost tasks honestly;
- compact interrupt JSON includes skipped reason details;
- legacy tasks without heartbeat are marked unverified and do not allow direct
  PID-based orphan interruption.

## Open Questions

- Should `lost` eventually become a durable task status?
- Should `orphaned` interruption write `cancelled` after the process group is
  confirmed dead?
- What exact OS process identity should we capture on macOS, Linux, and Windows?
- What is the right Windows behavior for process groups?

## Recommendation

Implement Slice 1 first. It gives immediate value to `ps` and the future TUI
without changing durable task outcomes or adding a daemon.

Then implement Slice 2 so agents using compact JSON get the same honest state
as humans. Implement Slice 3 before attempting orphan cleanup or writeback.

## References

- `adr/research/SPIKE-supervisor-heartbeats-and-stale-task-reconciliation-20260623-095805.md`
- `adr/research/synthesis-supervisor-heartbeats-and-stale-task-reconciliation-20260623-100342.md`
- `adr/decisions/0044-model-interrupt-as-stop-request-metadata-20260623-075635.md`
- `adr/specs/interrupt-stopping-state-20260623-075028.md`
- `doc/internal/supervision-model.svg`
