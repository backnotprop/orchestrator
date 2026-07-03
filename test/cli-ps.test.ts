import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { AGENT_CONTROL_PREVIEW_MAX_BYTES } from "@backnotprop/orchestrator-core";
import type { AgentTaskRecord } from "@backnotprop/orchestrator-core";
import { launchTask } from "@backnotprop/orchestrator-core/tasks";
import {
  assertOneJsonLine,
  cliPath,
  orchestratorPlan,
  runCli,
  shellPlan,
  waitForChildExit,
  waitForTaskStatus,
  waitForText,
  waitUntilRunning,
  withTempWorkspace,
} from "./cli-support.ts";

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

test("CLI ps displays actionable unique task id prefixes", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "printf done";
    const first = await launchTask({
      workspaceRoot,
      taskId: "shared-prefix-alpha-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "shared alpha",
    });
    const second = await launchTask({
      workspaceRoot,
      taskId: "shared-prefix-beta-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "shared beta",
    });
    await Promise.all([first.completed, second.completed]);

    const text = await runCli(workspaceRoot, ["ps", "--workspace", workspaceRoot, "--all"]);
    assert.match(text.stdout, /shared-prefix-a/);
    assert.match(text.stdout, /shared-prefix-b/);
    assert.doesNotMatch(text.stdout, / shared-prefix\s*$/m);

    const json = await runCli(workspaceRoot, [
      "ps",
      "--workspace",
      workspaceRoot,
      "--all",
      "--json",
    ]);
    const view = JSON.parse(json.stdout) as {
      rows: Array<{ taskId: string; shortTaskId: string }>;
    };
    const firstRow = view.rows.find((row) => row.taskId === first.task.taskId);
    const secondRow = view.rows.find((row) => row.taskId === second.task.taskId);
    assert.equal(firstRow?.shortTaskId, "shared-prefix-a");
    assert.equal(secondRow?.shortTaskId, "shared-prefix-b");
  }, "orchestrator-cli-ps-unique-prefixes-");
});

test("CLI ps exposes compact machine-control JSON", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const runningCommand = 'node -e "setTimeout(() => {}, 60000)"';
    const doneCommand = "printf done";
    const configPath = `${workspaceRoot}/orchestrator.config.json`;
    await writeFile(configPath, `${JSON.stringify({ agents: {} }, null, 2)}\n`);
    const parent = await launchTask({
      workspaceRoot,
      taskId: "compact-parent-00000001",
      plan: orchestratorPlan(runningCommand, workspaceRoot),
      name: "repo plan",
    });
    const child = await launchTask({
      workspaceRoot,
      taskId: "compact-child-running-00000001",
      plan: shellPlan(runningCommand, workspaceRoot),
      name: "inspect api",
      parent: {
        parentRunId: parent.task.taskId,
        parentTaskId: parent.task.taskId,
      },
    });
    const doneChild = await launchTask({
      workspaceRoot,
      taskId: "compact-child-done-00000001",
      plan: shellPlan(doneCommand, workspaceRoot),
      name: "done child",
      parent: {
        parentRunId: parent.task.taskId,
        parentTaskId: parent.task.taskId,
      },
    });

    await doneChild.completed;
    await Promise.all([
      waitUntilRunning(workspaceRoot, parent.task.taskId),
      waitUntilRunning(workspaceRoot, child.task.taskId),
    ]);

    try {
      await runCli(workspaceRoot, ["ps", "--workspace", workspaceRoot, "--compact"]);
      assert.fail("Expected ps --compact without --json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      assert.match(stderr, /--compact requires --json/);
    }

    try {
      await runCli(workspaceRoot, ["ps", "--workspace", workspaceRoot, "--active", "--json"]);
      assert.fail("Expected ps --active without --compact to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        error: { message: string; reason?: string; input?: string; hint?: string };
      };
      assert.match(parsed.error.message, /ps --active requires --compact/);
      assert.equal(parsed.error.reason, "missing_required_option");
      assert.equal(parsed.error.input, "--active");
      assert.match(parsed.error.hint ?? "", /ps --json --compact --active/);
    }

    try {
      const compactOutput = await runCli(workspaceRoot, [
        "ps",
        "--workspace",
        workspaceRoot,
        "--json",
        "--compact",
        "--active",
      ]);
      assertOneJsonLine(compactOutput.stdout);
      assert.doesNotMatch(compactOutput.stdout, /"rows"/);
      assert.doesNotMatch(compactOutput.stdout, /"taskDir"/);

      const compact = JSON.parse(compactOutput.stdout) as {
        schemaVersion: number;
        summary: {
          tasks: number;
          active: number;
          done: number;
          failed: number;
          stopped: number;
          timedOut: number;
        };
        commands: {
          read: { args: string[] };
          readPreview: { args: string[] };
          wait: { args: string[] };
          waitPreview: { args: string[] };
        };
        groups: Array<{
          id: string;
          groupId: string;
          label: string;
          active: number;
          commands: {
            ps: { args: string[] };
            activePs: { args: string[] };
            read: { args: string[] };
            readPreview: { args: string[] };
            wait: { args: string[] };
            waitPreview: { args: string[] };
          };
          stop?: { kind: string; id: string; groupId?: string; args?: string[] };
        }>;
        stop?: { kind: string; ids?: string[]; args?: string[] };
        tasks: Array<{
          id: string;
          taskId: string;
          groupId: string;
          group: string;
          name: string;
          runtime: string;
          status: string;
          active: boolean;
          location?: { kind: string; workspaceRoot?: string; cwd?: string };
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
          stop?: { kind: string; id: string; taskId?: string; args?: string[] };
        }>;
      };

      const parentGroupId = compact.groups[0]?.id;
      assert.ok(parentGroupId);
      assert.equal(compact.schemaVersion, 1);
      assert.deepEqual(compact.summary, {
        tasks: 2,
        active: 2,
        done: 0,
        failed: 0,
        stopped: 0,
        timedOut: 0,
      });
      const compactTaskIds = compact.tasks.map((task) => task.id);
      assert.deepEqual(compact.stop, {
        kind: "group",
        id: parentGroupId,
        groupId: parent.task.taskId,
        args: ["interrupt", "--group", parentGroupId, "--json", "--compact"],
      });
      assert.equal(parentGroupId, parent.task.taskId.slice(0, 8));
      assert.equal(compact.groups[0]?.groupId, parent.task.taskId);
      assert.equal(compact.groups[0]?.label, "repo plan");
      assert.equal(compact.groups[0]?.active, 2);
      assert.deepEqual(compact.groups[0]?.commands.ps.args, [
        "ps",
        "--parent",
        parentGroupId,
        "--json",
        "--compact",
        "--workspace",
        workspaceRoot,
      ]);
      assert.deepEqual(compact.groups[0]?.commands.activePs.args, [
        "ps",
        "--parent",
        parentGroupId,
        "--json",
        "--compact",
        "--active",
        "--workspace",
        workspaceRoot,
      ]);
      assert.deepEqual(compact.groups[0]?.commands.readPreview.args, [
        "read",
        ...compactTaskIds,
        "--max-bytes",
        String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
        "--json",
        "--compact",
      ]);
      assert.deepEqual(compact.groups[0]?.commands.waitPreview.args, [
        "read",
        ...compactTaskIds,
        "--wait",
        "--timeout-ms",
        "300000",
        "--max-bytes",
        String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
        "--json",
        "--compact",
      ]);
      assert.deepEqual(compact.groups[0]?.stop, {
        kind: "group",
        id: parentGroupId,
        groupId: parent.task.taskId,
        args: ["interrupt", "--group", parentGroupId, "--json", "--compact"],
      });
      assert.deepEqual(
        compact.tasks.map((task) => task.name),
        ["repo plan", "inspect api"],
      );
      assert.ok(compact.tasks.every((task) => task.active));
      assert.deepEqual(compact.commands.read.args, ["read", ...compactTaskIds, "--json"]);
      assert.deepEqual(compact.commands.readPreview.args, [
        "read",
        ...compactTaskIds,
        "--max-bytes",
        String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
        "--json",
        "--compact",
      ]);
      assert.deepEqual(compact.commands.wait.args, [
        "read",
        ...compactTaskIds,
        "--wait",
        "--timeout-ms",
        "300000",
        "--json",
      ]);
      assert.deepEqual(compact.commands.waitPreview.args, [
        "read",
        ...compactTaskIds,
        "--wait",
        "--timeout-ms",
        "300000",
        "--max-bytes",
        String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
        "--json",
        "--compact",
      ]);
      assert.deepEqual(compact.tasks[0]?.commands.read.args, [
        "read",
        compact.tasks[0]?.id,
        "--json",
      ]);
      assert.deepEqual(compact.tasks[0]?.commands.readPreview.args, [
        "read",
        compact.tasks[0]?.id,
        "--max-bytes",
        String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
        "--json",
        "--compact",
      ]);
      assert.deepEqual(compact.tasks[0]?.commands.wait.args, [
        "read",
        compact.tasks[0]?.id,
        "--wait",
        "--timeout-ms",
        "300000",
        "--json",
      ]);
      assert.deepEqual(compact.tasks[0]?.commands.waitPreview.args, [
        "read",
        compact.tasks[0]?.id,
        "--wait",
        "--timeout-ms",
        "300000",
        "--max-bytes",
        String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
        "--json",
        "--compact",
      ]);
      assert.deepEqual(compact.tasks[0]?.commands.watch.args, [
        "watch",
        compact.tasks[0]?.id,
        "--json",
      ]);
      assert.deepEqual(compact.tasks[0]?.commands.logsPreview.args, [
        "logs",
        compact.tasks[0]?.id,
        "--max-bytes",
        String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
        "--json",
        "--compact",
      ]);
      assert.deepEqual(compact.tasks[0]?.commands.agentWatch.args, [
        "watch",
        compact.tasks[0]?.id,
        "--agent-only",
        "--json",
      ]);
      assert.deepEqual(compact.tasks[0]?.commands.logs.args, [
        "logs",
        compact.tasks[0]?.id,
        "--json",
        "--compact",
      ]);
      assert.deepEqual(compact.tasks[0]?.commands.events.args, [
        "events",
        compact.tasks[0]?.id,
        "--json",
        "--compact",
      ]);
      assert.deepEqual(compact.tasks[0]?.commands.agentEvents.args, [
        "events",
        compact.tasks[0]?.id,
        "--agent-only",
        "--json",
        "--compact",
      ]);
      assert.equal(compact.tasks[0]?.location?.kind, "local");
      assert.equal(compact.tasks[0]?.location?.workspaceRoot, workspaceRoot);
      assert.equal(compact.tasks[0]?.location?.cwd, workspaceRoot);
      assert.equal(compact.tasks[0]?.stop?.kind, "parent");
      assert.equal(compact.tasks[0]?.stop?.taskId, parent.task.taskId);
      assert.deepEqual(compact.tasks[0]?.stop?.args, [
        "interrupt",
        compact.tasks[0]?.id,
        "--children",
        "--json",
        "--compact",
      ]);

      const configScopedOutput = await runCli(workspaceRoot, [
        "ps",
        "--workspace",
        workspaceRoot,
        "--config",
        configPath,
        "--json",
        "--compact",
        "--active",
      ]);
      const configScoped = JSON.parse(configScopedOutput.stdout) as {
        groups: Array<{
          commands: {
            ps: { args: string[] };
            activePs: { args: string[] };
          };
        }>;
      };
      assert.deepEqual(configScoped.groups[0]?.commands.ps.args, [
        "ps",
        "--parent",
        parentGroupId,
        "--json",
        "--compact",
        "--workspace",
        workspaceRoot,
        "--config",
        configPath,
      ]);
      assert.deepEqual(configScoped.groups[0]?.commands.activePs.args, [
        "ps",
        "--parent",
        parentGroupId,
        "--json",
        "--compact",
        "--active",
        "--workspace",
        workspaceRoot,
        "--config",
        configPath,
      ]);

      const runtimeFiltered = await runCli(workspaceRoot, [
        "ps",
        "--workspace",
        workspaceRoot,
        "--runtime",
        "shell",
        "--json",
        "--compact",
        "--active",
      ]);
      const runtimeCompact = JSON.parse(runtimeFiltered.stdout) as {
        stop?: { kind: string; id?: string; taskId?: string; args?: string[] };
        tasks: Array<{
          id: string;
          taskId: string;
          groupId: string;
          group: string;
          name: string;
          runtime: string;
          active: boolean;
          stop?: { kind: string; taskId?: string };
        }>;
      };
      assert.equal(runtimeCompact.tasks.length, 1);
      assert.match(runtimeCompact.tasks[0]?.id ?? "", /^compact-child-r/);
      assert.equal(runtimeCompact.tasks[0]?.taskId, child.task.taskId);
      assert.equal(runtimeCompact.tasks[0]?.groupId, parent.task.taskId);
      assert.equal(runtimeCompact.tasks[0]?.group, parentGroupId);
      assert.equal(runtimeCompact.tasks[0]?.name, "inspect api");
      assert.equal(runtimeCompact.tasks[0]?.runtime, "shell");
      assert.equal(runtimeCompact.tasks[0]?.active, true);
      assert.equal(runtimeCompact.tasks[0]?.stop?.kind, "task");
      assert.equal(runtimeCompact.tasks[0]?.stop?.taskId, child.task.taskId);
      assert.deepEqual(runtimeCompact.stop, {
        kind: "task",
        id: runtimeCompact.tasks[0]?.id,
        taskId: child.task.taskId,
        args: ["interrupt", runtimeCompact.tasks[0]?.id, "--json", "--compact"],
      });

      const briefFiltered = await runCli(workspaceRoot, [
        "ps",
        "--workspace",
        workspaceRoot,
        "--json",
        "--compact",
        "--active",
        "--brief",
      ]);
      const briefCompact = JSON.parse(briefFiltered.stdout) as {
        commands: {
          waitPreview: { args: string[] };
        };
        groups: Array<{ commands?: unknown; stop?: { kind: string } }>;
        stop?: { kind: string; id?: string; groupId?: string; args?: string[] };
        tasks: Array<{
          id: string;
          taskId: string;
          active: boolean;
          commands?: unknown;
          stop?: { kind: string; taskId?: string; args?: string[] };
        }>;
      };
      assert.equal(briefCompact.groups[0]?.commands, undefined);
      assert.equal(briefCompact.groups[0]?.stop?.kind, "group");
      assert.equal(briefCompact.tasks.length, 2);
      assert.ok(briefCompact.tasks.every((task) => task.active));
      assert.ok(briefCompact.tasks.every((task) => task.commands === undefined));
      assert.deepEqual(briefCompact.stop, {
        kind: "group",
        id: parentGroupId,
        groupId: parent.task.taskId,
        args: ["interrupt", "--group", parentGroupId, "--json", "--compact"],
      });
      assert.deepEqual(briefCompact.commands.waitPreview.args, [
        "read",
        ...briefCompact.tasks.map((task) => task.id),
        "--wait",
        "--timeout-ms",
        "300000",
        "--max-bytes",
        String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
        "--json",
        "--compact",
      ]);
      assert.deepEqual(briefCompact.tasks[0]?.stop?.args, [
        "interrupt",
        briefCompact.tasks[0]?.id,
        "--children",
        "--json",
        "--compact",
      ]);

      const parentFiltered = await runCli(workspaceRoot, [
        "ps",
        "--workspace",
        workspaceRoot,
        "--parent",
        parentGroupId,
        "--json",
        "--compact",
      ]);
      const parentCompact = JSON.parse(parentFiltered.stdout) as {
        summary: {
          tasks: number;
          active: number;
          done: number;
          failed: number;
          stopped: number;
          timedOut: number;
        };
        stop?: { kind: string; id?: string; groupId?: string; args?: string[] };
        tasks: Array<{ id: string; taskId: string; active: boolean }>;
      };
      assert.deepEqual(parentCompact.summary, {
        tasks: 3,
        active: 2,
        done: 1,
        failed: 0,
        stopped: 0,
        timedOut: 0,
      });
      assert.deepEqual(
        parentCompact.tasks.map((task) => task.taskId),
        [parent.task.taskId, child.task.taskId, doneChild.task.taskId],
      );
      assert.deepEqual(parentCompact.stop, {
        kind: "group",
        id: parentGroupId,
        groupId: parent.task.taskId,
        args: ["interrupt", "--group", parentGroupId, "--json", "--compact"],
      });
    } finally {
      await runCli(workspaceRoot, [
        "interrupt",
        "--workspace",
        workspaceRoot,
        "--group",
        parent.task.taskId,
        "--reason",
        "cleanup",
      ]).catch(() => undefined);
      await Promise.allSettled([parent.completed, child.completed]);
    }
  }, "orchestrator-cli-ps-compact-");
});

test("CLI ps --parent ambiguous prefixes are machine-readable", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 5000)"';
    const first = await launchTask({
      workspaceRoot,
      taskId: "ps-parent-ambiguous-00000001",
      plan: orchestratorPlan(command, workspaceRoot),
      name: "ambiguous parent one",
    });
    const second = await launchTask({
      workspaceRoot,
      taskId: "ps-parent-ambiguous-00000002",
      plan: orchestratorPlan(command, workspaceRoot),
      name: "ambiguous parent two",
    });

    await Promise.all([
      waitUntilRunning(workspaceRoot, first.task.taskId),
      waitUntilRunning(workspaceRoot, second.task.taskId),
    ]);

    try {
      try {
        await runCli(workspaceRoot, [
          "ps",
          "--workspace",
          workspaceRoot,
          "--parent",
          "ps-parent-ambiguous",
          "--json",
          "--compact",
          "--active",
        ]);
        assert.fail("Expected ambiguous ps --parent --json to fail.");
      } catch (error) {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          schemaVersion: number;
          error: {
            name: string;
            reason?: string;
            input?: string;
            matches?: string[];
            hint?: string;
          };
          recovery?: {
            views: {
              active: { args: string[] };
              recent: { args: string[] };
              all: { args: string[] };
            };
          };
        };
        assert.equal(parsed.schemaVersion, 1);
        assert.equal(parsed.error.name, "CliError");
        assert.equal(parsed.error.reason, "ambiguous_group");
        assert.equal(parsed.error.input, "ps-parent-ambiguous");
        assert.deepEqual(parsed.error.matches, [first.task.taskId, second.task.taskId]);
        assert.match(parsed.error.hint ?? "", /ps --json --compact --brief/);
        assert.match(parsed.error.hint ?? "", /ps --json --compact --active/);
        assert.match(parsed.error.hint ?? "", /ps --all --json --compact/);
        assert.deepEqual(parsed.recovery?.views.active.args, [
          "ps",
          "--json",
          "--compact",
          "--active",
          "--brief",
          "--workspace",
          workspaceRoot,
        ]);
        assert.deepEqual(parsed.recovery?.views.recent.args, [
          "ps",
          "--json",
          "--compact",
          "--brief",
          "--workspace",
          workspaceRoot,
        ]);
        assert.deepEqual(parsed.recovery?.views.all.args, [
          "ps",
          "--all",
          "--json",
          "--compact",
          "--brief",
          "--workspace",
          workspaceRoot,
        ]);
      }
    } finally {
      await Promise.allSettled([
        runCli(workspaceRoot, [
          "interrupt",
          first.task.taskId,
          "--workspace",
          workspaceRoot,
          "--reason",
          "cleanup",
        ]),
        runCli(workspaceRoot, [
          "interrupt",
          second.task.taskId,
          "--workspace",
          workspaceRoot,
          "--reason",
          "cleanup",
        ]),
      ]);
      await Promise.allSettled([first.completed, second.completed]);
    }
  }, "orchestrator-cli-ps-parent-ambiguous-");
});

test("CLI compact ps ids remain usable when old hidden tasks share prefixes", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const doneCommand = "printf old";
    const runningCommand = 'node -e "setTimeout(() => {}, 5000)"';
    const old = await launchTask({
      workspaceRoot,
      taskId: "collision-old-00000001",
      plan: shellPlan(doneCommand, workspaceRoot),
      name: "old hidden collision",
    });
    const oldDone = await old.completed;
    const oldRecord = JSON.parse(await readFile(oldDone.paths.taskJson, "utf8")) as AgentTaskRecord;
    await writeFile(
      oldDone.paths.taskJson,
      `${JSON.stringify(
        {
          ...oldRecord,
          createdAt: "2026-06-19T00:00:00.000Z",
          startedAt: "2026-06-19T00:00:00.000Z",
          finishedAt: "2026-06-19T00:00:01.000Z",
        },
        null,
        2,
      )}\n`,
    );

    const active = await launchTask({
      workspaceRoot,
      taskId: "collision-active-00000001",
      plan: shellPlan(runningCommand, workspaceRoot),
      name: "active collision",
    });

    await waitUntilRunning(workspaceRoot, active.task.taskId);
    try {
      const compactOutput = await runCli(workspaceRoot, [
        "ps",
        "--workspace",
        workspaceRoot,
        "--json",
        "--compact",
        "--active",
      ]);
      const compact = JSON.parse(compactOutput.stdout) as {
        tasks: Array<{ id: string; taskId: string; stop?: { id: string } }>;
      };
      const task = compact.tasks.find((item) => item.taskId === active.task.taskId);
      assert.equal(task?.id, "collision-a");
      assert.equal(task?.stop?.id, "collision-a");

      const interrupted = await runCli(workspaceRoot, [
        "interrupt",
        task?.stop?.id ?? "",
        "--workspace",
        workspaceRoot,
        "--json",
      ]);
      const parsed = JSON.parse(interrupted.stdout) as {
        interrupted: Array<{ taskId: string; id: string; stopRequestedAt?: string }>;
      };
      assert.equal(parsed.interrupted.length, 1);
      assert.deepEqual(parsed.interrupted[0], {
        taskId: active.task.taskId,
        id: "collision-a",
        name: "active collision",
        runtime: "shell",
        status: "running",
        state: "stopping",
        stopRequestedAt: parsed.interrupted[0]?.stopRequestedAt,
        stopReason: "Interrupted.",
        stopSignal: "SIGTERM",
      });
      assert.ok(parsed.interrupted[0]?.stopRequestedAt);
    } finally {
      await runCli(workspaceRoot, [
        "interrupt",
        active.task.taskId,
        "--workspace",
        workspaceRoot,
        "--reason",
        "cleanup",
      ]).catch(() => undefined);
      await active.completed;
    }
  }, "orchestrator-cli-compact-hidden-collision-");
});

test("CLI ps --watch refreshes the grouped operations view while a task runs", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 3000)"';
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "watch group",
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

test("CLI ps --watch streams compact JSON frames", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 700)"';
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "watch compact",
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
        "--json",
        "--compact",
        "--active",
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
      await waitForText(() => stdout, /"schemaVersion":1[\s\S]*"active":1/);
    } finally {
      child.kill("SIGTERM");
      await waitForChildExit(child);
    }

    assert.equal(stderr, "");
    const firstFrame = JSON.parse(stdout.trim().split("\n")[0] ?? "") as {
      schemaVersion: number;
      tasks: Array<{
        id: string;
        taskId: string;
        groupId: string;
        group: string;
        name: string;
        runtime: string;
        active: boolean;
        stop?: { kind: string; taskId?: string };
      }>;
    };
    assert.equal(firstFrame.schemaVersion, 1);
    assert.equal(firstFrame.tasks.length, 1);
    assert.equal(firstFrame.tasks[0]?.id, launched.taskId.slice(0, 8));
    assert.equal(firstFrame.tasks[0]?.taskId, launched.taskId);
    assert.equal(firstFrame.tasks[0]?.groupId, "ungrouped");
    assert.equal(firstFrame.tasks[0]?.group, "ungrouped");
    assert.equal(firstFrame.tasks[0]?.name, "watch compact");
    assert.equal(firstFrame.tasks[0]?.runtime, "shell");
    assert.equal(firstFrame.tasks[0]?.active, true);
    assert.equal(firstFrame.tasks[0]?.stop?.kind, "task");
    assert.equal(firstFrame.tasks[0]?.stop?.taskId, launched.taskId);

    await waitForTaskStatus(workspaceRoot, launched.taskId, "succeeded");
  }, "orchestrator-cli-ps-watch-compact-");
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
