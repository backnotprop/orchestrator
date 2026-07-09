import assert from "node:assert/strict";
import test from "node:test";
import { assertOneJsonLine, runCli, withTempWorkspace } from "./cli-support.ts";

const noProviderLimitAuthEnv = {
  PATH: "",
  CODEX_HOME: "",
  COPILOT_API_TOKEN: "",
  GITHUB_TOKEN: "",
  GH_TOKEN: "",
  CLAUDE_OAUTH_ACCESS_TOKEN: "",
  ORCHESTRATOR_CLAUDE_OAUTH_ACCESS_TOKEN: "",
  CLAUDE_OAUTH_SCOPES: "",
  CLAUDE_CONFIG_DIR: "",
};

test("CLI limits prints human report", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const result = await runCli(workspaceRoot, ["limits", "--workspace", workspaceRoot], 10_000, {
      ...noProviderLimitAuthEnv,
      CODEX_HOME: `${workspaceRoot}/.codex`,
    });

    assert.match(result.stdout, /provider\s+account\s+status\s+primary\s+secondary\s+reset/);
    assert.match(result.stdout, /codex\s+unavailable\s+unavailable\s+-\s+-\s+auth_missing/);
    assert.match(result.stdout, /copilot\s+unavailable\s+unavailable\s+-\s+-\s+auth_missing/);
    assert.match(result.stdout, /claude\s+unavailable\s+unavailable\s+-\s+-\s+auth_missing/);
  }, "orchestrator-cli-limits-human-");
});

test("CLI limits supports full JSON and provider filtering", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const result = await runCli(
      workspaceRoot,
      ["limits", "--workspace", workspaceRoot, "--provider", "codex", "--json"],
      10_000,
      {
        ...noProviderLimitAuthEnv,
        CODEX_HOME: `${workspaceRoot}/.codex`,
      },
    );
    const report = JSON.parse(result.stdout) as {
      schemaVersion: number;
      providers: { provider: string; status: string; error?: { code?: string } }[];
    };

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.providers.length, 1);
    assert.equal(report.providers[0]?.provider, "codex");
    assert.equal(report.providers[0]?.status, "unavailable");
    assert.equal(report.providers[0]?.error?.code, "auth_missing");
  }, "orchestrator-cli-limits-json-");
});

test("CLI limits supports compact JSON", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const result = await runCli(
      workspaceRoot,
      ["limits", "--workspace", workspaceRoot, "--json", "--compact", "--timeout-ms", "1234"],
      10_000,
      {
        ...noProviderLimitAuthEnv,
        CODEX_HOME: `${workspaceRoot}/.codex`,
      },
    );
    assertOneJsonLine(result.stdout);

    const report = JSON.parse(result.stdout) as {
      schemaVersion: number;
      providers: { id: string; status: string; error?: { code?: string } }[];
      fullLimits: { args: string[] };
    };

    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(
      report.providers.map((provider) => provider.id),
      ["codex", "copilot", "claude"],
    );
    assert.ok(report.providers.every((provider) => provider.status === "unavailable"));
    assert.equal(
      report.providers.find((provider) => provider.id === "codex")?.error?.code,
      "auth_missing",
    );
    assert.equal(
      report.providers.find((provider) => provider.id === "copilot")?.error?.code,
      "auth_missing",
    );
    assert.equal(
      report.providers.find((provider) => provider.id === "claude")?.error?.code,
      "auth_missing",
    );
    assert.deepEqual(report.fullLimits.args, [
      "limits",
      "--json",
      "--workspace",
      workspaceRoot,
      "--timeout-ms",
      "1234",
    ]);
  }, "orchestrator-cli-limits-compact-");
});

test("CLI limits compact output requires JSON and validates providers", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await assert.rejects(
      runCli(workspaceRoot, ["limits", "--workspace", workspaceRoot, "--compact"]),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /limits --compact requires --json/);
        assert.match(error.message, /Use limits --json --compact/);
        return true;
      },
    );

    await assert.rejects(
      runCli(workspaceRoot, [
        "limits",
        "--workspace",
        workspaceRoot,
        "--provider",
        "openai",
        "--json",
      ]),
      (error: unknown) => {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          error: { message: string; reason?: string; input?: string; matches?: string[] };
        };
        assert.match(parsed.error.message, /Unsupported limits provider "openai"/);
        assert.equal(parsed.error.reason, "invalid_option_value");
        assert.equal(parsed.error.input, "openai");
        assert.deepEqual(parsed.error.matches, ["codex", "copilot", "claude"]);
        return true;
      },
    );
  }, "orchestrator-cli-limits-validation-");
});
