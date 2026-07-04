# 0055. Hide Provider Turn Mechanics Behind Session Operations

Date: 2026-07-04

## Status

Accepted

## Context

Codex app-server exposes useful protocol primitives such as `turn/start`,
`turn/steer`, `thread/goal/set`, and `thread/settings/update`. Those primitives
matter for Orchestrator's runtime implementation, but they are the wrong mental
model for the main Orchestrator agent.

The main Orchestrator agent needs to coordinate other agents. It should not need
to decide whether a provider call is a new turn, a steering message, a thread
goal update, or a settings update. Teaching those mechanics directly would make
the parent agent brittle and provider-specific.

Recent research and specs showed that Orchestrator needs a stable product
language for long-lived agent work: task, session, operation, send, wait, read,
goal, and interrupt.

## Decision

Orchestrator will expose session operations to the parent agent and keep
provider turn mechanics internal.

The parent agent-facing model is:

- `task`: a managed Orchestrator job.
- `session`: a running task that stays alive for multiple operations.
- `operation`: one unit of work inside a session.
- `send`: give work or a follow-up instruction to a running task or session.
- `wait`: wait for an operation result.
- `read`: get a finished task result or latest completed session operation.
- `goal`: a provider-backed long-running objective.
- `interrupt`: stop work.

For Codex app-server, Orchestrator will map that model internally:

- idle session plus `send` maps to `turn/start`;
- active regular turn plus `send` maps to `turn/steer`;
- goal work maps to native Codex goal APIs;
- non-steerable active work fails with a clear Orchestrator error.

The parent agent will not be given public tools named `turn_start`,
`turn_steer`, or `steer_agent`. It will use `send_agent_message` for normal
session work and a separate goal tool for native provider goals.

## Consequences

Parent-agent instructions, CLI help, docs, and the Orchestrator skill must use
plain Orchestrator terms instead of provider protocol terms.

`send_agent_message` needs to support both idle persistent sessions and active
message-capable tasks. It also needs a `wait` path so the parent can send work
and get the operation result without guessing.

Persistent sessions need reliable state tracking for idle work, active turns,
goal operations, stopping, and closed sessions. In particular, active turn ids
must be cleared when a turn completes.

Provider-specific details remain available in internal docs, debug events,
transcripts, and provider metadata, but they should not leak into the normal
parent-agent contract.

This decision does not add app-server pooling, public protocol custom-agent
config, generic goals for every runtime, or a public socket control API.

References:

- `adr/research/SPIKE-codex-app-server-control-mechanisms-20260703-112203.md`
- `adr/research/synthesis-parent-agent-session-control-language-20260703-203248.md`
- `adr/specs/parent-agent-session-control-language-20260703-203248.md`
- `adr/specs/codex-app-server-persistent-session-operations-20260701-092650.md`
- `adr/specs/codex-app-server-steering-20260630-232736.md`
- `adr/specs/codex-goal-support-20260701-074950.md`
