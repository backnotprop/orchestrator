import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  JsonRpcStdioClientError,
  startJsonRpcStdioClient,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
} from "../packages/core/src/tasks/executors/protocol/json-rpc-stdio.ts";
import { withTempWorkspace } from "./helpers.ts";

test("JSON-RPC stdio client routes out-of-order responses by request id", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const serverPath = await writeFakeServer(workspaceRoot);
    const client = startJsonRpcStdioClient({
      executable: process.execPath,
      args: [serverPath],
      cwd: workspaceRoot,
    });

    try {
      const delayed = client.request("delayed", { value: "slow" });
      const fast = client.request("fast", { value: "fast" });

      assert.deepEqual(await fast, { value: "fast" });
      assert.deepEqual(await delayed, { value: "slow" });

      await assert.rejects(
        client.request("fail"),
        (error: unknown) =>
          error instanceof JsonRpcStdioClientError &&
          error.code === "protocol_error" &&
          /server rejected/.test(error.message),
      );

      const close = await client.close();
      assert.equal(close.exitCode, 0);
      assert.equal(close.killed, false);
      assert.match(close.stderr, /fake server ready/);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, "orchestrator-json-rpc-routing-");
});

test("JSON-RPC stdio client buffers and filters early notifications", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const serverPath = await writeFakeServer(workspaceRoot);
    const client = startJsonRpcStdioClient({
      executable: process.execPath,
      args: [serverPath],
      cwd: workspaceRoot,
    });

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
      assert.equal(
        client.drainBufferedNotifications({ threadId: "thread-1", turnId: "turn-early" }).length,
        0,
      );

      const live: JsonRpcNotification[] = [];
      const subscription = client.subscribeNotifications(
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

      subscription.unsubscribe();
      const other = client.drainBufferedNotifications({ threadId: "other-thread" });
      assert.equal(other.length, 1);
      assert.deepEqual(other[0]?.params, {
        threadId: "other-thread",
        turnId: "other-turn",
        value: "other",
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  }, "orchestrator-json-rpc-notifications-");
});

test("JSON-RPC stdio client answers server-initiated requests", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const serverPath = await writeFakeServer(workspaceRoot);
    const handled: JsonRpcServerRequest[] = [];
    const protocolErrors: JsonRpcStdioClientError[] = [];
    const client = startJsonRpcStdioClient({
      executable: process.execPath,
      args: [serverPath],
      cwd: workspaceRoot,
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
  }, "orchestrator-json-rpc-server-request-");
});

test("JSON-RPC stdio client reports request timeouts and parse errors", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const serverPath = await writeFakeServer(workspaceRoot);
    const protocolErrors: JsonRpcStdioClientError[] = [];
    const client = startJsonRpcStdioClient({
      executable: process.execPath,
      args: [serverPath],
      cwd: workspaceRoot,
      onProtocolError: (error) => {
        protocolErrors.push(error);
        throw new Error("observer failed");
      },
    });

    try {
      await assert.rejects(
        client.request("hang", undefined, { timeoutMs: 50 }),
        (error: unknown) =>
          error instanceof JsonRpcStdioClientError && error.code === "request_timeout",
      );

      await assert.rejects(
        client.request("badJson", undefined, { timeoutMs: 1_000 }),
        (error: unknown) =>
          error instanceof JsonRpcStdioClientError && error.code === "parse_error",
      );
      assert.equal(protocolErrors[0]?.code, "parse_error");

      const close = await client.closed;
      assert.equal(close.killed, true);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, "orchestrator-json-rpc-errors-");
});

test("JSON-RPC stdio client closes gracefully or kills stubborn servers", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const serverPath = await writeFakeServer(workspaceRoot);
    const graceful = startJsonRpcStdioClient({
      executable: process.execPath,
      args: [serverPath],
      cwd: workspaceRoot,
    });

    const gracefulClose = await graceful.close();
    assert.equal(gracefulClose.exitCode, 0);
    assert.equal(gracefulClose.killed, false);

    const stubborn = startJsonRpcStdioClient({
      executable: process.execPath,
      args: [serverPath, "stubborn"],
      cwd: workspaceRoot,
      closeTimeoutMs: 25,
      killTimeoutMs: 25,
    });

    const killedClose = await stubborn.close();
    assert.equal(killedClose.killed, true);
    assert.ok(killedClose.signal === "SIGTERM" || killedClose.signal === "SIGKILL");
  }, "orchestrator-json-rpc-close-");
});

async function writeFakeServer(workspaceRoot: string): Promise<string> {
  const serverPath = join(workspaceRoot, "fake-json-rpc-server.mjs");
  await writeFile(
    serverPath,
    `
import readline from "node:readline";

const mode = process.argv[2] ?? "normal";
const rl = readline.createInterface({ input: process.stdin });
const pendingServerRequests = new Map();
let nextServerRequestId = 1;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

function requestClient(originalRequestId, method, params) {
  const requestId = "server-" + nextServerRequestId;
  nextServerRequestId += 1;
  pendingServerRequests.set(requestId, originalRequestId);
  send({ jsonrpc: "2.0", id: requestId, method, params });
}

process.stderr.write("fake server ready\\n");
send({
  jsonrpc: "2.0",
  method: "thread/update",
  params: { threadId: "thread-1", turnId: "turn-early", value: "early" },
});
send({
  jsonrpc: "2.0",
  method: "thread/update",
  params: { threadId: "other-thread", turnId: "other-turn", value: "other" },
});

if (mode === "stubborn") {
  process.on("SIGTERM", () => {
    process.stderr.write("ignored sigterm\\n");
  });
  rl.on("close", () => {
    process.stderr.write("stdin closed\\n");
  });
  setInterval(() => {}, 1_000);
} else {
  rl.on("close", () => process.exit(0));
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (pendingServerRequests.has(message.id)) {
    const originalRequestId = pendingServerRequests.get(message.id);
    pendingServerRequests.delete(message.id);
    if (message.error) {
      respond(originalRequestId, { clientError: message.error.message });
    } else {
      respond(originalRequestId, { clientResponse: message.result });
    }
    return;
  }
  switch (message.method) {
    case "ping":
      respond(message.id, { ok: true });
      break;
    case "fast":
      respond(message.id, message.params);
      break;
    case "delayed":
      setTimeout(() => respond(message.id, message.params), 50);
      break;
    case "emit":
      send({ jsonrpc: "2.0", method: "thread/update", params: message.params });
      respond(message.id, { emitted: true });
      break;
    case "askClient":
      requestClient(message.id, "server/question", message.params);
      break;
    case "askClientFail":
      requestClient(message.id, "server/fail", {});
      break;
    case "fail":
      respondError(message.id, "server rejected");
      break;
    case "badJson":
      process.stdout.write("{not-json\\n");
      break;
    case "hang":
      break;
    default:
      respondError(message.id, "unknown method " + message.method);
  }
});
`,
  );
  return serverPath;
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
