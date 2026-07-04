import { randomUUID } from "node:crypto";
import { captureProcessIdentity } from "../../observation.ts";
import { readTaskRecord, writeTaskHeartbeat } from "../../store.ts";
import type {
  AgentTaskRecord,
  TaskGoal,
  TaskGoalStatus,
  TaskOperation,
  TaskOperationStatus,
  TaskStatus,
  TaskUsage,
} from "../../types.ts";
import {
  TaskSendMessageError,
  type TaskExecutionContext,
  type TaskExecutionHandle,
  type TaskExecutor,
  type TaskSendMessageInput,
  type TaskSendMessageResult,
  type TaskStartGoalInput,
  type TaskStartGoalResult,
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
  sessionStartedAt?: string;
  currentSessionOperation?: CodexSessionOperationState;
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

type CodexSessionOperationState = {
  operation: TaskOperation;
  goal?: TaskGoal;
  finalAnswer?: string;
  deltaBuffer: string;
  lastUsage?: TaskUsage;
  started?: Deferred<string>;
  completed: Deferred<TaskOperation>;
  terminal: Deferred<CodexTerminalResult>;
  settled: boolean;
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

        if (state.currentSessionOperation?.operation.kind === "goal") {
          throw new TaskSendMessageError(
            "not_ready",
            "Codex app-server session is running a goal. Wait for the goal operation before sending normal work.",
          );
        }

        return context.input.plan.protocolExecutionMode === "session" && !state.turnId
          ? await startSessionTurn(context, state, client, input, text)
          : await steerActiveTurn(context, state, client, input, text);
      },
      async startGoal(input) {
        const goal = input.goal.trim();
        if (!goal) {
          throw new TaskSendMessageError("invalid_request", "Goal must not be empty.");
        }
        const client = state.client;
        if (!client) {
          throw new TaskSendMessageError(
            "not_running",
            "Codex app-server is not running for this task.",
          );
        }

        return await startSessionGoal(context, state, client, input, goal);
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

async function startSessionGoal(
  context: TaskExecutionContext,
  state: CodexExecutorState,
  client: JsonRpcStdioClient,
  input: TaskStartGoalInput,
  objective: string,
): Promise<TaskStartGoalResult> {
  if (context.input.plan.protocolExecutionMode !== "session") {
    throw new TaskSendMessageError(
      "unsupported",
      "Codex goals require a persistent codex-app-server session.",
    );
  }

  const threadId = state.threadId;
  if (!threadId) {
    throw new TaskSendMessageError(
      "not_ready",
      "Codex app-server session has not opened a provider thread yet.",
    );
  }
  if (state.turnId || (state.currentSessionOperation && !state.currentSessionOperation.settled)) {
    throw new TaskSendMessageError(
      "not_ready",
      "Codex app-server session is already running an operation.",
    );
  }

  const threadResponse = await client.request(
    "thread/read",
    { threadId },
    { timeoutMs: input.timeoutMs ?? SEND_MESSAGE_TIMEOUT_MS },
  );
  await appendProtocolResponse(context, "thread/read", threadResponse);
  assertThreadCanStartGoal(threadResponse, threadId);

  const existingGoalResponse = await client.request(
    "thread/goal/get",
    { threadId },
    { timeoutMs: input.timeoutMs ?? SEND_MESSAGE_TIMEOUT_MS },
  );
  await appendProtocolResponse(context, "thread/goal/get", existingGoalResponse);
  const existingGoal = extractGoal(existingGoalResponse);
  if (existingGoal && !isTerminalGoalStatus(existingGoal.status)) {
    throw new TaskSendMessageError(
      "not_ready",
      `Codex app-server thread already has an unfinished goal: ${existingGoal.status}.`,
    );
  }
  if (existingGoal) {
    const clearResponse = await client.request(
      "thread/goal/clear",
      { threadId },
      { timeoutMs: input.timeoutMs ?? SEND_MESSAGE_TIMEOUT_MS },
    );
    await appendProtocolResponse(context, "thread/goal/clear", clearResponse);
  }

  const operation = createSessionGoalOperation(threadId, objective);
  const operationState: CodexSessionOperationState = {
    operation,
    deltaBuffer: "",
    started: deferred<string>(),
    completed: deferred<TaskOperation>(),
    terminal: deferred<CodexTerminalResult>(),
    settled: false,
  };
  state.currentSessionOperation = operationState;
  state.turnCompleted = operationState.terminal.promise;
  state.terminalSettled = () => operationState.settled;

  await context.updateTask({
    session: sessionRecord(state, "goal_running", {
      currentOperationId: operation.operationId,
    }),
    currentOperation: operation,
  });
  await appendAgentEvent(
    context,
    "operation.started",
    compactData({
      operationId: operation.operationId,
      operationKind: operation.kind,
      threadId,
    }),
  );
  await appendAgentEvent(
    context,
    "protocol.goal.requested",
    compactData({
      threadId,
      operationId: operation.operationId,
      bytes: Buffer.byteLength(objective),
      tokenBudget: input.tokenBudget,
      clientMessageId: input.clientMessageId,
    }),
  );

  try {
    const response = await client.request(
      "thread/goal/set",
      {
        threadId,
        objective,
        status: "active",
        ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
      },
      { timeoutMs: input.timeoutMs ?? SEND_MESSAGE_TIMEOUT_MS },
    );
    await appendProtocolResponse(context, "thread/goal/set", response);
    const goal = extractGoal(response);
    if (!goal) {
      throw new TaskSendMessageError(
        "provider_rejected",
        "Codex app-server thread/goal/set response did not include goal state.",
      );
    }
    // Notifications can arrive immediately after the provider response and may
    // already have advanced the goal to a terminal state. Do not let the
    // response's accepted goal snapshot overwrite newer notification state.
    if (!operationState.settled && isTerminalGoalStatus(goal.status)) {
      await settleGoalOperation(context, state, operationState, goal);
    } else if (!operationState.settled) {
      operationState.goal = goal;
      operationState.operation = {
        ...operationState.operation,
        status: "running",
      };
      await context.updateTask({
        goal,
        session: sessionRecord(state, "goal_running", {
          currentOperationId: operation.operationId,
        }),
        currentOperation: operationState.operation,
      });
    }
    await appendAgentEvent(
      context,
      "protocol.goal.sent",
      compactData({
        threadId,
        operationId: operation.operationId,
        status: goal.status,
      }),
    );

    if (operationState.settled) {
      const completed = await operationState.completed.promise;
      if (completed.turnId) {
        await appendAgentEvent(
          context,
          "protocol.goal.started",
          compactData({
            threadId,
            turnId: completed.turnId,
            operationId: operation.operationId,
          }),
        );
      }
      return {
        status: "completed",
        provider: codexProvider(threadId, completed.turnId),
        ...(operationState.goal ? { goal: operationState.goal } : {}),
        operation: completed,
      };
    }

    const turnId = await waitForGoalTurnStart(operationState, input.timeoutMs);
    await appendAgentEvent(
      context,
      "protocol.goal.started",
      compactData({
        threadId,
        turnId,
        operationId: operation.operationId,
      }),
    );

    if (operationState.settled) {
      const completed = await operationState.completed.promise;
      return {
        status: "completed",
        provider: codexProvider(threadId, completed.turnId ?? turnId),
        ...(operationState.goal ? { goal: operationState.goal } : {}),
        operation: completed,
      };
    }

    if (input.wait) {
      const completed = await waitForSessionOperation(operationState, input.timeoutMs);
      return {
        status: "completed",
        provider: codexProvider(threadId, completed.turnId ?? turnId),
        ...(operationState.goal ? { goal: operationState.goal } : {}),
        operation: completed,
      };
    }

    return {
      status: "running",
      provider: codexProvider(threadId, turnId),
      ...(operationState.goal ? { goal: operationState.goal } : {}),
      operation: operationState.operation,
    };
  } catch (error: unknown) {
    if (
      error instanceof TaskSendMessageError &&
      error.reason === "timeout" &&
      operationState.operation.status === "running"
    ) {
      throw error;
    }
    await failSessionOperation(context, state, operationState, error);
    await appendAgentEvent(
      context,
      "protocol.goal.failed",
      compactData({
        threadId,
        operationId: operation.operationId,
        error: errorMessage(error),
      }),
    );
    if (error instanceof TaskSendMessageError) {
      throw error;
    }
    throw new TaskSendMessageError("provider_rejected", errorMessage(error));
  }
}

async function startSessionTurn(
  context: TaskExecutionContext,
  state: CodexExecutorState,
  client: JsonRpcStdioClient,
  input: TaskSendMessageInput,
  text: string,
): Promise<TaskSendMessageResult> {
  const threadId = state.threadId;
  if (!threadId) {
    throw new TaskSendMessageError(
      "not_ready",
      "Codex app-server session has not opened a provider thread yet.",
    );
  }
  if (state.currentSessionOperation && !state.currentSessionOperation.settled) {
    throw new TaskSendMessageError(
      "not_ready",
      "Codex app-server session is already running an operation.",
    );
  }

  const operation = createSessionTurnOperation(threadId, text);
  const operationState: CodexSessionOperationState = {
    operation,
    deltaBuffer: "",
    completed: deferred<TaskOperation>(),
    terminal: deferred<CodexTerminalResult>(),
    settled: false,
  };
  state.currentSessionOperation = operationState;
  state.turnCompleted = operationState.terminal.promise;
  state.terminalSettled = () => operationState.settled;

  await context.updateTask({
    session: sessionRecord(state, "turn_running", {
      currentOperationId: operation.operationId,
    }),
    currentOperation: operation,
  });
  await appendAgentEvent(
    context,
    "operation.started",
    compactData({
      operationId: operation.operationId,
      operationKind: operation.kind,
      threadId,
    }),
  );
  await appendAgentEvent(
    context,
    "protocol.message.requested",
    compactData({
      threadId,
      operationId: operation.operationId,
      bytes: Buffer.byteLength(text),
      clientMessageId: input.clientMessageId,
    }),
  );

  try {
    const response = await client.request(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text }],
        ...(context.input.model ? { model: context.input.model } : {}),
        ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
      },
      { timeoutMs: input.timeoutMs ?? SEND_MESSAGE_TIMEOUT_MS },
    );
    await appendProtocolResponse(context, "turn/start", response);
    const turnId = extractTurnId(response);
    if (!turnId) {
      throw new TaskSendMessageError(
        "provider_rejected",
        "Codex app-server turn/start response did not include turn.id.",
      );
    }

    if (!operationState.settled) {
      state.turnId = turnId;
      operationState.operation = {
        ...operationState.operation,
        status: "running",
        turnId,
      };
      await context.updateProvider({ turnId });
      if (!operationState.settled) {
        await context.updateTask({
          session: sessionRecord(state, "turn_running", {
            currentTurnId: turnId,
            currentOperationId: operation.operationId,
          }),
          currentOperation: operationState.operation,
        });
      }
    } else {
      await context.updateProvider({ turnId });
    }
    await appendAgentEvent(
      context,
      "protocol.message.sent",
      compactData({
        threadId,
        turnId,
        operationId: operation.operationId,
        clientMessageId: input.clientMessageId,
      }),
    );

    if (input.wait) {
      const completed = await waitForSessionOperation(operationState, input.timeoutMs);
      return {
        status: "completed",
        provider: codexProvider(threadId, completed.turnId ?? turnId),
        operation: completed,
      };
    }

    return {
      status: "running",
      provider: codexProvider(threadId, turnId),
      operation: operationState.operation,
    };
  } catch (error: unknown) {
    if (
      error instanceof TaskSendMessageError &&
      error.reason === "timeout" &&
      operationState.operation.status === "running"
    ) {
      throw error;
    }
    await failSessionOperation(context, state, operationState, error);
    await appendAgentEvent(
      context,
      "protocol.message.failed",
      compactData({
        threadId,
        operationId: operation.operationId,
        error: errorMessage(error),
      }),
    );
    if (error instanceof TaskSendMessageError) {
      throw error;
    }
    throw new TaskSendMessageError("provider_rejected", errorMessage(error));
  }
}

async function steerActiveTurn(
  context: TaskExecutionContext,
  state: CodexExecutorState,
  client: JsonRpcStdioClient,
  input: TaskSendMessageInput,
  text: string,
): Promise<TaskSendMessageResult> {
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

    if (input.wait && state.currentSessionOperation) {
      const completed = await waitForSessionOperation(
        state.currentSessionOperation,
        input.timeoutMs,
      );
      return {
        status: "completed",
        provider: codexProvider(state.threadId, completed.turnId ?? responseTurnId),
        operation: completed,
      };
    }

    return {
      status: "accepted",
      provider: codexProvider(state.threadId, state.turnId),
      ...(state.currentSessionOperation
        ? { operation: state.currentSessionOperation.operation }
        : {}),
    };
  } catch (error: unknown) {
    if (error instanceof TaskSendMessageError && error.reason === "timeout") {
      throw error;
    }
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
}

function createSessionTurnOperation(threadId: string, input: string): TaskOperation {
  return {
    operationId: randomUUID(),
    kind: "turn",
    status: "starting",
    threadId,
    input,
    startedAt: now(),
  };
}

function createSessionGoalOperation(threadId: string, objective: string): TaskOperation {
  return {
    operationId: randomUUID(),
    kind: "goal",
    status: "starting",
    threadId,
    objective,
    startedAt: now(),
  };
}

async function settleSessionOperation(
  context: TaskExecutionContext,
  state: CodexExecutorState,
  terminal: CodexTerminalResult,
): Promise<void> {
  const operationState = state.currentSessionOperation;
  if (!operationState || operationState.settled) {
    return;
  }

  const result = operationState.finalAnswer ?? operationState.deltaBuffer;
  const error =
    terminal.status === "cancelled" ? (state.cancelReason ?? terminal.error) : terminal.error;
  const usage = operationState.lastUsage
    ? { ...operationState.lastUsage, final: true, updatedAt: now() }
    : undefined;
  const completed: TaskOperation = {
    ...operationState.operation,
    status: operationStatusForTerminal(terminal.status),
    ...(result ? { result } : {}),
    ...(usage ? { usage } : {}),
    finishedAt: now(),
    ...(error ? { error } : {}),
  };

  operationState.operation = completed;
  operationState.settled = true;
  state.currentSessionOperation = undefined;
  state.turnId = undefined;
  state.turnCompleted = undefined;
  state.terminalSettled = undefined;

  await context.writeResult(result);
  if (usage) {
    await context.updateUsage(usage);
  }
  await context.updateTask({
    session: sessionRecord(state, "idle"),
    currentOperation: undefined,
    lastOperation: completed,
  });
  await appendAgentEvent(
    context,
    terminal.status === "succeeded" ? "operation.completed" : "operation.failed",
    compactData({
      operationId: completed.operationId,
      operationKind: completed.kind,
      threadId: completed.threadId,
      turnId: completed.turnId,
      status: completed.status,
      error: completed.error,
    }),
  );
  await appendAgentEvent(context, "session.idle", compactData({ threadId: state.threadId }));
  operationState.terminal.resolve(terminal);
  operationState.completed.resolve(completed);
}

async function settleGoalOperation(
  context: TaskExecutionContext,
  state: CodexExecutorState,
  operationState: CodexSessionOperationState,
  goal: TaskGoal,
): Promise<void> {
  if (operationState.settled) {
    return;
  }

  const result = operationState.finalAnswer ?? `Goal ${goal.status}: ${goal.objective}`;
  const usage = operationState.lastUsage
    ? { ...operationState.lastUsage, final: true, updatedAt: now() }
    : undefined;
  const completed: TaskOperation = {
    ...operationState.operation,
    status: operationStatusForGoalStatus(goal.status),
    objective: goal.objective,
    ...(result ? { result } : {}),
    ...(usage ? { usage } : {}),
    finishedAt: now(),
  };

  operationState.goal = goal;
  operationState.operation = completed;
  operationState.settled = true;
  state.currentSessionOperation = undefined;
  state.turnId = undefined;
  state.turnCompleted = undefined;
  state.terminalSettled = undefined;

  await context.writeResult(result);
  if (usage) {
    await context.updateUsage(usage);
  }
  await context.updateTask({
    goal,
    session: sessionRecord(state, "idle"),
    currentOperation: undefined,
    lastOperation: completed,
  });
  await appendAgentEvent(
    context,
    "operation.completed",
    compactData({
      operationId: completed.operationId,
      operationKind: completed.kind,
      threadId: completed.threadId,
      turnId: completed.turnId,
      status: completed.status,
      goalStatus: goal.status,
    }),
  );
  await appendAgentEvent(context, "session.idle", compactData({ threadId: state.threadId }));
  operationState.terminal.resolve({ status: "succeeded", exitCode: 0 });
  operationState.completed.resolve(completed);
}

async function observeGoalUpdated(
  context: TaskExecutionContext,
  state: CodexExecutorState,
  goal: TaskGoal,
): Promise<void> {
  const operationState = state.currentSessionOperation;
  if (!operationState || operationState.settled || operationState.operation.kind !== "goal") {
    await context.updateTask({ goal });
    return;
  }

  operationState.goal = goal;
  operationState.operation = {
    ...operationState.operation,
    objective: goal.objective,
    status: operationStatusForGoalStatus(goal.status),
  };

  if (isTerminalGoalStatus(goal.status) && !state.turnId) {
    await settleGoalOperation(context, state, operationState, goal);
    return;
  }

  await context.updateTask({
    goal,
    session: sessionRecord(state, "goal_running", {
      ...(state.turnId ? { currentTurnId: state.turnId } : {}),
      currentOperationId: operationState.operation.operationId,
    }),
    currentOperation: operationState.operation,
  });
}

async function observeGoalCleared(
  context: TaskExecutionContext,
  state: CodexExecutorState,
  threadId: string | undefined,
): Promise<void> {
  const operationState = state.currentSessionOperation;
  if (!operationState || operationState.settled || operationState.operation.kind !== "goal") {
    await context.updateTask({ goal: undefined });
    return;
  }

  await failSessionOperation(
    context,
    state,
    operationState,
    new TaskSendMessageError(
      "provider_rejected",
      `Codex app-server goal was cleared${threadId ? ` for thread "${threadId}"` : ""}.`,
    ),
  );
}

async function observeGoalTurnCompleted(
  context: TaskExecutionContext,
  state: CodexExecutorState,
  terminal: CodexTerminalResult,
): Promise<void> {
  const operationState = state.currentSessionOperation;
  if (!operationState || operationState.settled || operationState.operation.kind !== "goal") {
    return;
  }

  if (terminal.status !== "succeeded") {
    await settleSessionOperation(context, state, terminal);
    return;
  }

  state.turnId = undefined;
  operationState.operation = {
    ...operationState.operation,
    status: operationState.goal
      ? operationStatusForGoalStatus(operationState.goal.status)
      : "running",
  };

  if (operationState.goal && isTerminalGoalStatus(operationState.goal.status)) {
    await settleGoalOperation(context, state, operationState, operationState.goal);
    return;
  }

  await context.updateTask({
    session: sessionRecord(state, "goal_running", {
      currentOperationId: operationState.operation.operationId,
    }),
    currentOperation: operationState.operation,
  });
}

async function failSessionOperation(
  context: TaskExecutionContext,
  state: CodexExecutorState,
  operationState: CodexSessionOperationState,
  error: unknown,
): Promise<void> {
  if (operationState.settled) {
    return;
  }
  const message = errorMessage(error);
  const failed: TaskOperation = {
    ...operationState.operation,
    status: "failed",
    error: message,
    finishedAt: now(),
  };
  operationState.operation = failed;
  operationState.settled = true;
  state.currentSessionOperation = undefined;
  state.turnId = undefined;
  state.turnCompleted = undefined;
  state.terminalSettled = undefined;
  await context.updateTask({
    session: sessionRecord(state, "idle"),
    currentOperation: undefined,
    lastOperation: failed,
  });
  await appendAgentEvent(
    context,
    "operation.failed",
    compactData({
      operationId: failed.operationId,
      operationKind: failed.kind,
      threadId: failed.threadId,
      turnId: failed.turnId,
      status: failed.status,
      error: failed.error,
    }),
  );
  operationState.terminal.resolve({ status: "failed", error: message, exitCode: null });
  operationState.completed.resolve(failed);
}

async function waitForSessionOperation(
  operationState: CodexSessionOperationState,
  timeoutMs: number | undefined,
): Promise<TaskOperation> {
  if (timeoutMs === undefined) {
    return await operationState.completed.promise;
  }
  return await Promise.race([
    operationState.completed.promise,
    delay(timeoutMs).then(() => {
      throw new TaskSendMessageError(
        "timeout",
        `Timed out waiting for operation "${operationState.operation.operationId}" to complete.`,
      );
    }),
  ]);
}

async function waitForGoalTurnStart(
  operationState: CodexSessionOperationState,
  timeoutMs: number | undefined,
): Promise<string> {
  if (!operationState.started) {
    throw new TaskSendMessageError(
      "provider_rejected",
      `Goal operation "${operationState.operation.operationId}" cannot observe provider turn start.`,
    );
  }

  const wait = operationState.started.promise;
  if (timeoutMs === undefined) {
    return await wait;
  }

  return await Promise.race([
    wait,
    delay(timeoutMs).then(() => {
      throw new TaskSendMessageError(
        "timeout",
        `Timed out waiting for goal operation "${operationState.operation.operationId}" to start.`,
      );
    }),
  ]);
}

function operationStatusForTerminal(status: TaskStatus): TaskOperationStatus {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "cancelled":
      return "interrupted";
    case "failed":
    case "timed_out":
      return "failed";
    case "queued":
    case "starting":
    case "running":
      return "running";
  }
}

function operationStatusForGoalStatus(status: TaskGoalStatus): TaskOperationStatus {
  return status === "active" ? "running" : status;
}

function sessionRecord(
  state: CodexExecutorState,
  sessionState: "starting" | "idle" | "turn_running" | "goal_running" | "stopping" | "closed",
  details: { currentTurnId?: string; currentOperationId?: string } = {},
) {
  return {
    kind: "codex-app-server" as const,
    state: sessionState,
    ...(state.threadId ? { threadId: state.threadId } : {}),
    ...(details.currentTurnId ? { currentTurnId: details.currentTurnId } : {}),
    ...(details.currentOperationId ? { currentOperationId: details.currentOperationId } : {}),
    startedAt: state.sessionStartedAt ?? now(),
    updatedAt: now(),
  };
}

function codexProvider(threadId: string, turnId?: string) {
  return {
    provider: "codex" as const,
    protocol: "jsonrpc" as const,
    transport: "stdio" as const,
    threadId,
    ...(turnId ? { turnId } : {}),
  };
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
        const operationState = state.currentSessionOperation;
        if (!operationState || operationState.settled) {
          return;
        }
        state.turnId = turnId;
        if (!operationState.operation.turnId) {
          operationState.operation = {
            ...operationState.operation,
            status: "running",
            turnId,
          };
        }
        operationState.started?.resolve(turnId);
      },
      appendDelta: (delta) => {
        const operationState = state.currentSessionOperation;
        if (operationState && !operationState.settled) {
          operationState.deltaBuffer += delta;
        }
      },
      setFinalAnswer: (text) => {
        const operationState = state.currentSessionOperation;
        if (operationState && !operationState.settled) {
          operationState.finalAnswer = text;
        }
      },
      setLastUsage: (usage) => {
        const operationState = state.currentSessionOperation;
        if (operationState && !operationState.settled) {
          operationState.lastUsage = usage;
        }
      },
      onTurnStarted: async (threadId, turnId) => {
        const operationState = state.currentSessionOperation;
        if (!operationState || operationState.settled) {
          return;
        }
        await context.updateProvider({ turnId });
        await context.updateTask({
          session: sessionRecord(
            state,
            operationState.operation.kind === "goal" ? "goal_running" : "turn_running",
            {
              currentTurnId: turnId,
              currentOperationId: operationState.operation.operationId,
            },
          ),
          currentOperation: operationState.operation,
        });
        await appendAgentEvent(
          context,
          "operation.turn.started",
          compactData({
            operationId: operationState.operation.operationId,
            operationKind: operationState.operation.kind,
            threadId,
            turnId,
          }),
        );
      },
      setGoal: async (goal) => {
        await observeGoalUpdated(context, state, goal);
      },
      clearGoal: async (threadId) => {
        await observeGoalCleared(context, state, threadId);
      },
      settleTurn: async (terminal) => {
        if (state.currentSessionOperation?.operation.kind === "goal") {
          await observeGoalTurnCompleted(context, state, terminal);
          return;
        }
        await settleSessionOperation(context, state, terminal);
      },
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
    state.sessionStartedAt = startedAt;
    await context.setStatus("running", {
      startedAt,
      ...(client.pid ? { pid: client.pid } : {}),
      session: sessionRecord(state, "starting"),
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
      session: sessionRecord(state, "idle"),
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
    onTurnStarted?(threadId: string | undefined, turnId: string | undefined): Promise<void>;
    appendDelta(delta: string): void;
    setFinalAnswer(text: string): void;
    setLastUsage(usage: TaskUsage): void;
    setGoal?(goal: TaskGoal): Promise<void>;
    clearGoal?(threadId: string | undefined): Promise<void>;
    settleTurn(result: CodexTerminalResult): void | Promise<void>;
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

  // Capture state-bearing notifications before any async writes. The JSON-RPC
  // transport dispatches notifications in order, but observers run concurrently;
  // awaiting transcript/event writes before updating state can let turn/completed
  // settle an operation before the final answer or usage has been recorded.
  switch (notification.method) {
    case "item/agentMessage/delta":
    case "item/agent_message/delta": {
      const delta = stringValue(params.delta) ?? "";
      if (delta) {
        handlers.appendDelta(delta);
      }
      break;
    }
    case "item/completed": {
      const item = isRecord(params.item) ? params.item : undefined;
      const itemType = item ? stringValue(item.type) : undefined;
      const text = item ? stringValue(item.text) : undefined;
      if (itemType === "agentMessage" && text !== undefined) {
        handlers.setFinalAnswer(text);
      }
      break;
    }
    case "thread/tokenUsage/updated": {
      const usage = usageFromParams(params);
      if (usage) {
        handlers.setLastUsage(usage);
      }
      break;
    }
    case "thread/goal/updated": {
      const goal = goalFromParams(params);
      if (goal && handlers.setGoal) {
        await handlers.setGoal(goal);
      }
      break;
    }
  }

  const terminal = terminalResultForNotification(notification.method, params);
  if (terminal) {
    await handlers.settleTurn(terminal);
  }

  await context.appendTranscript(notification);

  switch (notification.method) {
    case "thread/started":
      await appendAgentEvent(context, "thread.started", compactData({ threadId }));
      return;
    case "turn/started":
      if (handlers.onTurnStarted) {
        await handlers.onTurnStarted(threadId, turnId);
      }
      await appendAgentEvent(context, "turn.started", compactData({ threadId, turnId }));
      return;
    case "thread/goal/updated": {
      const goal = goalFromParams(params);
      await appendAgentEvent(
        context,
        "goal.updated",
        compactData({
          threadId,
          objective: goal?.objective,
          status: goal?.status,
          tokenBudget: goal?.tokenBudget,
          tokensUsed: goal?.tokensUsed,
          timeUsedSeconds: goal?.timeUsedSeconds,
        }),
      );
      return;
    }
    case "thread/goal/cleared": {
      if (handlers.clearGoal) {
        await handlers.clearGoal(threadId);
      }
      await appendAgentEvent(context, "goal.cleared", compactData({ threadId }));
      return;
    }
    case "item/started":
      await appendAgentEvent(context, "agent.item.started", compactData({ threadId, turnId }));
      return;
    case "item/agentMessage/delta":
    case "item/agent_message/delta": {
      await appendAgentEvent(context, "agent.message.delta", compactData({ threadId, turnId }));
      return;
    }
    case "item/completed": {
      const item = isRecord(params.item) ? params.item : undefined;
      const itemType = item ? stringValue(item.type) : undefined;
      const text = item ? stringValue(item.text) : undefined;
      if (itemType === "agentMessage" && text !== undefined) {
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

function extractGoal(response: unknown): TaskGoal | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  return isRecord(response.goal) ? codexGoalFromRecord(response.goal) : undefined;
}

function goalFromParams(params: Record<string, unknown>): TaskGoal | undefined {
  return isRecord(params.goal) ? codexGoalFromRecord(params.goal) : undefined;
}

function codexGoalFromRecord(value: Record<string, unknown>): TaskGoal | undefined {
  const threadId = stringValue(value.threadId) ?? stringValue(value.thread_id);
  const objective = stringValue(value.objective);
  const status = normalizeGoalStatus(value.status);
  if (!threadId || !objective || !status) {
    return undefined;
  }

  const goal: TaskGoal = {
    provider: "codex",
    threadId,
    objective,
    status,
  };
  assignNumber(goal, "tokenBudget", value.tokenBudget);
  assignNumber(goal, "tokensUsed", value.tokensUsed);
  assignNumber(goal, "timeUsedSeconds", value.timeUsedSeconds);
  assignDateString(goal, "createdAt", value.createdAt);
  assignDateString(goal, "updatedAt", value.updatedAt);
  return goal;
}

function normalizeGoalStatus(value: unknown): TaskGoalStatus | undefined {
  switch (value) {
    case "active":
    case "paused":
    case "blocked":
    case "complete":
      return value;
    case "usageLimited":
    case "usage_limited":
      return "usage_limited";
    case "budgetLimited":
    case "budget_limited":
      return "budget_limited";
    default:
      return undefined;
  }
}

function isTerminalGoalStatus(status: TaskGoalStatus): boolean {
  return status !== "active";
}

function assertThreadCanStartGoal(response: unknown, threadId: string): void {
  const thread = isRecord(response) && isRecord(response.thread) ? response.thread : undefined;
  if (!thread) {
    throw new TaskSendMessageError(
      "provider_rejected",
      "Codex app-server thread/read response did not include thread state.",
    );
  }

  const responseThreadId = stringValue(thread.id);
  if (responseThreadId && responseThreadId !== threadId) {
    throw new TaskSendMessageError(
      "turn_mismatch",
      `Codex app-server read thread "${responseThreadId}" while Orchestrator expected "${threadId}".`,
    );
  }

  const status = threadStatusLabel(thread.status);
  if (status && status !== "idle") {
    throw new TaskSendMessageError(
      "not_ready",
      `Codex app-server thread must be idle before starting a goal; current status is "${status}".`,
    );
  }

  if (thread.ephemeral === true || thread.path === null) {
    throw new TaskSendMessageError(
      "unsupported",
      "Codex app-server goals require a persisted provider thread.",
    );
  }
}

function threadStatusLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = stringValue(value.status) ?? stringValue(value.type) ?? stringValue(value.kind);
  if (direct) {
    return direct;
  }
  const root = isRecord(value.root) ? value.root : undefined;
  return root
    ? (stringValue(root.status) ?? stringValue(root.type) ?? stringValue(root.kind))
    : undefined;
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

function assignDateString<T extends Record<string, unknown>>(
  target: T,
  key: keyof T,
  value: unknown,
): void {
  if (typeof value === "string" && value.trim()) {
    target[key] = value as T[keyof T];
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = new Date(value).toISOString() as T[keyof T];
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

function deferred<T>(): Deferred<T> {
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
