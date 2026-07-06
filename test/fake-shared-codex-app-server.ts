import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";

export const FAKE_SHARED_CODEX_APP_SERVER_SOCKET_ENV = "ORCHESTRATOR_CODEX_APP_SERVER_SOCKET_PATH";

export type FakeSharedCodexAppServer = {
  socketPath: string;
};

export type FakeSharedCodexAppServerOptions = {
  resultText?: string;
  goalResultText?: string;
  goalTimestampUnit?: "milliseconds" | "seconds";
  threadReadStatus?: string;
  turnDelayMs?: number;
  goalDelayMs?: number;
};

type FakeThread = {
  threadId: string;
  turnCounter: number;
  turns: FakeTurn[];
  goal?: FakeGoal;
};

type FakeTurn = {
  id: string;
  status: "inProgress" | "completed" | "interrupted" | "failed";
  text?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

type FakeGoal = {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "complete" | "usageLimited" | "budgetLimited";
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  createdAt?: number;
  updatedAt?: number;
};

export async function withFakeSharedCodexAppServer(
  fn: (server: FakeSharedCodexAppServer) => Promise<void>,
  options: FakeSharedCodexAppServerOptions = {},
): Promise<void> {
  const socketPath = join(
    "/tmp",
    `orch-shared-codex-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
  );
  const threads = new Map<string, FakeThread>();
  const clients = new Set<WebSocket>();
  let threadCounter = 1;
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  webSocketServer.on("connection", (webSocket) => {
    clients.add(webSocket);
    webSocket.on("close", () => {
      clients.delete(webSocket);
    });
    webSocket.on("message", (data) => {
      const message = JSON.parse(rawDataToString(data)) as {
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (!message.method) {
        return;
      }
      handleFakeMessage(
        webSocket,
        { ...message, method: message.method },
        threads,
        clients,
        () => `thread-fake-${threadCounter++}`,
        options,
      );
    });
  });
  await listenUnix(server, socketPath);

  try {
    await fn({ socketPath });
  } finally {
    webSocketServer.close();
    await closeServer(server);
    await rm(socketPath, { force: true }).catch(() => undefined);
  }
}

function handleFakeMessage(
  webSocket: WebSocket,
  message: { id?: string | number; method: string; params?: Record<string, unknown> },
  threads: Map<string, FakeThread>,
  clients: Set<WebSocket>,
  nextThreadId: () => string,
  options: FakeSharedCodexAppServerOptions,
): void {
  switch (message.method) {
    case "initialize":
      respond(webSocket, message.id, {
        serverInfo: { name: "fake-shared-codex-app-server", version: "0.0.0" },
      });
      return;
    case "initialized":
      return;
    case "thread/start": {
      const threadId = nextThreadId();
      const thread: FakeThread = { threadId, turnCounter: 1, turns: [] };
      threads.set(threadId, thread);
      respond(webSocket, message.id, { thread: threadResponse(thread) });
      notifyAll(clients, "thread/started", { threadId });
      return;
    }
    case "thread/resume": {
      const threadId = requireString(message.params?.threadId, "threadId");
      const thread = requireThread(threads, threadId);
      respond(webSocket, message.id, {
        thread: threadResponse(thread, true),
        initialTurnsPage: {
          data: thread.turns.map(turnResponse),
          nextCursor: null,
          backwardsCursor: null,
        },
      });
      notify(webSocket, "thread/resumed", { threadId });
      return;
    }
    case "thread/read": {
      const threadId = requireString(message.params?.threadId, "threadId");
      const thread = requireThread(threads, threadId);
      const includeTurns = message.params?.includeTurns === true;
      respond(webSocket, message.id, {
        thread: threadResponse(thread, includeTurns, options.threadReadStatus),
      });
      return;
    }
    case "turn/start": {
      const threadId = requireString(message.params?.threadId, "threadId");
      const thread = requireThread(threads, threadId);
      const turnId = `turn-fake-${thread.turnCounter++}`;
      thread.turns.push({ id: turnId, status: "inProgress" });
      respond(webSocket, message.id, { turn: { id: turnId, status: "inProgress" } });
      emitCompletedTurn(
        clients,
        thread,
        threadId,
        turnId,
        options.resultText ?? "Hello from shared Codex.",
        options.turnDelayMs,
      );
      return;
    }
    case "turn/steer": {
      requireString(message.params?.threadId, "threadId");
      const turnId = requireString(message.params?.expectedTurnId, "expectedTurnId");
      respond(webSocket, message.id, { turn: { id: turnId } });
      return;
    }
    case "turn/interrupt":
      respond(webSocket, message.id, { interrupted: true });
      return;
    case "thread/goal/set": {
      const threadId = requireString(message.params?.threadId, "threadId");
      const thread = requireThread(threads, threadId);
      const objective =
        stringValue(message.params?.objective) ?? thread.goal?.objective ?? "fake goal";
      const providerStatus = stringValue(message.params?.status) ?? thread.goal?.status ?? "active";
      const tokenBudget = hasOwn(message.params, "tokenBudget")
        ? numberOrNull(message.params?.tokenBudget)
        : thread.goal?.tokenBudget;
      const goal = fakeGoal(threadId, objective, providerStatus, tokenBudget, options);
      thread.goal = goal;
      respond(webSocket, message.id, { goal });
      if (providerStatus !== "active") {
        return;
      }
      const turnId = `turn-fake-goal-${thread.turnCounter++}`;
      thread.turns.push({ id: turnId, status: "inProgress" });
      notifyAll(clients, "thread/goal/updated", { threadId, goal });
      schedule(() => {
        const completeGoal = fakeGoal(threadId, objective, "complete", tokenBudget, options);
        thread.goal = completeGoal;
        const turn = thread.turns.find((candidate) => candidate.id === turnId);
        if (turn) {
          turn.status = "completed";
          turn.text = options.goalResultText ?? "Goal complete from shared Codex.";
        }
        notifyAll(clients, "turn/started", {
          threadId,
          turnId,
          turn: { id: turnId, status: "inProgress" },
        });
        notifyAll(clients, "item/completed", {
          threadId,
          turnId,
          item: {
            id: "item-goal",
            type: "agentMessage",
            text: options.goalResultText ?? "Goal complete from shared Codex.",
          },
        });
        notifyAll(clients, "thread/goal/updated", { threadId, goal: completeGoal });
        notifyAll(clients, "turn/completed", {
          threadId,
          turnId,
          turn: { id: turnId, status: "completed" },
        });
      }, options.goalDelayMs);
      return;
    }
    case "thread/goal/get": {
      const threadId = requireString(message.params?.threadId, "threadId");
      const thread = requireThread(threads, threadId);
      respond(webSocket, message.id, { goal: thread.goal ?? null });
      return;
    }
    case "thread/goal/clear": {
      const threadId = requireString(message.params?.threadId, "threadId");
      const thread = requireThread(threads, threadId);
      thread.goal = undefined;
      respond(webSocket, message.id, { cleared: true });
      return;
    }
    default:
      respond(webSocket, message.id, {});
  }
}

function emitCompletedTurn(
  clients: Set<WebSocket>,
  thread: FakeThread,
  threadId: string,
  turnId: string,
  text: string,
  delayMs: number | undefined,
): void {
  schedule(() => {
    notifyAll(clients, "turn/started", {
      threadId,
      turnId,
      turn: { id: turnId, status: "inProgress" },
    });
    notifyAll(clients, "item/agentMessage/delta", { threadId, turnId, delta: text });
    notifyAll(clients, "item/completed", {
      threadId,
      turnId,
      item: { id: "item-agent", type: "agentMessage", text },
    });
    notifyAll(clients, "thread/tokenUsage/updated", {
      threadId,
      turnId,
      tokenUsage: {
        last: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      },
    });
    notifyAll(clients, "item/agentMessage/delta", {
      threadId: "thread-foreign",
      turnId: "turn-foreign",
      delta: "noise from another thread",
    });
    notifyAll(clients, "thread/tokenUsage/updated", {
      threadId: "thread-foreign",
      turnId: "turn-foreign",
      tokenUsage: {
        last: {
          inputTokens: 999,
          outputTokens: 1,
          totalTokens: 1000,
        },
      },
    });
    const turn = thread.turns.find((candidate) => candidate.id === turnId);
    if (turn) {
      turn.status = "completed";
      turn.text = text;
      turn.usage = {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      };
    }
    notifyAll(clients, "turn/completed", {
      threadId,
      turnId,
      turn: { id: turnId, status: "completed" },
    });
  }, delayMs);
}

function fakeGoal(
  threadId: string,
  objective: string,
  status: string,
  tokenBudget: number | null | undefined,
  options: FakeSharedCodexAppServerOptions,
): FakeGoal {
  return {
    threadId,
    objective,
    status: providerGoalStatus(status),
    tokenBudget,
    tokensUsed: status === "active" ? 0 : 15,
    timeUsedSeconds: status === "active" ? 0 : 1,
    createdAt: goalTimestamp(options),
    updatedAt: goalTimestamp(options),
  };
}

function threadResponse(
  thread: FakeThread,
  includeTurns = false,
  forcedStatus?: string,
): Record<string, unknown> {
  return {
    id: thread.threadId,
    path: `/tmp/fake/${thread.threadId}`,
    status:
      forcedStatus ??
      (thread.turns.some((turn) => turn.status === "inProgress") ? "active" : "idle"),
    turns: includeTurns ? thread.turns.map(turnResponse) : [],
  };
}

function turnResponse(turn: FakeTurn): Record<string, unknown> {
  return {
    id: turn.id,
    status: turn.status,
    ...(turn.usage
      ? {
          tokenUsage: {
            last: turn.usage,
          },
        }
      : {}),
    items:
      turn.text === undefined
        ? []
        : [{ id: `item-${turn.id}`, type: "agentMessage", text: turn.text }],
  };
}

function providerGoalStatus(status: string): FakeGoal["status"] {
  switch (status) {
    case "paused":
    case "blocked":
    case "complete":
    case "usageLimited":
    case "budgetLimited":
      return status;
    default:
      return "active";
  }
}

function goalTimestamp(options: FakeSharedCodexAppServerOptions): number {
  if (options.goalTimestampUnit === "seconds") {
    return Math.floor(Date.now() / 1000);
  }
  return Date.now();
}

function respond(webSocket: WebSocket, id: unknown, result: unknown): void {
  webSocket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function notify(webSocket: WebSocket, method: string, params: Record<string, unknown>): void {
  webSocket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
}

function notifyAll(clients: Set<WebSocket>, method: string, params: Record<string, unknown>): void {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      notify(client, method, params);
    }
  }
}

function schedule(fn: () => void, delayMs: number | undefined): void {
  if (delayMs === undefined) {
    setImmediate(fn);
    return;
  }
  setTimeout(fn, delayMs);
}

function requireThread(threads: Map<string, FakeThread>, threadId: string): FakeThread {
  const thread = threads.get(threadId);
  if (!thread) {
    throw new Error(`Unknown fake thread: ${threadId}`);
  }
  return thread;
}

function requireString(value: unknown, name: string): string {
  const parsed = stringValue(value);
  if (!parsed) {
    throw new Error(`${name} must be a string.`);
  }
  return parsed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasOwn(value: Record<string, unknown> | undefined, key: string): boolean {
  return value ? Object.prototype.hasOwnProperty.call(value, key) : false;
}

function rawDataToString(data: WebSocket.RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

async function listenUnix(server: HttpServer, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
