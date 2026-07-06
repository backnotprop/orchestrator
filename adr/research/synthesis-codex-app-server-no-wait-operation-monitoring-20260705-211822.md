# Synthesis: Codex App-Server No-Wait Operation Monitoring

Date: 2026-07-05

## Conclusion

No-wait `send` and `goal start` need a real monitor.

Today Orchestrator starts the operation, records it as running, returns, and
closes the protocol connection. That is fine for quick acknowledgement, but it
is not enough for long-running Codex session work. The session task can stay
stuck in a running operation even after Codex finishes.

The fix should not be a new task. The existing session task is the job. The
operation monitor should update that task until the provider operation reaches a
terminal state.

## Correct Model

The task model should remain:

```text
Orchestrator task
  -> Codex app-server session
     -> one provider thread
        -> current operation, either turn or goal
```

`send` starts or steers a turn operation.

`goal start` starts a goal operation.

Both can be waited on directly with `--wait`, or monitored in the background
when the user or parent agent does not wait.

## Why This Is Safe

Codex has the protocol behavior we need:

- `thread/resume` can rejoin a running thread and subscribe to new updates
- `thread/read` can reconstruct thread state from persisted and live data
- `thread/goal/get` can read current goal state
- `turn/completed` and `thread/goal/updated` provide terminal signals
- token usage is emitted as normal thread notifications

So Orchestrator does not need a custom mailbox or prompt trick. It should use
the provider protocol directly.

## Preferred Implementation

Add a core operation monitor for shared Codex app-server sessions.

The monitor should be reusable from:

- CLI internal detached monitor process
- parent-agent tools running in-process
- future service/TUI host process

For CLI no-wait use, add an internal command like:

```text
orchestrator __monitor-session-operation <request-path>
```

That command reads a small monitor request, calls the core monitor, and exits
when the operation settles or fails.

## What Changes

When `orchestrator send <task> "..."` returns `running`, Orchestrator should
also start a monitor.

When `orchestrator goal start <task> "..."` returns `running`, Orchestrator
should also start a monitor.

The user-visible task should then update naturally:

```sh
orchestrator ps --watch
orchestrator events <task-id> --agent-only
orchestrator read <task-id>
```

The session remains a running session task. Only the operation moves from
`currentOperation` to `lastOperation`.

## What Not To Do

- Do not create a second task for the monitor.
- Do not require users to poll manually for correctness.
- Do not rely only on a timer.
- Do not solve generic protocol custom agents here.
- Do not add a TUI feature in this slice.
- Do not make session task completion mean operation completion.

## Open Implementation Details

The main implementation choice is the monitor claim mechanism.

Recommendation:

- claim per task id plus operation id
- store the claim under the task directory
- verify `currentOperation.operationId` before writing any terminal state
- make duplicate monitor starts harmless

The monitor should prefer live rejoin through `thread/resume`, but should always
perform a reconciliation read before deciding that an operation is still active.

## Decision Readiness

This is ready to spec.

The design is small, uses Codex's intended thread/session protocol, and fixes a
real operator problem without changing the public task model.
