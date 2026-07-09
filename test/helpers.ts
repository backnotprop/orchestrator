import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  getOrchestratorDir,
  getTaskPaths,
  writeTaskHeartbeat,
} from "@backnotprop/orchestrator-core";
import type { AgentTaskRecord, TaskStatus } from "@backnotprop/orchestrator-core";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../packages/cli/src/cli.ts", import.meta.url));

export async function withTempWorkspace<T>(
  fn: (workspaceRoot: string) => Promise<T>,
  prefix = "orchestrator-test-",
): Promise<T> {
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const previousOrchestratorHome = process.env.ORCHESTRATOR_HOME;
  process.env.HOME = workspaceRoot;
  process.env.XDG_CONFIG_HOME = join(workspaceRoot, ".config");
  process.env.ORCHESTRATOR_HOME = join(workspaceRoot, ".orchestrator");
  try {
    return await fn(workspaceRoot);
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("XDG_CONFIG_HOME", previousXdgConfigHome);
    restoreEnv("ORCHESTRATOR_HOME", previousOrchestratorHome);
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
        ORCHESTRATOR_HOME: join(workspaceRoot, ".orchestrator"),
        ...env,
      },
    },
  );

  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

export async function readTask(workspaceRoot: string, taskId: string): Promise<AgentTaskRecord> {
  const raw = await readFile(getTaskPaths({ workspaceRoot }, taskId).taskJson, "utf8");
  return JSON.parse(raw) as AgentTaskRecord;
}

export async function markTaskLostForObservation(
  task: AgentTaskRecord,
  options: { startedAt?: string; heartbeatAt?: string } = {},
): Promise<void> {
  const raw = JSON.parse(await readFile(task.paths.taskJson, "utf8")) as AgentTaskRecord;
  const startedAt = options.startedAt ?? new Date(Date.now() - 60_000).toISOString();
  const heartbeatAt = options.heartbeatAt ?? new Date(Date.now() - 60_000).toISOString();
  const deadSupervisorPid = findDeadPid();
  const deadChildPid = findDeadPid([deadSupervisorPid]);

  await writeFile(
    task.paths.taskJson,
    `${JSON.stringify(
      {
        ...raw,
        status: "running",
        startedAt,
        finishedAt: undefined,
        exitCode: undefined,
        supervision: {
          supervisor: {
            pid: deadSupervisorPid,
            capturedAt: startedAt,
            startedAtMs: 1,
          },
          child: {
            pid: deadChildPid,
            capturedAt: startedAt,
            startedAtMs: 1,
          },
          processGroupId: deadChildPid,
          startedAt,
          heartbeatIntervalMs: 5_000,
          staleAfterMs: 20_000,
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeTaskHeartbeat(task.paths, {
    taskId: task.taskId,
    supervisorPid: deadSupervisorPid,
    childPid: deadChildPid,
    processGroupId: deadChildPid,
    lastHeartbeatAt: heartbeatAt,
  });
}

export function findDeadPid(excluded: readonly number[] = []): number {
  const excludedSet = new Set(excluded);
  for (let pid = 999_999; pid > 900_000; pid -= 1) {
    if (excludedSet.has(pid)) {
      continue;
    }
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        return pid;
      }
    }
  }
  throw new Error("Could not find an unused pid for observation tests.");
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

export async function assertCopilotAvailable(): Promise<void> {
  await execFileAsync("copilot", ["--version"], { timeout: 10_000 });
}

export async function assertGrokAvailable(): Promise<void> {
  await execFileAsync("grok", ["version"], { timeout: 10_000 });
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
  const requestPath = join(getOrchestratorDir({}), "run-requests", `${taskId}.json`);
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
