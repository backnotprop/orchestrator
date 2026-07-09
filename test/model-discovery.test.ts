import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_CODE_RUNTIME,
  CODEX_RUNTIME,
  BUILT_IN_AGENT_RUNTIMES,
  PI_RUNTIME,
  SHELL_RUNTIME,
  type HeadlessAgentRuntimeConfig,
} from "@backnotprop/orchestrator-core/runtime";
import {
  createClaudeModelReader,
  createCodexModelReader,
  createCopilotModelReader,
  createGrokModelReader,
  createPiModelReader,
  readRuntimeModels,
  type ModelCommandRunner,
  type RuntimeModelReader,
} from "@backnotprop/orchestrator-core/model-discovery";

const fixedNow = new Date("2026-07-09T12:00:00.000Z");

test("runtime model discovery normalizes live provider catalogs", async () => {
  const runCommand = commandRunner({
    "codex --version": "codex-cli 1.0.0\n",
    "claude --help":
      "--model <model> Model for the session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a full name.\n",
    "claude --version": "2.1.0 (Claude Code)\n",
    "copilot help config": [
      "Configuration Settings:",
      "  `model`: AI model to use.",
      '    - "claude-fable-5"',
      '    - "gpt-5.5"',
      "",
      "  `contextTier`: context window tier.",
    ].join("\n"),
    "copilot --help":
      "--model <model> Set the model (use 'auto' to let Copilot pick automatically)\n",
    "copilot --version": "GitHub Copilot CLI 1.0.0\n",
    "grok models": [
      "Default model: grok-4.5",
      "Available models:",
      "  * grok-4.5 (default)",
      "  - grok-fast",
    ].join("\n"),
    "grok version": "grok 1.0.0\n",
    "pi --list-models": [
      "provider  model       context  max-out  thinking  images",
      "openai    gpt-new     400K     128K     yes       yes",
      "local     small-code  32K      8K       no        no",
    ].join("\n"),
    "pi --version": "1.0.0\n",
  });
  let codexPage = 0;
  const readers: RuntimeModelReader[] = [
    createCodexModelReader({
      runCommand,
      async readPage(params) {
        codexPage += 1;
        if (!params.cursor) {
          return {
            data: [
              {
                model: "gpt-new",
                displayName: "GPT New",
                description: "Current default",
                hidden: false,
                isDefault: true,
                inputModalities: ["text", "image"],
                supportedReasoningEfforts: [
                  { reasoningEffort: "medium" },
                  { reasoningEffort: "high" },
                ],
              },
              { model: "hidden-model", hidden: true, isDefault: false },
            ],
            nextCursor: "page-2",
          };
        }
        assert.equal(params.cursor, "page-2");
        return {
          data: [{ model: "gpt-fast", hidden: false, isDefault: false }],
          nextCursor: null,
        };
      },
    }),
    createClaudeModelReader({ runCommand }),
    createCopilotModelReader({ runCommand }),
    createGrokModelReader({ runCommand }),
    createPiModelReader({ runCommand }),
  ];

  const report = await readRuntimeModels({
    runtimes: [
      CODEX_RUNTIME,
      CLAUDE_CODE_RUNTIME,
      BUILT_IN_AGENT_RUNTIMES.copilot,
      BUILT_IN_AGENT_RUNTIMES.grok,
      PI_RUNTIME,
    ],
    workspaceRoot: "/tmp/orchestrator-model-discovery",
    now: fixedNow,
    readers,
  });
  const catalogs = new Map(report.runtimes.map((catalog) => [catalog.runtime, catalog]));

  assert.equal(report.generatedAt, fixedNow.toISOString());
  assert.equal(codexPage, 2);
  assert.equal(catalogs.get("codex")?.defaultModel, "gpt-new");
  assert.deepEqual(
    catalogs.get("codex")?.models.map((model) => model.id),
    ["gpt-new", "gpt-fast"],
  );
  assert.deepEqual(catalogs.get("codex")?.models[0]?.reasoningEfforts, ["medium", "high"]);
  assert.equal(catalogs.get("claude-code")?.status, "partial");
  assert.deepEqual(
    catalogs.get("claude-code")?.models.map((model) => [model.id, model.kind]),
    [
      ["fable", "alias"],
      ["opus", "alias"],
      ["sonnet", "alias"],
    ],
  );
  assert.deepEqual(
    catalogs.get("copilot")?.models.map((model) => [model.id, model.kind]),
    [
      ["auto", "router"],
      ["claude-fable-5", "model"],
      ["gpt-5.5", "model"],
    ],
  );
  assert.equal(catalogs.get("grok")?.defaultModel, "grok-4.5");
  assert.equal(catalogs.get("grok")?.models[0]?.isDefault, true);
  assert.deepEqual(
    catalogs.get("pi")?.models.map((model) => model.id),
    ["openai/gpt-new", "local/small-code"],
  );
  assert.deepEqual(catalogs.get("pi")?.models[0]?.inputModalities, ["text", "image"]);
});

test("runtime model discovery reports invalid, unsupported, and redacted failures", async () => {
  const invalidCodex = createCodexModelReader({
    runCommand: commandRunner({ "codex --version": "codex-cli 1.0.0\n" }),
    async readPage() {
      return { data: "not-an-array" };
    },
  });
  const throwingReader: RuntimeModelReader = {
    runtimeIds: ["secret-runtime"],
    async read() {
      throw new Error("Bearer secret-token failed with access_token=secret-access");
    },
  };
  const secretRuntime: HeadlessAgentRuntimeConfig = {
    ...SHELL_RUNTIME,
    id: "secret-runtime",
    displayName: "Secret Runtime",
  };

  const report = await readRuntimeModels({
    runtimes: [CODEX_RUNTIME, SHELL_RUNTIME, secretRuntime],
    workspaceRoot: "/tmp/orchestrator-model-discovery",
    now: fixedNow,
    readers: [invalidCodex, throwingReader],
  });
  const catalogs = new Map(report.runtimes.map((catalog) => [catalog.runtime, catalog]));

  assert.equal(catalogs.get("codex")?.status, "unavailable");
  assert.equal(catalogs.get("codex")?.error?.code, "invalid_model_catalog");
  assert.equal(catalogs.get("shell")?.status, "unsupported");
  assert.equal(catalogs.get("secret-runtime")?.status, "unavailable");
  assert.match(catalogs.get("secret-runtime")?.error?.message ?? "", /Bearer \[redacted\]/);
  assert.match(catalogs.get("secret-runtime")?.error?.message ?? "", /access_token=\[redacted\]/);
  assert.doesNotMatch(
    catalogs.get("secret-runtime")?.error?.message ?? "",
    /secret-token|secret-access/,
  );
});

function commandRunner(outputs: Readonly<Record<string, string>>): ModelCommandRunner {
  return async (input) => {
    const key = `${input.executable} ${input.args.join(" ")}`;
    const stdout = outputs[key];
    if (stdout === undefined) {
      return {
        ok: false,
        error: { code: "command_failed", message: `No fake output for ${key}.` },
      };
    }
    return { ok: true, stdout, stderr: "" };
  };
}
