import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AuthStorage, ModelRegistry, type AuthCredential } from "@earendil-works/pi-coding-agent";
import { getDefaultOrchestratorAgentDir } from "./session.ts";

export type DoctorStatus = "ok" | "warning" | "error";

export type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorStatus;
  path?: string;
  message: string;
  details?: Record<string, unknown>;
};

export type ParentAgentDoctorOptions = {
  agentDir?: string;
  sessionDir?: string;
  homeDir?: string;
};

export type ParentAgentDoctorReport = {
  status: DoctorStatus;
  canRunParentAgent: boolean;
  agentDir: string;
  authPath: string;
  modelsPath: string;
  sessionDir: string;
  piAgentDir: string;
  checks: DoctorCheck[];
  suggestions: string[];
};

type JsonReadResult =
  | {
      exists: false;
    }
  | {
      exists: true;
      value?: unknown;
      error?: string;
    };

type AuthStorageData = Record<string, AuthCredential>;

type ConfiguredModelInspection =
  | {
      count: number;
    }
  | {
      error: string;
    };

export async function doctorParentAgentConfig(
  options: ParentAgentDoctorOptions = {},
): Promise<ParentAgentDoctorReport> {
  const homeDir = resolve(options.homeDir ?? homedir());
  const agentDir = resolve(options.agentDir ?? getDefaultOrchestratorAgentDir(homeDir));
  const authPath = join(agentDir, "auth.json");
  const modelsPath = join(agentDir, "models.json");
  const sessionDir = resolve(options.sessionDir ?? join(agentDir, "sessions"));
  const piAgentDir = join(homeDir, ".pi", "agent");
  const checks: DoctorCheck[] = [];

  checks.push(await checkDirectory("agent-dir", "Agent config directory", agentDir, "required"));

  const authRead = await readJson(authPath);
  const authProviders = authProviderNames(authRead);
  const authDoctorCheck = authCheck(authPath, authRead, authProviders);
  checks.push(authDoctorCheck);

  const modelsRead = await readJson(modelsPath);
  checks.push(modelsCheck(modelsPath, modelsRead));

  checks.push(
    await checkDirectory("sessions-dir", "Parent session directory", sessionDir, "created"),
  );

  const configuredModels =
    authDoctorCheck.status !== "error" &&
    authRead.exists &&
    !authRead.error &&
    isRecord(authRead.value)
      ? inspectConfiguredModels(authRead.value, modelsPath)
      : undefined;
  const configuredModelCount =
    configuredModels && "count" in configuredModels ? configuredModels.count : undefined;
  if (configuredModels && "error" in configuredModels) {
    checks.push({
      id: "configured-models",
      label: "Configured parent models",
      status: "error",
      message: `Cannot load configured parent models: ${configuredModels.error}`,
    });
  } else if (configuredModelCount !== undefined) {
    checks.push({
      id: "configured-models",
      label: "Configured parent models",
      status: configuredModelCount > 0 ? "ok" : "warning",
      message:
        configuredModelCount > 0
          ? `${configuredModelCount} model(s) have configured auth.`
          : "No model has configured auth under this agent directory.",
      details: { count: configuredModelCount },
    });
  }

  const suggestions = await buildSuggestions({
    homeDir,
    agentDir,
    authRead,
    authProviders,
    modelsRead,
    sessionDir,
    piAgentDir,
    configuredModelCount,
  });
  const status = overallStatus(checks);

  return {
    status,
    canRunParentAgent:
      status !== "error" &&
      (configuredModelCount === undefined ? authProviders.length > 0 : configuredModelCount > 0),
    agentDir,
    authPath,
    modelsPath,
    sessionDir,
    piAgentDir,
    checks,
    suggestions,
  };
}

async function checkDirectory(
  id: string,
  label: string,
  path: string,
  missingKind: "required" | "created",
): Promise<DoctorCheck> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isDirectory()) {
      return {
        id,
        label,
        status: "error",
        path,
        message: "Path exists but is not a directory.",
      };
    }

    return {
      id,
      label,
      status: "ok",
      path,
      message: "Directory exists.",
    };
  } catch (error) {
    if (isMissingFile(error)) {
      return {
        id,
        label,
        status: missingKind === "required" ? "warning" : "ok",
        path,
        message:
          missingKind === "required"
            ? "Directory does not exist yet."
            : "Directory does not exist yet; it will be created when the parent agent runs.",
      };
    }
    return {
      id,
      label,
      status: "error",
      path,
      message: errorMessage(error),
    };
  }
}

async function readJson(path: string): Promise<JsonReadResult> {
  try {
    return {
      exists: true,
      value: JSON.parse(await readFile(path, "utf8")),
    };
  } catch (error) {
    if (isMissingFile(error)) {
      return { exists: false };
    }
    return {
      exists: true,
      error: errorMessage(error),
    };
  }
}

function authCheck(path: string, read: JsonReadResult, providers: readonly string[]): DoctorCheck {
  if (!read.exists) {
    return {
      id: "auth-json",
      label: "Parent auth file",
      status: "warning",
      path,
      message: "Missing auth.json. The parent AI agent may not have provider credentials.",
    };
  }
  if (read.error) {
    return {
      id: "auth-json",
      label: "Parent auth file",
      status: "error",
      path,
      message: `Cannot parse auth.json: ${read.error}`,
    };
  }
  if (!isRecord(read.value)) {
    return {
      id: "auth-json",
      label: "Parent auth file",
      status: "error",
      path,
      message: "auth.json must be a JSON object.",
    };
  }
  const credentialErrors = authCredentialErrors(read.value);
  if (credentialErrors.length > 0) {
    return {
      id: "auth-json",
      label: "Parent auth file",
      status: "error",
      path,
      message: "auth.json contains invalid credential entries.",
      details: { errors: credentialErrors },
    };
  }
  if (providers.length === 0) {
    return {
      id: "auth-json",
      label: "Parent auth file",
      status: "warning",
      path,
      message: "auth.json exists but does not contain provider credentials.",
      details: { providers: [] },
    };
  }

  return {
    id: "auth-json",
    label: "Parent auth file",
    status: "ok",
    path,
    message: `${providers.length} provider credential(s) found.`,
    details: { providers },
  };
}

function authCredentialErrors(authData: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [provider, credential] of Object.entries(authData)) {
    if (credential === undefined || credential === null) {
      continue;
    }
    if (!isRecord(credential)) {
      errors.push(`${provider}: credential must be a JSON object.`);
      continue;
    }
    if (credential.type === "api_key") {
      if (typeof credential.key !== "string" || credential.key.trim().length === 0) {
        errors.push(`${provider}: api_key credential must include a non-empty "key".`);
      }
      continue;
    }
    if (credential.type === "oauth") {
      continue;
    }
    errors.push(`${provider}: credential type must be "api_key" or "oauth".`);
  }
  return errors;
}

function modelsCheck(path: string, read: JsonReadResult): DoctorCheck {
  if (!read.exists) {
    return {
      id: "models-json",
      label: "Parent model config",
      status: "ok",
      path,
      message: "models.json is missing. Built-in provider models can still work.",
    };
  }
  if (read.error) {
    return {
      id: "models-json",
      label: "Parent model config",
      status: "error",
      path,
      message: `Cannot parse models.json: ${read.error}`,
    };
  }
  if (!isRecord(read.value)) {
    return {
      id: "models-json",
      label: "Parent model config",
      status: "error",
      path,
      message: "models.json must be a JSON object.",
    };
  }

  return {
    id: "models-json",
    label: "Parent model config",
    status: "ok",
    path,
    message: "models.json is valid JSON.",
  };
}

function inspectConfiguredModels(
  authData: Record<string, unknown>,
  modelsPath: string,
): ConfiguredModelInspection | undefined {
  try {
    const authStorage = AuthStorage.inMemory(authData as AuthStorageData);
    const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
    const registryError = modelRegistry.getError();
    if (registryError) {
      return { error: registryError };
    }
    return { count: modelRegistry.getAvailable().length };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function buildSuggestions(input: {
  homeDir: string;
  agentDir: string;
  authRead: JsonReadResult;
  authProviders: readonly string[];
  modelsRead: JsonReadResult;
  sessionDir: string;
  piAgentDir: string;
  configuredModelCount: number | undefined;
}): Promise<string[]> {
  const suggestions: string[] = [];
  const usingDefaultAgentDir = input.agentDir === getDefaultOrchestratorAgentDir(input.homeDir);
  const piConfigExists = await directoryExists(input.piAgentDir);

  if (
    usingDefaultAgentDir &&
    piConfigExists &&
    (!input.authRead.exists || input.authProviders.length === 0)
  ) {
    suggestions.push(
      `Existing Pi config found at ${input.piAgentDir}. For a live test, run: orchestrator run --agent-dir ${input.piAgentDir} "<request>"`,
    );
    suggestions.push(
      `Inspect that config with: orchestrator doctor --agent-dir ${input.piAgentDir}`,
    );
  }

  if (!input.authRead.exists) {
    suggestions.push(`Add parent-agent auth at ${join(input.agentDir, "auth.json")}.`);
  } else if (input.authProviders.length === 0) {
    suggestions.push(
      `Add at least one provider credential to ${join(input.agentDir, "auth.json")}.`,
    );
  }

  if (!input.modelsRead.exists) {
    suggestions.push(
      `Add ${join(input.agentDir, "models.json")} only if you need custom providers or model defaults.`,
    );
  }

  if (input.configuredModelCount === 0) {
    suggestions.push(
      "No configured parent model was detected. Check auth/provider model settings.",
    );
  }

  suggestions.push(`Parent sessions will be stored in ${input.sessionDir}.`);
  return dedupe(suggestions);
}

function authProviderNames(read: JsonReadResult): string[] {
  if (!read.exists || read.error || !isRecord(read.value)) {
    return [];
  }

  return Object.entries(read.value)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([provider]) => provider)
    .sort((a, b) => a.localeCompare(b));
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function overallStatus(checks: readonly DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "error")) {
    return "error";
  }
  if (checks.some((check) => check.status === "warning")) {
    return "warning";
  }
  return "ok";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
