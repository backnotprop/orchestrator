# 53. Send Messages To Running Codex App-Server Tasks Through File-Backed Control Requests

Date: 2026-06-30

## Status

Accepted

## Context

Codex app-server supports native live steering through `turn/steer`. That call
adds user input to an already-running regular turn. It requires the active
`threadId`, the active `turnId`, and input text.

Orchestrator already records `threadId` and `turnId` for `codex-app-server`
tasks. The executor already owns the live JSON-RPC client and already uses
native app-server control for `turn/interrupt`.

The issue is process shape. Background Orchestrator tasks run in detached task
runner processes. A later CLI process can read task files, but it cannot call
the live in-memory JSON-RPC client owned by the detached task runner.

We considered a socket-style control channel, but the current Orchestrator task
store is file-backed. Adding sockets would introduce listener lifecycle,
cleanup, stale socket, permission, and platform edge cases before we need them.

References:

- `adr/research/SPIKE-codex-app-server-steering-20260630-195440.md`
- `adr/research/synthesis-codex-app-server-steering-20260630-232736.md`
- `adr/specs/codex-app-server-steering-20260630-232736.md`
- `adr/decisions/0006-treat-subagents-as-durable-asynchronous-task-sessions.md`
- `adr/decisions/0052-enable-task-shaped-resume-for-codex-app-server-20260630-163334.md`

## Decision

Add a generic running-task message operation and expose it as:

```sh
orchestrator send <task-id|prefix> "<message>"
```

Use product language around sending a message to a running task. Do not expose
Codex's `turn/steer` terminology as the primary user-facing concept.

Implement the cross-process control path with file-backed task control
requests:

```text
.orchestrator/tasks/<task-id>/control/requests/<request-id>.json
.orchestrator/tasks/<task-id>/control/responses/<request-id>.json
.orchestrator/tasks/<task-id>/control/processed/<request-id>.json
```

The CLI writes a control request. The detached task runner polls its own
control request directory while the task is active, handles the request through
the live executor handle, writes a response, and keeps the handled request for
debugging.

Extend the task executor handle with an optional send-message operation.
`codex-app-server` will implement it first by calling:

```text
turn/steer { threadId, expectedTurnId, input }
```

Process runtimes and other unsupported runtimes should fail clearly instead of
pretending they can accept live messages.

After the core and CLI path are working, expose the same capability to the
parent agent as:

```text
send_agent_message
```

This decision does not add sockets, app-server pooling, Codex goals,
cross-process app-server rejoin, public protocol custom-agent config, or a
service daemon.

## Consequences

Humans and agents will be able to send follow-up instructions to a running
`codex-app-server` task without starting a new task or a new Codex turn.

The implementation stays aligned with Orchestrator's current file-backed task
model. It gives us deterministic cross-process control with an audit trail and
keeps tests simple.

The feature adds a new internal control-request path under task directories.
The runner process must poll and handle requests while active. The core API
must distinguish unsupported, not-running, not-ready, stale, orphaned, lost,
timeout, provider-rejected, and turn-mismatch failures.

The first supported runtime is `codex-app-server`. Other runtimes can opt in
later if they expose a real live-message API.

If Orchestrator later becomes a long-lived service, sockets or a stronger IPC
transport can be reconsidered. That is a separate decision.
