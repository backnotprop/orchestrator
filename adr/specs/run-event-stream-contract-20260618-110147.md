# Run Event Stream Contract

Date: 2026-06-18

## Intent

Orchestrator needs one reliable live stream for parent runs. Humans should get a
clean terminal view. Programs should get JSONL. The future TUI should get live
state. All three should come from the same events.

This spec tightens the current `orchestrator run --trace-tools` and
`orchestrator run --stream-json` behavior into a clearer contract.

## Current State

The current implementation already has the right pieces:

- parent tools emit `tool.call`, `tool.progress`, `tool.result`, and
  `tool.error`;
- `orchestrator run --trace-tools` renders those events to stderr;
- `orchestrator run --trace-tools=jsonl` prints parent tool events as JSONL to
  stderr;
- `orchestrator run --stream-json` prints run events as JSONL to stdout;
- task events already have task-level `seq`, `taskId`, timestamps, lifecycle
  events, stdout/stderr, normalized agent events, and result events.

The gap is consistency. Parent run events do not yet have a common envelope,
stable sequence numbers, or enough ids to power a good live multi-agent view.

## Spec

### Event Envelope

Every `orchestrator run --stream-json` event should include:

```ts
type RunEventEnvelope = {
  schemaVersion: 1;
  seq: number;
  timestamp: string;
  runId: string;
  kind: string;
};
```

Rules:

- `seq` starts at `1` for each parent run and increments by one.
- `timestamp` is ISO 8601.
- `runId` is stable for the parent run.
- `kind` names the event.
- unknown event kinds should be ignored by human renderers, not treated as fatal.

### Run Lifecycle Events

The stream should include:

```ts
type RunStarted = RunEventEnvelope & {
  kind: "run.started";
  sessionId: string;
  cwd: string;
  request: string;
};

type RunFinal = RunEventEnvelope & {
  kind: "run.final";
  sessionId: string;
  output: string;
  modelFallbackMessage?: string;
};

type RunError = RunEventEnvelope & {
  kind: "run.error";
  sessionId?: string;
  error: {
    message: string;
    name?: string;
  };
};
```

`run.final` is the clean answer. It is not logs, progress, or a transcript.

### Tool Events

Parent tool events should use the same envelope:

```ts
type ToolCall = RunEventEnvelope & {
  kind: "tool.call";
  toolCallId: string;
  toolName: string;
  input: unknown;
};

type ToolProgress = RunEventEnvelope & {
  kind: "tool.progress";
  toolCallId: string;
  toolName: string;
  elapsedMs: number;
  progress: unknown;
};

type ToolResult = RunEventEnvelope & {
  kind: "tool.result";
  toolCallId: string;
  toolName: string;
  durationMs: number;
  result: unknown;
};

type ToolError = RunEventEnvelope & {
  kind: "tool.error";
  toolCallId: string;
  toolName: string;
  durationMs: number;
  error: {
    message: string;
    name?: string;
  };
};
```

Tool tracing remains passive. A renderer failure must never change parent-agent
execution.

### Child Task Events

When the parent launches or waits on a child agent, the run stream should make
that visible without requiring the user to open task files.

Add derived child-task events:

```ts
type ChildTaskStarted = RunEventEnvelope & {
  kind: "task.started";
  taskId: string;
  name?: string;
  runtime: string;
  model?: string;
  cwd: string;
  toolCallId?: string;
};

type ChildTaskStatus = RunEventEnvelope & {
  kind: "task.status";
  taskId: string;
  name?: string;
  runtime: string;
  status: string;
  toolCallId?: string;
};

type ChildTaskUsage = RunEventEnvelope & {
  kind: "task.usage";
  taskId: string;
  name?: string;
  runtime: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
};

type ChildTaskFinished = RunEventEnvelope & {
  kind: "task.finished";
  taskId: string;
  name?: string;
  runtime: string;
  status: string;
  output?: string;
  error?: {
    message: string;
    name?: string;
  };
  toolCallId?: string;
};
```

The first implementation can derive `task.started` from `launch_agent` result
and `task.finished` from `read_agent` result. Later, the parent run can subscribe
to task events and emit richer `task.status` and `task.usage` updates.

### Output Modes

Default:

```sh
orchestrator run "..."
```

Print only the final answer to stdout.

Human trace:

```sh
orchestrator run --trace-tools "..."
```

Print readable parent activity to stderr. This is a renderer. It may group,
summarize, colorize, or hide noise.

Tool JSONL trace:

```sh
orchestrator run --trace-tools=jsonl "..."
```

Print parent tool events to stderr as JSONL. This is useful for debugging, but
the full machine interface is `--stream-json`.

Full machine stream:

```sh
orchestrator run --stream-json "..."
```

Print the complete parent run stream to stdout as JSONL. This is the stable
surface for scripts, plugins, and the future TUI.

## State Reducer

Add a small shared reducer after the event envelope is stable:

```ts
type RunState = {
  runId: string;
  status: "running" | "succeeded" | "failed";
  tools: Record<string, ToolState>;
  tasks: Record<string, ChildTaskState>;
  output?: string;
  error?: { message: string; name?: string };
};
```

The reducer should accept events in order and rebuild current state.

Use it for:

- human trace rendering;
- tests;
- future `list --watch` or `ps --watch`;
- the future TUI.

## Implementation Plan

1. Add a run event module in the CLI or agent package.
   - Define `RunStreamEvent`.
   - Add `schemaVersion`, `seq`, and `runId`.
   - Normalize error objects.

2. Replace ad hoc `writeRunJsonStreamEvent(...)` payloads with the shared event
   builder.

3. Keep the existing parent tool trace type internally, but wrap it into the run
   stream envelope before writing JSONL.

4. Emit `task.started` from `launch_agent` results.

5. Emit `task.finished` from completed `read_agent` results.

6. Keep `--trace-tools` output compatible with current users, but allow its
   implementation to read from the same run events.

7. Add tests for:
   - sequence numbers;
   - required envelope fields;
   - `run.started` before tool events;
   - `run.final` as the last success event;
   - `run.error` on failure;
   - JSONL parseability;
   - human trace still writing to stderr;
   - default mode still printing only the final answer.

## Non-Goals

Do not build the TUI in this slice.

Do not make terminal text a stable API.

Do not require Claude Code, Codex, or custom agents to emit the same token usage
data. Store usage when runtime adapters expose it.

Do not replace task `events.jsonl`. Parent run streams and child task events
serve different views and should reference each other by ids.

Do not persist every text delta or log chunk as a high-level run event. Keep raw
logs available, but promote only useful lifecycle, progress, result, and usage
events.

## Expected Result

After this slice, a parent run that launches ten agents can be watched as one
coherent stream. A human renderer can show grouped live progress. A program can
parse JSONL without scraping terminal text. A future TUI can build the same view
from the same events.
