import {
  DEFAULT_PROVIDER_LIMIT_TIMEOUT_MS,
  readProviderLimits,
  type BuiltInProviderLimitProvider,
  type ProviderLimitSnapshot,
  type ProviderLimitsReport,
} from "@backnotprop/orchestrator-core/provider-limits";
import { jsonLine } from "../json-output.ts";

export type LimitsOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  compact: boolean;
  provider?: BuiltInProviderLimitProvider;
  timeoutMs: number;
};

type CompactProviderLimitSnapshot = {
  id: string;
  status: ProviderLimitSnapshot["status"];
  account?: string;
  primaryUsedPercent?: number;
  primaryReset?: string;
  secondaryUsedPercent?: number;
  secondaryReset?: string;
  resetCreditsAvailable?: number;
  error?: ProviderLimitSnapshot["error"];
};

type CompactProviderLimitsReport = {
  schemaVersion: 1;
  providers: CompactProviderLimitSnapshot[];
  fullLimits: { args: readonly string[] };
};

export async function commandLimits(options: LimitsOptions): Promise<void> {
  const report = await readProviderLimits({
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    timeoutMs: options.timeoutMs,
    ...(options.provider ? { providers: [options.provider] } : {}),
  });

  if (options.json) {
    const rendered = options.compact ? compactLimitsReport(report, options) : report;
    process.stdout.write(jsonLine(rendered, { compact: options.compact }));
    return;
  }

  process.stdout.write(renderProviderLimits(report));
}

function compactLimitsReport(
  report: ProviderLimitsReport,
  options: Pick<
    LimitsOptions,
    "workspaceRoot" | "orchestratorDir" | "configPath" | "provider" | "timeoutMs"
  >,
): CompactProviderLimitsReport {
  return {
    schemaVersion: report.schemaVersion,
    providers: report.providers.map((provider) => compactProvider(provider)),
    fullLimits: {
      args: ["limits", "--json", ...limitsArgsSuffix(options)],
    },
  };
}

function compactProvider(provider: ProviderLimitSnapshot): CompactProviderLimitSnapshot {
  const primary = provider.windows[0];
  const secondary = provider.windows[1];
  return {
    id: provider.provider,
    status: provider.status,
    ...optionalAccount(provider),
    ...(primary?.usedPercent !== undefined ? { primaryUsedPercent: primary.usedPercent } : {}),
    ...optionalReset("primaryReset", primary),
    ...(secondary?.usedPercent !== undefined
      ? { secondaryUsedPercent: secondary.usedPercent }
      : {}),
    ...optionalReset("secondaryReset", secondary),
    ...(provider.resetCredits?.availableCount !== undefined
      ? { resetCreditsAvailable: provider.resetCredits.availableCount }
      : {}),
    ...(provider.error ? { error: provider.error } : {}),
  };
}

function renderProviderLimits(report: ProviderLimitsReport): string {
  if (report.providers.length === 0) {
    return "No provider limits.\n";
  }

  const rows = [
    ["provider", "account", "status", "primary", "secondary", "reset", "reset credits"],
    ...report.providers.map((provider) => [
      provider.provider,
      accountLabel(provider),
      provider.status,
      windowLabel(provider.windows[0]),
      windowLabel(provider.windows[1]),
      resetLabel(provider),
      resetCreditsLabel(provider),
    ]),
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

function accountLabel(provider: ProviderLimitSnapshot): string {
  const account =
    provider.account?.email ??
    provider.account?.username ??
    provider.account?.organization ??
    provider.account?.plan;
  if (account) {
    return account;
  }

  return provider.status === "unavailable" ? "unavailable" : "-";
}

function optionalAccount(provider: ProviderLimitSnapshot): { account?: string } {
  const account =
    provider.account?.email ??
    provider.account?.username ??
    provider.account?.organization ??
    provider.account?.plan;
  return account ? { account } : {};
}

function windowLabel(window: ProviderLimitSnapshot["windows"][number] | undefined): string {
  if (!window) {
    return "-";
  }

  if (window.usedPercent !== undefined) {
    return `${window.usedPercent}% used`;
  }

  if (window.remainingPercent !== undefined) {
    return `${window.remainingPercent}% left`;
  }

  return window.limitDescription ?? "-";
}

function resetLabel(provider: ProviderLimitSnapshot): string {
  const window = provider.windows.find(
    (candidate) => candidate.resetsAt || candidate.resetDescription,
  );
  if (window?.resetDescription) {
    return window.resetDescription;
  }
  if (window?.resetsAt) {
    return window.resetsAt;
  }
  if (provider.resetCredits?.availableCount !== undefined) {
    return `${provider.resetCredits.availableCount} reset credits`;
  }
  if (provider.error?.code === "not_implemented") {
    return "not implemented";
  }
  return provider.error?.code ?? "-";
}

function resetCreditsLabel(provider: ProviderLimitSnapshot): string {
  if (provider.resetCredits?.availableCount === undefined) {
    return "-";
  }

  return `${provider.resetCredits.availableCount}`;
}

function limitsArgsSuffix(
  options: Pick<
    LimitsOptions,
    "workspaceRoot" | "orchestratorDir" | "configPath" | "provider" | "timeoutMs"
  >,
): string[] {
  return [
    "--workspace",
    options.workspaceRoot,
    ...(options.orchestratorDir ? ["--orchestrator-dir", options.orchestratorDir] : []),
    ...(options.configPath ? ["--config", options.configPath] : []),
    ...(options.provider ? ["--provider", options.provider] : []),
    ...(options.timeoutMs !== DEFAULT_PROVIDER_LIMIT_TIMEOUT_MS
      ? ["--timeout-ms", String(options.timeoutMs)]
      : []),
  ];
}

function optionalReset(
  key: "primaryReset" | "secondaryReset",
  window: ProviderLimitSnapshot["windows"][number] | undefined,
): Partial<Record<"primaryReset" | "secondaryReset", string>> {
  const reset = window?.resetDescription ?? window?.resetsAt;
  return reset ? { [key]: reset } : {};
}
