import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
  AgentTaskRecord,
  TaskHeartbeat,
  TaskLocation,
  TaskEvent,
  TaskPaths,
  TaskStatus,
  TaskStoreOptions,
} from "./types.ts";
import { isTerminalTaskStatus } from "./types.ts";

export type TaskLookupErrorReason = "empty" | "invalid" | "not_found" | "ambiguous";

export class TaskLookupError extends Error {
  readonly reason: TaskLookupErrorReason;
  readonly input: string;
  readonly matches: readonly string[];
  readonly hint: string;

  constructor(input: string, reason: TaskLookupErrorReason, matches: readonly string[] = []) {
    super(taskLookupMessage(input, reason, matches));
    this.name = "TaskLookupError";
    this.reason = reason;
    this.input = input;
    this.matches = matches;
    this.hint = taskLookupHint(reason);
  }
}

export function getDefaultOrchestratorDir(): string {
  return resolve(process.env.ORCHESTRATOR_HOME || join(homedir(), ".orchestrator"));
}

export function getOrchestratorDir(options: Pick<TaskStoreOptions, "orchestratorDir">): string {
  return resolve(options.orchestratorDir ?? getDefaultOrchestratorDir());
}

export function getTaskRoot(options: TaskStoreOptions): string {
  return join(getOrchestratorDir(options), "tasks");
}

export function getTaskPaths(options: TaskStoreOptions, taskId: string): TaskPaths {
  const taskDir = join(getTaskRoot(options), taskId);

  return {
    taskDir,
    taskJson: join(taskDir, "task.json"),
    heartbeatJson: join(taskDir, "heartbeat.json"),
    stdoutLog: join(taskDir, "stdout.log"),
    stderrLog: join(taskDir, "stderr.log"),
    combinedLog: join(taskDir, "combined.log"),
    eventsJsonl: join(taskDir, "events.jsonl"),
    transcriptJsonl: join(taskDir, "transcript.jsonl"),
    resultMd: join(taskDir, "result.md"),
    artifactsDir: join(taskDir, "artifacts"),
  };
}

export async function initializeTaskFiles(task: AgentTaskRecord): Promise<void> {
  await mkdir(task.paths.artifactsDir, { recursive: true });
  await Promise.all([
    writeTaskRecord(task),
    writeFile(task.paths.stdoutLog, ""),
    writeFile(task.paths.stderrLog, ""),
    writeFile(task.paths.combinedLog, ""),
    writeFile(task.paths.eventsJsonl, ""),
    writeFile(task.paths.transcriptJsonl, ""),
    writeFile(task.paths.resultMd, ""),
  ]);
}

export async function writeTaskRecord(task: AgentTaskRecord): Promise<void> {
  const tempPath = `${task.paths.taskJson}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(task, null, 2)}\n`);
  await rename(tempPath, task.paths.taskJson);
}

export async function readTaskRecord(
  options: TaskStoreOptions,
  taskId: string,
): Promise<AgentTaskRecord> {
  return await readResolvedTaskRecord(options, await resolveTaskId(options, taskId));
}

export async function resolveTaskId(options: TaskStoreOptions, input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new TaskLookupError(input, "empty");
  }
  if (isPathLikeTaskId(trimmed)) {
    throw new TaskLookupError(trimmed, "invalid");
  }

  if (await taskRecordExists(options, trimmed)) {
    return trimmed;
  }

  let entries: string[];
  try {
    entries = await readdir(getTaskRoot(options));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new TaskLookupError(trimmed, "not_found");
    }
    throw error;
  }

  const candidates = entries.filter((entry) => entry.startsWith(trimmed)).sort();
  const matches = (
    await Promise.all(
      candidates.map(async (candidate) =>
        (await taskRecordExists(options, candidate)) ? candidate : undefined,
      ),
    )
  ).filter((candidate): candidate is string => Boolean(candidate));

  if (matches.length === 1) {
    return matches[0];
  }

  throw new TaskLookupError(trimmed, matches.length === 0 ? "not_found" : "ambiguous", matches);
}

async function readResolvedTaskRecord(
  options: TaskStoreOptions,
  taskId: string,
): Promise<AgentTaskRecord> {
  const paths = getTaskPaths(options, taskId);
  const raw = await readFile(paths.taskJson, "utf8");
  const task = JSON.parse(raw) as AgentTaskRecord;
  return {
    ...task,
    storeScope: task.storeScope ?? (options.orchestratorDir ? "custom" : "machine"),
    location: task.location ?? inferTaskLocation(task, options),
    paths: {
      ...paths,
      ...task.paths,
      heartbeatJson: task.paths.heartbeatJson ?? paths.heartbeatJson,
      transcriptJsonl: task.paths.transcriptJsonl ?? paths.transcriptJsonl,
    },
  };
}

export async function writeTaskHeartbeat(
  paths: Pick<TaskPaths, "heartbeatJson">,
  heartbeat: TaskHeartbeat,
): Promise<void> {
  const tempPath = `${paths.heartbeatJson}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(heartbeat, null, 2)}\n`);
  await rename(tempPath, paths.heartbeatJson);
}

export async function readTaskHeartbeat(
  paths: Pick<TaskPaths, "heartbeatJson">,
): Promise<TaskHeartbeat | undefined> {
  try {
    const raw = await readFile(paths.heartbeatJson, "utf8");
    const value = JSON.parse(raw) as unknown;
    return isTaskHeartbeat(value) ? value : undefined;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function localTaskLocation(workspaceRoot: string, cwd: string): TaskLocation {
  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedCwd = resolve(cwd);
  return {
    kind: "local",
    workspaceRoot: resolvedWorkspace,
    workspaceName: basename(resolvedWorkspace),
    cwd: resolvedCwd,
  };
}

export function taskWorkspaceRoot(
  task: Pick<AgentTaskRecord, "location" | "cwd">,
  fallbackWorkspaceRoot: string,
): string {
  return task.location?.kind === "local" && task.location.workspaceRoot
    ? resolve(task.location.workspaceRoot)
    : resolve(fallbackWorkspaceRoot);
}

export function taskCwd(task: Pick<AgentTaskRecord, "location" | "cwd">): string {
  return task.location?.kind === "local" && task.location.cwd
    ? resolve(task.location.cwd)
    : resolve(task.cwd);
}

function inferTaskLocation(task: AgentTaskRecord, options: TaskStoreOptions): TaskLocation {
  return localTaskLocation(options.workspaceRoot, task.cwd);
}

export async function listTasks(
  options: TaskStoreOptions & { status?: TaskStatus },
): Promise<AgentTaskRecord[]> {
  const taskRoot = getTaskRoot(options);

  let entries: string[];
  try {
    entries = await readdir(taskRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const tasks = await Promise.all(
    entries.map(async (entry) => {
      try {
        return await readResolvedTaskRecord(options, entry);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    }),
  );

  return tasks
    .filter((task): task is AgentTaskRecord => Boolean(task))
    .filter((task) => (options.status ? task.status === options.status : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listTaskIds(options: TaskStoreOptions): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(getTaskRoot(options));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const taskIds = await Promise.all(
    entries.map(async (entry) => ((await taskRecordExists(options, entry)) ? entry : undefined)),
  );
  return taskIds.filter((taskId): taskId is string => Boolean(taskId)).sort();
}

export async function appendTaskEvent(paths: TaskPaths, event: TaskEvent): Promise<void> {
  await appendFile(paths.eventsJsonl, `${JSON.stringify(event)}\n`);
}

export async function appendSequencedTaskEvent(
  paths: TaskPaths,
  taskId: string,
  type: TaskEvent["type"],
  data: Record<string, unknown> = {},
): Promise<TaskEvent> {
  return withEventLock(paths, async () => {
    const event = {
      seq: await readNextEventSeq(paths),
      taskId,
      ts: new Date().toISOString(),
      type,
      data,
    };

    await appendTaskEvent(paths, event);
    return event;
  });
}

export async function updateTaskStatus(
  task: AgentTaskRecord,
  status: TaskStatus,
  updates: Partial<
    Pick<
      AgentTaskRecord,
      | "startedAt"
      | "finishedAt"
      | "exitCode"
      | "pid"
      | "error"
      | "usage"
      | "outputCapture"
      | "stopRequestedAt"
      | "stopReason"
      | "stopSignal"
      | "supervision"
      | "provider"
    >
  > = {},
): Promise<AgentTaskRecord> {
  const base = await readLatestTaskRecordForUpdate(task);
  const nextStatus =
    isTerminalTaskStatus(base.status) && !isTerminalTaskStatus(status) ? base.status : status;
  const updated = {
    ...base,
    ...updates,
    status: nextStatus,
  };

  await writeTaskRecord(updated);
  return updated;
}

async function readLatestTaskRecordForUpdate(task: AgentTaskRecord): Promise<AgentTaskRecord> {
  try {
    const raw = await readFile(task.paths.taskJson, "utf8");
    const latest = JSON.parse(raw) as AgentTaskRecord;
    if (latest.taskId !== task.taskId) {
      return task;
    }
    return {
      ...task,
      ...latest,
      paths: {
        ...task.paths,
        ...latest.paths,
        heartbeatJson: latest.paths.heartbeatJson ?? task.paths.heartbeatJson,
        transcriptJsonl: latest.paths.transcriptJsonl ?? task.paths.transcriptJsonl,
      },
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return task;
    }
    throw error;
  }
}

function isTaskHeartbeat(value: unknown): value is TaskHeartbeat {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.taskId === "string" &&
    typeof record.supervisorPid === "number" &&
    typeof record.lastHeartbeatAt === "string" &&
    (record.childPid === undefined || typeof record.childPid === "number") &&
    (record.processGroupId === undefined || typeof record.processGroupId === "number")
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function taskRecordExists(options: TaskStoreOptions, taskId: string): Promise<boolean> {
  try {
    await access(getTaskPaths(options, taskId).taskJson);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function taskLookupMessage(
  input: string,
  reason: TaskLookupErrorReason,
  matches: readonly string[],
): string {
  if (reason === "empty") {
    return "Task id must not be empty.";
  }

  if (reason === "ambiguous") {
    return `Task id "${input}" is ambiguous. Matches:\n${matches
      .map((match) => `  ${match}`)
      .join("\n")}`;
  }

  if (reason === "invalid") {
    return `Task id "${input}" is invalid. Use a task id or unique prefix, not a path.`;
  }

  return `Task id "${input}" did not match any task.`;
}

function taskLookupHint(reason: TaskLookupErrorReason): string {
  if (reason === "ambiguous") {
    return "Use one of error.matches exactly. Run orchestrator ps --json --compact --brief for recent task ids, ps --json --compact --active --brief for active task ids, or orchestrator ps --all --json --compact for history.";
  }

  if (reason === "not_found") {
    return "Run orchestrator ps --json --compact --brief for recent tasks, ps --json --compact --active --brief for active tasks, or orchestrator ps --all --json --compact for history.";
  }

  if (reason === "invalid") {
    return "Pass a task id or unique task id prefix, not a task directory or path.";
  }

  return "Pass a task id from launch --json --compact, run --background --json --compact, or ps --json --compact.";
}

function isPathLikeTaskId(value: string): boolean {
  return value === "." || value === ".." || value.includes("/") || value.includes("\\");
}

async function withEventLock<T>(paths: TaskPaths, fn: () => Promise<T>): Promise<T> {
  const lockDir = `${paths.eventsJsonl}.lock`;
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - startedAt > 5_000) {
        throw new Error(`Timed out waiting for event lock: ${lockDir}`, { cause: error });
      }
      await delay(10);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function readNextEventSeq(paths: TaskPaths): Promise<number> {
  const raw = await readFile(paths.eventsJsonl, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) {
    return 1;
  }

  const lines = trimmed.split("\n");
  const lastLine = lines[lines.length - 1];
  const lastEvent = JSON.parse(lastLine ?? "{}") as Pick<TaskEvent, "seq">;
  return lastEvent.seq + 1;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
