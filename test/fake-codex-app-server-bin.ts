import { appendFileSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";

const failMessage = process.env.FAKE_CODEX_APP_SERVER_FAIL;
if (failMessage) {
  process.stderr.write(`${failMessage}\n`);
  process.exit(42);
}

const listenUrl = parseListenUrl(process.argv.slice(2));
const socketPath = listenUrl.slice("unix://".length);
const startFile = process.env.FAKE_CODEX_APP_SERVER_START_FILE;
if (startFile) {
  appendFileSync(startFile, `${process.pid}\n`);
}

let threadCounter = 1;
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
    respond(webSocket, message.id, responseFor(message.method, message.params));
  });
});

await listenUnix(server, socketPath);

const shutdown = async (): Promise<void> => {
  webSocketServer.close();
  await closeServer(server).catch(() => undefined);
  rmSync(socketPath, { force: true });
  process.exit(0);
};

process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});

setTimeout(
  () => {
    void shutdown();
  },
  Number(process.env.FAKE_CODEX_APP_SERVER_TTL_MS ?? 30_000),
).unref();

function parseListenUrl(args: readonly string[]): string {
  if (args[0] !== "app-server") {
    process.stderr.write(`Expected first arg app-server; got ${args[0] ?? "<missing>"}\n`);
    process.exit(2);
  }
  const listenIndex = args.indexOf("--listen");
  const listenUrl = listenIndex >= 0 ? args[listenIndex + 1] : undefined;
  if (!listenUrl?.startsWith("unix://")) {
    process.stderr.write(`Expected --listen unix://PATH; got ${listenUrl ?? "<missing>"}\n`);
    process.exit(2);
  }
  return listenUrl;
}

function responseFor(method: string, params: Record<string, unknown> | undefined): unknown {
  switch (method) {
    case "initialize":
      return { serverInfo: { name: "fake-codex-app-server-bin", version: "0.0.0" } };
    case "initialized":
      return {};
    case "thread/start": {
      const threadId = `thread-managed-${threadCounter++}`;
      return { thread: { id: threadId, path: `/tmp/fake/${threadId}` } };
    }
    case "thread/read":
      return { thread: { id: params?.threadId, status: "idle" } };
    case "thread/unsubscribe":
      return { unsubscribed: true };
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

async function listenUnix(server: HttpServer, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
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
