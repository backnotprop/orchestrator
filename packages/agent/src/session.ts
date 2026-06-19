import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createOrchestratorAgentTools, type ParentAgentToolContext } from "./tools.ts";

type ParentSessionPiOptions = Partial<
  Omit<
    CreateAgentSessionOptions,
    | "cwd"
    | "agentDir"
    | "noTools"
    | "tools"
    | "excludeTools"
    | "customTools"
    | "resourceLoader"
    | "settingsManager"
    | "sessionStartEvent"
  >
>;

export type CreateOrchestratorParentSessionOptions = ParentAgentToolContext & {
  agentDir?: string;
  sessionDir?: string;
  pi?: ParentSessionPiOptions;
};

export function getDefaultOrchestratorAgentDir(homeDir = homedir()): string {
  return join(homeDir, ".orchestrator");
}

export async function createOrchestratorParentSession(
  options: CreateOrchestratorParentSessionOptions,
): Promise<CreateAgentSessionResult> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const cwd = resolve(options.cwd ?? workspaceRoot);
  const agentDir = resolve(options.agentDir ?? getDefaultOrchestratorAgentDir());
  const sessionDir = resolve(options.sessionDir ?? join(agentDir, "sessions"));
  const piOptions = stripUnsafePiOptions(options.pi);
  const authStorage = piOptions.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry =
    piOptions.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const sessionManager = piOptions.sessionManager ?? SessionManager.create(cwd, sessionDir);
  const settingsManager = SettingsManager.inMemory({ sessionDir });
  const { agentDir: _agentDir, sessionDir: _sessionDir, pi: _pi, ...toolOptions } = options;
  const orchestratorTools = createOrchestratorAgentTools({
    ...toolOptions,
    workspaceRoot,
    cwd,
  });

  return createAgentSession({
    ...piOptions,
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    sessionManager,
    settingsManager,
    noTools: "builtin",
    tools: toolNames(orchestratorTools),
    customTools: orchestratorTools,
  });
}

function toolNames(tools: readonly ToolDefinition[]): string[] {
  return tools.map((tool) => tool.name);
}

function stripUnsafePiOptions(options: ParentSessionPiOptions | undefined): ParentSessionPiOptions {
  const {
    cwd: _cwd,
    agentDir: _agentDir,
    noTools: _noTools,
    tools: _tools,
    excludeTools: _excludeTools,
    customTools: _customTools,
    resourceLoader: _resourceLoader,
    settingsManager: _settingsManager,
    sessionStartEvent: _sessionStartEvent,
    ...safeOptions
  } = (options ?? {}) as Partial<CreateAgentSessionOptions>;

  return safeOptions;
}
