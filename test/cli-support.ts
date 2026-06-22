import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildAgentLaunchPlan, type AgentLaunchPlan } from "@backnotprop/orchestrator-core/runtime";
import { runCli } from "./helpers.ts";

export {
  runCli,
  waitForTaskStatus,
  waitForTerminalTask,
  waitUntilRunning,
  waitUntilRunningOrCancelled,
  withTempWorkspace,
} from "./helpers.ts";

export const repoRoot = fileURLToPath(new URL("../", import.meta.url));
export const cliPath = fileURLToPath(new URL("../packages/cli/src/cli.ts", import.meta.url));
export const PACKAGE_CLI_TIMEOUT_MS = 30_000;

export function shellPlan(command: string, cwd: string) {
  return buildAgentLaunchPlan({
    runtime: "shell",
    task: command,
    cwd,
    allowDisabledRuntime: true,
  });
}

export function orchestratorPlan(command: string, cwd: string): AgentLaunchPlan {
  return {
    ...shellPlan(command, cwd),
    runtime: "orchestrator",
    displayName: "Orchestrator",
  };
}

export function customJsonlPlan(command: string, cwd: string): AgentLaunchPlan {
  return {
    runtime: "usage-demo",
    displayName: "Usage Demo",
    executable: "sh",
    args: ["-lc", command],
    env: {},
    cwd,
    promptTransport: { kind: "argv", position: "last" },
    outputTransport: { kind: "jsonl_events", finalEvent: "final" },
    expectedProcesses: ["sh"],
    interrupt: "process_group",
    canSteerRunning: false,
    handlesOwnAuth: false,
    enabled: true,
    safety: {
      acceptsShellCommand: false,
    },
  };
}

export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function assertOneJsonLine(output: string): void {
  assert.equal(output.endsWith("\n"), true);
  assert.equal(output.trimEnd().includes("\n"), false);
  JSON.parse(output);
}

export async function waitForCliStdout(
  workspaceRoot: string,
  args: readonly string[],
  pattern: RegExp,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const output = await runCli(workspaceRoot, args);
    if (pattern.test(output.stdout)) {
      return output.stdout;
    }
    await delay(25);
  }

  assert.fail(`Timed out waiting for CLI output matching ${pattern}.`);
}

export async function waitForText(read: () => string, pattern: RegExp): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (pattern.test(read())) {
      return;
    }
    await delay(25);
  }

  assert.fail(`Timed out waiting for text matching ${pattern}.`);
}

export async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
