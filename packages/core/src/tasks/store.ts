import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentTaskRecord,
  TaskEvent,
  TaskPaths,
  TaskStatus,
  TaskStoreOptions,
} from "./types.ts";

export function getTaskRoot(options: TaskStoreOptions): string {
  return join(options.orchestratorDir ?? join(options.workspaceRoot, ".orchestrator"), "tasks");
}

export function getTaskPaths(options: TaskStoreOptions, taskId: string): TaskPaths {
  const taskDir = join(getTaskRoot(options), taskId);

  return {
    taskDir,
    taskJson: join(taskDir, "task.json"),
    stdoutLog: join(taskDir, "stdout.log"),
    stderrLog: join(taskDir, "stderr.log"),
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
  const paths = getTaskPaths(options, taskId);
  const raw = await readFile(paths.taskJson, "utf8");
  const task = JSON.parse(raw) as AgentTaskRecord;
  return {
    ...task,
    paths: {
      ...paths,
      ...task.paths,
      transcriptJsonl: task.paths.transcriptJsonl ?? paths.transcriptJsonl,
    },
  };
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
        return await readTaskRecord(options, entry);
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
    Pick<AgentTaskRecord, "startedAt" | "finishedAt" | "exitCode" | "pid" | "error" | "usage">
  > = {},
): Promise<AgentTaskRecord> {
  const updated = {
    ...task,
    ...updates,
    status,
  };

  await writeTaskRecord(updated);
  return updated;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
