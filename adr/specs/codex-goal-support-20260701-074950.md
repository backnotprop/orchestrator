# Spec: Codex Goal Support

Status: Superseded for first implementation by
`adr/specs/codex-app-server-goal-start-operation-20260704-122339.md`.
This file describes useful low-level goal state controls, but the primary
product UX is now persistent Codex app-server sessions with normal turn
operations and `goal start`.

## Intent

Add Codex app-server goal support in the smallest useful form: Orchestrator can
read, set, clear, persist, and display goal state for `codex-app-server` tasks.

Goals are provider-backed task control. They are not a new Orchestrator planning
system.

## Scope

Implement support for:

- `codex-app-server` goal capability metadata.
- task-level goal state.
- normalized goal events.
- core task goal operations.
- CLI `goal get`, `goal set`, and `goal clear`.
- parent-agent goal tools.
- tests with the fake Codex app-server.
- opt-in live smoke for real Codex app-server.

## Runtime Capability

Add a runtime capability flag for goals, for example:

```ts
capabilities: {
  goals: {
    supported: true,
  },
}
```

Only `codex-app-server` should set this initially.

## Task Data Model

Add optional goal metadata to `AgentTaskRecord`:

```ts
type TaskGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
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

The exact field names should match the existing task-record style. Preserve raw
provider details only if they are useful for debugging.

## Protocol Executor

Update `CodexAppServerTaskExecutor` to handle:

- `thread/goal/updated`
- `thread/goal/cleared`

On `thread/goal/updated`:

- normalize the event as `goal.updated`.
- update `task.goal`.
- include thread id, objective, status, budget, usage, and timestamps when
  present.

On `thread/goal/cleared`:

- normalize the event as `goal.cleared`.
- clear `task.goal` for that thread.

## Core Goal Control

Extend the task control path that already supports `send_message`.

Add goal request kinds:

```ts
type TaskControlRequest =
  | { kind: "send_message"; ... }
  | { kind: "goal_get" }
  | { kind: "goal_set"; objective: string; status?: TaskGoalStatus; tokenBudget?: number | null }
  | { kind: "goal_clear" };
```

For running tasks:

- call the live executor through the in-process handle when available.
- otherwise use the existing file-backed control mailbox for detached tasks.
- map goal requests to Codex RPCs:
  - `thread/goal/get`
  - `thread/goal/set`
  - `thread/goal/clear`

For inactive tasks:

- `goal get` may return the last stored `task.goal`.
- `goal set` and `goal clear` should fail clearly until goal-driven resume/start
  is implemented.

This avoids the misleading case where Orchestrator writes goal state to a
persisted thread but no running agent exists to act on it.

## CLI

Add a `goal` command group:

```sh
orchestrator goal get <task-id>
orchestrator goal set <task-id> "Review the API until complete."
orchestrator goal clear <task-id>
```

Options:

- `--json`
- `--compact`
- `--status <status>` for `set`
- `--token-budget <tokens>` for `set`

Human output should be short:

```text
goal active  Review the API until complete.
```

JSON output should include:

- task id.
- runtime.
- provider thread id.
- goal state.
- whether the value came from the live runtime or stored task metadata.
- follow-up commands where useful.

## Parent-Agent Tools

Add tools:

- `read_agent_goal`
- `set_agent_goal`
- `clear_agent_goal`

Tool behavior should mirror the CLI:

- fail clearly when the runtime does not support goals.
- fail clearly when a task is not running and the operation requires a live
  runtime.
- return compact task and goal metadata.

## Help And Docs

Update:

- `packages/cli/src/commands/help.ts`
- `doc/codex-app-server.md`
- skill/plugin instructions if they mention Codex app-server capabilities.

Explain plainly:

- `codex` does not support goals through Orchestrator.
- `codex-app-server` supports provider-backed goals.
- goals require a Codex app-server task with stored provider thread metadata.
- setting a goal on a finished task does not make it resume by itself.

## Tests

Add deterministic fake-server tests for:

- goal notifications update task metadata.
- `goal get` returns stored/live goal state.
- `goal set` calls `thread/goal/set` and records `goal.updated`.
- `goal clear` calls `thread/goal/clear` and records `goal.cleared`.
- unsupported runtimes fail clearly.
- inactive task `goal set` and `goal clear` fail clearly.
- parent tools mirror CLI behavior.

Add opt-in live smoke:

```sh
RUN_CODEX_APP_SERVER_GOAL_SMOKE=1 pnpm test
```

The live smoke should be small and tolerant of provider feature availability. It
should verify the happy path when supported and skip clearly when unavailable.

## Later: Goal-Driven Work

Do not implement goal-driven launch in this slice.

A later slice can add something like:

```sh
orchestrator goal start <task-id> "Finish the migration plan."
```

That would require a deliberate execution mode that resumes a persisted Codex
thread, sets an active goal, waits for Codex to work against it, and maps Codex
goal states into task state. That is larger than basic goal control.

## References

- `adr/research/SPIKE-codex-goal-support-plan-20260701-074950.md`
- `adr/research/synthesis-codex-goal-support-plan-20260701-074950.md`
- `adr/research/SPIKE-codex-goals-support-20260701-072738.md`
- `adr/decisions/0050-use-simple-task-shaped-resume-before-pooling-20260630-051045.md`
- `adr/decisions/0052-enable-task-shaped-resume-for-codex-app-server-20260630-163334.md`
- `adr/decisions/0053-send-messages-to-running-codex-app-server-tasks-20260630-234839.md`
