import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { AGENT_CONTROL_PREVIEW_MAX_BYTES } from "@backnotprop/orchestrator-core";
import type { AgentTaskRecord, TaskEvent } from "@backnotprop/orchestrator-core";
import { launchTask } from "@backnotprop/orchestrator-core/tasks";
import {
  assertOneJsonLine,
  customJsonlPlan,
  orchestratorPlan,
  quoteShellArg,
  runCli,
  shellPlan,
  waitForTaskStatus,
  waitUntilRunning,
  withTempWorkspace,
} from "./cli-support.ts";

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
      "--name",
      "plain failure",
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
    const shortTaskId = launched.taskId.slice(0, 8);

    const read = await runCli(workspaceRoot, ["read", shortTaskId, "--workspace", workspaceRoot]);
    assert.equal(read.stdout, "cli-ok");

    const readJson = await runCli(workspaceRoot, [
      "read",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--json",
    ]);
    const parsedRead = JSON.parse(readJson.stdout) as {
      schemaVersion: number;
      id: string;
      taskId: string;
      runtime: string;
      status: string;
      active: boolean;
      output: string;
      outputAvailable: boolean;
      outputKind: string;
      usage?: unknown;
    };
    assert.equal(parsedRead.schemaVersion, 1);
    assert.equal(parsedRead.id, shortTaskId);
    assert.equal(parsedRead.taskId, launched.taskId);
    assert.equal(parsedRead.runtime, "shell");
    assert.equal(parsedRead.status, "succeeded");
    assert.equal(parsedRead.active, false);
    assert.equal(parsedRead.output, "cli-ok");
    assert.equal(parsedRead.outputAvailable, true);
    assert.equal(parsedRead.outputKind, "result");
    assert.equal(parsedRead.usage, undefined);

    const logs = await runCli(workspaceRoot, ["logs", shortTaskId, "--workspace", workspaceRoot]);
    assert.equal(logs.stdout, "cli-ok");

    const events = await runCli(workspaceRoot, [
      "events",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--json",
    ]);
    const parsedEvents = JSON.parse(events.stdout) as TaskEvent[];
    assert.ok(parsedEvents.some((event) => event.type === "completed"));

    const compactEvents = await runCli(workspaceRoot, [
      "events",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--json",
      "--compact",
      "--max-bytes",
      "2000",
    ]);
    assertOneJsonLine(compactEvents.stdout);
    const parsedCompactEvents = JSON.parse(compactEvents.stdout) as {
      schemaVersion: number;
      id: string;
      taskId: string;
      runtime: string;
      status: string;
      active: boolean;
      agentOnly: boolean;
      count: number;
      events: TaskEvent[];
      eventsTruncated: boolean;
      eventsTruncatedByReadLimit: boolean;
      maxBytes: number;
      commands: { logsPreview: { args: string[] }; agentEvents: { args: string[] } };
    };
    assert.equal(parsedCompactEvents.schemaVersion, 1);
    assert.equal(parsedCompactEvents.id, shortTaskId);
    assert.equal(parsedCompactEvents.taskId, launched.taskId);
    assert.equal(parsedCompactEvents.runtime, "shell");
    assert.equal(parsedCompactEvents.status, "succeeded");
    assert.equal(parsedCompactEvents.active, false);
    assert.equal(parsedCompactEvents.agentOnly, false);
    assert.equal(parsedCompactEvents.count, parsedCompactEvents.events.length);
    assert.equal(parsedCompactEvents.maxBytes, 2000);
    assert.equal(parsedCompactEvents.eventsTruncated, false);
    assert.equal(parsedCompactEvents.eventsTruncatedByReadLimit, false);
    assert.ok(parsedCompactEvents.events.some((event) => event.type === "completed"));
    assert.deepEqual(parsedCompactEvents.commands.agentEvents.args, [
      "events",
      shortTaskId,
      "--agent-only",
      "--json",
      "--compact",
      "--workspace",
      workspaceRoot,
    ]);

    const watch = await runCli(workspaceRoot, [
      "watch",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--interval-ms",
      "10",
    ]);
    assert.match(watch.stdout, /completed/);
    assert.match(watch.stdout, /cli-ok/);
  }, "orchestrator-cli-test-");
});

test("CLI read --wait --json waits for a final result without polling", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "node -e \"setTimeout(() => console.log('waited ok'), 250)\"";
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "wait read",
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--json",
      "--compact",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as {
      id: string;
      taskId: string;
      status: string;
      active: boolean;
    };
    assert.equal(launched.active, true);

    const readJson = await runCli(workspaceRoot, [
      "read",
      launched.id,
      "--workspace",
      workspaceRoot,
      "--wait",
      "--timeout-ms",
      "5000",
      "--interval-ms",
      "25",
      "--json",
    ]);
    const parsedRead = JSON.parse(readJson.stdout) as {
      id: string;
      taskId: string;
      retrievalStatus: string;
      status: string;
      active: boolean;
      output: string;
      outputAvailable: boolean;
    };
    assert.equal(parsedRead.id, launched.id);
    assert.equal(parsedRead.taskId, launched.taskId);
    assert.equal(parsedRead.retrievalStatus, "completed");
    assert.equal(parsedRead.status, "succeeded");
    assert.equal(parsedRead.active, false);
    assert.equal(parsedRead.output, "waited ok\n");
    assert.equal(parsedRead.outputAvailable, true);
  }, "orchestrator-cli-read-wait-");
});

test("CLI compact read gives active task follow-up commands", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "node -e \"setTimeout(() => console.log('active done'), 5000)\"";
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "active read",
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--json",
      "--compact",
      "--brief",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as { id: string; taskId: string };

    const readJson = await runCli(workspaceRoot, [
      "read",
      launched.id,
      "--workspace",
      workspaceRoot,
      "--json",
      "--compact",
    ]);
    const parsed = JSON.parse(readJson.stdout) as {
      id: string;
      taskId: string;
      status: string;
      active: boolean;
      commands?: {
        readPreview?: { args: string[] };
        waitPreview?: { args: string[] };
        read?: unknown;
        wait?: unknown;
      };
    };

    assert.equal(parsed.id, launched.id);
    assert.equal(parsed.taskId, launched.taskId);
    assert.equal(parsed.active, true);
    assert.ok(["queued", "starting", "running"].includes(parsed.status));
    assert.deepEqual(parsed.commands?.readPreview?.args, [
      "read",
      launched.id,
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
      "--workspace",
      workspaceRoot,
    ]);
    assert.deepEqual(parsed.commands?.waitPreview?.args, [
      "read",
      launched.id,
      "--wait",
      "--timeout-ms",
      "300000",
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
      "--workspace",
      workspaceRoot,
    ]);
    assert.equal(parsed.commands?.read, undefined);
    assert.equal(parsed.commands?.wait, undefined);

    await runCli(workspaceRoot, [
      "interrupt",
      launched.id,
      "--workspace",
      workspaceRoot,
      "--json",
      "--compact",
    ]);
  }, "orchestrator-cli-active-read-followup-");
});

test("CLI read --wait --json can collect multiple task results", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const firstCommand = "node -e \"setTimeout(() => console.log('first ok'), 100)\"";
    const secondCommand = "node -e \"setTimeout(() => console.log('second ok'), 250)\"";
    const firstLaunch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "batch first",
      "--allow-disabled-runtime",
      "--allow-shell-command",
      firstCommand,
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
      "batch second",
      "--allow-disabled-runtime",
      "--allow-shell-command",
      secondCommand,
      "--json",
      "--compact",
      "--brief",
      secondCommand,
    ]);
    const first = JSON.parse(firstLaunch.stdout) as { id: string; taskId: string };
    const second = JSON.parse(secondLaunch.stdout) as { id: string; taskId: string };

    const readJson = await runCli(workspaceRoot, [
      "read",
      first.id,
      second.id,
      "--workspace",
      workspaceRoot,
      "--wait",
      "--timeout-ms",
      "5000",
      "--interval-ms",
      "25",
      "--json",
      "--compact",
    ]);
    assertOneJsonLine(readJson.stdout);
    const parsed = JSON.parse(readJson.stdout) as {
      schemaVersion: number;
      summary: {
        tasks: number;
        active: number;
        done: number;
        failed: number;
        retrievalCompleted?: number;
        retrievalTimeout?: number;
      };
      commands?: unknown;
      tasks: Array<{
        id: string;
        taskId: string;
        name: string;
        status: string;
        retrievalStatus: string;
        output: string;
        commands?: unknown;
        schemaVersion?: unknown;
      }>;
    };

    assert.equal(parsed.schemaVersion, 1);
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
    assert.deepEqual(
      parsed.tasks.map((task) => task.id),
      [first.id, second.id],
    );
    assert.deepEqual(
      parsed.tasks.map((task) => task.taskId),
      [first.taskId, second.taskId],
    );
    assert.deepEqual(
      parsed.tasks.map((task) => task.output),
      ["first ok\n", "second ok\n"],
    );
    assert.ok(parsed.tasks.every((task) => task.status === "succeeded"));
    assert.ok(parsed.tasks.every((task) => task.retrievalStatus === "completed"));
    assert.equal(parsed.commands, undefined);
    assert.ok(parsed.tasks.every((task) => task.commands === undefined));
    assert.ok(parsed.tasks.every((task) => task.schemaVersion === undefined));

    try {
      await runCli(workspaceRoot, ["read", first.id, second.id, "--workspace", workspaceRoot]);
      assert.fail("Expected multi-task read without --json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      assert.match(stderr, /read multiple task ids requires --json/);
    }
  }, "orchestrator-cli-read-batch-");
});

test("CLI batch read timeout returns follow-up commands for active tasks", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const doneCommand = "printf done-ok";
    const slowCommand = "node -e \"setTimeout(() => console.log('late ok'), 2000)\"";
    const doneLaunch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "batch done",
      "--allow-disabled-runtime",
      "--allow-shell-command",
      doneCommand,
      "--json",
      "--compact",
      "--brief",
      doneCommand,
    ]);
    const slowLaunch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "batch slow",
      "--allow-disabled-runtime",
      "--allow-shell-command",
      slowCommand,
      "--json",
      "--compact",
      "--brief",
      slowCommand,
    ]);
    const done = JSON.parse(doneLaunch.stdout) as { id: string; taskId: string };
    const slow = JSON.parse(slowLaunch.stdout) as { id: string; taskId: string };
    await waitForTaskStatus(workspaceRoot, done.taskId, "succeeded");

    const readJson = await runCli(workspaceRoot, [
      "read",
      done.id,
      slow.id,
      "--workspace",
      workspaceRoot,
      "--wait",
      "--timeout-ms",
      "1",
      "--interval-ms",
      "1",
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
    ]);
    assertOneJsonLine(readJson.stdout);
    const parsed = JSON.parse(readJson.stdout) as {
      summary: {
        tasks: number;
        active: number;
        done: number;
        retrievalCompleted?: number;
        retrievalTimeout?: number;
      };
      commands: {
        readPreview: { args: string[] };
        waitPreview: { args: string[] };
      };
      stop: { kind: string; id: string; taskId: string; args: string[] };
      tasks: Array<{ id: string; status: string; retrievalStatus: string; active: boolean }>;
    };

    assert.deepEqual(parsed.summary, {
      tasks: 2,
      active: 1,
      done: 1,
      failed: 0,
      stopped: 0,
      timedOut: 0,
      retrievalCompleted: 1,
      retrievalTimeout: 1,
    });
    assert.deepEqual(
      parsed.tasks.map((task) => [task.id, task.status, task.retrievalStatus, task.active]),
      [
        [done.id, "succeeded", "completed", false],
        [slow.id, "running", "timeout", true],
      ],
    );
    assert.deepEqual(parsed.commands.readPreview.args, [
      "read",
      slow.id,
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
      "--workspace",
      workspaceRoot,
    ]);
    assert.deepEqual(parsed.commands.waitPreview.args, [
      "read",
      slow.id,
      "--wait",
      "--timeout-ms",
      "300000",
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
      "--workspace",
      workspaceRoot,
    ]);
    assert.deepEqual(parsed.stop, {
      kind: "task",
      id: slow.id,
      taskId: slow.taskId,
      args: ["interrupt", slow.id, "--json", "--compact", "--workspace", workspaceRoot],
    });

    await runCli(workspaceRoot, [
      "interrupt",
      slow.id,
      "--workspace",
      workspaceRoot,
      "--reason",
      "test cleanup",
      "--json",
    ]);
    await waitForTaskStatus(workspaceRoot, slow.taskId, "cancelled");
  }, "orchestrator-cli-read-batch-timeout-");
});

test("CLI batch read timeout returns parent-safe stop for parent children", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 5000)"';
    const parent = await launchTask({
      workspaceRoot,
      taskId: "batch-read-parent-00000001",
      plan: orchestratorPlan(command, workspaceRoot),
      name: "batch read parent",
      allowedShellCommands: [command],
    });
    const child = await launchTask({
      workspaceRoot,
      taskId: "batch-read-child-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "batch read child",
      parent: {
        parentRunId: parent.task.taskId,
        parentTaskId: parent.task.taskId,
      },
      allowedShellCommands: [command],
    });

    await Promise.all([
      waitUntilRunning(workspaceRoot, parent.task.taskId),
      waitUntilRunning(workspaceRoot, child.task.taskId),
    ]);

    try {
      const readJson = await runCli(workspaceRoot, [
        "read",
        parent.task.taskId,
        child.task.taskId,
        "--workspace",
        workspaceRoot,
        "--wait",
        "--timeout-ms",
        "1",
        "--interval-ms",
        "1",
        "--max-bytes",
        String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
        "--json",
        "--compact",
      ]);
      assertOneJsonLine(readJson.stdout);
      const parsed = JSON.parse(readJson.stdout) as {
        summary: { active: number; retrievalTimeout?: number };
        stop?: { kind: string; id?: string; taskId?: string; args?: string[] };
        tasks: Array<{ id: string; taskId: string; runtime: string; active: boolean }>;
      };
      const parentTask = parsed.tasks.find((task) => task.taskId === parent.task.taskId);

      assert.equal(parsed.summary.active, 2);
      assert.equal(parsed.summary.retrievalTimeout, 2);
      assert.ok(parentTask);
      assert.deepEqual(parsed.stop, {
        kind: "parent",
        id: parentTask?.id,
        taskId: parent.task.taskId,
        args: [
          "interrupt",
          parentTask?.id,
          "--children",
          "--json",
          "--compact",
          "--workspace",
          workspaceRoot,
        ],
      });
    } finally {
      await runCli(workspaceRoot, [
        "interrupt",
        "--workspace",
        workspaceRoot,
        "--group",
        parent.task.taskId,
        "--reason",
        "test cleanup",
      ]).catch(() => undefined);
      await Promise.allSettled([parent.completed, child.completed]);
    }
  }, "orchestrator-cli-read-batch-timeout-parent-");
});

test("CLI read --wait --json returns timeout status without claiming completion", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "node -e \"setTimeout(() => console.log('late ok'), 2000)\"";
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "wait timeout",
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--json",
      "--compact",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as { id: string; taskId: string };

    const readJson = await runCli(workspaceRoot, [
      "read",
      launched.id,
      "--workspace",
      workspaceRoot,
      "--wait",
      "--timeout-ms",
      "1",
      "--interval-ms",
      "1",
      "--json",
    ]);
    const parsedRead = JSON.parse(readJson.stdout) as {
      retrievalStatus: string;
      id: string;
      taskId: string;
      status: string;
      active: boolean;
      stop?: { kind: string; id: string; taskId: string; args: string[] };
      outputAvailable: boolean;
    };
    assert.equal(parsedRead.retrievalStatus, "timeout");
    assert.equal(parsedRead.status, "running");
    assert.equal(parsedRead.active, true);
    assert.deepEqual(parsedRead.stop, {
      kind: "task",
      id: parsedRead.id,
      taskId: parsedRead.taskId,
      args: ["interrupt", parsedRead.id, "--json", "--compact", "--workspace", workspaceRoot],
    });
    assert.equal(parsedRead.outputAvailable, false);

    await runCli(workspaceRoot, [
      "interrupt",
      launched.id,
      "--workspace",
      workspaceRoot,
      "--reason",
      "test cleanup",
      "--json",
    ]);
    await waitForTaskStatus(workspaceRoot, launched.taskId, "cancelled");
  }, "orchestrator-cli-read-wait-timeout-");
});

test("CLI read timeout and interval options require --wait", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await assert.rejects(
      () =>
        runCli(workspaceRoot, [
          "read",
          "abc12345",
          "--workspace",
          workspaceRoot,
          "--timeout-ms",
          "100",
          "--json",
        ]),
      (error) => {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          error: { message: string; reason?: string; input?: string; hint?: string };
        };
        return (
          /--timeout-ms requires --wait/.test(parsed.error.message) &&
          parsed.error.reason === "missing_required_option" &&
          parsed.error.input === "--timeout-ms" &&
          /--wait/.test(parsed.error.hint ?? "")
        );
      },
    );
  }, "orchestrator-cli-read-wait-option-guard-");
});

test("CLI option value errors are machine-readable with --json", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await assert.rejects(
      () => runCli(workspaceRoot, ["ps", "--workspace", "--json"]),
      (error) => {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          error: { message: string; reason?: string; input?: string; hint?: string };
        };
        return (
          /--workspace requires a value/.test(parsed.error.message) &&
          parsed.error.reason === "missing_option_value" &&
          parsed.error.input === "--workspace" &&
          /Pass a value after --workspace/.test(parsed.error.hint ?? "")
        );
      },
    );

    await assert.rejects(
      () => runCli(workspaceRoot, ["--workspace", "--json", "ps"]),
      (error) => {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          error: { message: string; reason?: string; input?: string; hint?: string };
        };
        return (
          /--workspace requires a value/.test(parsed.error.message) &&
          parsed.error.reason === "missing_option_value" &&
          parsed.error.input === "--workspace"
        );
      },
    );

    await assert.rejects(
      () =>
        runCli(workspaceRoot, [
          "read",
          "abc12345",
          "--workspace",
          workspaceRoot,
          "--wait",
          "--timeout-ms",
          "zero",
          "--json",
        ]),
      (error) => {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          error: { message: string; reason?: string; input?: string; hint?: string };
        };
        return (
          /--timeout-ms must be a positive integer/.test(parsed.error.message) &&
          parsed.error.reason === "invalid_option_value" &&
          parsed.error.input === "zero" &&
          /positive integer/.test(parsed.error.hint ?? "")
        );
      },
    );

    await assert.rejects(
      () =>
        runCli(workspaceRoot, [
          "logs",
          "abc12345",
          "--workspace",
          workspaceRoot,
          "--stream",
          "weird",
          "--json",
        ]),
      (error) => {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          error: { message: string; reason?: string; input?: string; hint?: string };
        };
        return (
          /--stream must be one of/.test(parsed.error.message) &&
          parsed.error.reason === "invalid_option_value" &&
          parsed.error.input === "weird" &&
          /--stream stdout/.test(parsed.error.hint ?? "")
        );
      },
    );

    await assert.rejects(
      () =>
        runCli(workspaceRoot, ["ps", "--workspace", workspaceRoot, "--status", "runing", "--json"]),
      (error) => {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          error: { message: string; reason?: string; input?: string; hint?: string };
        };
        return (
          /--status must be one of/.test(parsed.error.message) &&
          parsed.error.reason === "invalid_option_value" &&
          parsed.error.input === "runing" &&
          /running/.test(parsed.error.hint ?? "")
        );
      },
    );

    await assert.rejects(
      () =>
        runCli(workspaceRoot, [
          "list",
          "--workspace",
          workspaceRoot,
          "--status",
          "runing",
          "--json",
        ]),
      (error) => {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          error: { message: string; reason?: string; input?: string; hint?: string };
        };
        return (
          /--status must be one of/.test(parsed.error.message) &&
          parsed.error.reason === "invalid_option_value" &&
          parsed.error.input === "runing"
        );
      },
    );

    await assert.rejects(
      () =>
        runCli(workspaceRoot, ["ps", "--workspace", workspaceRoot, "--runtime", "codx", "--json"]),
      (error) => {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          error: { message: string; reason?: string; input?: string; hint?: string };
        };
        return (
          /Unknown runtime filter/.test(parsed.error.message) &&
          parsed.error.reason === "unknown_runtime" &&
          parsed.error.input === "codx" &&
          /help --json --compact/.test(parsed.error.hint ?? "")
        );
      },
    );
  }, "orchestrator-cli-option-value-errors-");
});

test("CLI read --json includes normalized task usage when available", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fixturePath = `${workspaceRoot}/usage-agent.jsonl`;
    await writeFile(
      fixturePath,
      [
        JSON.stringify({
          type: "usage",
          usage: {
            inputTokens: 700,
            outputTokens: 300,
            totalTokens: 1000,
            source: "provider",
            scope: "task",
            final: false,
          },
        }),
        JSON.stringify({
          type: "final",
          text: "usage complete",
          usage: {
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 1500,
            source: "provider",
            scope: "task",
            final: true,
          },
        }),
      ].join("\n"),
    );
    const handle = await launchTask({
      workspaceRoot,
      plan: customJsonlPlan(`cat ${quoteShellArg(fixturePath)}`, workspaceRoot),
      name: "usage cli read",
    });
    const completed = await handle.completed;
    const readJson = await runCli(workspaceRoot, [
      "read",
      completed.taskId.slice(0, 8),
      "--workspace",
      workspaceRoot,
      "--json",
    ]);
    const parsedRead = JSON.parse(readJson.stdout) as {
      output: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        source?: string;
        scope?: string;
        final?: boolean;
      };
    };

    assert.equal(parsedRead.output, "usage complete");
    assert.equal(parsedRead.usage?.inputTokens, 1000);
    assert.equal(parsedRead.usage?.outputTokens, 500);
    assert.equal(parsedRead.usage?.totalTokens, 1500);
    assert.equal(parsedRead.usage?.source, "provider");
    assert.equal(parsedRead.usage?.scope, "task");
    assert.equal(parsedRead.usage?.final, true);

    const compactReadJson = await runCli(workspaceRoot, [
      "read",
      completed.taskId.slice(0, 8),
      "--workspace",
      workspaceRoot,
      "--json",
      "--compact",
    ]);
    assertOneJsonLine(compactReadJson.stdout);
    const parsedCompactRead = JSON.parse(compactReadJson.stdout) as {
      output: string;
      usage?: { totalTokens?: number };
      commands?: unknown;
    };
    assert.equal(parsedCompactRead.output, "usage complete");
    assert.equal(parsedCompactRead.usage?.totalTokens, 1500);
    assert.equal(parsedCompactRead.commands, undefined);
  }, "orchestrator-cli-read-json-usage-");
});

test("CLI read and logs JSON mark truncated output", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command =
      "node -e \"console.log('start-' + 'x'.repeat(80) + '-end'); console.error('err-' + 'y'.repeat(80) + '-end')\"";
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "truncate output",
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--json",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
    const shortTaskId = launched.taskId.slice(0, 8);
    await waitForTaskStatus(workspaceRoot, launched.taskId, "succeeded");

    const readJson = await runCli(workspaceRoot, [
      "read",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--max-bytes",
      "32",
      "--json",
      "--compact",
    ]);
    const parsedRead = JSON.parse(readJson.stdout) as {
      id: string;
      output: string;
      outputTruncated: boolean;
      maxBytes: number;
      commands: {
        readPreview: { args: string[] };
        read: { args: string[] };
        logsPreview: { args: string[] };
        events: { args: string[] };
        agentEvents: { args: string[] };
        wait?: unknown;
      };
    };
    assert.equal(parsedRead.outputTruncated, true);
    assert.equal(parsedRead.maxBytes, 32);
    assert.doesNotMatch(parsedRead.output, /start-/);
    assert.match(parsedRead.output, /-end\n$/);
    assert.deepEqual(parsedRead.commands.readPreview.args, [
      "read",
      parsedRead.id,
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
      "--workspace",
      workspaceRoot,
    ]);
    assert.deepEqual(parsedRead.commands.read.args, [
      "read",
      parsedRead.id,
      "--json",
      "--workspace",
      workspaceRoot,
    ]);
    assert.deepEqual(parsedRead.commands.logsPreview.args, [
      "logs",
      parsedRead.id,
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
      "--workspace",
      workspaceRoot,
    ]);
    assert.deepEqual(parsedRead.commands.events.args, [
      "events",
      parsedRead.id,
      "--json",
      "--compact",
      "--workspace",
      workspaceRoot,
    ]);
    assert.deepEqual(parsedRead.commands.agentEvents.args, [
      "events",
      parsedRead.id,
      "--agent-only",
      "--json",
      "--compact",
      "--workspace",
      workspaceRoot,
    ]);
    assert.equal(parsedRead.commands.wait, undefined);

    const logsJson = await runCli(workspaceRoot, [
      "logs",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--max-bytes",
      "32",
      "--json",
    ]);
    const parsedLogs = JSON.parse(logsJson.stdout) as {
      stdout: string;
      stderr: string;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      maxBytes: number;
    };
    assert.equal(parsedLogs.stdoutTruncated, true);
    assert.equal(parsedLogs.stderrTruncated, true);
    assert.equal(parsedLogs.maxBytes, 32);
    assert.doesNotMatch(parsedLogs.stdout, /start-/);
    assert.doesNotMatch(parsedLogs.stderr, /err-/);
    assert.match(parsedLogs.stdout, /-end\n$/);
    assert.match(parsedLogs.stderr, /-end\n$/);
  }, "orchestrator-cli-json-truncation-");
});

test("CLI read and logs JSON distinguish capture truncation", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command =
      "node -e \"console.log('start-' + 'x'.repeat(80) + '-end'); console.error('err-' + 'y'.repeat(80) + '-end')\"";
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "capture truncated output",
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--max-output-bytes",
      "24",
      "--json",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
    const shortTaskId = launched.taskId.slice(0, 8);
    await waitForTaskStatus(workspaceRoot, launched.taskId, "succeeded");

    const readJson = await runCli(workspaceRoot, [
      "read",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--json",
    ]);
    const parsedRead = JSON.parse(readJson.stdout) as {
      output: string;
      outputTruncated: boolean;
      outputTruncatedByReadLimit: boolean;
      outputTruncatedByCaptureLimit: boolean;
      captureMaxBytes: number;
    };
    assert.equal(parsedRead.output, "start-xxxxxxxxxxxxxxxxxx");
    assert.equal(parsedRead.outputTruncated, true);
    assert.equal(parsedRead.outputTruncatedByReadLimit, false);
    assert.equal(parsedRead.outputTruncatedByCaptureLimit, true);
    assert.equal(parsedRead.captureMaxBytes, 24);

    const logsJson = await runCli(workspaceRoot, [
      "logs",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--json",
    ]);
    const parsedLogs = JSON.parse(logsJson.stdout) as {
      stdout: string;
      stderr: string;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      stdoutTruncatedByReadLimit: boolean;
      stderrTruncatedByReadLimit: boolean;
      stdoutTruncatedByCaptureLimit: boolean;
      stderrTruncatedByCaptureLimit: boolean;
      captureMaxBytes: number;
    };
    assert.equal(parsedLogs.stdout, "start-xxxxxxxxxxxxxxxxxx");
    assert.equal(parsedLogs.stderr, "err-yyyyyyyyyyyyyyyyyyyy");
    assert.equal(parsedLogs.stdoutTruncated, true);
    assert.equal(parsedLogs.stderrTruncated, true);
    assert.equal(parsedLogs.stdoutTruncatedByReadLimit, false);
    assert.equal(parsedLogs.stderrTruncatedByReadLimit, false);
    assert.equal(parsedLogs.stdoutTruncatedByCaptureLimit, true);
    assert.equal(parsedLogs.stderrTruncatedByCaptureLimit, true);
    assert.equal(parsedLogs.captureMaxBytes, 24);
  }, "orchestrator-cli-capture-truncation-");
});

test("CLI read --json surfaces stderr for plain failed tasks", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "node -e \"console.error('plain failure'); process.exit(2)\"";
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "plain failure",
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--json",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
    const shortTaskId = launched.taskId.slice(0, 8);

    await waitForTaskStatus(workspaceRoot, launched.taskId, "failed");

    const readJson = await runCli(workspaceRoot, [
      "read",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--json",
    ]);
    const parsedRead = JSON.parse(readJson.stdout) as {
      taskId: string;
      status: string;
      active: boolean;
      exitCode?: number | null;
      output: string;
      outputAvailable: boolean;
      outputKind: string;
      error?: string;
    };
    assert.equal(parsedRead.taskId, launched.taskId);
    assert.equal(parsedRead.status, "failed");
    assert.equal(parsedRead.active, false);
    assert.equal(parsedRead.exitCode, 2);
    assert.equal(parsedRead.output, "");
    assert.equal(parsedRead.outputAvailable, false);
    assert.equal(parsedRead.outputKind, "none");
    assert.equal(parsedRead.error, "plain failure");

    const compactReadJson = await runCli(workspaceRoot, [
      "read",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--json",
      "--compact",
    ]);
    const parsedCompactRead = JSON.parse(compactReadJson.stdout) as {
      commands?: {
        logsPreview?: { args: string[] };
        events?: { args: string[] };
        agentEvents?: { args: string[] };
        waitPreview?: unknown;
      };
    };
    assert.deepEqual(parsedCompactRead.commands?.logsPreview?.args, [
      "logs",
      shortTaskId,
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
      "--workspace",
      workspaceRoot,
    ]);
    assert.deepEqual(parsedCompactRead.commands?.events?.args, [
      "events",
      shortTaskId,
      "--json",
      "--compact",
      "--workspace",
      workspaceRoot,
    ]);
    assert.deepEqual(parsedCompactRead.commands?.agentEvents?.args, [
      "events",
      shortTaskId,
      "--agent-only",
      "--json",
      "--compact",
      "--workspace",
      workspaceRoot,
    ]);
    assert.equal(parsedCompactRead.commands?.waitPreview, undefined);

    const logsJson = await runCli(workspaceRoot, [
      "logs",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--json",
    ]);
    const parsedLogs = JSON.parse(logsJson.stdout) as {
      schemaVersion: number;
      id: string;
      taskId: string;
      name?: string;
      runtime: string;
      status: string;
      active: boolean;
      exitCode?: number | null;
      stream: string;
      stdout: string;
      stderr: string;
    };
    assert.equal(parsedLogs.schemaVersion, 1);
    assert.equal(parsedLogs.id, shortTaskId);
    assert.equal(parsedLogs.taskId, launched.taskId);
    assert.equal(parsedLogs.name, "plain failure");
    assert.equal(parsedLogs.runtime, "shell");
    assert.equal(parsedLogs.status, "failed");
    assert.equal(parsedLogs.active, false);
    assert.equal(parsedLogs.exitCode, 2);
    assert.equal(parsedLogs.stream, "all");
    assert.equal(parsedLogs.stdout, "");
    assert.equal(parsedLogs.stderr, "plain failure\n");

    const psCompact = await runCli(workspaceRoot, [
      "ps",
      "--workspace",
      workspaceRoot,
      "--all",
      "--json",
      "--compact",
    ]);
    const parsedPs = JSON.parse(psCompact.stdout) as {
      tasks: Array<{ taskId: string; status: string; exitCode?: number | null }>;
    };
    const failedTask = parsedPs.tasks.find((task) => task.taskId === launched.taskId);
    assert.equal(failedTask?.status, "failed");
    assert.equal(failedTask?.exitCode, 2);
  }, "orchestrator-cli-read-json-failed-");
});
