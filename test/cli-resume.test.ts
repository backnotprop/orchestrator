import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { readTaskRecord, type AgentTaskRecord } from "@backnotprop/orchestrator-core/tasks";
import { runCli, withTempWorkspace } from "./cli-support.ts";

test("CLI resume creates a new Codex task from the stored thread id", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const env = await installFakeRuntime(workspaceRoot, "codex", fakeCodexScript());
    const sourceLaunch = await runCli(
      workspaceRoot,
      ["launch", "codex", "--workspace", workspaceRoot, "--wait", "--json", "first codex"],
      10_000,
      env,
    );
    const source = JSON.parse(sourceLaunch.stdout) as AgentTaskRecord;
    assert.equal(source.status, "succeeded");
    assert.deepEqual(source.provider, {
      provider: "codex",
      threadId: "thread-cli-codex",
    });

    const resumedLaunch = await runCli(
      workspaceRoot,
      [
        "resume",
        source.taskId.slice(0, 8),
        "--workspace",
        workspaceRoot,
        "--wait",
        "--json",
        "--model",
        "gpt-5.4-mini",
        "second codex",
      ],
      10_000,
      env,
    );
    const resumed = JSON.parse(resumedLaunch.stdout) as AgentTaskRecord;
    const stored = await readTaskRecord({ workspaceRoot }, resumed.taskId);

    assert.equal(resumed.status, "succeeded");
    assert.equal(resumed.runtime, "codex");
    assert.deepEqual(stored.provider, {
      provider: "codex",
      threadId: "thread-cli-codex",
    });
    assert.deepEqual(stored.resume, {
      fromTaskId: source.taskId,
      rootTaskId: source.taskId,
      attempt: 1,
    });
    assert.deepEqual(stored.launchPlan.args, [
      "exec",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.4-mini",
      "--json",
      "resume",
      "thread-cli-codex",
      "second codex",
    ]);

    const read = await runCli(workspaceRoot, [
      "read",
      resumed.taskId,
      "--workspace",
      workspaceRoot,
    ]);
    assert.equal(read.stdout.trim(), "codex resumed second codex");
  }, "orchestrator-cli-resume-codex-");
});

test("CLI resume rejects an active task on the same provider session", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const env = await installFakeRuntime(workspaceRoot, "codex", fakeCodexScript());
    const sourceLaunch = await runCli(
      workspaceRoot,
      ["launch", "codex", "--workspace", workspaceRoot, "--wait", "--json", "first codex"],
      10_000,
      env,
    );
    const source = JSON.parse(sourceLaunch.stdout) as AgentTaskRecord;
    const activeLaunch = await runCli(
      workspaceRoot,
      ["launch", "codex", "--workspace", workspaceRoot, "--json", "hold codex"],
      10_000,
      env,
    );
    const active = JSON.parse(activeLaunch.stdout) as AgentTaskRecord;

    try {
      await waitForProviderThread(workspaceRoot, active.taskId, "thread-cli-codex");
      await assert.rejects(
        runCli(
          workspaceRoot,
          [
            "resume",
            source.taskId.slice(0, 8),
            "--workspace",
            workspaceRoot,
            "--json",
            "second codex",
          ],
          10_000,
          env,
        ),
        (error: unknown) => {
          const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
          const parsed = JSON.parse(stderr) as {
            error: { reason?: string; input?: string; hint?: string };
          };
          assert.equal(parsed.error.reason, "resume_session_active");
          assert.equal(parsed.error.input, active.taskId);
          assert.match(parsed.error.hint ?? "", /active task/);
          return true;
        },
      );
    } finally {
      await runCli(
        workspaceRoot,
        ["interrupt", active.taskId, "--workspace", workspaceRoot, "--reason", "test cleanup"],
        10_000,
        env,
      ).catch(() => {});
    }
  }, "orchestrator-cli-resume-active-conflict-");
});

test("CLI resume creates a new Claude Code task from the stored session id", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const env = await installFakeRuntime(workspaceRoot, "claude", fakeClaudeScript());
    const sourceLaunch = await runCli(
      workspaceRoot,
      ["launch", "claude-code", "--workspace", workspaceRoot, "--wait", "--json", "first claude"],
      10_000,
      env,
    );
    const source = JSON.parse(sourceLaunch.stdout) as AgentTaskRecord;
    assert.equal(source.status, "succeeded");
    assert.deepEqual(source.provider, {
      provider: "claude-code",
      sessionId: "session-cli-claude",
    });

    const resumedLaunch = await runCli(
      workspaceRoot,
      [
        "resume",
        source.taskId.slice(0, 8),
        "--workspace",
        workspaceRoot,
        "--wait",
        "--json",
        "--model",
        "haiku",
        "second claude",
      ],
      10_000,
      env,
    );
    const resumed = JSON.parse(resumedLaunch.stdout) as AgentTaskRecord;
    const stored = await readTaskRecord({ workspaceRoot }, resumed.taskId);

    assert.equal(resumed.status, "succeeded");
    assert.equal(resumed.runtime, "claude-code");
    assert.deepEqual(stored.provider, {
      provider: "claude-code",
      sessionId: "session-cli-claude",
    });
    assert.deepEqual(stored.resume, {
      fromTaskId: source.taskId,
      rootTaskId: source.taskId,
      attempt: 1,
    });
    assert.deepEqual(stored.launchPlan.args, [
      "-p",
      "--resume",
      "session-cli-claude",
      "--model",
      "haiku",
      "--output-format",
      "stream-json",
      "--verbose",
      "second claude",
    ]);

    const read = await runCli(workspaceRoot, [
      "read",
      resumed.taskId,
      "--workspace",
      workspaceRoot,
    ]);
    assert.equal(read.stdout.trim(), "claude resumed second claude");
  }, "orchestrator-cli-resume-claude-");
});

test("CLI resume rejects tasks without real provider resume support", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const sourceLaunch = await runCli(workspaceRoot, [
      "launch",
      "shell",
      "--workspace",
      workspaceRoot,
      "--wait",
      "--json",
      "printf shell-source",
    ]);
    const source = JSON.parse(sourceLaunch.stdout) as AgentTaskRecord;

    await assert.rejects(
      runCli(workspaceRoot, [
        "resume",
        source.taskId.slice(0, 8),
        "--workspace",
        workspaceRoot,
        "--json",
        "continue shell",
      ]),
      (error: unknown) => {
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const parsed = JSON.parse(stderr) as {
          error: { reason?: string; message?: string; hint?: string };
        };
        assert.equal(parsed.error.reason, "unsupported_resume");
        assert.match(parsed.error.message ?? "", /does not support provider resume/);
        assert.match(parsed.error.hint ?? "", /launch a new follow-up task/);
        return true;
      },
    );
  }, "orchestrator-cli-resume-unsupported-");
});

async function installFakeRuntime(
  workspaceRoot: string,
  name: "codex" | "claude",
  script: string,
): Promise<Record<string, string>> {
  const binDir = `${workspaceRoot}/bin`;
  await mkdir(binDir, { recursive: true });
  await writeFile(`${binDir}/${name}`, script, { mode: 0o755 });
  return { PATH: `${binDir}:${process.env.PATH ?? ""}` };
}

async function waitForProviderThread(
  workspaceRoot: string,
  taskId: string,
  threadId: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const task = await readTaskRecord({ workspaceRoot }, taskId);
    if (task.provider?.threadId === threadId) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.fail(`Timed out waiting for provider thread ${threadId}.`);
}

function fakeCodexScript(): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
const resumeIndex = args.indexOf("resume");
const isResume = resumeIndex !== -1;
const threadId = isResume ? args[resumeIndex + 1] : "thread-cli-codex";
const prompt = isResume ? args[resumeIndex + 2] : args.at(-1);
if (prompt === "hold codex") {
  console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
  console.log(JSON.stringify({ type: "turn.started" }));
  setInterval(() => {}, 1000);
} else {
const text = isResume ? \`codex resumed \${prompt}\` : "codex source";
console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
console.log(JSON.stringify({ type: "turn.started" }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "item-1", type: "agent_message", text } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
}
`;
}

function fakeClaudeScript(): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
const resumeIndex = args.indexOf("--resume");
const isResume = resumeIndex !== -1;
const sessionId = isResume ? args[resumeIndex + 1] : "session-cli-claude";
const prompt = args.at(-1);
const text = isResume ? \`claude resumed \${prompt}\` : "claude source";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "fake-claude" }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] }, session_id: sessionId }));
console.log(JSON.stringify({ type: "result", subtype: "success", result: text, session_id: sessionId, terminal_reason: "completed" }));
`;
}
