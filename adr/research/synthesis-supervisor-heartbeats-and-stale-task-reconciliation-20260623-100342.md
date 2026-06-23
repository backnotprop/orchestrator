# Synthesis: Supervisor Heartbeats and Stale Task Reconciliation

Date: 2026-06-23

## Summary

Orchestrator should add heartbeat-based stale task detection, but should not add
a daemon yet. The current architecture already has the right split: durable task
status says what has actually happened, while display state says what users and
agents should see right now.

We should extend that split.

## What We Know

Today, durable task status is:

```text
queued | starting | running | succeeded | failed | cancelled | timed_out
```

The newer display layer adds:

```text
stopping
```

That works well because `cancelled` now means "fully stopped," not merely "stop
requested."

The next problem is stale supervision. If Orchestrator's watcher process dies,
the task file can keep saying `running` or `stopping` after that is no longer a
trustworthy statement.

## Relevant Pattern

This matches Kubernetes and Nomad more than it matches worker pools.

Those systems do not assume the last saved status is forever true. They use
heartbeats, leases, and reconciliation to decide whether something is still
being observed.

For Orchestrator, the equivalent is:

```text
watcher writes heartbeat
reader checks freshness
reader verifies process identity when freshness is stale
reader shows an honest observed state
```

## Recommended Model

Keep durable outcome separate from observed supervision state.

Do not add `stale`, `orphaned`, or `lost` as durable `TaskStatus` values first.
Add them as observed states derived from heartbeat and process checks.

Do not rely on raw PID existence alone. PID reuse can make Orchestrator classify
or signal the wrong process. Any orphan/lost classification that depends on a
process still existing must verify process identity, such as PID plus OS process
start time. If identity cannot be verified, show `stale`.

Do not write heartbeat ticks into `task.json`. Heartbeats should use a separate
`heartbeat.json` file so they cannot race with final task status writes.

Observed state meanings:

- `running`: watcher is fresh and the task is active.
- `stopping`: stop was requested, watcher is fresh, task is still active.
- `stale`: watcher heartbeat is old and Orchestrator cannot trust the last
  saved status yet.
- `orphaned`: watcher is gone, but the child process still appears alive.
- `lost`: watcher is gone, child process appears gone, and no terminal status
  was written.

This is honest and useful. It does not pretend to know whether a lost task
succeeded or failed.

## Product Impact

This fixes the bad experience where a task appears to be running or stopping
forever.

Before:

```text
api review    stopping    42m
```

After:

```text
api review    lost        watcher gone, agent gone, final outcome unknown
```

or:

```text
api review    orphaned    watcher gone, agent still alive
```

That helps humans and agents decide whether to wait, interrupt, read logs, or
start replacement work.

## Implementation Direction

Build this as a small core capability:

1. Add supervision metadata.
2. Have the watcher write a separate heartbeat file.
3. Add a core observation/reconciliation helper.
4. Make `active`, stop targets, compact JSON, `ps`, `list`, `read`, and
   `interrupt` use the helper.
5. Keep status honest; expose observed state separately.

This must not be a human-rendering-only change. Agents and scripts need the same
observed state and `active` behavior as humans.

Do not start with a daemon. A daemon may be useful later, but heartbeat plus
reconciliation is the smaller proof we need first.

## References

- `adr/research/SPIKE-supervisor-heartbeats-and-stale-task-reconciliation-20260623-095805.md`
- `adr/decisions/0044-model-interrupt-as-stop-request-metadata-20260623-075635.md`
- `adr/specs/interrupt-stopping-state-20260623-075028.md`
- `doc/internal/supervision-model.svg`
