import { resolve } from "node:path";
import { CliError } from "./cli-errors.ts";

export type LaunchManifestCliDefaults = {
  runtime?: string;
  workspaceRoot: string;
  cwd?: string;
  model?: string;
  outputMode?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type NormalizedLaunchRequest = {
  runtime: string;
  task: string;
  workspaceRoot: string;
  cwd: string;
  name?: string;
  model?: string;
  outputMode?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  labels?: Record<string, string>;
};

type LaunchManifestDefaults = {
  runtime?: string;
  workspaceRoot?: string;
  cwd?: string;
  model?: string;
  outputMode?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  labels?: Record<string, string>;
};

export function parseLaunchManifest(
  raw: string,
  options: { workspaceRoot: string; cliDefaults: LaunchManifestCliDefaults },
): NormalizedLaunchRequest[] {
  const parsed = parseJson(raw);
  const manifest = objectValue(parsed, "manifest");

  const schemaVersion = manifest.schemaVersion;
  if (schemaVersion !== 1) {
    throw manifestError("schemaVersion must be 1.", "schemaVersion");
  }

  const defaults = parseDefaults(manifest.defaults, options.workspaceRoot);
  const tasks = manifest.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw manifestError("tasks must be a non-empty array.", "tasks");
  }

  return tasks.map((task, index) =>
    normalizeTaskRequest(task, {
      index,
      workspaceRoot: options.workspaceRoot,
      cliDefaults: options.cliDefaults,
      defaults,
    }),
  );
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw manifestError(`Invalid launch manifest JSON.${detail}`, "manifest");
  }
}

function parseDefaults(value: unknown, workspaceRoot: string): LaunchManifestDefaults {
  if (value === undefined) {
    return {};
  }

  const defaults = objectValue(value, "defaults");
  return {
    ...optionalString(defaults.runtime, "defaults.runtime", "runtime"),
    ...optionalWorkspace(defaults.workspace, "defaults.workspace", workspaceRoot),
    ...(defaults.cwd !== undefined ? { cwd: pathString(defaults.cwd, "defaults.cwd") } : {}),
    ...optionalString(defaults.model, "defaults.model", "model"),
    ...optionalString(defaults.outputMode, "defaults.outputMode", "outputMode"),
    ...optionalPositiveInteger(defaults.timeoutMs, "defaults.timeoutMs", "timeoutMs"),
    ...optionalPositiveInteger(
      defaults.maxOutputBytes,
      "defaults.maxOutputBytes",
      "maxOutputBytes",
    ),
    ...(defaults.labels !== undefined
      ? { labels: labelsObject(defaults.labels, "defaults.labels") }
      : {}),
  };
}

function normalizeTaskRequest(
  value: unknown,
  options: {
    index: number;
    workspaceRoot: string;
    cliDefaults: LaunchManifestCliDefaults;
    defaults: LaunchManifestDefaults;
  },
): NormalizedLaunchRequest {
  const path = `tasks[${options.index}]`;
  const task = objectValue(value, path);
  const runtime = requiredString(
    task.runtime ?? options.defaults.runtime ?? options.cliDefaults.runtime,
    `${path}.runtime`,
    "runtime",
  );
  const instructions = requiredString(task.task, `${path}.task`, "task");
  const taskWorkspace = optionalWorkspace(
    task.workspace,
    `${path}.workspace`,
    options.workspaceRoot,
  ).workspaceRoot;
  const workspaceRoot =
    taskWorkspace ?? options.defaults.workspaceRoot ?? options.cliDefaults.workspaceRoot;
  const rawCwd = task.cwd ?? options.defaults.cwd ?? options.cliDefaults.cwd;
  const cwd =
    rawCwd === undefined ? workspaceRoot : resolveCwd(rawCwd, `${path}.cwd`, workspaceRoot);
  const name = optionalTaskName(task.name, `${path}.name`);
  const model = optionalString(
    task.model ?? options.defaults.model ?? options.cliDefaults.model,
    `${path}.model`,
    "model",
  );
  const outputMode = optionalString(
    task.outputMode ?? options.defaults.outputMode ?? options.cliDefaults.outputMode,
    `${path}.outputMode`,
    "outputMode",
  );
  const timeoutMs = optionalPositiveInteger(
    task.timeoutMs ?? options.defaults.timeoutMs ?? options.cliDefaults.timeoutMs,
    `${path}.timeoutMs`,
    "timeoutMs",
  );
  const maxOutputBytes = optionalPositiveInteger(
    task.maxOutputBytes ?? options.defaults.maxOutputBytes ?? options.cliDefaults.maxOutputBytes,
    `${path}.maxOutputBytes`,
    "maxOutputBytes",
  );
  const labels = mergeLabels(
    options.defaults.labels,
    task.labels === undefined ? undefined : labelsObject(task.labels, `${path}.labels`),
  );

  return {
    runtime,
    task: instructions,
    workspaceRoot,
    cwd,
    ...(name ? { name } : {}),
    ...(model.model ? { model: model.model } : {}),
    ...(outputMode.outputMode ? { outputMode: outputMode.outputMode } : {}),
    ...(timeoutMs.timeoutMs ? { timeoutMs: timeoutMs.timeoutMs } : {}),
    ...(maxOutputBytes.maxOutputBytes ? { maxOutputBytes: maxOutputBytes.maxOutputBytes } : {}),
    ...(labels ? { labels } : {}),
  };
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw manifestError(`${path} must be an object.`, path);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string, field: string): string {
  const parsed = optionalString(value, path, field)[field];
  if (!parsed) {
    throw manifestError(`${path} is required.`, path);
  }
  return parsed;
}

function optionalString<T extends string>(
  value: unknown,
  path: string,
  field: T,
): Partial<Record<T, string>> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string") {
    throw manifestError(`${path} must be a string.`, path);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw manifestError(`${path} must not be empty.`, path);
  }
  return { [field]: trimmed } as Partial<Record<T, string>>;
}

function optionalTaskName(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw manifestError(`${path} must be a string.`, path);
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    throw manifestError(`${path} must not be empty.`, path);
  }
  return trimmed;
}

function labelsObject(value: unknown, path: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw manifestError(`${path} must be an object.`, path);
  }

  const labels: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const labelKey = key.trim();
    if (!labelKey) {
      throw manifestError(`${path} keys must not be empty.`, path);
    }
    if (typeof rawValue !== "string") {
      throw manifestError(`${path}.${key} must be a string.`, `${path}.${key}`);
    }
    const labelValue = rawValue.trim();
    if (!labelValue) {
      throw manifestError(`${path}.${key} must not be empty.`, `${path}.${key}`);
    }
    labels[labelKey] = labelValue;
  }
  return labels;
}

function mergeLabels(
  defaults: Record<string, string> | undefined,
  taskLabels: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged = { ...(defaults ?? {}), ...(taskLabels ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function optionalWorkspace(
  value: unknown,
  path: string,
  workspaceRoot: string,
): { workspaceRoot?: string } {
  if (value === undefined) {
    return {};
  }
  return { workspaceRoot: resolveCwd(value, path, workspaceRoot) };
}

function resolveCwd(value: unknown, path: string, workspaceRoot: string): string {
  const raw = pathString(value, path);
  return resolve(workspaceRoot, raw);
}

function pathString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw manifestError(`${path} must be a string.`, path);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw manifestError(`${path} must not be empty.`, path);
  }
  return trimmed;
}

function optionalPositiveInteger<T extends string>(
  value: unknown,
  path: string,
  field: T,
): Partial<Record<T, number>> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw manifestError(`${path} must be a positive integer.`, path);
  }
  return { [field]: value } as Partial<Record<T, number>>;
}

function manifestError(message: string, input: string): CliError {
  return new CliError(message, {
    reason: "invalid_launch_manifest",
    input,
    hint: "Use launch -f <manifest.json> --json with schemaVersion: 1 and a non-empty tasks array.",
  });
}
