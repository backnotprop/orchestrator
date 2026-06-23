import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  getOrchestratorDir,
  getTaskPaths,
  launchTask,
  validateLaunchTaskInput,
  type AgentTaskRecord,
  type LaunchTaskInput,
  type TaskStoreOptions,
} from "@backnotprop/orchestrator-core";
import { CliError } from "./cli-errors.ts";

export async function commandRunTask(requestPath: string): Promise<void> {
  const request = JSON.parse(await readFile(requestPath, "utf8")) as LaunchTaskInput;

  try {
    const handle = await launchTask(request);
    await handle.completed;
  } finally {
    await rm(requestPath, { force: true });
  }
}

export async function launchInBackground(
  input: LaunchTaskInput,
  options: { cliEntryPath: string },
): Promise<AgentTaskRecord> {
  const taskId = input.taskId;
  if (!taskId) {
    throw new CliError("Background launch requires a preallocated task id.");
  }

  validateLaunchTaskInput(input);
  const requestPath = await writeRunRequest(input);
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", options.cliEntryPath, "__run-task", requestPath],
    {
      cwd: input.plan.cwd,
      detached: true,
      env: process.env,
      stdio: "ignore",
    },
  );
  child.unref();

  return waitForTaskRecord(input, taskId);
}

export async function writeParentRunRequest<T extends TaskStoreOptions>(
  request: T,
  taskId: string,
): Promise<string> {
  const orchestratorDir = getOrchestratorDir(request);
  return writeJsonRequest({
    orchestratorDir,
    requestDirName: "parent-run-requests",
    id: taskId,
    value: request,
  });
}

async function writeRunRequest(input: LaunchTaskInput): Promise<string> {
  const orchestratorDir = getOrchestratorDir(input);
  return writeJsonRequest({
    orchestratorDir,
    requestDirName: "run-requests",
    id: input.taskId,
    value: input,
  });
}

async function writeJsonRequest(input: {
  orchestratorDir: string;
  requestDirName: string;
  id: string | undefined;
  value: unknown;
}): Promise<string> {
  if (!input.id) {
    throw new CliError("Detached request requires an id.");
  }

  const requestDir = resolve(input.orchestratorDir, input.requestDirName);
  await mkdir(requestDir, { recursive: true });

  const requestPath = resolve(requestDir, `${input.id}.json`);
  await writeFile(requestPath, `${JSON.stringify(input.value, null, 2)}\n`);
  return requestPath;
}

async function waitForTaskRecord(input: LaunchTaskInput, taskId: string): Promise<AgentTaskRecord> {
  const paths = getTaskPaths(input, taskId);
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5_000) {
    try {
      await access(paths.taskJson);
      return JSON.parse(await readFile(paths.taskJson, "utf8")) as AgentTaskRecord;
    } catch (error) {
      if (!isMissingFile(error) && !(error instanceof SyntaxError)) {
        throw error;
      }
      await delay(25);
    }
  }

  throw new CliError(`Task supervisor did not initialize task "${taskId}" within 5000ms.`);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
