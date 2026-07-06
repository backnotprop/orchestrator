import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  buildAgentLaunchPlan,
  createConfiguredRuntimeRegistryLoader,
  getRuntimeConfig,
  isSharedCodexAppServerSessionPlan,
  isTerminalTaskStatus as isTerminalStatus,
  launchSharedCodexAppServerSessionTask,
  launchTask,
  listTaskIds,
  observeTaskState,
  taskBatchControlCommands,
  validateLaunchTaskInput,
  type AgentRuntimeId,
  type AgentTaskControlStopTarget,
  type AgentTaskRecord,
  type ConfiguredRuntimeRegistryLoader,
  type LaunchTaskInput,
  type RuntimeRegistry,
} from "@backnotprop/orchestrator-core";
import { launchInBackground } from "../background-task.ts";
import { CliError } from "../cli-errors.ts";
import { jsonLine } from "../json-output.ts";
import {
  parseLaunchManifest,
  type LaunchManifestCliDefaults,
  type NormalizedLaunchRequest,
} from "../launch-manifest.ts";
import {
  briefTaskSummaryJsonPayload,
  printTask,
  printTaskSummaryJson,
  stopArgsSuffix,
} from "../task-output.ts";
import { taskCommandSummary } from "../task-json.ts";
import { workspaceName } from "../task-labels.ts";

export type LaunchOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  runtime?: AgentRuntimeId;
  task?: string;
  file?: string;
  cwd?: string;
  name?: string;
  model?: string;
  outputMode?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  wait: boolean;
  session: boolean;
  compact: boolean;
  brief: boolean;
  allowDisabledRuntime: boolean;
};

export async function commandLaunch(
  options: LaunchOptions,
  context: { cliEntryPath: string },
): Promise<void> {
  const registryLoader = createConfiguredRuntimeRegistryLoader({
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });

  if (options.file) {
    await commandBatchLaunch(options, registryLoader, context);
    return;
  }

  const request = singleLaunchRequest(options);
  const { registry } = await registryLoader.load(request.workspaceRoot);
  const launchInput = buildCliLaunchTaskInput(request, options, registry);

  if (options.wait) {
    const handle = await launchTask(launchInput);
    const completed = await handle.completed;
    await printLaunchTask(completed, options);
    return;
  }

  const task = isSharedCodexAppServerSessionPlan(launchInput.plan)
    ? await launchSharedCodexAppServerSessionTask(launchInput)
    : await launchInBackground(launchInput, context);
  await printLaunchTask(task, options);
}

async function commandBatchLaunch(
  options: LaunchOptions,
  registryLoader: ConfiguredRuntimeRegistryLoader,
  context: { cliEntryPath: string },
): Promise<void> {
  if (!options.file) {
    throw new CliError("launch -f requires a manifest path.");
  }
  if (options.wait) {
    throw new CliError("launch -f does not support --wait yet.", {
      reason: "incompatible_options",
      input: "--wait",
      hint: "Use the returned commands.waitPreview.args to wait for the launched tasks.",
    });
  }

  const raw = await readLaunchManifestInput(options.file);
  const requests = parseLaunchManifest(raw, {
    workspaceRoot: options.workspaceRoot,
    cliDefaults: launchCliDefaults(options),
  });
  const launchInputs = await Promise.all(
    requests.map(async (request) => {
      const { registry } = await registryLoader.load(request.workspaceRoot);
      return buildCliLaunchTaskInput(request, options, registry);
    }),
  );
  const tasks = await Promise.all(
    launchInputs.map((input) =>
      isSharedCodexAppServerSessionPlan(input.plan)
        ? launchSharedCodexAppServerSessionTask(input)
        : launchInBackground(input, context),
    ),
  );
  await printBatchLaunchTasks(tasks, options);
}

function singleLaunchRequest(options: LaunchOptions): NormalizedLaunchRequest {
  if (!options.runtime) {
    throw new CliError("launch requires a runtime.");
  }
  if (!options.task && !options.session) {
    throw new CliError("launch requires task instructions.");
  }
  return {
    runtime: options.runtime,
    ...(options.task ? { task: options.task } : {}),
    ...(options.session ? { session: true } : {}),
    workspaceRoot: options.workspaceRoot,
    cwd: resolveLaunchCwd(options.cwd, options.workspaceRoot),
    ...(options.name ? { name: options.name } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.outputMode ? { outputMode: options.outputMode } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
  };
}

function launchCliDefaults(options: LaunchOptions): LaunchManifestCliDefaults {
  return {
    ...(options.runtime ? { runtime: options.runtime } : {}),
    workspaceRoot: options.workspaceRoot,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.outputMode ? { outputMode: options.outputMode } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
  };
}

function buildCliLaunchTaskInput(
  request: NormalizedLaunchRequest,
  options: LaunchOptions,
  registry: RuntimeRegistry,
): LaunchTaskInput {
  const runtime = getRuntimeConfig(request.runtime, registry);
  const defaultTimeoutMs = request.session ? undefined : runtime?.defaults.timeoutMs;
  const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
  const plan = buildAgentLaunchPlan(
    {
      runtime: request.runtime,
      ...(request.task ? { task: request.task } : {}),
      ...(request.session ? { session: true } : {}),
      cwd: request.cwd,
      model: request.model,
      outputMode: request.outputMode,
      allowDisabledRuntime: options.allowDisabledRuntime,
    },
    registry,
  );

  const launchInput: LaunchTaskInput = {
    workspaceRoot: request.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId: randomUUID(),
    ...(request.name ? { name: request.name } : {}),
    ...(request.model ? { model: request.model } : {}),
    location: {
      kind: "local",
      workspaceRoot: request.workspaceRoot,
      workspaceName: workspaceName(request.workspaceRoot),
      cwd: request.cwd,
    },
    plan,
    ...(request.labels ? { labels: request.labels } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    maxOutputBytes: request.maxOutputBytes ?? runtime?.defaults.maxOutputBytes,
  };
  validateLaunchTaskInput(launchInput);
  return launchInput;
}

async function readLaunchManifestInput(file: string): Promise<string> {
  if (file === "-") {
    return await readStdin();
  }
  return await readFile(resolve(file), "utf8");
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
  }
  return data;
}

async function printLaunchTask(task: AgentTaskRecord, options: LaunchOptions): Promise<void> {
  if (options.json && options.compact) {
    await printTaskSummaryJson(task, options);
    return;
  }

  printTask(task, options.json);
}

async function printBatchLaunchTasks(
  tasks: readonly AgentTaskRecord[],
  options: LaunchOptions,
): Promise<void> {
  if (!options.json) {
    throw new CliError("launch -f requires --json.", {
      reason: "missing_required_option",
      input: "--json",
      hint: "Use launch -f <manifest.json> --json --compact --brief.",
    });
  }

  const storeOptions = {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
  };
  const taskIds = await listTaskIds(storeOptions);
  const suffix = stopArgsSuffix(options);
  const summaries = await Promise.all(
    tasks.map(async (task, index) => {
      const observation = await observeTaskState(storeOptions, task);
      const summary = taskCommandSummary(task, taskIds, { stopArgsSuffix: suffix, observation });
      const rendered = options.compact
        ? briefTaskSummaryJsonPayload(summary, options.brief)
        : summary;
      const { schemaVersion: _schemaVersion, ...withoutSchemaVersion } = rendered;
      return {
        index,
        ...withoutSchemaVersion,
      };
    }),
  );
  const ids = summaries.map((task) => task.id);
  const activeIds = summaries.filter((task) => task.active).map((task) => task.id);
  const stop = batchLaunchStopTarget(summaries, activeIds, suffix);

  process.stdout.write(
    jsonLine(
      {
        schemaVersion: 1,
        summary: batchLaunchSummary(tasks),
        commands: taskBatchControlCommands(ids, suffix),
        ...(stop ? { stop } : {}),
        tasks: summaries,
      },
      options,
    ),
  );
}

function batchLaunchSummary(tasks: readonly AgentTaskRecord[]): {
  requested: number;
  launched: number;
  active: number;
  failed: number;
} {
  return {
    requested: tasks.length,
    launched: tasks.length,
    active: tasks.filter((task) => !isTerminalStatus(task.status)).length,
    failed: tasks.filter((task) => task.status === "failed").length,
  };
}

function batchLaunchStopTarget(
  summaries: readonly { id: string; stop?: AgentTaskControlStopTarget }[],
  activeIds: readonly string[],
  argsSuffix: readonly string[],
): AgentTaskControlStopTarget | undefined {
  if (activeIds.length === 0) {
    return undefined;
  }
  if (activeIds.length === 1) {
    return summaries.find((task) => task.id === activeIds[0])?.stop;
  }
  return {
    kind: "tasks",
    ids: [...activeIds],
    args: ["interrupt", ...activeIds, "--json", "--compact", ...argsSuffix],
  };
}

function resolveLaunchCwd(cwd: string | undefined, workspaceRoot: string): string {
  if (!cwd) {
    return workspaceRoot;
  }
  return isAbsolute(cwd) ? resolve(cwd) : resolve(workspaceRoot, cwd);
}
