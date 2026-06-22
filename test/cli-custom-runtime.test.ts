import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { AGENT_CONTROL_PREVIEW_MAX_BYTES } from "@backnotprop/orchestrator-core";
import type { AgentTaskRecord } from "@backnotprop/orchestrator-core";
import { runCli, waitForTaskStatus, withTempWorkspace } from "./cli-support.ts";

test("CLI loads custom process runtimes from workspace config", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await writeFile(
      `${workspaceRoot}/orchestrator.config.json`,
      `${JSON.stringify(
        {
          agents: {
            "echo-agent": {
              adapter: "process",
              command: "node",
              args: ["-e", "process.stdout.write(process.argv.at(-1) ?? '')", "{prompt}"],
              output: "text",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const help = await runCli(workspaceRoot, ["help", "--workspace", workspaceRoot, "--json"]);
    const helpDocument = JSON.parse(help.stdout) as {
      runtimes: {
        id: string;
        executable: string;
        enabled: boolean;
        defaultOutputMode?: string;
        outputModes: string[];
      }[];
    };
    assert.ok(
      helpDocument.runtimes.some(
        (runtime) =>
          runtime.id === "echo-agent" &&
          runtime.executable === "node" &&
          runtime.enabled &&
          runtime.defaultOutputMode === "text" &&
          runtime.outputModes.includes("text"),
      ),
    );

    const launch = await runCli(workspaceRoot, [
      "launch",
      "echo-agent",
      "--workspace",
      workspaceRoot,
      "--name",
      "custom echo",
      "--output-mode",
      "text",
      "--json",
      "custom config works",
    ]);
    const launched = JSON.parse(launch.stdout) as AgentTaskRecord;
    assert.equal(launched.runtime, "echo-agent");
    assert.equal(launched.launchPlan.executable, "node");
    assert.deepEqual(launched.launchPlan.args, [
      "-e",
      "process.stdout.write(process.argv.at(-1) ?? '')",
      "custom config works",
    ]);

    await waitForTaskStatus(workspaceRoot, launched.taskId, "succeeded");

    const read = await runCli(workspaceRoot, [
      "read",
      launched.taskId,
      "--workspace",
      workspaceRoot,
    ]);
    assert.equal(read.stdout, "custom config works");

    const list = await runCli(workspaceRoot, ["list", "--workspace", workspaceRoot]);
    const columns = list.stdout.trim().split("\t");
    assert.equal(columns[0], "custom echo");
    assert.equal(columns[2], "echo-agent");
  }, "orchestrator-cli-custom-config-");
});

test("CLI compact launch exposes bounded failure follow-up", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await writeFile(
      `${workspaceRoot}/orchestrator.config.json`,
      `${JSON.stringify(
        {
          agents: {
            missing: {
              adapter: "process",
              command: "definitely-missing-orchestrator-runtime",
              args: ["{prompt}"],
              output: "text",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const launch = await runCli(workspaceRoot, [
      "launch",
      "missing",
      "--workspace",
      workspaceRoot,
      "--name",
      "missing exec",
      "--wait",
      "--json",
      "--compact",
      "hello",
    ]);
    const launched = JSON.parse(launch.stdout) as {
      id: string;
      status: string;
      active: boolean;
      error?: string;
      maxBytes?: number;
      commands?: {
        logsPreview?: { args: string[] };
        events?: { args: string[] };
        agentEvents?: { args: string[] };
      };
    };

    assert.equal(launched.status, "failed");
    assert.equal(launched.active, false);
    assert.deepEqual(launched.commands?.logsPreview?.args, [
      "logs",
      launched.id,
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
    ]);
    assert.deepEqual(launched.commands?.events?.args, [
      "events",
      launched.id,
      "--json",
      "--compact",
    ]);
    assert.deepEqual(launched.commands?.agentEvents?.args, [
      "events",
      launched.id,
      "--agent-only",
      "--json",
      "--compact",
    ]);
    assert.match(launched.error ?? "", /ENOENT/);
    assert.equal(launched.maxBytes, AGENT_CONTROL_PREVIEW_MAX_BYTES);
  }, "orchestrator-cli-compact-terminal-launch-");
});
