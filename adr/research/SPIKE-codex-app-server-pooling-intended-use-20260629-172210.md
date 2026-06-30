# Research Spike: Codex App-Server Pooling Intended Use

Date: 2026-06-29

Sub-agent: Pascal

## Question

Is `codex app-server --listen stdio://` intended to be a long-lived reusable
app-server process for multiple tasks, turns, or threads, or is Orchestrator's
current one-app-server-per-task model closer to the intended design?

## Short Answer

Codex app-server is designed as a stateful app/session server that can manage
multiple threads and turns over a live connection. Codex itself also has
daemon/reconnect-style usage for non-stdio transports.

However, `stdio://` is the single-client transport. It exits when the stdio
connection closes. A long-lived reusable `stdio://` server is possible only if
Orchestrator keeps one client connection open and implements correct
multiplexing, cleanup, and cancellation.

Orchestrator's current one-app-server-per-task model is not the full Codex
app-server design, but it is the safer first slice and matches Orchestrator's
current ADRs/specs. For pooling, prefer an explicit pool/daemon design, not an
accidental shared stdio process.

## Evidence With File References

- Codex app-server is documented as a JSON-RPC service for rich clients, with
  `Thread`, `Turn`, and `Item` primitives. Threads contain multiple turns.
  Clients create/list/archive threads and drive turns through turn APIs:
  [`codex-rs/app-server/README.md`](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:20),
  [`codex-rs/app-server/README.md`](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:64).
- The documented lifecycle is connection handshake, `thread/start` or
  `thread/resume`, `turn/start`, stream notifications, then `turn/completed` or
  `turn/interrupt`:
  [`codex-rs/app-server/README.md`](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:74).
- `stdio://` is the default transport, but Unix socket is explicitly for local
  app-server control-plane clients, and proxy opens one raw stream to the
  control socket:
  [`codex-rs/app-server/README.md`](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:24),
  [`codex-rs/app-server/README.md`](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:39).
- In code, stdio is treated as `single_client_mode`.
  `shutdown_when_no_connections` is true only for stdio, and the server exits
  after the last stdio connection closes:
  [`app-server/src/lib.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/lib.rs:714),
  [`app-server/src/lib.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/lib.rs:992).
- Stdio creates exactly one connection, reads newline JSON until stdin EOF, then
  emits `ConnectionClosed`:
  [`stdio.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server-transport/src/transport/stdio.rs:24),
  [`stdio.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server-transport/src/transport/stdio.rs:49).
- The app-server has process-scoped thread state and store. Comments say the
  thread store is intentionally process-scoped:
  [`message_processor.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/message_processor.rs:333).
- Requests can run concurrently unless their protocol scope requires
  serialization. Serialization keys include global, thread, path, process, and
  watch scopes:
  [`message_processor.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/message_processor.rs:895),
  [`request_serialization.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_serialization.rs:18).
- `thread/start`, `thread/resume`, and `thread/fork` are first-class APIs.
  `thread/unsubscribe` keeps idle unsubscribed threads loaded for 30 minutes
  before unload:
  [`codex-rs/app-server/README.md`](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:140),
  [`codex-rs/app-server/README.md`](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:162),
  [`thread_lifecycle.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/thread_lifecycle.rs:4).
- `turn/start` starts a turn on a target thread. `turn/steer` only adds input
  to an existing active steerable turn. `turn/interrupt` validates the active
  turn id and replies when abort completes:
  [`turn_processor.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/turn_processor.rs:442),
  [`turn_processor.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/turn_processor.rs:849),
  [`turn_processor.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/turn_processor.rs:1343).
- Codex TUI can reuse a local daemon only when launch config is replayable.
  Comments note a reused daemon cannot adopt the invocation's full config:
  [`tui/src/lib.rs`](/Users/ramos/oss-agents/codex/codex-rs/tui/src/lib.rs:801),
  [`tui/src/lib.rs`](/Users/ramos/oss-agents/codex/codex-rs/tui/src/lib.rs:837).
- Orchestrator currently spawns `codex app-server --listen stdio://`,
  initializes, starts one ephemeral thread, starts one turn, waits for
  completion, then closes the client:
  [`codex-app-server.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:142),
  [`codex-app-server.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:227),
  [`codex-app-server.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:240),
  [`codex-app-server.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:264),
  [`codex-app-server.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:323).
- Orchestrator docs/specs explicitly say each task starts its own app-server
  process and there is no pooling yet:
  [`doc/codex-app-server.md`](/Users/ramos/oss-agents/pi-research/doc/codex-app-server.md:46),
  [`protocol-session-adapter-20260624-054713.md`](/Users/ramos/oss-agents/pi-research/adr/specs/protocol-session-adapter-20260624-054713.md:240),
  [`codex-app-server-executor-20260624-084406.md`](/Users/ramos/oss-agents/pi-research/adr/specs/codex-app-server-executor-20260624-084406.md:18).

## Lifecycle Model

Codex app-server is process-scoped and connection-scoped. A connection
initializes once, then issues requests. The process owns thread managers,
stores, background tasks, request serialization queues, outbound routing, and
loaded thread state. A thread may live across multiple turns, may be
resumed/forked, and may remain loaded after a connection unsubscribes. Shutdown
drains RPC gates, cleanup tasks, background tasks, and threads unless forced.

For `stdio://`, the transport is single-connection. Keeping stdin/stdout open
keeps the server usable. Closing stdin causes connection close; because stdio
runs in single-client mode, the app-server shuts down.

## Pooling Implications

Pooling is compatible with Codex's app-server architecture, but it changes
Orchestrator's responsibilities. A pooled client must allocate unique JSON-RPC
ids, route notifications by `threadId`/`turnId`, handle server-initiated
approval requests, use `thread/unsubscribe`, avoid concurrent starts on the same
thread, distinguish `turn/start` from `turn/steer`, and send `turn/interrupt`
to the exact active turn before any process-level kill.

A pooled `stdio://` process would be one shared client connection. That is
workable for a controlled internal pool but not equivalent to multiple clients.
For multiple independent clients, Codex's Unix socket daemon path is a better
fit than shared stdio.

## Risks

- Cross-task notification bleed if routing is not strict by thread and turn.
- Request id collisions or response misrouting in a shared connection.
- Approval/server requests can block unrelated pooled work if not handled.
- Process-level fallback kill would terminate every task sharing that
  app-server.
- Reused daemon/process config may not match a later task's cwd, model,
  sandbox, config overrides, or managed requirements.
- Usage events are thread/turn-scoped and may be replayed on resume;
  attribution must be explicit.
- Idle thread unload is delayed, so pooling needs cleanup policy and
  memory/resource monitoring.
- Codex app-server protocol is still active and Orchestrator already documents
  protocol churn as a risk.

## Recommendation For Orchestrator

Keep the current one-app-server-per-task runtime as the launch-safe default. It
matches the documented Orchestrator slice, keeps failure isolation simple, and
avoids premature pooling architecture.

If startup cost becomes material, build pooling as a deliberate second design.
Prefer a pool manager that uses Codex's daemon/Unix transport or a controlled
long-lived stdio worker, starts one ephemeral thread per Orchestrator task,
routes all events by thread/turn, sends `thread/unsubscribe` after completion,
and never uses process kill as the first interrupt path for shared workers.

## Unknowns

- Whether upstream intends external headless tools to pool `stdio://`
  specifically, versus using Unix socket or in-process clients.
- Stable guarantees for protocol versioning and notification shapes.
- Best cleanup policy for ephemeral pooled threads beyond unsubscribe plus
  delayed unload.
- How pooled workers should handle tasks with different config, cwd, sandbox,
  model, auth, or managed-policy requirements.
- Whether Orchestrator should eventually support thread resume/goals on pooled
  app-server workers or keep every task as an isolated ephemeral thread.
