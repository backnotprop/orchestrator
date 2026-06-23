import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TASK_STATUSES } from "@backnotprop/orchestrator-core";
import type { TaskStatus } from "@backnotprop/orchestrator-core";
import { CliError } from "../cli-errors.ts";

export type CommonOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
};

export function defaultCommonOptions(): CommonOptions {
  return {
    workspaceRoot: resolveDefaultWorkspaceRoot(process.cwd()),
    json: false,
  };
}

export function resolveDefaultWorkspaceRoot(cwd: string): string {
  const resolved = resolve(cwd);
  return findNearestGitRoot(resolved) ?? resolved;
}

export function findNearestGitRoot(start: string): string | undefined {
  let current = start;
  while (true) {
    if (existsSync(resolve(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function requireValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new CliError(`${option} requires a value.`, {
      reason: "missing_option_value",
      input: option,
      hint: `Pass a value after ${option}.`,
    });
  }
  return value;
}

export function parseIntegerOption(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(`${option} must be a positive integer.`, {
      reason: "invalid_option_value",
      input: value,
      hint: `Pass ${option} as a positive integer.`,
    });
  }
  return parsed;
}

export function parseTaskStatus(value: string, option: string): TaskStatus {
  if ((TASK_STATUSES as readonly string[]).includes(value)) {
    return value as TaskStatus;
  }

  throw new CliError(`${option} must be one of: ${TASK_STATUSES.join(", ")}.`, {
    reason: "invalid_option_value",
    input: value,
    hint: `Use ${option} with one of: ${TASK_STATUSES.join(", ")}.`,
  });
}

export function parseTaskName(value: string): string {
  const name = value.replace(/\s+/g, " ").trim();
  if (!name) {
    throw new CliError("--name must not be empty.", {
      reason: "invalid_option_value",
      input: "--name",
      hint: "Pass a non-empty task name or omit --name.",
    });
  }
  return name;
}
