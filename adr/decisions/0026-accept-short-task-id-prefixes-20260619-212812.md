# 26. Accept Short Task ID Prefixes

Date: 2026-06-19

## Status

Accepted

## Context

`orchestrator ps`, `orchestrator ps --watch`, and `orchestrator list` show short
task IDs because full UUIDs are too noisy for humans. The control commands still
required full UUIDs, which made the displayed IDs misleading and made urgent
operations like interrupting a running agent slower than they should be.

This matters for humans and agents. A human watching running work should be able
to copy the ID they see. A parent agent should also be able to use the same ID
surface when reading, inspecting, or stopping child agents.

## Decision

Orchestrator will accept unique task ID prefixes for single-task commands.

The core task store will own resolution through a function like:

```ts
resolveTaskId(options: TaskStoreOptions, input: string): Promise<string>
```

Resolution will:

1. Trim and reject empty input.
2. Prefer exact task directory matches.
3. Match task directories by prefix when no exact match exists.
4. Return the full task ID when exactly one prefix match exists.
5. Fail clearly when there are no matches.
6. Fail clearly when the prefix is ambiguous.

`readTaskRecord` will resolve IDs before reading task files so most callers get
the behavior automatically.

Polling paths such as `waitForTask`, `logs --follow`, and `watch` should resolve
once, then reuse the canonical full ID.

`interruptTask` must use the resolved full task ID for its `runningTasks` lookup.
Resolving the record is not enough, because live running tasks are keyed by full
UUID in memory.

This applies to:

- `orchestrator read <id-or-prefix>`
- `orchestrator logs <id-or-prefix>`
- `orchestrator events <id-or-prefix>`
- `orchestrator watch <id-or-prefix>`
- `orchestrator interrupt <id-or-prefix>`
- parent-agent tools that read, inspect, wait on, or interrupt tasks

This does not add task-name lookup, fuzzy matching, rename support, or group
interrupt.

## Consequences

The short IDs already displayed by Orchestrator become real handles.

Humans can use the task IDs shown in `ps --watch` without hunting for full UUIDs.
Agents can do the same from command output or JSON.

The task store becomes the single place that defines ID lookup rules, which keeps
CLI commands and parent-agent tools consistent.

Ambiguous short IDs become explicit errors instead of guesses. This keeps
interruption and log-reading behavior predictable.

Group-level cancel remains a separate decision and implementation slice.
