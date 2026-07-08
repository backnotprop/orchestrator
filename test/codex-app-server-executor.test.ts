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
  clearTaskGoal,
  getTaskGoal,
  interruptTask,
  launchTask,
  readTaskEvents,
  readTaskLogs,
  readTaskOutput,
  readTaskRecord,
  sendTaskMessage,
  setTaskGoal,
  startTaskGoal,
} from "@backnotprop/orchestrator-core/tasks";
import {
  cliPath,
  runCli,
  waitForChildExit,
  waitForText,
  withTempWorkspace,
} from "./cli-support.ts";
import {
  FAKE_SHARED_CODEX_APP_SERVER_SOCKET_ENV,
  withFakeSharedCodexAppServer,
} from "./fake-shared-codex-app-server.ts";

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

test("codex app-server session send can start repeated turns and return to idle", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot),
      name: "repeat app-server session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    try {
      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return task.status === "running" && task.session?.state === "idle";
      }, 5_000);

      const first = await sendTaskMessage({
        workspaceRoot,
        taskId: handle.task.taskId,
        text: "Say hello once.",
        wait: true,
        timeoutMs: 5_000,
      });
      assert.equal(first.status, "completed");
      assert.equal(first.provider?.threadId, "thread-fake-1");
      assert.equal(first.provider?.turnId, "turn-fake-1");
      assert.equal(first.operation?.status, "succeeded");
      assert.equal(first.operation?.turnId, "turn-fake-1");
      assert.equal(first.operation?.result, "Hello from fake Codex.");

      const afterFirst = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      assert.equal(afterFirst.status, "running");
      assert.equal(afterFirst.session?.state, "idle");
      assert.equal(afterFirst.session?.currentTurnId, undefined);
      assert.equal(afterFirst.session?.currentOperationId, undefined);
      assert.equal(afterFirst.currentOperation, undefined);
      assert.equal(afterFirst.lastOperation?.turnId, "turn-fake-1");
      assert.equal(
        await readTaskOutput({ workspaceRoot, taskId: handle.task.taskId }),
        "Hello from fake Codex.",
      );

      const second = await sendTaskMessage({
        workspaceRoot,
        taskId: handle.task.taskId.slice(0, 8),
        text: "Say hello again.",
        wait: true,
        timeoutMs: 5_000,
      });
      assert.equal(second.status, "completed");
      assert.equal(second.provider?.threadId, "thread-fake-1");
      assert.equal(second.provider?.turnId, "turn-fake-2");
      assert.equal(second.operation?.turnId, "turn-fake-2");
      assert.equal(second.operation?.result, "Hello from fake Codex.");

      const afterSecond = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      assert.equal(afterSecond.status, "running");
      assert.equal(afterSecond.session?.state, "idle");
      assert.equal(afterSecond.provider?.threadId, "thread-fake-1");
      assert.equal(afterSecond.provider?.turnId, "turn-fake-2");
      assert.equal(afterSecond.lastOperation?.turnId, "turn-fake-2");

      const transcript = await readFile(afterSecond.paths.transcriptJsonl, "utf8");
      assert.equal((transcript.match(/"method":"turn\/start"/g) ?? []).length, 2);
      assert.doesNotMatch(transcript, /"method":"turn\/steer"/);

      const kinds = await agentEventKinds(workspaceRoot, handle.task.taskId);
      assert.equal(kinds.filter((kind) => kind === "operation.started").length, 2);
      assert.equal(kinds.filter((kind) => kind === "operation.completed").length, 2);
      assert.ok(kinds.includes("session.idle"));
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
  }, "orchestrator-codex-app-server-session-repeat-send-");
});

test("codex app-server session goal start waits for native goal completion", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot),
      name: "goal app-server session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    try {
      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return task.status === "running" && task.session?.state === "idle";
      }, 5_000);

      const goal = await startTaskGoal({
        workspaceRoot,
        taskId: handle.task.taskId.slice(0, 8),
        goal: "Improve performance by 10%.",
        wait: true,
        timeoutMs: 5_000,
        tokenBudget: 1000,
      });

      assert.equal(goal.status, "completed");
      assert.equal(goal.provider?.threadId, "thread-fake-1");
      assert.equal(goal.provider?.turnId, "turn-fake-goal-1");
      assert.equal(goal.goal?.status, "complete");
      assert.equal(goal.goal?.objective, "Improve performance by 10%.");
      assert.equal(goal.goal?.tokenBudget, 1000);
      assert.equal(goal.operation?.kind, "goal");
      assert.equal(goal.operation?.status, "complete");
      assert.equal(goal.operation?.turnId, "turn-fake-goal-1");
      assert.equal(goal.operation?.result, "Goal complete from fake Codex.");

      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      assert.equal(task.status, "running");
      assert.equal(task.session?.state, "idle");
      assert.equal(task.session?.currentTurnId, undefined);
      assert.equal(task.currentOperation, undefined);
      assert.equal(task.goal?.status, "complete");
      assert.equal(task.lastOperation?.kind, "goal");
      assert.equal(task.lastOperation?.status, "complete");
      assert.equal(
        await readTaskOutput({ workspaceRoot, taskId: handle.task.taskId }),
        "Goal complete from fake Codex.",
      );

      const transcript = await readFile(task.paths.transcriptJsonl, "utf8");
      assert.match(transcript, /"method":"thread\/read"/);
      assert.match(transcript, /"method":"thread\/goal\/get"/);
      assert.match(transcript, /"method":"thread\/goal\/set"/);
      assert.match(transcript, /"method":"thread\/goal\/updated"/);
      assert.match(transcript, /"method":"turn\/started"/);
      assert.match(transcript, /"method":"turn\/completed"/);

      const kinds = await agentEventKinds(workspaceRoot, handle.task.taskId);
      assert.ok(kinds.includes("protocol.goal.requested"));
      assert.ok(kinds.includes("protocol.goal.sent"));
      assert.ok(kinds.includes("protocol.goal.started"));
      assert.ok(kinds.includes("goal.updated"));
      assert.ok(kinds.includes("operation.completed"));
      assert.ok(kinds.includes("session.idle"));
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
  }, "orchestrator-codex-app-server-session-goal-start-");
});

test("codex app-server session goal get set and clear control provider goal state", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot, {
        FAKE_CODEX_APP_SERVER_GOAL_TIMESTAMP_UNIT: "seconds",
      }),
      name: "goal control app-server session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    try {
      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return task.status === "running" && task.session?.state === "idle";
      }, 5_000);

      const empty = await getTaskGoal({
        workspaceRoot,
        taskId: handle.task.taskId.slice(0, 8),
        timeoutMs: 5_000,
      });
      assert.equal(empty.source, "provider");
      assert.equal(empty.goal, undefined);

      const paused = await setTaskGoal({
        workspaceRoot,
        taskId: handle.task.taskId.slice(0, 8),
        objective: "Pause performance work.",
        status: "paused",
        tokenBudget: 1000,
        timeoutMs: 5_000,
      });
      assert.equal(paused.source, "provider");
      assert.equal(paused.goal.status, "paused");
      assert.equal(paused.goal.objective, "Pause performance work.");
      assert.equal(paused.goal.tokenBudget, 1000);
      assert.equal(paused.goal.tokensUsed, 15);
      assert.match(paused.goal.createdAt ?? "", /^\d{4}-/);

      const fresh = await getTaskGoal({
        workspaceRoot,
        taskId: handle.task.taskId,
        timeoutMs: 5_000,
      });
      assert.equal(fresh.source, "provider");
      assert.equal(fresh.goal?.status, "paused");

      const cleared = await clearTaskGoal({
        workspaceRoot,
        taskId: handle.task.taskId,
        timeoutMs: 5_000,
      });
      assert.equal(cleared.source, "provider");
      assert.equal(cleared.cleared, true);

      const emptyAgain = await getTaskGoal({
        workspaceRoot,
        taskId: handle.task.taskId,
        timeoutMs: 5_000,
      });
      assert.equal(emptyAgain.goal, undefined);

      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      assert.equal(task.goal, undefined);
      assert.equal(task.session?.state, "idle");

      const transcript = await readFile(task.paths.transcriptJsonl, "utf8");
      assert.match(transcript, /"method":"thread\/goal\/get"/);
      assert.match(transcript, /"method":"thread\/goal\/set"/);
      assert.match(transcript, /"method":"thread\/goal\/clear"/);

      const kinds = await agentEventKinds(workspaceRoot, handle.task.taskId);
      assert.ok(kinds.includes("protocol.goal.get"));
      assert.ok(kinds.includes("protocol.goal.set"));
      assert.ok(kinds.includes("protocol.goal.cleared"));
      assert.ok(kinds.includes("goal.updated"));
      assert.ok(kinds.includes("goal.cleared"));
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
  }, "orchestrator-codex-app-server-session-goal-control-");
});

test("codex app-server session goal set rejects active status", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot),
      name: "active set app-server session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    try {
      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return task.status === "running" && task.session?.state === "idle";
      }, 5_000);

      await assert.rejects(
        setTaskGoal({
          workspaceRoot,
          taskId: handle.task.taskId,
          // SAFETY: This test exercises the runtime guard for malformed JS callers.
          status: "active" as never,
          timeoutMs: 5_000,
        }),
        (error: unknown) =>
          error instanceof Error &&
          "reason" in error &&
          error.reason === "invalid_request" &&
          /goal set cannot activate/.test(error.message),
      );
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
  }, "orchestrator-codex-app-server-session-goal-set-active-");
});

test("codex app-server session goal start accepts a terminal goal before turn start", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot, {
        FAKE_CODEX_APP_SERVER_MODE: "goal-complete-without-turn",
      }),
      name: "fast goal app-server session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    try {
      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return task.status === "running" && task.session?.state === "idle";
      }, 5_000);

      const goal = await startTaskGoal({
        workspaceRoot,
        taskId: handle.task.taskId,
        goal: "Finish immediately.",
        wait: true,
        timeoutMs: 5_000,
      });

      assert.equal(goal.status, "completed");
      assert.equal(goal.provider?.threadId, "thread-fake-1");
      assert.equal(goal.provider?.turnId, undefined);
      assert.equal(goal.goal?.status, "complete");
      assert.equal(goal.operation?.kind, "goal");
      assert.equal(goal.operation?.status, "complete");
      assert.equal(goal.operation?.turnId, undefined);

      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      assert.equal(task.session?.state, "idle");
      assert.equal(task.currentOperation, undefined);
      assert.equal(task.lastOperation?.kind, "goal");
      assert.equal(task.lastOperation?.status, "complete");

      const kinds = await agentEventKinds(workspaceRoot, handle.task.taskId);
      assert.ok(kinds.includes("protocol.goal.sent"));
      assert.ok(kinds.includes("operation.completed"));
      assert.equal(kinds.includes("protocol.goal.started"), false);
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
  }, "orchestrator-codex-app-server-session-goal-fast-terminal-");
});

test("codex app-server session goal start rejects unfinished existing goals", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot, {
        FAKE_CODEX_APP_SERVER_MODE: "goal-existing-active",
      }),
      name: "existing goal app-server session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    try {
      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return task.status === "running" && task.session?.state === "idle";
      }, 5_000);

      await assert.rejects(
        startTaskGoal({
          workspaceRoot,
          taskId: handle.task.taskId,
          goal: "Start a second goal.",
          wait: true,
          timeoutMs: 5_000,
        }),
        (error: unknown) =>
          error instanceof Error &&
          "reason" in error &&
          error.reason === "not_ready" &&
          /unfinished goal/.test(error.message),
      );

      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      assert.equal(task.session?.state, "idle");
      assert.equal(task.currentOperation, undefined);
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
  }, "orchestrator-codex-app-server-session-goal-existing-");
});

test("codex app-server session goal start without wait records a running operation", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot, {
        FAKE_CODEX_APP_SERVER_MODE: "goal-delay",
        FAKE_CODEX_APP_SERVER_GOAL_DELAY_MS: "1000",
      }),
      name: "running goal app-server session",
      model: "fake-model",
      timeoutMs: 2_000,
    });
    let completed: Awaited<typeof handle.completed> | undefined;

    try {
      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return task.status === "running" && task.session?.state === "idle";
      }, 5_000);

      const goal = await startTaskGoal({
        workspaceRoot,
        taskId: handle.task.taskId,
        goal: "Keep working on the long goal.",
        wait: false,
        timeoutMs: 5_000,
      });

      assert.equal(goal.status, "running");
      assert.equal(goal.provider?.threadId, "thread-fake-1");
      assert.equal(goal.provider?.turnId, "turn-fake-goal-1");
      assert.equal(goal.goal?.status, "active");
      assert.equal(goal.operation?.kind, "goal");
      assert.equal(goal.operation?.status, "running");
      assert.equal(goal.operation?.turnId, "turn-fake-goal-1");

      await assert.rejects(
        clearTaskGoal({
          workspaceRoot,
          taskId: handle.task.taskId,
          timeoutMs: 5_000,
        }),
        (error: unknown) =>
          error instanceof Error &&
          "reason" in error &&
          error.reason === "not_ready" &&
          /running a goal/.test(error.message),
      );

      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      assert.ok(task.session?.state === "goal_running" || task.session?.state === "idle");
      if (task.session?.currentTurnId) {
        assert.equal(task.session.currentTurnId, "turn-fake-goal-1");
      }
      assert.equal(task.currentOperation?.kind ?? task.lastOperation?.kind, "goal");
      assert.ok(task.goal?.status === "active" || task.goal?.status === "complete");

      await waitFor(async () => {
        const kinds = await agentEventKinds(workspaceRoot, handle.task.taskId);
        return kinds.includes("goal.updated") && kinds.includes("turn.started");
      }, 5_000);

      await waitFor(async () => {
        const finished = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return finished.session?.state === "idle" && finished.goal?.status === "complete";
      }, 5_000);
    } finally {
      completed = await handle.completed;
    }

    assert.equal(completed.status, "timed_out");
  }, "orchestrator-codex-app-server-session-goal-running-");
});

for (const [providerStatus, normalizedStatus] of [
  ["paused", "paused"],
  ["blocked", "blocked"],
  ["usageLimited", "usage_limited"],
  ["budgetLimited", "budget_limited"],
] as const) {
  test(`codex app-server session goal start settles ${normalizedStatus} goals`, async () => {
    await withTempWorkspace(async (workspaceRoot) => {
      const handle = await launchTask({
        workspaceRoot,
        plan: codexAppServerSessionPlan(workspaceRoot, {
          FAKE_CODEX_APP_SERVER_GOAL_STATUS: providerStatus,
        }),
        name: `${normalizedStatus} goal app-server session`,
        model: "fake-model",
        timeoutMs: 10_000,
      });

      try {
        await waitFor(async () => {
          const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
          return task.status === "running" && task.session?.state === "idle";
        }, 5_000);

        const goal = await startTaskGoal({
          workspaceRoot,
          taskId: handle.task.taskId,
          goal: `Reach ${normalizedStatus}.`,
          wait: true,
          timeoutMs: 5_000,
        });

        assert.equal(goal.status, "completed");
        assert.equal(goal.goal?.status, normalizedStatus);
        assert.equal(goal.operation?.kind, "goal");
        assert.equal(goal.operation?.status, normalizedStatus);

        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        assert.equal(task.session?.state, "idle");
        assert.equal(task.goal?.status, normalizedStatus);
        assert.equal(task.lastOperation?.status, normalizedStatus);
      } finally {
        await interruptTask({
          workspaceRoot,
          taskId: handle.task.taskId,
          reason: "test cleanup",
        }).catch(() => undefined);
      }

      const completed = await handle.completed;
      assert.equal(completed.status, "cancelled");
    }, `orchestrator-codex-app-server-session-goal-${normalizedStatus}-`);
  });
}

test("codex app-server goal start rejects non-session tasks", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerPlan(workspaceRoot, {
        FAKE_CODEX_APP_SERVER_MODE: "hang",
      }),
      name: "non-session app-server task",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    try {
      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return task.status === "running";
      }, 5_000);

      await assert.rejects(
        startTaskGoal({
          workspaceRoot,
          taskId: handle.task.taskId,
          goal: "Try a goal on a one-shot task.",
          wait: true,
          timeoutMs: 5_000,
        }),
        (error: unknown) =>
          error instanceof Error &&
          "reason" in error &&
          error.reason === "unsupported" &&
          /does not support native goals/.test(error.message),
      );
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
  }, "orchestrator-codex-app-server-goal-non-session-");
});

test("codex app-server goal start rejects unsupported runtimes", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: {
        runtime: "shell",
        displayName: "shell",
        executable: process.execPath,
        args: ["-e", "setTimeout(() => {}, 2000)"],
        env: {},
        cwd: workspaceRoot,
        promptTransport: { kind: "argv", position: "last" },
        outputTransport: { kind: "stdout_text" },
        expectedProcesses: ["node"],
        interrupt: "process_group",
        canSteerRunning: false,
        handlesOwnAuth: false,
        enabled: true,
        safety: {
          acceptsShellCommand: false,
        },
      },
      name: "unsupported goal runtime",
      timeoutMs: 10_000,
    });

    try {
      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return task.status === "running";
      }, 5_000);

      await assert.rejects(
        startTaskGoal({
          workspaceRoot,
          taskId: handle.task.taskId,
          goal: "Try a goal on shell.",
          wait: true,
          timeoutMs: 5_000,
        }),
        (error: unknown) =>
          error instanceof Error &&
          "reason" in error &&
          error.reason === "unsupported" &&
          /does not support native goals/.test(error.message),
      );
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
  }, "orchestrator-codex-app-server-goal-unsupported-runtime-");
});

test("codex app-server session ignores late turn ids after idle send timeout", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot, {
        FAKE_CODEX_APP_SERVER_MODE: "late-turn-start",
      }),
      name: "late app-server session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    try {
      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return task.status === "running" && task.session?.state === "idle";
      }, 5_000);

      await assert.rejects(
        sendTaskMessage({
          workspaceRoot,
          taskId: handle.task.taskId,
          text: "Start too slowly.",
          wait: true,
          timeoutMs: 50,
        }),
        (error: unknown) =>
          error instanceof Error &&
          "reason" in error &&
          error.reason === "provider_rejected" &&
          /timed out/.test(error.message),
      );

      await delay(300);

      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      assert.equal(task.status, "running");
      assert.equal(task.session?.state, "idle");
      assert.equal(task.session?.currentTurnId, undefined);
      assert.equal(task.currentOperation, undefined);
      assert.equal(task.lastOperation?.status, "failed");
      assert.equal(task.provider?.turnId, undefined);

      const kinds = await agentEventKinds(workspaceRoot, handle.task.taskId);
      assert.ok(kinds.includes("operation.failed"));
      assert.ok(kinds.includes("turn.started"));
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
  }, "orchestrator-codex-app-server-session-late-send-");
});

test("codex app-server session send steers an active session turn", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot, { FAKE_CODEX_APP_SERVER_MODE: "hang" }),
      name: "steer app-server session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    try {
      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return task.status === "running" && task.session?.state === "idle";
      }, 5_000);

      const started = await sendTaskMessage({
        workspaceRoot,
        taskId: handle.task.taskId,
        text: "Start a long turn.",
        timeoutMs: 2_000,
      });
      assert.equal(started.status, "running");
      assert.equal(started.operation?.status, "running");
      assert.equal(started.operation?.turnId, "turn-fake-1");

      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return (
          task.session?.state === "turn_running" && task.session.currentTurnId === "turn-fake-1"
        );
      }, 5_000);

      const steered = await sendTaskMessage({
        workspaceRoot,
        taskId: handle.task.taskId,
        text: "Focus on failing tests first.",
        timeoutMs: 2_000,
      });
      assert.equal(steered.status, "accepted");
      assert.equal(steered.provider?.turnId, "turn-fake-1");

      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      const transcript = await readFile(task.paths.transcriptJsonl, "utf8");
      assert.match(transcript, /"method":"turn\/start"/);
      assert.match(transcript, /"method":"turn\/steer"/);

      const kinds = await agentEventKinds(workspaceRoot, handle.task.taskId);
      assert.ok(kinds.includes("protocol.message.sent"));
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
    }

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.session?.state, "closed");
    assert.equal(completed.currentOperation, undefined);
    assert.equal(completed.lastOperation?.kind, "turn");
    assert.equal(completed.lastOperation?.status, "interrupted");
  }, "orchestrator-codex-app-server-session-steer-");
});

test("codex app-server session send wait fails when interrupted", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot, { FAKE_CODEX_APP_SERVER_MODE: "hang" }),
      name: "interrupted send app-server session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    await waitFor(async () => {
      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      return task.status === "running" && task.session?.state === "idle";
    }, 5_000);

    const pendingSend = sendTaskMessage({
      workspaceRoot,
      taskId: handle.task.taskId,
      text: "Start a long turn.",
      wait: true,
      timeoutMs: 5_000,
    });

    await waitFor(async () => {
      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      return task.session?.state === "turn_running" && task.currentOperation?.kind === "turn";
    }, 5_000);

    await interruptTask({
      workspaceRoot,
      taskId: handle.task.taskId,
      reason: "stop waited send",
    });

    await assert.rejects(pendingSend, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal("reason" in error ? error.reason : undefined, "interrupted");
      assert.equal(error.message, "stop waited send");
      return true;
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.lastOperation?.kind, "turn");
    assert.equal(completed.lastOperation?.status, "interrupted");
  }, "orchestrator-codex-app-server-session-send-wait-interrupt-");
});

test("codex app-server session interrupt settles a running goal operation", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot, {
        FAKE_CODEX_APP_SERVER_MODE: "goal-hang",
      }),
      name: "hanging goal app-server session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    await waitFor(async () => {
      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      return task.status === "running" && task.session?.state === "idle";
    }, 5_000);

    const started = await startTaskGoal({
      workspaceRoot,
      taskId: handle.task.taskId,
      goal: "Keep the goal running.",
      timeoutMs: 5_000,
    });
    assert.equal(started.status, "running");
    assert.equal(started.operation?.kind, "goal");
    assert.equal(started.operation?.status, "running");

    await waitFor(async () => {
      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      return task.session?.state === "goal_running" && task.currentOperation?.kind === "goal";
    }, 5_000);

    await interruptTask({
      workspaceRoot,
      taskId: handle.task.taskId,
      reason: "stop hanging goal",
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.session?.state, "closed");
    assert.equal(completed.currentOperation, undefined);
    assert.equal(completed.lastOperation?.kind, "goal");
    assert.equal(completed.lastOperation?.status, "interrupted");
    assert.equal(completed.lastOperation?.error, "stop hanging goal");
    assert.equal(completed.goal?.status, "active");
  }, "orchestrator-codex-app-server-session-goal-interrupt-");
});

test("codex app-server session goal wait fails when interrupted", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot, {
        FAKE_CODEX_APP_SERVER_MODE: "goal-hang",
      }),
      name: "interrupted goal app-server session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    await waitFor(async () => {
      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      return task.status === "running" && task.session?.state === "idle";
    }, 5_000);

    const pendingGoal = startTaskGoal({
      workspaceRoot,
      taskId: handle.task.taskId,
      goal: "Keep the goal running.",
      wait: true,
      timeoutMs: 5_000,
    });

    await waitFor(async () => {
      const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
      return task.session?.state === "goal_running" && task.currentOperation?.kind === "goal";
    }, 5_000);

    await interruptTask({
      workspaceRoot,
      taskId: handle.task.taskId,
      reason: "stop waited goal",
    });

    await assert.rejects(pendingGoal, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal("reason" in error ? error.reason : undefined, "interrupted");
      assert.equal(error.message, "stop waited goal");
      return true;
    });

    const completed = await handle.completed;
    assert.equal(completed.status, "cancelled");
    assert.equal(completed.lastOperation?.kind, "goal");
    assert.equal(completed.lastOperation?.status, "interrupted");
  }, "orchestrator-codex-app-server-session-goal-wait-interrupt-");
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
  await withFakeSharedCodexAppServer(async ({ socketPath }) => {
    await withTempWorkspace(async (workspaceRoot) => {
      const fakeEnv = { [FAKE_SHARED_CODEX_APP_SERVER_SOCKET_ENV]: socketPath };

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
        fakeEnv,
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
        const record = await readTaskRecord({ workspaceRoot }, task.taskId);
        assert.equal(record.status, "running");
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
        assert.doesNotMatch(transcript, /"method":"turn\/start"/);
      } finally {
        await runCli(
          workspaceRoot,
          [
            "interrupt",
            task.taskId,
            "--workspace",
            workspaceRoot,
            "--reason",
            "close idle session",
          ],
          10_000,
          fakeEnv,
        ).catch(() => undefined);
      }

      await waitFor(async () => {
        const record = await readTaskRecord({ workspaceRoot }, task.taskId);
        return record.status === "cancelled" && record.session?.state === "closed";
      }, 5_000);
    }, "orchestrator-codex-app-server-cli-session-");
  });
});

test("CLI send --wait can run repeated work in an idle codex-app-server session", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const fakeEnv = { [FAKE_SHARED_CODEX_APP_SERVER_SOCKET_ENV]: socketPath };

        const launch = await runCli(
          workspaceRoot,
          [
            "launch",
            "codex-app-server",
            "--workspace",
            workspaceRoot,
            "--session",
            "--name",
            "repeat cli session",
            "--json",
          ],
          10_000,
          fakeEnv,
        );
        const task = JSON.parse(launch.stdout) as { taskId: string; runtime: string };
        assert.equal(task.runtime, "codex-app-server");

        try {
          const record = await readTaskRecord({ workspaceRoot }, task.taskId);
          assert.equal(record.status, "running");
          assert.equal(record.session?.state, "idle");

          const first = await runCli(
            workspaceRoot,
            [
              "send",
              task.taskId.slice(0, 8),
              "--workspace",
              workspaceRoot,
              "--wait",
              "--json",
              "--compact",
              "Say hello once.",
            ],
            10_000,
            fakeEnv,
          );
          const firstSent = JSON.parse(first.stdout) as {
            ok: boolean;
            task: {
              taskId: string;
              runtime: string;
              status: string;
              session?: { state?: string; currentTurnId?: string };
              lastOperation?: { result?: string; turnId?: string };
            };
            message: {
              status: string;
              operation?: { result?: string; turnId?: string };
            };
          };
          assert.equal(firstSent.ok, true);
          assert.equal(firstSent.message.status, "completed");
          assert.equal(firstSent.message.operation?.turnId, "turn-fake-1");
          assert.equal(firstSent.message.operation?.result, "Hello from fake Codex.");
          assert.equal(firstSent.task.session?.state, "idle");
          assert.equal(firstSent.task.session?.currentTurnId, undefined);
          assert.equal(firstSent.task.lastOperation?.turnId, "turn-fake-1");

          const second = await runCli(
            workspaceRoot,
            [
              "send",
              task.taskId.slice(0, 8),
              "--workspace",
              workspaceRoot,
              "--wait",
              "--json",
              "--compact",
              "Say hello again.",
            ],
            10_000,
            fakeEnv,
          );
          const secondSent = JSON.parse(second.stdout) as {
            message: { status: string; operation?: { result?: string; turnId?: string } };
            task: { session?: { state?: string }; lastOperation?: { turnId?: string } };
          };
          assert.equal(secondSent.message.status, "completed");
          assert.equal(secondSent.message.operation?.turnId, "turn-fake-2");
          assert.equal(secondSent.message.operation?.result, "Hello from fake Codex.");
          assert.equal(secondSent.task.session?.state, "idle");
          assert.equal(secondSent.task.lastOperation?.turnId, "turn-fake-2");
        } finally {
          await runCli(
            workspaceRoot,
            ["interrupt", task.taskId, "--workspace", workspaceRoot, "--reason", "test cleanup"],
            10_000,
            fakeEnv,
          ).catch(() => undefined);
        }

        await waitFor(async () => {
          const record = await readTaskRecord({ workspaceRoot }, task.taskId);
          return record.status === "cancelled" && record.session?.state === "closed";
        }, 5_000);
      }, "orchestrator-codex-app-server-cli-session-send-wait-");
    },
    {
      resultText: "Hello from fake Codex.",
    },
  );
});

test("CLI goal start --wait can run a native codex-app-server goal", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const fakeEnv = { [FAKE_SHARED_CODEX_APP_SERVER_SOCKET_ENV]: socketPath };

        const launch = await runCli(
          workspaceRoot,
          [
            "launch",
            "codex-app-server",
            "--workspace",
            workspaceRoot,
            "--session",
            "--name",
            "goal cli session",
            "--json",
          ],
          10_000,
          fakeEnv,
        );
        const task = JSON.parse(launch.stdout) as { taskId: string; runtime: string };
        assert.equal(task.runtime, "codex-app-server");

        try {
          const record = await readTaskRecord({ workspaceRoot }, task.taskId);
          assert.equal(record.status, "running");
          assert.equal(record.session?.state, "idle");

          const goal = await runCli(
            workspaceRoot,
            [
              "--workspace",
              workspaceRoot,
              "goal",
              "start",
              task.taskId.slice(0, 8),
              "--wait",
              "--token-budget",
              "1000",
              "--json",
              "--compact",
              "Improve performance by 10%.",
            ],
            10_000,
            fakeEnv,
          );
          const started = JSON.parse(goal.stdout) as {
            ok: boolean;
            task: {
              taskId: string;
              runtime: string;
              status: string;
              session?: { state?: string };
              goal?: { status?: string; objective?: string; tokenBudget?: number };
              lastOperation?: { kind?: string; status?: string; result?: string };
            };
            goal: {
              action: string;
              commandStatus: string;
              status: string;
              state?: { status?: string; objective?: string; tokenBudget?: number };
              operation?: { kind?: string; status?: string; result?: string; turnId?: string };
            };
          };
          assert.equal(started.ok, true);
          assert.equal(started.goal.action, "start");
          assert.equal(started.goal.commandStatus, "completed");
          assert.equal(started.goal.status, "complete");
          assert.equal(started.goal.state?.status, "complete");
          assert.equal(started.goal.state?.objective, "Improve performance by 10%.");
          assert.equal(started.goal.state?.tokenBudget, 1000);
          assert.equal(started.goal.operation?.kind, "goal");
          assert.equal(started.goal.operation?.status, "complete");
          assert.equal(started.goal.operation?.turnId, "turn-fake-goal-1");
          assert.equal(started.goal.operation?.result, "Goal complete from fake Codex.");
          assert.equal(started.task.session?.state, "idle");
          assert.equal(started.task.lastOperation?.kind, "goal");

          const events = await runCli(workspaceRoot, [
            "events",
            task.taskId.slice(0, 8),
            "--workspace",
            workspaceRoot,
            "--agent-only",
          ]);
          assert.match(events.stdout, /goal\.updated/);
          assert.match(events.stdout, /operation\.completed/);
          assert.doesNotMatch(events.stdout, /thread\/goal\/updated/);
        } finally {
          await runCli(
            workspaceRoot,
            ["interrupt", task.taskId, "--workspace", workspaceRoot, "--reason", "test cleanup"],
            10_000,
            fakeEnv,
          ).catch(() => undefined);
        }

        await waitFor(async () => {
          const record = await readTaskRecord({ workspaceRoot }, task.taskId);
          return record.status === "cancelled" && record.session?.state === "closed";
        }, 5_000);
      }, "orchestrator-codex-app-server-cli-session-goal-start-");
    },
    {
      goalResultText: "Goal complete from fake Codex.",
    },
  );
});

test("CLI goal start separates command status from provider goal status", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const handle = await launchTask({
      workspaceRoot,
      plan: codexAppServerSessionPlan(workspaceRoot, {
        FAKE_CODEX_APP_SERVER_GOAL_STATUS: "budgetLimited",
      }),
      name: "budget-limited goal cli session",
      model: "fake-model",
      timeoutMs: 10_000,
    });

    try {
      await waitFor(async () => {
        const task = await readTaskRecord({ workspaceRoot }, handle.task.taskId);
        return task.status === "running" && task.session?.state === "idle";
      }, 5_000);

      const goal = await runCli(
        workspaceRoot,
        [
          "goal",
          "start",
          handle.task.taskId.slice(0, 8),
          "--workspace",
          workspaceRoot,
          "--wait",
          "--json",
          "--compact",
          "Use the available budget.",
        ],
        10_000,
      );
      const started = JSON.parse(goal.stdout) as {
        ok: boolean;
        goal: {
          action: string;
          commandStatus: string;
          status: string;
          state?: { status?: string };
          operation?: { status?: string };
        };
      };

      assert.equal(started.ok, true);
      assert.equal(started.goal.action, "start");
      assert.equal(started.goal.commandStatus, "completed");
      assert.equal(started.goal.status, "budget_limited");
      assert.equal(started.goal.state?.status, "budget_limited");
      assert.equal(started.goal.operation?.status, "budget_limited");

      const human = await runCli(
        workspaceRoot,
        [
          "goal",
          "start",
          handle.task.taskId.slice(0, 8),
          "--workspace",
          workspaceRoot,
          "--wait",
          "Use the available budget again.",
        ],
        10_000,
      );
      assert.match(human.stdout, /goal start completed\s+goal budget_limited/);
      assert.doesNotMatch(human.stdout, /goal completed/);
    } finally {
      await interruptTask({
        workspaceRoot,
        taskId: handle.task.taskId,
        reason: "test cleanup",
      }).catch(() => undefined);
      await handle.completed.catch(() => undefined);
    }
  }, "orchestrator-codex-app-server-cli-goal-status-wording-");
});

test("CLI goal get set and clear control a native codex-app-server goal", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const fakeEnv = { [FAKE_SHARED_CODEX_APP_SERVER_SOCKET_ENV]: socketPath };

        const launch = await runCli(
          workspaceRoot,
          [
            "launch",
            "codex-app-server",
            "--workspace",
            workspaceRoot,
            "--session",
            "--name",
            "goal control cli session",
            "--json",
          ],
          10_000,
          fakeEnv,
        );
        const task = JSON.parse(launch.stdout) as { taskId: string; runtime: string };
        assert.equal(task.runtime, "codex-app-server");

        try {
          const record = await readTaskRecord({ workspaceRoot }, task.taskId);
          assert.equal(record.status, "running");
          assert.equal(record.session?.state, "idle");

          const empty = await runCli(
            workspaceRoot,
            [
              "goal",
              "get",
              task.taskId.slice(0, 8),
              "--workspace",
              workspaceRoot,
              "--json",
              "--compact",
            ],
            10_000,
            fakeEnv,
          );
          const emptyGoal = JSON.parse(empty.stdout) as {
            ok: boolean;
            goal: { action: string; source: string; exists: boolean; state?: { status?: string } };
          };
          assert.equal(emptyGoal.ok, true);
          assert.equal(emptyGoal.goal.action, "get");
          assert.equal(emptyGoal.goal.source, "provider");
          assert.equal(emptyGoal.goal.exists, false);
          assert.equal(emptyGoal.goal.state, undefined);

          const set = await runCli(
            workspaceRoot,
            [
              "goal",
              "set",
              task.taskId.slice(0, 8),
              "--workspace",
              workspaceRoot,
              "--objective",
              "Pause CLI work.",
              "--status",
              "usage-limited",
              "--token-budget",
              "1000",
              "--json",
              "--compact",
            ],
            10_000,
            fakeEnv,
          );
          const setGoal = JSON.parse(set.stdout) as {
            ok: boolean;
            goal: {
              action: string;
              source: string;
              exists: boolean;
              state?: {
                status?: string;
                objective?: string;
                tokenBudget?: number;
                createdAt?: string;
              };
            };
          };
          assert.equal(setGoal.ok, true);
          assert.equal(setGoal.goal.action, "set");
          assert.equal(setGoal.goal.exists, true);
          assert.equal(setGoal.goal.state?.status, "usage_limited");
          assert.equal(setGoal.goal.state?.objective, "Pause CLI work.");
          assert.equal(setGoal.goal.state?.tokenBudget, 1000);
          assert.match(setGoal.goal.state?.createdAt ?? "", /^\d{4}-/);

          const clear = await runCli(
            workspaceRoot,
            [
              "goal",
              "clear",
              task.taskId.slice(0, 8),
              "--workspace",
              workspaceRoot,
              "--json",
              "--compact",
            ],
            10_000,
            fakeEnv,
          );
          const clearGoal = JSON.parse(clear.stdout) as {
            ok: boolean;
            goal: { action: string; source: string; exists: boolean; cleared: boolean };
          };
          assert.equal(clearGoal.ok, true);
          assert.equal(clearGoal.goal.action, "clear");
          assert.equal(clearGoal.goal.exists, false);
          assert.equal(clearGoal.goal.cleared, true);

          const emptyAfterClear = await runCli(
            workspaceRoot,
            [
              "goal",
              "get",
              task.taskId.slice(0, 8),
              "--workspace",
              workspaceRoot,
              "--json",
              "--compact",
            ],
            10_000,
            fakeEnv,
          );
          const emptyAfterClearGoal = JSON.parse(emptyAfterClear.stdout) as {
            ok: boolean;
            goal: { action: string; source: string; exists: boolean; state?: { status?: string } };
          };
          assert.equal(emptyAfterClearGoal.ok, true);
          assert.equal(emptyAfterClearGoal.goal.action, "get");
          assert.equal(emptyAfterClearGoal.goal.exists, false);
          assert.equal(emptyAfterClearGoal.goal.state, undefined);

          await assert.rejects(
            runCli(
              workspaceRoot,
              [
                "goal",
                "set",
                task.taskId.slice(0, 8),
                "--workspace",
                workspaceRoot,
                "--status",
                "active",
                "--json",
              ],
              10_000,
              fakeEnv,
            ),
            (error: unknown) => {
              const stderr =
                error instanceof Error && "stderr" in error ? String(error.stderr) : "";
              return /Use goal start when activating a goal/.test(stderr);
            },
          );
        } finally {
          await runCli(
            workspaceRoot,
            ["interrupt", task.taskId, "--workspace", workspaceRoot, "--reason", "test cleanup"],
            10_000,
            fakeEnv,
          ).catch(() => undefined);
        }

        await waitFor(async () => {
          const record = await readTaskRecord({ workspaceRoot }, task.taskId);
          return record.status === "cancelled" && record.session?.state === "closed";
        }, 5_000);
      }, "orchestrator-codex-app-server-cli-session-goal-control-");
    },
    {
      goalTimestampUnit: "seconds",
    },
  );
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
