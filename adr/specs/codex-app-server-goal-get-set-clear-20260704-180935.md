# Spec: Codex App-Server Goal Get, Set, And Clear

Date: 2026-07-04

## Intent

Expose native Codex app-server goal state controls through Orchestrator, without
changing the meaning of `goal start`.

`goal start` remains the command for starting tracked provider work.
`goal get`, `goal set`, and `goal clear` are state controls for an existing
Codex app-server session.

## User-Facing CLI

```sh
orchestrator goal get <task-id|prefix> [--json [--compact]]

orchestrator goal set <task-id|prefix> \
  [--objective <text>] \
  [--status paused|blocked|usage-limited|budget-limited|complete] \
  [--token-budget <tokens|none>] \
  [--json [--compact]]

orchestrator goal clear <task-id|prefix> [--json [--compact]]
```

Keep the existing command unchanged:

```sh
orchestrator goal start <task-id|prefix> [--wait] [--timeout-ms <ms>] [--token-budget <tokens>] [--json [--compact]] "<goal>"
```

## Plain-English Behavior

- `goal get` shows the current goal Orchestrator knows about.
- `goal set` edits the current provider goal state.
- `goal clear` removes the current provider goal.
- `goal start` starts Codex working on a goal and lets Orchestrator track that
  work as an operation.

## Guardrails

Reject `goal set --status active` in the first implementation.

Reason: Codex can start provider work when a goal becomes active. Orchestrator
must create a tracked goal operation before that happens. `goal start` already
does that correctly.

Error hint:

```text
Use goal start when activating a goal so Orchestrator can track the work.
```

Reject `goal clear` while the task has a running goal operation:

```text
This session is running a goal. Use interrupt to stop the session, or wait for
the goal operation to finish before clearing it.
```

This avoids turning `clear` into a hidden cancellation command.

## Core API

Add core functions from `packages/core/src/tasks/supervisor.ts` or a nearby
goal-control module:

```ts
type GetTaskGoalResult = {
  task: AgentTaskRecord;
  source: "provider" | "task";
  goal?: TaskGoal;
};

type SetTaskGoalInput = TaskStoreOptions & {
  taskId: string;
  objective?: string;
  status?: TaskGoalStatus;
  tokenBudget?: number | null;
  timeoutMs?: number;
};

type SetTaskGoalResult = {
  task: AgentTaskRecord;
  source: "provider";
  goal: TaskGoal;
};

type ClearTaskGoalResult = {
  task: AgentTaskRecord;
  source: "provider";
  cleared: boolean;
};
```

Export:

```ts
getTaskGoal(input);
setTaskGoal(input);
clearTaskGoal(input);
```

## Runtime Validation

For `goal set` and `goal clear`, require:

- task exists;
- task is not terminal;
- task is actionable according to `observeTaskState`;
- runtime is `codex-app-server`;
- launch plan is `protocolExecutionMode: "session"`;
- task has a provider `threadId` or session `threadId`.

For `goal get`:

- if the running session is actionable, ask the provider for fresh state;
- otherwise return cached `task.goal` with `source: "task"`.

## Execution Handle

Extend `TaskExecutionHandle` with a single goal-control method:

```ts
type TaskGoalControlInput =
  | { action: "get"; timeoutMs?: number }
  | {
      action: "set";
      objective?: string;
      status?: TaskGoalStatus;
      tokenBudget?: number | null;
      timeoutMs?: number;
    }
  | { action: "clear"; timeoutMs?: number };

type TaskGoalControlResult =
  | { action: "get"; goal?: TaskGoal }
  | { action: "set"; goal: TaskGoal }
  | { action: "clear"; cleared: boolean };

type TaskExecutionHandle = {
  // existing fields...
  controlGoal?(input: TaskGoalControlInput): Promise<TaskGoalControlResult>;
};
```

This keeps goal state control separate from `startGoal`, which starts work.

## Detached Control Requests

Extend file-backed control requests with one new kind:

```ts
{
  kind: "goal_control";
  input: TaskGoalControlInput;
}
```

The response should include:

```ts
{
  kind: "goal_control";
  status: "completed" | "failed";
  goal?: TaskGoal;
  cleared?: boolean;
  error?: { reason; message };
}
```

This allows `goal get/set/clear` to work against background sessions owned by a
detached supervisor.

## Codex App-Server Executor

Implement `controlGoal` in `packages/core/src/tasks/executors/protocol/codex-app-server.ts`.

`get`:

```text
client.request("thread/goal/get", { threadId })
extract goal
update task.goal when present
clear task.goal when provider returns null
return goal
```

`set`:

```text
reject status active
client.request("thread/goal/set", { threadId, objective?, status?, tokenBudget? })
extract goal
update task.goal
append protocol.goal.set event
return goal
```

`clear`:

```text
reject if current operation kind is goal and not settled
client.request("thread/goal/clear", { threadId })
update task.goal undefined when cleared
append protocol.goal.cleared event
return cleared
```

Provider notifications still produce normalized `goal.updated` and
`goal.cleared` events. Do not expose raw `thread/goal/*` protocol events through
`events --agent-only`.

## Timestamp Normalization

Update goal timestamp normalization:

```ts
function normalizeProviderTimestamp(value: number): string {
  const millis = value < 1_000_000_000_000 ? value * 1000 : value;
  return new Date(millis).toISOString();
}
```

Codex emits Unix seconds. Fake servers may emit JavaScript milliseconds. Support
both.

## CLI Parser

Change `parseGoalOptions` to route:

```text
goal start
goal get
goal set
goal clear
```

Options:

- all subcommands accept `--workspace`, `--orchestrator-dir`, `--config`,
  `--json`, `--compact`;
- `get` accepts `--timeout-ms`;
- `set` accepts `--objective`, `--status`, `--token-budget`, `--timeout-ms`;
- `clear` accepts `--timeout-ms`;
- `--compact` still requires `--json`.

Status aliases:

```text
usage-limited -> usage_limited
budget-limited -> budget_limited
```

Reject unknown statuses and `active`.

## Provider Status Mapping

Keep Orchestrator task records in normalized snake-case:

```text
usage_limited
budget_limited
```

When sending `thread/goal/set` to Codex, convert back to provider status values:

```text
usage_limited -> usageLimited
budget_limited -> budgetLimited
```

`active` is still valid provider state for `goal start`, but not for public
`goal set` in this slice.

## CLI Output

Human:

```text
goal none  codex session
goal paused  codex session  12k tok
goal cleared  codex session
```

JSON:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "task": {},
  "goal": {
    "action": "get",
    "source": "provider",
    "state": {}
  }
}
```

For clear:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "task": {},
  "goal": {
    "action": "clear",
    "source": "provider",
    "cleared": true
  }
}
```

## Parent-Agent Tools

Add tools:

```text
read_agent_goal
set_agent_goal
clear_agent_goal
```

Guidance:

- use `read_agent_goal` to inspect provider goal state;
- use `set_agent_goal` to pause, mark blocked, mark complete, or edit the
  objective/token budget;
- use `start_agent_goal` to activate tracked goal work;
- use `interrupt_agent` to stop a running goal session.

Do not expose `active` in `set_agent_goal` yet.

## Tests

Core tests:

- `getTaskGoal` returns cached goal for terminal/stopped task.
- `getTaskGoal` asks provider for fresh goal on running session.
- `setTaskGoal` writes paused/blocked/complete state through detached control.
- `setTaskGoal` rejects active status.
- `clearTaskGoal` clears idle session goal.
- `clearTaskGoal` rejects while a goal operation is running.
- Unix-second timestamps normalize correctly.

CLI tests:

- `goal get --json --compact`
- `goal set --status paused --json --compact`
- `goal set --objective "..." --token-budget 1000 --json --compact`
- `goal set --status usage-limited` normalizes to `usage_limited`
- `goal clear --json --compact`
- errors are machine-readable with useful hints.

Parent-agent tests:

- parent can read a goal;
- parent can set a paused or blocked goal;
- parent can clear a goal;
- parent cannot set active and receives the `start_agent_goal` hint.

Fake app-server:

- ensure `thread/goal/clear` returns `{ cleared: boolean }`, matching real Codex.
- support `goal get` after clear returning `null`.
- support Unix-second timestamp fixture.

## Docs

Update:

- `packages/cli/src/commands/help.ts`
- `doc/codex-app-server.md`
- `skills/orchestrator/SKILL.md`

Make the docs say:

- use `goal start` to make Codex work on a goal;
- use `goal get/set/clear` to inspect or edit provider goal state;
- use `interrupt` to stop a running session.

## Non-Goals

- no generic Orchestrator goal engine;
- no goal support for `codex exec`;
- no goal support for Claude Code;
- no app-server pooling;
- no public protocol custom-agent goal schema;
- no `goal set --status active` until it can create a tracked operation.

## References

- `adr/research/SPIKE-codex-app-server-goal-get-set-clear-20260704-180935.md`
- `adr/research/synthesis-codex-app-server-goal-get-set-clear-20260704-180935.md`
- `adr/specs/codex-app-server-goal-start-operation-20260704-122339.md`
- `adr/specs/codex-app-server-persistent-session-operations-20260701-092650.md`
- `adr/decisions/0054-use-persistent-codex-app-server-sessions-for-goal-work-20260701-104716.md`
