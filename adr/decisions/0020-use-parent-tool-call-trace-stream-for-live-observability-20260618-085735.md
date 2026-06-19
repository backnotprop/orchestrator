# 20. Use Parent Tool-Call Trace Stream for Live Observability

Date: 2026-06-18

## Status

Accepted

## Context

`orchestrator run` currently waits for the parent agent to finish and then prints
the final answer. That hides the useful runtime behavior: which child agents the
parent launches, whether it waits for them, what it reads, and where it gets
stuck.

This is not just a terminal problem. The same visibility is needed later for a
TUI that can show live parent activity, child-agent rows, durations, errors, and
event history.

Pi already exposes session events and tool lifecycle events. Pi also persists
tool calls and tool results in session JSONL. Those are useful facts, but the
stable product surface should belong to Orchestrator. We should not make the CLI
or future TUI depend on parsing Pi transcript files, and we should not use Pi
extension hooks as the main debug path because those hooks can block or mutate
tool behavior.

## Decision

Orchestrator will add a small passive trace stream for parent tool calls.

The parent-agent package will emit structured events around Orchestrator-owned
tools:

- `tool.call`
- `tool.result`
- `tool.error`

The first visible renderer will be a CLI debug mode such as:

```sh
orchestrator run --trace-tools --agent-dir ~/.pi/agent "..."
```

Trace output should go to stderr so stdout can stay focused on the parent
agent's final answer.

The trace stream is for observation only. It must not be able to block a tool
call, modify tool arguments, or modify tool results. If trace rendering fails,
the parent tool should keep running.

The future TUI should consume the same structured trace events directly from the
package API. It should not scrape terminal output.

Pi session events can still be used where they help, especially for streamed
assistant text or replay, but they are not the primary Orchestrator observability
contract.

## Consequences

Operators will be able to see what the parent agent is doing while it is doing
it, instead of only seeing the final answer.

The CLI can show live lines such as:

```text
tool call   launch_agent runtime=codex model=gpt-5.4-mini name="hello demo"
tool result launch_agent taskId=... status=running duration=...
tool call   read_agent taskId=... wait=true timeoutMs=120000
tool result read_agent retrievalStatus=completed status=succeeded duration=...
```

The TUI can later render the same events as a live timeline, active tool panel,
child-agent list, error surface, and eventually token/cost/duration view.

This does not make `orchestrator run` a durable background task. That remains a
separate decision.

This does not require building the TUI now. The CLI debug renderer is the first
consumer.

This does not replace Pi session history. Pi's transcript remains useful for
session replay and debugging, but Orchestrator's live observability should use
its own small event shape.
