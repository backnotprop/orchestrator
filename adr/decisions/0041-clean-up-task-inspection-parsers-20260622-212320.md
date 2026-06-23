# 0041. Clean Up Task Inspection Parsers

Date: 2026-06-22

## Status

Accepted

## Context

The parser cleanup has moved shared parser primitives and introduced a common
option helper. The next repeated cluster is the task inspection parsers:

- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`

These parsers share common option handling and the same `--compact requires
--json` rule. They also have important differences. `read` accepts multiple task
ids and supports wait options. `logs` is single-task and has stream/follow
options. `events` is single-task and has agent-only filtering.

## Decision

Use the existing `parseCommonOption` helper in:

- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`

Create `packages/cli/src/parsing/validation.ts` with a small
`requireJsonForCompact` helper for the repeated compact/json validation.

Use that helper only where the error shape matches:

- `read --compact requires --json`
- `logs --compact requires --json`
- `events --compact requires --json`

Keep task id parsing explicit. Do not create a shared task-inspection parser
loop.

Keep these local for now:

- `parseLogStream`
- `missingTaskIdError`
- `duplicateTaskIdError`

Do not abstract `--max-bytes` in this slice.

## Consequences

The three task inspection parsers get smaller and reuse the same common option
parsing path.

The compact/json error shape gets one implementation for the matching commands.

The differences between `read`, `logs`, and `events` remain visible in the
parser code.

Parser cleanup continues incrementally instead of becoming a broad parser
rewrite.
