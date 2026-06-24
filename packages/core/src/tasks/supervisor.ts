import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentLaunchPlan } from "../runtime/index.ts";
import { observeTaskState } from "./observation.ts";
import { killPidGroup, ProcessTaskExecutor } from "./executors/process.ts";
import type { TaskExecutionHandle } from "./executors/types.ts";
import { isTerminalTaskStatus } from "./types.ts";
import type {
  AgentTaskRecord,
  InterruptTaskInput,
  InterruptTasksInput,
  InterruptTasksResult,
  LaunchTaskHandle,
  LaunchTaskInput,
  ReadTaskOutputInput,
  TaskObservedState,
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

type RunningTask = {
  handle: TaskExecutionHandle;
  appendEvent: (type: TaskEvent["type"], data?: Record<string, unknown>) => Promise<TaskEvent>;
};

const runningTasks = new Map<string, RunningTask>();
const processTaskExecutor = new ProcessTaskExecutor();

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
    ...(input.provider ? { provider: { ...input.provider } } : {}),
    storeScope: input.orchestratorDir ? "custom" : "machine",
    location,
    ...(input.labels ? { labels: { ...input.labels } } : {}),
    paths,
  };

  await initializeTaskFiles(initialTask);

  let eventQueue: Promise<unknown> = Promise.resolve();
  const maxOutputBytes = input.maxOutputBytes ?? 2_000_000;
  const appendEvent = async (
    type: TaskEvent["type"],
    data: Record<string, unknown> = {},
  ): Promise<TaskEvent> => {
    const write = eventQueue.then(() => appendSequencedTaskEvent(paths, taskId, type, data));
    eventQueue = write.catch(() => {});
    return await write;
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
  let task = await updateTaskStatus(initialTask, "starting");
  await appendEvent("starting", {
    executable: input.plan.executable,
    args: input.plan.args,
    cwd: input.plan.cwd,
  });

  const execution = processTaskExecutor.start({
    input,
    taskId,
    task,
    paths,
    maxOutputBytes,
    appendEvent,
  });
  const completed = execution.completed.finally(() => {
    runningTasks.delete(taskId);
  });
  runningTasks.set(taskId, {
    handle: execution,
    appendEvent,
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

function now(): string {
  return new Date().toISOString();
}
