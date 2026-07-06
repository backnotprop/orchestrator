# Spec: Codex App-Server No-Wait Operation Monitoring

Date: 2026-07-05

## Intent

Make no-wait Codex session operations behave like real managed work.

If a user or parent agent runs `send` or `goal start` without `--wait`,
Orchestrator should keep monitoring the provider operation, update `ps`,
events, tokens, logs, and result, and return the session task to `idle` when the
operation completes.

## Scope

In scope:

- no-wait `send` on `codex-app-server --session`
- no-wait `goal start` on `codex-app-server --session`
- background monitor for CLI commands
- reusable core monitor function for agent/service/TUI hosts
- `thread/resume` rejoin for live notifications
- `thread/read` and `thread/goal/get` reconciliation
- task record updates for `currentOperation`, `lastOperation`, `session`, `goal`,
  `usage`, and `result.md`
- deterministic fake app-server tests

Out of scope:

- public protocol custom-agent config
- app-server pooling changes
- TUI UI work
- generic operation monitoring for every runtime
- changing `codex exec`
- making session task completion mean operation completion

## User Behavior

Start a session:

```sh
orchestrator launch codex-app-server --session --name "codex session"
```

Start work without waiting:

```sh
orchestrator send <task-id> "Analyze the package structure."
```

Expected behavior:

- command returns after Codex accepts the operation
- `ps` shows the session as running a turn
- `events --agent-only` shows normalized turn/usage/result events
- `ps --watch` updates tokens when Codex emits usage
- when Codex finishes, the same task returns to idle
- `lastOperation` contains the result and status

Start a goal without waiting:

```sh
orchestrator goal start <task-id> "Improve performance across the app by 10%."
```

Expected behavior:

- command returns after Codex accepts the goal
- `ps` shows a running goal operation
- `goal get` shows provider goal state
- when Codex marks the goal paused, blocked, budget-limited, usage-limited, or
  complete, Orchestrator settles the operation

## Core API

Add a core monitor entry point near the shared session code:

```ts
export type MonitorSharedCodexAppServerSessionOperationInput = TaskStoreOptions & {
  taskId: string;
  operationId: string;
  timeoutMs?: number;
};

export async function monitorSharedCodexAppServerSessionOperation(
  input: MonitorSharedCodexAppServerSessionOperationInput,
): Promise<AgentTaskRecord>;
```

Behavior:

1. Resolve and read the task.
2. Confirm it is a shared `codex-app-server --session` task.
3. Confirm `currentOperation.operationId` matches `input.operationId`.
4. Claim the monitor for that operation.
5. Connect to the Codex app-server endpoint from task supervision.
6. Rejoin the provider thread.
7. Subscribe to notifications for that thread.
8. Reconcile immediately.
9. Wait for terminal turn or terminal goal state.
10. Write final task state and release the claim.

If the task no longer has that operation, return the latest task without error.
That makes duplicate or late monitors harmless.

## Monitor Claim

Use a small internal claim under the task directory:

```text
<taskDir>/control/operation-monitors/<operationId>.json
```

Shape:

```ts
type TaskOperationMonitorClaim = {
  schemaVersion: 1;
  operationId: string;
  taskId: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
};
```

The claim is not a public API. It is only there to avoid duplicate monitors.

Rules:

- if the claim is missing, create it
- if the claim pid is alive, do not start another detached CLI monitor
- if the claim pid is dead or stale, replace it
- every write still checks `currentOperation.operationId`

The operation id check is the real safety rule. The claim is only coordination.

## Rejoin Algorithm

The monitor should use Codex's provider protocol, not polling alone.

For every operation:

1. Subscribe locally to connection notifications filtered by thread id.
2. Call `thread/resume` for the task's provider thread.
3. Request an initial turns page when supported so a running turn can be seen
   immediately.
4. Process incoming notifications with the same normalization used by `--wait`.
5. Periodically reconcile if no terminal event has arrived.

Controller changes:

- extend `resumeThread` input to support `initialTurnsPage`
- extend `readThread` to support `includeTurns`

These are thin JSON-RPC parameter additions, not new protocol concepts.

## Reconciliation

For turn operations:

1. Call `thread/read` with turns included.
2. Look for the operation turn id when known.
3. If the turn is terminal, settle from that turn.
4. If no turn id is known, use the current operation id and most recent
   in-progress turn only when it clearly belongs to this operation.
5. If thread status is idle and no matching turn can be found, record a failed
   operation with a clear provider-state error.

For goal operations:

1. Call `thread/goal/get`.
2. If no goal exists, settle as failed unless the operation was already cleared
   by Orchestrator.
3. If the goal status is active, keep monitoring.
4. If the goal status is not active, settle from that status.

Reconciliation should happen:

- once immediately after rejoin
- after reconnect
- on a modest interval while no notification is received
- before timing out

## CLI Detached Monitor

Add an internal CLI command:

```text
orchestrator __monitor-session-operation <request-path>
```

The request file should live under:

```text
<orchestrator-dir>/operation-monitor-requests/<operationId>.json
```

Shape:

```ts
type MonitorSessionOperationRequest = {
  schemaVersion: 1;
  workspaceRoot: string;
  orchestratorDir?: string;
  taskId: string;
  operationId: string;
  timeoutMs?: number;
};
```

Add a helper similar to `launchInBackground`:

```ts
launchSessionOperationMonitor(request, { cliEntryPath });
```

CLI command behavior:

- `send` starts the monitor when the returned operation is still running,
  including the `accepted` response used when steering an already-running turn
- `goal start` starts the monitor when result status is `running`
- `--wait` does not start a detached monitor because the current process already
  waits and settles the operation
- JSON output does not change except that task state will continue updating after
  the command returns

## Parent-Agent Tool Behavior

Parent-agent tools call core APIs directly, so they should not depend on the CLI
internal command.

When `send_agent_message` or `start_agent_goal` returns a running operation with
`wait: false`, the tool host should start the core monitor in-process and not
await it.

For `send_agent_message`, monitor startup should follow the returned operation
state, not only the top-level response status. Steering an existing turn can
return `accepted` while the operation is still running.

If the parent process exits early, the operation can still be reconciled by a
later CLI monitor or by an explicit `goal get`/`send --wait` path, but normal
parent-agent operation should keep the monitor alive.

## Task Updates

On operation start:

- keep `task.status` as `running`
- set `session.state` to `turn_running` or `goal_running`
- set `currentOperation`
- append `operation.started`

On live updates:

- append normalized provider events
- update `usage` on token notifications
- update `goal` on goal notifications
- write protocol transcript lines for diagnostics

On terminal turn:

- write `result.md`
- move `currentOperation` to `lastOperation`
- set `session.state` back to `idle`
- keep task status `running`
- append `operation.completed`

On terminal goal:

- write `result.md`
- move `currentOperation` to `lastOperation`
- update `goal`
- set `session.state` back to `idle`
- keep task status `running`
- append `operation.completed`

On monitor failure:

- keep task status `running` unless the user interrupted the session
- move operation to `lastOperation` only if the provider state is clearly
  terminal or unrecoverable
- otherwise leave `currentOperation` and append `operation.monitor_failed`

## Interrupt

Existing interrupt behavior stays:

- if a turn id is known, send `turn/interrupt`
- mark the current operation interrupted
- close the session task

If a monitor is active, it must stop writing once the task no longer has the
same `currentOperation.operationId`.

## Tests

Add deterministic tests with the fake shared app-server:

- no-wait `send` starts a detached/in-process monitor and later settles
- no-wait `goal start` starts a monitor and later settles
- monitor uses `thread/resume` before waiting for notifications
- monitor can recover when completion happens before subscribe by using
  `thread/read`
- monitor can recover goal terminal state through `thread/goal/get`
- duplicate monitor start does not duplicate final state
- monitor stops if operation id no longer matches
- token usage emitted during no-wait operation appears in task usage
- CLI `send` without `--wait` updates task after the command exits
- CLI `goal start` without `--wait` updates task after the command exits

Live smoke should remain opt-in:

```sh
RUN_CODEX_APP_SERVER_SMOKE=1 pnpm test test/codex-app-server-smoke.test.ts
```

## Acceptance Criteria

This is done when:

- no-wait `send` on a session settles without another command helping it
- no-wait `goal start` on a session settles without another command helping it
- `ps --watch` shows operation state and token changes while the operation runs
- `events --agent-only` shows normalized operation events
- `read <task-id>` returns the latest operation result after completion
- duplicate monitors cannot corrupt task state
- `pnpm check` passes

## Follow-Up

After this lands, revisit whether we need a user-visible command like:

```sh
orchestrator monitor <task-id>
```

Do not add it in this slice. The first job is making no-wait operations correct
by default.
