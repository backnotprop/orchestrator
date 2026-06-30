# 48. Add Codex App-Server Protocol Executor

Date: 2026-06-24

## Status

Accepted

## Context

ADR 46 introduced the task executor boundary and moved current process execution
behind `ProcessTaskExecutor`. ADR 47 added the internal JSON-RPC stdio client
needed to talk to protocol-backed agent services.

The next missing capability is a real protocol runtime. Codex app-server is the
first target because it exposes a JSON-RPC app-server surface over stdio:
initialize a connection, start a thread, start a turn, receive notifications,
track token usage, and request interruption.

The existing `codex` runtime should remain the stable `codex exec` process
runtime. Codex app-server has a different lifecycle and should not be forced
into stdout parsing or treated as a different output mode.

## Decision

Add `codex-app-server` as the first protocol-backed runtime.

The runtime will:

- use `codex app-server --listen stdio://`;
- initialize the JSON-RPC connection;
- start one ephemeral Codex thread per Orchestrator task;
- start one Codex turn with the Orchestrator task prompt;
- store Codex `threadId` and `turnId` in task provider metadata;
- route and buffer notifications through the internal JSON-RPC stdio client;
- respond to server-initiated JSON-RPC requests, starting with approval
  callbacks that Codex app-server can send during a turn;
- write raw protocol notifications to `transcript.jsonl`;
- normalize useful protocol notifications into existing task events;
- extract the final answer from completed Codex agent-message items;
- update task token usage from `thread/tokenUsage/updated`;
- make the result readable through the existing `read` command;
- keep the task visible through existing `ps`, `events`, `logs`, and `watch`
  surfaces.

Add an internal execution kind to runtime plans so `launchTask(...)` can choose
between process and protocol executors:

```ts
type RuntimeExecutionKind = "process" | "protocol";
```

Existing runtimes and custom process agents default to `process`. Public custom
protocol config is not exposed in this decision.

Use ephemeral Codex threads for this first version. Persisted Codex threads,
goals, pooling, and broader protocol custom-agent configuration are later
decisions.

## Consequences

Orchestrator gains its third execution capability: managed process agents,
future remote/http-style agents, and now protocol-backed agents.

The user-facing command model stays stable. Users and parent agents still use
`launch`, `ps`, `read`, `events`, `logs`, `watch`, and `interrupt`; the runtime
executor decides how the work actually runs.

The executor context will need enough supervisor-owned helpers for protocol
executors to write result files, transcript lines, normalized events, usage, and
provider metadata without duplicating task-store logic.

The JSON-RPC stdio client needs one more small capability before the executor is
safe for real Codex turns: messages with both `method` and `id` are server
requests and must be answered. Otherwise approval callbacks can leave a task
waiting forever.

Normal tests should use a fake Codex app-server. Live Codex app-server smoke
tests should be opt-in only.

Full API interruption hardening is intentionally separate. This slice may make a
basic `turn/interrupt` attempt, but robust interruption behavior, terminal-state
settling, and parent/group cancellation semantics belong in the next slice.
