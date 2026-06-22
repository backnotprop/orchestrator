export type PsViewCommandOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  parentRunId?: string;
  runtime?: string;
};

export type PsViewCommands = {
  active: { args: string[] };
  recent: { args: string[] };
  all: { args: string[] };
};

export function compactPsViewCommands(options: PsViewCommandOptions): PsViewCommands {
  return {
    active: { args: compactPsViewArgs(options, { active: true }) },
    recent: { args: compactPsViewArgs(options, {}) },
    all: { args: compactPsViewArgs(options, { all: true }) },
  };
}

function compactPsViewArgs(
  options: PsViewCommandOptions,
  view: { active?: boolean; all?: boolean },
): string[] {
  return [
    "ps",
    ...(options.parentRunId ? ["--parent", options.parentRunId] : []),
    ...(options.runtime ? ["--runtime", options.runtime] : []),
    ...(view.all ? ["--all"] : []),
    "--json",
    "--compact",
    ...(view.active ? ["--active"] : []),
    "--brief",
    "--workspace",
    options.workspaceRoot,
    ...(options.orchestratorDir ? ["--orchestrator-dir", options.orchestratorDir] : []),
    ...(options.configPath ? ["--config", options.configPath] : []),
  ];
}
