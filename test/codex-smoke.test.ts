import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AgentTaskRecord } from "@backnotprop/orchestrator-core";
import { assertCodexAvailable, runCli, waitForTerminalTask, withTempWorkspace } from "./helpers.ts";

const runCodexSmoke = process.env.RUN_CODEX_SMOKE === "1";

test(
  "Codex smoke: launch codex through structured exec JSONL runtime",
  {
    skip: runCodexSmoke ? false : "Set RUN_CODEX_SMOKE=1 to run real Codex smoke tests.",
  },
  async () => {
    await assertCodexAvailable();

    await withTempWorkspace(async (workspaceRoot) => {
      const model = process.env.CODEX_SMOKE_MODEL ?? "gpt-5.4-mini";
      const prompt = "Reply with exactly this text and no markdown: orchestrator-codex-smoke-ok";
      const args = [
        "launch",
        "codex",
        "--workspace",
        workspaceRoot,
        "--timeout-ms",
        "120000",
        "--json",
      ];

      args.push("--model", model);
      args.push(prompt);

      const launch = await runCli(workspaceRoot, args, 130_000);
      const launched = JSON.parse(launch.stdout) as AgentTaskRecord;

      assert.equal(launched.runtime, "codex");
      assert.equal(launched.launchPlan.outputTransport.kind, "jsonl_events");
      assert.deepEqual(launched.launchPlan.args, [
        "exec",
        "--skip-git-repo-check",
        "--model",
        model,
        "--json",
        prompt,
      ]);

      const completed = await waitForTerminalTask(workspaceRoot, launched.taskId, 120_000);
      assert.equal(completed.status, "succeeded");

      const read = await runCli(workspaceRoot, [
        "read",
        launched.taskId,
        "--workspace",
        workspaceRoot,
      ]);
      assert.match(read.stdout, /orchestrator-codex-smoke-ok/);

      const transcript = await readFile(completed.paths.transcriptJsonl, "utf8");
      assert.match(transcript, /orchestrator-codex-smoke-ok/);

      const workerEvents = await runCli(workspaceRoot, [
        "events",
        launched.taskId,
        "--workspace",
        workspaceRoot,
        "--worker-only",
      ]);
      assert.match(workerEvents.stdout, /worker_event/);
      assert.match(workerEvents.stdout, /agent\.message/);
      assert.match(workerEvents.stdout, /turn\.completed/);
    }, "orchestrator-codex-smoke-");
  },
);
