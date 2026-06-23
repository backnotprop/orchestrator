# Research Spike: Interrupt Command Extraction

Date: 2026-06-22

## Question

What is required to extract `orchestrator interrupt` out of `packages/cli/src/cli.ts` without changing behavior?

## Current Shape

`interrupt` is still split across three areas in `cli.ts`:

- `InterruptOptions` near the top-level command option types.
- `commandInterrupt` near the command implementations.
- `parseInterruptOptions`, selector validation helpers, `interruptTargetFromOptions`, `isSingleTaskInterrupt`, and `printInterruptTasksResult` later in the file.

The actual task interruption behavior already lives in core:

- `packages/core/src/tasks/supervisor.ts`
  - `interruptTasks`
  - target selection
  - short-id resolution
  - parent child safety
  - group selection
  - active task selection
  - terminal task skipping
  - process group kill

The CLI layer does not need to re-own those rules. It only needs to parse user intent, call core, render output, and choose the process exit code.

## Current CLI Responsibilities

`commandInterrupt` currently:

- calls `interruptTasks`
- passes `workspaceRoot`, optional `orchestratorDir`, `allWorkspaces`, `reason`, and `signal`
- builds the core target from CLI options
- preserves the old single-task non-JSON output path through `printTask`
- renders full or compact JSON with `summarizeInterruptTasksResult` and `compactInterruptTasksResult`
- renders human multi-task output
- returns `0` or `1` based on failures and empty selections

`parseInterruptOptions` currently:

- parses common options
- parses task ids and selectors: task id, `--parent`, `--group`, `--active`
- parses behavior modifiers: `--children`, `--task-only`, `-A`, `--yes`
- parses output modifiers: `--json`, `--compact`
- parses reason and signal
- validates interrupt-specific option combinations after parsing

## Tests Covering Behavior

`test/cli-interrupt.test.ts` covers:

- cancelling a detached running task
- terminal task interruption as a skipped success
- parent safety and `--task-only`
- `--children`
- `--parent`
- `--group`
- broad `ungrouped` group rejection
- multiple task ids
- `--active` workspace cleanup
- `-A --active --yes` machine cleanup
- `--compact` requiring `--json`
- compact JSON output

Other relevant tests:

- `test/cli-errors.test.ts` checks machine-readable option errors.
- `test/cli-contract.test.ts` checks help text and command-contract references.
- `test/cli-ps.test.ts` checks stop command args returned by `ps --json --compact`.
- `test/cli-run.test.ts` and `test/cli-read.test.ts` check parent/child stop args returned by other commands.

## Extraction Boundary

Good extraction target:

```text
packages/cli/src/commands/interrupt.ts
```

This module should own the interrupt command behavior and interrupt-specific validation.

Keep in `cli.ts` for now:

- command dispatch
- `parseInterruptOptions`
- generic option parsing helpers
- generic `missingTaskIdError` and `duplicateTaskIdError`, because read/logs/events/watch still use them
- help text and JSON help contract

Move out of `cli.ts`:

- `InterruptOptions`
- `commandInterrupt`
- `validateInterruptOptions`
- `interruptSelectors`
- `interruptSelectorError`
- `incompatibleInterruptOptionsError`
- `interruptTargetFromOptions`
- `isSingleTaskInterrupt`
- `printInterruptTasksResult`

`parseInterruptOptions` can keep parsing argv in `cli.ts`, build an `InterruptOptions` object, then call `validateInterruptOptions(options)` exported by the interrupt command module.

## Risks

The main risk is changing error shape or exit code behavior. Tests already cover the most important cases, so this should be a mechanical extraction.

Another risk is accidentally moving core safety behavior into CLI. That should not happen. Parent/child selection, group resolution, terminal skipping, and process killing should stay in core.

## Findings

The extraction is safe and well scoped. `interrupt` is cohesive, smaller than `ps`, and is the next best cleanup target after `ps`.

The only non-obvious choice is validation placement. Since the user specifically wants interrupt selector validation owned by the interrupt command area, the clean path is to export `validateInterruptOptions` from `commands/interrupt.ts` and call it from `parseInterruptOptions`.
