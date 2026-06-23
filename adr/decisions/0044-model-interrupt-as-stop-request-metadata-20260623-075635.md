# 0044. Model Interrupt As Stop Request Metadata

Date: 2026-06-23

## Status

Accepted

## Context

`orchestrator interrupt` currently marks a task `cancelled` immediately after a
stop request is accepted. The child process may still be shutting down, and the
final output, final event, last logs, and final usage data may not be written
yet.

That makes `cancelled` mean two different things:

- stop was requested
- the task is fully stopped

Those are different moments. A user or agent should not be told a task is fully
stopped before it actually is.

Research compared two possible designs:

- add `stopping` as a real task status
- keep the durable status conservative and derive `stopping` from stop-request
  metadata

Kubernetes uses the second shape for pods: a terminating pod is still an object
with deletion metadata, and `kubectl` renders the human-friendly state.

## Decision

Do not add `stopping` as a durable `TaskStatus` right now.

Keep the task non-terminal until it is actually final. Add explicit stop-request
metadata to the task record instead, such as:

```ts
stopRequestedAt?: string
stopReason?: string
stopSignal?: string
```

When a running task is interrupted:

- record the stop-request metadata
- keep the task active/non-terminal
- send the stop signal
- render the task as `stopping` in human and compact control views

When the process exits and finalization finishes:

- write final output/events as usual
- set final status to `cancelled`
- set `finishedAt`, `exitCode`, and final usage/output metadata

So the product model is:

```text
running + stop requested -> shown as stopping
cancelled -> actually stopped
```

`read --wait` should keep waiting while a task is only stop-requested. `ps`,
compact JSON, and future TUI views should show `stopping` as the display state,
but terminal status remains `cancelled`.

## Consequences

`cancelled` becomes more honest: it means the task is fully stopped.

Users and agents get a clearer shutdown view without expanding the core
`TaskStatus` enum.

The CLI, compact JSON, parent-agent tools, and future TUI need a shared helper
for deriving display state from task status plus stop-request metadata.

`interrupt` can stay fast. It should return once the stop request is accepted,
not after the process fully exits. A later `interrupt --wait` can be added if we
want an explicit "return only after fully stopped" mode.

Stale shutdowns become visible. If a process ignores `SIGTERM`, the task remains
active and shown as `stopping` until it exits, is interrupted again with a
stronger signal, or a future reconciliation flow proves it is gone.

This supersedes the earlier draft preference for making `stopping` a durable
status.
