# Spec: Codex App-Server Persistent Sessions And Goal Operations

## Intent

Make `codex-app-server` able to run as a persistent managed Codex session. The
same session should accept normal work, run a Codex goal, wait for that goal,
return to idle, and accept more work.

## User-Facing Shape

Direct CLI:

```sh
orchestrator launch codex-app-server --session --name "performance worker"
orchestrator send <task-id> --wait "Inspect current performance bottlenecks."
orchestrator goal start <task-id> --wait "Improve performance across the app by 10%."
orchestrator send <task-id> --wait "Summarize what changed."
orchestrator interrupt <task-id>
```

Parent-agent tools:

```ts
launch_agent({ runtime: "codex-app-server", session: true, name: "performance worker" });
send_agent_message({ taskId, message: "Inspect current performance bottlenecks.", wait: true });
start_agent_goal({ taskId, goal: "Improve performance across the app by 10%.", wait: true });
send_agent_message({ taskId, message: "Summarize what changed.", wait: true });
```

## Product Rules

- A persistent session is a running Orchestrator task.
- The session owns one Codex provider thread.
- The task remains `running` while the session is alive.
- Work inside the session is tracked as operations.
- A session can be idle between operations.
- A goal operation requires an idle persisted Codex thread.
- `interrupt <task-id>` stops the whole session.

## Runtime Capability

Add runtime capability metadata for persistent sessions:

```ts
capabilities: {
  supportsPersistentSession: true,
  supportsSessionTurns: true,
  supportsSessionGoals: true,
}
```

Only `codex-app-server` should opt in initially.

## Launch Plan

Add a launch/session mode to protocol launch plans.

Example shape:

```ts
type ProtocolExecutionMode = "turn" | "session";
```

Current behavior stays as `"turn"`:

- launch task.
- start one turn.
- complete the Orchestrator task.

New `"session"` behavior:

- launch app-server.
- initialize.
- start or resume a persisted thread.
- record provider `threadId`.
- set task status to `running`.
- set session state to `idle`.
- keep the app-server process alive until interrupted.

The launch parser must allow a session launch without an immediate task prompt.
An initial prompt may still be supported later, but the core session use case is
"start this Codex worker and wait for instructions."

## Task Record Additions

Add optional session metadata:

```ts
type TaskSessionState = "starting" | "idle" | "turn_running" | "goal_running" | "stopping";

type TaskSession = {
  kind: "codex-app-server";
  state: TaskSessionState;
  threadId?: string;
  currentOperationId?: string;
  updatedAt: string;
};
```

Add optional current/last operation metadata:

```ts
type TaskOperationKind = "turn" | "goal";
type TaskOperationStatus =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

type TaskOperation = {
  operationId: string;
  kind: TaskOperationKind;
  status: TaskOperationStatus;
  turnId?: string;
  objective?: string;
  input?: string;
  result?: string;
  usage?: TaskUsage;
  startedAt: string;
  finishedAt?: string;
};
```

Keep this small. Store current and last operation on the task record. Full
operation history can be reconstructed from events unless we later need a
separate operation store.

## Executor Behavior

Refactor `CodexAppServerTaskExecutor` into two execution paths:

1. Turn mode
   - preserve current behavior.
   - used by existing launches.

2. Session mode
   - start app-server.
   - open or resume thread.
   - write heartbeat.
   - subscribe to notifications.
   - wait for control requests.
   - stay alive while idle.
   - mark terminal only when interrupted, app-server exits, or startup fails.

The executor needs internal state for:

- client.
- thread id.
- current turn id.
- session state.
- current operation.
- latest goal state.
- pending operation waiters.

## Control Requests

Extend file-backed task control beyond `send_message`.

Add request kinds:

```ts
type TaskControlRequest =
  | { kind: "send_message"; input: { text: string; wait?: boolean; timeoutMs?: number } }
  | { kind: "goal_start"; input: { objective: string; wait?: boolean; timeoutMs?: number } }
  | { kind: "goal_wait"; input: { operationId?: string; timeoutMs?: number } }
  | { kind: "goal_get" };
```

For same-process tasks, the supervisor calls the live handle directly. For
detached tasks, the CLI writes control requests into the task control directory.

## Send Semantics

For session tasks, `send` should do the useful thing:

- if the session is idle, start a new `turn/start`.
- if a normal turn is active, steer with `turn/steer`.
- if a goal turn is active, either steer safely or fail with a clear message.
- if `--wait` is passed, wait for that operation's result.

For non-session tasks, keep the existing meaning: send a follow-up message to an
active running task when supported.

## Goal Start Semantics

`goal start` should require:

- runtime is `codex-app-server`.
- task is a persistent session.
- session is idle.
- provider thread id exists.
- thread is persisted.

Flow:

1. optionally read current goal.
2. fail if an unfinished goal exists unless a future `--replace` option is
   provided.
3. clear completed or replaceable prior goal when needed.
4. register a new operation id.
5. call `thread/goal/set` with status `active`.
6. wait for Codex to emit the runtime-generated `turn/started`.
7. track all related turn, usage, message, and goal notifications under the
   current operation.
8. if `--wait` is passed, wait until the goal operation finishes.

Goal operation terminal statuses should mirror Codex:

- paused
- blocked
- usage_limited
- budget_limited
- complete

The operation should also finish if the goal is cleared after the active turn
settles.

If Codex rejects the goal because the thread is ephemeral or goals are disabled,
surface that directly. Do not silently fall back to ordinary prompt text.

## Events

Normalize session and operation events:

- `session.started`
- `session.idle`
- `operation.started`
- `operation.completed`
- `operation.failed`
- `goal.updated`
- `goal.cleared`

Keep existing protocol transcript logs for debugging.

`events <task-id> --agent-only` should show the useful normalized stream.

## CLI Output

`ps` should show both task and session state:

```text
codex-app-server  performance worker  running  idle          42k tok
codex-app-server  performance worker  running  goal active   58k tok
codex-app-server  performance worker  running  turn running  61k tok
```

Compact JSON should include:

- task id.
- runtime.
- task status.
- session state.
- current operation.
- latest operation.
- provider thread id.
- suggested next commands.

`read <task-id>` for a live session should return the latest completed operation
result, not imply that the session has finished. If there is no completed
operation yet, it should say that plainly.

## Parent-Agent Tools

Update tools around the session model:

- `launch_agent` accepts `session: true` for supported runtimes.
- `send_agent_message` accepts `wait: true` and can start a session turn when
  the task is idle.
- add `start_agent_goal`.
- add `wait_agent_goal` or make `start_agent_goal({ wait: true })` sufficient
  for the first version.
- keep `read_agent`, `read_agent_events`, and `interrupt_agent` working.

## Tests

Add fake app-server coverage for:

- session launch opens a persisted thread and remains idle.
- `send --wait` starts a turn from idle and returns result.
- `send` during active turn uses `turn/steer`.
- `goal start --wait` sets active goal and waits until terminal goal status.
- terminal goal statuses finish the operation.
- provider rejection for ephemeral threads or disabled goals is clear.
- `ps` shows idle, turn running, and goal running states.
- compact JSON exposes session and operation metadata.
- interrupt stops the whole session.
- unsupported runtimes fail clearly.

Add opt-in live smoke only after fake-server coverage is solid:

```sh
RUN_CODEX_APP_SERVER_SESSION_SMOKE=1 pnpm test
```

## Rollout Slices

1. Add task session and operation types, with no user-visible behavior change.
2. Add `--session` launch mode for `codex-app-server` and keep it idle.
3. Make `send --wait` work against idle sessions.
4. Add `goal start` and `goal wait`.
5. Update `ps`, events, compact JSON, help, docs, and parent tools.
6. Add live smoke and document provider limits.

## Non-Goals

- no app-server pooling.
- no one app-server process shared across many Orchestrator tasks.
- no generic goal abstraction for every runtime.
- no goal support for `codex exec`.
- no Slack/service deployment.
- no TUI work in this slice.

## Supersedes

This spec refines the first goal-support plan. The lower-level goal state
operations remain useful, but they are not the main implementation path.

- `adr/specs/codex-goal-support-20260701-074950.md`

## References

- `adr/research/SPIKE-codex-app-server-persistent-session-operations-20260701-092650.md`
- `adr/research/synthesis-codex-app-server-persistent-session-operations-20260701-092650.md`
- `adr/research/SPIKE-codex-goals-support-20260701-072738.md`
- `adr/specs/codex-goal-support-20260701-074950.md`
- `adr/decisions/0052-enable-task-shaped-resume-for-codex-app-server-20260630-163334.md`
- `adr/decisions/0053-send-messages-to-running-codex-app-server-tasks-20260630-234839.md`
