# Synthesis: Shared Codex App-Server Thread Controller

Date: 2026-07-05

## Bottom Line

The right next architecture is clear:

```text
Claude Code -> orchestrator CLI -> shared Codex app-server -> many Codex threads
```

Keep the Orchestrator CLI and parent-agent tools as the only user-facing
surface. Move Codex app-server session execution behind that surface from
`stdio://` per task to `unix://` shared app-server plus one Codex thread per
Orchestrator session.

Do not expose Codex sockets, thread ids, turn ids, or protocol methods to the
parent agent.

## What We Know

Codex app-server is built around a long-lived server process that owns threads
and turns. A thread is the session unit. A turn or goal is the work unit inside
that session.

Codex does not provide a generic app-server pool. It provides:

- a server that can hold multiple loaded threads;
- a Unix socket transport for local control-plane clients;
- thread APIs: `thread/start`, `thread/resume`, `thread/read`,
  `thread/unsubscribe`;
- turn APIs: `turn/start`, `turn/steer`, `turn/interrupt`;
- goal APIs: `thread/goal/set`, `thread/goal/get`, `thread/goal/clear`.

`stdio://` is the wrong shared-CLI transport. It is single-client mode and the
server exits when the stdio connection closes. That worked for the isolated
first implementation, but it does not match repeated CLI commands managing many
threads.

`unix://` is the right transport for this architecture. It lets Orchestrator
connect, initialize, operate on one thread, disconnect, and reconnect later
without killing the server.

## What Already Exists In Orchestrator

The product model is already in place:

- tasks;
- sessions;
- operations;
- provider metadata;
- `send`;
- `goal start/get/set/clear`;
- `read`;
- `events`;
- `ps`;
- `interrupt`.

The missing piece is the execution boundary. Today a persistent
`codex-app-server --session` task owns a child app-server process. The new model
needs the task to own a Codex thread while the app-server process is shared
infrastructure.

## Main Design Decision

Make `codex-app-server --session` use shared Codex app-server execution.

Keep one-shot `codex-app-server "<task>"` on the current isolated stdio path
unless we explicitly decide to move it too. The immediate product problem is
long-lived sessions that can be managed by Claude Code and humans through
repeated CLI commands.

The shared session shape is:

- app-server process: shared infrastructure;
- Orchestrator task: one managed Codex thread;
- session state: idle, turn running, goal running, stopping, closed;
- operation state: one turn or one goal;
- provider metadata: `transport: "unix"`, `threadId`, active `turnId` when
  present.

## Required Implementation Shift

The largest internal shift is not the socket. It is task supervision.

A shared Codex session task will be `running` even when no Orchestrator child
process is alive for that task. Current observation logic expects a supervised
process heartbeat for running tasks. That would incorrectly mark shared provider
sessions as stale.

So the implementation must add provider-backed supervision:

- process-backed tasks keep the current heartbeat and PID checks;
- shared Codex sessions are observed through provider metadata and app-server
  reachability;
- `send`, `goal`, and `interrupt` connect to Codex directly instead of writing
  control requests to a per-task background runner.

This is the key design point. Without it, the shared server design will fight
the current process-supervision model.

## Server Lifecycle

Use Codex's own local daemon lifecycle as the primary server ensure path:

```sh
codex app-server daemon start
```

Reasons:

- it is idempotent;
- it waits until app-server can answer the normal initialize handshake;
- it reports socket path and version as JSON;
- it serializes lifecycle operations per `CODEX_HOME`;
- it starts app-server with `--listen unix://`.

For tests and development, the controller can support an explicit socket path
or fake server. The public Orchestrator CLI should not expose socket mechanics
as the normal workflow.

## Command Mapping

The user-facing commands stay the same:

```sh
orchestrator launch codex-app-server --session --name "repo worker"
orchestrator send <task-id> --wait "Inspect the API."
orchestrator goal start <task-id> --wait "Improve performance by 10%."
orchestrator read <task-id>
orchestrator events <task-id> --agent-only
orchestrator interrupt <task-id> --reason "done"
```

Internal Codex mapping:

- `launch --session` -> ensure app-server, initialize connection,
  `thread/start`, store `threadId`, unsubscribe or close connection.
- `send` on idle session -> connect, initialize, `thread/resume` or
  `thread/read`, `turn/start`.
- `send` on active regular turn -> connect, initialize, `turn/steer`.
- `goal start` -> connect, initialize, `thread/goal/set`, wait for goal
  terminal state when requested.
- `interrupt` -> connect, initialize, `turn/interrupt` for active work; close
  the Orchestrator session when idle.

## Main Risks

- Websocket-over-unix is a new transport in Orchestrator.
- Shared app-server failure affects multiple Codex sessions.
- Event routing must be strict by `threadId` and `turnId`.
- Process-level config mismatch must not be hidden.
- The current stale/orphan/lost observation logic needs a provider-backed path.
- `interrupt` must not kill the shared app-server as a per-task fallback.

These risks are real but contained. The current Orchestrator task/session model
is strong enough to support this.

## Recommended Path

Build this in slices:

1. JSON-RPC websocket-over-unix transport.
2. Codex app-server controller.
3. Provider-backed session task records and observation.
4. Wire `codex-app-server --session`, `send`, `read`, and `events`.
5. Wire goals and interrupts.
6. Multi-thread fake tests and opt-in live smoke.
7. Docs/help/skill update.

This is a real architecture change, but it is not a rewrite. The CLI contract,
task store, session model, operation model, compact JSON, and parent-agent tools
remain the foundation.

## References

- `adr/research/SPIKE-shared-codex-app-server-thread-controller-20260705-112521.md`
- `adr/research/SPIKE-codex-app-server-thread-model-20260701-152153.md`
- `adr/research/SPIKE-codex-app-server-pooling-20260701-072738.md`
- `adr/research/SPIKE-codex-app-server-pooling-intended-use-20260629-172210.md`
- `adr/decisions/0054-use-persistent-codex-app-server-sessions-for-goal-work-20260701-104716.md`
- `adr/decisions/0055-hide-provider-turn-mechanics-behind-session-operations-20260704-094016.md`
