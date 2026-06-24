# Protocol Session Adapter Spec

Date: 2026-06-24

## Status

Draft spec.

## Intent

Add support for live protocol-backed agent runtimes, starting with Codex
app-server, without breaking the existing process runtime model.

The user-facing CLI should stay simple. Orchestrator still launches, watches,
reads, and interrupts agent tasks. Internally, task execution should support
more than spawned command processes.

This is real product work, not a throwaway experiment. Codex app-server is the
first protocol runtime. The implementation can be staged, but every slice should
be written as durable code with tests and documented bottlenecks.

## Goals

- Keep `codex exec` as the stable Codex runtime.
- Add Codex app-server as the first protocol runtime.
- Introduce a reusable internal task executor boundary.
- Keep task records, events, logs, usage, `ps`, waiting, grouping, and
  interruption unified across runtime types.
- Support API-level interrupt for protocol runtimes.
- Store external provider ids, such as Codex `threadId` and `turnId`, on the
  task record.
- Normalize protocol events into existing Orchestrator task events.
- Capture live token usage when the protocol provides it.

## Non-Goals

- Do not expose generic public `adapter: "protocol"` custom config yet.
- Do not replace the current `codex` process runtime.
- Do not build a long-lived Codex app-server pool in the first version.
- Do not require custom agents to use protocol sessions.
- Do not redesign `ps`, `read`, `logs`, `events`, or parent-agent tools.
- Do not build HTTP adapter support in this same slice.

## Runtime Model

Introduce an internal adapter kind concept:

```ts
type RuntimeAdapterKind = "process" | "http" | "protocol";
```

For now:

- `process` is implemented and remains default.
- `protocol` is implemented for Codex app-server only.
- `http` remains designed but not implemented in this slice.

The public runtime registry can stay close to the current shape at first, but
the launch plan or runtime config must be able to indicate which executor owns
the task.

Possible internal shape:

```ts
type RuntimeExecutionKind = "process" | "protocol";

type AgentLaunchPlan = {
  runtime: string;
  displayName: string;
  executionKind: RuntimeExecutionKind;
  executable: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  promptTransport: PromptTransport;
  outputTransport: OutputTransport;
  interrupt: InterruptStrategy;
  taskForSdkOrHttp?: string;
  taskForProtocol?: string;
};
```

This can be refined. The important part is that `launchTask(...)` should not
assume every launch plan means `spawn(...)`.

## Task Executor Boundary

Create an internal executor layer under `launchTask(...)`.

Draft files:

```text
packages/core/src/tasks/executors/types.ts
packages/core/src/tasks/executors/process.ts
packages/core/src/tasks/executors/protocol/codex-app-server.ts
packages/core/src/tasks/executors/protocol/json-rpc-stdio.ts
```

Draft interface:

```ts
type TaskExecutionContext = {
  taskId: string;
  task: AgentTaskRecord;
  plan: AgentLaunchPlan;
  appendEvent(type: TaskEvent["type"], data?: Record<string, unknown>): Promise<TaskEvent>;
  appendStdout(chunk: Buffer | string): Promise<void>;
  appendStderr(chunk: Buffer | string): Promise<void>;
  appendTranscript(line: string): Promise<void>;
  updateUsage(usage: TaskUsage): Promise<void>;
  updateProviderMetadata(metadata: TaskProviderMetadata): Promise<void>;
  markRunning(data?: Record<string, unknown>): Promise<void>;
  markTerminal(status: TaskStatus, details: TerminalDetails): Promise<AgentTaskRecord>;
};

type TaskExecutionHandle = {
  completed: Promise<AgentTaskRecord>;
  interrupt?(reason: string, signal?: NodeJS.Signals): Promise<void>;
};

type TaskExecutor = {
  kind: RuntimeAdapterKind;
  start(context: TaskExecutionContext): Promise<TaskExecutionHandle>;
};
```

`launchTask(...)` keeps owning:

- task id creation;
- task file initialization;
- queued/starting events;
- task record updates;
- output file paths;
- heartbeat policy;
- final task record persistence;
- the `runningTasks` map;
- interrupt dispatch.

Executors own:

- how the runtime starts;
- how output/events arrive;
- how final output is extracted;
- how usage is observed;
- how runtime-specific interrupt works.

## Process Executor

Move current `spawn(...)` behavior into `ProcessTaskExecutor` first.

This must be behavior-preserving.

It should keep:

- stdout log capture;
- stderr log capture;
- combined log capture;
- bounded output behavior;
- output adapter parsing;
- heartbeat for supervisor and child process;
- timeout behavior;
- process-group interrupt;
- final status rules.

This phase should not add Codex app-server yet.

## Provider Metadata

Add optional provider/session metadata to `AgentTaskRecord`.

Draft:

```ts
type TaskProviderMetadata = {
  provider?: string;
  protocol?: "jsonrpc";
  transport?: "stdio" | "unix" | "websocket" | "http";
  threadId?: string;
  turnId?: string;
  sessionId?: string;
  remoteTaskId?: string;
  connectionId?: string;
};

type AgentTaskRecord = {
  provider?: TaskProviderMetadata;
};
```

Rules:

- This metadata is for external runtime ids.
- It does not replace `parent`.
- It should be included in machine-readable output when useful.
- It should not clutter human `ps` by default.

For Codex app-server:

```json
{
  "provider": "codex",
  "protocol": "jsonrpc",
  "transport": "stdio",
  "threadId": "...",
  "turnId": "..."
}
```

## Codex JSON-RPC Stdio Client

Build a small internal client for Codex app-server over stdio.

Responsibilities:

- spawn `codex app-server --listen stdio://`;
- send JSON-RPC requests with ids;
- send notifications;
- read stdout line by line;
- route responses by request id;
- route notifications by `threadId` and `turnId`;
- buffer early turn notifications;
- drain stderr;
- surface protocol errors clearly;
- close gracefully;
- kill the process if graceful close fails.

This should be tested with a fake JSON-RPC process before using live Codex.

## Codex App-Server Runtime

Add the first protocol runtime:

```text
id: codex-app-server
displayName: Codex App Server
executionKind: protocol
command: codex app-server --listen stdio://
```

Initial task flow:

1. Start app-server over stdio.
2. Send `initialize`.
3. Send `initialized`.
4. Send `thread/start`.
5. Store `threadId`.
6. Send `turn/start` with the Orchestrator task prompt.
7. Store `turnId`.
8. Route notifications for that turn.
9. Normalize useful notifications into `agent_event`.
10. Store raw protocol notifications in `transcript.jsonl`.
11. Update task usage from `thread/tokenUsage/updated`.
12. Extract final answer from completed agent-message items.
13. On `turn/completed`, write `result.md`.
14. Mark task terminal.
15. Close the app-server process.

The first version should use one app-server process per Orchestrator task.

This runtime can land after the executor boundary and JSON-RPC client are in
place. It should not be treated as a proof of concept. The existing `codex`
runtime remains available because process-based Codex and app-server Codex are
different runtime surfaces with different tradeoffs.

## Notification Mapping

Map Codex protocol events into existing Orchestrator task events.

Suggested mapping:

```text
thread/started              -> agent_event kind="thread.started"
turn/started                -> agent_event kind="turn.started"
item/started                -> agent_event kind="agent.item.started"
item/completed agent_message -> agent_event kind="agent.message"
item/completed command      -> agent_event kind="agent.command"
item/completed tool         -> agent_event kind="agent.tool"
thread/tokenUsage/updated   -> agent_event kind="agent.usage"
turn/completed succeeded    -> completed/result
turn/completed failed       -> failed
```

Store enough detail for `events` and future TUI views, but keep `task.json`
small.

## Token Usage

Use the existing normalized usage contract.

Codex app-server emits `thread/tokenUsage/updated` with:

```ts
type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
};
```

For one Orchestrator task mapped to one Codex turn:

- prefer the current turn usage;
- update the task record as usage arrives;
- use `source: "provider"`;
- use `scope: "task"` only when the adapter knows the turn is the whole task;
- otherwise use `scope: "turn"`;
- use `final: false` while running;
- set `final: true` when the turn completes and usage is settled.

`ps` and future TUI should read `task.usage`. They should not parse logs.

## Interrupt Semantics

Protocol interrupt should prefer API control.

Flow:

1. Mark `stopRequestedAt`, `stopReason`, and `stopSignal` on the task.
2. If Codex `threadId` and `turnId` are known, send `turn/interrupt`.
3. Wait briefly for terminal protocol notification.
4. If the protocol does not settle, kill the app-server process group.
5. Preserve the user stop reason in the final task.

This should plug into the existing `interruptTask(...)` and
`interruptTasks(...)` behavior. Parent/child/group interruption should not need
a separate model.

## Logs, Events, Transcript

Use a clear split:

- `events.jsonl`: normalized Orchestrator task timeline.
- `transcript.jsonl`: raw provider/protocol messages useful for debugging.
- `stdout.log`: adapter stdout diagnostics only, if any.
- `stderr.log`: app-server stderr and adapter diagnostics.
- `result.md`: final answer.

Do not dump raw JSON-RPC messages into `logs` as the primary user experience.

## Public Config

Do not add public custom `adapter: "protocol"` in the first implementation.

Keep public custom agents at:

```json
{ "adapter": "process" }
```

Keep HTTP as the next likely public adapter:

```json
{ "adapter": "http" }
```

Only expose protocol config after another real protocol-backed tool proves the
shape.

## Test Plan

Slice 1-3 tests:

- process executor preserves current launch/read/logs/events behavior;
- process executor preserves timeout behavior;
- process executor preserves interrupt behavior;
- current test suite passes with no output changes.

Protocol client unit tests:

- routes JSON-RPC responses by id;
- routes notifications by turn id;
- buffers early notifications;
- handles malformed JSON lines;
- maps protocol errors;
- drains stderr;
- closes/kills cleanly.

Codex protocol executor tests with fake server:

- initializes protocol;
- starts thread and turn;
- stores threadId and turnId;
- writes normalized events;
- writes transcript lines;
- extracts final answer;
- updates usage;
- interrupts through API before process kill;
- marks succeeded, failed, cancelled, and timed_out correctly.

Optional live smoke:

```sh
RUN_CODEX_APP_SERVER_SMOKE=1 pnpm test
```

Live smoke should cover:

- simple final answer;
- token usage when emitted;
- interrupting a long task.

## Acceptance Criteria

- Existing `codex`, `claude-code`, `pi`, `shell`, and custom process runtimes
  still work.
- `codex-app-server` can launch as the first protocol runtime.
- `orchestrator ps` shows the running protocol task.
- `orchestrator read <task-id>` returns the final answer.
- `orchestrator events <task-id>` shows normalized protocol events.
- `orchestrator interrupt <task-id>` uses Codex API interrupt when possible.
- Task JSON stores Codex `threadId` and `turnId`.
- Token usage appears in `ps` when Codex app-server emits it.
- No generic public protocol config is exposed yet.

## Open Questions

- Should the first version use ephemeral Codex threads or persisted threads?
- How much Codex app-server config should be surfaced: model, sandbox,
  approval policy, base instructions, developer instructions?
- Should goals be part of the first Codex app-server runtime, or a second slice
  after basic turn execution works?
- Should protocol metadata appear in compact JSON control views by default?
- How should app-server protocol churn be version-gated?

## Implementation Slices

### Slice 1-3: Foundation

Build the task executor boundary, move existing process execution into
`ProcessTaskExecutor`, and add provider metadata to task records.

Outcome:

- no user-visible behavior change;
- all existing runtimes still work;
- `launchTask(...)` no longer assumes every runtime is only `spawn(...)`;
- task records can store external ids such as `threadId` and `turnId`;
- process runtime behavior is covered by existing and focused regression tests.

This is the highest-value first patch. It creates the real seam for protocol
runtimes before introducing Codex app-server behavior.

### Slice 4: JSON-RPC Stdio Client

Build the reusable protocol client needed by Codex app-server.

Outcome:

- spawn a stdio protocol process;
- send JSON-RPC requests with ids;
- route responses by id;
- route notifications by thread and turn id;
- buffer early notifications;
- drain stderr;
- close or kill cleanly;
- prove behavior with fake-server tests.

The client should be generic enough for future protocol tools, but it should not
be exposed as public custom-agent config yet.

### Slice 5: Codex Protocol Executor

Wire Codex app-server into the executor model.

Outcome:

- `codex-app-server` runtime exists;
- starts `codex app-server --listen stdio://`;
- initializes the protocol;
- starts a thread and turn;
- stores Codex `threadId` and `turnId`;
- normalizes events;
- captures final output;
- updates usage when token events arrive;
- works through `launch`, `ps`, `read`, and `events`.

This is where the third runtime capability becomes visible.

### Slice 6: Interrupt And Control Hardening

Make protocol control reliable.

Outcome:

- `interrupt` sends Codex `turn/interrupt` when possible;
- process kill is a fallback, not the primary control path;
- final task state is correct;
- stop reason wins over timeout or protocol noise;
- parent, child, and group interruption still work;
- timeout, cancellation, and protocol failure paths are tested.

This is separated from Slice 5 because launch/read/result is already enough
complexity.

### Slice 7: Product Polish And Live Smoke

Make the capability feel integrated.

Outcome:

- `ps --watch` shows Codex app-server token usage when emitted;
- `events` are useful and not raw protocol noise;
- `logs` stay understandable;
- docs explain `codex` versus `codex-app-server`;
- opt-in live smoke tests exist;
- any bottlenecks discovered during implementation are documented.

## Bottleneck Log

Track these as implementation proceeds:

- Codex app-server protocol churn;
- ephemeral versus persisted threads;
- whether goals belong in Slice 5 or a later slice;
- token usage finality;
- interrupt timing and terminal-state settling;
- protocol transcript versus user-facing logs;
- whether app-server should remain per-task or become pooled later.
