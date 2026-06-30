# Synthesis: Persist Parent Events For Background Runs

Date: 2026-06-30

## Summary

The code is ready for this slice. We do not need a new storage model or command.
Foreground parent runs already produce the right normalized event stream.
Background parent runs need to write that same stream into the parent task's
existing `events.jsonl` file as `agent_event` records.

## Decision Pressure

The manual smoke test showed that `orchestrator run --background` is manageable
through `ps` and `read`, but not replayable. The final answer is stored, and
children are grouped, but the parent tool timeline disappears. That makes it
hard for humans, agents, and the future TUI to answer: what did the parent
actually do?

ADR 20 and ADR 22 already decided the important parts:

- parent tool calls should be observable;
- normalized run events are the stable contract;
- renderers should consume structured events instead of terminal text.

This slice closes the gap for background runs by persisting the same contract.

## Implementation Direction

- Add an exported task helper in core, such as `appendAgentTaskEvent`, that wraps
  `appendSequencedTaskEvent(paths, taskId, "agent_event", data)`.
- In `commandRunParentTask`, load the parent task record and create a persistence
  sink for the parent task.
- Extend `executeParentRun` with an optional `runEventSink`.
- Emit `run.started`, converted tool trace events, `run.error`, and `run.final`
  through that sink.
- Keep foreground behavior unchanged:
  - `--stream-json` still writes JSONL to stdout.
  - `--trace-tools=text` still writes human trace output to stderr.
  - `--trace-tools=jsonl` still writes raw parent tool trace events to stderr.

## Test Direction

Add a focused CLI test around background parent runs:

1. Start a background parent task with a test parent-agent setup.
2. Have it launch a shell child and wait for it.
3. Read `events <parent-id> --agent-only --json`.
4. Assert the event kinds include `run.started`, `tool.call`, `tool.result`,
   `task.started`, `task.finished`, and `run.final`.
5. Assert `watch <parent-id> --agent-only --json` can stream the same kind of
   lines when the parent is still active.

If a full Pi-backed parent run is too expensive for unit tests, use the existing
test seams around parent tools/run events and one CLI integration test for the
background task plumbing.
