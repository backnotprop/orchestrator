#!/usr/bin/env -S node --experimental-strip-types
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_AGENT_RUNTIMES,
  BUILT_IN_AGENT_RUNTIMES,
  buildAgentLaunchPlan,
  getTaskPaths,
  getRuntimeConfig,
  interruptTask,
  launchTask,
  listTasks,
  loadConfiguredRuntimeRegistry,
  readTaskOutput,
  readTaskRecord,
} from "@backnotprop/orchestrator-core";
import type {
  AgentRuntimeId,
  AgentTaskRecord,
  HeadlessAgentRuntimeConfig,
  LaunchTaskInput,
  RuntimeRegistry,
  TaskEvent,
  TaskStatus,
} from "@backnotprop/orchestrator-core";

type CommonOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
};

type LaunchOptions = CommonOptions & {
  runtime: AgentRuntimeId;
  task: string;
  cwd: string;
  name?: string;
  model?: string;
  outputMode?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  wait: boolean;
  allowDisabledRuntime: boolean;
  allowedShellCommands?: readonly string[];
};

type ListOptions = CommonOptions & {
  status?: TaskStatus;
};

type ReadOptions = CommonOptions & {
  taskId: string;
  maxBytes?: number;
};

type LogStream = "stdout" | "stderr" | "all";

type LogsOptions = CommonOptions & {
  taskId: string;
  stream: LogStream;
  maxBytes?: number;
  follow: boolean;
};

type EventsOptions = CommonOptions & {
  taskId: string;
  maxBytes?: number;
  agentOnly: boolean;
};

type WatchOptions = CommonOptions & {
  taskId: string;
  intervalMs: number;
};

type InterruptOptions = CommonOptions & {
  taskId: string;
  reason?: string;
  signal?: NodeJS.Signals;
};

type HelpOptions = {
  workspaceRoot: string;
  configPath?: string;
  json: boolean;
};

type CliHelpDocument = {
  schemaVersion: 1;
  purpose: string;
  agentInstructions: readonly string[];
  runtimes: readonly {
    id: string;
    displayName: string;
    enabled: boolean;
    executable: string;
    baseArgs: readonly string[];
    modelFlag?: string;
    defaultOutputMode?: string;
    outputModes: readonly string[];
    structuredEvents: boolean;
    resumeSupported: boolean;
  }[];
  commands: readonly {
    name: string;
    usage: string;
    semantics: string;
    options: readonly string[];
  }[];
  workflows: readonly {
    name: string;
    steps: readonly string[];
  }[];
  examples: readonly string[];
};

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case "launch":
        await commandLaunch(parseLaunchOptions(rest));
        return 0;
      case "list":
        await commandList(parseListOptions(rest));
        return 0;
      case "read":
        await commandRead(parseReadOptions(rest));
        return 0;
      case "logs":
        await commandLogs(parseLogsOptions(rest));
        return 0;
      case "events":
        await commandEvents(parseEventsOptions(rest));
        return 0;
      case "watch":
        await commandWatch(parseWatchOptions(rest));
        return 0;
      case "interrupt":
        await commandInterrupt(parseInterruptOptions(rest));
        return 0;
      case "__run-task":
        await commandRunTask(parseInternalRunTaskOptions(rest));
        return 0;
      case undefined:
      case "-h":
      case "--help":
      case "help":
        await commandHelp(parseHelpOptions(rest));
        return command ? 0 : 1;
      default:
        throw new CliError(`Unknown command "${command}".\n\n${buildCliHelpText()}`);
    }
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

async function commandHelp(options: HelpOptions): Promise<void> {
  const { registry } = await loadConfiguredRuntimeRegistry({
    workspaceRoot: options.workspaceRoot,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(buildCliHelpDocument(registry), null, 2)}\n`);
    return;
  }

  process.stdout.write(buildCliHelpText(registry));
}

async function commandLaunch(options: LaunchOptions): Promise<void> {
  const { registry } = await loadConfiguredRuntimeRegistry({
    workspaceRoot: options.workspaceRoot,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });
  const runtime = getRuntimeConfig(options.runtime, registry);
  const plan = buildAgentLaunchPlan(
    {
      runtime: options.runtime,
      task: options.task,
      cwd: options.cwd,
      model: options.model,
      outputMode: options.outputMode,
      allowDisabledRuntime: options.allowDisabledRuntime,
    },
    registry,
  );

  const launchInput: LaunchTaskInput = {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId: randomUUID(),
    ...(options.name ? { name: options.name } : {}),
    plan,
    timeoutMs: options.timeoutMs ?? runtime?.defaults.timeoutMs,
    maxOutputBytes: options.maxOutputBytes ?? runtime?.defaults.maxOutputBytes,
    allowedShellCommands: options.allowedShellCommands,
  };

  if (options.wait) {
    const handle = await launchTask(launchInput);
    const completed = await handle.completed;
    printTask(completed, options.json);
    return;
  }

  const task = await launchInBackground(launchInput);
  printTask(task, options.json);
}

function buildCliHelpText(registry: RuntimeRegistry = BUILT_IN_AGENT_RUNTIMES): string {
  const runtimeLines = buildCliHelpDocument(registry)
    .runtimes.map((runtime) => {
      const outputModes =
        runtime.outputModes.length > 0 ? runtime.outputModes.join("|") : "default-only";
      const model = runtime.modelFlag ? `model: ${runtime.modelFlag} <model>` : "model: none";
      const state = runtime.enabled ? "enabled" : "disabled";
      return `  ${runtime.id.padEnd(12)} ${state.padEnd(8)} ${runtime.executable} ${runtime.baseArgs.join(" ")} | ${model} | output: ${outputModes}`;
    })
    .join("\n");

  return `Orchestrator CLI
Run and supervise headless coding agents.

Usage:
  orchestrator launch <runtime> [--name <name>] [--model <model>] [--cwd <path>] [--wait] "<task>"
  orchestrator list [--status <status>]
  orchestrator read <task-id> [--max-bytes <bytes>]
  orchestrator logs <task-id> [--stream stdout|stderr|all] [--max-bytes <bytes>] [--follow]
  orchestrator events <task-id> [--agent-only] [--max-bytes <bytes>]
  orchestrator watch <task-id> [--interval-ms <ms>]
  orchestrator interrupt <task-id> [--reason <text>]
  orchestrator help [--json]

Agent instructions:
  1. Treat launch as a background job by default. Capture taskId from stdout.
  2. Prefer --json for list/launch/events when another program will parse the result.
  3. Use watch to follow one task live.
  4. Use read for the final answer.
  5. Use logs for raw stdout/stderr and events for the task timeline.
  6. Use interrupt to cancel a running agent. Cancellation targets the process group.
  7. Model values are passed through to the provider CLI; aliases are not normalized yet.

Common options:
  --workspace <path>          Workspace root. Defaults to the current directory.
  --orchestrator-dir <path>   Store directory. Defaults to <workspace>/.orchestrator.
  --config <path>             Extra config file. Defaults also load global and workspace config.
  --json                      Print machine-readable JSON when the command supports it.

Launch options:
  --name <name>               Short label shown in list output.
  --model <model>             Runtime model hint, for example sonnet or gpt-5.4-mini.
  --output-mode <mode>        Adapter-selected output mode.
  --timeout-ms <ms>           Override runtime timeout.
  --max-output-bytes <bytes>  Override captured output cap.
  --wait                      Run in the foreground until the task completes.

Runtime ids:
${runtimeLines}

Examples:
  orchestrator launch claude-code --name "review repo" --model sonnet "review this repo"
  orchestrator launch codex --name "write tests" --model gpt-5.4-mini "write tests for the task store"
  orchestrator list --json
  orchestrator watch <task-id>
  orchestrator read <task-id>
  orchestrator logs <task-id> --stream stderr --follow
  orchestrator events <task-id> --agent-only --json
  orchestrator interrupt <task-id> --reason "stopping stale agent"

Shell test options:
  --allow-disabled-runtime    Permit launching disabled runtimes such as shell.
  --allow-shell-command <cmd> Allow one exact shell command.
`;
}

function buildCliHelpDocument(
  registry: RuntimeRegistry = BUILT_IN_AGENT_RUNTIMES,
): CliHelpDocument {
  const runtimes = orderedRuntimeConfigs(registry);

  return {
    schemaVersion: 1,
    purpose: "Launch and supervise headless coding agents as durable background tasks.",
    agentInstructions: [
      "Use launch to start Claude Code, Codex, or another registered runtime.",
      "Capture taskId from launch output; all inspection and control commands use that id.",
      "Prefer --json for machine-readable command output.",
      "Use read for the final agent answer.",
      "Use logs for raw stdout/stderr and events for the task timeline.",
      "Use watch to follow one task live.",
      "Pass model names exactly as the underlying provider CLI expects; this CLI does not normalize model aliases yet.",
      "Use interrupt to cancel a running task by process group.",
    ],
    runtimes: runtimes.map((runtime) => ({
      id: runtime.id,
      displayName: runtime.displayName,
      enabled: runtime.enabled,
      executable: runtime.launch.executable,
      baseArgs: runtime.launch.baseArgs,
      ...(runtime.launch.modelFlag ? { modelFlag: runtime.launch.modelFlag } : {}),
      ...(runtime.launch.defaultOutputMode
        ? { defaultOutputMode: runtime.launch.defaultOutputMode }
        : {}),
      outputModes: Object.keys(runtime.launch.outputModes ?? {}),
      structuredEvents: runtime.capabilities.supportsStructuredEvents,
      resumeSupported: runtime.capabilities.supportsResume,
    })),
    commands: [
      {
        name: "launch",
        usage:
          'orchestrator launch <runtime> [--name <name>] [--model <model>] [--cwd <path>] [--wait] "<task>"',
        semantics: "Starts one agent task. Background by default; prints task metadata.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--json",
          "--name <name>",
          "--model <model>",
          "--output-mode <mode>",
          "--timeout-ms <ms>",
          "--max-output-bytes <bytes>",
          "--wait",
        ],
      },
      {
        name: "list",
        usage: "orchestrator list [--status <status>] [--json]",
        semantics: "Lists known task records from the workspace task store.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--status <status>",
          "--json",
        ],
      },
      {
        name: "read",
        usage: "orchestrator read <task-id> [--max-bytes <bytes>]",
        semantics:
          "Prints the final normalized answer when available; falls back to stdout tail while running.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--max-bytes <bytes>",
        ],
      },
      {
        name: "logs",
        usage:
          "orchestrator logs <task-id> [--stream stdout|stderr|all] [--max-bytes <bytes>] [--follow]",
        semantics: "Prints raw captured provider stdout/stderr.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--stream stdout|stderr|all",
          "--max-bytes <bytes>",
          "--follow",
          "--json",
        ],
      },
      {
        name: "events",
        usage: "orchestrator events <task-id> [--agent-only] [--max-bytes <bytes>] [--json]",
        semantics: "Prints normalized task and agent events.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--agent-only",
          "--max-bytes <bytes>",
          "--json",
        ],
      },
      {
        name: "watch",
        usage: "orchestrator watch <task-id> [--interval-ms <ms>]",
        semantics: "Streams lifecycle and normalized agent events until the task exits.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--interval-ms <ms>",
          "--json",
        ],
      },
      {
        name: "interrupt",
        usage: "orchestrator interrupt <task-id> [--reason <text>] [--signal <signal>]",
        semantics: "Cancels a running task through the runtime interrupt strategy.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--reason <text>",
          "--signal <signal>",
          "--json",
        ],
      },
    ],
    workflows: [
      {
        name: "start-and-watch",
        steps: [
          'Run launch with a short name, runtime, model, and task: orchestrator launch codex --name "inspect store" --model gpt-5.4-mini --json "task".',
          "Extract taskId from launch output.",
          "Run list to see named tasks.",
          "Run watch <task-id> to follow one task.",
          "Run read <task-id> for the final answer.",
        ],
      },
      {
        name: "debug-agent-output",
        steps: [
          "Run logs <task-id> --follow to watch raw stdout/stderr.",
          "Run events <task-id> --agent-only --json to inspect agent events.",
          "Use interrupt <task-id> --reason <text> when the agent should stop.",
        ],
      },
    ],
    examples: [
      'orchestrator launch claude-code --name "review repo" --model sonnet "review this repo"',
      'orchestrator launch codex --name "write tests" --model gpt-5.4-mini "write tests for the task store"',
      "orchestrator list --json",
      "orchestrator watch <task-id>",
      "orchestrator read <task-id>",
      "orchestrator logs <task-id> --stream stderr --follow",
      "orchestrator events <task-id> --agent-only --json",
      'orchestrator interrupt <task-id> --reason "stopping stale agent"',
    ],
  };
}

function orderedRuntimeConfigs(registry: RuntimeRegistry): HeadlessAgentRuntimeConfig[] {
  const builtInIds = new Set<string>(ALL_AGENT_RUNTIMES);
  const builtIn = ALL_AGENT_RUNTIMES.map((runtimeId) => registry[runtimeId]).filter(
    (runtime): runtime is HeadlessAgentRuntimeConfig => Boolean(runtime),
  );
  const custom = Object.values(registry)
    .filter((runtime): runtime is HeadlessAgentRuntimeConfig => Boolean(runtime))
    .filter((runtime) => !builtInIds.has(runtime.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return [...builtIn, ...custom];
}

async function commandList(options: ListOptions): Promise<void> {
  const { registry } = await loadConfiguredRuntimeRegistry({
    workspaceRoot: options.workspaceRoot,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });
  const tasks = await listTasks({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    status: options.status,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
    return;
  }

  if (tasks.length === 0) {
    process.stdout.write("No tasks.\n");
    return;
  }

  const nowMs = Date.now();
  for (const task of tasks) {
    process.stdout.write(formatTaskListLine(task, nowMs, registry));
  }
}

async function commandRead(options: ReadOptions): Promise<void> {
  const task = await readTaskRecord(
    {
      workspaceRoot: options.workspaceRoot,
      ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    },
    options.taskId,
  );
  const output = await readTaskOutput({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId: options.taskId,
    maxBytes: options.maxBytes,
  });

  if (output.length > 0) {
    process.stdout.write(output);
    return;
  }

  if (!isTerminalStatus(task.status)) {
    const stdout = await readTail(task.paths.stdoutLog, options.maxBytes ?? 200_000);
    if (stdout.length > 0) {
      process.stdout.write(stdout);
      return;
    }

    process.stderr.write(`No output yet; task ${task.taskId} is ${task.status}.\n`);
    return;
  }

  process.stdout.write(output);
}

async function commandLogs(options: LogsOptions): Promise<void> {
  const task = await readTaskRecord(
    {
      workspaceRoot: options.workspaceRoot,
      ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    },
    options.taskId,
  );
  const maxBytes = options.maxBytes ?? 200_000;

  if (options.follow) {
    if (options.json) {
      throw new CliError("logs --follow cannot be combined with --json.");
    }
    await followLogs(task, options, maxBytes);
    return;
  }

  const stdout =
    options.stream === "stderr" ? "" : await readTailIfExists(task.paths.stdoutLog, maxBytes);
  const stderr =
    options.stream === "stdout" ? "" : await readTailIfExists(task.paths.stderrLog, maxBytes);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ taskId: task.taskId, stdout, stderr }, null, 2)}\n`);
    return;
  }

  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
}

async function followLogs(
  task: AgentTaskRecord,
  options: LogsOptions,
  maxBytes: number,
): Promise<void> {
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
    const current = await readTaskRecord(
      {
        workspaceRoot: options.workspaceRoot,
        ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
      },
      options.taskId,
    );

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

async function commandEvents(options: EventsOptions): Promise<void> {
  const task = await readTaskRecord(
    {
      workspaceRoot: options.workspaceRoot,
      ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    },
    options.taskId,
  );
  const raw = await readTailIfExists(task.paths.eventsJsonl, options.maxBytes ?? 500_000);
  const lines = raw.trim() ? raw.trimEnd().split("\n") : [];
  const events = options.agentOnly ? lines.filter((line) => isAgentEventLine(line)) : lines;

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(events.map(parseEventLine).filter(Boolean), null, 2)}\n`,
    );
    return;
  }

  if (events.length > 0) {
    process.stdout.write(`${events.join("\n")}\n`);
  }
}

async function commandWatch(options: WatchOptions): Promise<void> {
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let eventsOffset = 0;
  let eventRemainder = "";

  while (true) {
    const task = await readTaskRecord(
      {
        workspaceRoot: options.workspaceRoot,
        ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
      },
      options.taskId,
    );

    const eventsRead = await readNewFileText(task.paths.eventsJsonl, eventsOffset);
    eventsOffset = eventsRead.offset;
    if (eventsRead.text) {
      const rendered = renderWatchEvents(eventsRead.text, eventRemainder, options.json);
      eventRemainder = rendered.remainder;
      if (rendered.output) {
        process.stdout.write(rendered.output);
      }
    }

    if (task.launchPlan.outputTransport.kind !== "jsonl_events") {
      const stdoutRead = await readNewFileText(task.paths.stdoutLog, stdoutOffset);
      stdoutOffset = stdoutRead.offset;
      if (stdoutRead.text) {
        process.stdout.write(stdoutRead.text);
      }
    } else {
      stdoutOffset = (await readNewFileText(task.paths.stdoutLog, stdoutOffset)).offset;
    }

    const stderrRead = await readNewFileText(task.paths.stderrLog, stderrOffset);
    stderrOffset = stderrRead.offset;
    if (stderrRead.text) {
      process.stderr.write(stderrRead.text);
    }

    if (isTerminalStatus(task.status)) {
      if (eventRemainder.trim()) {
        const rendered = renderWatchEvents("\n", eventRemainder, options.json);
        if (rendered.output) {
          process.stdout.write(rendered.output);
        }
      }
      return;
    }

    await delay(options.intervalMs);
  }
}

async function commandInterrupt(options: InterruptOptions): Promise<void> {
  const task = await interruptTask({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId: options.taskId,
    reason: options.reason,
    signal: options.signal,
  });
  printTask(task, options.json);
}

async function commandRunTask(requestPath: string): Promise<void> {
  const request = JSON.parse(await readFile(requestPath, "utf8")) as LaunchTaskInput;

  try {
    const handle = await launchTask(request);
    await handle.completed;
  } finally {
    await rm(requestPath, { force: true });
  }
}

async function launchInBackground(input: LaunchTaskInput): Promise<AgentTaskRecord> {
  const taskId = input.taskId;
  if (!taskId) {
    throw new CliError("Background launch requires a preallocated task id.");
  }

  const requestPath = await writeRunRequest(input);
  const cliPath = fileURLToPath(import.meta.url);
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", cliPath, "__run-task", requestPath],
    {
      cwd: input.plan.cwd,
      detached: true,
      env: process.env,
      stdio: "ignore",
    },
  );
  child.unref();

  return waitForTaskRecord(input, taskId);
}

async function writeRunRequest(input: LaunchTaskInput): Promise<string> {
  const orchestratorDir = input.orchestratorDir ?? resolve(input.workspaceRoot, ".orchestrator");
  const requestDir = resolve(orchestratorDir, "run-requests");
  await mkdir(requestDir, { recursive: true });

  const requestPath = resolve(requestDir, `${input.taskId}.json`);
  await writeFile(requestPath, `${JSON.stringify(input, null, 2)}\n`);
  return requestPath;
}

async function waitForTaskRecord(input: LaunchTaskInput, taskId: string): Promise<AgentTaskRecord> {
  const paths = getTaskPaths(input, taskId);
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5_000) {
    try {
      await access(paths.taskJson);
      return JSON.parse(await readFile(paths.taskJson, "utf8")) as AgentTaskRecord;
    } catch (error) {
      if (!isMissingFile(error) && !(error instanceof SyntaxError)) {
        throw error;
      }
      await delay(25);
    }
  }

  throw new CliError(`Task supervisor did not initialize task "${taskId}" within 5000ms.`);
}

function parseHelpOptions(args: readonly string[]): HelpOptions {
  let workspaceRoot = process.cwd();
  let configPath: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--workspace":
        workspaceRoot = resolve(requireValue(args, ++index, arg));
        break;
      case "--config":
        configPath = resolve(requireValue(args, ++index, arg));
        break;
      default:
        throw new CliError(`Unknown help option "${arg}".`);
    }
  }

  return {
    workspaceRoot,
    ...(configPath ? { configPath } : {}),
    json,
  };
}

function parseLaunchOptions(args: readonly string[]): LaunchOptions {
  const common = defaultCommonOptions();
  let runtime: string | undefined;
  const taskParts: string[] = [];
  let cwd: string | undefined;
  let name: string | undefined;
  let model: string | undefined;
  let outputMode: string | undefined;
  let timeoutMs: number | undefined;
  let maxOutputBytes: number | undefined;
  let wait = false;
  let allowDisabledRuntime = false;
  const allowedShellCommands: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      taskParts.push(...args.slice(index + 1));
      break;
    }

    if (!runtime && arg && !arg.startsWith("-")) {
      runtime = arg;
      continue;
    }

    switch (arg) {
      case "--workspace":
        common.workspaceRoot = resolve(requireValue(args, ++index, arg));
        break;
      case "--orchestrator-dir":
        common.orchestratorDir = resolve(requireValue(args, ++index, arg));
        break;
      case "--config":
        common.configPath = resolve(requireValue(args, ++index, arg));
        break;
      case "--json":
        common.json = true;
        break;
      case "--cwd":
        cwd = resolve(requireValue(args, ++index, arg));
        break;
      case "--name":
        name = parseTaskName(requireValue(args, ++index, arg));
        break;
      case "--model":
        model = requireValue(args, ++index, arg);
        break;
      case "--output-mode":
        outputMode = requireValue(args, ++index, arg);
        break;
      case "--timeout-ms":
        timeoutMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--max-output-bytes":
        maxOutputBytes = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--wait":
        wait = true;
        break;
      case "--allow-disabled-runtime":
        allowDisabledRuntime = true;
        break;
      case "--allow-shell-command":
        allowedShellCommands.push(requireValue(args, ++index, arg));
        break;
      default:
        if (!arg) {
          break;
        }
        if (arg.startsWith("-")) {
          throw new CliError(`Unknown launch option "${arg}".`);
        }
        taskParts.push(arg);
    }
  }

  if (!runtime) {
    throw new CliError("launch requires a runtime.");
  }

  const task = taskParts.join(" ").trim();
  if (!task) {
    throw new CliError("launch requires task instructions.");
  }

  return {
    ...common,
    runtime,
    task,
    cwd: cwd ?? common.workspaceRoot,
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(outputMode ? { outputMode } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(maxOutputBytes ? { maxOutputBytes } : {}),
    wait,
    allowDisabledRuntime,
    ...(allowedShellCommands.length > 0 ? { allowedShellCommands } : {}),
  };
}

function parseListOptions(args: readonly string[]): ListOptions {
  const common = defaultCommonOptions();
  let status: TaskStatus | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--workspace":
        common.workspaceRoot = resolve(requireValue(args, ++index, arg));
        break;
      case "--orchestrator-dir":
        common.orchestratorDir = resolve(requireValue(args, ++index, arg));
        break;
      case "--config":
        common.configPath = resolve(requireValue(args, ++index, arg));
        break;
      case "--json":
        common.json = true;
        break;
      case "--status":
        status = requireValue(args, ++index, arg) as TaskStatus;
        break;
      default:
        throw new CliError(`Unknown list option "${arg}".`);
    }
  }

  return {
    ...common,
    ...(status ? { status } : {}),
  };
}

function parseReadOptions(args: readonly string[]): ReadOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  let maxBytes: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--workspace":
        common.workspaceRoot = resolve(requireValue(args, ++index, arg));
        break;
      case "--orchestrator-dir":
        common.orchestratorDir = resolve(requireValue(args, ++index, arg));
        break;
      case "--config":
        common.configPath = resolve(requireValue(args, ++index, arg));
        break;
      case "--json":
        common.json = true;
        break;
      case "--max-bytes":
        maxBytes = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      default:
        if (arg?.startsWith("-")) {
          throw new CliError(`Unknown read option "${arg}".`);
        }
        if (taskId) {
          throw new CliError("read accepts exactly one task id.");
        }
        taskId = arg;
    }
  }

  if (!taskId) {
    throw new CliError("read requires a task id.");
  }

  return {
    ...common,
    taskId,
    ...(maxBytes ? { maxBytes } : {}),
  };
}

function parseLogsOptions(args: readonly string[]): LogsOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  let maxBytes: number | undefined;
  let stream: LogStream = "all";
  let follow = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--workspace":
        common.workspaceRoot = resolve(requireValue(args, ++index, arg));
        break;
      case "--orchestrator-dir":
        common.orchestratorDir = resolve(requireValue(args, ++index, arg));
        break;
      case "--config":
        common.configPath = resolve(requireValue(args, ++index, arg));
        break;
      case "--json":
        common.json = true;
        break;
      case "--max-bytes":
        maxBytes = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--stream":
        stream = parseLogStream(requireValue(args, ++index, arg));
        break;
      case "--follow":
      case "-f":
        follow = true;
        break;
      default:
        if (arg?.startsWith("-")) {
          throw new CliError(`Unknown logs option "${arg}".`);
        }
        if (taskId) {
          throw new CliError("logs accepts exactly one task id.");
        }
        taskId = arg;
    }
  }

  if (!taskId) {
    throw new CliError("logs requires a task id.");
  }

  return {
    ...common,
    taskId,
    stream,
    follow,
    ...(maxBytes ? { maxBytes } : {}),
  };
}

function parseEventsOptions(args: readonly string[]): EventsOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  let maxBytes: number | undefined;
  let agentOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--workspace":
        common.workspaceRoot = resolve(requireValue(args, ++index, arg));
        break;
      case "--orchestrator-dir":
        common.orchestratorDir = resolve(requireValue(args, ++index, arg));
        break;
      case "--config":
        common.configPath = resolve(requireValue(args, ++index, arg));
        break;
      case "--json":
        common.json = true;
        break;
      case "--max-bytes":
        maxBytes = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--agent-only":
        agentOnly = true;
        break;
      default:
        if (arg?.startsWith("-")) {
          throw new CliError(`Unknown events option "${arg}".`);
        }
        if (taskId) {
          throw new CliError("events accepts exactly one task id.");
        }
        taskId = arg;
    }
  }

  if (!taskId) {
    throw new CliError("events requires a task id.");
  }

  return {
    ...common,
    taskId,
    agentOnly,
    ...(maxBytes ? { maxBytes } : {}),
  };
}

function parseWatchOptions(args: readonly string[]): WatchOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  let intervalMs = 250;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--workspace":
        common.workspaceRoot = resolve(requireValue(args, ++index, arg));
        break;
      case "--orchestrator-dir":
        common.orchestratorDir = resolve(requireValue(args, ++index, arg));
        break;
      case "--config":
        common.configPath = resolve(requireValue(args, ++index, arg));
        break;
      case "--json":
        common.json = true;
        break;
      case "--interval-ms":
        intervalMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      default:
        if (arg?.startsWith("-")) {
          throw new CliError(`Unknown watch option "${arg}".`);
        }
        if (taskId) {
          throw new CliError("watch accepts exactly one task id.");
        }
        taskId = arg;
    }
  }

  if (!taskId) {
    throw new CliError("watch requires a task id.");
  }

  return {
    ...common,
    taskId,
    intervalMs,
  };
}

function parseInterruptOptions(args: readonly string[]): InterruptOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  let reason: string | undefined;
  let signal: NodeJS.Signals | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--workspace":
        common.workspaceRoot = resolve(requireValue(args, ++index, arg));
        break;
      case "--orchestrator-dir":
        common.orchestratorDir = resolve(requireValue(args, ++index, arg));
        break;
      case "--config":
        common.configPath = resolve(requireValue(args, ++index, arg));
        break;
      case "--json":
        common.json = true;
        break;
      case "--reason":
        reason = requireValue(args, ++index, arg);
        break;
      case "--signal":
        signal = requireValue(args, ++index, arg) as NodeJS.Signals;
        break;
      default:
        if (arg?.startsWith("-")) {
          throw new CliError(`Unknown interrupt option "${arg}".`);
        }
        if (taskId) {
          throw new CliError("interrupt accepts exactly one task id.");
        }
        taskId = arg;
    }
  }

  if (!taskId) {
    throw new CliError("interrupt requires a task id.");
  }

  return {
    ...common,
    taskId,
    ...(reason ? { reason } : {}),
    ...(signal ? { signal } : {}),
  };
}

function parseInternalRunTaskOptions(args: readonly string[]): string {
  const [requestPath, ...extra] = args;
  if (!requestPath || extra.length > 0) {
    throw new CliError("__run-task requires exactly one request path.");
  }
  return requestPath;
}

function defaultCommonOptions(): CommonOptions {
  return {
    workspaceRoot: process.cwd(),
    json: false,
  };
}

function printTask(task: AgentTaskRecord, json: boolean): void {
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

function formatTaskListLine(
  task: AgentTaskRecord,
  nowMs: number,
  registry: RuntimeRegistry,
): string {
  return (
    [
      displayTaskName(task),
      task.status,
      task.runtime,
      taskModel(task, registry),
      formatTaskAge(task.createdAt, nowMs),
      task.taskId,
    ].join("\t") + "\n"
  );
}

function displayTaskName(task: AgentTaskRecord): string {
  const name = task.name ?? summarizeTask(task);
  return formatInline(name || "(unnamed)");
}

function taskModel(task: AgentTaskRecord, registry: RuntimeRegistry): string {
  const runtime = getRuntimeConfig(task.runtime, registry);
  const modelFlag = runtime?.launch.modelFlag;
  if (!modelFlag) {
    return "-";
  }

  const modelFlagIndex = task.launchPlan.args.indexOf(modelFlag);
  const model = modelFlagIndex >= 0 ? task.launchPlan.args[modelFlagIndex + 1] : undefined;
  return model && !model.startsWith("-") ? model : "-";
}

function formatTaskAge(createdAt: string, nowMs: number): string {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) {
    return createdAt;
  }

  const seconds = Math.max(0, Math.floor((nowMs - createdMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

function summarizeTask(task: AgentTaskRecord): string {
  const promptArg = task.launchPlan.args.at(-1);
  if (!promptArg) {
    return "";
  }
  return promptArg.length > 80 ? `${promptArg.slice(0, 77)}...` : promptArg;
}

function requireValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value) {
    throw new CliError(`${option} requires a value.`);
  }
  return value;
}

function parseIntegerOption(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(`${option} must be a positive integer.`);
  }
  return parsed;
}

function parseTaskName(value: string): string {
  const name = value.replace(/\s+/g, " ").trim();
  if (!name) {
    throw new CliError("--name must not be empty.");
  }
  return name;
}

function parseLogStream(value: string): LogStream {
  if (value === "stdout" || value === "stderr" || value === "all") {
    return value;
  }
  throw new CliError("--stream must be one of: stdout, stderr, all.");
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(path);
  const contents = await readFile(path);

  if (fileStat.size <= maxBytes) {
    return contents.toString("utf8");
  }

  return contents.subarray(contents.byteLength - maxBytes).toString("utf8");
}

async function readTailIfExists(path: string, maxBytes: number): Promise<string> {
  try {
    return await readTail(path, maxBytes);
  } catch (error) {
    if (isMissingFile(error)) {
      return "";
    }
    throw error;
  }
}

async function readTailWithOffsetIfExists(
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

async function readNewFileText(
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

function renderWatchEvents(
  text: string,
  remainder: string,
  json: boolean,
): { output: string; remainder: string } {
  const combined = remainder + text;
  const lines = combined.split("\n");
  const nextRemainder = combined.endsWith("\n") ? "" : (lines.pop() ?? "");
  const completeLines = combined.endsWith("\n") ? lines.slice(0, -1) : lines;

  if (json) {
    const output = completeLines
      .filter((line) => line.trim().length > 0)
      .map((line) => `${line}\n`)
      .join("");
    return { output, remainder: nextRemainder };
  }

  const output = completeLines
    .map((line) => parseEventLine(line))
    .filter((event): event is TaskEvent => Boolean(event))
    .map(formatWatchEvent)
    .filter((line): line is string => Boolean(line))
    .join("");

  return { output, remainder: nextRemainder };
}

function formatWatchEvent(event: TaskEvent): string | undefined {
  if (event.type === "agent_event") {
    const kind = eventDataString(event, "kind") ?? "agent_event";
    const label =
      eventDataString(event, "itemType") ??
      eventDataString(event, "toolName") ??
      eventDataString(event, "status");
    const message = eventDataString(event, "message");
    return `${[event.ts, kind, label, message ? formatInline(message) : undefined]
      .filter(Boolean)
      .join("\t")}\n`;
  }

  if (
    event.type === "queued" ||
    event.type === "starting" ||
    event.type === "running" ||
    event.type === "result" ||
    event.type === "completed" ||
    event.type === "failed" ||
    event.type === "cancelled" ||
    event.type === "timed_out" ||
    event.type === "interrupt_requested"
  ) {
    const pid = eventDataString(event, "pid");
    return `${[event.ts, event.type, pid ? `pid=${pid}` : undefined].filter(Boolean).join("\t")}\n`;
  }

  return undefined;
}

function isAgentEventLine(line: string): boolean {
  return parseEventLine(line)?.type === "agent_event";
}

function parseEventLine(line: string): TaskEvent | undefined {
  if (!line.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(line) as TaskEvent;
  } catch {
    return undefined;
  }
}

function eventDataString(event: TaskEvent, key: string): string | undefined {
  const value = event.data[key];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function formatInline(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isTerminalStatus(status: TaskStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out"
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

if (isDirectEntrypoint()) {
  process.exitCode = await main();
}

function isDirectEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
}
