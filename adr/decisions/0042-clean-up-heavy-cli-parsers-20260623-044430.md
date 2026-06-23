# 0042. Clean Up Heavy CLI Parsers

Date: 2026-06-23

## Status

Accepted

## Context

The CLI parser cleanup has already moved shared primitives into
`packages/cli/src/parsing/primitives.ts`, added `parseCommonOption`, and cleaned
up the simpler parser paths. The remaining repeated parser code is in four
larger command parsers:

- `parseLaunchOptions`
- `parsePsOptions`
- `parseInterruptOptions`
- `parseRunOptions`

Together they are about 483 lines. They still repeat common option handling for
`--workspace`, `--orchestrator-dir`, `--config`, and `--json`.

These parsers are heavier because they encode real command behavior. `launch`
has positional runtime/task parsing and manifest mode. `ps` has live view and
filter options. `interrupt` has safety-sensitive selector rules. `run` has
parent-agent foreground/background behavior, trace modes, and JSON stream rules.

## Decision

Clean up all four heavy parsers in one implementation goal, but do the work in
four internal passes:

1. `parseLaunchOptions`
2. `parsePsOptions`
3. `parseInterruptOptions`
4. `parseRunOptions`

Each pass should apply `parseCommonOption`, preserve the parser's
command-specific flow, and run focused tests before moving to the next parser.

Do not create a full parser framework in this slice. Do not collapse these
commands into a shared parser loop. The parser code should remain readable from
top to bottom.

Use `requireJsonForCompact` only where the compact/json error message and hint
match the shared helper:

- `launch --compact requires --json`
- `ps --compact requires --json`

Keep these rules local:

- `launch -f requires --json`, because it has manifest-specific guidance
- interrupt compact validation, because `validateInterruptOptions` owns
  interrupt validation
- run compact validation, because run has background-specific guidance

Keep interrupt selector validation in `validateInterruptOptions`.

Keep `parseParentToolTraceMode` local for now.

Keep launch task parsing and run request parsing separate.

## Consequences

The remaining parser cleanup can be completed as one coherent goal without
turning into a broad parser rewrite.

Common option behavior becomes consistent across the heavy parsers and the
already-cleaned parsers.

Command-specific behavior stays visible in each parser, which matters for
reviewing launch, ps, interrupt, and run safety rules.

The implementation must preserve existing CLI output, JSON contracts, help text,
and command execution behavior.

Focused verification should run after each internal pass, followed by full
`pnpm run check` and `git diff --check` at the end.
