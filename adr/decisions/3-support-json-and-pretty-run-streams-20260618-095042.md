# 3. Support JSON and Pretty Run Streams

Date: 2026-06-18

## Status

Accepted

## Context

`orchestrator run --trace-tools` now shows parent tool calls live. That is useful,
but the current text output is still basic. It shows calls and results, but it
does not yet feel like a polished live view of what the parent agent is doing.

We need two different output needs:

- humans need a readable live stream that groups related activity and hides noise
- programs need a stable JSON stream they can parse without scraping terminal text

The normal CLI contract should stay simple: `orchestrator run` prints the final
answer to stdout. Debug or trace output should not pollute that default.

At the same time, future integrations need a complete event stream. A TUI,
plugin, script, or external app should be able to consume the same structured
events that the CLI renders.

## Decision

Orchestrator will keep trace events as structured data first, then render them
through different output modes.

`--trace-tools` remains a live observation mode. It should write to stderr so
stdout stays focused on the parent agent's final answer.

`--trace-tools=jsonl` remains the machine-readable debug side channel. It emits
one JSON object per line for parent tool events.

Orchestrator will add a full JSON stream mode for integrations, likely:

```sh
orchestrator run --stream-json "..."
```

In that mode, stdout is the stream. It should include tool calls, tool results,
tool errors, progress events, and the final answer as structured JSONL records.

The human renderer for `--trace-tools` should become prettier without changing
the underlying event shape. It should group call/result pairs, show durations,
use stable alignment, hide unhelpful noise, and only use color or terminal
effects when stdout/stderr is attached to a TTY.

Long waits should emit progress events. For example, `read_agent` with
`wait: true` should be able to report that it is still waiting, how long it has
waited, and which child task it is waiting on. These progress events let the CLI
show useful live feedback and give the future TUI real-time state without
polling raw logs.

The event stream is the product surface. Pretty text, JSONL, and the future TUI
are renderers over that stream.

## Consequences

Users can keep using the simple default:

```sh
orchestrator run "..."
```

That prints the final answer.

Users can observe the parent agent live:

```sh
orchestrator run --trace-tools "..."
```

That prints a readable live trace while preserving stdout for the final answer.

Automation can consume the full run:

```sh
orchestrator run --stream-json "..."
```

That provides a complete JSONL stream instead of terminal prose.

The TUI can later reuse the same events for a live view of parent activity,
child-agent status, wait state, duration, errors, and final output.

This makes the event model more important. New renderers should not invent their
own facts by scraping text. They should consume the shared structured stream.

This also means long-running tools need progress events, not only call/result
events. Without progress events, the terminal and TUI can only show that a wait
started and then eventually ended.
