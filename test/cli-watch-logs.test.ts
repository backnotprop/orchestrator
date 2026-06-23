import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTaskRecord, TaskEvent } from "@backnotprop/orchestrator-core";
import { launchTask } from "@backnotprop/orchestrator-core/tasks";
import {
  customJsonlPlan,
  quoteShellArg,
  runCli,
  waitForCliStdout,
  waitForTaskStatus,
  waitUntilRunning,
  withTempWorkspace,
} from "./cli-support.ts";

test("CLI launch defaults cwd to --workspace when --cwd is not provided", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await withTempWorkspace(async (callerRoot) => {
      const command = "pwd";
      const launch = await runCli(callerRoot, [
        "launch",
        "shell",
        "--workspace",
        workspaceRoot,
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
      "--json",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
    const shortTaskId = launched.taskId.slice(0, 8);

    await waitUntilRunning(workspaceRoot, launched.taskId);
    const runningLogs = await waitForCliStdout(
      workspaceRoot,
      ["logs", shortTaskId, "--workspace", workspaceRoot, "--stream", "stdout"],
      /running-log/,
    );
    assert.match(runningLogs, /running-log/);

    const runningEvents = await runCli(workspaceRoot, [
      "events",
      shortTaskId,
      "--workspace",
      workspaceRoot,
    ]);
    assert.match(runningEvents.stdout, /"type":"running"/);

    const watch = await runCli(workspaceRoot, [
      "watch",
      shortTaskId,
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

test("CLI watch --json emits only parseable task events", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command =
      "node -e \"console.log('json-watch-out'); console.error('json-watch-err'); setTimeout(() => console.log('json-watch-done'), 150)\"";
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--json",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
    const shortTaskId = launched.taskId.slice(0, 8);

    await waitUntilRunning(workspaceRoot, launched.taskId);
    const watched = await runCli(workspaceRoot, [
      "watch",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--json",
      "--interval-ms",
      "10",
    ]);

    assert.equal(watched.stderr, "");
    assert.doesNotMatch(watched.stdout, /^json-watch-/m);
    const events = watched.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TaskEvent);
    assert.ok(events.some((event) => event.type === "stdout"));
    assert.ok(events.some((event) => event.type === "stderr"));
    assert.ok(events.some((event) => event.type === "completed"));

    const read = await runCli(workspaceRoot, [
      "read",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--json",
    ]);
    const result = JSON.parse(read.stdout) as { output: string };
    assert.match(result.output, /json-watch-out/);
    assert.match(result.output, /json-watch-done/);
  }, "orchestrator-cli-watch-json-events-only-");
});

test("CLI watch --agent-only --json streams only normalized agent events", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const firstLine = JSON.stringify({
      type: "message",
      message: "agent-only one",
      usage: { totalTokens: 11 },
    });
    const secondLine = JSON.stringify({
      type: "final",
      result: "agent-only done",
      usage: { totalTokens: 22 },
    });
    const command = `printf '%s\\n' ${quoteShellArg(firstLine)}; sleep 0.15; printf '%s\\n' ${quoteShellArg(secondLine)}`;
    const handle = await launchTask({
      workspaceRoot,
      plan: customJsonlPlan(command, workspaceRoot),
      name: "agent-only watch",
    });
    const shortTaskId = handle.task.taskId.slice(0, 8);

    const watched = await runCli(workspaceRoot, [
      "watch",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--agent-only",
      "--json",
      "--interval-ms",
      "10",
    ]);
    await handle.completed;

    assert.equal(watched.stderr, "");
    const events = watched.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TaskEvent);
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.type === "agent_event"));
    assert.ok(events.some((event) => event.data?.message === "agent-only one"));
    assert.ok(events.some((event) => event.data?.kind === "agent.result"));
  }, "orchestrator-cli-watch-agent-only-json-");
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
      "--json",
      command,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
    const shortTaskId = launched.taskId.slice(0, 8);

    await waitUntilRunning(workspaceRoot, launched.taskId);
    const followed = await runCli(workspaceRoot, [
      "logs",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--stream",
      "stdout",
      "--follow",
    ]);

    assert.match(followed.stdout, /follow-one/);
    assert.match(followed.stdout, /follow-two/);
    assert.equal(followed.stderr, "");

    await assert.rejects(
      () =>
        runCli(workspaceRoot, [
          "logs",
          shortTaskId,
          "--workspace",
          workspaceRoot,
          "--follow",
          "--json",
        ]),
      (error) => {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          error: { message: string; reason?: string; input?: string; hint?: string };
        };
        return (
          /logs --follow cannot be combined with --json/.test(parsed.error.message) &&
          parsed.error.reason === "incompatible_options" &&
          parsed.error.input === "--follow" &&
          /watch --json/.test(parsed.error.hint ?? "")
        );
      },
    );
  }, "orchestrator-cli-follow-");
});

test("CLI logs --follow --stream all preserves combined stdout and stderr order", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const script = [
      "process.stdout.write('out-one\\n')",
      "setTimeout(() => process.stderr.write('err-two\\n'), 50)",
      "setTimeout(() => process.stdout.write('out-three\\n'), 100)",
    ].join("; ");
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--wait",
      "--json",
      `node -e ${quoteShellArg(script)}`,
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
    const shortTaskId = launched.taskId.slice(0, 8);

    const followed = await runCli(workspaceRoot, [
      "logs",
      shortTaskId,
      "--workspace",
      workspaceRoot,
      "--stream",
      "all",
      "--follow",
    ]);

    assert.equal(followed.stdout, "out-one\nerr-two\nout-three\n");
    assert.equal(followed.stderr, "");
  }, "orchestrator-cli-follow-all-order-");
});
