# Synthesis: Heavy Parser Cleanup

Date: 2026-06-23

## Summary

The remaining parser cleanup should be one goal with four internal passes. The
goal is not to invent a full parser framework. The goal is to remove repeated
common option handling while keeping each command parser easy to read.

The four target parsers are large enough to justify one grouped cleanup, but
different enough that they should not be collapsed into one shared parser loop.

## Decision Direction

Use `parseCommonOption` in:

- `parseLaunchOptions`
- `parsePsOptions`
- `parseInterruptOptions`
- `parseRunOptions`

Keep command-specific option handling in each parser.

Use `requireJsonForCompact` only where the error message and hint match the
generic helper:

- `launch --compact requires --json`
- `ps --compact requires --json`

Do not use it for:

- manifest launch requiring `--json`, because that has a manifest-specific hint
- interrupt, because `validateInterruptOptions` already owns interrupt
  validation
- run, because run has background-specific compact hints

## Implementation Order

The implementation should still move iteratively:

1. `parseLaunchOptions`
   - safest heavy parser
   - good proof that positional parsing still works with `parseCommonOption`
2. `parsePsOptions`
   - no positional args
   - keep `--cwd` resolving against final workspace
3. `parseInterruptOptions`
   - apply common option parsing only
   - leave selector safety in `validateInterruptOptions`
4. `parseRunOptions`
   - apply common option parsing only
   - keep trace and background validation local

## What Not To Do

Do not build a general parser abstraction yet.

Do not move command-specific rules out of these parsers.

Do not move `parseParentToolTraceMode`.

Do not move interrupt selector validation.

Do not combine request/task text parsing between `launch` and `run`. They look
similar, but they have different meanings and validation.

## Why This Shape

This keeps the cleanup useful and reviewable. The repeated common option code is
removed, but the reader can still understand each command by reading its parser
top to bottom.

It also matches the previous parser cleanup style: small helpers, local command
flow, focused verification after each internal step.
