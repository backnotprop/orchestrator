import type {
  BuiltInAgentRuntimeId,
  HeadlessAgentRuntimeConfig,
  RuntimeRegistry,
} from "./types.ts";
import { BUILT_IN_RUNTIME_IDS } from "./types.ts";

export const CLAUDE_CODE_RUNTIME = {
  id: "claude-code",
  displayName: "Claude Code",
  enabled: true,
  detect: {
    command: "claude",
    versionArgs: ["--version"],
    expectedProcesses: ["claude"],
  },
  launch: {
    executable: "claude",
    baseArgs: ["-p"],
    prompt: { kind: "argv", position: "last" },
    output: { kind: "stdout_text" },
    defaultOutputMode: "stream_json",
    outputModes: {
      text: {
        extraArgs: [],
        output: { kind: "stdout_text" },
      },
      json: {
        extraArgs: ["--output-format", "json"],
        output: { kind: "stdout_json" },
      },
      stream_json: {
        extraArgs: ["--output-format", "stream-json", "--verbose"],
        output: { kind: "jsonl_events", finalEvent: "result" },
      },
    },
    cwdPolicy: "workspace",
    modelFlag: "--model",
  },
  resume: { supported: false },
  control: {
    interrupt: "process_group",
    steerRunning: false,
  },
  capabilities: {
    supportsStreaming: true,
    supportsRunningSteer: false,
    supportsResume: false,
    supportsStructuredEvents: true,
    supportsWorktree: true,
    handlesOwnAuth: true,
  },
  defaults: {
    timeoutMs: 900_000,
    maxOutputBytes: 200_000,
    isolation: "shared",
  },
} satisfies HeadlessAgentRuntimeConfig;

export const CODEX_RUNTIME = {
  id: "codex",
  displayName: "Codex",
  enabled: true,
  detect: {
    command: "codex",
    versionArgs: ["--version"],
    expectedProcesses: ["codex"],
  },
  launch: {
    executable: "codex",
    baseArgs: ["exec", "--skip-git-repo-check"],
    prompt: { kind: "argv", position: "last" },
    output: { kind: "stdout_text" },
    defaultOutputMode: "jsonl",
    outputModes: {
      text: {
        extraArgs: [],
        output: { kind: "stdout_text" },
      },
      jsonl: {
        extraArgs: ["--json"],
        output: { kind: "jsonl_events", finalEvent: "turn.completed" },
      },
    },
    cwdPolicy: "workspace",
    modelFlag: "--model",
  },
  resume: {
    supported: true,
    args: ["exec", "resume"],
  },
  control: {
    interrupt: "process_group",
    steerRunning: false,
  },
  capabilities: {
    supportsStreaming: true,
    supportsRunningSteer: false,
    supportsResume: true,
    supportsStructuredEvents: true,
    supportsWorktree: true,
    handlesOwnAuth: true,
  },
  defaults: {
    timeoutMs: 900_000,
    maxOutputBytes: 200_000,
    isolation: "shared",
  },
} satisfies HeadlessAgentRuntimeConfig;

export const PI_RUNTIME = {
  id: "pi",
  displayName: "Pi",
  enabled: true,
  detect: {
    command: "pi",
    versionArgs: ["--version"],
    expectedProcesses: ["pi"],
  },
  launch: {
    executable: "pi",
    baseArgs: ["-p"],
    prompt: { kind: "argv", position: "last" },
    output: { kind: "stdout_text" },
    outputModes: {
      json: {
        extraArgs: ["--mode", "json"],
        output: { kind: "stdout_json" },
      },
      rpc: {
        extraArgs: ["--mode", "rpc"],
        output: { kind: "jsonl_events", finalEvent: "message" },
      },
    },
    cwdPolicy: "workspace",
    modelFlag: "--model",
  },
  resume: { supported: true, args: ["--continue"] },
  control: {
    interrupt: "process_group",
    steerRunning: false,
  },
  capabilities: {
    supportsStreaming: true,
    supportsRunningSteer: false,
    supportsResume: true,
    supportsStructuredEvents: true,
    supportsWorktree: true,
    handlesOwnAuth: true,
  },
  defaults: {
    timeoutMs: 900_000,
    maxOutputBytes: 200_000,
    isolation: "shared",
  },
} satisfies HeadlessAgentRuntimeConfig;

export const SHELL_RUNTIME = {
  id: "shell",
  displayName: "Shell",
  enabled: false,
  detect: {
    command: "sh",
    expectedProcesses: ["sh"],
  },
  launch: {
    executable: "sh",
    baseArgs: ["-lc"],
    prompt: { kind: "argv", position: "last" },
    output: { kind: "stdout_text" },
    cwdPolicy: "any",
  },
  resume: { supported: false },
  control: {
    interrupt: "process_group",
    steerRunning: false,
  },
  capabilities: {
    supportsStreaming: false,
    supportsRunningSteer: false,
    supportsResume: false,
    supportsStructuredEvents: false,
    supportsWorktree: false,
    handlesOwnAuth: false,
  },
  defaults: {
    timeoutMs: 300_000,
    maxOutputBytes: 100_000,
    isolation: "shared",
  },
  safety: {
    requiresAllowlist: true,
    acceptsShellCommand: true,
  },
} satisfies HeadlessAgentRuntimeConfig;

export const BUILT_IN_AGENT_RUNTIMES = {
  codex: CODEX_RUNTIME,
  "claude-code": CLAUDE_CODE_RUNTIME,
  pi: PI_RUNTIME,
  shell: SHELL_RUNTIME,
} satisfies Record<BuiltInAgentRuntimeId, HeadlessAgentRuntimeConfig>;

export const ALL_AGENT_RUNTIMES = BUILT_IN_RUNTIME_IDS;

export function getEnabledAgentRuntimes(
  registry: RuntimeRegistry = BUILT_IN_AGENT_RUNTIMES,
): HeadlessAgentRuntimeConfig[] {
  return Object.values(registry).filter((runtime): runtime is HeadlessAgentRuntimeConfig =>
    Boolean(runtime?.enabled),
  );
}

export function getRuntimeConfig(
  runtimeId: string,
  registry: RuntimeRegistry = BUILT_IN_AGENT_RUNTIMES,
): HeadlessAgentRuntimeConfig | undefined {
  return registry[runtimeId];
}
