import { access } from "node:fs/promises";
import {
  isTerminalTaskStatus as isTerminalStatus,
  listTaskIds,
  observeTaskState,
  readTaskOutput,
  readTaskRecord,
  taskBatchControlCommands,
  waitForTask,
  type AgentTaskControlStopTarget,
  type AgentTaskRecord,
  type TaskEvent,
  type TaskObservation,
  type WaitForTaskRetrievalStatus,
} from "@backnotprop/orchestrator-core";
import { CliError } from "../cli-errors.ts";
import { jsonLine } from "../json-output.ts";
import { isAgentEventLine, parseTaskEventLine } from "../task-events.ts";
import { taskEventsJsonPayload, taskLogsJsonPayload } from "../task-json.ts";
import {
  compactTaskReadJsonPayload,
  emptyTailRead,
  readNewFileText,
  readTail,
  readTailMetadataIfExists,
  readTailWithOffsetIfExists,
  stopArgsSuffix,
  taskReadJsonPayload,
  type TaskReadJsonPayload,
} from "../task-output.ts";

export type LogStream = "stdout" | "stderr" | "all";

type CommonTaskInspectionOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
};

export type ReadOptions = CommonTaskInspectionOptions & {
  taskIds: readonly string[];
  maxBytes?: number;
  wait: boolean;
  timeoutMs?: number;
  intervalMs?: number;
  compact: boolean;
};

export type LogsOptions = CommonTaskInspectionOptions & {
  taskId: string;
  stream: LogStream;
  maxBytes?: number;
  follow: boolean;
  compact: boolean;
};

export type EventsOptions = CommonTaskInspectionOptions & {
  taskId: string;
  maxBytes?: number;
  agentOnly: boolean;
  compact: boolean;
};

type StoreOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
};

export async function commandRead(options: ReadOptions): Promise<void> {
  const storeOptions = taskInspectionStoreOptions(options);

  if (options.taskIds.length > 1) {
    await commandReadBatch(options, storeOptions);
    return;
  }

  const { task, retrievalStatus, observation } = await readTaskForOptions(
    options,
    storeOptions,
    onlyTaskId(options),
  );

  if (options.json) {
    const payload = await taskReadJsonPayload(task, options, undefined, {
      ...(retrievalStatus ? { retrievalStatus } : {}),
      observation,
    });
    const rendered = options.compact ? compactTaskReadJsonPayload(payload) : payload;
    process.stdout.write(jsonLine(rendered, options));
    return;
  }

  if (retrievalStatus === "timeout") {
    process.stderr.write(
      `Timed out waiting for task ${task.taskId}; state is ${observation.state}.\n`,
    );
  } else if (retrievalStatus === "unavailable") {
    process.stderr.write(
      `Task ${task.taskId} is ${observation.state}; final outcome is unavailable.${observation.reason ? ` ${observation.reason}.` : ""}\n`,
    );
  }

  const output = await readTaskOutput({
    ...storeOptions,
    taskId: task.taskId,
    maxBytes: options.maxBytes,
  });

  if (output.length > 0) {
    writeHumanReadOutput(output);
    return;
  }

  if (!isTerminalStatus(task.status)) {
    const stdout = await readTail(task.paths.stdoutLog, options.maxBytes ?? 200_000);
    if (stdout.length > 0) {
      writeHumanReadOutput(stdout);
      return;
    }

    if (retrievalStatus !== "timeout" && retrievalStatus !== "unavailable") {
      process.stderr.write(`No output yet; task ${task.taskId} is ${observation.state}.\n`);
    }
    return;
  }

  writeHumanReadOutput(output);
}

export async function commandLogs(options: LogsOptions): Promise<void> {
  const storeOptions = taskInspectionStoreOptions(options);
  const task = await readTaskRecord(storeOptions, options.taskId);
  const observation = await observeTaskState(storeOptions, task);
  const maxBytes = options.maxBytes ?? 200_000;

  if (options.follow) {
    if (options.json) {
      throw new CliError("logs --follow cannot be combined with --json.", {
        reason: "incompatible_options",
        input: "--follow",
        hint: "Use logs --follow for raw streaming text, or watch --json for parseable JSONL events.",
      });
    }
    await followLogs(task, options, storeOptions, maxBytes);
    return;
  }

  const stdout =
    options.stream === "stderr"
      ? emptyTailRead()
      : await readTailMetadataIfExists(task.paths.stdoutLog, maxBytes);
  const stderr =
    options.stream === "stdout"
      ? emptyTailRead()
      : await readTailMetadataIfExists(task.paths.stderrLog, maxBytes);

  if (options.json) {
    const taskIds = await listTaskIds(storeOptions);
    process.stdout.write(
      jsonLine(
        taskLogsJsonPayload({
          task,
          taskIds,
          stream: options.stream,
          maxBytes,
          stdout,
          stderr,
          stopArgsSuffix: stopArgsSuffix(options),
          observation,
        }),
        options,
      ),
    );
    return;
  }

  if (stdout.text) {
    process.stdout.write(stdout.text);
  }
  if (stderr.text) {
    process.stderr.write(stderr.text);
  }
}

export async function commandEvents(options: EventsOptions): Promise<void> {
  const storeOptions = taskInspectionStoreOptions(options);
  const task = await readTaskRecord(storeOptions, options.taskId);
  const observation = await observeTaskState(storeOptions, task);
  const maxBytes = options.maxBytes ?? 500_000;
  const raw = await readTailMetadataIfExists(task.paths.eventsJsonl, maxBytes);
  const lines = raw.text.trim() ? raw.text.trimEnd().split("\n") : [];
  const events = options.agentOnly ? lines.filter((line) => isAgentEventLine(line)) : lines;
  const parsedEvents = events
    .map(parseTaskEventLine)
    .filter((event): event is TaskEvent => Boolean(event));

  if (options.json) {
    if (options.compact) {
      const taskIds = await listTaskIds(storeOptions);
      process.stdout.write(
        jsonLine(
          taskEventsJsonPayload({
            task,
            taskIds,
            events: parsedEvents,
            agentOnly: options.agentOnly,
            maxBytes,
            eventsTruncated: raw.truncated,
            stopArgsSuffix: stopArgsSuffix(options),
            observation,
          }),
          options,
        ),
      );
      return;
    }

    process.stdout.write(jsonLine(parsedEvents, options));
    return;
  }

  if (events.length > 0) {
    process.stdout.write(`${events.join("\n")}\n`);
  }
}

async function commandReadBatch(options: ReadOptions, storeOptions: StoreOptions): Promise<void> {
  const taskIds = await listTaskIds(storeOptions);
  const results = await Promise.all(
    options.taskIds.map((taskId) => readTaskForOptions(options, storeOptions, taskId)),
  );
  const payloads = await Promise.all(
    results.map(async (result) => {
      return await taskReadJsonPayload(result.task, options, taskIds, {
        ...(result.retrievalStatus ? { retrievalStatus: result.retrievalStatus } : {}),
        observation: result.observation,
      });
    }),
  );
  const tasks = payloads.map((payload) => batchTaskReadJsonPayload(payload, options.compact));
  const activeIds = payloads.filter((payload) => payload.active).map((payload) => payload.id);
  const stop = taskBatchStopTarget(payloads, results, options);

  process.stdout.write(
    jsonLine(
      {
        schemaVersion: 1,
        summary: readBatchSummary(results),
        ...(activeIds.length > 0
          ? { commands: taskBatchControlCommands(activeIds, stopArgsSuffix(options)) }
          : {}),
        ...(stop ? { stop } : {}),
        tasks,
      },
      options,
    ),
  );
}

function taskBatchStopTarget(
  payloads: readonly TaskReadJsonPayload[],
  results: readonly { task: AgentTaskRecord }[],
  options: CommonTaskInspectionOptions,
): AgentTaskControlStopTarget | undefined {
  const active = payloads
    .map((payload, index) => ({ payload, task: results[index]?.task }))
    .filter((item): item is { payload: TaskReadJsonPayload; task: AgentTaskRecord } =>
      Boolean(item.task && item.payload.stop),
    );

  if (active.length === 0) {
    return undefined;
  }

  if (active.length === 1) {
    return active[0]?.payload.stop;
  }

  const activeParents = active.filter((item) => item.task.runtime === "orchestrator");
  if (activeParents.length > 0) {
    if (activeParents.length === 1 && activeBelongsToParent(active, activeParents[0]?.task)) {
      return activeParents[0]?.payload.stop;
    }
    return undefined;
  }

  const ids = active.map((item) => item.payload.id);
  return {
    kind: "tasks",
    ids: [...ids],
    args: ["interrupt", ...ids, "--json", "--compact", ...stopArgsSuffix(options)],
  };
}

function activeBelongsToParent(
  active: readonly { task: AgentTaskRecord }[],
  parent: AgentTaskRecord | undefined,
): boolean {
  if (!parent) {
    return false;
  }

  return active.every(
    (item) =>
      item.task.taskId === parent.taskId ||
      item.task.parent?.parentTaskId === parent.taskId ||
      item.task.parent?.parentRunId === parent.taskId,
  );
}

async function readTaskForOptions(
  options: ReadOptions,
  storeOptions: StoreOptions,
  taskId: string,
): Promise<{
  task: AgentTaskRecord;
  retrievalStatus?: WaitForTaskRetrievalStatus;
  observation: TaskObservation;
}> {
  const task = await readTaskRecord(storeOptions, taskId);

  if (options.wait && !isTerminalStatus(task.status)) {
    const result = await waitForTask({
      ...storeOptions,
      taskId: task.taskId,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    });
    return {
      retrievalStatus: result.retrievalStatus,
      task: result.task,
      observation: result.observation,
    };
  }

  const observation = await observeTaskState(storeOptions, task);
  return {
    ...(options.wait ? { retrievalStatus: "completed" as const } : {}),
    task,
    observation,
  };
}

function onlyTaskId(options: ReadOptions): string {
  const taskId = options.taskIds[0];
  if (!taskId) {
    throw new CliError("read requires a task id.", {
      reason: "missing_required_argument",
      input: "task-id",
      hint: "Pass one task id or unique prefix. Run orchestrator ps --json --compact --active for active tasks, or orchestrator ps --all --json --compact for history.",
    });
  }
  return taskId;
}

function writeHumanReadOutput(output: string): void {
  process.stdout.write(output);
  if (output.length > 0 && !output.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

function readBatchSummary(
  results: readonly {
    task: AgentTaskRecord;
    retrievalStatus?: WaitForTaskRetrievalStatus;
    observation: TaskObservation;
  }[],
): {
  tasks: number;
  active: number;
  done: number;
  failed: number;
  stopped: number;
  timedOut: number;
  retrievalCompleted?: number;
  retrievalTimeout?: number;
  retrievalUnavailable?: number;
} {
  const summary = {
    tasks: results.length,
    active: results.filter((result) => result.observation.active).length,
    done: results.filter((result) => result.task.status === "succeeded").length,
    failed: results.filter((result) => result.task.status === "failed").length,
    stopped: results.filter((result) => result.task.status === "cancelled").length,
    timedOut: results.filter((result) => result.task.status === "timed_out").length,
  };
  if (!results.some((result) => result.retrievalStatus)) {
    return summary;
  }

  const retrievalUnavailable = results.filter(
    (result) => result.retrievalStatus === "unavailable",
  ).length;
  return {
    ...summary,
    retrievalCompleted: results.filter((result) => result.retrievalStatus === "completed").length,
    retrievalTimeout: results.filter((result) => result.retrievalStatus === "timeout").length,
    ...(retrievalUnavailable > 0 ? { retrievalUnavailable } : {}),
  };
}

function batchTaskReadJsonPayload(
  payload: TaskReadJsonPayload,
  compact: boolean,
):
  | Omit<TaskReadJsonPayload, "schemaVersion">
  | Omit<TaskReadJsonPayload, "schemaVersion" | "commands"> {
  const rendered = compact ? compactTaskReadJsonPayload(payload) : payload;
  const { schemaVersion: _schemaVersion, ...task } = rendered;
  return task;
}

async function followLogs(
  task: AgentTaskRecord,
  options: LogsOptions,
  storeOptions: StoreOptions,
  maxBytes: number,
): Promise<void> {
  if (options.stream === "all" && (await fileExists(task.paths.combinedLog))) {
    await followCombinedLog(task, storeOptions, maxBytes);
    return;
  }

  let stdoutOffset = 0;
  let stderrOffset = 0;

  if (options.stream !== "stderr") {
    const stdout = await readTailWithOffsetIfExists(task.paths.stdoutLog, maxBytes);
    stdoutOffset = stdout.offset;
    if (stdout.text) {
      process.stdout.write(stdout.text);
    }
  }

  if (options.stream !== "stdout") {
    const stderr = await readTailWithOffsetIfExists(task.paths.stderrLog, maxBytes);
    stderrOffset = stderr.offset;
    if (stderr.text) {
      process.stderr.write(stderr.text);
    }
  }

  while (true) {
    const current = await readTaskRecord(storeOptions, task.taskId);

    if (options.stream !== "stderr") {
      const stdout = await readNewFileText(current.paths.stdoutLog, stdoutOffset);
      stdoutOffset = stdout.offset;
      if (stdout.text) {
        process.stdout.write(stdout.text);
      }
    }

    if (options.stream !== "stdout") {
      const stderr = await readNewFileText(current.paths.stderrLog, stderrOffset);
      stderrOffset = stderr.offset;
      if (stderr.text) {
        process.stderr.write(stderr.text);
      }
    }

    if (isTerminalStatus(current.status)) {
      return;
    }

    await delay(250);
  }
}

async function followCombinedLog(
  task: AgentTaskRecord,
  storeOptions: StoreOptions,
  maxBytes: number,
): Promise<void> {
  const initial = await readTailWithOffsetIfExists(task.paths.combinedLog, maxBytes);
  let offset = initial.offset;
  if (initial.text) {
    process.stdout.write(initial.text);
  }

  while (true) {
    const current = await readTaskRecord(storeOptions, task.taskId);
    const output = await readNewFileText(current.paths.combinedLog, offset);
    offset = output.offset;
    if (output.text) {
      process.stdout.write(output.text);
    }

    if (isTerminalStatus(current.status)) {
      return;
    }

    await delay(250);
  }
}

function taskInspectionStoreOptions(options: CommonTaskInspectionOptions): StoreOptions {
  return {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
