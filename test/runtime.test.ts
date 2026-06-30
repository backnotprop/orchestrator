import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ALL_AGENT_RUNTIMES,
  BUILT_IN_AGENT_RUNTIMES,
  LaunchPlanError,
  buildAgentLaunchPlan,
  buildAgentResumeLaunchPlan,
  compileOrchestratorConfig,
  getEnabledAgentRuntimes,
  loadConfiguredRuntimeRegistry,
} from "@backnotprop/orchestrator-core/runtime";
import type { RuntimeRegistry } from "@backnotprop/orchestrator-core/runtime";

const sampleTask = "Review this repository and summarize the main risks.";
const sampleCwd = "/tmp/orchestrator-workspace";

test("built-in runtime registry is exhaustive and internally consistent", () => {
  assert.deepEqual([...ALL_AGENT_RUNTIMES].sort(), [
    "claude-code",
    "codex",
    "codex-app-server",
    "pi",
    "shell",
  ]);

  assert.deepEqual(Object.keys(BUILT_IN_AGENT_RUNTIMES).sort(), [...ALL_AGENT_RUNTIMES].sort());

  for (const runtimeId of ALL_AGENT_RUNTIMES) {
    const config = BUILT_IN_AGENT_RUNTIMES[runtimeId];
    assert.equal(config.id, runtimeId);
    assert.equal(typeof config.displayName, "string");
    assert.notEqual(config.displayName.length, 0);
    assert.equal(typeof config.launch.executable, "string");
    assert.ok(Array.isArray(config.launch.baseArgs));
    assert.equal(typeof config.detect.command, "string");
    assert.equal(typeof config.control.interrupt, "string");
    assert.equal(typeof config.control.steerRunning, "boolean");
    assert.equal(typeof config.capabilities.handlesOwnAuth, "boolean");
    assert.equal(typeof config.defaults.timeoutMs, "number");
    assert.equal(typeof config.defaults.maxOutputBytes, "number");
  }
});

test("every enabled runtime can produce an argv-based launch plan", () => {
  const enabledRuntimes = getEnabledAgentRuntimes();
  assert.ok(enabledRuntimes.length > 0);

  for (const runtime of enabledRuntimes) {
    const plan = buildAgentLaunchPlan({
      runtime: runtime.id,
      task: sampleTask,
      cwd: sampleCwd,
      env: { ORCHESTRATOR_TEST: "1" },
    });

    assert.equal(plan.runtime, runtime.id);
    assert.equal(plan.cwd, sampleCwd);
    assert.equal(plan.executable, runtime.launch.executable);
    assert.ok(Array.isArray(plan.args));
    assert.equal(plan.env.ORCHESTRATOR_TEST, "1");
    assert.equal(typeof plan.outputTransport.kind, "string");
    assert.equal(Object.hasOwn(plan, "command"), false);
    assert.equal(plan.safety.acceptsShellCommand, runtime.id === "shell");
    assert.equal(plan.executionKind, runtime.executionKind ?? "process");
  }
});

test("claude-code default plan uses stream-json for observable headless runs", () => {
  const plan = buildAgentLaunchPlan({
    runtime: "claude-code",
    task: sampleTask,
    cwd: sampleCwd,
  });

  assert.equal(plan.executable, "claude");
  assert.deepEqual(plan.args, ["-p", "--output-format", "stream-json", "--verbose", sampleTask]);
  assert.deepEqual(plan.outputTransport, { kind: "jsonl_events", finalEvent: "result" });
  assert.equal(plan.promptTransport.kind, "argv");
  assert.equal(plan.safety.acceptsShellCommand, false);
});

test("claude-code output modes are adapter transport details", () => {
  const textPlan = buildAgentLaunchPlan({
    runtime: "claude-code",
    task: sampleTask,
    cwd: sampleCwd,
    outputMode: "text",
  });

  assert.deepEqual(textPlan.args, ["-p", sampleTask]);
  assert.deepEqual(textPlan.outputTransport, { kind: "stdout_text" });

  const jsonPlan = buildAgentLaunchPlan({
    runtime: "claude-code",
    task: sampleTask,
    cwd: sampleCwd,
    outputMode: "json",
  });

  assert.deepEqual(jsonPlan.args, ["-p", "--output-format", "json", sampleTask]);
  assert.deepEqual(jsonPlan.outputTransport, { kind: "stdout_json" });

  const plan = buildAgentLaunchPlan({
    runtime: "claude-code",
    task: sampleTask,
    cwd: sampleCwd,
    outputMode: "stream_json",
  });

  assert.deepEqual(plan.args, ["-p", "--output-format", "stream-json", "--verbose", sampleTask]);
  assert.deepEqual(plan.outputTransport, { kind: "jsonl_events", finalEvent: "result" });
});

test("codex default plan uses exec JSONL events for observable headless runs", () => {
  const plan = buildAgentLaunchPlan({
    runtime: "codex",
    task: sampleTask,
    cwd: sampleCwd,
  });

  assert.equal(plan.executable, "codex");
  assert.deepEqual(plan.args, ["exec", "--skip-git-repo-check", "--json", sampleTask]);
  assert.deepEqual(plan.outputTransport, { kind: "jsonl_events", finalEvent: "turn.completed" });
});

test("codex-app-server plan uses protocol execution without putting prompt in argv", () => {
  const plan = buildAgentLaunchPlan({
    runtime: "codex-app-server",
    task: sampleTask,
    cwd: sampleCwd,
    model: "gpt-5.4-mini",
  });

  assert.equal(plan.executionKind, "protocol");
  assert.equal(plan.executable, "codex");
  assert.deepEqual(plan.args, ["app-server", "--listen", "stdio://"]);
  assert.deepEqual(plan.promptTransport, { kind: "sdk" });
  assert.deepEqual(plan.outputTransport, {
    kind: "transcript_file",
    pathHint: "transcript.jsonl",
  });
  assert.equal(plan.interrupt, "api");
  assert.equal(plan.taskForProtocol, sampleTask);
  assert.equal(plan.taskForSdkOrHttp, undefined);
});

test("model hints are mapped by runtime config when supported", () => {
  const plan = buildAgentLaunchPlan({
    runtime: "claude-code",
    task: sampleTask,
    cwd: sampleCwd,
    model: "haiku",
  });

  assert.deepEqual(plan.args, [
    "-p",
    "--model",
    "haiku",
    "--output-format",
    "stream-json",
    "--verbose",
    sampleTask,
  ]);

  const codexPlan = buildAgentLaunchPlan({
    runtime: "codex",
    task: sampleTask,
    cwd: sampleCwd,
    model: "account-supported-codex-model",
  });

  assert.deepEqual(codexPlan.args, [
    "exec",
    "--skip-git-repo-check",
    "--model",
    "account-supported-codex-model",
    "--json",
    sampleTask,
  ]);
});

test("custom process config compiles into a launchable runtime", () => {
  const [runtime] = compileOrchestratorConfig({
    agents: {
      reviewer: {
        adapter: "process",
        command: "reviewer-agent",
        args: ["run", "--prompt", "{prompt}"],
        modelFlag: "--model",
        output: { format: "jsonl", finalEvent: "done" },
      },
    },
  });

  assert.ok(runtime);
  assert.equal(runtime.id, "reviewer");
  assert.equal(runtime.launch.executable, "reviewer-agent");
  assert.deepEqual(runtime.launch.baseArgs, ["run", "--prompt", "{prompt}"]);
  assert.deepEqual(runtime.launch.prompt, { kind: "argv_template" });
  assert.deepEqual(runtime.launch.output, { kind: "jsonl_events", finalEvent: "done" });
  assert.equal(runtime.launch.defaultOutputMode, "jsonl");
  assert.deepEqual(Object.keys(runtime.launch.outputModes ?? {}), ["jsonl"]);

  const plan = buildAgentLaunchPlan(
    {
      runtime: "reviewer",
      task: sampleTask,
      cwd: sampleCwd,
      model: "small",
    },
    { reviewer: runtime },
  );

  assert.deepEqual(plan.args, ["run", "--prompt", sampleTask, "--model", "small"]);
  assert.deepEqual(plan.outputTransport, { kind: "jsonl_events", finalEvent: "done" });
  assert.equal(plan.safety.acceptsShellCommand, false);

  const explicitOutputModePlan = buildAgentLaunchPlan(
    {
      runtime: "reviewer",
      task: sampleTask,
      cwd: sampleCwd,
      outputMode: "jsonl",
    },
    { reviewer: runtime },
  );
  assert.deepEqual(explicitOutputModePlan.outputTransport, {
    kind: "jsonl_events",
    finalEvent: "done",
  });
});

test("custom process argv templates do not rewrite JavaScript template literals", () => {
  const [runtime] = compileOrchestratorConfig({
    agents: {
      "jsonl-wrapper": {
        adapter: "process",
        command: "node",
        args: ["-e", "console.log(`${prompt}:${model}`)", "{prompt}", "{model}"],
        output: { format: "jsonl", finalEvent: "final" },
      },
    },
  });

  assert.ok(runtime);
  const plan = buildAgentLaunchPlan(
    {
      runtime: "jsonl-wrapper",
      task: sampleTask,
      cwd: sampleCwd,
      model: "small",
    },
    { "jsonl-wrapper": runtime },
  );

  assert.deepEqual(plan.args, ["-e", "console.log(`${prompt}:${model}`)", sampleTask, "small"]);
});

test("custom process config rejects common prompt placeholder mistakes", () => {
  for (const args of [["{{prompt}}"], ["{task}"], ["{{task}}"], ["{{model}}", "{prompt}"]]) {
    assert.throws(
      () =>
        compileOrchestratorConfig({
          agents: {
            "bad-wrapper": {
              adapter: "process",
              command: "bad-wrapper",
              args,
              output: "text",
            },
          },
        }),
      (error) =>
        error instanceof Error &&
        error.name === "OrchestratorConfigError" &&
        "reason" in error &&
        error.reason === "invalid_config_schema" &&
        "hint" in error &&
        typeof error.hint === "string" &&
        (error.hint.includes("{prompt}") || error.hint.includes("{model}")),
    );
  }
});

test("custom config schema errors are machine-readable", () => {
  assert.throws(
    () => compileOrchestratorConfig([]),
    (error) =>
      error instanceof Error &&
      error.name === "OrchestratorConfigError" &&
      "reason" in error &&
      error.reason === "invalid_config_schema" &&
      "input" in error &&
      error.input === "orchestrator.config.json" &&
      "hint" in error &&
      typeof error.hint === "string" &&
      error.hint.includes("agents object"),
  );
});

test("custom config adapter errors include recovery details", () => {
  assert.throws(
    () =>
      compileOrchestratorConfig({
        agents: {
          remote: {
            adapter: "http",
            command: "agent-server",
            args: ["{prompt}"],
            output: "text",
          },
        },
      }),
    (error) =>
      error instanceof Error &&
      error.name === "OrchestratorConfigError" &&
      "reason" in error &&
      error.reason === "unsupported_agent_adapter" &&
      "input" in error &&
      error.input === "agents.remote.adapter" &&
      "hint" in error &&
      typeof error.hint === "string" &&
      error.hint.includes('"adapter": "process"'),
  );
});

test("custom config output errors include recovery details", () => {
  assert.throws(
    () =>
      compileOrchestratorConfig({
        agents: {
          reviewer: {
            adapter: "process",
            command: "reviewer-agent",
            args: ["{prompt}"],
            output: { mode: "text" },
          },
        },
      }),
    (error) =>
      error instanceof Error &&
      error.name === "OrchestratorConfigError" &&
      "reason" in error &&
      error.reason === "invalid_config_schema" &&
      "input" in error &&
      error.input === "agents.reviewer.output.format" &&
      "hint" in error &&
      typeof error.hint === "string" &&
      error.hint.includes('"output": "text"'),
  );
});

test("custom config loader merges XDG, home, workspace, and explicit config", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-config-"));
  try {
    const homeDir = join(root, "home");
    const xdgDir = join(root, "xdg");
    const workspaceRoot = join(root, "workspace");
    const explicitPath = join(root, "extra.json");
    await mkdir(join(homeDir, ".orchestrator"), { recursive: true });
    await mkdir(join(xdgDir, "orchestrator"), { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });

    await writeJson(join(xdgDir, "orchestrator", "config.json"), {
      agents: {
        "xdg-agent": {
          adapter: "process",
          command: "xdg-agent",
          output: "text",
        },
        "shared-agent": {
          adapter: "process",
          command: "from-xdg",
          output: "text",
        },
      },
    });
    await writeJson(join(homeDir, ".orchestrator", "config.json"), {
      agents: {
        "home-agent": {
          adapter: "process",
          command: "home-agent",
          output: "text",
        },
        "shared-agent": {
          adapter: "process",
          command: "from-home",
          output: "text",
        },
      },
    });
    await writeJson(join(workspaceRoot, "orchestrator.config.json"), {
      agents: {
        "workspace-agent": {
          adapter: "process",
          command: "workspace-agent",
          output: "text",
        },
        "shared-agent": {
          adapter: "process",
          command: "from-workspace",
          output: "text",
        },
      },
    });
    await writeJson(explicitPath, {
      agents: {
        "explicit-agent": {
          adapter: "process",
          command: "explicit-agent",
          output: "text",
        },
        "shared-agent": {
          adapter: "process",
          command: "from-explicit",
          output: "text",
        },
      },
    });

    const loaded = await loadConfiguredRuntimeRegistry({
      workspaceRoot,
      homeDir,
      env: { XDG_CONFIG_HOME: xdgDir },
      configPath: explicitPath,
    });

    assert.ok(loaded.registry["xdg-agent"]);
    assert.ok(loaded.registry["home-agent"]);
    assert.ok(loaded.registry["workspace-agent"]);
    assert.ok(loaded.registry["explicit-agent"]);
    assert.equal(loaded.registry["shared-agent"]?.launch.executable, "from-explicit");
    assert.deepEqual(loaded.loadedConfigPaths, [
      join(xdgDir, "orchestrator", "config.json"),
      join(homeDir, ".orchestrator", "config.json"),
      join(workspaceRoot, "orchestrator.config.json"),
      explicitPath,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom config loader uses home XDG fallback when XDG_CONFIG_HOME is unset", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-config-xdg-fallback-"));
  try {
    const homeDir = join(root, "home");
    const fallbackPath = join(homeDir, ".config", "orchestrator", "config.json");
    await mkdir(join(homeDir, ".config", "orchestrator"), { recursive: true });
    await writeJson(fallbackPath, {
      agents: {
        "xdg-fallback-agent": {
          adapter: "process",
          command: "xdg-fallback-agent",
          output: "text",
        },
      },
    });

    const loaded = await loadConfiguredRuntimeRegistry({
      homeDir,
      env: {},
    });

    assert.ok(loaded.registry["xdg-fallback-agent"]);
    assert.deepEqual(loaded.loadedConfigPaths, [fallbackPath]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit config remains required when it duplicates a default config path", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-config-required-"));
  try {
    const workspaceRoot = join(root, "workspace");
    const missingConfig = join(workspaceRoot, "orchestrator.config.json");
    await mkdir(workspaceRoot, { recursive: true });

    await assert.rejects(
      () =>
        loadConfiguredRuntimeRegistry({
          workspaceRoot,
          homeDir: join(root, "home"),
          env: { XDG_CONFIG_HOME: join(root, "xdg") },
          configPath: missingConfig,
        }),
      /does not exist or is unreadable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config can disable built-in runtimes", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-config-disable-built-in-"));
  try {
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeJson(join(workspaceRoot, "orchestrator.config.json"), {
      agents: {
        "claude-code": {
          enabled: false,
        },
      },
    });

    const loaded = await loadConfiguredRuntimeRegistry({
      workspaceRoot,
      homeDir: join(root, "home"),
      env: { XDG_CONFIG_HOME: join(root, "xdg") },
    });

    assert.equal(loaded.registry["claude-code"], undefined);
    assert.ok(loaded.registry.codex);
    assert.throws(
      () =>
        buildAgentLaunchPlan(
          {
            runtime: "claude-code",
            task: sampleTask,
            cwd: sampleCwd,
          },
          loaded.registry,
        ),
      /Unknown runtime "claude-code"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("later config can re-enable built-in runtimes", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-config-reenable-built-in-"));
  try {
    const homeDir = join(root, "home");
    const workspaceRoot = join(root, "workspace");
    await mkdir(join(homeDir, ".orchestrator"), { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await writeJson(join(homeDir, ".orchestrator", "config.json"), {
      agents: {
        codex: {
          enabled: false,
        },
      },
    });
    await writeJson(join(workspaceRoot, "orchestrator.config.json"), {
      agents: {
        codex: {
          enabled: true,
        },
      },
    });

    const loaded = await loadConfiguredRuntimeRegistry({
      workspaceRoot,
      homeDir,
      env: { XDG_CONFIG_HOME: join(root, "xdg") },
    });

    assert.equal(loaded.registry.codex?.id, "codex");
    assert.equal(loaded.registry.codex?.enabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config can disable custom runtimes", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-config-disable-custom-"));
  try {
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeJson(join(workspaceRoot, "orchestrator.config.json"), {
      agents: {
        reviewer: {
          enabled: false,
          adapter: "process",
          command: "reviewer-agent",
          output: "text",
        },
      },
    });

    const [compiled] = compileOrchestratorConfig({
      agents: {
        reviewer: {
          enabled: false,
          adapter: "process",
          command: "reviewer-agent",
          output: "text",
        },
      },
    });
    assert.equal(compiled?.enabled, false);

    const loaded = await loadConfiguredRuntimeRegistry({
      workspaceRoot,
      homeDir: join(root, "home"),
      env: { XDG_CONFIG_HOME: join(root, "xdg") },
    });

    assert.equal(loaded.registry.reviewer, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shell runtime is enabled and launches local commands directly", () => {
  const plan = buildAgentLaunchPlan({
    runtime: "shell",
    task: "echo hello",
    cwd: sampleCwd,
  });

  assert.equal(plan.executable, "sh");
  assert.deepEqual(plan.args, ["-lc", "echo hello"]);
  assert.equal(plan.enabled, true);
  assert.equal(plan.safety.acceptsShellCommand, true);
});

test("unknown runtimes and unsupported output modes fail before producing a plan", () => {
  assert.throws(
    () =>
      buildAgentLaunchPlan({
        runtime: "missing-runtime",
        task: sampleTask,
        cwd: sampleCwd,
      }),
    (error) =>
      error instanceof LaunchPlanError &&
      error.reason === "unknown_runtime" &&
      error.input === "missing-runtime" &&
      error.hint?.includes("help --json --compact") === true,
  );

  assert.throws(
    () =>
      buildAgentLaunchPlan({
        runtime: "claude-code",
        task: sampleTask,
        cwd: sampleCwd,
        outputMode: "xml",
      }),
    (error) =>
      error instanceof LaunchPlanError &&
      error.reason === "unsupported_output_mode" &&
      error.input === "xml" &&
      error.hint?.includes("stream_json") === true,
  );
});

test("empty task instructions and cwd fail before producing a plan", () => {
  assert.throws(
    () =>
      buildAgentLaunchPlan({
        runtime: "claude-code",
        task: "   ",
        cwd: sampleCwd,
      }),
    /Task instructions must not be empty/,
  );

  assert.throws(
    () =>
      buildAgentLaunchPlan({
        runtime: "claude-code",
        task: sampleTask,
        cwd: " ",
      }),
    /cwd must not be empty/,
  );
});

test("resume launch plans use explicit provider handles", () => {
  const codex = buildAgentResumeLaunchPlan({
    runtime: "codex",
    task: "continue codex",
    cwd: sampleCwd,
    model: "gpt-5.4-mini",
    provider: { threadId: "thread-123" },
  });
  assert.deepEqual(codex.args, [
    "exec",
    "--skip-git-repo-check",
    "--model",
    "gpt-5.4-mini",
    "--json",
    "resume",
    "thread-123",
    "continue codex",
  ]);
  assert.deepEqual(codex.resume, { provider: "codex", threadId: "thread-123" });

  const claude = buildAgentResumeLaunchPlan({
    runtime: "claude-code",
    task: "continue claude",
    cwd: sampleCwd,
    model: "haiku",
    provider: { sessionId: "session-123" },
  });
  assert.deepEqual(claude.args, [
    "-p",
    "--resume",
    "session-123",
    "--model",
    "haiku",
    "--output-format",
    "stream-json",
    "--verbose",
    "continue claude",
  ]);
  assert.deepEqual(claude.resume, { provider: "claude-code", sessionId: "session-123" });
});

test("resume launch plans reject unsupported runtimes and missing provider handles", () => {
  assert.throws(
    () =>
      buildAgentResumeLaunchPlan({
        runtime: "shell",
        task: sampleTask,
        cwd: sampleCwd,
        provider: { sessionId: "session-123" },
      }),
    (error: unknown) => error instanceof LaunchPlanError && error.reason === "unsupported_resume",
  );

  assert.throws(
    () =>
      buildAgentResumeLaunchPlan({
        runtime: "codex",
        task: sampleTask,
        cwd: sampleCwd,
        provider: {},
      }),
    (error: unknown) =>
      error instanceof LaunchPlanError && error.reason === "missing_resume_provider_id",
  );
});

test("non-argv prompt transports are handled generically", () => {
  const registry: RuntimeRegistry = {
    flagger: {
      id: "flagger",
      displayName: "Flagger",
      enabled: true,
      detect: { command: "flagger" },
      launch: {
        executable: "flagger",
        baseArgs: ["run"],
        prompt: { kind: "flag", flag: "--task" },
        output: { kind: "stdout_text" },
        cwdPolicy: "workspace",
      },
      control: { interrupt: "process_group", steerRunning: false },
      capabilities: {
        supportsStreaming: false,
        supportsRunningSteer: false,
        supportsResume: false,
        supportsStructuredEvents: false,
        supportsWorktree: false,
        handlesOwnAuth: true,
      },
      defaults: {
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
        isolation: "shared",
      },
    },
    stdin_runner: {
      id: "stdin_runner",
      displayName: "Stdin Runner",
      enabled: true,
      detect: { command: "stdin-runner" },
      launch: {
        executable: "stdin-runner",
        baseArgs: ["run"],
        prompt: { kind: "stdin", closeAfterWrite: true },
        output: { kind: "stdout_text" },
        cwdPolicy: "workspace",
      },
      control: { interrupt: "process_group", steerRunning: false },
      capabilities: {
        supportsStreaming: false,
        supportsRunningSteer: false,
        supportsResume: false,
        supportsStructuredEvents: false,
        supportsWorktree: false,
        handlesOwnAuth: true,
      },
      defaults: {
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
        isolation: "shared",
      },
    },
    file_runner: {
      id: "file_runner",
      displayName: "File Runner",
      enabled: true,
      detect: { command: "file-runner" },
      launch: {
        executable: "file-runner",
        baseArgs: ["run"],
        prompt: { kind: "prompt_file", flag: "--prompt-file" },
        output: { kind: "stdout_text" },
        cwdPolicy: "workspace",
      },
      control: { interrupt: "process_group", steerRunning: false },
      capabilities: {
        supportsStreaming: false,
        supportsRunningSteer: false,
        supportsResume: false,
        supportsStructuredEvents: false,
        supportsWorktree: false,
        handlesOwnAuth: true,
      },
      defaults: {
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
        isolation: "shared",
      },
    },
    sdk_runner: {
      id: "sdk_runner",
      displayName: "SDK Runner",
      enabled: true,
      detect: { command: "sdk-runner" },
      launch: {
        executable: "sdk-runner",
        baseArgs: [],
        prompt: { kind: "sdk" },
        output: { kind: "transcript_file" },
        cwdPolicy: "workspace",
      },
      control: { interrupt: "api", steerRunning: true },
      capabilities: {
        supportsStreaming: true,
        supportsRunningSteer: true,
        supportsResume: true,
        supportsStructuredEvents: true,
        supportsWorktree: true,
        handlesOwnAuth: true,
      },
      defaults: {
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
        isolation: "shared",
      },
    },
    http_runner: {
      id: "http_runner",
      displayName: "HTTP Runner",
      enabled: true,
      detect: { command: "http-runner" },
      launch: {
        executable: "http-runner",
        baseArgs: [],
        prompt: { kind: "http" },
        output: { kind: "jsonl_events", finalEvent: "done" },
        cwdPolicy: "workspace",
      },
      control: { interrupt: "api", steerRunning: true },
      capabilities: {
        supportsStreaming: true,
        supportsRunningSteer: true,
        supportsResume: true,
        supportsStructuredEvents: true,
        supportsWorktree: true,
        handlesOwnAuth: true,
      },
      defaults: {
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
        isolation: "shared",
      },
    },
  };

  assert.deepEqual(
    buildAgentLaunchPlan(
      {
        runtime: "flagger",
        task: sampleTask,
        cwd: sampleCwd,
      },
      registry,
    ).args,
    ["run", "--task", sampleTask],
  );

  const stdinPlan = buildAgentLaunchPlan(
    {
      runtime: "stdin_runner",
      task: sampleTask,
      cwd: sampleCwd,
    },
    registry,
  );
  assert.deepEqual(stdinPlan.args, ["run"]);
  assert.deepEqual(stdinPlan.stdin, { input: sampleTask, closeAfterWrite: true });

  assert.deepEqual(
    buildAgentLaunchPlan(
      {
        runtime: "file_runner",
        task: sampleTask,
        cwd: sampleCwd,
        promptFilePath: "/tmp/task.txt",
      },
      registry,
    ).args,
    ["run", "--prompt-file", "/tmp/task.txt"],
  );

  const sdkPlan = buildAgentLaunchPlan(
    {
      runtime: "sdk_runner",
      task: sampleTask,
      cwd: sampleCwd,
    },
    registry,
  );
  assert.deepEqual(sdkPlan.args, []);
  assert.equal(sdkPlan.taskForSdkOrHttp, sampleTask);

  const httpPlan = buildAgentLaunchPlan(
    {
      runtime: "http_runner",
      task: sampleTask,
      cwd: sampleCwd,
    },
    registry,
  );
  assert.deepEqual(httpPlan.args, []);
  assert.equal(httpPlan.taskForSdkOrHttp, sampleTask);
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
