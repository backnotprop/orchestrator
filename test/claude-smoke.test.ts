import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AgentTaskRecord } from "@backnotprop/orchestrator-core";
import {
  assertClaudeAvailableAndAuthenticated,
  runCli,
  waitForTerminalTask,
  withTempWorkspace,
} from "./helpers.ts";

const runClaudeSmoke = process.env.RUN_CLAUDE_SMOKE === "1";

test(
  "Claude Code smoke: launch claude-code through the generic CLI runtime",
  {
    skip: runClaudeSmoke ? false : "Set RUN_CLAUDE_SMOKE=1 to run real Claude Code smoke tests.",
  },
  async () => {
    await assertClaudeAvailableAndAuthenticated();

    await withTempWorkspace(async (workspaceRoot) => {
      const model = process.env.CLAUDE_SMOKE_MODEL ?? "haiku";
      const prompt = "Reply with exactly this text and no markdown: orchestrator-smoke-ok";
      const launch = await runCli(
        workspaceRoot,
        [
          "launch",
          "claude-code",
          "--workspace",
          workspaceRoot,
          "--model",
          model,
          "--timeout-ms",
          "120000",
          "--json",
          prompt,
        ],
        130_000,
      );
      const launched = JSON.parse(launch.stdout) as AgentTaskRecord;

      assert.equal(launched.runtime, "claude-code");
      assert.deepEqual(launched.launchPlan.args, [
        "-p",
        "--model",
        model,
        "--output-format",
        "stream-json",
        "--verbose",
        prompt,
      ]);

      const completed = await waitForTerminalTask(workspaceRoot, launched.taskId, 120_000);
      assert.equal(completed.status, "succeeded");
      assert.equal(completed.launchPlan.outputTransport.kind, "jsonl_events");

      const list = await runCli(workspaceRoot, ["list", "--workspace", workspaceRoot, "--json"]);
      const tasks = JSON.parse(list.stdout) as AgentTaskRecord[];
      assert.ok(tasks.some((task) => task.taskId === launched.taskId));

      const read = await runCli(workspaceRoot, [
        "read",
        launched.taskId,
        "--workspace",
        workspaceRoot,
      ]);
      assert.match(read.stdout, /orchestrator-smoke-ok/);

      const transcript = await readFile(completed.paths.transcriptJsonl, "utf8");
      assert.match(transcript, /orchestrator-smoke-ok/);

      const agentEvents = await runCli(workspaceRoot, [
        "events",
        launched.taskId,
        "--workspace",
        workspaceRoot,
        "--agent-only",
      ]);
      assert.match(agentEvents.stdout, /agent_event/);
      assert.match(agentEvents.stdout, /agent\.result/);
    }, "orchestrator-claude-smoke-");
  },
);

test(
  "Claude Code smoke: interrupt a real claude-code task",
  {
    skip: runClaudeSmoke ? false : "Set RUN_CLAUDE_SMOKE=1 to run real Claude Code smoke tests.",
  },
  async () => {
    await assertClaudeAvailableAndAuthenticated();

    await withTempWorkspace(async (workspaceRoot) => {
      const model = process.env.CLAUDE_SMOKE_MODEL ?? "haiku";
      const prompt = "Write a very long implementation plan. Keep going until interrupted.";
      const launch = await runCli(
        workspaceRoot,
        [
          "launch",
          "claude-code",
          "--workspace",
          workspaceRoot,
          "--model",
          model,
          "--timeout-ms",
          "120000",
          "--json",
          prompt,
        ],
        130_000,
      );
      const launched = JSON.parse(launch.stdout) as AgentTaskRecord;

      const interrupt = await runCli(workspaceRoot, [
        "interrupt",
        launched.taskId,
        "--workspace",
        workspaceRoot,
        "--reason",
        "claude smoke cancellation",
        "--json",
      ]);
      const interrupted = JSON.parse(interrupt.stdout) as {
        interrupted: Array<{ taskId: string; status: string; state?: string }>;
      };
      assert.equal(interrupted.interrupted[0]?.taskId, launched.taskId);
      assert.equal(interrupted.interrupted[0]?.status, "running");
      assert.equal(interrupted.interrupted[0]?.state, "stopping");

      const completed = await waitForTerminalTask(workspaceRoot, launched.taskId, 120_000);
      assert.equal(completed.status, "cancelled");
      assert.equal(completed.error, "claude smoke cancellation");
    }, "orchestrator-claude-interrupt-");
  },
);

test(
  "Claude Code smoke: timeout a real claude-code task",
  {
    skip: runClaudeSmoke ? false : "Set RUN_CLAUDE_SMOKE=1 to run real Claude Code smoke tests.",
  },
  async () => {
    await assertClaudeAvailableAndAuthenticated();

    await withTempWorkspace(async (workspaceRoot) => {
      const model = process.env.CLAUDE_SMOKE_MODEL ?? "haiku";
      const prompt = "Reply with a short sentence.";
      const launch = await runCli(
        workspaceRoot,
        [
          "launch",
          "claude-code",
          "--workspace",
          workspaceRoot,
          "--model",
          model,
          "--timeout-ms",
          "1",
          "--json",
          prompt,
        ],
        130_000,
      );
      const launched = JSON.parse(launch.stdout) as AgentTaskRecord;

      const completed = await waitForTerminalTask(workspaceRoot, launched.taskId, 120_000);
      assert.equal(completed.status, "timed_out");
      assert.match(completed.error ?? "", /Timed out/);
    }, "orchestrator-claude-timeout-");
  },
);
