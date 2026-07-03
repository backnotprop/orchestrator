# Research Spike: Codex App-Server Pooling

Date: 2026-07-01

## Summary

I did not find a Codex-designed app-server pooling abstraction. Codex treats app-server reuse as lifecycle management around a live runtime or live connection, not as a shared pool of reusable servers or processes.

What Codex does support is:

- one in-process runtime per caller handle;
- one remote websocket/Unix connection per client handle;
- one app-server process that can accept multiple connections and keep per-connection state;
- per-thread persistence inside that process while it is alive.

That is reuse of state inside a live server, not pooling of server instances across tasks.

## Relevant Files

- [codex-rs/app-server-client/README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server-client/README.md:10)
- [codex-rs/app-server-client/src/lib.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server-client/src/lib.rs:1)
- [codex-rs/app-server-client/src/remote.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server-client/src/remote.rs:4)
- [codex-rs/app-server/src/lib.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/lib.rs:437)
- [codex-rs/app-server/src/message_processor.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/message_processor.rs:215)
- [codex-rs/app-server/src/in_process.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/in_process.rs:1)
- [codex-rs/app-server/src/connection_rpc_gate.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/connection_rpc_gate.rs:11)
- [codex-rs/app-server/src/connection_cleanup.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/connection_cleanup.rs:8)
- [codex-rs/app-server-daemon/README.md](/Users/ramos/oss-agents/codex/codex-rs/app-server-daemon/README.md:1)
- [codex-rs/app-server-daemon/src/lib.rs](/Users/ramos/oss-agents/codex/codex-rs/app-server-daemon/src/lib.rs:229)
- [codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts](/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts:10)

## Findings

1. The in-process client facade is a single runtime handle, not a pool.
   It centralizes startup, request dispatch, and bounded shutdown. `start()` performs the initialize handshake and returns one ready handle; `shutdown()` tears that runtime down. There is no reuse API or manager that keeps a started runtime in a pool for later borrowers.

2. The remote client owns one connection lifecycle, not a reusable server lease.
   The remote wrapper explicitly says it owns the remote connection lifecycle, including initialize/initialized and notification streaming. `connect()` creates one connection and `shutdown()` closes it.

3. The server process can host multiple connections, but each connection gets isolated session state.
   `run_main_with_transport_options()` tracks `ConnectionOpened` and `ConnectionClosed` events, stores `ConnectionState` in a `HashMap`, and drives shutdown from `single_client_mode` only for stdio. WebSocket and Unix socket transports can coexist in one process, but Codex does not expose a server pool above that.

4. Internal state is process-scoped, not pool-scoped.
   `MessageProcessor` comments say the thread store is intentionally process-scoped. `ConnectionSessionState` is per-connection and guarded by a write-once `OnceLock`. `ConnectionRpcGate` and `ConnectionCleanupTasks` are drain/shutdown helpers for one connection, not shared pooling machinery.

5. The only "reuse" Codex encodes is reuse of live state inside the same process.
   Threads, listeners, background tasks, and config-derived state survive across turns and across connections while the app-server process remains alive. That is a long-lived server assumption, but it is not a server pool or process recycler.

6. Startup locking is about single-instance coordination, not pooling.
   The Unix-socket path acquires an app-server startup lock before preparing the socket path. That prevents startup races for one server instance; it does not create or manage reusable instances.

## Implications for Orchestrator

- Do not model Codex as providing a built-in reusable app-server pool.
- If Orchestrator wants pooling, it must own that policy outside Codex.
- The safe assumption is one Orchestrator task maps to one live Codex handle, with reuse only if Orchestrator keeps that handle open intentionally.
- Any shared-worker design must respect Codex's per-connection state, per-thread state, and shutdown semantics, especially around `thread/start`, `thread/resume`, approvals, and cleanup.

## Main-agent verification

I verified the sub-agent findings against the Codex source after the spike:

- `app-server-client/README.md` and `app-server-client/src/lib.rs` describe a
  single in-process client facade with startup, request/event routing,
  backpressure handling, and bounded shutdown. I found no lease manager or idle
  app-server pool there.
- `app-server-client/src/remote.rs` owns one remote connection lifecycle:
  connect, initialize, route requests/notifications, then shut down that
  connection. It is a client handle, not a pool abstraction.
- `app-server/src/lib.rs` treats stdio as `single_client_mode`; when the last
  stdio connection closes, the server shuts down. Unix socket and WebSocket
  transports can keep a server process alive across connections, but connection
  state is tracked per connection.
- `app-server-daemon/README.md` and `app-server-daemon/src/lib.rs` describe a
  Unix-only managed daemon for starting/stopping/restarting a long-lived
  app-server and remote-control support. That is daemon lifecycle management,
  not a generic reusable worker pool.
- `ThreadResumeParams.ts` documents that `thread/resume` can rejoin an already
  running thread by `threadId`. `thread/loaded/list` lists active in-memory
  thread ids. These are thread/session reuse surfaces, not process pooling.

Conclusion: Codex gives us reusable long-lived app-server and thread-resume
primitives, but not native pooling. If Orchestrator later reduces startup cost,
the clean path is to connect to a long-lived Codex app-server/daemon and manage
thread lifecycle intentionally. It should not assume Codex already owns an
app-server pool.

## Open Questions

- Does Orchestrator want to reuse a live Codex handle across multiple tasks, or only across multiple turns within one task?
- If a shared handle is reused, how will task-level config differences be isolated from Codex's process-scoped state?
- Should pooled usage be limited to a single thread per live Codex handle, given that Codex itself can carry multiple threads in one process?
- Is the real requirement reduced startup cost, or true multi-task multiplexing?
