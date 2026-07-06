import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import {
  CodexAppServerControllerError,
  connectCodexAppServer,
  ensureCodexAppServer,
  parseCodexDaemonOutput,
} from "../packages/core/src/tasks/executors/protocol/codex-app-server-controller.ts";
import { readTask, runCli, withTempWorkspace } from "./helpers.ts";

test("Codex app-server controller parses daemon output", () => {
  const endpoint = parseCodexDaemonOutput(
    JSON.stringify({
      status: "started",
      backend: "pid",
      socketPath: "/tmp/codex.sock",
      managedCodexPath: "/tmp/codex",
      managedCodexVersion: "1.2.3",
      cliVersion: "1.2.3",
      appServerVersion: "1.2.4",
    }),
  );

  assert.deepEqual(endpoint, {
    status: "started",
    backend: "pid",
    socketPath: "/tmp/codex.sock",
    managedCodexPath: "/tmp/codex",
    managedCodexVersion: "1.2.3",
    cliVersion: "1.2.3",
    appServerVersion: "1.2.4",
  });
});

test("Codex app-server controller accepts explicit fake socket path", async () => {
  assert.deepEqual(await ensureCodexAppServer({ socketPath: "/tmp/fake-codex.sock" }), {
    socketPath: "/tmp/fake-codex.sock",
    managed: false,
  });
});

test("Codex app-server controller starts a managed app-server backend", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fake = await makeFakeCodexExecutable(workspaceRoot);
    const startsFile = join(workspaceRoot, "starts.txt");
    const endpoint = await ensureCodexAppServer({
      executable: fake.executable,
      cwd: workspaceRoot,
      orchestratorDir: join(workspaceRoot, ".orchestrator"),
      env: { FAKE_CODEX_APP_SERVER_START_FILE: startsFile },
    });

    try {
      assert.equal(endpoint.managed, true);
      assert.equal(typeof endpoint.pid, "number");
      assert.match(endpoint.socketPath, /orchestrator-codex-/);
      assert.equal((await readStartPids(startsFile)).length, 1);

      const connection = await connectCodexAppServer(endpoint);
      await connection.close();
    } finally {
      await stopEndpoint(endpoint.pid);
    }
  });
});

test("Codex app-server controller reuses a healthy managed backend", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fake = await makeFakeCodexExecutable(workspaceRoot);
    const startsFile = join(workspaceRoot, "starts.txt");
    const input = {
      executable: fake.executable,
      cwd: workspaceRoot,
      orchestratorDir: join(workspaceRoot, ".orchestrator"),
      env: { FAKE_CODEX_APP_SERVER_START_FILE: startsFile },
    };
    const first = await ensureCodexAppServer(input);
    const second = await ensureCodexAppServer(input);

    try {
      assert.equal(second.pid, first.pid);
      assert.equal(second.socketPath, first.socketPath);
      assert.equal((await readStartPids(startsFile)).length, 1);
    } finally {
      await stopEndpoint(first.pid);
    }
  });
});

test("Codex app-server controller serializes concurrent backend startup", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fake = await makeFakeCodexExecutable(workspaceRoot);
    const startsFile = join(workspaceRoot, "starts.txt");
    const input = {
      executable: fake.executable,
      cwd: workspaceRoot,
      orchestratorDir: join(workspaceRoot, ".orchestrator"),
      env: { FAKE_CODEX_APP_SERVER_START_FILE: startsFile },
    };

    const endpoints = await Promise.all([
      ensureCodexAppServer(input),
      ensureCodexAppServer(input),
      ensureCodexAppServer(input),
    ]);

    try {
      assert.equal(new Set(endpoints.map((endpoint) => endpoint.pid)).size, 1);
      assert.equal(new Set(endpoints.map((endpoint) => endpoint.socketPath)).size, 1);
      assert.equal((await readStartPids(startsFile)).length, 1);
    } finally {
      await stopEndpoint(endpoints[0]?.pid);
    }
  });
});

test("Codex app-server controller replaces stale backend metadata and socket", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fake = await makeFakeCodexExecutable(workspaceRoot);
    const startsFile = join(workspaceRoot, "starts.txt");
    const input = {
      executable: fake.executable,
      cwd: workspaceRoot,
      orchestratorDir: join(workspaceRoot, ".orchestrator"),
      env: { FAKE_CODEX_APP_SERVER_START_FILE: startsFile },
    };
    const first = await ensureCodexAppServer(input);
    await stopEndpoint(first.pid);
    await writeFile(first.socketPath, "stale socket placeholder");

    const second = await ensureCodexAppServer(input);

    try {
      assert.equal(second.socketPath, first.socketPath);
      assert.equal((await readStartPids(startsFile)).length, 2);
      const connection = await connectCodexAppServer(second);
      await connection.close();
    } finally {
      await stopEndpoint(second.pid);
    }
  });
});

test("Codex app-server controller does not kill unverified stale backend pids", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fake = await makeFakeCodexExecutable(workspaceRoot);
    const startsFile = join(workspaceRoot, "starts.txt");
    const orchestratorDir = join(workspaceRoot, ".orchestrator");
    const input = {
      executable: fake.executable,
      cwd: workspaceRoot,
      orchestratorDir,
      env: { FAKE_CODEX_APP_SERVER_START_FILE: startsFile },
    };
    const first = await ensureCodexAppServer(input);
    await stopEndpoint(first.pid);
    await writeFile(first.socketPath, "stale socket placeholder");
    const recordedAt = new Date().toISOString();
    await writeFile(
      join(orchestratorDir, "providers", "codex-app-server", "backend.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          executable: fake.executable,
          socketPath: first.socketPath,
          pid: process.pid,
          pidStartedAtMs: 1,
          startedAt: recordedAt,
          updatedAt: recordedAt,
          stdoutLogPath:
            first.stdoutLogPath ??
            join(orchestratorDir, "providers", "codex-app-server", "app-server.stdout.log"),
          stderrLogPath:
            first.stderrLogPath ??
            join(orchestratorDir, "providers", "codex-app-server", "app-server.stderr.log"),
        },
        null,
        2,
      )}\n`,
    );

    const second = await ensureCodexAppServer(input);

    try {
      assert.notEqual(second.pid, process.pid);
      assert.equal((await readStartPids(startsFile)).length, 2);
      const connection = await connectCodexAppServer(second);
      await connection.close();
    } finally {
      await stopEndpoint(second.pid);
    }
  });
});

test("Codex app-server controller reports managed backend startup failures with log paths", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fake = await makeFakeCodexExecutable(workspaceRoot);
    await assert.rejects(
      ensureCodexAppServer({
        executable: fake.executable,
        cwd: workspaceRoot,
        orchestratorDir: join(workspaceRoot, ".orchestrator"),
        timeoutMs: 1_000,
        env: { FAKE_CODEX_APP_SERVER_FAIL: "fake backend failed" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexAppServerControllerError);
        assert.equal(error.reason, "backend_failed");
        const details = backendFailureDetails(error.details);
        assert.ok(details.stderrLogPath.endsWith("app-server.stderr.log"));
        return true;
      },
    );
    const stderr = await readFile(
      join(
        workspaceRoot,
        ".orchestrator",
        "providers",
        "codex-app-server",
        "app-server.stderr.log",
      ),
      "utf8",
    );
    assert.match(stderr, /fake backend failed/);
  });
});

test("Codex app-server controller initializes and calls thread turn goal methods", async () => {
  await withFakeCodexAppServer(async ({ socketPath, requests }) => {
    const connection = await connectCodexAppServer({ socketPath });

    try {
      const started = await connection.startThread({
        cwd: "/tmp/workspace",
        model: "gpt-test",
        ephemeral: false,
      });
      assert.deepEqual(started, {
        thread: { id: "thread-fake-1", path: "/tmp/fake/thread-fake-1" },
      });

      const turn = await connection.startTurn({
        threadId: "thread-fake-1",
        input: [{ type: "text", text: "hello" }],
        model: "gpt-test",
        clientUserMessageId: "client-message-1",
      });
      assert.deepEqual(turn, { turn: { id: "turn-fake-1" } });

      const goal = await connection.setGoal({
        threadId: "thread-fake-1",
        objective: "Improve performance.",
        status: "active",
        tokenBudget: 100,
      });
      assert.deepEqual(goal, {
        goal: {
          provider: "codex",
          threadId: "thread-fake-1",
          objective: "Improve performance.",
          status: "active",
          tokenBudget: 100,
        },
      });

      assert.deepEqual(await connection.getGoal("thread-fake-1"), goal);
      assert.deepEqual(await connection.clearGoal("thread-fake-1"), { cleared: true });
      assert.deepEqual(
        await connection.interruptTurn({ threadId: "thread-fake-1", turnId: "turn-fake-1" }),
        {
          interrupted: true,
        },
      );

      assert.deepEqual(
        requests.map((request) => request.method),
        [
          "initialize",
          "initialized",
          "thread/start",
          "turn/start",
          "thread/goal/set",
          "thread/goal/get",
          "thread/goal/clear",
          "turn/interrupt",
        ],
      );
    } finally {
      await connection.close();
    }
  });
});

test("CLI launch codex-app-server --session uses the managed backend path", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fake = await makeFakeCodexExecutable(workspaceRoot);
    const startsFile = join(workspaceRoot, "starts.txt");
    const output = await runCli(
      workspaceRoot,
      [
        "launch",
        "codex-app-server",
        "--workspace",
        workspaceRoot,
        "--session",
        "--name",
        "managed cli session",
        "--json",
      ],
      10_000,
      {
        PATH: `${fake.binDir}:${process.env.PATH ?? ""}`,
        FAKE_CODEX_APP_SERVER_START_FILE: startsFile,
      },
    );
    const launched = JSON.parse(output.stdout) as { taskId: string; status: string };
    const task = await readTask(workspaceRoot, launched.taskId);

    try {
      assert.equal(launched.status, "running");
      assert.equal(task.runtime, "codex-app-server");
      assert.equal(task.provider?.threadId, "thread-managed-1");
      assert.equal(task.session?.state, "idle");
      assert.equal(task.supervision?.kind, "provider");
      assert.equal(typeof task.supervision.backendPid, "number");
      assert.equal((await readStartPids(startsFile)).length, 1);
    } finally {
      await stopEndpoint(
        task.supervision?.kind === "provider" ? task.supervision.backendPid : undefined,
      );
    }
  });
});

type FakeRequest = {
  method: string;
  params?: unknown;
};

type FakeCodexServer = {
  socketPath: string;
  requests: FakeRequest[];
};

type FakeCodexExecutable = {
  executable: string;
  binDir: string;
};

async function withFakeCodexAppServer(
  fn: (server: FakeCodexServer) => Promise<void>,
): Promise<void> {
  await withTempWorkspace(async () => {
    const socketPath = join("/tmp", `orch-codex-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
    const requests: FakeRequest[] = [];
    const server = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    });
    webSocketServer.on("connection", (webSocket) => {
      webSocket.on("message", (data) => {
        const message = JSON.parse(rawDataToString(data)) as {
          id?: string | number;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (!message.method) {
          return;
        }
        requests.push({
          method: message.method,
          ...(message.params ? { params: message.params } : {}),
        });
        respond(webSocket, message.id, responseFor(message.method, message.params));
      });
    });
    await listenUnix(server, socketPath);

    try {
      await fn({ socketPath, requests });
    } finally {
      webSocketServer.close();
      await closeServer(server);
      await rm(socketPath, { force: true }).catch(() => undefined);
    }
  }, "orchestrator-codex-controller-");
}

function responseFor(method: string, params: Record<string, unknown> | undefined): unknown {
  switch (method) {
    case "initialize":
      return { serverInfo: { name: "fake-codex-app-server", version: "0.0.0" } };
    case "thread/start":
    case "thread/resume":
      return { thread: { id: "thread-fake-1", path: "/tmp/fake/thread-fake-1" } };
    case "thread/read":
      return { thread: { id: params?.threadId, status: "idle" } };
    case "thread/unsubscribe":
      return { unsubscribed: true };
    case "turn/start":
    case "turn/steer":
      return { turn: { id: "turn-fake-1" } };
    case "turn/interrupt":
      return { interrupted: true };
    case "thread/goal/set":
      return {
        goal: {
          provider: "codex",
          threadId: params?.threadId,
          objective: params?.objective,
          status: params?.status,
          tokenBudget: params?.tokenBudget,
        },
      };
    case "thread/goal/get":
      return {
        goal: {
          provider: "codex",
          threadId: params?.threadId,
          objective: "Improve performance.",
          status: "active",
          tokenBudget: 100,
        },
      };
    case "thread/goal/clear":
      return { cleared: true };
    default:
      return {};
  }
}

function respond(webSocket: WebSocket, id: unknown, result: unknown): void {
  webSocket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
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

async function makeFakeCodexExecutable(workspaceRoot: string): Promise<FakeCodexExecutable> {
  const binDir = join(workspaceRoot, "fake-bin");
  const executable = join(binDir, "codex");
  const fakeBin = fileURLToPath(new URL("./fake-codex-app-server-bin.ts", import.meta.url));
  await mkdir(binDir, { recursive: true });
  await writeFile(
    executable,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} --experimental-strip-types ${shellQuote(fakeBin)} "$@"\n`,
  );
  await chmod(executable, 0o755);
  return { executable, binDir };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readStartPids(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function stopEndpoint(pid: number | undefined): Promise<void> {
  if (!pid) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    if (!isPidAlive(pid)) {
      return;
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 25);
    });
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function backendFailureDetails(value: unknown): { stderrLogPath: string } {
  assert.ok(value && typeof value === "object");
  assert.ok("stderrLogPath" in value);
  const stderrLogPath = value.stderrLogPath;
  if (typeof stderrLogPath !== "string") {
    assert.fail("Expected stderrLogPath to be a string.");
  }
  return { stderrLogPath };
}
