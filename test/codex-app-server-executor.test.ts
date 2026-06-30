import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CODEX_APP_SERVER_RUNTIME,
  buildAgentLaunchPlan,
  type AgentLaunchPlan,
  type HeadlessAgentRuntimeConfig,
} from "@backnotprop/orchestrator-core/runtime";
import {
  interruptTask,
  launchTask,
  readTaskEvents,
  readTaskLogs,
  readTaskOutput,
  readTaskRecord,
} from "@backnotprop/orchestrator-core/tasks";
import {
  cliPath,
  runCli,
  waitForChildExit,
  waitForText,
  withTempWorkspace,
} from "./cli-support.ts";

const fakeAppServerPath = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url),
);

test("codex app-server executor captures result, events, provider metadata, and usage", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerPlan(workspaceRoot),
      name: "fake codex app-server",
      model: "fake-model",
      timeoutMs: 5_000,
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "succeeded");
    assert.equal(
      await readTaskOutput({ workspaceRoot, taskId: completed.taskId }),
      "Hello from fake Codex.",
    );

    const task = await readTaskRecord({ workspaceRoot }, completed.taskId);
    assert.deepEqual(task.provider, {
      provider: "codex",
      protocol: "jsonrpc",
      transport: "stdio",
      threadId: "thread-fake-1",
      turnId: "turn-fake-1",
    });
    assert.equal(task.usage?.totalTokens, 15);
    assert.equal(task.usage?.inputTokens, 10);
    assert.equal(task.usage?.cacheReadTokens, 2);
    assert.equal(task.usage?.outputTokens, 4);
    assert.equal(task.usage?.reasoningTokens, 1);
    assert.equal(task.usage?.final, true);

    const events = await readTaskEvents({ workspaceRoot, taskId: completed.taskId });
    const kinds = events.flatMap((event) =>
      event.type === "agent_event" && typeof event.data.kind === "string" ? [event.data.kind] : [],
    );
    assert.ok(kinds.includes("thread.started"));
    assert.ok(kinds.includes("turn.started"));
    assert.ok(kinds.includes("server.request"));
    assert.ok(kinds.includes("agent.message"));
    assert.ok(kinds.includes("agent.usage"));
    assert.ok(kinds.includes("turn.completed"));

    const transcript = await readFile(task.paths.transcriptJsonl, "utf8");
    assert.match(transcript, /"method":"thread\/start"/);
    assert.match(transcript, /"method":"turn\/start"/);
    assert.match(transcript, /"method":"item\/commandExecution\/requestApproval"/);
    assert.match(transcript, /"method":"turn\/completed"/);
  }, "orchestrator-codex-app-server-success-");
});

test("codex app-server executor maps failed turns to failed tasks", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerPlan(workspaceRoot, { FAKE_CODEX_APP_SERVER_MODE: "failed" }),
      timeoutMs: 5_000,
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "failed");
    assert.equal(completed.error, "fake turn failure");
  }, "orchestrator-codex-app-server-failed-");
});

test("codex app-server executor preserves intentionally empty final answers", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerPlan(workspaceRoot, { FAKE_CODEX_APP_SERVER_MODE: "empty" }),
      timeoutMs: 5_000,
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "succeeded");
    assert.equal(await readTaskOutput({ workspaceRoot, taskId: completed.taskId }), "");
  }, "orchestrator-codex-app-server-empty-answer-");
});

test("codex app-server executor can interrupt an in-progress turn", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerPlan(workspaceRoot, { FAKE_CODEX_APP_SERVER_MODE: "hang" }),
      timeoutMs: 10_000,
    });

    await waitFor(async () => {
      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      return task.provider?.turnId === "turn-fake-1";
    });

    await interruptTask({
      workspaceRoot,
      taskId: handle.task.taskId,
      reason: "stop fake codex",
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.error, "stop fake codex");

    const kinds = await agentEventKinds(workspaceRoot, completed.taskId);
    assert.ok(kinds.includes("protocol.interrupt.requested"));
    assert.ok(kinds.includes("protocol.interrupt.sent"));
    assert.ok(kinds.includes("protocol.interrupt.settled"));
    assert.ok(!kinds.includes("protocol.interrupt.fallback_kill"));

    const logs = await readTaskLogs({ workspaceRoot, taskId: completed.taskId, stream: "stderr" });
    assert.doesNotMatch(logs.stderr, /got sigterm/);
  }, "orchestrator-codex-app-server-interrupt-");
});

test("codex app-server interrupt does not wait on a stuck protocol request", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerPlan(workspaceRoot, { FAKE_CODEX_APP_SERVER_MODE: "ignore-interrupt" }),
      timeoutMs: 10_000,
    });

    await waitFor(async () => {
      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      return task.provider?.turnId === "turn-fake-1";
    });

    const startedAt = Date.now();
    await interruptTask({
      workspaceRoot,
      taskId: handle.task.taskId,
      reason: "stop stuck protocol",
    });
    const elapsedMs = Date.now() - startedAt;

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.error, "stop stuck protocol");
    assert.ok(elapsedMs < 3_000, `interrupt took ${elapsedMs}ms`);

    const kinds = await agentEventKinds(workspaceRoot, completed.taskId);
    assert.ok(kinds.includes("protocol.interrupt.requested"));
    assert.ok(kinds.includes("protocol.interrupt.request_failed"));
    assert.ok(kinds.includes("protocol.interrupt.fallback_kill"));

    const logs = await readTaskLogs({ workspaceRoot, taskId: completed.taskId, stream: "stderr" });
    assert.match(logs.stderr, /got sigterm/);
  }, "orchestrator-codex-app-server-stuck-interrupt-");
});

test("codex app-server interrupt falls back when no turn id exists yet", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerPlan(workspaceRoot, { FAKE_CODEX_APP_SERVER_MODE: "slow-turn-start" }),
      timeoutMs: 10_000,
    });

    await waitFor(async () => {
      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      return task.provider?.threadId === "thread-fake-1" && !task.provider.turnId;
    });

    await interruptTask({
      workspaceRoot,
      taskId: handle.task.taskId,
      reason: "stop before turn id",
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.error, "stop before turn id");

    const kinds = await agentEventKinds(workspaceRoot, completed.taskId);
    assert.ok(kinds.includes("protocol.interrupt.requested"));
    assert.ok(kinds.includes("protocol.interrupt.missing_turn"));
    assert.ok(kinds.includes("protocol.interrupt.fallback_kill"));
  }, "orchestrator-codex-app-server-missing-turn-interrupt-");
});

test("codex app-server interrupt falls back when protocol ack never settles", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerPlan(workspaceRoot, {
        FAKE_CODEX_APP_SERVER_MODE: "interrupt-no-complete",
      }),
      timeoutMs: 10_000,
    });

    await waitFor(async () => {
      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      return task.provider?.turnId === "turn-fake-1";
    });

    const startedAt = Date.now();
    await interruptTask({
      workspaceRoot,
      taskId: handle.task.taskId,
      reason: "stop unsettled protocol",
    });
    const elapsedMs = Date.now() - startedAt;

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.error, "stop unsettled protocol");
    assert.ok(elapsedMs >= 1_800, `interrupt settled too quickly: ${elapsedMs}ms`);
    assert.ok(elapsedMs < 4_000, `interrupt took ${elapsedMs}ms`);

    const kinds = await agentEventKinds(workspaceRoot, completed.taskId);
    assert.ok(kinds.includes("protocol.interrupt.sent"));
    assert.ok(kinds.includes("protocol.interrupt.settle_timeout"));
    assert.ok(kinds.includes("protocol.interrupt.fallback_kill"));
  }, "orchestrator-codex-app-server-unsettled-interrupt-");
});

test("codex app-server interrupt keeps stop reason when timeout fires during shutdown", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerPlan(workspaceRoot, {
        FAKE_CODEX_APP_SERVER_MODE: "interrupt-no-complete",
      }),
      timeoutMs: 1_000,
    });

    await waitFor(async () => {
      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      return task.provider?.turnId === "turn-fake-1";
    });

    await interruptTask({
      workspaceRoot,
      taskId: handle.task.taskId,
      reason: "operator stopped it",
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.error, "operator stopped it");
  }, "orchestrator-codex-app-server-interrupt-timeout-");
});

test("CLI launch can run codex-app-server through the normal command path", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fakeCodex = await installFakeCodex(workspaceRoot);

    const launch = await runCli(
      workspaceRoot,
      [
        "launch",
        "codex-app-server",
        "--workspace",
        workspaceRoot,
        "--wait",
        "--json",
        "Say hello in one sentence.",
      ],
      10_000,
      fakeCodex.env,
    );
    const task = JSON.parse(launch.stdout) as {
      taskId: string;
      runtime: string;
      status: string;
    };
    assert.equal(task.runtime, "codex-app-server");
    assert.equal(task.status, "succeeded");
    assert.equal(
      await readTaskOutput({ workspaceRoot, taskId: task.taskId }),
      "Hello from fake Codex.",
    );

    const agentEvents = await runCli(workspaceRoot, [
      "events",
      task.taskId,
      "--workspace",
      workspaceRoot,
      "--agent-only",
    ]);
    assert.match(agentEvents.stdout, /agent_event/);
    assert.match(agentEvents.stdout, /thread\.started/);
    assert.match(agentEvents.stdout, /turn\.started/);
    assert.match(agentEvents.stdout, /agent\.usage/);
    assert.match(agentEvents.stdout, /turn\.completed/);
    assert.doesNotMatch(agentEvents.stdout, /thread\/tokenUsage\/updated/);

    const logs = await runCli(workspaceRoot, [
      "logs",
      task.taskId,
      "--workspace",
      workspaceRoot,
      "--stream",
      "all",
    ]);
    const logOutput = `${logs.stdout}${logs.stderr}`;
    assert.match(logOutput, /fake codex app-server ready/);
    assert.doesNotMatch(logOutput, /thread\/tokenUsage\/updated/);
    assert.doesNotMatch(logOutput, /"method":"turn\/start"/);
  }, "orchestrator-codex-app-server-cli-");
});

test("CLI ps surfaces codex-app-server usage while the protocol turn is active", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fakeCodex = await installFakeCodex(workspaceRoot);
    const launch = await runCli(
      workspaceRoot,
      [
        "launch",
        "codex-app-server",
        "--workspace",
        workspaceRoot,
        "--name",
        "app-server usage",
        "--json",
        "Stay active after reporting usage.",
      ],
      10_000,
      {
        ...fakeCodex.env,
        FAKE_CODEX_APP_SERVER_MODE: "usage-hang",
      },
    );
    const task = JSON.parse(launch.stdout) as {
      taskId: string;
      runtime: string;
      name: string;
      status: string;
    };
    assert.equal(task.runtime, "codex-app-server");
    assert.equal(task.name, "app-server usage");

    try {
      await waitFor(async () => {
        const record = await readTaskRecord({ workspaceRoot }, task.taskId);
        return record.status === "running" && record.usage?.totalTokens === 15;
      }, 5_000);

      const ps = await runCli(workspaceRoot, ["ps", "--workspace", workspaceRoot], 10_000);
      assert.match(ps.stdout, /app-server usage/);
      assert.match(ps.stdout, /15/);

      const compact = await runCli(
        workspaceRoot,
        ["ps", "--workspace", workspaceRoot, "--json", "--compact", "--active", "--brief"],
        10_000,
      );
      const compactView = JSON.parse(compact.stdout) as {
        tasks: Array<{ taskId: string; runtime: string; tokens?: number }>;
      };
      const compactTask = compactView.tasks.find((row) => row.taskId === task.taskId);
      assert.ok(compactTask);
      assert.equal(compactTask.runtime, "codex-app-server");
      assert.equal(compactTask.tokens, 15);

      const watch = spawn(
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
            XDG_CONFIG_HOME: join(workspaceRoot, ".config"),
            ORCHESTRATOR_HOME: join(workspaceRoot, ".orchestrator"),
            ...fakeCodex.env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let watchOutput = "";
      watch.stdout.setEncoding("utf8");
      watch.stderr.setEncoding("utf8");
      watch.stdout.on("data", (chunk) => {
        watchOutput += chunk;
      });
      watch.stderr.on("data", (chunk) => {
        watchOutput += chunk;
      });

      try {
        await waitForText(() => watchOutput, /app-server usage[\s\S]*15/);
      } finally {
        watch.kill("SIGTERM");
        await waitForChildExit(watch);
      }
    } finally {
      await runCli(
        workspaceRoot,
        ["interrupt", task.taskId, "--workspace", workspaceRoot, "--reason", "test cleanup"],
        10_000,
        fakeCodex.env,
      ).catch(() => undefined);
    }

    await waitFor(async () => {
      const record = await readTaskRecord({ workspaceRoot }, task.taskId);
      return record.status === "cancelled";
    }, 5_000);
  }, "orchestrator-codex-app-server-usage-");
});

async function installFakeCodex(
  workspaceRoot: string,
): Promise<{ fakeBin: string; env: Record<string, string> }> {
  const fakeBin = join(workspaceRoot, "bin");
  const fakeCodex = join(fakeBin, "codex");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    fakeCodex,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "fake codex 0.0.0"
  exit 0
fi
if [ "$1" = "app-server" ] && [ "$2" = "--listen" ]; then
  exec "$NODE_BIN" "$FAKE_CODEX_APP_SERVER"
fi
echo "unexpected codex args: $*" >&2
exit 1
`,
  );
  await chmod(fakeCodex, 0o755);

  return {
    fakeBin,
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      NODE_BIN: process.execPath,
      FAKE_CODEX_APP_SERVER: fakeAppServerPath,
    },
  };
}

function codexAppServerPlan(cwd: string, env: Record<string, string> = {}): AgentLaunchPlan {
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
      task: "Say hello in one sentence.",
      cwd,
      env,
      model: "fake-model",
    },
    {
      "codex-app-server": runtime,
    },
  );
}

async function agentEventKinds(workspaceRoot: string, taskId: string): Promise<string[]> {
  const events = await readTaskEvents({ workspaceRoot, taskId });
  return events.flatMap((event) =>
    event.type === "agent_event" && typeof event.data.kind === "string" ? [event.data.kind] : [],
  );
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await delay(25);
  }
  assert.fail("Timed out waiting for predicate.");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
