# SPIKE: Read, Logs, Events Extraction

Date: 2026-06-22

## Question

What is required to extract `orchestrator read`, `orchestrator logs`, and `orchestrator events` from `packages/cli/src/cli.ts` without changing behavior?

## Current Shape

`cli.ts` owns the execution and parsing for all three commands:

- `ReadOptions`, `LogsOptions`, `EventsOptions`, `LogStream`
- `commandRead`
- `commandReadBatch`
- `commandLogs`
- `followLogs`
- `commandEvents`
- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`

The execution block sits around `cli.ts` lines 1264-1638. The parsers sit around lines 2246-2465.

## `read` Path

Single task:

```text
commandRead
  -> readTaskForOptions
    -> readTaskRecord
    -> waitForTask, when --wait and task is active
  -> taskReadJsonPayload, for --json
  -> readTaskOutput, for human output
  -> stdout fallback, when active task has no final result yet
```

Batch read:

```text
commandRead
  -> commandReadBatch
    -> listTaskIds
    -> readTaskForOptions for each id
    -> taskReadJsonPayload for each task
    -> compactTaskReadJsonPayload, when --compact
    -> taskBatchControlCommands, when any task is still active
```

Important behavior:

- multiple ids require `--json`
- `--wait` can return `retrievalStatus: "completed"` or `"timeout"`
- active parent task groups get parent-safe stop commands
- compact read keeps recovery commands for truncated output, failed tasks, or active tasks

## `logs` Path

```text
commandLogs
  -> readTaskRecord
  -> logs --follow guard rejects --json
  -> followLogs, when --follow
  -> readTailMetadataIfExists for stdout/stderr snapshots
  -> taskLogsJsonPayload, for --json
  -> raw stdout/stderr writes, for human output
```

`followLogs` uses:

- `readTailWithOffsetIfExists` for initial bounded tail
- `readNewFileText` for appended bytes
- `readTaskRecord` every 250ms
- terminal task status to stop following

## `events` Path

```text
commandEvents
  -> readTaskRecord
  -> readTailMetadataIfExists(events.jsonl)
  -> parseEventLine
  -> agent-only filter, when requested
  -> taskEventsJsonPayload, for compact JSON
  -> parsed event JSON, for normal JSON
  -> raw event JSONL text, for human output
```

Important behavior:

- `events --json --compact` returns task summary, command follow-ups, count, truncation flags, and parsed events
- `events --json` returns just the parsed task events
- non-JSON output returns raw event lines
- malformed event lines are silently skipped in parsed JSON paths

## Shared Code Already Extracted

The extraction can reuse:

- `packages/cli/src/task-output.ts`
  - `taskReadJsonPayload`
  - `compactTaskReadJsonPayload`
  - `readTail`
  - `readTailMetadataIfExists`
  - `readTailWithOffsetIfExists`
  - `emptyTailRead`
  - `stopArgsSuffix`
- `packages/cli/src/task-json.ts`
  - `taskLogsJsonPayload`
  - `taskEventsJsonPayload`
- `packages/cli/src/json-output.ts`
  - `jsonLine`

## Shared Code Still In `cli.ts`

The following helpers are used by the target commands and also by `watch`:

- `readNewFileText`
- `parseEventLine`
- `isAgentEventLine`

`readNewFileText` fits naturally in `task-output.ts`, beside existing tail readers.

`parseEventLine` and `isAgentEventLine` should move to a small task event helper so `events` and the later `watch` extraction use the same parsing path.

## Tests Covering This Area

Primary tests:

- `test/cli-read.test.ts`
- `test/cli-watch-logs.test.ts`

Related contract/error tests:

- `test/cli-interrupt.test.ts`
- `test/cli-contract.test.ts`
- `test/cli-errors.test.ts`

Coverage includes:

- `read --wait --json`
- batch read
- read timeouts
- compact read follow-up commands
- usage in read JSON
- truncation flags
- stderr fallback for failed tasks
- logs/events snapshots
- logs `--follow`
- watch behavior, which will be affected if shared event/file helpers move

## Finding

This is a good next extraction target. `read`, `logs`, and `events` are cohesive task inspection commands. They can move together without pulling `watch` yet.

The safest boundary is to move execution first and keep the parsers in `cli.ts`, matching the `run` extraction pattern. Parser extraction can wait until common parser helpers are extracted across commands.
