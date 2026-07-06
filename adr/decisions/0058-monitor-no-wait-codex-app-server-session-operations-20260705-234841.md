# 58. Monitor No-Wait Codex App-Server Session Operations

Date: 2026-07-05

## Status

Accepted

## Context

Orchestrator now supports persistent `codex-app-server --session` tasks. A user
or parent agent can send normal work into that session, or start a Codex goal on
that same session.

The gap is no-wait operation handling. Today `send` and `goal start` can return
after Codex accepts the operation. That is good for user experience, but it can
leave Orchestrator without an active observer. Codex may keep working while the
task remains stuck in `turn_running` or `goal_running` until another command
happens to inspect it.

The related research and spec found that Codex app-server already provides the
right primitives: `thread/resume` can rejoin a running thread, `thread/read` can
reconstruct thread state, and `thread/goal/get` can read current goal state.

References:

- `adr/research/SPIKE-codex-app-server-no-wait-operation-monitoring-20260705-211822.md`
- `adr/research/synthesis-codex-app-server-no-wait-operation-monitoring-20260705-211822.md`
- `adr/specs/codex-app-server-no-wait-operation-monitoring-20260705-211822.md`

## Decision

No-wait Codex app-server `send` and `goal start` operations will remain managed
by Orchestrator through a background operation monitor.

The monitor will update the existing session task. It will not create a second
task for the operation.

The task model remains:

```text
Orchestrator task
  -> Codex app-server session
     -> one provider thread
        -> current operation, either turn or goal
```

The monitor will:

- confirm the session task still has the same `currentOperation.operationId`
- rejoin the provider thread through `thread/resume`
- process normalized provider notifications
- reconcile missed state with `thread/read` and `thread/goal/get`
- update usage, events, result, `currentOperation`, `lastOperation`, and session
  state
- return the session task to `idle` when the operation completes

CLI no-wait commands will start a detached internal monitor process. Parent-agent
tools and future service/TUI hosts will call the same core monitor in-process.

This decision does not add pooling, public protocol custom-agent config, TUI
work, or a new task model.

## Consequences

Users and agents can start long Codex session operations without waiting and
still rely on `ps`, `events`, `read`, and token usage to update.

Duplicate or late monitors must be harmless. The operation id check is the
source of truth before writing final state.

Implementation needs a small internal monitor claim so the CLI does not start
multiple detached monitors for the same operation.

The core monitor function becomes the shared path for CLI, parent-agent tools,
and future service/TUI hosts.
