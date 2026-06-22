import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentLaunchPlan } from "../runtime/index.ts";
import { isTerminalTaskStatus } from "./types.ts";
import type {
  AgentTaskRecord,
  InterruptTaskInput,
  InterruptTasksInput,
  InterruptTasksResult,
  LaunchTaskHandle,
  LaunchTaskInput,
  ReadTaskOutputInput,
  TaskEvent,
  TaskStoreOptions,
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
import { createRuntimeOutputAdapter } from "./output-adapters.ts";
import { selectTaskUsage, usageWithUpdatedAt } from "./usage.ts";

type RunningTask = {
  child: ChildProcessWithoutNullStreams;
  appendEvent: (type: TaskEvent["type"], data?: Record<string, unknown>) => Promise<TaskEvent>;
  cancelRequested: boolean;
  cancelReason?: string;
  cancelSignal: NodeJS.Signals;
};

const runningTasks = new Map<string, RunningTask>();

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
    storeScope: input.orchestratorDir ? "custom" : "machine",
    location,
    ...(input.labels ? { labels: { ...input.labels } } : {}),
    paths,
  };

  await initializeTaskFiles(initialTask);

  let eventQueue: Promise<unknown> = Promise.resolve();
  let taskRecordQueue: Promise<unknown> = Promise.resolve();
  const maxOutputBytes = input.maxOutputBytes ?? 2_000_000;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutCaptureTruncated = false;
  let stderrCaptureTruncated = false;
  const appendEvent = async (
    type: TaskEvent["type"],
    data: Record<string, unknown> = {},
  ): Promise<TaskEvent> => {
    const write = eventQueue.then(() => appendSequencedTaskEvent(paths, taskId, type, data));
    eventQueue = write.catch(() => {});
    return await write;
  };
  const updateTaskUsage = async (usage: AgentTaskRecord["usage"]): Promise<void> => {
    if (!usage) {
      return;
    }

    const update = taskRecordQueue.then(async () => {
      const current = await readTaskRecord(input, taskId);
      const selected = selectTaskUsage(current.usage, usage);
      if (selected === current.usage) {
        return;
      }
      await updateTaskStatus(current, current.status, { usage: selected });
    });
    taskRecordQueue = update.catch(() => {});
    await update;
  };
  const outputCaptureSnapshot = (
    resultTruncated = false,
  ): NonNullable<AgentTaskRecord["outputCapture"]> => ({
    maxBytes: maxOutputBytes,
    stdoutBytes,
    stderrBytes,
    stdoutTruncated: stdoutBytes > maxOutputBytes,
    stderrTruncated: stderrBytes > maxOutputBytes,
    resultTruncated,
    updatedAt: now(),
  });
  const shouldPersistOutputCapture = (resultTruncated = false): boolean =>
    stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes || resultTruncated;
  const updateOutputCapture = async (): Promise<void> => {
    if (!shouldPersistOutputCapture()) {
      return;
    }

    const update = taskRecordQueue.then(async () => {
      const current = await readTaskRecord(input, taskId);
      await updateTaskStatus(current, current.status, {
        outputCapture: outputCaptureSnapshot(current.outputCapture?.resultTruncated ?? false),
      });
    });
    taskRecordQueue = update.catch(() => {});
    await update;
  };
  const outputAdapter = createRuntimeOutputAdapter({
    plan: input.plan,
    paths,
    appendEvent,
    onUsage: updateTaskUsage,
  });

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
  let task = await updateTaskStatus(initialTask, "starting");
  await appendEvent("starting", {
    executable: input.plan.executable,
    args: input.plan.args,
    cwd: input.plan.cwd,
  });

  const child = spawn(input.plan.executable, input.plan.args, {
    cwd: input.plan.cwd,
    env: { ...process.env, ...input.plan.env },
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let settled = false;
  const timeoutMs = input.timeoutMs;
  const pendingWrites: Promise<unknown>[] = [];
  let stdoutQueue: Promise<unknown> = Promise.resolve();
  let stderrQueue: Promise<unknown> = Promise.resolve();
  const runningTask: RunningTask = {
    child,
    appendEvent,
    cancelRequested: false,
    cancelSignal: "SIGTERM",
  };
  runningTasks.set(taskId, runningTask);

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    const currentBytes = stdoutBytes;
    const streamTruncated = currentBytes > maxOutputBytes;
    const shouldUpdateCapture = streamTruncated && !stdoutCaptureTruncated;
    if (streamTruncated) {
      stdoutCaptureTruncated = true;
    }
    const write = stdoutQueue.then(async () => {
      await appendBoundedOutput({
        path: paths.stdoutLog,
        chunk,
        currentBytes,
        maxBytes: maxOutputBytes,
      });
      await appendEvent("stdout", {
        bytes: chunk.byteLength,
        ...(streamTruncated
          ? {
              truncated: true,
              maxBytes: maxOutputBytes,
              storedBytes: Math.min(currentBytes, maxOutputBytes),
            }
          : {}),
      });
      if (shouldUpdateCapture) {
        await updateOutputCapture();
      }
      await outputAdapter.onStdoutChunk(chunk);
    });
    stdoutQueue = write.catch(() => {});
    pendingWrites.push(write);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    const currentBytes = stderrBytes;
    const streamTruncated = currentBytes > maxOutputBytes;
    const shouldUpdateCapture = streamTruncated && !stderrCaptureTruncated;
    if (streamTruncated) {
      stderrCaptureTruncated = true;
    }
    const write = stderrQueue.then(async () => {
      await appendBoundedOutput({
        path: paths.stderrLog,
        chunk,
        currentBytes,
        maxBytes: maxOutputBytes,
      });
      await appendEvent("stderr", {
        bytes: chunk.byteLength,
        ...(streamTruncated
          ? {
              truncated: true,
              maxBytes: maxOutputBytes,
              storedBytes: Math.min(currentBytes, maxOutputBytes),
            }
          : {}),
      });
      if (shouldUpdateCapture) {
        await updateOutputCapture();
      }
      await outputAdapter.onStderrChunk(chunk);
    });
    stderrQueue = write.catch(() => {});
    pendingWrites.push(write);
  });

  const completed = new Promise<AgentTaskRecord>((resolve) => {
    child.on("error", (error) => {
      void (async () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        await Promise.all(pendingWrites);
        await outputAdapter.finalize();
        await eventQueue;
        await taskRecordQueue;
        runningTasks.delete(taskId);
        const failed = await updateTaskStatus(task, "failed", {
          finishedAt: now(),
          exitCode: null,
          error: error.message,
        });
        await appendEvent("failed", { error: error.message });
        resolve(failed);
      })();
    });

    child.on("close", (code, signal) => {
      void (async () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        runningTasks.delete(taskId);
        await Promise.all(pendingWrites);
        const adapterResult = await outputAdapter.finalize();
        await eventQueue;
        await taskRecordQueue;

        const current = await readTaskRecord(input, taskId);
        const stdout = await readFile(paths.stdoutLog, "utf8");
        const fallbackToStdout = adapterResult.fallbackToStdout ?? true;
        const resultTruncated =
          adapterResult.resultText === undefined &&
          fallbackToStdout &&
          stdoutBytes > maxOutputBytes;
        const result = adapterResult.resultText ?? (fallbackToStdout ? stdout : "");
        await writeFile(paths.resultMd, result);
        await appendEvent("result", { path: paths.resultMd, bytes: Buffer.byteLength(result) });

        const finalStatus =
          current.status === "cancelled" || runningTask.cancelRequested
            ? "cancelled"
            : timedOut
              ? "timed_out"
              : code === 0 && !adapterResult.failed
                ? "succeeded"
                : "failed";
        const error = timedOut
          ? `Timed out after ${timeoutMs}ms.`
          : finalStatus === "cancelled"
            ? (current.error ?? runningTask.cancelReason)
            : signal
              ? `Process exited from signal ${signal}.`
              : finalStatus === "failed"
                ? adapterResult.errorText
                : undefined;

        const finished = await updateTaskStatus(current, finalStatus, {
          finishedAt: now(),
          exitCode: code,
          ...(error ? { error } : {}),
          ...(adapterResult.usage
            ? {
                usage: selectTaskUsage(
                  current.usage,
                  usageWithUpdatedAt(adapterResult.usage, now()),
                ),
              }
            : {}),
          ...(shouldPersistOutputCapture(resultTruncated)
            ? { outputCapture: outputCaptureSnapshot(resultTruncated) }
            : {}),
        });
        await appendEvent(finalStatus === "succeeded" ? "completed" : finalStatus, {
          exitCode: code,
          signal,
          ...(error ? { error } : {}),
        });
        resolve(finished);
      })();
    });
  });

  child.once("spawn", () => {
    void (async () => {
      if (settled) {
        return;
      }

      const current = await readTaskRecord(input, taskId);
      if (current.status === "cancelled" || runningTask.cancelRequested) {
        killProcessGroup(child, runningTask.cancelSignal);
        return;
      }

      if (input.plan.stdin) {
        child.stdin.write(input.plan.stdin.input);
        if (input.plan.stdin.closeAfterWrite) {
          child.stdin.end();
        }
      } else {
        child.stdin.end();
      }

      const startedAt = now();
      task = await updateTaskStatus(current, "running", {
        startedAt,
        ...(child.pid ? { pid: child.pid } : {}),
      });
      if (runningTask.cancelRequested) {
        killProcessGroup(child, runningTask.cancelSignal);
        return;
      }

      await appendEvent("running", { pid: child.pid ?? null });

      timeout = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            killProcessGroup(child);
          }, timeoutMs)
        : undefined;
    })();
  });

  child.stdin.on("error", () => {
    // Spawn/kill races can close stdin before we write. The child error/close
    // handlers own the durable task status.
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

export async function interruptTask(input: InterruptTaskInput): Promise<AgentTaskRecord> {
  const task = await readTaskRecord(input, input.taskId);
  const running = runningTasks.get(task.taskId);
  const reason = input.reason ?? "Interrupted.";
  const signal = input.signal ?? "SIGTERM";

  if (!running && isTerminalTaskStatus(task.status)) {
    throw new TaskSupervisorError(`Task "${task.taskId}" is not running in this process.`);
  }

  if (running) {
    running.cancelRequested = true;
    running.cancelReason = reason;
    running.cancelSignal = signal;
  }

  const updated = await updateTaskStatus(task, "cancelled", {
    error: reason,
  });

  if (running) {
    await running.appendEvent("interrupt_requested", { reason });
  } else {
    await appendSequencedTaskEvent(task.paths, task.taskId, "interrupt_requested", { reason });
  }

  if (running) {
    killProcessGroup(running.child, signal);
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
  const nonTerminalChildren = children.filter((child) => !isTerminalTaskStatus(child.status));

  if (
    task.runtime === "orchestrator" &&
    nonTerminalChildren.length > 0 &&
    !target.children &&
    !target.taskOnly
  ) {
    throw new TaskSupervisorSafetyError(
      `Task "${shortId(task.taskId)}" has ${nonTerminalChildren.length} running ${nonTerminalChildren.length === 1 ? "child" : "children"}. Use:\n  orchestrator interrupt ${shortId(task.taskId)} --children\nor:\n  orchestrator interrupt ${shortId(task.taskId)} --task-only`,
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

function killProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!child.pid) {
    return;
  }

  killPidGroup(child.pid, signal);
}

function killPidGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch (error) {
    if (!isNoSuchProcess(error)) {
      throw error;
    }
  }
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

async function readTail(path: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(path);
  const contents = await readFile(path);

  if (fileStat.size <= maxBytes) {
    return contents.toString("utf8");
  }

  return contents.subarray(contents.byteLength - maxBytes).toString("utf8");
}

function now(): string {
  return new Date().toISOString();
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
