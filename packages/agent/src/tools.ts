import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  buildAgentLaunchPlan,
  createConfiguredRuntimeRegistryLoader,
  type OrchestratorConfigLoadOptions,
} from "@backnotprop/orchestrator-core/runtime";
import {
  interruptTasks,
  isTerminalTaskStatus,
  launchTask,
  listTasks,
  matchesTaskWorkspace,
  observeTaskState,
  readTaskEvents,
  readTaskLogs,
  readTaskOutput,
  readTaskRecord,
  resolveTaskId,
  selectTaskUsage,
  sendTaskMessage,
  taskDisplayState,
  waitForTask,
  usageWithUpdatedAt,
  type AgentTaskRecord,
  type InterruptTasksResult,
  type InterruptTasksTarget,
  type LaunchTaskInput,
  type LogStream,
  type TaskEvent,
  type TaskDisplayState,
  type TaskObservation,
  type TaskProviderMetadata,
  type TaskUsage,
  type TaskStatus,
  type WaitForTaskProgress,
  type WaitForTaskRetrievalStatus,
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
  state?: TaskDisplayState;
  active: boolean;
  actionable: boolean;
  observationReason?: string;
  cwd: string;
  location?: AgentTaskRecord["location"];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  error?: string;
  stopRequestedAt?: string;
  stopReason?: string;
  stopSignal?: NodeJS.Signals;
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
  retrievalStatus?: WaitForTaskRetrievalStatus;
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
  task?: TaskSummary;
  interrupted?: TaskSummary[];
  skipped?: Array<{ task: TaskSummary; reason: string }>;
  failed?: Array<{ taskId: string; error: string }>;
};

type SendAgentMessageDetails = {
  task: TaskSummary;
  status: "accepted";
  provider?: TaskProviderMetadata;
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
    createSendAgentMessageTool(toolContext),
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
      "Start Shell, Claude Code, Codex, or a configured custom agent as a background Orchestrator task.",
    promptSnippet: "launch_agent starts a background agent task and returns its task id.",
    promptGuidelines: [
      "Use launch_agent when a request should be delegated to another agent.",
      'Use runtime: "shell" for exact local shell commands and small local utility tasks. Put the command itself in instructions.',
      'Use runtime: "codex" or runtime: "claude-code" for AI work such as code review, implementation, research, repo inspection, or analysis.',
      "Use configured custom runtime ids only when the user names one or the runtime is clearly known from context.",
      "Do not launch Codex or Claude just to run a deterministic shell command.",
      "Keep instructions explicit. Do not assume hidden role templates exist.",
      "After launching, use list_agents, read_agent_events, read_agent_logs, and read_agent to inspect the task.",
    ],
    parameters: Type.Object({
      runtime: Type.String(),
      instructions: Type.String(),
      name: Type.Optional(Type.String()),
      workspace: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      labels: Type.Optional(Type.Record(Type.String(), Type.String())),
      model: Type.Optional(Type.String()),
      outputMode: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
      maxOutputBytes: Type.Optional(Type.Number()),
    }),
    executionMode: "parallel",
    async execute(toolCallId, params) {
      const workspaceRoot = resolve(params.workspace ?? context.workspaceRoot);
      const loaded = await loadRegistry(context, workspaceRoot);
      const cwd = resolveCwd(params.cwd ?? context.cwd, workspaceRoot);
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
        workspaceRoot,
        ...(context.orchestratorDir ? { orchestratorDir: context.orchestratorDir } : {}),
        taskId: randomUUID(),
        plan,
        ...(params.name ? { name: params.name } : {}),
        ...(params.model ? { model: params.model } : {}),
        location: {
          kind: "local",
          workspaceRoot,
          workspaceName: workspaceName(workspaceRoot),
          cwd,
        },
        ...(params.labels ? { labels: params.labels } : {}),
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
      workspace: Type.Optional(Type.String()),
      allWorkspaces: Type.Optional(Type.Boolean()),
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
      const workspaceRoot = resolve(params.workspace ?? context.workspaceRoot);
      const workspaceFiltered = params.allWorkspaces
        ? filtered
        : filtered.filter((task) => matchesTaskWorkspace(task, { workspaceRoot }));
      const limit = Math.max(0, Math.trunc(params.limit ?? workspaceFiltered.length));
      const selected = limit > 0 ? workspaceFiltered.slice(-limit) : [];

      return jsonResult<ListAgentsDetails>({
        tasks: await Promise.all(selected.map((task) => summarizeStoredTask(context, task))),
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
        taskId: task.taskId,
        ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
      });
      const usage = await readLatestTaskUsage(store, task.taskId);

      return jsonResult<ReadAgentDetails>({
        ...(waitResult ? { retrievalStatus: waitResult.retrievalStatus } : {}),
        task: await summarizeStoredTask(context, task, waitResult?.observation),
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
      const store = storeOptions(context);
      const taskId = await resolveTaskId(store, params.taskId);
      const events = await readTaskEvents({
        ...store,
        taskId,
        ...(params.maxBytes ? { maxBytes: params.maxBytes } : {}),
        ...(params.agentOnly !== undefined ? { agentOnly: params.agentOnly } : {}),
      });
      const limit = Math.max(0, Math.trunc(params.limit ?? events.length));

      return jsonResult<ReadAgentEventsDetails>({
        taskId,
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

function createSendAgentMessageTool(context: ToolContext): OrchestratorParentTool {
  return defineTool({
    name: "send_agent_message",
    label: "Send agent message",
    description: "Send a follow-up message to a running Orchestrator agent task.",
    promptSnippet:
      "send_agent_message sends a follow-up instruction to a running task when its runtime supports it.",
    promptGuidelines: [
      "Use send_agent_message only for active tasks that should receive a new instruction while they are still running.",
      "Use read_agent for results.",
      "Use launch_agent or resume from the CLI when the task has already finished.",
      "If send_agent_message returns not_ready, wait briefly or inspect events before retrying.",
    ],
    parameters: Type.Object({
      taskId: Type.String(),
      message: Type.String(),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = await sendTaskMessage({
        ...storeOptions(context),
        taskId: params.taskId,
        text: params.message,
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      });

      return jsonResult<SendAgentMessageDetails>({
        task: await summarizeStoredTask(context, result.task),
        status: result.status,
        ...(result.provider ? { provider: result.provider } : {}),
      });
    },
  });
}

function createInterruptAgentTool(context: ToolContext): OrchestratorParentTool {
  return defineTool({
    name: "interrupt_agent",
    label: "Interrupt agent",
    description: "Stop running Orchestrator agent tasks.",
    promptSnippet:
      "interrupt_agent stops one task, a parent task with its children, or a ps group.",
    promptGuidelines: [
      "Use interrupt_agent when a task is no longer useful, is wasting time, or should be cancelled.",
      "If a returned task has state: stopping, it is still shutting down. Use read_agent with wait: true when final confirmation matters.",
      "Use taskId with children: true to stop a parent task and its children.",
      "Use taskId with taskOnly: true only when a parent should stop but its children should continue.",
      "Use groupId to stop the running tasks in one ps group.",
    ],
    parameters: Type.Object({
      taskId: Type.Optional(Type.String()),
      parentId: Type.Optional(Type.String()),
      groupId: Type.Optional(Type.String()),
      children: Type.Optional(Type.Boolean()),
      taskOnly: Type.Optional(Type.Boolean()),
      reason: Type.Optional(Type.String()),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = await interruptTasks({
        ...storeOptions(context),
        target: interruptTargetFromParams(params),
        ...(params.reason ? { reason: params.reason } : {}),
      });

      return jsonResult<InterruptAgentDetails>(interruptAgentDetails(params, result));
    },
  });
}

function interruptTargetFromParams(params: {
  taskId?: string;
  parentId?: string;
  groupId?: string;
  children?: boolean;
  taskOnly?: boolean;
}): InterruptTasksTarget {
  const selectors = [params.taskId, params.parentId, params.groupId].filter(Boolean);
  if (selectors.length !== 1) {
    throw new Error("interrupt_agent requires exactly one of taskId, parentId, or groupId.");
  }
  if (params.children && params.taskOnly) {
    throw new Error("interrupt_agent cannot combine children and taskOnly.");
  }
  if (params.parentId && !params.children) {
    throw new Error("interrupt_agent parentId requires children: true.");
  }
  if (params.groupId && (params.children || params.taskOnly)) {
    throw new Error("interrupt_agent groupId cannot combine with children or taskOnly.");
  }
  if (params.taskOnly && !params.taskId) {
    throw new Error("interrupt_agent taskOnly requires taskId.");
  }

  if (params.groupId) {
    return { kind: "group", groupId: params.groupId };
  }
  if (params.parentId) {
    return { kind: "parent", parentId: params.parentId, children: true };
  }
  if (!params.taskId) {
    throw new Error("interrupt_agent requires exactly one of taskId, parentId, or groupId.");
  }
  return {
    kind: "task",
    taskId: params.taskId,
    ...(params.children ? { children: true } : {}),
    ...(params.taskOnly ? { taskOnly: true } : {}),
  };
}

function interruptAgentDetails(
  params: { children?: boolean; taskOnly?: boolean; parentId?: string; groupId?: string },
  result: InterruptTasksResult,
): InterruptAgentDetails {
  if (
    !params.children &&
    !params.taskOnly &&
    !params.parentId &&
    !params.groupId &&
    result.interrupted.length === 1 &&
    result.skipped.length === 0
  ) {
    return { task: summarizeTask(result.interrupted[0]) };
  }

  return {
    interrupted: result.interrupted.map((task) => summarizeTask(task)),
    skipped: result.skipped.map((skipped) => ({
      task: summarizeSkippedInterruptTask(skipped),
      reason: skipped.reason,
    })),
    failed: result.failed,
  };
}

function summarizeSkippedInterruptTask(
  skipped: InterruptTasksResult["skipped"][number],
): TaskSummary {
  if (skipped.reason === "terminal") {
    return summarizeTask(skipped.task);
  }
  return summarizeTask(skipped.task, {
    status: skipped.task.status,
    state: skipped.reason,
    active: skipped.reason !== "lost",
    actionable: false,
    checkedAt: new Date().toISOString(),
    reason: `task is ${skipped.reason}`,
  });
}

async function loadRegistry(context: ToolContext, workspaceRoot = context.workspaceRoot) {
  const options: Omit<OrchestratorConfigLoadOptions, "workspaceRoot"> = {
    ...(context.configPath ? { configPath: context.configPath } : {}),
    ...(context.configEnv ? { env: context.configEnv } : {}),
  };

  return createConfiguredRuntimeRegistryLoader(options).load(workspaceRoot);
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

function resolveCwd(cwd: string | undefined, workspaceRoot: string): string {
  if (!cwd) {
    return workspaceRoot;
  }
  return resolve(workspaceRoot, cwd);
}

function workspaceName(workspaceRoot: string): string {
  const parts = workspaceRoot.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? workspaceRoot;
}

function storeOptions(context: ToolContext) {
  return {
    workspaceRoot: context.workspaceRoot,
    ...(context.orchestratorDir ? { orchestratorDir: context.orchestratorDir } : {}),
  };
}

async function summarizeStoredTask(
  context: ToolContext,
  task: AgentTaskRecord,
  observation?: TaskObservation,
): Promise<TaskSummary> {
  const store = storeOptions(context);
  return summarizeTask(task, observation ?? (await observeTaskState(store, task)));
}

function summarizeTask(task: AgentTaskRecord, observation?: TaskObservation): TaskSummary {
  const state = observation?.state ?? taskDisplayState(task);
  const active = observation?.active ?? !isTerminalTaskStatus(task.status);
  const actionable = observation?.actionable ?? active;
  return {
    taskId: task.taskId,
    ...(task.name ? { name: task.name } : {}),
    runtime: task.runtime,
    status: task.status,
    ...(state === task.status ? {} : { state }),
    active,
    actionable,
    ...(observation?.reason && state !== task.status
      ? { observationReason: observation.reason }
      : {}),
    cwd: task.cwd,
    ...(task.location ? { location: task.location } : {}),
    createdAt: task.createdAt,
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.stopRequestedAt ? { stopRequestedAt: task.stopRequestedAt } : {}),
    ...(task.stopReason ? { stopReason: task.stopReason } : {}),
    ...(task.stopSignal ? { stopSignal: task.stopSignal } : {}),
    ...(task.pid ? { pid: task.pid } : {}),
    taskDir: task.paths.taskDir,
  };
}

async function readLatestTaskUsage(
  store: ReturnType<typeof storeOptions>,
  taskId: string,
): Promise<TokenUsage | undefined> {
  const task = await readTaskRecord(store, taskId);
  const taskUsage = selectTaskUsage(undefined, task.usage);
  if (taskUsage) {
    return taskUsage;
  }

  const events = await readTaskEvents({ ...store, taskId, agentOnly: true });
  let selected: TaskUsage | undefined;
  for (const event of events) {
    const usage = tokenUsageFromUnknown(event.data.usage);
    if (usage) {
      selected = selectTaskUsage(selected, usageWithUpdatedAt(usage, event.ts));
    }
  }
  return selected;
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
      ...(progress.observation.state === progress.task.status
        ? {}
        : { state: progress.observation.state }),
      active: progress.observation.active,
      actionable: progress.observation.actionable,
      ...(progress.observation.reason && progress.observation.state !== progress.task.status
        ? { observationReason: progress.observation.reason }
        : {}),
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
