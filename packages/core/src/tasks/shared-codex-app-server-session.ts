import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentLaunchPlan } from "../runtime/index.ts";
import type { TaskControlResponse } from "./control.ts";
import {
  connectCodexAppServer,
  ensureCodexAppServer,
  type CodexAppServerConnection,
  type CodexAppServerEndpoint,
} from "./executors/protocol/codex-app-server-controller.ts";
import { TaskSendMessageError, type TaskGoalControlInput } from "./executors/types.ts";
import {
  appendSequencedTaskEvent,
  getTaskPaths,
  initializeTaskFiles,
  localTaskLocation,
  readTaskRecord,
  resolveTaskId,
  updateTaskStatus,
} from "./store.ts";
import { selectTaskUsage } from "./usage.ts";
import type {
  AgentTaskRecord,
  LaunchTaskInput,
  TaskEvent,
  TaskGoal,
  TaskGoalStatus,
  TaskOperation,
  TaskOperationStatus,
  TaskPaths,
  TaskProviderMetadata,
  TaskStatus,
  TaskStoreOptions,
  TaskUsage,
} from "./types.ts";

const HEARTBEAT_STALE_AFTER_MS = 20_000;
const SEND_MESSAGE_TIMEOUT_MS = 5_000;
const INTERRUPT_REQUEST_TIMEOUT_MS = 1_000;
const OPERATION_MONITOR_RECONCILE_INTERVAL_MS = 1_000;
const TEST_SOCKET_PATH_ENV = "ORCHESTRATOR_CODEX_APP_SERVER_SOCKET_PATH";

type SharedSessionContext = {
  store: TaskStoreOptions;
  taskId: string;
  task: AgentTaskRecord;
  paths: TaskPaths;
  appendEvent(type: TaskEvent["type"], data?: Record<string, unknown>): Promise<TaskEvent>;
  appendTranscript(line: string | Record<string, unknown>): Promise<void>;
  updateTask(patch: Partial<AgentTaskRecord>): Promise<AgentTaskRecord>;
  updateProvider(provider: TaskProviderMetadata): Promise<void>;
  updateUsage(usage: TaskUsage): Promise<void>;
  writeResult(text: string): Promise<void>;
};

type SharedOperationState = {
  operation: TaskOperation;
  goal?: TaskGoal;
  finalAnswer?: string;
  deltaBuffer: string;
  lastUsage?: TaskUsage;
  completed: Deferred<TaskOperation>;
  settled: boolean;
};

export type MonitorSharedCodexAppServerSessionOperationInput = TaskStoreOptions & {
  taskId: string;
  operationId: string;
  timeoutMs?: number;
};

type TaskOperationMonitorClaim = {
  schemaVersion: 1;
  operationId: string;
  taskId: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
};

type MonitorClaimResult =
  | { claimed: true; claimPath: string }
  | { claimed: false; ownerPid?: number };

type CodexTerminalResult = {
  status: TaskStatus;
  error?: string;
  exitCode?: number | null;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

export function isSharedCodexAppServerSessionPlan(plan: AgentLaunchPlan): boolean {
  return plan.runtime === "codex-app-server" && plan.protocolExecutionMode === "session";
}

export function isSharedCodexAppServerSessionTask(task: AgentTaskRecord): boolean {
  return (
    task.runtime === "codex-app-server" &&
    task.launchPlan.protocolExecutionMode === "session" &&
    task.provider?.provider === "codex" &&
    task.provider.transport === "unix" &&
    Boolean(task.provider.threadId)
  );
}

export async function launchSharedCodexAppServerSessionTask(
  input: LaunchTaskInput,
): Promise<AgentTaskRecord> {
  const taskName = normalizeTaskName(input.name);
  const taskId = input.taskId ?? randomUUID();
  const paths = getTaskPaths(input, taskId);
  const createdAt = now();
  const location = input.location ?? localTaskLocation(input.workspaceRoot, input.plan.cwd);
  const initialTask: AgentTaskRecord = {
    taskId,
    ...(taskName ? { name: taskName } : {}),
    ...(input.model ? { model: input.model } : {}),
    runtime: input.plan.runtime,
    launchPlan: input.plan,
    cwd: input.plan.cwd,
    status: "queued",
    createdAt,
    ...(input.parent ? { parent: input.parent } : {}),
    ...(input.resume ? { resume: input.resume } : {}),
    storeScope: input.orchestratorDir ? "custom" : "machine",
    location,
    ...(input.labels ? { labels: { ...input.labels } } : {}),
    paths,
  };

  await initializeTaskFiles(initialTask);
  const context = makeSharedSessionContext(input, initialTask);
  await context.appendEvent("queued", { runtime: input.plan.runtime });
  await appendParentAndResumeEvents(context, input);
  let task = await updateTaskStatus(initialTask, "starting");
  context.task = task;
  await context.appendEvent("starting", {
    executable: input.plan.executable,
    args: input.plan.args,
    cwd: input.plan.cwd,
  });

  try {
    const endpoint = await ensureSharedEndpoint(input);
    const connection = await connectSharedCodexAppServer(endpoint);
    try {
      const startedAt = now();
      task = await context.updateTask({
        status: "running",
        startedAt,
        session: sessionRecord(startedAt, "starting"),
      });
      await context.appendEvent("running", { provider: "codex", transport: "unix" });
      const threadId = await openSharedThread(input, context, connection);
      const provider = codexProvider(threadId);
      await context.updateProvider(provider);
      task = await context.updateTask({
        provider,
        session: sessionRecord(startedAt, "idle", { threadId }),
        supervision: {
          kind: "provider",
          provider: "codex",
          transport: "unix",
          socketPath: endpoint.socketPath,
          ...(endpoint.pid ? { backendPid: endpoint.pid } : {}),
          startedAt,
          staleAfterMs: HEARTBEAT_STALE_AFTER_MS,
          lastVerifiedAt: now(),
        },
      });
      await appendAgentEvent(context, input.plan.runtime, "session.idle", { threadId });
      return task;
    } finally {
      await connection.close();
    }
  } catch (error) {
    const message = errorMessage(error);
    await context.appendEvent("stderr", { bytes: Buffer.byteLength(message) });
    await writeFile(paths.stderrLog, `${message}\n`);
    await writeFile(paths.combinedLog, `${message}\n`);
    return await updateTaskStatus(context.task, "failed", {
      finishedAt: now(),
      exitCode: null,
      error: message,
      session: {
        kind: "codex-app-server",
        state: "closed",
        startedAt: context.task.startedAt ?? context.task.createdAt,
        updatedAt: now(),
      },
    });
  }
}

export async function sendSharedCodexAppServerSessionMessage(input: {
  store: TaskStoreOptions;
  task: AgentTaskRecord;
  text: string;
  clientMessageId?: string;
  timeoutMs?: number;
  wait?: boolean;
}): Promise<TaskControlResponse> {
  return await controlResponse(input.task, "send_message", async () => {
    const context = makeSharedSessionContext(input.store, input.task);
    const threadId = requireThreadId(input.task);
    const endpoint = endpointForTask(input.task);
    const connection = await connectSharedCodexAppServer(endpoint);
    const operation = createSessionTurnOperation(threadId, input.text);
    const operationState: SharedOperationState = {
      operation,
      deltaBuffer: "",
      completed: deferred<TaskOperation>(),
      settled: false,
    };
    const subscription = subscribeOperationNotifications(context, connection, operationState);

    try {
      await context.updateTask({
        session: sessionRecord(input.task.session?.startedAt ?? now(), "turn_running", {
          threadId,
          currentOperationId: operation.operationId,
        }),
        currentOperation: operation,
      });
      await appendAgentEvent(context, input.task.runtime, "operation.started", {
        operationId: operation.operationId,
        operationKind: operation.kind,
        threadId,
      });

      const isActiveTurn =
        input.task.currentOperation?.kind === "turn" &&
        input.task.currentOperation.status === "running" &&
        Boolean(input.task.currentOperation.turnId ?? input.task.provider?.turnId);
      if (!isActiveTurn) {
        const readResponse = await connection.readThread(threadId, {
          timeoutMs: input.timeoutMs ?? SEND_MESSAGE_TIMEOUT_MS,
        });
        await appendProtocolResponse(context, "thread/read", readResponse);
        assertThreadIdle(readResponse, threadId);
      }
      const response = isActiveTurn
        ? await connection.steerTurn(
            {
              threadId,
              expectedTurnId:
                input.task.currentOperation?.turnId ?? input.task.provider?.turnId ?? "",
              input: [{ type: "text", text: input.text }],
              ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
            },
            { timeoutMs: input.timeoutMs ?? SEND_MESSAGE_TIMEOUT_MS },
          )
        : await connection.startTurn(
            {
              threadId,
              input: [{ type: "text", text: input.text }],
              ...(input.task.model ? { model: input.task.model } : {}),
              ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
            },
            { timeoutMs: input.timeoutMs ?? SEND_MESSAGE_TIMEOUT_MS },
          );
      await appendProtocolResponse(context, isActiveTurn ? "turn/steer" : "turn/start", response);
      const turnId = extractTurnId(response);
      if (!turnId) {
        throw new TaskSendMessageError(
          "provider_rejected",
          "Codex app-server turn response did not include turn.id.",
        );
      }
      operationState.operation = { ...operationState.operation, status: "running", turnId };
      await context.updateProvider({ turnId });
      await context.updateTask({
        session: sessionRecord(input.task.session?.startedAt ?? now(), "turn_running", {
          threadId,
          currentTurnId: turnId,
          currentOperationId: operation.operationId,
        }),
        currentOperation: operationState.operation,
      });
      await appendAgentEvent(context, input.task.runtime, "protocol.message.sent", {
        threadId,
        turnId,
        operationId: operation.operationId,
        clientMessageId: input.clientMessageId,
      });

      if (input.wait) {
        const completed = await waitForOperation(operationState, input.timeoutMs);
        return {
          status: "completed",
          provider: codexProvider(threadId, completed.turnId ?? turnId),
          operation: completed,
        };
      }

      return {
        status: isActiveTurn ? "accepted" : "running",
        provider: codexProvider(threadId, turnId),
        operation: operationState.operation,
      };
    } catch (error) {
      await failOperation(context, input.task, operationState, error);
      throw error;
    } finally {
      subscription.unsubscribe();
      await connection.close();
    }
  });
}

export async function startSharedCodexAppServerSessionGoal(input: {
  store: TaskStoreOptions;
  task: AgentTaskRecord;
  goal: string;
  clientMessageId?: string;
  timeoutMs?: number;
  wait?: boolean;
  tokenBudget?: number;
}): Promise<TaskControlResponse> {
  return await controlResponse(input.task, "goal_start", async () => {
    const context = makeSharedSessionContext(input.store, input.task);
    const threadId = requireThreadId(input.task);
    const endpoint = endpointForTask(input.task);
    const connection = await connectSharedCodexAppServer(endpoint);
    const operation = createSessionGoalOperation(threadId, input.goal);
    const operationState: SharedOperationState = {
      operation,
      deltaBuffer: "",
      completed: deferred<TaskOperation>(),
      settled: false,
    };
    const subscription = subscribeOperationNotifications(context, connection, operationState);

    try {
      const readResponse = await connection.readThread(threadId, {
        timeoutMs: input.timeoutMs ?? SEND_MESSAGE_TIMEOUT_MS,
      });
      await appendProtocolResponse(context, "thread/read", readResponse);
      assertThreadIdle(readResponse, threadId);

      await context.updateTask({
        session: sessionRecord(input.task.session?.startedAt ?? now(), "goal_running", {
          threadId,
          currentOperationId: operation.operationId,
        }),
        currentOperation: operation,
      });
      await appendAgentEvent(context, input.task.runtime, "operation.started", {
        operationId: operation.operationId,
        operationKind: operation.kind,
        threadId,
      });
      await appendAgentEvent(context, input.task.runtime, "protocol.goal.requested", {
        threadId,
        operationId: operation.operationId,
        bytes: Buffer.byteLength(input.goal),
        tokenBudget: input.tokenBudget,
        clientMessageId: input.clientMessageId,
      });

      const response = await connection.setGoal(
        {
          threadId,
          objective: input.goal,
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
      operationState.goal = goal;
      operationState.operation = {
        ...operationState.operation,
        status: operationStatusForGoalStatus(goal.status),
      };
      await context.updateTask({
        goal,
        session: sessionRecord(input.task.session?.startedAt ?? now(), "goal_running", {
          threadId,
          currentOperationId: operation.operationId,
        }),
        currentOperation: operationState.operation,
      });

      if (isTerminalGoalStatus(goal.status)) {
        const completed = await settleGoalOperation(context, input.task, operationState, goal);
        return {
          status: "completed",
          provider: codexProvider(threadId, completed.turnId),
          goal,
          operation: completed,
        };
      }

      if (input.wait) {
        const completed = await waitForOperation(operationState, input.timeoutMs);
        return {
          status: "completed",
          provider: codexProvider(threadId, completed.turnId),
          ...(operationState.goal ? { goal: operationState.goal } : { goal }),
          operation: completed,
        };
      }

      return {
        status: "running",
        provider: codexProvider(threadId),
        goal,
        operation: operationState.operation,
      };
    } catch (error) {
      await failOperation(context, input.task, operationState, error);
      throw error;
    } finally {
      subscription.unsubscribe();
      await connection.close();
    }
  });
}

export async function controlSharedCodexAppServerSessionGoal(input: {
  store: TaskStoreOptions;
  task: AgentTaskRecord;
  control: TaskGoalControlInput;
}): Promise<TaskControlResponse> {
  return await controlResponse(
    input.task,
    "goal_control",
    async () => {
      const context = makeSharedSessionContext(input.store, input.task);
      const threadId = requireThreadId(input.task);
      const endpoint = endpointForTask(input.task);
      const connection = await connectSharedCodexAppServer(endpoint);
      try {
        if (input.control.action === "get") {
          const response = await connection.getGoal(threadId, {
            timeoutMs: input.control.timeoutMs ?? SEND_MESSAGE_TIMEOUT_MS,
          });
          await appendProtocolResponse(context, "thread/goal/get", response);
          const goal = extractGoal(response);
          await context.updateTask(goal ? { goal } : { goal: undefined });
          return { status: "completed", provider: codexProvider(threadId), goal };
        }

        if (input.control.action === "clear") {
          const response = await connection.clearGoal(threadId, {
            timeoutMs: input.control.timeoutMs ?? SEND_MESSAGE_TIMEOUT_MS,
          });
          await appendProtocolResponse(context, "thread/goal/clear", response);
          const cleared = extractGoalCleared(response);
          if (cleared) {
            await context.updateTask({ goal: undefined });
          }
          return { status: "completed", provider: codexProvider(threadId), cleared };
        }

        const response = await connection.setGoal(
          {
            threadId,
            ...(input.control.objective ? { objective: input.control.objective } : {}),
            ...(input.control.status ? { status: codexGoalStatus(input.control.status) } : {}),
            ...(Object.prototype.hasOwnProperty.call(input.control, "tokenBudget")
              ? { tokenBudget: input.control.tokenBudget ?? null }
              : {}),
          },
          { timeoutMs: input.control.timeoutMs ?? SEND_MESSAGE_TIMEOUT_MS },
        );
        await appendProtocolResponse(context, "thread/goal/set", response);
        const goal = extractGoal(response);
        if (!goal) {
          throw new TaskSendMessageError(
            "provider_rejected",
            "Codex app-server thread/goal/set response did not include goal state.",
          );
        }
        await context.updateTask({ goal });
        return { status: "completed", provider: codexProvider(threadId), goal };
      } finally {
        await connection.close();
      }
    },
    input.control.action,
  );
}

export async function monitorSharedCodexAppServerSessionOperation(
  input: MonitorSharedCodexAppServerSessionOperationInput,
): Promise<AgentTaskRecord> {
  const taskId = await resolveTaskId(input, input.taskId);
  let task = await readTaskRecord(input, taskId);
  if (!isSharedCodexAppServerSessionTask(task)) {
    throw new TaskSendMessageError(
      "unsupported",
      `Task "${taskId.slice(0, 8)}" is not a shared Codex app-server session.`,
    );
  }
  if (!shouldMonitorOperation(task.currentOperation, input.operationId)) {
    return task;
  }

  const context = makeSharedSessionContext(input, task);
  const claim = await claimOperationMonitor(task.paths, task.taskId, input.operationId);
  if (!claim.claimed) {
    return await readTaskRecord(input, task.taskId);
  }

  try {
    await appendAgentEvent(context, task.runtime, "operation.monitor.started", {
      operationId: input.operationId,
      pid: process.pid,
    });
    task = await runSharedCodexAppServerSessionOperationMonitor(context, input);
    return task;
  } catch (error) {
    await appendAgentEvent(context, task.runtime, "operation.monitor_failed", {
      operationId: input.operationId,
      error: errorMessage(error),
    });
    return await readTaskRecord(input, task.taskId);
  } finally {
    await releaseOperationMonitorClaim(claim.claimPath);
  }
}

export async function interruptSharedCodexAppServerSession(input: {
  store: TaskStoreOptions;
  task: AgentTaskRecord;
  reason: string;
  signal?: NodeJS.Signals;
}): Promise<AgentTaskRecord> {
  const context = makeSharedSessionContext(input.store, input.task);
  const threadId = requireThreadId(input.task);
  const turnId = input.task.currentOperation?.turnId ?? input.task.provider?.turnId;
  let task = await updateTaskStatus(input.task, input.task.status, {
    stopRequestedAt: input.task.stopRequestedAt ?? now(),
    stopReason: input.reason,
    stopSignal: input.signal ?? "SIGTERM",
    session: sessionRecord(input.task.session?.startedAt ?? now(), "stopping", {
      threadId,
      ...(turnId ? { currentTurnId: turnId } : {}),
      ...(input.task.currentOperation?.operationId
        ? { currentOperationId: input.task.currentOperation.operationId }
        : {}),
    }),
  });
  await context.appendEvent("interrupt_requested", { reason: input.reason });
  if (turnId) {
    const connection = await connectSharedCodexAppServer(endpointForTask(task));
    try {
      await connection.interruptTurn(
        { threadId, turnId },
        { timeoutMs: INTERRUPT_REQUEST_TIMEOUT_MS },
      );
      await appendAgentEvent(context, task.runtime, "protocol.interrupt.sent", {
        threadId,
        turnId,
      });
    } catch (error) {
      await appendAgentEvent(context, task.runtime, "protocol.interrupt.request_failed", {
        threadId,
        turnId,
        error: errorMessage(error),
      });
    } finally {
      await connection.close();
    }
  }

  const interruptedOperation = task.currentOperation
    ? {
        ...task.currentOperation,
        status: "interrupted" as const,
        finishedAt: now(),
        error: input.reason,
      }
    : undefined;
  task = await updateTaskStatus(task, "cancelled", {
    finishedAt: now(),
    exitCode: null,
    error: input.reason,
    currentOperation: undefined,
    ...(interruptedOperation ? { lastOperation: interruptedOperation } : {}),
    session: {
      kind: "codex-app-server",
      state: "closed",
      threadId,
      startedAt: input.task.session?.startedAt ?? input.task.startedAt ?? input.task.createdAt,
      updatedAt: now(),
    },
  });
  await context.appendEvent("cancelled", { error: input.reason });
  return task;
}

async function runSharedCodexAppServerSessionOperationMonitor(
  context: SharedSessionContext,
  input: MonitorSharedCodexAppServerSessionOperationInput,
): Promise<AgentTaskRecord> {
  const task = await readTaskRecord(input, context.taskId);
  const operation = task.currentOperation;
  if (!shouldMonitorOperation(operation, input.operationId)) {
    return task;
  }

  context.task = task;
  const threadId = operation.threadId ?? requireThreadId(task);
  const operationState: SharedOperationState = {
    operation: { ...operation, threadId },
    ...(operation.kind === "goal" && task.goal ? { goal: task.goal } : {}),
    deltaBuffer: "",
    completed: deferred<TaskOperation>(),
    settled: false,
  };
  const connection = await connectSharedCodexAppServer(endpointForTask(task));
  const subscription = subscribeOperationNotifications(context, connection, operationState);

  try {
    const resume = await connection.resumeThread(
      {
        threadId,
        cwd: task.cwd,
        ...(task.model ? { model: task.model } : {}),
        initialTurnsPage: {
          limit: 10,
          sortDirection: "desc",
          itemsView: "full",
        },
      },
      { timeoutMs: SEND_MESSAGE_TIMEOUT_MS },
    );
    await appendProtocolResponse(context, "thread/resume", resume);
    await reconcileOperationFromResponse(context, connection, operationState, resume);
    await reconcileOperation(context, connection, operationState);
    await waitForMonitoredOperation(context, connection, operationState, input.timeoutMs);
    return await readTaskRecord(input, context.taskId);
  } finally {
    subscription.unsubscribe();
    await connection.close();
  }
}

async function waitForMonitoredOperation(
  context: SharedSessionContext,
  connection: CodexAppServerConnection,
  operationState: SharedOperationState,
  timeoutMs: number | undefined,
): Promise<void> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  while (!operationState.settled) {
    const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      throw new TaskSendMessageError(
        "timeout",
        `Timed out monitoring operation "${operationState.operation.operationId}".`,
      );
    }

    const waitMs =
      remainingMs === undefined
        ? OPERATION_MONITOR_RECONCILE_INTERVAL_MS
        : Math.min(OPERATION_MONITOR_RECONCILE_INTERVAL_MS, remainingMs);
    const result = await Promise.race([
      operationState.completed.promise.then(() => "completed" as const),
      delay(waitMs).then(() => "reconcile" as const),
    ]);
    if (result === "completed") {
      return;
    }
    await reconcileOperation(context, connection, operationState);
  }
}

async function reconcileOperation(
  context: SharedSessionContext,
  connection: CodexAppServerConnection,
  operationState: SharedOperationState,
): Promise<void> {
  if (operationState.settled) {
    return;
  }
  const latest = await readTaskRecord(context.store, context.taskId);
  if (!shouldMonitorOperation(latest.currentOperation, operationState.operation.operationId)) {
    operationState.settled = true;
    operationState.completed.resolve(latest.lastOperation ?? operationState.operation);
    return;
  }
  context.task = latest;

  if (operationState.operation.kind === "goal") {
    await reconcileGoalOperation(context, connection, operationState);
    return;
  }
  const response = await connection.readThread(
    operationState.operation.threadId ?? requireThreadId(latest),
    {
      timeoutMs: SEND_MESSAGE_TIMEOUT_MS,
      includeTurns: true,
    },
  );
  await appendProtocolResponse(context, "thread/read", response);
  await reconcileOperationFromResponse(context, connection, operationState, response);
}

async function reconcileOperationFromResponse(
  context: SharedSessionContext,
  _connection: CodexAppServerConnection,
  operationState: SharedOperationState,
  response: unknown,
): Promise<void> {
  if (operationState.operation.kind !== "turn" || operationState.settled) {
    return;
  }
  const turn = findOperationTurn(response, operationState.operation);
  if (turn) {
    const turnId = stringValue(turn.id);
    if (turnId && !operationState.operation.turnId) {
      operationState.operation = { ...operationState.operation, turnId };
      await context.updateProvider({ turnId });
    }
    const result = finalAnswerFromTurn(turn);
    if (result !== undefined) {
      operationState.finalAnswer = result;
    }
    const usage = usageFromRecord(turn);
    if (usage) {
      operationState.lastUsage = usage;
      await context.updateUsage(usage);
    }
    const status = stringValue(turn.status);
    if (isTerminalTurnStatus(status)) {
      await settleOperation(context, context.task, operationState, {
        status: mapTurnStatus(status),
        exitCode: status === "completed" ? 0 : null,
        ...(errorMessageFromRecord(turn) ? { error: errorMessageFromRecord(turn) } : {}),
      });
      return;
    }
  }

  const thread = threadFromResponse(response);
  if (threadStatusLabel(thread?.status) === "idle") {
    await failOperation(
      context,
      context.task,
      operationState,
      new TaskSendMessageError(
        "provider_rejected",
        "Codex app-server thread is idle but Orchestrator could not find the monitored turn.",
      ),
    );
  }
}

async function reconcileGoalOperation(
  context: SharedSessionContext,
  connection: CodexAppServerConnection,
  operationState: SharedOperationState,
): Promise<void> {
  const threadId = operationState.operation.threadId ?? requireThreadId(context.task);
  const response = await connection.getGoal(threadId, {
    timeoutMs: SEND_MESSAGE_TIMEOUT_MS,
  });
  await appendProtocolResponse(context, "thread/goal/get", response);
  const goal = extractGoal(response);
  if (!goal) {
    await failOperation(
      context,
      context.task,
      operationState,
      new TaskSendMessageError(
        "provider_rejected",
        "Codex app-server thread has no goal for the monitored goal operation.",
      ),
    );
    return;
  }

  operationState.goal = goal;
  await context.updateTask({ goal });
  if (isTerminalGoalStatus(goal.status)) {
    await settleGoalOperation(context, context.task, operationState, goal);
  }
}

async function openSharedThread(
  input: LaunchTaskInput,
  context: SharedSessionContext,
  connection: CodexAppServerConnection,
): Promise<string> {
  if (input.plan.resume) {
    if (input.plan.resume.provider !== "codex" || !input.plan.resume.threadId) {
      throw new Error("Codex app-server shared session resume requires provider.threadId.");
    }
    const response = await connection.resumeThread(
      {
        threadId: input.plan.resume.threadId,
        cwd: input.plan.cwd,
        ...(input.model ? { model: input.model } : {}),
        excludeTurns: true,
      },
      { timeoutMs: SEND_MESSAGE_TIMEOUT_MS },
    );
    await appendProtocolResponse(context, "thread/resume", response);
    const threadId = extractThreadId(response);
    if (!threadId) {
      throw new Error("Codex app-server thread/resume response did not include thread.id.");
    }
    await appendAgentEvent(context, input.plan.runtime, "thread.resumed", { threadId });
    return threadId;
  }

  const response = await connection.startThread(
    {
      cwd: input.plan.cwd,
      ...(input.model ? { model: input.model } : {}),
      ephemeral: false,
    },
    { timeoutMs: SEND_MESSAGE_TIMEOUT_MS },
  );
  await appendProtocolResponse(context, "thread/start", response);
  const threadId = extractThreadId(response);
  if (!threadId) {
    throw new Error("Codex app-server thread/start response did not include thread.id.");
  }
  await appendAgentEvent(context, input.plan.runtime, "thread.started", { threadId });
  return threadId;
}

function makeSharedSessionContext(
  store: TaskStoreOptions | LaunchTaskInput,
  task: AgentTaskRecord,
): SharedSessionContext {
  const context: SharedSessionContext = {
    store,
    taskId: task.taskId,
    task,
    paths: task.paths,
    async appendEvent(type, data = {}) {
      return await appendSequencedTaskEvent(task.paths, task.taskId, type, data);
    },
    async appendTranscript(line) {
      const rendered = typeof line === "string" ? line : JSON.stringify(line);
      await appendFile(task.paths.transcriptJsonl, `${rendered}\n`);
    },
    async updateTask(patch) {
      const latest = await readTaskRecord(store, task.taskId);
      const updated = await updateTaskStatus(latest, patch.status ?? latest.status, patch);
      context.task = updated;
      return updated;
    },
    async updateProvider(provider) {
      await context.updateTask({
        provider: { ...(context.task.provider ?? {}), ...provider },
      });
    },
    async updateUsage(usage) {
      const selected = selectTaskUsage(context.task.usage, usage);
      if (selected === context.task.usage) {
        return;
      }
      await context.updateTask({ usage: selected });
    },
    async writeResult(text) {
      await writeFile(task.paths.resultMd, text);
      await context.appendEvent("result", {
        path: task.paths.resultMd,
        bytes: Buffer.byteLength(text),
      });
    },
  };
  return context;
}

async function appendParentAndResumeEvents(
  context: SharedSessionContext,
  input: LaunchTaskInput,
): Promise<void> {
  if (input.parent) {
    await context.appendEvent("agent_event", {
      kind: "task.parent",
      parentRunId: input.parent.parentRunId,
      ...(input.parent.parentTaskId ? { parentTaskId: input.parent.parentTaskId } : {}),
      ...(input.parent.parentSessionId ? { parentSessionId: input.parent.parentSessionId } : {}),
      ...(input.parent.parentToolCallId ? { parentToolCallId: input.parent.parentToolCallId } : {}),
    });
  }
  if (input.resume) {
    await context.appendEvent("agent_event", {
      kind: "task.resume",
      fromTaskId: input.resume.fromTaskId,
      rootTaskId: input.resume.rootTaskId,
      attempt: input.resume.attempt,
    });
  }
}

async function ensureSharedEndpoint(input: LaunchTaskInput): Promise<CodexAppServerEndpoint> {
  return await ensureCodexAppServer({
    executable: input.plan.executable,
    cwd: input.plan.cwd,
    env: input.plan.env,
    orchestratorDir: input.orchestratorDir,
    socketPath: input.plan.env[TEST_SOCKET_PATH_ENV] ?? process.env[TEST_SOCKET_PATH_ENV],
  });
}

async function connectSharedCodexAppServer(
  endpoint: CodexAppServerEndpoint,
): Promise<CodexAppServerConnection> {
  return await connectCodexAppServer(endpoint, {
    onServerRequest: async () => ({ decision: "accept" }),
  });
}

function endpointForTask(task: AgentTaskRecord): CodexAppServerEndpoint {
  const socketPath =
    task.supervision?.kind === "provider" ? task.supervision.socketPath : undefined;
  return {
    socketPath: socketPath ?? process.env[TEST_SOCKET_PATH_ENV] ?? "",
  };
}

function subscribeOperationNotifications(
  context: SharedSessionContext,
  connection: CodexAppServerConnection,
  operationState: SharedOperationState,
) {
  const operationThreadId = operationState.operation.threadId;
  return connection.subscribeNotifications(
    operationThreadId ? { threadId: operationThreadId } : {},
    async (notification) => {
      await handleNotification(context, notification, operationState);
    },
  );
}

async function handleNotification(
  context: SharedSessionContext,
  notification: { method: string; params?: unknown },
  operationState: SharedOperationState,
): Promise<void> {
  const params = isRecord(notification.params) ? notification.params : {};
  const threadId = stringValue(params.threadId) ?? stringValue(params.thread_id);
  const turnId =
    stringValue(params.turnId) ?? stringValue(params.turn_id) ?? turnIdFromParams(params);
  if (
    threadId &&
    operationState.operation.threadId &&
    threadId !== operationState.operation.threadId
  ) {
    return;
  }
  if (turnId && !operationState.operation.turnId) {
    operationState.operation = { ...operationState.operation, turnId };
  }

  switch (notification.method) {
    case "item/agentMessage/delta":
    case "item/agent_message/delta": {
      const delta = stringValue(params.delta) ?? "";
      operationState.deltaBuffer += delta;
      break;
    }
    case "item/completed": {
      const item = isRecord(params.item) ? params.item : undefined;
      const itemType = item ? stringValue(item.type) : undefined;
      const text = item ? stringValue(item.text) : undefined;
      if (itemType === "agentMessage" && text !== undefined) {
        operationState.finalAnswer = text;
      }
      break;
    }
    case "thread/tokenUsage/updated": {
      const usage = usageFromParams(params);
      if (usage) {
        operationState.lastUsage = usage;
        await context.updateUsage(usage);
      }
      break;
    }
    case "thread/goal/updated": {
      const goal = goalFromParams(params);
      if (goal) {
        operationState.goal = goal;
        await context.updateTask({ goal });
        if (operationState.operation.kind === "goal" && isTerminalGoalStatus(goal.status)) {
          await settleGoalOperation(context, context.task, operationState, goal);
        }
      }
      break;
    }
  }

  const terminal = terminalResultForNotification(notification.method, params);
  await appendProtocolNotification(context, notification);
  await appendNormalizedNotification(context, notification.method, params, threadId, turnId);
  if (terminal) {
    if (
      operationState.operation.kind === "goal" &&
      operationState.goal &&
      isTerminalGoalStatus(operationState.goal.status)
    ) {
      await settleGoalOperation(context, context.task, operationState, operationState.goal);
    } else if (operationState.operation.kind === "goal") {
      await context.updateTask({
        session: sessionRecord(context.task.session?.startedAt ?? now(), "goal_running", {
          threadId: operationState.operation.threadId ?? context.task.provider?.threadId,
          currentOperationId: operationState.operation.operationId,
        }),
      });
    } else {
      await settleOperation(context, context.task, operationState, terminal);
    }
  }
}

async function settleOperation(
  context: SharedSessionContext,
  task: AgentTaskRecord,
  operationState: SharedOperationState,
  terminal: CodexTerminalResult,
): Promise<TaskOperation> {
  if (operationState.settled) {
    return await operationState.completed.promise;
  }
  const result = operationState.finalAnswer ?? operationState.deltaBuffer;
  const usage = operationState.lastUsage
    ? { ...operationState.lastUsage, final: true, updatedAt: now() }
    : undefined;
  const completed: TaskOperation = {
    ...operationState.operation,
    status: operationStatusForTerminal(terminal.status),
    ...(result ? { result } : {}),
    ...(usage ? { usage } : {}),
    finishedAt: now(),
    ...(terminal.error ? { error: terminal.error } : {}),
  };
  operationState.operation = completed;
  operationState.settled = true;
  await context.writeResult(result);
  if (usage) {
    await context.updateUsage(usage);
  }
  await context.updateTask({
    session: sessionRecord(task.session?.startedAt ?? now(), "idle", {
      threadId: completed.threadId ?? task.provider?.threadId,
    }),
    currentOperation: undefined,
    lastOperation: completed,
  });
  await appendAgentEvent(context, task.runtime, "operation.completed", {
    operationId: completed.operationId,
    operationKind: completed.kind,
    threadId: completed.threadId,
    turnId: completed.turnId,
    status: completed.status,
  });
  operationState.completed.resolve(completed);
  return completed;
}

async function settleGoalOperation(
  context: SharedSessionContext,
  task: AgentTaskRecord,
  operationState: SharedOperationState,
  goal: TaskGoal,
): Promise<TaskOperation> {
  if (operationState.settled) {
    return await operationState.completed.promise;
  }
  const result = operationState.finalAnswer ?? `Goal ${goal.status}: ${goal.objective}`;
  const usage = operationState.lastUsage
    ? { ...operationState.lastUsage, final: true, updatedAt: now() }
    : undefined;
  const completed: TaskOperation = {
    ...operationState.operation,
    objective: goal.objective,
    status: operationStatusForGoalStatus(goal.status),
    ...(result ? { result } : {}),
    ...(usage ? { usage } : {}),
    finishedAt: now(),
  };
  operationState.goal = goal;
  operationState.operation = completed;
  operationState.settled = true;
  await context.writeResult(result);
  if (usage) {
    await context.updateUsage(usage);
  }
  await context.updateTask({
    goal,
    session: sessionRecord(task.session?.startedAt ?? now(), "idle", {
      threadId: completed.threadId ?? task.provider?.threadId,
    }),
    currentOperation: undefined,
    lastOperation: completed,
  });
  await appendAgentEvent(context, task.runtime, "operation.completed", {
    operationId: completed.operationId,
    operationKind: completed.kind,
    threadId: completed.threadId,
    turnId: completed.turnId,
    status: completed.status,
    goalStatus: goal.status,
  });
  operationState.completed.resolve(completed);
  return completed;
}

async function failOperation(
  context: SharedSessionContext,
  task: AgentTaskRecord,
  operationState: SharedOperationState,
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
  await context.updateTask({
    session: sessionRecord(task.session?.startedAt ?? now(), "idle", {
      threadId: failed.threadId ?? task.provider?.threadId,
    }),
    currentOperation: undefined,
    lastOperation: failed,
  });
  await appendAgentEvent(context, task.runtime, "operation.failed", {
    operationId: failed.operationId,
    operationKind: failed.kind,
    threadId: failed.threadId,
    turnId: failed.turnId,
    status: failed.status,
    error: failed.error,
  });
  operationState.completed.resolve(failed);
}

async function waitForOperation(
  operationState: SharedOperationState,
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

async function controlResponse(
  task: AgentTaskRecord,
  kind: TaskControlResponse["kind"],
  fn: () => Promise<
    Omit<
      TaskControlResponse,
      "schemaVersion" | "requestId" | "taskId" | "kind" | "createdAt" | "completedAt"
    >
  >,
  goalAction?: TaskControlResponse["goalAction"],
): Promise<TaskControlResponse> {
  const createdAt = now();
  try {
    const result = await fn();
    return {
      schemaVersion: 1,
      requestId: "provider",
      taskId: task.taskId,
      kind,
      ...(goalAction ? { goalAction } : {}),
      createdAt,
      completedAt: now(),
      ...result,
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      requestId: "provider",
      taskId: task.taskId,
      kind,
      ...(goalAction ? { goalAction } : {}),
      status: "failed",
      createdAt,
      completedAt: now(),
      error: {
        reason: error instanceof TaskSendMessageError ? error.reason : "provider_rejected",
        message: errorMessage(error),
      },
    };
  }
}

async function appendProtocolResponse(
  context: SharedSessionContext,
  method: string,
  result: unknown,
): Promise<void> {
  await context.appendTranscript({ direction: "response", method, result });
}

async function appendProtocolNotification(
  context: SharedSessionContext,
  notification: unknown,
): Promise<void> {
  await context.appendTranscript(notification as Record<string, unknown>);
}

async function appendNormalizedNotification(
  context: SharedSessionContext,
  method: string,
  params: Record<string, unknown>,
  threadId: string | undefined,
  turnId: string | undefined,
): Promise<void> {
  switch (method) {
    case "thread/started":
      await appendAgentEvent(context, context.task.runtime, "thread.started", { threadId });
      return;
    case "turn/started":
      await appendAgentEvent(context, context.task.runtime, "turn.started", { threadId, turnId });
      return;
    case "thread/goal/updated": {
      const goal = goalFromParams(params);
      await appendAgentEvent(context, context.task.runtime, "goal.updated", {
        threadId,
        objective: goal?.objective,
        status: goal?.status,
        tokenBudget: goal?.tokenBudget,
        tokensUsed: goal?.tokensUsed,
        timeUsedSeconds: goal?.timeUsedSeconds,
      });
      return;
    }
    case "item/agentMessage/delta":
    case "item/agent_message/delta":
      await appendAgentEvent(context, context.task.runtime, "agent.message.delta", {
        threadId,
        turnId,
      });
      return;
    case "item/completed": {
      const item = isRecord(params.item) ? params.item : undefined;
      const itemType = item ? stringValue(item.type) : undefined;
      const text = item ? stringValue(item.text) : undefined;
      await appendAgentEvent(context, context.task.runtime, "agent.message", {
        threadId,
        turnId,
        itemType,
        text,
      });
      return;
    }
    case "thread/tokenUsage/updated": {
      const usage = usageFromParams(params);
      await appendAgentEvent(context, context.task.runtime, "agent.usage", {
        threadId,
        turnId,
        usage,
      });
      return;
    }
    case "turn/completed": {
      const turn = isRecord(params.turn) ? params.turn : undefined;
      await appendAgentEvent(context, context.task.runtime, "turn.completed", {
        threadId,
        turnId,
        status: turn ? stringValue(turn.status) : undefined,
      });
      return;
    }
    default:
      return;
  }
}

async function appendAgentEvent(
  context: SharedSessionContext,
  runtime: string,
  kind: string,
  data: Record<string, unknown>,
): Promise<void> {
  await context.appendEvent("agent_event", {
    runtime,
    source: "protocol",
    kind,
    ...compactData(data),
  });
}

function sessionRecord(
  startedAt: string,
  state: "starting" | "idle" | "turn_running" | "goal_running" | "stopping" | "closed",
  details: { threadId?: string; currentTurnId?: string; currentOperationId?: string } = {},
) {
  return {
    kind: "codex-app-server" as const,
    state,
    ...(details.threadId ? { threadId: details.threadId } : {}),
    ...(details.currentTurnId ? { currentTurnId: details.currentTurnId } : {}),
    ...(details.currentOperationId ? { currentOperationId: details.currentOperationId } : {}),
    startedAt,
    updatedAt: now(),
  };
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

function codexProvider(threadId: string, turnId?: string): TaskProviderMetadata {
  return {
    provider: "codex",
    protocol: "jsonrpc",
    transport: "unix",
    threadId,
    ...(turnId ? { turnId } : {}),
  };
}

function requireThreadId(task: AgentTaskRecord): string {
  const threadId = task.provider?.threadId ?? task.session?.threadId;
  if (!threadId) {
    throw new TaskSendMessageError(
      "not_ready",
      "Codex app-server session has not opened a provider thread yet.",
    );
  }
  return threadId;
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

function threadFromResponse(response: unknown): Record<string, unknown> | undefined {
  return isRecord(response) && isRecord(response.thread) ? response.thread : undefined;
}

function turnsFromResponse(response: unknown): Record<string, unknown>[] {
  const thread = threadFromResponse(response);
  const threadTurns = Array.isArray(thread?.turns) ? thread.turns : [];
  const initialTurnsPage =
    isRecord(response) && isRecord(response.initialTurnsPage)
      ? response.initialTurnsPage
      : undefined;
  const initialTurns = Array.isArray(initialTurnsPage?.data) ? initialTurnsPage.data : [];
  return [...threadTurns, ...initialTurns].filter(isRecord);
}

function findOperationTurn(
  response: unknown,
  operation: TaskOperation,
): Record<string, unknown> | undefined {
  const turns = turnsFromResponse(response);
  if (operation.turnId) {
    return turns.find((turn) => stringValue(turn.id) === operation.turnId);
  }
  return turns.find((turn) => stringValue(turn.status) === "inProgress");
}

function finalAnswerFromTurn(turn: Record<string, unknown>): string | undefined {
  const items = Array.isArray(turn.items) ? turn.items.filter(isRecord) : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    const type = stringValue(item.type);
    const text = stringValue(item.text);
    if ((type === "agentMessage" || type === "agent_message") && text !== undefined) {
      return text;
    }
  }
  return undefined;
}

function extractGoalCleared(response: unknown): boolean {
  return isRecord(response) && response.cleared === true;
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
  assignGoalTokenBudget(goal, value.tokenBudget);
  assignNumber(goal, "tokensUsed", value.tokensUsed);
  assignNumber(goal, "timeUsedSeconds", value.timeUsedSeconds);
  assignDateString(goal, "createdAt", value.createdAt);
  assignDateString(goal, "updatedAt", value.updatedAt);
  return goal;
}

function assertThreadIdle(response: unknown, threadId: string): void {
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
      `Codex app-server thread must be idle; current status is "${status}".`,
    );
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

function usageFromParams(params: Record<string, unknown>): TaskUsage | undefined {
  const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : undefined;
  const last = tokenUsage && isRecord(tokenUsage.last) ? tokenUsage.last : undefined;
  return usageFromTokenRecord(last);
}

function usageFromRecord(record: Record<string, unknown>): TaskUsage | undefined {
  const tokenUsage = isRecord(record.tokenUsage)
    ? record.tokenUsage
    : isRecord(record.token_usage)
      ? record.token_usage
      : undefined;
  if (tokenUsage) {
    const last = isRecord(tokenUsage.last) ? tokenUsage.last : tokenUsage;
    const usage = usageFromTokenRecord(last);
    if (usage) {
      return usage;
    }
  }
  const usage = isRecord(record.usage)
    ? record.usage
    : isRecord(record.token_usage)
      ? record.token_usage
      : undefined;
  return usage ? usageFromTokenRecord(usage) : undefined;
}

function usageFromTokenRecord(record: Record<string, unknown> | undefined): TaskUsage | undefined {
  if (!record) {
    return undefined;
  }
  const inputTokens = numberValue(record.inputTokens) ?? numberValue(record.input_tokens) ?? 0;
  const outputTokens = numberValue(record.outputTokens) ?? numberValue(record.output_tokens) ?? 0;
  const totalTokens =
    numberValue(record.totalTokens) ??
    numberValue(record.total_tokens) ??
    inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    scope: "turn",
    final: false,
    updatedAt: now(),
  };
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

function codexGoalStatus(status: Exclude<TaskGoalStatus, "active">): string {
  switch (status) {
    case "paused":
    case "blocked":
    case "complete":
      return status;
    case "usage_limited":
      return "usageLimited";
    case "budget_limited":
      return "budgetLimited";
  }
}

function isTerminalGoalStatus(status: TaskGoalStatus): boolean {
  return status !== "active";
}

function shouldMonitorOperation(
  operation: TaskOperation | undefined,
  operationId: string,
): operation is TaskOperation {
  return (
    operation?.operationId === operationId &&
    (operation.status === "starting" || operation.status === "running")
  );
}

function isTerminalTurnStatus(status: string | undefined): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
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

function mapTurnStatus(status: string | undefined): TaskStatus {
  switch (status) {
    case "completed":
    case "succeeded":
    case "success":
      return "succeeded";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    case "timed_out":
    case "timeout":
      return "timed_out";
    default:
      return "failed";
  }
}

function turnIdFromParams(params: Record<string, unknown>): string | undefined {
  if (isRecord(params.turn)) {
    return stringValue(params.turn.id);
  }
  return undefined;
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

function assignGoalTokenBudget(goal: TaskGoal, value: unknown): void {
  if (value === null) {
    goal.tokenBudget = null;
    return;
  }
  assignNumber(goal, "tokenBudget", value);
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
    const millis = value < 1_000_000_000_000 ? value * 1000 : value;
    target[key] = new Date(millis).toISOString() as T[keyof T];
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

async function claimOperationMonitor(
  paths: Pick<TaskPaths, "taskDir">,
  taskId: string,
  operationId: string,
): Promise<MonitorClaimResult> {
  const claimDir = join(paths.taskDir, "control", "operation-monitors");
  const claimPath = join(claimDir, `${operationId}.json`);
  await mkdir(claimDir, { recursive: true });
  const claim: TaskOperationMonitorClaim = {
    schemaVersion: 1,
    operationId,
    taskId,
    pid: process.pid,
    startedAt: now(),
    updatedAt: now(),
  };
  for (;;) {
    const existing = await readOperationMonitorClaim(claimPath);
    if (existing && existing.operationId === operationId && isPidAlive(existing.pid)) {
      return { claimed: false, ownerPid: existing.pid };
    }
    if (existing) {
      await rm(claimPath, { force: true });
    }

    try {
      await writeFile(claimPath, `${JSON.stringify(claim, null, 2)}\n`, { flag: "wx" });
      return { claimed: true, claimPath };
    } catch (error) {
      if (!isFileExists(error)) {
        throw error;
      }
    }
  }
}

async function readOperationMonitorClaim(
  claimPath: string,
): Promise<TaskOperationMonitorClaim | undefined> {
  try {
    const raw = JSON.parse(await readFile(claimPath, "utf8")) as unknown;
    if (!isRecord(raw)) {
      return undefined;
    }
    if (
      raw.schemaVersion !== 1 ||
      typeof raw.operationId !== "string" ||
      typeof raw.taskId !== "string" ||
      typeof raw.pid !== "number" ||
      typeof raw.startedAt !== "string" ||
      typeof raw.updatedAt !== "string"
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      operationId: raw.operationId,
      taskId: raw.taskId,
      pid: raw.pid,
      startedAt: raw.startedAt,
      updatedAt: raw.updatedAt,
    };
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function releaseOperationMonitorClaim(claimPath: string): Promise<void> {
  const claim = await readOperationMonitorClaim(claimPath);
  if (!claim || claim.pid === process.pid) {
    await rm(claimPath, { force: true });
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isFileExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function errorMessageFromRecord(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const error = value.error;
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error)) {
    return stringValue(error.message);
  }
  return undefined;
}

function normalizeTaskName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): string {
  return new Date().toISOString();
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
