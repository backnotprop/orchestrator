# Synthesis: Codex App-Server Goal Get, Set, And Clear

Date: 2026-07-04

## Summary

We can implement public `goal get`, `goal set`, and `goal clear` without a new
architecture. The current Codex app-server session model already owns a live
JSON-RPC client, a file-backed detached control channel, goal metadata on task
records, and normalized goal events.

The feature should be a thin control layer over native Codex goal state. It
should not become a generic Orchestrator goal system.

## Product Shape

Keep two different goal actions separate:

```sh
orchestrator goal start <task-id> "Improve performance by 10%."
```

Starts a tracked Codex goal operation. This is the command that may cause Codex
to do work and that Orchestrator can wait on.

```sh
orchestrator goal get <task-id>
orchestrator goal set <task-id> --objective "..."
orchestrator goal set <task-id> --status paused
orchestrator goal clear <task-id>
```

Reads or edits persisted provider goal state. These are state-control commands,
not a replacement for `goal start`.

## Important Guardrail

Do not let `goal set --status active` accidentally start provider work without
an Orchestrator operation. That would make the task look idle while Codex is
working.

For the first implementation, reject `--status active` with a clear message:

```text
Use goal start when activating a goal so Orchestrator can track the work.
```

We can add a tracked resume/activate command later if needed.

## API Shape

Recommended CLI:

```sh
orchestrator goal get <task-id|prefix> [--json [--compact]]
orchestrator goal set <task-id|prefix> [--objective <text>] [--status paused|blocked|usage-limited|budget-limited|complete] [--token-budget <tokens|none>] [--json [--compact]]
orchestrator goal clear <task-id|prefix> [--json [--compact]]
```

Recommended parent tools:

```text
read_agent_goal
set_agent_goal
clear_agent_goal
```

These should use the same core APIs as the CLI.

## Core Changes

Add core APIs:

```ts
getTaskGoal(...)
setTaskGoal(...)
clearTaskGoal(...)
```

Extend the live executor handle with goal state control. Either use separate
methods:

```ts
getGoal?()
setGoal?(input)
clearGoal?(input)
```

or one small union method:

```ts
controlGoal?(input)
```

The union method is probably cleaner because all three use the same provider
thread and error handling.

Extend detached control requests so a separate CLI invocation can control a
running background session:

```text
goal_get
goal_set
goal_clear
```

## Executor Changes

In `codex-app-server`:

- `goal_get` calls `thread/goal/get`.
- `goal_set` calls `thread/goal/set`.
- `goal_clear` calls `thread/goal/clear`.
- set/clear responses update `task.goal`.
- provider notifications still remain the source of truth when they arrive.
- `goal clear` rejects while `session.state === "goal_running"` unless a later
  slice deliberately makes it a cancellation command.

## Timestamp Fix

Fix Codex numeric goal timestamps while doing this work.

Codex emits Unix seconds. Orchestrator should normalize numeric goal timestamps
like this:

```ts
const millis = value < 1_000_000_000_000 ? value * 1000 : value;
```

This avoids showing 1970 dates for real Codex goal state.

## Tests

Add tests for:

- CLI `goal get` returns no goal.
- CLI `goal set` stores a paused/blocked/complete goal and compact JSON returns
  normalized state.
- CLI `goal clear` clears a goal and returns `{ cleared: true }`.
- `goal clear` returns `{ cleared: false }` when no goal exists.
- `goal set --status active` rejects with the `goal start` hint.
- detached control path works for background app-server sessions.
- parent tools can read, set, and clear goals.
- Unix-second timestamps normalize correctly.

## Decision Needed Before Implementation

One small choice remains:

- Should `goal get` always return cached task state?
- Or should it ask the live provider for fresh state when possible and fall back
  to cached state otherwise?

Recommendation: provider-fresh when possible, cached otherwise, and include
`source: "provider" | "task"` in JSON.

## References

- `adr/research/SPIKE-codex-app-server-goal-get-set-clear-20260704-180935.md`
- `adr/specs/codex-app-server-goal-start-operation-20260704-122339.md`
- `adr/specs/codex-app-server-persistent-session-operations-20260701-092650.md`
- `adr/decisions/0054-use-persistent-codex-app-server-sessions-for-goal-work-20260701-104716.md`
