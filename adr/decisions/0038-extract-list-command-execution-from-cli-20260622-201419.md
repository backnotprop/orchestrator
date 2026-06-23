# 0038. Extract List Command Execution From CLI

Date: 2026-06-22

## Status

Accepted

## Context

The main command execution extractions are now complete for `ps`, `interrupt`, `doctor`, and `help`. `orchestrator list` is smaller than those commands, but it is still command execution living inside `packages/cli/src/cli.ts`.

`list` owns task-store reads, status filtering, workspace filtering, JSON output, and human row formatting. Leaving it in `cli.ts` keeps command behavior mixed with routing and parser code.

Parser cleanup should happen after command execution is out of the entrypoint. Extracting `list` gives us that cleaner boundary.

## Decision

Extract `orchestrator list` into:

```text
packages/cli/src/commands/list.ts
```

The new module will own:

- `ListOptions`
- `commandList`
- `formatTaskListLine`
- `displayTaskName`
- `taskModel`
- `formatTaskAge`
- `summarizeTask`

`cli.ts` will keep:

- `parseListOptions`
- command dispatch
- common parser helpers
- `parseTaskStatus`
- `TASK_STATUSES`
- help text and JSON help contract

The extraction must preserve current `list` behavior: human text output, pretty JSON output, `No tasks.`, tab-separated rows, status filtering, workspace filtering, model fallback, task name fallback, and config loading before output.

## Consequences

`cli.ts` becomes more focused on routing and parsing.

`list` output behavior becomes easier to maintain in one command module.

This should be a mechanical extraction. It should not change output shape, add new options, remove config loading, change help text, or start parser cleanup.

After this, parser/common option extraction becomes the next cleanup phase.
