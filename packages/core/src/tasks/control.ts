import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TaskExecutionHandle } from "./executors/types.ts";
import { TaskSendMessageError } from "./executors/types.ts";
import type {
  TaskEvent,
  TaskPaths,
  TaskProviderMetadata,
  TaskSendMessageFailureReason,
} from "./types.ts";

const CONTROL_SCHEMA_VERSION = 1;
const CONTROL_POLL_INTERVAL_MS = 150;
const CONTROL_RESPONSE_POLL_INTERVAL_MS = 50;
const DEFAULT_SEND_MESSAGE_TIMEOUT_MS = 5_000;

export type TaskControlPaths = {
  controlDir: string;
  requestsDir: string;
  responsesDir: string;
  processedDir: string;
};

export type TaskControlRequest = {
  schemaVersion: 1;
  requestId: string;
  taskId: string;
  createdAt: string;
  expiresAt: string;
  kind: "send_message";
  input: {
    text: string;
    clientMessageId?: string;
    timeoutMs?: number;
  };
};

export type TaskControlResponse = {
  schemaVersion: 1;
  requestId: string;
  taskId: string;
  kind: "send_message";
  status: "accepted" | "failed";
  createdAt: string;
  completedAt: string;
  provider?: TaskProviderMetadata;
  error?: {
    reason: TaskSendMessageFailureReason;
    message: string;
  };
};

export class TaskControlRequestError extends Error {
  readonly reason: TaskSendMessageFailureReason;
  readonly input?: string;
  readonly hint?: string;

  constructor(
    reason: TaskSendMessageFailureReason,
    message: string,
    details: { input?: string; hint?: string } = {},
  ) {
    super(message);
    this.name = "TaskControlRequestError";
    this.reason = reason;
    this.input = details.input;
    this.hint = details.hint;
  }
}

export type TaskControlLoop = {
  stop(): void;
};

export function getTaskControlPaths(paths: Pick<TaskPaths, "taskDir">): TaskControlPaths {
  const controlDir = join(paths.taskDir, "control");
  return {
    controlDir,
    requestsDir: join(controlDir, "requests"),
    responsesDir: join(controlDir, "responses"),
    processedDir: join(controlDir, "processed"),
  };
}

export async function requestDetachedTaskMessage(input: {
  paths: Pick<TaskPaths, "taskDir">;
  taskId: string;
  text: string;
  timeoutMs?: number;
  clientMessageId?: string;
}): Promise<TaskControlResponse> {
  const requestId = randomUUID();
  const createdAt = now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_SEND_MESSAGE_TIMEOUT_MS;
  const request: TaskControlRequest = {
    schemaVersion: CONTROL_SCHEMA_VERSION,
    requestId,
    taskId: input.taskId,
    createdAt,
    expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    kind: "send_message",
    input: {
      text: input.text,
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    },
  };
  const paths = getTaskControlPaths(input.paths);
  await ensureControlDirs(paths);
  await writeJsonAtomic(requestPath(paths, requestId), request);
  return await waitForControlResponse({
    paths,
    taskId: input.taskId,
    requestId,
    timeoutMs,
  });
}

export function startTaskControlLoop(input: {
  taskId: string;
  paths: Pick<TaskPaths, "taskDir">;
  handle: TaskExecutionHandle;
  appendEvent: (type: TaskEvent["type"], data?: Record<string, unknown>) => Promise<TaskEvent>;
}): TaskControlLoop {
  const paths = getTaskControlPaths(input.paths);
  let stopped = false;
  let processing = false;

  const tick = (): void => {
    if (stopped || processing) {
      return;
    }
    processing = true;
    void processPendingControlRequests({ ...input, paths })
      .catch((error: unknown) =>
        input
          .appendEvent("agent_event", {
            kind: "control.error",
            error: errorMessage(error),
          })
          .catch(() => undefined),
      )
      .finally(() => {
        processing = false;
      });
  };

  const interval = setInterval(tick, CONTROL_POLL_INTERVAL_MS);
  interval.unref();
  tick();

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}

async function processPendingControlRequests(input: {
  taskId: string;
  paths: TaskControlPaths;
  handle: TaskExecutionHandle;
}): Promise<void> {
  await ensureControlDirs(input.paths);
  const requests = await pendingControlRequestFiles(input.paths);
  for (const request of requests) {
    await processControlRequestFile({ ...input, requestPath: request.path });
  }
}

async function processControlRequestFile(input: {
  taskId: string;
  paths: TaskControlPaths;
  handle: TaskExecutionHandle;
  requestPath: string;
}): Promise<void> {
  const requestId = requestIdFromPath(input.requestPath);
  if (await fileExists(responsePath(input.paths, requestId))) {
    await moveToProcessed(input.paths, input.requestPath, requestId);
    return;
  }

  const parsed = await readControlRequest(input.requestPath, input.taskId, requestId);
  const response = parsed.ok
    ? await handleFreshControlRequest(input.handle, parsed.request)
    : failedResponse({
        taskId: input.taskId,
        requestId: parsed.requestId,
        reason: "invalid_request",
        message: parsed.message,
      });

  await writeJsonAtomic(responsePath(input.paths, response.requestId), response);
  await moveToProcessed(input.paths, input.requestPath, response.requestId);
}

async function handleFreshControlRequest(
  handle: TaskExecutionHandle,
  request: TaskControlRequest,
): Promise<TaskControlResponse> {
  const remainingMs = requestRemainingMs(request);
  if (remainingMs <= 0) {
    return failedResponse({
      taskId: request.taskId,
      requestId: request.requestId,
      reason: "timeout",
      message: "Task control request expired before the running task accepted it.",
      createdAt: request.createdAt,
    });
  }

  return await handleControlRequest(handle, {
    ...request,
    input: {
      ...request.input,
      timeoutMs: Math.min(request.input.timeoutMs ?? remainingMs, remainingMs),
    },
  });
}

async function handleControlRequest(
  handle: TaskExecutionHandle,
  request: TaskControlRequest,
): Promise<TaskControlResponse> {
  if (!handle.sendMessage) {
    return failedResponse({
      taskId: request.taskId,
      requestId: request.requestId,
      reason: "unsupported",
      message: "This task runtime does not accept messages while running.",
    });
  }

  try {
    const result = await handle.sendMessage(request.input);
    return {
      schemaVersion: CONTROL_SCHEMA_VERSION,
      requestId: request.requestId,
      taskId: request.taskId,
      kind: "send_message",
      status: "accepted",
      createdAt: request.createdAt,
      completedAt: now(),
      ...(result.provider ? { provider: result.provider } : {}),
    };
  } catch (error: unknown) {
    const reason =
      error instanceof TaskSendMessageError ? error.reason : ("provider_rejected" as const);
    return failedResponse({
      taskId: request.taskId,
      requestId: request.requestId,
      reason,
      message: errorMessage(error),
      createdAt: request.createdAt,
    });
  }
}

async function waitForControlResponse(input: {
  paths: TaskControlPaths;
  taskId: string;
  requestId: string;
  timeoutMs: number;
}): Promise<TaskControlResponse> {
  const deadline = Date.now() + input.timeoutMs;
  const path = responsePath(input.paths, input.requestId);
  while (Date.now() <= deadline) {
    const response = await readControlResponse(path, input.taskId, input.requestId).catch(
      (error: unknown) => {
        if (isMissingFile(error)) {
          return undefined;
        }
        throw error;
      },
    );
    if (response) {
      return response;
    }
    await delay(CONTROL_RESPONSE_POLL_INTERVAL_MS);
  }

  throw new TaskControlRequestError(
    "timeout",
    `Timed out waiting for task "${input.taskId}" to accept the message.`,
    {
      input: input.taskId,
      hint: "Use events, logs, or ps to inspect the running task, then retry if it is still active.",
    },
  );
}

async function readControlRequest(
  path: string,
  expectedTaskId: string,
  fallbackRequestId: string,
): Promise<
  { ok: true; request: TaskControlRequest } | { ok: false; requestId: string; message: string }
> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      ok: false,
      requestId: fallbackRequestId,
      message: "Task control request is not valid JSON.",
    };
  }
  return parseControlRequest(parsed, expectedTaskId, fallbackRequestId);
}

async function readControlResponse(
  path: string,
  expectedTaskId: string,
  expectedRequestId: string,
): Promise<TaskControlResponse> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return parseControlResponse(parsed, expectedTaskId, expectedRequestId);
}

function parseControlRequest(
  value: unknown,
  expectedTaskId: string,
  fallbackRequestId: string,
): { ok: true; request: TaskControlRequest } | { ok: false; requestId: string; message: string } {
  if (!isRecord(value)) {
    return invalidRequest(fallbackRequestId, "Task control request must be an object.");
  }
  const requestId = stringValue(value.requestId) ?? fallbackRequestId;
  if (value.schemaVersion !== CONTROL_SCHEMA_VERSION) {
    return invalidRequest(requestId, "Task control request schema version is unsupported.");
  }
  if (stringValue(value.taskId) !== expectedTaskId) {
    return invalidRequest(requestId, "Task control request task id does not match this task.");
  }
  if (value.kind !== "send_message") {
    return invalidRequest(requestId, "Task control request kind is unsupported.");
  }
  const input = isRecord(value.input) ? value.input : undefined;
  if (!input) {
    return invalidRequest(requestId, "Task control request input must be an object.");
  }
  const text = stringValue(input.text)?.trim();
  if (!text) {
    return invalidRequest(requestId, "Task control request message must not be empty.");
  }
  const clientMessageId = stringValue(input.clientMessageId)?.trim();
  const timeoutMs = numberValue(input.timeoutMs);
  return {
    ok: true,
    request: {
      schemaVersion: CONTROL_SCHEMA_VERSION,
      requestId,
      taskId: expectedTaskId,
      createdAt: stringValue(value.createdAt) ?? now(),
      expiresAt: parseExpiresAt(value),
      kind: "send_message",
      input: {
        text,
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
    },
  };
}

function parseControlResponse(
  value: unknown,
  expectedTaskId: string,
  expectedRequestId: string,
): TaskControlResponse {
  if (!isRecord(value)) {
    throw new TaskControlRequestError(
      "invalid_request",
      "Task control response must be an object.",
    );
  }
  if (value.schemaVersion !== CONTROL_SCHEMA_VERSION) {
    throw new TaskControlRequestError(
      "invalid_request",
      "Task control response schema version is unsupported.",
    );
  }
  if (stringValue(value.taskId) !== expectedTaskId) {
    throw new TaskControlRequestError(
      "invalid_request",
      "Task control response task id does not match the requested task.",
    );
  }
  if (stringValue(value.requestId) !== expectedRequestId) {
    throw new TaskControlRequestError(
      "invalid_request",
      "Task control response id does not match the request.",
    );
  }
  if (value.kind !== "send_message") {
    throw new TaskControlRequestError(
      "invalid_request",
      "Task control response kind is unsupported.",
    );
  }
  if (value.status !== "accepted" && value.status !== "failed") {
    throw new TaskControlRequestError(
      "invalid_request",
      "Task control response status is unsupported.",
    );
  }
  const provider = isRecord(value.provider) ? parseProvider(value.provider) : undefined;
  const error = isRecord(value.error) ? parseResponseError(value.error) : undefined;
  return {
    schemaVersion: CONTROL_SCHEMA_VERSION,
    requestId: expectedRequestId,
    taskId: expectedTaskId,
    kind: "send_message",
    status: value.status,
    createdAt: stringValue(value.createdAt) ?? now(),
    completedAt: stringValue(value.completedAt) ?? now(),
    ...(provider ? { provider } : {}),
    ...(error ? { error } : {}),
  };
}

function parseProvider(value: Record<string, unknown>): TaskProviderMetadata | undefined {
  const provider = stringValue(value.provider);
  const protocol = value.protocol === "jsonrpc" ? "jsonrpc" : undefined;
  const transport =
    value.transport === "stdio" ||
    value.transport === "unix" ||
    value.transport === "websocket" ||
    value.transport === "http"
      ? value.transport
      : undefined;
  const parsed: TaskProviderMetadata = {
    ...(provider ? { provider } : {}),
    ...(protocol ? { protocol } : {}),
    ...(transport ? { transport } : {}),
    ...optionalString(value, "threadId"),
    ...optionalString(value, "turnId"),
    ...optionalString(value, "sessionId"),
    ...optionalString(value, "remoteTaskId"),
    ...optionalString(value, "connectionId"),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseResponseError(value: Record<string, unknown>): TaskControlResponse["error"] {
  const reason = parseFailureReason(value.reason);
  return {
    reason,
    message: stringValue(value.message) ?? "Task control request failed.",
  };
}

function parseFailureReason(value: unknown): TaskSendMessageFailureReason {
  switch (value) {
    case "unsupported":
    case "not_running":
    case "not_ready":
    case "provider_rejected":
    case "turn_mismatch":
    case "invalid_request":
    case "timeout":
    case "stale":
    case "orphaned":
    case "lost":
      return value;
    default:
      return "invalid_request";
  }
}

function parseExpiresAt(value: Record<string, unknown>): string {
  const expiresAt = stringValue(value.expiresAt);
  if (expiresAt && Number.isFinite(Date.parse(expiresAt))) {
    return expiresAt;
  }

  const createdAt = stringValue(value.createdAt);
  const createdAtMs = createdAt ? Date.parse(createdAt) : NaN;
  const timeoutMs =
    numberValue(isRecord(value.input) ? value.input.timeoutMs : undefined) ??
    DEFAULT_SEND_MESSAGE_TIMEOUT_MS;
  const baseMs = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
  return new Date(baseMs + timeoutMs).toISOString();
}

function requestRemainingMs(request: TaskControlRequest): number {
  const expiresAtMs = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return 0;
  }
  return expiresAtMs - Date.now();
}

function failedResponse(input: {
  taskId: string;
  requestId: string;
  reason: TaskSendMessageFailureReason;
  message: string;
  createdAt?: string;
}): TaskControlResponse {
  return {
    schemaVersion: CONTROL_SCHEMA_VERSION,
    requestId: input.requestId,
    taskId: input.taskId,
    kind: "send_message",
    status: "failed",
    createdAt: input.createdAt ?? now(),
    completedAt: now(),
    error: {
      reason: input.reason,
      message: input.message,
    },
  };
}

async function pendingControlRequestFiles(
  paths: TaskControlPaths,
): Promise<Array<{ path: string; mtimeMs: number }>> {
  let entries: string[];
  try {
    entries = await readdir(paths.requestsDir);
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }

  const requests = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        const path = join(paths.requestsDir, entry);
        const stats = await stat(path);
        return { path, mtimeMs: stats.mtimeMs };
      }),
  );
  return requests.sort(
    (left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path),
  );
}

async function ensureControlDirs(paths: TaskControlPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.requestsDir, { recursive: true }),
    mkdir(paths.responsesDir, { recursive: true }),
    mkdir(paths.processedDir, { recursive: true }),
  ]);
}

async function moveToProcessed(
  paths: TaskControlPaths,
  currentPath: string,
  requestId: string,
): Promise<void> {
  await rename(currentPath, join(paths.processedDir, `${requestId}.json`));
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, path);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

function requestPath(paths: TaskControlPaths, requestId: string): string {
  return join(paths.requestsDir, `${requestId}.json`);
}

function responsePath(paths: TaskControlPaths, requestId: string): string {
  return join(paths.responsesDir, `${requestId}.json`);
}

function requestIdFromPath(path: string): string {
  return basename(path).replace(/\.json$/, "");
}

function invalidRequest(
  requestId: string,
  message: string,
): { ok: false; requestId: string; message: string } {
  return { ok: false, requestId, message };
}

function optionalString(value: Record<string, unknown>, key: string): Record<string, string> {
  const parsed = stringValue(value[key]);
  return parsed ? { [key]: parsed } : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function now(): string {
  return new Date().toISOString();
}
