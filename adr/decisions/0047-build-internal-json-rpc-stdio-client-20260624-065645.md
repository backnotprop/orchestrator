# 47. Build Internal JSON-RPC Stdio Client

Date: 2026-06-24

## Status

Accepted

## Context

ADR 46 extracted process execution into `ProcessTaskExecutor`, so
`launchTask(...)` no longer has to own every detail of how work runs. That gives
Orchestrator the internal boundary needed for protocol-backed runtimes.

The next needed capability is a reusable JSON-RPC stdio client. Codex app-server
is the first target, but the client should not be Codex-specific. It should be
generic enough to support future protocol tools while staying internal to the
runtime layer.

This is Slice 4 of the protocol runtime plan. It should build the pipe, not add
Codex app-server as a runtime yet.

## Decision

Build an internal JSON-RPC stdio client under the task executor/protocol code.

The client will:

- spawn a stdio protocol process;
- send JSON-RPC requests with ids;
- route responses back to the matching request;
- expose notifications to callers;
- support notification filtering by fields such as `threadId` and `turnId`;
- buffer early notifications that arrive before a task has subscribed;
- drain stderr so protocol processes do not block;
- close gracefully, then kill if graceful close fails;
- report protocol, spawn, parse, and close errors clearly;
- be tested against a fake server.

The client remains private implementation detail. We will not expose generic
public protocol runtime config in this slice.

## Consequences

Codex app-server work can build on a tested transport instead of mixing JSON-RPC
framing, process management, notification routing, and task execution in one
place.

This keeps Slice 5 smaller: Codex app-server can focus on initialize,
thread/start, turn/start, notification normalization, result extraction, usage
updates, and API interrupt.

The client must stay boring and practical. It should not become a public plugin
system, a generic SDK framework, or a long-lived process pool. Those can be
revisited only after the first protocol runtime works.
