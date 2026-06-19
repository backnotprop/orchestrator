import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import type { AgentLaunchPlan } from "@backnotprop/orchestrator-core/runtime";
import {
  launchTask,
  isTerminalTaskStatus,
  listTasks,
  readTaskEvents,
  readTaskLogs,
} from "@backnotprop/orchestrator-core/tasks";

type TestTool = ReturnType<typeof createOrchestratorAgentTools>[number];

type TestToolResult<T> = {
  content: Array<{ type: "text"; text: string }>;
  details: T;
};

type ToolDetails = {
  task?: {
    taskId: string;
    runtime: string;
    status: string;
    name?: string;
  };
  retrievalStatus?: "completed" | "timeout";
  tasks?: Array<{
    taskId: string;
    runtime: string;
    status: string;
    name?: string;
  }>;
  output?: string;
  stdout?: string;
  stderr?: string;
  events?: Array<{ type: string; data: Record<string, unknown> }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    totalTokens?: number;
  };
};

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

async function withTempWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "orchestrator-agent-tools-"));
  try {
    return await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
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
      requiresAllowlist: false,
      acceptsShellCommand: false,
    },
  };
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
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5_000) {
    const task = (await listTasks({ workspaceRoot })).find(
      (candidate) => candidate.taskId === taskId,
    );
    if (task && isTerminalTaskStatus(task.status)) {
      return task.status;
    }
    await delay(25);
  }

  assert.fail(`Timed out waiting for task ${taskId}.`);
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
      allowedShellCommands: [command],
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
    assert.equal(await waitForTerminalTask(workspaceRoot, taskId), "succeeded");

    const read = await executeTool<ToolDetails>(getTool(tools, "read_agent"), {
      taskId,
      wait: true,
      timeoutMs: 5_000,
    });
    assert.equal(read.details.retrievalStatus, "completed");
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

    const logs = await executeTool<ToolDetails>(getTool(tools, "read_agent_logs"), { taskId });
    assert.equal(logs.details.stdout, "final answer from worker\n");
    assert.equal(logs.details.stderr, "worker stderr\n");

    const events = await executeTool<ToolDetails>(getTool(tools, "read_agent_events"), {
      taskId,
    });
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

test("read_agent wait returns timeout without claiming completion", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'sleep 0.2; printf "late output\\n"';
    const tools = createOrchestratorAgentTools({
      workspaceRoot,
      allowDisabledRuntime: true,
      allowedShellCommands: [command],
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

    assert.deepEqual(read.details.usage, {
      inputTokens: 16484,
      outputTokens: 31,
      cacheReadTokens: 10624,
      totalTokens: 16515,
    });
  });
});

test("parent agent tools emit passive trace events", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = 'printf "traced output\\n"';
    const traceEvents: ParentToolTraceEvent[] = [];
    const tools = createOrchestratorAgentTools({
      workspaceRoot,
      allowDisabledRuntime: true,
      allowedShellCommands: [command],
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
      allowedShellCommands: [command],
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
        "interrupt_agent",
      ]);
      assert.ok(created.session.sessionId);
      assert.match(
        buildOrchestratorParentPrompt("Clean up this repo."),
        /User request:\nClean up this repo\./,
      );
      assert.match(buildOrchestratorParentPrompt("Clean up this repo."), /wait: true/);
    } finally {
      created.session.dispose();
    }
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
