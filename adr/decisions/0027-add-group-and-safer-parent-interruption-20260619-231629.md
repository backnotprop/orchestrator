# 27. Add Group And Safer Parent Interruption

Date: 2026-06-19

## Status

Accepted

## Context

Orchestrator can already show parent/child agent work in `ps`, and task records
already store parent linkage through `parentRunId` and `parentTaskId`. But
interruption is still one task at a time.

That is unsafe for multi-agent work. If a user interrupts a managed parent
Orchestrator task, its child agents can keep running and spending budget. During
live testing this made cleanup clumsy: the operator had to find each child task
and interrupt it manually.

Short task ID support made individual control easier. The next budget-safety
step is stopping a parent/child group directly.

## Decision

Orchestrator will add group interruption and safer parent interruption in the
same implementation slice.

The CLI will support:

```sh
orchestrator interrupt <parent-task-id|prefix> --children
orchestrator interrupt --parent <parent-task-id|prefix> --children
orchestrator interrupt --group <group-id|prefix>
orchestrator interrupt <parent-task-id|prefix> --task-only
```

Plain single-task interruption remains:

```sh
orchestrator interrupt <task-id|prefix>
```

If the target is an `orchestrator` parent task with non-terminal children, plain
`interrupt <parent>` will fail with a direct message telling the user to choose
`--children` or `--task-only`. There will be no interactive prompt.

Core will own the behavior through a grouped interrupt operation, not CLI-only
logic. The operation will select tasks from existing task records and reuse the
same group identity that `ps` already uses:

- parent tasks group by their own task ID
- children group by `parentTaskId` when present
- otherwise children group by `parentRunId`
- `ungrouped` is not interruptible as a group in this slice

The grouped interrupt operation will interrupt non-terminal tasks, skip terminal
tasks, continue attempting remaining tasks when one fails, and return a stable
summary of interrupted, skipped, and failed tasks.

Parent-agent tooling will extend `interrupt_agent` instead of adding another
tool. It will support task, parent, and group selectors using the same rules as
the CLI.

## Consequences

Users and agents get an obvious way to stop a whole managed run:

```sh
orchestrator interrupt <parent-id|prefix> --children
```

The command shown by `ps` becomes actionable without copying every child task ID.

Stopping a parent will no longer silently leave children running. The user must
choose parent-plus-children or parent-only behavior.

The implementation must share grouping helpers between `ps` and interruption so
the displayed groups and interrupt targets cannot drift.

This does not add interactive prompts, broad `ungrouped` kill, a new persistent
group table, a TUI, or a compact machine-control `ps` view.
