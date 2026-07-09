import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { cliPath } from "./cli-support.ts";

const execFileAsync = promisify(execFile);
const runClaudeLimitsSmoke = process.env.RUN_CLAUDE_LIMITS_SMOKE === "1";

test(
  "Claude limits smoke: read real Claude provider limit state",
  {
    skip: runClaudeLimitsSmoke
      ? false
      : "Set RUN_CLAUDE_LIMITS_SMOKE=1 to run real Claude limits smoke.",
  },
  async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "orchestrator-claude-limits-smoke-"));
    try {
      const result = await execFileAsync(
        process.execPath,
        [
          "--experimental-strip-types",
          cliPath,
          "limits",
          "--workspace",
          workspaceRoot,
          "--provider",
          "claude",
          "--json",
          "--compact",
        ],
        {
          cwd: workspaceRoot,
          timeout: 15_000,
          maxBuffer: 1_000_000,
          env: process.env,
        },
      );

      const report = JSON.parse(result.stdout.toString()) as {
        providers: Array<{ id: string; status: string; error?: { code?: string } }>;
      };
      const claude = report.providers[0];
      assert.equal(claude?.id, "claude");
      assert.ok(
        claude?.status === "available" || claude?.status === "partial",
        JSON.stringify(claude),
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  },
);
