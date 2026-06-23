# 0032. Extract Task Inspection Commands From CLI

Date: 2026-06-22

## Status

Accepted

## Context

`packages/cli/src/cli.ts` is still too large. ADR 0031 moved `orchestrator run` execution into its own command module, but `cli.ts` still owns the execution logic for task inspection commands.

The next cohesive block is:

- `orchestrator read`
- `orchestrator logs`
- `orchestrator events`

These commands all inspect existing tasks. They share task lookup, task aliases, compact JSON output, raw output handling, truncation behavior, and follow-up command generation.

`orchestrator watch` is related, but it has live terminal rendering and mixed stdout/stderr/event streaming. It should be extracted later.

## Decision

Move task inspection execution into:

```text
packages/cli/src/commands/task-inspection.ts
```

That module will own:

- `ReadOptions`
- `LogsOptions`
- `EventsOptions`
- `LogStream`
- `commandRead`
- `commandLogs`
- `commandEvents`
- batch-read helpers
- logs-follow helper

`cli.ts` will keep option parsing for this slice:

- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`
- `parseLogStream`

Move appended-file reading into:

```text
packages/cli/src/task-output.ts
```

That file already owns tail reads and missing-file handling, so it should export `readNewFileText`.

Create:

```text
packages/cli/src/task-events.ts
```

That file will own event-line parsing shared by `events` and the later `watch` extraction:

- `parseTaskEventLine`
- `isAgentEventLine`

Update the remaining `watch` code in `cli.ts` to use these shared helpers. Keep watch rendering in `cli.ts` until the watch extraction.

## Consequences

`cli.ts` becomes smaller and stops owning task inspection execution.

`commands/task-inspection.ts` becomes the home for reading final task output, reading raw logs, following raw logs, and reading task event timelines.

This is a behavior-preserving refactor. It must not change read output, logs output, events output, compact JSON contracts, timeout behavior, truncation flags, parent-safe stop targets, or machine-readable error shapes.

Parser extraction remains a later cleanup. `watch` extraction also remains a later cleanup, but this decision prepares it by sharing event parsing and appended-file reading.
