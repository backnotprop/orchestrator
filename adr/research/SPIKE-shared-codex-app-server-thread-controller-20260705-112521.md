# Research Spike: Shared Codex App-Server Thread Controller

Date: 2026-07-05

## Question

What needs to change so a Claude Code agent using the Orchestrator CLI can
manage many Codex app-server threads through Orchestrator?

The desired user flow is:

```text
Claude Code -> orchestrator CLI -> one shared Codex app-server -> many Codex threads
```

Claude Code should only see Orchestrator commands and task ids. It should not
need to know Codex sockets, JSON-RPC request names, turn ids, or thread ids.

## Short Answer

Build a shared Codex app-server controller in Orchestrator.

The right model is:

- one shared Codex app-server process;
- many Codex provider threads inside that process;
- one Orchestrator task/session per Codex provider thread;
- one Orchestrator operation per Codex turn or Codex goal operation;
- Codex protocol details hidden behind `launch`, `send`, `goal`, `read`,
  `events`, `ps`, and `interrupt`.

This is not normal worker pooling. Codex does not expose a reusable
app-server-pool abstraction. Codex exposes a long-lived app-server that can
host multiple threads. Orchestrator should own the policy that maps those
threads to Orchestrator tasks.

## Current Orchestrator State

Orchestrator already has the product model needed for this:

- `TaskProviderMetadata` can store `transport`, `threadId`, `turnId`, and
  `connectionId` in
  `packages/core/src/tasks/types.ts`.
- `TaskSession` can represent `idle`, `turn_running`, `goal_running`,
  `stopping`, and `closed`.
- `TaskOperation` can represent a normal turn or goal operation.
- `send`, `goal start/get/set/clear`, `resume`, `read`, `events`, `ps`, and
  `interrupt` already work over the current `codex-app-server --session`
  surface.

The current implementation is still process-owned per task:

- Runtime config starts `codex app-server --listen stdio://` in
  `packages/core/src/runtime/runtimes.ts`.
- `CodexAppServerTaskExecutor` starts a `JsonRpcStdioClient` per task/session
  in `packages/core/src/tasks/executors/protocol/codex-app-server.ts`.
- `openCodexThread` stores `provider.transport: "stdio"`.
- `runCodexAppServerSession` keeps one stdio app-server process open while that
  one Orchestrator session is alive.
- `interrupt` on that session can safely kill that one process because no other
  task shares it.

That implementation is correct for isolated sessions. It is not the right
shape for many Codex threads managed from repeated CLI calls.

## Current Codex State

Codex app-server is built around `Thread`, `Turn`, and `Item`.

Codex documents the lifecycle as:

1. initialize a transport connection;
2. call `thread/start`, `thread/resume`, or `thread/fork`;
3. call `turn/start` against a thread;
4. stream notifications;
5. finish with `turn/completed` or `turn/interrupt`.

Relevant Codex references:

- `/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server/src/lib.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-transport/src/transport/mod.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-transport/src/transport/unix_socket.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/core/src/thread_manager.rs`

Important facts:

- `stdio://` is the default transport.
- `stdio://` is single-client mode.
- The app-server shuts down when the stdio connection closes.
- `unix://` is explicitly documented for local app-server control-plane
  clients.
- Unix socket transport accepts websocket connections over a Unix domain
  socket.
- Non-stdio transports do not shut the app-server down just because one client
  disconnects.
- Codex can keep loaded threads in one app-server process.
- `thread/unsubscribe` unsubscribes a connection from thread events and Codex
  keeps the thread loaded until idle unload policy runs.
- `thread/loaded/list` lists loaded thread ids.
- `turn/start`, `turn/steer`, and `turn/interrupt` operate against thread and
  turn ids.
- `thread/goal/set`, `thread/goal/get`, and `thread/goal/clear` operate against
  a provider thread.

This confirms the shared-server model is aligned with Codex's app-server design.

## Why Unix Socket

The Orchestrator CLI is process-shaped: each command starts, does work, prints
output, and exits.

That does not fit shared `stdio://`.

With `stdio://`, the client connection is stdin/stdout. If the Orchestrator CLI
exits, the pipe closes. Codex app-server sees the connection close, and because
stdio is single-client mode, the server exits. To share `stdio://`, Orchestrator
would need a separate long-lived daemon whose only job is to keep the stdio pipe
open and multiplex requests. That is more awkward than using the transport Codex
already provides for local control-plane clients.

With `unix://`, Orchestrator can:

- ensure a Codex app-server is running;
- connect for one CLI command;
- initialize that connection;
- start, resume, read, steer, interrupt, or run a goal on a specific thread;
- disconnect without killing the app-server;
- reconnect from the next CLI command.

Codex's Unix socket transport is websocket-over-unix, not plain JSONL. Our
current `JsonRpcStdioClient` cannot talk directly to it. We need either:

- a new internal JSON-RPC websocket client that supports Unix sockets; or
- a transport abstraction under the current JSON-RPC client with stdio and
  websocket-over-unix implementations.

Do not hand this socket detail to Claude Code. Claude Code should keep using:

```sh
orchestrator launch codex-app-server --session
orchestrator send <id> --wait "..."
orchestrator goal start <id> --wait "..."
orchestrator interrupt <id>
```

## Required Orchestrator Changes

### 1. Add a Shared Codex App-Server Controller

Add a core module under the protocol runtime area, shaped like:

```text
packages/core/src/tasks/executors/protocol/codex-app-server-controller.ts
```

Responsibilities:

- resolve the app-server socket path;
- ensure `codex app-server --listen unix://...` is running;
- wait until the socket accepts connections;
- open an initialized JSON-RPC connection;
- expose request helpers for thread, turn, goal, read, and unsubscribe calls;
- normalize Codex notifications into Orchestrator events;
- report server pid/socket/version metadata when available.

This controller is infrastructure. It is not a user-visible task.

### 2. Add JSON-RPC Websocket-Over-Unix Transport

The current protocol client is stdio-specific:

```text
packages/core/src/tasks/executors/protocol/json-rpc-stdio.ts
```

Shared app-server needs a transport that can speak one JSON-RPC message per
websocket text frame over a Unix domain socket.

Recommendation:

- keep the existing stdio client intact;
- extract shared request/response/notification routing if useful;
- add a narrow websocket-over-unix client with the same high-level API:
  `request`, `notify`, `subscribeNotifications`, `close`;
- use a small websocket dependency instead of manually implementing websocket
  framing.

### 3. Separate Task Ownership From Process Ownership

Today a `codex-app-server --session` task owns the app-server child process.
With shared app-server, the task owns a Codex thread, not the app-server
process.

That changes the meaning of a task:

- task id: Orchestrator handle for one Codex thread/session;
- provider thread id: Codex handle inside the shared app-server;
- operation id: one normal turn or goal operation;
- app-server pid/socket: shared infrastructure metadata.

`interrupt <task>` must not kill the shared app-server. It should:

- interrupt the active turn when there is one;
- close or unsubscribe the task/session when idle;
- mark the Orchestrator task closed/cancelled only for that session;
- leave unrelated Codex threads running.

### 4. Route Events By Thread And Turn

A shared server means many threads can emit events through one server process.
Orchestrator must never mix them.

Routing rules:

- task lookup is by Orchestrator task id;
- provider routing is by Codex `threadId`;
- active operation routing is by Codex `turnId` when a turn exists;
- goal updates route by `threadId`;
- thread status changes route by `threadId`;
- unknown-thread events go to diagnostic logs, not another task.

Tests need to prove two Codex threads can run at the same time and their
events/results do not cross.

### 5. Use Thread Lifecycle Explicitly

The session commands should map to Codex like this:

```text
launch codex-app-server --session
  -> ensure shared app-server
  -> connect
  -> initialize
  -> thread/start
  -> store provider.threadId and provider.transport="unix"
  -> thread/unsubscribe or keep watch subscription only while command needs it

send <task> --wait "work"
  -> connect
  -> initialize
  -> thread/resume or use loaded thread
  -> if idle: turn/start
  -> if active regular turn: turn/steer
  -> wait for turn/completed when --wait is set
  -> write operation result

goal start <task> --wait "goal"
  -> connect
  -> initialize
  -> thread/resume/read
  -> thread/goal/set
  -> wait for goal updates / terminal state when --wait is set

interrupt <task>
  -> connect
  -> initialize
  -> if active turn: turn/interrupt(threadId, turnId)
  -> if idle: unsubscribe/close Orchestrator session state
```

### 6. Decide The Server Boundary

The clean boundary is one shared Codex app-server per user/Codex home.

Reasoning:

- Codex already resolves default `unix://` under `CODEX_HOME`.
- Auth, model access, config, and persisted thread store are Codex-home scoped.
- A machine-wide Orchestrator can manage tasks across many repositories while
  keeping one Codex provider home.

Task-specific differences should be passed at thread/turn level:

- `cwd`;
- `model`;
- sandbox or permissions profile;
- runtime workspace roots when needed.

If a task requires incompatible process-level Codex config, Orchestrator should
start or select a separate app-server boundary explicitly. Do not silently mix
incompatible process-level settings inside one shared server.

## What This Enables

For Claude Code:

```text
Human: launch five Codex agents to inspect these repos
Claude Code:
  orchestrator launch codex-app-server --session --name "repo a"
  orchestrator launch codex-app-server --session --name "repo b"
  orchestrator send <a> --wait "Inspect performance bottlenecks."
  orchestrator goal start <b> --wait "Improve test coverage."
  orchestrator ps --watch
```

Claude Code manages Orchestrator task ids. Orchestrator manages Codex thread
ids and socket details.

For humans:

```sh
orchestrator ps --watch
orchestrator read <task-id>
orchestrator events <task-id> --agent-only
orchestrator interrupt <task-id>
```

The commands remain the product surface.

## Main Risks

- Websocket-over-unix support adds a real transport dependency or a new
  protocol implementation.
- Shared app-server death affects many Codex tasks at once.
- Event routing bugs could mix outputs between tasks.
- Process-level config mismatch can create surprising behavior if not modeled.
- Approval/server requests must be handled per connection and not block
  unrelated work.
- Interrupt fallback cannot use process kill as a per-task action.
- Thread unload/cleanup needs explicit policy through `thread/unsubscribe` and
  Orchestrator session closure.

These are manageable risks, but they make this a real architecture change, not
a small executor patch.

## Recommended Build Slices

1. **Transport foundation**
   Add JSON-RPC websocket-over-unix client tests against a fake server. Keep the
   existing stdio client working.

2. **Shared controller**
   Add a Codex app-server controller that can ensure/connect/initialize/read
   against a Unix socket and list loaded threads.

3. **Thread-backed task mode**
   Add a task execution mode where a task owns a provider thread instead of a
   child process. Store `provider.transport = "unix"` and shared server
   metadata.

4. **Move session launch/send/read**
   Make `codex-app-server --session`, `send`, `read`, and `events` work through
   the shared controller for one thread.

5. **Goals and interrupts**
   Move `goal start/get/set/clear` and `interrupt` onto the shared controller.
   Prove interrupting one task does not stop other threads.

6. **Multi-thread smoke**
   Run multiple Codex app-server sessions in parallel, verify `ps --watch`,
   token usage, events, reads, goals, and interruption.

## Decision Pressure

Existing ADRs intentionally chose isolated stdio sessions first:

- `adr/decisions/0054-use-persistent-codex-app-server-sessions-for-goal-work-20260701-104716.md`
- `adr/decisions/0055-hide-provider-turn-mechanics-behind-session-operations-20260704-094016.md`
- `adr/research/SPIKE-codex-app-server-thread-model-20260701-152153.md`

Those decisions remain valid as completed stepping stones. The new product
target changes the next step: Orchestrator should move from isolated
app-server-per-session to a shared Codex app-server controller over Unix socket.

Do not expose this as "pooling" in the CLI. Expose it as normal Orchestrator
session behavior:

```sh
orchestrator launch codex-app-server --session
orchestrator send <task-id> --wait "..."
orchestrator goal start <task-id> --wait "..."
```

## Open Questions

- Use Codex's default `unix://` socket path or an Orchestrator-owned explicit
  socket path?
- Add a dependency-backed websocket client or implement a minimal internal
  websocket-over-unix transport?
- Should idle `interrupt <task>` close an Orchestrator session, or should we add
  a clearer `close` command for persistent sessions?
- How should Orchestrator represent shared server health in `doctor` and `ps`?
- How should app-server restart reconcile tasks whose provider threads still
  exist in Codex's persisted store?
