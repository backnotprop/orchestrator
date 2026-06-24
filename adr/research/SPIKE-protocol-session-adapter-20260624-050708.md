# Research Spike: Protocol Session Adapter

Date: 2026-06-24

## Question

What would it take to build a reusable protocol/session adapter for
Orchestrator, starting with Codex app-server but leaving room for other tools in
the future?

## Short Answer

This is a third adapter family.

It is similar to the future HTTP adapter only in the broad sense that both are
not plain local process execution. But it should not be modeled as HTTP.

Orchestrator should treat runtime adapters as:

1. `process`: start a local command, pass a prompt, capture stdout/stderr, wait
   for process exit.
2. `http`: call a remote or local service over request/response HTTP, then poll
   or subscribe if the service supports long-running work.
3. `protocol`: keep a live session open to an agent service using JSON-RPC,
   WebSocket, stdio, Unix socket, or an SDK-style protocol.

Codex app-server fits `protocol`. It is not just `codex exec` with different
flags. It exposes thread lifecycle, turn lifecycle, notifications, token usage,
interrupt, steer, and goal operations through a live JSON-RPC session.

The right reusable design is to introduce a task executor boundary underneath
the current task supervisor. The supervisor should continue owning task records,
events, logs, usage summaries, waiting, `ps`, short IDs, grouping, and
interrupt semantics. Executors should own how one task actually runs.

## Current Orchestrator Shape

Relevant files:

- `packages/core/src/runtime/types.ts`
- `packages/core/src/runtime/launch-plan.ts`
- `packages/core/src/runtime/runtimes.ts`
- `packages/core/src/runtime/config.ts`
- `packages/core/src/tasks/supervisor.ts`
- `packages/core/src/tasks/output-adapters.ts`
- `packages/core/src/tasks/types.ts`
- `packages/core/src/tasks/usage.ts`
- `packages/agent/src/tools.ts`
- `doc/custom-agents.md`
- `doc/live-agent-view.md`
- `adr/research/SPIKE-codex-app-server-support-20260624-045625.md`

Today `buildAgentLaunchPlan(...)` produces an `AgentLaunchPlan`. The plan always
contains:

- executable;
- args;
- env;
- cwd;
- prompt transport;
- output transport;
- interrupt strategy.

The type already hints at more than process execution:

```ts
type PromptTransport =
  | { kind: "argv"; position: "first" | "last" }
  | { kind: "argv_template" }
  | { kind: "flag"; flag: string }
  | { kind: "stdin"; closeAfterWrite: boolean }
  | { kind: "prompt_file"; flag: string }
  | { kind: "sdk" }
  | { kind: "http" };

type InterruptStrategy = "process_group" | "stdin" | "api" | "unsupported";
```

`AgentLaunchPlan` also has `taskForSdkOrHttp?: string`.

But those hints are not implemented as separate execution paths. In
`packages/core/src/tasks/supervisor.ts`, `launchTask(...)` always does:

```ts
spawn(input.plan.executable, input.plan.args, ...)
```

Then it:

- initializes task files;
- appends `queued`, `starting`, `running`, stdout/stderr, result, and terminal
  events;
- writes heartbeat metadata;
- captures stdout/stderr/combined logs;
- sends chunks to `createRuntimeOutputAdapter(...)`;
- updates normalized usage;
- marks final status when the process closes;
- interrupts by killing a process group.

That process path is good. It should stay. But it should become one executor,
not the only executor.

## What Codex App-Server Requires

The Codex app-server research found these facts:

- Codex app-server runs as:

  ```text
  codex app-server --listen stdio://
  codex app-server --listen unix://
  codex app-server --listen unix://PATH
  codex app-server --listen ws://IP:PORT
  ```

- The stdio transport is newline-delimited JSON-RPC over stdin/stdout.
- A client must send `initialize`, then `initialized`.
- A client starts or resumes a thread.
- A client starts a turn.
- Responses are routed by JSON-RPC request id.
- Notifications are routed by `threadId` and `turnId`.
- Turn output comes through notifications, not just process stdout text.
- Token usage comes through `thread/tokenUsage/updated`.
- Interrupt is `turn/interrupt`, not process kill as the primary control path.
- Goals are real protocol calls: `thread/goal/set|get|clear`.

Codex Python SDK already implements this shape:

- starts `codex app-server --listen stdio://`;
- drains stderr separately;
- reads stdout in one reader thread;
- routes JSON-RPC responses by request id;
- routes turn notifications by turn id;
- preserves early notifications that arrive before the caller starts reading;
- collects final answer from completed items;
- captures `ThreadTokenUsageUpdatedNotification`;
- supports `turn_interrupt`, `turn_steer`, and goal operations.

Reference files:

- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/client.py`
- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/_message_router.py`
- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/_run.py`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-transport/src/transport/stdio.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsageUpdatedNotification.ts`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/schema/typescript/v2/TurnCompletedNotification.ts`

## Why Process Adapter Is Not Enough

The current process adapter is excellent when the runtime contract is:

```text
start command -> stream stdout/stderr -> process exits -> task is done
```

Codex app-server has a different contract:

```text
open protocol connection
initialize client
start/resume thread
start turn
receive notifications
possibly interrupt/steer while running
finish turn
close or keep session
```

Forcing that into the current process adapter would create bad pressure:

- stdout would carry protocol messages for Orchestrator, not agent logs;
- process exit would not necessarily mean one task finished;
- API interrupt would be bolted beside process-group kill;
- thread/turn ids would be hidden inside provider output instead of task
  metadata;
- token updates would need a fake JSONL translation layer;
- future protocol tools would copy the same JSON-RPC/session plumbing.

That would work for a smoke test, but it would be the wrong foundation.

## Why HTTP Adapter Is Not Enough

HTTP is useful for remote agents where the service owns job execution:

```text
POST /tasks
GET /tasks/:id
GET /tasks/:id/events
POST /tasks/:id/cancel
```

Codex app-server is not that. It is a live, stateful protocol session. It has
request ids, server notifications, turn ids, active streams, and server-side
operations while the task is running.

Some protocol transports may use WebSocket. That still does not make them the
same as the HTTP adapter. The important distinction is not network shape. It is
lifecycle shape:

- HTTP adapter: submit job, fetch status/result.
- Protocol adapter: maintain session, route messages, react to live
  notifications.

## Desired Adapter Model

Use a small number of adapter kinds:

```ts
type RuntimeAdapterKind = "process" | "http" | "protocol";
```

Do not create `adapter: "codex-app-server"` as the generic public concept.
Codex app-server should be a protocol-backed runtime.

The runtime registry should eventually describe:

```ts
type RuntimeExecution =
  | {
      kind: "process";
      executable: string;
      args: string[];
      prompt: PromptTransport;
      output: OutputTransport;
      interrupt: "process_group" | "stdin" | "unsupported";
    }
  | {
      kind: "http";
      endpoint: HttpRuntimeEndpoint;
      interrupt: "api" | "unsupported";
    }
  | {
      kind: "protocol";
      protocol: "jsonrpc";
      transport: ProtocolTransportConfig;
      session: ProtocolSessionConfig;
      interrupt: "api" | "process_group" | "unsupported";
    };
```

For Codex first, this can be narrower:

```ts
type ProtocolTransportConfig =
  | {
      kind: "stdio";
      executable: string;
      args: string[];
    }
  | {
      kind: "unix";
      path: string;
    }
  | {
      kind: "websocket";
      url: string;
    };
```

The first implementation should probably only support `stdio` for Codex. The
type should not block Unix socket or WebSocket later.

## Task Executor Boundary

Introduce an internal executor interface under `launchTask(...)`.

Draft shape:

```ts
type TaskExecutionContext = {
  taskId: string;
  task: AgentTaskRecord;
  plan: AgentLaunchPlan;
  signal?: AbortSignal;
  appendEvent(type: TaskEvent["type"], data?: Record<string, unknown>): Promise<TaskEvent>;
  appendStdout(chunk: Buffer | string): Promise<void>;
  appendStderr(chunk: Buffer | string): Promise<void>;
  appendTranscript(line: string): Promise<void>;
  updateUsage(usage: TaskUsage): Promise<void>;
  updateProviderMetadata(metadata: Record<string, unknown>): Promise<void>;
  markRunning(data?: Record<string, unknown>): Promise<void>;
  markTerminal(status: TaskStatus, details: TerminalDetails): Promise<AgentTaskRecord>;
};

type TaskExecutor = {
  kind: "process" | "http" | "protocol";
  start(context: TaskExecutionContext): Promise<TaskExecutionHandle>;
};

type TaskExecutionHandle = {
  completed: Promise<AgentTaskRecord>;
  interrupt?(reason: string, signal?: NodeJS.Signals): Promise<void>;
  steer?(input: string): Promise<void>;
};
```

`launchTask(...)` would still create the task record and files. It would choose
an executor from the plan/runtime, then let the executor run the task.

The process executor would contain today’s spawn logic.

The protocol executor would contain Codex app-server session logic.

This keeps the public behavior stable:

- `orchestrator launch ...`
- `orchestrator ps`
- `orchestrator read`
- `orchestrator logs`
- `orchestrator events`
- `orchestrator interrupt`
- parent tool `launch_agent`
- parent tool `read_agent`

All of those should continue reading the same task store.

## Codex Protocol Executor Shape

For a first Codex protocol runtime:

```text
runtime id: codex-app-server
adapter kind: protocol
transport: stdio
command: codex app-server --listen stdio://
```

One Orchestrator task should map to one Codex turn. The Codex app-server process
may be per task at first. That is simpler and matches current task supervision.

Minimal flow:

1. Spawn `codex app-server --listen stdio://`.
2. Start one stdout reader.
3. Start one stderr drain.
4. Send `initialize`.
5. Send `initialized`.
6. Send `thread/start` with cwd, model, sandbox/approval config, and optional
   base/developer instructions.
7. Store returned `threadId` in task metadata.
8. Send `turn/start` with the Orchestrator task prompt.
9. Store returned `turnId` in task metadata.
10. Route notifications for the turn.
11. Convert useful notifications into `agent_event` events.
12. Append raw provider notifications to `transcript.jsonl`.
13. Update `task.usage` when `thread/tokenUsage/updated` arrives.
14. Collect final answer from completed agent-message items.
15. On `turn/completed`, write `result.md` and mark the task terminal.
16. Close the app-server process.

Interrupt flow:

1. If `threadId` and `turnId` are known, send `turn/interrupt`.
2. Keep a short bounded wait for the turn to complete/cancel.
3. If the protocol process does not respond, fall back to process-group kill.
4. Preserve Orchestrator’s stop reason in task state.

## Task Metadata Needed

The current task record has `runtime`, `launchPlan`, `pid`, `usage`,
`supervision`, and `location`. Protocol runtimes need provider/session metadata.

Add something like:

```ts
type TaskProviderMetadata = {
  provider?: string;
  protocol?: "jsonrpc";
  transport?: "stdio" | "unix" | "websocket";
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

This should not replace parent metadata. Parent metadata answers “who launched
this task?” Provider metadata answers “what external session does this task map
to?”

For Codex:

- `provider.provider = "codex"`
- `provider.protocol = "jsonrpc"`
- `provider.transport = "stdio"`
- `provider.threadId = <codex thread id>`
- `provider.turnId = <codex turn id>`

For future HTTP:

- `provider.remoteTaskId = <remote task id>`

For future WebSocket protocol tools:

- `provider.connectionId` or service-specific session id may be useful.

## Event Mapping

Keep Orchestrator events stable. Protocol-specific messages should become
normalized `agent_event` records plus raw transcript lines.

Codex examples:

```text
thread/started              -> agent_event kind="thread.started"
turn/started                -> agent_event kind="turn.started"
item/started                -> agent_event kind="agent.item.started"
item/completed agent_message -> agent_event kind="agent.message"
item/completed tool_call     -> agent_event kind="agent.tool"
thread/tokenUsage/updated   -> agent_event kind="agent.usage"
turn/completed succeeded    -> completed/result
turn/completed failed       -> failed
```

Use `packages/core/src/tasks/usage.ts` for normalized usage selection.

Codex `ThreadTokenUsage` shape:

```ts
type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
};
```

For a single Orchestrator task mapped to one turn, prefer `last` as
`scope: "turn"` or `scope: "task"` depending on confidence. If the Codex turn is
the whole Orchestrator task, the adapter may record it as task usage. Preserve
`final: false` while running and `final: true` only after `turn/completed` if
the usage is known to be settled.

Do not parse usage in `ps`. The protocol executor should update task usage as
events arrive. `ps`, `ps --watch`, and future TUI should read task summary
state.

## Logs and Transcripts

For process runtimes:

- stdout/stderr are the child process streams.
- transcript is structured runtime JSONL when available.

For protocol runtimes:

- stdout/stderr should be Orchestrator’s protocol adapter logs only when useful.
- raw provider protocol messages belong in `transcript.jsonl`.
- normalized task timeline belongs in `events.jsonl`.
- final answer belongs in `result.md`.

Do not dump raw JSON-RPC protocol messages into user-facing `logs` by default.
They are too noisy. Put them in transcript/events so debugging is possible.

## Heartbeats and Liveness

The current supervisor heartbeat model still applies. For a stdio protocol
runtime, the supervised child is the app-server process.

For a future remote protocol runtime, heartbeat should not be process-only. The
executor should provide a lightweight health signal:

```ts
type ExecutorHeartbeat = {
  kind: "process" | "protocol" | "remote";
  alive: boolean;
  lastMessageAt?: string;
  lastRequestAt?: string;
  lastResponseAt?: string;
};
```

This should feed the existing observed states: running, stopping, stale,
orphaned, lost. Do not create a separate state model for protocol runtimes
unless the current observed-state model fails.

## Config Implications

Do not expose full protocol adapter config to custom users immediately.

Current custom agents intentionally support only:

```json
{ "adapter": "process" }
```

The docs mention future:

```json
{ "adapter": "http" }
```

Protocol adapters are more complex and easier to misconfigure. For the first
release, make `codex-app-server` a built-in experimental runtime rather than a
generic public config schema.

Later, if another tool needs the same lifecycle, expose a limited protocol
schema.

Possible future config:

```json
{
  "agents": {
    "some-jsonrpc-agent": {
      "adapter": "protocol",
      "protocol": "jsonrpc",
      "transport": {
        "kind": "stdio",
        "command": "some-agent",
        "args": ["serve", "--stdio"]
      },
      "methods": {
        "initialize": "initialize",
        "startTask": "task/start",
        "interrupt": "task/interrupt"
      },
      "events": {
        "result": "task/completed",
        "usage": "task/usage"
      }
    }
  }
}
```

But do not build that until at least two real protocol tools need it. A bad
generic protocol schema can become worse than writing one dedicated adapter.

## Future Tool Support

A reusable protocol adapter is worthwhile if future tools share these traits:

- live session;
- explicit start/resume;
- request/response ids;
- server notifications;
- API-level interrupt;
- API-level steer;
- usage or progress events;
- durable external thread/session ids.

Examples that could fit:

- Codex app-server over stdio, Unix socket, or WebSocket;
- a local agent daemon exposing JSON-RPC;
- a remote agent daemon over WebSocket;
- a future Pi daemon if Pi exposes a live protocol service;
- a custom Flue service only if it exposes live session events rather than a
  one-shot command.

Examples that should not use protocol:

- simple custom wrapper commands;
- headless CLIs that print final text;
- remote services that only expose submit/status/result HTTP endpoints.

Those should stay `process` or future `http`.

## Implementation Options

### Option A: Codex Runner Process

Build a small Node runner binary:

```text
orchestrator-codex-app-server-runner "<task>"
```

The runner speaks Codex app-server protocol, then emits Orchestrator-compatible
JSONL to stdout. The existing process adapter consumes that JSONL.

Pros:

- fastest path;
- minimal changes to `launchTask(...)`;
- existing output adapter can parse normalized JSONL;
- easy to hide behind experimental runtime id.

Cons:

- API interrupt still awkward because Orchestrator only knows the runner
  process, not the Codex turn;
- thread/turn ids must be tunneled through JSONL events;
- duplicates parts of task supervision inside the runner;
- future protocol tools would likely need their own runner;
- does not solve the core adapter boundary.

Verdict: acceptable as a throwaway proof of concept, not the clean final
architecture.

### Option B: Task Executor Boundary

Refactor `launchTask(...)` so process execution is one executor and protocol
execution is another.

Pros:

- keeps task store, events, usage, `ps`, read/logs/events, interrupt, and parent
  tools unified;
- supports API interrupt cleanly;
- stores thread/turn ids directly in task metadata;
- gives future HTTP/protocol runtimes a real place to live;
- avoids one-off runner duplication.

Cons:

- more invasive than Option A;
- must preserve current process runtime behavior exactly;
- tests need careful coverage around lifecycle, cancellation, and output.

Verdict: recommended path.

### Option C: Separate Codex Service Manager

Build a long-lived Codex app-server pool and have tasks attach to it.

Pros:

- closer to how a TUI or daemon might eventually work;
- could reuse app-server process across tasks;
- better for persistent Codex threads.

Cons:

- too much for first adapter;
- introduces lifecycle, locking, cleanup, and crash-recovery questions;
- harder to reason about one task mapping to one external turn;
- makes task supervision less obvious.

Verdict: defer. Start per-task. Revisit when persistent sessions matter.

## Recommended Build Plan

### Phase 1: Define Executor Boundary

Move today’s process spawn lifecycle into a `ProcessTaskExecutor` without
changing behavior.

Deliverables:

- internal executor types;
- process executor;
- `launchTask(...)` delegates to process executor;
- all existing tests pass.

This is mostly architecture cleanup. It should not add Codex app-server yet.

### Phase 2: Add Provider Metadata

Add optional provider/session metadata to `AgentTaskRecord`.

Deliverables:

- `provider` or `external` metadata field;
- task JSON read/write support;
- `ps --json` includes metadata in machine output if useful;
- no change to human output yet.

### Phase 3: Codex JSON-RPC Client

Create a small internal JSON-RPC client for stdio.

Deliverables:

- start app-server process;
- send requests with ids;
- route responses;
- route notifications;
- preserve early turn notifications;
- drain stderr;
- close/kill robustly.

This should be tested with a fake JSON-RPC process before live Codex.

### Phase 4: Codex Protocol Executor

Add `codex-app-server` as an experimental built-in runtime.

Deliverables:

- `thread/start`;
- `turn/start`;
- notification normalization;
- final answer extraction;
- token usage extraction;
- `turn/interrupt`;
- fallback process kill;
- result/event/log files consistent with other tasks.

Keep existing `codex` runtime unchanged.

### Phase 5: Live Smoke Tests

Add opt-in live tests.

Examples:

```sh
RUN_CODEX_APP_SERVER_SMOKE=1 pnpm test
```

Smoke should cover:

- launch simple task;
- read final answer;
- observe thread/turn ids;
- see token usage when emitted;
- interrupt a long-running turn.

### Phase 6: Decide Whether To Generalize Public Config

Only after Codex works, decide if public `adapter: "protocol"` belongs in
`~/.orchestrator/config.json`.

Do not expose a generic protocol schema until another real protocol tool
requires it.

## Testing Strategy

Unit tests:

- JSON-RPC line parser;
- response routing by id;
- notification routing by turn id;
- early notification buffering;
- protocol error mapping;
- token usage mapping;
- final answer extraction.

Core tests:

- process executor still preserves current behavior;
- protocol executor writes task events in correct order;
- protocol executor stores provider metadata;
- protocol executor updates usage during run;
- protocol executor marks succeeded/failed/cancelled correctly;
- protocol interrupt calls API before process kill.

CLI tests:

- `launch codex-app-server` returns a task id;
- `ps` shows the task;
- `read` returns final output;
- `events` shows normalized protocol events;
- `interrupt` cancels through protocol path.

Live smoke:

- opt-in only;
- requires Codex installed/authenticated;
- uses cheap model when available.

## Risks

### Protocol Churn

Codex app-server is a richer and likely more active surface than `codex exec`.
Method names and payloads may change.

Mitigation: keep `codex` process runtime as the stable default. Mark
`codex-app-server` experimental until exercised.

### Over-Generalization

Building a generic protocol schema too early could create a bad abstraction.

Mitigation: implement Codex as a dedicated protocol runtime on top of a generic
executor/client foundation. Generalize public config later.

### Supervisor Regression

Changing `launchTask(...)` risks breaking stable process behavior.

Mitigation: first extract process execution with no behavior change. Keep tests
green before adding protocol.

### API Interrupt Semantics

`turn/interrupt` may return before all final notifications are written.

Mitigation: use bounded settling after interrupt, keep Orchestrator
`stopRequestedAt` state, and only mark terminal after the protocol reports
completion or the fallback kill resolves.

### Logs Become Confusing

Protocol runtimes can produce huge JSON-RPC streams.

Mitigation: keep raw protocol messages in `transcript.jsonl`; keep `events` as
the normalized timeline; keep `logs` for adapter/process diagnostics.

### Persistent Sessions

Per-task app-server processes are simpler but do not fully exploit Codex
persistent sessions.

Mitigation: start per-task. Add long-lived session support later only when
product needs it.

## What This Changes

This changes the internal runtime model from:

```text
runtime -> launch plan -> spawn process
```

to:

```text
runtime -> launch plan -> task executor -> task store/events/result
```

The CLI should not need a new mental model. Users still run:

```sh
orchestrator launch codex-app-server "Do the task."
orchestrator ps --watch
orchestrator read <task-id>
orchestrator interrupt <task-id>
```

The difference is that Orchestrator can now use richer control paths under the
hood when the runtime supports them.

## Recommendation

Build the protocol/session adapter as a core executor family, not as HTTP and
not as a permanent runner-process hack.

Start with Codex app-server as an experimental built-in runtime. Keep the
existing `codex exec` runtime as the stable default. Implement the internal
executor seam first, then add a Codex JSON-RPC client and protocol executor.

Do not expose generic custom `adapter: "protocol"` config until at least one
more real tool needs it. The reusable part should be the executor/client
foundation, not a premature public schema.
