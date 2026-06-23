# Synthesis: Ps Command Extraction

Date: 2026-06-22

## Summary

`ps` is the next best extraction target.

It is the largest coherent command block still in `packages/cli/src/cli.ts`. It owns a real product surface: grouped task views, compact machine-control JSON, parent/group filtering, runtime validation, portable follow-up commands, and live `ps --watch`.

## Why Extract It Now

The previous extractions moved:

- `launch`
- `run`
- `read` / `logs` / `events`
- single-task `watch`

That leaves `ps` as the biggest remaining command body. Moving it out continues the same pattern: `cli.ts` remains the router/parser, and command modules own execution.

## Boundary

The right boundary is:

```text
packages/cli/src/commands/ps.ts
```

That module should own:

- building the ps view
- validating runtime filters
- formatting JSON and compact JSON
- adding portable command args
- filtering to a parent/group
- running `ps --watch`

`cli.ts` should continue to own `parsePsOptions` for now.

## What Not To Do

Do not extract the human table renderer. `render-ps.ts` already exists and should stay focused on rendering.

Do not extract the terminal frame renderer. `terminal-frame.ts` already owns that.

Do not extract parser/common option handling yet. That is a later pass after more command execution has moved out.

Do not change compact ps JSON, returned commands, or `ps --watch` behavior.

## Expected Result

After extraction:

- `cli.ts` loses the biggest remaining command execution block
- `commands/ps.ts` becomes the home for ps behavior
- help and parsing stay stable
- compact JSON contracts stay stable
- the next extraction targets become smaller: `interrupt`, `doctor`, and `help`

This should be a mechanical refactor, but it deserves broad tests because `ps` is central to the CLI and agent-control UX.
