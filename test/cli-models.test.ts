import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";
import { assertOneJsonLine, runCli, withTempWorkspace } from "./cli-support.ts";

test("CLI models prints compact live runtime catalogs", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const binDir = join(workspaceRoot, "bin");
    const executable = join(binDir, "grok");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        'if [ "$1" = "models" ]; then',
        "  printf '%s\\n' 'Default model: grok-current' 'Available models:' '  * grok-current (default)' '  - grok-fast'",
        "  exit 0",
        "fi",
        'if [ "$1" = "version" ]; then',
        "  printf '%s\\n' 'grok 1.2.3'",
        "  exit 0",
        "fi",
        "exit 2",
        "",
      ].join("\n"),
    );
    await chmod(executable, 0o755);

    const result = await runCli(
      workspaceRoot,
      ["models", "grok", "--workspace", workspaceRoot, "--json", "--compact"],
      10_000,
      { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
    );
    assertOneJsonLine(result.stdout);
    const report = JSON.parse(result.stdout) as {
      schemaVersion: number;
      runtimes: {
        id: string;
        status: string;
        defaultModel?: string;
        cliVersion?: string;
        models: { id: string; kind: string; isDefault?: boolean }[];
      }[];
      fullModels: { args: string[] };
    };

    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(report.runtimes, [
      {
        id: "grok",
        status: "available",
        source: "grok models",
        cliVersion: "grok 1.2.3",
        defaultModel: "grok-current",
        models: [
          { id: "grok-current", kind: "model", isDefault: true },
          { id: "grok-fast", kind: "model" },
        ],
      },
    ]);
    assert.deepEqual(report.fullModels.args, [
      "models",
      "--json",
      "grok",
      "--workspace",
      workspaceRoot,
    ]);

    const human = await runCli(
      workspaceRoot,
      ["models", "grok", "--workspace", workspaceRoot],
      10_000,
      { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
    );
    assert.match(human.stdout, /runtime\s+status\s+model\s+kind\s+default\s+source/);
    assert.match(human.stdout, /grok\s+available\s+grok-current\s+model\s+yes\s+grok models/);
  }, "orchestrator-cli-models-");
});

test("CLI models validates compact output and runtime ids", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await assert.rejects(
      runCli(workspaceRoot, ["models", "grok", "--compact"]),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /models --compact requires --json/);
        return true;
      },
    );

    await assert.rejects(
      runCli(workspaceRoot, ["models", "missing", "--json"]),
      (error: unknown) => {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          error: { reason?: string; input?: string; matches?: string[] };
        };
        assert.equal(parsed.error.reason, "unknown_runtime");
        assert.equal(parsed.error.input, "missing");
        assert.ok(parsed.error.matches?.includes("codex"));
        return true;
      },
    );
  }, "orchestrator-cli-models-validation-");
});
