import { randomUUID } from "node:crypto";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentLaunchPlan } from "../runtime/index.ts";
import {
  requestDetachedTaskGoalStart,
  requestDetachedTaskMessage,
  startTaskControlLoop,
  TaskControlRequestError,
  type TaskControlResponse,
  type TaskControlLoop,
} from "./control.ts";
import { observeTaskState } from "./observation.ts";
import { CodexAppServerTaskExecutor } from "./executors/protocol/codex-app-server.ts";
import { killPidGroup, ProcessTaskExecutor } from "./executors/process.ts";
import {
  TaskSendMessageError,
  type TaskExecutionHandle,
  type TaskExecutor,
} from "./executors/types.ts";
import { isTerminalTaskStatus } from "./types.ts";
import { selectTaskUsage } from "./usage.ts";
import type {
  AgentTaskRecord,
  InterruptTaskInput,
  InterruptTasksInput,
  InterruptTasksResult,
  LaunchTaskHandle,
  LaunchTaskInput,
  ReadTaskOutputInput,
  SendTaskMessageInput,
  SendTaskMessageResult,
  StartTaskGoalInput,
  StartTaskGoalResult,
  TaskObservedState,
  TaskEvent,
  TaskProviderMetadata,
  TaskSendMessageFailureReason,
  TaskStoreOptions,
  TaskStatus,
  TaskUsage,
} from "./types.ts";
import {
  appendSequencedTaskEvent,
  getTaskPaths,
  initializeTaskFiles,
  localTaskLocation,
  listTasks,
  readTaskRecord,
  resolveTaskId,
  taskCwd,
  taskWorkspaceRoot,
  updateTaskStatus,
} from "./store.ts";
import {
  UNGROUPED_GROUP_ID,
  childTasksForParent,
  resolveTaskGroupId,
  taskGroupId,
  tasksForGroup,
} from "./groups.ts";

type RunningTask = {
  handle: TaskExecutionHandle;
  appendEvent: (type: TaskEvent["type"], data?: Record<string, unknown>) => Promise<TaskEvent>;
  controlLoop: TaskControlLoop;
};

const runningTasks = new Map<string, RunningTask>();
const processTaskExecutor = new ProcessTaskExecutor();
const codexAppServerTaskExecutor = new CodexAppServerTaskExecutor();

export { listTasks } from "./store.ts";

export class TaskSupervisorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskSupervisorError";
  }
}

export class TaskSupervisorSafetyError extends TaskSupervisorError {
  readonly reason?: string;
  readonly input?: string;
  readonly hint?: string;

  constructor(message: string, details: { reason?: string; input?: string; hint?: string } = {}) {
    super(message);
    this.name = "TaskSupervisorSafetyError";
    this.reason = details.reason;
    this.input = details.input;
    this.hint = details.hint;
  }
}

export function validateLaunchTaskInput(input: LaunchTaskInput): void {
  validateLaunchPlan(input.plan);
  normalizeTaskName(input.name);
}

export async function launchTask(input: LaunchTaskInput): Promise<LaunchTaskHandle> {
  validateLaunchTaskInput(input);
  const executor = taskExecutorForPlan(input.plan);
  const taskName = normalizeTaskName(input.name);

  const taskId = input.taskId ?? randomUUID();
  const paths = getTaskPaths(input, taskId);
  const createdAt = now();
  const location = input.location ?? localTaskLocation(input.workspaceRoot, input.plan.cwd);
  const initialTask: AgentTaskRecord = {
    taskId,
    ...(taskName ? { name: taskName } : {}),
    ...(input.model ? { model: input.model } : {}),
    runtime: input.plan.runtime,
    launchPlan: input.plan,
    cwd: input.plan.cwd,
    status: "queued",
    createdAt,
    ...(input.parent ? { parent: input.parent } : {}),
    ...(input.resume ? { resume: input.resume } : {}),
    ...(input.provider ? { provider: { ...input.provider } } : {}),
    storeScope: input.orchestratorDir ? "custom" : "machine",
    location,
    ...(input.labels ? { labels: { ...input.labels } } : {}),
    paths,
  };

  await initializeTaskFiles(initialTask);

  let task = initialTask;
  let eventQueue: Promise<unknown> = Promise.resolve();
  let taskRecordQueue: Promise<unknown> = Promise.resolve();
  let stdoutQueue: Promise<unknown> = Promise.resolve();
  let stderrQueue: Promise<unknown> = Promise.resolve();
  let combinedQueue: Promise<unknown> = Promise.resolve();
  let transcriptQueue: Promise<unknown> = Promise.resolve();
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let combinedBytes = 0;
  const maxOutputBytes = input.maxOutputBytes ?? 2_000_000;
  const appendEvent = async (
    type: TaskEvent["type"],
    data: Record<string, unknown> = {},
  ): Promise<TaskEvent> => {
    const write = eventQueue.then(() => appendSequencedTaskEvent(paths, taskId, type, data));
    eventQueue = write.catch(() => {});
    return await write;
  };
  const queueTaskRecordUpdate = async (
    update: (current: AgentTaskRecord) => Promise<AgentTaskRecord>,
  ): Promise<AgentTaskRecord> => {
    const write = taskRecordQueue.then(async () => {
      const current = await readTaskRecord(input, taskId);
      const updated = await update(current);
      task = updated;
      return updated;
    });
    taskRecordQueue = write.catch(() => {});
    return await write;
  };
  const appendOutput = async (
    path: string,
    chunk: Buffer | string,
    stream: "stdout" | "stderr" | "combined",
  ): Promise<void> => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let currentBytes: number;
    if (stream === "stdout") {
      stdoutBytes += bytes.byteLength;
      currentBytes = stdoutBytes;
    } else if (stream === "stderr") {
      stderrBytes += bytes.byteLength;
      currentBytes = stderrBytes;
    } else {
      combinedBytes += bytes.byteLength;
      currentBytes = combinedBytes;
    }
    await appendBoundedOutput({
      path,
      chunk: bytes,
      currentBytes,
      maxBytes: maxOutputBytes,
    });
  };
  const appendStdout = async (chunk: Buffer | string): Promise<void> => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const write = stdoutQueue.then(async () => {
      await appendOutput(paths.stdoutLog, bytes, "stdout");
      await appendEvent("stdout", { bytes: bytes.byteLength });
    });
    stdoutQueue = write.catch(() => {});
    await write;
  };
  const appendStderr = async (chunk: Buffer | string): Promise<void> => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const write = stderrQueue.then(async () => {
      await appendOutput(paths.stderrLog, bytes, "stderr");
      await appendEvent("stderr", { bytes: bytes.byteLength });
    });
    stderrQueue = write.catch(() => {});
    await write;
  };
  const appendCombined = async (chunk: Buffer | string): Promise<void> => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const write = combinedQueue.then(() => appendOutput(paths.combinedLog, bytes, "combined"));
    combinedQueue = write.catch(() => {});
    await write;
  };
  const appendTranscript = async (line: string | Record<string, unknown>): Promise<void> => {
    const rendered = typeof line === "string" ? line : JSON.stringify(line);
    const write = transcriptQueue.then(() => appendFile(paths.transcriptJsonl, `${rendered}\n`));
    transcriptQueue = write.catch(() => {});
    await write;
  };
  const updateTask = async (patch: Partial<AgentTaskRecord>): Promise<AgentTaskRecord> =>
    await queueTaskRecordUpdate((current) => updateTaskStatus(current, current.status, patch));
  const setStatus = async (
    status: TaskStatus,
    details: Partial<AgentTaskRecord> = {},
  ): Promise<AgentTaskRecord> =>
    await queueTaskRecordUpdate((current) => updateTaskStatus(current, status, details));
  const updateUsage = async (usage: TaskUsage): Promise<void> => {
    await queueTaskRecordUpdate(async (current) => {
      const selected = selectTaskUsage(current.usage, usage);
      if (selected === current.usage) {
        return current;
      }
      return await updateTaskStatus(current, current.status, { usage: selected });
    });
  };
  const updateProvider = async (provider: TaskProviderMetadata): Promise<void> => {
    await queueTaskRecordUpdate((current) =>
      updateTaskStatus(current, current.status, {
        provider: { ...(current.provider ?? {}), ...provider },
      }),
    );
  };
  const writeResult = async (text: string): Promise<void> => {
    await writeFile(paths.resultMd, text);
    await appendEvent("result", { path: paths.resultMd, bytes: Buffer.byteLength(text) });
  };
  const markTerminal = async (
    status: TaskStatus,
    details: Partial<AgentTaskRecord> = {},
    eventData: Record<string, unknown> = {},
  ): Promise<AgentTaskRecord> => {
    const finished = await queueTaskRecordUpdate((current) =>
      updateTaskStatus(current, status, {
        finishedAt: now(),
        ...details,
      }),
    );
    await appendEvent(status === "succeeded" ? "completed" : status, eventData);
    return finished;
  };

  await appendEvent("queued", { runtime: input.plan.runtime });
  if (input.parent) {
    await appendEvent("agent_event", {
      kind: "task.parent",
      parentRunId: input.parent.parentRunId,
      ...(input.parent.parentTaskId ? { parentTaskId: input.parent.parentTaskId } : {}),
      ...(input.parent.parentSessionId ? { parentSessionId: input.parent.parentSessionId } : {}),
      ...(input.parent.parentToolCallId ? { parentToolCallId: input.parent.parentToolCallId } : {}),
    });
  }
  if (input.resume) {
    await appendEvent("agent_event", {
      kind: "task.resume",
      fromTaskId: input.resume.fromTaskId,
      rootTaskId: input.resume.rootTaskId,
      attempt: input.resume.attempt,
    });
  }
  task = await updateTaskStatus(initialTask, "starting");
  await appendEvent("starting", {
    executable: input.plan.executable,
    args: input.plan.args,
    cwd: input.plan.cwd,
  });

  const execution = executor.start({
    input,
    taskId,
    task,
    paths,
    maxOutputBytes,
    appendEvent,
    appendStdout,
    appendStderr,
    appendCombined,
    appendTranscript,
    updateTask,
    setStatus,
    updateUsage,
    updateProvider,
    writeResult,
    markTerminal,
  });
  const controlLoop = input.plan.canSteerRunning
    ? startTaskControlLoop({
        taskId,
        paths,
        handle: execution,
        appendEvent,
      })
    : { stop() {} };
  const completed = execution.completed.finally(() => {
    controlLoop.stop();
    runningTasks.delete(taskId);
  });
  runningTasks.set(taskId, {
    handle: execution,
    appendEvent,
    controlLoop,
  });

  return {
    task,
    completed,
  };
}

export async function readTaskOutput(input: ReadTaskOutputInput): Promise<string> {
  const task = await readTaskRecord(input, input.taskId);
  const maxBytes = input.maxBytes ?? 200_000;
  return readTail(task.paths.resultMd, maxBytes);
}

export async function sendTaskMessage(input: SendTaskMessageInput): Promise<SendTaskMessageResult> {
  const text = input.text.trim();
  if (!text) {
    throw new TaskSupervisorSafetyError("send requires a non-empty message.", {
      reason: "invalid_request",
      input: input.taskId,
      hint: "Pass the message as the final quoted argument.",
    });
  }

  const taskId = await resolveTaskId(input, input.taskId);
  const task = await readTaskRecord(input, taskId);
  if (isTerminalTaskStatus(task.status)) {
    throw new TaskSupervisorSafetyError(`Task "${shortId(task.taskId)}" has already finished.`, {
      reason: "not_running",
      input: task.taskId,
      hint: `Use orchestrator resume ${shortId(task.taskId)} "message" when the runtime supports resume, or launch a new task.`,
    });
  }
  if (!task.launchPlan.canSteerRunning) {
    throw new TaskSupervisorSafetyError(
      `Task "${shortId(task.taskId)}" uses runtime "${task.runtime}", which does not accept messages while running.`,
      {
        reason: "unsupported",
        input: task.taskId,
        hint: "Use read, logs, events, interrupt, resume, or launch a new task instead.",
      },
    );
  }

  const observation = await observeTaskState(input, task);
  if (!observation.actionable) {
    throw new TaskSupervisorSafetyError(
      `Task "${shortId(task.taskId)}" is ${observation.state}; Orchestrator cannot send it a message safely.`,
      {
        reason: sendFailureReasonForObservedState(observation.state),
        input: task.taskId,
        hint: "Use read, logs, and events to inspect the task before retrying.",
      },
    );
  }

  const running = runningTasks.get(task.taskId);
  const result = running
    ? await sendMessageToRunningHandle(task, running.handle, {
        text,
        ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.wait !== undefined ? { wait: input.wait } : {}),
      })
    : await requestDetachedTaskMessage({
        paths: task.paths,
        taskId: task.taskId,
        text,
        ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.wait !== undefined ? { wait: input.wait } : {}),
      });

  if (result.status === "failed") {
    throw new TaskControlRequestError(
      result.error?.reason ?? "provider_rejected",
      result.error?.message ?? "Task rejected the message.",
      {
        input: task.taskId,
        hint: hintForSendFailure(result.error?.reason ?? "provider_rejected", task.taskId),
      },
    );
  }

  return {
    task: await readTaskRecord(input, task.taskId),
    status: result.status,
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.operation ? { operation: result.operation } : {}),
  };
}

export async function startTaskGoal(input: StartTaskGoalInput): Promise<StartTaskGoalResult> {
  const goal = input.goal.trim();
  if (!goal) {
    throw new TaskSupervisorSafetyError("goal start requires a non-empty goal.", {
      reason: "invalid_request",
      input: input.taskId,
      hint: "Pass the goal as the final quoted argument.",
    });
  }

  const taskId = await resolveTaskId(input, input.taskId);
  const task = await readTaskRecord(input, taskId);
  if (isTerminalTaskStatus(task.status)) {
    throw new TaskSupervisorSafetyError(`Task "${shortId(task.taskId)}" has already finished.`, {
      reason: "not_running",
      input: task.taskId,
      hint: "Start a new codex-app-server --session task before starting a goal.",
    });
  }
  if (
    task.runtime !== "codex-app-server" ||
    task.launchPlan.protocolExecutionMode !== "session" ||
    !task.launchPlan.canSteerRunning
  ) {
    throw new TaskSupervisorSafetyError(
      `Task "${shortId(task.taskId)}" does not support native goals.`,
      {
        reason: "unsupported",
        input: task.taskId,
        hint: "Use goal start only with a running codex-app-server --session task.",
      },
    );
  }

  const observation = await observeTaskState(input, task);
  if (!observation.actionable) {
    throw new TaskSupervisorSafetyError(
      `Task "${shortId(task.taskId)}" is ${observation.state}; Orchestrator cannot start a goal safely.`,
      {
        reason: sendFailureReasonForObservedState(observation.state),
        input: task.taskId,
        hint: "Use read, logs, and events to inspect the task before retrying.",
      },
    );
  }

  const running = runningTasks.get(task.taskId);
  const result = running
    ? await startGoalOnRunningHandle(task, running.handle, {
        goal,
        ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.wait !== undefined ? { wait: input.wait } : {}),
        ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
      })
    : await requestDetachedTaskGoalStart({
        paths: task.paths,
        taskId: task.taskId,
        goal,
        ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.wait !== undefined ? { wait: input.wait } : {}),
        ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
      });

  if (result.status === "failed") {
    throw new TaskControlRequestError(
      result.error?.reason ?? "provider_rejected",
      result.error?.message ?? "Task rejected the goal.",
      {
        input: task.taskId,
        hint: hintForGoalFailure(result.error?.reason ?? "provider_rejected", task.taskId),
      },
    );
  }

  return {
    task: await readTaskRecord(input, task.taskId),
    status: result.status,
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.goal ? { goal: result.goal } : {}),
    ...(result.operation ? { operation: result.operation } : {}),
  };
}

async function sendMessageToRunningHandle(
  task: AgentTaskRecord,
  handle: TaskExecutionHandle,
  input: { text: string; clientMessageId?: string; timeoutMs?: number; wait?: boolean },
): Promise<TaskControlResponse> {
  if (!handle.sendMessage) {
    return sendMessageFailedResponse(task, {
      reason: "unsupported",
      message: "This task runtime does not accept messages while running.",
    });
  }

  try {
    const result = await handle.sendMessage(input);
    return {
      schemaVersion: 1,
      requestId: "in-process",
      taskId: task.taskId,
      kind: "send_message",
      status: result.status,
      createdAt: now(),
      completedAt: now(),
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.operation ? { operation: result.operation } : {}),
    };
  } catch (error: unknown) {
    return sendMessageFailedResponse(task, {
      reason: error instanceof TaskSendMessageError ? error.reason : "provider_rejected",
      message: formatError(error),
    });
  }
}

function sendMessageFailedResponse(
  task: AgentTaskRecord,
  error: { reason: TaskSendMessageFailureReason; message: string },
): TaskControlResponse {
  return {
    schemaVersion: 1,
    requestId: "in-process",
    taskId: task.taskId,
    kind: "send_message",
    status: "failed",
    createdAt: now(),
    completedAt: now(),
    error,
  };
}

async function startGoalOnRunningHandle(
  task: AgentTaskRecord,
  handle: TaskExecutionHandle,
  input: {
    goal: string;
    clientMessageId?: string;
    timeoutMs?: number;
    wait?: boolean;
    tokenBudget?: number;
  },
): Promise<TaskControlResponse> {
  if (!handle.startGoal) {
    return goalStartFailedResponse(task, {
      reason: "unsupported",
      message: "This task runtime does not support native goals while running.",
    });
  }

  try {
    const result = await handle.startGoal(input);
    return {
      schemaVersion: 1,
      requestId: "in-process",
      taskId: task.taskId,
      kind: "goal_start",
      status: result.status,
      createdAt: now(),
      completedAt: now(),
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.goal ? { goal: result.goal } : {}),
      ...(result.operation ? { operation: result.operation } : {}),
    };
  } catch (error: unknown) {
    return goalStartFailedResponse(task, {
      reason: error instanceof TaskSendMessageError ? error.reason : "provider_rejected",
      message: formatError(error),
    });
  }
}

function goalStartFailedResponse(
  task: AgentTaskRecord,
  error: { reason: TaskSendMessageFailureReason; message: string },
): TaskControlResponse {
  return {
    schemaVersion: 1,
    requestId: "in-process",
    taskId: task.taskId,
    kind: "goal_start",
    status: "failed",
    createdAt: now(),
    completedAt: now(),
    error,
  };
}

function sendFailureReasonForObservedState(state: TaskObservedState): TaskSendMessageFailureReason {
  switch (state) {
    case "stale":
    case "orphaned":
    case "lost":
      return state;
    default:
      return "not_running";
  }
}

function hintForSendFailure(reason: TaskSendMessageFailureReason, taskId: string): string {
  switch (reason) {
    case "not_running":
      return `Use orchestrator resume ${shortId(taskId)} "message" when the runtime supports resume, or launch a new task.`;
    case "not_ready":
      return "Wait for the task to start its provider turn, then retry.";
    case "unsupported":
      return "Use read, logs, events, interrupt, resume, or launch a new task instead.";
    case "timeout":
      return "Use events, logs, or ps to inspect the running task, then retry if it is still active.";
    case "stale":
    case "orphaned":
    case "lost":
      return "Use read, logs, and events to inspect the task before retrying.";
    case "turn_mismatch":
      return "Use events and logs to inspect the provider turn before retrying.";
    case "invalid_request":
      return "Pass a non-empty message as the final quoted argument.";
    case "provider_rejected":
      return "Use events and logs to inspect why the provider rejected the message.";
  }
}

function hintForGoalFailure(reason: TaskSendMessageFailureReason, taskId: string): string {
  switch (reason) {
    case "not_running":
      return `Start a new codex-app-server --session task before starting a goal. Last task: ${shortId(taskId)}.`;
    case "not_ready":
      return "Wait for the codex-app-server session to become idle, then retry.";
    case "unsupported":
      return "Use goal start only with a running codex-app-server --session task.";
    case "timeout":
      return "Use events, logs, or ps to inspect the running goal, then retry if it is still active.";
    case "stale":
    case "orphaned":
    case "lost":
      return "Use read, logs, and events to inspect the task before retrying.";
    case "turn_mismatch":
      return "Use events and logs to inspect the provider turn before retrying.";
    case "invalid_request":
      return "Pass a non-empty goal as the final quoted argument.";
    case "provider_rejected":
      return "Use events and logs to inspect why the provider rejected the goal.";
  }
}

export async function interruptTask(input: InterruptTaskInput): Promise<AgentTaskRecord> {
  const task = await readTaskRecord(input, input.taskId);
  const running = runningTasks.get(task.taskId);
  const reason = input.reason ?? "Interrupted.";
  const signal = input.signal ?? "SIGTERM";

  if (!running && isTerminalTaskStatus(task.status)) {
    throw new TaskSupervisorError(`Task "${task.taskId}" is not running in this process.`);
  }

  const observation = await observeTaskState(input, task);
  if (!observation.actionable && !running) {
    throw new TaskSupervisorSafetyError(
      `Task "${shortId(task.taskId)}" is ${observation.state}; Orchestrator cannot interrupt it safely.`,
      {
        reason: observation.state,
        input: task.taskId,
        hint: "Use read, logs, and events to inspect the task. If this is stale history, leave it as-is.",
      },
    );
  }

  const updated = await updateTaskStatus(task, task.status, {
    stopRequestedAt: task.stopRequestedAt ?? now(),
    stopReason: reason,
    stopSignal: signal,
  });

  if (running) {
    await running.appendEvent("interrupt_requested", { reason });
  } else {
    await appendSequencedTaskEvent(task.paths, task.taskId, "interrupt_requested", { reason });
  }

  if (running) {
    await running.handle.interrupt(reason, signal);
  } else if (task.pid) {
    killPidGroup(task.pid, signal);
  }

  return updated;
}

export async function interruptTasks(input: InterruptTasksInput): Promise<InterruptTasksResult> {
  const selected = await selectInterruptTasks(input);
  const interrupted: AgentTaskRecord[] = [];
  const skipped: InterruptTasksResult["skipped"] = [];
  const failed: InterruptTasksResult["failed"] = [];

  for (const task of selected.tasks) {
    if (isTerminalTaskStatus(task.status)) {
      skipped.push({ task, reason: "terminal" });
      continue;
    }

    const observation = await observeTaskState(input, task);
    const skipReason = nonActionableInterruptReason(observation.state);
    if (skipReason && !runningTasks.has(task.taskId)) {
      skipped.push({ task, reason: skipReason });
      continue;
    }

    try {
      interrupted.push(
        await interruptTask({
          workspaceRoot: input.workspaceRoot,
          ...(input.orchestratorDir ? { orchestratorDir: input.orchestratorDir } : {}),
          taskId: task.taskId,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
    } catch (error) {
      const latest = await readTaskRecord(input, task.taskId).catch(() => undefined);
      if (latest && isTerminalTaskStatus(latest.status)) {
        skipped.push({ task: latest, reason: "terminal" });
        continue;
      }
      if (latest) {
        const latestObservation = await observeTaskState(input, latest);
        const latestSkipReason = nonActionableInterruptReason(latestObservation.state);
        if (latestSkipReason) {
          skipped.push({ task: latest, reason: latestSkipReason });
          continue;
        }
      }
      failed.push({ taskId: task.taskId, error: formatError(error) });
    }
  }

  return {
    target: selected.target,
    interrupted,
    skipped,
    failed,
  };
}

async function selectInterruptTasks(
  input: InterruptTasksInput,
): Promise<{ target: InterruptTasksInput["target"]; tasks: AgentTaskRecord[] }> {
  const store = {
    workspaceRoot: input.workspaceRoot,
    ...(input.orchestratorDir ? { orchestratorDir: input.orchestratorDir } : {}),
  };
  const tasks = await listTasks(store);
  const scopedTasks = interruptScopeTasks(tasks, input);

  switch (input.target.kind) {
    case "task": {
      const selected = await selectSingleInterruptTask(store, tasks, input.target);
      return {
        target: { ...input.target, taskId: selected.task.taskId },
        tasks: selected.tasks,
      };
    }
    case "tasks": {
      const selections = await Promise.all(
        input.target.taskIds.map((taskId) =>
          selectSingleInterruptTask(store, tasks, { kind: "task", taskId }),
        ),
      );
      const selectedTasks = selections.flatMap((selection) => selection.tasks);
      return {
        target: {
          ...input.target,
          taskIds: selections.map((selection) => selection.task.taskId),
        },
        tasks: orderInterruptTasks(selectedTasks, undefined),
      };
    }
    case "parent": {
      const parentTaskId = await resolveTaskId(store, input.target.parentId);
      const parent = await readTaskRecord(store, parentTaskId);
      return {
        target: { ...input.target, parentId: parent.taskId },
        tasks: orderInterruptTasks(
          [parent, ...childTasksForParent(tasks, parent.taskId)],
          parent.taskId,
        ),
      };
    }
    case "group": {
      const groupId = resolveTaskGroupId(tasks, input.target.groupId);
      if (groupId === UNGROUPED_GROUP_ID) {
        throw new TaskSupervisorSafetyError(
          'Group "ungrouped" is too broad to interrupt. Interrupt specific task ids instead.',
          {
            reason: "broad_group",
            input: groupId,
            hint: "Use orchestrator ps --json --compact --active, then interrupt specific task stop ids.",
          },
        );
      }
      return {
        target: { ...input.target, groupId },
        tasks: orderInterruptTasks(
          tasksForGroup(tasks, groupId),
          parentTaskIdForGroup(tasks, groupId),
        ),
      };
    }
    case "active":
      return {
        target: input.target,
        tasks: orderInterruptTasks(
          scopedTasks.filter((task) => !isTerminalTaskStatus(task.status)),
          undefined,
        ),
      };
  }
}

function interruptScopeTasks(
  tasks: readonly AgentTaskRecord[],
  input: InterruptTasksInput,
): AgentTaskRecord[] {
  return tasks
    .filter((task) =>
      input.allWorkspaces
        ? true
        : taskWorkspaceRoot(task, input.workspaceRoot) === resolve(input.workspaceRoot),
    )
    .filter((task) => (input.cwd ? taskCwd(task) === resolve(input.cwd) : true));
}

async function selectSingleInterruptTask(
  store: TaskStoreOptions,
  allTasks: readonly AgentTaskRecord[],
  target: Extract<InterruptTasksInput["target"], { kind: "task" }>,
): Promise<{ task: AgentTaskRecord; tasks: AgentTaskRecord[] }> {
  const taskId = await resolveTaskId(store, target.taskId);
  const task = await readTaskRecord(store, taskId);
  const children = childTasksForParent(allTasks, task.taskId);
  const activeChildren = (
    await Promise.all(
      children.map(async (child) => ({
        child,
        observation: await observeTaskState(store, child),
      })),
    )
  )
    .filter(({ observation }) => observation.active)
    .map(({ child }) => child);

  if (
    task.runtime === "orchestrator" &&
    activeChildren.length > 0 &&
    !target.children &&
    !target.taskOnly
  ) {
    throw new TaskSupervisorSafetyError(
      `Task "${shortId(task.taskId)}" has ${activeChildren.length} active ${activeChildren.length === 1 ? "child" : "children"}. Use:\n  orchestrator interrupt ${shortId(task.taskId)} --children\nor:\n  orchestrator interrupt ${shortId(task.taskId)} --task-only`,
      {
        reason: "parent_has_running_children",
        input: task.taskId,
        hint: `Use "orchestrator interrupt ${shortId(task.taskId)} --children" to stop the parent and children, or "--task-only" to stop only the parent.`,
      },
    );
  }

  return {
    task,
    tasks: target.children ? orderInterruptTasks([task, ...children], task.taskId) : [task],
  };
}

function nonActionableInterruptReason(
  state: TaskObservedState,
): InterruptTasksResult["skipped"][number]["reason"] | undefined {
  if (state === "stale" || state === "orphaned" || state === "lost") {
    return state;
  }
  return undefined;
}

function orderInterruptTasks(
  tasks: readonly AgentTaskRecord[],
  parentTaskId: string | undefined,
): AgentTaskRecord[] {
  return uniqueTasks(tasks).sort((left, right) => {
    if (parentTaskId) {
      if (left.taskId === parentTaskId) {
        return -1;
      }
      if (right.taskId === parentTaskId) {
        return 1;
      }
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
}

function uniqueTasks(tasks: readonly AgentTaskRecord[]): AgentTaskRecord[] {
  const seen = new Set<string>();
  const unique: AgentTaskRecord[] = [];
  for (const task of tasks) {
    if (seen.has(task.taskId)) {
      continue;
    }
    seen.add(task.taskId);
    unique.push(task);
  }
  return unique;
}

function parentTaskIdForGroup(
  tasks: readonly AgentTaskRecord[],
  groupId: string,
): string | undefined {
  return tasks.find((task) => taskGroupId(task) === groupId && task.runtime === "orchestrator")
    ?.taskId;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function validateLaunchPlan(plan: AgentLaunchPlan): void {
  if (!plan.executable.trim()) {
    throw new TaskSupervisorError("Launch plan executable must not be empty.");
  }

  if (!plan.cwd.trim()) {
    throw new TaskSupervisorError("Launch plan cwd must not be empty.");
  }

  taskExecutorForPlan(plan);
}

function taskExecutorForPlan(plan: AgentLaunchPlan): TaskExecutor {
  if ((plan.executionKind ?? "process") === "process") {
    return processTaskExecutor;
  }

  if (plan.runtime === "codex-app-server") {
    return codexAppServerTaskExecutor;
  }

  throw new TaskSupervisorError(
    `No protocol executor is registered for runtime "${plan.runtime}".`,
  );
}

function normalizeTaskName(name: string | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }

  const normalized = name.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new TaskSupervisorError("Task name must not be empty.");
  }

  return normalized;
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(path);
  const contents = await readFile(path);

  if (fileStat.size <= maxBytes) {
    return contents.toString("utf8");
  }

  return contents.subarray(contents.byteLength - maxBytes).toString("utf8");
}

async function appendBoundedOutput(input: {
  path: string;
  chunk: Buffer;
  currentBytes: number;
  maxBytes: number;
}): Promise<void> {
  const previousBytes = input.currentBytes - input.chunk.byteLength;
  const remainingBytes = input.maxBytes - previousBytes;

  if (remainingBytes <= 0) {
    return;
  }

  await appendFile(input.path, input.chunk.subarray(0, remainingBytes));
}

function now(): string {
  return new Date().toISOString();
}
