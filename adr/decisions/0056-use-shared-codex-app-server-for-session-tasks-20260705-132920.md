# 0056. Use Shared Codex App-Server For Session Tasks

Date: 2026-07-05

## Status

Accepted

## Context

Orchestrator already supports Codex app-server sessions, normal session
messages, native Codex goals, reads, events, token usage, and interrupts. That
work proved the right product language: tasks, sessions, operations, send,
goal, read, events, ps, and interrupt.

The current implementation still starts one `codex app-server --listen
stdio://` process per `codex-app-server --session` task. That is simple and
isolated, but it is the wrong shape for the product target where Claude Code, a
human, or another agent uses Orchestrator to manage many Codex app-server
sessions at once.

Codex app-server is designed as a long-lived server that can host many provider
threads. Its `stdio://` transport is single-client and exits when the stdio
connection closes. Its `unix://` transport is the local control-plane transport
for clients that connect, initialize, operate on threads, disconnect, and
reconnect later.

Recent research and specs established that the right shape is not a public
"pooling" feature. The right shape is one shared Codex app-server process with
one Orchestrator task/session per Codex provider thread.

## Decision

Use a shared Codex app-server over `unix://` for `codex-app-server --session`
tasks.

Orchestrator will keep the existing user-facing commands:

```sh
orchestrator launch codex-app-server --session
orchestrator send <task-id> --wait "..."
orchestrator goal start <task-id> --wait "..."
orchestrator read <task-id>
orchestrator events <task-id> --agent-only
orchestrator ps --watch
orchestrator interrupt <task-id>
```

Internally, Orchestrator will map those commands to Codex app-server protocol
calls:

- launch session: ensure shared app-server, initialize a connection,
  `thread/start`, store `provider.threadId`, and mark the Orchestrator session
  idle.
- send to idle session: `turn/start`.
- send to active regular turn: `turn/steer`.
- goal work: `thread/goal/set`, `thread/goal/get`, and `thread/goal/clear`.
- interrupt: `turn/interrupt` for active work, or close the Orchestrator
  session when idle.

The shared app-server process is infrastructure, not a user-visible task.
Claude Code and other parent agents will manage Orchestrator task ids. Codex
socket paths, thread ids, turn ids, and JSON-RPC methods stay internal.

Use Codex's daemon lifecycle as the primary app-server ensure path:

```sh
codex app-server daemon start
```

This command is idempotent, waits until the Unix control socket can answer the
normal initialize handshake, and reports socket/version information as JSON.

Add provider-backed task supervision for shared sessions. Process-backed tasks
keep the current heartbeat and PID model. Shared Codex sessions are observed
through provider metadata and app-server reachability, because the Orchestrator
task owns a provider thread rather than a child process.

## Consequences

`codex-app-server --session` becomes the high-quality path for many managed
Codex sessions. Launching five Codex sessions means five Orchestrator tasks and
five Codex provider threads, not five app-server processes.

The implementation must add:

- a JSON-RPC websocket-over-unix client;
- a shared Codex app-server controller;
- provider-backed task supervision;
- shared-session launch, send, read, events, goals, and interrupt paths;
- strict event routing by `threadId` and `turnId`;
- fake multi-session tests and opt-in live smoke.

Interrupt semantics change for shared Codex sessions. Interrupting one
Orchestrator session must never kill the shared app-server or stop unrelated
Codex sessions.

Existing isolated stdio-backed Codex app-server tasks remain readable. One-shot
`codex-app-server "<task>"` can stay on the isolated stdio path unless we
explicitly move it.

The relevant planning artifacts are:

- `adr/research/SPIKE-shared-codex-app-server-thread-controller-20260705-112521.md`
- `adr/research/synthesis-shared-codex-app-server-thread-controller-20260705-114539.md`
- `adr/specs/shared-codex-app-server-thread-controller-20260705-114539.md`
