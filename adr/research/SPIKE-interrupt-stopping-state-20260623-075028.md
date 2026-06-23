# Interrupt Stopping State Spike

Date: 2026-06-23

Note: this spike explored adding `stopping` as a durable task status. ADR 0044
settled on stop-request metadata with `stopping` as a derived display state
instead.

## Question

Should Orchestrator add an intermediate task state for interruption, such as
`stopping`, instead of marking a task `cancelled` immediately when
`orchestrator interrupt` is called?

## Current Behavior

Task statuses currently are:

```ts
queued | starting | running | succeeded | failed | cancelled | timed_out;
```

`cancelled` is terminal. Anything that calls `isTerminalTaskStatus` treats a
cancelled task as finished.

The important path is in `packages/core/src/tasks/supervisor.ts`:

- `interruptTask` reads the task.
- It marks the running task as cancel requested in memory.
- It immediately writes task status `cancelled`.
- It appends `interrupt_requested`.
- It sends the process signal.
- Later, the child `close` handler finalizes output, appends `result`, updates
  the final record, and appends `cancelled`.

That means `cancelled` currently means two different things:

1. A stop request has been sent.
2. The task has fully exited and final files/events are written.

Those are not the same moment.

## Reproduced UX

With normal short-running tasks, immediate reads after interrupt usually show
`cancelled`. They do not usually show `running`.

With a process that delays shutdown after `SIGTERM`, the gap is visible:

- immediate `read --json --compact` shows:
  - `status: "cancelled"`
  - `active: false`
  - `outputKind: "none"`
- one or two seconds later, the same read shows:
  - `status: "cancelled"`
  - `outputKind: "result"`
  - final events are present

So the issue is not strictly the output value. The same early terminal status
can affect:

- final result availability
- final `cancelled` event availability
- last stdout/stderr capture
- `ps` last-message summaries
- token/final usage summaries when adapters finalize on close
- whether agents believe there is nothing left to wait for

## Affected Code

Core status model:

- `packages/core/src/tasks/types.ts`
  - `TASK_STATUSES`
  - `TaskStatus`
  - `isTerminalTaskStatus`
  - `TaskEvent["type"]`

Interrupt behavior:

- `packages/core/src/tasks/supervisor.ts`
  - `interruptTask`
  - `interruptTasks`
  - child `spawn` race checks
  - child `close` finalization

Read and wait behavior:

- `packages/core/src/tasks/wait.ts`
  - `waitForTask` stops waiting as soon as status is terminal
- `packages/cli/src/commands/task-inspection.ts`
  - `read --wait`
  - fallback stdout behavior for non-terminal tasks
- `packages/cli/src/task-output.ts`
  - compact read payloads use terminal status to decide whether to read final
    result or active stdout

Operations view:

- `packages/core/src/tasks/operations.ts`
  - active task filtering
  - group status
  - compact control view
- `packages/cli/src/render-ps.ts`
  - human status labels
  - summary counts

Parent-agent tools:

- `packages/agent/src/tools.ts`
  - `interrupt_agent`
  - task summaries returned to parent agents

Tests that would be affected:

- `test/cli-interrupt.test.ts`
- `test/tasks.test.ts`
- `test/agent-tools.test.ts`
- `test/cli-read.test.ts`
- `test/cli-ps.test.ts`
- `test/cli-contract.test.ts`

## Option A: Keep Current Statuses

Leave `cancelled` as the immediate status.

Benefits:

- No contract change.
- Existing tests and JSON consumers keep working.
- Simple mental model for most tasks.

Problems:

- `cancelled` can appear before the task is fully stopped.
- `read` can show terminal status with no final output yet.
- `ps` can hide the fact that shutdown is still happening.
- Agents may stop waiting too early because `cancelled` is terminal.

This is acceptable only if we decide the current gap is harmless enough.

## Option B: Add a Short Settling Wait After Interrupt

After `interruptTasks` returns, the CLI waits briefly for final output/events to
catch up before printing.

Benefits:

- Small patch.
- Improves common CLI UX.
- Does not change task status contracts.

Problems:

- It is a timing patch, not a real model.
- It helps CLI output but not all readers of the task store.
- Parent tools and other integrations can still observe the early `cancelled`.
- It may make broad interrupts feel slower.

This is pragmatic but not the clean design.

## Option C: Add `stopping`

Add a non-terminal `stopping` status.

Flow:

```text
running -> stopping -> cancelled
```

`interruptTask` would set `stopping`, append `interrupt_requested`, and signal
the process. The child close handler would finalize output and then write
`cancelled`.

Benefits:

- Honest status model.
- `read --wait` can wait until the task is actually terminal.
- `ps --watch` can show that shutdown is in progress.
- Agents can distinguish "stop was requested" from "fully stopped."
- Future TUI state is clearer.

Problems:

- Contract change: new `TaskStatus`.
- Tests need updates.
- JSON consumers must handle one more status.
- Status counts need careful naming: `stopping` should count as active, not
  stopped.
- A stale `stopping` task from a crashed supervisor needs recovery behavior.

This is the cleanest product model, but it should be implemented deliberately.

## Option D: Add `interrupt_requested` Metadata Without a New Status

Keep status `running`, but add fields such as:

```ts
interruptRequestedAt;
interruptReason;
interruptSignal;
```

Benefits:

- Existing status enum stays stable.
- Allows UI to show "stopping" based on metadata.

Problems:

- More complicated than a status for readers.
- Active/stopped filtering still needs custom logic.
- A task can be `running` while actually stopping, which is also imprecise.

This is less clean than adding `stopping`.

## Research Takeaway

The real issue is not just missing output. It is that the current model has no
place for "stop requested, still shutting down." A proper `stopping` state
resolves that directly. A bounded wait after interrupt can smooth the CLI, but
it does not fix the underlying state model.
