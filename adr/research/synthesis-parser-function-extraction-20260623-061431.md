# Synthesis: Parser Function Extraction

Date: 2026-06-23

## Summary

The command cleanup is mostly complete, but `cli.ts` still owns all argv parsing.
That is why it remains about 1000 lines. Moving parser functions into files is a
reasonable final cleanup step.

The right move is not a generic parser framework. It is mechanical extraction:
put parser functions into files under `packages/cli/src/parsing` that mirror the
command modules.

## Recommended Shape

Use this layout:

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

Keep existing shared files:

```text
packages/cli/src/parsing/primitives.ts
packages/cli/src/parsing/common-options.ts
packages/cli/src/parsing/validation.ts
```

## Ownership

Command modules should keep owning their option types. Parser modules should
import those types.

Example:

```ts
import type { LaunchOptions } from "../commands/launch.ts";
```

Parser modules should not import from `cli.ts`.

Command modules should not import parser modules.

## What `cli.ts` Should Own Afterward

`cli.ts` should own:

- the executable shebang
- `main`
- command routing
- top-level error formatting
- `CLI_ENTRY_PATH`
- direct entrypoint detection

It should not own per-command parser logic.

## Why This Is Better

This makes `cli.ts` small and honest. It becomes the entrypoint and router, not a
mixed parser registry.

Parser changes become easier to review because each command parser sits in a
focused file.

The approach keeps the current mental model:

- `commands/*`: what a command does
- `parsing/*`: how argv becomes command options
- `cli.ts`: which command to run

## What Not To Do

Do not create a parser DSL.

Do not move option types into parser files.

Do not move command execution back into parser files.

Do not combine launch task parsing and run request parsing.

Do not change CLI help, JSON output, error messages, or command behavior.

## Implementation Direction

Do this as one extraction goal with internal checkpoints. Each checkpoint should
move a coherent parser group and run focused tests.

This is a behavior-preserving refactor.
