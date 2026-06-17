# 3. Reuse Pi for orchestrator brain provider model auth

Date: 2026-06-17

## Status

Accepted

## Context

The orchestrator is itself an AI agent, so it must call models. Building a full
provider/model/auth stack from scratch would distract from the actual product
differentiator: launching and managing subagents.

Pi already has useful pieces for provider support, model metadata, auth/login,
streaming, and agent-loop behavior.

## Decision

Use Pi as the preferred foundation for the orchestrator brain:

- `pi-ai` for provider/model support and normalized streaming;
- `pi-agent-core` for the main agent loop and tool execution;
- selected `pi-coding-agent` auth/model-registry pieces if they can be reused
  without importing the full TUI/product shell.

Do not make the Pi CLI/TUI the orchestrator's core. Pi is a library dependency
and may also become an external worker runtime, but it is not the product shell.

## Consequences

This should reduce duplicate work around provider login, model capability
metadata, streaming, and model invocation.

The risk is package coupling. If Pi's useful auth/model pieces are too tied to
the coding-agent app, we will either wrap a smaller boundary or implement a
minimal local auth/model config for V1.

The open question is package shape, not product shape. The orchestrator calls
models either way.
