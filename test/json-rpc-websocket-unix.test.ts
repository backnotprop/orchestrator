import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import {
  JsonRpcWebSocketUnixClientError,
  startJsonRpcWebSocketUnixClient,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
} from "../packages/core/src/tasks/executors/protocol/json-rpc-websocket-unix.ts";
import { withTempWorkspace } from "./helpers.ts";

test("JSON-RPC websocket unix client routes out-of-order responses by request id", async () => {
  await withFakeUnixJsonRpcServer(async ({ socketPath }) => {
    const client = startJsonRpcWebSocketUnixClient({ socketPath });

    try {
      const delayed = client.request("delayed", { value: "slow" });
      const fast = client.request("fast", { value: "fast" });

      assert.deepEqual(await fast, { value: "fast" });
      assert.deepEqual(await delayed, { value: "slow" });

      await assert.rejects(
        client.request("fail"),
        (error: unknown) =>
          error instanceof JsonRpcWebSocketUnixClientError &&
          error.code === "protocol_error" &&
          /server rejected/.test(error.message),
      );

      const close = await client.close();
      assert.equal(close.clean, true);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

test("JSON-RPC websocket unix client buffers and filters early notifications", async () => {
  await withFakeUnixJsonRpcServer(async ({ socketPath }) => {
    const client = startJsonRpcWebSocketUnixClient({ socketPath });

    try {
      assert.deepEqual(await client.request("ping"), { ok: true });

      const replayed: JsonRpcNotification[] = [];
      client.subscribeNotifications(
        { method: "thread/update", threadId: "thread-1", turnId: "turn-early" },
        (notification) => {
          replayed.push(notification);
        },
      );

      assert.equal(replayed.length, 1);
      assert.deepEqual(replayed[0]?.params, {
        threadId: "thread-1",
        turnId: "turn-early",
        value: "early",
      });

      const live: JsonRpcNotification[] = [];
      client.subscribeNotifications(
        { method: "thread/update", threadId: "thread-1", turnId: "turn-live" },
        (notification) => {
          live.push(notification);
        },
      );

      assert.deepEqual(
        await client.request("emit", {
          threadId: "thread-1",
          turnId: "turn-live",
          value: "live",
        }),
        { emitted: true },
      );
      await waitFor(() => live.length === 1);
      assert.deepEqual(live[0]?.params, {
        threadId: "thread-1",
        turnId: "turn-live",
        value: "live",
      });

      const snakeCase: JsonRpcNotification[] = [];
      client.subscribeNotifications(
        { method: "thread/update", threadId: "thread-snake", turnId: "turn-snake" },
        (notification) => {
          snakeCase.push(notification);
        },
      );

      assert.deepEqual(
        await client.request("emit", {
          thread_id: "thread-snake",
          turn_id: "turn-snake",
          value: "snake",
        }),
        { emitted: true },
      );
      await waitFor(() => snakeCase.length === 1);
      assert.deepEqual(snakeCase[0]?.params, {
        thread_id: "thread-snake",
        turn_id: "turn-snake",
        value: "snake",
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

test("JSON-RPC websocket unix client answers server-initiated requests", async () => {
  await withFakeUnixJsonRpcServer(async ({ socketPath }) => {
    const handled: JsonRpcServerRequest[] = [];
    const protocolErrors: JsonRpcWebSocketUnixClientError[] = [];
    const client = startJsonRpcWebSocketUnixClient({
      socketPath,
      onServerRequest: async (request) => {
        handled.push(request);
        if (request.method === "server/fail") {
          throw new Error("client handler rejected");
        }
        return {
          accepted: true,
          params: request.params,
        };
      },
      onProtocolError: (error) => {
        protocolErrors.push(error);
      },
    });

    try {
      assert.deepEqual(await client.request("askClient", { value: "from-server" }), {
        clientResponse: {
          accepted: true,
          params: { value: "from-server" },
        },
      });
      assert.equal(handled[0]?.method, "server/question");
      assert.deepEqual(handled[0]?.params, { value: "from-server" });

      assert.deepEqual(await client.request("askClientFail"), {
        clientError: 'JSON-RPC server request "server/fail" handler failed.',
      });
      assert.equal(protocolErrors[0]?.code, "protocol_error");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

test("JSON-RPC websocket unix client reports request timeouts and parse errors", async () => {
  await withFakeUnixJsonRpcServer(async ({ socketPath }) => {
    const protocolErrors: JsonRpcWebSocketUnixClientError[] = [];
    const client = startJsonRpcWebSocketUnixClient({
      socketPath,
      onProtocolError: (error) => {
        protocolErrors.push(error);
        throw new Error("observer failed");
      },
    });

    try {
      await assert.rejects(
        client.request("hang", undefined, { timeoutMs: 50 }),
        (error: unknown) =>
          error instanceof JsonRpcWebSocketUnixClientError && error.code === "request_timeout",
      );

      await assert.rejects(
        client.request("badJson", undefined, { timeoutMs: 1_000 }),
        (error: unknown) =>
          error instanceof JsonRpcWebSocketUnixClientError && error.code === "parse_error",
      );
      assert.equal(protocolErrors[0]?.code, "parse_error");

      const close = await client.closed;
      assert.equal(close.clean, false);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

type FakeUnixJsonRpcServer = {
  socketPath: string;
};

async function withFakeUnixJsonRpcServer(
  fn: (server: FakeUnixJsonRpcServer) => Promise<void>,
): Promise<void> {
  await withTempWorkspace(async () => {
    const socketPath = join("/tmp", `orch-rpc-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
    const server = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    });
    webSocketServer.on("connection", handleConnection);
    await listenUnix(server, socketPath);

    try {
      await fn({ socketPath });
    } finally {
      webSocketServer.close();
      await closeServer(server);
      await rm(socketPath, { force: true }).catch(() => undefined);
    }
  }, "orchestrator-json-rpc-ws-unix-");
}

function handleConnection(webSocket: WebSocket): void {
  const pendingServerRequests = new Map<string, number | string>();
  let nextServerRequestId = 1;

  send(webSocket, {
    jsonrpc: "2.0",
    method: "thread/update",
    params: { threadId: "thread-1", turnId: "turn-early", value: "early" },
  });
  send(webSocket, {
    jsonrpc: "2.0",
    method: "thread/update",
    params: { threadId: "other-thread", turnId: "other-turn", value: "other" },
  });

  webSocket.on("message", (data) => {
    const message = JSON.parse(rawDataToString(data)) as {
      id?: string | number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };

    if (message.id !== undefined && pendingServerRequests.has(String(message.id))) {
      const originalRequestId = pendingServerRequests.get(String(message.id));
      pendingServerRequests.delete(String(message.id));
      if (message.error) {
        respond(webSocket, originalRequestId, { clientError: message.error.message });
      } else {
        respond(webSocket, originalRequestId, { clientResponse: message.result });
      }
      return;
    }

    switch (message.method) {
      case "ping":
        respond(webSocket, message.id, { ok: true });
        break;
      case "fast":
        respond(webSocket, message.id, message.params);
        break;
      case "delayed":
        setTimeout(() => respond(webSocket, message.id, message.params), 50);
        break;
      case "emit":
        send(webSocket, { jsonrpc: "2.0", method: "thread/update", params: message.params });
        respond(webSocket, message.id, { emitted: true });
        break;
      case "askClient": {
        const requestId = `server-${nextServerRequestId}`;
        nextServerRequestId += 1;
        pendingServerRequests.set(requestId, message.id ?? "");
        send(webSocket, {
          jsonrpc: "2.0",
          id: requestId,
          method: "server/question",
          params: message.params,
        });
        break;
      }
      case "askClientFail": {
        const requestId = `server-${nextServerRequestId}`;
        nextServerRequestId += 1;
        pendingServerRequests.set(requestId, message.id ?? "");
        send(webSocket, {
          jsonrpc: "2.0",
          id: requestId,
          method: "server/fail",
          params: {},
        });
        break;
      }
      case "fail":
        send(webSocket, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "server rejected" },
        });
        break;
      case "badJson":
        webSocket.send("{not-json");
        break;
      case "hang":
        break;
      default:
        send(webSocket, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: `unknown method ${message.method}` },
        });
    }
  });
}

function send(webSocket: WebSocket, message: Record<string, unknown>): void {
  webSocket.send(JSON.stringify(message));
}

function respond(webSocket: WebSocket, id: unknown, result: unknown): void {
  send(webSocket, { jsonrpc: "2.0", id, result });
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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  assert.fail("Timed out waiting for predicate.");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
