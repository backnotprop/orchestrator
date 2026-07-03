import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CODEX_APP_SERVER_RUNTIME,
  buildAgentLaunchPlan,
  buildAgentResumeLaunchPlan,
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
  sendTaskMessage,
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
    assert.match(transcript, /"ephemeral":true/);
    assert.match(transcript, /"method":"turn\/start"/);
    assert.match(transcript, /"method":"item\/commandExecution\/requestApproval"/);
    assert.match(transcript, /"method":"turn\/completed"/);
  }, "orchestrator-codex-app-server-success-");
});

test("codex app-server executor resumes an existing provider thread", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerResumePlan(workspaceRoot),
      name: "fake codex app-server resume",
      model: "fake-model",
      timeoutMs: 5_000,
      provider: {
        provider: "codex",
        protocol: "jsonrpc",
        transport: "stdio",
        threadId: "thread-fake-1",
      },
      resume: {
        fromTaskId: "source-task",
        rootTaskId: "source-task",
        attempt: 1,
      },
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
      turnId: "turn-fake-resumed-1",
    });

    const events = await readTaskEvents({ workspaceRoot, taskId: completed.taskId });
    const kinds = events.flatMap((event) =>
      event.type === "agent_event" && typeof event.data.kind === "string" ? [event.data.kind] : [],
    );
    assert.ok(kinds.includes("thread.resumed"));
    assert.ok(kinds.includes("turn.started"));
    assert.ok(kinds.includes("turn.completed"));

    const transcript = await readFile(task.paths.transcriptJsonl, "utf8");
    assert.match(transcript, /"method":"thread\/resume"/);
    assert.doesNotMatch(transcript, /"method":"thread\/start"/);
  }, "orchestrator-codex-app-server-resume-");
});

test("codex app-server executor can launch an idle persistent session", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot),
      name: "idle app-server session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    try {
      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return task.status === "running" && task.session?.state === "idle";
      }, 5_000);

      const running = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      assert.equal(running.status, "running");
      assert.equal(running.provider?.provider, "codex");
      assert.equal(running.provider?.threadId, "thread-fake-1");
      assert.equal(running.provider?.turnId, undefined);
      assert.deepEqual(running.session, {
        kind: "codex-app-server",
        state: "idle",
        threadId: "thread-fake-1",
        startedAt: running.session?.startedAt,
        updatedAt: running.session?.updatedAt,
      });

      const transcript = await readFile(running.paths.transcriptJsonl, "utf8");
      assert.match(transcript, /"method":"initialize"/);
      assert.match(transcript, /"method":"thread\/start"/);
      assert.match(transcript, /"ephemeral":false/);
      assert.doesNotMatch(transcript, /"method":"turn\/start"/);

      const kinds = await agentEventKinds(workspaceRoot, running.taskId);
      assert.ok(kinds.includes("thread.started"));
      assert.ok(kinds.includes("session.idle"));

      await interruptTask({
        workspaceRoot,
        taskId: running.taskId,
        reason: "close idle session",
      });
    } catch (error) {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
      throw error;
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.error, "close idle session");
    assert.equal(completed.session?.state, "closed");
    assert.equal(completed.session?.threadId, "thread-fake-1");

    const kinds = await agentEventKinds(workspaceRoot, completed.taskId);
    assert.ok(kinds.includes("protocol.interrupt.session_idle"));
    assert.ok(kinds.includes("protocol.interrupt.fallback_kill"));
  }, "orchestrator-codex-app-server-session-");
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

test("codex app-server executor accepts a message while the turn is running", async () => {
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

    try {
      const sent = await sendTaskMessage({
        workspaceRoot,
        taskId: handle.task.taskId.slice(0, 8),
        text: "Focus on failing tests first.",
        timeoutMs: 2_000,
      });

      assert.equal(sent.status, "accepted");
      assert.equal(sent.provider?.provider, "codex");
      assert.equal(sent.provider?.threadId, "thread-fake-1");
      assert.equal(sent.provider?.turnId, "turn-fake-1");

      const kinds = await agentEventKinds(workspaceRoot, handle.task.taskId);
      assert.ok(kinds.includes("protocol.message.requested"));
      assert.ok(kinds.includes("protocol.message.sent"));
      assert.ok(!kinds.includes("protocol.message.failed"));

      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      const transcript = await readFile(task.paths.transcriptJsonl, "utf8");
      assert.match(transcript, /"method":"turn\/steer"/);
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
  }, "orchestrator-codex-app-server-send-");
});

test("codex app-server send fails clearly when the provider returns a different turn", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerPlan(workspaceRoot, {
        FAKE_CODEX_APP_SERVER_MODE: "steer-turn-mismatch",
      }),
      timeoutMs: 10_000,
    });

    await waitFor(async () => {
      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      return task.provider?.turnId === "turn-fake-1";
    });

    try {
      await assert.rejects(
        sendTaskMessage({
          workspaceRoot,
          taskId: handle.task.taskId,
          text: "Focus on failing tests first.",
          timeoutMs: 2_000,
        }),
        (error: unknown) =>
          error instanceof Error &&
          "reason" in error &&
          error.reason === "turn_mismatch" &&
          /turn-fake-other/.test(error.message),
      );

      const kinds = await agentEventKinds(workspaceRoot, handle.task.taskId);
      assert.ok(kinds.includes("protocol.message.requested"));
      assert.ok(kinds.includes("protocol.message.failed"));
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
  }, "orchestrator-codex-app-server-send-mismatch-");
});

test("codex app-server send respects the message timeout", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerPlan(workspaceRoot, {
        FAKE_CODEX_APP_SERVER_MODE: "steer-delay",
      }),
      timeoutMs: 10_000,
    });

    await waitFor(async () => {
      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      return task.provider?.turnId === "turn-fake-1";
    });

    try {
      await assert.rejects(
        sendTaskMessage({
          workspaceRoot,
          taskId: handle.task.taskId,
          text: "Focus on failing tests first.",
          timeoutMs: 100,
        }),
        (error: unknown) =>
          error instanceof Error &&
          "reason" in error &&
          error.reason === "provider_rejected" &&
          /timed out/.test(error.message),
      );

      const kinds = await agentEventKinds(workspaceRoot, handle.task.taskId);
      assert.ok(kinds.includes("protocol.message.requested"));
      assert.ok(kinds.includes("protocol.message.failed"));
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
  }, "orchestrator-codex-app-server-send-timeout-");
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

test("CLI launch can start and interrupt an idle codex-app-server session", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fakeCodex = await installFakeCodex(workspaceRoot);

    const launch = await runCli(
      workspaceRoot,
      [
        "launch",
        "codex-app-server",
        "--workspace",
        workspaceRoot,
        "--session",
        "--name",
        "idle session",
        "--json",
      ],
      10_000,
      fakeCodex.env,
    );
    const task = JSON.parse(launch.stdout) as {
      taskId: string;
      runtime: string;
      status: string;
      name?: string;
    };
    assert.equal(task.runtime, "codex-app-server");
    assert.equal(task.name, "idle session");

    try {
      await waitFor(async () => {
        const record = await readTaskRecord({ workspaceRoot }, task.taskId);
        return record.status === "running" && record.session?.state === "idle";
      }, 5_000);

      const record = await readTaskRecord({ workspaceRoot }, task.taskId);
      assert.equal(record.provider?.provider, "codex");
      assert.equal(record.provider?.threadId, "thread-fake-1");
      assert.equal(record.provider?.turnId, undefined);
      assert.equal(record.session?.state, "idle");
      assert.equal(record.session?.threadId, "thread-fake-1");

      const events = await runCli(workspaceRoot, [
        "events",
        task.taskId,
        "--workspace",
        workspaceRoot,
        "--agent-only",
      ]);
      assert.match(events.stdout, /thread\.started/);
      assert.match(events.stdout, /session\.idle/);
      assert.doesNotMatch(events.stdout, /turn\.started/);

      const transcript = await readFile(record.paths.transcriptJsonl, "utf8");
      assert.match(transcript, /"method":"thread\/start"/);
      assert.match(transcript, /"ephemeral":false/);
      assert.doesNotMatch(transcript, /"method":"turn\/start"/);
    } finally {
      await runCli(
        workspaceRoot,
        ["interrupt", task.taskId, "--workspace", workspaceRoot, "--reason", "close idle session"],
        10_000,
        fakeCodex.env,
      ).catch(() => undefined);
    }

    await waitFor(async () => {
      const record = await readTaskRecord({ workspaceRoot }, task.taskId);
      return record.status === "cancelled" && record.session?.state === "closed";
    }, 5_000);
  }, "orchestrator-codex-app-server-cli-session-");
});

test("CLI resume can continue a codex-app-server task", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fakeCodex = await installFakeCodex(workspaceRoot);

    const sourceLaunch = await runCli(
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
    const source = JSON.parse(sourceLaunch.stdout) as {
      taskId: string;
      runtime: string;
      status: string;
      provider?: { provider?: string; threadId?: string; turnId?: string };
    };
    assert.equal(source.runtime, "codex-app-server");
    assert.equal(source.status, "succeeded");
    assert.equal(source.provider?.provider, "codex");
    assert.equal(source.provider?.threadId, "thread-fake-1");

    const resumedLaunch = await runCli(
      workspaceRoot,
      [
        "resume",
        source.taskId.slice(0, 8),
        "--workspace",
        workspaceRoot,
        "--wait",
        "--json",
        "Continue with one more short sentence.",
      ],
      10_000,
      fakeCodex.env,
    );
    const resumed = JSON.parse(resumedLaunch.stdout) as {
      taskId: string;
      runtime: string;
      status: string;
      provider?: { provider?: string; threadId?: string; turnId?: string };
    };
    const stored = await readTaskRecord({ workspaceRoot }, resumed.taskId);

    assert.equal(resumed.runtime, "codex-app-server");
    assert.equal(resumed.status, "succeeded");
    assert.deepEqual(stored.resume, {
      fromTaskId: source.taskId,
      rootTaskId: source.taskId,
      attempt: 1,
    });
    assert.deepEqual(stored.provider, {
      provider: "codex",
      protocol: "jsonrpc",
      transport: "stdio",
      threadId: "thread-fake-1",
      turnId: "turn-fake-resumed-1",
    });

    const events = await runCli(workspaceRoot, [
      "events",
      resumed.taskId,
      "--workspace",
      workspaceRoot,
      "--agent-only",
    ]);
    assert.match(events.stdout, /thread\.resumed/);
    assert.match(events.stdout, /turn\.completed/);
  }, "orchestrator-codex-app-server-cli-resume-");
});

test("CLI resume rejects an active codex-app-server task on the same provider thread", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const fakeCodex = await installFakeCodex(workspaceRoot);

    const sourceLaunch = await runCli(
      workspaceRoot,
      [
        "launch",
        "codex-app-server",
        "--workspace",
        workspaceRoot,
        "--wait",
        "--json",
        "Create the source thread.",
      ],
      10_000,
      fakeCodex.env,
    );
    const source = JSON.parse(sourceLaunch.stdout) as { taskId: string };

    const activeLaunch = await runCli(
      workspaceRoot,
      [
        "launch",
        "codex-app-server",
        "--workspace",
        workspaceRoot,
        "--json",
        "Keep the same provider thread active.",
      ],
      10_000,
      {
        ...fakeCodex.env,
        FAKE_CODEX_APP_SERVER_MODE: "hang",
        FAKE_CODEX_APP_SERVER_THREAD_ID: "thread-fake-1",
      },
    );
    const active = JSON.parse(activeLaunch.stdout) as { taskId: string };

    try {
      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, active.taskId);
        return task.provider?.provider === "codex" && task.provider.threadId === "thread-fake-1";
      }, 5_000);

      await assert.rejects(
        runCli(
          workspaceRoot,
          [
            "resume",
            source.taskId.slice(0, 8),
            "--workspace",
            workspaceRoot,
            "--json",
            "This should be rejected.",
          ],
          10_000,
          fakeCodex.env,
        ),
        (error: unknown) => {
          const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
          const parsed = JSON.parse(stderr) as {
            error: { reason?: string; input?: string; hint?: string };
          };
          assert.equal(parsed.error.reason, "resume_session_active");
          assert.equal(parsed.error.input, active.taskId);
          assert.match(parsed.error.hint ?? "", /active task/);
          return true;
        },
      );
    } finally {
      await runCli(
        workspaceRoot,
        ["interrupt", active.taskId, "--workspace", workspaceRoot, "--reason", "test cleanup"],
        10_000,
        fakeCodex.env,
      ).catch(() => undefined);
    }
  }, "orchestrator-codex-app-server-cli-resume-conflict-");
});

test("CLI send can message a detached running codex-app-server task", async () => {
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
        "send target",
        "--json",
        "Stay active so a follow-up can be sent.",
      ],
      10_000,
      {
        ...fakeCodex.env,
        FAKE_CODEX_APP_SERVER_MODE: "hang",
      },
    );
    const task = JSON.parse(launch.stdout) as {
      taskId: string;
      runtime: string;
      status: string;
    };
    assert.equal(task.runtime, "codex-app-server");

    try {
      await waitFor(async () => {
        const record = await readTaskRecord({ workspaceRoot }, task.taskId);
        return record.status === "running" && record.provider?.turnId === "turn-fake-1";
      }, 5_000);

      const send = await runCli(
        workspaceRoot,
        [
          "send",
          task.taskId.slice(0, 8),
          "--workspace",
          workspaceRoot,
          "--json",
          "--compact",
          "Focus on failing tests first.",
        ],
        10_000,
        fakeCodex.env,
      );
      const sent = JSON.parse(send.stdout) as {
        ok: boolean;
        task: { taskId: string; runtime: string; status: string };
        message: { status: string; provider?: { threadId?: string; turnId?: string } };
      };
      assert.equal(sent.ok, true);
      assert.equal(sent.task.taskId, task.taskId);
      assert.equal(sent.task.runtime, "codex-app-server");
      assert.equal(sent.message.status, "accepted");
      assert.equal(sent.message.provider?.threadId, "thread-fake-1");
      assert.equal(sent.message.provider?.turnId, "turn-fake-1");

      const events = await runCli(workspaceRoot, [
        "events",
        task.taskId.slice(0, 8),
        "--workspace",
        workspaceRoot,
        "--agent-only",
      ]);
      assert.match(events.stdout, /protocol\.message\.requested/);
      assert.match(events.stdout, /protocol\.message\.sent/);
      assert.doesNotMatch(events.stdout, /turn\/steer/);

      const record = await readTaskRecord({ workspaceRoot }, task.taskId);
      const transcript = await readFile(record.paths.transcriptJsonl, "utf8");
      assert.match(transcript, /"method":"turn\/steer"/);
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
  }, "orchestrator-codex-app-server-cli-send-");
});

test("CLI send reports unsupported runtimes as machine-readable errors", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const launch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--name",
      "plain shell",
      "--json",
      `${process.execPath} -e "setTimeout(() => {}, 2000)"`,
    ]);
    const task = JSON.parse(launch.stdout) as { taskId: string };

    try {
      await waitFor(async () => {
        const record = await readTaskRecord({ workspaceRoot }, task.taskId);
        return record.status === "running";
      }, 5_000);

      await assert.rejects(
        runCli(
          workspaceRoot,
          [
            "send",
            task.taskId.slice(0, 8),
            "--workspace",
            workspaceRoot,
            "--json",
            "--compact",
            "Please change direction.",
          ],
          10_000,
        ),
        (error: unknown) => {
          const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
          const parsed = JSON.parse(stderr) as {
            error: { reason?: string; input?: string; hint?: string };
          };
          assert.equal(parsed.error.reason, "unsupported");
          assert.equal(parsed.error.input, task.taskId);
          assert.match(parsed.error.hint ?? "", /resume|launch|read/);
          return true;
        },
      );
    } finally {
      await runCli(
        workspaceRoot,
        ["interrupt", task.taskId, "--workspace", workspaceRoot, "--reason", "test cleanup"],
        10_000,
      ).catch(() => undefined);
    }
  }, "orchestrator-codex-app-server-cli-send-unsupported-");
});

test("CLI send does not apply an expired detached control request later", async () => {
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
        "expiry target",
        "--json",
        "Stay active so an expired follow-up can be rejected.",
      ],
      10_000,
      {
        ...fakeCodex.env,
        FAKE_CODEX_APP_SERVER_MODE: "hang",
      },
    );
    const task = JSON.parse(launch.stdout) as { taskId: string };

    try {
      await waitFor(async () => {
        const record = await readTaskRecord({ workspaceRoot }, task.taskId);
        return record.status === "running" && record.provider?.turnId === "turn-fake-1";
      }, 5_000);

      await assert.rejects(
        runCli(
          workspaceRoot,
          [
            "send",
            task.taskId.slice(0, 8),
            "--workspace",
            workspaceRoot,
            "--timeout-ms",
            "1",
            "--json",
            "--compact",
            "This message should expire before the runner handles it.",
          ],
          10_000,
          fakeCodex.env,
        ),
        (error: unknown) => {
          const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
          const parsed = JSON.parse(stderr) as { error: { reason?: string } };
          assert.equal(parsed.error.reason, "timeout");
          return true;
        },
      );

      await delay(400);
      const record = await readTaskRecord({ workspaceRoot }, task.taskId);
      const transcript = await readFile(record.paths.transcriptJsonl, "utf8");
      assert.doesNotMatch(transcript, /"method":"turn\/steer"/);

      const kinds = await agentEventKinds(workspaceRoot, task.taskId);
      assert.ok(!kinds.includes("protocol.message.requested"));
      assert.ok(!kinds.includes("protocol.message.sent"));
    } finally {
      await runCli(
        workspaceRoot,
        ["interrupt", task.taskId, "--workspace", workspaceRoot, "--reason", "test cleanup"],
        10_000,
        fakeCodex.env,
      ).catch(() => undefined);
    }
  }, "orchestrator-codex-app-server-cli-send-expired-");
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

function codexAppServerResumePlan(cwd: string, env: Record<string, string> = {}): AgentLaunchPlan {
  const runtime: HeadlessAgentRuntimeConfig = {
    ...CODEX_APP_SERVER_RUNTIME,
    launch: {
      ...CODEX_APP_SERVER_RUNTIME.launch,
      executable: process.execPath,
      baseArgs: [fakeAppServerPath],
    },
  };

  return buildAgentResumeLaunchPlan(
    {
      runtime: "codex-app-server",
      task: "Continue in one sentence.",
      cwd,
      env,
      model: "fake-model",
      provider: { threadId: "thread-fake-1" },
    },
    {
      "codex-app-server": runtime,
    },
  );
}

function codexAppServerSessionPlan(cwd: string, env: Record<string, string> = {}): AgentLaunchPlan {
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
      env,
      model: "fake-model",
      session: true,
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
