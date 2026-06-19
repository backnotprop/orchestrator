import { listTasks } from "./store.ts";
import { readTaskEvents } from "./readers.ts";
import { isTerminalTaskStatus } from "./types.ts";
import type {
  AgentTaskRecord,
  TaskEvent,
  TaskStatus,
  TaskStoreOptions,
  TaskUsage,
} from "./types.ts";

export type AgentTaskPsInput = TaskStoreOptions & {
  status?: TaskStatus;
  runtime?: string;
  parentRunId?: string;
  all?: boolean;
  recentFinishedWindowMs?: number;
  maxEventBytes?: number;
  now?: Date;
};

export type AgentTaskRow = {
  taskId: string;
  shortTaskId: string;
  name: string;
  status: TaskStatus;
  runtime: string;
  model?: string;
  cwd: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  ageMs: number;
  durationMs?: number;
  usage?: TaskUsage;
  lastEvent?: string;
  lastMessage?: string;
  error?: string;
  parentRunId?: string;
  parentTaskId?: string;
  parentSessionId?: string;
  parentToolCallId?: string;
  taskDir: string;
};

export type AgentTaskGroupStatus = "running" | "succeeded" | "failed" | "mixed";

export type AgentTaskGroup = {
  groupId: string;
  label: string;
  parentRunId?: string;
  parentTaskId?: string;
  parentSessionId?: string;
  status: AgentTaskGroupStatus;
  total: number;
  running: number;
  succeeded: number;
  failed: number;
  usage?: TaskUsage;
  rows: AgentTaskRow[];
};

export type AgentTaskPsView = {
  generatedAt: string;
  groups: AgentTaskGroup[];
  rows: AgentTaskRow[];
};

const UNGROUPED_GROUP_ID = "ungrouped";
const DEFAULT_RECENT_FINISHED_WINDOW_MS = 60 * 60 * 1_000;

export async function buildAgentTaskPsView(input: AgentTaskPsInput): Promise<AgentTaskPsView> {
  const now = input.now ?? new Date();
  const tasks = await listTasks({
    workspaceRoot: input.workspaceRoot,
    ...(input.orchestratorDir ? { orchestratorDir: input.orchestratorDir } : {}),
    ...(input.status ? { status: input.status } : {}),
  });

  const filtered = tasks
    .filter((task) => (input.runtime ? task.runtime === input.runtime : true))
    .filter((task) => matchesParentFilter(task, input.parentRunId))
    .filter((task) =>
      input.all
        ? true
        : shouldShowByDefault(
            task,
            now,
            input.recentFinishedWindowMs ?? DEFAULT_RECENT_FINISHED_WINDOW_MS,
          ),
    );

  const rows = (
    await Promise.all(
      filtered.map((task) =>
        buildAgentTaskRow(task, {
          workspaceRoot: input.workspaceRoot,
          ...(input.orchestratorDir ? { orchestratorDir: input.orchestratorDir } : {}),
          maxEventBytes: input.maxEventBytes,
          now,
        }),
      ),
    )
  ).sort(compareRows);

  return {
    generatedAt: now.toISOString(),
    rows,
    groups: groupRows(rows),
  };
}

async function buildAgentTaskRow(
  task: AgentTaskRecord,
  input: TaskStoreOptions & { maxEventBytes?: number; now: Date },
): Promise<AgentTaskRow> {
  const events = await readTaskEvents({
    workspaceRoot: input.workspaceRoot,
    ...(input.orchestratorDir ? { orchestratorDir: input.orchestratorDir } : {}),
    taskId: task.taskId,
    ...(input.maxEventBytes ? { maxBytes: input.maxEventBytes } : {}),
  });
  const eventSummary = summarizeEvents(events);
  const usage = task.usage ?? eventSummary.usage;
  const error = task.error ?? eventSummary.error;
  const lastEvent =
    eventSummary.error && task.status === "failed" ? "runtime.error" : eventSummary.lastEvent;
  const lastMessage = error ?? eventSummary.lastMessage;
  const taskDurationMs = durationMs(task, input.now);
  const model = taskModel(task);

  return {
    taskId: task.taskId,
    shortTaskId: shortId(task.taskId),
    name: displayTaskName(task),
    status: task.status,
    runtime: task.runtime,
    ...(model ? { model } : {}),
    cwd: task.cwd,
    createdAt: task.createdAt,
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ageMs: elapsedMs(task.createdAt, input.now),
    ...(taskDurationMs !== undefined ? { durationMs: taskDurationMs } : {}),
    ...(usage ? { usage } : {}),
    ...(lastEvent ? { lastEvent } : {}),
    ...(lastMessage ? { lastMessage } : {}),
    ...(error ? { error } : {}),
    ...(task.parent?.parentRunId ? { parentRunId: task.parent.parentRunId } : {}),
    ...(task.parent?.parentTaskId ? { parentTaskId: task.parent.parentTaskId } : {}),
    ...(task.parent?.parentSessionId ? { parentSessionId: task.parent.parentSessionId } : {}),
    ...(task.parent?.parentToolCallId ? { parentToolCallId: task.parent.parentToolCallId } : {}),
    taskDir: task.paths.taskDir,
  };
}

function summarizeEvents(events: readonly TaskEvent[]): {
  usage?: TaskUsage;
  lastEvent?: string;
  lastMessage?: string;
  error?: string;
} {
  let usage: TaskUsage | undefined;
  let lastEvent: string | undefined;
  let lastMessage: string | undefined;
  let error: string | undefined;

  for (const event of events) {
    if (event.type === "agent_event") {
      const kind = stringValue(event.data, "kind");
      if (kind) {
        lastEvent = kind;
      }
      const message = stringValue(event.data, "message");
      if (message) {
        lastMessage = message;
      }
      const eventUsage = usageFromUnknown(event.data.usage, event.ts);
      if (eventUsage) {
        usage = eventUsage;
      }
      if (kind === "runtime.error" && message) {
        error = message;
      }
      continue;
    }

    if (event.type !== "stdout" && event.type !== "stderr") {
      lastEvent = event.type;
      const message = stringValue(event.data, "error") ?? stringValue(event.data, "reason");
      if (message) {
        lastMessage = message;
      }
    }
  }

  return {
    ...(usage ? { usage } : {}),
    ...(lastEvent ? { lastEvent } : {}),
    ...(lastMessage ? { lastMessage } : {}),
    ...(error ? { error } : {}),
  };
}

function groupRows(rows: readonly AgentTaskRow[]): AgentTaskGroup[] {
  const groups = new Map<string, AgentTaskRow[]>();
  for (const row of rows) {
    const groupId = rowGroupId(row);
    const group = groups.get(groupId);
    if (group) {
      group.push(row);
    } else {
      groups.set(groupId, [row]);
    }
  }

  return [...groups.entries()]
    .sort(([leftId, leftRows], [rightId, rightRows]) => {
      if (leftId === UNGROUPED_GROUP_ID) {
        return 1;
      }
      if (rightId === UNGROUPED_GROUP_ID) {
        return -1;
      }
      return firstCreatedAt(leftRows).localeCompare(firstCreatedAt(rightRows));
    })
    .map(([groupId, groupRows]) => {
      const rows = [...groupRows].sort(compareRows);
      const usage = sumUsage(
        rows.map((row) => row.usage).filter((value): value is TaskUsage => Boolean(value)),
      );
      const status = groupStatus(rows);
      const failed = rows.filter((row) => isFailedStatus(row.status)).length;
      const succeeded = rows.filter((row) => row.status === "succeeded").length;
      const running = rows.filter((row) => !isTerminalTaskStatus(row.status)).length;
      const parentRunId = rows.find((row) => row.parentRunId)?.parentRunId;
      const parentSessionId = rows.find((row) => row.parentSessionId)?.parentSessionId;

      return {
        groupId,
        label: groupId === UNGROUPED_GROUP_ID ? "ungrouped" : shortId(groupId),
        ...(parentRunId ? { parentRunId } : {}),
        ...optionalParentTaskId(groupId, rows),
        ...(parentSessionId ? { parentSessionId } : {}),
        status,
        total: rows.length,
        running,
        succeeded,
        failed,
        ...(usage ? { usage } : {}),
        rows,
      };
    });
}

function rowGroupId(row: AgentTaskRow): string {
  if (row.runtime === "orchestrator") {
    return row.taskId;
  }
  return row.parentTaskId ?? row.parentRunId ?? UNGROUPED_GROUP_ID;
}

function parentTaskIdForGroup(groupId: string, rows: readonly AgentTaskRow[]): string | undefined {
  if (groupId === UNGROUPED_GROUP_ID) {
    return undefined;
  }
  return rows.find((row) => row.runtime === "orchestrator")?.taskId ?? rows[0]?.parentTaskId;
}

function optionalParentTaskId(
  groupId: string,
  rows: readonly AgentTaskRow[],
): Pick<AgentTaskGroup, "parentTaskId"> | Record<string, never> {
  const parentTaskId = parentTaskIdForGroup(groupId, rows);
  return parentTaskId ? { parentTaskId } : {};
}

function matchesParentFilter(task: AgentTaskRecord, parentRunId: string | undefined): boolean {
  if (!parentRunId) {
    return true;
  }
  if (parentRunId === UNGROUPED_GROUP_ID) {
    return (
      task.runtime !== "orchestrator" && !task.parent?.parentRunId && !task.parent?.parentTaskId
    );
  }
  return (
    task.taskId === parentRunId ||
    task.parent?.parentTaskId === parentRunId ||
    task.parent?.parentRunId === parentRunId
  );
}

function shouldShowByDefault(
  task: AgentTaskRecord,
  now: Date,
  recentFinishedWindowMs: number,
): boolean {
  if (!isTerminalTaskStatus(task.status)) {
    return true;
  }

  const referenceTimestamp = task.finishedAt ?? task.createdAt;
  const referenceMs = Date.parse(referenceTimestamp);
  return Number.isFinite(referenceMs) && now.getTime() - referenceMs <= recentFinishedWindowMs;
}

function groupStatus(rows: readonly AgentTaskRow[]): AgentTaskGroupStatus {
  if (rows.some((row) => !isTerminalTaskStatus(row.status))) {
    return "running";
  }
  if (rows.length > 0 && rows.every((row) => row.status === "succeeded")) {
    return "succeeded";
  }
  if (rows.some((row) => isFailedStatus(row.status))) {
    return rows.every((row) => isFailedStatus(row.status)) ? "failed" : "mixed";
  }
  return "mixed";
}

function isFailedStatus(status: TaskStatus): boolean {
  return status === "failed" || status === "cancelled" || status === "timed_out";
}

function displayTaskName(task: AgentTaskRecord): string {
  return task.name ?? summarizePrompt(task.launchPlan.args.at(-1)) ?? task.taskId;
}

function taskModel(task: AgentTaskRecord): string | undefined {
  if (task.model) {
    return task.model;
  }

  const modelFlagIndex = task.launchPlan.args.indexOf("--model");
  const model = modelFlagIndex >= 0 ? task.launchPlan.args[modelFlagIndex + 1] : undefined;
  return model && !model.startsWith("-") ? model : undefined;
}

function compareRows(a: AgentTaskRow, b: AgentTaskRow): number {
  const priority = rowPriority(a) - rowPriority(b);
  if (priority !== 0) {
    return priority;
  }

  if (!isTerminalTaskStatus(a.status) && !isTerminalTaskStatus(b.status)) {
    return a.createdAt.localeCompare(b.createdAt);
  }

  return comparableFinishedAt(b).localeCompare(comparableFinishedAt(a));
}

function rowPriority(row: AgentTaskRow): number {
  if (!isTerminalTaskStatus(row.status)) {
    return 0;
  }
  if (isFailedStatus(row.status)) {
    return 1;
  }
  return 2;
}

function comparableFinishedAt(row: AgentTaskRow): string {
  return row.finishedAt ?? row.startedAt ?? row.createdAt;
}

function summarizePrompt(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return undefined;
  }
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
}

function usageFromUnknown(value: unknown, updatedAt: string): TaskUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const usage = compactData({
    inputTokens: numberValue(record, "inputTokens"),
    outputTokens: numberValue(record, "outputTokens"),
    cacheReadTokens: numberValue(record, "cacheReadTokens"),
    cacheWriteTokens: numberValue(record, "cacheWriteTokens"),
    totalTokens: numberValue(record, "totalTokens"),
    costUsd: numberValue(record, "costUsd"),
    updatedAt,
  });

  return Object.keys(usage).length > 1 ? (usage as TaskUsage) : undefined;
}

function sumUsage(values: readonly TaskUsage[]): TaskUsage | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const updatedAt = values.reduce(
    (latest, usage) => (usage.updatedAt > latest ? usage.updatedAt : latest),
    values[0]?.updatedAt ?? new Date(0).toISOString(),
  );

  return compactData({
    inputTokens: sumNumbers(values.map((usage) => usage.inputTokens)),
    outputTokens: sumNumbers(values.map((usage) => usage.outputTokens)),
    cacheReadTokens: sumNumbers(values.map((usage) => usage.cacheReadTokens)),
    cacheWriteTokens: sumNumbers(values.map((usage) => usage.cacheWriteTokens)),
    totalTokens: sumNumbers(values.map((usage) => usage.totalTokens)),
    costUsd: sumNumbers(values.map((usage) => usage.costUsd)),
    updatedAt,
  }) as TaskUsage;
}

function sumNumbers(values: readonly (number | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => typeof value === "number");
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : undefined;
}

function durationMs(task: AgentTaskRecord, now: Date): number | undefined {
  if (!task.startedAt) {
    return undefined;
  }
  const end = task.finishedAt ? Date.parse(task.finishedAt) : now.getTime();
  const start = Date.parse(task.startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }
  return Math.max(0, end - start);
}

function elapsedMs(timestamp: string, now: Date): number {
  const started = Date.parse(timestamp);
  return Number.isFinite(started) ? Math.max(0, now.getTime() - started) : 0;
}

function firstCreatedAt(rows: readonly AgentTaskRow[]): string {
  return rows[0]?.createdAt ?? "";
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function compactData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
  );
}
