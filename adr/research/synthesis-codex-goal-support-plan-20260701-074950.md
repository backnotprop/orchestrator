# Synthesis: Codex Goal Support Plan

Status: Refined by
`adr/research/synthesis-codex-app-server-persistent-session-operations-20260701-092650.md`.
The `goal get/set/clear` shape remains useful as lower-level control, but the
main product direction is persistent Codex app-server sessions with operations.

## Summary

Goal support should be a Codex app-server feature exposed through the existing
task model. A goal belongs to a provider thread, so Orchestrator should attach
goal state to the task record that owns that thread.

This is not a new Orchestrator planning loop. It is provider-backed task control.

## Product Shape

The human CLI should be direct:

```sh
orchestrator goal get <task-id>
orchestrator goal set <task-id> "Keep working until the API review is complete."
orchestrator goal clear <task-id>
```

The agent-facing tools should mirror that shape:

- `read_agent_goal`
- `set_agent_goal`
- `clear_agent_goal`

The commands should fail clearly when the target task does not support goals.

## Runtime Shape

Only `codex-app-server` should advertise goal support at first. It has:

- a JSON-RPC protocol.
- stored provider thread ids.
- goal RPCs.
- goal notifications.
- running-task control.

Other runtimes should remain unsupported until they expose a comparable
provider-backed goal concept.

## Active Task Behavior

For a running `codex-app-server` task, goal operations should go through the
running executor. This matters because Codex applies runtime effects inside the
app-server process that owns the live thread.

The existing file-backed control path used by `send` should be extended so a
detached background task can receive goal control requests.

## Inactive Task Behavior

For a completed or inactive task, Orchestrator should not pretend it can make
the agent keep working just by writing goal metadata.

Initial behavior should be conservative:

- `goal get` can return the last goal state Orchestrator observed.
- `goal set` and `goal clear` should require a running controllable
  `codex-app-server` task unless a later goal-resume mode is implemented.
- a future slice can add a deliberate goal-driven resume/start command.

## Event Shape

Codex goal notifications should become normalized task events:

- `goal.updated`
- `goal.cleared`

Those events should be visible through:

- `orchestrator events <task-id>`
- `orchestrator watch <task-id>`
- parent run event streams when a parent changes a child goal.

The raw protocol transcript should stay in logs only when useful for debugging.

## Recommended Slices

1. Add task goal metadata and normalized goal notifications.
2. Add core goal control APIs and extend detached task control requests.
3. Add CLI `goal get/set/clear`, help output, and compact JSON.
4. Add parent-agent goal tools.
5. Add docs and opt-in live smoke.
6. Revisit goal-driven resume/start after the basic goal path is proven.

## Non-Goals

- no generic Orchestrator goal engine.
- no app-server pooling.
- no goal support for `codex exec`.
- no goal support for Claude Code unless a real provider protocol appears.
- no public protocol custom-agent goal schema.
- no automatic goal loop in the first implementation.

## References

- `adr/research/SPIKE-codex-goal-support-plan-20260701-074950.md`
- `adr/research/SPIKE-codex-goals-support-20260701-072738.md`
- `adr/specs/codex-app-server-steering-20260630-232736.md`
