# 7. Launch external agents through headless runtime adapters

Date: 2026-06-17

## Status

Accepted

## Context

The orchestrator needs to run external coding agents such as Codex and Claude
Code. Those agents have different launch commands, auth/session behavior,
streaming formats, result formats, cancellation behavior, and support for
resume or steering.

Embedding any one agent's internal subagent architecture would make the core
too coupled.

## Decision

Launch external agents through runtime adapters.

Initial adapters:

- `ShellAdapter`: local command runtime for exercising the lifecycle, tests, and
  utility commands.
- `ClaudeCodeAdapter`: start with `claude -p "<prompt>"`; use
  `--output-format=json` or `--output-format=stream-json --verbose` only as
  adapter transport choices if useful.
- `CodexAdapter`: choose the exact surface later, likely CLI `exec`, SDK, or
  MCP based on result/event semantics.
- `PiAdapter`: only as an external worker if useful beyond powering the
  orchestrator brain.

Each adapter owns command construction, prompt transport, output transport,
auth/session assumptions, result extraction, and interruption.

## Consequences

This keeps the orchestrator core stable while allowing each worker runtime to
evolve independently.

The first real headless agent should be Claude Code through `claude -p` because
the launch surface is clear. Codex needs a short implementation spike to choose
between CLI `exec`, SDK, or MCP.

Adapters should not leak provider-specific output modes into the public
`launch_agent` contract unless a specific override is truly needed.
