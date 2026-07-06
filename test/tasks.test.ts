import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAgentLaunchPlan } from "@backnotprop/orchestrator-core/runtime";
import type { AgentLaunchPlan } from "@backnotprop/orchestrator-core/runtime";
import {
  AGENT_CONTROL_PREVIEW_MAX_BYTES,
  TaskLookupError,
  TaskGroupLookupError,
  TaskSupervisorSafetyError,
  buildAgentTaskPsView,
  compactAgentTaskPsView,
  captureProcessIdentity,
  interruptTask,
  interruptTasks,
  launchTask,
  listTaskIds,
  listTasks,
  observeTaskState,
  readTaskEvents as readTaskEventStream,
  readTaskLogs,
  readTaskRecord,
  readTaskOutput,
  resolveTaskId,
  taskDisplayState,
  writeTaskHeartbeat,
  type AgentTaskRecord,
  type AgentTaskPsView,
  waitForTask,
} from "@backnotprop/orchestrator-core/tasks";
import { markTaskLostForObservation, withTempWorkspace } from "./helpers.ts";

type PersistedTaskEvent = {
  seq: number;
  type: string;
  data: Record<string, unknown>;
};

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

function shellPlan(command: string, cwd: string) {
  return buildAgentLaunchPlan({
    runtime: "shell",
    task: command,
    cwd,
    allowDisabledRuntime: true,
  });
}

function orchestratorPlan(command: string, cwd: string): AgentLaunchPlan {
  return {
    ...shellPlan(command, cwd),
    runtime: "orchestrator",
    displayName: "Orchestrator",
  };
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
      acceptsShellCommand: false,
    },
  };
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function findDeadPid(): number {
  for (let pid = 999_999; pid > 900_000; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        return pid;
      }
    }
  }
  throw new Error("Could not find an unused pid for observation tests.");
}

function controlViewRow(taskId: string, name: string): AgentTaskPsView["rows"][number] {
  return {
    taskId,
    shortTaskId: taskId.slice(0, 8),
    name,
    status: "running",
    active: true,
    actionable: true,
    runtime: "orchestrator",
    cwd: "/tmp",
    workspaceRoot: "/tmp",
    createdAt: "2026-06-20T00:00:00.000Z",
    startedAt: "2026-06-20T00:00:00.000Z",
    ageMs: 0,
    durationMs: 0,
    taskDir: `/tmp/${taskId}`,
  };
}

function controlViewGroup(
  groupId: string,
  row: AgentTaskPsView["rows"][number],
): AgentTaskPsView["groups"][number] {
  return {
    groupId,
    label: groupId.slice(0, 8),
    parentTaskId: groupId,
    status: "running",
    total: 1,
    running: 1,
    succeeded: 0,
    failed: 0,
    stopped: 0,
    timedOut: 0,
    rows: [row],
  };
}

test("task store resolves unique task id prefixes", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const firstCommand = "printf first";
    const secondCommand = "printf second";
    const firstTaskId = "0ea6bbc9-0000-4000-8000-000000000001";
    const secondTaskId = "0ea91a52-0000-4000-8000-000000000002";

    const first = await launchTask({
      workspaceRoot,
      taskId: firstTaskId,
      plan: shellPlan(firstCommand, workspaceRoot),
    });
    const second = await launchTask({
      workspaceRoot,
      taskId: secondTaskId,
      plan: shellPlan(secondCommand, workspaceRoot),
    });

    await Promise.all([first.completed, second.completed]);

    assert.deepEqual(await listTaskIds({ workspaceRoot }), [firstTaskId, secondTaskId]);

    assert.equal(await resolveTaskId({ workspaceRoot }, firstTaskId), firstTaskId);
    assert.equal(await resolveTaskId({ workspaceRoot }, firstTaskId.slice(0, 8)), firstTaskId);
    assert.equal(await resolveTaskId({ workspaceRoot }, firstTaskId.slice(0, 5)), firstTaskId);

    const record = await readTaskRecord({ workspaceRoot }, firstTaskId.slice(0, 8));
    assert.equal(record.taskId, firstTaskId);
    assert.equal(await readTaskOutput({ workspaceRoot, taskId: firstTaskId.slice(0, 8) }), "first");

    const logs = await readTaskLogs({ workspaceRoot, taskId: firstTaskId.slice(0, 8) });
    assert.equal(logs.taskId, firstTaskId);
    assert.equal(logs.stdout, "first");
    assert.equal(logs.stderr, "");

    const events = await readTaskEventStream({ workspaceRoot, taskId: firstTaskId.slice(0, 8) });
    assert.ok(events.some((event) => event.type === "completed"));

    const waitResult = await waitForTask({
      workspaceRoot,
      taskId: firstTaskId.slice(0, 8),
      timeoutMs: 1_000,
    });
    assert.equal(waitResult.retrievalStatus, "completed");
    assert.equal(waitResult.task.taskId, firstTaskId);

    await assert.rejects(
      () => resolveTaskId({ workspaceRoot }, "deadbeef"),
      (error) =>
        error instanceof TaskLookupError &&
        error.reason === "not_found" &&
        /did not match/.test(error.message),
    );

    await assert.rejects(
      () => resolveTaskId({ workspaceRoot }, "0ea"),
      (error) =>
        error instanceof TaskLookupError &&
        error.reason === "ambiguous" &&
        error.matches.includes(firstTaskId) &&
        error.matches.includes(secondTaskId),
    );

    await assert.rejects(
      () => resolveTaskId({ workspaceRoot }, "../0ea6bbc9"),
      (error) =>
        error instanceof TaskLookupError &&
        error.reason === "invalid" &&
        /not a path/.test(error.message),
    );
  });
});

async function readTaskEvents(path: string): Promise<PersistedTaskEvent[]> {
  const raw = await readFile(path, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  return trimmed.split("\n").map((line) => JSON.parse(line) as PersistedTaskEvent);
}

async function waitForTaskState(
  workspaceRoot: string,
  taskId: string,
  predicate: (task: AgentTaskRecord) => boolean,
  description: string,
): Promise<AgentTaskRecord> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const task = await readTaskRecord({ workspaceRoot }, taskId);
    if (predicate(task)) {
      return task;
    }
    await delay(25);
  }
  assert.fail(`Timed out waiting for task ${taskId} to be ${description}.`);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("launchTask creates task files, runs shell command, and captures output", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "echo hello";
    const plan = shellPlan(command, workspaceRoot);

    const handle = await launchTask({
      workspaceRoot,
      plan,
      name: "  hello   task  ",
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

    const view = await buildAgentTaskPsView({ workspaceRoot });
    assert.equal(view.rows[0]?.lastMessage, "hello");
    const compact = compactAgentTaskPsView(view);
    assert.equal(compact.tasks[0]?.last, "hello");

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
      provider: {
        provider: "codex",
        protocol: "jsonrpc",
        transport: "stdio",
        threadId: "thread-123",
        turnId: "turn-123",
      },
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.model, "glm-5.2");
    assert.deepEqual(completed.parent, {
      parentRunId: "3133aaea-a17e-4094-b9df-67a77dc87437",
      parentSessionId: "session-123",
      parentToolCallId: "tool-call-123",
    });
    assert.deepEqual(completed.provider, {
      provider: "codex",
      protocol: "jsonrpc",
      transport: "stdio",
      threadId: "thread-123",
      turnId: "turn-123",
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

test("ps status filters preserve parent group labels", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const parentCommand = "printf parent-ok";
    const failedChildCommand = "node -e \"console.error('child failed'); process.exit(2)\"";
    const parentHandle = await launchTask({
      workspaceRoot,
      plan: {
        ...shellPlan(parentCommand, workspaceRoot),
        runtime: "orchestrator",
        displayName: "Orchestrator",
      },
      taskId: "filtered-parent-12345678",
      name: "filtered parent",
    });
    const childHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan(failedChildCommand, workspaceRoot),
      name: "failed child",
      parent: {
        parentRunId: "filtered-parent-12345678",
        parentTaskId: "filtered-parent-12345678",
      },
    });

    await parentHandle.completed;
    await childHandle.completed;

    const view = await buildAgentTaskPsView({ workspaceRoot, status: "failed" });
    const compact = compactAgentTaskPsView(view);

    assert.equal(view.groups.length, 1);
    assert.equal(view.groups[0]?.label, "filtered");
    assert.equal(view.groups[0]?.parentLabel, "filtered parent");
    assert.equal(compact.groups[0]?.label, "filtered parent");
    assert.deepEqual(
      compact.tasks.map((task) => task.name),
      ["failed child"],
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
    });
    const recentHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan(recentCommand, workspaceRoot),
      name: "recent done",
    });
    const oldFailureHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan(oldFailureCommand, workspaceRoot),
      name: "old failed",
    });
    const recentFailureHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan(recentFailureCommand, workspaceRoot),
      name: "recent failed",
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

    const activeOnlyView = await buildAgentTaskPsView({ workspaceRoot, now, activeOnly: true });
    assert.deepEqual(
      activeOnlyView.rows.map((row) => row.taskId),
      [],
    );
  });
});

test("ps observes fresh and lost supervised tasks from heartbeat files", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const freshHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan("printf fresh", workspaceRoot),
      name: "fresh supervised",
    });
    const lostHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan("printf lost", workspaceRoot),
      name: "lost supervised",
    });
    const freshCompleted = await freshHandle.completed;
    const lostCompleted = await lostHandle.completed;
    const freshTask = JSON.parse(await readFile(freshCompleted.paths.taskJson, "utf8"));
    const lostTask = JSON.parse(await readFile(lostCompleted.paths.taskJson, "utf8"));
    const now = new Date("2026-06-18T03:00:00.000Z");
    const deadSupervisorPid = findDeadPid();
    const deadChildPid = findDeadPid();

    await writeFile(
      freshCompleted.paths.taskJson,
      `${JSON.stringify(
        {
          ...freshTask,
          status: "running",
          startedAt: "2026-06-18T02:59:00.000Z",
          finishedAt: undefined,
          exitCode: undefined,
          supervision: {
            supervisor: {
              pid: deadSupervisorPid,
              capturedAt: "2026-06-18T02:59:00.000Z",
            },
            startedAt: "2026-06-18T02:59:00.000Z",
            heartbeatIntervalMs: 5_000,
            staleAfterMs: 20_000,
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeTaskHeartbeat(freshCompleted.paths, {
      taskId: freshCompleted.taskId,
      supervisorPid: deadSupervisorPid,
      lastHeartbeatAt: "2026-06-18T02:59:55.000Z",
    });

    await writeFile(
      lostCompleted.paths.taskJson,
      `${JSON.stringify(
        {
          ...lostTask,
          status: "running",
          startedAt: "2026-06-18T02:59:00.000Z",
          finishedAt: undefined,
          exitCode: undefined,
          supervision: {
            supervisor: {
              pid: deadSupervisorPid,
              capturedAt: "2026-06-18T02:59:00.000Z",
              startedAtMs: 1,
            },
            child: {
              pid: deadChildPid,
              capturedAt: "2026-06-18T02:59:00.000Z",
              startedAtMs: 1,
            },
            processGroupId: deadChildPid,
            startedAt: "2026-06-18T02:59:00.000Z",
            heartbeatIntervalMs: 5_000,
            staleAfterMs: 20_000,
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeTaskHeartbeat(lostCompleted.paths, {
      taskId: lostCompleted.taskId,
      supervisorPid: deadSupervisorPid,
      childPid: deadChildPid,
      processGroupId: deadChildPid,
      lastHeartbeatAt: "2026-06-18T02:59:00.000Z",
    });

    const view = await buildAgentTaskPsView({ workspaceRoot, now });
    const fresh = view.rows.find((row) => row.taskId === freshCompleted.taskId);
    const lost = view.rows.find((row) => row.taskId === lostCompleted.taskId);
    assert.equal(fresh?.state, undefined);
    assert.equal(fresh?.active, true);
    assert.equal(lost?.state, "lost");
    assert.equal(lost?.active, false);
    assert.equal(lost?.lastMessage, "watcher gone, child gone, final outcome unknown");

    const activeView = await buildAgentTaskPsView({ workspaceRoot, now, activeOnly: true });
    assert.deepEqual(
      activeView.rows.map((row) => row.taskId),
      [freshCompleted.taskId],
    );

    const compact = compactAgentTaskPsView(view);
    const compactFresh = compact.tasks.find((task) => task.taskId === freshCompleted.taskId);
    const compactLost = compact.tasks.find((task) => task.taskId === lostCompleted.taskId);
    assert.equal(compact.summary.active, 1);
    assert.equal(compact.summary.lost, 1);
    assert.equal(compactFresh?.active, true);
    assert.equal(compactFresh?.stop?.kind, "task");
    assert.equal(compactLost?.state, "lost");
    assert.equal(compactLost?.active, false);
    assert.equal(compactLost?.stop, undefined);
  });
});

test("provider-backed supervised tasks do not require process heartbeats", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan("printf provider", workspaceRoot),
      name: "provider supervised",
    });
    const completed = await handle.completed;
    const raw = JSON.parse(await readFile(completed.paths.taskJson, "utf8"));
    const startedAt = "2026-07-05T10:00:00.000Z";

    await writeFile(
      completed.paths.taskJson,
      `${JSON.stringify(
        {
          ...raw,
          runtime: "codex-app-server",
          status: "running",
          startedAt,
          finishedAt: undefined,
          exitCode: undefined,
          provider: {
            provider: "codex",
            protocol: "jsonrpc",
            transport: "unix",
            threadId: "thread-provider-1",
          },
          session: {
            kind: "codex-app-server",
            state: "idle",
            threadId: "thread-provider-1",
            startedAt,
            updatedAt: startedAt,
          },
          supervision: {
            kind: "provider",
            provider: "codex",
            transport: "unix",
            socketPath: "/tmp/fake-codex.sock",
            startedAt,
            staleAfterMs: 20_000,
          },
        },
        null,
        2,
      )}\n`,
    );

    const task = await readTaskRecord({ workspaceRoot }, completed.taskId);
    const defaultObservation = await observeTaskState({ workspaceRoot }, task);
    assert.equal(defaultObservation.state, "running");
    assert.equal(defaultObservation.active, true);
    assert.equal(defaultObservation.actionable, true);

    const reachableObservation = await observeTaskState({ workspaceRoot }, task, {
      providerHealth: async () => ({
        reachable: true,
        checkedAt: "2026-07-05T10:00:01.000Z",
      }),
    });
    assert.equal(reachableObservation.state, "running");
    assert.equal(reachableObservation.active, true);
    assert.equal(reachableObservation.actionable, true);
    assert.equal(reachableObservation.heartbeat?.lastHeartbeatAt, "2026-07-05T10:00:01.000Z");

    const staleObservation = await observeTaskState({ workspaceRoot }, task, {
      providerHealth: async () => ({
        reachable: false,
        checkedAt: "2026-07-05T10:00:02.000Z",
        reason: "provider app-server unavailable",
      }),
    });
    assert.equal(staleObservation.state, "stale");
    assert.equal(staleObservation.active, true);
    assert.equal(staleObservation.actionable, false);
    assert.equal(staleObservation.reason, "provider app-server unavailable");
  });
});

test("waitForTask returns unavailable for lost supervised tasks", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan("printf lost-wait", workspaceRoot),
      name: "lost wait",
    });
    const completed = await handle.completed;
    await markTaskLostForObservation(completed);

    const startedAt = Date.now();
    const result = await waitForTask({
      workspaceRoot,
      taskId: completed.taskId,
      timeoutMs: 5_000,
      intervalMs: 25,
    });

    assert.equal(result.retrievalStatus, "unavailable");
    assert.equal(result.task.status, "running");
    assert.equal(result.observation.state, "lost");
    assert.equal(result.observation.active, false);
    assert.ok(Date.now() - startedAt < 2_000);
  });
});

test("waitForTask returns unavailable for stale and orphaned supervised tasks", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const staleHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan("printf stale-wait", workspaceRoot),
      name: "stale wait",
    });
    const orphanedHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan("printf orphaned-wait", workspaceRoot),
      name: "orphaned wait",
    });
    const staleCompleted = await staleHandle.completed;
    const orphanedCompleted = await orphanedHandle.completed;
    const staleRaw = JSON.parse(await readFile(staleCompleted.paths.taskJson, "utf8"));
    const orphanedRaw = JSON.parse(await readFile(orphanedCompleted.paths.taskJson, "utf8"));
    const liveIdentity = await captureProcessIdentity(process.pid);
    assert.ok(liveIdentity);
    const deadSupervisorPid = findDeadPid();
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const heartbeatAt = new Date(Date.now() - 60_000).toISOString();

    await writeFile(
      staleCompleted.paths.taskJson,
      `${JSON.stringify(
        {
          ...staleRaw,
          status: "running",
          startedAt,
          finishedAt: undefined,
          exitCode: undefined,
          supervision: {
            supervisor: liveIdentity,
            startedAt,
            heartbeatIntervalMs: 5_000,
            staleAfterMs: 20_000,
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeTaskHeartbeat(staleCompleted.paths, {
      taskId: staleCompleted.taskId,
      supervisorPid: liveIdentity.pid,
      lastHeartbeatAt: heartbeatAt,
    });

    await writeFile(
      orphanedCompleted.paths.taskJson,
      `${JSON.stringify(
        {
          ...orphanedRaw,
          status: "running",
          startedAt,
          finishedAt: undefined,
          exitCode: undefined,
          supervision: {
            supervisor: {
              pid: deadSupervisorPid,
              capturedAt: startedAt,
              startedAtMs: 1,
            },
            child: liveIdentity,
            startedAt,
            heartbeatIntervalMs: 5_000,
            staleAfterMs: 20_000,
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeTaskHeartbeat(orphanedCompleted.paths, {
      taskId: orphanedCompleted.taskId,
      supervisorPid: deadSupervisorPid,
      childPid: liveIdentity.pid,
      lastHeartbeatAt: heartbeatAt,
    });

    const stale = await waitForTask({
      workspaceRoot,
      taskId: staleCompleted.taskId,
      timeoutMs: 5_000,
      intervalMs: 25,
    });
    const orphaned = await waitForTask({
      workspaceRoot,
      taskId: orphanedCompleted.taskId,
      timeoutMs: 5_000,
      intervalMs: 25,
    });

    assert.equal(stale.retrievalStatus, "unavailable");
    assert.equal(stale.observation.state, "stale");
    assert.equal(stale.observation.active, true);
    assert.equal(stale.observation.actionable, false);
    assert.equal(orphaned.retrievalStatus, "unavailable");
    assert.equal(orphaned.observation.state, "orphaned");
    assert.equal(orphaned.observation.active, true);
    assert.equal(orphaned.observation.actionable, false);

    const interrupt = await interruptTasks({
      workspaceRoot,
      target: {
        kind: "tasks",
        taskIds: [staleCompleted.taskId, orphanedCompleted.taskId],
      },
    });
    assert.deepEqual(interrupt.interrupted, []);
    assert.deepEqual(
      interrupt.skipped.map((skipped) => ({
        taskId: skipped.task.taskId,
        reason: skipped.reason,
      })),
      [
        { taskId: staleCompleted.taskId, reason: "stale" },
        { taskId: orphanedCompleted.taskId, reason: "orphaned" },
      ],
    );
    assert.deepEqual(interrupt.failed, []);
  });
});

test("waitForTask handles first heartbeat race and legacy running records conservatively", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const supervisedHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan("printf supervised-race", workspaceRoot),
      name: "supervised race",
    });
    const legacyHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan("printf legacy-running", workspaceRoot),
      name: "legacy running",
    });
    const supervisedCompleted = await supervisedHandle.completed;
    const legacyCompleted = await legacyHandle.completed;
    const supervisedRaw = JSON.parse(await readFile(supervisedCompleted.paths.taskJson, "utf8"));
    const legacyRaw = JSON.parse(await readFile(legacyCompleted.paths.taskJson, "utf8"));
    const liveIdentity = await captureProcessIdentity(process.pid);
    assert.ok(liveIdentity);
    const startedAt = new Date().toISOString();
    const legacyStartedAt = new Date(Date.now() - 60_000).toISOString();
    await rm(supervisedCompleted.paths.heartbeatJson, { force: true });
    await rm(legacyCompleted.paths.heartbeatJson, { force: true });

    await writeFile(
      supervisedCompleted.paths.taskJson,
      `${JSON.stringify(
        {
          ...supervisedRaw,
          status: "running",
          startedAt,
          finishedAt: undefined,
          exitCode: undefined,
          supervision: {
            supervisor: liveIdentity,
            startedAt,
            heartbeatIntervalMs: 5_000,
            staleAfterMs: 20_000,
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      legacyCompleted.paths.taskJson,
      `${JSON.stringify(
        {
          ...legacyRaw,
          status: "running",
          startedAt: legacyStartedAt,
          finishedAt: undefined,
          exitCode: undefined,
          supervision: undefined,
        },
        null,
        2,
      )}\n`,
    );

    const supervised = await waitForTask({
      workspaceRoot,
      taskId: supervisedCompleted.taskId,
      timeoutMs: 0,
      intervalMs: 1,
    });
    assert.equal(supervised.retrievalStatus, "timeout");
    assert.equal(supervised.observation.state, "running");
    assert.equal(supervised.observation.active, true);
    assert.equal(supervised.observation.actionable, true);

    const legacy = await waitForTask({
      workspaceRoot,
      taskId: legacyCompleted.taskId,
      timeoutMs: 5_000,
      intervalMs: 25,
    });
    assert.equal(legacy.retrievalStatus, "unavailable");
    assert.equal(legacy.observation.state, "stale");
    assert.equal(legacy.observation.active, true);
    assert.equal(legacy.observation.actionable, false);

    const interrupt = await interruptTasks({
      workspaceRoot,
      target: { kind: "task", taskId: legacyCompleted.taskId },
    });
    assert.deepEqual(interrupt.interrupted, []);
    assert.deepEqual(
      interrupt.skipped.map((skipped) => ({
        taskId: skipped.task.taskId,
        reason: skipped.reason,
      })),
      [{ taskId: legacyCompleted.taskId, reason: "stale" }],
    );
    assert.deepEqual(interrupt.failed, []);
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
    });
    const failureHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan(failureCommand, workspaceRoot),
      name: "failed child",
    });
    const runningHandle = await launchTask({
      workspaceRoot,
      plan: shellPlan(runningCommand, workspaceRoot),
      name: "running child",
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

    const task = await readTaskRecord({ workspaceRoot }, completed.taskId);
    assert.deepEqual(task.provider, {
      provider: "claude-code",
      sessionId: "fixture-session",
    });
  });
});

test("launchTask normalizes Claude stream-json usage and persists final task usage", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: jsonlFixturePlan({
        runtime: "claude-code",
        fixturePath: join(fixturesDir, "claude-stream-json-usage.jsonl"),
        cwd: workspaceRoot,
      }),
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "succeeded");
    assert.equal(
      await readTaskOutput({ workspaceRoot, taskId: completed.taskId }),
      "fixture-claude-usage-ok",
    );

    const events = await readTaskEvents(completed.paths.eventsJsonl);
    const agentEvents = events.filter((event) => event.type === "agent_event");
    const assistant = agentEvents.find((event) => event.data.kind === "agent.message");
    assert.ok(assistant);
    assert.deepEqual(assistant.data.usage, {
      inputTokens: 40,
      outputTokens: 0,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 55,
      source: "provider",
      scope: "turn",
      final: false,
    });

    const result = agentEvents.find((event) => event.data.kind === "agent.result");
    assert.ok(result);
    assert.deepEqual(result.data.usage, {
      inputTokens: 40,
      outputTokens: 7,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 62,
      costUsd: 0.00123,
      source: "provider",
      scope: "task",
      final: true,
    });

    const task = await readTaskRecord({ workspaceRoot }, completed.taskId);
    assert.deepEqual(task.provider, {
      provider: "claude-code",
      sessionId: "fixture-session",
    });
    assert.equal(task.usage?.inputTokens, 40);
    assert.equal(task.usage?.outputTokens, 7);
    assert.equal(task.usage?.cacheReadTokens, 10);
    assert.equal(task.usage?.cacheWriteTokens, 5);
    assert.equal(task.usage?.totalTokens, 62);
    assert.equal(task.usage?.costUsd, 0.00123);
    assert.equal(task.usage?.source, "provider");
    assert.equal(task.usage?.scope, "task");
    assert.equal(task.usage?.final, true);
    assert.match(task.usage?.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
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
      reasoningTokens: 20,
      totalTokens: 16515,
      source: "provider",
      scope: "task",
      final: true,
    });

    const task = await readTaskRecord({ workspaceRoot }, completed.taskId);
    assert.deepEqual(task.provider, {
      provider: "codex",
      threadId: "019ed6c8-5e27-7f02-827c-7fcd44bde1a1",
    });
    assert.equal(task.usage?.inputTokens, 16484);
    assert.equal(task.usage?.outputTokens, 31);
    assert.equal(task.usage?.cacheReadTokens, 10624);
    assert.equal(task.usage?.reasoningTokens, 20);
    assert.equal(task.usage?.totalTokens, 16515);
    assert.equal(task.usage?.source, "provider");
    assert.equal(task.usage?.scope, "task");
    assert.equal(task.usage?.final, true);
    assert.match(task.usage?.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("launchTask fails resumed process tasks when provider emits a different session id", async () => {
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
        resume: {
          provider: "codex",
          threadId: "requested-thread",
        },
      },
      provider: {
        provider: "codex",
        threadId: "requested-thread",
      },
      resume: {
        fromTaskId: "source-task",
        rootTaskId: "source-task",
        attempt: 1,
      },
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "failed");
    assert.match(completed.error ?? "", /requested-thread/);

    const events = await readTaskEvents(completed.paths.eventsJsonl);
    assert.ok(
      events.some(
        (event) =>
          event.type === "agent_event" &&
          event.data.kind === "task.resume" &&
          event.data.fromTaskId === "source-task",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "agent_event" &&
          event.data.kind === "runtime.error" &&
          String(event.data.message).includes("requested-thread"),
      ),
    );
  });
});

test("launchTask accepts custom JSONL usage and keeps final task usage over session totals", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fixturePath = join(workspaceRoot, "custom-agent.jsonl");
    await writeFile(
      fixturePath,
      [
        JSON.stringify({
          type: "usage",
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
            source: "runtime",
            scope: "task",
            final: false,
          },
        }),
        JSON.stringify({
          type: "final",
          text: "custom done",
          usage: {
            inputTokens: 2,
            outputTokens: 3,
            reasoningTokens: 1,
            totalTokens: 6,
            source: "provider",
            scope: "task",
            final: true,
          },
        }),
        JSON.stringify({
          type: "usage",
          usage: {
            totalTokens: 100,
            source: "provider",
            scope: "session",
            final: true,
          },
        }),
      ].join("\n"),
    );
    const command = `cat ${quoteShellArg(fixturePath)}`;
    const handle = await launchTask({
      workspaceRoot,
      plan: {
        runtime: "custom",
        displayName: "custom",
        executable: "sh",
        args: ["-lc", command],
        env: {},
        cwd: workspaceRoot,
        promptTransport: { kind: "argv", position: "last" },
        outputTransport: {
          kind: "jsonl_events",
          finalEvent: "final",
        },
        expectedProcesses: ["sh"],
        interrupt: "process_group",
        canSteerRunning: false,
        handlesOwnAuth: false,
        enabled: true,
        safety: {
          acceptsShellCommand: false,
        },
      },
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "succeeded");
    assert.equal(await readTaskOutput({ workspaceRoot, taskId: completed.taskId }), "custom done");

    const task = await readTaskRecord({ workspaceRoot }, completed.taskId);
    assert.equal(task.usage?.inputTokens, 2);
    assert.equal(task.usage?.outputTokens, 3);
    assert.equal(task.usage?.reasoningTokens, 1);
    assert.equal(task.usage?.totalTokens, 6);
    assert.equal(task.usage?.source, "provider");
    assert.equal(task.usage?.scope, "task");
    assert.equal(task.usage?.final, true);

    const view = await buildAgentTaskPsView({ workspaceRoot });
    assert.equal(view.rows[0]?.usage?.totalTokens, 6);
    assert.equal(view.groups[0]?.usage?.totalTokens, 6);

    const compact = compactAgentTaskPsView(view);
    assert.equal(compact.schemaVersion, 1);
    assert.equal(compact.summary.tasks, 1);
    assert.equal(compact.summary.done, 1);
    assert.equal(compact.stop, undefined);
    assert.equal(compact.groups[0]?.tokens, 6);
    assert.equal(compact.tasks[0]?.tokens, 6);
    assert.equal(compact.tasks[0]?.stop, undefined);
  });
});

test("compact ps view expands stop ids until they are unambiguous", () => {
  const left = controlViewRow("control-parent-a-00000001", "left parent");
  const right = controlViewRow("control-parent-b-00000001", "right parent");
  const view: AgentTaskPsView = {
    generatedAt: "2026-06-20T00:00:00.000Z",
    scope: { workspaces: "current", workspaceRoot: "/tmp" },
    rows: [left, right],
    groups: [controlViewGroup(left.taskId, left), controlViewGroup(right.taskId, right)],
  };

  const compact = compactAgentTaskPsView(view, { activeOnly: true });

  assert.equal(compact.groups.length, 2);
  assert.equal(compact.tasks.length, 2);
  assert.notEqual(compact.groups[0]?.id, compact.groups[1]?.id);
  assert.notEqual(compact.tasks[0]?.id, compact.tasks[1]?.id);
  const firstGroupStop = compact.groups[0]?.stop;
  const secondGroupStop = compact.groups[1]?.stop;
  const firstTaskStop = compact.tasks[0]?.stop;
  const secondTaskStop = compact.tasks[1]?.stop;
  assert.equal(firstGroupStop?.kind, "group");
  assert.equal(secondGroupStop?.kind, "group");
  assert.equal(firstTaskStop?.kind, "parent");
  assert.equal(secondTaskStop?.kind, "parent");
  if (
    firstGroupStop?.kind !== "group" ||
    secondGroupStop?.kind !== "group" ||
    firstTaskStop?.kind !== "parent" ||
    secondTaskStop?.kind !== "parent"
  ) {
    assert.fail("Expected group and task stop targets.");
  }
  assert.equal(firstGroupStop.id, compact.groups[0]?.id);
  assert.equal(secondGroupStop.id, compact.groups[1]?.id);
  assert.deepEqual(compact.groups[0]?.commands?.ps.args, [
    "ps",
    "--parent",
    compact.groups[0]?.id,
    "--json",
    "--compact",
  ]);
  assert.deepEqual(compact.groups[0]?.commands?.activePs.args, [
    "ps",
    "--parent",
    compact.groups[0]?.id,
    "--json",
    "--compact",
    "--active",
  ]);
  assert.equal(compact.stop, undefined);
  assert.deepEqual(firstGroupStop.args, [
    "interrupt",
    "--group",
    compact.groups[0]?.id,
    "--json",
    "--compact",
  ]);
  assert.equal(firstTaskStop.id, compact.tasks[0]?.id);
  assert.equal(secondTaskStop.id, compact.tasks[1]?.id);
  assert.deepEqual(compact.tasks[0]?.commands?.read.args, ["read", compact.tasks[0]?.id, "--json"]);
  assert.deepEqual(compact.tasks[0]?.commands?.readPreview.args, [
    "read",
    compact.tasks[0]?.id,
    "--max-bytes",
    String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
    "--json",
    "--compact",
  ]);
  assert.deepEqual(compact.tasks[0]?.commands?.wait.args, [
    "read",
    compact.tasks[0]?.id,
    "--wait",
    "--timeout-ms",
    "300000",
    "--json",
  ]);
  assert.deepEqual(compact.tasks[0]?.commands?.waitPreview.args, [
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
  assert.deepEqual(compact.tasks[0]?.commands?.watch.args, [
    "watch",
    compact.tasks[0]?.id,
    "--json",
  ]);
  assert.deepEqual(compact.tasks[0]?.commands?.agentWatch.args, [
    "watch",
    compact.tasks[0]?.id,
    "--agent-only",
    "--json",
  ]);
  assert.deepEqual(compact.tasks[0]?.commands?.logs.args, [
    "logs",
    compact.tasks[0]?.id,
    "--json",
    "--compact",
  ]);
  assert.deepEqual(compact.tasks[0]?.commands?.logsPreview.args, [
    "logs",
    compact.tasks[0]?.id,
    "--max-bytes",
    String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
    "--json",
    "--compact",
  ]);
  assert.deepEqual(compact.tasks[0]?.commands?.events.args, [
    "events",
    compact.tasks[0]?.id,
    "--json",
    "--compact",
  ]);
  assert.deepEqual(compact.tasks[0]?.commands?.agentEvents.args, [
    "events",
    compact.tasks[0]?.id,
    "--agent-only",
    "--json",
    "--compact",
  ]);
  assert.deepEqual(firstTaskStop.args, [
    "interrupt",
    compact.tasks[0]?.id,
    "--children",
    "--json",
    "--compact",
  ]);
  assert.match(compact.tasks[0]?.id ?? "", /^control-parent-a/);
  assert.match(compact.tasks[1]?.id ?? "", /^control-parent-b/);

  const brief = compactAgentTaskPsView(view, { activeOnly: true, brief: true });
  assert.equal(brief.groups[0]?.commands, undefined);
  assert.equal(brief.tasks[0]?.commands, undefined);
  assert.deepEqual(brief.tasks[0]?.stop?.args, [
    "interrupt",
    brief.tasks[0]?.id,
    "--children",
    "--json",
    "--compact",
  ]);
});

test("compact ps view exposes selected stop for non-parent active tasks", () => {
  const first = { ...controlViewRow("control-child-a-00000001", "left child"), runtime: "codex" };
  const second = {
    ...controlViewRow("control-child-b-00000001", "right child"),
    runtime: "claude-code",
  };
  const view: AgentTaskPsView = {
    generatedAt: "2026-06-20T00:00:00.000Z",
    scope: { workspaces: "current", workspaceRoot: "/tmp" },
    rows: [first, second],
    groups: [
      {
        groupId: "ungrouped",
        label: "ungrouped",
        status: "running",
        total: 2,
        running: 2,
        succeeded: 0,
        failed: 0,
        stopped: 0,
        timedOut: 0,
        rows: [first, second],
      },
    ],
  };

  const compact = compactAgentTaskPsView(view, { activeOnly: true });

  assert.deepEqual(compact.stop, {
    kind: "tasks",
    ids: compact.tasks.map((task) => task.id),
    args: ["interrupt", ...compact.tasks.map((task) => task.id), "--json", "--compact"],
  });
});

test("compact ps view keeps last activity short for agent control payloads", () => {
  const row = {
    ...controlViewRow("compact-last-00000001", "long output"),
    lastMessage: `first line ${"detail ".repeat(80)}\nsecond line`,
  };
  const view: AgentTaskPsView = {
    generatedAt: "2026-06-20T00:00:00.000Z",
    scope: { workspaces: "current", workspaceRoot: "/tmp" },
    rows: [row],
    groups: [controlViewGroup(row.taskId, row)],
  };

  const compact = compactAgentTaskPsView(view);
  const last = compact.tasks[0]?.last;

  assert.ok(last);
  assert.equal(last.includes("\n"), false);
  assert.equal(last.length, 160);
  assert.match(last, /\.\.\.$/);
  assert.equal(row.lastMessage.includes("\n"), true);
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

test("launchTask fails malformed JSONL with no final result", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: jsonlCommandPlan({
        runtime: "claude-code",
        command: "printf '{bad json\\n'",
        cwd: workspaceRoot,
      }),
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "failed");
    assert.match(completed.error ?? "", /malformed JSONL/);
    assert.equal(await readTaskOutput({ workspaceRoot, taskId: completed.taskId }), "");

    const events = await readTaskEvents(completed.paths.eventsJsonl);
    assert.ok(
      events.some(
        (event) => event.type === "agent_event" && event.data.kind === "runtime.parse_error",
      ),
    );
  });
});

test("launchTask caps stored output at maxOutputBytes, including partial chunks", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "printf abcdef";
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan(command, workspaceRoot),
      maxOutputBytes: 3,
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "succeeded");
    assert.equal(await readFile(completed.paths.stdoutLog, "utf8"), "abc");
    assert.equal(await readTaskOutput({ workspaceRoot, taskId: completed.taskId }), "abc");
    assert.equal(completed.outputCapture?.maxBytes, 3);
    assert.equal(completed.outputCapture?.stdoutBytes, 6);
    assert.equal(completed.outputCapture?.stdoutTruncated, true);
    assert.equal(completed.outputCapture?.stderrTruncated, false);
    assert.equal(completed.outputCapture?.resultTruncated, true);
  });
});

test("launchTask marks non-zero exit as failed and captures stderr", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "echo bad >&2; exit 7";
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan(command, workspaceRoot),
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "failed");
    assert.equal(completed.exitCode, 7);
    assert.equal(await readFile(completed.paths.stderrLog, "utf8"), "bad\n");

    const view = await buildAgentTaskPsView({ workspaceRoot });
    assert.equal(view.rows[0]?.error, "bad");
    assert.equal(view.rows[0]?.lastMessage, "bad");

    const compact = compactAgentTaskPsView(view);
    assert.equal(compact.tasks[0]?.last, "bad");
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
      timeoutMs: 50,
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "timed_out");
    assert.match(completed.error ?? "", /Timed out/);

    const persisted = (await listTasks({ workspaceRoot, status: "timed_out" }))[0];
    assert.equal(persisted?.taskId, completed.taskId);
  });
});

test("interruptTasks blocks plain parent interruption and supports children", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 5000)"';
    const parentId = "parent-task-children-00000001";
    const parent = await launchTask({
      workspaceRoot,
      taskId: parentId,
      plan: orchestratorPlan(command, workspaceRoot),
      name: "parent run",
    });
    const child = await launchTask({
      workspaceRoot,
      taskId: "child-task-children-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "child run",
      parent: {
        parentRunId: parentId,
        parentTaskId: parentId,
      },
    });

    await Promise.all([
      waitForTaskState(
        workspaceRoot,
        parent.task.taskId,
        (task) => task.status === "running",
        "running",
      ),
      waitForTaskState(
        workspaceRoot,
        child.task.taskId,
        (task) => task.status === "running",
        "running",
      ),
    ]);

    await assert.rejects(
      () =>
        interruptTasks({
          workspaceRoot,
          target: { kind: "task", taskId: parentId.slice(0, 8) },
          reason: "plain parent should fail",
        }),
      (error) =>
        error instanceof TaskSupervisorSafetyError &&
        /--children/.test(error.message) &&
        /--task-only/.test(error.message),
    );

    const result = await interruptTasks({
      workspaceRoot,
      target: { kind: "task", taskId: parentId.slice(0, 8), children: true },
      reason: "stop run",
    });

    assert.deepEqual(
      result.interrupted.map((task) => task.taskId),
      [parent.task.taskId, child.task.taskId],
    );
    assert.equal(result.failed.length, 0);
    assert.equal(result.skipped.length, 0);

    const [completedParent, completedChild] = await Promise.all([
      parent.completed,
      child.completed,
    ]);
    assert.equal(completedParent.status, "cancelled");
    assert.equal(completedChild.status, "cancelled");
    assert.equal(completedParent.error, "stop run");
    assert.equal(completedChild.error, "stop run");
  });
});

test("interruptTasks taskOnly stops only the parent task", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 5000)"';
    const parentId = "parent-task-only-00000001";
    const parent = await launchTask({
      workspaceRoot,
      taskId: parentId,
      plan: orchestratorPlan(command, workspaceRoot),
      name: "parent only",
    });
    const child = await launchTask({
      workspaceRoot,
      taskId: "child-task-only-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "left running",
      parent: {
        parentRunId: parentId,
        parentTaskId: parentId,
      },
    });

    await Promise.all([
      waitForTaskState(
        workspaceRoot,
        parent.task.taskId,
        (task) => task.status === "running",
        "running",
      ),
      waitForTaskState(
        workspaceRoot,
        child.task.taskId,
        (task) => task.status === "running",
        "running",
      ),
    ]);

    const result = await interruptTasks({
      workspaceRoot,
      target: { kind: "task", taskId: parentId.slice(0, 8), taskOnly: true },
      reason: "parent only",
    });

    assert.deepEqual(
      result.interrupted.map((task) => task.taskId),
      [parent.task.taskId],
    );

    const completedParent = await parent.completed;
    assert.equal(completedParent.status, "cancelled");
    const stillRunningChild = await readTaskRecord({ workspaceRoot }, child.task.taskId);
    assert.equal(stillRunningChild.status, "running");

    await interruptTask({ workspaceRoot, taskId: child.task.taskId, reason: "cleanup" });
    await child.completed;
  });
});

test("interruptTasks stops a ps group and skips terminal children", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const runningCommand = 'node -e "setTimeout(() => {}, 5000)"';
    const doneCommand = "printf done";
    const parentId = "group-parent-00000001";
    const parent = await launchTask({
      workspaceRoot,
      taskId: parentId,
      plan: orchestratorPlan(runningCommand, workspaceRoot),
      name: "group parent",
    });
    const runningChild = await launchTask({
      workspaceRoot,
      taskId: "group-child-running-00000001",
      plan: shellPlan(runningCommand, workspaceRoot),
      name: "group child",
      parent: {
        parentRunId: parentId,
        parentTaskId: parentId,
      },
    });
    const doneChild = await launchTask({
      workspaceRoot,
      taskId: "group-child-done-00000001",
      plan: shellPlan(doneCommand, workspaceRoot),
      name: "done child",
      parent: {
        parentRunId: parentId,
        parentTaskId: parentId,
      },
    });

    await doneChild.completed;
    await Promise.all([
      waitForTaskState(
        workspaceRoot,
        parent.task.taskId,
        (task) => task.status === "running",
        "running",
      ),
      waitForTaskState(
        workspaceRoot,
        runningChild.task.taskId,
        (task) => task.status === "running",
        "running",
      ),
    ]);

    const view = await buildAgentTaskPsView({ workspaceRoot });
    assert.equal(view.groups[0]?.groupId, parentId);

    const result = await interruptTasks({
      workspaceRoot,
      target: { kind: "group", groupId: parentId.slice(0, 8) },
      reason: "stop group",
    });

    assert.deepEqual(
      result.interrupted.map((task) => task.taskId),
      [parent.task.taskId, runningChild.task.taskId],
    );
    assert.deepEqual(
      result.skipped.map((skipped) => skipped.task.taskId),
      [doneChild.task.taskId],
    );

    await Promise.all([parent.completed, runningChild.completed]);
  });
});

test("interruptTasks skips lost supervised tasks instead of signaling stale pids", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan("printf lost-interrupt", workspaceRoot),
      name: "lost interrupt",
    });
    const completed = await handle.completed;
    await markTaskLostForObservation(completed);

    const result = await interruptTasks({
      workspaceRoot,
      target: { kind: "task", taskId: completed.taskId.slice(0, 8) },
    });

    assert.deepEqual(result.interrupted, []);
    assert.deepEqual(
      result.skipped.map((skipped) => ({
        taskId: skipped.task.taskId,
        reason: skipped.reason,
      })),
      [{ taskId: completed.taskId, reason: "lost" }],
    );
    assert.deepEqual(result.failed, []);

    await assert.rejects(
      () => interruptTask({ workspaceRoot, taskId: completed.taskId }),
      (error) =>
        error instanceof TaskSupervisorSafetyError &&
        error.reason === "lost" &&
        error.input === completed.taskId,
    );
  });
});

test("interruptTasks rejects ambiguous group prefixes and broad ungrouped interruption", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "printf parent";
    const first = await launchTask({
      workspaceRoot,
      taskId: "ambiguous-parent-a-00000001",
      plan: orchestratorPlan(command, workspaceRoot),
    });
    const second = await launchTask({
      workspaceRoot,
      taskId: "ambiguous-parent-b-00000001",
      plan: orchestratorPlan(command, workspaceRoot),
    });
    const ungrouped = await launchTask({
      workspaceRoot,
      taskId: "ungrouped-task-00000001",
      plan: shellPlan(command, workspaceRoot),
    });
    await Promise.all([first.completed, second.completed, ungrouped.completed]);

    await assert.rejects(
      () =>
        interruptTasks({
          workspaceRoot,
          target: { kind: "group", groupId: "ambiguous-parent" },
        }),
      (error) =>
        error instanceof TaskGroupLookupError &&
        error.reason === "ambiguous" &&
        error.matches.includes(first.task.taskId) &&
        error.matches.includes(second.task.taskId) &&
        error.hint?.includes("ps --json --compact --brief") === true,
    );

    await assert.rejects(
      () =>
        interruptTasks({
          workspaceRoot,
          target: { kind: "group", groupId: "ungrouped" },
        }),
      (error) =>
        error instanceof TaskSupervisorSafetyError &&
        error.reason === "broad_group" &&
        error.input === "ungrouped" &&
        error.hint?.includes("ps --json --compact --active") === true,
    );
  });
});

test("interruptTask cancels a running task", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 5000)"';
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan(command, workspaceRoot),
    });
    await waitForTaskState(
      workspaceRoot,
      handle.task.taskId,
      (task) => task.status === "running",
      "running",
    );

    const interrupted = await interruptTask({
      workspaceRoot,
      taskId: handle.task.taskId.slice(0, 8),
      reason: "test cancellation",
    });

    assert.equal(interrupted.status, "running");
    assert.equal(taskDisplayState(interrupted), "stopping");
    assert.equal(interrupted.stopReason, "test cancellation");
    assert.equal(interrupted.stopSignal, "SIGTERM");
    assert.ok(interrupted.stopRequestedAt);
    assert.equal(interrupted.error, undefined);

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

test("interruptTask keeps delayed shutdown active until the process exits", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const script = [
      "printf 'ready\\n'",
      "trap 'printf stopping\\\\n; sleep 1; exit 0' TERM",
      "while true; do sleep 1; done",
    ].join("; ");
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan(script, workspaceRoot),
    });
    await waitForTaskState(
      workspaceRoot,
      handle.task.taskId,
      (task) => task.status === "running",
      "running",
    );

    const interrupted = await interruptTask({
      workspaceRoot,
      taskId: handle.task.taskId,
      reason: "delayed cancellation",
    });

    assert.equal(interrupted.status, "running");
    assert.equal(taskDisplayState(interrupted), "stopping");

    const waitResult = await waitForTask({
      workspaceRoot,
      taskId: handle.task.taskId,
      timeoutMs: 50,
      intervalMs: 10,
    });
    assert.equal(waitResult.retrievalStatus, "timeout");
    assert.equal(waitResult.task.status, "running");
    assert.equal(taskDisplayState(waitResult.task), "stopping");

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
    assert.equal(taskDisplayState(completed), "cancelled");
    assert.equal(completed.error, "delayed cancellation");
  });
});

test("interruptTask keeps stop reason when timeout fires during shutdown", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const script = `
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  console.log("cleanup started");
  setTimeout(() => {
    console.log("cleanup finished");
    process.exit(0);
  }, 700);
});
console.log("ready");
setInterval(() => console.log("alive"), 100);
`;
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan(`node -e ${JSON.stringify(script)}`, workspaceRoot),
      timeoutMs: 500,
    });
    await waitForTaskState(
      workspaceRoot,
      handle.task.taskId,
      (task) => task.status === "running",
      "running",
    );

    const interrupted = await interruptTask({
      workspaceRoot,
      taskId: handle.task.taskId,
      reason: "operator stop",
    });

    assert.equal(taskDisplayState(interrupted), "stopping");

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.error, "operator stop");
    assert.doesNotMatch(completed.error ?? "", /Timed out/);

    const events = await readTaskEvents(completed.paths.eventsJsonl);
    const cancelled = events.find((event) => event.type === "cancelled");
    assert.equal(cancelled?.data?.error, "operator stop");
  });
});
