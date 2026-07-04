# Research Spike: Codex App-Server Control Mechanisms

Date: 2026-07-03

## Question

How do Codex app-server control mechanisms actually work, and how should
Orchestrator map them into persistent sessions, send, steering, goals, and
settings?

## Short Answer

Codex app-server has real, separate protocol mechanisms:

- `thread/start`, `thread/resume`, and `thread/fork` manage conversations.
- `turn/start` sends normal user work to a thread.
- `turn/steer` adds user input to an already-running regular turn.
- `turn/interrupt` cancels an active turn and completes it as interrupted.
- `thread/settings/update` changes next-turn settings without starting a turn.
- `thread/goal/set|get|clear` manages Codex's persisted goal state.

The right Orchestrator mapping is state-based:

- idle persistent Codex session + message: call `turn/start`.
- active regular turn + message: call `turn/steer` with `expectedTurnId`.
- active review or compact turn + message: reject clearly.
- active goal work: treat as a goal operation, not as a plain text prompt.
- settings updates: keep separate from messages.

Do not silently queue messages yet. Codex has internal queues for active-turn
input and goal/runtime work, but Orchestrator should expose explicit, predictable
behavior first.

## Evidence From Codex

Codex's public app-server lifecycle is connection, thread, turn, stream events,
then terminal turn event:
[README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:74).

The API overview names the relevant controls directly:
`thread/start`, `thread/resume`, `thread/settings/update`, `thread/goal/*`,
`turn/start`, `turn/steer`, and `turn/interrupt`:
[README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:138).

`turn/start` is the normal path for user input on a thread. It returns a turn
object immediately and streams `turn/started`, item events, and
`turn/completed`:
[README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:171).

`turn/steer` is narrower. It appends input to the current active regular turn,
does not emit `turn/started`, requires `expectedTurnId`, and rejects no-active,
wrong-turn, review, and manual compaction cases:
[README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:974).

`turn/interrupt` asks Codex to cancel the active turn. Clients should rely on
the later `turn/completed` notification with status `interrupted`:
[README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:925).

Token usage is streamed separately through `thread/tokenUsage/updated`, while
turn lifecycle ends with `turn/completed`:
[README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:1353).

Codex documents `ActiveTurnNotSteerable` as an error for `turn/start` or
`turn/steer` while the current active turn is not steerable:
[README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:1434).

## Turn Start

`turn/start` loads the thread, validates input, applies thread-setting
overrides, maps app-server input into core `Op::UserInput`, and records the
submission id as the turn id:
[turn_processor.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/turn_processor.rs:442).

Core `Op::UserInput` is explicitly "user input, optionally with
thread-settings overrides applied first":
[protocol.rs](/Users/ramos/oss-agents/codex/codex-rs/protocol/src/protocol.rs:542).

The core handler tries to apply input into the current active turn first, then
spawns a new regular task if there is no active turn:
[handlers.rs](/Users/ramos/oss-agents/codex/codex-rs/core/src/session/handlers.rs:183).

This is a Codex implementation detail. Orchestrator should not rely on
`turn/start` as an implicit steer path. It should choose explicitly:

- idle: `turn/start`;
- active regular turn: `turn/steer`;
- active non-steerable turn: reject clearly.

## Steering

The app-server `turn/steer` processor requires non-empty `expectedTurnId`, maps
input, then calls core `steer_input`:
[turn_processor.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/turn_processor.rs:849).

Core `steer_input` checks:

- an active turn exists;
- the active turn has a task;
- `expectedTurnId` matches, when provided;
- the task kind is `Regular`;
- input is non-empty.

Then it appends pending user input into the active turn's input queue:
[mod.rs](/Users/ramos/oss-agents/codex/codex-rs/core/src/session/mod.rs:3833).

Codex tests lock this behavior down for no active turn, mismatched turn id,
review/compact rejection, and successful active-turn input:
[tests.rs](/Users/ramos/oss-agents/codex/codex-rs/core/src/session/tests.rs:9935).

## Thread Settings

`thread/settings/update` is a separate protocol path. It builds thread-setting
overrides, submits core `Op::ThreadSettings`, and does not start a turn:
[turn_processor.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/turn_processor.rs:758).

The core `Op::ThreadSettings` uses the same submission queue as turn starts so
Codex preserves ordering:
[protocol.rs](/Users/ramos/oss-agents/codex/codex-rs/protocol/src/protocol.rs:557).

Orchestrator should not overload `send` for settings. A future command can
expose model, effort, sandbox, or permission updates as settings operations.

## Thread Status

Codex exposes thread status as:

- `notLoaded`;
- `idle`;
- `systemError`;
- `active`, with flags for waiting on approval or user input.

Reference:
[thread.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs:1253).

The app-server status manager derives active status from runtime facts:
running, pending permission requests, and pending user input:
[thread_status.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/thread_status.rs:420).

Important limitation: thread status tells us whether a thread is active, but not
the active turn id. Orchestrator must track active turn id from `turn/start`,
`turn/started`, and `turn/completed`.

## Goals

`thread/goal/set` requires the goals feature, reconciles persisted rollout
state, writes goal state through `GoalService`, emits `thread/goal/updated`,
then applies runtime effects:
[thread_goal_processor.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/thread_goal_processor.rs:97).

The public params are `threadId`, optional `objective`, optional `status`, and
optional `tokenBudget`:
[thread.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs:778).

Goal updates are persisted as rollout items for live threads:
[thread_goal_processor.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/thread_goal_processor.rs:139).

The goal extension registers a goal runtime for each thread, restores it on
thread resume, continues active goals when the thread goes idle, and unregisters
on thread stop:
[extension.rs](/Users/ramos/oss-agents/codex/codex-rs/ext/goal/src/extension.rs:120),
[extension.rs](/Users/ramos/oss-agents/codex/codex-rs/ext/goal/src/extension.rs:139),
[extension.rs](/Users/ramos/oss-agents/codex/codex-rs/ext/goal/src/extension.rs:154).

When an active goal exists and the thread is idle, Codex asks the thread to
start automatic idle work:
[runtime.rs](/Users/ramos/oss-agents/codex/codex-rs/ext/goal/src/runtime.rs:359).

That automatic idle path rejects when user/client-triggered work is pending,
when the session is in plan mode, or when another task is active:
[inject.rs](/Users/ramos/oss-agents/codex/codex-rs/core/src/session/inject.rs:38),
[codex_thread.rs](/Users/ramos/oss-agents/codex/codex-rs/core/src/codex_thread.rs:83).

If an active goal's objective changes during a running turn, Codex injects a
goal steering item into the active turn when possible:
[runtime.rs](/Users/ramos/oss-agents/codex/codex-rs/ext/goal/src/runtime.rs:159).

So goal support should not be modeled as "send a prompt saying this is a goal."
Native goal behavior is provider-backed state plus Codex runtime continuation.

## Current Orchestrator Mismatch

Orchestrator already has the beginning of the right model:

- task session states include `idle`, `turn_running`, and `goal_running`;
- task operations include `turn` and `goal`;
- provider metadata can store `threadId` and `turnId`.

Reference:
[types.ts](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/types.ts:64).

But current `codex-app-server` `sendMessage` only supports active-turn steering:
it requires both `state.threadId` and `state.turnId`, then calls
`turn/steer`:
[codex-app-server.ts](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:57).

Current session startup sets the task session to `idle` after opening the
thread:
[codex-app-server.ts](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:538).

Current notification handling sets `state.turnId` only if it is missing and does
not clear it on `turn/completed`:
[codex-app-server.ts](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:461),
[codex-app-server.ts](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:783).

That is not enough for repeated session operations. Persistent sessions need
"active turn id" state, not "first turn id forever."

## Recommended Orchestrator Call Sequences

### Launch Persistent Session

```text
orchestrator -> codex app-server stdio
initialize
initialized
thread/start or thread/resume
store provider.threadId
task.status = running
task.session.state = idle
wait for control requests
```

### Send To Idle Session

```text
send <task> "Do the next thing"
read task.session.state == idle
turn/start { threadId, input }
store active turn id
create operation { kind: turn, status: running }
task.session.state = turn_running
watch turn/item/token notifications
on turn/completed:
  finish operation
  clear active turn id
  task.session.state = idle
```

### Send To Active Regular Turn

```text
send <task> "Actually focus on tests"
read active turn id
turn/steer { threadId, expectedTurnId: activeTurnId, input }
record message accepted
keep current operation running
```

This is steering, but Orchestrator can keep the product word `send`.

### Send To Active Non-Steerable Turn

```text
send <task> "..."
Codex rejects review/compact turns, or Orchestrator detects non-steerable state
return a clear error:
  "Codex is busy with a non-steerable turn. Wait for it to finish."
```

### Start Goal Operation

```text
goal start <task> "Improve performance by 10%"
require persisted codex-app-server session
require threadId
prefer idle session for v1
thread/goal/set { threadId, objective, status: active, tokenBudget? }
record operation { kind: goal, status: running, objective }
wait for Codex goal runtime to start/continue work
track goal updates, turns, token usage, and terminal goal status
return session to idle when goal operation is terminal
```

### Update Settings

```text
settings update <task> --model ... --effort ...
thread/settings/update { threadId, ... }
do not start a turn
record settings updated event when Codex emits it
```

## Implementation Implications

For persistent Codex sessions, Orchestrator needs to:

1. Track `activeTurnId` separately from the provider's last seen `turnId`.
2. Set session state to `turn_running` on `turn/start` or `turn/started`.
3. Clear `activeTurnId` and set state to `idle` on `turn/completed`.
4. Make idle `send` call `turn/start`, not `turn/steer`.
5. Make active `send` call `turn/steer` with `expectedTurnId`.
6. Keep `goal start` separate from plain `send`.
7. Treat settings as a separate operation.
8. Prefer clear rejection over silent queueing when state is ambiguous.

## What This Confirms

The ADR direction is sound:

- persistent session first;
- normal turn operations inside that session;
- native Codex goal operations after session operation state is solid;
- no app-server pooling required for this slice;
- no public protocol custom-agent config required for this slice.

The immediate next implementation should be session operation state:

1. idle `send` -> `turn/start`;
2. active `send` -> `turn/steer`;
3. active turn id lifecycle;
4. operation wait/result handling.

Goal operations should come after that because Codex goals depend on correct
idle/active session state.
