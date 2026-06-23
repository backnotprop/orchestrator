import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { AGENT_CONTROL_PREVIEW_MAX_BYTES } from "@backnotprop/orchestrator-core";
import type { AgentTaskRecord } from "@backnotprop/orchestrator-core";
import { readTaskRecord } from "@backnotprop/orchestrator-core/tasks";
import {
  assertOneJsonLine,
  cliPath,
  PACKAGE_CLI_TIMEOUT_MS,
  repoRoot,
  runCli,
  waitForTaskStatus,
  withTempWorkspace,
} from "./cli-support.ts";

const execFileAsync = promisify(execFile);

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

test("CLI uses one task store and filters ps by workspace", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const repoA = `${workspaceRoot}/repo-a`;
    const repoB = `${workspaceRoot}/repo-b`;
    const repoASubdir = `${repoA}/packages/api`;
    await mkdir(repoASubdir, { recursive: true });
    await mkdir(repoB, { recursive: true });

    const storeDir = `${workspaceRoot}/.orchestrator`;
    const pwdCommand = "pwd";
    const secondCommand = "printf repo-b";
    const launchA = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      repoA,
      "--cwd",
      "packages/api",
      "--name",
      "repo a cwd",
      "--json",
      pwdCommand,
    ]);
    const launchedA = JSON.parse(launchA.stdout) as AgentTaskRecord;
    const launchB = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      repoB,
      "--name",
      "repo b task",
      "--json",
      secondCommand,
    ]);
    const launchedB = JSON.parse(launchB.stdout) as AgentTaskRecord;

    await Promise.all([
      waitForTaskStatus(workspaceRoot, launchedA.taskId, "succeeded"),
      waitForTaskStatus(workspaceRoot, launchedB.taskId, "succeeded"),
    ]);

    const taskA = await readTaskRecord({ workspaceRoot }, launchedA.taskId);
    assert.equal(taskA.storeScope, "machine");
    assert.equal(taskA.location?.kind, "local");
    assert.equal(taskA.location?.workspaceRoot, repoA);
    assert.equal(taskA.location?.cwd, repoASubdir);
    assert.equal(taskA.cwd, repoASubdir);
    assert.ok(taskA.paths.taskDir.startsWith(`${storeDir}/tasks/`));

    const currentWorkspacePs = await runCli(repoA, ["ps", "--json"], PACKAGE_CLI_TIMEOUT_MS, {
      ORCHESTRATOR_HOME: storeDir,
    });
    const currentView = JSON.parse(currentWorkspacePs.stdout) as {
      scope: { workspaces: string; workspaceRoot?: string };
      rows: Array<{ taskId: string; workspaceRoot: string; cwd: string }>;
    };
    assert.deepEqual(currentView.scope, { workspaces: "current", workspaceRoot: repoA });
    assert.deepEqual(
      currentView.rows.map((row) => row.taskId),
      [launchedA.taskId],
    );
    assert.equal(currentView.rows[0]?.workspaceRoot, repoA);
    assert.equal(currentView.rows[0]?.cwd, repoASubdir);

    const allWorkspacePs = await runCli(repoA, ["ps", "-A", "--json"], PACKAGE_CLI_TIMEOUT_MS, {
      ORCHESTRATOR_HOME: storeDir,
    });
    const allView = JSON.parse(allWorkspacePs.stdout) as {
      scope: { workspaces: string };
      rows: Array<{ taskId: string; workspaceRoot: string }>;
    };
    assert.deepEqual(allView.scope, { workspaces: "all" });
    assert.deepEqual(
      allView.rows.map((row) => row.taskId).sort(),
      [launchedA.taskId, launchedB.taskId].sort(),
    );

    const crossWorkspaceRead = await runCli(
      repoB,
      ["read", launchedA.taskId.slice(0, 8)],
      PACKAGE_CLI_TIMEOUT_MS,
      { ORCHESTRATOR_HOME: storeDir },
    );
    assert.equal(crossWorkspaceRead.stdout.trim(), repoASubdir);
  }, "orchestrator-cli-machine-store-");
});

test("CLI list and ps use the same normalized workspace filter", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const repo = `${workspaceRoot}/repo`;
    await mkdir(repo, { recursive: true });

    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      repo,
      "--wait",
      "--json",
      "printf normalized-filter",
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
    const task = await readTaskRecord({ workspaceRoot }, launched.taskId);
    assert.equal(task.location?.kind, "local");
    await writeFile(
      task.paths.taskJson,
      `${JSON.stringify(
        {
          ...task,
          location: {
            ...task.location,
            workspaceRoot: `${repo}/.`,
          },
        },
        null,
        2,
      )}\n`,
    );

    const list = await runCli(workspaceRoot, ["list", "--workspace", repo, "--json"]);
    const listed = JSON.parse(list.stdout) as AgentTaskRecord[];
    assert.equal(
      listed.some((candidate) => candidate.taskId === launched.taskId),
      true,
    );

    const ps = await runCli(workspaceRoot, ["ps", "--workspace", repo, "--json"]);
    const psView = JSON.parse(ps.stdout) as { rows: Array<{ taskId: string }> };
    assert.equal(
      psView.rows.some((row) => row.taskId === launched.taskId),
      true,
    );
  }, "orchestrator-cli-list-ps-normalized-filter-");
});

test("CLI launch --json --compact returns a small agent control summary", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 5000)"';

    try {
      await runCli(workspaceRoot, [
        "launch",
        "shell",
        "--workspace",
        workspaceRoot,
        "--compact",
        command,
      ]);
      assert.fail("Expected launch --compact without --json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      assert.match(stderr, /launch --compact requires --json/);
    }

    try {
      await runCli(workspaceRoot, [
        "launch",
        "shell",
        "--workspace",
        workspaceRoot,
        "--brief",
        command,
      ]);
      assert.fail("Expected launch --brief without --compact to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        error: { message: string; reason?: string; input?: string; hint?: string };
      };
      assert.match(parsed.error.message, /launch --brief requires --compact/);
      assert.equal(parsed.error.reason, "missing_required_option");
      assert.equal(parsed.error.input, "--brief");
      assert.match(parsed.error.hint ?? "", /launch --json --compact --brief/);
    }

    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "compact launch",
      "--json",
      "--compact",
      command,
    ]);
    assertOneJsonLine(launch.stdout);
    const launched = JSON.parse(launch.stdout) as {
      schemaVersion: number;
      id: string;
      taskId: string;
      name: string;
      runtime: string;
      status: string;
      active: boolean;
      commands: {
        read: { args: string[] };
        readPreview: { args: string[] };
        wait: { args: string[] };
        waitPreview: { args: string[] };
        watch: { args: string[] };
        agentWatch: { args: string[] };
        logs: { args: string[] };
        logsPreview: { args: string[] };
        events: { args: string[] };
        agentEvents: { args: string[] };
      };
      stop?: { kind: string; id: string; taskId: string; args: string[] };
      launchPlan?: unknown;
      paths?: unknown;
    };

    assert.equal(launched.schemaVersion, 1);
    assert.equal(launched.id, launched.taskId.slice(0, 8));
    assert.equal(launched.name, "compact launch");
    assert.equal(launched.runtime, "shell");
    assert.ok(["queued", "starting", "running"].includes(launched.status));
    assert.equal(launched.active, true);
    assert.deepEqual(launched.commands.read.args, ["read", launched.id, "--json"]);
    assert.deepEqual(launched.commands.readPreview.args, [
      "read",
      launched.id,
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
    ]);
    assert.deepEqual(launched.commands.wait.args, [
      "read",
      launched.id,
      "--wait",
      "--timeout-ms",
      "300000",
      "--json",
    ]);
    assert.deepEqual(launched.commands.waitPreview.args, [
      "read",
      launched.id,
      "--wait",
      "--timeout-ms",
      "300000",
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
    ]);
    assert.deepEqual(launched.commands.watch.args, ["watch", launched.id, "--json"]);
    assert.deepEqual(launched.commands.logsPreview.args, [
      "logs",
      launched.id,
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
    ]);
    assert.deepEqual(launched.commands.agentWatch.args, [
      "watch",
      launched.id,
      "--agent-only",
      "--json",
    ]);
    assert.deepEqual(launched.commands.logs.args, ["logs", launched.id, "--json", "--compact"]);
    assert.deepEqual(launched.commands.events.args, ["events", launched.id, "--json", "--compact"]);
    assert.deepEqual(launched.commands.agentEvents.args, [
      "events",
      launched.id,
      "--agent-only",
      "--json",
      "--compact",
    ]);
    assert.deepEqual(launched.stop, {
      kind: "task",
      id: launched.id,
      taskId: launched.taskId,
      args: ["interrupt", launched.id, "--json", "--compact"],
    });
    assert.equal(launched.launchPlan, undefined);
    assert.equal(launched.paths, undefined);

    const briefLaunch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "compact brief launch",
      "--json",
      "--compact",
      "--brief",
      command,
    ]);
    assertOneJsonLine(briefLaunch.stdout);
    assert.ok(briefLaunch.stdout.length < launch.stdout.length);
    const briefLaunched = JSON.parse(briefLaunch.stdout) as {
      schemaVersion: number;
      id: string;
      taskId: string;
      name: string;
      active: boolean;
      commands?: unknown;
      stop?: { kind: string; id: string; taskId: string; args: string[] };
    };
    assert.equal(briefLaunched.schemaVersion, 1);
    assert.equal(briefLaunched.name, "compact brief launch");
    assert.equal(briefLaunched.active, true);
    assert.equal(briefLaunched.commands, undefined);
    assert.deepEqual(briefLaunched.stop, {
      kind: "task",
      id: briefLaunched.id,
      taskId: briefLaunched.taskId,
      args: ["interrupt", briefLaunched.id, "--json", "--compact"],
    });

    await runCli(workspaceRoot, [
      "interrupt",
      launched.id,
      "--workspace",
      workspaceRoot,
      "--reason",
      "cleanup",
    ]);
    await runCli(workspaceRoot, [
      "interrupt",
      briefLaunched.id,
      "--workspace",
      workspaceRoot,
      "--reason",
      "cleanup",
    ]);
    await waitForTaskStatus(workspaceRoot, launched.taskId, "cancelled");
    await waitForTaskStatus(workspaceRoot, briefLaunched.taskId, "cancelled");
  }, "orchestrator-cli-compact-launch-");
});

test("CLI JSON stop args are portable across cwd and custom task stores", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const orchestratorDir = `${workspaceRoot}/custom-orchestrator-store`;
    const command = 'node -e "setTimeout(() => {}, 5000)"';

    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--orchestrator-dir",
      orchestratorDir,
      "--name",
      "portable stop",
      "--json",
      "--compact",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as {
      id: string;
      taskId: string;
      stop?: { args: string[] };
    };

    assert.deepEqual(launched.stop?.args, [
      "interrupt",
      launched.id,
      "--json",
      "--compact",
      "--orchestrator-dir",
      orchestratorDir,
    ]);

    const logs = await runCli(workspaceRoot, [
      "logs",
      launched.id,
      "--workspace",
      workspaceRoot,
      "--orchestrator-dir",
      orchestratorDir,
      "--json",
    ]);
    const parsedLogs = JSON.parse(logs.stdout) as { stop?: { args: string[] } };
    assert.deepEqual(parsedLogs.stop?.args, launched.stop?.args);

    const stopped = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", cliPath, ...(launched.stop?.args ?? [])],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: workspaceRoot,
          XDG_CONFIG_HOME: `${workspaceRoot}/.config`,
        },
      },
    );
    const parsedStop = JSON.parse(stopped.stdout.toString()) as {
      summary: { interrupted: number; skipped: number; failed: number };
      interrupted?: unknown;
    };
    assert.deepEqual(parsedStop.summary, { interrupted: 1, skipped: 0, failed: 0 });
    assert.equal(parsedStop.interrupted, undefined);

    const task = await readTaskRecord({ workspaceRoot, orchestratorDir }, launched.taskId);
    assert.equal(task.status, "cancelled");
  }, "orchestrator-cli-portable-stop-args-");
});

test("CLI compact ps command args are portable across cwd", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const firstCommand = "printf portable-one";
    const secondCommand = "printf portable-two";

    const firstLaunch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "portable one",
      "--json",
      "--compact",
      "--brief",
      firstCommand,
    ]);
    const secondLaunch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "portable two",
      "--json",
      "--compact",
      "--brief",
      secondCommand,
    ]);
    const first = JSON.parse(firstLaunch.stdout) as { taskId: string };
    const second = JSON.parse(secondLaunch.stdout) as { taskId: string };

    await Promise.all([
      waitForTaskStatus(workspaceRoot, first.taskId, "succeeded"),
      waitForTaskStatus(workspaceRoot, second.taskId, "succeeded"),
    ]);

    const ps = await runCli(workspaceRoot, [
      "ps",
      "--workspace",
      workspaceRoot,
      "--json",
      "--compact",
      "--brief",
    ]);
    const compact = JSON.parse(ps.stdout) as {
      commands: {
        waitPreview: { args: string[] };
      };
    };

    const read = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", cliPath, ...compact.commands.waitPreview.args],
      {
        cwd: "/tmp",
        env: {
          ...process.env,
          HOME: workspaceRoot,
          XDG_CONFIG_HOME: `${workspaceRoot}/.config`,
        },
      },
    );
    assertOneJsonLine(read.stdout.toString());
    const parsed = JSON.parse(read.stdout.toString()) as {
      summary: { tasks: number; done: number };
      tasks: Array<{ output: string }>;
    };
    assert.deepEqual(parsed.summary, {
      tasks: 2,
      active: 0,
      done: 2,
      failed: 0,
      stopped: 0,
      timedOut: 0,
      retrievalCompleted: 2,
      retrievalTimeout: 0,
    });
    assert.deepEqual(parsed.tasks.map((task) => task.output).sort(), [
      "portable-one",
      "portable-two",
    ]);
  }, "orchestrator-cli-portable-ps-commands-");
});

test("CLI compact ps includes portable view commands even when active output is empty", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const configPath = `${workspaceRoot}/custom-runtime-config.json`;
    await writeFile(
      configPath,
      JSON.stringify(
        {
          agents: {
            "external-agent": {
              adapter: "process",
              command: "node",
              args: ["-e", "console.log(process.argv.slice(1).join(' '));", "{prompt}"],
              output: "text",
            },
          },
        },
        null,
        2,
      ),
    );

    const active = await runCli(workspaceRoot, [
      "ps",
      "--runtime",
      "external-agent",
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--json",
      "--compact",
      "--active",
      "--brief",
    ]);
    assertOneJsonLine(active.stdout);
    const compact = JSON.parse(active.stdout) as {
      summary: { tasks: number; active: number };
      commands?: unknown;
      views: {
        active: { args: string[] };
        recent: { args: string[] };
        all: { args: string[] };
      };
    };

    assert.deepEqual(compact.summary, {
      tasks: 0,
      active: 0,
      done: 0,
      failed: 0,
      stopped: 0,
      timedOut: 0,
    });
    assert.equal(compact.commands, undefined);
    assert.deepEqual(compact.views.active.args, [
      "ps",
      "--runtime",
      "external-agent",
      "--json",
      "--compact",
      "--active",
      "--brief",
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
    ]);
    assert.deepEqual(compact.views.recent.args, [
      "ps",
      "--runtime",
      "external-agent",
      "--json",
      "--compact",
      "--brief",
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
    ]);
    assert.deepEqual(compact.views.all.args, [
      "ps",
      "--runtime",
      "external-agent",
      "--all",
      "--json",
      "--compact",
      "--brief",
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
    ]);

    const recent = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", cliPath, ...compact.views.recent.args],
      {
        cwd: "/tmp",
        timeout: PACKAGE_CLI_TIMEOUT_MS,
        env: {
          ...process.env,
          HOME: workspaceRoot,
          XDG_CONFIG_HOME: `${workspaceRoot}/.config`,
        },
      },
    );
    assertOneJsonLine(recent.stdout.toString());
    const parsedRecent = JSON.parse(recent.stdout.toString()) as {
      summary: { tasks: number; active: number };
    };
    assert.deepEqual(parsedRecent.summary, {
      tasks: 0,
      active: 0,
      done: 0,
      failed: 0,
      stopped: 0,
      timedOut: 0,
    });
  }, "orchestrator-cli-empty-active-ps-views-");
});

test("CLI launch --wait --json --compact includes final output or error", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const okCommand = "printf wait-ok";
    const okLaunch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "wait ok",
      "--wait",
      "--json",
      "--compact",
      okCommand,
    ]);
    const ok = JSON.parse(okLaunch.stdout) as {
      status: string;
      active: boolean;
      output: string;
      outputAvailable: boolean;
      outputKind: string;
      usage?: { totalTokens?: number };
      error?: string;
    };
    assert.equal(ok.status, "succeeded");
    assert.equal(ok.active, false);
    assert.equal(ok.output, "wait-ok");
    assert.equal(ok.outputAvailable, true);
    assert.equal(ok.outputKind, "result");
    assert.equal(ok.error, undefined);

    const largeCommand = "node -e \"console.log('x'.repeat(30000))\"";
    const largeLaunch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "wait large",
      "--wait",
      "--json",
      "--compact",
      "--max-output-bytes",
      "40000",
      largeCommand,
    ]);
    const large = JSON.parse(largeLaunch.stdout) as {
      id: string;
      output: string;
      outputTruncated: boolean;
      outputTruncatedByReadLimit: boolean;
      outputTruncatedByCaptureLimit: boolean;
      maxBytes: number;
      captureMaxBytes?: number;
      commands: { read: { args: string[] }; wait?: unknown };
    };
    assert.equal(large.output.length, 16_000);
    assert.equal(large.outputTruncated, true);
    assert.equal(large.outputTruncatedByReadLimit, true);
    assert.equal(large.outputTruncatedByCaptureLimit, false);
    assert.equal(large.maxBytes, 16_000);
    assert.equal(large.captureMaxBytes, undefined);
    assert.deepEqual(large.commands.read.args, ["read", large.id, "--json"]);
    assert.equal(large.commands.wait, undefined);

    const failCommand = "node -e \"console.error('wait bad'); process.exit(2)\"";
    const failLaunch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "wait fail",
      "--wait",
      "--json",
      "--compact",
      failCommand,
    ]);
    const failed = JSON.parse(failLaunch.stdout) as {
      status: string;
      active: boolean;
      output: string;
      outputAvailable: boolean;
      outputKind: string;
      error?: string;
    };
    assert.equal(failed.status, "failed");
    assert.equal(failed.active, false);
    assert.equal(failed.output, "");
    assert.equal(failed.outputAvailable, false);
    assert.equal(failed.outputKind, "none");
    assert.equal(failed.error, "wait bad");
  }, "orchestrator-cli-wait-compact-launch-");
});
