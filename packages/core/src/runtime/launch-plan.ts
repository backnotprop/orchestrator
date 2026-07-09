import { BUILT_IN_AGENT_RUNTIMES, getRuntimeConfig } from "./runtimes.ts";
import type {
  AgentLaunchPlan,
  BuildAgentLaunchPlanInput,
  BuildAgentResumeLaunchPlanInput,
  HeadlessAgentRuntimeConfig,
  OutputTransport,
  ProtocolExecutionMode,
  RuntimeRegistry,
} from "./types.ts";

export class LaunchPlanError extends Error {
  readonly reason?: string;
  readonly input?: string;
  readonly hint?: string;

  constructor(message: string, details: { reason?: string; input?: string; hint?: string } = {}) {
    super(message);
    this.name = "LaunchPlanError";
    this.reason = details.reason;
    this.input = details.input;
    this.hint = details.hint;
  }
}

export function buildAgentLaunchPlan(
  input: BuildAgentLaunchPlanInput,
  registry: RuntimeRegistry = BUILT_IN_AGENT_RUNTIMES,
): AgentLaunchPlan {
  const runtime = getRuntimeOrThrow(input.runtime, registry);
  const executionKind = runtime.executionKind ?? "process";
  const protocolExecutionMode: ProtocolExecutionMode | undefined =
    executionKind === "protocol" ? (input.session ? "session" : "turn") : undefined;
  validateLaunchInput(input, runtime, protocolExecutionMode);

  if (!runtime.enabled && !input.allowDisabledRuntime) {
    throw new LaunchPlanError(
      `Runtime "${input.runtime}" is disabled. Enable it explicitly before building launch plans.`,
      {
        reason: "disabled_runtime",
        input: input.runtime,
        hint: "Enable the runtime in config or choose an enabled runtime from orchestrator help --json --compact.",
      },
    );
  }

  const outputMode = resolveOutputMode(runtime, input.outputMode);
  const argsBeforeTask = [
    ...runtime.launch.baseArgs,
    ...modelArgs(runtime, input.model),
    ...outputMode.extraArgs,
  ];

  const args =
    runtime.launch.prompt.kind === "argv_template"
      ? applyArgTemplate({
          template: argsBeforeTask,
          runtime,
          task: taskText(input),
          model: input.model,
        })
      : applyTaskTransport({
          argsBeforeTask,
          runtime,
          task: taskText(input),
          promptFilePath: input.promptFilePath,
        });

  const stdin =
    runtime.launch.prompt.kind === "stdin"
      ? { input: taskText(input), closeAfterWrite: runtime.launch.prompt.closeAfterWrite }
      : undefined;

  const taskForSdkOrHttp =
    executionKind !== "protocol" &&
    (runtime.launch.prompt.kind === "sdk" || runtime.launch.prompt.kind === "http")
      ? taskText(input)
      : undefined;
  const taskForProtocol =
    executionKind === "protocol" && protocolExecutionMode === "turn" ? taskText(input) : undefined;

  return {
    runtime: runtime.id,
    executionKind,
    ...(protocolExecutionMode ? { protocolExecutionMode } : {}),
    displayName: runtime.displayName,
    executable: runtime.launch.executable,
    args,
    env: {
      ...(runtime.launch.env ?? {}),
      ...(input.env ?? {}),
    },
    cwd: input.cwd,
    promptTransport: runtime.launch.prompt,
    outputTransport: outputMode.output,
    expectedProcesses: runtime.detect.expectedProcesses ?? [runtime.detect.command],
    interrupt: runtime.control.interrupt,
    canSteerRunning: runtime.control.steerRunning,
    handlesOwnAuth: runtime.capabilities.handlesOwnAuth,
    enabled: runtime.enabled,
    safety: {
      acceptsShellCommand: runtime.safety?.acceptsShellCommand ?? false,
    },
    ...(stdin ? { stdin } : {}),
    ...(taskForSdkOrHttp ? { taskForSdkOrHttp } : {}),
    ...(taskForProtocol ? { taskForProtocol } : {}),
  };
}

export function buildAgentResumeLaunchPlan(
  input: BuildAgentResumeLaunchPlanInput,
  registry: RuntimeRegistry = BUILT_IN_AGENT_RUNTIMES,
): AgentLaunchPlan {
  validateResumeLaunchInput(input);

  const runtime = getRuntimeOrThrow(input.runtime, registry);

  if (!runtime.enabled && !input.allowDisabledRuntime) {
    throw new LaunchPlanError(
      `Runtime "${input.runtime}" is disabled. Enable it explicitly before building resume plans.`,
      {
        reason: "disabled_runtime",
        input: input.runtime,
        hint: "Enable the runtime in config or choose an enabled runtime from orchestrator help --json --compact.",
      },
    );
  }

  if (!runtime.capabilities.supportsResume || runtime.resume?.supported !== true) {
    throw new LaunchPlanError(`Runtime "${input.runtime}" does not support provider resume.`, {
      reason: "unsupported_resume",
      input: input.runtime,
      hint: "Use resume only with tasks that have real provider session metadata, or launch a new follow-up task with context.",
    });
  }

  switch (runtime.id) {
    case "codex":
      return buildCodexResumePlan(input, runtime);
    case "codex-app-server":
      return buildCodexAppServerResumePlan(input, runtime);
    case "claude-code":
      return buildClaudeCodeResumePlan(input, runtime);
    case "copilot":
      return buildCopilotResumePlan(input, runtime);
    case "grok":
      return buildGrokResumePlan(input, runtime);
    default:
      throw new LaunchPlanError(`Runtime "${input.runtime}" does not support provider resume.`, {
        reason: "unsupported_resume",
        input: input.runtime,
        hint: "This release supports provider resume for codex, codex-app-server, claude-code, copilot, and grok only.",
      });
  }
}

function validateLaunchInput(
  input: BuildAgentLaunchPlanInput,
  runtime: HeadlessAgentRuntimeConfig,
  protocolExecutionMode: ProtocolExecutionMode | undefined,
): void {
  if (input.cwd.trim().length === 0) {
    throw new LaunchPlanError("cwd must not be empty.");
  }

  if (input.session && protocolExecutionMode !== "session") {
    throw new LaunchPlanError(`Runtime "${input.runtime}" does not support persistent sessions.`, {
      reason: "unsupported_session",
      input: input.runtime,
      hint: "Use --session only with a protocol runtime that supports persistent sessions.",
    });
  }

  if (protocolExecutionMode === "session") {
    if (runtime.executionKind !== "protocol" || !runtime.capabilities.supportsPersistentSession) {
      throw new LaunchPlanError(
        `Runtime "${input.runtime}" does not support persistent sessions.`,
        {
          reason: "unsupported_session",
          input: input.runtime,
          hint: "Use --session only with a protocol runtime that supports persistent sessions.",
        },
      );
    }
    if (taskText(input).trim().length > 0) {
      throw new LaunchPlanError("Session launch does not accept task instructions yet.", {
        reason: "unsupported_session_task",
        input: input.runtime,
        hint: "Start the session first, then send work with orchestrator send.",
      });
    }
    return;
  }

  if (taskText(input).trim().length === 0) {
    throw new LaunchPlanError("Task instructions must not be empty.");
  }
}

function validateResumeLaunchInput(input: BuildAgentResumeLaunchPlanInput): void {
  if (input.task.trim().length === 0) {
    throw new LaunchPlanError("Task instructions must not be empty.");
  }

  if (input.cwd.trim().length === 0) {
    throw new LaunchPlanError("cwd must not be empty.");
  }
}

function taskText(input: Pick<BuildAgentLaunchPlanInput, "task">): string {
  return input.task ?? "";
}

function buildCodexResumePlan(
  input: BuildAgentResumeLaunchPlanInput,
  runtime: HeadlessAgentRuntimeConfig,
): AgentLaunchPlan {
  const threadId = input.provider.threadId?.trim();
  if (!threadId) {
    throw new LaunchPlanError(`Runtime "${runtime.id}" resume requires provider.threadId.`, {
      reason: "missing_resume_provider_id",
      input: runtime.id,
      hint: "Resume a Codex task only after its task record has provider.threadId from thread.started.",
    });
  }

  const outputMode = resolveOutputMode(runtime, input.outputMode);
  return baseResumePlan({
    input,
    runtime,
    outputMode,
    args: [
      ...runtime.launch.baseArgs,
      ...modelArgs(runtime, input.model),
      ...outputMode.extraArgs,
      "resume",
      threadId,
      input.task,
    ],
    resume: {
      provider: "codex",
      threadId,
    },
  });
}

function buildCodexAppServerResumePlan(
  input: BuildAgentResumeLaunchPlanInput,
  runtime: HeadlessAgentRuntimeConfig,
): AgentLaunchPlan {
  const threadId = input.provider.threadId?.trim();
  if (!threadId) {
    throw new LaunchPlanError(`Runtime "${runtime.id}" resume requires provider.threadId.`, {
      reason: "missing_resume_provider_id",
      input: runtime.id,
      hint: "Resume a Codex app-server task only after its task record has provider.threadId from thread.started.",
    });
  }

  const outputMode = resolveOutputMode(runtime, input.outputMode);
  return baseResumePlan({
    input,
    runtime,
    outputMode,
    args: [...runtime.launch.baseArgs, ...modelArgs(runtime, input.model), ...outputMode.extraArgs],
    resume: {
      provider: "codex",
      threadId,
    },
  });
}

function buildClaudeCodeResumePlan(
  input: BuildAgentResumeLaunchPlanInput,
  runtime: HeadlessAgentRuntimeConfig,
): AgentLaunchPlan {
  const sessionId = input.provider.sessionId?.trim();
  if (!sessionId) {
    throw new LaunchPlanError(`Runtime "${runtime.id}" resume requires provider.sessionId.`, {
      reason: "missing_resume_provider_id",
      input: runtime.id,
      hint: "Resume a Claude Code task only after its task record has provider.sessionId from session_id.",
    });
  }

  const outputMode = resolveOutputMode(runtime, input.outputMode);
  return baseResumePlan({
    input,
    runtime,
    outputMode,
    args: [
      ...runtime.launch.baseArgs,
      "--resume",
      sessionId,
      ...modelArgs(runtime, input.model),
      ...outputMode.extraArgs,
      input.task,
    ],
    resume: {
      provider: "claude-code",
      sessionId,
    },
  });
}

function buildCopilotResumePlan(
  input: BuildAgentResumeLaunchPlanInput,
  runtime: HeadlessAgentRuntimeConfig,
): AgentLaunchPlan {
  const sessionId = input.provider.sessionId?.trim();
  if (!sessionId) {
    throw new LaunchPlanError(`Runtime "${runtime.id}" resume requires provider.sessionId.`, {
      reason: "missing_resume_provider_id",
      input: runtime.id,
      hint: "Resume a Copilot task only after its task record has provider.sessionId from result.sessionId.",
    });
  }

  const outputMode = resolveOutputMode(runtime, input.outputMode);
  return baseResumePlan({
    input,
    runtime,
    outputMode,
    args: [
      ...runtime.launch.baseArgs,
      "--resume",
      sessionId,
      ...modelArgs(runtime, input.model),
      ...outputMode.extraArgs,
      "-p",
      input.task,
    ],
    resume: {
      provider: "copilot",
      sessionId,
    },
  });
}

function buildGrokResumePlan(
  input: BuildAgentResumeLaunchPlanInput,
  runtime: HeadlessAgentRuntimeConfig,
): AgentLaunchPlan {
  const sessionId = input.provider.sessionId?.trim();
  if (!sessionId) {
    throw new LaunchPlanError(`Runtime "${runtime.id}" resume requires provider.sessionId.`, {
      reason: "missing_resume_provider_id",
      input: runtime.id,
      hint: "Resume a Grok task only after its task record has provider.sessionId from end.sessionId.",
    });
  }

  const outputMode = resolveOutputMode(runtime, input.outputMode);
  return baseResumePlan({
    input,
    runtime,
    outputMode,
    args: [
      ...runtime.launch.baseArgs,
      "--resume",
      sessionId,
      ...modelArgs(runtime, input.model),
      ...outputMode.extraArgs,
      "-p",
      input.task,
    ],
    resume: {
      provider: "grok",
      sessionId,
    },
  });
}

function baseResumePlan(args: {
  input: BuildAgentResumeLaunchPlanInput;
  runtime: HeadlessAgentRuntimeConfig;
  outputMode: { extraArgs: readonly string[]; output: OutputTransport };
  args: string[];
  resume: NonNullable<AgentLaunchPlan["resume"]>;
}): AgentLaunchPlan {
  const executionKind = args.runtime.executionKind ?? "process";
  const protocolExecutionMode: ProtocolExecutionMode | undefined =
    executionKind === "protocol" ? "turn" : undefined;
  const taskForSdkOrHttp =
    executionKind !== "protocol" &&
    (args.runtime.launch.prompt.kind === "sdk" || args.runtime.launch.prompt.kind === "http")
      ? args.input.task
      : undefined;
  const taskForProtocol = executionKind === "protocol" ? args.input.task : undefined;

  return {
    runtime: args.runtime.id,
    executionKind,
    ...(protocolExecutionMode ? { protocolExecutionMode } : {}),
    displayName: args.runtime.displayName,
    executable: args.runtime.launch.executable,
    args: args.args,
    env: {
      ...(args.runtime.launch.env ?? {}),
      ...(args.input.env ?? {}),
    },
    cwd: args.input.cwd,
    promptTransport: args.runtime.launch.prompt,
    outputTransport: args.outputMode.output,
    expectedProcesses: args.runtime.detect.expectedProcesses ?? [args.runtime.detect.command],
    interrupt: args.runtime.control.interrupt,
    canSteerRunning: args.runtime.control.steerRunning,
    handlesOwnAuth: args.runtime.capabilities.handlesOwnAuth,
    enabled: args.runtime.enabled,
    safety: {
      acceptsShellCommand: args.runtime.safety?.acceptsShellCommand ?? false,
    },
    resume: args.resume,
    ...(taskForSdkOrHttp ? { taskForSdkOrHttp } : {}),
    ...(taskForProtocol ? { taskForProtocol } : {}),
  };
}

function getRuntimeOrThrow(
  runtimeId: string,
  registry: RuntimeRegistry,
): HeadlessAgentRuntimeConfig {
  const runtime = getRuntimeConfig(runtimeId, registry);
  if (!runtime) {
    throw new LaunchPlanError(`Unknown runtime "${runtimeId}".`, {
      reason: "unknown_runtime",
      input: runtimeId,
      hint: "Run orchestrator help --json --compact to list available runtime ids.",
    });
  }
  return runtime;
}

function resolveOutputMode(
  runtime: HeadlessAgentRuntimeConfig,
  outputMode: string | undefined,
): { extraArgs: readonly string[]; output: OutputTransport } {
  const selectedOutputMode = outputMode ?? runtime.launch.defaultOutputMode;
  if (!selectedOutputMode) {
    return {
      extraArgs: [],
      output: runtime.launch.output,
    };
  }

  const selected = runtime.launch.outputModes?.[selectedOutputMode];
  if (!selected) {
    const supportedModes = Object.keys(runtime.launch.outputModes ?? {});
    throw new LaunchPlanError(
      `Runtime "${runtime.id}" does not support output mode "${selectedOutputMode}".` +
        (supportedModes.length > 0 ? ` Supported modes: ${supportedModes.join(", ")}.` : ""),
      {
        reason: "unsupported_output_mode",
        input: selectedOutputMode,
        hint:
          supportedModes.length > 0
            ? `Use one of: ${supportedModes.join(", ")}.`
            : "Omit --output-mode for this runtime.",
      },
    );
  }

  return selected;
}

function modelArgs(runtime: HeadlessAgentRuntimeConfig, model: string | undefined): string[] {
  if (!model) {
    return [];
  }

  if (!runtime.launch.modelFlag) {
    return [];
  }

  return [runtime.launch.modelFlag, model];
}

function applyTaskTransport(args: {
  argsBeforeTask: string[];
  runtime: HeadlessAgentRuntimeConfig;
  task: string;
  promptFilePath: string | undefined;
}): string[] {
  const { argsBeforeTask, runtime, task, promptFilePath } = args;
  const transport = runtime.launch.prompt;

  switch (transport.kind) {
    case "argv":
      return transport.position === "first" ? [task, ...argsBeforeTask] : [...argsBeforeTask, task];
    case "argv_template":
      return applyArgTemplate({
        template: argsBeforeTask,
        runtime,
        task,
        model: undefined,
      });
    case "flag":
      return [...argsBeforeTask, transport.flag, task];
    case "stdin":
      return argsBeforeTask;
    case "prompt_file":
      if (!promptFilePath) {
        throw new LaunchPlanError(
          `Runtime "${runtime.id}" requires promptFilePath for prompt_file transport.`,
        );
      }
      return [...argsBeforeTask, transport.flag, promptFilePath];
    case "sdk":
    case "http":
      return argsBeforeTask;
  }
}

function applyArgTemplate(args: {
  template: readonly string[];
  runtime: HeadlessAgentRuntimeConfig;
  task: string;
  model: string | undefined;
}): string[] {
  let sawPromptPlaceholder = false;

  const rendered = args.template.map((arg) => {
    if (hasTemplatePlaceholder(arg, "prompt")) {
      sawPromptPlaceholder = true;
    }
    if (hasTemplatePlaceholder(arg, "model") && !args.model) {
      throw new LaunchPlanError(
        `Runtime "${args.runtime.id}" argv template uses {model}; pass --model or use modelFlag.`,
        {
          reason: "missing_model",
          input: args.runtime.id,
          hint: "Pass --model <model> when launching this runtime.",
        },
      );
    }
    return replaceTemplatePlaceholder(
      replaceTemplatePlaceholder(arg, "prompt", args.task),
      "model",
      args.model ?? "",
    );
  });

  if (!sawPromptPlaceholder) {
    throw new LaunchPlanError(
      `Runtime "${args.runtime.id}" argv template must include a {prompt} placeholder.`,
    );
  }

  return rendered;
}

function hasTemplatePlaceholder(value: string, name: "prompt" | "model"): boolean {
  return templatePlaceholderPattern(name).test(value);
}

function replaceTemplatePlaceholder(
  value: string,
  name: "prompt" | "model",
  replacement: string,
): string {
  return value.replaceAll(templatePlaceholderPattern(name), replacement);
}

function templatePlaceholderPattern(name: "prompt" | "model"): RegExp {
  return new RegExp(`(?<![$\\{])\\{${name}\\}(?!\\})`, "g");
}
