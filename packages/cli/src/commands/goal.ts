import {
  clearTaskGoal,
  getTaskGoal,
  isSharedCodexAppServerSessionTask,
  listTaskIds,
  observeTaskState,
  setTaskGoal,
  startTaskGoal,
  type ClearTaskGoalResult,
  type GetTaskGoalResult,
  type SetTaskGoalResult,
  type SettableTaskGoalStatus,
  type StartTaskGoalResult,
} from "@backnotprop/orchestrator-core";
import { launchSessionOperationMonitor } from "../background-task.ts";
import { jsonLine } from "../json-output.ts";
import {
  briefTaskSummaryJsonPayload,
  stopArgsSuffix,
  type CommonTaskOutputOptions,
} from "../task-output.ts";
import { taskCommandSummary } from "../task-json.ts";

type GoalBaseOptions = CommonTaskOutputOptions & {
  configPath?: string;
  taskId: string;
  timeoutMs?: number;
  compact: boolean;
};

export type GoalStartOptions = GoalBaseOptions & {
  command: "start";
  goal: string;
  tokenBudget?: number;
  wait: boolean;
};

export type GoalGetOptions = GoalBaseOptions & {
  command: "get";
};

export type GoalSetOptions = GoalBaseOptions & {
  command: "set";
  objective?: string;
  status?: SettableTaskGoalStatus;
  tokenBudget?: number | null;
};

export type GoalClearOptions = GoalBaseOptions & {
  command: "clear";
};

export type GoalOptions = GoalStartOptions | GoalGetOptions | GoalSetOptions | GoalClearOptions;

export async function commandGoal(
  options: GoalOptions,
  context: { cliEntryPath: string },
): Promise<void> {
  switch (options.command) {
    case "start":
      await commandGoalStart(options, context);
      return;
    case "get":
      await commandGoalGet(options);
      return;
    case "set":
      await commandGoalSet(options);
      return;
    case "clear":
      await commandGoalClear(options);
      return;
  }
}

async function commandGoalStart(
  options: GoalStartOptions,
  context: { cliEntryPath: string },
): Promise<void> {
  const result = await startTaskGoal({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId: options.taskId,
    goal: options.goal,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
    wait: options.wait,
  });
  await maybeLaunchSessionOperationMonitor(result, options, context);

  if (options.json) {
    await printGoalStartJson(result, options);
    return;
  }

  const target = result.task.name ?? shortId(result.task.taskId);
  const status = goalStartStatus(result);
  const tokens = result.operation?.usage?.totalTokens ?? result.task.usage?.totalTokens;
  const tokenText = tokens === undefined ? "" : `  ${formatTokens(tokens)} tok`;
  process.stdout.write(`goal start ${result.status}  goal ${status}  ${target}${tokenText}\n`);
}

async function maybeLaunchSessionOperationMonitor(
  result: StartTaskGoalResult,
  options: GoalStartOptions,
  context: { cliEntryPath: string },
): Promise<void> {
  if (
    options.wait ||
    result.status !== "running" ||
    !result.operation ||
    !isSharedCodexAppServerSessionTask(result.task)
  ) {
    return;
  }

  await launchSessionOperationMonitor(
    {
      workspaceRoot: options.workspaceRoot,
      ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
      taskId: result.task.taskId,
      operationId: result.operation.operationId,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    },
    context,
  );
}

async function commandGoalGet(options: GoalGetOptions): Promise<void> {
  const result = await getTaskGoal({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId: options.taskId,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  if (options.json) {
    await printGoalControlJson("get", result, options);
    return;
  }

  printGoalState(result);
}

async function commandGoalSet(options: GoalSetOptions): Promise<void> {
  const result = await setTaskGoal({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId: options.taskId,
    ...(options.objective ? { objective: options.objective } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(Object.prototype.hasOwnProperty.call(options, "tokenBudget")
      ? { tokenBudget: options.tokenBudget ?? null }
      : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  if (options.json) {
    await printGoalControlJson("set", result, options);
    return;
  }

  printGoalState(result);
}

async function commandGoalClear(options: GoalClearOptions): Promise<void> {
  const result = await clearTaskGoal({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId: options.taskId,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  if (options.json) {
    await printGoalControlJson("clear", result, options);
    return;
  }

  const target = result.task.name ?? shortId(result.task.taskId);
  process.stdout.write(`goal ${result.cleared ? "cleared" : "none"}  ${target}\n`);
}

async function printGoalStartJson(
  result: StartTaskGoalResult,
  options: GoalStartOptions,
): Promise<void> {
  const task = await taskPayload(result.task, options);
  process.stdout.write(
    jsonLine(
      {
        schemaVersion: 1,
        ok: true,
        task,
        goal: {
          action: "start",
          commandStatus: result.status,
          status: goalStartStatus(result),
          ...(result.provider ? { provider: result.provider } : {}),
          ...(result.goal ? { state: result.goal } : {}),
          ...(result.operation ? { operation: result.operation } : {}),
        },
      },
      options,
    ),
  );
}

async function printGoalControlJson(
  action: "get" | "set" | "clear",
  result: GetTaskGoalResult | SetTaskGoalResult | ClearTaskGoalResult,
  options: GoalGetOptions | GoalSetOptions | GoalClearOptions,
): Promise<void> {
  const task = await taskPayload(result.task, options);
  const goal =
    action === "clear"
      ? {
          action,
          source: result.source,
          cleared: "cleared" in result ? result.cleared : false,
          ...(result.provider ? { provider: result.provider } : {}),
        }
      : {
          action,
          source: result.source,
          ...(result.provider ? { provider: result.provider } : {}),
          ...("goal" in result && result.goal ? { state: result.goal } : {}),
        };
  process.stdout.write(
    jsonLine(
      {
        schemaVersion: 1,
        ok: true,
        task,
        goal,
      },
      options,
    ),
  );
}

async function taskPayload(
  taskRecord: StartTaskGoalResult["task"],
  options: GoalOptions,
): Promise<unknown> {
  const storeOptions = {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
  };
  const taskIds = await listTaskIds(storeOptions);
  const observation = await observeTaskState(storeOptions, taskRecord);
  const summary = taskCommandSummary(taskRecord, taskIds, {
    stopArgsSuffix: stopArgsSuffix(options),
    observation,
  });
  return options.compact ? briefTaskSummaryJsonPayload(summary, true) : summary;
}

function printGoalState(result: GetTaskGoalResult | SetTaskGoalResult): void {
  const target = result.task.name ?? shortId(result.task.taskId);
  const status = result.goal?.status ?? "none";
  const tokens = result.goal?.tokensUsed ?? result.task.usage?.totalTokens;
  const tokenText = tokens === undefined ? "" : `  ${formatTokens(tokens)} tok`;
  process.stdout.write(`goal ${status}  ${target}${tokenText}\n`);
}

function goalStartStatus(result: StartTaskGoalResult): string {
  return result.goal?.status ?? result.operation?.status ?? result.status;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}m`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  return String(tokens);
}

function shortId(value: string): string {
  return value.slice(0, 8);
}
