# Spec: Parent-Agent Session Control Language

Date: 2026-07-03

## Intent

Make persistent agent sessions powerful without making the main Orchestrator
agent think in provider mechanics. The parent agent should be able to launch a
long-lived Codex app-server session, send work to it, wait for results, and
continue using the same session without knowing whether Orchestrator used
`turn/start` or `turn/steer` internally.

Native Codex goals build on that same session model. The first slice established
normal session work; the follow-up goal-start slice is specified in
`adr/specs/codex-app-server-goal-start-operation-20260704-122339.md`.

## First Implementation Slice

The first implementation slice was persistent session turns, not goals.

Build this first:

- `send` on an idle persistent session starts a new provider turn.
- `send` during an active regular turn steers that turn.
- `send --wait` and `send_agent_message({ wait: true })` wait for that
  operation result.
- `turn/completed` completes the current operation, not the whole session task.
- after `turn/completed`, clear the active turn id and return the session to
  `idle`.
- busy non-steerable states fail clearly.

Native goal tools are added by the goal-start slice, after this turn model is in
place.

## Product Vocabulary

Use these terms in parent instructions, CLI help, docs, and skill guidance:

- `task`: a managed Orchestrator job.
- `session`: a running task that stays alive for multiple operations.
- `operation`: one unit of work inside a session.
- `send`: give work or a follow-up instruction to a running task/session.
- `goal`: a provider-backed long-running objective.
- `read`: get a task result or latest completed session operation result.
- `interrupt`: stop work.

Keep these terms internal:

- `turn/start`
- `turn/steer`
- `thread/goal/set`
- `thread/settings/update`
- provider thread id
- provider turn id

## Parent-Agent Rules

Update `ORCHESTRATOR_PARENT_INSTRUCTIONS` to teach this model:

```text
Use launch_agent with session: true when a supported runtime should stay alive
for multiple operations.

Use send_agent_message to give work or a follow-up instruction to a running task
or session when its runtime supports messages. Use wait: true when you need that
operation's result before answering.

Do not use send_agent_message for finished tasks. Use read_agent for finished
results, resume when true provider resume is needed, or launch a new task.

When goal support is available, use start_agent_goal for provider-backed goals
on supported running sessions.
Do not simulate provider goals by sending ordinary prompt text.
```

The parent agent should never be told to choose between `turn/start` and
`turn/steer`.

## Tool Shape

### `launch_agent`

Add optional params:

```ts
session?: boolean;
```

Rules:

- `session: true` only works for runtimes with persistent-session support.
- session launch may omit `instructions` if the runtime supports idle sessions.
- one-shot launches keep current behavior.

### `send_agent_message`

Extend params:

```ts
taskId: string;
message: string;
wait?: boolean;
timeoutMs?: number;
```

Rules:

- If the target is a persistent session and idle, start a new operation.
- If the target has an active regular operation and supports live input, send a
  follow-up into that operation.
- If the target is busy with a non-steerable operation, fail clearly.
- If `wait: true`, wait for the operation result or timeout.
- If `wait` is omitted or false, only report acceptance.

Return shape:

```ts
{
  task: TaskSummary;
  status: "accepted" | "running" | "completed";
  operation?: {
    operationId: string;
    kind: "turn" | "goal";
    status: string;
    result?: string;
  };
  provider?: TaskProviderMetadata;
}
```

### `start_agent_goal`

Add for native provider goals after session send is solid:

```ts
taskId: string;
goal: string;
wait?: boolean;
timeoutMs?: number;
tokenBudget?: number;
```

Rules:

- only supported on running persistent sessions with native goal support;
- prefer idle sessions for v1;
- call provider goal APIs, not ordinary prompt text;
- return goal/operation state;
- `wait: true` waits for terminal goal status.

## CLI Shape

Keep product commands plain:

```sh
orchestrator launch codex-app-server --session --name "performance worker"
orchestrator send <task-id> --wait "Inspect current performance bottlenecks."
orchestrator goal start <task-id> --wait "Improve performance across the app by 10%."
orchestrator send <task-id> --wait "Summarize what changed."
orchestrator interrupt <task-id>
```

Update `send` usage:

```text
orchestrator send <task-id|prefix> [--wait] [--timeout-ms <ms>] [--json [--compact]] "<message>"
```

CLI semantics:

```text
Sends work or a follow-up instruction to a running task/session when its runtime
supports messages. For persistent sessions, send starts a new operation when
idle or adds input to the current operation when supported.
```

## Runtime Mapping

For `codex-app-server`:

| Orchestrator action   | Session state                | Provider call                                   |
| --------------------- | ---------------------------- | ----------------------------------------------- |
| launch session        | none                         | `initialize`, `thread/start` or `thread/resume` |
| send                  | idle                         | `turn/start`                                    |
| send                  | regular turn running         | `turn/steer`                                    |
| send                  | review/compact/non-steerable | reject clearly                                  |
| start goal            | idle                         | `thread/goal/set`                               |
| interrupt active turn | active                       | `turn/interrupt`                                |
| interrupt session     | idle/session                 | stop app-server task                            |
| settings update       | loaded session               | `thread/settings/update`                        |

For `codex`, `claude-code`, process custom agents, and shell:

- no persistent session behavior unless the runtime explicitly opts in;
- normal launch/read/resume behavior stays unchanged;
- `send` remains unsupported unless the runtime implements message support.

## Data Model

Use existing session/operation fields, but tighten semantics:

```ts
type TaskSessionState =
  | "starting"
  | "idle"
  | "turn_running"
  | "goal_running"
  | "stopping"
  | "closed";
```

Rules:

- `session.currentTurnId` is the active turn id, not the first or last turn id.
- `provider.turnId` may store last provider turn metadata, but must not be used
  as active-turn truth after completion.
- `session.currentOperationId` points to the active operation, if any.
- `currentOperation` and `lastOperation` should be enough for v1.

On `turn/started`:

- set `session.state = "turn_running"`;
- set `session.currentTurnId`;
- set or update current operation.

On `turn/completed`:

- finish current operation;
- clear `session.currentTurnId`;
- clear `session.currentOperationId`;
- store the operation as `lastOperation`;
- set `session.state = "idle"` unless a goal continues or session is stopping.
- do not mark the persistent session task terminal.

On `thread/goal/updated`:

- update goal metadata;
- if active, set or keep `session.state = "goal_running"` when tied to a goal
  operation.

## Control Request Shape

For the first slice, extend `send_message` so it can wait for the operation
result:

```ts
type TaskControlRequest = {
  kind: "send_message";
  input: {
    text: string;
    clientMessageId?: string;
    wait?: boolean;
    timeoutMs?: number;
  };
};
```

Keep the existing file-backed control directory. Do not add sockets for this
slice.

The goal-start slice extends this control path with `goal_start` and explicit
goal operation waiting.

## Output And Observability

`ps` should show session state in plain words:

```text
codex-app-server  performance worker  running  idle          42k tok
codex-app-server  performance worker  running  turn running  55k tok
codex-app-server  performance worker  running  goal running  80k tok
```

`events --agent-only` should show normalized events:

- `session.idle`
- `operation.started`
- `operation.completed`
- `operation.failed`
- `goal.updated`
- `goal.cleared`

Raw protocol events stay in transcript/debug surfaces.

## Documentation Updates

Update:

- `packages/agent/src/instructions.ts`
- `packages/agent/src/tools.ts`
- `packages/cli/src/commands/help.ts`
- `doc/codex-app-server.md`
- README runtime/command list if it mentions `send`
- packaged Orchestrator skill/plugin guidance

Replace "send only for active tasks" with "send to running tasks/sessions when
the runtime supports messages."

## Test Plan

Add fake app-server tests for the first slice:

- session launch becomes idle;
- idle `send --wait` calls `turn/start` and returns the operation result;
- active regular `send` calls `turn/steer`;
- completed turn clears active turn id;
- second idle `send` starts a second turn on the same provider thread;
- non-steerable provider rejection becomes a clear Orchestrator error;
- `send_agent_message({ wait: true })` mirrors CLI behavior;
- compact JSON includes session and operation state.

Add docs/help snapshot or behavior tests where existing help currently says
"active tasks only."

Goal tests belong to the later native-goal slice.

## Non-Goals

- no public `turn_start` command;
- no public `steer` command;
- no hidden automatic prompt templates;
- no silent queueing while a session is busy;
- no app-server pooling;
- no shared Codex daemon connector;
- no generic goal abstraction for every runtime.

## References

- `adr/research/SPIKE-codex-app-server-control-mechanisms-20260703-112203.md`
- `adr/research/synthesis-parent-agent-session-control-language-20260703-203248.md`
- `adr/specs/codex-app-server-persistent-session-operations-20260701-092650.md`
- `adr/specs/codex-app-server-steering-20260630-232736.md`
- `adr/specs/codex-goal-support-20260701-074950.md`
