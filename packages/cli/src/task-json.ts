import {
  isTerminalTaskStatus,
  taskDisplayState,
  taskControlCommands,
  uniqueIdPrefix,
  type AgentTaskControlStopTarget,
  type AgentTaskControlTaskCommands,
  type AgentTaskRecord,
  type InterruptTasksResult,
  type InterruptTasksTarget,
  type LogStream,
  type TaskLocation,
  type TaskEvent,
  type TaskDisplayState,
  type TaskObservation,
  type TaskStatus,
} from "@backnotprop/orchestrator-core";

export type TailRead = {
  text: string;
  truncated: boolean;
};

export type TaskCommandSummary = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  name?: string;
  runtime: string;
  model?: string;
  status: TaskStatus;
  state?: TaskDisplayState;
  active: boolean;
  actionable: boolean;
  observationReason?: string;
  exitCode?: number | null;
  stopRequestedAt?: string;
  stopReason?: string;
  stopSignal?: NodeJS.Signals;
  location?: TaskLocation;
  commands: AgentTaskControlTaskCommands;
  stop?: AgentTaskControlStopTarget;
};

export function taskCommandSummary(
  task: AgentTaskRecord,
  taskIds: readonly string[],
  options: { stopArgsSuffix?: readonly string[]; observation?: TaskObservation } = {},
): TaskCommandSummary {
  const id = uniqueIdPrefix(task.taskId, taskIds);
  const observation = options.observation ?? fallbackTaskObservation(task);
  const state = observation.state;
  return {
    schemaVersion: 1,
    id,
    taskId: task.taskId,
    ...(task.name ? { name: task.name } : {}),
    runtime: task.runtime,
    ...(task.model ? { model: task.model } : {}),
    status: task.status,
    ...(state === task.status ? {} : { state }),
    active: observation.active,
    actionable: observation.actionable,
    ...(observation.reason && state !== task.status
      ? { observationReason: observation.reason }
      : {}),
    ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
    ...(task.stopRequestedAt ? { stopRequestedAt: task.stopRequestedAt } : {}),
    ...(task.stopReason ? { stopReason: task.stopReason } : {}),
    ...(task.stopSignal ? { stopSignal: task.stopSignal } : {}),
    ...(task.location ? { location: task.location } : {}),
    commands: taskControlCommands(id, options.stopArgsSuffix ?? []),
    ...(observation.actionable
      ? { stop: taskStopTarget(task, id, options.stopArgsSuffix ?? []) }
      : {}),
  };
}

function fallbackTaskObservation(task: AgentTaskRecord): TaskObservation {
  const state = taskDisplayState(task);
  const active = !isTerminalTaskStatus(task.status);
  return {
    status: task.status,
    state,
    active,
    actionable: active,
    checkedAt: new Date().toISOString(),
  };
}

function taskStopTarget(
  task: AgentTaskRecord,
  id: string,
  argsSuffix: readonly string[],
): AgentTaskControlStopTarget {
  if (task.runtime === "orchestrator") {
    return {
      kind: "parent",
      id,
      taskId: task.taskId,
      args: ["interrupt", id, "--children", "--json", "--compact", ...argsSuffix],
    };
  }

  return {
    kind: "task",
    id,
    taskId: task.taskId,
    args: ["interrupt", id, "--json", "--compact", ...argsSuffix],
  };
}

export function taskLogsJsonPayload(input: {
  task: AgentTaskRecord;
  taskIds: readonly string[];
  stream: LogStream;
  maxBytes: number;
  stdout: TailRead;
  stderr: TailRead;
  stopArgsSuffix?: readonly string[];
  observation?: TaskObservation;
}): TaskCommandSummary & {
  stream: LogStream;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutTruncatedByReadLimit: boolean;
  stderrTruncatedByReadLimit: boolean;
  stdoutTruncatedByCaptureLimit: boolean;
  stderrTruncatedByCaptureLimit: boolean;
  maxBytes: number;
  captureMaxBytes?: number;
} {
  const { task, stdout, stderr } = input;

  return {
    ...taskCommandSummary(task, input.taskIds, {
      stopArgsSuffix: input.stopArgsSuffix,
      observation: input.observation,
    }),
    stream: input.stream,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated || (task.outputCapture?.stdoutTruncated ?? false),
    stderrTruncated: stderr.truncated || (task.outputCapture?.stderrTruncated ?? false),
    stdoutTruncatedByReadLimit: stdout.truncated,
    stderrTruncatedByReadLimit: stderr.truncated,
    stdoutTruncatedByCaptureLimit: task.outputCapture?.stdoutTruncated ?? false,
    stderrTruncatedByCaptureLimit: task.outputCapture?.stderrTruncated ?? false,
    maxBytes: input.maxBytes,
    ...(task.outputCapture?.stdoutTruncated || task.outputCapture?.stderrTruncated
      ? { captureMaxBytes: task.outputCapture.maxBytes }
      : {}),
  };
}

export function taskEventsJsonPayload(input: {
  task: AgentTaskRecord;
  taskIds: readonly string[];
  events: readonly TaskEvent[];
  agentOnly: boolean;
  maxBytes: number;
  eventsTruncated: boolean;
  stopArgsSuffix?: readonly string[];
  observation?: TaskObservation;
}): TaskCommandSummary & {
  agentOnly: boolean;
  count: number;
  events: readonly TaskEvent[];
  eventsTruncated: boolean;
  eventsTruncatedByReadLimit: boolean;
  maxBytes: number;
} {
  return {
    ...taskCommandSummary(input.task, input.taskIds, {
      stopArgsSuffix: input.stopArgsSuffix,
      observation: input.observation,
    }),
    agentOnly: input.agentOnly,
    count: input.events.length,
    events: input.events,
    eventsTruncated: input.eventsTruncated,
    eventsTruncatedByReadLimit: input.eventsTruncated,
    maxBytes: input.maxBytes,
  };
}

export type InterruptTaskSummary = {
  taskId: string;
  id: string;
  name: string;
  runtime: string;
  status: TaskStatus;
  state?: TaskDisplayState;
  error?: string;
  stopRequestedAt?: string;
  stopReason?: string;
  stopSignal?: NodeJS.Signals;
};

export function summarizeInterruptTasksResult(
  result: InterruptTasksResult,
  aliasTaskIds: readonly string[],
): InterruptTasksJsonSummary {
  const taskIds = [
    ...aliasTaskIds,
    ...result.interrupted.map((task) => task.taskId),
    ...result.skipped.map((skipped) => skipped.task.taskId),
    ...result.failed.map((failed) => failed.taskId),
  ];
  const aliases = new Map(taskIds.map((taskId) => [taskId, uniqueIdPrefix(taskId, taskIds)]));

  return {
    schemaVersion: 1,
    ok: result.failed.length === 0,
    target: result.target,
    summary: {
      interrupted: result.interrupted.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    },
    interrupted: result.interrupted.map((task) => summarizeInterruptTask(task, aliases)),
    skipped: result.skipped.map((skipped) => ({
      task: summarizeInterruptTask(
        skipped.task,
        aliases,
        skipped.reason === "terminal" ? undefined : skipped.reason,
      ),
      reason: skipped.reason,
    })),
    failed: result.failed.map((failed) => ({
      ...failed,
      id: aliases.get(failed.taskId) ?? shortId(failed.taskId),
    })),
  };
}

export type InterruptTasksJsonSummary = {
  schemaVersion: 1;
  ok: boolean;
  target: InterruptTasksTarget;
  summary: {
    interrupted: number;
    skipped: number;
    failed: number;
  };
  interrupted: InterruptTaskSummary[];
  skipped: Array<{ task: InterruptTaskSummary; reason: string }>;
  failed: Array<{ taskId: string; id: string; error: string }>;
};

export function compactInterruptTasksResult(summary: InterruptTasksJsonSummary): {
  schemaVersion: 1;
  ok: boolean;
  target: InterruptTasksTarget;
  summary: InterruptTasksJsonSummary["summary"];
  failed?: InterruptTasksJsonSummary["failed"];
} {
  return {
    schemaVersion: summary.schemaVersion,
    ok: summary.ok,
    target: summary.target,
    summary: summary.summary,
    ...(summary.failed.length > 0 ? { failed: summary.failed } : {}),
  };
}

function summarizeInterruptTask(
  task: AgentTaskRecord,
  aliases: ReadonlyMap<string, string>,
  stateOverride?: TaskDisplayState,
): InterruptTaskSummary {
  const state = stateOverride ?? taskDisplayState(task);
  return {
    taskId: task.taskId,
    id: aliases.get(task.taskId) ?? shortId(task.taskId),
    name: task.name ?? task.taskId,
    runtime: task.runtime,
    status: task.status,
    ...(state === task.status ? {} : { state }),
    ...(task.error ? { error: task.error } : {}),
    ...(task.stopRequestedAt ? { stopRequestedAt: task.stopRequestedAt } : {}),
    ...(task.stopReason ? { stopReason: task.stopReason } : {}),
    ...(task.stopSignal ? { stopSignal: task.stopSignal } : {}),
  };
}

function shortId(value: string): string {
  return value.slice(0, 8);
}
