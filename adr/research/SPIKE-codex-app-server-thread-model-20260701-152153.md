# Research Spike: Codex App-Server Thread Model

Date: 2026-07-01

## Question

Is Codex app-server actually built around one app-server process per task/thread,
or is it built around one long-lived app-server that can manage multiple threads?

## Short Answer

Codex app-server is built around a long-lived runtime that manages threads and
turns. A thread is the conversation/session unit; the app-server process is the
host.

Our current Orchestrator implementation, where a `codex-app-server` managed
session starts one stdio app-server process and owns one provider thread, is a
good first implementation. It should not be treated as the final Codex-native
architecture.

If Orchestrator later wants one Codex app-server managing many Codex threads,
the likely shape is not "pooling" app-server processes. It is a shared
app-server or daemon connector over Codex's Unix socket/app-server daemon path,
with Orchestrator managing provider thread lifecycle intentionally.

## Evidence From Codex

Codex documents app-server as the interface for rich clients such as the VS Code
extension, not just a one-shot CLI mode:
[README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:3).

The protocol exposes three core primitives: thread, turn, and item. Threads are
conversations, turns happen inside threads, and clients drive threads through
thread APIs:
[README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:64).

The lifecycle is connection-first, then thread-first:

- initialize once per transport connection.
- call `thread/start`, `thread/resume`, or `thread/fork`.
- call `turn/start` against that thread.
- stream notifications until `turn/completed`.

Reference:
[README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:74).

The supported transports make the split clear:

- `stdio://` is the default single-client path.
- Unix socket and websocket transports can keep a server process alive for
  local control-plane clients.

Reference:
[README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:24).

In the app-server implementation, stdio is explicitly `single_client_mode`, and
the server shuts down when the last stdio connection closes:
[lib.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/lib.rs:714),
[lib.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/lib.rs:1010).

For non-stdio transports, the process tracks connections in maps and routes
messages by connection. That is a server with connection state, not a one-thread
process:
[lib.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/lib.rs:822),
[lib.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/lib.rs:907).

The internal `ThreadManager` keeps loaded threads in a
`HashMap<ThreadId, Arc<CodexThread>>`, and exposes `list_thread_ids()` and
`get_thread()`:
[thread_manager.rs](/Users/ramos/oss-agents/codex/codex-rs/core/src/thread_manager.rs:236),
[thread_manager.rs](/Users/ramos/oss-agents/codex/codex-rs/core/src/thread_manager.rs:1081).

The app-server API exposes `thread/loaded/list`, which returns currently loaded
in-memory thread ids. The example response includes multiple thread ids:
[README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:428).

Loaded threads are not unloaded immediately when a client unsubscribes. Codex
keeps the thread loaded until it has no subscribers and no activity for 30
minutes:
[README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:455),
[thread_lifecycle.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/thread_lifecycle.rs:4).

Codex also has an experimental Unix-only app-server daemon. Its `start` command
is idempotent and returns once app-server is ready on the Unix control socket:
[README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server-daemon/README.md:84),
[lib.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server-daemon/src/lib.rs:302).

## What This Means For Orchestrator

The current `codex-app-server --session` path is:

- one Orchestrator task.
- one stdio Codex app-server child process.
- one Codex provider thread.
- many operations over that one thread while the task stays alive.

That is a deliberate v1 because it keeps task ownership, logs, events,
interrupts, and cleanup simple. It also matches stdio's single-client behavior.

But it is not the only model Codex supports. Codex's own server and thread
manager are shaped for a live app-server hosting multiple loaded threads.

The cleaner future model, if we need it, is:

- one long-lived Codex app-server process per machine/user/workspace boundary;
- Orchestrator connects over Unix socket or Codex's daemon path;
- Orchestrator creates/resumes many Codex threads in that process;
- each Orchestrator-managed task/session stores its provider `threadId`;
- task/session operations are routed to the right Codex thread.

That is not "pooling" in the usual sense of borrowing idle worker processes.
It is a shared app-server host with multiple provider threads.

## Recommendation

Keep the current per-session stdio implementation as the v1. It is simple and
correct for one managed Codex session, including normal messages and goal work
inside that session.

Do not finalize per-session stdio as the permanent Codex architecture. If
startup cost, many Codex sessions, or TUI/service usage become central, design a
shared Codex app-server connector around the Unix socket/daemon model.

Do not implement "multiple threads inside one stdio child process" as an
accidental half-step. If we manage multiple Codex threads through one server,
make that an explicit shared-server design with clear routing, lifecycle,
cleanup, and task ownership.

## Open Questions

- What should the shared-server boundary be: one per machine, one per user, one
  per workspace, or one per Orchestrator service?
- How should Orchestrator isolate thread-specific cwd/model/config while sharing
  one app-server process?
- Should each Orchestrator task map to one Codex thread, while operations map to
  turns/goals inside that thread?
- Should shared app-server support wait until after `codex-app-server --session`
  and goal operations are finished?
