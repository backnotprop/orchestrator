# Research Spike: Codex App-Server No-Wait Operation Monitoring

Date: 2026-07-05

## Question

What should happen when Orchestrator sends work or starts a goal in a
`codex-app-server --session` task without `--wait`?

The user-facing need is simple: start a long operation, return immediately, keep
showing it in `ps`/`events`, and settle the existing session task when Codex
finishes.

## Current Orchestrator Behavior

Relevant files:

- `packages/core/src/tasks/shared-codex-app-server-session.ts`
- `packages/core/src/tasks/executors/protocol/codex-app-server-controller.ts`
- `packages/core/src/tasks/supervisor.ts`
- `packages/cli/src/commands/send.ts`
- `packages/cli/src/commands/goal.ts`
- `packages/agent/src/tools.ts`

Current no-wait behavior:

1. `send` or `goal start` connects to the Codex app-server socket.
2. It records `currentOperation` on the existing session task.
3. It subscribes to live notifications while the request is being made.
4. If `wait: false`, it returns once Codex accepts the operation.
5. It unsubscribes and closes the connection.

That leaves a gap. Codex may continue working, but Orchestrator no longer has a
live observer attached to the operation. The task may remain in
`turn_running`/`goal_running` until another command happens to inspect or update
it.

This is not a problem for `--wait`: the current code keeps the connection open
until the operation completes.

## Codex App-Server Findings

Relevant Codex files:

- `~/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
- `~/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/turn.rs`
- `~/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs`
- `~/oss-agents/codex/codex-rs/app-server/src/request_processors/thread_processor.rs`
- `~/oss-agents/codex/codex-rs/app-server/src/request_processors/turn_processor.rs`
- `~/oss-agents/codex/codex-rs/app-server/src/request_processors/thread_goal_processor.rs`
- `~/oss-agents/codex/codex-rs/app-server/src/thread_state.rs`
- `~/oss-agents/codex/codex-rs/app-server/tests/suite/v2/thread_resume.rs`

Codex gives us enough protocol surface to do this cleanly.

### Running Thread Rejoin

Codex `thread/resume` can rejoin an already running thread. The server code has
a specific running-thread path, and the thread state comment says the running
resume path sends history and atomically subscribes for new updates.

The app-server tests confirm this behavior:

- a second client can resume a running thread
- the resume response can include the running turn in the initial turns page
- the second client can keep receiving `turn/completed`
- override mismatches are ignored for an already running thread rather than
  breaking rejoin

This is the right primitive for no-wait operation monitoring.

### Durable Thread Read

Codex `thread/read` returns a thread view from persisted metadata plus optional
live state. With `includeTurns`, it can include turn history. Thread status can
be:

- `notLoaded`
- `idle`
- `systemError`
- `active`

Turn status can be:

- `completed`
- `interrupted`
- `failed`
- `inProgress`

This gives Orchestrator a recovery path if a monitor misses notifications or
starts after an operation is already in progress.

### Goal State

Codex exposes native goal state through:

- `thread/goal/set`
- `thread/goal/get`
- `thread/goal/clear`
- `thread/goal/updated`
- `thread/goal/cleared`

Goal status can be:

- `active`
- `paused`
- `blocked`
- `usageLimited`
- `budgetLimited`
- `complete`

For Orchestrator, every goal status other than `active` is terminal for the
operation currently being tracked.

### Token Usage

Codex emits `thread/tokenUsage/updated` with total and last-token breakdowns.
Orchestrator already normalizes this into task usage while connected.

No-wait monitoring should preserve that behavior by staying attached or
rejoining the thread.

## Product Implication

No-wait `send` and `goal start` should not be "fire and forget" internally.
They should mean:

1. Start the operation.
2. Return control to the user or parent agent.
3. Keep a monitor attached to the existing session task.
4. Update events, usage, result, current operation, and last operation.
5. Return the session task to `idle` when Codex finishes.

The user should not need to remember to run `goal get` or `thread/read` just to
make Orchestrator notice completion.

## Implementation Shape

Use a monitor over the existing task. Do not create a second Orchestrator task.

The monitor should:

1. Re-read the session task.
2. Confirm `currentOperation.operationId` still matches.
3. Connect to the task's Codex app-server socket.
4. Use `thread/resume` to rejoin the provider thread and subscribe to updates.
5. Process the same normalized notifications as `--wait`.
6. Reconcile with `thread/read` and `thread/goal/get`.
7. Settle `currentOperation` into `lastOperation`.
8. Return the session to `idle`.

For CLI no-wait commands, the monitor must survive after the CLI exits. That
means a small internal detached monitor command, similar to the existing
`__run-task` pattern.

For parent-agent tools and future service/TUI hosts, the same core monitor
function should also be callable in-process.

## Risks

- Duplicate monitors could race. Use an operation id check and a small lock or
  claim file per operation.
- Notifications may arrive before the monitor subscribes. Reconcile with
  `thread/read` and `thread/goal/get`.
- The app-server backend may restart. The monitor should reconnect through the
  stored socket/backend path when possible and fail the operation clearly when it
  cannot.
- `turn/steer` can keep using the same turn id. The monitor must track the
  current operation id and turn id, not assume every message creates a new task.
- A no-wait operation should not make the whole session task terminal when it
  completes. The session should stay `running` and return to `idle`.

## Recommendation

Implement durable operation monitoring for no-wait `codex-app-server --session`
operations.

Use Codex's own running-thread rejoin path (`thread/resume`) as the primary
monitoring mechanism, with `thread/read` and `thread/goal/get` as reconciliation
checks.

Keep this narrow. Do not add pooling, public protocol-agent config, TUI work, or
a new task model in this slice.
