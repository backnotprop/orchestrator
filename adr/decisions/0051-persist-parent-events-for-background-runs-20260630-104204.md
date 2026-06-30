# 51. Persist Parent Events For Background Runs

Date: 2026-06-30

## Status

Accepted

## Context

Manual smoke testing showed that `orchestrator run --background` is useful but
not replayable enough. The parent task can be listed, watched, read, and grouped
with child tasks, but its parent tool timeline is lost after the run unless the
operator used foreground `--trace-tools` or `--stream-json`.

ADR 20 already decided that parent tool calls should have a passive trace
stream. ADR 22 already standardized the parent run event contract with
`run.started`, `tool.call`, `tool.result`, child task events, and `run.final`.
Foreground runs already use that event stream. Background parent tasks should use
the same facts.

## Decision

Background parent runs will persist normalized parent run events into the parent
task's existing `events.jsonl` file as `agent_event` records.

Orchestrator will not create a new parent trace store. It will reuse the current
task event log and store the normalized `RunStreamEvent` as the `data` payload:

```ts
{
  type: "agent_event",
  data: RunStreamEvent
}
```

This makes these commands replay the parent timeline:

```sh
orchestrator events <parent-id> --agent-only --json
orchestrator watch <parent-id> --agent-only --json
```

The persisted events should include:

- `run.started`
- `tool.call`
- `tool.result`
- `tool.error`
- `tool.progress`
- `task.started`
- `task.status`
- `task.usage`
- `task.finished`
- `run.error`
- `run.final`

Implementation should add a small exported core helper for appending
`agent_event` records, then pass a run-event sink when executing the internal
background parent task. Foreground `run`, `--trace-tools`, and `--stream-json`
must keep their current behavior.

## Consequences

Background parent runs become inspectable after completion. Humans, agents, and
the future TUI can see what the parent did without scraping stdout or depending
on Pi transcripts.

The task event log remains the single durable event surface for task inspection.
There will be both task event sequence numbers and parent run event sequence
numbers, but they describe different streams and can coexist.

This adds durable observability without changing the core task model, child task
storage, runtime adapters, or the TUI plan.
