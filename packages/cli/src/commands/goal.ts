import {
  listTaskIds,
  observeTaskState,
  startTaskGoal,
  type StartTaskGoalResult,
} from "@backnotprop/orchestrator-core";
import { jsonLine } from "../json-output.ts";
import {
  briefTaskSummaryJsonPayload,
  stopArgsSuffix,
  type CommonTaskOutputOptions,
} from "../task-output.ts";
import { taskCommandSummary } from "../task-json.ts";

export type GoalStartOptions = CommonTaskOutputOptions & {
  configPath?: string;
  taskId: string;
  goal: string;
  timeoutMs?: number;
  tokenBudget?: number;
  wait: boolean;
  compact: boolean;
};

export async function commandGoalStart(options: GoalStartOptions): Promise<void> {
  const result = await startTaskGoal({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId: options.taskId,
    goal: options.goal,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
    wait: options.wait,
  });

  if (options.json) {
    await printGoalStartJson(result, options);
    return;
  }

  const target = result.task.name ?? shortId(result.task.taskId);
  const status = result.goal?.status ?? result.operation?.status ?? result.status;
  const tokens = result.operation?.usage?.totalTokens ?? result.task.usage?.totalTokens;
  const tokenText = tokens === undefined ? "" : `  ${formatTokens(tokens)} tok`;
  process.stdout.write(`goal ${status}  ${target}${tokenText}\n`);
}

async function printGoalStartJson(
  result: StartTaskGoalResult,
  options: GoalStartOptions,
): Promise<void> {
  const storeOptions = {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
  };
  const taskIds = await listTaskIds(storeOptions);
  const observation = await observeTaskState(storeOptions, result.task);
  const summary = taskCommandSummary(result.task, taskIds, {
    stopArgsSuffix: stopArgsSuffix(options),
    observation,
  });
  const task = options.compact ? briefTaskSummaryJsonPayload(summary, true) : summary;
  process.stdout.write(
    jsonLine(
      {
        schemaVersion: 1,
        ok: true,
        task,
        goal: {
          status: result.status,
          ...(result.provider ? { provider: result.provider } : {}),
          ...(result.goal ? { state: result.goal } : {}),
          ...(result.operation ? { operation: result.operation } : {}),
        },
      },
      options,
    ),
  );
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
