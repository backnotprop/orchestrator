import { randomUUID } from "node:crypto";
import {
  buildAgentResumeLaunchPlan,
  createConfiguredRuntimeRegistryLoader,
  getRuntimeConfig,
  isTerminalTaskStatus,
  launchTask,
  listTasks,
  localTaskLocation,
  observeTaskState,
  readTaskRecord,
  taskCwd,
  taskWorkspaceRoot,
  validateLaunchTaskInput,
  type AgentLaunchPlan,
  type AgentTaskRecord,
  type AgentRuntimeId,
  type LaunchTaskInput,
} from "@backnotprop/orchestrator-core";
import { launchInBackground } from "../background-task.ts";
import { CliError } from "../cli-errors.ts";
import { printTask, printTaskSummaryJson } from "../task-output.ts";

export type ResumeOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  taskId?: string;
  task?: string;
  name?: string;
  model?: string;
  outputMode?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  wait: boolean;
  compact: boolean;
  brief: boolean;
};

export async function commandResume(
  options: ResumeOptions,
  context: { cliEntryPath: string },
): Promise<void> {
  if (!options.taskId) {
    throw new CliError("resume requires a task id.");
  }
  if (!options.task) {
    throw new CliError("resume requires next task instructions.");
  }

  const storeOptions = {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
  };
  const sourceTask = await readTaskRecord(storeOptions, options.taskId);
  if (!isTerminalTaskStatus(sourceTask.status)) {
    throw new CliError(`Task "${sourceTask.taskId}" is still active and cannot be resumed yet.`, {
      reason: "active_source_task",
      input: sourceTask.taskId,
      hint: "Wait for the task to finish, or use read/logs/events to inspect it.",
    });
  }

  const workspaceRoot = taskWorkspaceRoot(sourceTask, options.workspaceRoot);
  const cwd = taskCwd(sourceTask);
  const registryLoader = createConfiguredRuntimeRegistryLoader({
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });
  const { registry } = await registryLoader.load(workspaceRoot);
  const runtime = getRuntimeConfig(sourceTask.runtime, registry);
  const model = options.model ?? sourceTask.model;
  const name = options.name ?? sourceTask.name;
  const plan = buildAgentResumeLaunchPlan(
    {
      runtime: sourceTask.runtime as AgentRuntimeId,
      task: options.task,
      cwd,
      provider: sourceTask.provider ?? {},
      ...(model ? { model } : {}),
      ...(options.outputMode ? { outputMode: options.outputMode } : {}),
    },
    registry,
  );

  await assertNoActiveResumeConflict(storeOptions, sourceTask, plan);

  const launchInput: LaunchTaskInput = {
    workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId: randomUUID(),
    plan,
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    location: localTaskLocation(workspaceRoot, cwd),
    ...(sourceTask.labels ? { labels: { ...sourceTask.labels } } : {}),
    ...(plan.resume ? { provider: resumeProviderMetadata(plan.resume) } : {}),
    resume: {
      fromTaskId: sourceTask.taskId,
      rootTaskId: sourceTask.resume?.rootTaskId ?? sourceTask.taskId,
      attempt: (sourceTask.resume?.attempt ?? 0) + 1,
    },
    timeoutMs: options.timeoutMs ?? runtime?.defaults.timeoutMs,
    maxOutputBytes: options.maxOutputBytes ?? runtime?.defaults.maxOutputBytes,
  };
  validateLaunchTaskInput(launchInput);

  if (options.wait) {
    const handle = await launchTask(launchInput);
    const completed = await handle.completed;
    await printResumeTask(completed, options);
    return;
  }

  const task = await launchInBackground(launchInput, context);
  await printResumeTask(task, options);
}

async function assertNoActiveResumeConflict(
  storeOptions: { workspaceRoot: string; orchestratorDir?: string },
  sourceTask: AgentTaskRecord,
  plan: AgentLaunchPlan,
): Promise<void> {
  if (!plan.resume) {
    return;
  }

  const tasks = await listTasks(storeOptions);
  for (const task of tasks) {
    if (task.taskId === sourceTask.taskId || !sameProviderSession(task, plan)) {
      continue;
    }
    const observation = await observeTaskState(storeOptions, task);
    if (observation.active) {
      throw new CliError(`Task "${task.taskId}" is already active for this provider session.`, {
        reason: "resume_session_active",
        input: task.taskId,
        hint: "Wait for the active task to finish before resuming this provider session again.",
      });
    }
  }
}

function sameProviderSession(task: AgentTaskRecord, plan: AgentLaunchPlan): boolean {
  if (!plan.resume) {
    return false;
  }
  if (plan.resume.provider === "codex") {
    if (!plan.resume.threadId) {
      return false;
    }
    return task.provider?.provider === "codex" && task.provider.threadId === plan.resume.threadId;
  }
  if (!plan.resume.sessionId) {
    return false;
  }
  return (
    task.provider?.provider === "claude-code" && task.provider.sessionId === plan.resume.sessionId
  );
}

function resumeProviderMetadata(
  resume: NonNullable<AgentLaunchPlan["resume"]>,
): NonNullable<LaunchTaskInput["provider"]> {
  return resume.provider === "codex"
    ? { provider: "codex", threadId: resume.threadId }
    : { provider: "claude-code", sessionId: resume.sessionId };
}

async function printResumeTask(task: AgentTaskRecord, options: ResumeOptions): Promise<void> {
  if (options.json && options.compact) {
    await printTaskSummaryJson(task, options);
    return;
  }

  printTask(task, options.json);
}
