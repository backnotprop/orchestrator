# Synthesis: Read, Logs, Events Extraction

Date: 2026-06-22

## Recommendation

Extract `read`, `logs`, and `events` execution together into one command module:

```text
packages/cli/src/commands/task-inspection.ts
```

This is cleaner than three tiny files for the first pass because these commands share task lookup, output rendering, task aliases, compact JSON, and follow-up command behavior.

Keep option parsing in `cli.ts` for now:

- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`
- `parseLogStream`

This keeps the patch behavior-preserving and avoids a broader parser refactor.

## Shared Helper Moves

Move appended-file reading into `task-output.ts`:

```ts
readNewFileText(path, offset);
```

That file already owns tail reads and missing-file handling.

Create a small event-line helper:

```text
packages/cli/src/task-events.ts
```

It should export:

```ts
parseTaskEventLine(line);
isAgentEventLine(line);
```

`commandEvents` should use these helpers immediately. `watch` should keep its rendering logic in `cli.ts` for now but import the same parser helpers. That prevents duplicated event parsing and sets up the later `watch` extraction.

## What The New Module Should Own

`commands/task-inspection.ts` should own:

- `ReadOptions`
- `LogsOptions`
- `EventsOptions`
- `LogStream`
- `commandRead`
- `commandLogs`
- `commandEvents`
- private batch-read helpers
- private logs-follow helper

It should not own:

- parser functions
- `watch`
- terminal frame rendering
- top-level dispatch

## Why Not Include `watch` Now

`watch` is related, but it has live rendering behavior and mixed stdout/stderr/event streaming. It should be the next extraction after this one.

This slice should only make `watch` easier to extract by moving shared event parsing and appended-file reading into reusable helpers.

## Expected Result

`cli.ts` loses another large execution block, while preserving the current CLI behavior:

- human `read`
- JSON and compact JSON `read`
- batch read
- logs snapshots
- logs follow
- events snapshots
- events JSON and compact JSON

The remaining `cli.ts` responsibility becomes routing, parsing, help text, and commands not yet extracted.
