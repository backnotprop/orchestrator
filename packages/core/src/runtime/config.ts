import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BUILT_IN_AGENT_RUNTIMES } from "./runtimes.ts";
import type {
  HeadlessAgentRuntimeConfig,
  OutputTransport,
  PromptTransport,
  RuntimeRegistry,
} from "./types.ts";

export type OrchestratorConfigLoadOptions = {
  workspaceRoot?: string;
  configPath?: string;
  homeDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
  baseRegistry?: RuntimeRegistry;
};

export type ConfiguredRuntimeRegistry = {
  registry: RuntimeRegistry;
  loadedConfigPaths: readonly string[];
};

type ConfigSource = {
  path: string;
  required: boolean;
};

const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
const BUILT_IN_RUNTIME_IDS = new Set(Object.keys(BUILT_IN_AGENT_RUNTIMES));

export class OrchestratorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorConfigError";
  }
}

export function getDefaultOrchestratorConfigPaths(
  options: Pick<OrchestratorConfigLoadOptions, "workspaceRoot" | "homeDir" | "env"> = {},
): readonly string[] {
  return configSources(options).map((source) => source.path);
}

export async function loadConfiguredRuntimeRegistry(
  options: OrchestratorConfigLoadOptions = {},
): Promise<ConfiguredRuntimeRegistry> {
  const registry: Record<string, HeadlessAgentRuntimeConfig> = {};
  for (const runtime of Object.values(options.baseRegistry ?? BUILT_IN_AGENT_RUNTIMES)) {
    if (runtime) {
      registry[runtime.id] = runtime;
    }
  }
  const loadedConfigPaths: string[] = [];

  for (const source of configSources(options)) {
    const raw = await readConfigSource(source);
    if (raw === undefined) {
      continue;
    }

    loadedConfigPaths.push(source.path);
    for (const runtime of compileOrchestratorConfig(raw, source.path)) {
      if (BUILT_IN_RUNTIME_IDS.has(runtime.id)) {
        throw new OrchestratorConfigError(
          `${source.path}: custom agent "${runtime.id}" conflicts with a built-in runtime id.`,
        );
      }
      registry[runtime.id] = runtime;
    }
  }

  return { registry, loadedConfigPaths };
}

export function compileOrchestratorConfig(
  value: unknown,
  sourcePath = "orchestrator.config.json",
): HeadlessAgentRuntimeConfig[] {
  if (!isRecord(value)) {
    throw new OrchestratorConfigError(`${sourcePath}: config must be a JSON object.`);
  }

  const agents = optionalRecord(value, "agents", sourcePath);
  if (!agents) {
    return [];
  }

  return Object.entries(agents).map(([id, config]) => {
    if (!isValidRuntimeId(id)) {
      throw new OrchestratorConfigError(
        `${sourcePath}: agent id "${id}" must use letters, numbers, dots, dashes, or underscores.`,
      );
    }
    if (BUILT_IN_RUNTIME_IDS.has(id)) {
      throw new OrchestratorConfigError(
        `${sourcePath}: custom agent "${id}" conflicts with a built-in runtime id.`,
      );
    }
    if (!isRecord(config)) {
      throw new OrchestratorConfigError(`${sourcePath}: agents.${id} must be an object.`);
    }
    return compileProcessRuntime(id, config, sourcePath);
  });
}

function configSources(options: OrchestratorConfigLoadOptions): ConfigSource[] {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const workspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : undefined;
  const sources: ConfigSource[] = [];
  const xdgConfigHome = stringOrUndefined(env.XDG_CONFIG_HOME);
  const xdgPath = xdgConfigHome
    ? join(xdgConfigHome, "orchestrator", "config.json")
    : home
      ? join(home, ".config", "orchestrator", "config.json")
      : undefined;

  if (xdgPath) {
    sources.push({ path: xdgPath, required: false });
  }
  if (home) {
    sources.push({ path: join(home, ".orchestrator", "config.json"), required: false });
  }
  if (workspaceRoot) {
    sources.push({
      path: join(workspaceRoot, "orchestrator.config.json"),
      required: false,
    });
    sources.push({
      path: join(workspaceRoot, ".orchestrator", "config.json"),
      required: false,
    });
  }
  if (options.configPath) {
    sources.push({ path: resolve(options.configPath), required: true });
  }

  return dedupeSources(sources);
}

function dedupeSources(sources: readonly ConfigSource[]): ConfigSource[] {
  const seen = new Set<string>();
  const deduped: ConfigSource[] = [];
  for (const source of sources) {
    if (seen.has(source.path)) {
      const existing = deduped.find((dedupedSource) => dedupedSource.path === source.path);
      if (existing) {
        existing.required = existing.required || source.required;
      }
      continue;
    }
    seen.add(source.path);
    deduped.push({ ...source });
  }
  return deduped;
}

async function readConfigSource(source: ConfigSource): Promise<unknown | undefined> {
  try {
    await access(source.path, constants.R_OK);
  } catch (_error) {
    if (source.required) {
      throw new OrchestratorConfigError(
        `${source.path}: config file does not exist or is unreadable.`,
      );
    }
    return undefined;
  }

  const raw = await readFile(source.path, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new OrchestratorConfigError(
      `${source.path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function compileProcessRuntime(
  id: string,
  config: Record<string, unknown>,
  sourcePath: string,
): HeadlessAgentRuntimeConfig {
  const adapter = requiredString(config, "adapter", sourcePath, id);
  if (adapter !== "process") {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id}.adapter must be "process" in this release.`,
    );
  }

  const command = requiredString(config, "command", sourcePath, id);
  const args = optionalStringArray(config, "args", sourcePath, id) ?? [];
  const hasPromptPlaceholder = args.some((arg) => arg.includes("{prompt}"));
  const hasModelPlaceholder = args.some((arg) => arg.includes("{model}"));
  const prompt = optionalString(config, "prompt", sourcePath, id);
  const modelFlag = optionalString(config, "modelFlag", sourcePath, id);

  if (hasPromptPlaceholder && prompt !== undefined) {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id} cannot combine args {prompt} with prompt mode.`,
    );
  }
  if (hasModelPlaceholder && modelFlag !== undefined) {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id} cannot combine args {model} with modelFlag.`,
    );
  }
  if (hasModelPlaceholder && !hasPromptPlaceholder) {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id} args with {model} must also include {prompt}.`,
    );
  }

  const output = parseOutputTransport(config.output, sourcePath, id);
  const env = optionalStringRecord(config, "env", sourcePath, id);
  const timeoutMs =
    optionalPositiveInteger(config, "timeoutMs", sourcePath, id) ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes =
    optionalPositiveInteger(config, "maxOutputBytes", sourcePath, id) ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    id,
    displayName: optionalString(config, "displayName", sourcePath, id) ?? id,
    enabled: true,
    detect: {
      command,
      expectedProcesses: [command],
    },
    launch: {
      executable: command,
      baseArgs: args,
      prompt: hasPromptPlaceholder ? { kind: "argv_template" } : parsePromptTransport(prompt),
      output,
      ...(env ? { env } : {}),
      cwdPolicy: "workspace",
      ...(modelFlag ? { modelFlag } : {}),
    },
    resume: { supported: false },
    control: {
      interrupt: "process_group",
      steerRunning: false,
    },
    capabilities: {
      supportsStreaming: output.kind === "jsonl_events",
      supportsRunningSteer: false,
      supportsResume: false,
      supportsStructuredEvents: output.kind === "jsonl_events",
      supportsWorktree: true,
      handlesOwnAuth: true,
    },
    defaults: {
      timeoutMs,
      maxOutputBytes,
      isolation: "shared",
    },
  };
}

function parsePromptTransport(prompt: string | undefined): PromptTransport {
  switch (prompt ?? "argv-last") {
    case "argv-last":
      return { kind: "argv", position: "last" };
    case "argv-first":
      return { kind: "argv", position: "first" };
    case "stdin":
      return { kind: "stdin", closeAfterWrite: true };
    default:
      throw new OrchestratorConfigError(`prompt must be one of: argv-last, argv-first, stdin.`);
  }
}

function parseOutputTransport(output: unknown, sourcePath: string, id: string): OutputTransport {
  if (output === undefined || output === "text") {
    return { kind: "stdout_text" };
  }
  if (output === "json") {
    return { kind: "stdout_json" };
  }
  if (typeof output === "string") {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id}.output must be "text", "json", or an object with format "jsonl".`,
    );
  }
  if (!isRecord(output)) {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id}.output must be valid output config.`,
    );
  }

  const format = requiredString(output, "format", sourcePath, id, "output");
  if (format !== "jsonl") {
    throw new OrchestratorConfigError(`${sourcePath}: agents.${id}.output.format must be "jsonl".`);
  }

  return {
    kind: "jsonl_events",
    finalEvent: requiredString(output, "finalEvent", sourcePath, id, "output"),
  };
}

function requiredString(
  config: Record<string, unknown>,
  key: string,
  sourcePath: string,
  id: string,
  prefix = "",
): string {
  const value = config[key];
  const path = configPath(id, key, prefix);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OrchestratorConfigError(`${sourcePath}: ${path} must be a non-empty string.`);
  }
  return value;
}

function optionalString(
  config: Record<string, unknown>,
  key: string,
  sourcePath: string,
  id: string,
): string | undefined {
  const value = config[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id}.${key} must be a non-empty string.`,
    );
  }
  return value;
}

function optionalStringArray(
  config: Record<string, unknown>,
  key: string,
  sourcePath: string,
  id: string,
): string[] | undefined {
  const value = config[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new OrchestratorConfigError(`${sourcePath}: agents.${id}.${key} must be a string array.`);
  }
  return value;
}

function optionalStringRecord(
  config: Record<string, unknown>,
  key: string,
  sourcePath: string,
  id: string,
): Record<string, string> | undefined {
  const value = config[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new OrchestratorConfigError(`${sourcePath}: agents.${id}.${key} must be an object.`);
  }

  const result: Record<string, string> = {};
  for (const [envKey, envValue] of Object.entries(value)) {
    if (typeof envValue !== "string") {
      throw new OrchestratorConfigError(
        `${sourcePath}: agents.${id}.${key}.${envKey} must be a string.`,
      );
    }
    result[envKey] = envValue;
  }
  return result;
}

function optionalPositiveInteger(
  config: Record<string, unknown>,
  key: string,
  sourcePath: string,
  id: string,
): number | undefined {
  const value = config[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id}.${key} must be a positive integer.`,
    );
  }
  return value;
}

function optionalRecord(
  config: Record<string, unknown>,
  key: string,
  sourcePath: string,
): Record<string, unknown> | undefined {
  const value = config[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new OrchestratorConfigError(`${sourcePath}: ${key} must be an object.`);
  }
  return value;
}

function configPath(id: string, key: string, prefix: string): string {
  return prefix ? `agents.${id}.${prefix}.${key}` : `agents.${id}.${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRuntimeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function stringOrUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
