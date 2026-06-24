# Synthesis: Protocol Session Adapter

Date: 2026-06-24

## Sources

- `adr/research/SPIKE-protocol-session-adapter-20260624-050708.md`
- `adr/research/SPIKE-codex-app-server-support-20260624-045625.md`
- `adr/research/SPIKE-codex-exec-goal-support-20260623-212322.md`
- `adr/specs/token-usage-contract-20260619-135212.md`
- `doc/custom-agents.md`
- `doc/live-agent-view.md`
- `packages/core/src/runtime/types.ts`
- `packages/core/src/runtime/launch-plan.ts`
- `packages/core/src/tasks/supervisor.ts`
- `packages/core/src/tasks/output-adapters.ts`
- `packages/core/src/tasks/types.ts`

## Where The Research Landed

Codex app-server should not be treated as a new command-line flavor of the
current Codex runtime.

The current runtime path is:

```text
runtime config -> launch plan -> spawn process -> parse stdout/stderr
```

That works well for `codex exec`, `claude -p`, and custom process agents. It
does not match Codex app-server. Codex app-server is a live JSON-RPC protocol
session with initialization, thread lifecycle, turn lifecycle, notifications,
token usage updates, API interrupt, steer, and goal operations.

The right model is:

```text
runtime config -> launch plan -> task executor -> task store/events/result
```

The task store stays central. The executor changes how a task runs.

## Adapter Families

Orchestrator should keep adapter kinds few and concrete:

- `process`: run a local command, pass a prompt, capture stdout/stderr, finish
  when the process exits.
- `http`: submit work to a remote or local HTTP service, then fetch or subscribe
  to status, events, result, and cancel operations.
- `protocol`: keep a live session open to an agent service and route requests,
  responses, notifications, usage updates, interrupts, and session ids.

Codex app-server fits `protocol`.

This is related to HTTP because both are non-process integrations, but the
lifecycle is different. HTTP is job-oriented. Protocol is session-oriented.

## Why This Matters

If we force Codex app-server into the process adapter, the design gets bent in
bad ways:

- JSON-RPC protocol messages become fake stdout logs.
- Thread and turn ids get hidden in provider output instead of stored as task
  metadata.
- API interrupt becomes a side channel beside process-group kill.
- Token updates need a translation runner instead of flowing through the task
  system directly.
- Every future protocol tool would need another one-off runner.

If we force Codex app-server into HTTP, we lose the important shape of the
system: one open session, multiple in-flight request ids, server notifications,
turn routing, and live control.

## What Should Stay Stable

The user-facing Orchestrator model should not change.

These commands should keep working the same way:

```sh
orchestrator launch <runtime> "Do the task."
orchestrator ps --watch
orchestrator read <task-id>
orchestrator logs <task-id>
orchestrator events <task-id>
orchestrator interrupt <task-id>
```

Parent-agent tools should also keep the same shape:

- `launch_agent`
- `list_agents`
- `read_agent`
- `read_agent_events`
- `read_agent_logs`
- `interrupt_agent`

The difference is internal. Some runtimes are run by spawning a task process.
Some future runtimes may be run by an HTTP job client. Codex app-server should
be run by a protocol executor.

## Recommended Direction

Build a task executor boundary under `launchTask(...)`.

The process path should be extracted first with no behavior change. That keeps
existing Claude Code, Codex exec, Pi, shell, and custom process agents stable.

Then add a Codex protocol executor as an experimental built-in runtime, likely:

```text
codex-app-server
```

The existing `codex` runtime should remain the stable default.

## What To Avoid

Do not expose a broad public `adapter: "protocol"` config immediately.

Custom agents currently support:

```json
{ "adapter": "process" }
```

The docs already point toward future:

```json
{ "adapter": "http" }
```

Protocol config is harder to get right. It has method names, notification
routing, request ids, provider metadata, and live control semantics. We should
not make users configure that until at least one more real protocol tool proves
the shape.

Do not build a long-lived Codex app-server pool first. Per-task app-server is
simpler and safer for the first version. Persistent sessions can come later.

Do not remove or replace `codex exec`. It remains the reliable process runtime.

## Practical Build Order

1. Extract the current process spawn code into a process task executor.
2. Add provider/session metadata to task records.
3. Add a small internal JSON-RPC client for stdio.
4. Add a Codex app-server protocol executor.
5. Add opt-in live smoke tests.
6. Revisit public protocol config only after another real protocol tool appears.

## Decision Pressure

The main pressure is not whether Codex app-server is useful. It is useful.

The real decision is whether to pay the small architecture cost now by adding an
executor boundary, or to ship a shortcut runner that we will probably unwind.

The synthesis is that the executor boundary is worth it. It keeps Orchestrator
from becoming process-only while preserving the existing task model.
