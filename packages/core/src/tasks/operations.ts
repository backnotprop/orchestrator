import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { listTasks, taskCwd, taskWorkspaceRoot } from "./store.ts";
import { readTaskEvents } from "./readers.ts";
import { UNGROUPED_GROUP_ID, taskGroupId, uniqueIdPrefix } from "./groups.ts";
import { isTerminalTaskStatus } from "./types.ts";
import { normalizeTaskUsage, selectTaskUsage, sumTaskUsage, usageWithUpdatedAt } from "./usage.ts";
import { DEFAULT_WAIT_TIMEOUT_MS } from "./wait.ts";
import type {
  AgentTaskRecord,
  TaskEvent,
  TaskLocation,
  TaskStatus,
  TaskStoreOptions,
  TaskUsage,
} from "./types.ts";

export type AgentTaskPsInput = TaskStoreOptions & {
  status?: TaskStatus;
  runtime?: string;
  parentRunId?: string;
  all?: boolean;
  allWorkspaces?: boolean;
  cwd?: string;
  activeOnly?: boolean;
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
  exitCode?: number | null;
  cwd: string;
  workspaceRoot: string;
  workspaceName?: string;
  relativeCwd?: string;
  location?: TaskLocation;
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

export type AgentTaskGroupStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "stopped"
  | "timed_out"
  | "mixed";

export type AgentTaskGroup = {
  groupId: string;
  label: string;
  parentLabel?: string;
  parentRunId?: string;
  parentTaskId?: string;
  parentSessionId?: string;
  status: AgentTaskGroupStatus;
  total: number;
  running: number;
  succeeded: number;
  failed: number;
  stopped: number;
  timedOut: number;
  usage?: TaskUsage;
  rows: AgentTaskRow[];
};

export type AgentTaskPsView = {
  generatedAt: string;
  scope: {
    workspaces: "current" | "all";
    workspaceRoot?: string;
    cwd?: string;
  };
  groups: AgentTaskGroup[];
  rows: AgentTaskRow[];
};

export type AgentTaskControlStopTarget =
  | {
      kind: "task";
      id: string;
      taskId: string;
      args: string[];
    }
  | {
      kind: "parent";
      id: string;
      taskId: string;
      args: string[];
    }
  | {
      kind: "group";
      id: string;
      groupId: string;
      args: string[];
    }
  | {
      kind: "tasks";
      ids: string[];
      args: string[];
    }
  | {
      kind: "active";
      args: string[];
    };

export type AgentTaskControlCommand = {
  args: string[];
};

export type AgentTaskControlTaskCommands = {
  read: AgentTaskControlCommand;
  readPreview: AgentTaskControlCommand;
  wait: AgentTaskControlCommand;
  waitPreview: AgentTaskControlCommand;
  watch: AgentTaskControlCommand;
  agentWatch: AgentTaskControlCommand;
  logs: AgentTaskControlCommand;
  logsPreview: AgentTaskControlCommand;
  events: AgentTaskControlCommand;
  agentEvents: AgentTaskControlCommand;
};

export type AgentTaskControlGroupCommands = {
  ps: AgentTaskControlCommand;
  activePs: AgentTaskControlCommand;
} & AgentTaskControlBatchCommands;

export type AgentTaskControlBatchCommands = {
  read: AgentTaskControlCommand;
  readPreview: AgentTaskControlCommand;
  wait: AgentTaskControlCommand;
  waitPreview: AgentTaskControlCommand;
};

export type AgentTaskControlGroup = {
  id: string;
  groupId: string;
  label: string;
  status: AgentTaskGroupStatus;
  tasks: number;
  active: number;
  failed: number;
  stopped: number;
  timedOut: number;
  tokens?: number;
  commands?: AgentTaskControlGroupCommands;
  stop?: AgentTaskControlStopTarget;
};

export type AgentTaskControlTask = {
  id: string;
  taskId: string;
  groupId: string;
  group: string;
  name: string;
  runtime: string;
  model?: string;
  status: TaskStatus;
  active: boolean;
  exitCode?: number | null;
  tokens?: number;
  last?: string;
  durationMs?: number;
  location?: TaskLocation;
  commands?: AgentTaskControlTaskCommands;
  stop?: AgentTaskControlStopTarget;
};

export type AgentTaskControlView = {
  schemaVersion: 1;
  generatedAt: string;
  scope: AgentTaskPsView["scope"];
  summary: {
    tasks: number;
    active: number;
    done: number;
    failed: number;
    stopped: number;
    timedOut: number;
  };
  commands?: AgentTaskControlBatchCommands;
  stop?: AgentTaskControlStopTarget;
  groups: AgentTaskControlGroup[];
  tasks: AgentTaskControlTask[];
};

const DEFAULT_RECENT_FINISHED_WINDOW_MS = 60 * 60 * 1_000;
const COMPACT_LAST_MAX_LENGTH = 160;
const FAILED_TASK_STDERR_PREVIEW_MAX_BYTES = 4_000;
const SUCCEEDED_TASK_OUTPUT_PREVIEW_MAX_BYTES = 4_000;
export const AGENT_CONTROL_PREVIEW_MAX_BYTES = 16_000;

export async function buildAgentTaskPsView(input: AgentTaskPsInput): Promise<AgentTaskPsView> {
  const now = input.now ?? new Date();
  const tasks = await listTasks({
    workspaceRoot: input.workspaceRoot,
    ...(input.orchestratorDir ? { orchestratorDir: input.orchestratorDir } : {}),
  });
  const groupLabels = groupLabelsFromTasks(tasks);

  const filtered = tasks
    .filter((task) => (input.status ? task.status === input.status : true))
    .filter((task) => (input.runtime ? task.runtime === input.runtime : true))
    .filter((task) => matchesParentFilter(task, input.parentRunId))
    .filter((task) => matchesWorkspaceFilter(task, input))
    .filter((task) => matchesCwdFilter(task, input.cwd))
    .filter((task) => (input.activeOnly ? !isTerminalTaskStatus(task.status) : true))
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
  const taskIds = tasks.map((task) => task.taskId);
  const rowsWithUniqueIds = rows.map((row) => ({
    ...row,
    shortTaskId: uniqueIdPrefix(row.taskId, taskIds),
  }));

  return {
    generatedAt: now.toISOString(),
    scope: {
      workspaces: input.allWorkspaces ? "all" : "current",
      ...(input.allWorkspaces ? {} : { workspaceRoot: resolve(input.workspaceRoot) }),
      ...(input.cwd ? { cwd: resolve(input.cwd) } : {}),
    },
    rows: rowsWithUniqueIds,
    groups: groupRows(rowsWithUniqueIds, groupLabels),
  };
}

export function compactAgentTaskPsView(
  view: AgentTaskPsView,
  options: {
    activeOnly?: boolean;
    brief?: boolean;
    taskIds?: readonly string[];
    groupIds?: readonly string[];
  } = {},
): AgentTaskControlView {
  const taskIds = options.taskIds ?? view.rows.map((row) => row.taskId);
  const groupIds = options.groupIds ?? view.groups.map((group) => group.groupId);
  const taskAliases = new Map(taskIds.map((taskId) => [taskId, uniqueIdPrefix(taskId, taskIds)]));
  const groupAliases = new Map(
    groupIds.map((groupId) => [groupId, compactGroupId(groupId, groupIds)]),
  );
  const groups: AgentTaskControlGroup[] = [];
  const tasks: AgentTaskControlTask[] = [];

  for (const group of view.groups) {
    const rows = compactRows(group.rows, options);
    if (rows.length === 0) {
      continue;
    }
    const groupAlias = groupAliases.get(group.groupId) ?? group.groupId;
    groups.push(
      compactGroup(
        group,
        rows,
        groupAlias,
        rows.map((row) => taskAliases.get(row.taskId) ?? row.shortTaskId),
        options,
      ),
    );
    tasks.push(
      ...rows.map((row) =>
        compactTask(
          group.groupId,
          rows,
          row,
          groupAlias,
          taskAliases.get(row.taskId) ?? row.shortTaskId,
          options,
        ),
      ),
    );
  }

  const active = tasks.filter((task) => task.active).length;
  const done = tasks.filter((task) => task.status === "succeeded").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const stopped = tasks.filter((task) => task.status === "cancelled").length;
  const timedOut = tasks.filter((task) => task.status === "timed_out").length;

  return {
    schemaVersion: 1,
    generatedAt: view.generatedAt,
    scope: view.scope,
    summary: {
      tasks: tasks.length,
      active,
      done,
      failed,
      stopped,
      timedOut,
    },
    ...(tasks.length > 0
      ? { commands: taskBatchControlCommands(tasks.map((task) => task.id)) }
      : {}),
    ...compactViewStopTarget(tasks, groups),
    groups,
    tasks,
  };
}

function compactViewStopTarget(
  tasks: readonly AgentTaskControlTask[],
  groups: readonly AgentTaskControlGroup[],
): Pick<AgentTaskControlView, "stop"> | Record<string, never> {
  const activeTasks = tasks.filter((task) => task.active);
  if (activeTasks.length === 0) {
    return {};
  }

  if (activeTasks.length === 1 && activeTasks[0]?.stop) {
    return { stop: activeTasks[0].stop };
  }

  if (activeTasks.some((task) => task.runtime === "orchestrator")) {
    const activeGroupIds = [...new Set(activeTasks.map((task) => task.groupId))];
    const groupStop =
      activeGroupIds.length === 1
        ? groups.find((group) => group.groupId === activeGroupIds[0])?.stop
        : undefined;
    return groupStop ? { stop: groupStop } : {};
  }

  const activeIds = activeTasks.map((task) => task.id);
  return {
    stop: {
      kind: "tasks",
      ids: activeIds,
      args: ["interrupt", ...activeIds, "--json", "--compact"],
    },
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
  const usage = selectTaskUsage(eventSummary.usage, task.usage);
  const stderrFailureDetail =
    task.error || eventSummary.error ? undefined : await failedTaskStderrDetail(task);
  const error = task.error ?? eventSummary.error ?? stderrFailureDetail;
  const succeededOutputDetail =
    error || eventSummary.lastMessage ? undefined : await succeededTaskOutputDetail(task);
  const lastEvent =
    eventSummary.error && task.status === "failed" ? "runtime.error" : eventSummary.lastEvent;
  const lastMessage = error ?? eventSummary.lastMessage ?? succeededOutputDetail;
  const taskDurationMs = durationMs(task, input.now);
  const model = taskModel(task);
  const workspaceRoot = taskWorkspaceRoot(task, input.workspaceRoot);
  const cwd = taskCwd(task);
  const relativeCwd = relativeCwdForDisplay(workspaceRoot, cwd);

  return {
    taskId: task.taskId,
    shortTaskId: shortId(task.taskId),
    name: displayTaskName(task),
    status: task.status,
    runtime: task.runtime,
    ...(model ? { model } : {}),
    ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
    cwd,
    workspaceRoot,
    ...(task.location?.kind === "local" && task.location.workspaceName
      ? { workspaceName: task.location.workspaceName }
      : {}),
    ...(relativeCwd ? { relativeCwd } : {}),
    ...(task.location ? { location: task.location } : {}),
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

function compactGroup(
  group: AgentTaskGroup,
  rows: readonly AgentTaskRow[],
  id: string,
  taskIds: readonly string[],
  options: { brief?: boolean },
): AgentTaskControlGroup {
  const active = rows.filter((row) => !isTerminalTaskStatus(row.status)).length;
  const usage = sumTaskUsage(
    rows.map((row) => row.usage).filter((value): value is TaskUsage => Boolean(value)),
  );

  return {
    id,
    groupId: group.groupId,
    label: compactGroupLabel(group),
    status: groupStatus(rows),
    tasks: rows.length,
    active,
    failed: rows.filter((row) => row.status === "failed").length,
    stopped: rows.filter((row) => row.status === "cancelled").length,
    timedOut: rows.filter((row) => row.status === "timed_out").length,
    ...(usage?.totalTokens !== undefined ? { tokens: usage.totalTokens } : {}),
    ...(options.brief ? {} : { commands: groupControlCommands(id, taskIds) }),
    ...(group.groupId !== UNGROUPED_GROUP_ID && active > 0
      ? {
          stop: {
            kind: "group",
            id,
            groupId: group.groupId,
            args: ["interrupt", "--group", id, "--json", "--compact"],
          },
        }
      : {}),
  };
}

export function groupControlCommands(
  id: string,
  taskIds: readonly string[],
  argsSuffix: readonly string[] = [],
): AgentTaskControlGroupCommands {
  return {
    ps: { args: ["ps", "--parent", id, "--json", "--compact", ...argsSuffix] },
    activePs: {
      args: ["ps", "--parent", id, "--json", "--compact", "--active", ...argsSuffix],
    },
    ...taskBatchControlCommands(taskIds, argsSuffix),
  };
}

export function taskBatchControlCommands(
  ids: readonly string[],
  argsSuffix: readonly string[] = [],
): AgentTaskControlBatchCommands {
  return {
    read: { args: ["read", ...ids, "--json", ...argsSuffix] },
    readPreview: {
      args: [
        "read",
        ...ids,
        "--max-bytes",
        String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
        "--json",
        "--compact",
        ...argsSuffix,
      ],
    },
    wait: {
      args: [
        "read",
        ...ids,
        "--wait",
        "--timeout-ms",
        String(DEFAULT_WAIT_TIMEOUT_MS),
        "--json",
        ...argsSuffix,
      ],
    },
    waitPreview: {
      args: [
        "read",
        ...ids,
        "--wait",
        "--timeout-ms",
        String(DEFAULT_WAIT_TIMEOUT_MS),
        "--max-bytes",
        String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
        "--json",
        "--compact",
        ...argsSuffix,
      ],
    },
  };
}

function compactRows(
  rows: readonly AgentTaskRow[],
  options: { activeOnly?: boolean },
): AgentTaskRow[] {
  return options.activeOnly ? rows.filter((row) => !isTerminalTaskStatus(row.status)) : [...rows];
}

function compactTask(
  groupId: string,
  rows: readonly AgentTaskRow[],
  row: AgentTaskRow,
  groupAlias: string,
  id: string,
  options: { brief?: boolean },
): AgentTaskControlTask {
  const active = !isTerminalTaskStatus(row.status);

  return {
    id,
    taskId: row.taskId,
    groupId,
    group: groupAlias,
    name: row.name,
    runtime: row.runtime,
    ...(row.model ? { model: row.model } : {}),
    status: row.status,
    active,
    ...(row.exitCode !== undefined ? { exitCode: row.exitCode } : {}),
    ...(row.usage?.totalTokens !== undefined ? { tokens: row.usage.totalTokens } : {}),
    ...optionalLast(row),
    ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
    ...(row.location ? { location: row.location } : {}),
    ...(options.brief ? {} : { commands: taskControlCommands(id) }),
    ...(active ? { stop: compactTaskStopTarget(row, id) } : {}),
  };
}

export function taskControlCommands(
  id: string,
  argsSuffix: readonly string[] = [],
): AgentTaskControlTaskCommands {
  return {
    read: { args: ["read", id, "--json", ...argsSuffix] },
    readPreview: {
      args: [
        "read",
        id,
        "--max-bytes",
        String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
        "--json",
        "--compact",
        ...argsSuffix,
      ],
    },
    wait: {
      args: [
        "read",
        id,
        "--wait",
        "--timeout-ms",
        String(DEFAULT_WAIT_TIMEOUT_MS),
        "--json",
        ...argsSuffix,
      ],
    },
    waitPreview: {
      args: [
        "read",
        id,
        "--wait",
        "--timeout-ms",
        String(DEFAULT_WAIT_TIMEOUT_MS),
        "--max-bytes",
        String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
        "--json",
        "--compact",
        ...argsSuffix,
      ],
    },
    watch: { args: ["watch", id, "--json", ...argsSuffix] },
    agentWatch: { args: ["watch", id, "--agent-only", "--json", ...argsSuffix] },
    logs: { args: ["logs", id, "--json", "--compact", ...argsSuffix] },
    logsPreview: {
      args: [
        "logs",
        id,
        "--max-bytes",
        String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
        "--json",
        "--compact",
        ...argsSuffix,
      ],
    },
    events: { args: ["events", id, "--json", "--compact", ...argsSuffix] },
    agentEvents: { args: ["events", id, "--agent-only", "--json", "--compact", ...argsSuffix] },
  };
}

function compactTaskStopTarget(row: AgentTaskRow, id: string): AgentTaskControlStopTarget {
  if (row.runtime === "orchestrator") {
    return {
      kind: "parent",
      id,
      taskId: row.taskId,
      args: ["interrupt", id, "--children", "--json", "--compact"],
    };
  }

  return { kind: "task", id, taskId: row.taskId, args: ["interrupt", id, "--json", "--compact"] };
}

function compactGroupId(groupId: string, groupIds: readonly string[]): string {
  return groupId === UNGROUPED_GROUP_ID ? UNGROUPED_GROUP_ID : uniqueIdPrefix(groupId, groupIds);
}

function compactGroupLabel(group: AgentTaskGroup): string {
  const parent = group.rows.find((row) => row.taskId === group.parentTaskId);
  return parent?.name ?? group.parentLabel ?? group.label;
}

function optionalLast(
  row: AgentTaskRow,
): Pick<AgentTaskControlTask, "last"> | Record<string, never> {
  const last = row.error ?? row.lastMessage ?? row.lastEvent;
  return last ? { last: truncateCompactText(last, COMPACT_LAST_MAX_LENGTH) } : {};
}

function truncateCompactText(value: string, maxLength: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLength) {
    return oneLine;
  }
  return `${oneLine.slice(0, maxLength - 3)}...`;
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
        usage = selectTaskUsage(usage, eventUsage);
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

async function failedTaskStderrDetail(task: AgentTaskRecord): Promise<string | undefined> {
  if (task.status !== "failed") {
    return undefined;
  }

  const stderr = sanitizeTail(
    await readTailIfExists(task.paths.stderrLog, FAILED_TASK_STDERR_PREVIEW_MAX_BYTES),
  );
  return stderr || undefined;
}

async function succeededTaskOutputDetail(task: AgentTaskRecord): Promise<string | undefined> {
  if (task.status !== "succeeded") {
    return undefined;
  }

  const output = sanitizeTail(
    await readTailIfExists(task.paths.resultMd, SUCCEEDED_TASK_OUTPUT_PREVIEW_MAX_BYTES),
  );
  return output || undefined;
}

function sanitizeTail(value: string): string {
  return value.split(String.fromCharCode(0)).join("").trim();
}

async function readTailIfExists(path: string, maxBytes: number): Promise<string> {
  try {
    const fileStat = await stat(path);
    const contents = await readFile(path);

    if (fileStat.size <= maxBytes) {
      return contents.toString("utf8");
    }

    return contents.subarray(contents.byteLength - maxBytes).toString("utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return "";
    }
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function groupRows(
  rows: readonly AgentTaskRow[],
  groupLabels: ReadonlyMap<string, string> = new Map(),
): AgentTaskGroup[] {
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
      const parentTaskId = parentTaskIdForGroup(groupId, groupRows);
      const rows = [...groupRows].sort((left, right) => compareRows(left, right, parentTaskId));
      const usage = sumTaskUsage(
        rows.map((row) => row.usage).filter((value): value is TaskUsage => Boolean(value)),
      );
      const status = groupStatus(rows);
      const failed = rows.filter((row) => row.status === "failed").length;
      const stopped = rows.filter((row) => row.status === "cancelled").length;
      const timedOut = rows.filter((row) => row.status === "timed_out").length;
      const succeeded = rows.filter((row) => row.status === "succeeded").length;
      const running = rows.filter((row) => !isTerminalTaskStatus(row.status)).length;
      const parentRunId = rows.find((row) => row.parentRunId)?.parentRunId;
      const parentSessionId = rows.find((row) => row.parentSessionId)?.parentSessionId;

      return {
        groupId,
        label: groupId === UNGROUPED_GROUP_ID ? "ungrouped" : shortId(groupId),
        ...(groupLabels.get(groupId) ? { parentLabel: groupLabels.get(groupId) } : {}),
        ...(parentRunId ? { parentRunId } : {}),
        ...optionalParentTaskId(groupId, rows),
        ...(parentSessionId ? { parentSessionId } : {}),
        status,
        total: rows.length,
        running,
        succeeded,
        failed,
        stopped,
        timedOut,
        ...(usage ? { usage } : {}),
        rows,
      };
    });
}

function groupLabelsFromTasks(tasks: readonly AgentTaskRecord[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const task of tasks) {
    if (task.runtime === "orchestrator") {
      labels.set(task.taskId, displayTaskName(task));
    }
  }
  return labels;
}

function rowGroupId(row: AgentTaskRow): string {
  return taskGroupId(row);
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

export function matchesTaskWorkspace(
  task: Pick<AgentTaskRecord, "location" | "cwd">,
  input: { workspaceRoot: string; allWorkspaces?: boolean },
): boolean {
  if (input.allWorkspaces) {
    return true;
  }
  return taskWorkspaceRoot(task, input.workspaceRoot) === resolve(input.workspaceRoot);
}

function matchesWorkspaceFilter(task: AgentTaskRecord, input: AgentTaskPsInput): boolean {
  return matchesTaskWorkspace(task, input);
}

function matchesCwdFilter(task: AgentTaskRecord, cwd: string | undefined): boolean {
  if (!cwd) {
    return true;
  }
  return taskCwd(task) === resolve(cwd);
}

function relativeCwdForDisplay(workspaceRoot: string, cwd: string): string | undefined {
  const relativeCwd = relative(workspaceRoot, cwd);
  if (!relativeCwd) {
    return ".";
  }
  if (relativeCwd.startsWith("..")) {
    return undefined;
  }
  return relativeCwd;
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
  if (rows.length > 0 && rows.every((row) => row.status === "cancelled")) {
    return "stopped";
  }
  if (rows.length > 0 && rows.every((row) => row.status === "timed_out")) {
    return "timed_out";
  }
  if (rows.length > 0 && rows.every((row) => row.status === "failed")) {
    return "failed";
  }
  return "mixed";
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

function compareRows(a: AgentTaskRow, b: AgentTaskRow, parentTaskId?: string): number {
  if (parentTaskId) {
    if (a.taskId === parentTaskId && b.taskId !== parentTaskId) {
      return -1;
    }
    if (b.taskId === parentTaskId && a.taskId !== parentTaskId) {
      return 1;
    }
  }

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
  if (row.status === "failed" || row.status === "cancelled" || row.status === "timed_out") {
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
  const usage = normalizeTaskUsage(value, { updatedAt });
  return usage ? usageWithUpdatedAt(usage, updatedAt) : undefined;
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
