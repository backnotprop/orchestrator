import type { ParentToolTraceEvent } from "./tools.ts";

export const RUN_STREAM_SCHEMA_VERSION = 1 as const;

export type RunStreamError = {
  message: string;
  name?: string;
};

export type RunEventEnvelope = {
  schemaVersion: typeof RUN_STREAM_SCHEMA_VERSION;
  seq: number;
  timestamp: string;
  runId: string;
  kind: string;
};

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type RunStreamEvent =
  | (RunEventEnvelope & {
      kind: "run.started";
      sessionId: string;
      cwd: string;
      request: string;
    })
  | (RunEventEnvelope & {
      kind: "run.final";
      sessionId: string;
      output: string;
      modelFallbackMessage?: string;
    })
  | (RunEventEnvelope & {
      kind: "run.error";
      sessionId?: string;
      error: RunStreamError;
    })
  | (RunEventEnvelope & {
      kind: "tool.call";
      toolCallId: string;
      toolName: string;
      input: unknown;
    })
  | (RunEventEnvelope & {
      kind: "tool.progress";
      toolCallId: string;
      toolName: string;
      elapsedMs: number;
      progress: unknown;
    })
  | (RunEventEnvelope & {
      kind: "tool.result";
      toolCallId: string;
      toolName: string;
      durationMs: number;
      result: unknown;
    })
  | (RunEventEnvelope & {
      kind: "tool.error";
      toolCallId: string;
      toolName: string;
      durationMs: number;
      error: RunStreamError;
    })
  | (RunEventEnvelope & {
      kind: "task.started";
      taskId: string;
      name?: string;
      runtime: string;
      model?: string;
      cwd: string;
      toolCallId?: string;
    })
  | (RunEventEnvelope & {
      kind: "task.status";
      taskId: string;
      name?: string;
      runtime: string;
      status: string;
      toolCallId?: string;
    })
  | (RunEventEnvelope & {
      kind: "task.usage";
      taskId: string;
      name?: string;
      runtime: string;
      usage: TokenUsage;
    })
  | (RunEventEnvelope & {
      kind: "task.finished";
      taskId: string;
      name?: string;
      runtime: string;
      status: string;
      output?: string;
      error?: RunStreamError;
      toolCallId?: string;
    });

type WithoutEnvelope<T> = T extends RunStreamEvent
  ? Omit<T, "schemaVersion" | "seq" | "timestamp" | "runId"> & {
      timestamp?: string;
    }
  : never;

export type RunStreamEventPayload = WithoutEnvelope<RunStreamEvent>;

export type RunStreamSequencer = {
  runId: string;
  create: (payload: RunStreamEventPayload) => RunStreamEvent;
};

export type CreateRunStreamSequencerOptions = {
  runId: string;
  now?: () => Date;
};

export type ToolState = {
  toolCallId: string;
  toolName: string;
  status: "running" | "succeeded" | "failed";
  input?: unknown;
  progress?: unknown;
  result?: unknown;
  error?: RunStreamError;
  startedAt?: string;
  updatedAt: string;
  durationMs?: number;
  elapsedMs?: number;
};

export type ChildTaskState = {
  taskId: string;
  name?: string;
  runtime: string;
  model?: string;
  cwd?: string;
  status?: string;
  usage?: TokenUsage;
  output?: string;
  error?: RunStreamError;
  toolCallId?: string;
  updatedAt: string;
};

export type RunState = {
  runId: string;
  status: "running" | "succeeded" | "failed";
  seq: number;
  sessionId?: string;
  cwd?: string;
  request?: string;
  output?: string;
  error?: RunStreamError;
  startedAt?: string;
  finishedAt?: string;
  tools: Record<string, ToolState>;
  tasks: Record<string, ChildTaskState>;
};

type TaskLike = {
  taskId: string;
  name?: string;
  runtime: string;
  status: string;
  cwd?: string;
  error?: string;
};

export function createRunStreamSequencer(
  options: CreateRunStreamSequencerOptions,
): RunStreamSequencer {
  let seq = 0;
  const now = options.now ?? (() => new Date());

  return {
    runId: options.runId,
    create(payload) {
      const { timestamp, ...event } = payload;
      seq += 1;
      return {
        schemaVersion: RUN_STREAM_SCHEMA_VERSION,
        seq,
        timestamp: timestamp ?? now().toISOString(),
        runId: options.runId,
        ...event,
      } as RunStreamEvent;
    },
  };
}

export function runStreamPayloadsFromParentToolTrace(
  event: ParentToolTraceEvent,
): RunStreamEventPayload[] {
  const payloads: RunStreamEventPayload[] = [toolPayloadFromTraceEvent(event)];

  if (event.kind === "tool.progress") {
    const task = taskFromRecord(event.progress);
    if (task) {
      payloads.push(taskStatusPayload(task, event.toolCallId, event.timestamp));
      const usage = tokenUsageFromUnknown(recordFromUnknown(event.progress)?.usage);
      if (usage) {
        payloads.push(taskUsagePayload(task, usage, event.timestamp));
      }
    }
    return payloads;
  }

  if (event.kind !== "tool.result") {
    return payloads;
  }

  const result = recordFromUnknown(event.result);
  const task = taskFromRecord(result?.task);
  if (!task) {
    return payloads;
  }
  const usage =
    tokenUsageFromUnknown(result?.usage) ??
    tokenUsageFromUnknown(recordFromUnknown(result?.task)?.usage);

  if (event.toolName === "launch_agent") {
    payloads.push({
      kind: "task.started",
      timestamp: event.timestamp,
      taskId: task.taskId,
      ...(task.name ? { name: task.name } : {}),
      runtime: task.runtime,
      ...(stringFromUnknown(result?.model) ? { model: stringFromUnknown(result?.model) } : {}),
      cwd: task.cwd ?? "",
      toolCallId: event.toolCallId,
    });
    if (usage) {
      payloads.push(taskUsagePayload(task, usage, event.timestamp));
    }
    return payloads;
  }

  if (isTerminalStatus(task.status)) {
    if (usage) {
      payloads.push(taskUsagePayload(task, usage, event.timestamp));
    }
    payloads.push({
      kind: "task.finished",
      timestamp: event.timestamp,
      taskId: task.taskId,
      ...(task.name ? { name: task.name } : {}),
      runtime: task.runtime,
      status: task.status,
      ...(stringFromUnknown(result?.output) ? { output: stringFromUnknown(result?.output) } : {}),
      ...(task.error ? { error: normalizeRunStreamError(task.error) } : {}),
      toolCallId: event.toolCallId,
    });
    return payloads;
  }

  payloads.push(taskStatusPayload(task, event.toolCallId, event.timestamp));
  if (usage) {
    payloads.push(taskUsagePayload(task, usage, event.timestamp));
  }
  return payloads;
}

export function createInitialRunState(runId: string): RunState {
  return {
    runId,
    status: "running",
    seq: 0,
    tools: {},
    tasks: {},
  };
}

export function reduceRunStreamEvent(state: RunState | undefined, event: RunStreamEvent): RunState {
  const current = state ?? createInitialRunState(event.runId);
  const next: RunState = {
    ...current,
    runId: event.runId,
    seq: event.seq,
    tools: { ...current.tools },
    tasks: { ...current.tasks },
  };

  switch (event.kind) {
    case "run.started":
      return {
        ...next,
        status: "running",
        sessionId: event.sessionId,
        cwd: event.cwd,
        request: event.request,
        startedAt: event.timestamp,
      };
    case "run.final":
      return {
        ...next,
        status: "succeeded",
        sessionId: event.sessionId,
        output: event.output,
        finishedAt: event.timestamp,
      };
    case "run.error":
      return {
        ...next,
        status: "failed",
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        error: event.error,
        finishedAt: event.timestamp,
      };
    case "tool.call":
      next.tools[event.toolCallId] = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "running",
        input: event.input,
        startedAt: event.timestamp,
        updatedAt: event.timestamp,
      };
      return next;
    case "tool.progress":
      next.tools[event.toolCallId] = {
        ...toolStateFor(next, event),
        status: "running",
        progress: event.progress,
        elapsedMs: event.elapsedMs,
        updatedAt: event.timestamp,
      };
      return next;
    case "tool.result":
      next.tools[event.toolCallId] = {
        ...toolStateFor(next, event),
        status: "succeeded",
        result: event.result,
        durationMs: event.durationMs,
        updatedAt: event.timestamp,
      };
      return next;
    case "tool.error":
      next.tools[event.toolCallId] = {
        ...toolStateFor(next, event),
        status: "failed",
        error: event.error,
        durationMs: event.durationMs,
        updatedAt: event.timestamp,
      };
      return next;
    case "task.started":
      next.tasks[event.taskId] = {
        taskId: event.taskId,
        ...(event.name ? { name: event.name } : {}),
        runtime: event.runtime,
        ...(event.model ? { model: event.model } : {}),
        cwd: event.cwd,
        status: "running",
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        updatedAt: event.timestamp,
      };
      return next;
    case "task.status":
      next.tasks[event.taskId] = {
        ...taskStateFor(next, event),
        ...(event.name ? { name: event.name } : {}),
        runtime: event.runtime,
        status: event.status,
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        updatedAt: event.timestamp,
      };
      return next;
    case "task.usage":
      next.tasks[event.taskId] = {
        ...taskStateFor(next, event),
        ...(event.name ? { name: event.name } : {}),
        runtime: event.runtime,
        usage: event.usage,
        updatedAt: event.timestamp,
      };
      return next;
    case "task.finished":
      next.tasks[event.taskId] = {
        ...taskStateFor(next, event),
        ...(event.name ? { name: event.name } : {}),
        runtime: event.runtime,
        status: event.status,
        ...(event.output !== undefined ? { output: event.output } : {}),
        ...(event.error ? { error: event.error } : {}),
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        updatedAt: event.timestamp,
      };
      return next;
  }
}

export function normalizeRunStreamError(error: unknown): RunStreamError {
  if (error instanceof Error) {
    return {
      message: error.message,
      ...(error.name ? { name: error.name } : {}),
    };
  }

  return { message: String(error) };
}

export function tokenUsageFromUnknown(value: unknown): TokenUsage | undefined {
  const record = recordFromUnknown(value);
  if (!record) {
    return undefined;
  }

  const inputTokens = numberFromUnknown(record.inputTokens ?? record.input_tokens);
  const outputTokens = numberFromUnknown(record.outputTokens ?? record.output_tokens);
  const cacheReadTokens = numberFromUnknown(
    record.cacheReadTokens ?? record.cache_read_tokens ?? record.cached_input_tokens,
  );
  const cacheWriteTokens = numberFromUnknown(record.cacheWriteTokens ?? record.cache_write_tokens);
  const totalTokens = numberFromUnknown(record.totalTokens ?? record.total_tokens);
  const costUsd = numberFromUnknown(record.costUsd ?? record.cost_usd);
  const inferredTotal =
    totalTokens ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  const usage: TokenUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(inferredTotal !== undefined ? { totalTokens: inferredTotal } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };

  return Object.keys(usage).length > 0 ? usage : undefined;
}

function toolPayloadFromTraceEvent(event: ParentToolTraceEvent): RunStreamEventPayload {
  switch (event.kind) {
    case "tool.call":
      return {
        kind: "tool.call",
        timestamp: event.timestamp,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
      };
    case "tool.progress":
      return {
        kind: "tool.progress",
        timestamp: event.timestamp,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        elapsedMs: event.elapsedMs,
        progress: event.progress,
      };
    case "tool.result":
      return {
        kind: "tool.result",
        timestamp: event.timestamp,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        durationMs: event.durationMs,
        result: event.result,
      };
    case "tool.error":
      return {
        kind: "tool.error",
        timestamp: event.timestamp,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        durationMs: event.durationMs,
        error: normalizeRunStreamError(event.error),
      };
  }
}

function taskStatusPayload(
  task: TaskLike,
  toolCallId: string,
  timestamp: string,
): RunStreamEventPayload {
  return {
    kind: "task.status",
    timestamp,
    taskId: task.taskId,
    ...(task.name ? { name: task.name } : {}),
    runtime: task.runtime,
    status: task.status,
    toolCallId,
  };
}

function taskUsagePayload(
  task: TaskLike,
  usage: TokenUsage,
  timestamp: string,
): RunStreamEventPayload {
  return {
    kind: "task.usage",
    timestamp,
    taskId: task.taskId,
    ...(task.name ? { name: task.name } : {}),
    runtime: task.runtime,
    usage,
  };
}

function toolStateFor(
  state: RunState,
  event: Extract<RunStreamEvent, { toolCallId: string; toolName: string }>,
): ToolState {
  return (
    state.tools[event.toolCallId] ?? {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      status: "running",
      updatedAt: event.timestamp,
    }
  );
}

function taskStateFor(
  state: RunState,
  event: Extract<RunStreamEvent, { taskId: string; runtime: string }>,
): ChildTaskState {
  return (
    state.tasks[event.taskId] ?? {
      taskId: event.taskId,
      runtime: event.runtime,
      updatedAt: event.timestamp,
    }
  );
}

function taskFromRecord(value: unknown): TaskLike | undefined {
  const record = recordFromUnknown(value);
  const taskId = stringFromUnknown(record?.taskId);
  const runtime = stringFromUnknown(record?.runtime);
  const status = stringFromUnknown(record?.status);
  if (!taskId || !runtime || !status) {
    return undefined;
  }

  return {
    taskId,
    ...(stringFromUnknown(record?.name) ? { name: stringFromUnknown(record?.name) } : {}),
    runtime,
    status,
    ...(stringFromUnknown(record?.cwd) ? { cwd: stringFromUnknown(record?.cwd) } : {}),
    ...(stringFromUnknown(record?.error) ? { error: stringFromUnknown(record?.error) } : {}),
  };
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out"
  );
}
