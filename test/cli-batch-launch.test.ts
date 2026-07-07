import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { AGENT_CONTROL_PREVIEW_MAX_BYTES } from "@backnotprop/orchestrator-core";
import { readTaskRecord } from "@backnotprop/orchestrator-core/tasks";
import {
  assertOneJsonLine,
  cliPath,
  runCli,
  waitForTerminalTask,
  withTempWorkspace,
} from "./cli-support.ts";

test("CLI launch -f file starts several tasks and returns batch controls", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const firstCommand = 'node -e "setTimeout(() => console.log(\\"one\\"), 1000)"';
    const secondCommand = 'node -e "setTimeout(() => console.log(\\"two\\"), 1100)"';
    const manifestPath = `${workspaceRoot}/agents.json`;
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        defaults: {
          runtime: "shell",
          model: "demo-model",
        },
        tasks: [
          { name: "batch one", task: firstCommand },
          { name: "batch two", model: "override-model", task: secondCommand },
        ],
      }),
    );

    const launch = await runCli(workspaceRoot, [
      "launch",
      "-f",
      manifestPath,
      "--workspace",
      workspaceRoot,
      "--json",
      "--compact",
      "--brief",
    ]);

    assertOneJsonLine(launch.stdout);
    const parsed = JSON.parse(launch.stdout) as {
      schemaVersion: number;
      summary: { requested: number; launched: number; active: number; failed: number };
      commands: { waitPreview: { args: string[] }; readPreview: { args: string[] } };
      stop?: { kind: string; ids: string[]; args: string[] };
      tasks: Array<{
        index: number;
        id: string;
        taskId: string;
        name: string;
        runtime: string;
        model: string;
        active: boolean;
        commands?: unknown;
      }>;
    };

    assert.equal(parsed.schemaVersion, 1);
    assert.deepEqual(parsed.summary, {
      requested: 2,
      launched: 2,
      active: 2,
      failed: 0,
    });
    assert.equal(parsed.tasks.length, 2);
    assert.deepEqual(
      parsed.tasks.map((task) => task.index),
      [0, 1],
    );
    assert.deepEqual(
      parsed.tasks.map((task) => task.name),
      ["batch one", "batch two"],
    );
    assert.deepEqual(
      parsed.tasks.map((task) => task.runtime),
      ["shell", "shell"],
    );
    assert.deepEqual(
      parsed.tasks.map((task) => task.model),
      ["demo-model", "override-model"],
    );
    assert.equal(
      parsed.tasks.every((task) => task.commands === undefined),
      true,
    );

    const ids = parsed.tasks.map((task) => task.id);
    assert.deepEqual(parsed.commands.readPreview.args, [
      "read",
      ...ids,
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
    ]);
    assert.deepEqual(parsed.commands.waitPreview.args, [
      "read",
      ...ids,
      "--wait",
      "--timeout-ms",
      "300000",
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
    ]);
    assert.deepEqual(parsed.stop, {
      kind: "tasks",
      ids,
      args: ["interrupt", ...ids, "--json", "--compact"],
    });

    const read = await runCli(workspaceRoot, parsed.commands.waitPreview.args, 10_000);
    const completed = JSON.parse(read.stdout) as {
      summary: { tasks: number; done: number; retrievalCompleted: number };
      tasks: Array<{ output: string }>;
    };
    assert.equal(completed.summary.tasks, 2);
    assert.equal(completed.summary.done, 2);
    assert.equal(completed.summary.retrievalCompleted, 2);
    assert.deepEqual(completed.tasks.map((task) => task.output).sort(), ["one\n", "two\n"]);
  }, "orchestrator-cli-batch-launch-file-");
});

test("CLI launch -f supports per-task workspace and cwd", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const repoA = `${workspaceRoot}/repo-a`;
    const repoB = `${workspaceRoot}/repo-b`;
    const repoASubdir = `${repoA}/packages/api`;
    await mkdir(repoASubdir, { recursive: true });
    await mkdir(repoB, { recursive: true });

    const command = "pwd";
    const manifestPath = `${workspaceRoot}/agents-cross-workspace.json`;
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        defaults: {
          runtime: "shell",
          workspace: repoA,
          labels: { suite: "cross-workspace" },
        },
        tasks: [
          {
            name: "repo a package",
            cwd: "packages/api",
            labels: { component: "api" },
            task: command,
          },
          {
            name: "repo b root",
            workspace: repoB,
            labels: { suite: "override", component: "root" },
            task: command,
          },
        ],
      }),
    );

    const launch = await runCli(workspaceRoot, [
      "launch",
      "-f",
      manifestPath,
      "--json",
      "--compact",
      "--brief",
    ]);
    const parsed = JSON.parse(launch.stdout) as {
      tasks: Array<{
        id: string;
        taskId: string;
        name: string;
        location?: { kind: string; workspaceRoot?: string; cwd?: string };
      }>;
      commands: { waitPreview: { args: string[] } };
    };

    assert.deepEqual(
      parsed.tasks.map((task) => [task.name, task.location?.workspaceRoot, task.location?.cwd]),
      [
        ["repo a package", repoA, repoASubdir],
        ["repo b root", repoB, repoB],
      ],
    );

    const read = await runCli(workspaceRoot, parsed.commands.waitPreview.args);
    const completed = JSON.parse(read.stdout) as { tasks: Array<{ output: string }> };
    assert.deepEqual(
      completed.tasks.map((task) => task.output.trim()).sort(),
      [repoASubdir, repoB].sort(),
    );

    const persisted = await Promise.all(
      parsed.tasks.map((task) => readTaskRecord({ workspaceRoot }, task.taskId)),
    );
    assert.deepEqual(
      persisted.map((task) => [
        task.location?.kind,
        task.location?.workspaceRoot,
        task.cwd,
        task.labels,
      ]),
      [
        ["local", repoA, repoASubdir, { suite: "cross-workspace", component: "api" }],
        ["local", repoB, repoB, { suite: "override", component: "root" }],
      ],
    );
  }, "orchestrator-cli-batch-cross-workspace-");
});

test("CLI launch -f accepts a bare task array as manifest shorthand", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const manifestPath = `${workspaceRoot}/agents-array.json`;
    await writeFile(
      manifestPath,
      JSON.stringify([
        {
          runtime: "shell",
          name: "array one",
          task: "printf array-one",
        },
      ]),
    );

    const launch = await runCli(workspaceRoot, [
      "launch",
      "-f",
      manifestPath,
      "--workspace",
      workspaceRoot,
      "--json",
      "--compact",
      "--brief",
    ]);
    const parsed = JSON.parse(launch.stdout) as {
      summary: { requested: number; launched: number };
      tasks: Array<{ id: string; name: string; runtime: string }>;
      commands: { waitPreview: { args: string[] } };
    };

    assert.equal(parsed.summary.requested, 1);
    assert.equal(parsed.summary.launched, 1);
    assert.equal(parsed.tasks[0]?.name, "array one");
    assert.equal(parsed.tasks[0]?.runtime, "shell");

    const read = await runCli(workspaceRoot, parsed.commands.waitPreview.args, 10_000);
    const completed = JSON.parse(read.stdout) as { output: string; status: string };
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.output, "array-one");
  }, "orchestrator-cli-batch-array-");
});

test("CLI launch -f loads custom runtimes from each task workspace", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const repoA = `${workspaceRoot}/repo-a`;
    const repoB = `${workspaceRoot}/repo-b`;
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    await writeFile(
      `${repoA}/orchestrator.config.json`,
      JSON.stringify({
        agents: {
          "repo-a-agent": {
            adapter: "process",
            command: "node",
            args: ["-e", "process.stdout.write('a:' + (process.argv.at(-1) ?? ''))", "{prompt}"],
            output: "text",
          },
        },
      }),
    );
    await writeFile(
      `${repoB}/orchestrator.config.json`,
      JSON.stringify({
        agents: {
          "repo-b-agent": {
            adapter: "process",
            command: "node",
            args: ["-e", "process.stdout.write('b:' + (process.argv.at(-1) ?? ''))", "{prompt}"],
            output: "text",
          },
        },
      }),
    );

    const manifestPath = `${workspaceRoot}/agents-target-config.json`;
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            runtime: "repo-a-agent",
            workspace: repoA,
            name: "repo a custom",
            task: "alpha",
          },
          {
            runtime: "repo-b-agent",
            workspace: repoB,
            name: "repo b custom",
            task: "beta",
          },
        ],
      }),
    );

    const launch = await runCli(workspaceRoot, [
      "launch",
      "-f",
      manifestPath,
      "--json",
      "--compact",
      "--brief",
    ]);
    const parsed = JSON.parse(launch.stdout) as {
      tasks: Array<{
        taskId: string;
        runtime: string;
        location?: { workspaceRoot?: string };
      }>;
      commands: { waitPreview: { args: string[] } };
    };
    assert.deepEqual(
      parsed.tasks.map((task) => [task.runtime, task.location?.workspaceRoot]),
      [
        ["repo-a-agent", repoA],
        ["repo-b-agent", repoB],
      ],
    );

    const read = await runCli(workspaceRoot, parsed.commands.waitPreview.args);
    const completed = JSON.parse(read.stdout) as { tasks: Array<{ output: string }> };
    assert.deepEqual(completed.tasks.map((task) => task.output).sort(), ["a:alpha", "b:beta"]);
  }, "orchestrator-cli-batch-target-config-");
});

test("CLI launch -f preflights custom runtimes before starting any target task", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const repoA = `${workspaceRoot}/repo-a`;
    const repoB = `${workspaceRoot}/repo-b`;
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    await writeFile(
      `${repoA}/orchestrator.config.json`,
      JSON.stringify({
        agents: {
          "repo-a-agent": {
            adapter: "process",
            command: "node",
            args: [
              "-e",
              "process.stdout.write('should-not-run:' + (process.argv.at(-1) ?? ''))",
              "{prompt}",
            ],
            output: "text",
          },
        },
      }),
    );

    const manifestPath = `${workspaceRoot}/agents-target-config-invalid.json`;
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            runtime: "repo-a-agent",
            workspace: repoA,
            name: "valid target custom",
            task: "alpha",
          },
          {
            runtime: "repo-b-agent",
            workspace: repoB,
            name: "missing target custom",
            task: "beta",
          },
        ],
      }),
    );

    await assert.rejects(
      runCli(workspaceRoot, ["launch", "-f", manifestPath, "--json", "--compact", "--brief"]),
      (error: unknown) => {
        assert(error instanceof Error);
        const stderr = "stderr" in error ? String(error.stderr) : "";
        assert.match(stderr, /repo-b-agent/);
        return true;
      },
    );

    const list = await runCli(workspaceRoot, [
      "list",
      "-A",
      "--workspace",
      workspaceRoot,
      "--json",
    ]);
    assert.deepEqual(JSON.parse(list.stdout), []);
  }, "orchestrator-cli-batch-target-config-preflight-");
});

test("CLI launch -f - reads a manifest from stdin", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => console.log(\\"stdin-ok\\"), 1000)"';
    const manifest = JSON.stringify({
      schemaVersion: 1,
      tasks: [{ runtime: "shell", name: "stdin batch", task: command }],
    });

    const launch = await runCliWithInput(
      workspaceRoot,
      ["launch", "-f", "-", "--workspace", workspaceRoot, "--json", "--compact", "--brief"],
      manifest,
    );

    assertOneJsonLine(launch.stdout);
    const parsed = JSON.parse(launch.stdout) as {
      summary: { requested: number; launched: number };
      commands: { waitPreview: { args: string[] } };
      tasks: Array<{ taskId: string; name: string; runtime: string }>;
    };
    assert.deepEqual(parsed.summary, {
      requested: 1,
      launched: 1,
      active: 1,
      failed: 0,
    });
    assert.equal(parsed.tasks[0]?.name, "stdin batch");
    assert.equal(parsed.tasks[0]?.runtime, "shell");

    await waitForTerminalTask(workspaceRoot, parsed.tasks[0]?.taskId ?? "", 10_000);
    const read = await runCli(workspaceRoot, parsed.commands.waitPreview.args);
    assert.match(read.stdout, /stdin-ok/);
  }, "orchestrator-cli-batch-launch-stdin-");
});

test("CLI launch -f preflights every task before starting any task", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "printf should-not-run";
    const manifestPath = `${workspaceRoot}/invalid-agents.json`;
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          { runtime: "shell", name: "valid", task: command },
          { runtime: "missing-runtime", name: "invalid", task: "noop" },
        ],
      }),
    );

    await assert.rejects(
      runCli(workspaceRoot, [
        "launch",
        "-f",
        manifestPath,
        "--workspace",
        workspaceRoot,
        "--json",
        "--compact",
        "--brief",
      ]),
      (error: unknown) => {
        assert(error instanceof Error);
        const stderr = "stderr" in error ? String(error.stderr) : "";
        assert.match(stderr, /missing-runtime/);
        return true;
      },
    );

    const list = await runCli(workspaceRoot, ["list", "--workspace", workspaceRoot, "--json"]);
    assert.deepEqual(JSON.parse(list.stdout), []);
  }, "orchestrator-cli-batch-launch-preflight-");
});

test("CLI launch -f validates manifest shape before launch", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const cases = [
      {
        name: "bad-json",
        body: "{",
        pattern: /Invalid launch manifest JSON/,
      },
      {
        name: "missing-tasks",
        body: JSON.stringify({ schemaVersion: 1 }),
        pattern: /tasks must be a non-empty array/,
      },
      {
        name: "empty-array",
        body: JSON.stringify([]),
        pattern: /tasks must be a non-empty array/,
      },
      {
        name: "missing-runtime",
        body: JSON.stringify({ schemaVersion: 1, tasks: [{ task: "printf nope" }] }),
        pattern: /tasks\[0\]\.runtime is required/,
      },
    ];

    for (const testCase of cases) {
      const manifestPath = `${workspaceRoot}/${testCase.name}.json`;
      await writeFile(manifestPath, testCase.body);

      await assert.rejects(
        runCli(workspaceRoot, [
          "launch",
          "-f",
          manifestPath,
          "--workspace",
          workspaceRoot,
          "--json",
          "--compact",
          "--brief",
        ]),
        (error: unknown) => {
          assert(error instanceof Error);
          const stderr = "stderr" in error ? String(error.stderr) : "";
          assert.match(stderr, testCase.pattern);
          assert.match(stderr, /invalid_launch_manifest/);
          return true;
        },
      );
    }

    const list = await runCli(workspaceRoot, ["list", "--workspace", workspaceRoot, "--json"]);
    assert.deepEqual(JSON.parse(list.stdout), []);
  }, "orchestrator-cli-batch-launch-validate-manifest-");
});

test("CLI launch -f rejects positional launch input", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await writeFile(
      `${workspaceRoot}/agents.json`,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [{ runtime: "shell", task: "printf nope" }],
      }),
    );

    await assert.rejects(
      runCli(workspaceRoot, [
        "launch",
        "-f",
        `${workspaceRoot}/agents.json`,
        "shell",
        "--workspace",
        workspaceRoot,
        "--json",
      ]),
      (error: unknown) => {
        assert(error instanceof Error);
        const stderr = "stderr" in error ? String(error.stderr) : "";
        assert.match(stderr, /cannot be combined with a positional runtime or task/);
        return true;
      },
    );
  }, "orchestrator-cli-batch-launch-reject-positional-");
});

test("CLI launch -f rejects ignored single-task names", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const manifestPath = `${workspaceRoot}/agents.json`;
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [{ runtime: "shell", name: "manifest name", task: "printf nope" }],
      }),
    );

    await assert.rejects(
      runCli(workspaceRoot, [
        "launch",
        "-f",
        manifestPath,
        "--name",
        "ignored name",
        "--workspace",
        workspaceRoot,
        "--json",
      ]),
      (error: unknown) => {
        assert(error instanceof Error);
        const stderr = "stderr" in error ? String(error.stderr) : "";
        assert.match(stderr, /launch -f does not support --name/);
        assert.match(stderr, /Set name on each task in the launch manifest/);
        return true;
      },
    );
  }, "orchestrator-cli-batch-launch-reject-name-");
});

async function runCliWithInput(
  workspaceRoot: string,
  args: readonly string[],
  input: string,
): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", cliPath, ...args], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOME: workspaceRoot,
      XDG_CONFIG_HOME: `${workspaceRoot}/.config`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(input);

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  const output = {
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
  };
  if (exitCode !== 0) {
    const error = new Error(`CLI exited with code ${exitCode}`) as Error & {
      stdout: string;
      stderr: string;
    };
    error.stdout = output.stdout;
    error.stderr = output.stderr;
    throw error;
  }
  return output;
}
