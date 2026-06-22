import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { launchTask } from "@backnotprop/orchestrator-core/tasks";
import {
  assertOneJsonLine,
  cliPath,
  PACKAGE_CLI_TIMEOUT_MS,
  runCli,
  shellPlan,
  withTempWorkspace,
} from "./cli-support.ts";

const execFileAsync = promisify(execFile);

test("CLI --json errors are machine-readable", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const command = "printf done";
    await launchTask({
      workspaceRoot,
      taskId: "json-error-alpha-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "json error alpha",
      allowedShellCommands: [command],
    });
    await launchTask({
      workspaceRoot,
      taskId: "json-error-beta-00000001",
      plan: shellPlan(command, workspaceRoot),
      name: "json error beta",
      allowedShellCommands: [command],
    });

    try {
      await runCli(workspaceRoot, ["--json", "missing-command"]);
      assert.fail("Expected unknown command --json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        schemaVersion: number;
        error: { name: string; message: string; reason?: string; input?: string; hint?: string };
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.error.name, "CliError");
      assert.equal(parsed.error.reason, "unknown_command");
      assert.equal(parsed.error.input, "missing-command");
      assert.equal(parsed.error.message, 'Unknown command "missing-command".');
      assert.doesNotMatch(parsed.error.message, /Usage:/);
      assert.match(parsed.error.hint ?? "", /commands\[\]\.name/);
    }

    try {
      await runCli(workspaceRoot, ["ps", "--workspace", workspaceRoot, "--bogus", "--json"]);
      assert.fail("Expected unknown ps option --json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        schemaVersion: number;
        error: { name: string; message: string; reason?: string; input?: string; hint?: string };
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.error.name, "CliError");
      assert.equal(parsed.error.reason, "unknown_option");
      assert.equal(parsed.error.input, "--bogus");
      assert.match(parsed.error.hint ?? "", /command "ps"/);
    }

    try {
      await runCli(workspaceRoot, ["read", "json-error", "--workspace", workspaceRoot, "--json"]);
      assert.fail("Expected ambiguous read --json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        schemaVersion: number;
        error: {
          name: string;
          message: string;
          reason?: string;
          input?: string;
          matches?: string[];
          hint?: string;
        };
        recovery?: {
          views: {
            active: { args: string[] };
            recent: { args: string[] };
            all: { args: string[] };
          };
        };
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.error.name, "TaskLookupError");
      assert.equal(parsed.error.reason, "ambiguous");
      assert.equal(parsed.error.input, "json-error");
      assert.deepEqual(parsed.error.matches, [
        "json-error-alpha-00000001",
        "json-error-beta-00000001",
      ]);
      assert.match(parsed.error.message, /ambiguous/);
      assert.match(parsed.error.hint ?? "", /ps --json --compact --brief/);
      assert.match(parsed.error.hint ?? "", /ps --json --compact --active/);
      assert.match(parsed.error.hint ?? "", /ps --all --json --compact/);
      assert.deepEqual(parsed.recovery?.views.recent.args, [
        "ps",
        "--json",
        "--compact",
        "--brief",
        "--workspace",
        workspaceRoot,
      ]);
      assert.deepEqual(parsed.recovery?.views.active.args, [
        "ps",
        "--json",
        "--compact",
        "--active",
        "--brief",
        "--workspace",
        workspaceRoot,
      ]);
      assert.deepEqual(parsed.recovery?.views.all.args, [
        "ps",
        "--all",
        "--json",
        "--compact",
        "--brief",
        "--workspace",
        workspaceRoot,
      ]);

      const recovery = await execFileAsync(
        process.execPath,
        ["--experimental-strip-types", cliPath, ...(parsed.recovery?.views.recent.args ?? [])],
        {
          cwd: "/tmp",
          timeout: PACKAGE_CLI_TIMEOUT_MS,
          env: {
            ...process.env,
            HOME: workspaceRoot,
            XDG_CONFIG_HOME: `${workspaceRoot}/.config`,
          },
        },
      );
      assertOneJsonLine(recovery.stdout.toString());
      const recovered = JSON.parse(recovery.stdout.toString()) as {
        tasks: Array<{ taskId: string }>;
      };
      assert.deepEqual(recovered.tasks.map((task) => task.taskId).sort(), [
        "json-error-alpha-00000001",
        "json-error-beta-00000001",
      ]);
    }

    try {
      await runCli(workspaceRoot, [
        "interrupt",
        "missing-task",
        "--workspace",
        workspaceRoot,
        "--json",
      ]);
      assert.fail("Expected missing interrupt --json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        schemaVersion: number;
        error: { name: string; message: string; reason?: string; input?: string; hint?: string };
        recovery?: { views: { recent: { args: string[] } } };
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.error.name, "TaskLookupError");
      assert.equal(parsed.error.reason, "not_found");
      assert.equal(parsed.error.input, "missing-task");
      assert.match(parsed.error.message, /did not match/);
      assert.match(parsed.error.hint ?? "", /ps --json --compact --brief/);
      assert.match(parsed.error.hint ?? "", /ps --json --compact --active/);
      assert.match(parsed.error.hint ?? "", /ps --all --json --compact/);
      assert.deepEqual(parsed.recovery?.views.recent.args, [
        "ps",
        "--json",
        "--compact",
        "--brief",
        "--workspace",
        workspaceRoot,
      ]);
    }

    try {
      await runCli(workspaceRoot, ["read", "--workspace", workspaceRoot, "--json"]);
      assert.fail("Expected missing read task id --json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        schemaVersion: number;
        error: { name: string; message: string; reason?: string; input?: string; hint?: string };
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.error.name, "CliError");
      assert.equal(parsed.error.reason, "missing_required_argument");
      assert.equal(parsed.error.input, "task-id");
      assert.match(parsed.error.message, /read requires a task id/);
      assert.match(parsed.error.hint ?? "", /ps --json --compact --active/);
    }

    try {
      await runCli(workspaceRoot, ["logs", "one", "two", "--workspace", workspaceRoot, "--json"]);
      assert.fail("Expected duplicate logs task id --json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        schemaVersion: number;
        error: { name: string; message: string; reason?: string; input?: string; hint?: string };
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.error.name, "CliError");
      assert.equal(parsed.error.reason, "too_many_arguments");
      assert.equal(parsed.error.input, "task-id");
      assert.match(parsed.error.message, /logs accepts exactly one task id/);
      assert.match(parsed.error.hint ?? "", /exactly one task id/);
    }

    try {
      await runCli(workspaceRoot, [
        "interrupt",
        "one",
        "--parent",
        "two",
        "--workspace",
        workspaceRoot,
        "--json",
      ]);
      assert.fail("Expected mixed interrupt selectors --json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        schemaVersion: number;
        error: { name: string; message: string; reason?: string; input?: string; hint?: string };
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.error.name, "CliError");
      assert.equal(parsed.error.reason, "incompatible_options");
      assert.equal(parsed.error.input, "task-id,--parent");
      assert.match(parsed.error.message, /exactly one selector/);
      assert.match(parsed.error.hint ?? "", /Use one form/);
    }

    try {
      await runCli(workspaceRoot, [
        "interrupt",
        "--active",
        "--children",
        "--workspace",
        workspaceRoot,
        "--json",
      ]);
      assert.fail("Expected incompatible interrupt flags --json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        schemaVersion: number;
        error: { name: string; message: string; reason?: string; input?: string; hint?: string };
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.error.name, "CliError");
      assert.equal(parsed.error.reason, "incompatible_options");
      assert.equal(parsed.error.input, "--active,--children|--task-only");
      assert.match(parsed.error.message, /cannot be combined/);
      assert.match(parsed.error.hint ?? "", /interrupt --active/);
    }

    try {
      await runCli(workspaceRoot, [
        "launch",
        "missing-runtime",
        "--workspace",
        workspaceRoot,
        "--json",
        "--compact",
        "do the work",
      ]);
      assert.fail("Expected missing runtime launch --json to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        schemaVersion: number;
        error: { name: string; reason?: string; input?: string; hint?: string };
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.error.name, "LaunchPlanError");
      assert.equal(parsed.error.reason, "unknown_runtime");
      assert.equal(parsed.error.input, "missing-runtime");
      assert.match(parsed.error.hint ?? "", /help --json --compact/);
    }

    try {
      await runCli(workspaceRoot, [
        "launch",
        "shell",
        "--workspace",
        workspaceRoot,
        "--allow-disabled-runtime",
        "--json",
        "--compact",
        "printf hi",
      ]);
      assert.fail("Expected shell launch without allowlisted command to fail.");
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const parsed = JSON.parse(stderr) as {
        schemaVersion: number;
        error: { name: string; reason?: string; input?: string; hint?: string };
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.error.name, "TaskSupervisorSafetyError");
      assert.equal(parsed.error.reason, "shell_command_not_allowlisted");
      assert.equal(parsed.error.input, "printf hi");
      assert.match(parsed.error.hint ?? "", /--allow-shell-command/);
    }

    await withTempWorkspace(async (badConfigRoot) => {
      const badConfigPath = `${badConfigRoot}/orchestrator.config.json`;
      await writeFile(badConfigPath, '{"agents":');
      try {
        await runCli(badConfigRoot, ["help", "--workspace", badConfigRoot, "--json"]);
        assert.fail("Expected invalid config help --json to fail.");
      } catch (error) {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          schemaVersion: number;
          error: { name: string; reason?: string; input?: string; hint?: string };
        };
        assert.equal(parsed.schemaVersion, 1);
        assert.equal(parsed.error.name, "OrchestratorConfigError");
        assert.equal(parsed.error.reason, "invalid_config_json");
        assert.equal(parsed.error.input, badConfigPath);
        assert.match(parsed.error.hint ?? "", /Fix the JSON syntax/);
      }
    }, "orchestrator-cli-json-errors-config-");

    await withTempWorkspace(async (badAdapterRoot) => {
      await writeFile(
        `${badAdapterRoot}/orchestrator.config.json`,
        JSON.stringify({
          agents: {
            remote: {
              adapter: "http",
              command: "agent-server",
              args: ["{prompt}"],
              output: "text",
            },
          },
        }),
      );
      try {
        await runCli(badAdapterRoot, ["doctor", "--workspace", badAdapterRoot, "--json"]);
        assert.fail("Expected unsupported adapter doctor --json to fail.");
      } catch (error) {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          schemaVersion: number;
          error: { name: string; reason?: string; input?: string; hint?: string };
        };
        assert.equal(parsed.schemaVersion, 1);
        assert.equal(parsed.error.name, "OrchestratorConfigError");
        assert.equal(parsed.error.reason, "unsupported_agent_adapter");
        assert.equal(parsed.error.input, "agents.remote.adapter");
        assert.match(parsed.error.hint ?? "", /"adapter": "process"/);
      }
    }, "orchestrator-cli-json-errors-config-adapter-");

    await withTempWorkspace(async (badOutputRoot) => {
      await writeFile(
        `${badOutputRoot}/orchestrator.config.json`,
        JSON.stringify({
          agents: {
            reviewer: {
              adapter: "process",
              command: "reviewer-agent",
              args: ["{prompt}"],
              output: { mode: "text" },
            },
          },
        }),
      );
      try {
        await runCli(badOutputRoot, ["doctor", "--workspace", badOutputRoot, "--json"]);
        assert.fail("Expected invalid output config doctor --json to fail.");
      } catch (error) {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          schemaVersion: number;
          error: { name: string; reason?: string; input?: string; hint?: string };
        };
        assert.equal(parsed.schemaVersion, 1);
        assert.equal(parsed.error.name, "OrchestratorConfigError");
        assert.equal(parsed.error.reason, "invalid_config_schema");
        assert.equal(parsed.error.input, "agents.reviewer.output.format");
        assert.match(parsed.error.hint ?? "", /"output": "text"/);
      }
    }, "orchestrator-cli-json-errors-config-output-");
  }, "orchestrator-cli-json-errors-");
});
