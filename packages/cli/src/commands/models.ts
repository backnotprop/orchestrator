import {
  ALL_AGENT_RUNTIMES,
  getEnabledAgentRuntimes,
  loadConfiguredRuntimeRegistry,
  type HeadlessAgentRuntimeConfig,
  type RuntimeRegistry,
} from "@backnotprop/orchestrator-core/runtime";
import {
  DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
  readRuntimeModels,
  type RuntimeModel,
  type RuntimeModelCatalog,
  type RuntimeModelsReport,
} from "@backnotprop/orchestrator-core/model-discovery";
import { CliError } from "../cli-errors.ts";
import { jsonLine } from "../json-output.ts";

export type ModelsOptions = {
  readonly workspaceRoot: string;
  readonly orchestratorDir?: string;
  readonly configPath?: string;
  readonly json: boolean;
  readonly compact: boolean;
  readonly runtimeId?: string;
  readonly timeoutMs: number;
};

type CompactRuntimeModel = Pick<RuntimeModel, "id" | "kind"> & {
  readonly displayName?: string;
  readonly provider?: string;
  readonly isDefault?: boolean;
};

type CompactRuntimeModelCatalog = {
  readonly id: string;
  readonly status: RuntimeModelCatalog["status"];
  readonly source: string;
  readonly cliVersion?: string;
  readonly defaultModel?: string;
  readonly models: readonly CompactRuntimeModel[];
  readonly error?: RuntimeModelCatalog["error"];
};

type CompactRuntimeModelsReport = {
  readonly schemaVersion: 1;
  readonly runtimes: readonly CompactRuntimeModelCatalog[];
  readonly fullModels: { readonly args: readonly string[] };
};

export async function commandModels(options: ModelsOptions): Promise<void> {
  const { registry } = await loadConfiguredRuntimeRegistry({
    workspaceRoot: options.workspaceRoot,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });
  const runtimes = selectModelRuntimes(registry, options.runtimeId);
  const report = await readRuntimeModels({
    runtimes,
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    timeoutMs: options.timeoutMs,
  });

  if (options.json) {
    const rendered = options.compact ? compactModelsReport(report, options) : report;
    process.stdout.write(jsonLine(rendered, { compact: options.compact }));
    return;
  }

  process.stdout.write(renderModelsReport(report));
}

function selectModelRuntimes(
  registry: RuntimeRegistry,
  runtimeId: string | undefined,
): readonly HeadlessAgentRuntimeConfig[] {
  if (runtimeId) {
    const runtime = registry[runtimeId];
    if (!runtime) {
      throw new CliError(`Unknown runtime "${runtimeId}".`, {
        reason: "unknown_runtime",
        input: runtimeId,
        matches: orderedEnabledRuntimes(registry).map((candidate) => candidate.id),
        hint: "Run orchestrator help --json --compact to list configured runtime ids.",
      });
    }
    if (!runtime.enabled) {
      throw new CliError(`Runtime "${runtimeId}" is disabled.`, {
        reason: "disabled_runtime",
        input: runtimeId,
        hint: "Enable the runtime in Orchestrator config before discovering its models.",
      });
    }
    return [runtime];
  }

  return orderedEnabledRuntimes(registry).filter(runtimeAcceptsModel);
}

function orderedEnabledRuntimes(registry: RuntimeRegistry): readonly HeadlessAgentRuntimeConfig[] {
  const builtInIds = new Set<string>(ALL_AGENT_RUNTIMES);
  const enabled = getEnabledAgentRuntimes(registry);
  const builtIn = ALL_AGENT_RUNTIMES.flatMap((id) => {
    const runtime = registry[id];
    return runtime?.enabled ? [runtime] : [];
  });
  const custom = enabled
    .filter((runtime) => !builtInIds.has(runtime.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  return [...builtIn, ...custom];
}

function runtimeAcceptsModel(runtime: HeadlessAgentRuntimeConfig): boolean {
  return (
    runtime.id === "codex-app-server" ||
    Boolean(runtime.launch.modelFlag) ||
    runtime.launch.baseArgs.some((arg) => arg.includes("{model}"))
  );
}

function compactModelsReport(
  report: RuntimeModelsReport,
  options: Pick<
    ModelsOptions,
    "workspaceRoot" | "orchestratorDir" | "configPath" | "runtimeId" | "timeoutMs"
  >,
): CompactRuntimeModelsReport {
  return {
    schemaVersion: report.schemaVersion,
    runtimes: report.runtimes.map((runtime) => ({
      id: runtime.runtime,
      status: runtime.status,
      source: runtime.source,
      ...(runtime.cliVersion ? { cliVersion: runtime.cliVersion } : {}),
      ...(runtime.defaultModel ? { defaultModel: runtime.defaultModel } : {}),
      models: runtime.models.map((model) => ({
        id: model.id,
        kind: model.kind,
        ...(model.displayName && model.displayName !== model.id
          ? { displayName: model.displayName }
          : {}),
        ...(model.provider ? { provider: model.provider } : {}),
        ...(model.isDefault ? { isDefault: true } : {}),
      })),
      ...(runtime.error ? { error: runtime.error } : {}),
    })),
    fullModels: { args: ["models", "--json", ...modelsArgsSuffix(options)] },
  };
}

function renderModelsReport(report: RuntimeModelsReport): string {
  if (report.runtimes.length === 0) {
    return "No model-capable runtimes are enabled.\n";
  }

  const rows = [
    ["runtime", "status", "model", "kind", "default", "source"],
    ...report.runtimes.flatMap((runtime) => modelRows(runtime)),
  ];
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
    .concat("\n");
}

function modelRows(runtime: RuntimeModelCatalog): string[][] {
  if (runtime.models.length === 0) {
    return [
      [
        runtime.runtime,
        runtime.status,
        "-",
        "-",
        "-",
        runtime.error ? `${runtime.source} (${runtime.error.code})` : runtime.source,
      ],
    ];
  }

  return runtime.models.map((model) => [
    runtime.runtime,
    runtime.status,
    model.id,
    model.kind,
    model.isDefault || model.id === runtime.defaultModel ? "yes" : "-",
    runtime.source,
  ]);
}

function modelsArgsSuffix(
  options: Pick<
    ModelsOptions,
    "workspaceRoot" | "orchestratorDir" | "configPath" | "runtimeId" | "timeoutMs"
  >,
): string[] {
  return [
    ...(options.runtimeId ? [options.runtimeId] : []),
    "--workspace",
    options.workspaceRoot,
    ...(options.orchestratorDir ? ["--orchestrator-dir", options.orchestratorDir] : []),
    ...(options.configPath ? ["--config", options.configPath] : []),
    ...(options.timeoutMs !== DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS
      ? ["--timeout-ms", String(options.timeoutMs)]
      : []),
  ];
}
