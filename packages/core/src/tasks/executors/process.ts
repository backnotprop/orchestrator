import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { captureProcessIdentity } from "../observation.ts";
import { createRuntimeOutputAdapter } from "../output-adapters.ts";
import { readTaskRecord, updateTaskStatus, writeTaskHeartbeat } from "../store.ts";
import { isTaskStopRequested } from "../types.ts";
import type { AgentTaskRecord } from "../types.ts";
import { selectTaskUsage, usageWithUpdatedAt } from "../usage.ts";
import type { TaskExecutionContext, TaskExecutionHandle, TaskExecutor } from "./types.ts";

const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_STALE_AFTER_MS = 20_000;

export class ProcessTaskExecutor implements TaskExecutor {
  start(context: TaskExecutionContext): TaskExecutionHandle {
    return startProcessTask(context);
  }
}

function startProcessTask(context: TaskExecutionContext): TaskExecutionHandle {
  const { input, taskId, paths, maxOutputBytes, appendEvent } = context;
  let task = context.task;
  let eventQueue: Promise<unknown> = Promise.resolve();
  let taskRecordQueue: Promise<unknown> = Promise.resolve();
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let combinedBytes = 0;
  let stdoutCaptureTruncated = false;
  let stderrCaptureTruncated = false;
  let cancelRequested = false;
  let cancelReason: string | undefined;
  let cancelSignal: NodeJS.Signals = "SIGTERM";

  const queueEvent = async (
    type: Parameters<typeof appendEvent>[0],
    data: Record<string, unknown> = {},
  ) => {
    const write = eventQueue.then(() => appendEvent(type, data));
    eventQueue = write.catch(() => {});
    return await write;
  };

  const updateTaskUsage = async (usage: AgentTaskRecord["usage"]): Promise<void> => {
    if (!usage) {
      return;
    }

    const update = taskRecordQueue.then(async () => {
      const current = await readTaskRecord(input, taskId);
      const selected = selectTaskUsage(current.usage, usage);
      if (selected === current.usage) {
        return;
      }
      await updateTaskStatus(current, current.status, { usage: selected });
    });
    taskRecordQueue = update.catch(() => {});
    await update;
  };

  const outputCaptureSnapshot = (
    resultTruncated = false,
  ): NonNullable<AgentTaskRecord["outputCapture"]> => ({
    maxBytes: maxOutputBytes,
    stdoutBytes,
    stderrBytes,
    stdoutTruncated: stdoutBytes > maxOutputBytes,
    stderrTruncated: stderrBytes > maxOutputBytes,
    resultTruncated,
    updatedAt: now(),
  });

  const shouldPersistOutputCapture = (resultTruncated = false): boolean =>
    stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes || resultTruncated;

  const updateOutputCapture = async (): Promise<void> => {
    if (!shouldPersistOutputCapture()) {
      return;
    }

    const update = taskRecordQueue.then(async () => {
      const current = await readTaskRecord(input, taskId);
      await updateTaskStatus(current, current.status, {
        outputCapture: outputCaptureSnapshot(current.outputCapture?.resultTruncated ?? false),
      });
    });
    taskRecordQueue = update.catch(() => {});
    await update;
  };

  const outputAdapter = createRuntimeOutputAdapter({
    plan: input.plan,
    paths,
    appendEvent: queueEvent,
    onUsage: updateTaskUsage,
    onProvider: context.updateProvider,
  });

  const child = spawn(input.plan.executable, input.plan.args, {
    cwd: input.plan.cwd,
    env: { ...process.env, ...input.plan.env },
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let settled = false;
  const timeoutMs = input.timeoutMs;
  const pendingWrites: Promise<unknown>[] = [];
  let stdoutQueue: Promise<unknown> = Promise.resolve();
  let stderrQueue: Promise<unknown> = Promise.resolve();
  let combinedQueue: Promise<unknown> = Promise.resolve();

  const appendCombinedOutput = (chunk: Buffer): void => {
    combinedBytes += chunk.byteLength;
    const currentBytes = combinedBytes;
    const write = combinedQueue.then(() =>
      appendBoundedOutput({
        path: paths.combinedLog,
        chunk,
        currentBytes,
        maxBytes: maxOutputBytes,
      }),
    );
    combinedQueue = write.catch(() => {});
    pendingWrites.push(write);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    appendCombinedOutput(chunk);
    stdoutBytes += chunk.byteLength;
    const currentBytes = stdoutBytes;
    const streamTruncated = currentBytes > maxOutputBytes;
    const shouldUpdateCapture = streamTruncated && !stdoutCaptureTruncated;
    if (streamTruncated) {
      stdoutCaptureTruncated = true;
    }
    const write = stdoutQueue.then(async () => {
      await appendBoundedOutput({
        path: paths.stdoutLog,
        chunk,
        currentBytes,
        maxBytes: maxOutputBytes,
      });
      await queueEvent("stdout", {
        bytes: chunk.byteLength,
        ...(streamTruncated
          ? {
              truncated: true,
              maxBytes: maxOutputBytes,
              storedBytes: Math.min(currentBytes, maxOutputBytes),
            }
          : {}),
      });
      if (shouldUpdateCapture) {
        await updateOutputCapture();
      }
      await outputAdapter.onStdoutChunk(chunk);
    });
    stdoutQueue = write.catch(() => {});
    pendingWrites.push(write);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    appendCombinedOutput(chunk);
    stderrBytes += chunk.byteLength;
    const currentBytes = stderrBytes;
    const streamTruncated = currentBytes > maxOutputBytes;
    const shouldUpdateCapture = streamTruncated && !stderrCaptureTruncated;
    if (streamTruncated) {
      stderrCaptureTruncated = true;
    }
    const write = stderrQueue.then(async () => {
      await appendBoundedOutput({
        path: paths.stderrLog,
        chunk,
        currentBytes,
        maxBytes: maxOutputBytes,
      });
      await queueEvent("stderr", {
        bytes: chunk.byteLength,
        ...(streamTruncated
          ? {
              truncated: true,
              maxBytes: maxOutputBytes,
              storedBytes: Math.min(currentBytes, maxOutputBytes),
            }
          : {}),
      });
      if (shouldUpdateCapture) {
        await updateOutputCapture();
      }
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
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        await Promise.all(pendingWrites);
        await outputAdapter.finalize();
        await eventQueue;
        await taskRecordQueue;
        const failed = await updateTaskStatus(task, "failed", {
          finishedAt: now(),
          exitCode: null,
          error: error.message,
        });
        await queueEvent("failed", { error: error.message });
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
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        await Promise.all(pendingWrites);
        const adapterResult = await outputAdapter.finalize();
        await eventQueue;
        await taskRecordQueue;

        const current = await readTaskRecord(input, taskId);
        const stdout = await readFile(paths.stdoutLog, "utf8");
        const fallbackToStdout = adapterResult.fallbackToStdout ?? true;
        const resultTruncated =
          adapterResult.resultText === undefined &&
          fallbackToStdout &&
          stdoutBytes > maxOutputBytes;
        const result = adapterResult.resultText ?? (fallbackToStdout ? stdout : "");
        await writeFile(paths.resultMd, result);
        await queueEvent("result", { path: paths.resultMd, bytes: Buffer.byteLength(result) });

        const finalStatus =
          isTaskStopRequested(current) || cancelRequested
            ? "cancelled"
            : timedOut
              ? "timed_out"
              : code === 0 && !adapterResult.failed
                ? "succeeded"
                : "failed";
        const error =
          finalStatus === "cancelled"
            ? (current.stopReason ?? cancelReason ?? current.error)
            : timedOut
              ? `Timed out after ${timeoutMs}ms.`
              : signal
                ? `Process exited from signal ${signal}.`
                : finalStatus === "failed"
                  ? adapterResult.errorText
                  : undefined;

        const finished = await updateTaskStatus(current, finalStatus, {
          finishedAt: now(),
          exitCode: code,
          ...(error ? { error } : {}),
          ...(adapterResult.usage
            ? {
                usage: selectTaskUsage(
                  current.usage,
                  usageWithUpdatedAt(adapterResult.usage, now()),
                ),
              }
            : {}),
          ...(shouldPersistOutputCapture(resultTruncated)
            ? { outputCapture: outputCaptureSnapshot(resultTruncated) }
            : {}),
        });
        await queueEvent(finalStatus === "succeeded" ? "completed" : finalStatus, {
          exitCode: code,
          signal,
          ...(error ? { error } : {}),
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
      if (isTaskStopRequested(current) || cancelRequested) {
        if (child.pid && !current.pid) {
          await updateTaskStatus(current, current.status, { pid: child.pid });
        }
        killProcessGroup(child, current.stopSignal ?? cancelSignal);
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
      await queueEvent("running", { pid: child.pid ?? null });

      timeout = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            killProcessGroup(child);
          }, timeoutMs)
        : undefined;

      if (cancelRequested) {
        killProcessGroup(child, cancelSignal);
        return;
      }

      const supervisorIdentity = await captureProcessIdentity(process.pid);
      const childIdentity = child.pid ? await captureProcessIdentity(child.pid) : undefined;
      if (settled) {
        return;
      }
      const supervision =
        supervisorIdentity && childIdentity
          ? {
              supervisor: supervisorIdentity,
              child: childIdentity,
              ...(process.platform !== "win32" && child.pid ? { processGroupId: child.pid } : {}),
              startedAt,
              heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
              staleAfterMs: HEARTBEAT_STALE_AFTER_MS,
            }
          : undefined;
      if (supervision) {
        const currentForSupervision = await readTaskRecord(input, taskId);
        if (settled) {
          return;
        }
        await updateTaskStatus(currentForSupervision, currentForSupervision.status, {
          supervision,
        });
        const writeHeartbeat = async (): Promise<void> => {
          await writeTaskHeartbeat(paths, {
            taskId,
            supervisorPid: supervision.supervisor.pid,
            ...(supervision.child ? { childPid: supervision.child.pid } : {}),
            ...(supervision.processGroupId ? { processGroupId: supervision.processGroupId } : {}),
            lastHeartbeatAt: now(),
          });
        };
        await writeHeartbeat();
        if (settled) {
          return;
        }
        heartbeat = setInterval(() => {
          void writeHeartbeat().catch(() => {});
        }, HEARTBEAT_INTERVAL_MS);
        heartbeat.unref();
      }
      if (cancelRequested) {
        killProcessGroup(child, cancelSignal);
        return;
      }
    })();
  });

  child.stdin.on("error", () => {
    // Spawn/kill races can close stdin before we write. The child error/close
    // handlers own the durable task status.
  });

  return {
    completed,
    interrupt(reason, signal = "SIGTERM") {
      cancelRequested = true;
      cancelReason = reason;
      cancelSignal = signal;
      killProcessGroup(child, signal);
    },
  };
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

export function killPidGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
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

function now(): string {
  return new Date().toISOString();
}

function isIgnorableKillError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM")
  );
}
