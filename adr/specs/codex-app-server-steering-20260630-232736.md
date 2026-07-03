# Spec: Send Messages To Running Codex App-Server Tasks

Date: 2026-06-30

## Intent

Let humans and agents send an additional instruction to a running
`codex-app-server` task.

Public shape:

```sh
orchestrator send <task-id|prefix> "Actually focus on failing tests first."
```

Codex implementation detail:

```text
turn/steer { threadId, expectedTurnId, input }
```

## Goals

- Add a deterministic way for a later CLI process to talk to a detached running
  task runner process.
- Keep the product language simple: send a message to a running task.
- Support only `codex-app-server` first.
- Use Codex's native `turn/steer`.
- Keep all task observability on the existing task surfaces:
  `ps`, `events`, `watch`, `logs`, and `read`.
- Keep raw protocol traffic in `transcript.jsonl`, not user-facing logs.

## Non-Goals

- No sockets.
- No local HTTP server.
- No app-server pooling.
- No Codex goals.
- No steering terminal tasks.
- No cross-process rejoin to a Codex app-server after the task runner exits.
- No public protocol custom-agent config.
- No generic support for all runtimes in this slice.

## User Behavior

Launch a long-running app-server task:

```sh
orchestrator launch codex-app-server --name "api review" "Review the API package carefully."
```

Send it a follow-up while it is still running:

```sh
orchestrator send <task-id> "Focus on failing tests first."
```

Expected output:

```text
sent message to api review
```

Machine output:

```sh
orchestrator send <task-id> "Focus on failing tests first." --json --compact
```

```json
{
  "schemaVersion": 1,
  "ok": true,
  "task": {
    "id": "abc12345",
    "taskId": "abc12345-....",
    "runtime": "codex-app-server",
    "status": "running"
  },
  "message": {
    "status": "accepted",
    "provider": {
      "threadId": "thr_123",
      "turnId": "turn_456"
    }
  }
}
```

This output only means the running task accepted the message. It does not mean
the task finished.

## Internal Control Request Files

Add task control paths under each task directory:

```text
control/requests/
control/responses/
control/processed/
```

These can be added either to `TaskPaths` or through a helper derived from
`TaskPaths.taskDir`.

Request file:

```text
.orchestrator/tasks/<task-id>/control/requests/<request-id>.json
```

Response file:

```text
.orchestrator/tasks/<task-id>/control/responses/<request-id>.json
```

Use atomic writes:

1. write `<request-id>.json.tmp`;
2. rename to `<request-id>.json`.

After handling, move or copy the request to:

```text
control/processed/<request-id>.json
```

Do not delete handled requests immediately. Keeping them makes debugging easier.

## Control Request Types

Initial request:

```ts
type TaskControlRequest = {
  schemaVersion: 1;
  requestId: string;
  taskId: string;
  createdAt: string;
  kind: "send_message";
  input: {
    text: string;
    clientMessageId?: string;
  };
};
```

Initial response:

```ts
type TaskControlResponse = {
  schemaVersion: 1;
  requestId: string;
  taskId: string;
  kind: "send_message";
  status: "accepted" | "failed";
  createdAt: string;
  completedAt: string;
  provider?: {
    threadId?: string;
    turnId?: string;
  };
  error?: {
    reason:
      | "unsupported"
      | "not_running"
      | "not_ready"
      | "provider_rejected"
      | "turn_mismatch"
      | "invalid_request";
    message: string;
  };
};
```

The CLI may also return `timeout`, `stale`, `orphaned`, or `lost` before a
request is accepted, based on task observation.

## Core API

Add core types:

```ts
type SendTaskMessageInput = TaskStoreOptions & {
  taskId: string;
  text: string;
  timeoutMs?: number;
};

type SendTaskMessageResult = {
  task: AgentTaskRecord;
  status: "accepted";
  provider?: TaskProviderMetadata;
};
```

Add:

```ts
sendTaskMessage(input: SendTaskMessageInput): Promise<SendTaskMessageResult>
```

Behavior:

1. resolve the task id or prefix;
2. read `task.json`;
3. reject terminal tasks;
4. observe task liveness;
5. reject stale, orphaned, lost, or unsafe tasks;
6. reject runtimes without running-message support;
7. if the task is running in this process, call the live handle directly;
8. otherwise write a control request and wait for a response;
9. timeout clearly if the detached task runner does not answer.

Default timeout: 5 seconds.

## Executor Handle

Extend:

```ts
export type TaskExecutionHandle = {
  completed: Promise<AgentTaskRecord>;
  interrupt(reason: string, signal?: NodeJS.Signals): Promise<void> | void;
  sendMessage?(input: TaskSendMessageInput): Promise<TaskSendMessageResult>;
};
```

Process runtimes do not implement `sendMessage`.

`codex-app-server` implements it.

## Running Task Control Loop

The task runner process should poll its own control request directory while the
task is active.

Initial behavior:

- poll every 100-250ms;
- read pending request files in created order;
- ignore malformed partial files by relying on atomic rename;
- handle one request at a time;
- write a response file for success or failure;
- move handled request files to `processed`;
- stop polling when the task reaches a terminal state.

This polling should live in shared supervisor code, not inside every executor.
The supervisor owns task files and can call optional handle methods.

## Codex App-Server Behavior

Set runtime metadata:

```ts
control.steerRunning = true;
capabilities.supportsRunningSteer = true;
```

In `CodexAppServerTaskExecutor.sendMessage`:

1. trim and validate text;
2. require live `client`;
3. require `state.threadId`;
4. require `state.turnId`;
5. append `agent_event` kind `protocol.message.requested`;
6. call:

```ts
client.request("turn/steer", {
  threadId: state.threadId,
  expectedTurnId: state.turnId,
  input: [{ type: "text", text }],
  ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
});
```

7. verify returned `turnId` matches `state.turnId`;
8. append `agent_event` kind `protocol.message.sent`;
9. return provider metadata.

If Codex rejects the request, return `provider_rejected` and include the Codex
message.

If the returned turn id differs, return `turn_mismatch`.

## CLI

Add:

```sh
orchestrator send <task-id|prefix> "<message>" [--json [--compact]] [--timeout-ms <ms>]
```

Parser rules:

- exactly one task id;
- exactly one message;
- message must not be empty;
- `--compact` requires `--json`;
- support common options: `--workspace`, `--orchestrator-dir`, `--config`,
  `--json`.

Human output:

```text
sent message to <name-or-short-id>
```

Human failures should say what to do next:

- task finished: use `orchestrator resume <id> "message"`;
- task not ready: wait and retry;
- unsupported runtime: launch a new task or use resume if supported;
- stale/lost: inspect `read`, `events`, and `logs`.

## Parent-Agent Tool

After the CLI/core path works, add:

```text
send_agent_message
```

Input:

```ts
{
  taskId: string;
  message: string;
  timeoutMs?: number;
}
```

Return:

```ts
{
  task: { taskId, id, name?, runtime, status },
  status: "accepted",
  provider?: { threadId?, turnId? }
}
```

Tool guidance:

- use this only for running tasks;
- use `read_agent` for results;
- use `resume`/new launch when the task is already finished.

## Events

Add normalized events:

```text
protocol.message.requested
protocol.message.sent
protocol.message.failed
```

These are `agent_event` entries. They should appear through:

```sh
orchestrator events <task-id> --agent-only
orchestrator watch <task-id> --agent-only --json
```

Do not expose raw JSON-RPC request/response lines through `logs`.

## Tests

### Unit / Core

- control request paths are derived correctly;
- request writes are atomic;
- malformed request files are ignored or rejected safely;
- terminal task rejects `sendTaskMessage`;
- unsupported runtime rejects `sendTaskMessage`;
- stale/lost supervised task rejects `sendTaskMessage`;
- same-process `launchTask` can send a message through the live handle.

### Fake Codex App-Server

Add fake handling for:

```text
turn/steer
```

Modes:

- accepts steering and returns `{ turnId }`;
- rejects because no active turn;
- rejects because expected turn id mismatches;
- delays response to test timeout.

### CLI

- `orchestrator send <id> "message" --json` succeeds against a running fake
  `codex-app-server` task;
- compact JSON includes task id, runtime, status, thread id, and turn id;
- `events --agent-only` includes normalized message events;
- terminal task returns a useful error that points to `resume`;
- process runtime returns unsupported;
- timeout returns a machine-readable error.

### Parent Tool

- parent agent exposes `send_agent_message`;
- tool accepts a running fake `codex-app-server` task;
- tool returns clear errors for terminal and unsupported tasks.

## Implementation Slices

### Slice 1: Control Request Files

Build the generic file-backed control request path and polling loop. Add
`sendTaskMessage`, but it can return unsupported until an executor implements
the handle method.

This is the architecture slice.

### Slice 2: Codex App-Server Send Message

Implement `sendMessage` on the app-server executor and fake app-server
coverage.

This is the provider behavior slice.

### Slice 3: CLI

Add `orchestrator send`, JSON/compact output, help text, and docs.

This is the human/agent CLI slice.

### Slice 4: Parent-Agent Tool

Add `send_agent_message` and parent-agent instructions.

This is the orchestration tool slice.

## Rollout Recommendation

Do slices 1 and 2 together if possible. A control path without one working
runtime is hard to validate meaningfully.

Do slices 3 and 4 after the core behavior is stable.

Do not add sockets, pooling, goals, or service mode in this work.

## References

- `adr/research/SPIKE-codex-app-server-steering-20260630-195440.md`
- `adr/research/synthesis-codex-app-server-steering-20260630-232736.md`
- `adr/decisions/0006-treat-subagents-as-durable-asynchronous-task-sessions.md`
- `adr/decisions/0052-enable-task-shaped-resume-for-codex-app-server-20260630-163334.md`
