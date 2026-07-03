import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { AGENT_CONTROL_PREVIEW_MAX_BYTES } from "@backnotprop/orchestrator-core";
import {
  assertOneJsonLine,
  cliPath,
  PACKAGE_CLI_TIMEOUT_MS,
  repoRoot,
  runCli,
  withTempWorkspace,
} from "./cli-support.ts";

const execFileAsync = promisify(execFile);
const hostCorepackHome =
  process.env.COREPACK_HOME ??
  (process.env.HOME ? `${process.env.HOME}/.cache/node/corepack` : undefined);

function isolatedCliEnv(workspaceRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(hostCorepackHome ? { COREPACK_HOME: hostCorepackHome } : {}),
    HOME: workspaceRoot,
    XDG_CONFIG_HOME: `${workspaceRoot}/.config`,
  };
}

test("workspace CLI bin invokes the packaged entrypoint", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const result = await execFileAsync(
      "pnpm",
      ["exec", "orchestrator", "list", "--workspace", workspaceRoot],
      {
        cwd: repoRoot,
        timeout: PACKAGE_CLI_TIMEOUT_MS,
        env: isolatedCliEnv(workspaceRoot),
      },
    );

    assert.equal(result.stdout.toString(), "No tasks.\n");
  }, "orchestrator-cli-bin-");
});

test("CLI accepts common options before commands and portable args can override them", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const emptyList = await runCli(workspaceRoot, ["--workspace", workspaceRoot, "list", "--json"]);
    assert.deepEqual(JSON.parse(emptyList.stdout), []);
    const help = await runCli(workspaceRoot, [
      "--workspace",
      workspaceRoot,
      "--orchestrator-dir",
      `${workspaceRoot}/.custom-orchestrator`,
      "help",
      "--json",
    ]);
    assert.equal(JSON.parse(help.stdout).schemaVersion, 1);
    const doctor = await runCli(workspaceRoot, ["--workspace", workspaceRoot, "--json", "doctor"]);
    assert.equal(JSON.parse(doctor.stdout).status, "warning");
    const emptyPs = await runCli(workspaceRoot, [
      "--json",
      "--workspace",
      workspaceRoot,
      "ps",
      "--compact",
      "--active",
    ]);
    assert.deepEqual(JSON.parse(emptyPs.stdout).summary, {
      tasks: 0,
      active: 0,
      done: 0,
      failed: 0,
      stopped: 0,
      timedOut: 0,
    });

    const command = "node -e \"setTimeout(() => console.log('leading-common-options'), 300)\"";
    const launch = await runCli(workspaceRoot, [
      "--workspace",
      `${workspaceRoot}/wrong-workspace`,
      "launch",
      "shell",
      "--json",
      "--compact",
      "--name",
      "leading options",
      command,
      "--workspace",
      workspaceRoot,
    ]);
    const launched = JSON.parse(launch.stdout) as {
      commands: { wait: { args: string[] } };
    };

    const read = await runCli(
      workspaceRoot,
      ["--workspace", `${workspaceRoot}/wrong-workspace`, ...launched.commands.wait.args],
      10_000,
    );
    const parsedRead = JSON.parse(read.stdout) as { output: string };
    assert.equal(parsedRead.output, "leading-common-options\n");
  }, "orchestrator-cli-leading-common-options-");
});

test("CLI help teaches agents the job-control contract", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const result = await execFileAsync(
      "pnpm",
      ["exec", "orchestrator", "--help", "--workspace", workspaceRoot],
      {
        cwd: repoRoot,
        timeout: PACKAGE_CLI_TIMEOUT_MS,
        env: isolatedCliEnv(workspaceRoot),
      },
    );

    assert.match(result.stdout.toString(), /Agent instructions:/);
    assert.match(result.stdout.toString(), /orchestrator doctor/);
    assert.match(
      result.stdout.toString(),
      /orchestrator doctor \[--agent-dir <path>\] \[--session-dir <path>\] \[--json \[--compact\]\]/,
    );
    assert.match(
      result.stdout.toString(),
      /orchestrator launch -f <manifest\.json\|-> --json \[--compact \[--brief\]\]/,
    );
    assert.match(result.stdout.toString(), /doctor --json --compact/);
    assert.match(result.stdout.toString(), /orchestrator ps/);
    assert.match(
      result.stdout.toString(),
      /orchestrator run "figure out what needs to change in this repo"/,
    );
    assert.match(result.stdout.toString(), /orchestrator run --background --name "repo plan"/);
    assert.match(
      result.stdout.toString(),
      /orchestrator run --trace-tools "launch a codex child and wait for it"/,
    );
    assert.match(
      result.stdout.toString(),
      /orchestrator run --stream-json "launch a codex child and wait for it"/,
    );
    assert.match(result.stdout.toString(), /--trace-tools\[=text\|jsonl\]/);
    assert.match(result.stdout.toString(), /--stream-json/);
    assert.match(result.stdout.toString(), /--background/);
    assert.match(result.stdout.toString(), /--compact/);
    assert.match(result.stdout.toString(), /--active/);
    assert.match(result.stdout.toString(), /interrupt --active/);
    assert.match(
      result.stdout.toString(),
      /Prefer launch --json --compact and ps --json --compact/,
    );
    assert.match(result.stdout.toString(), /Use runtime shell for exact local shell commands/);
    assert.match(result.stdout.toString(), /Use runtime codex or claude-code for AI work/);
    assert.match(
      result.stdout.toString(),
      /Do not launch Codex or Claude just to run a deterministic shell command/,
    );
    assert.match(result.stdout.toString(), /launch -f <manifest\.json\|->/);
    assert.match(result.stdout.toString(), /Common options like --workspace/);
    assert.match(result.stdout.toString(), /commands\.\*\.args/);
    assert.match(result.stdout.toString(), /orchestrator ps --all --json --compact/);
    assert.match(
      result.stdout.toString(),
      /orchestrator list \[--status <status>\] \[-A\|--all-workspaces\] \[--json\]/,
    );
    assert.match(
      result.stdout.toString(),
      /orchestrator logs <task-id\|prefix> .* \[--json \[--compact\]\]/,
    );
    assert.match(
      result.stdout.toString(),
      /orchestrator events <task-id\|prefix> .* \[--json \[--compact\]\]/,
    );
    assert.match(result.stdout.toString(), /orchestrator help \[--json \[--compact\]\]/);
    assert.match(result.stdout.toString(), /help --json --compact/);
    assert.match(
      result.stdout.toString(),
      /orchestrator launch claude-code --name "review repo" --model sonnet/,
    );
    assert.match(
      result.stdout.toString(),
      /orchestrator launch codex --name "write tests" --model gpt-5\.4-mini/,
    );
    assert.match(
      result.stdout.toString(),
      /orchestrator logs <task-id\|prefix> --stream stderr --follow/,
    );
    assert.match(result.stdout.toString(), /Use read for final agent answers/);
    assert.match(result.stdout.toString(), /read <id> <id> --wait --json --compact/);
    assert.match(result.stdout.toString(), /Runtime ids:/);
  }, "orchestrator-cli-help-");
});

test("CLI JSON help exposes a machine-readable agent contract", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const result = await execFileAsync(
      "pnpm",
      ["exec", "orchestrator", "help", "--workspace", workspaceRoot, "--json"],
      {
        cwd: repoRoot,
        timeout: PACKAGE_CLI_TIMEOUT_MS,
        env: isolatedCliEnv(workspaceRoot),
      },
    );
    const help = JSON.parse(result.stdout.toString()) as {
      schemaVersion: number;
      agentInstructions: string[];
      runtimes: { id: string; modelFlag?: string }[];
      commands: { name: string; semantics: string; usage: string; options: string[] }[];
      examples: string[];
      workflows: { name: string; steps: string[] }[];
    };

    assert.equal(help.schemaVersion, 1);
    assert.ok(
      help.agentInstructions.some((instruction) => instruction.includes("doctor --json --compact")),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) => instruction.includes("parent.run") && instruction.includes("argsPrefix"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("parent.canRun") && instruction.includes("parent.run"),
      ),
    );
    assert.ok(help.agentInstructions.some((instruction) => instruction.includes("Use run")));
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes('runtime "shell"') &&
          instruction.includes("exact local shell commands"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes('runtime "codex"') &&
          instruction.includes('"claude-code"') &&
          instruction.includes("AI work"),
      ),
    );
    assert.ok(
      help.agentInstructions.some((instruction) =>
        instruction.includes(
          "Do not launch Codex or Claude just to run a deterministic shell command",
        ),
      ),
    );
    assert.ok(help.agentInstructions.some((instruction) => instruction.includes("--background")));
    assert.ok(help.agentInstructions.some((instruction) => instruction.includes("--trace-tools")));
    assert.ok(help.agentInstructions.some((instruction) => instruction.includes("--stream-json")));
    assert.ok(help.agentInstructions.some((instruction) => instruction.includes("--compact")));
    assert.ok(help.agentInstructions.some((instruction) => instruction.includes("Capture taskId")));
    assert.ok(
      help.agentInstructions.some((instruction) => instruction.includes("help --json --compact")),
    );
    assert.ok(
      help.agentInstructions.some((instruction) =>
        instruction.includes("runtimeSummary.availableIds"),
      ),
    );
    assert.ok(
      help.agentInstructions.some((instruction) => instruction.includes("recovery.views.*.args")),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("launch --json --compact") &&
          instruction.includes("ps --json --compact"),
      ),
    );
    assert.ok(
      help.agentInstructions.some((instruction) =>
        instruction.includes("ps --json --compact --active --brief"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("ps --parent <run-id|prefix> --json --compact --brief") &&
          instruction.includes("parent run"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("active ps is empty") && instruction.includes("views.recent.args"),
      ),
    );
    assert.ok(
      help.agentInstructions.some((instruction) =>
        instruction.includes("launch --json --compact --brief"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("launch -f <manifest.json|->") && instruction.includes("one call"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("Common options") && instruction.includes("--workspace"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("read <id> <id> --wait --json --compact") &&
          instruction.includes("multi-task wait call"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("active: true") && instruction.includes("commands.waitPreview.args"),
      ),
    );
    assert.ok(
      help.agentInstructions.some((instruction) =>
        instruction.includes("compact ps top-level commands.waitPreview.args"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("After starting several tasks") &&
          instruction.includes("commands.waitPreview.args"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("returned args") &&
          instruction.includes("argument vector") &&
          instruction.includes("shell string"),
      ),
    );
    assert.ok(
      help.agentInstructions.some((instruction) =>
        instruction.includes("compact ps group commands.waitPreview.args"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("compact batch read times out") &&
          instruction.includes("stop.args") &&
          instruction.includes("still-active work safely"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("compact read returns failed status") &&
          instruction.includes("commands.logsPreview.args") &&
          instruction.includes("commands.events.args"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("compact read is truncated by read limit") &&
          instruction.includes("commands.read.args"),
      ),
    );
    assert.ok(help.agentInstructions.some((instruction) => instruction.includes("Truncated")));
    assert.ok(
      help.agentInstructions.some((instruction) => instruction.includes("commands.*.args")),
    );
    assert.ok(
      help.agentInstructions.some((instruction) => instruction.includes("commands.readPreview")),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("stop.args") && instruction.includes("exactly the returned task"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("interrupt --active") &&
          instruction.includes("deliberate workspace cleanup"),
      ),
    );
    assert.ok(
      help.agentInstructions.some(
        (instruction) =>
          instruction.includes("interrupt -A --active --yes") &&
          instruction.includes("all-workspace cleanup"),
      ),
    );
    assert.ok(help.agentInstructions.some((instruction) => instruction.includes("JSON on stderr")));
    assert.ok(help.commands.some((command) => command.name === "doctor"));
    assert.ok(
      help.commands.some(
        (command) =>
          command.name === "doctor" &&
          command.usage.includes("[--compact]") &&
          command.options.includes("--compact"),
      ),
    );
    assert.ok(help.commands.some((command) => command.name === "run"));
    assert.ok(
      help.commands.some((command) => command.name === "run" && command.usage.includes("--brief")),
    );
    assert.ok(
      help.commands.some(
        (command) => command.name === "launch" && command.usage.includes("--brief"),
      ),
    );
    assert.ok(
      help.commands.some(
        (command) =>
          command.name === "launch" &&
          command.usage.includes("launch -f <manifest.json|->") &&
          command.options.includes("--file <manifest.json|->"),
      ),
    );
    assert.ok(help.commands.some((command) => command.name === "ps"));
    assert.ok(
      help.commands.some((command) => command.name === "ps" && command.usage.includes("--brief")),
    );
    assert.ok(
      help.commands.some(
        (command) =>
          command.name === "ps" &&
          command.usage.includes("-A|--all-workspaces") &&
          command.usage.includes("--cwd <path>") &&
          command.options.includes("-A") &&
          command.options.includes("--all-workspaces"),
      ),
    );
    assert.ok(
      help.commands.some(
        (command) =>
          command.name === "read" &&
          command.usage.includes("[--wait]") &&
          command.usage.includes("[--compact]"),
      ),
    );
    assert.ok(
      help.commands.some(
        (command) => command.name === "watch" && command.usage.includes("[--json]"),
      ),
    );
    assert.ok(
      help.commands.some(
        (command) =>
          command.name === "logs" &&
          command.usage.includes("[--json [--compact]]") &&
          command.usage.includes("[--follow]"),
      ),
    );
    assert.ok(
      help.commands.some(
        (command) => command.name === "events" && command.usage.includes("[--json [--compact]]"),
      ),
    );
    assert.ok(help.runtimes.some((runtime) => runtime.id === "claude-code" && runtime.modelFlag));
    assert.ok(help.runtimes.some((runtime) => runtime.id === "codex" && runtime.modelFlag));
    assert.ok(help.commands.some((command) => command.name === "watch"));
    assert.ok(help.commands.some((command) => command.name === "logs"));
    assert.ok(
      help.commands.some(
        (command) =>
          command.name === "help" &&
          command.usage.includes("[--compact]") &&
          command.semantics.includes("compact JSON contract"),
      ),
    );
    assert.ok(help.examples.some((example) => example === "orchestrator doctor"));
    assert.ok(help.examples.some((example) => example === "orchestrator doctor --json --compact"));
    assert.ok(help.examples.some((example) => example === "orchestrator help --json --compact"));
    assert.ok(
      help.examples.some(
        (example) => example === "orchestrator launch -f agents.json --json --compact --brief",
      ),
    );
    assert.ok(help.examples.some((example) => example === "orchestrator ps"));
    assert.ok(
      help.examples.some((example) => example === "orchestrator ps --all --json --compact"),
    );
    assert.ok(help.examples.some((example) => example === "orchestrator ps -A"));
    assert.ok(help.examples.some((example) => example === "orchestrator ps -A --all"));
    assert.ok(
      help.examples.some(
        (example) => example === "orchestrator ps -A --json --compact --active --brief",
      ),
    );
    assert.ok(help.examples.some((example) => example === "orchestrator ps --watch"));
    assert.ok(
      help.examples.some((example) => example === "orchestrator ps --json --compact --active"),
    );
    assert.ok(
      help.examples.some(
        (example) => example === "orchestrator ps --json --compact --active --brief",
      ),
    );
    assert.ok(
      help.examples.some(
        (example) =>
          example ===
          'orchestrator interrupt --active --json --compact --reason "workspace cleanup"',
      ),
    );
    assert.ok(
      help.examples.some(
        (example) =>
          example ===
          'orchestrator interrupt -A --active --yes --json --compact --reason "all-workspace cleanup"',
      ),
    );
    assert.ok(!help.examples.some((example) => example === "orchestrator list --json"));
    assert.ok(
      help.examples.some(
        (example) => example === "orchestrator read <task-id|prefix>... --wait --json --compact",
      ),
    );
    assert.ok(
      help.examples.some(
        (example) => example === "orchestrator watch <task-id|prefix> --agent-only --json",
      ),
    );
    assert.ok(help.examples.some((example) => example.startsWith("orchestrator run")));
    assert.ok(help.examples.some((example) => example.includes("--background")));
    assert.ok(help.examples.some((example) => example.includes("--trace-tools")));
    assert.ok(help.examples.some((example) => example.includes("--stream-json")));
    assert.ok(help.examples.some((example) => example.includes("--name")));
    assert.ok(help.examples.some((example) => example.includes("--json --compact")));
    assert.ok(help.examples.some((example) => example.includes("--follow")));
    assert.ok(
      help.workflows.some(
        (workflow) =>
          workflow.name === "discover-contract" &&
          workflow.steps.some((step) => step.includes("help --json --compact")),
      ),
    );
    assert.ok(help.workflows.some((workflow) => workflow.name === "parent-agent"));
    assert.ok(help.workflows.some((workflow) => workflow.name === "start-and-watch"));
    assert.ok(
      help.workflows.some(
        (workflow) =>
          workflow.name === "start-and-watch" &&
          workflow.steps.some((step) => step.includes("Add --brief to compact launch")),
      ),
    );
    assert.ok(
      help.workflows.some(
        (workflow) =>
          workflow.name === "start-and-watch" &&
          workflow.steps.some((step) => step.includes("launch -f <manifest.json|->")),
      ),
    );
    assert.ok(
      help.workflows.some(
        (workflow) =>
          workflow.name === "debug-agent-output" &&
          workflow.steps.some((step) => step.includes("do not combine --follow with --json")),
      ),
    );

    const implicitHelp = await runCli(workspaceRoot, ["--json"]);
    const implicitHelpDocument = JSON.parse(implicitHelp.stdout) as { schemaVersion: number };
    assert.equal(implicitHelpDocument.schemaVersion, 1);
  }, "orchestrator-cli-json-help-");
});

test("CLI compact JSON help exposes a small agent command contract", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await writeFile(
      `${workspaceRoot}/orchestrator.config.json`,
      JSON.stringify(
        {
          agents: {
            codex: { enabled: false },
            "scratch-agent": {
              adapter: "process",
              command: "node",
              args: ["-e", "console.log(process.argv.slice(1).join(' '))", "{prompt}"],
              enabled: true,
            },
          },
        },
        null,
        2,
      ),
    );

    const result = await execFileAsync(
      "pnpm",
      ["exec", "orchestrator", "help", "--workspace", workspaceRoot, "--json", "--compact"],
      {
        cwd: repoRoot,
        timeout: PACKAGE_CLI_TIMEOUT_MS,
        env: isolatedCliEnv(workspaceRoot),
      },
    );
    assertOneJsonLine(result.stdout.toString());

    const help = JSON.parse(result.stdout.toString()) as {
      schemaVersion: number;
      purpose: string;
      fullHelp: { args: string[] };
      agentQuickStart: string[];
      canLaunchChildAgents: boolean;
      runtimeIds: string[];
      runtimes: { id: string; modelFlag?: string }[];
      commands: { name: string; usage: string; semantics: string; options?: unknown }[];
      examples: string[];
      workflows?: unknown;
      agentInstructions?: unknown;
    };

    assert.equal(help.schemaVersion, 1);
    assert.deepEqual(help.fullHelp.args, ["help", "--json", "--workspace", workspaceRoot]);
    assert.equal(help.canLaunchChildAgents, true);
    assert.ok(help.runtimeIds.includes("claude-code"));
    assert.ok(!help.runtimeIds.includes("codex"));
    assert.ok(help.runtimeIds.includes("scratch-agent"));
    assert.ok(help.commands.some((command) => command.name === "launch"));
    assert.ok(help.commands.some((command) => command.name === "help"));
    assert.ok(help.commands.every((command) => command.options === undefined));
    assert.ok(help.agentQuickStart.some((step) => step.includes("launch -f <manifest.json|->")));
    assert.ok(
      help.agentQuickStart.some(
        (step) =>
          step.includes('runtime "shell"') &&
          step.includes('runtime "claude-code"') &&
          !step.includes('"codex"'),
      ),
    );
    assert.ok(
      help.agentQuickStart.some((step) =>
        step.includes("Do not launch Codex or Claude just to run a deterministic shell command"),
      ),
    );
    assert.ok(help.agentQuickStart.some((step) => step.includes("commands.waitPreview.args")));
    assert.ok(
      help.agentQuickStart.some(
        (step) =>
          step.includes("returned args") &&
          step.includes("argument vectors") &&
          step.includes("shell string"),
      ),
    );
    assert.ok(
      help.agentQuickStart.some(
        (step) =>
          step.includes("failed reads") &&
          step.includes("commands.logsPreview.args") &&
          step.includes("commands.events.args"),
      ),
    );
    assert.ok(
      help.agentQuickStart.some(
        (step) =>
          step.includes("ps --parent <run-id|prefix> --json --compact --brief") &&
          step.includes("parent run"),
      ),
    );
    assert.ok(
      help.agentQuickStart.some(
        (step) => step.includes("stop.args") && step.includes("compact ps or read output"),
      ),
    );
    assert.ok(help.examples.some((example) => example === "orchestrator doctor"));
    assert.ok(
      help.examples.some(
        (example) => example === "orchestrator ps --json --compact --active --brief",
      ),
    );
    assert.ok(
      help.examples.some(
        (example) =>
          example === "orchestrator ps --parent <run-id|prefix> --json --compact --brief",
      ),
    );
    assert.ok(
      help.examples.some(
        (example) =>
          example ===
          'orchestrator interrupt <task-id|prefix> <task-id|prefix> --json --compact --reason "selected cleanup"',
      ),
    );
    assert.ok(
      !help.examples.some(
        (example) =>
          example === 'orchestrator interrupt --active --json --compact --reason "cleanup"',
      ),
    );
    assert.equal(help.workflows, undefined);
    assert.equal(help.agentInstructions, undefined);

    const full = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", cliPath, ...help.fullHelp.args],
      {
        cwd: "/tmp",
        timeout: PACKAGE_CLI_TIMEOUT_MS,
        env: isolatedCliEnv(workspaceRoot),
      },
    );
    const fullHelp = JSON.parse(full.stdout) as { runtimes: { id: string }[] };
    assert.ok(fullHelp.runtimes.some((runtime) => runtime.id === "scratch-agent"));
    assert.ok(!fullHelp.runtimes.some((runtime) => runtime.id === "codex"));
    assert.ok(result.stdout.length < full.stdout.length);

    await assert.rejects(
      runCli(workspaceRoot, ["help", "--workspace", workspaceRoot, "--compact"]),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /help --compact requires --json/);
        assert.match(error.message, /Use help --json --compact/);
        return true;
      },
    );
  }, "orchestrator-cli-help-compact-");
});

test("CLI doctor reports parent-agent config paths", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const doctor = await runCli(workspaceRoot, ["doctor", "--json"]);
    const report = JSON.parse(doctor.stdout) as {
      status: string;
      canRunParentAgent: boolean;
      authPath: string;
      modelsPath: string;
      sessionDir: string;
      checks: { id: string; status: string }[];
      suggestions: string[];
    };

    assert.equal(report.status, "warning");
    assert.equal(report.canRunParentAgent, false);
    assert.match(report.authPath, /\.orchestrator\/auth\.json$/);
    assert.match(report.modelsPath, /\.orchestrator\/models\.json$/);
    assert.match(report.sessionDir, /\.orchestrator\/sessions$/);
    assert.ok(report.checks.some((check) => check.id === "auth-json"));
    assert.ok(report.suggestions.some((suggestion) => suggestion.includes("auth.json")));
  }, "orchestrator-cli-doctor-");
});

test("CLI doctor reports configured runtime availability", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const executablePath = `${workspaceRoot}/mail-agent`;
    await writeFile(
      executablePath,
      "#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join(' '));\n",
      { mode: 0o755 },
    );
    await writeFile(
      `${workspaceRoot}/orchestrator.config.json`,
      JSON.stringify({
        agents: {
          mail: {
            adapter: "process",
            command: executablePath,
            args: ["{prompt}"],
            output: "text",
          },
          missing: {
            adapter: "process",
            command: "definitely-missing-orchestrator-runtime",
            args: ["{prompt}"],
            output: "text",
          },
        },
      }),
    );

    const doctor = await runCli(workspaceRoot, ["doctor", "--json"]);
    const report = JSON.parse(doctor.stdout) as {
      runtimeSummary: {
        total: number;
        available: number;
        unavailable: number;
        availableIds: string[];
        unavailableIds: string[];
      };
      runtimes: Array<{
        id: string;
        executable: string;
        available: boolean;
        path?: string;
        message: string;
      }>;
    };

    const mail = report.runtimes.find((runtime) => runtime.id === "mail");
    const missing = report.runtimes.find((runtime) => runtime.id === "missing");

    assert.equal(report.runtimeSummary.total, report.runtimes.length);
    assert.ok(report.runtimeSummary.available >= 1);
    assert.equal(report.runtimeSummary.unavailable, 1);
    assert.ok(report.runtimeSummary.availableIds.includes("mail"));
    assert.deepEqual(report.runtimeSummary.unavailableIds, ["missing"]);
    assert.equal(mail?.available, true);
    assert.equal(mail?.executable, executablePath);
    assert.equal(mail?.path, executablePath);
    assert.match(mail?.message ?? "", /Found/);
    assert.equal(missing?.available, false);
    assert.equal(missing?.executable, "definitely-missing-orchestrator-runtime");
    assert.equal(missing?.path, undefined);
    assert.match(missing?.message ?? "", /not found on PATH/);
  }, "orchestrator-cli-doctor-runtimes-");
});

test("CLI compact doctor reports small portable runtime readiness", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const executablePath = `${workspaceRoot}/mail-agent`;
    await writeFile(
      executablePath,
      "#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join(' '));\n",
      { mode: 0o755 },
    );
    await writeFile(
      `${workspaceRoot}/orchestrator.config.json`,
      JSON.stringify({
        agents: {
          mail: {
            adapter: "process",
            command: executablePath,
            args: ["{prompt}"],
            output: "text",
          },
          missing: {
            adapter: "process",
            command: "definitely-missing-orchestrator-runtime",
            args: ["{prompt}"],
            output: "text",
          },
        },
      }),
    );

    const doctor = await runCli(workspaceRoot, ["doctor", "--json", "--compact"]);
    assertOneJsonLine(doctor.stdout);
    const report = JSON.parse(doctor.stdout) as {
      schemaVersion: number;
      status: string;
      canRunParentAgent: boolean;
      canLaunchChildAgents: boolean;
      parent: {
        canRun: boolean;
        agentDir: string;
        sessionDir: string;
        run?: {
          source: string;
          requestPosition: string;
          argsPrefix: string[];
          backgroundArgsPrefix: string[];
        };
      };
      runtimeSummary: {
        total: number;
        available: number;
        unavailable: number;
        availableIds: string[];
        unavailableIds: string[];
      };
      runtimes: Array<{
        id: string;
        executable: string;
        available: boolean;
        path?: string;
        message: string;
      }>;
      fullDoctor: { args: string[] };
      checks?: unknown;
      suggestions?: unknown;
    };

    const mail = report.runtimes.find((runtime) => runtime.id === "mail");
    const missing = report.runtimes.find((runtime) => runtime.id === "missing");

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.status, "warning");
    assert.equal(report.canRunParentAgent, false);
    assert.equal(report.canLaunchChildAgents, true);
    assert.equal(report.parent.canRun, false);
    assert.match(report.parent.agentDir, /\.orchestrator$/);
    assert.match(report.parent.sessionDir, /\.orchestrator\/sessions$/);
    assert.equal(report.parent.run, undefined);
    assert.ok(report.runtimeSummary.availableIds.includes("mail"));
    assert.deepEqual(report.runtimeSummary.unavailableIds, ["missing"]);
    assert.equal(mail?.available, true);
    assert.equal(mail?.path, executablePath);
    assert.equal(missing?.available, false);
    assert.equal(missing?.path, undefined);
    assert.deepEqual(report.fullDoctor.args, ["doctor", "--json", "--workspace", workspaceRoot]);
    assert.equal(report.checks, undefined);
    assert.equal(report.suggestions, undefined);

    const full = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", cliPath, ...report.fullDoctor.args],
      {
        cwd: "/tmp",
        timeout: PACKAGE_CLI_TIMEOUT_MS,
        env: isolatedCliEnv(workspaceRoot),
      },
    );
    const fullReport = JSON.parse(full.stdout) as { runtimes: { id: string }[] };
    assert.ok(fullReport.runtimes.some((runtime) => runtime.id === "mail"));
    assert.ok(doctor.stdout.length < full.stdout.length);

    await assert.rejects(
      runCli(workspaceRoot, ["doctor", "--workspace", workspaceRoot, "--compact"]),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /doctor --compact requires --json/);
        assert.match(error.message, /Use doctor --json --compact/);
        return true;
      },
    );
  }, "orchestrator-cli-doctor-compact-");
});

test("CLI compact doctor exposes parent run prefixes for Pi fallback config", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await mkdir(`${workspaceRoot}/.pi/agent`, { recursive: true });

    const doctor = await runCli(workspaceRoot, ["doctor", "--json", "--compact"]);
    const report = JSON.parse(doctor.stdout) as {
      canRunParentAgent: boolean;
      parent: {
        canRun: boolean;
        piAgentDir?: string;
        run?: {
          source: string;
          requestPosition: string;
          argsPrefix: string[];
          backgroundArgsPrefix: string[];
        };
      };
    };

    assert.equal(report.canRunParentAgent, true);
    assert.equal(report.parent.canRun, true);
    assert.equal(report.parent.piAgentDir, `${workspaceRoot}/.pi/agent`);
    assert.deepEqual(report.parent.run, {
      source: "pi-fallback",
      requestPosition: "last",
      argsPrefix: [
        "run",
        "--workspace",
        workspaceRoot,
        "--agent-dir",
        `${workspaceRoot}/.pi/agent`,
      ],
      backgroundArgsPrefix: [
        "run",
        "--background",
        "--json",
        "--compact",
        "--workspace",
        workspaceRoot,
        "--agent-dir",
        `${workspaceRoot}/.pi/agent`,
      ],
    });
  }, "orchestrator-cli-doctor-pi-fallback-");
});

test("CLI compact config discovery preserves explicit config and portable follow-up commands", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const configPath = `${workspaceRoot}/explicit-orchestrator-config.json`;
    const agentDir = `${workspaceRoot}/parent-agent`;
    await mkdir(`${agentDir}/sessions`, { recursive: true });
    await writeFile(
      `${agentDir}/auth.json`,
      `${JSON.stringify({ openai: { type: "api_key", key: "test-key" } }, null, 2)}\n`,
    );
    await writeFile(`${agentDir}/models.json`, `${JSON.stringify({ providers: {} })}\n`);
    await writeFile(
      configPath,
      JSON.stringify(
        {
          agents: {
            "claude-code": { enabled: false },
            codex: { enabled: false },
            "codex-app-server": { enabled: false },
            pi: { enabled: false },
            "external-agent": {
              enabled: true,
              adapter: "process",
              command: "node",
              args: [
                "-e",
                "console.log('external:' + process.argv.slice(1).join(' '));",
                "{prompt}",
              ],
              output: "text",
            },
          },
        },
        null,
        2,
      ),
    );

    const help = await runCli(workspaceRoot, [
      "help",
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--json",
      "--compact",
    ]);
    assertOneJsonLine(help.stdout);
    const compactHelp = JSON.parse(help.stdout) as {
      canLaunchChildAgents: boolean;
      runtimeIds: string[];
      fullHelp: { args: string[] };
    };
    assert.equal(compactHelp.canLaunchChildAgents, true);
    assert.deepEqual([...compactHelp.runtimeIds].sort(), ["external-agent", "shell"]);
    assert.deepEqual(compactHelp.fullHelp.args, [
      "help",
      "--json",
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
    ]);

    const doctor = await runCli(workspaceRoot, [
      "doctor",
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--agent-dir",
      agentDir,
      "--json",
      "--compact",
    ]);
    assertOneJsonLine(doctor.stdout);
    const compactDoctor = JSON.parse(doctor.stdout) as {
      canRunParentAgent: boolean;
      canLaunchChildAgents: boolean;
      runtimeSummary: { availableIds: string[] };
      parent: {
        canRun: boolean;
        run?: { argsPrefix: string[]; backgroundArgsPrefix: string[] };
      };
      fullDoctor: { args: string[] };
    };
    assert.equal(compactDoctor.canRunParentAgent, true);
    assert.equal(compactDoctor.canLaunchChildAgents, true);
    assert.deepEqual([...compactDoctor.runtimeSummary.availableIds].sort(), [
      "external-agent",
      "shell",
    ]);
    assert.equal(compactDoctor.parent.canRun, true);
    assert.deepEqual(compactDoctor.parent.run?.argsPrefix, [
      "run",
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--agent-dir",
      agentDir,
    ]);
    assert.deepEqual(compactDoctor.parent.run?.backgroundArgsPrefix, [
      "run",
      "--background",
      "--json",
      "--compact",
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--agent-dir",
      agentDir,
    ]);
    assert.deepEqual(compactDoctor.fullDoctor.args, [
      "doctor",
      "--json",
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--agent-dir",
      agentDir,
    ]);

    const launch = await runCli(workspaceRoot, [
      "launch",
      "external-agent",
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--name",
      "external config",
      "--json",
      "--compact",
      "Use explicit config.",
    ]);
    assertOneJsonLine(launch.stdout);
    const launched = JSON.parse(launch.stdout) as {
      id: string;
      taskId: string;
      runtime: string;
      commands: {
        waitPreview: { args: string[] };
      };
    };
    assert.equal(launched.id, launched.taskId.slice(0, 8));
    assert.equal(launched.runtime, "external-agent");
    assert.deepEqual(launched.commands.waitPreview.args, [
      "read",
      launched.id,
      "--wait",
      "--timeout-ms",
      "300000",
      "--max-bytes",
      String(AGENT_CONTROL_PREVIEW_MAX_BYTES),
      "--json",
      "--compact",
    ]);

    const read = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", cliPath, ...launched.commands.waitPreview.args],
      {
        cwd: "/tmp",
        timeout: PACKAGE_CLI_TIMEOUT_MS,
        env: isolatedCliEnv(workspaceRoot),
      },
    );
    assertOneJsonLine(read.stdout.toString());
    const parsedRead = JSON.parse(read.stdout.toString()) as {
      id: string;
      taskId: string;
      retrievalStatus: string;
      status: string;
      output: string;
    };
    assert.equal(parsedRead.id, launched.id);
    assert.equal(parsedRead.taskId, launched.taskId);
    assert.equal(parsedRead.retrievalStatus, "completed");
    assert.equal(parsedRead.status, "succeeded");
    assert.equal(parsedRead.output, "external:Use explicit config.\n");
  }, "orchestrator-cli-explicit-config-compact-");
});
