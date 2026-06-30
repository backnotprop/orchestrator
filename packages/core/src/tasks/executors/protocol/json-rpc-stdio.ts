import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type JsonRpcId = string | number;

export type JsonRpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcServerRequest = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcServerRequestHandler = (
  request: JsonRpcServerRequest,
) => Promise<unknown> | unknown;

export type JsonRpcRequestOptions = {
  timeoutMs?: number;
};

export type JsonRpcNotificationFilter = {
  method?: string;
  threadId?: string;
  turnId?: string;
  predicate?: (notification: JsonRpcNotification) => boolean;
};

export type JsonRpcNotificationSubscription = {
  unsubscribe(): void;
};

export type JsonRpcStdioClientOptions = {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  killTimeoutMs?: number;
  notificationBufferSize?: number;
  stderrMaxBytes?: number;
  onServerRequest?: JsonRpcServerRequestHandler;
  onProtocolError?: (error: JsonRpcStdioClientError) => void;
};

export type JsonRpcStdioCloseResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  stderr: string;
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
const DEFAULT_KILL_TIMEOUT_MS = 1_000;
const DEFAULT_NOTIFICATION_BUFFER_SIZE = 200;
const DEFAULT_STDERR_MAX_BYTES = 64_000;

export class JsonRpcStdioClientError extends Error {
  readonly code:
    | "spawn_error"
    | "write_error"
    | "parse_error"
    | "protocol_error"
    | "request_timeout"
    | "process_closed";
  readonly details?: unknown;
  readonly stderr?: string;

  constructor(
    code: JsonRpcStdioClientError["code"],
    message: string,
    details: { details?: unknown; stderr?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: details.cause });
    this.name = "JsonRpcStdioClientError";
    this.code = code;
    this.details = details.details;
    this.stderr = details.stderr;
  }
}

export function startJsonRpcStdioClient(options: JsonRpcStdioClientOptions): JsonRpcStdioClient {
  return new JsonRpcStdioClient(options);
}

export class JsonRpcStdioClient {
  readonly closed: Promise<JsonRpcStdioCloseResult>;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly options: Required<
    Pick<
      JsonRpcStdioClientOptions,
      | "requestTimeoutMs"
      | "closeTimeoutMs"
      | "killTimeoutMs"
      | "notificationBufferSize"
      | "stderrMaxBytes"
    >
  > &
    Pick<JsonRpcStdioClientOptions, "onProtocolError" | "onServerRequest">;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscribers = new Set<NotificationSubscriber>();
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private readonly bufferedNotifications: JsonRpcNotification[] = [];
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private nextRequestId = 1;
  private closeResult: JsonRpcStdioCloseResult | undefined;
  private resolveClosed!: (result: JsonRpcStdioCloseResult) => void;
  private closing = false;
  private killed = false;

  constructor(options: JsonRpcStdioClientOptions) {
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      killTimeoutMs: options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS,
      notificationBufferSize: options.notificationBufferSize ?? DEFAULT_NOTIFICATION_BUFFER_SIZE,
      stderrMaxBytes: options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES,
      ...(options.onServerRequest ? { onServerRequest: options.onServerRequest } : {}),
      ...(options.onProtocolError ? { onProtocolError: options.onProtocolError } : {}),
    };
    this.closed = new Promise<JsonRpcStdioCloseResult>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.child = spawn(options.executable, options.args ?? [], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.attachProcessHandlers();
  }

  get stderr(): string {
    return this.stderrBuffer;
  }

  get pid(): number | undefined {
    return this.child.pid;
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
                new JsonRpcStdioClientError(
                  "request_timeout",
                  `JSON-RPC request "${method}" timed out after ${timeoutMs}ms.`,
                  { stderr: this.stderr },
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

      this.writeLine(message).catch((error: unknown) => {
        this.pending.delete(idKey(id));
        if (timeout) {
          clearTimeout(timeout);
        }
        reject(
          toClientError("write_error", `Failed to write JSON-RPC request "${method}".`, error),
        );
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.writeLine(jsonRpcMessage({ method, params }));
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

  async close(
    options: { timeoutMs?: number; killTimeoutMs?: number } = {},
  ): Promise<JsonRpcStdioCloseResult> {
    if (this.closeResult) {
      return this.closeResult;
    }
    if (this.closing) {
      return await this.closed;
    }

    this.closing = true;
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) {
      this.child.stdin.end();
    }

    const graceful = await waitForClose(
      this.closed,
      options.timeoutMs ?? this.options.closeTimeoutMs,
    );
    if (graceful) {
      return graceful;
    }

    this.kill("SIGTERM");
    const killed = await waitForClose(
      this.closed,
      options.killTimeoutMs ?? this.options.killTimeoutMs,
    );
    if (killed) {
      return killed;
    }

    this.kill("SIGKILL");
    return await this.closed;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.closeResult) {
      return;
    }
    this.killed = true;
    killPidGroup(this.child.pid, signal);
  }

  private attachProcessHandlers(): void {
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.consumeStdout(this.stdoutDecoder.write(chunk));
    });
    this.child.stdout.on("end", () => {
      this.consumeStdout(this.stdoutDecoder.end());
      const trailing = this.stdoutBuffer.trim();
      this.stdoutBuffer = "";
      if (trailing) {
        this.handleProtocolError(
          new JsonRpcStdioClientError("parse_error", "JSON-RPC stdout ended with a partial line.", {
            details: { line: trailing },
            stderr: this.stderr,
          }),
        );
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.appendStderr(this.stderrDecoder.write(chunk));
    });
    this.child.stderr.on("end", () => {
      this.appendStderr(this.stderrDecoder.end());
    });
    this.child.on("error", (error) => {
      const clientError = toClientError("spawn_error", "JSON-RPC stdio process failed.", error);
      this.rejectPending(clientError);
      this.finishClose(null, null);
    });
    this.child.on("close", (exitCode, signal) => {
      this.rejectPending(
        new JsonRpcStdioClientError(
          "process_closed",
          `JSON-RPC stdio process closed before all requests completed.`,
          { details: { exitCode, signal }, stderr: this.stderr },
        ),
      );
      this.finishClose(exitCode, signal);
    });
  }

  private consumeStdout(text: string): void {
    if (!text) {
      return;
    }

    this.stdoutBuffer += text;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const rawLine = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.handleProtocolError(
        new JsonRpcStdioClientError("parse_error", "Invalid JSON-RPC message on stdout.", {
          details: { line },
          stderr: this.stderr,
          cause: error,
        }),
      );
      return;
    }

    if (!isRecord(parsed)) {
      this.handleProtocolError(
        new JsonRpcStdioClientError("protocol_error", "JSON-RPC message must be an object.", {
          details: parsed,
          stderr: this.stderr,
        }),
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
      new JsonRpcStdioClientError("protocol_error", "Unsupported JSON-RPC message shape.", {
        details: parsed,
        stderr: this.stderr,
      }),
    );
  }

  private handleResponse(response: JsonRpcResponse): void {
    const key = idKey(response.id);
    const pending = this.pending.get(key);
    if (!pending) {
      this.handleProtocolError(
        new JsonRpcStdioClientError(
          "protocol_error",
          "Received response for unknown JSON-RPC id.",
          {
            details: response,
            stderr: this.stderr,
          },
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
        new JsonRpcStdioClientError(
          "protocol_error",
          response.error.message ?? `JSON-RPC request "${pending.method}" failed.`,
          { details: response.error, stderr: this.stderr },
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
        await this.writeLine({
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
        await this.writeLine({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: clientError.message,
          },
        }).catch((writeError: unknown) => {
          this.handleProtocolError(
            toClientError("write_error", "Failed to write JSON-RPC server response.", writeError),
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
        toClientError("protocol_error", "JSON-RPC notification handler failed.", error),
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

  private appendStderr(text: string): void {
    if (!text) {
      return;
    }

    this.stderrBuffer += text;
    if (this.stderrBuffer.length > this.options.stderrMaxBytes) {
      this.stderrBuffer = this.stderrBuffer.slice(-this.options.stderrMaxBytes);
    }
  }

  private async writeLine(message: Record<string, unknown>): Promise<void> {
    if (
      this.closeResult ||
      this.closing ||
      this.child.stdin.destroyed ||
      this.child.stdin.writableEnded
    ) {
      throw new JsonRpcStdioClientError("process_closed", "JSON-RPC stdio process is closed.", {
        stderr: this.stderr,
      });
    }

    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private handleProtocolError(error: JsonRpcStdioClientError): void {
    try {
      this.options.onProtocolError?.(error);
    } catch {
      // Protocol observers are diagnostic only; they must not block transport cleanup.
    }
    if (error.code === "parse_error") {
      this.rejectPending(error);
      this.kill("SIGTERM");
    }
  }

  private rejectPending(error: JsonRpcStdioClientError): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }

  private finishClose(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.closeResult) {
      return;
    }

    this.closeResult = {
      exitCode,
      signal,
      killed: this.killed,
      stderr: this.stderr,
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
  closed: Promise<JsonRpcStdioCloseResult>,
  timeoutMs: number,
): Promise<JsonRpcStdioCloseResult | undefined> {
  if (timeoutMs <= 0) {
    return undefined;
  }

  return await Promise.race([closed, delay(timeoutMs).then(() => undefined)]);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function killPidGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) {
    return;
  }

  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch (error) {
    if (!isIgnorableKillError(error)) {
      throw error;
    }
  }
}

function isIgnorableKillError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM")
  );
}

function toClientError(
  code: JsonRpcStdioClientError["code"],
  message: string,
  error: unknown,
): JsonRpcStdioClientError {
  if (error instanceof JsonRpcStdioClientError) {
    return error;
  }
  return new JsonRpcStdioClientError(code, message, {
    cause: error,
    details: error instanceof Error ? { message: error.message } : error,
  });
}
