import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildOrchestratorParentPrompt,
  createOrchestratorParentSession,
  createRunStreamSequencer,
  normalizeRunStreamError,
  runStreamPayloadsFromParentToolTrace,
  type RunStreamEvent,
} from "@backnotprop/orchestrator-agent";
import {
  appendAgentTaskEvent,
  type AgentLaunchPlan,
  type LaunchTaskInput,
} from "@backnotprop/orchestrator-core";
import { launchInBackground, writeParentRunRequest } from "../background-task.ts";
import { CliError } from "../cli-errors.ts";
import { renderRunTraceEvents } from "../render-run-trace.ts";
import { summarizeTaskPrompt, workspaceName } from "../task-labels.ts";
import { printTask, printTaskSummaryJson } from "../task-output.ts";

export type ParentToolTraceMode = "off" | "text" | "jsonl";

export type RunOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  request: string;
  agentDir?: string;
  sessionDir?: string;
  name?: string;
  background: boolean;
  compact: boolean;
  brief: boolean;
  traceTools: ParentToolTraceMode;
  streamJson: boolean;
};

type ParentRunTaskRequest = {
  schemaVersion: 1;
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  agentDir?: string;
  sessionDir?: string;
  request: string;
  parentRunId: string;
  parentTaskId: string;
};

type ParentRunResult = {
  sessionId: string;
  output: string;
  modelFallbackMessage?: string;
};

type RunEventSink = (event: RunStreamEvent) => void | Promise<void>;

type RunCommandContext = {
  cliEntryPath: string;
};

export async function commandRun(options: RunOptions, context: RunCommandContext): Promise<void> {
  if (options.background) {
    await commandRunBackground(options, context);
    return;
  }

  const result = await executeParentRun(options, context);
  if (options.streamJson) {
    return;
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          sessionId: result.sessionId,
          output: result.output,
          ...(result.modelFallbackMessage
            ? { modelFallbackMessage: result.modelFallbackMessage }
            : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (result.modelFallbackMessage) {
    process.stderr.write(`${result.modelFallbackMessage}\n`);
  }
  if (result.output) {
    process.stdout.write(`${result.output}\n`);
  }
}

export async function commandRunParentTask(
  requestPath: string,
  context: RunCommandContext,
): Promise<void> {
  const request = JSON.parse(await readFile(requestPath, "utf8")) as ParentRunTaskRequest;

  try {
    if (request.schemaVersion !== 1) {
      throw new CliError(`Unsupported parent run request schema ${request.schemaVersion}.`);
    }

    const result = await executeParentRun(
      {
        workspaceRoot: request.workspaceRoot,
        ...(request.orchestratorDir ? { orchestratorDir: request.orchestratorDir } : {}),
        ...(request.configPath ? { configPath: request.configPath } : {}),
        ...(request.agentDir ? { agentDir: request.agentDir } : {}),
        ...(request.sessionDir ? { sessionDir: request.sessionDir } : {}),
        request: request.request,
        parentRunId: request.parentRunId,
        parentTaskId: request.parentTaskId,
        json: false,
        background: false,
        compact: false,
        brief: false,
        traceTools: "off",
        streamJson: false,
        runEventSink: async (event) => {
          await appendAgentTaskEvent(
            {
              workspaceRoot: request.workspaceRoot,
              ...(request.orchestratorDir ? { orchestratorDir: request.orchestratorDir } : {}),
            },
            request.parentTaskId,
            { ...event },
          );
        },
      },
      context,
    );

    if (result.modelFallbackMessage) {
      process.stderr.write(`${result.modelFallbackMessage}\n`);
    }
    if (result.output) {
      process.stdout.write(`${result.output}\n`);
    }
  } finally {
    await rm(requestPath, { force: true });
  }
}

async function commandRunBackground(
  options: RunOptions,
  context: RunCommandContext,
): Promise<void> {
  if (options.traceTools !== "off") {
    throw new CliError("run --background cannot be combined with --trace-tools.");
  }
  if (options.streamJson) {
    throw new CliError("run --background cannot be combined with --stream-json.");
  }

  const taskId = randomUUID();
  const request: ParentRunTaskRequest = {
    schemaVersion: 1,
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
    ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
    request: options.request,
    parentRunId: taskId,
    parentTaskId: taskId,
  };
  const requestPath = await writeParentRunRequest(request, taskId);
  const launchInput: LaunchTaskInput = {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
    taskId,
    name: options.name ?? summarizeTaskPrompt(options.request),
    plan: parentRunLaunchPlan({
      workspaceRoot: options.workspaceRoot,
      requestPath,
      cliEntryPath: context.cliEntryPath,
    }),
    location: {
      kind: "local",
      workspaceRoot: options.workspaceRoot,
      workspaceName: workspaceName(options.workspaceRoot),
      cwd: options.workspaceRoot,
    },
  };

  const task = await launchInBackground(launchInput, context);
  if (options.json && options.compact) {
    await printTaskSummaryJson(task, {
      ...options,
      wait: false,
    });
    return;
  }

  printTask(task, options.json);
}

async function executeParentRun(
  options: RunOptions & {
    parentRunId?: string;
    parentTaskId?: string;
    runEventSink?: RunEventSink;
  },
  context: RunCommandContext,
): Promise<ParentRunResult> {
  const runEvents = createRunStreamSequencer({ runId: options.parentRunId ?? randomUUID() });
  const persistedRunEvents = createQueuedRunEventSink(options.runEventSink);
  const shouldEmitRunLifecycle = options.streamJson || Boolean(options.runEventSink);
  let parentSessionId: string | undefined;
  let created: Awaited<ReturnType<typeof createOrchestratorParentSession>>;

  const publishRunEvent = (payload: Parameters<typeof runEvents.create>[0]): RunStreamEvent => {
    const event = runEvents.create(payload);
    if (options.streamJson) {
      writeRunJsonStreamEvent(event);
    }
    persistedRunEvents.write(event);
    return event;
  };

  try {
    created = await createOrchestratorParentSession({
      workspaceRoot: options.workspaceRoot,
      ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
      ...(options.configPath ? { configPath: options.configPath } : {}),
      ...(options.agentDir ? { agentDir: options.agentDir } : {}),
      ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
      parentRunId: runEvents.runId,
      ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
      parentSessionId: () => parentSessionId,
      configEnv: process.env,
      backgroundLauncher: (input) => launchInBackground(input, context),
      ...(options.traceTools === "off" && !options.streamJson && !options.runEventSink
        ? {}
        : {
            trace: (event) => {
              const shouldCreateRunEvents =
                options.streamJson ||
                options.traceTools === "text" ||
                Boolean(options.runEventSink);
              const traceEvents = shouldCreateRunEvents
                ? runStreamPayloadsFromParentToolTrace(event).map(publishRunEvent)
                : [];

              if (options.traceTools === "jsonl") {
                process.stderr.write(`${JSON.stringify(event)}\n`);
              } else if (options.traceTools === "text") {
                process.stderr.write(renderRunTraceEvents(traceEvents));
              }
            },
          }),
    });
  } catch (error) {
    if (shouldEmitRunLifecycle) {
      publishRunEvent({
        kind: "run.error",
        error: normalizeRunStreamError(error),
      });
      await persistedRunEvents.flush().catch(() => undefined);
    }
    throw error;
  }
  const { session, modelFallbackMessage } = created;
  parentSessionId = session.sessionId;

  try {
    if (shouldEmitRunLifecycle) {
      publishRunEvent({
        kind: "run.started",
        sessionId: session.sessionId,
        cwd: resolve(options.workspaceRoot),
        request: options.request,
      });
    }

    try {
      await session.prompt(buildOrchestratorParentPrompt(options.request), {
        expandPromptTemplates: false,
      });
    } catch (error) {
      if (shouldEmitRunLifecycle) {
        publishRunEvent({
          kind: "run.error",
          sessionId: session.sessionId,
          error: normalizeRunStreamError(error),
        });
        await persistedRunEvents.flush().catch(() => undefined);
      }
      throw error;
    }

    const output = session.getLastAssistantText() ?? "";
    if (shouldEmitRunLifecycle) {
      publishRunEvent({
        kind: "run.final",
        sessionId: session.sessionId,
        output,
        ...(modelFallbackMessage ? { modelFallbackMessage } : {}),
      });
    }
    await persistedRunEvents.flush();

    return {
      sessionId: session.sessionId,
      output,
      ...(modelFallbackMessage ? { modelFallbackMessage } : {}),
    };
  } finally {
    session.dispose();
  }
}

function createQueuedRunEventSink(sink: RunEventSink | undefined): {
  write: (event: RunStreamEvent) => void;
  flush: () => Promise<void>;
} {
  let writeQueue = Promise.resolve();
  let writeError: unknown;

  return {
    write(event) {
      if (!sink || writeError) {
        return;
      }
      writeQueue = writeQueue
        .then(async () => {
          await sink(event);
        })
        .catch((error: unknown) => {
          writeError = error;
        });
    },
    async flush() {
      await writeQueue;
      if (writeError) {
        throw writeError;
      }
    },
  };
}

function parentRunLaunchPlan(input: {
  workspaceRoot: string;
  requestPath: string;
  cliEntryPath: string;
}): AgentLaunchPlan {
  return {
    runtime: "orchestrator",
    displayName: "Orchestrator",
    executable: process.execPath,
    args: [
      "--experimental-strip-types",
      input.cliEntryPath,
      "__run-parent-task",
      input.requestPath,
    ],
    env: {},
    cwd: input.workspaceRoot,
    promptTransport: { kind: "sdk" },
    outputTransport: { kind: "stdout_text" },
    expectedProcesses: ["node"],
    interrupt: "process_group",
    canSteerRunning: false,
    handlesOwnAuth: true,
    enabled: true,
    safety: {
      acceptsShellCommand: false,
    },
  };
}

function writeRunJsonStreamEvent(event: RunStreamEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
