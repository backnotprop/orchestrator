# Research Spike: Codex App-Server Steering

Date: 2026-06-30

## Question

What would it take for Orchestrator to send additional instructions into an
already-running `codex-app-server` task?

## Short Answer

Codex already supports the native operation. The method is `turn/steer`.

The missing part is Orchestrator's control path. Today the live JSON-RPC client
for `codex-app-server` lives inside the task supervisor process. A normal CLI
command runs in a different process, so it cannot directly call the in-memory
client.

The right first implementation is:

1. add a small task-control request path for running tasks;
2. add a `steer`/`send message` operation that reaches the running executor;
3. have the `codex-app-server` executor translate that into Codex
   `turn/steer`;
4. expose it through CLI and parent-agent tools.

This does not require app-server pooling. It does require a cross-process
control channel.

## Codex Behavior

Codex app-server registers `turn/steer` as a first-class JSON-RPC method:

- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/common.rs:805`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server/src/message_processor.rs:1338`

The request shape is:

```text
turn/steer {
  threadId,
  input,
  expectedTurnId,
  clientUserMessageId?
}
```

The generated TypeScript schema makes `expectedTurnId` required:

- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/schema/typescript/v2/TurnSteerParams.ts:6`

Codex's app-server README describes the behavior directly: `turn/steer` appends
input to an already in-flight regular turn. It does not start a new turn:

- `/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:976`

Codex rejects steering when:

- there is no active turn;
- `expectedTurnId` does not match the active turn;
- the active turn is not steerable, such as review or manual compact turns;
- the input is empty or too large.

Relevant implementation:

- `/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/turn_processor.rs:849`

## Current Orchestrator State

`codex-app-server` already owns the live JSON-RPC client while a task is
running:

- `/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:142`

It already stores the active thread and turn ids:

- `/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:240`
- `/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:252`

It already uses native app-server control for in-process interrupt:

- `/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:50`
- `/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:66`

The runtime metadata still says running steering is unsupported:

- `/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/runtimes.ts:131`

The task executor handle only supports `interrupt` today:

- `/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/types.ts:34`

The supervisor keeps live handles only in the current Node process:

- `/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/supervisor.ts:51`
- `/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/supervisor.ts:285`

Background launches run a detached `__run-task` process:

- `/Users/ramos/oss-agents/pi-research/packages/cli/src/background-task.ts:37`

That means a later `orchestrator steer ...` command would run in a new process.
It would see the task record, logs, events, and pid, but not the live
`JsonRpcStdioClient`.

## Product Primitive

ADR 0006 already names the generic product operation as `send_message`:

- `/Users/ramos/oss-agents/pi-research/adr/decisions/0006-treat-subagents-as-durable-asynchronous-task-sessions.md:28`

That is still the better generic concept. Codex calls the native operation
`turn/steer`, but Orchestrator should probably expose this as sending a message
to a running task.

Possible CLI:

```sh
orchestrator send <task-id|prefix> "Actually focus on failing tests first."
```

Possible parent-agent tool:

```text
send_agent_message({ taskId, message })
```

Internally the core operation can still be named `steerTask` if that keeps the
runtime adapter code clear.

## Required Architecture

### 1. Add A Running Task Control Request Path

Add a small control request path under each task directory, for example:

```text
.orchestrator/tasks/<task-id>/control/requests/<request-id>.json
.orchestrator/tasks/<task-id>/control/responses/<request-id>.json
```

Initial request shape:

```ts
type TaskControlRequest = {
  schemaVersion: 1;
  requestId: string;
  createdAt: string;
  kind: "steer";
  input: {
    text: string;
    clientUserMessageId?: string;
  };
};
```

Initial response shape:

```ts
type TaskControlResponse = {
  schemaVersion: 1;
  requestId: string;
  taskId: string;
  kind: "steer";
  status: "accepted" | "failed";
  createdAt: string;
  completedAt: string;
  provider?: {
    threadId?: string;
    turnId?: string;
  };
  error?: {
    message: string;
    reason?: string;
  };
};
```

Use atomic writes, like the task store already does for task records and
heartbeats.

The running supervisor or executor should poll this directory at a small
interval while the task is active. `fs.watch` can come later if needed. Polling
is simpler and reliable enough for a first implementation.

### 2. Extend The Task Executor Handle

Add a runtime control method:

```ts
export type TaskExecutionHandle = {
  completed: Promise<AgentTaskRecord>;
  interrupt(reason: string, signal?: NodeJS.Signals): Promise<void> | void;
  steer?(input: TaskSteerInput): Promise<TaskSteerResult>;
};
```

Only `codex-app-server` should implement it initially. Process runtimes should
not pretend to support it.

The supervisor can expose:

```ts
steerTask({ taskId, text, ...storeOptions });
```

If the task is running in the same process, call `running.handle.steer`.

If the task is detached, write a control request and wait briefly for the
response.

If the task is terminal, stale, orphaned, lost, or unsupported, fail clearly.

### 3. Implement Codex App-Server Steering

In `CodexAppServerTaskExecutor`, the steer handler should:

1. validate non-empty text;
2. require `state.client`;
3. require `state.threadId`;
4. require `state.turnId`;
5. require the turn not to be terminal;
6. append a normalized event such as `protocol.steer.requested`;
7. call:

```ts
client.request("turn/steer", {
  threadId: state.threadId,
  expectedTurnId: state.turnId,
  input: [{ type: "text", text }],
  ...(clientUserMessageId ? { clientUserMessageId } : {}),
});
```

8. verify the response `turnId` matches `state.turnId`;
9. append `protocol.steer.sent`;
10. write a control response.

Do not write raw JSON-RPC protocol traffic to normal logs. Keep raw protocol in
`transcript.jsonl`, and keep `events --agent-only` normalized.

### 4. Expose CLI And Parent Tool

Add a focused CLI command:

```sh
orchestrator send <task-id|prefix> "message"
orchestrator send <task-id|prefix> "message" --json
orchestrator send <task-id|prefix> "message" --json --compact
```

The JSON result should make it clear whether the message was accepted by the
running runtime, not whether the whole task finished.

Add the parent-agent tool after the CLI/core path is solid:

```text
send_agent_message
```

This should be available only for running tasks that advertise
`supportsRunningSteer`.

## Error Cases To Model

- `unsupported`: runtime does not support running messages.
- `not_running`: task is terminal or not active.
- `not_ready`: app-server task is running but `threadId` or `turnId` is not known
  yet.
- `stale`, `orphaned`, `lost`: supervisor liveness says Orchestrator cannot
  safely reach the task.
- `provider_rejected`: Codex rejected `turn/steer`.
- `timeout`: control request was not answered by the supervisor in time.
- `turn_mismatch`: Codex reported a different active turn.

The user should then either wait, inspect events/logs, or use `resume` after
the task finishes.

## Tests

Add deterministic tests before any live smoke.

Core tests:

- process runtime rejects steering as unsupported;
- terminal task rejects steering as not running;
- stale/lost supervised task rejects steering safely;
- same-process `launchTask` can steer a running `codex-app-server` task.

Detached CLI tests:

- launch fake `codex-app-server` in a hanging mode;
- wait until `threadId` and `turnId` are recorded;
- run `orchestrator send <id> "focus on x" --json`;
- assert fake app-server received `turn/steer`;
- assert response includes task id, thread id, and turn id;
- assert `events --agent-only` includes normalized steer events;
- assert the final result can include the steered content.

Fake app-server changes:

- add `turn/steer` handling;
- return `{ turnId }`;
- support modes for no active turn, turn mismatch, and delayed steer response.

Parent-agent tests:

- parent tool exposes `send_agent_message`;
- tool returns a concise accepted/failed result;
- tool errors are recoverable and name `resume` as the follow-up when the task
  has already finished.

## Effort And Risk

The Codex-specific part is small. Calling `turn/steer` is straightforward.

The real work is the Orchestrator control path. It is medium-sized because it
needs to work across detached task supervisor processes, not just in memory.

This should be built as a real task-control primitive, but kept narrow:

- one request kind first: `steer`;
- text input only first;
- no pooling;
- no goals;
- no cross-process app-server rejoin;
- no public protocol custom-agent config.

## Recommendation

Implement this in three slices.

### Slice 1: Task Control Mailbox

Add the per-task control request/response files, request polling in the running
task process, and a core `steerTask` function that can send a request to a
detached task.

Outcome: Orchestrator has a real path for a later CLI command to reach a
running task.

### Slice 2: Codex App-Server `turn/steer`

Implement `TaskExecutionHandle.steer` for `codex-app-server`, translate it to
`turn/steer`, and record normalized events.

Outcome: running `codex-app-server` tasks can accept additional instructions.

### Slice 3: CLI And Parent-Agent Tool

Add `orchestrator send` and `send_agent_message`, update help/docs, and add
compact JSON output.

Outcome: humans and agents can steer running Codex app-server tasks without
knowing the Codex protocol.

## Open Questions

- Should the public command be `send` or `steer`? `send` is clearer and matches
  ADR 0006's generic `send_message` language. `steer` matches Codex protocol
  naming but is less obvious.
- Should control request polling live in the supervisor generically, or inside
  each executor? Prefer supervisor-owned polling with executor handlers, so
  future control operations do not duplicate file watching logic.
- Should successful steering create a visible row/event in `ps` as the latest
  activity? Probably yes, through a normalized `agent_event`.
- Should external CLI interrupt use the same control path later for
  `codex-app-server` instead of falling back to process kill? Probably yes, but
  not in the first steering slice.
