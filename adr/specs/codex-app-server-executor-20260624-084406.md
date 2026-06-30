# Codex App-Server Executor Spec

Date: 2026-06-24

## Status

Draft spec for Slice 5.

## Intent

Add `codex-app-server` as the first protocol-backed runtime while keeping the
existing Orchestrator task model intact. A user or parent agent should still use
the same commands: `launch`, `ps`, `read`, `events`, `logs`, `watch`, and later
`interrupt`. The internal difference is that this runtime talks JSON-RPC to a
live Codex app-server process instead of parsing a normal child process stdout
stream.

This slice makes the protocol feature real enough to launch, observe, and read a
Codex app-server task. It does not replace `codex exec`, expose public protocol
custom-agent config, or build long-lived app-server pooling.

## References

- `adr/decisions/0046-extract-task-executor-foundation-for-protocol-runtimes-20260624-055627.md`
- `adr/decisions/0047-build-internal-json-rpc-stdio-client-20260624-065645.md`
- `adr/specs/protocol-session-adapter-20260624-054713.md`
- `adr/research/synthesis-protocol-session-adapter-20260624-054713.md`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/turn.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/jsonrpc_lite.rs`
- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/client.py`
- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/_message_router.py`

## Current Orchestrator Shape

Slice 4 exists:

- `packages/core/src/tasks/executors/process.ts`
- `packages/core/src/tasks/executors/protocol/json-rpc-stdio.ts`
- `packages/core/src/tasks/executors/types.ts`

But runtime selection is still process-only:

- `AgentLaunchPlan` has no execution kind.
- `launchTask(...)` always starts `ProcessTaskExecutor`.
- `TaskExecutionContext` only exposes `appendEvent`.
- protocol executors cannot yet write result, transcript, usage, provider
  metadata, heartbeat, stdout, stderr, or terminal status through a shared
  supervisor-owned API.

`AgentTaskRecord` already has the provider metadata shape we need:

```ts
provider?: {
  provider?: string
  protocol?: "jsonrpc"
  transport?: "stdio" | "unix" | "websocket" | "http"
  threadId?: string
  turnId?: string
  sessionId?: string
  remoteTaskId?: string
  connectionId?: string
}
```

## Spec Adjustments

The broad protocol spec remains right, with these refinements:

- Use ephemeral Codex threads for Slice 5.
- Do not include goals in Slice 5. Goals require persisted threads and belong in
  a later slice.
- Use `threadTokenUsageUpdated.tokenUsage.last` for task/turn usage. Do not use
  `tokenUsage.total` as the task token count, because `total` is thread-level.
- Implement basic cleanup by closing/killing the app-server process. Full
  `turn/interrupt` behavior stays in Slice 6 unless it is trivial to wire after
  launch/read works.
- Treat Codex app-server protocol field names as camelCase JSON:
  `threadId`, `turnId`, `tokenUsage`, `inputTokens`, `cachedInputTokens`,
  `outputTokens`, `reasoningOutputTokens`, and `totalTokens`.
- Support server-initiated JSON-RPC requests in the stdio client. Codex
  app-server can ask the client for approval callbacks, so a client that only
  handles responses and notifications can hang real turns.

## Preflight Adjustment: Server Requests

Codex app-server is not only a notification stream. It can send JSON-RPC
requests from server to client, especially:

```text
item/commandExecution/requestApproval
item/fileChange/requestApproval
```

Slice 4's JSON-RPC client currently routes responses by `id` and notifications
by `method`, but it does not yet answer messages that contain both `method` and
`id`. Add a small request hook before or during the Codex executor work:

```ts
type JsonRpcServerRequestHandler = (request: {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}) => Promise<unknown> | unknown;
```

Rules:

- Messages with `method` and `id` are server requests.
- Route them to the handler and write `{ "id": <id>, "result": <value> }` on
  success.
- Write a JSON-RPC error response on handler failure.
- Preserve existing response and notification behavior.
- Add fake-server tests for server requests so real Codex turns cannot deadlock
  on an unanswered callback.

For Slice 5, the Codex executor should answer the known approval request methods
with the same basic headless policy used by the Codex Python SDK:
`{ "decision": "accept" }`. Unknown server requests should receive `{}` and be
recorded as adapter diagnostics instead of hanging the task.

## Runtime Registry

Add a built-in runtime:

```text
id: codex-app-server
displayName: Codex App Server
enabled: true
detect.command: codex
launch.executable: codex
launch.baseArgs: ["app-server", "--listen", "stdio://"]
prompt.kind: sdk
output.kind: transcript_file
control.interrupt: api
```

`codex` remains the stable process runtime. `codex-app-server` is a separate
runtime because its lifecycle, event stream, control path, and failure modes are
different.

## Runtime Type Changes

Add an internal execution kind:

```ts
type RuntimeExecutionKind = "process" | "protocol";

type HeadlessAgentRuntimeConfig = {
  executionKind?: RuntimeExecutionKind; // default "process"
  ...
};

type AgentLaunchPlan = {
  executionKind: RuntimeExecutionKind;
  taskForProtocol?: string;
  ...
};
```

Rules:

- Omitted `executionKind` means `"process"` for existing runtimes and custom
  process agents.
- `prompt.kind === "sdk"` can feed either `taskForSdkOrHttp` or
  `taskForProtocol`; the executor choice decides which one matters.
- The public custom-agent config should not accept protocol adapters yet.

## Executor Context Changes

Expand `TaskExecutionContext` with supervisor-owned helpers so protocol
executors do not duplicate task-store logic:

```ts
type TaskExecutionContext = {
  input: LaunchTaskInput;
  taskId: string;
  task: AgentTaskRecord;
  paths: TaskPaths;
  maxOutputBytes: number;

  appendEvent(type: TaskEvent["type"], data?: Record<string, unknown>): Promise<TaskEvent>;
  appendStdout(chunk: Buffer | string): Promise<void>;
  appendStderr(chunk: Buffer | string): Promise<void>;
  appendCombined(chunk: Buffer | string): Promise<void>;
  appendTranscript(line: string | Record<string, unknown>): Promise<void>;

  updateTask(patch: Partial<AgentTaskRecord>): Promise<AgentTaskRecord>;
  updateUsage(usage: TaskUsage): Promise<void>;
  updateProvider(provider: TaskProviderMetadata): Promise<void>;
  writeResult(text: string): Promise<void>;
  markTerminal(status: TaskStatus, details?: Partial<AgentTaskRecord>): Promise<AgentTaskRecord>;
};
```

This should be introduced carefully:

- Keep process executor behavior unchanged.
- Move duplicated process-writer logic only as needed.
- If the full helper set is too large for one patch, add only what
  `CodexAppServerTaskExecutor` needs now and leave the rest out.

## Executor Selection

Update `launchTask(...)` to select by `input.plan.executionKind`:

```ts
const executor =
  input.plan.executionKind === "protocol"
    ? protocolExecutorFor(input.plan.runtime)
    : processTaskExecutor;
```

For this slice, only one protocol executor is valid:

```text
runtime: codex-app-server -> CodexAppServerTaskExecutor
```

Unknown protocol runtimes should fail before creating or running a task.

## Codex Protocol Flow

Create:

```text
packages/core/src/tasks/executors/protocol/codex-app-server.ts
```

First version flow:

1. Start `codex app-server --listen stdio://` with `startJsonRpcStdioClient`.
2. Send `initialize`:

   ```json
   {
     "clientInfo": {
       "name": "orchestrator",
       "title": "Orchestrator",
       "version": "0.0.0"
     },
     "capabilities": {
       "experimentalApi": true
     }
   }
   ```

3. Send `initialized` notification.
4. Send `thread/start`:

   ```json
   {
     "cwd": "<task cwd>",
     "model": "<optional model>",
     "ephemeral": true
   }
   ```

5. Store:

   ```json
   {
     "provider": "codex",
     "protocol": "jsonrpc",
     "transport": "stdio",
     "threadId": "<thread.id>"
   }
   ```

6. Send `turn/start`:

   ```json
   {
     "threadId": "<thread.id>",
     "input": [{ "type": "text", "text": "<task prompt>" }],
     "model": "<optional model>"
   }
   ```

7. Store `turnId` from `turn/start` response `turn.id`.
8. Subscribe to notifications filtered by `threadId` and `turnId`.
9. Write every raw notification to `transcript.jsonl`.
10. Normalize useful notifications to `agent_event`.
11. Answer server-initiated JSON-RPC requests through the request handler.
12. Update usage when `thread/tokenUsage/updated` arrives.
13. Capture final answer from `item/completed` where
    `item.type === "agentMessage"` and `item.text` is present.
14. On `turn/completed`, mark terminal:
    - `completed` -> `succeeded`
    - `interrupted` -> `cancelled`
    - `failed` -> `failed`
    - anything unexpected -> `failed`
15. Write final text to `result.md`.
16. Close the app-server client.

The protocol can emit notifications immediately after `turn/start`. Our
JSON-RPC client buffers early notifications, which matches the race handled by
Codex's Python SDK router.

## Notification Mapping

Map the first useful subset:

```text
thread/started                    -> agent_event kind="thread.started"
turn/started                      -> agent_event kind="turn.started"
item/started                      -> agent_event kind="agent.item.started"
item/agentMessage/delta           -> agent_event kind="agent.message.delta"
item/completed agentMessage       -> agent_event kind="agent.message"
item/completed commandExecution   -> agent_event kind="agent.command"
turn/plan/updated                 -> agent_event kind="agent.plan"
turn/diff/updated                 -> agent_event kind="agent.diff"
thread/tokenUsage/updated         -> agent_event kind="agent.usage"
turn/completed                    -> agent_event kind="turn.completed"
error                             -> agent_event kind="runtime.error"
```

Do not normalize every Codex event in the first patch. Unknown notifications
should still be appended to `transcript.jsonl`.

## Usage Mapping

For `thread/tokenUsage/updated`, use `params.tokenUsage.last`:

```ts
{
  inputTokens: last.inputTokens,
  outputTokens: last.outputTokens,
  cacheReadTokens: last.cachedInputTokens,
  reasoningTokens: last.reasoningOutputTokens,
  totalTokens: last.totalTokens,
  source: "provider",
  scope: "turn",
  final: false,
  updatedAt
}
```

When `turn/completed` arrives, persist the last known usage again with
`final: true`.

## Result Extraction

Prefer final completed agent message items:

```text
item/completed params.item.type == "agentMessage"
item.text -> candidate final answer
```

Also collect `item/agentMessage/delta` into a streaming buffer for live progress,
but `item/completed` remains the authoritative result when available.

If no final text exists:

- succeeded turn with no text: write an empty `result.md` and mark succeeded;
- failed turn: use `turn.error.message` when available;
- malformed protocol or missing completion: mark failed with a clear adapter
  error.

## Terminal Status

Codex `TurnStatus` maps to Orchestrator:

```text
completed    -> succeeded
interrupted  -> cancelled
failed       -> failed
inProgress   -> failed if seen on turn/completed
```

The executor should preserve the user stop reason if `stopRequestedAt` is
present by the time terminal state is written.

## Logs And Transcript

Use the existing files this way:

- `transcript.jsonl`: raw Codex notifications and important protocol responses.
- `events.jsonl`: normalized Orchestrator task events.
- `result.md`: final answer text.
- `stderr.log`: app-server stderr and adapter errors.
- `stdout.log`: leave mostly empty unless adapter diagnostics are needed.
- `combined.log`: include stderr/diagnostics; do not make raw protocol JSON the
  primary logs UX.

## Interrupt Boundary

Slice 5 should implement a simple `interrupt(...)` method:

1. If `threadId` and `turnId` are known, attempt `turn/interrupt`.
2. Close the client.
3. Kill the app-server process group if close does not settle.

Slice 6 will harden this:

- wait for terminal `turn/completed`;
- distinguish API interrupt success from fallback process kill;
- preserve stop reason over timeouts;
- test parent/child/group interruption thoroughly.

## Tests

Add fake-server tests first. Do not require live Codex for normal `pnpm check`.

Recommended files:

```text
test/codex-app-server-executor.test.ts
test/fixtures/fake-codex-app-server.mjs
```

Fake-server scenarios:

- initializes and receives `initialized`;
- receives `thread/start` and returns `{ thread: { id, ... } }`;
- receives `turn/start`, returns `{ turn: { id, status: "inProgress" } }`;
- emits early notifications before subscription replay;
- emits `item/agentMessage/delta`;
- emits `item/completed` with `agentMessage`;
- emits `thread/tokenUsage/updated`;
- sends a server request and receives a response;
- emits `turn/completed` with status `completed`;
- failed turn maps to failed task;
- interrupted turn maps to cancelled task;
- malformed protocol maps to failed task with useful stderr/event detail.

Core/CLI integration tests:

- `launch codex-app-server --wait --json` returns a succeeded task and final
  output using fake executable wiring if feasible.
- `read` returns `result.md`.
- `events` shows normalized protocol events.
- `ps` can show the task while running.
- task JSON stores provider `threadId` and `turnId`.
- usage is visible from task JSON and compact `ps` once emitted.

Optional live smoke:

```sh
RUN_CODEX_APP_SERVER_SMOKE=1 pnpm test
```

Live smoke should test one short final answer and skip by default.

## Acceptance Criteria

- Existing process runtimes still pass the full suite.
- `codex-app-server` appears as a built-in runtime.
- Launching `codex-app-server` starts `codex app-server --listen stdio://`.
- The executor initializes, starts an ephemeral thread, starts one turn, and
  stores `threadId` and `turnId`.
- `read` returns the final answer from `result.md`.
- `events` shows normalized app-server events.
- `transcript.jsonl` contains raw protocol notifications.
- usage updates persist on `task.usage`.
- normal `pnpm check` uses fake-server tests only.
- no public protocol custom-agent config is exposed.

## Open Risks

- Protocol churn: app-server is active API surface, so method payloads may shift.
- User input shape: verify the exact JSON shape for text input against live
  Codex before enabling smoke broadly.
- Permissions/sandbox fields: initial slice should pass minimal fields and rely
  on existing Codex config unless live smoke proves explicit fields are needed.
- Interrupt timing: full API interrupt polish belongs in Slice 6.
- Per-task app-server startup cost may be noticeable, but pooling is not part of
  this slice.

## Recommended Build Order

1. Add `executionKind` to runtime types and launch plans with process default.
2. Add `codex-app-server` built-in runtime.
3. Expand `TaskExecutionContext` with only the helpers the protocol executor
   needs.
4. Add executor selection in `launchTask(...)`.
5. Implement `CodexAppServerTaskExecutor` against the fake server.
6. Add focused fake-server tests for success, failure, usage, result, provider
   metadata, and basic interruption.
7. Run full `pnpm check`.
8. Add opt-in live smoke only after fake-server behavior is stable.
