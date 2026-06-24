# Research Spike: Codex App-Server Support

Date: 2026-06-24

## Question

What would it take for Orchestrator to support Codex app-server, and what would
that change?

## Short Answer

Supporting Codex app-server is feasible, but it is not just a different command
line for the current `codex exec` adapter.

Today Orchestrator launches Codex as a headless child process:

```text
codex exec --skip-git-repo-check --json "<task>"
```

It supervises that process, captures stdout/stderr, parses JSONL, and marks one
Orchestrator task complete when the process exits.

Codex app-server is a JSON-RPC service. A client starts or connects to
`codex app-server`, initializes the protocol, starts or resumes a thread, starts
a turn, consumes notifications, handles server requests, and optionally sends
control requests such as `turn/interrupt`, `turn/steer`, and `thread/goal/set`.

That unlocks better control and observability, but it changes the adapter from
"spawn a CLI and parse stdout" to "own a live protocol session."

## Current Orchestrator Shape

Relevant files:

- `packages/core/src/runtime/runtimes.ts`
- `packages/core/src/runtime/types.ts`
- `packages/core/src/runtime/launch-plan.ts`
- `packages/core/src/tasks/supervisor.ts`
- `packages/core/src/tasks/output-adapters.ts`
- `packages/agent/src/tools.ts`

Current Codex runtime:

- executable: `codex`
- args: `exec --skip-git-repo-check`
- prompt transport: argv
- default output mode: JSONL via `--json`
- interrupt: process group
- resume: `codex exec resume`

The task supervisor always creates a process with `spawn(...)`. It then:

- writes task files;
- records `queued`, `starting`, `running`, stdout/stderr, result, and terminal
  events;
- parses runtime output through an output adapter;
- interrupts with process-group kill;
- stores process identity and heartbeat metadata.

The runtime types already have hints for future non-process integrations:

- `PromptTransport` includes `sdk` and `http`;
- `InterruptStrategy` includes `api`;
- `AgentLaunchPlan` has `taskForSdkOrHttp`.

But those are not implemented by the supervisor yet. A plan still becomes a
spawned process.

## Codex App-Server Shape

Codex app-server is a binary surface:

```text
codex app-server --listen stdio://
codex app-server --listen unix://
codex app-server --listen unix://PATH
codex app-server --listen ws://IP:PORT
```

Evidence:

- `/Users/ramos/oss-agents/codex/codex-rs/app-server/src/main.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-transport/src/transport/mod.rs`

The default transport is `stdio://`.

The stdio transport reads newline-delimited JSON-RPC messages from stdin and
writes newline-delimited JSON-RPC messages to stdout.

Evidence:

- `/Users/ramos/oss-agents/codex/codex-rs/app-server-transport/src/transport/stdio.rs`

Codex also has Unix socket and WebSocket transports. WebSocket listeners refuse
unsafe non-loopback unauthenticated use.

Evidence:

- `/Users/ramos/oss-agents/codex/codex-rs/app-server-transport/src/transport/unix_socket.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-transport/src/transport/websocket.rs`

There is also `codex remote-control`, which can start an app-server daemon with
remote control enabled. That looks more useful for remote UX than for our first
local task adapter.

Evidence:

- `/Users/ramos/oss-agents/codex/codex-rs/cli/src/remote_control_cmd.rs`

## Basic Protocol Flow

A minimal local client would:

1. Spawn `codex app-server --listen stdio://`.
2. Send `initialize` with client info and `experimentalApi: true`.
3. Send `initialized`.
4. Send `thread/start` with model, cwd, sandbox/approval settings, and optional
   instructions.
5. Send `turn/start` with the prompt as `UserInput::Text`.
6. Route responses by JSON-RPC id.
7. Route notifications by `threadId` and `turnId`.
8. Collect item notifications, token usage notifications, and
   `turn/completed`.
9. Write normalized Orchestrator task events and final result.
10. On interrupt, send `turn/interrupt`, then fall back to process kill if the
    app-server process does not stop.

Relevant protocol methods:

- `thread/start`
- `thread/resume`
- `thread/read`
- `thread/turns/list`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `thread/goal/set`
- `thread/goal/get`
- `thread/goal/clear`

Relevant notifications:

- `thread/started`
- `thread/status/changed`
- `turn/started`
- `item/started`
- `item/agentMessage/delta`
- `item/completed`
- `turn/plan/updated`
- `turn/diff/updated`
- `thread/tokenUsage/updated`
- `turn/completed`
- `thread/goal/updated`
- `thread/goal/cleared`

Evidence:

- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/common.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/turn.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server/tests/common/test_app_server.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server/tests/suite/v2/turn_start.rs`

## Existing SDK Reference

The TypeScript SDK currently wraps `codex exec --experimental-json`; it does not
expose app-server or goal APIs.

Evidence:

- `/Users/ramos/oss-agents/codex/sdk/typescript/src/exec.ts`
- `/Users/ramos/oss-agents/codex/sdk/typescript/src/thread.ts`

The Python SDK is the better app-server reference. It starts:

```text
codex app-server --listen stdio://
```

Then it initializes JSON-RPC, starts threads, starts turns, routes responses and
notifications, collects final answers, captures token usage, supports
interrupt/steer, and has goal helpers.

Evidence:

- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/client.py`
- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/api.py`
- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/_message_router.py`
- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/_run.py`
- `/Users/ramos/oss-agents/codex/sdk/python/tests/test_app_server_run.py`
- `/Users/ramos/oss-agents/codex/sdk/python/tests/test_app_server_goal_operations.py`
- `/Users/ramos/oss-agents/codex/sdk/python/examples/11_cli_mini_app/sync.py`

For Orchestrator, the Python SDK is useful as a design reference. It should not
become a hard dependency for the Node packages unless we intentionally accept a
Python runtime dependency.

## What App-Server Would Improve

### Native Goals

The previous spike found that `codex exec "/goal ..."` does not set a goal.

App-server changes that. It exposes:

- `thread/goal/set`
- `thread/goal/get`
- `thread/goal/clear`

That means Orchestrator could explicitly create a persisted Codex thread goal
instead of smuggling `/goal` through prompt text.

Important detail: Codex goals require a persisted thread. Ephemeral threads do
not support goals.

Reference:

- `adr/research/SPIKE-codex-exec-goal-support-20260623-212322.md`

### Better Live Events

`codex exec --json` gives us a useful JSONL stream, but app-server is the richer
native event surface. It has structured notifications for:

- message deltas;
- item completion;
- plans;
- diffs;
- token usage;
- goal changes;
- thread and turn status.

This maps well to Orchestrator's `events`, `ps --watch`, and future TUI.

### Better Token Data

Prior token research found that app-server emits
`thread/tokenUsage/updated`. That gives Orchestrator a direct protocol event for
usage instead of relying only on final `codex exec` output.

It does not magically guarantee per-token live increments; provider usage can
still arrive at response completion. But app-server is the right native surface
for whatever Codex knows during the run.

References:

- `adr/research/SPIKE-token-metrics-codex-20260619-085009.md`
- `adr/research/SPIKE-token-metrics-codex-harness-transmission-20260619-140002.md`

### API Interrupt And Steer

Current Orchestrator cancellation for Codex is process-group kill.

App-server exposes:

- `turn/interrupt`
- `turn/steer`

That means a Codex app-server runtime could cancel or steer a running turn
through Codex's own control plane before falling back to killing the process.

This would make `supportsRunningSteer` real for Codex.

### Thread Reuse

`codex exec` can resume a thread, but the app-server makes thread lifecycle a
first-class protocol surface:

- start;
- resume;
- fork;
- read;
- list;
- compact;
- set name;
- archive.

That matters if Orchestrator eventually wants long-lived Codex sub-agents rather
than one prompt per process.

## What It Would Change In Orchestrator

### Runtime Model

Today a runtime is mostly:

```text
command + args + prompt transport + output transport
```

App-server needs a richer split:

```text
process runtime: spawn command, parse stdout/stderr
protocol runtime: start/connect to service, send requests, consume events
remote runtime: call HTTP/WebSocket service, no local process ownership
```

The existing `sdk`, `http`, and `api` type hints are not enough by themselves.
The task supervisor needs an executor boundary.

### Task Supervision

Current `launchTask(...)` owns process supervision directly.

For app-server, we need either:

1. A child runner process that speaks app-server and emits Orchestrator JSONL.
2. A native task executor abstraction inside `@backnotprop/orchestrator-core`.

Option 1 is smaller. Orchestrator would still supervise one process. The runner
would be a Node script that:

- starts Codex app-server;
- speaks JSON-RPC;
- converts app-server events into Orchestrator runtime events;
- writes final result;
- exits.

Option 2 is cleaner long term. Core would understand:

- process-backed tasks;
- protocol-backed tasks;
- API interruption;
- provider session ids;
- non-process liveness.

But option 2 is a real refactor.

### Task Records

Codex app-server tasks need provider metadata:

```json
{
  "provider": "codex",
  "transport": "app-server",
  "threadId": "...",
  "turnId": "...",
  "goalId": "optional",
  "appServerPid": 12345
}
```

Today `AgentTaskRecord` has `pid`, `supervision`, `location`, `labels`, and
`usage`, but no first-class provider session metadata. We can store this in
events or labels first, but a real adapter should add explicit metadata.

### Output Adapter

Current Codex output normalization parses JSONL from stdout.

App-server output normalization would consume JSON-RPC notifications. It should
map notifications into the same normalized event categories Orchestrator already
uses:

- `runtime.system`
- `runtime.item.*`
- `agent.message`
- `agent.result`
- `agent.usage`
- `runtime.error`

The result should still end up in `result.md`, and raw app-server protocol
events should still be debuggable, likely in `transcript.jsonl`.

### Interrupt

For app-server tasks, interrupt should be:

1. mark stop requested;
2. send `turn/interrupt` if a `threadId` and `turnId` are known;
3. wait for `turn/completed` with interrupted/failed status;
4. kill the app-server runner/process only if the protocol path does not settle.

That is different from current process-group-first cancellation.

### Parent-Agent Tools

The parent agent probably should not learn a new tool for Codex app-server.

It should still call:

```text
launch_agent
read_agent
read_agent_events
read_agent_logs
interrupt_agent
```

The runtime id or runtime config decides whether Codex uses `exec` or
app-server. This keeps the parent-agent interface stable.

## Implementation Options

### Option A: Keep Current `codex` Runtime, Add Experimental `codex-app-server`

This is the safest path.

Add a new runtime id:

```text
codex-app-server
```

Then implement a runner that makes app-server look like a structured runtime to
the existing process supervisor.

Pros:

- does not break current Codex behavior;
- low-risk comparison against `codex exec`;
- reuses current task store, logs, events, ps, interrupt shell;
- good test surface.

Cons:

- still uses a process wrapper;
- API interrupt and steer are inside the runner, not core;
- long-lived app-server reuse is not solved.

### Option B: Replace `codex` Runtime With App-Server

This is too aggressive for the first pass.

Pros:

- one Codex path;
- richer runtime immediately.

Cons:

- higher regression risk;
- more protocol code before we know the exact product shape;
- current smoke tests and expectations change.

### Option C: Add A Native Protocol Executor To Core

This is the long-term clean architecture.

Pros:

- app-server becomes a real first-class runtime implementation;
- API interrupts and steering fit naturally;
- future remote agents can use similar execution machinery.

Cons:

- bigger core refactor;
- harder to review;
- more edge cases around liveness, heartbeats, and stale tasks.

### Option D: Shell Out To Python SDK

This is useful as a prototype, but not as the package architecture.

Pros:

- Python SDK already solved routing and result collection;
- fastest proof of behavior.

Cons:

- introduces Python as a runtime dependency for a Node package;
- awkward packaging;
- harder to debug from the Orchestrator codebase.

## Recommended Path

Start with Option A.

Build an experimental `codex-app-server` runtime using a small Node runner
process. The runner should speak Codex app-server over stdio and emit
Orchestrator-compatible JSONL events. The existing supervisor can continue to
own task files, logs, heartbeats, and process cleanup.

This keeps the current architecture stable while proving the app-server value.

If the runtime proves useful, move toward Option C by extracting a real
task-executor boundary in core.

## Minimum Viable Runner

The first runner should support:

- spawn `codex app-server --listen stdio://`;
- initialize JSON-RPC;
- send `thread/start`;
- send `turn/start`;
- route JSON-RPC responses by id;
- route notifications by turn id;
- collect final response from completed agent-message items;
- capture `thread/tokenUsage/updated`;
- write app-server protocol transcript;
- emit normalized JSONL events;
- exit when `turn/completed` arrives;
- on SIGTERM, send `turn/interrupt`, then kill app-server after a short timeout.

Do not implement goals in the first runner unless we are specifically testing
goals. First make normal turn execution correct.

## Goal Support After The Runner

Native Codex goal support would require:

1. Start a persisted thread.
2. Verify the thread is idle and not ephemeral.
3. Clear existing goal if needed.
4. Send `thread/goal/set` with objective and active status.
5. Wait for Codex's runtime-generated goal turn.
6. Route multiple physical turns as one logical Orchestrator task if Codex
   auto-continues the goal.
7. Finish when the goal reports complete, blocked, paused, usage-limited, or
   budget-limited.

The Python SDK has a private implementation that coalesces runtime continuations
into one logical goal operation. That is the right behavior to study before we
build our own.

Evidence:

- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/client.py`
- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/_goal.py`
- `/Users/ramos/oss-agents/codex/sdk/python/tests/test_app_server_goal_operations.py`

## Testing Strategy

Use three layers:

1. Unit tests for JSON-RPC routing.
   - response id routing;
   - turn notification routing;
   - early notification buffering;
   - error response handling;
   - malformed JSON handling.

2. Runner tests with a fake app-server process.
   - validate the request sequence;
   - emit controlled notifications;
   - verify normalized events and final result.

3. Optional live smoke tests against real Codex.
   - `RUN_CODEX_APP_SERVER_SMOKE=1`
   - use cheap model where available;
   - skip by default.

Do not require a live Codex account for normal CI.

## Risks

- App-server protocol may move faster than `codex exec` JSONL.
- Some fields are experimental and require `experimentalApi: true`.
- App-server can send server requests for approvals; the runner must either
  handle them or configure approval/sandbox behavior to avoid interactive hangs.
- Thread goals require persisted threads, so ephemeral mode will not work for
  goals.
- Long-lived shared app-server support is a separate problem from per-task local
  runners.
- Token usage still depends on what Codex/provider knows at runtime; app-server
  is the better surface, but it does not guarantee smooth token increments.

## Conclusion

Codex app-server support would give Orchestrator a more native Codex adapter:
goals, thread lifecycle, turn interrupt, turn steer, richer event streaming, and
better token usage events.

The right first move is not to refactor the whole task supervisor. Add an
experimental `codex-app-server` runtime backed by a small Node runner process.
Let the current process supervisor manage that runner. If it proves materially
better than `codex exec`, then promote protocol-backed runtimes into core.
