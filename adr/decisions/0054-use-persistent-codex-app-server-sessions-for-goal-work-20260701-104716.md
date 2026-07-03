# 0054. Use Persistent Codex App-Server Sessions For Goal Work

Date: 2026-07-01

## Status

Accepted

## Context

The initial goal-support plan focused on low-level goal state controls:
`goal get`, `goal set`, and `goal clear`. That is not the product shape we want.

The desired Orchestrator UX is: launch Codex, give that same Codex agent normal
tasks, start a goal, wait for the goal to finish, then keep using that same
Codex agent for more tasks or another goal.

The current `codex-app-server` executor is still turn-shaped. It starts Codex
app-server, opens or resumes a thread, immediately starts one turn, waits for
that turn to complete, writes the result, marks the Orchestrator task terminal,
and closes the app-server process.

Codex goals are app-server-backed provider state on persisted threads. Codex's
own goal operation flow requires an idle persisted thread, sets an active goal,
waits for Codex to start the runtime-generated goal turn, and treats goal
completion as a logical operation over one or more provider events.

Reference docs:

- `adr/research/SPIKE-codex-app-server-persistent-session-operations-20260701-092650.md`
- `adr/research/synthesis-codex-app-server-persistent-session-operations-20260701-092650.md`
- `adr/specs/codex-app-server-persistent-session-operations-20260701-092650.md`
- `adr/research/SPIKE-codex-goals-support-20260701-072738.md`
- `adr/specs/codex-goal-support-20260701-074950.md`

## Decision

Build Codex goal work on persistent `codex-app-server` sessions.

Add a session mode where `codex-app-server` can start, open or resume one
persisted provider thread, remain alive, become idle between operations, and
accept more work through Orchestrator control commands.

Model the system as:

- task: the Orchestrator-managed process shown in `ps`.
- session: the live Codex app-server process plus provider thread.
- operation: one normal turn or one goal operation inside that session.

The task remains `running` while the session is alive. Session and operation
state must be tracked separately from task terminal status.

The primary command shape is:

```sh
orchestrator launch codex-app-server --session --name "performance worker"
orchestrator send <task-id> --wait "Inspect current performance bottlenecks."
orchestrator goal start <task-id> --wait "Improve performance across the app by 10%."
orchestrator send <task-id> --wait "Summarize what changed."
orchestrator interrupt <task-id>
```

Parent-agent tools should mirror this:

- `launch_agent({ runtime: "codex-app-server", session: true, ... })`
- `send_agent_message({ taskId, message, wait: true })`
- `start_agent_goal({ taskId, goal, wait: true })`

`goal get`, `goal set`, and `goal clear` may still exist later as secondary
inspection/control commands, but they are not the main implementation path.

## Consequences

The existing runtime registry, task store, process supervisor, JSON-RPC client,
provider metadata, event/log/read/watch/interrupt surfaces, and file-backed
control path remain valid.

The implementation must extend the foundation with:

- session launch mode.
- session and operation metadata on task records.
- a `codex-app-server` executor path that can stay alive while idle.
- control requests for session turns and goal operations.
- operation-level waiting, because waiting on a persistent session does not mean
  waiting for the task to finish.
- `ps`, events, compact JSON, help, docs, and parent tools that show session and
  operation state clearly.

This decision does not add app-server pooling, generic goals for every runtime,
goal support for `codex exec`, public protocol custom-agent goal config, Slack
or service deployment, or TUI work.
