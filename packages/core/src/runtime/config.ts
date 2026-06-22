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

type OrchestratorConfigAction =
  | {
      kind: "register-runtime";
      runtime: HeadlessAgentRuntimeConfig;
      enabled: boolean;
    }
  | {
      kind: "set-enabled";
      id: string;
      enabled: boolean;
    };

const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
const BUILT_IN_RUNTIME_IDS = new Set(Object.keys(BUILT_IN_AGENT_RUNTIMES));

export class OrchestratorConfigError extends Error {
  readonly reason?: string;
  readonly input?: string;
  readonly hint?: string;

  constructor(message: string, details: { reason?: string; input?: string; hint?: string } = {}) {
    super(message);
    this.name = "OrchestratorConfigError";
    this.reason = details.reason;
    this.input = details.input;
    this.hint = details.hint;
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
  const knownRuntimes: Record<string, HeadlessAgentRuntimeConfig> = {};
  const registry: Record<string, HeadlessAgentRuntimeConfig> = {};

  for (const runtime of Object.values(options.baseRegistry ?? BUILT_IN_AGENT_RUNTIMES)) {
    if (runtime) {
      knownRuntimes[runtime.id] = runtime;
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
    for (const action of compileOrchestratorConfigActions(raw, source.path)) {
      applyConfigAction(action, registry, knownRuntimes, source.path);
    }
  }

  return { registry, loadedConfigPaths };
}

export function compileOrchestratorConfig(
  value: unknown,
  sourcePath = "orchestrator.config.json",
): HeadlessAgentRuntimeConfig[] {
  return compileOrchestratorConfigActions(value, sourcePath).flatMap((action) =>
    action.kind === "register-runtime" ? [{ ...action.runtime, enabled: action.enabled }] : [],
  );
}

function compileOrchestratorConfigActions(
  value: unknown,
  sourcePath = "orchestrator.config.json",
): OrchestratorConfigAction[] {
  if (!isRecord(value)) {
    throw new OrchestratorConfigError(`${sourcePath}: config must be a JSON object.`, {
      reason: "invalid_config_schema",
      input: sourcePath,
      hint: "Use a JSON object with an agents object.",
    });
  }

  const agents = optionalRecord(value, "agents", sourcePath);
  if (!agents) {
    return [];
  }

  return Object.entries(agents).flatMap(([id, config]) => {
    if (!isValidRuntimeId(id)) {
      throw new OrchestratorConfigError(
        `${sourcePath}: agent id "${id}" must use letters, numbers, dots, dashes, or underscores.`,
        {
          reason: "invalid_config_schema",
          input: `agents.${id}`,
          hint: "Use agent ids with only letters, numbers, dots, dashes, or underscores.",
        },
      );
    }
    if (!isRecord(config)) {
      throw new OrchestratorConfigError(`${sourcePath}: agents.${id} must be an object.`, {
        reason: "invalid_config_schema",
        input: `agents.${id}`,
        hint: "Use an object with adapter, command, args, and output fields.",
      });
    }
    const enabled = optionalBoolean(config, "enabled", sourcePath, id);

    if (BUILT_IN_RUNTIME_IDS.has(id)) {
      return enabled === undefined ? [] : [{ kind: "set-enabled", id, enabled }];
    }

    if (!hasRuntimeDefinition(config)) {
      if (enabled === undefined) {
        return [compileProcessRuntimeAction(id, config, sourcePath, true)];
      }
      return [{ kind: "set-enabled", id, enabled }];
    }

    return [compileProcessRuntimeAction(id, config, sourcePath, enabled ?? true)];
  });
}

function compileProcessRuntimeAction(
  id: string,
  config: Record<string, unknown>,
  sourcePath: string,
  enabled: boolean,
): OrchestratorConfigAction {
  return {
    kind: "register-runtime",
    runtime: compileProcessRuntime(id, config, sourcePath),
    enabled,
  };
}

function applyConfigAction(
  action: OrchestratorConfigAction,
  registry: Record<string, HeadlessAgentRuntimeConfig>,
  knownRuntimes: Record<string, HeadlessAgentRuntimeConfig>,
  sourcePath: string,
): void {
  if (action.kind === "register-runtime") {
    const runtime = { ...action.runtime, enabled: action.enabled };
    knownRuntimes[runtime.id] = runtime;
    if (action.enabled) {
      registry[runtime.id] = runtime;
    } else {
      delete registry[runtime.id];
    }
    return;
  }

  if (!action.enabled) {
    delete registry[action.id];
    return;
  }

  const runtime = knownRuntimes[action.id];
  if (!runtime) {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${action.id} cannot be enabled without a runtime definition.`,
    );
  }

  const enabledRuntime = { ...runtime, enabled: true };
  knownRuntimes[action.id] = enabledRuntime;
  registry[action.id] = enabledRuntime;
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
        {
          reason: "config_unreadable",
          input: source.path,
          hint: "Check the --config path or remove the explicit config argument.",
        },
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
      {
        reason: "invalid_config_json",
        input: source.path,
        hint: "Fix the JSON syntax in this config file.",
      },
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
      {
        reason: "unsupported_agent_adapter",
        input: `agents.${id}.adapter`,
        hint: 'Use "adapter": "process". HTTP/remote custom agents are not supported in this release.',
      },
    );
  }

  const command = requiredString(config, "command", sourcePath, id);
  const args = optionalStringArray(config, "args", sourcePath, id) ?? [];
  validateCommonPromptPlaceholderMistakes(args, sourcePath, id);
  const hasPromptPlaceholder = args.some((arg) => hasTemplatePlaceholder(arg, "prompt"));
  const hasModelPlaceholder = args.some((arg) => hasTemplatePlaceholder(arg, "model"));
  const prompt = optionalString(config, "prompt", sourcePath, id);
  const modelFlag = optionalString(config, "modelFlag", sourcePath, id);

  if (hasPromptPlaceholder && prompt !== undefined) {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id} cannot combine args {prompt} with prompt mode.`,
      {
        reason: "invalid_config_schema",
        input: `agents.${id}`,
        hint: 'Use either args with "{prompt}" or "prompt", not both.',
      },
    );
  }
  if (hasModelPlaceholder && modelFlag !== undefined) {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id} cannot combine args {model} with modelFlag.`,
      {
        reason: "invalid_config_schema",
        input: `agents.${id}`,
        hint: 'Use either args with "{model}" or "modelFlag", not both.',
      },
    );
  }
  if (hasModelPlaceholder && !hasPromptPlaceholder) {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id} args with {model} must also include {prompt}.`,
      {
        reason: "invalid_config_schema",
        input: `agents.${id}.args`,
        hint: 'When args include "{model}", include "{prompt}" too so the task is passed.',
      },
    );
  }

  const output = parseOutputTransport(config.output, sourcePath, id);
  const outputMode = outputModeName(output);
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
      defaultOutputMode: outputMode,
      outputModes: {
        [outputMode]: {
          extraArgs: [],
          output,
        },
      },
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

function outputModeName(output: OutputTransport): "text" | "json" | "jsonl" {
  switch (output.kind) {
    case "stdout_text":
      return "text";
    case "stdout_json":
      return "json";
    case "jsonl_events":
      return "jsonl";
    case "transcript_file":
      return "text";
  }
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
      throw new OrchestratorConfigError(`prompt must be one of: argv-last, argv-first, stdin.`, {
        reason: "invalid_config_schema",
        input: "prompt",
        hint: 'Use "prompt": "argv-last", "argv-first", or "stdin".',
      });
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
      invalidConfigSchemaDetails(
        `agents.${id}.output`,
        'Use "output": "text", "output": "json", or "output": { "format": "jsonl", "finalEvent": "done" }.',
      ),
    );
  }
  if (!isRecord(output)) {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id}.output must be valid output config.`,
      invalidConfigSchemaDetails(
        `agents.${id}.output`,
        'Use "output": "text", "output": "json", or "output": { "format": "jsonl", "finalEvent": "done" }.',
      ),
    );
  }

  const format = requiredString(output, "format", sourcePath, id, "output");
  if (format !== "jsonl") {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id}.output.format must be "jsonl".`,
      invalidConfigSchemaDetails(
        `agents.${id}.output.format`,
        'Use "output": "text" for plain stdout, or set "output": { "format": "jsonl", "finalEvent": "done" }.',
      ),
    );
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
    throw new OrchestratorConfigError(
      `${sourcePath}: ${path} must be a non-empty string.`,
      invalidConfigSchemaDetails(path, configSchemaHint(path, "Set it to a non-empty string.")),
    );
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
      invalidConfigSchemaDetails(
        `agents.${id}.${key}`,
        `Set agents.${id}.${key} to a non-empty string.`,
      ),
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
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id}.${key} must be a string array.`,
      invalidConfigSchemaDetails(
        `agents.${id}.${key}`,
        `Set agents.${id}.${key} to an array of strings.`,
      ),
    );
  }
  return value;
}

function validateCommonPromptPlaceholderMistakes(
  args: readonly string[],
  sourcePath: string,
  id: string,
): void {
  const mistakes = [
    {
      pattern: /\{\{prompt\}\}/,
      input: "{{prompt}}",
      hint: 'Use "{prompt}" exactly; double braces are not supported.',
    },
    {
      pattern: /\{\{model\}\}/,
      input: "{{model}}",
      hint: 'Use "{model}" exactly; double braces are not supported.',
    },
    {
      pattern: /\{\{task\}\}|\{task\}/,
      input: "{task}",
      hint: 'Use "{prompt}" for the task text. There is no "{task}" placeholder.',
    },
  ];

  for (const arg of args) {
    for (const mistake of mistakes) {
      if (mistake.pattern.test(arg)) {
        throw new OrchestratorConfigError(
          `${sourcePath}: agents.${id}.args contains unsupported placeholder ${mistake.input}.`,
          invalidConfigSchemaDetails(`agents.${id}.args`, mistake.hint),
        );
      }
    }
  }
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
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id}.${key} must be an object.`,
      invalidConfigSchemaDetails(
        `agents.${id}.${key}`,
        `Set agents.${id}.${key} to an object with string values.`,
      ),
    );
  }

  const result: Record<string, string> = {};
  for (const [envKey, envValue] of Object.entries(value)) {
    if (typeof envValue !== "string") {
      throw new OrchestratorConfigError(
        `${sourcePath}: agents.${id}.${key}.${envKey} must be a string.`,
        invalidConfigSchemaDetails(
          `agents.${id}.${key}.${envKey}`,
          `Set agents.${id}.${key}.${envKey} to a string value.`,
        ),
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
      invalidConfigSchemaDetails(
        `agents.${id}.${key}`,
        `Set agents.${id}.${key} to a positive integer.`,
      ),
    );
  }
  return value;
}

function optionalBoolean(
  config: Record<string, unknown>,
  key: string,
  sourcePath: string,
  id: string,
): boolean | undefined {
  const value = config[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new OrchestratorConfigError(
      `${sourcePath}: agents.${id}.${key} must be a boolean.`,
      invalidConfigSchemaDetails(
        `agents.${id}.${key}`,
        `Set agents.${id}.${key} to true or false.`,
      ),
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
    throw new OrchestratorConfigError(
      `${sourcePath}: ${key} must be an object.`,
      invalidConfigSchemaDetails(key, `Set ${key} to an object.`),
    );
  }
  return value;
}

function configPath(id: string, key: string, prefix: string): string {
  return prefix ? `agents.${id}.${prefix}.${key}` : `agents.${id}.${key}`;
}

function invalidConfigSchemaDetails(
  input: string,
  hint: string,
): {
  reason: "invalid_config_schema";
  input: string;
  hint: string;
} {
  return { reason: "invalid_config_schema", input, hint };
}

function configSchemaHint(path: string, fallback: string): string {
  if (path.endsWith(".output.format")) {
    return 'Use "output": "text" for plain stdout, or set "output": { "format": "jsonl", "finalEvent": "done" }.';
  }
  if (path.endsWith(".output.finalEvent")) {
    return 'Set "finalEvent" to the JSONL event type that contains the final answer, for example "done".';
  }
  return fallback;
}

function hasTemplatePlaceholder(value: string, name: "prompt" | "model"): boolean {
  return new RegExp(`(?<!\\$)\\{${name}\\}`, "g").test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRuntimeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function hasRuntimeDefinition(config: Record<string, unknown>): boolean {
  return config.adapter !== undefined || config.command !== undefined;
}

function stringOrUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
