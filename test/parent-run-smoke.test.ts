import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli, waitForTerminalTask, withTempWorkspace } from "./helpers.ts";

const runParentRunSmoke = process.env.RUN_PARENT_RUN_SMOKE === "1";
const parentAgentDir = process.env.PARENT_RUN_SMOKE_AGENT_DIR ?? join(homedir(), ".pi", "agent");

type CompactLaunch = {
  id: string;
  taskId: string;
  name?: string;
  runtime: string;
  status: string;
};

type CompactRead = {
  id: string;
  taskId: string;
  runtime: string;
  status: string;
  output: string;
};

type ParsedTaskEvent = {
  type: string;
  data?: {
    kind?: string;
    toolName?: string;
    taskId?: string;
    runtime?: string;
    status?: string;
    output?: string;
  };
};

type CompactPs = {
  groups: Array<{
    id: string;
    groupId: string;
    label: string;
    tasks: number;
    commands?: {
      waitPreview?: { args: string[] };
      ps?: { args: string[] };
    };
  }>;
  tasks: Array<{
    id: string;
    taskId: string;
    groupId: string;
    runtime: string;
    name: string;
    status: string;
  }>;
};

type CompactBatchRead = {
  tasks: Array<{
    id: string;
    taskId: string;
    runtime: string;
    status: string;
    output: string;
  }>;
};

test(
  "Parent run smoke: background parent launches a child and exposes operator views",
  {
    skip: runParentRunSmoke
      ? false
      : "Set RUN_PARENT_RUN_SMOKE=1 to run live parent-run smoke tests.",
  },
  async () => {
    await withTempWorkspace(async (workspaceRoot) => {
      const doctor = await runCli(
        workspaceRoot,
        [
          "doctor",
          "--workspace",
          workspaceRoot,
          "--agent-dir",
          parentAgentDir,
          "--json",
          "--compact",
        ],
        30_000,
      );
      const doctorReport = JSON.parse(doctor.stdout) as {
        parent?: { canRun?: boolean };
        canRunParentAgent?: boolean;
      };
      assert.equal(doctorReport.parent?.canRun, true);
      assert.equal(doctorReport.canRunParentAgent, true);

      const request = [
        'Launch exactly one shell child named "echo demo".',
        "Do not launch Codex or Claude for this; use runtime shell.",
        "Give the child exactly this task: printf OK.",
        "Use read_agent with wait: true to wait for the child result.",
        "Then answer with exactly this text and no markdown: parent-smoke-ok OK",
      ].join(" ");
      const launch = await runCli(
        workspaceRoot,
        [
          "run",
          "--workspace",
          workspaceRoot,
          "--agent-dir",
          parentAgentDir,
          "--background",
          "--name",
          "parent run smoke",
          "--json",
          "--compact",
          "--brief",
          request,
        ],
        180_000,
      );
      const launched = JSON.parse(launch.stdout) as CompactLaunch;

      assert.equal(launched.runtime, "orchestrator");
      assert.equal(launched.name, "parent run smoke");
      assert.ok(["queued", "starting", "running", "succeeded"].includes(launched.status));

      const completed = await waitForTerminalTask(workspaceRoot, launched.taskId, 180_000);
      assert.equal(completed.status, "succeeded");

      const read = await runCli(
        workspaceRoot,
        ["read", launched.id, "--workspace", workspaceRoot, "--json", "--compact"],
        30_000,
      );
      const parsedRead = JSON.parse(read.stdout) as CompactRead;
      assert.equal(parsedRead.taskId, launched.taskId);
      assert.equal(parsedRead.runtime, "orchestrator");
      assert.equal(parsedRead.status, "succeeded");
      assert.match(parsedRead.output, /parent-smoke-ok OK/);

      const agentEvents = await runCli(
        workspaceRoot,
        ["events", launched.id, "--workspace", workspaceRoot, "--agent-only", "--json"],
        30_000,
      );
      const parsedAgentEvents = JSON.parse(agentEvents.stdout) as ParsedTaskEvent[];
      const eventKinds = parsedAgentEvents.map((event) => event.data?.kind);
      assertEventKindSubsequence(eventKinds, [
        "run.started",
        "tool.call",
        "tool.result",
        "task.started",
        "tool.call",
        "tool.result",
        "task.finished",
        "run.final",
      ]);
      assert.ok(
        parsedAgentEvents.some(
          (event) => event.data?.kind === "tool.call" && event.data.toolName === "launch_agent",
        ),
      );
      assert.ok(
        parsedAgentEvents.some(
          (event) => event.data?.kind === "tool.call" && event.data.toolName === "read_agent",
        ),
      );
      const childStarted = parsedAgentEvents.find(
        (event) => event.data?.kind === "task.started" && event.data.runtime === "shell",
      );
      assert.ok(childStarted?.data?.taskId);
      assert.ok(
        parsedAgentEvents.some(
          (event) =>
            event.data?.kind === "task.finished" &&
            event.data.taskId === childStarted.data?.taskId &&
            event.data.runtime === "shell" &&
            event.data.status === "succeeded" &&
            event.data.output?.includes("OK"),
        ),
      );
      assert.equal(parsedAgentEvents.at(-1)?.data?.kind, "run.final");

      const watchedAgentEvents = await runCli(
        workspaceRoot,
        ["watch", launched.id, "--workspace", workspaceRoot, "--agent-only", "--json"],
        30_000,
      );
      const parsedWatchedAgentEvents = watchedAgentEvents.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ParsedTaskEvent);
      assert.deepEqual(
        parsedWatchedAgentEvents.map((event) => event.data?.kind),
        eventKinds,
      );

      const ps = await runCli(
        workspaceRoot,
        ["ps", "--workspace", workspaceRoot, "--all", "--json", "--compact"],
        30_000,
      );
      const compactPs = JSON.parse(ps.stdout) as CompactPs;
      const group = compactPs.groups.find((candidate) => candidate.groupId === launched.taskId);
      assert.ok(group);
      assert.equal(group.label, "parent run smoke");
      assert.equal(group.tasks, 2);
      const groupPsArgs = group.commands?.ps?.args;
      assert.ok(groupPsArgs);
      assert.deepEqual(groupPsArgs, [
        "ps",
        "--parent",
        group.id,
        "--json",
        "--compact",
        "--workspace",
        workspaceRoot,
      ]);

      const parentRow = compactPs.tasks.find((task) => task.taskId === launched.taskId);
      const childRow = compactPs.tasks.find(
        (task) => task.groupId === launched.taskId && task.runtime === "shell",
      );
      assert.ok(parentRow);
      assert.ok(childRow);
      assert.equal(childRow.name, "echo demo");
      assert.equal(childRow.status, "succeeded");
      const groupWaitPreviewArgs = group.commands?.waitPreview?.args;
      assert.ok(groupWaitPreviewArgs);
      assert.ok(groupWaitPreviewArgs.includes(parentRow.id));
      assert.ok(groupWaitPreviewArgs.includes(childRow.id));
      assert.ok(groupWaitPreviewArgs.includes("--json"));
      assert.ok(groupWaitPreviewArgs.includes("--compact"));

      const followUpRead = await runCli(workspaceRoot, groupWaitPreviewArgs, 30_000);
      const parsedFollowUpRead = JSON.parse(followUpRead.stdout) as CompactBatchRead;
      assert.ok(
        parsedFollowUpRead.tasks.some(
          (task) =>
            task.taskId === childRow.taskId &&
            task.runtime === "shell" &&
            task.status === "succeeded" &&
            task.output.includes("OK"),
        ),
      );
    }, "orchestrator-parent-run-smoke-");
  },
);

function assertEventKindSubsequence(
  actual: readonly (string | undefined)[],
  expected: readonly string[],
): void {
  let offset = 0;
  for (const kind of actual) {
    if (kind === expected[offset]) {
      offset += 1;
    }
    if (offset === expected.length) {
      return;
    }
  }
  assert.fail(
    `Expected event kind subsequence ${expected.join(" -> ")} in ${actual.join(" -> ")}.`,
  );
}
