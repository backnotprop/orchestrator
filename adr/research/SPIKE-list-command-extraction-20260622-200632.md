# Research Spike: List Command Extraction

Date: 2026-06-22

## Question

What is required to extract `orchestrator list` out of `packages/cli/src/cli.ts` without changing behavior?

## Current Shape

`list` is now the last small command execution block still owned by `cli.ts`.

The current list-owned pieces are:

- `ListOptions`
- `commandList`
- `formatTaskListLine`
- `displayTaskName`
- `taskModel`
- `formatTaskAge`
- `summarizeTask`

`parseListOptions` also lives in `cli.ts`, with the rest of the command parsers.

## Current Command Behavior

`commandList` currently:

1. Loads the configured runtime registry for the selected workspace and optional config file.
2. Reads tasks from the selected task store through `listTasks`.
3. Applies the shared workspace filter through `matchesTaskWorkspace`.
4. Prints full task records as pretty JSON when `--json` is present.
5. Prints `No tasks.` when the human output has no rows.
6. Prints tab-separated human rows otherwise.

The human columns are:

```text
name    status    runtime    model    age    taskId
```

There is no header row.

The model column prefers `task.model`. If that is missing, it derives a model from the runtime's configured `modelFlag` and the stored launch args. If no model can be found, it prints `-`.

The name column prefers `task.name`. If there is no task name, it summarizes the last launch arg, which is usually the prompt or shell command. If that is empty, it prints `(unnamed)`.

## Important Behavior To Preserve

`list --json` currently still loads runtime config before reading tasks. That means config errors can surface even though JSON output does not use the registry. The extraction should keep that behavior unless we explicitly decide to change it later.

`list` already uses the same normalized workspace filter as `ps`. That was a correctness fix and must stay intact.

## Tests Covering Behavior

Relevant tests:

- `test/cli-read.test.ts`
  - `CLI list falls back to the task prompt when no name is provided`
  - `CLI launches a background task, lists it, and reads the result`
- `test/cli-launch.test.ts`
  - `CLI launch accepts task names and list shows names before ids`
  - `CLI list and ps use the same normalized workspace filter`
- `test/cli-contract.test.ts`
  - text help documents `orchestrator list [--status <status>] [-A|--all-workspaces] [--json]`
  - JSON help includes the `list` command contract

## Extraction Boundary

Good extraction target:

```text
packages/cli/src/commands/list.ts
```

Move list command execution and human row formatting into that module.

Keep in `cli.ts` for now:

- command dispatch
- `parseListOptions`
- common parser helpers
- `parseTaskStatus`
- `TASK_STATUSES`
- parser error behavior
- help text and JSON help contract

After extraction, `cli.ts` should import `commandList` and `ListOptions` from the list command module.

## Risks

The main risk is small output drift:

- changing tab-separated human columns
- adding a header row
- changing `No tasks.`
- changing age formatting
- changing model fallback behavior
- changing name fallback behavior
- changing JSON pretty formatting
- accidentally skipping config loading for `list --json`
- breaking the shared workspace filter

## Findings

`list` is a clean extraction target. It is smaller than previous command modules and has no live-loop behavior.

The extraction should be mechanical:

- create `commands/list.ts`
- export `ListOptions`
- export `commandList`
- move list formatting helpers there
- import `commandList` and `ListOptions` in `cli.ts`
- keep `parseListOptions` in `cli.ts`
- remove now-unused list imports from `cli.ts`

This is the last command execution extraction before parser/common option cleanup.
