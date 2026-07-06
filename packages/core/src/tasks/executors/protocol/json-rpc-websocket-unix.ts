import { createConnection } from "node:net";
import WebSocket from "ws";
import type {
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcNotificationFilter,
  JsonRpcNotificationSubscription,
  JsonRpcRequestOptions,
  JsonRpcServerRequest,
  JsonRpcServerRequestHandler,
} from "./json-rpc-stdio.ts";

export type {
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcNotificationFilter,
  JsonRpcNotificationSubscription,
  JsonRpcRequestOptions,
  JsonRpcServerRequest,
  JsonRpcServerRequestHandler,
} from "./json-rpc-stdio.ts";

export type JsonRpcWebSocketUnixClientOptions = {
  socketPath: string;
  requestPath?: string;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  notificationBufferSize?: number;
  onServerRequest?: JsonRpcServerRequestHandler;
  onProtocolError?: (error: JsonRpcWebSocketUnixClientError) => void;
};

export type JsonRpcWebSocketUnixCloseResult = {
  code: number | null;
  reason: string;
  clean: boolean;
};

type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type PendingRequest = {
  method: string;
  timeout?: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type NotificationSubscriber = {
  filter: JsonRpcNotificationFilter;
  handler(notification: JsonRpcNotification): void | Promise<void>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_NOTIFICATION_BUFFER_SIZE = 200;

export class JsonRpcWebSocketUnixClientError extends Error {
  readonly code:
    | "connect_error"
    | "write_error"
    | "parse_error"
    | "protocol_error"
    | "request_timeout"
    | "socket_closed";
  readonly details?: unknown;

  constructor(
    code: JsonRpcWebSocketUnixClientError["code"],
    message: string,
    details: { details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: details.cause });
    this.name = "JsonRpcWebSocketUnixClientError";
    this.code = code;
    this.details = details.details;
  }
}

export function startJsonRpcWebSocketUnixClient(
  options: JsonRpcWebSocketUnixClientOptions,
): JsonRpcWebSocketUnixClient {
  return new JsonRpcWebSocketUnixClient(options);
}

export class JsonRpcWebSocketUnixClient {
  readonly closed: Promise<JsonRpcWebSocketUnixCloseResult>;

  private readonly socket: WebSocket;
  private readonly options: Required<
    Pick<
      JsonRpcWebSocketUnixClientOptions,
      "requestPath" | "requestTimeoutMs" | "closeTimeoutMs" | "notificationBufferSize"
    >
  > &
    Pick<JsonRpcWebSocketUnixClientOptions, "onProtocolError" | "onServerRequest">;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscribers = new Set<NotificationSubscriber>();
  private readonly bufferedNotifications: JsonRpcNotification[] = [];
  private readonly ready: Promise<void>;
  private nextRequestId = 1;
  private closeResult: JsonRpcWebSocketUnixCloseResult | undefined;
  private resolveClosed!: (result: JsonRpcWebSocketUnixCloseResult) => void;
  private closing = false;

  constructor(options: JsonRpcWebSocketUnixClientOptions) {
    this.options = {
      requestPath: options.requestPath ?? "/",
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      notificationBufferSize: options.notificationBufferSize ?? DEFAULT_NOTIFICATION_BUFFER_SIZE,
      ...(options.onServerRequest ? { onServerRequest: options.onServerRequest } : {}),
      ...(options.onProtocolError ? { onProtocolError: options.onProtocolError } : {}),
    };
    this.closed = new Promise<JsonRpcWebSocketUnixCloseResult>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.socket = new WebSocket(`ws://localhost${this.options.requestPath}`, {
      createConnection: () => createConnection(options.socketPath),
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", (error) => {
        reject(toClientError("connect_error", "JSON-RPC websocket connection failed.", error));
      });
    });
    this.attachSocketHandlers();
  }

  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {},
  ): Promise<TResult> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const message = jsonRpcMessage({ id, method, params });
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;

    return await new Promise<TResult>((resolve, reject) => {
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(idKey(id));
              reject(
                new JsonRpcWebSocketUnixClientError(
                  "request_timeout",
                  `JSON-RPC request "${method}" timed out after ${timeoutMs}ms.`,
                ),
              );
            }, timeoutMs)
          : undefined;
      if (timeout) {
        timeout.unref();
      }

      this.pending.set(idKey(id), {
        method,
        ...(timeout ? { timeout } : {}),
        resolve: (value) => resolve(value as TResult),
        reject,
      });

      this.writeMessage(message).catch((error: unknown) => {
        this.pending.delete(idKey(id));
        if (timeout) {
          clearTimeout(timeout);
        }
        reject(
          toClientError(
            "write_error",
            `Failed to write JSON-RPC websocket request "${method}".`,
            error,
          ),
        );
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.writeMessage(jsonRpcMessage({ method, params }));
  }

  subscribeNotifications(
    filter: JsonRpcNotificationFilter,
    handler: (notification: JsonRpcNotification) => void | Promise<void>,
    options: { replayBuffered?: boolean } = {},
  ): JsonRpcNotificationSubscription {
    const subscriber: NotificationSubscriber = { filter, handler };
    this.subscribers.add(subscriber);

    if (options.replayBuffered !== false) {
      for (const notification of this.drainBufferedNotifications(filter)) {
        this.deliverNotification(subscriber, notification);
      }
    }

    return {
      unsubscribe: () => {
        this.subscribers.delete(subscriber);
      },
    };
  }

  drainBufferedNotifications(filter: JsonRpcNotificationFilter = {}): JsonRpcNotification[] {
    const matched: JsonRpcNotification[] = [];
    const kept: JsonRpcNotification[] = [];

    for (const notification of this.bufferedNotifications) {
      if (matchesNotification(filter, notification)) {
        matched.push(notification);
      } else {
        kept.push(notification);
      }
    }

    this.bufferedNotifications.length = 0;
    this.bufferedNotifications.push(...kept);
    return matched;
  }

  async close(options: { timeoutMs?: number } = {}): Promise<JsonRpcWebSocketUnixCloseResult> {
    if (this.closeResult) {
      return this.closeResult;
    }
    if (this.closing) {
      return await this.closed;
    }

    this.closing = true;
    if (
      this.socket.readyState === WebSocket.CONNECTING ||
      this.socket.readyState === WebSocket.OPEN
    ) {
      this.socket.close(1000, "client closing");
    }

    const graceful = await waitForClose(
      this.closed,
      options.timeoutMs ?? this.options.closeTimeoutMs,
    );
    if (graceful) {
      return graceful;
    }

    this.socket.terminate();
    return await this.closed;
  }

  private attachSocketHandlers(): void {
    this.socket.on("message", (data) => {
      this.handleRawMessage(data);
    });
    this.socket.on("error", (error) => {
      const clientError = toClientError("connect_error", "JSON-RPC websocket error.", error);
      this.handleProtocolError(clientError);
      this.rejectPending(clientError);
    });
    this.socket.on("close", (code, reason) => {
      this.rejectPending(
        new JsonRpcWebSocketUnixClientError(
          "socket_closed",
          "JSON-RPC websocket closed before all requests completed.",
          { details: { code, reason: reason.toString("utf8") } },
        ),
      );
      this.finishClose(code, reason.toString("utf8"));
    });
  }

  private handleRawMessage(data: WebSocket.RawData): void {
    const text = rawDataToString(data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.handleProtocolError(
        new JsonRpcWebSocketUnixClientError("parse_error", "Invalid JSON-RPC websocket message.", {
          details: { message: text },
          cause: error,
        }),
      );
      return;
    }

    if (!isRecord(parsed)) {
      this.handleProtocolError(
        new JsonRpcWebSocketUnixClientError(
          "protocol_error",
          "JSON-RPC websocket message must be an object.",
          { details: parsed },
        ),
      );
      return;
    }

    if (isJsonRpcResponse(parsed)) {
      this.handleResponse(parsed);
      return;
    }
    if (isJsonRpcServerRequest(parsed)) {
      this.handleServerRequest(parsed);
      return;
    }
    if (isJsonRpcNotification(parsed)) {
      this.handleNotification(parsed);
      return;
    }

    this.handleProtocolError(
      new JsonRpcWebSocketUnixClientError(
        "protocol_error",
        "Unsupported JSON-RPC websocket message shape.",
        { details: parsed },
      ),
    );
  }

  private handleResponse(response: JsonRpcResponse): void {
    const key = idKey(response.id);
    const pending = this.pending.get(key);
    if (!pending) {
      this.handleProtocolError(
        new JsonRpcWebSocketUnixClientError(
          "protocol_error",
          "Received response for unknown JSON-RPC websocket id.",
          { details: response },
        ),
      );
      return;
    }

    this.pending.delete(key);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    if (response.error) {
      pending.reject(
        new JsonRpcWebSocketUnixClientError(
          "protocol_error",
          response.error.message ?? `JSON-RPC request "${pending.method}" failed.`,
          { details: response.error },
        ),
      );
      return;
    }

    pending.resolve(response.result);
  }

  private handleServerRequest(request: JsonRpcServerRequest): void {
    void (async () => {
      try {
        const result = this.options.onServerRequest
          ? await this.options.onServerRequest(request)
          : {};
        await this.writeMessage({
          jsonrpc: "2.0",
          id: request.id,
          result,
        });
      } catch (error) {
        const clientError = toClientError(
          "protocol_error",
          `JSON-RPC server request "${request.method}" handler failed.`,
          error,
        );
        this.handleProtocolError(clientError);
        await this.writeMessage({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: clientError.message,
          },
        }).catch((writeError: unknown) => {
          this.handleProtocolError(
            toClientError(
              "write_error",
              "Failed to write JSON-RPC websocket server response.",
              writeError,
            ),
          );
        });
      }
    })();
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const matchingSubscribers = Array.from(this.subscribers).filter((subscriber) =>
      matchesNotification(subscriber.filter, notification),
    );

    if (matchingSubscribers.length === 0) {
      this.bufferNotification(notification);
      return;
    }

    for (const subscriber of matchingSubscribers) {
      this.deliverNotification(subscriber, notification);
    }
  }

  private deliverNotification(
    subscriber: NotificationSubscriber,
    notification: JsonRpcNotification,
  ): void {
    void Promise.resolve(subscriber.handler(notification)).catch((error: unknown) => {
      this.handleProtocolError(
        toClientError("protocol_error", "JSON-RPC websocket notification handler failed.", error),
      );
    });
  }

  private bufferNotification(notification: JsonRpcNotification): void {
    if (this.options.notificationBufferSize <= 0) {
      return;
    }

    this.bufferedNotifications.push(notification);
    while (this.bufferedNotifications.length > this.options.notificationBufferSize) {
      this.bufferedNotifications.shift();
    }
  }

  private async writeMessage(message: Record<string, unknown>): Promise<void> {
    if (
      this.closeResult ||
      this.closing ||
      this.socket.readyState === WebSocket.CLOSING ||
      this.socket.readyState === WebSocket.CLOSED
    ) {
      throw new JsonRpcWebSocketUnixClientError("socket_closed", "JSON-RPC websocket is closed.");
    }

    await this.ready;
    await new Promise<void>((resolve, reject) => {
      this.socket.send(JSON.stringify(message), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private handleProtocolError(error: JsonRpcWebSocketUnixClientError): void {
    try {
      this.options.onProtocolError?.(error);
    } catch {
      // Protocol observers are diagnostic only; they must not block transport cleanup.
    }
    if (error.code === "parse_error") {
      this.rejectPending(error);
      this.socket.close(1002, "invalid JSON-RPC message");
    }
  }

  private rejectPending(error: JsonRpcWebSocketUnixClientError): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }

  private finishClose(code: number, reason: string): void {
    if (this.closeResult) {
      return;
    }

    this.closeResult = {
      code,
      reason,
      clean: code === 1000,
    };
    this.resolveClosed(this.closeResult);
  }
}

function jsonRpcMessage(input: {
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    ...(input.id !== undefined ? { id: input.id } : {}),
    method: input.method,
    ...(input.params !== undefined ? { params: input.params } : {}),
  };
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

function isJsonRpcResponse(value: Record<string, unknown>): value is JsonRpcResponse {
  return (
    (typeof value.id === "string" || typeof value.id === "number") &&
    ("result" in value || "error" in value)
  );
}

function isJsonRpcServerRequest(value: Record<string, unknown>): value is JsonRpcServerRequest {
  return (
    (typeof value.id === "string" || typeof value.id === "number") &&
    typeof value.method === "string" &&
    !("result" in value) &&
    !("error" in value)
  );
}

function isJsonRpcNotification(value: Record<string, unknown>): value is JsonRpcNotification {
  return !("id" in value) && typeof value.method === "string";
}

function matchesNotification(
  filter: JsonRpcNotificationFilter,
  notification: JsonRpcNotification,
): boolean {
  if (filter.method && notification.method !== filter.method) {
    return false;
  }
  if (filter.threadId && notificationParam(notification, "threadId") !== filter.threadId) {
    return false;
  }
  if (filter.turnId && notificationParam(notification, "turnId") !== filter.turnId) {
    return false;
  }
  return filter.predicate ? filter.predicate(notification) : true;
}

function notificationParam(
  notification: JsonRpcNotification,
  name: "threadId" | "turnId",
): string | undefined {
  if (!isRecord(notification.params)) {
    return undefined;
  }
  const value = notification.params[name] ?? notification.params[toSnakeCase(name)];
  return typeof value === "string" ? value : undefined;
}

function toSnakeCase(value: "threadId" | "turnId"): "thread_id" | "turn_id" {
  return value === "threadId" ? "thread_id" : "turn_id";
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitForClose(
  closed: Promise<JsonRpcWebSocketUnixCloseResult>,
  timeoutMs: number,
): Promise<JsonRpcWebSocketUnixCloseResult | undefined> {
  if (timeoutMs <= 0) {
    return undefined;
  }

  return await Promise.race([closed, delay(timeoutMs).then(() => undefined)]);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toClientError(
  code: JsonRpcWebSocketUnixClientError["code"],
  message: string,
  error: unknown,
): JsonRpcWebSocketUnixClientError {
  if (error instanceof JsonRpcWebSocketUnixClientError) {
    return error;
  }
  return new JsonRpcWebSocketUnixClientError(code, message, {
    cause: error,
    details: error instanceof Error ? { message: error.message } : error,
  });
}
