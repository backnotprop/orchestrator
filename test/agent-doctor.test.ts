import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { doctorParentAgentConfig } from "@backnotprop/orchestrator-agent/doctor";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "orchestrator-agent-doctor-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("parent agent doctor reports missing default config without creating files", async () => {
  await withTempHome(async (homeDir) => {
    const report = await doctorParentAgentConfig({ homeDir });

    assert.equal(report.status, "warning");
    assert.equal(report.canRunParentAgent, false);
    assert.equal(report.agentDir, join(homeDir, ".orchestrator"));
    assert.ok(
      report.checks.some((check) => check.id === "auth-json" && check.status === "warning"),
    );
    assert.ok(report.suggestions.some((suggestion) => suggestion.includes("auth.json")));

    await assert.rejects(() => access(report.authPath), /ENOENT/);
  });
});

test("parent agent doctor reports valid local parent-agent config", async () => {
  await withTempHome(async (homeDir) => {
    const agentDir = join(homeDir, ".orchestrator");
    await mkdir(join(agentDir, "sessions"), { recursive: true });
    await writeFile(
      join(agentDir, "auth.json"),
      `${JSON.stringify({ openai: { type: "api_key", key: "test-key" } }, null, 2)}\n`,
    );
    await writeFile(join(agentDir, "models.json"), `${JSON.stringify({ providers: {} })}\n`);

    const report = await doctorParentAgentConfig({ homeDir });

    assert.equal(report.status, "ok");
    assert.equal(report.canRunParentAgent, true);
    assert.ok(
      report.checks.some(
        (check) =>
          check.id === "auth-json" &&
          check.status === "ok" &&
          Array.isArray(check.details?.providers) &&
          check.details.providers.includes("openai"),
      ),
    );
    assert.ok(report.checks.some((check) => check.id === "models-json" && check.status === "ok"));
    assert.ok(report.checks.some((check) => check.id === "sessions-dir" && check.status === "ok"));
  });
});

test("parent agent doctor suggests existing Pi config for live testing", async () => {
  await withTempHome(async (homeDir) => {
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });

    const report = await doctorParentAgentConfig({ homeDir });

    assert.equal(report.status, "warning");
    assert.ok(
      report.suggestions.some((suggestion) =>
        suggestion.includes(`orchestrator run --agent-dir ${join(homeDir, ".pi", "agent")}`),
      ),
    );
    assert.ok(
      report.suggestions.some((suggestion) =>
        suggestion.includes(`orchestrator doctor --agent-dir ${join(homeDir, ".pi", "agent")}`),
      ),
    );
  });
});

test("parent agent doctor reports invalid auth JSON as an error", async () => {
  await withTempHome(async (homeDir) => {
    const agentDir = join(homeDir, ".orchestrator");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "auth.json"), "{nope");

    const report = await doctorParentAgentConfig({ homeDir });

    assert.equal(report.status, "error");
    assert.equal(report.canRunParentAgent, false);
    assert.ok(report.checks.some((check) => check.id === "auth-json" && check.status === "error"));
  });
});

test("parent agent doctor reports invalid auth credential shape as an error", async () => {
  await withTempHome(async (homeDir) => {
    const agentDir = join(homeDir, ".orchestrator");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "auth.json"),
      `${JSON.stringify({ openai: { type: "api_key", apiKey: "test-key" } }, null, 2)}\n`,
    );

    const report = await doctorParentAgentConfig({ homeDir });

    assert.equal(report.status, "error");
    assert.equal(report.canRunParentAgent, false);
    assert.ok(
      report.checks.some(
        (check) =>
          check.id === "auth-json" &&
          check.status === "error" &&
          check.message.includes("invalid credential"),
      ),
    );
  });
});

test("parent agent doctor reports invalid model config schema as an error", async () => {
  await withTempHome(async (homeDir) => {
    const agentDir = join(homeDir, ".orchestrator");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "auth.json"),
      `${JSON.stringify({ openai: { type: "api_key", key: "test-key" } }, null, 2)}\n`,
    );
    await writeFile(join(agentDir, "models.json"), `${JSON.stringify({ providers: [] })}\n`);

    const report = await doctorParentAgentConfig({ homeDir });

    assert.equal(report.status, "error");
    assert.equal(report.canRunParentAgent, false);
    assert.ok(
      report.checks.some(
        (check) =>
          check.id === "configured-models" &&
          check.status === "error" &&
          check.message.includes("Invalid models.json schema"),
      ),
    );
  });
});
