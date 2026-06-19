# 2. Build a focused coding orchestrator agent

Date: 2026-06-17

## Status

Accepted

## Context

We need a small agent product that can coordinate other coding agents. The
target is closer to Claude Code or Codex than to a generic workflow engine, but
with subagent session management as the primary product feature.

The system needs to:

- call models itself as an AI coding agent;
- launch Codex, Claude Code, Pi, shell/custom agents, and future headless
  agents as background workers;
- keep workers visible, inspectable, cancellable, and resumable where possible;
- avoid making Pi, Flue, or any UI extension the source of truth.

## Decision

Build a standalone coding orchestrator agent with two mandatory halves:

1. Orchestrator brain: an LLM loop that plans work, launches workers, reads
   results, asks follow-up questions, and synthesizes final answers.
2. Orchestrator runtime: task records, process supervision, runtime adapters,
   logs, transcripts, results, capacity limits, cancellation, and isolation.

Subagent job control is a first-class product capability, not an implementation
detail.

## Consequences

This keeps the product focused: build the smallest credible coding agent whose
native strength is background subagent management.

The design is inspired by using tools like Codex and Claude Code. We will
borrow the useful product primitives:

- Codex-style control-plane clarity;
- Claude Code-style background-task UX;
- Pi provider/model/auth reuse where package boundaries allow it.

This also means the runtime cannot be only a process helper. The orchestrator
must have its own model-calling agent loop.
