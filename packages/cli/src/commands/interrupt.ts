import {
  interruptTasks,
  listTaskIds,
  type InterruptTasksResult,
  type InterruptTasksTarget,
} from "@backnotprop/orchestrator-core";
import { CliError } from "../cli-errors.ts";
import { jsonLine } from "../json-output.ts";
import { compactInterruptTasksResult, summarizeInterruptTasksResult } from "../task-json.ts";
import { printTask } from "../task-output.ts";

export type InterruptOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  taskIds: readonly string[];
  parentId?: string;
  groupId?: string;
  active: boolean;
  allWorkspaces: boolean;
  children: boolean;
  taskOnly: boolean;
  yes: boolean;
  reason?: string;
  signal?: NodeJS.Signals;
  compact: boolean;
};

export function validateInterruptOptions(options: InterruptOptions): InterruptOptions {
  if (options.compact && !options.json) {
    throw new CliError("interrupt --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Add --json or omit --compact.",
    });
  }
  const selectors = interruptSelectors({
    taskIds: options.taskIds,
    parentId: options.parentId,
    groupId: options.groupId,
    active: options.active,
  });
  const selectorCount = selectors.length;
  if (selectorCount !== 1) {
    throw interruptSelectorError(selectors);
  }
  if (options.children && options.taskOnly) {
    throw incompatibleInterruptOptionsError("--children,--task-only", [
      "Choose --children to stop a parent task and its children.",
      "Choose --task-only to stop only the selected task.",
    ]);
  }
  if (options.parentId && !options.children) {
    throw new CliError("interrupt --parent requires --children.", {
      reason: "missing_required_option",
      input: "--parent",
      hint: "Use interrupt --parent <id> --children, or use interrupt <id> --task-only to stop only the parent task.",
    });
  }
  if (options.groupId && (options.children || options.taskOnly)) {
    throw incompatibleInterruptOptionsError("--group,--children|--task-only", [
      "Use interrupt --group <id> to stop a group.",
      "Use interrupt <task-id> --children or interrupt <task-id> --task-only for task-specific control.",
    ]);
  }
  if (options.active && (options.children || options.taskOnly)) {
    throw incompatibleInterruptOptionsError("--active,--children|--task-only", [
      "Use interrupt --active to stop all active tasks.",
      "Use a task id with --children or --task-only when targeting one task.",
    ]);
  }
  if (options.active && options.allWorkspaces && !options.yes) {
    throw new CliError("interrupt -A --active requires --yes.", {
      reason: "confirmation_required",
      input: "-A --active",
      hint: "Use interrupt --active --workspace <path> to stop active tasks in one workspace, or add --yes for deliberate all-workspace cleanup.",
    });
  }
  if (options.taskIds.length > 1 && (options.children || options.taskOnly)) {
    throw incompatibleInterruptOptionsError("task-id...,--children|--task-only", [
      "Use interrupt <id> <id> for selected tasks.",
      "Use one task id with --children or --task-only when controlling a parent task.",
    ]);
  }
  if (options.taskOnly && options.taskIds.length !== 1) {
    throw new CliError("interrupt --task-only requires a task id.", {
      reason: "missing_required_argument",
      input: "task-id",
      hint: "Use interrupt <task-id|prefix> --task-only.",
    });
  }

  return options;
}

export async function commandInterrupt(options: InterruptOptions): Promise<number> {
  const result = await interruptTasks({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    target: interruptTargetFromOptions(options),
    allWorkspaces: options.allWorkspaces,
    reason: options.reason,
    signal: options.signal,
  });

  if (!options.json && isSingleTaskInterrupt(options, result)) {
    const task = result.interrupted[0];
    if (task) {
      printTask(task, options.json);
      return result.failed.length > 0 ? 1 : 0;
    }
  }

  await printInterruptTasksResult(result, options);
  if (options.active && result.failed.length === 0) {
    return 0;
  }
  return result.failed.length > 0 ||
    (result.interrupted.length === 0 && result.skipped.length === 0)
    ? 1
    : 0;
}

function interruptSelectors(input: {
  taskIds: readonly string[];
  parentId?: string;
  groupId?: string;
  active: boolean;
}): string[] {
  return [
    ...(input.taskIds.length > 0 ? ["task-id"] : []),
    ...(input.parentId ? ["--parent"] : []),
    ...(input.groupId ? ["--group"] : []),
    ...(input.active ? ["--active"] : []),
  ];
}

function interruptSelectorError(selectors: readonly string[]): CliError {
  const hasMultipleSelectors = selectors.length > 1;
  return new CliError(
    hasMultipleSelectors
      ? "interrupt accepts exactly one selector: task id, --parent, --group, or --active."
      : "interrupt requires one selector: task id, --parent, --group, or --active.",
    {
      reason: hasMultipleSelectors ? "incompatible_options" : "missing_required_argument",
      input: hasMultipleSelectors ? selectors.join(",") : "selector",
      hint: "Use one form: interrupt <task-id|prefix>..., interrupt <task-id|prefix> --children, interrupt --parent <id> --children, interrupt --group <id>, or interrupt --active.",
    },
  );
}

function incompatibleInterruptOptionsError(input: string, hintParts: readonly string[]): CliError {
  return new CliError("interrupt options cannot be combined this way.", {
    reason: "incompatible_options",
    input,
    hint: hintParts.join(" "),
  });
}

function interruptTargetFromOptions(options: InterruptOptions): InterruptTasksTarget {
  if (options.active) {
    return { kind: "active" };
  }
  if (options.groupId) {
    return { kind: "group", groupId: options.groupId };
  }
  if (options.parentId) {
    return { kind: "parent", parentId: options.parentId, children: true };
  }
  if (options.taskIds.length === 0) {
    throw new CliError("interrupt requires exactly one task id, --parent, or --group.");
  }
  if (options.taskIds.length > 1) {
    return {
      kind: "tasks",
      taskIds: options.taskIds,
    };
  }
  return {
    kind: "task",
    taskId: options.taskIds[0] ?? "",
    ...(options.children ? { children: true } : {}),
    ...(options.taskOnly ? { taskOnly: true } : {}),
  };
}

function isSingleTaskInterrupt(options: InterruptOptions, result: InterruptTasksResult): boolean {
  return (
    options.taskIds.length === 1 &&
    !options.children &&
    !options.taskOnly &&
    !options.parentId &&
    !options.groupId &&
    !options.active &&
    result.interrupted.length === 1 &&
    result.skipped.length === 0
  );
}

async function printInterruptTasksResult(
  result: InterruptTasksResult,
  options: InterruptOptions,
): Promise<void> {
  const taskIds = await listTaskIds({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
  });
  const summary = summarizeInterruptTasksResult(result, taskIds);
  if (options.json) {
    const rendered = options.compact ? compactInterruptTasksResult(summary) : summary;
    process.stdout.write(jsonLine(rendered, options));
    return;
  }

  process.stdout.write(`interrupted ${summary.interrupted.length} tasks\n`);
  for (const task of summary.interrupted) {
    process.stdout.write(
      `${"cancelled".padEnd(10)} ${task.id.padEnd(8)} ${task.runtime.padEnd(12)} ${task.name}\n`,
    );
  }
  for (const skipped of summary.skipped) {
    process.stdout.write(
      `${"skipped".padEnd(10)} ${skipped.task.id.padEnd(8)} ${skipped.task.runtime.padEnd(12)} ${skipped.reason}\n`,
    );
  }
  for (const failed of summary.failed) {
    process.stdout.write(`${"failed".padEnd(10)} ${failed.id} ${failed.error}\n`);
  }
}
