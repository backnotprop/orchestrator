import { readTaskRecord } from "./store.ts";
import { isTerminalTaskStatus, type WaitForTaskInput, type WaitForTaskResult } from "./types.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const MAX_WAIT_TIMEOUT_MS = 600_000;
const DEFAULT_WAIT_INTERVAL_MS = 250;
const DEFAULT_PROGRESS_INTERVAL_MS = 1_000;

export async function waitForTask(input: WaitForTaskInput): Promise<WaitForTaskResult> {
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
  const intervalMs = normalizeIntervalMs(input.intervalMs);
  const progressIntervalMs = normalizeProgressIntervalMs(input.progressIntervalMs);
  const startedAt = Date.now();
  let nextProgressAtMs = progressIntervalMs;
  let attempt = 0;

  while (true) {
    const task = await readTaskRecord(input, input.taskId);
    const elapsedMs = Date.now() - startedAt;
    if (isTerminalTaskStatus(task.status)) {
      return {
        retrievalStatus: "completed",
        task,
      };
    }

    if (elapsedMs >= timeoutMs) {
      return {
        retrievalStatus: "timeout",
        task,
      };
    }

    const remainingMs = Math.max(1, timeoutMs - elapsedMs);
    if (input.onProgress && elapsedMs >= nextProgressAtMs) {
      input.onProgress({
        task,
        elapsedMs,
        timeoutMs,
        remainingMs,
        attempt,
      });
      attempt += 1;
      nextProgressAtMs = elapsedMs + progressIntervalMs;
    }

    await delay(Math.min(intervalMs, remainingMs));
  }
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_WAIT_TIMEOUT_MS;
  }

  assertFiniteNonNegative(timeoutMs, "timeoutMs");
  return Math.min(Math.trunc(timeoutMs), MAX_WAIT_TIMEOUT_MS);
}

function normalizeIntervalMs(intervalMs: number | undefined): number {
  if (intervalMs === undefined) {
    return DEFAULT_WAIT_INTERVAL_MS;
  }

  assertFiniteNonNegative(intervalMs, "intervalMs");
  return Math.max(1, Math.trunc(intervalMs));
}

function normalizeProgressIntervalMs(intervalMs: number | undefined): number {
  if (intervalMs === undefined) {
    return DEFAULT_PROGRESS_INTERVAL_MS;
  }

  assertFiniteNonNegative(intervalMs, "progressIntervalMs");
  return Math.max(1, Math.trunc(intervalMs));
}

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number.`);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
