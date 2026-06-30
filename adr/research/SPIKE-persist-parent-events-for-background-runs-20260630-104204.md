# SPIKE: Persist Parent Events For Background Runs

Date: 2026-06-30

## Question

Can background parent runs persist the same parent run/tool events that foreground
`orchestrator run --stream-json` already emits?

## Findings

- `packages/cli/src/commands/run.ts` already creates normalized parent run
  events for foreground runs.
  - `createRunStreamSequencer` creates stable `seq`, `timestamp`, `runId`, and
    `schemaVersion` fields.
  - `runStreamPayloadsFromParentToolTrace` converts parent tool traces into
    `tool.call`, `tool.result`, `tool.error`, `tool.progress`, `task.started`,
    `task.status`, `task.usage`, and `task.finished`.
  - `--stream-json` writes these events to stdout.
  - `--trace-tools=text` renders the same normalized events for humans.

- Background parent runs use the same `executeParentRun` path, but tracing is
  disabled.
  - `commandRunBackground` creates a task with runtime `orchestrator`.
  - The child process runs `__run-parent-task`.
  - `commandRunParentTask` calls `executeParentRun` with `traceTools: "off"` and
    `streamJson: false`.
  - Because no trace sink is installed, parent tool calls are not written
    anywhere durable.

- The task event store already has the right durable surface.
  - Task events are stored in each task's `events.jsonl`.
  - `TaskEvent` supports type `agent_event`.
  - `events <task-id> --agent-only` filters to `agent_event`.
  - `watch <task-id> --agent-only --json` streams only `agent_event` lines.

- Runtime adapters already use `agent_event` for normalized provider events.
  Parent run events can use the same outer task event type with the normalized
  run event as `data`.

- `appendSequencedTaskEvent` exists in `packages/core/src/tasks/store.ts`, but
  is not exported from `@backnotprop/orchestrator-core/tasks`. The implementation
  should expose a small public helper instead of importing private files from
  the CLI package.

## Recommended Shape

Persist each normalized parent run event as:

```json
{
  "type": "agent_event",
  "data": {
    "schemaVersion": 1,
    "seq": 1,
    "timestamp": "...",
    "runId": "...",
    "kind": "tool.call",
    "...": "..."
  }
}
```

The task event envelope supplies the parent task id, event sequence for the task
file, and write timestamp. The nested run event keeps the parent run stream's own
sequence and run id.

## Risks

- There will be two sequence numbers: task event `seq` and parent run event
  `data.seq`. This is acceptable because they describe different streams.
- `run.started` and `run.final` are currently only emitted when `--stream-json`
  is true. Background runs need those events emitted through the same helper.
- Trace persistence must not break parent execution. If event persistence fails,
  it is reasonable for the parent task to fail because durable observability is
  part of the managed background run contract.
