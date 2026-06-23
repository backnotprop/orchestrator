# Interrupt Stop Request Metadata

Date: 2026-06-23

## Status

Draft spec, aligned with ADR 0044.

## Intent

Separate "stop requested" from "fully stopped." Orchestrator should show
`stopping` while a task is shutting down, but should only mark the durable task
status `cancelled` after the process exits and final output/events are written.

## Core Model

Keep `TaskStatus` unchanged:

```text
queued | starting | running | succeeded | failed | cancelled | timed_out
```

Add stop-request metadata to `AgentTaskRecord`:

```ts
stopRequestedAt?: string
stopReason?: string
stopSignal?: NodeJS.Signals
```

Add a shared helper:

```ts
taskDisplayState(task) => TaskStatus | "stopping"
```

Rules:

- if the task is non-terminal and has `stopRequestedAt`, display `stopping`
- otherwise display the durable `status`
- `cancelled` remains terminal and means the task is fully stopped

## Interrupt Behavior

`interruptTask` should:

- record `stopRequestedAt`, `stopReason`, and `stopSignal`
- keep the current non-terminal status, usually `running`
- append `interrupt_requested`
- send the stop signal
- return the active task record with derived state `stopping`

The child close handler should:

- finalize output
- write the result file
- append the result event
- set final status to `cancelled`
- set `finishedAt`, `exitCode`, final usage/output metadata, and error/reason
- append final `cancelled`

## CLI Behavior

Human output:

- `interrupt <id>` should show `stopping` after a stop request is accepted
- `ps` and `ps --watch` should show rows as `stopping`
- `list` should show `stopping` for human output
- final completed cancellation should show as stopped/cancelled depending on
  the existing command style

JSON behavior:

- durable `status` stays unchanged, usually `running` while stopping
- compact/control JSON adds `state: "stopping"` when it differs from `status`
- stop metadata is included where task summaries are returned
- `active` remains `true` until the task reaches a terminal status

## Read/Wait Behavior

Because the durable status remains non-terminal while stopping:

- `read <id>` can still fall back to active stdout if no final result exists
- `read <id> --wait` keeps waiting through shutdown
- final `read` after completion returns `status: "cancelled"`

## Parent-Agent Tool Behavior

Tool task summaries should include:

- durable `status`
- derived `state` when it differs from `status`
- stop-request metadata when present

Parent instructions should say that `state: "stopping"` is not final. If final
confirmation matters, the parent should call `read_agent` with `wait: true`.

## Stale Shutdowns

If a process ignores the stop signal, the task remains active and displays
`stopping`.

First release behavior:

- allow another interrupt with a stronger signal, such as `SIGKILL`
- do not auto-mark `cancelled` without proof the process has exited

Future behavior can add explicit stale-task reconciliation if needed.

## Tests

Cover:

- `interruptTask` returns an active task with `state: "stopping"`
- stop metadata is persisted
- delayed shutdown remains non-terminal until process exit
- `waitForTask` does not complete while only stop-requested
- final completion becomes `cancelled`
- CLI interrupt JSON exposes `state: "stopping"` and stop metadata
- parent-agent `interrupt_agent` returns `state: "stopping"`
- `ps` and compact control views show stopping tasks as active
