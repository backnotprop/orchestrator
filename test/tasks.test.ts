import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAgentLaunchPlan } from "@backnotprop/orchestrator-core/runtime";
import type { AgentLaunchPlan } from "@backnotprop/orchestrator-core/runtime";
import {
  TaskSupervisorError,
  interruptTask,
  launchTask,
  listTasks,
  readTaskOutput,
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
    assert.ok(agentEvents.some((event) => event.data.kind === "turn.completed"));
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
