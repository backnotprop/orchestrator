# Persist Parent Events For Background Runs

Date: 2026-06-30

## Goal

Make background parent runs replayable. A managed parent task should keep a
durable event timeline of what the parent did, not only its final answer.

## User-Facing Behavior

After:

```sh
orchestrator run --background --name "repo plan" "Launch a shell child and wait for it."
```

these commands should work:

```sh
orchestrator events <parent-id> --agent-only --json
orchestrator watch <parent-id> --agent-only --json
```

They should include parent run events such as:

- `run.started`
- `tool.call`
- `tool.result`
- `tool.error`, when a tool fails
- `task.started`, when the parent launches a child task
- `task.status` and `task.usage`, when waiting reports progress
- `task.finished`, when a child reaches a terminal state through parent reads
- `run.error`, when the parent run fails
- `run.final`, when the parent run finishes successfully

## Data Shape

Persist each parent run event as an existing task event:

```ts
{
  type: "agent_event",
  data: RunStreamEvent
}
```

The outer `TaskEvent` remains responsible for task-local event ordering. The
inner `RunStreamEvent` remains responsible for parent-run ordering.

## Code Changes

1. Export a small task event helper from core.
   - Preferred shape:

     ```ts
     appendAgentTaskEvent(store, taskId, data);
     ```

   - It should resolve the task, append a sequenced `agent_event`, and reuse the
     existing task event lock.

2. Extend `executeParentRun`.
   - Add an optional `runEventSink(event: RunStreamEvent): void | Promise<void>`.
   - Route `run.started`, converted parent tool trace events, `run.error`, and
     `run.final` through one helper.
   - Keep stdout/stderr rendering behavior unchanged.

3. Update `commandRunParentTask`.
   - Read the parent task id from the request.
   - Pass a sink that appends each normalized run event to that parent task's
     event log as `agent_event`.

4. Keep foreground commands stable.
   - No behavior change for plain `run`.
   - No behavior change for `run --trace-tools`.
   - No behavior change for `run --stream-json`.

## Tests

Add coverage for:

- background parent run stores `run.started` and `run.final`;
- background parent tool calls are stored as `agent_event`;
- child launch/read activity creates `task.started` and `task.finished` in the
  parent event stream;
- `events <parent-id> --agent-only --json` returns the persisted parent events;
- `watch <parent-id> --agent-only --json` can stream persisted parent activity.

## Non-Goals

- Do not build the TUI.
- Do not add a new event file.
- Do not persist raw Pi transcripts in the task event log.
- Do not change child task event storage.
- Do not change provider runtime adapters.

## Acceptance

The slice is done when a completed background parent task can be inspected after
the fact and still show what tools it called and what child tasks it launched or
waited on.
