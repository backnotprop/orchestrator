import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import {
  createOrchestratorAgentTools,
  type CreateOrchestratorParentSessionOptions,
  type OrchestratorParentTool,
  type createOrchestratorParentSession,
} from "@backnotprop/orchestrator-agent";
import { AGENT_CONTROL_PREVIEW_MAX_BYTES } from "@backnotprop/orchestrator-core";
import { launchTask, readTaskRecord } from "@backnotprop/orchestrator-core/tasks";
import { writeParentRunRequest } from "../packages/cli/src/background-task.ts";
import { commandRunParentTask } from "../packages/cli/src/commands/run.ts";
import {
  assertOneJsonLine,
  cliPath,
  orchestratorPlan,
  PACKAGE_CLI_TIMEOUT_MS,
  repoRoot,
  runCli,
  waitForTerminalTask,
  withTempWorkspace,
} from "./cli-support.ts";

const execFileAsync = promisify(execFile);

type ParentSessionResult = Awaited<ReturnType<typeof createOrchestratorParentSession>>;

type LaunchAgentDetails = {
  task: {
    taskId: string;
    runtime: string;
    status: string;
    name?: string;
  };
};

type ReadAgentDetails = {
  retrievalStatus?: string;
  task: {
    taskId: string;
    runtime: string;
    status: string;
  };
  output: string;
};

type ParsedTaskEvent = {
  type: string;
  data?: {
    kind?: string;
    toolName?: string;
    taskId?: string;
    runtime?: string;
    status?: string;
    output?: string;
    error?: { message?: string };
  };
};

test("CLI run requires a user request before creating a parent session", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    try {
      await runCli(workspaceRoot, ["run", "--workspace", workspaceRoot, "--trace-tools=jsonl"]);
      assert.fail("Expected run without a request to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      assert.match(stderr, /run requires a user request/);
    }
  }, "orchestrator-cli-run-requires-request-");
});

test("CLI run rejects final JSON and stream JSON together before creating a parent session", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    try {
      await runCli(workspaceRoot, [
        "run",
        "--workspace",
        workspaceRoot,
        "--json",
        "--stream-json",
        "hello",
      ]);
      assert.fail("Expected run with --json and --stream-json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        error: { message: string; reason?: string; input?: string; hint?: string };
      };
      assert.match(parsed.error.message, /run --stream-json cannot be combined with --json/);
      assert.equal(parsed.error.reason, "incompatible_options");
      assert.equal(parsed.error.input, "--stream-json");
      assert.match(parsed.error.hint ?? "", /JSONL event streams/);
    }
  }, "orchestrator-cli-run-stream-json-conflict-");
});

test("CLI run --stream-json emits parseable setup errors on stdout", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const invalidAgentDir = `${workspaceRoot}/agent-file`;
    await writeFile(invalidAgentDir, "not a directory");

    try {
      await execFileAsync(
        process.execPath,
        [
          "--experimental-strip-types",
          cliPath,
          "run",
          "--workspace",
          workspaceRoot,
          "--stream-json",
          "--agent-dir",
          invalidAgentDir,
          "launch a child later",
        ],
        {
          cwd: repoRoot,
          timeout: PACKAGE_CLI_TIMEOUT_MS,
          env: {
            ...process.env,
            HOME: workspaceRoot,
            XDG_CONFIG_HOME: `${workspaceRoot}/.config`,
          },
        },
      );
      assert.fail("Expected stream-json setup failure to exit nonzero.");
    } catch (error) {
      assert(error instanceof Error);
      assert("stdout" in error);
      assert("stderr" in error);
      const stdout = (error as { stdout: Buffer | string }).stdout.toString();
      const stderr = (error as { stderr: Buffer | string }).stderr.toString();
      assertOneJsonLine(stdout);

      const event = JSON.parse(stdout) as {
        schemaVersion: number;
        seq: number;
        runId: string;
        kind: string;
        error?: { message?: string; name?: string };
      };
      assert.equal(event.schemaVersion, 1);
      assert.equal(event.seq, 1);
      assert.match(event.runId, /^[0-9a-f-]+$/);
      assert.equal(event.kind, "run.error");
      assert.match(event.error?.message ?? "", /ENOTDIR/);
      assert.match(stderr, /ENOTDIR/);
      assert.doesNotMatch(stderr.trim(), /^\{/);
    }
  }, "orchestrator-cli-run-stream-json-setup-error-");
});

test("CLI run rejects unsupported trace modes before creating a parent session", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    try {
      await runCli(workspaceRoot, [
        "run",
        "--workspace",
        workspaceRoot,
        "--json",
        "--trace-tools=verbose",
        "hello",
      ]);
      assert.fail("Expected run with unsupported trace mode to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        error: { message: string; reason?: string; input?: string; hint?: string };
      };
      assert.match(parsed.error.message, /--trace-tools=verbose must be text or jsonl/);
      assert.equal(parsed.error.reason, "invalid_option_value");
      assert.equal(parsed.error.input, "verbose");
      assert.match(parsed.error.hint ?? "", /--trace-tools=jsonl/);
    }
  }, "orchestrator-cli-run-trace-mode-");
});

test("CLI run rejects names outside background mode", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    try {
      await runCli(workspaceRoot, [
        "run",
        "--workspace",
        workspaceRoot,
        "--name",
        "unused",
        "hello",
      ]);
      assert.fail("Expected foreground run with --name to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      assert.match(stderr, /run --name requires --background/);
    }
  }, "orchestrator-cli-run-name-requires-background-");
});

test("CLI run rejects compact outside background JSON mode", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    try {
      await runCli(workspaceRoot, ["run", "--workspace", workspaceRoot, "--compact", "hello"]);
      assert.fail("Expected run --compact without --json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      assert.match(stderr, /run --compact requires --json/);
    }

    try {
      await runCli(workspaceRoot, ["run", "--workspace", workspaceRoot, "--brief", "hello"]);
      assert.fail("Expected run --brief without --compact to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        error: { message: string; reason?: string; input?: string; hint?: string };
      };
      assert.match(parsed.error.message, /run --brief requires --compact/);
      assert.equal(parsed.error.reason, "missing_required_option");
      assert.equal(parsed.error.input, "--brief");
      assert.match(parsed.error.hint ?? "", /run --background --json --compact --brief/);
    }

    try {
      await runCli(workspaceRoot, [
        "run",
        "--workspace",
        workspaceRoot,
        "--json",
        "--compact",
        "hello",
      ]);
      assert.fail("Expected foreground run --compact to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        error: { message: string; reason?: string; input?: string; hint?: string };
      };
      assert.match(parsed.error.message, /run --compact requires --background/);
      assert.equal(parsed.error.reason, "missing_required_option");
      assert.equal(parsed.error.input, "--compact");
      assert.match(parsed.error.hint ?? "", /run --background --json --compact/);
    }
  }, "orchestrator-cli-run-compact-guards-");
});

test("CLI run --background creates a managed parent task", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const invalidAgentDir = `${workspaceRoot}/agent-file`;
    await writeFile(invalidAgentDir, "not a directory");

    const launch = await runCli(workspaceRoot, [
      "run",
      "--workspace",
      workspaceRoot,
      "--agent-dir",
      invalidAgentDir,
      "--background",
      "--name",
      "parent smoke",
      "--json",
      "--compact",
      "--brief",
      "start a child later",
    ]);
    const launched = JSON.parse(launch.stdout) as {
      schemaVersion: number;
      id: string;
      taskId: string;
      name?: string;
      runtime: string;
      status: string;
      active: boolean;
      commands?: unknown;
      stop?: { kind: string; id: string; taskId: string; args: string[] };
    };
    assert.equal(launched.schemaVersion, 1);
    assert.equal(launched.runtime, "orchestrator");
    assert.equal(launched.name, "parent smoke");
    assert.equal(launched.commands, undefined);
    assert.ok(["queued", "starting", "running", "failed"].includes(launched.status));
    const launchedActive = ["queued", "starting", "running"].includes(launched.status);
    assert.equal(launched.active, launchedActive);
    if (launchedActive) {
      assert.deepEqual(launched.stop, {
        kind: "parent",
        id: launched.id,
        taskId: launched.taskId,
        args: ["interrupt", launched.id, "--children", "--json", "--compact"],
      });
    } else {
      assert.equal(launched.stop, undefined);
    }

    const task = await readTaskRecord({ workspaceRoot }, launched.taskId);
    assert.equal(task.launchPlan.args.at(-2), "__run-parent-task");

    const finished = await waitForTerminalTask(workspaceRoot, launched.taskId, 10_000);
    assert.equal(finished.runtime, "orchestrator");
    assert.equal(finished.name, "parent smoke");
    assert.equal(finished.status, "failed");

    const ps = await runCli(workspaceRoot, ["ps", "--workspace", workspaceRoot, "--all"]);
    assert.match(ps.stdout, /parent smoke\s+failed\s+1 agent\s+1 failed/);
    assert.match(ps.stdout, /orchestrator/);

    const compactRead = await runCli(workspaceRoot, [
      "read",
      launched.id,
      "--workspace",
      workspaceRoot,
      "--json",
      "--compact",
    ]);
    const parsedCompactRead = JSON.parse(compactRead.stdout) as {
      id: string;
      runtime: string;
      status: string;
      active: boolean;
      error?: string;
      commands?: {
        logsPreview?: { args: string[] };
        events?: { args: string[] };
        agentEvents?: { args: string[] };
      };
    };
    assert.equal(parsedCompactRead.id, launched.id);
    assert.equal(parsedCompactRead.runtime, "orchestrator");
    assert.equal(parsedCompactRead.status, "failed");
    assert.equal(parsedCompactRead.active, false);
    assert.match(parsedCompactRead.error ?? "", /ENOTDIR/);
    assert.deepEqual(parsedCompactRead.commands?.logsPreview?.args, [
      "logs",
      launched.id,
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
    ]);
    assert.deepEqual(parsedCompactRead.commands?.events?.args, [
      "events",
      launched.id,
      "--json",
      "--compact",
    ]);
    assert.deepEqual(parsedCompactRead.commands?.agentEvents?.args, [
      "events",
      launched.id,
      "--agent-only",
      "--json",
      "--compact",
    ]);

    const agentEvents = await runCli(workspaceRoot, [
      "events",
      launched.id,
      "--workspace",
      workspaceRoot,
      "--agent-only",
      "--json",
    ]);
    const parsedAgentEvents = JSON.parse(agentEvents.stdout) as Array<{
      type: string;
      data?: {
        kind?: string;
        error?: { message?: string };
      };
    }>;
    assert.deepEqual(
      parsedAgentEvents.map((event) => event.data?.kind),
      ["run.error"],
    );
    assert.match(parsedAgentEvents[0]?.data?.error?.message ?? "", /ENOTDIR/);

    const watchedAgentEvents = await runCli(workspaceRoot, [
      "watch",
      launched.id,
      "--workspace",
      workspaceRoot,
      "--agent-only",
      "--json",
    ]);
    const parsedWatchedAgentEvents = watchedAgentEvents.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            data?: { kind?: string };
          },
      );
    assert.deepEqual(
      parsedWatchedAgentEvents.map((event) => event.data?.kind),
      ["run.error"],
    );
  }, "orchestrator-cli-run-background-");
});

test("CLI parent task persists successful run events for later replay", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const parentTaskId = "11111111-2222-4333-8444-555555555555";
    const parent = await launchTask({
      workspaceRoot,
      taskId: parentTaskId,
      name: "parent event success",
      plan: orchestratorPlan("printf 'parent placeholder\\n'", workspaceRoot),
      location: {
        kind: "local",
        workspaceRoot,
        workspaceName: "workspace",
        cwd: workspaceRoot,
      },
    });
    await parent.completed;

    const requestPath = await writeParentRunRequest(
      {
        schemaVersion: 1,
        workspaceRoot,
        request: "Launch a shell child and wait for it.",
        parentRunId: parentTaskId,
        parentTaskId,
      },
      parentTaskId,
    );

    const stdout = await captureStdout(async () => {
      await commandRunParentTask(requestPath, {
        cliEntryPath: cliPath,
        createParentSession: createSuccessfulFakeParentSession,
      });
    });
    assert.equal(stdout, "Child output: OK\n\n");

    const agentEvents = await runCli(workspaceRoot, [
      "events",
      parentTaskId,
      "--workspace",
      workspaceRoot,
      "--agent-only",
      "--json",
    ]);
    const parsedAgentEvents = JSON.parse(agentEvents.stdout) as ParsedTaskEvent[];
    const eventKinds = parsedAgentEvents.map((event) => event.data?.kind);
    assertEventKindSubsequence(eventKinds, [
      "run.started",
      "tool.call",
      "tool.result",
      "task.started",
      "tool.call",
      "tool.result",
      "task.finished",
      "run.final",
    ]);
    assert.ok(
      parsedAgentEvents.some(
        (event) => event.data?.kind === "tool.call" && event.data.toolName === "launch_agent",
      ),
    );
    assert.ok(
      parsedAgentEvents.some(
        (event) => event.data?.kind === "tool.call" && event.data.toolName === "read_agent",
      ),
    );
    assert.ok(
      parsedAgentEvents.some(
        (event) => event.data?.kind === "task.started" && event.data.runtime === "shell",
      ),
    );
    assert.ok(
      parsedAgentEvents.some(
        (event) =>
          event.data?.kind === "task.finished" &&
          event.data.runtime === "shell" &&
          event.data.status === "succeeded" &&
          event.data.output?.includes("OK"),
      ),
    );
    assert.equal(parsedAgentEvents.at(-1)?.data?.kind, "run.final");
    assert.match(parsedAgentEvents.at(-1)?.data?.output ?? "", /OK/);

    const watchedAgentEvents = await runCli(workspaceRoot, [
      "watch",
      parentTaskId,
      "--workspace",
      workspaceRoot,
      "--agent-only",
      "--json",
    ]);
    const parsedWatchedAgentEvents = watchedAgentEvents.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ParsedTaskEvent);
    assert.deepEqual(
      parsedWatchedAgentEvents.map((event) => event.data?.kind),
      eventKinds,
    );
  }, "orchestrator-cli-parent-task-events-success-");
});

test("CLI hides configured disabled runtimes and refuses to launch them", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await writeFile(
      `${workspaceRoot}/orchestrator.config.json`,
      `${JSON.stringify(
        {
          agents: {
            "claude-code": {
              enabled: false,
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const jsonHelp = await runCli(workspaceRoot, ["help", "--workspace", workspaceRoot, "--json"]);
    const helpDocument = JSON.parse(jsonHelp.stdout) as {
      runtimes: { id: string }[];
      examples: string[];
    };
    assert.equal(
      helpDocument.runtimes.some((runtime) => runtime.id === "claude-code"),
      false,
    );
    assert.equal(
      helpDocument.examples.some((example) => example.includes("claude-code")),
      false,
    );
    assert.ok(helpDocument.runtimes.some((runtime) => runtime.id === "codex"));

    const textHelp = await runCli(workspaceRoot, ["--help", "--workspace", workspaceRoot]);
    assert.doesNotMatch(textHelp.stdout, /claude-code/);

    try {
      await runCli(workspaceRoot, [
        "launch",
        "claude-code",
        "--workspace",
        workspaceRoot,
        "review this repo",
      ]);
      assert.fail("Expected disabled claude-code runtime launch to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      assert.match(stderr, /Unknown runtime "claude-code"/);
    }
  }, "orchestrator-cli-disable-runtime-");
});

test("CLI help handles an empty configured runtime list", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await writeFile(
      `${workspaceRoot}/orchestrator.config.json`,
      `${JSON.stringify(
        {
          agents: {
            "claude-code": { enabled: false },
            codex: { enabled: false },
            "codex-app-server": { enabled: false },
            copilot: { enabled: false },
            grok: { enabled: false },
            pi: { enabled: false },
            shell: { enabled: false },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await runCli(workspaceRoot, ["--help", "--workspace", workspaceRoot]);
    assert.match(result.stdout, /Runtime ids:\n  none configured/);
    assert.doesNotMatch(result.stdout, /Use runtime shell/);
    assert.match(
      result.stdout,
      /Do not call launch for exact local shell commands unless a local-command runtime is enabled/,
    );

    const compact = await runCli(workspaceRoot, [
      "help",
      "--workspace",
      workspaceRoot,
      "--json",
      "--compact",
    ]);
    const parsed = JSON.parse(compact.stdout) as {
      canLaunchChildAgents: boolean;
      runtimeIds: string[];
      agentQuickStart: string[];
    };
    assert.equal(parsed.canLaunchChildAgents, false);
    assert.deepEqual(parsed.runtimeIds, []);
    assert.ok(parsed.agentQuickStart.some((step) => step.includes("do not call launch")));
    assert.ok(
      parsed.agentQuickStart.some((step) => step.includes("No shell or built-in AI runtime")),
    );
    assert.ok(!parsed.agentQuickStart.some((step) => step.includes('runtime "shell"')));
    assert.ok(!parsed.agentQuickStart.some((step) => step.includes("Start many tasks")));
  }, "orchestrator-cli-no-runtimes-help-");
});

async function createSuccessfulFakeParentSession(
  options: CreateOrchestratorParentSessionOptions,
): Promise<ParentSessionResult> {
  let output = "";
  const session = {
    sessionId: "fake-parent-session",
    async prompt(): Promise<void> {
      const tools = createOrchestratorAgentTools(options);
      const launch = await executeParentTool<LaunchAgentDetails>(
        parentTool(tools, "launch_agent"),
        "fake-launch-agent",
        {
          runtime: "shell",
          name: "echo demo",
          instructions: "printf 'OK\\n'",
          timeoutMs: 10_000,
          maxOutputBytes: 1_000,
        },
      );
      const read = await executeParentTool<ReadAgentDetails>(
        parentTool(tools, "read_agent"),
        "fake-read-agent",
        {
          taskId: launch.task.taskId,
          wait: true,
          timeoutMs: 10_000,
          maxBytes: 1_000,
        },
      );
      assert.equal(read.retrievalStatus, "completed");
      assert.equal(read.task.status, "succeeded");
      output = `Child output: ${read.output}`;
    },
    getLastAssistantText(): string {
      return output;
    },
    dispose(): void {},
  };

  return {
    session: session as unknown as ParentSessionResult["session"],
    extensionsResult: {
      extensions: [],
      diagnostics: [],
    } as unknown as ParentSessionResult["extensionsResult"],
  };
}

function parentTool(
  tools: readonly OrchestratorParentTool[],
  name: string,
): OrchestratorParentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected parent tool ${name}.`);
  return tool;
}

async function executeParentTool<TDetails>(
  tool: OrchestratorParentTool,
  toolCallId: string,
  params: unknown,
): Promise<TDetails> {
  const result = await tool.execute(
    toolCallId,
    params as never,
    undefined,
    undefined,
    undefined as never,
  );
  return result.details as TDetails;
}

async function captureStdout(action: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    writeCallback?.();
    return true;
  }) as typeof process.stdout.write;

  try {
    await action();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

function assertEventKindSubsequence(
  actual: readonly (string | undefined)[],
  expected: readonly string[],
): void {
  let actualIndex = 0;
  for (const expectedKind of expected) {
    const nextIndex = actual.findIndex(
      (actualKind, index) => index >= actualIndex && actualKind === expectedKind,
    );
    assert.notEqual(nextIndex, -1, `Expected event kind ${expectedKind}.`);
    actualIndex = nextIndex + 1;
  }
}
