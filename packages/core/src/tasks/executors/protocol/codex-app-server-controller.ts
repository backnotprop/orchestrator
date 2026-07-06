import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { captureProcessIdentity } from "../../observation.ts";
import { getOrchestratorDir } from "../../store.ts";
import {
  startJsonRpcWebSocketUnixClient,
  type JsonRpcNotification,
  type JsonRpcNotificationFilter,
  type JsonRpcNotificationSubscription,
  type JsonRpcServerRequestHandler,
  type JsonRpcWebSocketUnixClient,
} from "./json-rpc-websocket-unix.ts";

const DEFAULT_BACKEND_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const BACKEND_HEALTH_TIMEOUT_MS = 1_000;
const BACKEND_READY_POLL_MS = 100;
const BACKEND_LOCK_POLL_MS = 50;
const BACKEND_LOCK_STALE_MS = 60_000;

export type CodexAppServerEndpoint = {
  socketPath: string;
  pid?: number;
  managed?: boolean;
  startedAt?: string;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  status?: string;
  backend?: string;
  managedCodexPath?: string;
  managedCodexVersion?: string;
  cliVersion?: string;
  appServerVersion?: string;
};

export type EnsureCodexAppServerInput = {
  executable?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  socketPath?: string;
  orchestratorDir?: string;
};

export type CodexAppServerBackendRecord = {
  schemaVersion: 1;
  executable: string;
  socketPath: string;
  pid: number;
  pidStartedAtMs?: number;
  startedAt: string;
  updatedAt: string;
  stdoutLogPath: string;
  stderrLogPath: string;
};

export type CodexAppServerConnectionOptions = {
  requestTimeoutMs?: number;
  onServerRequest?: JsonRpcServerRequestHandler;
  onProtocolError?: (error: Error) => void;
};

export type CodexStartThreadInput = {
  cwd: string;
  model?: string;
  ephemeral?: boolean;
};

export type CodexResumeThreadInput = {
  threadId: string;
  cwd: string;
  model?: string;
  excludeTurns?: boolean;
  initialTurnsPage?: {
    limit?: number;
    sortDirection?: "asc" | "desc";
    itemsView?: "summary" | "full";
  };
};

export type CodexStartTurnInput = {
  threadId: string;
  input: readonly { type: "text"; text: string }[];
  model?: string;
  clientUserMessageId?: string;
};

export type CodexSteerTurnInput = {
  threadId: string;
  expectedTurnId: string;
  input: readonly { type: "text"; text: string }[];
  clientUserMessageId?: string;
};

export type CodexInterruptTurnInput = {
  threadId: string;
  turnId: string;
};

export type CodexSetGoalInput = {
  threadId: string;
  objective?: string;
  status?: string;
  tokenBudget?: number | null;
};

export type CodexAppServerConnection = {
  endpoint: CodexAppServerEndpoint;
  client: JsonRpcWebSocketUnixClient;
  initialize(): Promise<unknown>;
  request<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<TResult>;
  notify(method: string, params?: unknown): Promise<void>;
  subscribeNotifications(
    filter: JsonRpcNotificationFilter,
    handler: (notification: JsonRpcNotification) => void | Promise<void>,
    options?: { replayBuffered?: boolean },
  ): JsonRpcNotificationSubscription;
  startThread(input: CodexStartThreadInput, options?: { timeoutMs?: number }): Promise<unknown>;
  resumeThread(input: CodexResumeThreadInput, options?: { timeoutMs?: number }): Promise<unknown>;
  readThread(
    threadId: string,
    options?: { timeoutMs?: number; includeTurns?: boolean },
  ): Promise<unknown>;
  unsubscribeThread(threadId: string, options?: { timeoutMs?: number }): Promise<unknown>;
  startTurn(input: CodexStartTurnInput, options?: { timeoutMs?: number }): Promise<unknown>;
  steerTurn(input: CodexSteerTurnInput, options?: { timeoutMs?: number }): Promise<unknown>;
  interruptTurn(input: CodexInterruptTurnInput, options?: { timeoutMs?: number }): Promise<unknown>;
  getGoal(threadId: string, options?: { timeoutMs?: number }): Promise<unknown>;
  setGoal(input: CodexSetGoalInput, options?: { timeoutMs?: number }): Promise<unknown>;
  clearGoal(threadId: string, options?: { timeoutMs?: number }): Promise<unknown>;
  close(): Promise<void>;
};

export class CodexAppServerControllerError extends Error {
  readonly reason:
    | "unsupported"
    | "backend_failed"
    | "invalid_backend_record"
    | "invalid_daemon_output"
    | "connect_failed";
  readonly details?: unknown;

  constructor(
    reason: CodexAppServerControllerError["reason"],
    message: string,
    details: { details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: details.cause });
    this.name = "CodexAppServerControllerError";
    this.reason = reason;
    this.details = details.details;
  }
}

export async function ensureCodexAppServer(
  input: EnsureCodexAppServerInput = {},
): Promise<CodexAppServerEndpoint> {
  if (input.socketPath) {
    return { socketPath: input.socketPath, managed: false };
  }
  if (process.platform === "win32") {
    throw new CodexAppServerControllerError(
      "unsupported",
      "Codex app-server Unix socket backend is only supported on Unix platforms.",
    );
  }

  const paths = managedBackendPaths(input);
  const timeoutMs = input.timeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS;
  const existing = await healthyManagedBackend(paths, timeoutMs);
  if (existing) {
    return endpointFromBackendRecord(existing);
  }

  return await withBackendStartupLock(paths, timeoutMs, async () => {
    const lockedExisting = await healthyManagedBackend(paths, timeoutMs);
    if (lockedExisting) {
      return endpointFromBackendRecord(lockedExisting);
    }

    await cleanupStaleBackend(paths);
    return await startManagedCodexAppServerBackend(input, paths, timeoutMs);
  });
}

export async function connectCodexAppServer(
  endpoint: CodexAppServerEndpoint,
  options: CodexAppServerConnectionOptions = {},
): Promise<CodexAppServerConnection> {
  const client = startJsonRpcWebSocketUnixClient({
    socketPath: endpoint.socketPath,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ...(options.onServerRequest ? { onServerRequest: options.onServerRequest } : {}),
    ...(options.onProtocolError ? { onProtocolError: options.onProtocolError } : {}),
  });
  const connection = makeConnection(endpoint, client);
  try {
    await connection.initialize();
    return connection;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new CodexAppServerControllerError(
      "connect_failed",
      "Failed to initialize Codex app-server connection.",
      { cause: error },
    );
  }
}

export async function withCodexAppServerConnection<T>(
  input: EnsureCodexAppServerInput & CodexAppServerConnectionOptions,
  fn: (connection: CodexAppServerConnection) => Promise<T>,
): Promise<T> {
  const endpoint = await ensureCodexAppServer(input);
  const connection = await connectCodexAppServer(endpoint, input);
  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}

export function parseCodexDaemonOutput(stdout: string): CodexAppServerEndpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new CodexAppServerControllerError(
      "invalid_daemon_output",
      "Codex app-server daemon did not return JSON.",
      { cause: error, details: { stdout } },
    );
  }
  return parseCodexDaemonObject(parsed);
}

type ManagedBackendPaths = {
  orchestratorDir: string;
  providerDir: string;
  metadataPath: string;
  lockPath: string;
  socketDir: string;
  socketPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
};

function managedBackendPaths(input: EnsureCodexAppServerInput): ManagedBackendPaths {
  const orchestratorDir = getOrchestratorDir({ orchestratorDir: input.orchestratorDir });
  const backendHash = createHash("sha256")
    .update(resolve(orchestratorDir))
    .digest("hex")
    .slice(0, 16);
  const providerDir = join(orchestratorDir, "providers", "codex-app-server");
  const socketDir = join(tmpdir(), `orchestrator-codex-${backendHash}`);
  return {
    orchestratorDir,
    providerDir,
    metadataPath: join(providerDir, "backend.json"),
    lockPath: join(providerDir, "startup.lock"),
    socketDir,
    socketPath: join(socketDir, "app-server.sock"),
    stdoutLogPath: join(providerDir, "app-server.stdout.log"),
    stderrLogPath: join(providerDir, "app-server.stderr.log"),
  };
}

async function healthyManagedBackend(
  paths: ManagedBackendPaths,
  timeoutMs: number,
): Promise<CodexAppServerBackendRecord | undefined> {
  const record = await readBackendRecord(paths.metadataPath);
  if (!record) {
    return undefined;
  }
  if (!isPidAlive(record.pid)) {
    return undefined;
  }
  if (
    record.socketPath !== paths.socketPath ||
    !(await socketInitializes(record.socketPath, Math.min(timeoutMs, BACKEND_HEALTH_TIMEOUT_MS)))
  ) {
    return undefined;
  }
  return record;
}

async function withBackendStartupLock<T>(
  paths: ManagedBackendPaths,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(paths.providerDir, { recursive: true });
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await mkdir(paths.lockPath);
      try {
        return await fn();
      } finally {
        await rm(paths.lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      await removeStaleLock(paths.lockPath);
      await delay(BACKEND_LOCK_POLL_MS);
    }
  }

  throw new CodexAppServerControllerError(
    "backend_failed",
    `Timed out waiting for Codex app-server startup lock at ${paths.lockPath}.`,
    { details: { lockPath: paths.lockPath, timeoutMs } },
  );
}

async function startManagedCodexAppServerBackend(
  input: EnsureCodexAppServerInput,
  paths: ManagedBackendPaths,
  timeoutMs: number,
): Promise<CodexAppServerEndpoint> {
  const executable = input.executable ?? "codex";
  await mkdir(paths.providerDir, { recursive: true });
  await mkdir(paths.socketDir, { recursive: true });
  await rm(paths.socketPath, { force: true });

  const stdoutFd = openSync(paths.stdoutLogPath, "a");
  const stderrFd = openSync(paths.stderrLogPath, "a");
  let child: ChildProcess | undefined;
  try {
    child = spawn(executable, ["app-server", "--listen", `unix://${paths.socketPath}`], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } catch (error) {
    throw backendStartError(paths, executable, error);
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  if (!child.pid) {
    throw backendStartError(paths, executable, new Error("Spawned process did not expose a pid."));
  }

  let startupFailure: Error | undefined;
  const failStartup = (error: Error): void => {
    startupFailure = error;
  };
  const failExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    startupFailure = new Error(
      `Codex app-server exited before becoming ready: code=${code ?? "null"} signal=${signal ?? "null"}.`,
    );
  };
  child.once("error", failStartup);
  child.once("exit", failExit);
  child.unref();

  try {
    await waitForManagedBackendReady(paths.socketPath, timeoutMs, () => startupFailure);
  } catch (error) {
    await terminatePid(child.pid);
    throw backendStartError(paths, executable, error);
  } finally {
    child.off("error", failStartup);
    child.off("exit", failExit);
  }

  const startedAt = now();
  const processIdentity = await captureProcessIdentity(child.pid);
  const record: CodexAppServerBackendRecord = {
    schemaVersion: 1,
    executable,
    socketPath: paths.socketPath,
    pid: child.pid,
    ...(processIdentity?.startedAtMs !== undefined
      ? { pidStartedAtMs: processIdentity.startedAtMs }
      : {}),
    startedAt,
    updatedAt: startedAt,
    stdoutLogPath: paths.stdoutLogPath,
    stderrLogPath: paths.stderrLogPath,
  };
  await writeBackendRecord(paths.metadataPath, record);
  return endpointFromBackendRecord(record);
}

async function waitForManagedBackendReady(
  socketPath: string,
  timeoutMs: number,
  startupFailure: () => Error | undefined,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const failure = startupFailure();
    if (failure) {
      throw failure;
    }
    if (await socketInitializes(socketPath, BACKEND_HEALTH_TIMEOUT_MS)) {
      return;
    }
    await delay(BACKEND_READY_POLL_MS);
  }
  throw new Error(`Timed out waiting for Codex app-server at ${socketPath}.`);
}

async function socketInitializes(socketPath: string, timeoutMs: number): Promise<boolean> {
  try {
    const connection = await connectCodexAppServer({ socketPath }, { requestTimeoutMs: timeoutMs });
    await connection.close();
    return true;
  } catch {
    return false;
  }
}

async function cleanupStaleBackend(paths: ManagedBackendPaths): Promise<void> {
  const record = await readBackendRecord(paths.metadataPath);
  if (record && (await backendRecordOwnsLivePid(record))) {
    await terminatePid(record.pid);
  }
  await Promise.all([
    rm(paths.socketPath, { force: true }),
    rm(paths.metadataPath, { force: true }),
  ]);
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs > BACKEND_LOCK_STALE_MS) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function readBackendRecord(
  metadataPath: string,
): Promise<CodexAppServerBackendRecord | undefined> {
  try {
    const raw = await readFile(metadataPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parseBackendRecord(parsed);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function parseBackendRecord(value: unknown): CodexAppServerBackendRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const schemaVersion = value.schemaVersion;
  const executable = stringValue(value.executable);
  const socketPath = stringValue(value.socketPath);
  const pid = numberValue(value.pid);
  const pidStartedAtMs = numberValue(value.pidStartedAtMs);
  const startedAt = stringValue(value.startedAt);
  const updatedAt = stringValue(value.updatedAt);
  const stdoutLogPath = stringValue(value.stdoutLogPath);
  const stderrLogPath = stringValue(value.stderrLogPath);
  if (
    schemaVersion !== 1 ||
    !executable ||
    !socketPath ||
    !pid ||
    !startedAt ||
    !updatedAt ||
    !stdoutLogPath ||
    !stderrLogPath
  ) {
    return undefined;
  }
  return {
    schemaVersion,
    executable,
    socketPath,
    pid,
    ...(pidStartedAtMs !== undefined ? { pidStartedAtMs } : {}),
    startedAt,
    updatedAt,
    stdoutLogPath,
    stderrLogPath,
  };
}

async function backendRecordOwnsLivePid(record: CodexAppServerBackendRecord): Promise<boolean> {
  if (record.pidStartedAtMs === undefined) {
    return false;
  }
  const current = await captureProcessIdentity(record.pid);
  return (
    current?.startedAtMs !== undefined &&
    Math.abs(current.startedAtMs - record.pidStartedAtMs) < 1000
  );
}

async function writeBackendRecord(
  metadataPath: string,
  record: CodexAppServerBackendRecord,
): Promise<void> {
  await mkdir(dirname(metadataPath), { recursive: true });
  const tempPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tempPath, metadataPath);
}

function endpointFromBackendRecord(record: CodexAppServerBackendRecord): CodexAppServerEndpoint {
  return {
    socketPath: record.socketPath,
    pid: record.pid,
    managed: true,
    startedAt: record.startedAt,
    stdoutLogPath: record.stdoutLogPath,
    stderrLogPath: record.stderrLogPath,
    backend: "orchestrator",
  };
}

function backendStartError(
  paths: ManagedBackendPaths,
  executable: string,
  cause: unknown,
): CodexAppServerControllerError {
  return new CodexAppServerControllerError(
    "backend_failed",
    `Failed to start Codex app-server at ${paths.socketPath}. Inspect ${paths.stderrLogPath}.`,
    {
      cause,
      details: {
        executable,
        socketPath: paths.socketPath,
        stdoutLogPath: paths.stdoutLogPath,
        stderrLogPath: paths.stderrLogPath,
        cause: errorMessage(cause),
      },
    },
  );
}

async function terminatePid(pid: number): Promise<void> {
  if (!isPidAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (!isPidAlive(pid)) {
      return;
    }
    await delay(50);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
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
    return isNodeError(error) && error.code === "EPERM";
  }
}

function parseCodexDaemonObject(value: unknown): CodexAppServerEndpoint {
  if (!isRecord(value)) {
    throw new CodexAppServerControllerError(
      "invalid_daemon_output",
      "Codex app-server daemon output must be a JSON object.",
      { details: value },
    );
  }
  const socketPath = stringValue(value.socketPath) ?? stringValue(value.socket_path);
  if (!socketPath) {
    throw new CodexAppServerControllerError(
      "invalid_daemon_output",
      "Codex app-server daemon output did not include socketPath.",
      { details: value },
    );
  }

  return {
    socketPath,
    ...optionalString("status", value.status),
    ...optionalString("backend", value.backend),
    ...optionalString("managedCodexPath", value.managedCodexPath ?? value.managed_codex_path),
    ...optionalString(
      "managedCodexVersion",
      value.managedCodexVersion ?? value.managed_codex_version,
    ),
    ...optionalString("cliVersion", value.cliVersion ?? value.cli_version),
    ...optionalString("appServerVersion", value.appServerVersion ?? value.app_server_version),
  };
}

function makeConnection(
  endpoint: CodexAppServerEndpoint,
  client: JsonRpcWebSocketUnixClient,
): CodexAppServerConnection {
  return {
    endpoint,
    client,
    async initialize() {
      const response = await client.request("initialize", {
        clientInfo: {
          name: "orchestrator",
          title: "Orchestrator",
          version: "0.0.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      await client.notify("initialized");
      return response;
    },
    async request(method, params, options) {
      return await client.request(method, params, options);
    },
    async notify(method, params) {
      await client.notify(method, params);
    },
    subscribeNotifications(filter, handler, options) {
      return client.subscribeNotifications(filter, handler, options);
    },
    async startThread(input, options) {
      return await client.request(
        "thread/start",
        {
          cwd: input.cwd,
          ...(input.model ? { model: input.model } : {}),
          ...(input.ephemeral !== undefined ? { ephemeral: input.ephemeral } : {}),
        },
        options,
      );
    },
    async resumeThread(input, options) {
      return await client.request(
        "thread/resume",
        {
          threadId: input.threadId,
          cwd: input.cwd,
          ...(input.model ? { model: input.model } : {}),
          ...(input.excludeTurns !== undefined ? { excludeTurns: input.excludeTurns } : {}),
          ...(input.initialTurnsPage ? { initialTurnsPage: input.initialTurnsPage } : {}),
        },
        options,
      );
    },
    async readThread(threadId, options) {
      return await client.request(
        "thread/read",
        {
          threadId,
          ...(options?.includeTurns !== undefined ? { includeTurns: options.includeTurns } : {}),
        },
        options,
      );
    },
    async unsubscribeThread(threadId, options) {
      return await client.request("thread/unsubscribe", { threadId }, options);
    },
    async startTurn(input, options) {
      return await client.request(
        "turn/start",
        {
          threadId: input.threadId,
          input: input.input,
          ...(input.model ? { model: input.model } : {}),
          ...(input.clientUserMessageId ? { clientUserMessageId: input.clientUserMessageId } : {}),
        },
        options,
      );
    },
    async steerTurn(input, options) {
      return await client.request(
        "turn/steer",
        {
          threadId: input.threadId,
          expectedTurnId: input.expectedTurnId,
          input: input.input,
          ...(input.clientUserMessageId ? { clientUserMessageId: input.clientUserMessageId } : {}),
        },
        options,
      );
    },
    async interruptTurn(input, options) {
      return await client.request(
        "turn/interrupt",
        {
          threadId: input.threadId,
          turnId: input.turnId,
        },
        options,
      );
    },
    async getGoal(threadId, options) {
      return await client.request("thread/goal/get", { threadId }, options);
    },
    async setGoal(input, options) {
      return await client.request(
        "thread/goal/set",
        {
          threadId: input.threadId,
          ...(input.objective ? { objective: input.objective } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(Object.prototype.hasOwnProperty.call(input, "tokenBudget")
            ? { tokenBudget: input.tokenBudget ?? null }
            : {}),
        },
        options,
      );
    },
    async clearGoal(threadId, options) {
      return await client.request("thread/goal/clear", { threadId }, options);
    },
    async close() {
      await client.close();
    },
  };
}

function optionalString(key: string, value: unknown): Record<string, string> {
  return typeof value === "string" && value ? { [key]: value } : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function now(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
