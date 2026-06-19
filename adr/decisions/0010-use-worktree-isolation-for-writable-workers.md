# 10. Use worktree isolation for writable workers

Date: 2026-06-17

## Status

Accepted

## Context

Background agents may write files. Multiple workers editing the same checkout
can conflict, hide partial work, or make it hard to review which agent changed
what.

Read-only workers do not need separate write sandboxes, but writable workers
do.

## Decision

Use worktree isolation by default for writable workers.

Policy:

- `can_write: false`, `isolation: shared`: allowed.
- `can_write: true`, `isolation: worktree`: default.
- `can_write: true`, `isolation: shared`: require an explicit high-friction
  override.

The orchestrator should create a branch/worktree named from task id and optional
task name, run the worker inside that path, and record the worktree path on the
task. It must not auto-merge worker edits in V1.

## Consequences

Writable agent work becomes easier to inspect, compare, evaluate, and discard.
The parent can launch another read-only worker against a writer's worktree
before any human or parent agent decides to apply changes.

This adds implementation work around git worktree creation, cleanup, status
inspection, branch naming, and failure handling. It is still simpler and safer
than letting multiple background writers mutate the same checkout by default.
