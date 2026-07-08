import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AgentTaskRecord } from "@backnotprop/orchestrator-core";
import {
  assertCopilotAvailable,
  runCli,
  waitForTerminalTask,
  withTempWorkspace,
} from "./helpers.ts";

const runCopilotSmoke = process.env.RUN_COPILOT_SMOKE === "1";

test(
  "Copilot smoke: launch copilot through programmatic JSONL runtime",
  {
    skip: runCopilotSmoke ? false : "Set RUN_COPILOT_SMOKE=1 to run real Copilot smoke tests.",
  },
  async () => {
    await assertCopilotAvailable();

    const providerHome = process.env.HOME;
    const providerXdgConfigHome = process.env.XDG_CONFIG_HOME;

    await withTempWorkspace(async (workspaceRoot) => {
      const model = process.env.COPILOT_SMOKE_MODEL;
      const prompt = "Reply with exactly this text and no markdown: orchestrator-copilot-smoke-ok";
      const args = [
        "launch",
        "copilot",
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

      const launch = await runCli(workspaceRoot, args, 130_000, {
        ...(providerHome ? { HOME: providerHome } : {}),
        ...(providerXdgConfigHome ? { XDG_CONFIG_HOME: providerXdgConfigHome } : {}),
      });
      const launched = JSON.parse(launch.stdout) as AgentTaskRecord;

      assert.equal(launched.runtime, "copilot");
      assert.equal(launched.launchPlan.outputTransport.kind, "jsonl_events");
      assert.deepEqual(launched.launchPlan.args, [
        "--no-ask-user",
        "--yolo",
        ...(model ? ["--model", model] : []),
        "--output-format",
        "json",
        "--stream",
        "off",
        "-p",
        prompt,
      ]);

      const completed = await waitForTerminalTask(workspaceRoot, launched.taskId, 120_000);
      assert.equal(completed.status, "succeeded");
      assert.equal(completed.provider?.provider, "copilot");
      assert.ok(completed.provider?.sessionId);

      const read = await runCli(workspaceRoot, [
        "read",
        launched.taskId,
        "--workspace",
        workspaceRoot,
      ]);
      assert.match(read.stdout, /orchestrator-copilot-smoke-ok/);

      const transcript = await readFile(completed.paths.transcriptJsonl, "utf8");
      assert.match(transcript, /orchestrator-copilot-smoke-ok/);

      const agentEvents = await runCli(workspaceRoot, [
        "events",
        launched.taskId,
        "--workspace",
        workspaceRoot,
        "--agent-only",
      ]);
      assert.match(agentEvents.stdout, /agent_event/);
      assert.match(agentEvents.stdout, /agent\.message/);
      assert.match(agentEvents.stdout, /agent\.result/);
    }, "orchestrator-copilot-smoke-");
  },
);
