# 12. Scope first release to Claude Code and Codex runtimes

Date: 2026-06-17

## Status

Accepted

## Context

The orchestrator runtime is intentionally generic: runtime registry, launch
plans, task store, process supervisor, and CLI control-plane commands should
work for any headless agent that can be launched and observed.

That generic shape is still the right architecture, but the first release needs
a narrower product target. Supporting every possible agent runtime at release
would spread effort across adapter quirks before the core UX is proven.

The two first-release runtimes that matter are:

- Claude Code
- Codex

Observed CLI behavior supports both as headless workers:

- Claude Code supports `claude -p`, `--model`, `--output-format stream-json`,
  `--verbose`, and its own background-session commands such as
  `claude agents`, `claude logs`, and `claude stop`.
- Codex supports `codex exec`, `--model`, `--json`, and JSONL exec events such
  as `thread.started`, `turn.started`, `item.started`, `item.completed`,
  `turn.completed`, and `error`.

The first release should learn from those two surfaces without becoming a
Claude-only or Codex-only system.

## Decision

Scope the first release to Claude Code and Codex as the supported external
agent runtimes.

The release target is:

```text
orchestrator can launch, list, read, observe, interrupt, and time out Claude
Code and Codex background tasks through the same task/runtime APIs.
```

The generic runtime architecture remains mandatory:

- keep `HeadlessAgentRuntimeConfig` as the runtime source of truth;
- keep `buildAgentLaunchPlan(...)` as the command/env/cwd builder;
- keep the process supervisor unaware of `"claude-code"` and `"codex"` branch
  logic;
- keep task records, logs, events, transcripts, result files, and CLI commands
  runtime-neutral;
- implement Claude and Codex differences in adapter/config/output-parsing code.

Do not spend first-release implementation time on Pi-as-worker, Flue workers,
custom providers, arbitrary shell workers beyond testing, or additional agent
runtimes unless they are needed to validate the Claude/Codex architecture.

For observability, implement the next slice against both primary runtimes:

- Claude Code: prefer `claude -p --output-format stream-json --verbose` when
  live events are needed.
- Codex: prefer `codex exec --json` for JSONL events.

Normalize both streams into the same task observability model while preserving
raw runtime transcripts.

## Consequences

This gives the first release a concrete and testable surface.

It becomes easier to prioritize:

- `orchestrator logs`
- `orchestrator events`
- `orchestrator watch`
- output adapter interfaces
- transcript storage
- normalized worker events
- real Claude and Codex smoke tests

It also reduces speculative work around runtimes we do not yet need.

The cost is that other runtimes remain non-release targets even if the registry
can describe them. They may stay in code as experimental entries, but release
quality is only promised for Claude Code and Codex.

This decision does not undo the generic architecture. It constrains release
scope so the abstraction is proven by two real, different agents instead of by
an open-ended list of integrations.

References:

- [Launch external agents through headless runtime adapters](0007-launch-external-agents-through-headless-runtime-adapters.md)
- [Use typed runtime registry and pure launch plan builders](0005-use-typed-runtime-registry-and-pure-launch-plan-builders.md)
