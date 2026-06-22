import type { AgentTaskRecord, TaskParent } from "./types.ts";

export const UNGROUPED_GROUP_ID = "ungrouped";

export type TaskGroupLookupErrorReason = "empty" | "not_found" | "ambiguous";

export class TaskGroupLookupError extends Error {
  readonly reason: TaskGroupLookupErrorReason;
  readonly input: string;
  readonly matches: readonly string[];
  readonly hint: string;

  constructor(input: string, reason: TaskGroupLookupErrorReason, matches: readonly string[] = []) {
    super(taskGroupLookupMessage(input, reason, matches));
    this.name = "TaskGroupLookupError";
    this.reason = reason;
    this.input = input;
    this.matches = matches;
    this.hint = taskGroupLookupHint(reason);
  }
}

export type TaskGroupSource = {
  taskId: string;
  runtime: string;
  parent?: TaskParent;
  parentRunId?: string;
  parentTaskId?: string;
};

export function taskGroupId(task: TaskGroupSource): string {
  if (task.runtime === "orchestrator") {
    return task.taskId;
  }
  return (
    task.parent?.parentTaskId ??
    task.parentTaskId ??
    task.parent?.parentRunId ??
    task.parentRunId ??
    UNGROUPED_GROUP_ID
  );
}

export function childTasksForParent(
  tasks: readonly AgentTaskRecord[],
  parentTaskId: string,
): AgentTaskRecord[] {
  return tasks.filter(
    (task) =>
      task.taskId !== parentTaskId &&
      (task.parent?.parentTaskId === parentTaskId || task.parent?.parentRunId === parentTaskId),
  );
}

export function tasksForGroup(
  tasks: readonly AgentTaskRecord[],
  groupId: string,
): AgentTaskRecord[] {
  return tasks.filter((task) => taskGroupId(task) === groupId);
}

export function resolveTaskGroupId(tasks: readonly AgentTaskRecord[], input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new TaskGroupLookupError(input, "empty");
  }

  const groupIds = [...new Set(tasks.map((task) => taskGroupId(task)))].sort();
  if (groupIds.includes(trimmed)) {
    return trimmed;
  }

  const matches = groupIds.filter((groupId) => groupId.startsWith(trimmed));
  if (matches.length === 1) {
    return matches[0];
  }

  throw new TaskGroupLookupError(
    trimmed,
    matches.length === 0 ? "not_found" : "ambiguous",
    matches,
  );
}

export function uniqueIdPrefix(value: string, values: readonly string[]): string {
  const uniqueValues = [...new Set(values)];
  const minimumLength = Math.min(8, value.length);
  for (let length = minimumLength; length <= value.length; length += 1) {
    const prefix = value.slice(0, length);
    if (uniqueValues.filter((candidate) => candidate.startsWith(prefix)).length === 1) {
      return prefix;
    }
  }
  return value;
}

function taskGroupLookupMessage(
  input: string,
  reason: TaskGroupLookupErrorReason,
  matches: readonly string[],
): string {
  if (reason === "empty") {
    return "Group id must not be empty.";
  }

  if (reason === "ambiguous") {
    return `Group id "${input}" is ambiguous. Matches:\n${matches
      .map((match) => `  ${match}`)
      .join("\n")}`;
  }

  return `Group id "${input}" did not match any group.`;
}

function taskGroupLookupHint(reason: TaskGroupLookupErrorReason): string {
  if (reason === "ambiguous") {
    return "Use one of error.matches exactly. Run orchestrator ps --json --compact --brief for recent groups, ps --json --compact --active --brief for active groups, or orchestrator ps --all --json --compact for history.";
  }

  if (reason === "not_found") {
    return "Run orchestrator ps --json --compact --brief for recent groups, ps --json --compact --active --brief for active groups, or orchestrator ps --all --json --compact for history.";
  }

  return "Pass a group id from ps --json --compact.";
}
