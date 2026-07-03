# SPIKE: Codex Goal Support Plan

Status: Refined by
`adr/research/SPIKE-codex-app-server-persistent-session-operations-20260701-092650.md`.
The original spike correctly identified Codex goal RPCs, but the desired UX
requires persistent sessions and goal operations, not just goal state mutation.

## Question

What needs to be done for Orchestrator to support Codex app-server goals without
turning goals into a new, generic Orchestrator planning system?

## Codex Facts

Codex app-server exposes goals through JSON-RPC on persisted threads:

- `thread/goal/set`
- `thread/goal/get`
- `thread/goal/clear`

It also emits goal notifications:

- `thread/goal/updated`
- `thread/goal/cleared`

The goal record is tied to a Codex thread. It includes an objective, status,
optional token budget, token usage, time usage, and timestamps. Goal statuses
come from Codex, including active, paused, blocked, usage-limited,
budget-limited, and complete states.

Codex also has agent-facing internal goal tools, but those are not the same as
Orchestrator CLI commands. Orchestrator should not copy those tool names or
pretend all runtimes support them.

## Current Orchestrator Fit

Orchestrator already has the right foundation:

- `codex-app-server` stores provider thread metadata.
- `resume` can continue a stored Codex app-server thread.
- `send` can steer a running Codex app-server task through file-backed control.
- protocol events are normalized before reaching CLI surfaces.
- `ps`, `events`, `watch`, and parent tools already understand task state.

That means goal support should extend the protocol runtime/control path. It
should not add a parallel job model.

## Missing Pieces

The current code does not yet have:

- task-level goal metadata.
- normalized handling for Codex goal notifications.
- a runtime capability flag for goal support.
- core APIs for getting, setting, or clearing a goal.
- CLI commands for goal operations.
- parent-agent tools for goal operations.
- fake app-server support for goal RPCs and notifications.
- live smoke coverage for real Codex app-server goal behavior.

## Design Fork

There are two different features that sound similar:

1. Goal state operations
   - read the current goal for a Codex app-server task.
   - set or clear the goal on a running Codex app-server task.
   - show goal changes in events and task metadata.

2. Goal-driven task mode
   - start or resume a Codex thread specifically to let Codex work against a
     persistent goal.
   - keep the task open while Codex progresses the goal.
   - map provider goal states into Orchestrator task states.

The first one is a clean extension of the system we already have. The second one
changes task execution semantics and should be handled after the basic goal
control path is proven.

## Recommendation

Build goal state operations first for `codex-app-server` only.

Do not implement a generic Orchestrator goal system. Do not add goals to
`codex exec`, Claude Code, process agents, or custom agents until a provider has
a real goal protocol that can be mapped cleanly.

Initial support should be task-shaped:

- a task has a provider thread id.
- Orchestrator can read, set, or clear the goal for that task when supported.
- goal events are normalized and visible through existing task inspection.
- parent agents get explicit goal tools only for supported tasks.

Defer goal-driven launch/resume until we know the exact product shape.

## References

- `adr/research/SPIKE-codex-goals-support-20260701-072738.md`
- `adr/research/SPIKE-codex-app-server-pooling-20260701-072738.md`
- `adr/decisions/0050-use-simple-task-shaped-resume-before-pooling-20260630-051045.md`
- `adr/decisions/0052-enable-task-shaped-resume-for-codex-app-server-20260630-163334.md`
- `adr/decisions/0053-send-messages-to-running-codex-app-server-tasks-20260630-234839.md`
- `adr/specs/codex-app-server-steering-20260630-232736.md`
