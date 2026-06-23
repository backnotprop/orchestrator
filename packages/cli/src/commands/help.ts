import {
  ALL_AGENT_RUNTIMES,
  BUILT_IN_AGENT_RUNTIMES,
  loadConfiguredRuntimeRegistry,
  type HeadlessAgentRuntimeConfig,
  type RuntimeRegistry,
} from "@backnotprop/orchestrator-core";
import { jsonLine } from "../json-output.ts";

export type HelpOptions = {
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

export async function commandHelp(options: HelpOptions): Promise<void> {
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

export function buildCliHelpText(registry: RuntimeRegistry = BUILT_IN_AGENT_RUNTIMES): string {
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
  orchestrator launch -f <manifest.json|-> --json [--compact [--brief]]
  orchestrator list [--status <status>] [-A|--all-workspaces] [--json]
  orchestrator ps [--all] [-A|--all-workspaces] [--cwd <path>] [--watch] [--runtime <runtime>] [--status <status>] [--parent <run-id>] [--json [--compact [--active] [--brief]]]
  orchestrator read <task-id|prefix>... [--wait] [--timeout-ms <ms>] [--interval-ms <ms>] [--max-bytes <bytes>] [--json [--compact]]
  orchestrator logs <task-id|prefix> [--stream stdout|stderr|all] [--max-bytes <bytes>] [--follow] [--json [--compact]]
  orchestrator events <task-id|prefix> [--agent-only] [--max-bytes <bytes>] [--json [--compact]]
  orchestrator watch <task-id|prefix> [--agent-only] [--interval-ms <ms>] [--json]
  orchestrator interrupt <task-id|prefix>... [--reason <text>] [--json [--compact]]
  orchestrator interrupt <task-id|prefix> [--children|--task-only] [--reason <text>] [--json [--compact]]
  orchestrator interrupt --parent <task-id|prefix> --children [--reason <text>] [--json [--compact]]
  orchestrator interrupt --group <group-id|prefix> [--reason <text>] [--json [--compact]]
  orchestrator interrupt --active [-A|--all-workspaces --yes] [--reason <text>] [--json [--compact]]
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
  9. Orchestrator uses one default machine store at ~/.orchestrator/tasks; workspace is a project scope/filter, and cwd is the agent process directory.
  10. Task commands accept full task ids or unique prefixes shown by ps/list from the same store.
  11. Common options like --workspace, --orchestrator-dir, --config, and --json may appear before or after the command.
  12. Prefer launch --json --compact and ps --json --compact for normal agent control.
  13. Use help --json --compact when software needs a smaller command contract.
  14. When --json is present, command errors are JSON on stderr with reason/input/matches/hint and recovery.views.*.args when available.
  15. Use ps for the current workspace operations view; use ps -A for all workspaces.
  16. Use ps --watch to watch the selected scope update live.
  17. Use ps --json --compact --active when an agent or script needs active task and stop targets.
  18. Use ps --json --compact --active --brief to scan many running tasks with less JSON.
  19. Use ps -A --json --compact --active --brief to scan active work across the machine.
  20. Use ps --parent <run-id|prefix> --json --compact --brief to inspect one parent run and its children.
  21. If active ps is empty after short work, run views.recent.args from compact ps to recover recent finished tasks and batch read commands.
  22. Use launch -f <manifest.json|-> --json --compact --brief to start several tasks in one call.
  23. Use launch --json --compact --brief when starting one task and only task id/status/stop is needed.
  24. When compact JSON returns stop.args, run those portable args to stop exactly the returned task, group, or selected active set.
  25. Compact ps stop.args are scoped to the current view; parent/group stops may include children of that selected run.
  26. When JSON output returns commands.*.args, pass those portable args to orchestrator for read/watch/logs/events follow-up.
  27. Treat returned args as an argument vector. Do not join them into one shell string.
  28. Use compact ps top-level commands.waitPreview.args to wait for every listed task with bounded output.
  29. Use compact ps group commands.waitPreview.args to wait for one listed group with bounded output.
  30. Use commands.readPreview, commands.waitPreview, or commands.logsPreview when another agent needs bounded output before deciding whether to fetch more.
  31. Use watch to follow one task live. Use watch --agent-only --json for normalized agent event JSONL.
  32. Use read for final agent answers. Use read <id> <id> --wait --json --compact to build your own multi-task wait call.
  33. If compact read returns active: true, use commands.waitPreview.args to wait with bounded output or commands.readPreview.args to poll again.
  34. If compact batch read times out, use its top-level commands.waitPreview.args to wait again or stop.args to stop still-active work safely.
  35. If compact read returns failed status, use commands.logsPreview.args for bounded raw logs or commands.events.args for the task timeline.
  36. Check outputTruncated/stdoutTruncated/stderrTruncated in JSON output; ByReadLimit means re-read with more bytes can help, ByCaptureLimit means the task was launched with too small a capture cap.
  37. If compact read is truncated by read limit, use commands.read.args to fetch more output.
  38. Use logs --json --compact for a one-line raw stdout/stderr snapshot and events --json --compact for a one-line task timeline.
  39. Use interrupt to cancel running agents. Use interrupt <id> <id> --json --compact to stop a selected subset.
  40. Use --children for parent runs with children.
  41. Use interrupt --active only for deliberate workspace cleanup; use interrupt -A --active --yes only for deliberate all-workspace cleanup.
  42. Model values are passed through to the provider CLI; aliases are not normalized yet.

Common options:
  --workspace <path>          Workspace scope. Defaults to the nearest git repo, then current directory.
  --orchestrator-dir <path>   Advanced store override. Defaults to ~/.orchestrator.
  --config <path>             Extra config file. Defaults also load global and workspace config.
  --json                      Print machine-readable JSON when the command supports it.

Launch options:
  -f, --file <path|->       Launch several tasks from a JSON manifest file or stdin.
  --name <name>               Short label shown in list output.
  --model <model>             Runtime model hint, for example sonnet or gpt-5.4-mini.
  --cwd <path>                Process directory. Defaults to the workspace; relative paths resolve inside the workspace.
  --output-mode <mode>        Adapter-selected output mode.
  --timeout-ms <ms>           Override runtime timeout.
  --max-output-bytes <bytes>  Override captured output cap.
  --wait                      Run in the foreground until the task completes.
  --compact                   With --json, print a small launch result for agents/scripts.
  --brief                     With --compact, omit follow-up command bundles.

Ps options:
  -A, --all-workspaces        Show tasks across every workspace in the selected store.
  --all                       Show full task history instead of hiding old finished tasks.
  --cwd <path>                Filter tasks by process cwd. Relative paths resolve inside the workspace.
  --watch                     Refresh the grouped view until interrupted.
  --interval-ms <ms>          Refresh interval for --watch.
  --runtime <runtime>         Filter to one runtime.
  --status <status>           Filter to one task status.
  --parent <run-id|ungrouped> Filter to one parent group.
  --compact                   With --json, print compact task/group control data.
  --active                    With --compact, include only non-terminal tasks.
  --brief                     With --compact, omit repeated follow-up command bundles.

Interrupt options:
  -A, --all-workspaces        With --active, select active tasks across every workspace.
  --yes                       Required with -A --active.
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

Advanced launch options:
  --allow-disabled-runtime    Permit launching disabled runtimes.
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
      "Use launch -f <manifest.json|-> --json --compact --brief when software needs to start several tasks in one call.",
      "Orchestrator uses one default machine store at ~/.orchestrator/tasks; workspace is project scope, and cwd is the agent process directory.",
      "Capture taskId from launch output. Task commands accept the full id or a unique prefix shown by ps/list from the same store.",
      "Common options like --workspace, --orchestrator-dir, --config, and --json may appear before or after the command.",
      "Prefer launch --json --compact and ps --json --compact for normal agent control.",
      "Use help --json --compact when software needs a smaller command contract; use help --json for the full contract.",
      "When --json is present, command errors are JSON on stderr with reason/input/matches/hint and recovery.views.*.args when available.",
      "Use ps for the current workspace operations view. It hides old finished tasks by default.",
      "Use ps -A for all workspaces.",
      "Use ps --all for full task history in the selected workspace.",
      "Use ps -A --all for full task history across all workspaces.",
      "Use ps --watch to watch the selected scope update live.",
      "Use ps --json --compact --active when an agent or script needs active task and stop targets.",
      "Use ps --json --compact --active --brief to scan many running tasks with less JSON.",
      "Use ps -A --json --compact --active --brief to scan active work across the machine.",
      "Use ps --parent <run-id|prefix> --json --compact --brief when software needs one parent run and its children.",
      "If active ps is empty after short work, run views.recent.args from compact ps to recover recent finished tasks and batch read commands.",
      "Use launch --json --compact --brief for one compact task result, or launch -f <manifest.json|-> --json --compact --brief to start several tasks from a manifest.",
      "After starting several tasks, use the returned commands.waitPreview.args or run ps --json --compact --brief to collect the listed set.",
      "When JSON output returns stop.args, pass those portable args to orchestrator to stop exactly the returned task, group, or selected active set.",
      "Compact ps stop.args are scoped to the current view; parent/group stops may include children of that selected run.",
      "When JSON output returns commands.*.args, pass those portable args to orchestrator for read/watch/logs/events follow-up.",
      "Treat returned args as an argument vector. Do not join them into one shell string.",
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
      "Use interrupt --active --json --compact only for deliberate workspace cleanup when every active task in the selected workspace should stop; it is safe when none are active.",
      "Use interrupt -A --active --yes --json --compact only for deliberate all-workspace cleanup.",
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
          'orchestrator launch <runtime> [--name <name>] [--model <model>] [--cwd <path>] [--wait] [--json [--compact [--brief]]] "<task>"; or orchestrator launch -f <manifest.json|-> --json [--compact [--brief]]',
        semantics:
          "Starts one agent task, or starts several normal tasks from a JSON manifest with -f.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--json",
          "-f <manifest.json|->",
          "--file <manifest.json|->",
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
        usage: "orchestrator list [--status <status>] [-A|--all-workspaces] [--json]",
        semantics: "Lists task records in the current workspace scope, or all workspaces with -A.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--status <status>",
          "-A",
          "--all-workspaces",
          "--json",
        ],
      },
      {
        name: "ps",
        usage:
          "orchestrator ps [--all] [-A|--all-workspaces] [--cwd <path>] [--watch] [--runtime <runtime>] [--status <status>] [--parent <run-id>] [--json [--compact [--active] [--brief]]]",
        semantics:
          "Shows grouped agent work in the current workspace scope, or all workspaces with -A.",
        options: [
          "--workspace <path>",
          "--orchestrator-dir <path>",
          "--config <path>",
          "--status <status>",
          "--runtime <runtime>",
          "--parent <run-id|ungrouped>",
          "--all",
          "-A",
          "--all-workspaces",
          "--cwd <path>",
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
          "orchestrator interrupt <task-id|prefix>...|--parent <id>|--group <id>|--active [-A|--all-workspaces --yes] [--children|--task-only] [--reason <text>] [--signal <signal>] [--json [--compact]]",
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
          "-A",
          "--all-workspaces",
          "--yes",
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
          "Add --brief to compact launch when one task only needs id/status/stop.",
          "Use launch -f <manifest.json|-> --json --compact --brief when several tasks should start from one manifest.",
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
    "orchestrator ps -A --json --compact --active --brief",
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
        ? ["Start many tasks with launch -f <manifest.json|-> --json --compact --brief."]
        : ["If runtimeIds is empty, do not call launch; add or enable an agent config first."]),
      "Find running tasks with ps --json --compact --active --brief.",
      "Narrow one parent run with ps --parent <run-id|prefix> --json --compact --brief.",
      "If active ps is empty after short work, run views.recent.args from compact ps to recover recent tasks.",
      "Collect listed tasks with top-level commands.waitPreview.args from compact ps.",
      "Treat returned args arrays as argument vectors; do not join them into one shell string.",
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
  examples.push("orchestrator launch -f agents.json --json --compact --brief");
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
    "orchestrator ps -A",
    "orchestrator ps -A --all",
    "orchestrator ps -A --json --compact --active --brief",
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
    'orchestrator interrupt --active --json --compact --reason "workspace cleanup"',
    'orchestrator interrupt -A --active --yes --json --compact --reason "all-workspace cleanup"',
  ];
}
