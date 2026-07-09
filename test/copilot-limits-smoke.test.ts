import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { cliPath, repoRoot } from "./cli-support.ts";

const execFileAsync = promisify(execFile);
const runCopilotLimitsSmoke = process.env.RUN_COPILOT_LIMITS_SMOKE === "1";

test(
  "Copilot limits live smoke returns a valid provider snapshot",
  { skip: !runCopilotLimitsSmoke },
  async () => {
    const result = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", cliPath, "limits", "--provider", "copilot", "--json"],
      {
        cwd: repoRoot,
        timeout: 20_000,
        maxBuffer: 1_000_000,
        env: process.env,
      },
    );

    const report = JSON.parse(result.stdout.toString()) as {
      schemaVersion: number;
      providers: Array<{
        provider: string;
        status: string;
        windows?: unknown[];
        error?: { code?: string };
      }>;
    };

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.providers.length, 1);
    assert.equal(report.providers[0]?.provider, "copilot");
    assert.match(report.providers[0]?.status ?? "", /^(available|partial|unavailable)$/);
    assert.ok(Array.isArray(report.providers[0]?.windows));
  },
);
