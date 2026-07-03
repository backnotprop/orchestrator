# Synthesis: Codex App-Server Steering

Date: 2026-06-30

## Summary

Codex app-server already supports native live steering through `turn/steer`.
The hard part is not the Codex API. The hard part is that Orchestrator launches
background work in detached task runner processes. A later CLI command can read
task files, but it cannot call the live in-memory JSON-RPC client owned by the
detached task runner.

The cleanest low-edge-case approach is file-backed task control requests. That
fits Orchestrator's current file-backed task model and avoids adding sockets,
ports, local servers, daemon lifecycle, or stale listener cleanup.

## What We Should Build

Expose a generic user-facing command:

```sh
orchestrator send <task-id|prefix> "Actually focus on failing tests first."
```

Expose the matching parent-agent tool later:

```text
send_agent_message({ taskId, message })
```

For `codex-app-server`, that generic send operation maps to Codex's native:

```text
turn/steer { threadId, expectedTurnId, input }
```

Do not expose Codex protocol naming as the primary product language. Users and
agents are sending a message to a running task. Codex happens to call that
operation steering.

## Why File-Backed Control Requests

Orchestrator already persists task state as files:

- `task.json`
- `events.jsonl`
- `transcript.jsonl`
- `stdout.log`
- `stderr.log`
- `result.md`
- `heartbeat.json`

A control request file is the smallest consistent extension:

```text
.orchestrator/tasks/<task-id>/control/requests/<request-id>.json
.orchestrator/tasks/<task-id>/control/responses/<request-id>.json
```

This gives us:

- deterministic cross-process communication;
- durable audit trail;
- easy testing in temp directories;
- no socket lifecycle;
- no stale listener cleanup;
- no local HTTP server;
- no dependency on one long-lived daemon.

Sockets may become attractive for a real service mode, but they add more
lifecycle edge cases than they remove for the current CLI-first task runner.

## Current Code Fit

The existing executor shape already has the right place to add this.

`TaskExecutionHandle` currently exposes only:

```ts
completed
interrupt(...)
```

Add a narrow optional method:

```ts
sendMessage ? input : Promise<result>;
```

The supervisor already keeps the live handle in memory for tasks running in the
same process. For detached tasks, the task runner process should watch its own
control request directory and call the same handle method.

The `codex-app-server` executor already owns:

- the live JSON-RPC client;
- `threadId`;
- `turnId`;
- notification handling;
- normalized event writing;
- native `turn/interrupt`.

Adding native `turn/steer` is a small executor change once the control request
path exists.

## Recommended Slices

### Slice 1: Task Control Request Files

Add the internal request/response file path, request type, atomic writes, and a
polling loop owned by the running task process.

Outcome: a later CLI process can ask a running task process to handle one
control request and return a response.

### Slice 2: Codex App-Server Send Message

Add optional executor support for sending a message. For `codex-app-server`,
translate it to native `turn/steer`.

Outcome: a running app-server task can accept additional user input without
starting a new Orchestrator task or a new Codex turn.

### Slice 3: CLI And Parent Tool

Add:

```sh
orchestrator send <task-id|prefix> "message"
```

Then add:

```text
send_agent_message
```

Outcome: humans and agents can send follow-up instructions to running tasks
without knowing Codex protocol details.

## Important Boundaries

This does not add:

- app-server pooling;
- Codex goals;
- cross-process app-server rejoin;
- public protocol custom-agent config;
- general bidirectional chat with every runtime;
- a service daemon.

This is a narrow running-task control feature.

## References

- `adr/research/SPIKE-codex-app-server-steering-20260630-195440.md`
- `adr/decisions/0006-treat-subagents-as-durable-asynchronous-task-sessions.md`
- `adr/decisions/0050-use-simple-task-shaped-resume-before-pooling-20260630-051045.md`
- `adr/decisions/0052-enable-task-shaped-resume-for-codex-app-server-20260630-163334.md`
