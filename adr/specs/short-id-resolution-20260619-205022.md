# Short ID Resolution

Date: 2026-06-19

## Status

Draft spec.

## Intent

The IDs shown in `orchestrator ps`, `orchestrator ps --watch`, and `orchestrator list`
should be usable directly. If the UI shows `0ea6bbc9`, a human or agent should be
able to run:

```bash
orchestrator interrupt 0ea6bbc9
orchestrator read 0ea6bbc9
orchestrator logs 0ea6bbc9
```

This removes the current bad loop where the CLI shows a short ID, but control
commands require the full UUID.

## Current Code Shape

Tasks are stored as directories under:

```text
<orchestrator-dir>/tasks/<full-task-id>/
```

The important current paths are:

- `packages/core/src/tasks/store.ts`
  - `getTaskPaths(options, taskId)` joins the task root with the supplied ID.
  - `readTaskRecord(options, taskId)` assumes the supplied ID is the full
    directory name.
  - `listTasks(options)` already scans the task root.
- `packages/core/src/tasks/readers.ts`
  - `readTaskLogs` and `readTaskEvents` call `readTaskRecord`.
- `packages/core/src/tasks/wait.ts`
  - `waitForTask` repeatedly calls `readTaskRecord`.
- `packages/core/src/tasks/supervisor.ts`
  - `readTaskOutput` calls `readTaskRecord`.
  - `interruptTask` calls `readTaskRecord`, then looks up
    `runningTasks.get(input.taskId)`.
- `packages/cli/src/cli.ts`
  - `read`, `logs`, `events`, `watch`, and `interrupt` parse one positional
    `taskId` and pass it through.
- `packages/agent/src/tools.ts`
  - Parent-agent tools also pass `taskId` through to the same core functions.

The main implementation trap is `interruptTask`: even after a short ID resolves
to a task record, the in-memory `runningTasks` map is keyed by the full task ID.
`interruptTask` must use the canonical `task.taskId`, not the original user
input, after resolution.

## Proposed Design

Add task ID resolution in the core task store.

```ts
resolveTaskId(options: TaskStoreOptions, input: string): Promise<string>
```

Resolution rules:

1. Trim and reject an empty ID.
2. Try an exact directory match first. Full UUIDs stay fast and unchanged.
3. If there is no exact match, scan task directories and find IDs that start
   with the input.
4. If exactly one match exists, return the full task ID.
5. If no matches exist, throw a clear not-found error.
6. If multiple matches exist, throw a clear ambiguous-ID error that includes the
   matching full IDs.

Do not normalize by task name. Do not fuzzy match. Do not guess.

`readTaskRecord(options, taskId)` should call `resolveTaskId` before reading
`task.json`. This makes most existing callers work without duplicating lookup
logic.

Looping paths should resolve once, then reuse the full ID:

- `waitForTask`
- `logs --follow`
- `watch`

This avoids scanning the task directory on every polling interval.

`interruptTask` should:

1. Resolve through `readTaskRecord`.
2. Use `task.taskId` for `runningTasks.get(...)`.
3. Use the canonical ID in errors, task updates, and emitted events.

## Command Coverage

This slice should cover every command that operates on one task:

- `orchestrator read <id-or-prefix>`
- `orchestrator logs <id-or-prefix>`
- `orchestrator logs <id-or-prefix> --follow`
- `orchestrator events <id-or-prefix>`
- `orchestrator watch <id-or-prefix>`
- `orchestrator interrupt <id-or-prefix>`

The same behavior should work through parent-agent tools because they call the
same core functions:

- `read_agent`
- `read_agent_logs`
- `read_agent_events`
- `interrupt_agent`

`ps --parent <id>` can follow later unless it is trivial to use the same
resolver. It filters groups, not one task, so it should not block this patch.

## Errors

Errors should be plain and actionable:

```text
Task id "abc" did not match any task.
```

```text
Task id "0ea" is ambiguous. Matches:
  0ea6bbc9-9806-4d3d-8c80-95a60fcfc6df
  0ea91a52-3f6d-4c82-9d22-51c58c8ed786
```

The CLI should print these errors cleanly. Agent tools can return the same
message through the normal tool error path.

## Tests

Add focused tests for:

- full IDs still work
- displayed 8-character IDs work
- shorter unique prefixes work
- missing prefixes fail clearly
- ambiguous prefixes fail clearly
- `readTaskRecord`, `readTaskOutput`, `readTaskLogs`, `readTaskEvents`, and
  `waitForTask` accept prefixes
- `interruptTask` accepts a prefix and actually stops the running task
- CLI `read`, `logs`, `events`, and `interrupt` accept prefixes

The `interruptTask` test is important because it verifies the canonical full ID
is used for `runningTasks`.

## Non-Goals

- No task-name lookup.
- No fuzzy search.
- No rename command.
- No group interrupt.
- No change to how IDs are displayed.
- No database or index. A task-root scan is fine for now.

## Expected Result

The short IDs we already show become real handles. Humans can copy what they see
from `ps --watch`. Agents can do the same from `ps --json` or command output.
This is the smallest useful improvement before group-level cancel commands.
