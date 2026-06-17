import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import type { AgentLaunchPlan } from "../runtime/index.ts";
import type {
  AgentTaskRecord,
  InterruptTaskInput,
  LaunchTaskHandle,
  LaunchTaskInput,
  ReadTaskOutputInput,
  TaskEvent,
} from "./types.ts";
import {
  appendSequencedTaskEvent,
  getTaskPaths,
  initializeTaskFiles,
  readTaskRecord,
  updateTaskStatus,
} from "./store.ts";
import { createRuntimeOutputAdapter } from "./output-adapters.ts";

type RunningTask = {
  child: ChildProcessWithoutNullStreams;
  appendEvent: (type: TaskEvent["type"], data?: Record<string, unknown>) => Promise<void>;
  cancelRequested: boolean;
  cancelReason?: string;
  cancelSignal: NodeJS.Signals;
};

const runningTasks = new Map<string, RunningTask>();

export { listTasks } from "./store.ts";

export class TaskSupervisorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskSupervisorError";
  }
}

export async function launchTask(input: LaunchTaskInput): Promise<LaunchTaskHandle> {
  validateLaunchPlan(input.plan);
  validateShellAllowlist(input.plan, input.allowedShellCommands);
  const taskName = normalizeTaskName(input.name);

  const taskId = input.taskId ?? randomUUID();
  const paths = getTaskPaths(input, taskId);
  const createdAt = now();
  const initialTask: AgentTaskRecord = {
    taskId,
    ...(taskName ? { name: taskName } : {}),
    runtime: input.plan.runtime,
    launchPlan: input.plan,
    cwd: input.plan.cwd,
    status: "queued",
    createdAt,
    paths,
  };

  await initializeTaskFiles(initialTask);

  let eventQueue: Promise<unknown> = Promise.resolve();
  const appendEvent = async (
    type: TaskEvent["type"],
    data: Record<string, unknown> = {},
  ): Promise<void> => {
    eventQueue = eventQueue.then(() => appendSequencedTaskEvent(paths, taskId, type, data));
    await eventQueue;
  };
  const outputAdapter = createRuntimeOutputAdapter({
    plan: input.plan,
    paths,
    appendEvent,
  });

  await appendEvent("queued", { runtime: input.plan.runtime });
  let task = await updateTaskStatus(initialTask, "starting");
  await appendEvent("starting", {
    executable: input.plan.executable,
    args: input.plan.args,
    cwd: input.plan.cwd,
  });

  const child = spawn(input.plan.executable, input.plan.args, {
    cwd: input.plan.cwd,
    env: { ...process.env, ...input.plan.env },
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let settled = false;
  const timeoutMs = input.timeoutMs;
  const maxOutputBytes = input.maxOutputBytes ?? 2_000_000;
  const pendingWrites: Promise<unknown>[] = [];
  let stdoutQueue: Promise<unknown> = Promise.resolve();
  let stderrQueue: Promise<unknown> = Promise.resolve();
  const runningTask: RunningTask = {
    child,
    appendEvent,
    cancelRequested: false,
    cancelSignal: "SIGTERM",
  };
  runningTasks.set(taskId, runningTask);

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    const currentBytes = stdoutBytes;
    const write = stdoutQueue.then(async () => {
      await appendBoundedOutput({
        path: paths.stdoutLog,
        chunk,
        currentBytes,
        maxBytes: maxOutputBytes,
      });
      await appendEvent("stdout", { bytes: chunk.byteLength });
      await outputAdapter.onStdoutChunk(chunk);
    });
    stdoutQueue = write.catch(() => {});
    pendingWrites.push(write);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    const currentBytes = stderrBytes;
    const write = stderrQueue.then(async () => {
      await appendBoundedOutput({
        path: paths.stderrLog,
        chunk,
        currentBytes,
        maxBytes: maxOutputBytes,
      });
      await appendEvent("stderr", { bytes: chunk.byteLength });
      await outputAdapter.onStderrChunk(chunk);
    });
    stderrQueue = write.catch(() => {});
    pendingWrites.push(write);
  });

  const completed = new Promise<AgentTaskRecord>((resolve) => {
    child.on("error", (error) => {
      void (async () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        await Promise.all(pendingWrites);
        await outputAdapter.finalize();
        await eventQueue;
        runningTasks.delete(taskId);
        const failed = await updateTaskStatus(task, "failed", {
          finishedAt: now(),
          exitCode: null,
          error: error.message,
        });
        await appendEvent("failed", { error: error.message });
        resolve(failed);
      })();
    });

    child.on("close", (code, signal) => {
      void (async () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        runningTasks.delete(taskId);
        await Promise.all(pendingWrites);
        const adapterResult = await outputAdapter.finalize();
        await eventQueue;

        const current = await readTaskRecord(input, taskId);
        const stdout = await readFile(paths.stdoutLog, "utf8");
        const result = adapterResult.resultText ?? stdout;
        await writeFile(paths.resultMd, result);
        await appendEvent("result", { path: paths.resultMd, bytes: Buffer.byteLength(result) });

        const finalStatus =
          current.status === "cancelled" || runningTask.cancelRequested
            ? "cancelled"
            : timedOut
              ? "timed_out"
              : code === 0
                ? "succeeded"
                : "failed";
        const error = timedOut
          ? `Timed out after ${timeoutMs}ms.`
          : finalStatus === "cancelled"
            ? (current.error ?? runningTask.cancelReason)
            : signal
              ? `Process exited from signal ${signal}.`
              : undefined;

        const finished = await updateTaskStatus(current, finalStatus, {
          finishedAt: now(),
          exitCode: code,
          ...(error ? { error } : {}),
        });
        await appendEvent(finalStatus === "succeeded" ? "completed" : finalStatus, {
          exitCode: code,
          signal,
        });
        resolve(finished);
      })();
    });
  });

  child.once("spawn", () => {
    void (async () => {
      if (settled) {
        return;
      }

      const current = await readTaskRecord(input, taskId);
      if (current.status === "cancelled" || runningTask.cancelRequested) {
        killProcessGroup(child, runningTask.cancelSignal);
        return;
      }

      if (input.plan.stdin) {
        child.stdin.write(input.plan.stdin.input);
        if (input.plan.stdin.closeAfterWrite) {
          child.stdin.end();
        }
      } else {
        child.stdin.end();
      }

      const startedAt = now();
      task = await updateTaskStatus(current, "running", {
        startedAt,
        ...(child.pid ? { pid: child.pid } : {}),
      });
      if (runningTask.cancelRequested) {
        killProcessGroup(child, runningTask.cancelSignal);
        return;
      }

      await appendEvent("running", { pid: child.pid ?? null });

      timeout = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            killProcessGroup(child);
          }, timeoutMs)
        : undefined;
    })();
  });

  child.stdin.on("error", () => {
    // Spawn/kill races can close stdin before we write. The child error/close
    // handlers own the durable task status.
  });

  return {
    task,
    completed,
  };
}

export async function readTaskOutput(input: ReadTaskOutputInput): Promise<string> {
  const task = await readTaskRecord(input, input.taskId);
  const maxBytes = input.maxBytes ?? 200_000;
  return readTail(task.paths.resultMd, maxBytes);
}

export async function interruptTask(input: InterruptTaskInput): Promise<AgentTaskRecord> {
  const task = await readTaskRecord(input, input.taskId);
  const running = runningTasks.get(input.taskId);
  const reason = input.reason ?? "Interrupted.";
  const signal = input.signal ?? "SIGTERM";

  if (!running && isTerminalStatus(task.status)) {
    throw new TaskSupervisorError(`Task "${input.taskId}" is not running in this process.`);
  }

  if (running) {
    running.cancelRequested = true;
    running.cancelReason = reason;
    running.cancelSignal = signal;
  }

  const updated = await updateTaskStatus(task, "cancelled", {
    error: reason,
  });

  if (running) {
    await running.appendEvent("interrupt_requested", { reason });
  } else {
    await appendSequencedTaskEvent(task.paths, task.taskId, "interrupt_requested", { reason });
  }

  if (running) {
    killProcessGroup(running.child, signal);
  } else if (task.pid) {
    killPidGroup(task.pid, signal);
  }

  return updated;
}

function validateLaunchPlan(plan: AgentLaunchPlan): void {
  if (!plan.executable.trim()) {
    throw new TaskSupervisorError("Launch plan executable must not be empty.");
  }

  if (!plan.cwd.trim()) {
    throw new TaskSupervisorError("Launch plan cwd must not be empty.");
  }
}

function validateShellAllowlist(
  plan: AgentLaunchPlan,
  allowedShellCommands: readonly string[] | undefined,
): void {
  if (!plan.safety.requiresAllowlist) {
    return;
  }

  const command = plan.args.at(-1);
  if (!command || !allowedShellCommands?.includes(command)) {
    throw new TaskSupervisorError(
      `Runtime "${plan.runtime}" requires an allowlisted shell command.`,
    );
  }
}

function normalizeTaskName(name: string | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }

  const normalized = name.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new TaskSupervisorError("Task name must not be empty.");
  }

  return normalized;
}

function killProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!child.pid) {
    return;
  }

  killPidGroup(child.pid, signal);
}

function killPidGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch (error) {
    if (!isNoSuchProcess(error)) {
      throw error;
    }
  }
}

async function appendBoundedOutput(input: {
  path: string;
  chunk: Buffer;
  currentBytes: number;
  maxBytes: number;
}): Promise<void> {
  const previousBytes = input.currentBytes - input.chunk.byteLength;
  const remainingBytes = input.maxBytes - previousBytes;

  if (remainingBytes <= 0) {
    return;
  }

  await appendFile(input.path, input.chunk.subarray(0, remainingBytes));
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(path);
  const contents = await readFile(path);

  if (fileStat.size <= maxBytes) {
    return contents.toString("utf8");
  }

  return contents.subarray(contents.byteLength - maxBytes).toString("utf8");
}

function now(): string {
  return new Date().toISOString();
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function isTerminalStatus(status: AgentTaskRecord["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out"
  );
}
