import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAgentLaunchPlan } from "@backnotprop/orchestrator-core/runtime";
import type { AgentLaunchPlan } from "@backnotprop/orchestrator-core/runtime";
import {
  TaskSupervisorError,
  buildAgentTaskPsView,
  interruptTask,
  launchTask,
  listTasks,
  readTaskOutput,
  waitForTask,
} from "@backnotprop/orchestrator-core/tasks";

type PersistedTaskEvent = {
  seq: number;
  type: string;
  data: Record<string, unknown>;
};

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

async function withTempWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "orchestrator-test-"));
  try {
    return await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function shellPlan(command: string, cwd: string) {
  return buildAgentLaunchPlan({
    runtime: "shell",
    task: command,
    cwd,
    allowDisabledRuntime: true,
  });
}

function jsonlFixturePlan(input: {
  runtime: "claude-code" | "codex";
  fixturePath: string;
  cwd: string;
}): AgentLaunchPlan {
  const command = `cat ${quoteShellArg(input.fixturePath)}`;
  return jsonlCommandPlan({
    runtime: input.runtime,
    command,
    cwd: input.cwd,
  });
}

function jsonlCommandPlan(input: {
  runtime: "claude-code" | "codex";
  command: string;
  cwd: string;
}): AgentLaunchPlan {
  return {
    runtime: input.runtime,
    displayName: input.runtime,
    executable: "sh",
    args: ["-lc", input.command],
    env: {},
    cwd: input.cwd,
    promptTransport: { kind: "argv", position: "last" },
    outputTransport: {
      kind: "jsonl_events",
      finalEvent: input.runtime === "claude-code" ? "result" : "turn.completed",
    },
    expectedProcesses: ["sh"],
    interrupt: "process_group",
    canSteerRunning: false,
    handlesOwnAuth: false,
    enabled: true,
    safety: {
      requiresAllowlist: false,
      acceptsShellCommand: false,
    },
  };
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readTaskEvents(path: string): Promise<PersistedTaskEvent[]> {
  const raw = await readFile(path, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  return trimmed.split("\n").map((line) => JSON.parse(line) as PersistedTaskEvent);
}

test("launchTask creates task files, runs allowlisted shell command, and captures output", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "echo hello";
    const plan = shellPlan(command, workspaceRoot);

    const handle = await launchTask({
      workspaceRoot,
      plan,
      name: "  hello   task  ",
      allowedShellCommands: [command],
    });

    assert.equal(handle.task.status, "starting");
    assert.equal(handle.task.runtime, "shell");
    assert.equal(handle.task.name, "hello task");

    const completed = await handle.completed;
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.exitCode, 0);
    assert.equal(completed.name, "hello task");

    const taskDir = join(workspaceRoot, ".orchestrator", "tasks", completed.taskId);
    assert.equal(completed.paths.taskDir, taskDir);
    await stat(join(taskDir, "task.json"));
    await stat(join(taskDir, "stdout.log"));
    await stat(join(taskDir, "stderr.log"));
    await stat(join(taskDir, "events.jsonl"));
    await stat(join(taskDir, "transcript.jsonl"));
    await stat(join(taskDir, "result.md"));
    await stat(join(taskDir, "artifacts"));

    const stdout = await readFile(completed.paths.stdoutLog, "utf8");
    assert.equal(stdout, "hello\n");
    assert.equal(await readTaskOutput({ workspaceRoot, taskId: completed.taskId }), "hello\n");

    const taskJson = JSON.parse(await readFile(completed.paths.taskJson, "utf8"));
    assert.equal(taskJson.status, "succeeded");
    assert.equal(taskJson.name, "hello task");
    assert.equal(taskJson.runtime, "shell");
    assert.equal(taskJson.launchPlan.executable, "sh");
    assert.deepEqual(taskJson.launchPlan.args, ["-lc", command]);

    const events = await readTaskEvents(completed.paths.eventsJsonl);
    assert.ok(events.some((event) => event.type === "queued"));
    assert.ok(events.some((event) => event.type === "running"));
    assert.ok(events.some((event) => event.type === "stdout"));
    assert.ok(events.some((event) => event.type === "completed"));

    const tasks = await listTasks({ workspaceRoot });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.taskId, completed.taskId);
    assert.equal(tasks[0]?.name, "hello task");
  });
});

test("launchTask persists parent metadata and ps groups child tasks by parent run", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "printf grouped-ok";
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan(command, workspaceRoot),
      name: "grouped child",
      model: "glm-5.2",
      parent: {
        parentRunId: "3133aaea-a17e-4094-b9df-67a77dc87437",
        parentSessionId: "session-123",
        parentToolCallId: "tool-call-123",
      },
      allowedShellCommands: [command],
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.model, "glm-5.2");
    assert.deepEqual(completed.parent, {
      parentRunId: "3133aaea-a17e-4094-b9df-67a77dc87437",
      parentSessionId: "session-123",
      parentToolCallId: "tool-call-123",
    });

    const events = await readTaskEvents(completed.paths.eventsJsonl);
    assert.ok(
      events.some(
        (event) =>
          event.type === "agent_event" &&
          event.data.kind === "task.parent" &&
          event.data.parentRunId === "3133aaea-a17e-4094-b9df-67a77dc87437",
      ),
    );

    const view = await buildAgentTaskPsView({ workspaceRoot });
    assert.equal(view.groups.length, 1);
    assert.equal(view.groups[0]?.parentRunId, "3133aaea-a17e-4094-b9df-67a77dc87437");
    assert.equal(view.groups[0]?.label, "3133aaea");
    assert.equal(view.groups[0]?.rows[0]?.name, "grouped child");
    assert.equal(view.groups[0]?.rows[0]?.model, "glm-5.2");
    assert.equal(view.groups[0]?.rows[0]?.parentToolCallId, "tool-call-123");
  });
});

test("ps groups managed parent tasks with their child tasks by parent task id", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const parentCommand = "printf parent-ok";
    const childCommand = "printf child-ok";
    const parentHandle = await launchTask({
      workspaceRoot,
      plan: {
        ...shellPlan(parentCommand, workspaceRoot),
        runtime: "orchestrator",
        displayName: "Orchestrator",
      },
      taskId: "parent-task-12345678",
      name: "parent run",
      allowedShellCommands: [parentCommand],
    });
    const childHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan(childCommand, workspaceRoot),
      name: "child run",
      parent: {
        parentRunId: "parent-run-12345678",
        parentTaskId: "parent-task-12345678",
        parentSessionId: "session-123",
        parentToolCallId: "tool-call-123",
      },
      allowedShellCommands: [childCommand],
    });

    await parentHandle.completed;
    await childHandle.completed;

    const view = await buildAgentTaskPsView({ workspaceRoot });
    assert.equal(view.groups.length, 1);
    assert.equal(view.groups[0]?.groupId, "parent-task-12345678");
    assert.equal(view.groups[0]?.label, "parent-t");
    assert.equal(view.groups[0]?.parentTaskId, "parent-task-12345678");
    assert.deepEqual(view.groups[0]?.rows.map((row) => row.name).sort(), [
      "child run",
      "parent run",
    ]);
    assert.equal(
      view.rows.find((row) => row.name === "child run")?.parentTaskId,
      "parent-task-12345678",
    );
  });
});

test("ps hides old finished tasks by default and keeps them with all", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const oldCommand = "printf old-ok";
    const recentCommand = "printf recent-ok";
    const oldFailureCommand = "exit 2";
    const recentFailureCommand = "exit 3";
    const oldHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan(oldCommand, workspaceRoot),
      name: "old done",
      allowedShellCommands: [oldCommand],
    });
    const recentHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan(recentCommand, workspaceRoot),
      name: "recent done",
      allowedShellCommands: [recentCommand],
    });
    const oldFailureHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan(oldFailureCommand, workspaceRoot),
      name: "old failed",
      allowedShellCommands: [oldFailureCommand],
    });
    const recentFailureHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan(recentFailureCommand, workspaceRoot),
      name: "recent failed",
      allowedShellCommands: [recentFailureCommand],
    });

    const oldCompleted = await oldHandle.completed;
    const recentCompleted = await recentHandle.completed;
    const oldFailure = await oldFailureHandle.completed;
    const recentFailure = await recentFailureHandle.completed;
    const oldTask = JSON.parse(await readFile(oldCompleted.paths.taskJson, "utf8"));
    const recentTask = JSON.parse(await readFile(recentCompleted.paths.taskJson, "utf8"));
    const oldFailureTask = JSON.parse(await readFile(oldFailure.paths.taskJson, "utf8"));
    const recentFailureTask = JSON.parse(await readFile(recentFailure.paths.taskJson, "utf8"));
    await writeFile(
      oldCompleted.paths.taskJson,
      `${JSON.stringify(
        {
          ...oldTask,
          createdAt: "2026-06-18T00:00:00.000Z",
          startedAt: "2026-06-18T00:00:01.000Z",
          finishedAt: "2026-06-18T00:00:02.000Z",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      recentCompleted.paths.taskJson,
      `${JSON.stringify(
        {
          ...recentTask,
          createdAt: "2026-06-18T02:59:00.000Z",
          startedAt: "2026-06-18T02:59:01.000Z",
          finishedAt: "2026-06-18T02:59:02.000Z",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      oldFailure.paths.taskJson,
      `${JSON.stringify(
        {
          ...oldFailureTask,
          createdAt: "2026-06-18T00:01:00.000Z",
          startedAt: "2026-06-18T00:01:01.000Z",
          finishedAt: "2026-06-18T00:01:02.000Z",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      recentFailure.paths.taskJson,
      `${JSON.stringify(
        {
          ...recentFailureTask,
          createdAt: "2026-06-18T02:58:00.000Z",
          startedAt: "2026-06-18T02:58:01.000Z",
          finishedAt: "2026-06-18T02:58:02.000Z",
        },
        null,
        2,
      )}\n`,
    );

    const now = new Date("2026-06-18T03:00:00.000Z");
    const defaultView = await buildAgentTaskPsView({ workspaceRoot, now });
    assert.deepEqual(
      defaultView.rows.map((row) => row.taskId),
      [recentFailure.taskId, recentCompleted.taskId],
    );

    const allView = await buildAgentTaskPsView({ workspaceRoot, now, all: true });
    assert.deepEqual(
      allView.rows.map((row) => row.taskId),
      [recentFailure.taskId, oldFailure.taskId, recentCompleted.taskId, oldCompleted.taskId],
    );
  });
});

test("ps sorts active tasks before failed tasks and succeeded tasks", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const successCommand = "printf success";
    const failureCommand = "exit 2";
    const runningCommand = "sleep 1; printf running";
    const successHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan(successCommand, workspaceRoot),
      name: "succeeded child",
      allowedShellCommands: [successCommand],
    });
    const failureHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan(failureCommand, workspaceRoot),
      name: "failed child",
      allowedShellCommands: [failureCommand],
    });
    const runningHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan(runningCommand, workspaceRoot),
      name: "running child",
      allowedShellCommands: [runningCommand],
    });

    await successHandle.completed;
    await failureHandle.completed;

    const view = await buildAgentTaskPsView({ workspaceRoot });
    assert.deepEqual(
      view.rows.map((row) => row.name),
      ["running child", "failed child", "succeeded child"],
    );

    await runningHandle.completed;
  });
});

test("waitForTask emits progress after the progress interval", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'sleep 0.15; printf "done\\n"';
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan(command, workspaceRoot),
      allowedShellCommands: [command],
    });
    const progressEvents: number[] = [];

    const result = await waitForTask({
      workspaceRoot,
      taskId: handle.task.taskId,
      timeoutMs: 5_000,
      intervalMs: 10,
      progressIntervalMs: 50,
      onProgress: (progress) => {
        progressEvents.push(progress.elapsedMs);
      },
    });

    assert.equal(result.retrievalStatus, "completed");
    assert.ok(progressEvents.length > 0);
    assert.ok(
      progressEvents[0] >= 40,
      `Expected first progress after interval, got ${progressEvents[0]}ms.`,
    );
    await handle.completed;
  });
});

test("launchTask rejects empty task names", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "echo nope";

    await assert.rejects(
      () =>
        launchTask({
          workspaceRoot,
          plan: shellPlan(command, workspaceRoot),
          name: "   ",
          allowedShellCommands: [command],
        }),
      /Task name must not be empty/,
    );
  });
});

test("launchTask normalizes Claude stream-json fixtures and extracts final result", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: jsonlFixturePlan({
        runtime: "claude-code",
        fixturePath: join(fixturesDir, "claude-stream-json.jsonl"),
        cwd: workspaceRoot,
      }),
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "succeeded");
    assert.equal(
      await readTaskOutput({ workspaceRoot, taskId: completed.taskId }),
      "fixture-claude-ok",
    );

    const transcript = await readFile(completed.paths.transcriptJsonl, "utf8");
    assert.match(transcript, /"type":"result"/);
    assert.match(transcript, /fixture-claude-ok/);

    const events = await readTaskEvents(completed.paths.eventsJsonl);
    const agentEvents = events.filter((event) => event.type === "agent_event");
    assert.ok(agentEvents.some((event) => event.data.kind === "agent.message"));
    assert.ok(agentEvents.some((event) => event.data.kind === "agent.result"));
  });
});

test("launchTask normalizes Codex exec JSONL fixtures and extracts final result", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: jsonlFixturePlan({
        runtime: "codex",
        fixturePath: join(fixturesDir, "codex-exec-jsonl.jsonl"),
        cwd: workspaceRoot,
      }),
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "succeeded");
    assert.equal(
      await readTaskOutput({ workspaceRoot, taskId: completed.taskId }),
      "fixture-codex-ok",
    );

    const transcript = await readFile(completed.paths.transcriptJsonl, "utf8");
    assert.match(transcript, /"type":"thread.started"/);
    assert.match(transcript, /fixture-codex-ok/);

    const events = await readTaskEvents(completed.paths.eventsJsonl);
    const agentEvents = events.filter((event) => event.type === "agent_event");
    assert.ok(agentEvents.some((event) => event.data.kind === "thread.started"));
    assert.ok(agentEvents.some((event) => event.data.kind === "agent.message"));
    const usage = agentEvents.find((event) => event.data.kind === "agent.usage");
    assert.ok(usage);
    assert.deepEqual(usage.data.usage, {
      inputTokens: 16484,
      outputTokens: 31,
      cacheReadTokens: 10624,
      totalTokens: 16515,
    });
  });
});

test("ps derives legacy model values from launch args when task metadata is missing", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const plan = jsonlFixturePlan({
      runtime: "codex",
      fixturePath: join(fixturesDir, "codex-exec-jsonl.jsonl"),
      cwd: workspaceRoot,
    });
    const handle = await launchTask({
      workspaceRoot,
      plan: {
        ...plan,
        args: [...plan.args, "--model", "legacy-model"],
      },
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "succeeded");

    const view = await buildAgentTaskPsView({ workspaceRoot });
    assert.equal(view.rows[0]?.model, "legacy-model");
  });
});

test("launchTask promotes structured Codex provider errors into task.error", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const providerError = JSON.stringify({
      type: "error",
      message: JSON.stringify({
        type: "error",
        status: 400,
        error: {
          type: "invalid_request_error",
          message: "The model is not supported for this account.",
        },
      }),
    });
    const turnFailed = JSON.stringify({
      type: "turn.failed",
      error: {
        message: JSON.stringify({
          type: "error",
          status: 400,
          error: {
            type: "invalid_request_error",
            message: "The model is not supported for this account.",
          },
        }),
      },
    });
    const handle = await launchTask({
      workspaceRoot,
      plan: jsonlCommandPlan({
        runtime: "codex",
        command: `printf '%s\\n' ${quoteShellArg(providerError)} ${quoteShellArg(turnFailed)}; exit 1`,
        cwd: workspaceRoot,
      }),
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "failed");
    assert.equal(completed.error, "The model is not supported for this account.");

    const events = await readTaskEvents(completed.paths.eventsJsonl);
    assert.ok(
      events.some(
        (event) =>
          event.type === "agent_event" &&
          event.data.kind === "runtime.error" &&
          event.data.message === "The model is not supported for this account.",
      ),
    );

    const view = await buildAgentTaskPsView({ workspaceRoot });
    assert.equal(view.rows[0]?.status, "failed");
    assert.equal(view.rows[0]?.lastEvent, "runtime.error");
    assert.equal(view.rows[0]?.error, "The model is not supported for this account.");
  });
});

test("launchTask preserves intentionally empty structured final results", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const line = JSON.stringify({ type: "result", result: "" });
    const handle = await launchTask({
      workspaceRoot,
      plan: jsonlCommandPlan({
        runtime: "claude-code",
        command: `printf '%s\\n' ${quoteShellArg(line)}`,
        cwd: workspaceRoot,
      }),
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "succeeded");
    assert.equal(await readFile(completed.paths.stdoutLog, "utf8"), `${line}\n`);
    assert.equal(await readFile(completed.paths.resultMd, "utf8"), "");
    assert.equal(await readFile(completed.paths.transcriptJsonl, "utf8"), `${line}\n`);
  });
});

test("launchTask caps stored output at maxOutputBytes, including partial chunks", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "printf abcdef";
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan(command, workspaceRoot),
      allowedShellCommands: [command],
      maxOutputBytes: 3,
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "succeeded");
    assert.equal(await readFile(completed.paths.stdoutLog, "utf8"), "abc");
    assert.equal(await readTaskOutput({ workspaceRoot, taskId: completed.taskId }), "abc");
  });
});

test("launchTask refuses shell commands that are not explicitly allowlisted", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "echo nope";

    await assert.rejects(
      () =>
        launchTask({
          workspaceRoot,
          plan: shellPlan(command, workspaceRoot),
        }),
      TaskSupervisorError,
    );
  });
});

test("launchTask marks non-zero exit as failed and captures stderr", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "echo bad >&2; exit 7";
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan(command, workspaceRoot),
      allowedShellCommands: [command],
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "failed");
    assert.equal(completed.exitCode, 7);
    assert.equal(await readFile(completed.paths.stderrLog, "utf8"), "bad\n");
  });
});

test("launchTask marks spawn errors as failed", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "echo unreachable";
    const plan = {
      ...shellPlan(command, workspaceRoot),
      executable: "definitely-missing-orchestrator-test-command",
    };

    const handle = await launchTask({
      workspaceRoot,
      plan,
      allowedShellCommands: [command],
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "failed");
    assert.match(completed.error ?? "", /ENOENT|spawn/);

    const view = await buildAgentTaskPsView({ workspaceRoot });
    assert.equal(view.rows[0]?.lastEvent, "failed");
    assert.match(view.rows[0]?.error ?? "", /ENOENT|spawn/);
  });
});

test("launchTask enforces timeout and marks task timed_out", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 5000)"';
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan(command, workspaceRoot),
      allowedShellCommands: [command],
      timeoutMs: 50,
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "timed_out");
    assert.match(completed.error ?? "", /Timed out/);

    const persisted = (await listTasks({ workspaceRoot, status: "timed_out" }))[0];
    assert.equal(persisted?.taskId, completed.taskId);
  });
});

test("interruptTask cancels a running task", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 5000)"';
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan(command, workspaceRoot),
      allowedShellCommands: [command],
    });

    const interrupted = await interruptTask({
      workspaceRoot,
      taskId: handle.task.taskId,
      reason: "test cancellation",
    });

    assert.equal(interrupted.status, "cancelled");
    assert.equal(interrupted.error, "test cancellation");

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.error, "test cancellation");

    const events = await readTaskEvents(completed.paths.eventsJsonl);
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index + 1),
    );
    assert.ok(events.some((event) => event.type === "interrupt_requested"));
    assert.ok(events.some((event) => event.type === "cancelled"));
  });
});
