import { captureProcessIdentity } from "../../observation.ts";
import { readTaskRecord, writeTaskHeartbeat } from "../../store.ts";
import type { AgentTaskRecord, TaskStatus, TaskUsage } from "../../types.ts";
import {
  TaskSendMessageError,
  type TaskExecutionContext,
  type TaskExecutionHandle,
  type TaskExecutor,
} from "../types.ts";
import {
  JsonRpcStdioClientError,
  startJsonRpcStdioClient,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
  type JsonRpcStdioClient,
} from "./json-rpc-stdio.ts";

const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_STALE_AFTER_MS = 20_000;
const INTERRUPT_REQUEST_TIMEOUT_MS = 1_000;
const INTERRUPT_SETTLE_TIMEOUT_MS = 2_000;
const SEND_MESSAGE_TIMEOUT_MS = 5_000;
const CODEX_APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

type CodexExecutorState = {
  client?: JsonRpcStdioClient;
  threadId?: string;
  turnId?: string;
  cancelRequested: boolean;
  cancelReason?: string;
  timedOut: boolean;
  turnCompleted?: Promise<CodexTerminalResult>;
  terminalSettled?: () => boolean;
};

type CodexTerminalResult = {
  status: TaskStatus;
  error?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

export class CodexAppServerTaskExecutor implements TaskExecutor {
  start(context: TaskExecutionContext): TaskExecutionHandle {
    const state: CodexExecutorState = {
      cancelRequested: false,
      timedOut: false,
    };
    const completed =
      context.input.plan.protocolExecutionMode === "session"
        ? runCodexAppServerSession(context, state)
        : runCodexAppServerTask(context, state);

    return {
      completed,
      async sendMessage(input) {
        const text = input.text.trim();
        if (!text) {
          throw new TaskSendMessageError("invalid_request", "Message must not be empty.");
        }
        const client = state.client;
        if (!client) {
          throw new TaskSendMessageError(
            "not_running",
            "Codex app-server is not running for this task.",
          );
        }
        if (!state.threadId || !state.turnId) {
          throw new TaskSendMessageError(
            "not_ready",
            "Codex app-server has not started a turn for this task yet.",
          );
        }

        await appendAgentEvent(
          context,
          "protocol.message.requested",
          compactData({
            threadId: state.threadId,
            turnId: state.turnId,
            bytes: Buffer.byteLength(text),
            clientMessageId: input.clientMessageId,
          }),
        );

        try {
          const response = await client.request(
            "turn/steer",
            {
              threadId: state.threadId,
              expectedTurnId: state.turnId,
              input: [{ type: "text", text }],
              ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
            },
            { timeoutMs: input.timeoutMs ?? SEND_MESSAGE_TIMEOUT_MS },
          );
          await appendProtocolResponse(context, "turn/steer", response);
          const responseTurnId = extractTurnId(response);
          if (!responseTurnId) {
            throw new TaskSendMessageError(
              "provider_rejected",
              "Codex app-server turn/steer response did not include turn.id.",
            );
          }
          if (responseTurnId !== state.turnId) {
            throw new TaskSendMessageError(
              "turn_mismatch",
              `Codex app-server accepted message for turn "${responseTurnId}" while Orchestrator expected "${state.turnId}".`,
            );
          }

          await appendAgentEvent(
            context,
            "protocol.message.sent",
            compactData({
              threadId: state.threadId,
              turnId: state.turnId,
              clientMessageId: input.clientMessageId,
            }),
          );
          return {
            status: "accepted",
            provider: {
              provider: "codex",
              protocol: "jsonrpc",
              transport: "stdio",
              threadId: state.threadId,
              turnId: state.turnId,
            },
          };
        } catch (error: unknown) {
          await appendAgentEvent(
            context,
            "protocol.message.failed",
            compactData({
              threadId: state.threadId,
              turnId: state.turnId,
              error: errorMessage(error),
            }),
          );
          if (error instanceof TaskSendMessageError) {
            throw error;
          }
          throw new TaskSendMessageError("provider_rejected", errorMessage(error));
        }
      },
      async interrupt(reason: string, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
        state.cancelRequested = true;
        state.cancelReason = reason;
        const client = state.client;
        if (!client) {
          return;
        }

        await appendInterruptEvent(context, "protocol.interrupt.requested", {
          hasThreadId: Boolean(state.threadId),
          hasTurnId: Boolean(state.turnId),
          signal,
        });

        if (
          context.input.plan.protocolExecutionMode === "session" &&
          state.threadId &&
          !state.turnId
        ) {
          await appendInterruptEvent(context, "protocol.interrupt.session_idle", {
            threadId: state.threadId,
            signal,
          });
        } else if (state.threadId && state.turnId) {
          try {
            await client.request(
              "turn/interrupt",
              {
                threadId: state.threadId,
                turnId: state.turnId,
              },
              { timeoutMs: INTERRUPT_REQUEST_TIMEOUT_MS },
            );
            await appendInterruptEvent(context, "protocol.interrupt.sent", {
              threadId: state.threadId,
              turnId: state.turnId,
            });

            const settled = await waitForProtocolInterruptSettle(state);
            if (settled) {
              await appendInterruptEvent(context, "protocol.interrupt.settled", {
                status: settled.status,
              });
              return;
            }

            await appendInterruptEvent(context, "protocol.interrupt.settle_timeout", {
              timeoutMs: INTERRUPT_SETTLE_TIMEOUT_MS,
            });
          } catch (error) {
            await appendInterruptEvent(context, "protocol.interrupt.request_failed", {
              error: errorMessage(error),
            });
          }
        } else if (context.input.plan.protocolExecutionMode !== "session") {
          await appendInterruptEvent(context, "protocol.interrupt.missing_turn", {
            hasThreadId: Boolean(state.threadId),
            hasTurnId: Boolean(state.turnId),
          });
        }

        await appendInterruptEvent(context, "protocol.interrupt.fallback_kill", { signal });
        client.kill(signal);
      },
    };
  }
}

async function runCodexAppServerTask(
  context: TaskExecutionContext,
  state: CodexExecutorState,
): Promise<AgentTaskRecord> {
  const taskText = context.input.plan.taskForProtocol;
  if (!taskText) {
    await context.writeResult("");
    return await context.markTerminal(
      "failed",
      { exitCode: null, error: "Protocol runtime did not receive task text." },
      { error: "Protocol runtime did not receive task text." },
    );
  }

  let heartbeat: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  const pendingNotificationWrites = new Set<Promise<void>>();
  const turnCompleted = deferred<CodexTerminalResult>();
  let terminalSettled = false;
  let finalAnswer: string | undefined;
  let deltaBuffer = "";
  let lastUsage: TaskUsage | undefined;

  const settleTurn = (result: CodexTerminalResult): void => {
    if (terminalSettled) {
      return;
    }
    terminalSettled = true;
    turnCompleted.resolve(result);
  };
  state.turnCompleted = turnCompleted.promise;
  state.terminalSettled = () => terminalSettled;

  const client = startJsonRpcStdioClient({
    executable: context.input.plan.executable,
    args: context.input.plan.args,
    cwd: context.input.plan.cwd,
    env: context.input.plan.env,
    requestTimeoutMs: Math.min(context.input.timeoutMs ?? 60_000, 60_000),
    onServerRequest: async (request) => await handleServerRequest(context, request),
    onProtocolError: (error) => {
      void context.appendStderr(`${error.message}\n`).catch(() => undefined);
      void context
        .appendTranscript({
          direction: "protocol_error",
          error: error.message,
          code: error.code,
          ...(error.details !== undefined ? { details: error.details } : {}),
        })
        .catch(() => undefined);
    },
  });
  state.client = client;

  const subscription = client.subscribeNotifications({}, (notification) => {
    const write = handleNotification(context, notification, {
      setThreadId: (threadId) => {
        state.threadId = state.threadId ?? threadId;
      },
      setTurnId: (turnId) => {
        state.turnId = state.turnId ?? turnId;
      },
      appendDelta: (delta) => {
        deltaBuffer += delta;
      },
      setFinalAnswer: (text) => {
        finalAnswer = text;
      },
      setLastUsage: (usage) => {
        lastUsage = usage;
      },
      settleTurn,
    });
    pendingNotificationWrites.add(write);
    write.finally(() => pendingNotificationWrites.delete(write));
    return write;
  });

  void client.closed.then(async (closed) => {
    if (!terminalSettled) {
      const externalStopReason = await readExternalStopReason(context);
      const wasCancelled = state.cancelRequested || externalStopReason !== undefined;
      settleTurn({
        status: wasCancelled ? "cancelled" : "failed",
        exitCode: closed.exitCode,
        signal: closed.signal,
        error: wasCancelled
          ? (state.cancelReason ?? externalStopReason ?? "Interrupted.")
          : `Codex app-server exited before the turn completed.`,
      });
    }
  });

  try {
    const startedAt = now();
    await context.setStatus("running", {
      startedAt,
      ...(client.pid ? { pid: client.pid } : {}),
    });
    await context.appendEvent("running", { pid: client.pid ?? null });
    heartbeat = await startHeartbeat(context, client.pid, startedAt);

    if (context.input.timeoutMs) {
      timeout = setTimeout(() => {
        state.timedOut = true;
        client.kill("SIGTERM");
        const wasCancelled = state.cancelRequested;
        settleTurn({
          status: wasCancelled ? "cancelled" : "timed_out",
          exitCode: null,
          error: wasCancelled
            ? (state.cancelReason ?? "Interrupted.")
            : `Timed out after ${context.input.timeoutMs}ms.`,
        });
      }, context.input.timeoutMs);
      timeout.unref();
    }

    const initializeResponse = await client.request("initialize", {
      clientInfo: {
        name: "orchestrator",
        title: "Orchestrator",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    await appendProtocolResponse(context, "initialize", initializeResponse);
    await client.notify("initialized");

    const threadId = await openCodexThread(context, state, client);

    const turnResponse = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: taskText }],
      ...(context.input.model ? { model: context.input.model } : {}),
    });
    await appendProtocolResponse(context, "turn/start", turnResponse);
    const turnId = extractTurnId(turnResponse);
    if (!turnId) {
      throw new Error("Codex app-server turn/start response did not include turn.id.");
    }
    state.turnId = turnId;
    await context.updateProvider({ turnId });

    const terminal = await turnCompleted.promise;
    await Promise.all(pendingNotificationWrites);

    const resultText = finalAnswer ?? deltaBuffer;
    const terminalError =
      terminal.status === "cancelled" ? (state.cancelReason ?? terminal.error) : terminal.error;
    await context.writeResult(resultText);
    if (lastUsage) {
      await context.updateUsage({ ...lastUsage, final: true, updatedAt: now() });
    }

    return await context.markTerminal(
      terminal.status,
      {
        exitCode: terminal.exitCode ?? null,
        ...(terminalError ? { error: terminalError } : {}),
        ...(lastUsage ? { usage: { ...lastUsage, final: true, updatedAt: now() } } : {}),
      },
      {
        ...(terminalError ? { error: terminalError } : {}),
        ...(terminal.signal ? { signal: terminal.signal } : {}),
      },
    );
  } catch (error) {
    const status = state.cancelRequested ? "cancelled" : state.timedOut ? "timed_out" : "failed";
    const message = state.cancelRequested
      ? (state.cancelReason ?? "Interrupted.")
      : errorMessage(error);
    await context.appendStderr(`${message}\n`).catch(() => undefined);
    await context.writeResult(finalAnswer ?? deltaBuffer);
    return await context.markTerminal(
      status,
      {
        exitCode: null,
        error: message,
      },
      { error: message },
    );
  } finally {
    subscription.unsubscribe();
    if (timeout) {
      clearTimeout(timeout);
    }
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    const close = await client.close().catch((error: unknown) => {
      void context.appendStderr(`${errorMessage(error)}\n`).catch(() => undefined);
      return undefined;
    });
    if (close?.stderr) {
      await context.appendStderr(close.stderr).catch(() => undefined);
      await context.appendCombined(close.stderr).catch(() => undefined);
    }
  }
}

async function runCodexAppServerSession(
  context: TaskExecutionContext,
  state: CodexExecutorState,
): Promise<AgentTaskRecord> {
  let heartbeat: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  const pendingNotificationWrites = new Set<Promise<void>>();
  const sessionClosed = deferred<CodexTerminalResult>();
  let terminalSettled = false;

  const settleSession = (result: CodexTerminalResult): void => {
    if (terminalSettled) {
      return;
    }
    terminalSettled = true;
    sessionClosed.resolve(result);
  };
  state.terminalSettled = () => terminalSettled;

  const client = startJsonRpcStdioClient({
    executable: context.input.plan.executable,
    args: context.input.plan.args,
    cwd: context.input.plan.cwd,
    env: context.input.plan.env,
    requestTimeoutMs: Math.min(context.input.timeoutMs ?? 60_000, 60_000),
    onServerRequest: async (request) => await handleServerRequest(context, request),
    onProtocolError: (error) => {
      void context.appendStderr(`${error.message}\n`).catch(() => undefined);
      void context
        .appendTranscript({
          direction: "protocol_error",
          error: error.message,
          code: error.code,
          ...(error.details !== undefined ? { details: error.details } : {}),
        })
        .catch(() => undefined);
    },
  });
  state.client = client;

  const subscription = client.subscribeNotifications({}, (notification) => {
    const write = handleNotification(context, notification, {
      setThreadId: (threadId) => {
        state.threadId = state.threadId ?? threadId;
      },
      setTurnId: (turnId) => {
        state.turnId = state.turnId ?? turnId;
      },
      appendDelta: () => {},
      setFinalAnswer: () => {},
      setLastUsage: () => {},
      settleTurn: settleSession,
    });
    pendingNotificationWrites.add(write);
    write.finally(() => pendingNotificationWrites.delete(write));
    return write;
  });

  void client.closed.then(async (closed) => {
    if (!terminalSettled) {
      const externalStopReason = await readExternalStopReason(context);
      const wasCancelled = state.cancelRequested || externalStopReason !== undefined;
      settleSession({
        status: wasCancelled ? "cancelled" : "failed",
        exitCode: closed.exitCode,
        signal: closed.signal,
        error: wasCancelled
          ? (state.cancelReason ?? externalStopReason ?? "Interrupted.")
          : "Codex app-server session exited unexpectedly.",
      });
    }
  });

  try {
    const startedAt = now();
    await context.setStatus("running", {
      startedAt,
      ...(client.pid ? { pid: client.pid } : {}),
      session: {
        kind: "codex-app-server",
        state: "starting",
        startedAt,
        updatedAt: startedAt,
      },
    });
    await context.appendEvent("running", { pid: client.pid ?? null });
    heartbeat = await startHeartbeat(context, client.pid, startedAt);

    if (context.input.timeoutMs) {
      timeout = setTimeout(() => {
        state.timedOut = true;
        client.kill("SIGTERM");
        const wasCancelled = state.cancelRequested;
        settleSession({
          status: wasCancelled ? "cancelled" : "timed_out",
          exitCode: null,
          error: wasCancelled
            ? (state.cancelReason ?? "Interrupted.")
            : `Timed out after ${context.input.timeoutMs}ms.`,
        });
      }, context.input.timeoutMs);
      timeout.unref();
    }

    const initializeResponse = await client.request("initialize", {
      clientInfo: {
        name: "orchestrator",
        title: "Orchestrator",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    await appendProtocolResponse(context, "initialize", initializeResponse);
    await client.notify("initialized");

    const threadId = await openCodexThread(context, state, client);
    await context.updateTask({
      session: {
        kind: "codex-app-server",
        state: "idle",
        threadId,
        startedAt,
        updatedAt: now(),
      },
    });
    await appendAgentEvent(context, "session.idle", compactData({ threadId }));

    const terminal = await sessionClosed.promise;
    await Promise.all(pendingNotificationWrites);

    const terminalError =
      terminal.status === "cancelled" ? (state.cancelReason ?? terminal.error) : terminal.error;
    return await context.markTerminal(
      terminal.status,
      {
        exitCode: terminal.exitCode ?? null,
        ...(terminalError ? { error: terminalError } : {}),
        session: {
          kind: "codex-app-server",
          state: "closed",
          threadId,
          startedAt,
          updatedAt: now(),
        },
      },
      {
        ...(terminalError ? { error: terminalError } : {}),
        ...(terminal.signal ? { signal: terminal.signal } : {}),
      },
    );
  } catch (error) {
    const status = state.cancelRequested ? "cancelled" : state.timedOut ? "timed_out" : "failed";
    const message = state.cancelRequested
      ? (state.cancelReason ?? "Interrupted.")
      : errorMessage(error);
    await context.appendStderr(`${message}\n`).catch(() => undefined);
    return await context.markTerminal(
      status,
      {
        exitCode: null,
        error: message,
        session: {
          kind: "codex-app-server",
          state: "closed",
          ...(state.threadId ? { threadId: state.threadId } : {}),
          startedAt: context.task.startedAt ?? context.task.createdAt,
          updatedAt: now(),
        },
      },
      { error: message },
    );
  } finally {
    subscription.unsubscribe();
    if (timeout) {
      clearTimeout(timeout);
    }
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    const close = await client.close().catch((error: unknown) => {
      void context.appendStderr(`${errorMessage(error)}\n`).catch(() => undefined);
      return undefined;
    });
    if (close?.stderr) {
      await context.appendStderr(close.stderr).catch(() => undefined);
      await context.appendCombined(close.stderr).catch(() => undefined);
    }
  }
}

async function openCodexThread(
  context: TaskExecutionContext,
  state: CodexExecutorState,
  client: JsonRpcStdioClient,
): Promise<string> {
  if (context.input.plan.resume) {
    if (context.input.plan.resume.provider !== "codex") {
      throw new Error(
        `Codex app-server resume plan used unsupported provider "${context.input.plan.resume.provider}".`,
      );
    }

    const resumeThreadId = context.input.plan.resume.threadId?.trim();
    if (!resumeThreadId) {
      throw new Error("Codex app-server resume plan did not include provider.threadId.");
    }

    const threadResponse = await client.request("thread/resume", {
      threadId: resumeThreadId,
      cwd: context.input.plan.cwd,
      ...(context.input.model ? { model: context.input.model } : {}),
      excludeTurns: true,
    });
    await appendProtocolResponse(context, "thread/resume", threadResponse);
    const threadId = extractThreadId(threadResponse);
    if (!threadId) {
      throw new Error("Codex app-server thread/resume response did not include thread.id.");
    }
    if (threadId !== resumeThreadId) {
      throw new Error(
        `Codex app-server resumed thread "${threadId}" but Orchestrator requested "${resumeThreadId}".`,
      );
    }

    state.threadId = threadId;
    await context.updateProvider({
      provider: "codex",
      protocol: "jsonrpc",
      transport: "stdio",
      threadId,
    });
    await appendAgentEvent(context, "thread.resumed", compactData({ threadId }));
    return threadId;
  }

  const threadResponse = await client.request("thread/start", {
    cwd: context.input.plan.cwd,
    ...(context.input.model ? { model: context.input.model } : {}),
    ephemeral: context.input.plan.protocolExecutionMode !== "session",
  });
  await appendProtocolResponse(context, "thread/start", threadResponse);
  const threadId = extractThreadId(threadResponse);
  if (!threadId) {
    throw new Error("Codex app-server thread/start response did not include thread.id.");
  }
  state.threadId = threadId;
  await context.updateProvider({
    provider: "codex",
    protocol: "jsonrpc",
    transport: "stdio",
    threadId,
  });
  await appendAgentEvent(context, "thread.started", compactData({ threadId }));
  return threadId;
}

async function handleServerRequest(
  context: TaskExecutionContext,
  request: JsonRpcServerRequest,
): Promise<unknown> {
  await context.appendTranscript({
    direction: "server_request",
    method: request.method,
    id: request.id,
    ...(request.params !== undefined ? { params: request.params } : {}),
  });
  await context.appendEvent("agent_event", {
    runtime: context.input.plan.runtime,
    source: "protocol",
    kind: "server.request",
    method: request.method,
  });

  if (CODEX_APPROVAL_REQUEST_METHODS.has(request.method)) {
    return { decision: "accept" };
  }

  return {};
}

async function handleNotification(
  context: TaskExecutionContext,
  notification: JsonRpcNotification,
  handlers: {
    setThreadId(threadId: string): void;
    setTurnId(turnId: string): void;
    appendDelta(delta: string): void;
    setFinalAnswer(text: string): void;
    setLastUsage(usage: TaskUsage): void;
    settleTurn(result: CodexTerminalResult): void;
  },
): Promise<void> {
  const params = isRecord(notification.params) ? notification.params : {};
  const threadId = stringValue(params.threadId) ?? stringValue(params.thread_id);
  const turnId =
    stringValue(params.turnId) ?? stringValue(params.turn_id) ?? turnIdFromParams(params);
  if (threadId) {
    handlers.setThreadId(threadId);
  }
  if (turnId) {
    handlers.setTurnId(turnId);
  }

  const terminal = terminalResultForNotification(notification.method, params);
  if (terminal) {
    handlers.settleTurn(terminal);
  }

  await context.appendTranscript(notification);

  switch (notification.method) {
    case "thread/started":
      await appendAgentEvent(context, "thread.started", compactData({ threadId }));
      return;
    case "turn/started":
      await appendAgentEvent(context, "turn.started", compactData({ threadId, turnId }));
      return;
    case "item/started":
      await appendAgentEvent(context, "agent.item.started", compactData({ threadId, turnId }));
      return;
    case "item/agentMessage/delta":
    case "item/agent_message/delta": {
      const delta = stringValue(params.delta) ?? "";
      if (delta) {
        handlers.appendDelta(delta);
      }
      await appendAgentEvent(context, "agent.message.delta", compactData({ threadId, turnId }));
      return;
    }
    case "item/completed": {
      const item = isRecord(params.item) ? params.item : undefined;
      const itemType = item ? stringValue(item.type) : undefined;
      const text = item ? stringValue(item.text) : undefined;
      if (itemType === "agentMessage" && text !== undefined) {
        handlers.setFinalAnswer(text);
        await appendAgentEvent(context, "agent.message", compactData({ threadId, turnId, text }));
        return;
      }
      await appendAgentEvent(
        context,
        itemType === "commandExecution" ? "agent.command" : "agent.item.completed",
        compactData({ threadId, turnId, itemType }),
      );
      return;
    }
    case "turn/plan/updated":
      await appendAgentEvent(context, "agent.plan", compactData({ threadId, turnId }));
      return;
    case "turn/diff/updated":
      await appendAgentEvent(context, "agent.diff", compactData({ threadId, turnId }));
      return;
    case "thread/tokenUsage/updated": {
      const usage = usageFromParams(params);
      if (usage) {
        handlers.setLastUsage(usage);
        await context.updateUsage(usage);
      }
      await appendAgentEvent(context, "agent.usage", compactData({ threadId, turnId, usage }));
      return;
    }
    case "turn/completed": {
      const turn = isRecord(params.turn) ? params.turn : undefined;
      const status = turn ? stringValue(turn.status) : undefined;
      const error =
        terminal?.status === "failed"
          ? (stringValue(turn?.error) ?? errorMessageFromRecord(turn))
          : undefined;
      await appendAgentEvent(
        context,
        "turn.completed",
        compactData({ threadId, turnId, status, error }),
      );
      return;
    }
    case "error": {
      const message = stringValue(params.message) ?? "Codex app-server protocol error.";
      await appendAgentEvent(context, "runtime.error", compactData({ threadId, turnId, message }));
      return;
    }
    default:
      return;
  }
}

function terminalResultForNotification(
  method: string,
  params: Record<string, unknown>,
): CodexTerminalResult | undefined {
  if (method === "turn/completed") {
    const turn = isRecord(params.turn) ? params.turn : undefined;
    const status = turn ? stringValue(turn.status) : undefined;
    const mapped = mapTurnStatus(status);
    const error =
      mapped === "failed" ? (stringValue(turn?.error) ?? errorMessageFromRecord(turn)) : undefined;
    return {
      status: mapped,
      exitCode: mapped === "succeeded" ? 0 : null,
      ...(error ? { error } : {}),
    };
  }

  if (method === "error") {
    return {
      status: "failed",
      exitCode: null,
      error: stringValue(params.message) ?? "Codex app-server protocol error.",
    };
  }

  return undefined;
}

async function appendAgentEvent(
  context: TaskExecutionContext,
  kind: string,
  data: Record<string, unknown>,
): Promise<void> {
  await context.appendEvent("agent_event", {
    runtime: context.input.plan.runtime,
    source: "protocol",
    kind,
    ...data,
  });
}

async function appendInterruptEvent(
  context: TaskExecutionContext,
  kind: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await appendAgentEvent(context, kind, compactData(data)).catch((error: unknown) => {
    void context.appendStderr(`${errorMessage(error)}\n`).catch(() => undefined);
  });
}

async function waitForProtocolInterruptSettle(
  state: CodexExecutorState,
): Promise<CodexTerminalResult | undefined> {
  if (!state.turnCompleted) {
    return undefined;
  }
  if (state.terminalSettled?.()) {
    return await state.turnCompleted;
  }

  return await Promise.race([
    state.turnCompleted,
    delay(INTERRUPT_SETTLE_TIMEOUT_MS).then(() => undefined),
  ]);
}

async function readExternalStopReason(context: TaskExecutionContext): Promise<string | undefined> {
  try {
    const latest = await readTaskRecord(
      {
        workspaceRoot: context.input.workspaceRoot,
        ...(context.input.orchestratorDir
          ? { orchestratorDir: context.input.orchestratorDir }
          : {}),
      },
      context.taskId,
    );
    return latest.stopRequestedAt ? (latest.stopReason ?? "Interrupted.") : undefined;
  } catch {
    return undefined;
  }
}

async function appendProtocolResponse(
  context: TaskExecutionContext,
  method: string,
  result: unknown,
): Promise<void> {
  await context.appendTranscript({
    direction: "response",
    method,
    result,
  });
}

async function startHeartbeat(
  context: TaskExecutionContext,
  pid: number | undefined,
  startedAt: string,
): Promise<NodeJS.Timeout | undefined> {
  if (!pid) {
    return undefined;
  }
  const supervisorIdentity = await captureProcessIdentity(process.pid);
  const childIdentity = await captureProcessIdentity(pid);
  if (!supervisorIdentity || !childIdentity) {
    return undefined;
  }
  const supervision = {
    supervisor: supervisorIdentity,
    child: childIdentity,
    ...(process.platform !== "win32" ? { processGroupId: pid } : {}),
    startedAt,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    staleAfterMs: HEARTBEAT_STALE_AFTER_MS,
  };
  await context.updateTask({ supervision });

  const writeHeartbeat = async (): Promise<void> => {
    await writeTaskHeartbeat(context.paths, {
      taskId: context.taskId,
      supervisorPid: supervisorIdentity.pid,
      childPid: childIdentity.pid,
      ...(process.platform !== "win32" ? { processGroupId: pid } : {}),
      lastHeartbeatAt: now(),
    });
  };
  await writeHeartbeat();
  const heartbeat = setInterval(() => {
    void writeHeartbeat().catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  return heartbeat;
}

function extractThreadId(response: unknown): string | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  if (typeof response.threadId === "string") {
    return response.threadId;
  }
  return isRecord(response.thread) ? stringValue(response.thread.id) : undefined;
}

function extractTurnId(response: unknown): string | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  if (typeof response.turnId === "string") {
    return response.turnId;
  }
  return isRecord(response.turn) ? stringValue(response.turn.id) : undefined;
}

function turnIdFromParams(params: Record<string, unknown>): string | undefined {
  if (isRecord(params.turn)) {
    return stringValue(params.turn.id);
  }
  return undefined;
}

function usageFromParams(params: Record<string, unknown>): TaskUsage | undefined {
  const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : undefined;
  const last = tokenUsage && isRecord(tokenUsage.last) ? tokenUsage.last : undefined;
  if (!last) {
    return undefined;
  }
  const usage: TaskUsage = {
    updatedAt: now(),
    source: "provider",
    scope: "turn",
    final: false,
  };
  assignNumber(usage, "inputTokens", last.inputTokens);
  assignNumber(usage, "outputTokens", last.outputTokens);
  assignNumber(usage, "cacheReadTokens", last.cachedInputTokens);
  assignNumber(usage, "reasoningTokens", last.reasoningOutputTokens);
  assignNumber(usage, "totalTokens", last.totalTokens);
  return Object.keys(usage).length > 4 ? usage : undefined;
}

function assignNumber<T extends Record<string, unknown>>(
  target: T,
  key: keyof T,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value as T[keyof T];
  }
}

function mapTurnStatus(status: string | undefined): TaskStatus {
  switch (status) {
    case "completed":
      return "succeeded";
    case "interrupted":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof JsonRpcStdioClientError && error.stderr) {
    return `${error.message}\n${error.stderr}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function errorMessageFromRecord(value: Record<string, unknown> | undefined): string | undefined {
  const error = value && isRecord(value.error) ? value.error : undefined;
  return error ? stringValue(error.message) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function compactData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function now(): string {
  return new Date().toISOString();
}
