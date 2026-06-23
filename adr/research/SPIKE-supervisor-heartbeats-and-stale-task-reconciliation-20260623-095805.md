# Research Spike: Supervisor Heartbeats and Stale Task Reconciliation

Date: 2026-06-23

## Question

How should Orchestrator handle tasks whose internal watcher dies before it writes
a final task state, and how does that relate to known orchestration patterns?

## Short Answer

This is the same class of problem handled by orchestration systems with
heartbeats, leases, observed state, and reconciliation. The fix is not to
pretend we can prevent every crash. The fix is to make stale state detectable,
honest, and recoverable.

For Orchestrator, that means:

- the watcher should periodically write a heartbeat;
- task records should store enough process metadata to check liveness;
- `ps`, `read`, `list`, and `interrupt` should reconcile stale non-terminal
  records before presenting them as active;
- the UI/API should distinguish "agent failed" from "Orchestrator lost
  supervision."

## Current Orchestrator Model

The durable task status is currently:

```text
queued | starting | running | succeeded | failed | cancelled | timed_out
```

Source: `packages/core/src/tasks/types.ts`.

We recently added a separate display state:

```ts
export type TaskDisplayState = TaskStatus | "stopping";
```

`stopping` is derived from `stopRequestedAt` while the task is still
non-terminal. It is displayed in:

- `orchestrator ps`
- `orchestrator list`
- `orchestrator read --json`
- `orchestrator interrupt --json`
- parent-agent tool summaries

That split is good. It keeps durable terminal states honest while still giving
humans and agents a useful live state.

What does not exist yet:

- `supervisorPid`
- `childPid` as distinct from the current task `pid`
- `processGroupId`
- `lastHeartbeatAt`
- stale/orphaned/lost display states
- read-time reconciliation of stale task files

## Current Failure Mode

Normal task failure is already modeled:

```text
agent process exits badly -> status: failed
```

The open problem is different:

```text
Orchestrator watcher dies -> task file may keep saying running/stopping
```

That does not mean the agent failed. It means Orchestrator no longer has a
trustworthy observation stream.

Today, `interruptTask` can still try to signal a task by stored `pid` if the
task is not in the live `runningTasks` map. That helps, but it does not prove
the watcher is alive or that final result/status will be written. Without a
heartbeat, the CLI cannot tell the difference between:

- task is genuinely still running;
- task is shutting down;
- watcher died but child is alive;
- watcher died and child is gone;
- task file is stale after a crash or restart.

## Related Orchestration Patterns

### Kubernetes: Heartbeats and Leases

Kubernetes nodes report liveness through heartbeats. Kubernetes also uses Lease
objects where a timestamp is renewed and the control plane uses that timestamp
to determine node availability.

Lesson for Orchestrator:

Do not trust the last saved task status forever. Store a freshness timestamp and
make readers check whether it is still fresh.

### Kubernetes: Unknown and Terminating States

Kubernetes separates actual terminal pod phases from cases where state cannot be
obtained. It also treats deletion as a request first: deletion metadata is set,
controllers perform cleanup, and the object is removed only when cleanup is
complete.

Lesson for Orchestrator:

`stopRequestedAt -> stopping -> cancelled` is the right shape. A stop request is
not the same as final cancellation. Likewise, "lost supervision" should not be
shown as `failed` unless the agent itself actually failed.

### Nomad: Client Heartbeats and Lost Allocations

Nomad clients heartbeat to servers. When heartbeats stop, Nomad treats the
client as unavailable and marks allocations as lost or disconnected depending
on configuration. Nomad also documents that a network failure and agent crash
can be indistinguishable from the server's point of view.

Lesson for Orchestrator:

When the watcher heartbeat is gone, the honest state is about observation loss,
not task outcome. The system can apply a policy after a timeout, but it should
not claim success/failure without proof.

## Proposed Mental Model

Keep durable task outcome separate from supervision health.

Durable task status:

```text
queued | starting | running | succeeded | failed | cancelled | timed_out
```

Observed/display state:

```text
queued | starting | running | stopping | succeeded | failed | cancelled | timed_out
stale | orphaned | lost
```

Meanings:

- `running`: watcher heartbeat is fresh and task is active.
- `stopping`: stop requested, watcher heartbeat is fresh, task has not exited.
- `stale`: heartbeat is old and Orchestrator should no longer trust the last
  status without checking.
- `orphaned`: watcher appears gone, but the child process still appears alive.
- `lost`: watcher appears gone, child process appears gone, and no terminal
  status was written.

These should start as observed/display states, not new durable terminal
statuses. We may later add durable remediation events if needed.

## Possible Data Model

Add supervision metadata to `AgentTaskRecord`:

```ts
supervision?: {
  supervisorPid: number
  childPid?: number
  processGroupId?: number
  startedAt: string
  lastHeartbeatAt: string
  heartbeatIntervalMs: number
  staleAfterMs: number
}
```

We already have `pid?: number`; this likely represents the child process today.
We should avoid overloading it further. The next model should name the process
roles clearly:

- watcher/supervisor process
- child agent process
- process group where available

## Reconciliation Flow

On `ps`, `list`, `read`, and `interrupt`:

1. Read task record.
2. If task is terminal, return it as-is.
3. If task is non-terminal and heartbeat is fresh, use current status/display
   state.
4. If heartbeat is old, check known PIDs.
5. If watcher alive, keep current state or refresh heartbeat tolerance.
6. If watcher gone and child alive, show `orphaned`.
7. If watcher gone and child gone, show `lost`.

`interrupt` behavior:

- `running` / `stopping`: current behavior.
- `orphaned`: try to kill the child/process group directly; if confirmed gone,
  mark cancelled with an explicit orphaned-interrupt reason.
- `lost`: do not pretend to kill anything; return that there is no known live
  process to stop.

`read --wait` behavior:

- should not wait forever on `lost`;
- may continue waiting on `running` or `stopping`;
- should return a clear retrieval state for `orphaned` or `lost`.

## What This Fixes

It fixes the lying active-task UX:

```text
api review    stopping    42m
```

when Orchestrator no longer has a live watcher.

The improved view becomes:

```text
api review    orphaned    watcher gone, agent still alive
```

or:

```text
api review    lost        watcher gone, agent gone, final outcome unknown
```

This helps:

- humans avoid fake forever-running tasks;
- agents avoid polling forever;
- `interrupt` provide honest results;
- budget control become safer;
- the future TUI display "needs attention" instead of a misleading spinner.

## What This Does Not Fix

It does not reconstruct a missing final answer if the watcher died before
writing it.

It does not prove whether a lost task succeeded or failed unless a terminal
event/result file already exists.

It does not remove the need for process-level care around PID reuse,
cross-platform behavior, and process groups.

## Risks and Design Notes

- PID reuse can produce false confidence. For a local developer tool, checking
  PID existence may be enough at first, but stronger checks should include
  process start time where practical.
- Heartbeat intervals must be conservative enough to avoid false stale states
  during heavy disk or CPU pressure.
- Windows process-group behavior differs from POSIX and should be handled
  explicitly.
- A read-time display-only state may not be enough for `read --wait` and
  `interrupt`; those commands need actionable observed state, not just text.
- If we write back reconciliation results, the event log should record that the
  task was reconciled rather than naturally completed.

## Recommendation

Do not add a daemon yet.

First add a small supervision freshness model:

1. watcher heartbeat metadata;
2. child/supervisor PID metadata;
3. a reconciliation helper in core;
4. observed states for `stale`, `orphaned`, and `lost`;
5. CLI/agent output that uses those observed states;
6. tests for stale heartbeat, dead watcher/live child, and dead watcher/dead
   child.

This follows the same reliability pattern as Kubernetes and Nomad while staying
small enough for Orchestrator's current architecture.

## Sources

Local:

- `packages/core/src/tasks/types.ts`
- `packages/core/src/tasks/supervisor.ts`
- `packages/core/src/tasks/operations.ts`
- `adr/decisions/0044-model-interrupt-as-stop-request-metadata-20260623-075635.md`
- `adr/specs/interrupt-stopping-state-20260623-075028.md`
- `doc/internal/supervision-model.svg`

External:

- Kubernetes Nodes: https://kubernetes.io/docs/concepts/architecture/nodes/
- Kubernetes Leases: https://kubernetes.io/docs/concepts/architecture/leases/
- Kubernetes Pod Lifecycle: https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
- Kubernetes Finalizers: https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/
- Nomad Server Config, Client Heartbeats: https://developer.hashicorp.com/nomad/docs/configuration/server
- Nomad Disconnect Block: https://developer.hashicorp.com/nomad/docs/job-specification/disconnect
