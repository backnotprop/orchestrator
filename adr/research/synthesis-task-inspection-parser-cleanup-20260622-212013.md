# Synthesis: Task Inspection Parser Cleanup

Date: 2026-06-22

## Summary

The task inspection parsers should be cleaned up, but not collapsed into one
shared parser.

`read`, `logs`, and `events` share common option handling and compact/json
validation. They differ enough in task id and command-specific options that the
main parser flow should remain explicit.

## Decision Direction

Use the existing `parseCommonOption` helper in:

- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`

Add one small validation helper:

```text
packages/cli/src/parsing/validation.ts
```

```ts
requireJsonForCompact(command, compact, common.json);
```

Use it for the repeated `--compact requires --json` rule in all three parsers.

## What Should Stay Local

Keep these parser branches visible:

- `read` task id collection
- `read --wait`
- `read --timeout-ms`
- `read --interval-ms`
- `read` multi-task JSON requirement
- `logs --stream`
- `logs --follow`
- `events --agent-only`

Keep `parseLogStream` in `cli.ts` for now.

Keep `missingTaskIdError` and `duplicateTaskIdError` where they are for now.
They are also used by `watch`, so moving them is a separate cleanup.

## Why This Slice

This removes the real repeated parts without hiding the command-specific
behavior. It also proves that `parseCommonOption` works beyond the first simple
parser slice.

## Expected Outcome

After this slice:

- task inspection parsers use shared common option parsing
- compact/json validation has one implementation for the matching error shape
- task id behavior remains easy to read
- command behavior and error messages stay unchanged
