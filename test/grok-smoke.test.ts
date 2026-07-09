import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AgentTaskRecord } from "@backnotprop/orchestrator-core";
import { assertGrokAvailable, runCli, waitForTerminalTask, withTempWorkspace } from "./helpers.ts";

const runGrokSmoke = process.env.RUN_GROK_SMOKE === "1";

test(
  "Grok smoke: launch and resume grok through streaming JSON runtime",
  {
    skip: runGrokSmoke ? false : "Set RUN_GROK_SMOKE=1 to run real Grok smoke tests.",
  },
  async () => {
    await assertGrokAvailable();

    const providerHome = process.env.HOME;
    const providerXdgConfigHome = process.env.XDG_CONFIG_HOME;

    await withTempWorkspace(async (workspaceRoot) => {
      const model = process.env.GROK_SMOKE_MODEL;
      const prompt = "Reply with exactly this text and no markdown: orchestrator-grok-smoke-ok";
      const args = [
        "launch",
        "grok",
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

      assert.equal(launched.runtime, "grok");
      assert.equal(launched.launchPlan.outputTransport.kind, "jsonl_events");
      assert.deepEqual(launched.launchPlan.args, [
        "--no-auto-update",
        ...(model ? ["-m", model] : []),
        "--output-format",
        "streaming-json",
        "-p",
        prompt,
      ]);

      const completed = await waitForTerminalTask(workspaceRoot, launched.taskId, 120_000);
      assert.equal(completed.status, "succeeded");
      assert.equal(completed.provider?.provider, "grok");
      assert.ok(completed.provider?.sessionId);

      const read = await runCli(workspaceRoot, [
        "read",
        launched.taskId,
        "--workspace",
        workspaceRoot,
      ]);
      assert.equal(read.stdout.trim(), "orchestrator-grok-smoke-ok");

      const transcript = await readFile(completed.paths.transcriptJsonl, "utf8");
      assert.match(transcript, /"type":"text"/);
      assert.match(transcript, /"type":"end"/);

      const agentEvents = await runCli(workspaceRoot, [
        "events",
        launched.taskId,
        "--workspace",
        workspaceRoot,
        "--agent-only",
      ]);
      assert.match(agentEvents.stdout, /agent\.message_delta/);
      assert.match(agentEvents.stdout, /agent\.result/);

      const resumePrompt =
        "Reply with exactly this text and no markdown: orchestrator-grok-resume-smoke-ok";
      const resume = await runCli(
        workspaceRoot,
        [
          "resume",
          completed.taskId,
          "--workspace",
          workspaceRoot,
          "--wait",
          "--timeout-ms",
          "120000",
          "--json",
          resumePrompt,
        ],
        130_000,
        {
          ...(providerHome ? { HOME: providerHome } : {}),
          ...(providerXdgConfigHome ? { XDG_CONFIG_HOME: providerXdgConfigHome } : {}),
        },
      );
      const resumed = JSON.parse(resume.stdout) as AgentTaskRecord;

      assert.equal(resumed.status, "succeeded");
      assert.equal(resumed.runtime, "grok");
      assert.equal(resumed.provider?.provider, "grok");
      assert.equal(resumed.provider?.sessionId, completed.provider.sessionId);
      assert.deepEqual(resumed.launchPlan.args, [
        "--no-auto-update",
        "--resume",
        completed.provider.sessionId,
        ...(model ? ["-m", model] : []),
        "--output-format",
        "streaming-json",
        "-p",
        resumePrompt,
      ]);

      const resumedRead = await runCli(workspaceRoot, [
        "read",
        resumed.taskId,
        "--workspace",
        workspaceRoot,
      ]);
      assert.equal(resumedRead.stdout.trim(), "orchestrator-grok-resume-smoke-ok");
    }, "orchestrator-grok-smoke-");
  },
);
