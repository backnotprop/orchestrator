import { BUILT_IN_AGENT_RUNTIMES, getRuntimeConfig } from "./runtimes.ts";
import type {
  AgentLaunchPlan,
  BuildAgentLaunchPlanInput,
  HeadlessAgentRuntimeConfig,
  OutputTransport,
  RuntimeRegistry,
} from "./types.ts";

export class LaunchPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchPlanError";
  }
}

export function buildAgentLaunchPlan(
  input: BuildAgentLaunchPlanInput,
  registry: RuntimeRegistry = BUILT_IN_AGENT_RUNTIMES,
): AgentLaunchPlan {
  validateLaunchInput(input);

  const runtime = getRuntimeOrThrow(input.runtime, registry);

  if (!runtime.enabled && !input.allowDisabledRuntime) {
    throw new LaunchPlanError(
      `Runtime "${input.runtime}" is disabled. Enable it explicitly before building launch plans.`,
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
          task: input.task,
          model: input.model,
        })
      : applyTaskTransport({
          argsBeforeTask,
          runtime,
          task: input.task,
          promptFilePath: input.promptFilePath,
        });

  const stdin =
    runtime.launch.prompt.kind === "stdin"
      ? { input: input.task, closeAfterWrite: runtime.launch.prompt.closeAfterWrite }
      : undefined;

  const taskForSdkOrHttp =
    runtime.launch.prompt.kind === "sdk" || runtime.launch.prompt.kind === "http"
      ? input.task
      : undefined;

  return {
    runtime: runtime.id,
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
      requiresAllowlist: runtime.safety?.requiresAllowlist ?? false,
      acceptsShellCommand: runtime.safety?.acceptsShellCommand ?? false,
    },
    ...(stdin ? { stdin } : {}),
    ...(taskForSdkOrHttp ? { taskForSdkOrHttp } : {}),
  };
}

function validateLaunchInput(input: BuildAgentLaunchPlanInput): void {
  if (input.task.trim().length === 0) {
    throw new LaunchPlanError("Task instructions must not be empty.");
  }

  if (input.cwd.trim().length === 0) {
    throw new LaunchPlanError("cwd must not be empty.");
  }
}

function getRuntimeOrThrow(
  runtimeId: string,
  registry: RuntimeRegistry,
): HeadlessAgentRuntimeConfig {
  const runtime = getRuntimeConfig(runtimeId, registry);
  if (!runtime) {
    throw new LaunchPlanError(`Unknown runtime "${runtimeId}".`);
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
    if (arg.includes("{prompt}")) {
      sawPromptPlaceholder = true;
    }
    if (arg.includes("{model}") && !args.model) {
      throw new LaunchPlanError(
        `Runtime "${args.runtime.id}" argv template uses {model}; pass --model or use modelFlag.`,
      );
    }
    return arg.replaceAll("{prompt}", args.task).replaceAll("{model}", args.model ?? "");
  });

  if (!sawPromptPlaceholder) {
    throw new LaunchPlanError(
      `Runtime "${args.runtime.id}" argv template must include a {prompt} placeholder.`,
    );
  }

  return rendered;
}
