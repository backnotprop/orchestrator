import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  buildAgentLaunchPlan,
  loadConfiguredRuntimeRegistry,
  type OrchestratorConfigLoadOptions,
} from "@backnotprop/orchestrator-core/runtime";
import {
  interruptTask,
  launchTask,
  listTasks,
  readTaskEvents,
  readTaskLogs,
  readTaskOutput,
  readTaskRecord,
  waitForTask,
  type AgentTaskRecord,
  type LaunchTaskInput,
  type LogStream,
  type TaskEvent,
  type TaskStatus,
  type WaitForTaskProgress,
} from "@backnotprop/orchestrator-core/tasks";
import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { tokenUsageFromUnknown, type TokenUsage } from "./run-events.ts";

export type ParentAgentToolContext = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  cwd?: string;
  parentRunId?: string;
  parentSessionId?: string | (() => string | undefined);
  configEnv?: Readonly<Record<string, string | undefined>>;
  launchEnv?: Readonly<Record<string, string | undefined>>;
  allowedShellCommands?: readonly string[];
  allowDisabledRuntime?: boolean;
  parentTaskId?: string;
  backgroundLauncher?: (input: LaunchTaskInput) => Promise<AgentTaskRecord>;
  trace?: ParentToolTraceSink;
};

export type OrchestratorParentTool = ToolDefinition;

export type ParentToolTraceEvent =
  | {
      kind: "tool.call";
      timestamp: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      kind: "tool.result";
      timestamp: string;
      toolCallId: string;
      toolName: string;
      durationMs: number;
      result: unknown;
    }
  | {
      kind: "tool.progress";
      timestamp: string;
      toolCallId: string;
      toolName: string;
      elapsedMs: number;
      progress: unknown;
    }
  | {
      kind: "tool.error";
      timestamp: string;
      toolCallId: string;
      toolName: string;
      durationMs: number;
      error: string;
    };

export type ParentToolTraceSink = (event: ParentToolTraceEvent) => void;

type ToolContext = Required<Pick<ParentAgentToolContext, "workspaceRoot">> &
  Omit<ParentAgentToolContext, "workspaceRoot">;

type TaskSummary = {
  taskId: string;
  name?: string;
  runtime: string;
  status: TaskStatus;
  cwd: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  error?: string;
  pid?: number;
  taskDir: string;
};

type LaunchAgentDetails = {
  task: TaskSummary;
  model?: string;
  outputMode?: string;
  loadedConfigPaths: readonly string[];
};

type ListAgentsDetails = {
  tasks: TaskSummary[];
};

type ReadAgentDetails = {
  retrievalStatus?: "completed" | "timeout";
  task: TaskSummary;
  output: string;
  usage?: TokenUsage;
};

type ReadAgentEventsDetails = {
  taskId: string;
  events: TaskEvent[];
};

type ReadAgentLogsDetails = {
  taskId: string;
  stdout: string;
  stderr: string;
};

type InterruptAgentDetails = {
  task: TaskSummary;
};

const StatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
]);

const LogStreamSchema = Type.Union([
  Type.Literal("stdout"),
  Type.Literal("stderr"),
  Type.Literal("all"),
]);

export function createOrchestratorAgentTools(
  context: ParentAgentToolContext,
): OrchestratorParentTool[] {
  const toolContext = normalizeToolContext(context);

  const tools = [
    createLaunchAgentTool(toolContext),
    createListAgentsTool(toolContext),
    createReadAgentTool(toolContext),
    createReadAgentEventsTool(toolContext),
    createReadAgentLogsTool(toolContext),
    createInterruptAgentTool(toolContext),
  ];

  return tools.map((tool) => traceTool(tool, toolContext.trace));
}

function traceTool(
  tool: OrchestratorParentTool,
  trace: ParentToolTraceSink | undefined,
): OrchestratorParentTool {
  if (!trace) {
    return tool;
  }

  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const startedAt = Date.now();
      emitTrace(trace, {
        kind: "tool.call",
        timestamp: new Date().toISOString(),
        toolCallId,
        toolName: tool.name,
        input: snapshotTraceValue(params),
      });

      try {
        const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
        emitTrace(trace, {
          kind: "tool.result",
          timestamp: new Date().toISOString(),
          toolCallId,
          toolName: tool.name,
          durationMs: Date.now() - startedAt,
          result: snapshotTraceValue(result.details),
        });
        return result;
      } catch (error) {
        emitTrace(trace, {
          kind: "tool.error",
          timestamp: new Date().toISOString(),
          toolCallId,
          toolName: tool.name,
          durationMs: Date.now() - startedAt,
          error: formatTraceError(error),
        });
        throw error;
      }
    },
  };
}

function createLaunchAgentTool(context: ToolContext): OrchestratorParentTool {
  return defineTool({
    name: "launch_agent",
    label: "Launch agent",
    description:
      "Start a Claude Code, Codex, or configured custom agent as a background Orchestrator task.",
    promptSnippet: "launch_agent starts a background agent task and returns its task id.",
    promptGuidelines: [
      "Use launch_agent when a request should be delegated to another agent.",
      "Keep instructions explicit. Do not assume hidden role templates exist.",
      "After launching, use list_agents, read_agent_events, read_agent_logs, and read_agent to inspect the task.",
    ],
    parameters: Type.Object({
      runtime: Type.String(),
      instructions: Type.String(),
      name: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      outputMode: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
      maxOutputBytes: Type.Optional(Type.Number()),
    }),
    executionMode: "parallel",
    async execute(toolCallId, params) {
      const loaded = await loadRegistry(context);
      const cwd = resolve(params.cwd ?? context.cwd ?? context.workspaceRoot);
      const runtime = loaded.registry[params.runtime];
      const plan = buildAgentLaunchPlan(
        {
          runtime: params.runtime,
          task: params.instructions,
          cwd,
          ...(context.launchEnv ? { env: compactEnv(context.launchEnv) } : {}),
          ...(params.model ? { model: params.model } : {}),
          ...(params.outputMode ? { outputMode: params.outputMode } : {}),
          allowDisabledRuntime: context.allowDisabledRuntime,
        },
        loaded.registry,
      );
      const parentSessionId = resolveParentSessionId(context);
      const launchInput: LaunchTaskInput = {
        workspaceRoot: context.workspaceRoot,
        ...(context.orchestratorDir ? { orchestratorDir: context.orchestratorDir } : {}),
        taskId: randomUUID(),
        plan,
        ...(params.name ? { name: params.name } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(context.parentRunId
          ? {
              parent: {
                parentRunId: context.parentRunId,
                ...(context.parentTaskId ? { parentTaskId: context.parentTaskId } : {}),
                ...(parentSessionId ? { parentSessionId } : {}),
                parentToolCallId: toolCallId,
              },
            }
          : {}),
        timeoutMs: params.timeoutMs ?? runtime?.defaults.timeoutMs,
        maxOutputBytes: params.maxOutputBytes ?? runtime?.defaults.maxOutputBytes,
        ...(context.allowedShellCommands
          ? { allowedShellCommands: context.allowedShellCommands }
          : {}),
      };
      const task = context.backgroundLauncher
        ? await context.backgroundLauncher(launchInput)
        : await launchInCurrentProcess(launchInput);

      return jsonResult<LaunchAgentDetails>({
        task: summarizeTask(task),
        ...(params.model ? { model: params.model } : {}),
        ...(params.outputMode ? { outputMode: params.outputMode } : {}),
        loadedConfigPaths: loaded.loadedConfigPaths,
      });
    },
  });
}

function resolveParentSessionId(context: ToolContext): string | undefined {
  const sessionId = context.parentSessionId;
  return typeof sessionId === "function" ? sessionId() : sessionId;
}

async function launchInCurrentProcess(input: LaunchTaskInput): Promise<AgentTaskRecord> {
  const handle = await launchTask(input);
  handle.completed.catch(() => {});
  return handle.task;
}

function createListAgentsTool(context: ToolContext): OrchestratorParentTool {
  return defineTool({
    name: "list_agents",
    label: "List agents",
    description: "List Orchestrator agent tasks, optionally filtered by runtime or status.",
    promptSnippet: "list_agents lists background agent tasks.",
    parameters: Type.Object({
      status: Type.Optional(StatusSchema),
      runtime: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const tasks = await listTasks({
        workspaceRoot: context.workspaceRoot,
        ...(context.orchestratorDir ? { orchestratorDir: context.orchestratorDir } : {}),
        ...(params.status ? { status: params.status } : {}),
      });
      const filtered = params.runtime
        ? tasks.filter((task) => task.runtime === params.runtime)
        : tasks;
      const limit = Math.max(0, Math.trunc(params.limit ?? filtered.length));
      const selected = limit > 0 ? filtered.slice(-limit) : [];

      return jsonResult<ListAgentsDetails>({
        tasks: selected.map(summarizeTask),
      });
    },
  });
}

function createReadAgentTool(context: ToolContext): OrchestratorParentTool {
  return defineTool({
    name: "read_agent",
    label: "Read agent result",
    description:
      "Read an Orchestrator agent task result, optionally waiting for the task to finish first.",
    promptSnippet:
      "read_agent reads a task's result. Pass wait: true when you need the child agent's answer before responding.",
    promptGuidelines: [
      "Use wait: true when the user needs the child agent's result before you answer.",
      "Do not claim a child task is finished unless task.status is succeeded, failed, cancelled, or timed_out.",
    ],
    parameters: Type.Object({
      taskId: Type.String(),
      wait: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(Type.Number()),
      maxBytes: Type.Optional(Type.Number()),
    }),
    executionMode: "parallel",
    async execute(toolCallId, params) {
      const store = storeOptions(context);
      const trace = context.trace;
      const waitResult = params.wait
        ? await waitForTask({
            ...store,
            taskId: params.taskId,
            ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
            ...(trace
              ? {
                  onProgress: (progress) => {
                    emitReadAgentWaitProgress(trace, toolCallId, progress);
                  },
                }
              : {}),
          })
        : undefined;
      const task = waitResult?.task ?? (await readTaskRecord(store, params.taskId));
      const output = await readTaskOutput({
        ...store,
        taskId: params.taskId,
        ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
      });
      const usage = await readLatestTaskUsage(store, params.taskId);

      return jsonResult<ReadAgentDetails>({
        ...(waitResult ? { retrievalStatus: waitResult.retrievalStatus } : {}),
        task: summarizeTask(task),
        output,
        ...(usage ? { usage } : {}),
      });
    },
  });
}

function createReadAgentEventsTool(context: ToolContext): OrchestratorParentTool {
  return defineTool({
    name: "read_agent_events",
    label: "Read agent events",
    description: "Read lifecycle and normalized provider events for an Orchestrator agent task.",
    promptSnippet: "read_agent_events reads task events.",
    parameters: Type.Object({
      taskId: Type.String(),
      maxBytes: Type.Optional(Type.Number()),
      agentOnly: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number()),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const events = await readTaskEvents({
        ...storeOptions(context),
        taskId: params.taskId,
        ...(params.maxBytes ? { maxBytes: params.maxBytes } : {}),
        ...(params.agentOnly !== undefined ? { agentOnly: params.agentOnly } : {}),
      });
      const limit = Math.max(0, Math.trunc(params.limit ?? events.length));

      return jsonResult<ReadAgentEventsDetails>({
        taskId: params.taskId,
        events: limit > 0 ? events.slice(-limit) : [],
      });
    },
  });
}

function createReadAgentLogsTool(context: ToolContext): OrchestratorParentTool {
  return defineTool({
    name: "read_agent_logs",
    label: "Read agent logs",
    description: "Read stdout and stderr logs for an Orchestrator agent task.",
    promptSnippet: "read_agent_logs reads task stdout and stderr.",
    parameters: Type.Object({
      taskId: Type.String(),
      stream: Type.Optional(LogStreamSchema),
      maxBytes: Type.Optional(Type.Number()),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const logs = await readTaskLogs({
        ...storeOptions(context),
        taskId: params.taskId,
        ...(params.stream ? { stream: params.stream as LogStream } : {}),
        ...(params.maxBytes ? { maxBytes: params.maxBytes } : {}),
      });

      return jsonResult<ReadAgentLogsDetails>(logs);
    },
  });
}

function createInterruptAgentTool(context: ToolContext): OrchestratorParentTool {
  return defineTool({
    name: "interrupt_agent",
    label: "Interrupt agent",
    description: "Stop a running Orchestrator agent task.",
    promptSnippet: "interrupt_agent stops a running task.",
    promptGuidelines: [
      "Use interrupt_agent when a task is no longer useful, is wasting time, or should be cancelled.",
    ],
    parameters: Type.Object({
      taskId: Type.String(),
      reason: Type.Optional(Type.String()),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const task = await interruptTask({
        ...storeOptions(context),
        taskId: params.taskId,
        ...(params.reason ? { reason: params.reason } : {}),
      });

      return jsonResult<InterruptAgentDetails>({
        task: summarizeTask(task),
      });
    },
  });
}

async function loadRegistry(context: ToolContext) {
  const options: OrchestratorConfigLoadOptions = {
    workspaceRoot: context.workspaceRoot,
    ...(context.configPath ? { configPath: context.configPath } : {}),
    ...(context.configEnv ? { env: context.configEnv } : {}),
  };

  return loadConfiguredRuntimeRegistry(options);
}

function normalizeToolContext(context: ParentAgentToolContext): ToolContext {
  return {
    ...context,
    workspaceRoot: resolve(context.workspaceRoot),
    ...(context.orchestratorDir ? { orchestratorDir: resolve(context.orchestratorDir) } : {}),
    ...(context.configPath ? { configPath: resolve(context.configPath) } : {}),
    ...(context.cwd ? { cwd: resolve(context.cwd) } : {}),
  };
}

function storeOptions(context: ToolContext) {
  return {
    workspaceRoot: context.workspaceRoot,
    ...(context.orchestratorDir ? { orchestratorDir: context.orchestratorDir } : {}),
  };
}

function summarizeTask(task: AgentTaskRecord): TaskSummary {
  return {
    taskId: task.taskId,
    ...(task.name ? { name: task.name } : {}),
    runtime: task.runtime,
    status: task.status,
    cwd: task.cwd,
    createdAt: task.createdAt,
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.pid ? { pid: task.pid } : {}),
    taskDir: task.paths.taskDir,
  };
}

async function readLatestTaskUsage(
  store: ReturnType<typeof storeOptions>,
  taskId: string,
): Promise<TokenUsage | undefined> {
  const events = await readTaskEvents({ ...store, taskId, agentOnly: true });
  for (const event of [...events].reverse()) {
    const usage = tokenUsageFromUnknown(event.data.usage);
    if (usage) {
      return usage;
    }
  }
  return undefined;
}

function emitReadAgentWaitProgress(
  trace: ParentToolTraceSink,
  toolCallId: string,
  progress: WaitForTaskProgress,
): void {
  emitTrace(trace, {
    kind: "tool.progress",
    timestamp: new Date().toISOString(),
    toolCallId,
    toolName: "read_agent",
    elapsedMs: progress.elapsedMs,
    progress: {
      taskId: progress.task.taskId,
      ...(progress.task.name ? { name: progress.task.name } : {}),
      runtime: progress.task.runtime,
      status: progress.task.status,
      timeoutMs: progress.timeoutMs,
      remainingMs: progress.remainingMs,
      attempt: progress.attempt,
    },
  });
}

function compactEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function jsonResult<T>(details: T): AgentToolResult<T> {
  return {
    content: [{ type: "text", text: `${JSON.stringify(details, null, 2)}\n` }],
    details,
  };
}

function emitTrace(trace: ParentToolTraceSink, event: ParentToolTraceEvent): void {
  try {
    trace(event);
  } catch {
    // Tracing is observability only. It must not affect parent tool execution.
  }
}

function snapshotTraceValue(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      return undefined;
    }
    return JSON.parse(encoded) as unknown;
  } catch {
    return safeTraceString(value);
  }
}

function formatTraceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeTraceString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unserializable]";
  }
}
