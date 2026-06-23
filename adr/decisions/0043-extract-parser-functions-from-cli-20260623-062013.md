# 0043. Extract Parser Functions From CLI

Date: 2026-06-23

## Status

Accepted

## Context

The CLI command cleanup has moved command execution into
`packages/cli/src/commands/*`. The remaining bulk in `packages/cli/src/cli.ts`
is command-line parsing.

`cli.ts` still defines parser functions for every command, including launch,
ps, interrupt, run, task inspection, help, list, doctor, watch, and internal
task runners. That keeps `cli.ts` around 1000 lines even though command behavior
has been extracted.

The current split is close to the desired shape:

- command modules own behavior
- parser helpers live under `packages/cli/src/parsing`
- `cli.ts` routes commands and handles top-level errors

The missing piece is moving per-command parser functions out of `cli.ts`.

## Decision

Move command parser functions into files under `packages/cli/src/parsing`.

Parser files should mirror command modules or command clusters:

```text
packages/cli/src/parsing/leading-common-options.ts
packages/cli/src/parsing/help.ts
packages/cli/src/parsing/launch.ts
packages/cli/src/parsing/list.ts
packages/cli/src/parsing/ps.ts
packages/cli/src/parsing/task-inspection.ts
packages/cli/src/parsing/watch.ts
packages/cli/src/parsing/interrupt.ts
packages/cli/src/parsing/doctor.ts
packages/cli/src/parsing/run.ts
packages/cli/src/parsing/internal.ts
packages/cli/src/parsing/task-id-errors.ts
```

Keep existing shared parser helpers:

```text
packages/cli/src/parsing/primitives.ts
packages/cli/src/parsing/common-options.ts
packages/cli/src/parsing/validation.ts
```

`cli.ts` should keep only:

- executable entrypoint setup
- `CLI_ENTRY_PATH`
- `main`
- command routing
- top-level error handling
- direct-entrypoint detection

Command option types should remain in command modules. Parser modules should
import those types. Command modules should not import parser modules.

Parser modules must not import from `cli.ts`.

This is a behavior-preserving extraction. Do not create a parser framework or
parser DSL.

## Consequences

`cli.ts` becomes a small entrypoint and router instead of a mixed parser
registry.

Parser changes become easier to review because each parser lives in a focused
file that matches the command or command cluster it parses.

The command/execution boundary stays intact:

- `commands/*` owns behavior
- `parsing/*` owns argv-to-options parsing
- `cli.ts` owns command selection and top-level errors

The implementation must preserve current CLI behavior, help text, JSON
contracts, output, error messages, and validation order.

The extraction should run in internal passes with focused tests after each pass,
then full `pnpm run check` and `git diff --check` at the end.
