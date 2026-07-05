# Research Spike: Codex App-Server Goal Get, Set, And Clear

Date: 2026-07-04

## Question

What would it take to expose public `goal get`, `goal set`, and `goal clear`
commands for Codex app-server sessions?

## Current Orchestrator State

Orchestrator already has `goal start`.

The CLI path is:

```text
packages/cli/src/cli.ts
  -> parseGoalOptions
  -> commandGoalStart
  -> startTaskGoal
```

The core path is:

```text
startTaskGoal
  -> validate task is running codex-app-server --session
  -> live handle startGoal, or detached control request kind goal_start
  -> codex-app-server executor startSessionGoal
```

The task model already has:

- `TaskGoal`
- `TaskGoalStatus`
- `task.goal`
- `TaskOperationKind = "turn" | "goal"`
- `TaskSessionState = "goal_running"`
- normalized `goal.updated` and `goal.cleared` events

The control channel already supports detached writes for live background
sessions. It currently accepts:

- `send_message`
- `goal_start`

The Codex app-server executor already observes provider notifications:

- `thread/goal/updated` updates `task.goal`
- `thread/goal/cleared` clears `task.goal`

## Codex App-Server Goal API

Codex app-server exposes native JSON-RPC goal methods:

```text
thread/goal/get
thread/goal/set
thread/goal/clear
```

The generated TypeScript schema says:

```ts
type ThreadGoalGetParams = { threadId: string };
type ThreadGoalGetResponse = { goal: ThreadGoal | null };

type ThreadGoalSetParams = {
  threadId: string;
  objective?: string | null;
  status?: ThreadGoalStatus | null;
  tokenBudget?: number | null;
};
type ThreadGoalSetResponse = { goal: ThreadGoal };

type ThreadGoalClearParams = { threadId: string };
type ThreadGoalClearResponse = { cleared: boolean };
```

`ThreadGoal` contains:

```ts
{
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}
```

Codex stores goal timestamps as Unix seconds. Orchestrator currently treats
numeric goal timestamps as JavaScript milliseconds. That produces wrong 1970
dates for live Codex goals and should be fixed before widening goal output.

## Codex Behavior

Codex goal methods require:

- goals feature enabled;
- materialized, persisted thread;
- non-ephemeral thread state.

`thread/goal/set` can update objective, status, and token budget. It also calls
Codex runtime effects after the update. Setting a goal to `active` can therefore
start or continue provider-side goal work.

That is important for Orchestrator. `goal start` creates an Orchestrator
operation before setting the provider goal active, so Orchestrator can track the
provider turn and final result. A raw `goal set --status active` could create
provider work without a matching Orchestrator operation unless we guard it.

## Implementation Hooks Already Present

The existing code gives us most of the foundation:

- `TaskExecutionHandle` already has `startGoal`.
- `TaskControlRequest` can be extended with more goal request kinds.
- `processPendingControlRequests` already routes detached control requests to
  the live executor.
- `codex-app-server` already has the JSON-RPC client available while a session
  is running.
- task events and `task.goal` already reflect goal update/clear notifications.
- fake app-server tests already implement `thread/goal/get`, `set`, and
  `clear`.

## Main Design Risk

The main risk is confusing two different actions:

1. `goal start`: start a tracked running goal operation and optionally wait.
2. `goal set`: edit persisted goal state.

For the first public `get/set/clear` slice, `goal set --status active` should
not be allowed to create untracked provider work. Use `goal start` for that.

## Recommendation

Expose public goal state commands, but keep them conservative:

```sh
orchestrator goal get <task-id|prefix> [--json [--compact]]
orchestrator goal set <task-id|prefix> [--objective <text>] [--status <status>] [--token-budget <tokens>] [--json [--compact]]
orchestrator goal clear <task-id|prefix> [--json [--compact]]
```

Rules:

- `goal get` may return cached task goal state for stopped tasks.
- `goal get` should ask the live provider for fresh state when the session is
  running and controllable.
- `goal set` and `goal clear` require a running controllable
  `codex-app-server --session` task.
- `goal set --status active` should be rejected unless it is implemented through
  the tracked `goal start` operation path.
- `goal clear` should reject while a tracked goal operation is running, unless
  we intentionally define it as a cancellation command. Use `interrupt` to stop
  a running session.

## Files Reviewed

- `packages/cli/src/commands/goal.ts`
- `packages/cli/src/parsing/goal.ts`
- `packages/core/src/tasks/supervisor.ts`
- `packages/core/src/tasks/control.ts`
- `packages/core/src/tasks/executors/types.ts`
- `packages/core/src/tasks/executors/protocol/codex-app-server.ts`
- `packages/core/src/tasks/types.ts`
- `packages/agent/src/tools.ts`
- `packages/agent/src/instructions.ts`
- `test/fixtures/fake-codex-app-server.mjs`
- `test/codex-app-server-executor.test.ts`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/thread_goal_processor.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadGoal*.ts`
- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/client.py`
