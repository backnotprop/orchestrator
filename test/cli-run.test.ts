import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { AGENT_CONTROL_PREVIEW_MAX_BYTES } from "@backnotprop/orchestrator-core";
import { readTaskRecord } from "@backnotprop/orchestrator-core/tasks";
import {
  assertOneJsonLine,
  cliPath,
  PACKAGE_CLI_TIMEOUT_MS,
  repoRoot,
  runCli,
  waitForTerminalTask,
  withTempWorkspace,
} from "./cli-support.ts";

const execFileAsync = promisify(execFile);

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
  }, "orchestrator-cli-run-background-");
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
    assert.ok(!parsed.agentQuickStart.some((step) => step.includes("Start many tasks")));
  }, "orchestrator-cli-no-runtimes-help-");
});
