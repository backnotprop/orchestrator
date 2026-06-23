import {
  doctorParentAgentConfig,
  type ParentAgentDoctorReport,
} from "@backnotprop/orchestrator-agent";
import { loadConfiguredRuntimeRegistry } from "@backnotprop/orchestrator-core";
import { jsonLine } from "../json-output.ts";
import { doctorRuntimeAvailability, type RuntimeDoctorCheck } from "../runtime-doctor.ts";

export type DoctorOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
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

export async function commandDoctor(options: DoctorOptions): Promise<number> {
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
  const canRunParentAgent = Boolean(parentRun);

  return {
    schemaVersion: 1,
    status: report.status,
    canRunParentAgent,
    canLaunchChildAgents: report.runtimeSummary.available > 0,
    parent: {
      canRun: canRunParentAgent,
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
