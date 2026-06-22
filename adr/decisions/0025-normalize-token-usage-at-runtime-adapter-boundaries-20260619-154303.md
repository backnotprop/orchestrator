# 0025. Normalize Token Usage at Runtime Adapter Boundaries

Date: 2026-06-19

## Status

Accepted

## Intent

Make token usage visible without making Orchestrator fragile.

Users should be able to watch many agents and see token counts when a runtime
provides them. Machines should be able to read the same data from task records,
events, and streams. Custom agents should have a small optional contract for
reporting usage, but they should not need to know anything about Claude Code,
Codex, Pi, OpenCode, or Flue internals.

The important constraint is performance. Usage should be parsed once as runtime
output arrives, then stored as compact task summary data. Live views such as
`ps --watch` and the future TUI should read that summary; they should not
re-scan large logs or transcripts on every refresh.

## Context

Orchestrator needs to show token usage for running and completed agents, but
agent runtimes expose usage differently. Claude Code, Codex, Pi, Flue, and
OpenCode do not share one token schema, one timing model, or one cost model.

Some usage arrives only when a response, turn, step, or task finishes. Some
runtimes can expose partial usage during streaming. Some values are provider
reported, some are runtime calculated, and some are only estimates for context
pressure. Account quota, rate limits, credits, and subscription usage are
separate from task token usage.

Custom agents also need a simple path. They should not be required to report
tokens, but if they can report tokens, Orchestrator should be able to consume
that data without learning every provider-specific field name.

## Decision

Token usage parsing belongs at the runtime adapter boundary.

Each built-in adapter is responsible for understanding its runtime's output and
mapping usage into Orchestrator's normalized task usage shape. Core
Orchestrator will store, aggregate, and display normalized usage. Core will not
parse provider-specific fields such as `prompt_tokens`, `completion_tokens`,
`usageMetadata`, or Anthropic cache creation fields.

The normalized usage shape will include the existing token and cost fields, plus
the missing semantics needed for reliable display:

- reasoning tokens
- usage source: provider, runtime, or estimated
- usage scope: turn, task, session, or account
- whether the value is final

Custom agents may opt into token reporting through a small structured JSONL
contract. Agents that do not report usage still work; their token usage remains
unknown.

Usage parsing must happen during output/event ingestion, not during every live
view refresh. Task records keep the latest best usage summary. Raw provider
payloads stay in event logs when useful for debugging, not in `task.json`.

## Consequences

Orchestrator can show useful token data without pretending every runtime reports
usage the same way.

The CLI, `ps --watch`, and future TUI can stay responsive because they read
summary state instead of reparsing full logs on every refresh.

Built-in adapters need runtime-specific usage extraction work, especially for
Codex and Claude Code.

Custom agents get a clear optional contract. Flue, OpenCode, and other process
agents can report normalized usage without Orchestrator knowing their internal
provider details.

Task and group totals must avoid mixing incompatible data. Account usage,
rate limits, credits, subscription usage, and context estimates must not be
counted as task token totals unless explicitly labeled for a separate display.
