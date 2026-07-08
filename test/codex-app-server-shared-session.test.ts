import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createOrchestratorAgentTools } from "@backnotprop/orchestrator-agent/tools";
import { buildAgentLaunchPlan } from "@backnotprop/orchestrator-core/runtime";
import {
  buildAgentTaskPsView,
  interruptTask,
  launchSharedCodexAppServerSessionTask,
  monitorSharedCodexAppServerSessionOperation,
  readTaskEvents,
  readTaskOutput,
  readTaskRecord,
  sendTaskMessage,
  startTaskGoal,
  type TaskEvent,
} from "@backnotprop/orchestrator-core/tasks";
import {
  FAKE_SHARED_CODEX_APP_SERVER_SOCKET_ENV as TEST_SOCKET_PATH_ENV,
  withFakeSharedCodexAppServer,
} from "./fake-shared-codex-app-server.ts";
import { runCli, withTempWorkspace } from "./helpers.ts";

type TestTool = ReturnType<typeof createOrchestratorAgentTools>[number];

test("shared codex-app-server session launches sends goals and interrupts through task ids", async () => {
  await withFakeSharedCodexAppServer(async ({ socketPath }) => {
    await withTempWorkspace(async (workspaceRoot) => {
      const task = await launchSharedCodexAppServerSessionTask({
        workspaceRoot,
        plan: sessionPlan(workspaceRoot, socketPath),
        name: "shared session",
        model: "fake-model",
      });

      assert.equal(task.status, "running");
      assert.equal(task.pid, undefined);
      assert.equal(task.provider?.transport, "unix");
      assert.equal(task.provider?.threadId, "thread-fake-1");
      assert.equal(task.session?.state, "idle");
      assert.equal(task.supervision?.kind, "provider");

      const sent = await sendTaskMessage({
        workspaceRoot,
        taskId: task.taskId,
        text: "Say hello.",
        wait: true,
        timeoutMs: 1_000,
      });
      assert.equal(sent.status, "completed");
      assert.equal(sent.operation?.result, "Hello from shared Codex.");
      assert.equal(sent.provider?.transport, "unix");
      assert.equal(sent.provider?.turnId, "turn-fake-1");
      assert.equal(
        await readTaskOutput({ workspaceRoot, taskId: task.taskId }),
        "Hello from shared Codex.",
      );
      const afterSend = await readTaskRecord({ workspaceRoot }, task.taskId);
      assert.equal(afterSend.usage?.totalTokens, 15);

      const goal = await startTaskGoal({
        workspaceRoot,
        taskId: task.taskId,
        goal: "Improve performance.",
        wait: true,
        timeoutMs: 1_000,
        tokenBudget: 100,
      });
      assert.equal(goal.status, "completed");
      assert.equal(goal.goal?.status, "complete");
      assert.equal(goal.operation?.kind, "goal");
      assert.equal(goal.operation?.result, "Goal complete from shared Codex.");

      const events = await readTaskEvents({
        workspaceRoot,
        taskId: task.taskId,
        agentOnly: true,
      });
      const kinds = events.map((event) => String(event.data.kind));
      assert.ok(kinds.includes("thread.started"));
      assert.ok(kinds.includes("protocol.message.sent"));
      assert.ok(kinds.includes("goal.updated"));
      assert.ok(kinds.includes("operation.completed"));
      assert.equal(
        events.some((event) => event.data.threadId === "thread-foreign"),
        false,
      );

      const cancelled = await interruptTask({
        workspaceRoot,
        taskId: task.taskId,
        reason: "done",
      });
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.session?.state, "closed");
    });
  });
});

test("shared codex-app-server usage advances for later send across task ps and read_agent", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const task = await launchSharedCodexAppServerSessionTask({
          workspaceRoot,
          plan: sessionPlan(workspaceRoot, socketPath),
          name: "visible usage session",
        });

        const first = await sendTaskMessage({
          workspaceRoot,
          taskId: task.taskId,
          text: "First turn.",
          wait: true,
          timeoutMs: 5_000,
        });
        assert.equal(first.status, "completed");
        const afterFirst = await readTaskRecord({ workspaceRoot }, task.taskId);
        assert.equal(afterFirst.usage?.totalTokens, 15);

        const second = await sendTaskMessage({
          workspaceRoot,
          taskId: task.taskId,
          text: "Second turn.",
          wait: true,
          timeoutMs: 5_000,
        });
        assert.equal(second.status, "completed");

        const afterSecond = await readTaskRecord({ workspaceRoot }, task.taskId);
        assert.equal(afterSecond.usage?.totalTokens, 42);

        const ps = await buildAgentTaskPsView({
          workspaceRoot,
          now: new Date("2026-06-19T12:00:00.000Z"),
        });
        const row = ps.rows.find((candidate) => candidate.taskId === task.taskId);
        assert.equal(row?.usage?.totalTokens, 42);

        const tools = createOrchestratorAgentTools({ workspaceRoot });
        const read = await executeTool<{ usage?: { totalTokens?: number } }>(
          getTool(tools, "read_agent"),
          {
            taskId: task.taskId.slice(0, 8),
          },
        );
        assert.equal(read.details.usage?.totalTokens, 42);
      });
    },
    {
      turnUsages: [
        { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
      ],
    },
  );
});

test("interrupting one shared codex-app-server session does not stop another session", async () => {
  await withFakeSharedCodexAppServer(async ({ socketPath }) => {
    await withTempWorkspace(async (workspaceRoot) => {
      const first = await launchSharedCodexAppServerSessionTask({
        workspaceRoot,
        plan: sessionPlan(workspaceRoot, socketPath),
        name: "first shared session",
      });
      const second = await launchSharedCodexAppServerSessionTask({
        workspaceRoot,
        plan: sessionPlan(workspaceRoot, socketPath),
        name: "second shared session",
      });

      const cancelled = await interruptTask({
        workspaceRoot,
        taskId: first.taskId,
        reason: "stop first",
      });
      const remaining = await readTaskRecord({ workspaceRoot }, second.taskId);

      assert.equal(cancelled.status, "cancelled");
      assert.equal(remaining.status, "running");
      assert.equal(remaining.session?.state, "idle");
      assert.notEqual(cancelled.provider?.threadId, remaining.provider?.threadId);
    });
  });
});

test("shared codex-app-server monitor settles a no-wait send operation", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const task = await launchSharedCodexAppServerSessionTask({
          workspaceRoot,
          plan: sessionPlan(workspaceRoot, socketPath),
          name: "monitored send session",
        });

        const sent = await sendTaskMessage({
          workspaceRoot,
          taskId: task.taskId,
          text: "Say hello.",
          wait: false,
          timeoutMs: 1_000,
        });
        assert.equal(sent.status, "running");
        assert.equal(sent.operation?.status, "running");
        assert.ok(sent.operation?.operationId);

        const monitored = await monitorSharedCodexAppServerSessionOperation({
          workspaceRoot,
          taskId: task.taskId,
          operationId: sent.operation.operationId,
          timeoutMs: 5_000,
        });
        assert.equal(monitored.status, "running");
        assert.equal(monitored.session?.state, "idle");
        assert.equal(monitored.currentOperation, undefined);
        assert.equal(monitored.lastOperation?.status, "succeeded");
        assert.equal(monitored.lastOperation?.result, "Hello from shared Codex.");
        assert.equal(monitored.usage?.totalTokens, 15);
        assert.equal(
          await readTaskOutput({ workspaceRoot, taskId: task.taskId }),
          "Hello from shared Codex.",
        );
      });
    },
    { turnDelayMs: 50 },
  );
});

test("shared codex-app-server send wait fails when the operation is interrupted", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const task = await launchSharedCodexAppServerSessionTask({
          workspaceRoot,
          plan: sessionPlan(workspaceRoot, socketPath),
          name: "interrupted send session",
        });

        const pendingSend = sendTaskMessage({
          workspaceRoot,
          taskId: task.taskId,
          text: "Start a delayed turn.",
          wait: true,
          timeoutMs: 5_000,
        });

        await waitForTask(
          workspaceRoot,
          task.taskId,
          (record) => record.session?.state === "turn_running",
        );

        await interruptTask({
          workspaceRoot,
          taskId: task.taskId,
          reason: "operator stopped wait",
        });

        await assert.rejects(pendingSend, (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal("reason" in error ? error.reason : undefined, "interrupted");
          assert.equal(error.message, "operator stopped wait");
          return true;
        });

        const interrupted = await readTaskRecord({ workspaceRoot }, task.taskId);
        assert.equal(interrupted.status, "cancelled");
        assert.equal(interrupted.lastOperation?.status, "interrupted");
      });
    },
    { turnDelayMs: 1_000 },
  );
});

test("shared codex-app-server send surfaces backend auth diagnostics while active", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const task = await launchSharedCodexAppServerSessionTask({
          workspaceRoot,
          plan: sessionPlan(workspaceRoot, socketPath),
          name: "backend auth diagnostic session",
        });
        const backendStderrLogPath = `${task.paths.taskDir}/backend.stderr.log`;
        await patchTaskJson(task.taskId, task.paths.taskJson, {
          supervision: {
            ...task.supervision,
            backendStderrLogPath,
          },
        });

        const pendingSend = sendTaskMessage({
          workspaceRoot,
          taskId: task.taskId,
          text: "Start a delayed turn.",
          wait: true,
          timeoutMs: 10_000,
        });

        await waitForTask(
          workspaceRoot,
          task.taskId,
          (record) => record.session?.state === "turn_running",
        );
        await writeFile(
          backendStderrLogPath,
          "2026-07-07T20:26:53.560722Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)\n",
        );
        const diagnostic = await waitForAgentEvent(
          workspaceRoot,
          task.taskId,
          (event) => event.data.kind === "protocol.backend.auth_required",
        );
        assert.equal(diagnostic.data.code, "authorization_required");
        assert.match(String(diagnostic.data.message), /AuthorizationRequired/);
        assert.equal(diagnostic.data.logPath, backendStderrLogPath);

        const ps = await buildAgentTaskPsView({
          workspaceRoot,
          now: new Date("2026-07-07T20:27:01.000Z"),
        });
        const row = ps.rows.find((candidate) => candidate.taskId === task.taskId);
        assert.equal(row?.lastEvent, "protocol.backend.auth_required");
        assert.match(row?.lastMessage ?? "", /AuthorizationRequired/);

        const compactRead = await runCli(
          workspaceRoot,
          ["read", task.taskId, "--json", "--compact"],
          10_000,
        );
        const parsedRead = JSON.parse(compactRead.stdout) as {
          lastEvent?: string;
          lastMessage?: string;
        };
        assert.equal(parsedRead.lastEvent, "protocol.backend.auth_required");
        assert.match(parsedRead.lastMessage ?? "", /AuthorizationRequired/);

        const humanRead = await runCli(workspaceRoot, ["read", task.taskId], 10_000);
        assert.match(humanRead.stderr, /AuthorizationRequired/);

        const waitRead = await runCli(
          workspaceRoot,
          ["read", task.taskId, "--wait", "--timeout-ms", "50"],
          10_000,
        );
        assert.match(waitRead.stderr, /AuthorizationRequired/);

        await interruptTask({
          workspaceRoot,
          taskId: task.taskId,
          reason: "diagnostic test cleanup",
        });
        await assert.rejects(pendingSend, (error: unknown) => {
          assert.equal(
            error instanceof Error && "reason" in error ? error.reason : undefined,
            "interrupted",
          );
          return true;
        });
      });
    },
    { turnDelayMs: 5_000 },
  );
});

test("shared codex-app-server send timeout includes backend auth diagnostic", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const task = await launchSharedCodexAppServerSessionTask({
          workspaceRoot,
          plan: sessionPlan(workspaceRoot, socketPath),
          name: "auth timeout session",
        });
        const backendStderrLogPath = join(task.paths.taskDir, "backend.stderr.log");
        await patchTaskJson(task.taskId, task.paths.taskJson, {
          supervision: {
            kind: "provider",
            provider: "codex-app-server",
            socketPath,
            backendStderrLogPath,
          },
        });

        const pendingSend = sendTaskMessage({
          workspaceRoot,
          taskId: task.taskId,
          text: "Start a delayed turn.",
          wait: true,
          timeoutMs: 1_000,
        });

        await waitForTask(
          workspaceRoot,
          task.taskId,
          (record) => record.session?.state === "turn_running",
        );
        await writeFile(
          backendStderrLogPath,
          "ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)\n",
        );

        await assert.rejects(pendingSend, (error: unknown) => {
          assert.equal(
            error instanceof Error && "reason" in error ? error.reason : undefined,
            "timeout",
          );
          assert.match(
            String(error instanceof Error ? error.message : error),
            /AuthorizationRequired/,
          );
          return true;
        });

        await interruptTask({
          workspaceRoot,
          taskId: task.taskId,
          reason: "diagnostic timeout test cleanup",
        });
      });
    },
    { turnDelayMs: 5_000 },
  );
});

test("shared codex-app-server send ignores stale backend auth diagnostics", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const task = await launchSharedCodexAppServerSessionTask({
          workspaceRoot,
          plan: sessionPlan(workspaceRoot, socketPath),
          name: "stale auth diagnostic session",
        });
        const backendStderrLogPath = join(task.paths.taskDir, "backend.stderr.log");
        await writeFile(
          backendStderrLogPath,
          "ERROR old operation failed with Auth(AuthorizationRequired)\n",
        );
        await patchTaskJson(task.taskId, task.paths.taskJson, {
          supervision: {
            kind: "provider",
            provider: "codex-app-server",
            socketPath,
            backendStderrLogPath,
          },
        });

        await assert.rejects(
          sendTaskMessage({
            workspaceRoot,
            taskId: task.taskId,
            text: "Start a delayed turn.",
            wait: true,
            timeoutMs: 200,
          }),
          (error: unknown) => {
            assert.equal(
              error instanceof Error && "reason" in error ? error.reason : undefined,
              "timeout",
            );
            assert.doesNotMatch(
              String(error instanceof Error ? error.message : error),
              /AuthorizationRequired/,
            );
            return true;
          },
        );

        await interruptTask({
          workspaceRoot,
          taskId: task.taskId,
          reason: "stale diagnostic test cleanup",
        });
      });
    },
    { turnDelayMs: 5_000 },
  );
});

test("CLI send wait reports interrupted when another operator stops the session", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const fakeEnv = { [TEST_SOCKET_PATH_ENV]: socketPath };
        const launch = await runCli(
          workspaceRoot,
          [
            "launch",
            "codex-app-server",
            "--workspace",
            workspaceRoot,
            "--session",
            "--name",
            "cli interrupted send",
            "--json",
          ],
          10_000,
          fakeEnv,
        );
        const task = JSON.parse(launch.stdout) as { taskId: string };

        const pendingSend = runCli(
          workspaceRoot,
          [
            "send",
            task.taskId.slice(0, 8),
            "--workspace",
            workspaceRoot,
            "--wait",
            "--json",
            "--compact",
            "Start a delayed turn.",
          ],
          10_000,
          fakeEnv,
        );

        await waitForTask(
          workspaceRoot,
          task.taskId,
          (record) => record.session?.state === "turn_running",
        );

        await runCli(
          workspaceRoot,
          ["interrupt", task.taskId, "--workspace", workspaceRoot, "--reason", "operator stopped"],
          10_000,
          fakeEnv,
        );

        await assert.rejects(pendingSend, (error: unknown) => {
          const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
          const parsed = JSON.parse(stderr) as {
            error: { message?: string; reason?: string; input?: string; hint?: string };
          };
          assert.equal(parsed.error.reason, "interrupted");
          assert.equal(parsed.error.message, "operator stopped");
          assert.equal(parsed.error.input, task.taskId);
          assert.match(parsed.error.hint ?? "", /interrupted/);
          return true;
        });
      });
    },
    { turnDelayMs: 5_000 },
  );
});

test("fresh shared codex-app-server session first send materializes rollout without resume", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const task = await launchSharedCodexAppServerSessionTask({
          workspaceRoot,
          plan: sessionPlan(workspaceRoot, socketPath),
          name: "fresh first send session",
        });

        const sent = await sendTaskMessage({
          workspaceRoot,
          taskId: task.taskId,
          text: "Say hello.",
          wait: true,
          timeoutMs: 5_000,
        });
        const after = await readTaskRecord({ workspaceRoot }, task.taskId);
        const events = await readTaskEvents({
          workspaceRoot,
          taskId: task.taskId,
          agentOnly: true,
        });
        const kinds = events.map((event) => String(event.data.kind));

        assert.equal(sent.status, "completed");
        assert.equal(sent.operation?.result, "Hello from shared Codex.");
        assert.equal(sent.provider?.turnId, "turn-fake-1");
        assert.equal(after.session?.state, "idle");
        assert.equal(after.lastOperation?.status, "succeeded");
        assert.equal(after.usage?.totalTokens, 15);
        assert.ok(kinds.includes("thread.rollout.pending"));
        assert.ok(kinds.includes("operation.completed"));
      });
    },
    {
      notifyOnlySubscribers: true,
      readRequiresCompletedRollout: true,
      resumeRequiresCompletedRollout: true,
      turnDelayMs: 50,
    },
  );
});

test("fresh shared codex-app-server session monitor settles first send after rollout appears", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const task = await launchSharedCodexAppServerSessionTask({
          workspaceRoot,
          plan: sessionPlan(workspaceRoot, socketPath),
          name: "fresh monitored first send session",
        });

        const sent = await sendTaskMessage({
          workspaceRoot,
          taskId: task.taskId,
          text: "Say hello.",
          wait: false,
          timeoutMs: 5_000,
        });
        assert.equal(sent.status, "running");
        assert.ok(sent.operation?.operationId);

        const monitored = await monitorSharedCodexAppServerSessionOperation({
          workspaceRoot,
          taskId: task.taskId,
          operationId: sent.operation.operationId,
          timeoutMs: 5_000,
        });

        assert.equal(monitored.session?.state, "idle");
        assert.equal(monitored.lastOperation?.status, "succeeded");
        assert.equal(monitored.lastOperation?.result, "Hello from shared Codex.");
        assert.equal(monitored.usage?.totalTokens, 15);
      });
    },
    {
      notifyOnlySubscribers: true,
      readRequiresCompletedRollout: true,
      resumeRequiresCompletedRollout: true,
      turnDelayMs: 50,
    },
  );
});

test("fresh shared codex-app-server session can steer an active first turn before rollout appears", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const task = await launchSharedCodexAppServerSessionTask({
          workspaceRoot,
          plan: sessionPlan(workspaceRoot, socketPath),
          name: "fresh first steer session",
        });

        const started = await sendTaskMessage({
          workspaceRoot,
          taskId: task.taskId,
          text: "Start the first turn.",
          wait: false,
          timeoutMs: 5_000,
        });
        assert.equal(started.status, "running");

        const steered = await sendTaskMessage({
          workspaceRoot,
          taskId: task.taskId,
          text: "Add one more sentence.",
          wait: true,
          timeoutMs: 5_000,
        });
        const after = await readTaskRecord({ workspaceRoot }, task.taskId);

        assert.equal(steered.status, "completed");
        assert.equal(steered.operation?.result, "Hello from shared Codex.");
        assert.equal(steered.provider?.turnId, "turn-fake-1");
        assert.equal(after.session?.state, "idle");
        assert.equal(after.lastOperation?.status, "succeeded");
      });
    },
    {
      notifyOnlySubscribers: true,
      readRequiresCompletedRollout: true,
      resumeRequiresCompletedRollout: true,
      turnDelayMs: 50,
    },
  );
});

test("fresh shared codex-app-server session first goal materializes rollout without resume", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const task = await launchSharedCodexAppServerSessionTask({
          workspaceRoot,
          plan: sessionPlan(workspaceRoot, socketPath),
          name: "fresh first goal session",
        });

        const goal = await startTaskGoal({
          workspaceRoot,
          taskId: task.taskId,
          goal: "Complete a tiny goal.",
          wait: true,
          timeoutMs: 5_000,
          tokenBudget: 100,
        });
        const after = await readTaskRecord({ workspaceRoot }, task.taskId);

        assert.equal(goal.status, "completed");
        assert.equal(goal.goal?.status, "complete");
        assert.equal(goal.operation?.kind, "goal");
        assert.equal(goal.operation?.result, "Goal complete from shared Codex.");
        assert.equal(goal.operation?.turnId, "turn-fake-goal-1");
        assert.equal(after.session?.state, "idle");
        assert.equal(after.lastOperation?.status, "complete");
      });
    },
    {
      goalDelayMs: 50,
      notifyOnlySubscribers: true,
      readRequiresCompletedRollout: true,
      resumeRequiresCompletedRollout: true,
    },
  );
});

test("shared codex-app-server monitor claim prevents duplicate operation settlement", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const task = await launchSharedCodexAppServerSessionTask({
          workspaceRoot,
          plan: sessionPlan(workspaceRoot, socketPath),
          name: "duplicate monitor session",
        });

        const sent = await sendTaskMessage({
          workspaceRoot,
          taskId: task.taskId,
          text: "Say hello.",
          wait: false,
          timeoutMs: 1_000,
        });
        assert.ok(sent.operation?.operationId);

        const [first, second] = await Promise.all([
          monitorSharedCodexAppServerSessionOperation({
            workspaceRoot,
            taskId: task.taskId,
            operationId: sent.operation.operationId,
            timeoutMs: 5_000,
          }),
          monitorSharedCodexAppServerSessionOperation({
            workspaceRoot,
            taskId: task.taskId,
            operationId: sent.operation.operationId,
            timeoutMs: 5_000,
          }),
        ]);

        const settled = await waitForTask(
          workspaceRoot,
          task.taskId,
          (record) =>
            record.session?.state === "idle" &&
            record.currentOperation === undefined &&
            record.lastOperation?.status === "succeeded",
        );
        const events = await readTaskEvents({
          workspaceRoot,
          taskId: task.taskId,
          agentOnly: true,
        });
        const completedEvents = events.filter(
          (event) =>
            event.data.kind === "operation.completed" &&
            event.data.operationId === sent.operation?.operationId,
        );

        assert.equal(settled.lastOperation?.result, "Hello from shared Codex.");
        assert.equal(first.taskId, task.taskId);
        assert.equal(second.taskId, task.taskId);
        assert.equal(completedEvents.length, 1);
      });
    },
    { turnDelayMs: 50 },
  );
});

test("CLI send without wait starts a detached shared session monitor", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const launch = await runCli(
          workspaceRoot,
          [
            "launch",
            "codex-app-server",
            "--workspace",
            workspaceRoot,
            "--session",
            "--name",
            "cli monitored send",
            "--json",
          ],
          10_000,
          {
            [TEST_SOCKET_PATH_ENV]: socketPath,
          },
        );
        const launched = JSON.parse(launch.stdout) as { taskId: string };

        const send = await runCli(
          workspaceRoot,
          [
            "send",
            launched.taskId.slice(0, 8),
            "--workspace",
            workspaceRoot,
            "--json",
            "--compact",
            "Say hello.",
          ],
          10_000,
          {
            [TEST_SOCKET_PATH_ENV]: socketPath,
          },
        );
        const sent = JSON.parse(send.stdout) as {
          ok: boolean;
          message: { status: string; operation?: { operationId?: string } };
        };
        assert.equal(sent.ok, true);
        assert.equal(sent.message.status, "running");
        assert.ok(sent.message.operation?.operationId);

        const settled = await waitForTask(
          workspaceRoot,
          launched.taskId,
          (record) =>
            record.session?.state === "idle" &&
            record.currentOperation === undefined &&
            record.lastOperation?.status === "succeeded",
        );
        assert.equal(settled.lastOperation?.result, "Hello from shared Codex.");
        assert.equal(settled.usage?.totalTokens, 15);
      });
    },
    { turnDelayMs: 1_000 },
  );
});

test("parent tool send_agent_message without wait starts an in-process shared session monitor", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const task = await launchSharedCodexAppServerSessionTask({
          workspaceRoot,
          plan: sessionPlan(workspaceRoot, socketPath),
          name: "tool monitored send",
        });
        const tools = createOrchestratorAgentTools({ workspaceRoot });

        const sent = await executeTool<{
          status: string;
          operation?: { operationId?: string; status?: string };
        }>(getTool(tools, "send_agent_message"), {
          taskId: task.taskId.slice(0, 8),
          message: "Say hello.",
          wait: false,
        });

        assert.equal(sent.details.status, "running");
        assert.equal(sent.details.operation?.status, "running");
        assert.ok(sent.details.operation?.operationId);

        const settled = await waitForTask(
          workspaceRoot,
          task.taskId,
          (record) =>
            record.session?.state === "idle" &&
            record.currentOperation === undefined &&
            record.lastOperation?.kind === "turn" &&
            record.lastOperation.status === "succeeded",
        );
        assert.equal(settled.lastOperation?.result, "Hello from shared Codex.");
        assert.equal(settled.usage?.totalTokens, 15);
      });
    },
    { turnDelayMs: 50 },
  );
});

test("parent tool start_agent_goal without wait starts an in-process shared session monitor", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const task = await launchSharedCodexAppServerSessionTask({
          workspaceRoot,
          plan: sessionPlan(workspaceRoot, socketPath),
          name: "tool monitored goal",
        });
        const tools = createOrchestratorAgentTools({ workspaceRoot });

        const started = await executeTool<{
          status: string;
          operation?: { operationId?: string; status?: string };
        }>(getTool(tools, "start_agent_goal"), {
          taskId: task.taskId.slice(0, 8),
          goal: "Improve performance.",
          wait: false,
        });

        assert.equal(started.details.status, "running");
        assert.equal(started.details.operation?.status, "running");
        assert.ok(started.details.operation?.operationId);

        const settled = await waitForTask(
          workspaceRoot,
          task.taskId,
          (record) =>
            record.session?.state === "idle" &&
            record.currentOperation === undefined &&
            record.lastOperation?.kind === "goal" &&
            record.lastOperation.status === "complete",
        );
        assert.equal(settled.goal?.status, "complete");
        assert.equal(settled.lastOperation?.result, "Goal complete from shared Codex.");
      });
    },
    { goalDelayMs: 50 },
  );
});

test("CLI goal start without wait starts a detached shared session monitor", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const launch = await runCli(
          workspaceRoot,
          [
            "launch",
            "codex-app-server",
            "--workspace",
            workspaceRoot,
            "--session",
            "--name",
            "cli monitored goal",
            "--json",
          ],
          10_000,
          {
            [TEST_SOCKET_PATH_ENV]: socketPath,
          },
        );
        const launched = JSON.parse(launch.stdout) as { taskId: string };

        const goal = await runCli(
          workspaceRoot,
          [
            "goal",
            "start",
            launched.taskId.slice(0, 8),
            "--workspace",
            workspaceRoot,
            "--json",
            "--compact",
            "Improve performance.",
          ],
          10_000,
          {
            [TEST_SOCKET_PATH_ENV]: socketPath,
          },
        );
        const started = JSON.parse(goal.stdout) as {
          ok: boolean;
          goal: {
            action: string;
            commandStatus: string;
            status: string;
            operation?: { operationId?: string };
          };
        };
        assert.equal(started.ok, true);
        assert.equal(started.goal.action, "start");
        assert.equal(started.goal.commandStatus, "running");
        assert.equal(started.goal.status, "active");
        assert.ok(started.goal.operation?.operationId);

        const settled = await waitForTask(
          workspaceRoot,
          launched.taskId,
          (record) =>
            record.session?.state === "idle" &&
            record.currentOperation === undefined &&
            record.lastOperation?.kind === "goal" &&
            record.lastOperation.status === "complete",
        );
        assert.equal(settled.goal?.status, "complete");
        assert.equal(settled.lastOperation?.result, "Goal complete from shared Codex.");
      });
    },
    { goalDelayMs: 1_000 },
  );
});

test("shared codex-app-server session checks provider thread is idle before starting a turn", async () => {
  await withFakeSharedCodexAppServer(
    async ({ socketPath }) => {
      await withTempWorkspace(async (workspaceRoot) => {
        const task = await launchSharedCodexAppServerSessionTask({
          workspaceRoot,
          plan: sessionPlan(workspaceRoot, socketPath),
          name: "busy shared session",
        });

        await assert.rejects(
          sendTaskMessage({
            workspaceRoot,
            taskId: task.taskId,
            text: "Say hello.",
            wait: true,
            timeoutMs: 1_000,
          }),
          /Codex app-server thread must be idle; current status is "running"./,
        );

        const afterSend = await readTaskRecord({ workspaceRoot }, task.taskId);
        assert.equal(afterSend.session?.state, "idle");
        assert.equal(afterSend.currentOperation, undefined);
        assert.equal(afterSend.lastOperation?.kind, "turn");
        assert.equal(afterSend.lastOperation?.status, "failed");
      });
    },
    { threadReadStatus: "running" },
  );
});

test("CLI launch codex-app-server --session creates a shared provider-backed task", async () => {
  await withFakeSharedCodexAppServer(async ({ socketPath }) => {
    await withTempWorkspace(async (workspaceRoot) => {
      const output = await runCli(
        workspaceRoot,
        [
          "launch",
          "codex-app-server",
          "--workspace",
          workspaceRoot,
          "--session",
          "--name",
          "cli shared session",
          "--json",
        ],
        10_000,
        {
          [TEST_SOCKET_PATH_ENV]: socketPath,
        },
      );
      const launched = JSON.parse(output.stdout) as {
        taskId: string;
        status: string;
        runtime: string;
        session?: { state?: string };
        provider?: { transport?: string; threadId?: string };
      };

      assert.equal(launched.status, "running");
      assert.equal(launched.runtime, "codex-app-server");
      assert.equal(launched.provider?.transport, "unix");
      assert.equal(launched.provider?.threadId, "thread-fake-1");
      assert.equal(launched.session?.state, "idle");

      const read = await readTaskRecord({ workspaceRoot }, launched.taskId);
      assert.equal(read.supervision?.kind, "provider");
      assert.equal(read.status, "running");

      const ps = await runCli(workspaceRoot, ["ps", "--workspace", workspaceRoot], 10_000, {
        [TEST_SOCKET_PATH_ENV]: socketPath,
      });
      assert.match(ps.stdout, /cli shared session\s+idle/);
    });
  });
});

function sessionPlan(workspaceRoot: string, socketPath: string) {
  return buildAgentLaunchPlan({
    runtime: "codex-app-server",
    cwd: workspaceRoot,
    session: true,
    env: {
      [TEST_SOCKET_PATH_ENV]: socketPath,
    },
  });
}

function getTool(tools: readonly TestTool[], name: string): TestTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected tool ${name} to be registered.`);
  return tool;
}

async function executeTool<TDetails>(
  tool: TestTool,
  params: unknown,
): Promise<{ details: TDetails }> {
  return (await tool.execute(
    "test-tool-call",
    params as never,
    undefined,
    undefined,
    undefined as never,
  )) as { details: TDetails };
}

async function waitForTask(
  workspaceRoot: string,
  taskId: string,
  predicate: (record: Awaited<ReturnType<typeof readTaskRecord>>) => boolean,
  timeoutMs = 5_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const record = await readTaskRecord({ workspaceRoot }, taskId);
    if (predicate(record)) {
      return record;
    }
    await delay(25);
  }
  assert.fail(`Timed out waiting for task ${taskId}.`);
}

async function waitForAgentEvent(
  workspaceRoot: string,
  taskId: string,
  predicate: (event: TaskEvent) => boolean,
  timeoutMs = 5_000,
): Promise<TaskEvent> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const event = (
      await readTaskEvents({
        workspaceRoot,
        taskId,
        agentOnly: true,
      })
    ).find(predicate);
    if (event) {
      return event;
    }
    await delay(25);
  }
  assert.fail(`Timed out waiting for task event ${taskId}.`);
}

async function patchTaskJson(
  taskId: string,
  taskJsonPath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const raw = JSON.parse(await readFile(taskJsonPath, "utf8")) as Record<string, unknown>;
  if (raw.taskId !== taskId) {
    assert.fail(`Unexpected task id in ${taskJsonPath}.`);
  }
  await writeFile(taskJsonPath, `${JSON.stringify({ ...raw, ...patch }, null, 2)}\n`);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
