# Spec: Codex App-Server Goal Start Operation

Date: 2026-07-04

## Intent

Add the first native Codex goal operation to Orchestrator.

The product flow is:

```sh
orchestrator launch codex-app-server --session --name "performance worker"
orchestrator send <task-id> --wait "Inspect current performance bottlenecks."
orchestrator goal start <task-id> --wait "Improve performance across the app by 10%."
orchestrator send <task-id> --wait "Summarize what changed."
```

The parent-agent flow is:

```ts
launch_agent({ runtime: "codex-app-server", session: true, name: "performance worker" });
send_agent_message({ taskId, message: "Inspect current performance bottlenecks.", wait: true });
start_agent_goal({ taskId, goal: "Improve performance across the app by 10%.", wait: true });
send_agent_message({ taskId, message: "Summarize what changed.", wait: true });
```

Goals are provider-backed operations inside a running Codex app-server session.
They are not a generic Orchestrator planning system.

## Preflight Findings

The current code is ready for this slice:

- `AgentTaskRecord` already has `session`, `currentOperation`, and
  `lastOperation`.
- `TaskOperationKind` already supports `"goal"`.
- `TaskSessionState` already supports `"goal_running"`.
- `TaskOperationStatus` already has `paused`, `blocked`, `usage_limited`,
  `budget_limited`, and `complete`.
- `codex-app-server --session` can stay alive and return to `idle` after normal
  turns.
- `send` and `send_agent_message` already prove the live-handle and
  file-backed control paths.

The missing work is wiring a new goal operation through those same seams.

## Scope

Implement only:

- runtime metadata that says `codex-app-server` supports native session goals.
- task-level goal metadata.
- `goal start` for running persistent `codex-app-server` sessions.
- `start_agent_goal` for the parent agent.
- Codex app-server goal RPC handling.
- normalized goal events.
- fake app-server tests.

Do not implement `goal get`, `goal set`, or `goal clear` as the first user
surface. Those may come later as secondary inspection/control commands.

## Data Model

Add optional goal metadata to task records:

```ts
type TaskGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

type TaskGoal = {
  provider: "codex";
  threadId: string;
  objective: string;
  status: TaskGoalStatus;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  createdAt?: string;
  updatedAt?: string;
};
```

Normalize Codex's camel-case provider statuses at the boundary:

- `usageLimited` -> `usage_limited`
- `budgetLimited` -> `budget_limited`

Keep `TaskOperation` as the operation result shape. A goal operation should use:

- `kind: "goal"`
- `objective`
- `status: "running"` while active
- terminal status from the normalized goal state
- `result` as a short human-readable goal summary when available
- `usage` from provider token updates when available

## Control Path

Extend task control with one new request kind:

```ts
type TaskControlRequest =
  | { kind: "send_message"; ... }
  | {
      kind: "goal_start";
      input: {
        goal: string;
        clientMessageId?: string;
        timeoutMs?: number;
        wait?: boolean;
        tokenBudget?: number;
      };
    };
```

Extend the live executor handle with:

```ts
startGoal?(input: TaskStartGoalInput): Promise<TaskStartGoalResult>;
```

The supervisor should mirror the existing `send_message` behavior:

- use the live handle when this process owns the task.
- use the file-backed control directory for detached session tasks.
- return compact, typed errors for unsupported, not-running, busy, timeout, and
  invalid request cases.

## Executor Flow

`CodexAppServerTaskExecutor.startGoal` should:

1. trim and validate the goal text.
2. require session mode.
3. require a live app-server client.
4. require `threadId`.
5. require session state `idle`.
6. fail if an unsettled operation already exists.
7. optionally call `thread/goal/get`.
8. fail if an unfinished existing goal exists.
9. clear a completed prior goal only when needed.
10. create a `TaskOperation` with `kind: "goal"` and `status: "starting"`.
11. set `session.state = "goal_running"`.
12. call `thread/goal/set` with status `active`.
13. wait for Codex's runtime-generated `turn/started`.
14. attach that turn id to the goal operation.
15. update usage and output from normal Codex notifications.
16. finish the operation when Codex emits a terminal goal state.
17. return the session to `idle`.

If `wait` is false, return after the goal has been accepted and operation state
has been recorded. If `wait` is true, wait for terminal goal status or timeout.

## Goal Status Handling

Handle Codex notifications:

- `thread/goal/updated`
- `thread/goal/cleared`

On `thread/goal/updated`:

- update `task.goal`.
- emit normalized `goal.updated`.
- if it is the active goal operation, update the current operation.
- if the status is terminal, complete the goal operation.

Terminal goal statuses:

- `paused`
- `blocked`
- `usage_limited`
- `budget_limited`
- `complete`

On `thread/goal/cleared`:

- emit `goal.cleared`.
- clear `task.goal`.
- complete the current goal operation only if the provider has already settled
  the active goal or if Codex explicitly reports the operation as cleared.

Do not silently turn provider goal failures into ordinary prompt text.

## CLI

Add:

```sh
orchestrator goal start <task-id|prefix> [--wait] [--timeout-ms <ms>] [--token-budget <tokens>] [--json [--compact]] "<goal>"
```

Human output should be short:

```text
goal started  performance worker  improve performance across the app by 10%
```

With `--wait`, print the final goal operation result:

```text
goal complete  performance worker  84k tok
```

Compact JSON should include:

- task id.
- runtime.
- session state.
- goal state.
- operation.
- provider thread id.
- follow-up commands.

## Parent-Agent Tool

Add `start_agent_goal`:

```ts
{
  taskId: string;
  goal: string;
  wait?: boolean;
  timeoutMs?: number;
  tokenBudget?: number;
}
```

Tool guidance:

- use only for provider-backed goals on supported running sessions.
- do not simulate native provider goals by sending ordinary prompt text.
- use `send_agent_message` for normal work before or after the goal.
- use `interrupt_agent` to stop the session.

## Tests

Add fake app-server support for:

- `thread/goal/get`
- `thread/goal/set`
- `thread/goal/clear`
- `thread/goal/updated`
- `thread/goal/cleared`

Add tests for:

- `goal start --wait` happy path.
- goal start without `--wait` records running operation.
- terminal `complete` returns session to `idle`.
- terminal `blocked`, `paused`, `usage_limited`, and `budget_limited` settle the
  operation.
- unfinished existing goal is rejected.
- non-session task is rejected.
- unsupported runtime is rejected.
- busy session is rejected.
- detached control request works.
- `start_agent_goal({ wait: true })` mirrors CLI behavior.
- normalized events appear through `events --agent-only`.

Live smoke can be opt-in later:

```sh
RUN_CODEX_APP_SERVER_GOAL_SMOKE=1 pnpm test
```

## Non-Goals

- no generic goal abstraction for all runtimes.
- no goal support for `codex exec`.
- no public protocol custom-agent goal config.
- no app-server pooling.
- no multi-thread session manager.
- no TUI work.
- no Slack/service deployment.
- no `goal get`, `goal set`, `goal clear` command group in this first slice.

## References

- `adr/decisions/0054-use-persistent-codex-app-server-sessions-for-goal-work-20260701-104716.md`
- `adr/decisions/0055-hide-provider-turn-mechanics-behind-session-operations-20260704-094016.md`
- `adr/specs/codex-app-server-persistent-session-operations-20260701-092650.md`
- `adr/specs/parent-agent-session-control-language-20260703-203248.md`
- `adr/research/SPIKE-codex-goals-support-20260701-072738.md`
- `adr/research/synthesis-codex-app-server-persistent-session-operations-20260701-092650.md`
