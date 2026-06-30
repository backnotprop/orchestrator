import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTaskRecord } from "@backnotprop/orchestrator-core";
import { readTaskEvents, readTaskRecord } from "@backnotprop/orchestrator-core/tasks";
import { assertCodexAvailable, runCli, waitForTerminalTask, withTempWorkspace } from "./helpers.ts";

const runCodexAppServerSmoke = process.env.RUN_CODEX_APP_SERVER_SMOKE === "1";

test(
  "Codex app-server smoke: launch through protocol runtime",
  {
    skip: runCodexAppServerSmoke
      ? false
      : "Set RUN_CODEX_APP_SERVER_SMOKE=1 to run real Codex app-server smoke tests.",
  },
  async () => {
    await assertCodexAvailable();

    await withTempWorkspace(async (workspaceRoot) => {
      const model = process.env.CODEX_APP_SERVER_SMOKE_MODEL;
      const prompt =
        "Reply with exactly this text and no markdown: orchestrator-codex-app-server-smoke-ok";
      const args = [
        "launch",
        "codex-app-server",
        "--workspace",
        workspaceRoot,
        "--timeout-ms",
        "120000",
        "--json",
      ];

      if (model) {
        args.push("--model", model);
      }
      args.push(prompt);

      const launch = await runCli(workspaceRoot, args, 130_000);
      const launched = JSON.parse(launch.stdout) as AgentTaskRecord;

      assert.equal(launched.runtime, "codex-app-server");
      assert.equal(launched.launchPlan.executionKind, "protocol");
      assert.equal(launched.launchPlan.outputTransport.kind, "transcript_file");

      const completed = await waitForTerminalTask(workspaceRoot, launched.taskId, 120_000);
      assert.equal(completed.status, "succeeded");

      const read = await runCli(workspaceRoot, [
        "read",
        launched.taskId,
        "--workspace",
        workspaceRoot,
      ]);
      assert.match(read.stdout, /orchestrator-codex-app-server-smoke-ok/);

      const task = await readTaskRecord({ workspaceRoot }, launched.taskId);
      assert.equal(task.provider?.provider, "codex");
      assert.equal(task.provider?.protocol, "jsonrpc");
      assert.equal(task.provider?.transport, "stdio");
      assert.equal(typeof task.provider?.threadId, "string");
      assert.equal(typeof task.provider?.turnId, "string");

      const events = await readTaskEvents({ workspaceRoot, taskId: launched.taskId });
      const kinds = events.flatMap((event) =>
        event.type === "agent_event" && typeof event.data.kind === "string"
          ? [event.data.kind]
          : [],
      );
      assert.ok(kinds.includes("thread.started"));
      assert.ok(kinds.includes("turn.started"));
      assert.ok(kinds.includes("agent.message"));
      assert.ok(kinds.includes("turn.completed"));

      const agentEvents = await runCli(workspaceRoot, [
        "events",
        launched.taskId,
        "--workspace",
        workspaceRoot,
        "--agent-only",
      ]);
      assert.match(agentEvents.stdout, /agent_event/);
      assert.match(agentEvents.stdout, /thread\.started/);
      assert.match(agentEvents.stdout, /turn\.completed/);

      if (task.usage?.totalTokens !== undefined) {
        const ps = await runCli(workspaceRoot, [
          "ps",
          "--workspace",
          workspaceRoot,
          "--json",
          "--compact",
        ]);
        const view = JSON.parse(ps.stdout) as {
          tasks: Array<{ taskId: string; tokens?: number }>;
        };
        assert.equal(
          view.tasks.find((row) => row.taskId === launched.taskId)?.tokens,
          task.usage.totalTokens,
        );
      }
    }, "orchestrator-codex-app-server-smoke-");
  },
);
