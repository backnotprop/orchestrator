#!/usr/bin/env -S node --experimental-strip-types
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOrchestratorParentPrompt,
  createOrchestratorParentSession,
  createRunStreamSequencer,
  doctorParentAgentConfig,
  normalizeRunStreamError,
  runStreamPayloadsFromParentToolTrace,
  type ParentAgentDoctorReport,
  type RunStreamEvent,
} from "@backnotprop/orchestrator-agent";
import {
  ALL_AGENT_RUNTIMES,
  AGENT_CONTROL_PREVIEW_MAX_BYTES,
  BUILT_IN_AGENT_RUNTIMES,
  buildAgentTaskPsView,
  buildAgentLaunchPlan,
  compactAgentTaskPsView,
  getTaskPaths,
  getRuntimeConfig,
  interruptTasks,
  isTerminalTaskStatus as isTerminalStatus,
  launchTask,
  listTaskIds,
  listTasks,
  loadConfiguredRuntimeRegistry,
  readTaskOutput,
  readTaskRecord,
  resolveTaskId,
  UNGROUPED_GROUP_ID,
  TASK_STATUSES,
  taskBatchControlCommands,
  taskGroupId,
  validateLaunchTaskInput,
  waitForTask,
} from "@backnotprop/orchestrator-core";
import type {
  AgentTaskControlView,
  AgentRuntimeId,
  AgentTaskPsView,
  AgentTaskRecord,
  AgentTaskControlStopTarget,
  HeadlessAgentRuntimeConfig,
  InterruptTasksResult,
  InterruptTasksTarget,
  LaunchTaskInput,
  RuntimeRegistry,
  TaskEvent,
  TaskStatus,
  TaskUsage,
  AgentLaunchPlan,
} from "@backnotprop/orchestrator-core";
import {
  CliError,
  formatError,
  unknownCommandError,
  unknownOptionError,
  wantsJsonError,
} from "./cli-errors.ts";
import { cliErrorJsonWithRecovery } from "./cli-error-recovery.ts";
import { jsonLine } from "./json-output.ts";
import { compactPsViewCommands } from "./ps-view-commands.ts";
import { renderPsView } from "./render-ps.ts";
import { renderRunTraceEvents } from "./render-run-trace.ts";
import { doctorRuntimeAvailability, type RuntimeDoctorCheck } from "./runtime-doctor.ts";
import {
  compactInterruptTasksResult,
  summarizeInterruptTasksResult,
  taskCommandSummary,
  taskEventsJsonPayload,
  taskLogsJsonPayload,
  type TaskCommandSummary,
  type TailRead,
} from "./task-json.ts";
import { countRenderedLines, renderWatchFrame, terminalColumns } from "./terminal-frame.ts";
import { formatInline } from "./terminal-format.ts";

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
  compact: boolean;
  brief: boolean;
  allowDisabledRuntime: boolean;
  allowedShellCommands?: readonly string[];
};

type ListOptions = CommonOptions & {
  status?: TaskStatus;
};

type PsOptions = CommonOptions & {
  status?: TaskStatus;
  runtime?: string;
  parentRunId?: string;
  all: boolean;
  watch: boolean;
  compact: boolean;
  brief: boolean;
  active: boolean;
  intervalMs: number;
};

type ReadOptions = CommonOptions & {
  taskIds: readonly string[];
  maxBytes?: number;
  wait: boolean;
  timeoutMs?: number;
  intervalMs?: number;
  compact: boolean;
};

type LogStream = "stdout" | "stderr" | "all";

type LogsOptions = CommonOptions & {
  taskId: string;
  stream: LogStream;
  maxBytes?: number;
  follow: boolean;
  compact: boolean;
};

type EventsOptions = CommonOptions & {
  taskId: string;
  maxBytes?: number;
  agentOnly: boolean;
  compact: boolean;
};

type WatchOptions = CommonOptions & {
  taskId: string;
  intervalMs: number;
  agentOnly: boolean;
};

type InterruptOptions = CommonOptions & {
  taskIds: readonly string[];
  parentId?: string;
  groupId?: string;
  active: boolean;
  children: boolean;
  taskOnly: boolean;
  reason?: string;
  signal?: NodeJS.Signals;
  compact: boolean;
};

type RunOptions = CommonOptions & {
  request: string;
  agentDir?: string;
  sessionDir?: string;
  name?: string;
  background: boolean;
  compact: boolean;
  brief: boolean;
  traceTools: ParentToolTraceMode;
  streamJson: boolean;
};

type ParentToolTraceMode = "off" | "text" | "jsonl";

type ParentRunTaskRequest = {
  schemaVersion: 1;
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  agentDir?: string;
  sessionDir?: string;
  request: string;
  parentRunId: string;
  parentTaskId: string;
};

type ParentRunResult = {
  sessionId: string;
  output: string;
  modelFallbackMessage?: string;
};

type DoctorOptions = CommonOptions & {
  agentDir?: string;
  sessionDir?: string;
  compact: boolean;
};

type CliDoctorReport = ParentAgentDoctorReport & {
  runtimeSummary: {
    total: number;
    available: number;
    unavailable: number;
    availableIds: string[];
    unavailableIds: string[];
  };
  runtimes: RuntimeDoctorCheck[];
};

type CliCompactDoctorReport = {
  schemaVersion: 1;
  status: CliDoctorReport["status"];
  canRunParentAgent: boolean;
  canLaunchChildAgents: boolean;
  parent: {
    canRun: boolean;
    agentDir: string;
    sessionDir: string;
    piAgentDir?: string;
    run?: {
      source: "configured" | "pi-fallback";
      requestPosition: "last";
      argsPrefix: readonly string[];
      backgroundArgsPrefix: readonly string[];
    };
  };
  runtimeSummary: CliDoctorReport["runtimeSummary"];
  runtimes: readonly {
    id: string;
    available: boolean;
    executable: string;
    path?: string;
    message: string;
  }[];
  fullDoctor: { args: readonly string[] };
};

type HelpOptions = {
  workspaceRoot: string;
  configPath?: string;
  json: boolean;
  compact: boolean;
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

type CliCompactHelpDocument = {
  schemaVersion: 1;
  purpose: string;
  fullHelp: { args: readonly string[] };
  agentQuickStart: readonly string[];
  canLaunchChildAgents: boolean;
  runtimeIds: readonly string[];
  runtimes: readonly {
    id: string;
    displayName: string;
    modelFlag?: string;
    structuredEvents: boolean;
    resumeSupported: boolean;
  }[];
  commands: readonly {
    name: string;
    usage: string;
    semantics: string;
  }[];
  examples: readonly string[];
};

const DEFAULT_READ_MAX_BYTES = 200_000;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const normalizedArgv = normalizeLeadingCommonOptions(argv);
    const [command, ...rest] = normalizedArgv;

    switch (command) {
      case "launch":
        await commandLaunch(parseLaunchOptions(rest));
        return 0;
      case "list":
        await commandList(parseListOptions(rest));
        return 0;
      case "ps":
        await commandPs(parsePsOptions(rest));
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
        return await commandInterrupt(parseInterruptOptions(rest));
      case "run":
        await commandRun(parseRunOptions(rest));
        return 0;
      case "doctor":
        return await commandDoctor(parseDoctorOptions(rest));
      case "__run-task":
        await commandRunTask(parseInternalRunTaskOptions(rest));
        return 0;
      case "__run-parent-task":
        await commandRunParentTask(parseInternalRunTaskOptions(rest));
        return 0;
      case undefined:
      case "-h":
      case "--help":
      case "help":
        await commandHelp(parseHelpOptions(rest));
        return command ? 0 : 1;
      default:
        throw unknownCommandError(String(command), {
          json: wantsJsonError(argv),
          helpText: buildCliHelpText,
        });
    }
  } catch (error) {
    if (wantsJsonError(argv)) {
      process.stderr.write(`${JSON.stringify(cliErrorJsonWithRecovery(error, argv))}\n`);
    } else {
      process.stderr.write(`${formatError(error)}\n`);
    }
    return 1;
  }
}

function normalizeLeadingCommonOptions(argv: readonly string[]): string[] {
  const leading: string[] = [];
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index];

    if (arg === "--json") {
      leading.push(arg);
      index += 1;
      continue;
    }

    if (arg === "--workspace" || arg === "--orchestrator-dir" || arg === "--config") {
      leading.push(arg, requireValue(argv, index + 1, arg));
      index += 2;
      continue;
    }

    break;
  }

  if (leading.length === 0) {
    return [...argv];
  }

  if (index >= argv.length) {
    return ["help", ...leading];
  }

  return [argv[index], ...leading, ...argv.slice(index + 1)];
}

async function commandHelp(options: HelpOptions): Promise<void> {
  const { registry } = await loadConfiguredRuntimeRegistry({
    workspaceRoot: options.workspaceRoot,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });

  if (options.json) {
    const document = buildCliHelpDocument(registry);
    const rendered = options.compact ? compactCliHelpDocument(document, options) : document;
    process.stdout.write(jsonLine(rendered, { compact: options.compact }));
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
    ...(options.model ? { model: options.model } : {}),
    plan,
    timeoutMs: options.timeoutMs ?? runtime?.defaults.timeoutMs,
    maxOutputBytes: options.maxOutputBytes ?? runtime?.defaults.maxOutputBytes,
    allowedShellCommands: options.allowedShellCommands,
  };

  if (options.wait) {
    const handle = await launchTask(launchInput);
    const completed = await handle.completed;
    await printLaunchTask(completed, options);
    return;
  }

  const task = await launchInBackground(launchInput);
  await printLaunchTask(task, options);
}

function buildCliHelpText(registry: RuntimeRegistry = BUILT_IN_AGENT_RUNTIMES): string {
  const help = buildCliHelpDocument(registry);
  const runtimeLines = help.runtimes
    .map((runtime) => {
      const outputModes =
        runtime.outputModes.length > 0 ? runtime.outputModes.join("|") : "default-only";
      const model = runtime.modelFlag ? `model: ${runtime.modelFlag} <model>` : "model: none";
      const state = runtime.enabled ? "enabled" : "disabled";
      return `  ${runtime.id.padEnd(12)} ${state.padEnd(8)} ${runtime.executable} ${runtime.baseArgs.join(" ")} | ${model} | output: ${outputModes}`;
    })
    .join("\n");
  const examples = help.examples.map((example) => `  ${example}`).join("\n");
  const renderedRuntimeLines = runtimeLines || "  none configured";

  return `Orchestrator CLI
Run and supervise headless coding agents.

Usage:
  orchestrator doctor [--agent-dir <path>] [--session-dir <path>] [--json [--compact]]
  orchestrator run [--agent-dir <path>] [--session-dir <path>] [--name <name>] [--background] [--json [--compact [--brief]]] [--trace-tools[=text|jsonl]] [--stream-json] "<request>"
  orchestrator launch <runtime> [--name <name>] [--model <model>] [--cwd <path>] [--wait] [--json [--compact [--brief]]] "<task>"
  orchestrator list [--status <status>] [--json]
  orchestrator ps [--all] [--watch] [--runtime <runtime>] [--status <status>] [--parent <run-id>] [--json [--compact [--active] [--brief]]]
  orchestrator read <task-id|prefix>... [--wait] [--timeout-ms <ms>] [--interval-ms <ms>] [--max-bytes <bytes>] [--json [--compact]]
  orchestrator logs <task-id|prefix> [--stream stdout|stderr|all] [--max-bytes <bytes>] [--follow] [--json [--compact]]
  orchestrator events <task-id|prefix> [--agent-only] [--max-bytes <bytes>] [--json [--compact]]
  orchestrator watch <task-id|prefix> [--agent-only] [--interval-ms <ms>] [--json]
  orchestrator interrupt <task-id|prefix>... [--reason <text>] [--json [--compact]]
  orchestrator interrupt <task-id|prefix> [--children|--task-only] [--reason <text>] [--json [--compact]]
  orchestrator interrupt --parent <task-id|prefix> --children [--reason <text>] [--json [--compact]]
  orchestrator interrupt --group <group-id|prefix> [--reason <text>] [--json [--compact]]
  orchestrator interrupt --active [--reason <text>] [--json [--compact]]
  orchestrator help [--json [--compact]]

Agent instructions:
  1. Use doctor --json --compact before run when parent-agent auth/model setup is uncertain or before launch when runtime availability is uncertain.
  2. In doctor --json, use runtimeSummary.availableIds to choose launchable runtimes quickly.
  3. In doctor --json --compact, parent.canRun means parent.run is available; append the request to parent.run.argsPrefix or parent.run.backgroundArgsPrefix.
  4. Use run when Orchestrator itself should think and coordinate child agents.
  5. Use run --background when the parent agent should be a managed background task.
  6. Use run --trace-tools when you need to see parent tool calls live.
  7. Use run --stream-json when another program needs the full run event stream.
  8. Treat launch as a background job by default. Capture taskId from stdout.
  9. Task commands accept full task ids or unique prefixes shown by ps/list.
  10. Common options like --workspace, --orchestrator-dir, --config, and --json may appear before or after the command.
  11. Prefer launch --json --compact and ps --json --compact for normal agent control.
  12. Use help --json --compact when software needs a smaller command contract.
  13. When --json is present, command errors are JSON on stderr with reason/input/matches/hint and recovery.views.*.args when available.
  14. Use ps for the multi-agent operations view.
  15. Use ps --watch to watch the whole agent system update live.
  16. Use ps --json --compact --active when an agent or script needs active task and stop targets.
  17. Use ps --json --compact --active --brief to scan many running tasks with less JSON.
  18. Use ps --parent <run-id|prefix> --json --compact --brief to inspect one parent run and its children.
  19. If active ps is empty after short work, run views.recent.args from compact ps to recover recent finished tasks and batch read commands.
  20. Use launch --json --compact --brief when starting many tasks and only task id/status/stop is needed.
  21. After starting several tasks, run ps --json --compact --brief and use top-level commands.waitPreview.args to collect the listed set.
  22. When compact JSON returns stop.args, run those portable args to stop exactly the returned task, group, or selected active set.
  23. Compact ps stop.args are scoped to the current view; parent/group stops may include children of that selected run.
  24. When JSON output returns commands.*.args, pass those portable args to orchestrator for read/watch/logs/events follow-up.
  25. Use compact ps top-level commands.waitPreview.args to wait for every listed task with bounded output.
  26. Use compact ps group commands.waitPreview.args to wait for one listed group with bounded output.
  27. Use commands.readPreview, commands.waitPreview, or commands.logsPreview when another agent needs bounded output before deciding whether to fetch more.
  28. Use watch to follow one task live. Use watch --agent-only --json for normalized agent event JSONL.
  29. Use read for final agent answers. Use read <id> <id> --wait --json --compact to build your own multi-task wait call.
  30. If compact read returns active: true, use commands.waitPreview.args to wait with bounded output or commands.readPreview.args to poll again.
  31. If compact batch read times out, use its top-level commands.waitPreview.args to wait again or stop.args to stop still-active work safely.
  32. If compact read returns failed status, use commands.logsPreview.args for bounded raw logs or commands.events.args for the task timeline.
  33. Check outputTruncated/stdoutTruncated/stderrTruncated in JSON output; ByReadLimit means re-read with more bytes can help, ByCaptureLimit means the task was launched with too small a capture cap.
  34. If compact read is truncated by read limit, use commands.read.args to fetch more output.
  35. Use logs --json --compact for a one-line raw stdout/stderr snapshot and events --json --compact for a one-line task timeline.
  36. Use interrupt to cancel running agents. Use interrupt <id> <id> --json --compact to stop a selected subset.
  37. Use --children for parent runs with children.
  38. Use interrupt --active only for deliberate workspace-wide cleanup when every active task in the selected workspace should stop; it is safe when none are active.
  39. Model values are passed through to the provider CLI; aliases are not normalized yet.

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
  --compact                   With --json, print a small launch result for agents/scripts.
  --brief                     With --compact, omit follow-up command bundles.

Ps options:
  --all                       Show full task history instead of hiding old finished tasks.
  --watch                     Refresh the grouped view until interrupted.
  --interval-ms <ms>          Refresh interval for --watch.
  --runtime <runtime>         Filter to one runtime.
  --status <status>           Filter to one task status.
  --parent <run-id|ungrouped> Filter to one parent group.
  --compact                   With --json, print compact task/group control data.
  --active                    With --compact, include only non-terminal tasks.
  --brief                     With --compact, omit repeated follow-up command bundles.

Interrupt options:
  --children                  Stop a parent task and its children.
  --parent <task-id|prefix>   Stop a parent task and children with --children.
  --group <group-id|prefix>   Stop running tasks in one ps group.
  --active                    Stop all active tasks in the selected workspace.
  --task-only                 Stop only the parent task when children are running.
  --reason <text>             Cancellation reason stored on interrupted tasks.
  --signal <signal>           Process signal. Defaults to SIGTERM.
  --compact                   With --json, print counts and failures only.

Run options:
  --agent-dir <path>          Parent AI agent config dir. Defaults to ~/.orchestrator.
  --session-dir <path>        Parent AI agent session dir. Defaults to ~/.orchestrator/sessions.
  --name <name>               Short label for a background parent task.
  --background                Run the parent agent as a managed background task.
  --compact                   With --background --json, print a small task summary.
  --brief                     With --compact, omit follow-up command bundles.
  --trace-tools[=text|jsonl]  Show parent tool calls live on stderr.
  --stream-json               Stream the full parent run as JSONL on stdout.

Doctor options:
  --agent-dir <path>          Parent AI agent config dir to inspect.
  --session-dir <path>        Parent AI agent session dir to inspect.
  --workspace <path>          Workspace whose runtime config should be inspected.
  --config <path>             Extra runtime config file to inspect.
  --compact                   With --json, print a small runtime/readiness report.

Runtime ids:
${renderedRuntimeLines}

Examples:
${examples}

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
    purpose:
      "Run Orchestrator as a parent AI agent or launch and supervise child agents as durable background tasks.",
    agentInstructions: [
      "Use doctor --json --compact before run when parent-agent auth/model setup is uncertain or before launch when runtime availability is uncertain.",
      "In doctor --json, use runtimeSummary.availableIds to choose launchable runtimes quickly.",
      "In doctor --json --compact, parent.canRun means parent.run is available; append the request to parent.run.argsPrefix or parent.run.backgroundArgsPrefix.",
      "Use run when Orchestrator itself should think and coordinate child agents.",
      "Use run --background when the parent agent should run as a managed task.",
      "Use run --trace-tools when you need to see parent tool calls live.",
      "Use run --stream-json when a plugin, script, TUI, or other program needs the full live run stream.",
      "Use launch to start a registered runtime.",
      "Use launch --json --compact when software needs only the new task id and status.",
      "Capture taskId from launch output. Task commands accept the full id or a unique prefix shown by ps/list.",
      "Common options like --workspace, --orchestrator-dir, --config, and --json may appear before or after the command.",
      "Prefer launch --json --compact and ps --json --compact for normal agent control.",
      "Use help --json --compact when software needs a smaller command contract; use help --json for the full contract.",
      "When --json is present, command errors are JSON on stderr with reason/input/matches/hint and recovery.views.*.args when available.",
      "Use ps for the grouped multi-agent operations view. It hides old finished tasks by default.",
      "Use ps --all for full task history.",
      "Use ps --watch to watch the whole agent system update live.",
      "Use ps --json --compact --active when an agent or script needs active task and stop targets.",
      "Use ps --json --compact --active --brief to scan many running tasks with less JSON.",
      "Use ps --parent <run-id|prefix> --json --compact --brief when software needs one parent run and its children.",
      "If active ps is empty after short work, run views.recent.args from compact ps to recover recent finished tasks and batch read commands.",
      "Use launch --json --compact --brief when starting many tasks and only task id/status/stop is needed.",
      "After starting several tasks, run ps --json --compact --brief and use top-level commands.waitPreview.args to collect the listed set.",
      "When JSON output returns stop.args, pass those portable args to orchestrator to stop exactly the returned task, group, or selected active set.",
      "Compact ps stop.args are scoped to the current view; parent/group stops may include children of that selected run.",
      "When JSON output returns commands.*.args, pass those portable args to orchestrator for read/watch/logs/events follow-up.",
      "Use compact ps top-level commands.waitPreview.args to wait for every listed task with bounded output.",
      "Use compact ps group commands.waitPreview.args to wait for one listed group with bounded output.",
      "Use commands.readPreview, commands.waitPreview, or commands.logsPreview when another agent needs bounded output before deciding whether to fetch more.",
      "Use read for final agent answers. Use read <id> <id> --wait --json --compact when software needs to build its own multi-task wait call.",
      "If compact read returns active: true, use commands.waitPreview.args to wait with bounded output or commands.readPreview.args to poll again.",
      "If compact batch read times out, use its top-level commands.waitPreview.args to wait again or stop.args to stop still-active work safely.",
      "If compact read returns failed status, use commands.logsPreview.args for bounded raw logs or commands.events.args for the task timeline.",
      "Check outputTruncated/stdoutTruncated/stderrTruncated in JSON output; ByReadLimit means re-read with more bytes can help, ByCaptureLimit means the task was launched with too small a capture cap.",
      "If compact read is truncated by read limit, use commands.read.args to fetch more output.",
      "Use logs --json --compact for a one-line raw stdout/stderr snapshot and events --json --compact for a one-line task timeline.",
      "Use watch to follow one task live. Use watch --agent-only --json for normalized agent event JSONL.",
      "Pass model names exactly as the underlying provider CLI expects; this CLI does not normalize model aliases yet.",
      "Use interrupt to cancel a running task by process group.",
      "Use interrupt --active --json --compact only for deliberate workspace-wide cleanup when every active task in the selected workspace should stop; it is safe when none are active.",
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
        name: "doctor",
        usage:
          "orchestrator doctor [--agent-dir <path>] [--session-dir <path>] [--json [--compact]]",
        semantics:
          "Checks parent-agent auth/session paths and configured runtime executable availability.",
        options: [
          "--json",
          "--compact",
          "--workspace <path>",
          "--config <path>",
          "--agent-dir <path>",
          "--session-dir <path>",
        ],
      },
      {
        name: "run",
        usage:
          'orchestrator run [--agent-dir <path>] [--session-dir <path>] [--name <name>] [--background] [--json [--compact [--brief]]] [--trace-tools[=text|jsonl]] [--stream-json] "<request>"',
        semantics:
          "Starts the Pi-backed parent AI agent with Orchestrator child-agent tools enabled.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--json",
          "--agent-dir <path>",
          "--session-dir <path>",
          "--name <name>",
          "--background",
          "--compact",
          "--brief",
          "--trace-tools[=text|jsonl]",
          "--stream-json",
        ],
      },
      {
        name: "launch",
        usage:
          'orchestrator launch <runtime> [--name <name>] [--model <model>] [--cwd <path>] [--wait] [--json [--compact [--brief]]] "<task>"',
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
          "--compact",
          "--brief",
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
        name: "ps",
        usage:
          "orchestrator ps [--all] [--watch] [--runtime <runtime>] [--status <status>] [--parent <run-id>] [--json [--compact [--active] [--brief]]]",
        semantics: "Shows grouped agent work across parent runs and ungrouped manual tasks.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--status <status>",
          "--runtime <runtime>",
          "--parent <run-id|ungrouped>",
          "--all",
          "--watch",
          "--interval-ms <ms>",
          "--json",
          "--compact",
          "--active",
          "--brief",
        ],
      },
      {
        name: "read",
        usage:
          "orchestrator read <task-id|prefix>... [--wait] [--timeout-ms <ms>] [--interval-ms <ms>] [--max-bytes <bytes>] [--json [--compact]]",
        semantics:
          "Prints final normalized answers when available; with --json, accepts one or more task ids.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--json",
          "--wait",
          "--timeout-ms <ms>",
          "--interval-ms <ms>",
          "--max-bytes <bytes>",
          "--compact",
        ],
      },
      {
        name: "logs",
        usage:
          "orchestrator logs <task-id|prefix> [--stream stdout|stderr|all] [--max-bytes <bytes>] [--follow] [--json [--compact]]",
        semantics: "Prints raw captured provider stdout/stderr.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--stream stdout|stderr|all",
          "--max-bytes <bytes>",
          "--follow",
          "--json",
          "--compact",
        ],
      },
      {
        name: "events",
        usage:
          "orchestrator events <task-id|prefix> [--agent-only] [--max-bytes <bytes>] [--json [--compact]]",
        semantics: "Prints normalized task and agent events.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--agent-only",
          "--max-bytes <bytes>",
          "--json",
          "--compact",
        ],
      },
      {
        name: "watch",
        usage: "orchestrator watch <task-id|prefix> [--agent-only] [--interval-ms <ms>] [--json]",
        semantics: "Streams lifecycle and normalized agent events until the task exits.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--agent-only",
          "--interval-ms <ms>",
          "--json",
        ],
      },
      {
        name: "interrupt",
        usage:
          "orchestrator interrupt <task-id|prefix>...|--parent <id>|--group <id>|--active [--children|--task-only] [--reason <text>] [--signal <signal>] [--json [--compact]]",
        semantics:
          "Cancels running tasks. Use returned stop.args for scoped cleanup; use --active only when every active task in the selected workspace should stop.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--children",
          "--parent <task-id|prefix>",
          "--group <group-id|prefix>",
          "--active",
          "--task-only",
          "--reason <text>",
          "--signal <signal>",
          "--json",
          "--compact",
        ],
      },
      {
        name: "help",
        usage: "orchestrator help [--json [--compact]]",
        semantics: "Prints human help, the full JSON command contract, or a compact JSON contract.",
        options: ["--workspace <path>", "--config <path>", "--json", "--compact"],
      },
    ],
    workflows: [
      {
        name: "discover-contract",
        steps: [
          "Run help --json --compact when software needs the smaller command contract.",
          "Run help --json when software needs full command options, workflows, and examples.",
          "Use fullHelp.args from compact help to fetch the full contract.",
          "Use runtimeIds from compact help to choose a configured runtime quickly.",
        ],
      },
      {
        name: "parent-agent",
        steps: [
          'Run orchestrator run "figure out what needs to change in this repo" when Orchestrator should coordinate child agents for you.',
          "Add --background when that parent run should be listed and managed like any other task.",
          "Add --trace-tools to run when you need to see live parent tool calls.",
          "Use --stream-json when software needs the complete live parent run stream.",
          "Use ps or ps --watch to see all child tasks created by the parent agent.",
          "Use ps --json --compact --active when software needs active child tasks and stop targets.",
          "Use ps --json --compact --active --brief when software needs to scan many running child tasks without follow-up command bundles.",
          "Use ps --parent <run-id|prefix> --json --compact --brief when software needs only one parent run and its children.",
          "If active ps is empty after short child tasks, run views.recent.args from compact ps to recover recent finished tasks and batch read commands.",
          "After launching several child tasks, use ps --json --compact --brief and top-level commands.waitPreview.args to collect their results.",
          "When JSON output returns stop.args, pass those portable args to orchestrator to stop exactly the returned task, group, or selected active set.",
          "When JSON output returns commands.*.args, pass those portable args to orchestrator for read/watch/logs/events follow-up.",
          "Use compact ps top-level commands.waitPreview.args when software needs to wait for every listed child task.",
          "Use compact ps group commands.waitPreview.args when software needs to wait for only one parent group.",
          "Use watch, read, logs, events, and interrupt with a full task id or unique prefix to inspect or control one child task.",
          "Use read <id> <id> --wait --json --compact when software needs to build its own multi-task wait call.",
          "If compact batch read times out, use its top-level commands.waitPreview.args to wait again or stop.args to stop still-active child work safely.",
          "If compact read returns failed status, use commands.logsPreview.args for bounded raw logs or commands.events.args for the task timeline.",
          "Use interrupt <task-id|prefix> --children when a parent run and its children should stop.",
          "Use interrupt <id> <id> --json --compact to stop a selected subset of tasks.",
          "Use interrupt --group <group-id|prefix> to stop the running tasks in one ps group.",
          "Use interrupt --active only when the parent agent intentionally needs to stop every active task in the selected workspace.",
        ],
      },
      {
        name: "start-and-watch",
        steps: [
          'Run launch with a short name, runtime, model, and task: orchestrator launch codex --name "inspect store" --model gpt-5.4-mini --json --compact "task".',
          "Add --brief to compact launch when starting many tasks and only id/status/stop is needed.",
          "Extract taskId from launch output, or use the short id shown by ps/list when it is unique.",
          "Run list to see named tasks.",
          "Run ps to see grouped agent work.",
          "Run ps --watch to watch the whole workspace update.",
          "Run ps --json --compact --active when another program needs active task and stop targets.",
          "Run ps --json --compact --active --brief to scan many running tasks with less JSON.",
          "Run ps --parent <run-id|prefix> --json --compact --brief to narrow follow-up to one parent run.",
          "If active ps is empty after short work, run views.recent.args from compact ps to recover recent finished tasks.",
          "After starting several tasks, run ps --json --compact --brief and use top-level commands.waitPreview.args to collect the listed set.",
          "If JSON output has stop.args, run orchestrator with those portable args to stop exactly that task, group, or selected active set.",
          "Run interrupt <id> <id> --json --compact to stop a selected subset of tasks.",
          "If JSON output has commands.*.args, run orchestrator with those portable args for follow-up.",
          "Use compact ps top-level commands.waitPreview.args when you need to wait for every listed task.",
          "Use compact ps group commands.waitPreview.args when you need to wait for one listed group.",
          "If compact batch read times out, run its top-level commands.waitPreview.args to retry or stop.args to stop still-active work safely.",
          "Run interrupt --active --json --compact only when the selected workspace should have no active tasks left. It is safe when none are active.",
          "Run watch <task-id|prefix> to follow one task, or watch <task-id|prefix> --agent-only --json for normalized agent event JSONL.",
          "Run read <task-id|prefix> for one final answer, or read <id> <id> --wait --json --compact when software needs to build its own multi-task wait call.",
          "If compact read returns active: true, use commands.waitPreview.args to wait with bounded output or commands.readPreview.args to poll again.",
        ],
      },
      {
        name: "debug-agent-output",
        steps: [
          "Run logs <task-id|prefix> --follow to watch raw stdout/stderr.",
          "Use logs <task-id|prefix> --json --compact for one parseable log snapshot; do not combine --follow with --json.",
          "Use watch <task-id|prefix> --json when software needs parseable live task events.",
          "Run events <task-id|prefix> --agent-only --json --compact to inspect agent events.",
          "Use interrupt <task-id|prefix> --task-only only when a parent should stop but children should continue.",
        ],
      },
    ],
    examples: buildCliExamples(registry),
  };
}

function compactCliHelpDocument(
  document: CliHelpDocument,
  options: Pick<HelpOptions, "workspaceRoot" | "configPath">,
): CliCompactHelpDocument {
  const preferredExamples = new Set([
    "orchestrator doctor",
    "orchestrator ps --json --compact --active --brief",
    "orchestrator ps --parent <run-id|prefix> --json --compact --brief",
    "orchestrator read <task-id|prefix>... --wait --json --compact",
    'orchestrator interrupt <task-id|prefix> <task-id|prefix> --json --compact --reason "selected cleanup"',
  ]);
  const launchExamples = document.examples.filter(
    (example) => example.includes(" launch ") && example.includes("--json --compact"),
  );
  const runExamples = document.examples.filter(
    (example) => example.includes(" run ") && example.includes("--background"),
  );
  const runtimeIds = document.runtimes.map((runtime) => runtime.id);
  const canLaunchChildAgents = runtimeIds.length > 0;

  return {
    schemaVersion: document.schemaVersion,
    purpose: document.purpose,
    fullHelp: { args: ["help", "--json", ...helpArgsSuffix(options)] },
    agentQuickStart: [
      "Run doctor --json --compact when runtime availability is uncertain.",
      "If compact doctor returns parent.canRun: true, append the request to parent.run.argsPrefix or parent.run.backgroundArgsPrefix.",
      ...(canLaunchChildAgents
        ? ["Start many tasks with launch --json --compact --brief."]
        : ["If runtimeIds is empty, do not call launch; add or enable an agent config first."]),
      "Find running tasks with ps --json --compact --active --brief.",
      "Narrow one parent run with ps --parent <run-id|prefix> --json --compact --brief.",
      "If active ps is empty after short work, run views.recent.args from compact ps to recover recent tasks.",
      "Collect listed tasks with top-level commands.waitPreview.args from compact ps.",
      "Read selected tasks with read <id> <id> --wait --json --compact.",
      "Debug failed reads with commands.logsPreview.args or commands.events.args.",
      "Stop scoped work with stop.args from compact ps or read output.",
    ],
    canLaunchChildAgents,
    runtimeIds,
    runtimes: document.runtimes.map((runtime) => ({
      id: runtime.id,
      displayName: runtime.displayName,
      ...(runtime.modelFlag ? { modelFlag: runtime.modelFlag } : {}),
      structuredEvents: runtime.structuredEvents,
      resumeSupported: runtime.resumeSupported,
    })),
    commands: document.commands.map((command) => ({
      name: command.name,
      usage: command.usage,
      semantics: command.semantics,
    })),
    examples: [
      ...document.examples.filter((example) => preferredExamples.has(example)),
      ...runExamples.slice(0, 1),
      ...launchExamples.slice(0, 2),
    ],
  };
}

function helpArgsSuffix(options: Pick<HelpOptions, "workspaceRoot" | "configPath">): string[] {
  return [
    "--workspace",
    options.workspaceRoot,
    ...(options.configPath ? ["--config", options.configPath] : []),
  ];
}

function orderedRuntimeConfigs(registry: RuntimeRegistry): HeadlessAgentRuntimeConfig[] {
  const builtInIds = new Set<string>(ALL_AGENT_RUNTIMES);
  const builtIn = ALL_AGENT_RUNTIMES.map((runtimeId) => registry[runtimeId])
    .filter((runtime): runtime is HeadlessAgentRuntimeConfig => Boolean(runtime))
    .filter((runtime) => runtime.enabled);
  const custom = Object.values(registry)
    .filter((runtime): runtime is HeadlessAgentRuntimeConfig => Boolean(runtime))
    .filter((runtime) => !builtInIds.has(runtime.id))
    .filter((runtime) => runtime.enabled)
    .sort((a, b) => a.id.localeCompare(b.id));
  return [...builtIn, ...custom];
}

function buildCliExamples(registry: RuntimeRegistry): string[] {
  const examples: string[] = [];

  examples.push("orchestrator doctor");
  examples.push("orchestrator doctor --json --compact");
  examples.push('orchestrator run "figure out what needs to change in this repo"');
  examples.push(
    'orchestrator run --background --name "repo plan" --json --compact "figure out what needs to change in this repo"',
  );
  examples.push('orchestrator run --trace-tools "launch a codex child and wait for it"');
  examples.push('orchestrator run --stream-json "launch a codex child and wait for it"');
  if (registry["claude-code"]?.enabled) {
    examples.push(
      'orchestrator launch claude-code --name "review repo" --model sonnet --json --compact "review this repo"',
    );
  }
  if (registry.codex?.enabled) {
    examples.push(
      'orchestrator launch codex --name "write tests" --model gpt-5.4-mini --json --compact "write tests for the task store"',
    );
  }

  return [
    ...examples,
    "orchestrator help --json --compact",
    "orchestrator ps",
    "orchestrator ps --all",
    "orchestrator ps --all --json --compact",
    "orchestrator ps --watch",
    "orchestrator ps --json --compact --active",
    "orchestrator ps --json --compact --active --brief",
    "orchestrator ps --parent <run-id|prefix> --json --compact --brief",
    "orchestrator watch <task-id|prefix>",
    "orchestrator watch <task-id|prefix> --agent-only --json",
    "orchestrator read <task-id|prefix>",
    "orchestrator read <task-id|prefix>... --wait --json --compact",
    "orchestrator logs <task-id|prefix> --stream stderr --follow",
    "orchestrator events <task-id|prefix> --agent-only --json",
    'orchestrator interrupt <task-id|prefix> <task-id|prefix> --json --compact --reason "selected cleanup"',
    'orchestrator interrupt <parent-id|prefix> --children --reason "stopping stale run"',
    'orchestrator interrupt --group <group-id|prefix> --reason "stopping stale group"',
    'orchestrator interrupt --active --json --compact --reason "cleanup"',
  ];
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

async function commandPs(options: PsOptions): Promise<void> {
  await validatePsRuntimeFilter(options);

  if (!options.watch) {
    const view = await loadPsView(options);
    if (options.json) {
      process.stdout.write(jsonLine(await formatPsJsonView(view, options), options));
      return;
    }
    process.stdout.write(renderPsView(view, { columns: terminalColumns() }));
    return;
  }

  let previousLineCount = 0;
  while (true) {
    const view = await loadPsView(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(await formatPsJsonView(view, options))}\n`);
    } else {
      const rendered = renderPsView(view, { columns: terminalColumns() });
      if (process.stdout.isTTY) {
        process.stdout.write(renderWatchFrame(rendered, previousLineCount));
        previousLineCount = countRenderedLines(rendered, terminalColumns());
      } else {
        process.stdout.write("---\n");
        process.stdout.write(rendered);
      }
    }

    await delay(options.intervalMs);
  }
}

async function loadPsView(options: PsOptions): Promise<AgentTaskPsView> {
  const view = await buildAgentTaskPsView({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    all: options.all,
    activeOnly: options.compact && options.active,
  });
  return options.parentRunId ? filterPsViewByParent(view, options.parentRunId) : view;
}

async function validatePsRuntimeFilter(options: PsOptions): Promise<void> {
  if (!options.runtime) {
    return;
  }

  const storeOptions = {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
  };
  const [tasks, { registry }] = await Promise.all([
    listTasks(storeOptions),
    loadConfiguredRuntimeRegistry({
      workspaceRoot: options.workspaceRoot,
      ...(options.configPath ? { configPath: options.configPath } : {}),
    }),
  ]);

  if (registry[options.runtime] || tasks.some((task) => task.runtime === options.runtime)) {
    return;
  }

  throw new CliError(`Unknown runtime filter "${options.runtime}".`, {
    reason: "unknown_runtime",
    input: options.runtime,
    hint: "Run orchestrator help --json --compact for configured runtime ids, or ps --all --json --compact for task history.",
  });
}

async function formatPsJsonView(view: AgentTaskPsView, options: PsOptions): Promise<unknown> {
  if (!options.compact) {
    return view;
  }

  const storeOptions = {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
  };
  const taskIds = await listTaskIds(storeOptions);
  const groupIds = view.groups.some((group) => group.groupId !== UNGROUPED_GROUP_ID)
    ? [...new Set((await listTasks(storeOptions)).map((task) => taskGroupId(task)))]
    : view.groups.map((group) => group.groupId);

  const compactView = withPortableStopArgs(
    compactAgentTaskPsView(view, {
      activeOnly: options.active,
      brief: options.brief,
      taskIds,
      groupIds,
    }),
    options,
  );

  return {
    ...compactView,
    views: compactPsViewCommands(options),
  };
}

function withPortableStopArgs<T extends AgentTaskControlView>(view: T, options: CommonOptions): T {
  const suffix = stopArgsSuffix(options);
  if (suffix.length === 0) {
    return view;
  }

  return {
    ...view,
    ...(view.commands ? { commands: appendControlCommandArgs(view.commands, suffix) } : {}),
    ...(view.stop ? { stop: appendStopArgs(view.stop, suffix) } : {}),
    groups: view.groups.map((group) => ({
      ...group,
      ...(group.commands ? { commands: appendControlCommandArgs(group.commands, suffix) } : {}),
      ...(group.stop ? { stop: appendStopArgs(group.stop, suffix) } : {}),
    })),
    tasks: view.tasks.map((task) => ({
      ...task,
      ...(task.commands ? { commands: appendControlCommandArgs(task.commands, suffix) } : {}),
      ...(task.stop ? { stop: appendStopArgs(task.stop, suffix) } : {}),
    })),
  };
}

function appendControlCommandArgs<T extends Record<string, { args: string[] }>>(
  commands: T,
  suffix: readonly string[],
): T {
  return Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [
      name,
      { ...command, args: [...command.args, ...suffix] },
    ]),
  ) as T;
}

function appendStopArgs<T extends { args: string[] }>(stop: T, suffix: readonly string[]): T {
  return { ...stop, args: [...stop.args, ...suffix] };
}

function stopArgsSuffix(options: CommonOptions): string[] {
  return [
    "--workspace",
    options.workspaceRoot,
    ...(options.orchestratorDir ? ["--orchestrator-dir", options.orchestratorDir] : []),
  ];
}

function filterPsViewByParent(view: AgentTaskPsView, parentRunId: string): AgentTaskPsView {
  const groupId = resolvePsGroupId(view, parentRunId);
  if (!groupId) {
    return {
      generatedAt: view.generatedAt,
      groups: [],
      rows: [],
    };
  }
  const groups = view.groups.filter((group) => group.groupId === groupId);
  const groupIds = new Set(groups.map((group) => group.groupId));
  return {
    generatedAt: view.generatedAt,
    groups,
    rows: view.rows.filter((row) => groupIds.has(psRowGroupId(row))),
  };
}

function resolvePsGroupId(view: AgentTaskPsView, input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new CliError("ps --parent requires a non-empty group id.");
  }

  const groupIds = view.groups.map((group) => group.groupId).sort();
  if (groupIds.includes(trimmed)) {
    return trimmed;
  }

  const matches = groupIds.filter((groupId) => groupId.startsWith(trimmed));
  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    throw new CliError(
      `ps --parent "${trimmed}" is ambiguous. Matches:\n${matches
        .map((match) => `  ${match}`)
        .join("\n")}`,
      {
        reason: "ambiguous_group",
        input: trimmed,
        matches,
        hint: "Run orchestrator ps --json --compact --brief for recent groups, ps --json --compact --active --brief for active groups, or orchestrator ps --all --json --compact for history. Use groups[].id or groupId.",
      },
    );
  }

  return undefined;
}

function psRowGroupId(row: AgentTaskPsView["rows"][number]): string {
  return taskGroupId(row);
}

async function commandRead(options: ReadOptions): Promise<void> {
  const storeOptions = {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
  };

  if (options.taskIds.length > 1) {
    await commandReadBatch(options, storeOptions);
    return;
  }

  const { task, retrievalStatus } = await readTaskForOptions(
    options,
    storeOptions,
    onlyTaskId(options),
  );

  if (options.json) {
    const payload = await taskReadJsonPayload(
      task,
      options,
      undefined,
      retrievalStatus ? { retrievalStatus } : {},
    );
    const rendered = options.compact ? compactTaskReadJsonPayload(payload) : payload;
    process.stdout.write(jsonLine(rendered, options));
    return;
  }

  if (retrievalStatus === "timeout") {
    process.stderr.write(`Timed out waiting for task ${task.taskId}; status is ${task.status}.\n`);
  }

  const output = await readTaskOutput({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId: task.taskId,
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

    if (retrievalStatus !== "timeout") {
      process.stderr.write(`No output yet; task ${task.taskId} is ${task.status}.\n`);
    }
    return;
  }

  process.stdout.write(output);
}

async function commandReadBatch(
  options: ReadOptions,
  storeOptions: { workspaceRoot: string; orchestratorDir?: string },
): Promise<void> {
  const taskIds = await listTaskIds(storeOptions);
  const results = await Promise.all(
    options.taskIds.map((taskId) => readTaskForOptions(options, storeOptions, taskId)),
  );
  const payloads = await Promise.all(
    results.map(async (result) => {
      return await taskReadJsonPayload(
        result.task,
        options,
        taskIds,
        result.retrievalStatus ? { retrievalStatus: result.retrievalStatus } : {},
      );
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
  options: CommonOptions,
): AgentTaskControlStopTarget | undefined {
  const active = payloads
    .map((payload, index) => ({ payload, task: results[index]?.task }))
    .filter((item): item is { payload: TaskReadJsonPayload; task: AgentTaskRecord } =>
      Boolean(item.task && item.payload.active),
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
  storeOptions: { workspaceRoot: string; orchestratorDir?: string },
  taskId: string,
): Promise<{ task: AgentTaskRecord; retrievalStatus?: "completed" | "timeout" }> {
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
    };
  }

  return {
    ...(options.wait ? { retrievalStatus: "completed" as const } : {}),
    task,
  };
}

function onlyTaskId(options: ReadOptions): string {
  const taskId = options.taskIds[0];
  if (!taskId) {
    throw missingTaskIdError("read");
  }
  return taskId;
}

function readBatchSummary(
  results: readonly { task: AgentTaskRecord; retrievalStatus?: "completed" | "timeout" }[],
): {
  tasks: number;
  active: number;
  done: number;
  failed: number;
  stopped: number;
  timedOut: number;
  retrievalCompleted?: number;
  retrievalTimeout?: number;
} {
  const summary = {
    tasks: results.length,
    active: results.filter((result) => !isTerminalStatus(result.task.status)).length,
    done: results.filter((result) => result.task.status === "succeeded").length,
    failed: results.filter((result) => result.task.status === "failed").length,
    stopped: results.filter((result) => result.task.status === "cancelled").length,
    timedOut: results.filter((result) => result.task.status === "timed_out").length,
  };
  if (!results.some((result) => result.retrievalStatus)) {
    return summary;
  }

  return {
    ...summary,
    retrievalCompleted: results.filter((result) => result.retrievalStatus === "completed").length,
    retrievalTimeout: results.filter((result) => result.retrievalStatus === "timeout").length,
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

function isFailedReadStatus(status: TaskStatus): boolean {
  return status === "failed" || status === "cancelled" || status === "timed_out";
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
      throw new CliError("logs --follow cannot be combined with --json.", {
        reason: "incompatible_options",
        input: "--follow",
        hint: "Use logs --follow for raw streaming text, or watch --json for parseable JSONL events.",
      });
    }
    await followLogs(task, options, maxBytes);
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
    const taskIds = await listTaskIds({
      workspaceRoot: options.workspaceRoot,
      ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    });
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
      task.taskId,
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
  const maxBytes = options.maxBytes ?? 500_000;
  const raw = await readTailMetadataIfExists(task.paths.eventsJsonl, maxBytes);
  const lines = raw.text.trim() ? raw.text.trimEnd().split("\n") : [];
  const events = options.agentOnly ? lines.filter((line) => isAgentEventLine(line)) : lines;
  const parsedEvents = events
    .map(parseEventLine)
    .filter((event): event is TaskEvent => Boolean(event));

  if (options.json) {
    if (options.compact) {
      const taskIds = await listTaskIds({
        workspaceRoot: options.workspaceRoot,
        ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
      });
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

async function commandWatch(options: WatchOptions): Promise<void> {
  const storeOptions = {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
  };
  const taskId = await resolveTaskId(storeOptions, options.taskId);
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let eventsOffset = 0;
  let eventRemainder = "";

  while (true) {
    const task = await readTaskRecord(storeOptions, taskId);

    const eventsRead = await readNewFileText(task.paths.eventsJsonl, eventsOffset);
    eventsOffset = eventsRead.offset;
    if (eventsRead.text) {
      const rendered = renderWatchEvents(
        eventsRead.text,
        eventRemainder,
        options.json,
        options.agentOnly,
      );
      eventRemainder = rendered.remainder;
      if (rendered.output) {
        process.stdout.write(rendered.output);
      }
    }

    if (!options.json && task.launchPlan.outputTransport.kind !== "jsonl_events") {
      const stdoutRead = await readNewFileText(task.paths.stdoutLog, stdoutOffset);
      stdoutOffset = stdoutRead.offset;
      if (stdoutRead.text) {
        process.stdout.write(stdoutRead.text);
      }
    } else {
      stdoutOffset = (await readNewFileText(task.paths.stdoutLog, stdoutOffset)).offset;
    }

    if (options.json) {
      stderrOffset = (await readNewFileText(task.paths.stderrLog, stderrOffset)).offset;
    } else {
      const stderrRead = await readNewFileText(task.paths.stderrLog, stderrOffset);
      stderrOffset = stderrRead.offset;
      if (stderrRead.text) {
        process.stderr.write(stderrRead.text);
      }
    }

    if (isTerminalStatus(task.status)) {
      if (eventRemainder.trim()) {
        const rendered = renderWatchEvents("\n", eventRemainder, options.json, options.agentOnly);
        if (rendered.output) {
          process.stdout.write(rendered.output);
        }
      }
      return;
    }

    await delay(options.intervalMs);
  }
}

async function commandInterrupt(options: InterruptOptions): Promise<number> {
  const result = await interruptTasks({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    target: interruptTargetFromOptions(options),
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

async function commandDoctor(options: DoctorOptions): Promise<number> {
  const [parentReport, runtimeConfig] = await Promise.all([
    doctorParentAgentConfig({
      ...(options.agentDir ? { agentDir: options.agentDir } : {}),
      ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
    }),
    loadConfiguredRuntimeRegistry({
      workspaceRoot: options.workspaceRoot,
      ...(options.configPath ? { configPath: options.configPath } : {}),
    }),
  ]);
  const runtimes = await doctorRuntimeAvailability(runtimeConfig.registry, {
    cwd: options.workspaceRoot,
  });
  const report: CliDoctorReport = {
    ...parentReport,
    runtimeSummary: summarizeRuntimeDoctorChecks(runtimes),
    runtimes,
  };

  if (options.json) {
    const rendered = options.compact ? compactDoctorReport(report, options) : report;
    process.stdout.write(jsonLine(rendered, { compact: options.compact }));
  } else {
    process.stdout.write(renderDoctorReport(report));
  }

  return report.status === "error" ? 1 : 0;
}

function compactDoctorReport(
  report: CliDoctorReport,
  options: Pick<DoctorOptions, "workspaceRoot" | "configPath" | "agentDir" | "sessionDir">,
): CliCompactDoctorReport {
  const parentRun = compactParentRunCommand(report, options);

  return {
    schemaVersion: 1,
    status: report.status,
    canRunParentAgent: report.canRunParentAgent,
    canLaunchChildAgents: report.runtimeSummary.available > 0,
    parent: {
      canRun: Boolean(parentRun),
      agentDir: report.agentDir,
      sessionDir: report.sessionDir,
      ...(report.piAgentDir ? { piAgentDir: report.piAgentDir } : {}),
      ...(parentRun ? { run: parentRun } : {}),
    },
    runtimeSummary: report.runtimeSummary,
    runtimes: report.runtimes.map((runtime) => ({
      id: runtime.id,
      available: runtime.available,
      executable: runtime.executable,
      ...(runtime.path ? { path: runtime.path } : {}),
      message: runtime.message,
    })),
    fullDoctor: { args: ["doctor", "--json", ...doctorArgsSuffix(options)] },
  };
}

function compactParentRunCommand(
  report: CliDoctorReport,
  options: Pick<DoctorOptions, "workspaceRoot" | "configPath" | "agentDir" | "sessionDir">,
): NonNullable<CliCompactDoctorReport["parent"]["run"]> | null {
  const source = report.canRunParentAgent
    ? "configured"
    : hasPiFallbackSuggestion(report)
      ? "pi-fallback"
      : null;
  if (!source) {
    return null;
  }

  const agentDir = source === "pi-fallback" ? report.piAgentDir : options.agentDir;
  const argsSuffix = [
    "--workspace",
    options.workspaceRoot,
    ...(options.configPath ? ["--config", options.configPath] : []),
    ...(agentDir ? ["--agent-dir", agentDir] : []),
    ...(options.sessionDir ? ["--session-dir", options.sessionDir] : []),
  ];

  return {
    source,
    requestPosition: "last",
    argsPrefix: ["run", ...argsSuffix],
    backgroundArgsPrefix: ["run", "--background", "--json", "--compact", ...argsSuffix],
  };
}

function hasPiFallbackSuggestion(report: CliDoctorReport): boolean {
  return report.suggestions.some((suggestion) =>
    suggestion.includes(`orchestrator run --agent-dir ${report.piAgentDir}`),
  );
}

function doctorArgsSuffix(
  options: Pick<DoctorOptions, "workspaceRoot" | "configPath" | "agentDir" | "sessionDir">,
): string[] {
  return [
    "--workspace",
    options.workspaceRoot,
    ...(options.configPath ? ["--config", options.configPath] : []),
    ...(options.agentDir ? ["--agent-dir", options.agentDir] : []),
    ...(options.sessionDir ? ["--session-dir", options.sessionDir] : []),
  ];
}

function summarizeRuntimeDoctorChecks(
  runtimes: readonly RuntimeDoctorCheck[],
): CliDoctorReport["runtimeSummary"] {
  const availableIds = runtimes.filter((runtime) => runtime.available).map((runtime) => runtime.id);
  const unavailableIds = runtimes
    .filter((runtime) => !runtime.available)
    .map((runtime) => runtime.id);

  return {
    total: runtimes.length,
    available: availableIds.length,
    unavailable: unavailableIds.length,
    availableIds,
    unavailableIds,
  };
}

async function commandRun(options: RunOptions): Promise<void> {
  if (options.background) {
    await commandRunBackground(options);
    return;
  }

  const result = await executeParentRun(options);
  if (options.streamJson) {
    return;
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          sessionId: result.sessionId,
          output: result.output,
          ...(result.modelFallbackMessage
            ? { modelFallbackMessage: result.modelFallbackMessage }
            : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (result.modelFallbackMessage) {
    process.stderr.write(`${result.modelFallbackMessage}\n`);
  }
  if (result.output) {
    process.stdout.write(`${result.output}\n`);
  }
}

async function commandRunBackground(options: RunOptions): Promise<void> {
  if (options.traceTools !== "off") {
    throw new CliError("run --background cannot be combined with --trace-tools.");
  }
  if (options.streamJson) {
    throw new CliError("run --background cannot be combined with --stream-json.");
  }

  const taskId = randomUUID();
  const request: ParentRunTaskRequest = {
    schemaVersion: 1,
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
    ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
    request: options.request,
    parentRunId: taskId,
    parentTaskId: taskId,
  };
  const requestPath = await writeParentRunRequest(request, taskId);
  const launchInput: LaunchTaskInput = {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId,
    name: options.name ?? summarizeTaskPrompt(options.request),
    plan: parentRunLaunchPlan({
      workspaceRoot: options.workspaceRoot,
      requestPath,
    }),
  };

  const task = await launchInBackground(launchInput);
  if (options.json && options.compact) {
    await printTaskSummaryJson(task, {
      ...options,
      wait: false,
    });
    return;
  }

  printTask(task, options.json);
}

async function executeParentRun(
  options: RunOptions & { parentRunId?: string; parentTaskId?: string },
): Promise<ParentRunResult> {
  const runEvents = createRunStreamSequencer({ runId: options.parentRunId ?? randomUUID() });
  let parentSessionId: string | undefined;
  let created: Awaited<ReturnType<typeof createOrchestratorParentSession>>;
  try {
    created = await createOrchestratorParentSession({
      workspaceRoot: options.workspaceRoot,
      ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
      ...(options.configPath ? { configPath: options.configPath } : {}),
      ...(options.agentDir ? { agentDir: options.agentDir } : {}),
      ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
      parentRunId: runEvents.runId,
      ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
      parentSessionId: () => parentSessionId,
      configEnv: process.env,
      backgroundLauncher: launchInBackground,
      ...(options.traceTools === "off" && !options.streamJson
        ? {}
        : {
            trace: (event) => {
              const shouldRenderRunEvents = options.streamJson || options.traceTools === "text";
              const traceEvents = shouldRenderRunEvents
                ? runStreamPayloadsFromParentToolTrace(event).map((payload) =>
                    runEvents.create(payload),
                  )
                : [];

              if (options.streamJson) {
                for (const traceEvent of traceEvents) {
                  writeRunJsonStreamEvent(traceEvent);
                }
              }
              if (options.traceTools === "jsonl") {
                process.stderr.write(`${JSON.stringify(event)}\n`);
              } else if (options.traceTools === "text") {
                process.stderr.write(renderRunTraceEvents(traceEvents));
              }
            },
          }),
    });
  } catch (error) {
    if (options.streamJson) {
      writeRunJsonStreamEvent(
        runEvents.create({
          kind: "run.error",
          error: normalizeRunStreamError(error),
        }),
      );
    }
    throw error;
  }
  const { session, modelFallbackMessage } = created;
  parentSessionId = session.sessionId;

  try {
    if (options.streamJson) {
      writeRunJsonStreamEvent(
        runEvents.create({
          kind: "run.started",
          sessionId: session.sessionId,
          cwd: resolve(options.workspaceRoot),
          request: options.request,
        }),
      );
    }

    try {
      await session.prompt(buildOrchestratorParentPrompt(options.request), {
        expandPromptTemplates: false,
      });
    } catch (error) {
      if (options.streamJson) {
        writeRunJsonStreamEvent(
          runEvents.create({
            kind: "run.error",
            sessionId: session.sessionId,
            error: normalizeRunStreamError(error),
          }),
        );
      }
      throw error;
    }

    const output = session.getLastAssistantText() ?? "";
    if (options.streamJson) {
      writeRunJsonStreamEvent(
        runEvents.create({
          kind: "run.final",
          sessionId: session.sessionId,
          output,
          ...(modelFallbackMessage ? { modelFallbackMessage } : {}),
        }),
      );
    }

    return {
      sessionId: session.sessionId,
      output,
      ...(modelFallbackMessage ? { modelFallbackMessage } : {}),
    };
  } finally {
    session.dispose();
  }
}

function renderDoctorReport(report: CliDoctorReport): string {
  const lines = [
    "Orchestrator doctor",
    `status: ${report.status}`,
    `canRunParentAgent: ${report.canRunParentAgent ? "yes" : "no"}`,
    `agentDir: ${report.agentDir}`,
    "",
    "Checks:",
    ...report.checks.map(
      (check) =>
        `  ${check.status.padEnd(7)} ${check.label}${check.path ? ` (${check.path})` : ""}: ${check.message}`,
    ),
    "",
    "Runtimes:",
    ...report.runtimes.map(
      (runtime) =>
        `  ${(runtime.available ? "ok" : "warning").padEnd(7)} ${runtime.id} (${runtime.executable}): ${runtime.message}`,
    ),
  ];

  if (report.suggestions.length > 0) {
    lines.push("", "Suggestions:", ...report.suggestions.map((suggestion) => `  - ${suggestion}`));
  }

  return `${lines.join("\n")}\n`;
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

async function commandRunParentTask(requestPath: string): Promise<void> {
  const request = JSON.parse(await readFile(requestPath, "utf8")) as ParentRunTaskRequest;

  try {
    if (request.schemaVersion !== 1) {
      throw new CliError(`Unsupported parent run request schema ${request.schemaVersion}.`);
    }

    const result = await executeParentRun({
      workspaceRoot: request.workspaceRoot,
      ...(request.orchestratorDir ? { orchestratorDir: request.orchestratorDir } : {}),
      ...(request.configPath ? { configPath: request.configPath } : {}),
      ...(request.agentDir ? { agentDir: request.agentDir } : {}),
      ...(request.sessionDir ? { sessionDir: request.sessionDir } : {}),
      request: request.request,
      parentRunId: request.parentRunId,
      parentTaskId: request.parentTaskId,
      json: false,
      background: false,
      compact: false,
      brief: false,
      traceTools: "off",
      streamJson: false,
    });

    if (result.modelFallbackMessage) {
      process.stderr.write(`${result.modelFallbackMessage}\n`);
    }
    if (result.output) {
      process.stdout.write(`${result.output}\n`);
    }
  } finally {
    await rm(requestPath, { force: true });
  }
}

async function launchInBackground(input: LaunchTaskInput): Promise<AgentTaskRecord> {
  const taskId = input.taskId;
  if (!taskId) {
    throw new CliError("Background launch requires a preallocated task id.");
  }

  validateLaunchTaskInput(input);
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
  return writeJsonRequest({
    orchestratorDir,
    requestDirName: "run-requests",
    id: input.taskId,
    value: input,
  });
}

async function writeParentRunRequest(
  request: ParentRunTaskRequest,
  taskId: string,
): Promise<string> {
  const orchestratorDir =
    request.orchestratorDir ?? resolve(request.workspaceRoot, ".orchestrator");
  return writeJsonRequest({
    orchestratorDir,
    requestDirName: "parent-run-requests",
    id: taskId,
    value: request,
  });
}

async function writeJsonRequest(input: {
  orchestratorDir: string;
  requestDirName: string;
  id: string | undefined;
  value: unknown;
}): Promise<string> {
  if (!input.id) {
    throw new CliError("Detached request requires an id.");
  }

  const requestDir = resolve(input.orchestratorDir, input.requestDirName);
  await mkdir(requestDir, { recursive: true });

  const requestPath = resolve(requestDir, `${input.id}.json`);
  await writeFile(requestPath, `${JSON.stringify(input.value, null, 2)}\n`);
  return requestPath;
}

function parentRunLaunchPlan(input: {
  workspaceRoot: string;
  requestPath: string;
}): AgentLaunchPlan {
  const cliPath = fileURLToPath(import.meta.url);
  return {
    runtime: "orchestrator",
    displayName: "Orchestrator",
    executable: process.execPath,
    args: ["--experimental-strip-types", cliPath, "__run-parent-task", input.requestPath],
    env: {},
    cwd: input.workspaceRoot,
    promptTransport: { kind: "sdk" },
    outputTransport: { kind: "stdout_text" },
    expectedProcesses: ["node"],
    interrupt: "process_group",
    canSteerRunning: false,
    handlesOwnAuth: true,
    enabled: true,
    safety: {
      requiresAllowlist: false,
      acceptsShellCommand: false,
    },
  };
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
  let compact = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--compact":
        compact = true;
        break;
      case "--workspace":
        workspaceRoot = resolve(requireValue(args, ++index, arg));
        break;
      case "--orchestrator-dir":
        requireValue(args, ++index, arg);
        break;
      case "--config":
        configPath = resolve(requireValue(args, ++index, arg));
        break;
      default:
        throw unknownOptionError("help", String(arg));
    }
  }

  if (compact && !json) {
    throw new CliError("help --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Use help --json --compact, or omit --compact.",
    });
  }

  return {
    workspaceRoot,
    ...(configPath ? { configPath } : {}),
    json,
    compact,
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
  let compact = false;
  let brief = false;
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
      case "--compact":
        compact = true;
        break;
      case "--brief":
        brief = true;
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
          throw unknownOptionError("launch", arg);
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
  if (compact && !common.json) {
    throw new CliError("launch --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Add --json or omit --compact.",
    });
  }
  if (brief && !compact) {
    throw new CliError("launch --brief requires --compact.", {
      reason: "missing_required_option",
      input: "--brief",
      hint: "Use launch --json --compact --brief, or omit --brief.",
    });
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
    compact,
    brief,
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
        status = parseTaskStatus(requireValue(args, ++index, arg), arg);
        break;
      default:
        throw unknownOptionError("list", String(arg));
    }
  }

  return {
    ...common,
    ...(status ? { status } : {}),
  };
}

function parsePsOptions(args: readonly string[]): PsOptions {
  const common = defaultCommonOptions();
  let status: TaskStatus | undefined;
  let runtime: string | undefined;
  let parentRunId: string | undefined;
  let all = false;
  let watch = false;
  let compact = false;
  let brief = false;
  let active = false;
  let intervalMs = 1_000;

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
        status = parseTaskStatus(requireValue(args, ++index, arg), arg);
        break;
      case "--runtime":
        runtime = requireValue(args, ++index, arg);
        break;
      case "--parent":
        parentRunId = requireValue(args, ++index, arg);
        break;
      case "--all":
        all = true;
        break;
      case "--watch":
      case "-w":
        watch = true;
        break;
      case "--compact":
        compact = true;
        break;
      case "--brief":
        brief = true;
        break;
      case "--active":
        active = true;
        break;
      case "--interval-ms":
        intervalMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      default:
        throw unknownOptionError("ps", String(arg));
    }
  }

  if (compact && !common.json) {
    throw new CliError("ps --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Add --json or omit --compact.",
    });
  }
  if (active && !compact) {
    throw new CliError("ps --active requires --compact.", {
      reason: "missing_required_option",
      input: "--active",
      hint: "Use ps --json --compact --active.",
    });
  }
  if (brief && !compact) {
    throw new CliError("ps --brief requires --compact.", {
      reason: "missing_required_option",
      input: "--brief",
      hint: "Use ps --json --compact --active --brief.",
    });
  }

  return {
    ...common,
    ...(status ? { status } : {}),
    ...(runtime ? { runtime } : {}),
    ...(parentRunId ? { parentRunId } : {}),
    all,
    watch,
    compact,
    brief,
    active,
    intervalMs,
  };
}

function parseReadOptions(args: readonly string[]): ReadOptions {
  const common = defaultCommonOptions();
  const taskIds: string[] = [];
  let maxBytes: number | undefined;
  let wait = false;
  let compact = false;
  let timeoutMs: number | undefined;
  let intervalMs: number | undefined;

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
      case "--compact":
        compact = true;
        break;
      case "--max-bytes":
        maxBytes = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--wait":
        wait = true;
        break;
      case "--timeout-ms":
        timeoutMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--interval-ms":
        intervalMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      default:
        if (arg?.startsWith("-")) {
          throw unknownOptionError("read", arg);
        }
        taskIds.push(arg);
    }
  }

  if (taskIds.length === 0) {
    throw missingTaskIdError("read");
  }
  if (compact && !common.json) {
    throw new CliError("read --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Add --json or omit --compact.",
    });
  }
  if (taskIds.length > 1 && !common.json) {
    throw new CliError("read multiple task ids requires --json.", {
      reason: "missing_required_option",
      input: "task-id",
      hint: "Use read <id> <id> --json --compact, or read one task at a time.",
    });
  }
  if (!wait && timeoutMs !== undefined) {
    throw new CliError("read --timeout-ms requires --wait.", {
      reason: "missing_required_option",
      input: "--timeout-ms",
      hint: "Add --wait or omit --timeout-ms.",
    });
  }
  if (!wait && intervalMs !== undefined) {
    throw new CliError("read --interval-ms requires --wait.", {
      reason: "missing_required_option",
      input: "--interval-ms",
      hint: "Add --wait or omit --interval-ms.",
    });
  }

  return {
    ...common,
    taskIds,
    ...(maxBytes ? { maxBytes } : {}),
    wait,
    compact,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(intervalMs !== undefined ? { intervalMs } : {}),
  };
}

function parseLogsOptions(args: readonly string[]): LogsOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  let maxBytes: number | undefined;
  let stream: LogStream = "all";
  let follow = false;
  let compact = false;

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
      case "--compact":
        compact = true;
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
          throw unknownOptionError("logs", arg);
        }
        if (taskId) {
          throw duplicateTaskIdError("logs");
        }
        taskId = arg;
    }
  }

  if (!taskId) {
    throw missingTaskIdError("logs");
  }

  if (compact && !common.json) {
    throw new CliError("logs --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Add --json or omit --compact.",
    });
  }

  return {
    ...common,
    taskId,
    stream,
    follow,
    compact,
    ...(maxBytes ? { maxBytes } : {}),
  };
}

function parseEventsOptions(args: readonly string[]): EventsOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  let maxBytes: number | undefined;
  let agentOnly = false;
  let compact = false;

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
      case "--compact":
        compact = true;
        break;
      case "--max-bytes":
        maxBytes = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--agent-only":
        agentOnly = true;
        break;
      default:
        if (arg?.startsWith("-")) {
          throw unknownOptionError("events", arg);
        }
        if (taskId) {
          throw duplicateTaskIdError("events");
        }
        taskId = arg;
    }
  }

  if (!taskId) {
    throw missingTaskIdError("events");
  }

  if (compact && !common.json) {
    throw new CliError("events --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Add --json or omit --compact.",
    });
  }

  return {
    ...common,
    taskId,
    agentOnly,
    compact,
    ...(maxBytes ? { maxBytes } : {}),
  };
}

function parseWatchOptions(args: readonly string[]): WatchOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  let intervalMs = 250;
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
      case "--agent-only":
        agentOnly = true;
        break;
      case "--interval-ms":
        intervalMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      default:
        if (arg?.startsWith("-")) {
          throw unknownOptionError("watch", arg);
        }
        if (taskId) {
          throw duplicateTaskIdError("watch");
        }
        taskId = arg;
    }
  }

  if (!taskId) {
    throw missingTaskIdError("watch");
  }

  return {
    ...common,
    taskId,
    intervalMs,
    agentOnly,
  };
}

function parseInterruptOptions(args: readonly string[]): InterruptOptions {
  const common = defaultCommonOptions();
  const taskIds: string[] = [];
  let parentId: string | undefined;
  let groupId: string | undefined;
  let active = false;
  let children = false;
  let taskOnly = false;
  let reason: string | undefined;
  let signal: NodeJS.Signals | undefined;
  let compact = false;

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
      case "--compact":
        compact = true;
        break;
      case "--parent":
        parentId = requireValue(args, ++index, arg);
        break;
      case "--group":
        groupId = requireValue(args, ++index, arg);
        break;
      case "--active":
        active = true;
        break;
      case "--children":
        children = true;
        break;
      case "--task-only":
        taskOnly = true;
        break;
      case "--reason":
        reason = requireValue(args, ++index, arg);
        break;
      case "--signal":
        signal = requireValue(args, ++index, arg) as NodeJS.Signals;
        break;
      default:
        if (arg?.startsWith("-")) {
          throw unknownOptionError("interrupt", arg);
        }
        taskIds.push(arg);
    }
  }

  if (compact && !common.json) {
    throw new CliError("interrupt --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Add --json or omit --compact.",
    });
  }
  const selectors = interruptSelectors({ taskIds, parentId, groupId, active });
  const selectorCount = selectors.length;
  if (selectorCount !== 1) {
    throw interruptSelectorError(selectors);
  }
  if (children && taskOnly) {
    throw incompatibleInterruptOptionsError("--children,--task-only", [
      "Choose --children to stop a parent task and its children.",
      "Choose --task-only to stop only the selected task.",
    ]);
  }
  if (parentId && !children) {
    throw new CliError("interrupt --parent requires --children.", {
      reason: "missing_required_option",
      input: "--parent",
      hint: "Use interrupt --parent <id> --children, or use interrupt <id> --task-only to stop only the parent task.",
    });
  }
  if (groupId && (children || taskOnly)) {
    throw incompatibleInterruptOptionsError("--group,--children|--task-only", [
      "Use interrupt --group <id> to stop a group.",
      "Use interrupt <task-id> --children or interrupt <task-id> --task-only for task-specific control.",
    ]);
  }
  if (active && (children || taskOnly)) {
    throw incompatibleInterruptOptionsError("--active,--children|--task-only", [
      "Use interrupt --active to stop all active tasks.",
      "Use a task id with --children or --task-only when targeting one task.",
    ]);
  }
  if (taskIds.length > 1 && (children || taskOnly)) {
    throw incompatibleInterruptOptionsError("task-id...,--children|--task-only", [
      "Use interrupt <id> <id> for selected tasks.",
      "Use one task id with --children or --task-only when controlling a parent task.",
    ]);
  }
  if (taskOnly && taskIds.length !== 1) {
    throw new CliError("interrupt --task-only requires a task id.", {
      reason: "missing_required_argument",
      input: "task-id",
      hint: "Use interrupt <task-id|prefix> --task-only.",
    });
  }

  return {
    ...common,
    taskIds,
    ...(parentId ? { parentId } : {}),
    ...(groupId ? { groupId } : {}),
    active,
    children,
    taskOnly,
    ...(reason ? { reason } : {}),
    ...(signal ? { signal } : {}),
    compact,
  };
}

function missingTaskIdError(command: string): CliError {
  return new CliError(`${command} requires a task id.`, {
    reason: "missing_required_argument",
    input: "task-id",
    hint: "Pass one task id or unique prefix. Run orchestrator ps --json --compact --active for active tasks, or orchestrator ps --all --json --compact for history.",
  });
}

function duplicateTaskIdError(command: string): CliError {
  return new CliError(`${command} accepts exactly one task id.`, {
    reason: "too_many_arguments",
    input: "task-id",
    hint: "Pass exactly one task id or unique prefix.",
  });
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

function parseDoctorOptions(args: readonly string[]): DoctorOptions {
  const common = defaultCommonOptions();
  let agentDir: string | undefined;
  let sessionDir: string | undefined;
  let compact = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--json":
        common.json = true;
        break;
      case "--compact":
        compact = true;
        break;
      case "--workspace":
        common.workspaceRoot = resolve(requireValue(args, ++index, arg));
        break;
      case "--orchestrator-dir":
        common.orchestratorDir = resolve(requireValue(args, ++index, arg));
        break;
      case "--config":
        common.configPath = resolve(requireValue(args, ++index, arg));
        break;
      case "--agent-dir":
        agentDir = resolve(requireValue(args, ++index, arg));
        break;
      case "--session-dir":
        sessionDir = resolve(requireValue(args, ++index, arg));
        break;
      default:
        throw unknownOptionError("doctor", String(arg));
    }
  }

  if (compact && !common.json) {
    throw new CliError("doctor --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Use doctor --json --compact, or omit --compact.",
    });
  }

  return {
    ...common,
    ...(agentDir ? { agentDir } : {}),
    ...(sessionDir ? { sessionDir } : {}),
    compact,
  };
}

function parseRunOptions(args: readonly string[]): RunOptions {
  const common = defaultCommonOptions();
  const requestParts: string[] = [];
  let agentDir: string | undefined;
  let sessionDir: string | undefined;
  let name: string | undefined;
  let background = false;
  let compact = false;
  let brief = false;
  let traceTools: ParentToolTraceMode = "off";
  let streamJson = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      requestParts.push(...args.slice(index + 1));
      break;
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
      case "--agent-dir":
        agentDir = resolve(requireValue(args, ++index, arg));
        break;
      case "--session-dir":
        sessionDir = resolve(requireValue(args, ++index, arg));
        break;
      case "--name":
        name = parseTaskName(requireValue(args, ++index, arg));
        break;
      case "--background":
        background = true;
        break;
      case "--compact":
        compact = true;
        break;
      case "--brief":
        brief = true;
        break;
      case "--trace-tools":
        traceTools = "text";
        break;
      case "--stream-json":
        streamJson = true;
        break;
      default:
        if (!arg) {
          break;
        }
        if (arg.startsWith("--trace-tools=")) {
          traceTools = parseParentToolTraceMode(arg.slice("--trace-tools=".length), arg);
          break;
        }
        if (arg.startsWith("-")) {
          throw unknownOptionError("run", arg);
        }
        requestParts.push(arg);
    }
  }

  const request = requestParts.join(" ").trim();
  if (!request) {
    throw new CliError("run requires a user request.");
  }

  if (streamJson && common.json) {
    throw new CliError("run --stream-json cannot be combined with --json.", {
      reason: "incompatible_options",
      input: "--stream-json",
      hint: "Use --stream-json for JSONL event streams, or --json for one JSON result.",
    });
  }
  if (compact && !common.json) {
    throw new CliError("run --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Use run --background --json --compact, or omit --compact.",
    });
  }
  if (brief && !compact) {
    throw new CliError("run --brief requires --compact.", {
      reason: "missing_required_option",
      input: "--brief",
      hint: "Use run --background --json --compact --brief, or omit --brief.",
    });
  }
  if (compact && !background) {
    throw new CliError("run --compact requires --background.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Use run --background --json --compact, or omit --compact.",
    });
  }
  if (background && traceTools !== "off") {
    throw new CliError("run --background cannot be combined with --trace-tools.", {
      reason: "incompatible_options",
      input: "--trace-tools",
      hint: "Use foreground run with --trace-tools, or background run with ps/read/watch.",
    });
  }
  if (background && streamJson) {
    throw new CliError("run --background cannot be combined with --stream-json.", {
      reason: "incompatible_options",
      input: "--stream-json",
      hint: "Use foreground run with --stream-json, or background run with ps/read/watch.",
    });
  }
  if (name && !background) {
    throw new CliError("run --name requires --background.", {
      reason: "missing_required_option",
      input: "--name",
      hint: "Use run --background --name <name>, or omit --name.",
    });
  }

  return {
    ...common,
    request,
    ...(name ? { name } : {}),
    background,
    compact,
    brief,
    traceTools,
    streamJson,
    ...(agentDir ? { agentDir } : {}),
    ...(sessionDir ? { sessionDir } : {}),
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

async function printLaunchTask(task: AgentTaskRecord, options: LaunchOptions): Promise<void> {
  if (options.json && options.compact) {
    await printTaskSummaryJson(task, options);
    return;
  }

  printTask(task, options.json);
}

async function printTaskSummaryJson(
  task: AgentTaskRecord,
  options: CommonOptions & { wait: boolean; maxBytes?: number; brief?: boolean },
): Promise<void> {
  const storeOptions = {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
  };
  const taskIds = await listTaskIds(storeOptions);
  if (options.wait || isTerminalStatus(task.status)) {
    const payload = await taskReadJsonPayload(task, compactReadOptions(options), taskIds);
    const summary = compactTaskReadJsonPayload(payload);
    process.stdout.write(jsonLine(summary, { compact: true }));
    return;
  }

  const summary = taskCommandSummary(task, taskIds, { stopArgsSuffix: stopArgsSuffix(options) });
  process.stdout.write(
    jsonLine(briefTaskSummaryJsonPayload(summary, options.brief ?? false), {
      compact: true,
    }),
  );
}

function compactReadOptions<T extends CommonOptions & { maxBytes?: number }>(options: T): T {
  if (options.maxBytes !== undefined) {
    return options;
  }
  return { ...options, maxBytes: AGENT_CONTROL_PREVIEW_MAX_BYTES };
}

async function taskReadJsonPayload(
  task: AgentTaskRecord,
  options: CommonOptions & { maxBytes?: number },
  taskIds?: readonly string[],
  metadata: { retrievalStatus?: "completed" | "timeout" } = {},
): Promise<
  TaskCommandSummary & {
    retrievalStatus?: "completed" | "timeout";
    output: string;
    outputAvailable: boolean;
    outputKind: "result" | "stdout" | "none";
    outputTruncated: boolean;
    outputTruncatedByReadLimit: boolean;
    outputTruncatedByCaptureLimit: boolean;
    maxBytes: number;
    captureMaxBytes?: number;
    usage?: TaskUsage;
    error?: string;
    errorTruncated?: boolean;
    errorTruncatedByReadLimit?: boolean;
    errorTruncatedByCaptureLimit?: boolean;
  }
> {
  const maxBytes = options.maxBytes ?? DEFAULT_READ_MAX_BYTES;
  const output = await readTailMetadataIfExists(task.paths.resultMd, maxBytes);
  const fallback =
    output.text.length === 0 && !isTerminalStatus(task.status)
      ? await readTailMetadataIfExists(task.paths.stdoutLog, maxBytes)
      : emptyTailRead();
  const stderrError =
    !task.error && isFailedReadStatus(task.status)
      ? await readTailMetadataIfExists(task.paths.stderrLog, maxBytes)
      : emptyTailRead();
  const stderrErrorText = stderrError.text.trim();
  const error = task.error ?? (stderrErrorText || undefined);
  const aliases =
    taskIds ??
    (await listTaskIds({
      workspaceRoot: options.workspaceRoot,
      ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    }));
  const renderedOutput = output.text.length > 0 ? output : fallback;
  const outputKind =
    output.text.length > 0 ? "result" : fallback.text.length > 0 ? "stdout" : "none";
  const outputCaptureTruncated =
    outputKind === "result"
      ? (task.outputCapture?.resultTruncated ?? false)
      : outputKind === "stdout"
        ? (task.outputCapture?.stdoutTruncated ?? false)
        : false;
  const errorCaptureTruncated =
    Boolean(error && !task.error) && (task.outputCapture?.stderrTruncated ?? false);

  return {
    ...taskCommandSummary(task, aliases, { stopArgsSuffix: stopArgsSuffix(options) }),
    ...(metadata.retrievalStatus ? { retrievalStatus: metadata.retrievalStatus } : {}),
    output: renderedOutput.text,
    outputAvailable: renderedOutput.text.length > 0,
    outputKind,
    outputTruncated: renderedOutput.truncated || outputCaptureTruncated,
    outputTruncatedByReadLimit: renderedOutput.truncated,
    outputTruncatedByCaptureLimit: outputCaptureTruncated,
    maxBytes,
    ...(outputCaptureTruncated ? { captureMaxBytes: task.outputCapture?.maxBytes } : {}),
    ...(task.usage ? { usage: task.usage } : {}),
    ...(error ? { error } : {}),
    ...(error && !task.error && (stderrError.truncated || errorCaptureTruncated)
      ? {
          errorTruncated: true,
          errorTruncatedByReadLimit: stderrError.truncated,
          errorTruncatedByCaptureLimit: errorCaptureTruncated,
        }
      : {}),
  };
}

type TaskReadJsonPayload = Awaited<ReturnType<typeof taskReadJsonPayload>>;
type CompactTaskReadCommands = Partial<
  Pick<
    TaskReadJsonPayload["commands"],
    "read" | "readPreview" | "waitPreview" | "logs" | "logsPreview" | "events" | "agentEvents"
  >
>;
type CompactTaskReadJsonPayload = Omit<TaskReadJsonPayload, "commands"> & {
  commands?: CompactTaskReadCommands;
};

function compactTaskReadJsonPayload(payload: TaskReadJsonPayload): CompactTaskReadJsonPayload {
  const { commands, ...compact } = payload;
  if (readCanRecoverTruncatedOutput(payload)) {
    return { ...compact, commands: truncatedReadRecoveryCommands(commands) };
  }
  if (payload.active) {
    return { ...compact, commands: activeReadFollowupCommands(commands) };
  }
  if (payload.status === "failed" || payload.error) {
    return { ...compact, commands: failedReadFollowupCommands(commands) };
  }
  return compact;
}

function readCanRecoverTruncatedOutput(payload: TaskReadJsonPayload): boolean {
  return Boolean(payload.outputTruncatedByReadLimit || payload.errorTruncatedByReadLimit);
}

function truncatedReadRecoveryCommands(
  commands: TaskReadJsonPayload["commands"],
): CompactTaskReadCommands {
  return {
    read: commands.read,
    readPreview: commands.readPreview,
    logs: commands.logs,
    logsPreview: commands.logsPreview,
    events: commands.events,
    agentEvents: commands.agentEvents,
  };
}

function activeReadFollowupCommands(
  commands: TaskReadJsonPayload["commands"],
): CompactTaskReadCommands {
  return {
    readPreview: commands.readPreview,
    waitPreview: commands.waitPreview,
  };
}

function failedReadFollowupCommands(
  commands: TaskReadJsonPayload["commands"],
): CompactTaskReadCommands {
  return {
    logsPreview: commands.logsPreview,
    events: commands.events,
    agentEvents: commands.agentEvents,
  };
}

function briefTaskSummaryJsonPayload(
  payload: TaskCommandSummary,
  brief: boolean,
): TaskCommandSummary | Omit<TaskCommandSummary, "commands"> {
  if (!brief) {
    return payload;
  }
  const { commands: _commands, ...compact } = payload;
  return compact;
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

function writeRunJsonStreamEvent(event: RunStreamEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
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
  if (task.model) {
    return task.model;
  }

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
  return summarizeTaskPrompt(promptArg);
}

function summarizeTaskPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return "";
  }
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
}

function requireValue(args: readonly string[], index: number, option: string): string {
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

function parseIntegerOption(value: string, option: string): number {
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

function parseTaskStatus(value: string, option: string): TaskStatus {
  if ((TASK_STATUSES as readonly string[]).includes(value)) {
    return value as TaskStatus;
  }

  throw new CliError(`${option} must be one of: ${TASK_STATUSES.join(", ")}.`, {
    reason: "invalid_option_value",
    input: value,
    hint: `Use ${option} with one of: ${TASK_STATUSES.join(", ")}.`,
  });
}

function parseTaskName(value: string): string {
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

function parseLogStream(value: string): LogStream {
  if (value === "stdout" || value === "stderr" || value === "all") {
    return value;
  }
  throw new CliError("--stream must be one of: stdout, stderr, all.", {
    reason: "invalid_option_value",
    input: value,
    hint: "Use --stream stdout, --stream stderr, or --stream all.",
  });
}

function parseParentToolTraceMode(value: string, option: string): ParentToolTraceMode {
  if (value === "text" || value === "jsonl") {
    return value;
  }
  throw new CliError(`${option} must be text or jsonl.`, {
    reason: "invalid_option_value",
    input: value,
    hint: "Use --trace-tools=text or --trace-tools=jsonl.",
  });
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(path);
  const contents = await readFile(path);

  if (fileStat.size <= maxBytes) {
    return contents.toString("utf8");
  }

  return contents.subarray(contents.byteLength - maxBytes).toString("utf8");
}

function emptyTailRead(): TailRead {
  return {
    text: "",
    truncated: false,
  };
}

async function readTailMetadata(path: string, maxBytes: number): Promise<TailRead> {
  const fileStat = await stat(path);
  const contents = await readFile(path);
  const truncated = fileStat.size > maxBytes;

  return {
    text: truncated
      ? contents.subarray(contents.byteLength - maxBytes).toString("utf8")
      : contents.toString("utf8"),
    truncated,
  };
}

async function readTailMetadataIfExists(path: string, maxBytes: number): Promise<TailRead> {
  try {
    return await readTailMetadata(path, maxBytes);
  } catch (error) {
    if (isMissingFile(error)) {
      return emptyTailRead();
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
  agentOnly: boolean,
): { output: string; remainder: string } {
  const combined = remainder + text;
  const lines = combined.split("\n");
  const nextRemainder = combined.endsWith("\n") ? "" : (lines.pop() ?? "");
  const completeLines = combined.endsWith("\n") ? lines.slice(0, -1) : lines;

  const renderedLines = agentOnly ? completeLines.filter(isAgentEventLine) : completeLines;

  if (json) {
    const output = renderedLines
      .filter((line) => line.trim().length > 0)
      .map((line) => `${line}\n`)
      .join("");
    return { output, remainder: nextRemainder };
  }

  const output = renderedLines
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

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
