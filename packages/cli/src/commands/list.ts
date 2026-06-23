import {
  getRuntimeConfig,
  listTasks,
  loadConfiguredRuntimeRegistry,
  matchesTaskWorkspace,
  type AgentTaskRecord,
  type RuntimeRegistry,
  type TaskStatus,
} from "@backnotprop/orchestrator-core";
import { summarizeTaskPrompt } from "../task-labels.ts";
import { formatInline } from "../terminal-format.ts";

export type ListOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  status?: TaskStatus;
  allWorkspaces: boolean;
};

export async function commandList(options: ListOptions): Promise<void> {
  const { registry } = await loadConfiguredRuntimeRegistry({
    workspaceRoot: options.workspaceRoot,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });
  const allTasks = await listTasks({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    status: options.status,
  });
  const tasks = allTasks.filter((task) =>
    matchesTaskWorkspace(task, {
      workspaceRoot: options.workspaceRoot,
      allWorkspaces: options.allWorkspaces,
    }),
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
    return;
  }

  if (tasks.length === 0) {
    process.stdout.write("No tasks.\n");
    return;
  }

  const nowMs = Date.now();
  for (const task of tasks) {
    process.stdout.write(formatTaskListLine(task, nowMs, registry));
  }
}

function formatTaskListLine(
  task: AgentTaskRecord,
  nowMs: number,
  registry: RuntimeRegistry,
): string {
  return (
    [
      displayTaskName(task),
      task.status,
      task.runtime,
      taskModel(task, registry),
      formatTaskAge(task.createdAt, nowMs),
      task.taskId,
    ].join("\t") + "\n"
  );
}

function displayTaskName(task: AgentTaskRecord): string {
  const name = task.name ?? summarizeTask(task);
  return formatInline(name || "(unnamed)");
}

function taskModel(task: AgentTaskRecord, registry: RuntimeRegistry): string {
  if (task.model) {
    return task.model;
  }

  const runtime = getRuntimeConfig(task.runtime, registry);
  const modelFlag = runtime?.launch.modelFlag;
  if (!modelFlag) {
    return "-";
  }

  const modelFlagIndex = task.launchPlan.args.indexOf(modelFlag);
  const model = modelFlagIndex >= 0 ? task.launchPlan.args[modelFlagIndex + 1] : undefined;
  return model && !model.startsWith("-") ? model : "-";
}

function formatTaskAge(createdAt: string, nowMs: number): string {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) {
    return createdAt;
  }

  const seconds = Math.max(0, Math.floor((nowMs - createdMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

function summarizeTask(task: AgentTaskRecord): string {
  const promptArg = task.launchPlan.args.at(-1);
  if (!promptArg) {
    return "";
  }
  return summarizeTaskPrompt(promptArg);
}
