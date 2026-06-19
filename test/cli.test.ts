import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentTaskRecord, TaskEvent } from "@backnotprop/orchestrator-core";
import {
  runCli,
  waitForTaskStatus,
  waitForTerminalTask,
  waitUntilRunning,
  withTempWorkspace,
} from "./helpers.ts";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = fileURLToPath(new URL("../packages/cli/src/cli.ts", import.meta.url));

test("workspace CLI bin invokes the packaged entrypoint", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const result = await execFileAsync(
      "pnpm",
      ["exec", "orchestrator", "list", "--workspace", workspaceRoot],
      {
        cwd: repoRoot,
        timeout: 10_000,
        env: {
          ...process.env,
          HOME: workspaceRoot,
          XDG_CONFIG_HOME: `${workspaceRoot}/.config`,
        },
      },
    );

    assert.equal(result.stdout.toString(), "No tasks.\n");
  }, "orchestrator-cli-bin-");
});

test("CLI help teaches agents the job-control contract", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const result = await execFileAsync(
      "pnpm",
      ["exec", "orchestrator", "--help", "--workspace", workspaceRoot],
      {
        cwd: repoRoot,
        timeout: 10_000,
        env: {
          ...process.env,
          HOME: workspaceRoot,
          XDG_CONFIG_HOME: `${workspaceRoot}/.config`,
        },
      },
    );

    assert.match(result.stdout.toString(), /Agent instructions:/);
    assert.match(result.stdout.toString(), /orchestrator doctor/);
    assert.match(result.stdout.toString(), /orchestrator ps/);
    assert.match(
      result.stdout.toString(),
      /orchestrator run "figure out what needs to change in this repo"/,
    );
    assert.match(result.stdout.toString(), /orchestrator run --background --name "repo plan"/);
    assert.match(
      result.stdout.toString(),
      /orchestrator run --trace-tools "launch a codex child and wait for it"/,
    );
    assert.match(
      result.stdout.toString(),
      /orchestrator run --stream-json "launch a codex child and wait for it"/,
    );
    assert.match(result.stdout.toString(), /--trace-tools\[=text\|jsonl\]/);
    assert.match(result.stdout.toString(), /--stream-json/);
    assert.match(result.stdout.toString(), /--background/);
    assert.match(
      result.stdout.toString(),
      /orchestrator launch claude-code --name "review repo" --model sonnet/,
    );
    assert.match(
      result.stdout.toString(),
      /orchestrator launch codex --name "write tests" --model gpt-5\.4-mini/,
    );
    assert.match(result.stdout.toString(), /orchestrator logs <task-id> --stream stderr --follow/);
    assert.match(result.stdout.toString(), /Use read for the final answer/);
    assert.match(result.stdout.toString(), /Runtime ids:/);
  }, "orchestrator-cli-help-");
});

test("CLI JSON help exposes a machine-readable agent contract", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const result = await execFileAsync(
      "pnpm",
      ["exec", "orchestrator", "help", "--workspace", workspaceRoot, "--json"],
      {
        cwd: repoRoot,
        timeout: 10_000,
        env: {
          ...process.env,
          HOME: workspaceRoot,
          XDG_CONFIG_HOME: `${workspaceRoot}/.config`,
        },
      },
    );
    const help = JSON.parse(result.stdout.toString()) as {
      schemaVersion: number;
      agentInstructions: string[];
      runtimes: { id: string; modelFlag?: string }[];
      commands: { name: string; semantics: string }[];
      examples: string[];
      workflows: { name: string; steps: string[] }[];
    };

    assert.equal(help.schemaVersion, 1);
    assert.ok(help.agentInstructions.some((instruction) => instruction.includes("Use doctor")));
    assert.ok(help.agentInstructions.some((instruction) => instruction.includes("Use run")));
    assert.ok(help.agentInstructions.some((instruction) => instruction.includes("--background")));
    assert.ok(help.agentInstructions.some((instruction) => instruction.includes("--trace-tools")));
    assert.ok(help.agentInstructions.some((instruction) => instruction.includes("--stream-json")));
    assert.ok(help.agentInstructions.some((instruction) => instruction.includes("Capture taskId")));
    assert.ok(help.commands.some((command) => command.name === "doctor"));
    assert.ok(help.commands.some((command) => command.name === "run"));
    assert.ok(help.commands.some((command) => command.name === "ps"));
    assert.ok(help.runtimes.some((runtime) => runtime.id === "claude-code" && runtime.modelFlag));
    assert.ok(help.runtimes.some((runtime) => runtime.id === "codex" && runtime.modelFlag));
    assert.ok(help.commands.some((command) => command.name === "watch"));
    assert.ok(help.commands.some((command) => command.name === "logs"));
    assert.ok(help.examples.some((example) => example === "orchestrator doctor"));
    assert.ok(help.examples.some((example) => example === "orchestrator ps"));
    assert.ok(help.examples.some((example) => example === "orchestrator ps --watch"));
    assert.ok(help.examples.some((example) => example.startsWith("orchestrator run")));
    assert.ok(help.examples.some((example) => example.includes("--background")));
    assert.ok(help.examples.some((example) => example.includes("--trace-tools")));
    assert.ok(help.examples.some((example) => example.includes("--stream-json")));
    assert.ok(help.examples.some((example) => example.includes("--name")));
    assert.ok(help.examples.some((example) => example.includes("--follow")));
    assert.ok(help.workflows.some((workflow) => workflow.name === "parent-agent"));
    assert.ok(help.workflows.some((workflow) => workflow.name === "start-and-watch"));
  }, "orchestrator-cli-json-help-");
});

test("CLI doctor reports parent-agent config paths", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const doctor = await runCli(workspaceRoot, ["doctor", "--json"]);
    const report = JSON.parse(doctor.stdout) as {
      status: string;
      canRunParentAgent: boolean;
      authPath: string;
      modelsPath: string;
      sessionDir: string;
      checks: { id: string; status: string }[];
      suggestions: string[];
    };

    assert.equal(report.status, "warning");
    assert.equal(report.canRunParentAgent, false);
    assert.match(report.authPath, /\.orchestrator\/auth\.json$/);
    assert.match(report.modelsPath, /\.orchestrator\/models\.json$/);
    assert.match(report.sessionDir, /\.orchestrator\/sessions$/);
    assert.ok(report.checks.some((check) => check.id === "auth-json"));
    assert.ok(report.suggestions.some((suggestion) => suggestion.includes("auth.json")));
  }, "orchestrator-cli-doctor-");
});

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
      assert.match(stderr, /run --stream-json cannot be combined with --json/);
    }
  }, "orchestrator-cli-run-stream-json-conflict-");
});

test("CLI run rejects unsupported trace modes before creating a parent session", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    try {
      await runCli(workspaceRoot, [
        "run",
        "--workspace",
        workspaceRoot,
        "--trace-tools=verbose",
        "hello",
      ]);
      assert.fail("Expected run with unsupported trace mode to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      assert.match(stderr, /--trace-tools=verbose must be text or jsonl/);
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
      "start a child later",
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
    assert.equal(launched.runtime, "orchestrator");
    assert.equal(launched.name, "parent smoke");
    assert.equal(launched.launchPlan.args.at(-2), "__run-parent-task");

    const finished = await waitForTerminalTask(workspaceRoot, launched.taskId, 10_000);
    assert.equal(finished.runtime, "orchestrator");
    assert.equal(finished.name, "parent smoke");
    assert.equal(finished.status, "failed");

    const ps = await runCli(workspaceRoot, ["ps", "--workspace", workspaceRoot, "--all"]);
    assert.match(ps.stdout, /parent smoke\s+failed\s+1 agent\s+1 failed/);
    assert.match(ps.stdout, /orchestrator/);
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
  }, "orchestrator-cli-no-runtimes-help-");
});

test("CLI launch accepts task names and list shows names before ids", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "printf named-ok";
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "review tests",
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--json",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
    assert.equal(launched.name, "review tests");

    await waitForTaskStatus(workspaceRoot, launched.taskId, "succeeded");

    const list = await runCli(workspaceRoot, ["list", "--workspace", workspaceRoot]);
    const columns = list.stdout.trim().split("\t");
    assert.equal(columns[0], "review tests");
    assert.equal(columns[1], "succeeded");
    assert.equal(columns[2], "shell");
    assert.equal(columns[3], "-");
    assert.match(columns[4] ?? "", /^\d+[smhd] ago$/);
    assert.equal(columns[5], launched.taskId);

    const jsonList = await runCli(workspaceRoot, ["list", "--workspace", workspaceRoot, "--json"]);
    const tasks = JSON.parse(jsonList.stdout) as AgentTaskRecord[];
    assert.equal(tasks[0]?.name, "review tests");
  }, "orchestrator-cli-names-");
});

test("CLI ps shows grouped operations view and exposes JSON rows", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "printf ps-ok";
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "check email",
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--json",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
    await waitForTaskStatus(workspaceRoot, launched.taskId, "succeeded");

    const text = await runCli(workspaceRoot, ["ps", "--workspace", workspaceRoot]);
    assert.match(text.stdout, /updated \d{2}:\d{2}:\d{2}\s+0 running\s+1 done/);
    assert.match(text.stdout, /manual launches\s+done\s+1 agent\s+1 done/);
    assert.match(text.stdout, /agent\s+work\s+status\s+model\s+started\s+dur\s+tok\s+last\s+id/);
    assert.match(text.stdout, /check email/);
    assert.match(text.stdout, /done/);
    assert.doesNotMatch(text.stdout, /completed/);
    assert.match(text.stdout, /shell/);
    assert.match(text.stdout, new RegExp(launched.taskId.slice(0, 8)));

    const json = await runCli(workspaceRoot, ["ps", "--workspace", workspaceRoot, "--json"]);
    const view = JSON.parse(json.stdout) as {
      groups: Array<{
        groupId: string;
        label: string;
        rows: Array<{ taskId: string; name: string; status: string; runtime: string }>;
      }>;
    };
    assert.equal(view.groups[0]?.groupId, "ungrouped");
    assert.equal(view.groups[0]?.label, "ungrouped");
    assert.equal(view.groups[0]?.rows[0]?.taskId, launched.taskId);
    assert.equal(view.groups[0]?.rows[0]?.name, "check email");
    assert.equal(view.groups[0]?.rows[0]?.status, "succeeded");
    assert.equal(view.groups[0]?.rows[0]?.runtime, "shell");

    const filtered = await runCli(workspaceRoot, [
      "ps",
      "--workspace",
      workspaceRoot,
      "--runtime",
      "shell",
      "--status",
      "succeeded",
      "--parent",
      "ungrouped",
      "--json",
    ]);
    const filteredView = JSON.parse(filtered.stdout) as { rows: Array<{ taskId: string }> };
    assert.deepEqual(
      filteredView.rows.map((row) => row.taskId),
      [launched.taskId],
    );

    const all = await runCli(workspaceRoot, ["ps", "--workspace", workspaceRoot, "--all"]);
    assert.match(all.stdout, /manual launches\s+done\s+1 agent\s+1 done/);
  }, "orchestrator-cli-ps-");
});

test("CLI ps --watch refreshes the grouped operations view while a task runs", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 700)"';
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "watch group",
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--json",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;

    await waitUntilRunning(workspaceRoot, launched.taskId);

    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        cliPath,
        "ps",
        "--workspace",
        workspaceRoot,
        "--watch",
        "--interval-ms",
        "50",
      ],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          HOME: workspaceRoot,
          XDG_CONFIG_HOME: `${workspaceRoot}/.config`,
        },
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      await waitForText(() => stdout, /watch group[\s\S]*running/);
    } finally {
      child.kill("SIGTERM");
      await waitForChildExit(child);
    }

    assert.equal(stderr, "");
    assert.match(stdout, /manual launches\s+running\s+1 agent\s+1 running/);
    assert.match(stdout, /watch group/);
    assert.match(stdout, /running/);

    await waitForTaskStatus(workspaceRoot, launched.taskId, "succeeded");
  }, "orchestrator-cli-ps-watch-");
});

test("CLI ps shows readable nested JSON runtime errors", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const script = [
      "const event = {",
      'type: "error",',
      "message: JSON.stringify({",
      'type: "error",',
      "error: {",
      'type: "invalid_request_error",',
      'message: "model unsupported",',
      "},",
      "}),",
      "};",
      "console.log(JSON.stringify(event));",
      "process.exit(1);",
    ].join("");

    await writeFile(
      `${workspaceRoot}/orchestrator.config.json`,
      `${JSON.stringify(
        {
          agents: {
            "json-error-agent": {
              adapter: "process",
              command: "node",
              args: ["-e", script, "{prompt}"],
              output: { format: "jsonl", finalEvent: "done" },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const launch = await runCli(workspaceRoot, [
      "launch",
      "json-error-agent",
      "--workspace",
      workspaceRoot,
      "--name",
      "bad model",
      "--json",
      "trigger error",
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
    await waitForTaskStatus(workspaceRoot, launched.taskId, "failed");

    const text = await runCli(workspaceRoot, ["ps", "--workspace", workspaceRoot, "--all"]);
    assert.match(text.stdout, /bad model/);
    assert.match(text.stdout, /model unsupported/);
    assert.doesNotMatch(text.stdout, /invalid_request_error/);
  }, "orchestrator-cli-ps-json-error-");
});

test("CLI loads custom process runtimes from workspace config", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await writeFile(
      `${workspaceRoot}/orchestrator.config.json`,
      `${JSON.stringify(
        {
          agents: {
            "echo-agent": {
              adapter: "process",
              command: "node",
              args: ["-e", "process.stdout.write(process.argv.at(-1) ?? '')", "{prompt}"],
              output: "text",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const help = await runCli(workspaceRoot, ["help", "--workspace", workspaceRoot, "--json"]);
    const helpDocument = JSON.parse(help.stdout) as {
      runtimes: { id: string; executable: string; enabled: boolean }[];
    };
    assert.ok(
      helpDocument.runtimes.some(
        (runtime) =>
          runtime.id === "echo-agent" && runtime.executable === "node" && runtime.enabled,
      ),
    );

    const launch = await runCli(workspaceRoot, [
      "launch",
      "echo-agent",
      "--workspace",
      workspaceRoot,
      "--name",
      "custom echo",
      "--json",
      "custom config works",
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
    assert.equal(launched.runtime, "echo-agent");
    assert.equal(launched.launchPlan.executable, "node");
    assert.deepEqual(launched.launchPlan.args, [
      "-e",
      "process.stdout.write(process.argv.at(-1) ?? '')",
      "custom config works",
    ]);

    await waitForTaskStatus(workspaceRoot, launched.taskId, "succeeded");

    const read = await runCli(workspaceRoot, [
      "read",
      launched.taskId,
      "--workspace",
      workspaceRoot,
    ]);
    assert.equal(read.stdout, "custom config works");

    const list = await runCli(workspaceRoot, ["list", "--workspace", workspaceRoot]);
    const columns = list.stdout.trim().split("\t");
    assert.equal(columns[0], "custom echo");
    assert.equal(columns[2], "echo-agent");
  }, "orchestrator-cli-custom-config-");
});

test("CLI list falls back to the task prompt when no name is provided", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "printf fallback-ok";
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--json",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;

    await waitForTaskStatus(workspaceRoot, launched.taskId, "succeeded");

    const list = await runCli(workspaceRoot, ["list", "--workspace", workspaceRoot]);
    const columns = list.stdout.trim().split("\t");
    assert.equal(columns[0], command);
    assert.equal(columns[5], launched.taskId);
  }, "orchestrator-cli-name-fallback-");
});

test("CLI launches a background task, lists it, and reads the result", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "printf cli-ok";
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--json",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;

    assert.equal(launched.runtime, "shell");
    assert.equal(launched.launchPlan.executable, "sh");
    assert.deepEqual(launched.launchPlan.args, ["-lc", command]);

    const completed = await waitForTaskStatus(workspaceRoot, launched.taskId, "succeeded");
    assert.equal(completed.exitCode, 0);

    const list = await runCli(workspaceRoot, ["list", "--workspace", workspaceRoot, "--json"]);
    const tasks = JSON.parse(list.stdout) as AgentTaskRecord[];
    assert.ok(tasks.some((task) => task.taskId === launched.taskId));

    const read = await runCli(workspaceRoot, [
      "read",
      launched.taskId,
      "--workspace",
      workspaceRoot,
    ]);
    assert.equal(read.stdout, "cli-ok");

    const logs = await runCli(workspaceRoot, [
      "logs",
      launched.taskId,
      "--workspace",
      workspaceRoot,
    ]);
    assert.equal(logs.stdout, "cli-ok");

    const events = await runCli(workspaceRoot, [
      "events",
      launched.taskId,
      "--workspace",
      workspaceRoot,
      "--json",
    ]);
    const parsedEvents = JSON.parse(events.stdout) as TaskEvent[];
    assert.ok(parsedEvents.some((event) => event.type === "completed"));

    const watch = await runCli(workspaceRoot, [
      "watch",
      launched.taskId,
      "--workspace",
      workspaceRoot,
      "--interval-ms",
      "10",
    ]);
    assert.match(watch.stdout, /completed/);
    assert.match(watch.stdout, /cli-ok/);
  }, "orchestrator-cli-test-");
});

test("CLI launch defaults cwd to --workspace when --cwd is not provided", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await withTempWorkspace(async (callerRoot) => {
      const command = "pwd";
      const launch = await runCli(callerRoot, [
        "launch",
        "shell",
        "--workspace",
        workspaceRoot,
        "--allow-disabled-runtime",
        "--allow-shell-command",
        command,
        "--json",
        command,
      ]);
      const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
      assert.equal(launched.cwd, workspaceRoot);
      assert.equal(launched.launchPlan.cwd, workspaceRoot);

      const completed = await waitForTaskStatus(workspaceRoot, launched.taskId, "succeeded");
      assert.equal(completed.cwd, workspaceRoot);

      const read = await runCli(callerRoot, [
        "read",
        launched.taskId,
        "--workspace",
        workspaceRoot,
      ]);
      assert.equal(read.stdout.trim(), workspaceRoot);
    }, "orchestrator-cli-caller-");
  }, "orchestrator-cli-workspace-");
});

test("CLI logs, events, and watch work while a task is running", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command =
      "node -e \"console.log('running-log'); setTimeout(() => console.log('done-log'), 500)\"";
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--json",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;

    await waitUntilRunning(workspaceRoot, launched.taskId);
    const runningLogs = await waitForCliStdout(
      workspaceRoot,
      ["logs", launched.taskId, "--workspace", workspaceRoot, "--stream", "stdout"],
      /running-log/,
    );
    assert.match(runningLogs, /running-log/);

    const runningEvents = await runCli(workspaceRoot, [
      "events",
      launched.taskId,
      "--workspace",
      workspaceRoot,
    ]);
    assert.match(runningEvents.stdout, /"type":"running"/);

    const watch = await runCli(workspaceRoot, [
      "watch",
      launched.taskId,
      "--workspace",
      workspaceRoot,
      "--interval-ms",
      "10",
    ]);
    assert.match(watch.stdout, /running-log/);
    assert.match(watch.stdout, /done-log/);
    assert.match(watch.stdout, /completed/);
  }, "orchestrator-cli-running-");
});

test("CLI logs --follow streams raw output until the task exits", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command =
      "node -e \"console.log('follow-one'); setTimeout(() => console.log('follow-two'), 150)\"";
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--json",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;

    await waitUntilRunning(workspaceRoot, launched.taskId);
    const followed = await runCli(workspaceRoot, [
      "logs",
      launched.taskId,
      "--workspace",
      workspaceRoot,
      "--stream",
      "stdout",
      "--follow",
    ]);

    assert.match(followed.stdout, /follow-one/);
    assert.match(followed.stdout, /follow-two/);
    assert.equal(followed.stderr, "");
  }, "orchestrator-cli-follow-");
});

test("CLI interrupt cancels a task launched by a detached supervisor", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 5000)"';
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--json",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;

    await waitUntilRunning(workspaceRoot, launched.taskId);

    const earlyRead = await runCli(workspaceRoot, [
      "read",
      launched.taskId,
      "--workspace",
      workspaceRoot,
    ]);
    assert.equal(earlyRead.stdout, "");
    assert.match(earlyRead.stderr, /No output yet/);
    assert.match(earlyRead.stderr, /running/);

    const interrupt = await runCli(workspaceRoot, [
      "interrupt",
      launched.taskId,
      "--workspace",
      workspaceRoot,
      "--reason",
      "cli cancellation",
      "--json",
    ]);
    const interrupted = JSON.parse(interrupt.stdout) as AgentTaskRecord;
    assert.equal(interrupted.status, "cancelled");
    assert.equal(interrupted.error, "cli cancellation");

    const completed = await waitForTaskStatus(workspaceRoot, launched.taskId, "cancelled");
    assert.equal(completed.error, "cli cancellation");
  }, "orchestrator-cli-test-");
});

async function waitForCliStdout(
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

async function waitForText(read: () => string, pattern: RegExp): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (pattern.test(read())) {
      return;
    }
    await delay(25);
  }

  assert.fail(`Timed out waiting for text matching ${pattern}.`);
}

async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
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
