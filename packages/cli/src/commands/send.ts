import {
  listTaskIds,
  isSharedCodexAppServerSessionTask,
  observeTaskState,
  sendTaskMessage,
  type SendTaskMessageResult,
} from "@backnotprop/orchestrator-core";
import { launchSessionOperationMonitor } from "../background-task.ts";
import { jsonLine } from "../json-output.ts";
import {
  briefTaskSummaryJsonPayload,
  stopArgsSuffix,
  type CommonTaskOutputOptions,
} from "../task-output.ts";
import { taskCommandSummary } from "../task-json.ts";

export type SendOptions = CommonTaskOutputOptions & {
  configPath?: string;
  taskId: string;
  message: string;
  timeoutMs?: number;
  wait: boolean;
  compact: boolean;
};

export async function commandSend(
  options: SendOptions,
  context: { cliEntryPath: string },
): Promise<void> {
  const result = await sendTaskMessage({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId: options.taskId,
    text: options.message,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    wait: options.wait,
  });
  await maybeLaunchSessionOperationMonitor(result, options, context);

  if (options.json) {
    await printSendJson(result, options);
    return;
  }

  const target = result.task.name ?? shortId(result.task.taskId);
  const operation = result.operation?.result ? `: ${result.operation.result}` : "";
  process.stdout.write(`sent message to ${target}${operation}\n`);
}

async function maybeLaunchSessionOperationMonitor(
  result: SendTaskMessageResult,
  options: SendOptions,
  context: { cliEntryPath: string },
): Promise<void> {
  if (
    options.wait ||
    !result.operation ||
    !isSharedCodexAppServerSessionTask(result.task) ||
    !isRunningOperationStatus(result.operation.status)
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

function isRunningOperationStatus(status: string): boolean {
  return status === "starting" || status === "running";
}

async function printSendJson(result: SendTaskMessageResult, options: SendOptions): Promise<void> {
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
        message: {
          status: result.status,
          ...(result.provider ? { provider: result.provider } : {}),
          ...(result.operation ? { operation: result.operation } : {}),
        },
      },
      options,
    ),
  );
}

function shortId(value: string): string {
  return value.slice(0, 8);
}
