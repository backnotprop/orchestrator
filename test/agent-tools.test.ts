import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildOrchestratorParentPrompt,
  createOrchestratorParentSession,
  type ParentToolTraceEvent,
} from "@backnotprop/orchestrator-agent";
import { createOrchestratorAgentTools } from "@backnotprop/orchestrator-agent/tools";
import {
  CODEX_APP_SERVER_RUNTIME,
  buildAgentLaunchPlan,
  type AgentLaunchPlan,
  type HeadlessAgentRuntimeConfig,
} from "@backnotprop/orchestrator-core/runtime";
import {
  launchTask,
  interruptTask,
  isTerminalTaskStatus,
  listTasks,
  readTaskEvents,
  readTaskLogs,
} from "@backnotprop/orchestrator-core/tasks";
import { markTaskLostForObservation } from "./helpers.ts";

type TestTool = ReturnType<typeof createOrchestratorAgentTools>[number];

type TestToolResult<T> = {
  content: Array<{ type: "text"; text: string }>;
  details: T;
};

type ToolDetails = {
  taskId?: string;
  status?: string;
  provider?: { provider?: string; threadId?: string; turnId?: string };
  source?: string;
  cleared?: boolean;
  goal?: { status?: string; objective?: string; tokenBudget?: number | null };
  operation?: { kind?: string; status?: string; turnId?: string; result?: string };
  task?: {
    taskId: string;
    runtime: string;
    status: string;
    state?: string;
    active?: boolean;
    actionable?: boolean;
    observationReason?: string;
    name?: string;
    stopReason?: string;
    location?: { kind: string; workspaceRoot?: string; cwd?: string };
  };
  retrievalStatus?: "completed" | "timeout" | "unavailable";
  tasks?: Array<{
    taskId: string;
    runtime: string;
    status: string;
    state?: string;
    active?: boolean;
    actionable?: boolean;
    observationReason?: string;
    name?: string;
    stopReason?: string;
    location?: { kind: string; workspaceRoot?: string; cwd?: string };
  }>;
  interrupted?: Array<{
    taskId: string;
    runtime: string;
    status: string;
    state?: string;
    active?: boolean;
    actionable?: boolean;
    observationReason?: string;
    name?: string;
    stopReason?: string;
  }>;
  skipped?: Array<{
    task: {
      taskId: string;
      runtime: string;
      status: string;
      state?: string;
      active?: boolean;
      actionable?: boolean;
      observationReason?: string;
      name?: string;
      stopReason?: string;
    };
    reason: string;
  }>;
  failed?: Array<{ taskId: string; error: string }>;
  output?: string;
  stdout?: string;
  stderr?: string;
  events?: Array<{ type: string; data: Record<string, unknown> }>;
  loadedConfigPaths?: readonly string[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    source?: string;
    scope?: string;
    final?: boolean;
  };
};

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fakeAppServerPath = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url),
);

async function withTempWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "orchestrator-agent-tools-")));
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const previousOrchestratorHome = process.env.ORCHESTRATOR_HOME;
  process.env.HOME = workspaceRoot;
  process.env.XDG_CONFIG_HOME = join(workspaceRoot, ".config");
  process.env.ORCHESTRATOR_HOME = join(workspaceRoot, ".orchestrator");
  try {
    return await fn(workspaceRoot);
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("XDG_CONFIG_HOME", previousXdgConfigHome);
    restoreEnv("ORCHESTRATOR_HOME", previousOrchestratorHome);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function codexFixturePlan(fixturePath: string, cwd: string): AgentLaunchPlan {
  return {
    runtime: "codex",
    displayName: "codex",
    executable: "sh",
    args: ["-lc", `cat ${quoteShellArg(fixturePath)}`],
    env: {},
    cwd,
    promptTransport: { kind: "argv", position: "last" },
    outputTransport: { kind: "jsonl_events", finalEvent: "turn.completed" },
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

function shellPlan(command: string, cwd: string): AgentLaunchPlan {
  return {
    runtime: "shell",
    displayName: "shell",
    executable: "sh",
    args: ["-lc", command],
    env: {},
    cwd,
    promptTransport: { kind: "argv", position: "last" },
    outputTransport: { kind: "stdout_text" },
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

function orchestratorPlan(command: string, cwd: string): AgentLaunchPlan {
  return {
    ...shellPlan(command, cwd),
    runtime: "orchestrator",
    displayName: "Orchestrator",
  };
}

function codexAppServerSessionPlan(cwd: string): AgentLaunchPlan {
  const runtime: HeadlessAgentRuntimeConfig = {
    ...CODEX_APP_SERVER_RUNTIME,
    launch: {
      ...CODEX_APP_SERVER_RUNTIME.launch,
      executable: process.execPath,
      baseArgs: [fakeAppServerPath],
    },
  };

  return buildAgentLaunchPlan(
    {
      runtime: "codex-app-server",
      cwd,
      model: "fake-model",
      session: true,
    },
    {
      "codex-app-server": runtime,
    },
  );
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function getTool(tools: readonly TestTool[], name: string): TestTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected tool ${name} to be registered.`);
  return tool;
}

async function executeTool<TDetails>(
  tool: TestTool,
  params: unknown,
): Promise<TestToolResult<TDetails>> {
  return (await tool.execute(
    "test-tool-call",
    params as never,
    undefined,
    undefined,
    undefined as never,
  )) as TestToolResult<TDetails>;
}

async function waitForTerminalTask(workspaceRoot: string, taskId: string): Promise<string> {
  return (
    await waitForTaskState(
      workspaceRoot,
      taskId,
      (task) => isTerminalTaskStatus(task.status),
      "terminal",
    )
  ).status;
}

async function waitForTaskState(
  workspaceRoot: string,
  taskId: string,
  predicate: (task: Awaited<ReturnType<typeof listTasks>>[number]) => boolean,
  description: string,
): Promise<Awaited<ReturnType<typeof listTasks>>[number]> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5_000) {
    const task = (await listTasks({ workspaceRoot })).find(
      (candidate) => candidate.taskId === taskId,
    );
    if (task && predicate(task)) {
      return task;
    }
    await delay(25);
  }

  assert.fail(`Timed out waiting for task ${taskId} to be ${description}.`);
}

test("parent agent tools manage a background Orchestrator task", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command =
      'sleep 0.05; printf "final answer from worker\\n"; printf "worker stderr\\n" >&2';
    let usedBackgroundLauncher = false;
    const tools = createOrchestratorAgentTools({
      workspaceRoot,
      parentRunId: "run-agent-tools",
      parentSessionId: () => "session-agent-tools",
      allowDisabledRuntime: true,
      configEnv: {
        HOME: workspaceRoot,
        XDG_CONFIG_HOME: join(workspaceRoot, ".config"),
      },
      backgroundLauncher: async (input) => {
        usedBackgroundLauncher = true;
        const handle = await launchTask(input);
        handle.completed.catch(() => {});
        return handle.task;
      },
    });

    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "launch_agent",
        "list_agents",
        "read_agent",
        "read_agent_events",
        "read_agent_logs",
        "send_agent_message",
        "start_agent_goal",
        "read_agent_goal",
        "set_agent_goal",
        "clear_agent_goal",
        "interrupt_agent",
      ],
    );

    const launch = await executeTool<ToolDetails>(getTool(tools, "launch_agent"), {
      runtime: "shell",
      instructions: command,
      name: "check email",
    });
    assert.equal(launch.details.task?.runtime, "shell");
    assert.equal(launch.details.task?.status, "starting");
    assert.equal(launch.details.task?.name, "check email");
    assert.equal(usedBackgroundLauncher, true);

    const taskId = launch.details.task?.taskId;
    assert.ok(taskId);
    const shortTaskId = taskId.slice(0, 8);
    assert.equal(await waitForTerminalTask(workspaceRoot, taskId), "succeeded");

    const read = await executeTool<ToolDetails>(getTool(tools, "read_agent"), {
      taskId: shortTaskId,
      wait: true,
      timeoutMs: 5_000,
    });
    assert.equal(read.details.retrievalStatus, "completed");
    assert.equal(read.details.task?.taskId, taskId);
    assert.equal(read.details.task?.status, "succeeded");
    assert.equal(read.details.output, "final answer from worker\n");

    const list = await executeTool<ToolDetails>(getTool(tools, "list_agents"), {
      runtime: "shell",
    });
    assert.ok(list.details.tasks?.some((task) => task.taskId === taskId));
    const persisted = (await listTasks({ workspaceRoot })).find((task) => task.taskId === taskId);
    assert.deepEqual(persisted?.launchPlan.env, {});
    assert.deepEqual(persisted?.parent, {
      parentRunId: "run-agent-tools",
      parentSessionId: "session-agent-tools",
      parentToolCallId: "test-tool-call",
    });

    const logs = await executeTool<ToolDetails>(getTool(tools, "read_agent_logs"), {
      taskId: shortTaskId,
    });
    assert.equal(logs.details.taskId, taskId);
    assert.equal(logs.details.stdout, "final answer from worker\n");
    assert.equal(logs.details.stderr, "worker stderr\n");

    const events = await executeTool<ToolDetails>(getTool(tools, "read_agent_events"), {
      taskId: shortTaskId,
    });
    assert.equal(events.details.taskId, taskId);
    assert.ok(events.details.events?.some((event) => event.type === "completed"));

    assert.equal(
      (await readTaskLogs({ workspaceRoot, taskId, stream: "stdout" })).stdout,
      "final answer from worker\n",
    );
    assert.ok(
      (await readTaskEvents({ workspaceRoot, taskId })).some((event) => event.type === "stdout"),
    );
    assert.ok(
      (await readTaskEvents({ workspaceRoot, taskId })).some(
        (event) => event.type === "agent_event" && event.data.kind === "task.parent",
      ),
    );
  });
});

test("parent agent tools can launch children across workspaces", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const repoA = `${workspaceRoot}/repo-a`;
    const repoB = `${workspaceRoot}/repo-b`;
    const repoASubdir = `${repoA}/packages/api`;
    await mkdir(repoASubdir, { recursive: true });
    await mkdir(repoB, { recursive: true });

    const command = "pwd";
    const tools = createOrchestratorAgentTools({
      workspaceRoot: repoB,
      allowDisabledRuntime: true,
      configEnv: {
        HOME: workspaceRoot,
        XDG_CONFIG_HOME: join(workspaceRoot, ".config"),
        ORCHESTRATOR_HOME: join(workspaceRoot, ".orchestrator"),
      },
      backgroundLauncher: async (input) => {
        const handle = await launchTask(input);
        handle.completed.catch(() => {});
        return handle.task;
      },
    });

    const launch = await executeTool<ToolDetails>(getTool(tools, "launch_agent"), {
      runtime: "shell",
      instructions: command,
      name: "repo a child",
      workspace: repoA,
      cwd: "packages/api",
      labels: { suite: "parent-tool", component: "api" },
    });
    const taskId = launch.details.task?.taskId;
    assert.ok(taskId);
    assert.equal(launch.details.task?.location?.workspaceRoot, repoA);
    assert.equal(launch.details.task?.location?.cwd, repoASubdir);

    const read = await executeTool<ToolDetails>(getTool(tools, "read_agent"), {
      taskId: taskId.slice(0, 8),
      wait: true,
      timeoutMs: 5_000,
    });
    assert.equal(read.details.output, `${repoASubdir}\n`);

    const currentWorkspaceList = await executeTool<ToolDetails>(getTool(tools, "list_agents"), {});
    assert.equal(
      currentWorkspaceList.details.tasks?.some((task) => task.taskId === taskId),
      false,
    );

    const repoAList = await executeTool<ToolDetails>(getTool(tools, "list_agents"), {
      workspace: repoA,
    });
    assert.equal(
      repoAList.details.tasks?.some((task) => task.taskId === taskId),
      true,
    );

    const allWorkspaceList = await executeTool<ToolDetails>(getTool(tools, "list_agents"), {
      allWorkspaces: true,
    });
    assert.equal(
      allWorkspaceList.details.tasks?.some((task) => task.taskId === taskId),
      true,
    );

    const persisted = (await listTasks({ workspaceRoot })).find((task) => task.taskId === taskId);
    assert.equal(persisted?.location?.kind, "local");
    assert.equal(persisted?.location?.workspaceRoot, repoA);
    assert.equal(persisted?.location?.cwd, repoASubdir);
    assert.deepEqual(persisted?.labels, { suite: "parent-tool", component: "api" });
  });
});

test("parent launch_agent loads custom runtimes from the target workspace config", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const repoA = `${workspaceRoot}/repo-a`;
    const repoB = `${workspaceRoot}/repo-b`;
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    await writeFile(
      `${repoA}/orchestrator.config.json`,
      JSON.stringify({
        agents: {
          "repo-agent": {
            adapter: "process",
            command: "node",
            args: [
              "-e",
              "process.stdout.write('target:' + (process.argv.at(-1) ?? ''))",
              "{prompt}",
            ],
            output: "text",
          },
        },
      }),
    );

    const tools = createOrchestratorAgentTools({
      workspaceRoot: repoB,
      configEnv: {
        HOME: workspaceRoot,
        XDG_CONFIG_HOME: join(workspaceRoot, ".config"),
        ORCHESTRATOR_HOME: join(workspaceRoot, ".orchestrator"),
      },
      backgroundLauncher: async (input) => {
        const handle = await launchTask(input);
        handle.completed.catch(() => {});
        return handle.task;
      },
    });

    const launch = await executeTool<ToolDetails>(getTool(tools, "launch_agent"), {
      runtime: "repo-agent",
      instructions: "hello",
      name: "target custom child",
      workspace: repoA,
    });
    const taskId = launch.details.task?.taskId;
    assert.ok(taskId);
    assert.equal(launch.details.task?.runtime, "repo-agent");
    assert.equal(launch.details.task?.location?.workspaceRoot, repoA);
    assert.deepEqual(launch.details.loadedConfigPaths, [`${repoA}/orchestrator.config.json`]);

    const read = await executeTool<ToolDetails>(getTool(tools, "read_agent"), {
      taskId,
      wait: true,
      timeoutMs: 5_000,
    });
    assert.equal(read.details.output, "target:hello");

    const persisted = (await listTasks({ workspaceRoot })).find((task) => task.taskId === taskId);
    assert.equal(persisted?.location?.workspaceRoot, repoA);
    assert.equal(persisted?.launchPlan.executable, "node");
  });
});

test("interrupt_agent accepts short task ids", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 5000)"';
    let completed: Promise<unknown> | undefined;
    const tools = createOrchestratorAgentTools({
      workspaceRoot,
      allowDisabledRuntime: true,
      configEnv: {
        HOME: workspaceRoot,
        XDG_CONFIG_HOME: join(workspaceRoot, ".config"),
      },
      backgroundLauncher: async (input) => {
        const handle = await launchTask(input);
        completed = handle.completed.catch(() => {});
        return handle.task;
      },
    });

    const launch = await executeTool<ToolDetails>(getTool(tools, "launch_agent"), {
      runtime: "shell",
      instructions: command,
      name: "cancel me",
    });

    const taskId = launch.details.task?.taskId;
    assert.ok(taskId);
    await waitForTaskState(workspaceRoot, taskId, (task) => task.status === "running", "running");

    const interrupted = await executeTool<ToolDetails>(getTool(tools, "interrupt_agent"), {
      taskId: taskId.slice(0, 8),
      reason: "tool cancellation",
    });
    assert.equal(interrupted.details.task?.taskId, taskId);
    assert.equal(interrupted.details.task?.status, "running");
    assert.equal(interrupted.details.task?.state, "stopping");
    assert.equal(interrupted.details.task?.stopReason, "tool cancellation");

    assert.equal(await waitForTerminalTask(workspaceRoot, taskId), "cancelled");
    const persisted = await waitForTaskState(
      workspaceRoot,
      taskId,
      (task) => task.status === "cancelled",
      "cancelled",
    );
    assert.equal(persisted.error, "tool cancellation");
    await completed;
  });
});

test("interrupt_agent can stop parent children and groups", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'node -e "setTimeout(() => {}, 5000)"';
    const tools = createOrchestratorAgentTools({ workspaceRoot });

    const parent = await launchTask({
      workspaceRoot,
      taskId: "tool-parent-children-00000001",
      plan: orchestratorPlan(command, workspaceRoot),
      name: "tool parent",
    });
    const child = await launchTask({
      workspaceRoot,
      taskId: "tool-child-children-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "tool child",
      parent: {
        parentRunId: parent.task.taskId,
        parentTaskId: parent.task.taskId,
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

    const interruptedParent = await executeTool<ToolDetails>(getTool(tools, "interrupt_agent"), {
      parentId: parent.task.taskId.slice(0, 8),
      children: true,
      reason: "tool parent stop",
    });
    assert.deepEqual(
      interruptedParent.details.interrupted?.map((task) => task.taskId),
      [parent.task.taskId, child.task.taskId],
    );
    await Promise.all([parent.completed, child.completed]);

    const groupParent = await launchTask({
      workspaceRoot,
      taskId: "tool-group-parent-00000001",
      plan: orchestratorPlan(command, workspaceRoot),
      name: "tool group parent",
    });
    const groupChild = await launchTask({
      workspaceRoot,
      taskId: "tool-group-child-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "tool group child",
      parent: {
        parentRunId: groupParent.task.taskId,
        parentTaskId: groupParent.task.taskId,
      },
    });
    await Promise.all([
      waitForTaskState(
        workspaceRoot,
        groupParent.task.taskId,
        (task) => task.status === "running",
        "running",
      ),
      waitForTaskState(
        workspaceRoot,
        groupChild.task.taskId,
        (task) => task.status === "running",
        "running",
      ),
    ]);

    const interruptedGroup = await executeTool<ToolDetails>(getTool(tools, "interrupt_agent"), {
      groupId: groupParent.task.taskId.slice(0, 8),
      reason: "tool group stop",
    });
    assert.deepEqual(
      interruptedGroup.details.interrupted?.map((task) => task.taskId),
      [groupParent.task.taskId, groupChild.task.taskId],
    );
    await Promise.all([groupParent.completed, groupChild.completed]);
  });
});

test("interrupt_agent rejects invalid multi-task selectors", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const tools = createOrchestratorAgentTools({ workspaceRoot });

    await assert.rejects(
      () =>
        executeTool<ToolDetails>(getTool(tools, "interrupt_agent"), {
          taskId: "task",
          groupId: "group",
        }),
      /exactly one/,
    );
    await assert.rejects(
      () =>
        executeTool<ToolDetails>(getTool(tools, "interrupt_agent"), {
          parentId: "parent",
        }),
      /children: true/,
    );
  });
});

test("read_agent wait returns timeout without claiming completion", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'sleep 0.2; printf "late output\\n"';
    const tools = createOrchestratorAgentTools({
      workspaceRoot,
      allowDisabledRuntime: true,
      configEnv: {
        HOME: workspaceRoot,
        XDG_CONFIG_HOME: join(workspaceRoot, ".config"),
      },
      backgroundLauncher: async (input) => {
        const handle = await launchTask(input);
        handle.completed.catch(() => {});
        return handle.task;
      },
    });

    const launch = await executeTool<ToolDetails>(getTool(tools, "launch_agent"), {
      runtime: "shell",
      instructions: command,
      name: "slow child",
    });
    const taskId = launch.details.task?.taskId;
    assert.ok(taskId);

    const read = await executeTool<ToolDetails>(getTool(tools, "read_agent"), {
      taskId,
      wait: true,
      timeoutMs: 1,
    });
    assert.equal(read.details.retrievalStatus, "timeout");
    assert.notEqual(read.details.task?.status, "succeeded");

    assert.equal(await waitForTerminalTask(workspaceRoot, taskId), "succeeded");
  });
});

test("read_agent wait returns unavailable for lost supervised tasks", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan("printf lost-agent", workspaceRoot),
      name: "lost agent",
    });
    const completed = await handle.completed;
    await markTaskLostForObservation(completed);
    const tools = createOrchestratorAgentTools({ workspaceRoot });

    const startedAt = Date.now();
    const read = await executeTool<ToolDetails>(getTool(tools, "read_agent"), {
      taskId: completed.taskId.slice(0, 8),
      wait: true,
      timeoutMs: 5_000,
    });

    assert.equal(read.details.retrievalStatus, "unavailable");
    assert.equal(read.details.task?.taskId, completed.taskId);
    assert.equal(read.details.task?.status, "running");
    assert.equal(read.details.task?.state, "lost");
    assert.equal(read.details.task?.active, false);
    assert.equal(read.details.task?.actionable, false);
    assert.equal(
      read.details.task?.observationReason,
      "watcher gone, child gone, final outcome unknown",
    );
    assert.equal(read.details.output, "lost-agent");
    assert.ok(Date.now() - startedAt < 2_000);
  });
});

test("read_agent includes latest normalized usage when available", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexFixturePlan(join(fixturesDir, "codex-exec-jsonl.jsonl"), workspaceRoot),
    });
    const completed = await handle.completed;
    assert.equal(completed.status, "succeeded");

    const tools = createOrchestratorAgentTools({ workspaceRoot });
    const read = await executeTool<ToolDetails>(getTool(tools, "read_agent"), {
      taskId: completed.taskId,
    });

    assert.equal(read.details.usage?.inputTokens, 16484);
    assert.equal(read.details.usage?.outputTokens, 31);
    assert.equal(read.details.usage?.cacheReadTokens, 10624);
    assert.equal(read.details.usage?.reasoningTokens, 20);
    assert.equal(read.details.usage?.totalTokens, 16515);
    assert.equal(read.details.usage?.source, "provider");
    assert.equal(read.details.usage?.scope, "task");
    assert.equal(read.details.usage?.final, true);
  });
});

test("send_agent_message rejects runtimes without running-message support", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: shellPlan("sleep 2", workspaceRoot),
    });
    const tools = createOrchestratorAgentTools({ workspaceRoot });

    try {
      await assert.rejects(
        executeTool<ToolDetails>(getTool(tools, "send_agent_message"), {
          taskId: handle.task.taskId.slice(0, 8),
          message: "Focus on failing tests first.",
        }),
        (error: unknown) =>
          error instanceof Error &&
          "reason" in error &&
          error.reason === "unsupported" &&
          /does not accept messages/.test(error.message),
      );
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
      await handle.completed.catch(() => undefined);
    }
  });
});

test("start_agent_goal can run a native codex-app-server goal", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot),
      name: "goal tool session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    try {
      await waitForTaskState(
        workspaceRoot,
        handle.task.taskId,
        (task) => task.status === "running" && task.session?.state === "idle",
        "idle session",
      );

      const tools = createOrchestratorAgentTools({ workspaceRoot });
      const started = await executeTool<ToolDetails>(getTool(tools, "start_agent_goal"), {
        taskId: handle.task.taskId.slice(0, 8),
        goal: "Improve performance by 10%.",
        wait: true,
        timeoutMs: 5_000,
        tokenBudget: 1000,
      });

      assert.equal(started.details.status, "completed");
      assert.equal(started.details.provider?.threadId, "thread-fake-1");
      assert.equal(started.details.provider?.turnId, "turn-fake-goal-1");
      assert.equal(started.details.goal?.status, "complete");
      assert.equal(started.details.goal?.objective, "Improve performance by 10%.");
      assert.equal(started.details.goal?.tokenBudget, 1000);
      assert.equal(started.details.operation?.kind, "goal");
      assert.equal(started.details.operation?.status, "complete");
      assert.equal(started.details.operation?.result, "Goal complete from fake Codex.");

      const events = await readTaskEvents({ workspaceRoot, taskId: handle.task.taskId });
      const kinds = events.flatMap((event) =>
        event.type === "agent_event" && typeof event.data.kind === "string"
          ? [event.data.kind]
          : [],
      );
      assert.ok(kinds.includes("protocol.goal.requested"));
      assert.ok(kinds.includes("goal.updated"));
      assert.ok(kinds.includes("operation.completed"));
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
  });
});

test("parent agent goal tools can read set and clear provider goal state", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot),
      name: "goal control tool session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    try {
      await waitForTaskState(
        workspaceRoot,
        handle.task.taskId,
        (task) => task.status === "running" && task.session?.state === "idle",
        "idle session",
      );

      const tools = createOrchestratorAgentTools({ workspaceRoot });
      const empty = await executeTool<ToolDetails>(getTool(tools, "read_agent_goal"), {
        taskId: handle.task.taskId.slice(0, 8),
        timeoutMs: 5_000,
      });
      assert.equal(empty.details.source, "provider");
      assert.equal(empty.details.goal, undefined);

      const set = await executeTool<ToolDetails>(getTool(tools, "set_agent_goal"), {
        taskId: handle.task.taskId.slice(0, 8),
        objective: "Blocked until the API stabilizes.",
        status: "blocked",
        tokenBudget: null,
        timeoutMs: 5_000,
      });
      assert.equal(set.details.source, "provider");
      assert.equal(set.details.goal?.status, "blocked");
      assert.equal(set.details.goal?.objective, "Blocked until the API stabilizes.");
      assert.equal(set.details.goal?.tokenBudget, null);

      const read = await executeTool<ToolDetails>(getTool(tools, "read_agent_goal"), {
        taskId: handle.task.taskId.slice(0, 8),
        timeoutMs: 5_000,
      });
      assert.equal(read.details.goal?.status, "blocked");

      const cleared = await executeTool<ToolDetails>(getTool(tools, "clear_agent_goal"), {
        taskId: handle.task.taskId.slice(0, 8),
        timeoutMs: 5_000,
      });
      assert.equal(cleared.details.source, "provider");
      assert.equal(cleared.details.cleared, true);
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
  });
});

test("read_agent event fallback keeps final task usage over later session usage", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fixturePath = join(workspaceRoot, "custom-agent.jsonl");
    await writeFile(
      fixturePath,
      [
        JSON.stringify({
          type: "final",
          text: "custom done",
          usage: {
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
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
    const handle = await launchTask({
      workspaceRoot,
      plan: {
        runtime: "custom",
        displayName: "custom",
        executable: "sh",
        args: ["-lc", `cat ${quoteShellArg(fixturePath)}`],
        env: {},
        cwd: workspaceRoot,
        promptTransport: { kind: "argv", position: "last" },
        outputTransport: { kind: "jsonl_events", finalEvent: "final" },
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

    const taskRecord = JSON.parse(await readFile(completed.paths.taskJson, "utf8")) as Record<
      string,
      unknown
    >;
    delete taskRecord.usage;
    await writeFile(completed.paths.taskJson, `${JSON.stringify(taskRecord, null, 2)}\n`);

    const tools = createOrchestratorAgentTools({ workspaceRoot });
    const read = await executeTool<ToolDetails>(getTool(tools, "read_agent"), {
      taskId: completed.taskId,
    });

    assert.equal(read.details.usage?.totalTokens, 5);
    assert.equal(read.details.usage?.scope, "task");
    assert.equal(read.details.usage?.final, true);
  });
});

test("parent agent tools emit passive trace events", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'printf "traced output\\n"';
    const traceEvents: ParentToolTraceEvent[] = [];
    const tools = createOrchestratorAgentTools({
      workspaceRoot,
      allowDisabledRuntime: true,
      configEnv: {
        HOME: workspaceRoot,
        XDG_CONFIG_HOME: join(workspaceRoot, ".config"),
      },
      trace: (event) => {
        traceEvents.push(event);
        if (event.kind === "tool.call" && event.toolName === "launch_agent") {
          (event.input as { runtime?: string }).runtime = "mutated";
        }
      },
      backgroundLauncher: async (input) => {
        const handle = await launchTask(input);
        handle.completed.catch(() => {});
        return handle.task;
      },
    });

    const launch = await executeTool<ToolDetails>(getTool(tools, "launch_agent"), {
      runtime: "shell",
      instructions: command,
      name: "trace child",
    });
    assert.equal(launch.details.task?.runtime, "shell");

    const taskId = launch.details.task?.taskId;
    assert.ok(taskId);

    const read = await executeTool<ToolDetails>(getTool(tools, "read_agent"), {
      taskId,
      wait: true,
      timeoutMs: 5_000,
    });
    assert.equal(read.details.output, "traced output\n");

    assert.deepEqual(
      traceEvents
        .filter((event) => event.kind !== "tool.progress")
        .map((event) => `${event.kind}:${event.toolName}`),
      [
        "tool.call:launch_agent",
        "tool.result:launch_agent",
        "tool.call:read_agent",
        "tool.result:read_agent",
      ],
    );
    assert.equal(traceEvents[0]?.toolCallId, "test-tool-call");
    assert.equal(
      traceEvents[0]?.kind === "tool.call" &&
        (traceEvents[0].input as { runtime?: string }).runtime,
      "mutated",
    );
    assert.equal(
      traceEvents[1]?.kind === "tool.result" &&
        (traceEvents[1].result as ToolDetails).task?.runtime,
      "shell",
    );
    const readResult = [...traceEvents]
      .reverse()
      .find((event) => event.kind === "tool.result" && event.toolName === "read_agent");
    assert.equal(
      readResult?.kind === "tool.result" && (readResult.result as ToolDetails).retrievalStatus,
      "completed",
    );
  });
});

test("read_agent wait emits progress trace events while waiting", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'sleep 1.2; printf "slow traced output\\n"';
    const traceEvents: ParentToolTraceEvent[] = [];
    const tools = createOrchestratorAgentTools({
      workspaceRoot,
      allowDisabledRuntime: true,
      configEnv: {
        HOME: workspaceRoot,
        XDG_CONFIG_HOME: join(workspaceRoot, ".config"),
      },
      trace: (event) => traceEvents.push(event),
      backgroundLauncher: async (input) => {
        const handle = await launchTask(input);
        handle.completed.catch(() => {});
        return handle.task;
      },
    });

    const launch = await executeTool<ToolDetails>(getTool(tools, "launch_agent"), {
      runtime: "shell",
      instructions: command,
      name: "slow trace child",
    });
    const taskId = launch.details.task?.taskId;
    assert.ok(taskId);

    const read = await executeTool<ToolDetails>(getTool(tools, "read_agent"), {
      taskId,
      wait: true,
      timeoutMs: 5_000,
    });

    assert.equal(read.details.retrievalStatus, "completed");
    assert.equal(read.details.output, "slow traced output\n");

    const progress = traceEvents.find(
      (event) => event.kind === "tool.progress" && event.toolName === "read_agent",
    );
    if (!progress || progress.kind !== "tool.progress") {
      assert.fail("Expected read_agent progress trace event.");
    }
    assert.equal(progress.toolCallId, "test-tool-call");
    assert.equal((progress.progress as { taskId?: string }).taskId, taskId);
    assert.match(
      String((progress.progress as { status?: string }).status),
      /queued|starting|running/,
    );
  });
});

test("trace sink failures do not affect parent tool execution", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const tools = createOrchestratorAgentTools({
      workspaceRoot,
      trace: () => {
        throw new Error("trace renderer failed");
      },
    });

    const list = await executeTool<ToolDetails>(getTool(tools, "list_agents"), {});
    assert.deepEqual(list.details.tasks, []);
  });
});

test("trace snapshot failures do not affect parent tool execution", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const traceEvents: ParentToolTraceEvent[] = [];
    const tools = createOrchestratorAgentTools({
      workspaceRoot,
      trace: (event) => traceEvents.push(event),
    });
    const params: Record<string, unknown> = {
      toString: () => {
        throw new Error("cannot stringify");
      },
    };
    params.self = params;

    const list = await executeTool<ToolDetails>(getTool(tools, "list_agents"), params);
    assert.deepEqual(list.details.tasks, []);
    assert.equal(
      traceEvents[0]?.kind === "tool.call" ? traceEvents[0].input : undefined,
      "[unserializable]",
    );
  });
});

test("parent agent tool trace emits errors before rethrowing", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const traceEvents: ParentToolTraceEvent[] = [];
    const tools = createOrchestratorAgentTools({
      workspaceRoot,
      trace: (event) => traceEvents.push(event),
    });

    await assert.rejects(
      () =>
        executeTool<ToolDetails>(getTool(tools, "launch_agent"), {
          runtime: "missing-runtime",
          instructions: "will fail",
        }),
      /Unknown runtime "missing-runtime"/,
    );

    assert.deepEqual(
      traceEvents.map((event) => `${event.kind}:${event.toolName}`),
      ["tool.call:launch_agent", "tool.error:launch_agent"],
    );
    assert.match(
      traceEvents[1]?.kind === "tool.error" ? traceEvents[1].error : "",
      /Unknown runtime "missing-runtime"/,
    );
  });
});

test("parent AI session starts with only Orchestrator tools enabled", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const created = await createOrchestratorParentSession({
      workspaceRoot,
      agentDir: join(workspaceRoot, ".orchestrator"),
    });

    try {
      assert.deepEqual(created.session.getActiveToolNames(), [
        "launch_agent",
        "list_agents",
        "read_agent",
        "read_agent_events",
        "read_agent_logs",
        "send_agent_message",
        "start_agent_goal",
        "read_agent_goal",
        "set_agent_goal",
        "clear_agent_goal",
        "interrupt_agent",
      ]);
      assert.ok(created.session.sessionId);
      assert.match(
        buildOrchestratorParentPrompt("Clean up this repo."),
        /User request:\nClean up this repo\./,
      );
      assert.match(buildOrchestratorParentPrompt("Clean up this repo."), /wait: true/);
      assert.match(buildOrchestratorParentPrompt("Clean up this repo."), /runtime: "shell"/);
      assert.match(
        buildOrchestratorParentPrompt("Clean up this repo."),
        /Do not launch Codex or Claude just to run a deterministic shell command\./,
      );
    } finally {
      created.session.dispose();
    }
  });
});

test("launch_agent metadata teaches shell versus model runtime choice", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const launchAgent = getTool(createOrchestratorAgentTools({ workspaceRoot }), "launch_agent");
    const promptGuidelines = launchAgent.promptGuidelines;

    assert.match(launchAgent.description, /Shell/);
    assert.ok(promptGuidelines);
    assert.ok(
      promptGuidelines.some(
        (guideline) =>
          guideline.includes('runtime: "shell"') &&
          guideline.includes("exact local shell commands"),
      ),
    );
    assert.ok(
      promptGuidelines.some(
        (guideline) =>
          guideline.includes('runtime: "codex"') &&
          guideline.includes('runtime: "claude-code"') &&
          guideline.includes("AI work"),
      ),
    );
    assert.ok(
      promptGuidelines.some((guideline) =>
        guideline.includes(
          "Do not launch Codex or Claude just to run a deterministic shell command",
        ),
      ),
    );
  });
});

test("send_agent_message metadata teaches running task and session use", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const sendAgentMessage = getTool(
      createOrchestratorAgentTools({ workspaceRoot }),
      "send_agent_message",
    );
    const promptGuidelines = sendAgentMessage.promptGuidelines;

    assert.match(sendAgentMessage.description, /task or session/);
    assert.ok(promptGuidelines);
    assert.ok(
      promptGuidelines.some((guideline) => guideline.includes("running tasks or sessions")),
    );
    assert.ok(promptGuidelines.some((guideline) => guideline.includes("wait: true")));
    assert.ok(
      promptGuidelines.some((guideline) => guideline.includes("read_agent for finished results")),
    );
    assert.ok(promptGuidelines.some((guideline) => guideline.includes("already finished")));
  });
});

test("parent AI session ignores unsafe Pi tool overrides", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const created = await createOrchestratorParentSession({
      workspaceRoot,
      agentDir: join(workspaceRoot, ".orchestrator"),
      pi: {
        noTools: "all",
        tools: ["bash"],
        excludeTools: ["launch_agent"],
        customTools: [],
      } as never,
    });

    try {
      assert.deepEqual(created.session.getActiveToolNames(), [
        "launch_agent",
        "list_agents",
        "read_agent",
        "read_agent_events",
        "read_agent_logs",
        "send_agent_message",
        "start_agent_goal",
        "read_agent_goal",
        "set_agent_goal",
        "clear_agent_goal",
        "interrupt_agent",
      ]);
      assert.equal(created.session.getToolDefinition("bash"), undefined);
    } finally {
      created.session.dispose();
    }
  });
});

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
