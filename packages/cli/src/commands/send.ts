import {
  listTaskIds,
  observeTaskState,
  sendTaskMessage,
  type SendTaskMessageResult,
} from "@backnotprop/orchestrator-core";
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
  compact: boolean;
};

export async function commandSend(options: SendOptions): Promise<void> {
  const result = await sendTaskMessage({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId: options.taskId,
    text: options.message,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  if (options.json) {
    await printSendJson(result, options);
    return;
  }

  process.stdout.write(`sent message to ${result.task.name ?? shortId(result.task.taskId)}\n`);
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
        },
      },
      options,
    ),
  );
}

function shortId(value: string): string {
  return value.slice(0, 8);
}
