export const BUILT_IN_RUNTIME_IDS = [
  "codex",
  "codex-app-server",
  "claude-code",
  "pi",
  "shell",
] as const;

export type BuiltInAgentRuntimeId = (typeof BUILT_IN_RUNTIME_IDS)[number];
export type AgentRuntimeId = BuiltInAgentRuntimeId | (string & {});

export type PromptTransport =
  | { kind: "argv"; position: "first" | "last" }
  | { kind: "argv_template" }
  | { kind: "flag"; flag: string }
  | { kind: "stdin"; closeAfterWrite: boolean }
  | { kind: "prompt_file"; flag: string }
  | { kind: "sdk" }
  | { kind: "http" };

export type OutputTransport =
  | { kind: "stdout_text" }
  | { kind: "stdout_json"; finalPath?: string }
  | { kind: "jsonl_events"; finalEvent: string }
  | { kind: "transcript_file"; pathHint?: string };

export type InterruptStrategy = "process_group" | "stdin" | "api" | "unsupported";
export type CwdPolicy = "workspace" | "worktree" | "any";
export type IsolationDefault = "shared" | "worktree";
export type RuntimeExecutionKind = "process" | "protocol";
export type ProtocolExecutionMode = "turn" | "session";

export type RuntimeCapabilities = {
  supportsStreaming: boolean;
  supportsRunningSteer: boolean;
  supportsResume: boolean;
  supportsStructuredEvents: boolean;
  supportsWorktree: boolean;
  handlesOwnAuth: boolean;
  supportsPersistentSession?: boolean;
  supportsSessionTurns?: boolean;
  supportsSessionGoals?: boolean;
};

export type RuntimeOutputMode = {
  extraArgs: readonly string[];
  output: OutputTransport;
};

export type HeadlessAgentRuntimeConfig = {
  id: AgentRuntimeId;
  displayName: string;
  enabled: boolean;
  executionKind?: RuntimeExecutionKind;
  detect: {
    command: string;
    aliases?: readonly string[];
    versionArgs?: readonly string[];
    expectedProcesses?: readonly string[];
  };
  launch: {
    executable: string;
    baseArgs: readonly string[];
    prompt: PromptTransport;
    output: OutputTransport;
    defaultOutputMode?: string;
    outputModes?: Readonly<Record<string, RuntimeOutputMode>>;
    env?: Readonly<Record<string, string>>;
    cwdPolicy: CwdPolicy;
    modelFlag?: string;
  };
  resume?: {
    supported: boolean;
    args?: readonly string[];
  };
  control: {
    interrupt: InterruptStrategy;
    steerRunning: boolean;
  };
  capabilities: RuntimeCapabilities;
  defaults: {
    timeoutMs: number;
    maxOutputBytes: number;
    isolation: IsolationDefault;
  };
  safety?: {
    acceptsShellCommand?: boolean;
  };
};

export type RuntimeRegistry = Readonly<Partial<Record<AgentRuntimeId, HeadlessAgentRuntimeConfig>>>;

export type BuildAgentLaunchPlanInput = {
  runtime: AgentRuntimeId;
  task?: string;
  cwd: string;
  env?: Readonly<Record<string, string>>;
  model?: string;
  outputMode?: string;
  promptFilePath?: string;
  allowDisabledRuntime?: boolean;
  session?: boolean;
};

export type BuildAgentResumeLaunchPlanInput = {
  runtime: AgentRuntimeId;
  task: string;
  cwd: string;
  env?: Readonly<Record<string, string>>;
  model?: string;
  outputMode?: string;
  allowDisabledRuntime?: boolean;
  provider: {
    threadId?: string;
    sessionId?: string;
  };
};

export type AgentLaunchPlan = {
  runtime: AgentRuntimeId;
  executionKind?: RuntimeExecutionKind;
  protocolExecutionMode?: ProtocolExecutionMode;
  displayName: string;
  executable: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  promptTransport: PromptTransport;
  outputTransport: OutputTransport;
  expectedProcesses: readonly string[];
  interrupt: InterruptStrategy;
  canSteerRunning: boolean;
  handlesOwnAuth: boolean;
  enabled: boolean;
  safety: {
    acceptsShellCommand: boolean;
  };
  resume?: {
    provider: "codex" | "claude-code";
    threadId?: string;
    sessionId?: string;
  };
  stdin?: {
    input: string;
    closeAfterWrite: boolean;
  };
  taskForSdkOrHttp?: string;
  taskForProtocol?: string;
};
