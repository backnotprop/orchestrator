import { readFile, stat } from "node:fs/promises";
import {
  AGENT_CONTROL_PREVIEW_MAX_BYTES,
  isTerminalTaskStatus as isTerminalStatus,
  listTaskIds,
  type AgentTaskRecord,
  type TaskStatus,
  type TaskUsage,
} from "@backnotprop/orchestrator-core";
import { jsonLine } from "./json-output.ts";
import { taskCommandSummary, type TaskCommandSummary, type TailRead } from "./task-json.ts";

const DEFAULT_READ_MAX_BYTES = 200_000;

export type CommonTaskOutputOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  json: boolean;
};

export function printTask(task: AgentTaskRecord, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
    return;
  }

  process.stdout.write(`taskId: ${task.taskId}\n`);
  if (task.name) {
    process.stdout.write(`name: ${task.name}\n`);
  }
  process.stdout.write(`status: ${task.status}\n`);
  process.stdout.write(`runtime: ${task.runtime}\n`);
  process.stdout.write(`taskDir: ${task.paths.taskDir}\n`);
}

export async function printTaskSummaryJson(
  task: AgentTaskRecord,
  options: CommonTaskOutputOptions & { wait: boolean; maxBytes?: number; brief?: boolean },
): Promise<void> {
  const storeOptions = {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
  };
  const taskIds = await listTaskIds(storeOptions);
  if (options.wait || isTerminalStatus(task.status)) {
    const payload = await taskReadJsonPayload(task, compactReadOptions(options), taskIds);
    const summary = compactTaskReadJsonPayload(payload);
    process.stdout.write(jsonLine(summary, { compact: true }));
    return;
  }

  const summary = taskCommandSummary(task, taskIds, { stopArgsSuffix: stopArgsSuffix(options) });
  process.stdout.write(
    jsonLine(briefTaskSummaryJsonPayload(summary, options.brief ?? false), {
      compact: true,
    }),
  );
}

export function stopArgsSuffix(
  options: Pick<CommonTaskOutputOptions, "orchestratorDir">,
): string[] {
  return [...(options.orchestratorDir ? ["--orchestrator-dir", options.orchestratorDir] : [])];
}

export function compactReadOptions<T extends CommonTaskOutputOptions & { maxBytes?: number }>(
  options: T,
): T {
  if (options.maxBytes !== undefined) {
    return options;
  }
  return { ...options, maxBytes: AGENT_CONTROL_PREVIEW_MAX_BYTES };
}

export async function taskReadJsonPayload(
  task: AgentTaskRecord,
  options: CommonTaskOutputOptions & { maxBytes?: number },
  taskIds?: readonly string[],
  metadata: { retrievalStatus?: "completed" | "timeout" } = {},
): Promise<
  TaskCommandSummary & {
    retrievalStatus?: "completed" | "timeout";
    output: string;
    outputAvailable: boolean;
    outputKind: "result" | "stdout" | "none";
    outputTruncated: boolean;
    outputTruncatedByReadLimit: boolean;
    outputTruncatedByCaptureLimit: boolean;
    maxBytes: number;
    captureMaxBytes?: number;
    usage?: TaskUsage;
    error?: string;
    errorTruncated?: boolean;
    errorTruncatedByReadLimit?: boolean;
    errorTruncatedByCaptureLimit?: boolean;
  }
> {
  const maxBytes = options.maxBytes ?? DEFAULT_READ_MAX_BYTES;
  const output = await readTailMetadataIfExists(task.paths.resultMd, maxBytes);
  const fallback =
    output.text.length === 0 && !isTerminalStatus(task.status)
      ? await readTailMetadataIfExists(task.paths.stdoutLog, maxBytes)
      : emptyTailRead();
  const stderrError =
    !task.error && isFailedReadStatus(task.status)
      ? await readTailMetadataIfExists(task.paths.stderrLog, maxBytes)
      : emptyTailRead();
  const stderrErrorText = stderrError.text.trim();
  const error = task.error ?? (stderrErrorText || undefined);
  const aliases =
    taskIds ??
    (await listTaskIds({
      workspaceRoot: options.workspaceRoot,
      ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    }));
  const renderedOutput = output.text.length > 0 ? output : fallback;
  const outputKind =
    output.text.length > 0 ? "result" : fallback.text.length > 0 ? "stdout" : "none";
  const outputCaptureTruncated =
    outputKind === "result"
      ? (task.outputCapture?.resultTruncated ?? false)
      : outputKind === "stdout"
        ? (task.outputCapture?.stdoutTruncated ?? false)
        : false;
  const errorCaptureTruncated =
    Boolean(error && !task.error) && (task.outputCapture?.stderrTruncated ?? false);

  return {
    ...taskCommandSummary(task, aliases, { stopArgsSuffix: stopArgsSuffix(options) }),
    ...(metadata.retrievalStatus ? { retrievalStatus: metadata.retrievalStatus } : {}),
    output: renderedOutput.text,
    outputAvailable: renderedOutput.text.length > 0,
    outputKind,
    outputTruncated: renderedOutput.truncated || outputCaptureTruncated,
    outputTruncatedByReadLimit: renderedOutput.truncated,
    outputTruncatedByCaptureLimit: outputCaptureTruncated,
    maxBytes,
    ...(outputCaptureTruncated ? { captureMaxBytes: task.outputCapture?.maxBytes } : {}),
    ...(task.usage ? { usage: task.usage } : {}),
    ...(error ? { error } : {}),
    ...(error && !task.error && (stderrError.truncated || errorCaptureTruncated)
      ? {
          errorTruncated: true,
          errorTruncatedByReadLimit: stderrError.truncated,
          errorTruncatedByCaptureLimit: errorCaptureTruncated,
        }
      : {}),
  };
}

export type TaskReadJsonPayload = Awaited<ReturnType<typeof taskReadJsonPayload>>;
type CompactTaskReadCommands = Partial<
  Pick<
    TaskReadJsonPayload["commands"],
    "read" | "readPreview" | "waitPreview" | "logs" | "logsPreview" | "events" | "agentEvents"
  >
>;
type CompactTaskReadJsonPayload = Omit<TaskReadJsonPayload, "commands"> & {
  commands?: CompactTaskReadCommands;
};

export function compactTaskReadJsonPayload(
  payload: TaskReadJsonPayload,
): CompactTaskReadJsonPayload {
  const { commands, ...compact } = payload;
  if (readCanRecoverTruncatedOutput(payload)) {
    return { ...compact, commands: truncatedReadRecoveryCommands(commands) };
  }
  if (payload.active) {
    return { ...compact, commands: activeReadFollowupCommands(commands) };
  }
  if (payload.status === "failed" || payload.error) {
    return { ...compact, commands: failedReadFollowupCommands(commands) };
  }
  return compact;
}

function readCanRecoverTruncatedOutput(payload: TaskReadJsonPayload): boolean {
  return Boolean(payload.outputTruncatedByReadLimit || payload.errorTruncatedByReadLimit);
}

function truncatedReadRecoveryCommands(
  commands: TaskReadJsonPayload["commands"],
): CompactTaskReadCommands {
  return {
    read: commands.read,
    readPreview: commands.readPreview,
    logs: commands.logs,
    logsPreview: commands.logsPreview,
    events: commands.events,
    agentEvents: commands.agentEvents,
  };
}

function activeReadFollowupCommands(
  commands: TaskReadJsonPayload["commands"],
): CompactTaskReadCommands {
  return {
    readPreview: commands.readPreview,
    waitPreview: commands.waitPreview,
  };
}

function failedReadFollowupCommands(
  commands: TaskReadJsonPayload["commands"],
): CompactTaskReadCommands {
  return {
    logsPreview: commands.logsPreview,
    events: commands.events,
    agentEvents: commands.agentEvents,
  };
}

export function briefTaskSummaryJsonPayload(
  payload: TaskCommandSummary,
  brief: boolean,
): TaskCommandSummary | Omit<TaskCommandSummary, "commands"> {
  if (!brief) {
    return payload;
  }
  const { commands: _commands, ...compact } = payload;
  return compact;
}

function isFailedReadStatus(status: TaskStatus): boolean {
  return status === "failed" || status === "cancelled" || status === "timed_out";
}

export async function readTail(path: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(path);
  const contents = await readFile(path);

  if (fileStat.size <= maxBytes) {
    return contents.toString("utf8");
  }

  return contents.subarray(contents.byteLength - maxBytes).toString("utf8");
}

export function emptyTailRead(): TailRead {
  return {
    text: "",
    truncated: false,
  };
}

async function readTailMetadata(path: string, maxBytes: number): Promise<TailRead> {
  const fileStat = await stat(path);
  const contents = await readFile(path);
  const truncated = fileStat.size > maxBytes;

  return {
    text: truncated
      ? contents.subarray(contents.byteLength - maxBytes).toString("utf8")
      : contents.toString("utf8"),
    truncated,
  };
}

export async function readTailMetadataIfExists(path: string, maxBytes: number): Promise<TailRead> {
  try {
    return await readTailMetadata(path, maxBytes);
  } catch (error) {
    if (isMissingFile(error)) {
      return emptyTailRead();
    }
    throw error;
  }
}

export async function readTailWithOffsetIfExists(
  path: string,
  maxBytes: number,
): Promise<{ text: string; offset: number }> {
  try {
    const fileStat = await stat(path);
    const contents = await readFile(path);
    const start = fileStat.size <= maxBytes ? 0 : contents.byteLength - maxBytes;
    return {
      text: contents.subarray(start).toString("utf8"),
      offset: contents.byteLength,
    };
  } catch (error) {
    if (isMissingFile(error)) {
      return { text: "", offset: 0 };
    }
    throw error;
  }
}

export async function readNewFileText(
  path: string,
  offset: number,
): Promise<{ text: string; offset: number }> {
  let contents: Buffer;
  try {
    contents = await readFile(path);
  } catch (error) {
    if (isMissingFile(error)) {
      return { text: "", offset };
    }
    throw error;
  }

  const safeOffset = Math.min(offset, contents.byteLength);
  return {
    text: contents.subarray(safeOffset).toString("utf8"),
    offset: contents.byteLength,
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
