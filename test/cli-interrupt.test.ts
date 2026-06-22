import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTaskRecord } from "@backnotprop/orchestrator-core";
import { launchTask } from "@backnotprop/orchestrator-core/tasks";
import {
  assertOneJsonLine,
  orchestratorPlan,
  runCli,
  shellPlan,
  waitForTaskStatus,
  waitUntilRunning,
  withTempWorkspace,
} from "./cli-support.ts";

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
    const shortTaskId = launched.taskId.slice(0, 8);

    await waitUntilRunning(workspaceRoot, launched.taskId);

    const earlyRead = await runCli(workspaceRoot, [
      "read",
      shortTaskId,
      "--workspace",
      workspaceRoot,
    ]);
    assert.equal(earlyRead.stdout, "");
    assert.match(earlyRead.stderr, /No output yet/);
    assert.match(earlyRead.stderr, /running/);

    const earlyReadJson = await runCli(workspaceRoot, [
      "read",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--json",
    ]);
    const parsedEarlyRead = JSON.parse(earlyReadJson.stdout) as {
      taskId: string;
      status: string;
      active: boolean;
      output: string;
      outputAvailable: boolean;
      outputKind: string;
    };
    assert.equal(earlyReadJson.stderr, "");
    assert.equal(parsedEarlyRead.taskId, launched.taskId);
    assert.equal(parsedEarlyRead.status, "running");
    assert.equal(parsedEarlyRead.active, true);
    assert.equal(parsedEarlyRead.output, "");
    assert.equal(parsedEarlyRead.outputAvailable, false);
    assert.equal(parsedEarlyRead.outputKind, "none");

    const interrupt = await runCli(workspaceRoot, [
      "interrupt",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--reason",
      "cli cancellation",
      "--json",
    ]);
    const interrupted = JSON.parse(interrupt.stdout) as {
      schemaVersion: number;
      ok: boolean;
      summary: { interrupted: number; skipped: number; failed: number };
      target: { kind: string; taskId: string };
      interrupted: Array<{ taskId: string; id: string; status: string; error?: string }>;
      skipped: unknown[];
      failed: unknown[];
    };
    assert.equal(interrupted.schemaVersion, 1);
    assert.equal(interrupted.ok, true);
    assert.deepEqual(interrupted.summary, { interrupted: 1, skipped: 0, failed: 0 });
    assert.deepEqual(interrupted.target, { kind: "task", taskId: launched.taskId });
    assert.deepEqual(interrupted.interrupted, [
      {
        taskId: launched.taskId,
        id: shortTaskId,
        status: "cancelled",
        error: "cli cancellation",
        name: launched.taskId,
        runtime: "shell",
      },
    ]);
    assert.deepEqual(interrupted.skipped, []);
    assert.deepEqual(interrupted.failed, []);

    const completed = await waitForTaskStatus(workspaceRoot, launched.taskId, "cancelled");
    assert.equal(completed.error, "cli cancellation");
  }, "orchestrator-cli-test-");
});

test("CLI interrupt succeeds when the task is already terminal", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "printf already-done";
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "already done",
      "--allow-disabled-runtime",
      "--allow-shell-command",
      command,
      "--json",
      "--compact",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as { id: string; taskId: string };
    await waitForTaskStatus(workspaceRoot, launched.taskId, "succeeded");

    const interrupt = await runCli(workspaceRoot, [
      "interrupt",
      launched.id,
      "--workspace",
      workspaceRoot,
      "--reason",
      "idempotent stop",
      "--json",
    ]);
    const parsed = JSON.parse(interrupt.stdout) as {
      interrupted: unknown[];
      skipped: Array<{ task: { taskId: string; status: string }; reason: string }>;
      failed: unknown[];
    };
    assert.deepEqual(parsed.interrupted, []);
    assert.deepEqual(parsed.skipped, [
      {
        task: {
          taskId: launched.taskId,
          id: launched.id,
          name: "already done",
          runtime: "shell",
          status: "succeeded",
        },
        reason: "terminal",
      },
    ]);
    assert.deepEqual(parsed.failed, []);
  }, "orchestrator-cli-interrupt-terminal-");
});

test("CLI interrupt protects parent tasks and supports task-only", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 5000)"';
    const parent = await launchTask({
      workspaceRoot,
      taskId: "cli-parent-task-only-00000001",
      plan: orchestratorPlan(command, workspaceRoot),
      name: "cli parent",
      allowedShellCommands: [command],
    });
    const child = await launchTask({
      workspaceRoot,
      taskId: "cli-child-task-only-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "cli child",
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
      await runCli(workspaceRoot, [
        "interrupt",
        parent.task.taskId.slice(0, 8),
        "--workspace",
        workspaceRoot,
      ]);
      assert.fail("Expected plain parent interrupt to fail while children are running.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      assert.match(stderr, /--children/);
      assert.match(stderr, /--task-only/);
    }

    const taskOnly = await runCli(workspaceRoot, [
      "interrupt",
      parent.task.taskId.slice(0, 8),
      "--workspace",
      workspaceRoot,
      "--task-only",
      "--json",
    ]);
    const taskOnlyResult = JSON.parse(taskOnly.stdout) as {
      interrupted: Array<{ taskId: string }>;
    };
    assert.deepEqual(
      taskOnlyResult.interrupted.map((task) => task.taskId),
      [parent.task.taskId],
    );
    await parent.completed;

    const childStillRunning = await waitUntilRunning(workspaceRoot, child.task.taskId);
    assert.equal(childStillRunning, undefined);

    await runCli(workspaceRoot, [
      "interrupt",
      child.task.taskId.slice(0, 8),
      "--workspace",
      workspaceRoot,
      "--reason",
      "cleanup",
    ]);
    await child.completed;
  }, "orchestrator-cli-parent-safe-");
});

test("CLI interrupt can stop parent children and ps groups", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 5000)"';
    const parent = await launchTask({
      workspaceRoot,
      taskId: "cli-parent-children-00000001",
      plan: orchestratorPlan(command, workspaceRoot),
      name: "parent children",
      allowedShellCommands: [command],
    });
    const child = await launchTask({
      workspaceRoot,
      taskId: "cli-child-children-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "child children",
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

    const parentResult = await runCli(workspaceRoot, [
      "interrupt",
      "--parent",
      parent.task.taskId.slice(0, 8),
      "--children",
      "--workspace",
      workspaceRoot,
      "--json",
    ]);
    const parsedParent = JSON.parse(parentResult.stdout) as {
      schemaVersion: number;
      interrupted: Array<{ taskId: string }>;
    };
    assert.equal(parsedParent.schemaVersion, 1);
    assert.deepEqual(
      parsedParent.interrupted.map((task) => task.taskId),
      [parent.task.taskId, child.task.taskId],
    );
    await Promise.all([parent.completed, child.completed]);

    const groupParent = await launchTask({
      workspaceRoot,
      taskId: "cli-group-parent-00000001",
      plan: orchestratorPlan(command, workspaceRoot),
      name: "group parent",
      allowedShellCommands: [command],
    });
    const groupChild = await launchTask({
      workspaceRoot,
      taskId: "cli-group-child-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "group child",
      parent: {
        parentRunId: groupParent.task.taskId,
        parentTaskId: groupParent.task.taskId,
      },
      allowedShellCommands: [command],
    });
    await Promise.all([
      waitUntilRunning(workspaceRoot, groupParent.task.taskId),
      waitUntilRunning(workspaceRoot, groupChild.task.taskId),
    ]);

    const groupResult = await runCli(workspaceRoot, [
      "interrupt",
      "--group",
      groupParent.task.taskId.slice(0, 8),
      "--workspace",
      workspaceRoot,
      "--json",
    ]);
    const parsedGroup = JSON.parse(groupResult.stdout) as {
      schemaVersion: number;
      interrupted: Array<{ taskId: string; id: string }>;
    };
    assert.equal(parsedGroup.schemaVersion, 1);
    assert.deepEqual(
      parsedGroup.interrupted.map((task) => task.taskId),
      [groupParent.task.taskId, groupChild.task.taskId],
    );
    assert.deepEqual(
      parsedGroup.interrupted.map((task) => task.id),
      ["cli-group-p", "cli-group-c"],
    );
    await Promise.all([groupParent.completed, groupChild.completed]);

    const ungroupedCommand = "printf ungrouped";
    const ungrouped = await launchTask({
      workspaceRoot,
      taskId: "cli-ungrouped-00000001",
      plan: shellPlan(ungroupedCommand, workspaceRoot),
      name: "ungrouped",
      allowedShellCommands: [ungroupedCommand],
    });
    await ungrouped.completed;

    try {
      await runCli(workspaceRoot, [
        "interrupt",
        "--group",
        "ungrouped",
        "--workspace",
        workspaceRoot,
        "--json",
      ]);
      assert.fail("Expected broad ungrouped interruption to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        schemaVersion: number;
        error: {
          name: string;
          reason?: string;
          input?: string;
          hint?: string;
        };
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.error.name, "TaskSupervisorSafetyError");
      assert.equal(parsed.error.reason, "broad_group");
      assert.equal(parsed.error.input, "ungrouped");
      assert.match(parsed.error.hint ?? "", /ps --json --compact --active/);
    }
  }, "orchestrator-cli-group-interrupt-");
});

test("CLI interrupt can stop a selected subset of task ids", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 5000)"';
    const keep = await launchTask({
      workspaceRoot,
      taskId: "cli-selective-keep-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "keep running",
      allowedShellCommands: [command],
    });
    const first = await launchTask({
      workspaceRoot,
      taskId: "cli-selective-first-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "stop first",
      allowedShellCommands: [command],
    });
    const second = await launchTask({
      workspaceRoot,
      taskId: "cli-selective-second-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "stop second",
      allowedShellCommands: [command],
    });

    await Promise.all([
      waitUntilRunning(workspaceRoot, keep.task.taskId),
      waitUntilRunning(workspaceRoot, first.task.taskId),
      waitUntilRunning(workspaceRoot, second.task.taskId),
    ]);

    const result = await runCli(workspaceRoot, [
      "interrupt",
      first.task.taskId,
      second.task.taskId,
      "--workspace",
      workspaceRoot,
      "--reason",
      "selected cleanup",
      "--json",
      "--compact",
    ]);
    assertOneJsonLine(result.stdout);
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: number;
      ok: boolean;
      target: { kind: string; taskIds: string[] };
      summary: { interrupted: number; skipped: number; failed: number };
      failed?: unknown;
    };
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.target, {
      kind: "tasks",
      taskIds: [first.task.taskId, second.task.taskId],
    });
    assert.deepEqual(parsed.summary, { interrupted: 2, skipped: 0, failed: 0 });
    assert.equal(parsed.failed, undefined);

    await Promise.all([first.completed, second.completed]);
    await waitUntilRunning(workspaceRoot, keep.task.taskId);

    try {
      await runCli(workspaceRoot, [
        "interrupt",
        first.task.taskId,
        second.task.taskId,
        "--workspace",
        workspaceRoot,
        "--children",
        "--json",
      ]);
      assert.fail("Expected multiple task ids with --children to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsedError = JSON.parse(stderr) as {
        error: { message: string; reason?: string; input?: string; hint?: string };
      };
      assert.match(parsedError.error.message, /interrupt options cannot be combined/);
      assert.equal(parsedError.error.reason, "incompatible_options");
      assert.equal(parsedError.error.input, "task-id...,--children|--task-only");
    }

    await runCli(workspaceRoot, [
      "interrupt",
      keep.task.taskId,
      "--workspace",
      workspaceRoot,
      "--reason",
      "cleanup",
    ]);
    await keep.completed;
  }, "orchestrator-cli-selective-interrupt-");
});

test("CLI interrupt --active stops all active tasks in the selected workspace", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const runningCommand = 'node -e "setTimeout(() => {}, 5000)"';
    const doneCommand = "printf already-done";
    const parent = await launchTask({
      workspaceRoot,
      taskId: "cli-active-parent-00000001",
      plan: orchestratorPlan(runningCommand, workspaceRoot),
      name: "active parent",
      allowedShellCommands: [runningCommand],
    });
    const child = await launchTask({
      workspaceRoot,
      taskId: "cli-active-child-00000001",
      plan: shellPlan(runningCommand, workspaceRoot),
      name: "active child",
      parent: {
        parentRunId: parent.task.taskId,
        parentTaskId: parent.task.taskId,
      },
      allowedShellCommands: [runningCommand],
    });
    const manual = await launchTask({
      workspaceRoot,
      taskId: "cli-active-manual-00000001",
      plan: shellPlan(runningCommand, workspaceRoot),
      name: "active manual",
      allowedShellCommands: [runningCommand],
    });
    const done = await launchTask({
      workspaceRoot,
      taskId: "cli-active-done-00000001",
      plan: shellPlan(doneCommand, workspaceRoot),
      name: "already done",
      allowedShellCommands: [doneCommand],
    });

    await done.completed;
    await Promise.all([
      waitUntilRunning(workspaceRoot, parent.task.taskId),
      waitUntilRunning(workspaceRoot, child.task.taskId),
      waitUntilRunning(workspaceRoot, manual.task.taskId),
    ]);

    const result = await runCli(workspaceRoot, [
      "interrupt",
      "--active",
      "--workspace",
      workspaceRoot,
      "--reason",
      "cleanup active",
      "--json",
    ]);
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: number;
      ok: boolean;
      summary: { interrupted: number; skipped: number; failed: number };
      target: { kind: string };
      interrupted: Array<{ taskId: string; status: string; error?: string }>;
      skipped: unknown[];
      failed: unknown[];
    };
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.summary, { interrupted: 3, skipped: 0, failed: 0 });
    assert.deepEqual(parsed.target, { kind: "active" });
    assert.deepEqual(
      parsed.interrupted.map((task) => task.taskId),
      [parent.task.taskId, child.task.taskId, manual.task.taskId],
    );
    assert.ok(parsed.interrupted.every((task) => task.status === "cancelled"));
    assert.ok(parsed.interrupted.every((task) => task.error === "cleanup active"));
    assert.deepEqual(parsed.skipped, []);
    assert.deepEqual(parsed.failed, []);

    await Promise.all([parent.completed, child.completed, manual.completed]);
    const active = await runCli(workspaceRoot, [
      "ps",
      "--workspace",
      workspaceRoot,
      "--json",
      "--compact",
      "--active",
    ]);
    const compact = JSON.parse(active.stdout) as {
      summary: { active: number; tasks: number };
      stop?: { kind: string; args: string[] };
    };
    assert.deepEqual(compact.summary, {
      tasks: 0,
      active: 0,
      done: 0,
      failed: 0,
      stopped: 0,
      timedOut: 0,
    });
    assert.equal(compact.stop, undefined);

    const secondCleanup = await runCli(workspaceRoot, [
      "interrupt",
      "--active",
      "--workspace",
      workspaceRoot,
      "--reason",
      "idempotent cleanup",
      "--json",
    ]);
    const parsedSecondCleanup = JSON.parse(secondCleanup.stdout) as {
      ok: boolean;
      summary: { interrupted: number; skipped: number; failed: number };
      interrupted: unknown[];
      skipped: unknown[];
      failed: unknown[];
    };
    assert.equal(parsedSecondCleanup.ok, true);
    assert.deepEqual(parsedSecondCleanup.summary, { interrupted: 0, skipped: 0, failed: 0 });
    assert.deepEqual(parsedSecondCleanup.interrupted, []);
    assert.deepEqual(parsedSecondCleanup.skipped, []);
    assert.deepEqual(parsedSecondCleanup.failed, []);
  }, "orchestrator-cli-interrupt-active-");
});

test("CLI interrupt --compact without --json returns a machine-readable error", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    try {
      await runCli(workspaceRoot, ["interrupt", "--workspace", workspaceRoot, "--compact"]);
      assert.fail("Expected interrupt --compact without --json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        error: { message: string; reason?: string; input?: string; hint?: string };
      };
      assert.match(parsed.error.message, /interrupt --compact requires --json/);
      assert.equal(parsed.error.reason, "missing_required_option");
      assert.equal(parsed.error.input, "--compact");
      assert.match(parsed.error.hint ?? "", /Add --json or omit --compact/);
    }
  }, "orchestrator-cli-interrupt-compact-json-error-");
});

test("CLI logs and events --compact without --json return machine-readable errors", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    for (const command of ["logs", "events"]) {
      try {
        await runCli(workspaceRoot, [
          command,
          "task-id",
          "--workspace",
          workspaceRoot,
          "--compact",
        ]);
        assert.fail(`Expected ${command} --compact without --json to fail.`);
      } catch (error) {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          error: { message: string; reason?: string; input?: string; hint?: string };
        };
        assert.match(parsed.error.message, new RegExp(`${command} --compact requires --json`));
        assert.equal(parsed.error.reason, "missing_required_option");
        assert.equal(parsed.error.input, "--compact");
        assert.match(parsed.error.hint ?? "", /Add --json or omit --compact/);
      }
    }
  }, "orchestrator-cli-log-events-compact-json-error-");
});

test("CLI interrupt --json --compact returns concise cleanup summary", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const runningCommand = 'node -e "setTimeout(() => {}, 5000)"';
    const first = await launchTask({
      workspaceRoot,
      taskId: "cli-compact-interrupt-first-00000001",
      plan: shellPlan(runningCommand, workspaceRoot),
      name: "compact interrupt first",
      allowedShellCommands: [runningCommand],
    });
    const second = await launchTask({
      workspaceRoot,
      taskId: "cli-compact-interrupt-second-00000001",
      plan: shellPlan(runningCommand, workspaceRoot),
      name: "compact interrupt second",
      allowedShellCommands: [runningCommand],
    });

    await Promise.all([
      waitUntilRunning(workspaceRoot, first.task.taskId),
      waitUntilRunning(workspaceRoot, second.task.taskId),
    ]);

    const result = await runCli(workspaceRoot, [
      "interrupt",
      "--active",
      "--workspace",
      workspaceRoot,
      "--reason",
      "compact cleanup",
      "--json",
      "--compact",
    ]);
    assertOneJsonLine(result.stdout);
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: number;
      ok: boolean;
      summary: { interrupted: number; skipped: number; failed: number };
      target: { kind: string };
      interrupted?: unknown;
      skipped?: unknown;
      failed?: unknown;
    };

    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.target, { kind: "active" });
    assert.deepEqual(parsed.summary, { interrupted: 2, skipped: 0, failed: 0 });
    assert.equal(parsed.interrupted, undefined);
    assert.equal(parsed.skipped, undefined);
    assert.equal(parsed.failed, undefined);

    await Promise.all([first.completed, second.completed]);
  }, "orchestrator-cli-interrupt-compact-");
});
