# 0040. Add Common Option Parser Helper

Date: 2026-06-22

## Status

Accepted

## Context

After extracting command execution and parser primitives, `packages/cli/src/cli.ts`
still repeats the same common option handling across most command parsers.

The repeated options are:

- `--workspace`
- `--orchestrator-dir`
- `--config`
- `--json`

This duplication is real, but the parser should not be rewritten broadly. Some
commands have positional arguments, `--` handling, multiple task ids, selector
validation, and command-specific option dependencies. A small helper should be
proven on simple parsers first.

## Decision

Create `packages/cli/src/parsing/common-options.ts` with a small
`parseCommonOption` helper.

The helper will:

- accept `args`, `index`, and a mutable `CommonOptions` object
- handle `--workspace`, `--orchestrator-dir`, `--config`, and `--json`
- use the existing `requireValue` behavior for value options
- resolve path values the same way current parsers do
- return whether it matched and which index was consumed

Apply the helper only to:

- `parseHelpOptions`
- `parseListOptions`
- `parseDoctorOptions`
- `parseWatchOptions`

Do not change `normalizeLeadingCommonOptions`.

Do not apply the helper yet to the heavier parsers:

- `parseLaunchOptions`
- `parsePsOptions`
- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`
- `parseInterruptOptions`
- `parseRunOptions`

`parseHelpOptions` must keep accepting `--orchestrator-dir` without adding it to
`HelpOptions`, because help accepts common options for consistency but does not
use the task store.

## Consequences

Common option parsing gets one shared implementation without changing command
behavior, help text, JSON contracts, or error messages.

The simple parsers get smaller and prove the helper shape.

The heavier parsers stay explicit until the helper has been validated in a small
slice.

The next parser cleanup can decide whether to apply the helper to task
inspection parsers or leave command-specific parser flow mostly local.
