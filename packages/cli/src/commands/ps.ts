import {
  buildAgentTaskPsView,
  compactAgentTaskPsView,
  listTaskIds,
  listTasks,
  loadConfiguredRuntimeRegistry,
  taskGroupId,
  UNGROUPED_GROUP_ID,
  type AgentTaskControlView,
  type AgentTaskPsView,
  type TaskStatus,
} from "@backnotprop/orchestrator-core";
import { CliError } from "../cli-errors.ts";
import { jsonLine } from "../json-output.ts";
import { compactPsViewCommands } from "../ps-view-commands.ts";
import { renderPsView } from "../render-ps.ts";
import { stopArgsSuffix } from "../task-output.ts";
import { countRenderedLines, renderWatchFrame, terminalColumns } from "../terminal-frame.ts";

export type PsOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  status?: TaskStatus;
  runtime?: string;
  parentRunId?: string;
  all: boolean;
  allWorkspaces: boolean;
  cwd?: string;
  watch: boolean;
  compact: boolean;
  brief: boolean;
  active: boolean;
  intervalMs: number;
};

type CommonPsOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
};

export async function commandPs(options: PsOptions): Promise<void> {
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
    ...(options.cwd ? { cwd: options.cwd } : {}),
    all: options.all,
    allWorkspaces: options.allWorkspaces,
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

function withPortableStopArgs<T extends AgentTaskControlView>(view: T, options: PsOptions): T {
  const taskSuffix = stopArgsSuffix(options);
  const viewSuffix = viewArgsSuffix(options);
  if (taskSuffix.length === 0 && viewSuffix.length === 0) {
    return view;
  }

  return {
    ...view,
    ...(view.commands ? { commands: appendControlCommandArgs(view.commands, taskSuffix) } : {}),
    ...(view.stop ? { stop: appendStopArgs(view.stop, taskSuffix) } : {}),
    groups: view.groups.map((group) => ({
      ...group,
      ...(group.commands
        ? { commands: appendGroupControlCommandArgs(group.commands, taskSuffix, viewSuffix) }
        : {}),
      ...(group.stop ? { stop: appendStopArgs(group.stop, taskSuffix) } : {}),
    })),
    tasks: view.tasks.map((task) => ({
      ...task,
      ...(task.commands ? { commands: appendControlCommandArgs(task.commands, taskSuffix) } : {}),
      ...(task.stop ? { stop: appendStopArgs(task.stop, taskSuffix) } : {}),
    })),
  };
}

function appendGroupControlCommandArgs<T extends Record<string, { args: string[] }>>(
  commands: T,
  taskSuffix: readonly string[],
  viewSuffix: readonly string[],
): T {
  return Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [
      name,
      {
        ...command,
        args: [
          ...command.args,
          ...(name === "ps" || name === "activePs" ? viewSuffix : taskSuffix),
        ],
      },
    ]),
  ) as T;
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

function viewArgsSuffix(
  options: CommonPsOptions & { allWorkspaces?: boolean; cwd?: string; configPath?: string },
): string[] {
  return [
    ...(options.allWorkspaces ? ["-A"] : ["--workspace", options.workspaceRoot]),
    ...(options.cwd ? ["--cwd", options.cwd] : []),
    ...(options.orchestratorDir ? ["--orchestrator-dir", options.orchestratorDir] : []),
    ...(options.configPath ? ["--config", options.configPath] : []),
  ];
}

function filterPsViewByParent(view: AgentTaskPsView, parentRunId: string): AgentTaskPsView {
  const groupId = resolvePsGroupId(view, parentRunId);
  if (!groupId) {
    return {
      generatedAt: view.generatedAt,
      scope: view.scope,
      groups: [],
      rows: [],
    };
  }
  const groups = view.groups.filter((group) => group.groupId === groupId);
  const groupIds = new Set(groups.map((group) => group.groupId));
  return {
    generatedAt: view.generatedAt,
    scope: view.scope,
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
