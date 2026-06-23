# Research Spike: Task Inspection Parser Cleanup

Date: 2026-06-22

## Question

How should `parseReadOptions`, `parseLogsOptions`, and `parseEventsOptions` be
cleaned up without turning parser cleanup into a framework?

## Current Shape

The task inspection parsers live in `packages/cli/src/cli.ts`:

- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`

The command execution lives in `packages/cli/src/commands/task-inspection.ts`.
The parser still lives in `cli.ts` with the rest of the parser layer.

`packages/cli/src/parsing/common-options.ts` now has `parseCommonOption` for:

- `--workspace`
- `--orchestrator-dir`
- `--config`
- `--json`

## Shared Behavior

All three task inspection parsers currently repeat common option handling:

```text
--workspace
--orchestrator-dir
--config
--json
```

All three support:

```text
--compact
--max-bytes
```

All three require `--compact` to be paired with `--json` using the same error
shape:

```text
{command} --compact requires --json.
reason: missing_required_option
input: --compact
hint: Add --json or omit --compact.
```

## Important Differences

`read` is not the same as `logs` and `events`:

- `read` accepts multiple task ids.
- `read` has `--wait`, `--timeout-ms`, and `--interval-ms`.
- `read` requires `--json` when multiple task ids are provided.
- `read` requires `--wait` when timeout or interval options are used.

`logs` is single-task only and has:

- `--stream stdout|stderr|all`
- `--follow`

`events` is single-task only and has:

- `--agent-only`

`logs --follow` with `--json` is validated in command execution, not in the
parser. That should stay where it is for this slice.

## What Is Worth Sharing Now

Apply the existing `parseCommonOption` helper to all three parsers.

Add a small validation helper for the repeated compact/json rule:

```text
packages/cli/src/parsing/validation.ts
```

```ts
export function requireJsonForCompact(command: string, compact: boolean, json: boolean): void;
```

Use it in:

- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`

This removes real duplication while preserving the current parser shape.

## What Is Not Worth Sharing Yet

Do not create a shared task-inspection parser loop.

Do not abstract task id parsing yet. The difference between `read` allowing
multiple ids and `logs/events` requiring exactly one id matters enough to keep
the code explicit.

Do not abstract `--max-bytes` yet. It is already a clear one-line use of
`parseIntegerOption(requireValue(...))`, and abstracting it would not buy much.

Do not move `parseLogStream` yet. It is specific to `logs` and can stay local
until command-specific parser modules are extracted.

## Tests Covering Behavior

Relevant tests:

- `test/cli-read.test.ts`
  - read/logs/events output behavior
  - read wait behavior
  - multi-task read requiring JSON
  - max byte handling
  - invalid `--stream`
- `test/cli-watch-logs.test.ts`
  - logs follow behavior
  - logs follow/json incompatibility
- `test/cli-interrupt.test.ts`
  - logs/events compact without JSON errors
- `test/cli-errors.test.ts`
  - missing and duplicate task id errors
  - machine-readable error payloads
- `test/cli-contract.test.ts`
  - command contract and examples

## Findings

The right Slice 3 cleanup is small:

- use `parseCommonOption` in the three task inspection parsers
- add `requireJsonForCompact`
- keep command-specific branches obvious

This gets rid of the most repetitive code without hiding the important
differences between `read`, `logs`, and `events`.
