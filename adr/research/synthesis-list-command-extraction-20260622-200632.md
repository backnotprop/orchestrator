# Synthesis: List Command Extraction

Date: 2026-06-22

## Summary

`list` should be extracted before parser cleanup.

The originally planned command extractions are done: `ps`, `interrupt`, `doctor`, and `help`. `list` was not in that first list because it is smaller, but it is still real command execution inside `cli.ts`.

Moving it gives us a cleaner boundary before extracting shared parser code.

## What Should Move

Create:

```text
packages/cli/src/commands/list.ts
```

Move into it:

- `ListOptions`
- `commandList`
- `formatTaskListLine`
- `displayTaskName`
- `taskModel`
- `formatTaskAge`
- `summarizeTask`

The module should own list execution and list human rendering.

## What Should Stay

Keep in `cli.ts`:

- `parseListOptions`
- command dispatch
- common option parsing
- `parseTaskStatus`
- parser errors
- help command contract

This keeps the command extraction pattern consistent with `ps`, `interrupt`, `doctor`, and `help`.

## What Should Not Change

Do not change:

- `list` human output
- `list --json` output
- `No tasks.`
- tab-separated row shape
- status filtering
- workspace filtering
- `-A` / `--all-workspaces`
- model fallback logic
- task name fallback logic
- config loading behavior
- help text or examples

## Why This Is The Right Next Step

After this extraction, `cli.ts` will be mostly routing and parsing. That makes parser cleanup easier to reason about and keeps command behavior from being mixed with parser refactoring.

## Expected Outcome

After extraction:

- `cli.ts` gets smaller.
- `list` behavior is isolated in one command module.
- list formatting helpers stop living at the bottom of `cli.ts`.
- parser cleanup becomes the next natural phase.
