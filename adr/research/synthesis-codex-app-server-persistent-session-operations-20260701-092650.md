# Synthesis: Codex App-Server Persistent Sessions And Goal Operations

## Summary

The next phase should be persistent Codex sessions.

The product object is not a single Codex task that finishes after one turn. The
product object is a managed Codex app-server session that can stay alive, hold a
provider thread, accept normal work, run goal operations, become idle again, and
accept more work.

## Correct Mental Model

Use three layers:

1. Task
   - the Orchestrator-managed process.
   - shows up in `ps`.
   - can be interrupted.
   - remains `running` while the session is alive.

2. Session
   - the Codex app-server process plus one provider thread.
   - can be idle or busy.
   - owns `threadId`.

3. Operation
   - one unit of work inside the session.
   - can be a normal turn or a goal operation.
   - owns `turnId` when Codex starts a turn.
   - has its own result, usage, status, and timestamps.

This avoids overloading task status. A task can be `running` while the session
is `idle`.

## What Changes From The Previous Goal Spec

The previous spec centered `goal get/set/clear`. That is not the desired first
UX.

Those controls may still exist later for inspection and advanced control, but
the main feature should be:

```sh
orchestrator launch codex-app-server --session --name "performance worker"
orchestrator send <id> --wait "Inspect performance bottlenecks."
orchestrator goal start <id> --wait "Improve performance across the app by 10%."
orchestrator send <id> --wait "Summarize what changed."
```

For parent Orchestrator tools:

```ts
launch_agent({ runtime: "codex-app-server", session: true, name: "performance worker" });
send_agent_message({ taskId, message: "Inspect performance bottlenecks.", wait: true });
start_agent_goal({ taskId, goal: "Improve performance across the app by 10%.", wait: true });
send_agent_message({ taskId, message: "Summarize what changed.", wait: true });
```

## Foundation Impact

The existing foundation does not need to be thrown away.

Keep:

- runtime registry.
- launch plans.
- task store.
- process supervisor.
- JSON-RPC stdio client.
- provider metadata.
- events/logs/read/watch/interrupt.
- file-backed detached control.

Extend:

- launch plan with session mode.
- task record with session and current operation metadata.
- executor from "one turn then exit" to "session loop until interrupted."
- control requests from `send_message` to session operations.
- CLI and parent tools with goal operation commands.

## Command Direction

Human-facing commands should stay simple:

```sh
orchestrator launch codex-app-server --session --name "worker"
orchestrator send <id> --wait "Do this task."
orchestrator goal start <id> --wait "Pursue this goal."
orchestrator goal wait <id>
orchestrator interrupt <id>
```

`goal get`, `goal set`, and `goal clear` can be secondary commands if needed,
but they should not lead the product.

## Wait Semantics

Waiting for a persistent session cannot mean "wait for the task to finish." The
task should stay alive.

Waiting must mean "wait for the current operation to finish."

For a normal turn, the operation finishes on `turn/completed`.

For a goal, the operation finishes when Codex reports a terminal goal status and
there is no active physical turn for that logical goal operation. Mirror Codex's
own terminal goal statuses:

- paused
- blocked
- usage-limited
- budget-limited
- complete

## Recommended Slices

1. Add session mode and operation metadata.
2. Make `codex-app-server --session` start, open a persisted thread, and stay
   idle.
3. Make `send` start a normal turn when the session is idle and optionally wait
   for that operation.
4. Add goal operation start/wait on idle sessions.
5. Show session and operation state in `ps`, `events`, and compact JSON.
6. Add parent-agent tools for session operations.
7. Add docs and fake-server/live-smoke tests.

## Non-Goals

- no app-server pooling across tasks.
- no generic goals for every runtime.
- no public protocol custom-agent goal schema.
- no automatic Slack/service deployment.
- no broad TUI work in this slice.

## References

- `adr/research/SPIKE-codex-app-server-persistent-session-operations-20260701-092650.md`
- `adr/specs/codex-goal-support-20260701-074950.md`
- `adr/decisions/0052-enable-task-shaped-resume-for-codex-app-server-20260630-163334.md`
- `adr/decisions/0053-send-messages-to-running-codex-app-server-tasks-20260630-234839.md`
