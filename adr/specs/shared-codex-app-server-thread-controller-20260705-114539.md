# Spec: Shared Codex App-Server Thread Controller

Date: 2026-07-05

## Intent

Make `codex-app-server --session` a true shared-server runtime. Orchestrator
should manage many Codex app-server sessions through one Codex app-server
process, while humans and parent agents keep using normal Orchestrator commands.

The product flow is:

```text
Claude Code -> orchestrator CLI -> shared Codex app-server -> many Codex threads
```

## Non-Goals

- Do not expose sockets, thread ids, turn ids, or JSON-RPC methods in the normal
  CLI.
- Do not add a new public runtime id.
- Do not change the stable `codex` runtime.
- Do not move one-shot `codex-app-server "<task>"` off stdio in this slice.
- Do not build public protocol custom-agent config.
- Do not build TUI or Slack/service mode in this slice.
- Do not call the feature "pooling" in user-facing docs.

## User-Facing Contract

The commands remain:

```sh
orchestrator launch codex-app-server --session --name "codex worker"
orchestrator send <task-id> --wait "Inspect the repo."
orchestrator goal start <task-id> --wait "Improve performance by 10%."
orchestrator goal get <task-id>
orchestrator goal set <task-id> --status paused
orchestrator goal clear <task-id>
orchestrator read <task-id>
orchestrator events <task-id> --agent-only
orchestrator ps --watch
orchestrator interrupt <task-id> --reason "done"
```

The visible behavior should be:

- `launch --session` returns quickly with a task id.
- `ps` shows one row per Orchestrator session.
- `send --wait` returns one operation result.
- `goal start --wait` returns after Codex reports terminal goal state.
- `read` returns the latest completed operation result.
- `events --agent-only` shows normalized thread, turn, goal, usage, and result
  events.
- `interrupt` stops that session's active work or closes the idle session. It
  does not stop other Codex sessions.

## Internal Model

Use this model:

- Codex app-server process: shared provider infrastructure.
- Orchestrator task: one Codex provider thread.
- Orchestrator session: the task's active provider-thread lifecycle.
- Orchestrator operation: one Codex turn or one Codex goal operation.

Provider metadata:

```ts
{
  provider: "codex",
  protocol: "jsonrpc",
  transport: "unix",
  threadId: string,
  turnId?: string,
  connectionId?: string
}
```

Session state remains:

```ts
"starting" | "idle" | "turn_running" | "goal_running" | "stopping" | "closed";
```

## Slice 1: JSON-RPC Websocket-Over-Unix Client

Add an internal client under:

```text
packages/core/src/tasks/executors/protocol/json-rpc-websocket-unix.ts
```

Use a small websocket dependency instead of hand-writing websocket framing.

The client should expose the same shape as the stdio client where practical:

```ts
request(method, params, options);
notify(method, params);
subscribeNotifications(filter, handler);
close();
closed;
```

It must support:

- Unix socket path connection.
- JSON-RPC request id routing.
- notifications.
- server-initiated requests.
- request timeout.
- close timeout.
- protocol error reporting.
- buffered early notifications.

Tests:

- fake websocket-over-unix server accepts initialize.
- request response routes by id.
- notifications route by `threadId` and `turnId`.
- server requests get responses.
- close rejects pending requests.
- malformed messages surface protocol errors.

Do not refactor `json-rpc-stdio.ts` aggressively in this slice. Extract shared
message routing only if it is small and obvious.

## Slice 2: Codex App-Server Controller

Add:

```text
packages/core/src/tasks/executors/protocol/codex-app-server-controller.ts
```

Responsibilities:

- ensure a shared Codex app-server is running;
- resolve the Unix socket path;
- connect and initialize;
- expose Codex thread/turn/goal helpers;
- normalize provider notifications into Orchestrator event data;
- report provider server metadata.

Primary ensure path:

```sh
codex app-server daemon start
```

Parse the JSON response and keep:

- socket path;
- backend;
- app-server version;
- CLI version when available.

If the daemon command fails because Codex does not support it, return a clear
provider setup error. Test and development code may use an explicit fake socket
path.

Controller API shape:

```ts
ensureCodexAppServer(input): Promise<CodexAppServerEndpoint>
connectCodexAppServer(endpoint): Promise<CodexAppServerConnection>
withCodexAppServerConnection(input, fn): Promise<T>
```

Connection helpers:

```ts
startThread(...)
resumeThread(...)
readThread(...)
unsubscribeThread(...)
startTurn(...)
steerTurn(...)
interruptTurn(...)
getGoal(...)
setGoal(...)
clearGoal(...)
```

Tests:

- ensure parses daemon output.
- ensure reports clear errors on unsupported daemon.
- connection initializes before other requests.
- start/resume/read/unsubscribe call expected JSON-RPC methods.
- daemon ensure is cached per command execution where useful.

## Slice 3: Provider-Backed Task Supervision

Add provider-backed supervision so a running shared Codex session is not treated
as a stale process task.

Extend `TaskSupervision` into a backwards-compatible union:

```ts
type TaskSupervision = ProcessTaskSupervision | ProviderTaskSupervision;

type ProcessTaskSupervision = {
  kind?: "process";
  supervisor: TaskProcessIdentity;
  child?: TaskProcessIdentity;
  processGroupId?: number;
  startedAt: string;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
};

type ProviderTaskSupervision = {
  kind: "provider";
  provider: "codex";
  transport: "unix";
  socketPath?: string;
  startedAt: string;
  staleAfterMs: number;
  lastVerifiedAt?: string;
};
```

Update `observeTaskState`:

- process supervision keeps current behavior;
- provider supervision checks app-server reachability, cached per command where
  possible;
- provider health should be passed in through a small observer/controller helper,
  not by making generic task observation own Codex-specific protocol details;
- reachable provider sessions are actionable when task status is non-terminal;
- unreachable provider sessions show `stale` with reason
  `provider app-server unavailable`;
- terminal tasks keep terminal status.

Update `ps` and compact JSON so provider-backed tasks show the same task/session
fields without requiring a PID.

Tests:

- provider-backed running idle session is actionable without a heartbeat.
- unreachable provider-backed session is stale.
- process-backed tasks keep current stale/orphan/lost behavior.
- compact `ps` includes session and provider metadata for provider-backed
  sessions.

## Slice 4: Shared Session Launch

Change `orchestrator launch codex-app-server --session` to create a
provider-backed task instead of starting a per-task stdio app-server process.

Add a core path, likely:

```text
launchCodexAppServerSessionTask(input: LaunchTaskInput): Promise<AgentTaskRecord>
```

Behavior:

1. Initialize task files.
2. Set task status to `starting`.
3. Ensure shared app-server.
4. Connect and initialize.
5. Call `thread/start` or `thread/resume`.
6. Store `provider.transport = "unix"` and `provider.threadId`.
7. Store `session.state = "idle"`.
8. Store provider-backed supervision.
9. Write normalized events.
10. Return the task as `running`.

Do not launch `__run-task` for this path.

`commandLaunch` should route `codex-app-server --session` to this shared-session
launch path before calling the generic `launchInBackground` helper.

Keep `launchInBackground` for process-backed tasks and isolated stdio
`codex-app-server` one-shot tasks.

Tests:

- session launch returns a running task with no PID requirement.
- task stores `provider.transport = "unix"`.
- task stores `threadId`.
- events include `thread.started` and `session.idle`.
- launch errors leave a clear failed task record.

## Slice 5: Send, Read, And Events

Update `sendTaskMessage`:

- if task is in-memory running, keep current handle path;
- if task is provider-backed Codex session, use the controller directly;
- otherwise use current detached control request path.

Idle session:

- connect;
- initialize;
- resume/read thread;
- call `turn/start`;
- wait for `turn/completed` when requested;
- update `currentOperation`, `lastOperation`, `usage`, `resultMd`, and events;
- return session to `idle`.

Active regular turn:

- call `turn/steer`;
- wait when requested;
- update operation state.

Update `read`:

- keep returning `resultMd`;
- for a running provider-backed session with no local result, optionally refresh
  from `thread/read` only when needed.

Events:

- normalized events go to task `events.jsonl`;
- raw protocol details stay in transcript/diagnostics;
- unknown-thread notifications never write to another task.

Tests:

- send to idle session starts a turn and writes result.
- send to active turn steers.
- two sessions receive separate events/results.
- read returns latest completed operation.
- compact JSON commands stay stable.

## Slice 6: Goals And Interrupts

Update goal functions for provider-backed sessions:

- `goal start` uses `thread/goal/set`;
- `goal get` uses `thread/goal/get`;
- `goal set` edits allowed non-active goal state;
- `goal clear` uses `thread/goal/clear`.

Waiting:

- `goal start --wait` waits for terminal provider goal state.
- goal updates route by `threadId`.
- terminal goal returns the session to `idle`.

Update `interrupt`:

- active turn: `turn/interrupt(threadId, turnId)`;
- active goal: interrupt active goal turn if one exists, then mark operation
  interrupted;
- idle session: unsubscribe and mark session closed/cancelled with the provided
  reason;
- never kill the shared app-server as a per-task fallback.

Tests:

- interrupt one active session does not stop another.
- idle interrupt closes only that Orchestrator session.
- active turn interrupt writes interrupted operation.
- goal start/get/set/clear work against provider-backed session.
- goal wait returns terminal goal state.

## Slice 7: Multi-Session Smoke And Docs

Add fake-server integration tests:

- launch five sessions;
- send work to each;
- run a goal on one;
- interrupt one;
- verify the other four continue;
- verify `ps`, `read`, `events`, and compact JSON.

Add opt-in live smoke:

```sh
RUN_CODEX_APP_SERVER_SHARED_SMOKE=1 node --experimental-strip-types --test test/codex-app-server-shared-smoke.test.ts
```

Docs to update:

- `doc/codex-app-server.md`;
- `README.md` if command examples mention app-server sessions;
- `AGENTS.md` only if contributor guidance changes;
- Orchestrator skill/plugin instructions.

Docs should say:

- `codex` is the stable process runtime.
- `codex-app-server --session` uses a shared Codex app-server and one Codex
  thread per Orchestrator session.
- Users and agents manage Orchestrator task ids, not provider thread ids.
- `interrupt` stops one Orchestrator session, not the shared Codex server.

## Migration Behavior

Existing stdio-backed app-server tasks remain readable.

Rules:

- Tasks with `provider.transport = "stdio"` keep current behavior.
- New `codex-app-server --session` tasks use `provider.transport = "unix"`.
- `resume` from old stdio-backed durable thread can create a new unix-backed
  session when provider `threadId` exists.
- Tasks without provider `threadId` cannot become shared sessions.

## Success Criteria

This work is complete when:

- a Claude Code parent agent can launch several `codex-app-server --session`
  children through Orchestrator;
- each child maps to a different Codex thread in one shared app-server;
- the parent can `send`, `goal start`, `read`, `events`, `ps`, and `interrupt`
  through Orchestrator task ids;
- one child can be interrupted without killing the other Codex sessions;
- `ps --watch` shows multiple sessions clearly;
- fake tests prove event isolation;
- opt-in live smoke passes against a real Codex app-server.

## References

- `adr/research/SPIKE-shared-codex-app-server-thread-controller-20260705-112521.md`
- `adr/research/synthesis-shared-codex-app-server-thread-controller-20260705-114539.md`
- `adr/research/SPIKE-codex-app-server-thread-model-20260701-152153.md`
- `adr/research/SPIKE-codex-app-server-pooling-20260701-072738.md`
- `adr/research/SPIKE-codex-app-server-pooling-intended-use-20260629-172210.md`
- `adr/decisions/0054-use-persistent-codex-app-server-sessions-for-goal-work-20260701-104716.md`
- `adr/decisions/0055-hide-provider-turn-mechanics-behind-session-operations-20260704-094016.md`
