import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentTaskRecord, TaskStatus } from "@backnotprop/orchestrator-core";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../packages/cli/src/cli.ts", import.meta.url));

export async function withTempWorkspace<T>(
  fn: (workspaceRoot: string) => Promise<T>,
  prefix = "orchestrator-test-",
): Promise<T> {
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  try {
    return await fn(workspaceRoot);
  } finally {
    await removeWorkspace(workspaceRoot);
  }
}

export async function runCli(
  workspaceRoot: string,
  args: readonly string[],
  timeout = 10_000,
  env: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", cliPath, ...args],
    {
      cwd: workspaceRoot,
      timeout,
      maxBuffer: 2_000_000,
      env: {
        ...process.env,
        HOME: workspaceRoot,
        XDG_CONFIG_HOME: join(workspaceRoot, ".config"),
        ...env,
      },
    },
  );

  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

export async function readTask(workspaceRoot: string, taskId: string): Promise<AgentTaskRecord> {
  const raw = await readFile(
    join(workspaceRoot, ".orchestrator", "tasks", taskId, "task.json"),
    "utf8",
  );
  return JSON.parse(raw) as AgentTaskRecord;
}

export async function waitForTaskStatus(
  workspaceRoot: string,
  taskId: string,
  expected: TaskStatus,
  timeoutMs = 5_000,
): Promise<AgentTaskRecord> {
  const task = await waitForTask(
    workspaceRoot,
    taskId,
    timeoutMs,
    (current) => current.status === expected,
  );
  await waitForSupervisorExit(workspaceRoot, taskId);
  return task;
}

export async function waitForTerminalTask(
  workspaceRoot: string,
  taskId: string,
  timeoutMs: number,
): Promise<AgentTaskRecord> {
  const task = await waitForTask(workspaceRoot, taskId, timeoutMs, isTerminalTask);
  await waitForSupervisorExit(workspaceRoot, taskId);
  return task;
}

export async function waitUntilRunningOrCancelled(
  workspaceRoot: string,
  taskId: string,
): Promise<void> {
  await waitForTask(
    workspaceRoot,
    taskId,
    5_000,
    (task) => task.status === "running" || task.status === "cancelled",
  );
}

export async function waitUntilRunning(workspaceRoot: string, taskId: string): Promise<void> {
  await waitForTask(workspaceRoot, taskId, 5_000, (task) => task.status === "running");
}

export async function assertClaudeAvailableAndAuthenticated(): Promise<void> {
  await execFileAsync("claude", ["--version"], { timeout: 10_000 });
  await execFileAsync("claude", ["auth", "status"], { timeout: 10_000 });
}

export async function assertCodexAvailable(): Promise<void> {
  await execFileAsync("codex", ["--version"], { timeout: 10_000 });
}

async function waitForTask(
  workspaceRoot: string,
  taskId: string,
  timeoutMs: number,
  predicate: (task: AgentTaskRecord) => boolean,
): Promise<AgentTaskRecord> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const task = await readTask(workspaceRoot, taskId);
    if (predicate(task)) {
      return task;
    }
    await delay(25);
  }

  const task = await readTask(workspaceRoot, taskId);
  assert.fail(`Timed out waiting for task ${taskId}; last status was ${task.status}.`);
}

async function waitForSupervisorExit(workspaceRoot: string, taskId: string): Promise<void> {
  const requestPath = join(workspaceRoot, ".orchestrator", "run-requests", `${taskId}.json`);
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5_000) {
    try {
      await access(requestPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    await delay(25);
  }

  assert.fail(`Expected detached supervisor for task ${taskId} to exit.`);
}

async function removeWorkspace(workspaceRoot: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(workspaceRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableRemoveError(error) || attempt === 4) {
        throw error;
      }
      await delay(25);
    }
  }
}

function isRetryableRemoveError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOTEMPTY" || error.code === "EBUSY" || error.code === "EPERM")
  );
}

function isTerminalTask(task: AgentTaskRecord): boolean {
  return (
    task.status === "succeeded" ||
    task.status === "failed" ||
    task.status === "cancelled" ||
    task.status === "timed_out"
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
