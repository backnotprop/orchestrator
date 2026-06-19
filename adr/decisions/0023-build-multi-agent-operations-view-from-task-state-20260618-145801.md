# 23. Build Multi-Agent Operations View From Task State

Date: 2026-06-18

## Status

Accepted

## Intent

Build the first real human view for managing many running agents.

The user should be able to start a parent run, let it launch child agents, and
then open one command that shows what exists, what is still running, what
failed, what finished, and which parent run each child belongs to. This should
feel like watching pods update during a rollout: live, grouped, scannable, and
useful without reading raw logs.

This is not the full TUI yet. It is the command-line operations surface that
the future TUI can build on. It should also stay separate from debug output:
tool traces, raw logs, and machine-readable streams remain available, but they
are not the default human view.

## Context

Orchestrator can now launch background agent tasks, run a Pi-backed parent
agent, and emit a stable parent run event stream. That proves the engine works,
but the human experience is still mostly task-id based.

The next product need is a multi-agent operations view: a way to see which
agents exist, what they are doing, which parent run created them, and what
changed recently. This should feel closer to watching pods update than tailing
raw logs.

`orchestrator run --trace-tools` is useful, but it answers a different
question: what tool calls is the parent making right now? It should remain a
debug/timeline view, not become the main multi-agent dashboard.

The parent run stream already emits `runId`, `toolCallId`, and `taskId`, but
that relationship is live-only. A user should be able to open a watch view after
agents have already started and still see correct grouping.

## Decision

Orchestrator will build the multi-agent operations view from persisted task
state and task events, not by scraping terminal output or relying only on the
live parent run stream.

First, child tasks launched by the parent agent will persist parent metadata:

```ts
type TaskParent = {
  parentRunId: string;
  parentSessionId?: string;
  parentToolCallId?: string;
};
```

`AgentTaskRecord` will get an optional `parent` field. Manual
`orchestrator launch` tasks remain ungrouped.

Second, Orchestrator will add a grouped task view:

```sh
orchestrator ps
orchestrator ps --watch
```

`ps` is the human operations view. It groups tasks by parent run, with an
`ungrouped` section for manually launched tasks. It should show name, status,
runtime, model when known, age or duration, token usage when known, last event,
and enough task id context to inspect a specific task.

`ps --watch` will refresh the same view live. The first version should stay
terminal-simple: no full TUI, no keyboard navigation, no replacement for
`logs`, `events`, or `--stream-json`.

Provider errors should be promoted into task state when possible. If a runtime
emits a structured provider error and the process exits failed, the task should
carry a readable `task.error` rather than forcing users to read raw JSONL.

Token usage remains best-effort. Runtime adapters should normalize usage into
`agent.usage` events when the runtime exposes it. The operations view should
show known usage and `unknown` otherwise. It must not estimate tokens from log
length.

Raw and debug surfaces remain distinct:

- `orchestrator run --trace-tools`: parent tool timeline.
- `orchestrator run --stream-json`: machine-readable parent run stream.
- `orchestrator logs <task-id> --follow`: raw process output.
- `orchestrator events <task-id>`: task lifecycle and provider events.
- `orchestrator ps`: grouped human task view.
- `orchestrator ps --watch`: live grouped human task view.

## Consequences

The next implementation should start with parent-child linkage. Without
persisted parent metadata, grouped views are unreliable once the user starts
watching after the parent has already launched children.

`list` remains a simple task-id oriented command. `ps` becomes the richer
operations view.

The future TUI should consume the same grouped task data as `ps`, rather than
inventing another job model.

This adds task metadata and view-building code before UI polish. That is
intentional: the watch view should be built on durable state first.

The first useful sequence is:

1. Persist parent-child linkage.
2. Add static `orchestrator ps`.
3. Promote provider errors into readable task errors.
4. Add `orchestrator ps --watch`.
5. Polish row data: model, tokens, duration, last event.

This does not require building the full TUI now.
