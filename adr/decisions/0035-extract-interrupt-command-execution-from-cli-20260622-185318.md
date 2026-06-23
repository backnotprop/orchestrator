# 0035. Extract Interrupt Command Execution From CLI

Date: 2026-06-22

## Status

Accepted

## Context

`packages/cli/src/cli.ts` has been shrinking by moving command execution into focused command modules. ADR 0031 moved `run`, ADR 0032 moved `read`, `logs`, and `events`, ADR 0033 moved single-task `watch`, and ADR 0034 moved `ps`.

`orchestrator interrupt` is the next coherent command block left in `cli.ts`. It is smaller than `ps`, but important: it is the command humans and agents use to stop tasks, parent runs, child groups, and active work.

The core interruption semantics already live in `packages/core/src/tasks/supervisor.ts` through `interruptTasks`. Core owns short-id resolution, parent child safety, group selection, active task selection, terminal task skipping, and process interruption. The CLI should not re-own those rules.

The CLI currently owns interrupt parsing, interrupt-specific option validation, target conversion, output rendering, compact JSON rendering, and exit-code behavior. That is enough behavior to justify a focused command module.

## Decision

Move `orchestrator interrupt` command execution into:

```text
packages/cli/src/commands/interrupt.ts
```

That module will own:

- `InterruptOptions`
- `commandInterrupt`
- `validateInterruptOptions`
- interrupt selector validation helpers
- `interruptTargetFromOptions`
- `isSingleTaskInterrupt`
- `printInterruptTasksResult`
- full and compact interrupt JSON rendering
- human interrupt summary rendering

`cli.ts` will keep:

- command dispatch
- `parseInterruptOptions`
- common option parsing
- help text
- JSON help contract
- generic parser helpers
- generic missing/duplicate task id parser errors used by other commands

`parseInterruptOptions` will still parse argv in `cli.ts`, then return `validateInterruptOptions(options)` from the interrupt module.

Do not change core interruption behavior.

## Consequences

`cli.ts` gets smaller and stops owning interrupt command behavior.

`commands/interrupt.ts` becomes the home for interrupt command execution, interrupt-specific validation, output rendering, and exit-code decisions.

The implementation must preserve:

- single task interruption
- multiple task interruption
- parent and child interruption
- `--task-only`
- group interruption
- broad `ungrouped` group protection
- active workspace cleanup
- all-workspace active cleanup requiring `--yes`
- reason and signal forwarding
- full JSON output
- compact JSON output
- human output
- single-task non-JSON `printTask` behavior
- existing error shape
- existing exit-code behavior

Verification should include:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-interrupt.test.ts test/cli-errors.test.ts test/cli-contract.test.ts test/cli-ps.test.ts test/cli-run.test.ts test/cli-read.test.ts
pnpm run check
```
