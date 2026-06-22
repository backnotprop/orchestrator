import { resolve } from "node:path";
import { cliErrorJson } from "./cli-errors.ts";
import { compactPsViewCommands, type PsViewCommands } from "./ps-view-commands.ts";

export function cliErrorJsonWithRecovery(error: unknown, argv: readonly string[]): unknown {
  const payload = cliErrorJson(error);
  const recovery = errorRecovery(error, argv);
  return recovery ? { ...payload, recovery } : payload;
}

function errorRecovery(
  error: unknown,
  argv: readonly string[],
): { views: PsViewCommands } | undefined {
  if (!isTaskLookupRecoveryError(error)) {
    return undefined;
  }
  return { views: compactPsViewCommands(recoveryCommonOptionsFromArgv(argv)) };
}

function isTaskLookupRecoveryError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const name = (error as { name?: unknown }).name;
  const reason = (error as { reason?: unknown }).reason;
  return (
    (name === "TaskLookupError" ||
      name === "TaskGroupLookupError" ||
      reason === "ambiguous_group") &&
    (reason === "ambiguous" || reason === "not_found" || reason === "ambiguous_group")
  );
}

function recoveryCommonOptionsFromArgv(argv: readonly string[]): {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
} {
  const common: {
    workspaceRoot: string;
    orchestratorDir?: string;
    configPath?: string;
  } = { workspaceRoot: process.cwd() };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      break;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      continue;
    }

    if (arg === "--workspace") {
      common.workspaceRoot = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--orchestrator-dir") {
      common.orchestratorDir = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--config") {
      common.configPath = resolve(value);
      index += 1;
    }
  }

  return common;
}
