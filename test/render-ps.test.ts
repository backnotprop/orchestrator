import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTaskPsView } from "@backnotprop/orchestrator-core";
import { renderPsView } from "../packages/cli/src/render-ps.ts";

test("ps renderer shows session activity without hiding observed health state", () => {
  const now = "2026-07-07T12:00:00.000Z";
  const view: AgentTaskPsView = {
    generatedAt: now,
    scope: { workspaces: "current", workspaceRoot: "/tmp/orchestrator-render-ps" },
    rows: [
      psRow({
        taskId: "11111111-1111-4111-8111-111111111111",
        name: "idle session",
        sessionState: "idle",
      }),
      psRow({
        taskId: "22222222-2222-4222-8222-222222222222",
        name: "busy session",
        sessionState: "turn_running",
      }),
      psRow({
        taskId: "33333333-3333-4333-8333-333333333333",
        name: "stale session",
        state: "stale",
        active: true,
        sessionState: "idle",
      }),
    ],
    groups: [
      {
        groupId: "ungrouped",
        label: "manual launches",
        status: "mixed",
        total: 3,
        running: 2,
        succeeded: 0,
        failed: 0,
        stopped: 0,
        timedOut: 0,
        rows: [],
      },
    ],
  };
  view.groups[0]!.rows = view.rows;

  const rendered = renderPsView(view, { columns: 120 });

  assert.match(rendered, /idle session\s+idle/);
  assert.match(rendered, /busy session\s+turn/);
  assert.match(rendered, /stale session\s+stale/);
});

function psRow(input: {
  taskId: string;
  name: string;
  state?: AgentTaskPsView["rows"][number]["state"];
  active?: boolean;
  sessionState?: NonNullable<AgentTaskPsView["rows"][number]["session"]>["state"];
}): AgentTaskPsView["rows"][number] {
  const now = "2026-07-07T12:00:00.000Z";
  return {
    taskId: input.taskId,
    shortTaskId: input.taskId.slice(0, 8),
    name: input.name,
    status: "running",
    ...(input.state ? { state: input.state } : {}),
    active: input.active ?? true,
    actionable: true,
    runtime: "codex-app-server",
    cwd: "/tmp/orchestrator-render-ps",
    workspaceRoot: "/tmp/orchestrator-render-ps",
    createdAt: now,
    startedAt: now,
    ageMs: 0,
    lastEvent: "session.idle",
    ...(input.sessionState
      ? {
          session: {
            kind: "codex-app-server",
            state: input.sessionState,
            startedAt: now,
            updatedAt: now,
            threadId: `thread-${input.taskId.slice(0, 8)}`,
          },
        }
      : {}),
    taskDir: `/tmp/orchestrator-render-ps/.orchestrator/tasks/${input.taskId}`,
  };
}
