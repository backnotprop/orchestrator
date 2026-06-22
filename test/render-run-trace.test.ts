import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunStreamSequencer,
  runStreamPayloadsFromParentToolTrace,
  type ParentToolTraceEvent,
  type RunStreamEvent,
} from "@backnotprop/orchestrator-agent";
import { renderRunTraceEvents } from "../packages/cli/src/render-run-trace.ts";

test("run trace renders launch_agent as a readable action", () => {
  const events = traceEvents([
    {
      kind: "tool.call",
      timestamp: "2026-06-19T12:00:00.000Z",
      toolCallId: "call-launch",
      toolName: "launch_agent",
      input: {
        runtime: "codex",
        model: "gpt-5.4-mini",
        name: "say hello",
        instructions: "Say hello.",
      },
    },
    {
      kind: "tool.result",
      timestamp: "2026-06-19T12:00:01.000Z",
      toolCallId: "call-launch",
      toolName: "launch_agent",
      durationMs: 300,
      result: {
        task: {
          taskId: "task-123456",
          name: "say hello",
          runtime: "codex",
          status: "running",
          cwd: "/repo",
        },
        model: "gpt-5.4-mini",
      },
    },
  ]);

  assert.equal(
    renderRunTraceEvents(events),
    "launching codex (gpt-5.4-mini): say hello\n  task task-123 started\n",
  );
});

test("run trace renders read_agent wait progress and final output once", () => {
  const events = traceEvents([
    {
      kind: "tool.call",
      timestamp: "2026-06-19T12:00:00.000Z",
      toolCallId: "call-read",
      toolName: "read_agent",
      input: {
        taskId: "task-123456",
        wait: true,
      },
    },
    {
      kind: "tool.progress",
      timestamp: "2026-06-19T12:00:01.000Z",
      toolCallId: "call-read",
      toolName: "read_agent",
      elapsedMs: 1_200,
      progress: {
        taskId: "task-123456",
        name: "say hello",
        runtime: "codex",
        status: "running",
      },
    },
    {
      kind: "tool.result",
      timestamp: "2026-06-19T12:00:02.000Z",
      toolCallId: "call-read",
      toolName: "read_agent",
      durationMs: 2_000,
      result: {
        retrievalStatus: "completed",
        task: {
          taskId: "task-123456",
          name: "say hello",
          runtime: "codex",
          status: "succeeded",
          cwd: "/repo",
        },
        output: "Hello.",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
      },
    },
  ]);

  assert.equal(
    renderRunTraceEvents(events),
    [
      "waiting for task-123",
      "  still running 1s: say hello",
      "  tokens 15: say hello",
      "  done: Hello.",
      "",
    ].join("\n"),
  );
});

test("run trace shows live token usage plainly and labels estimated usage", () => {
  const stream = createRunStreamSequencer({
    runId: "run-test",
    now: () => new Date("2026-06-19T12:00:00.000Z"),
  });
  const events: RunStreamEvent[] = [
    stream.create({
      kind: "task.usage",
      taskId: "task-live",
      name: "live task",
      runtime: "codex",
      usage: {
        totalTokens: 1500,
        source: "provider",
        scope: "turn",
        final: false,
      },
    }),
    stream.create({
      kind: "task.usage",
      taskId: "task-estimated",
      name: "estimated task",
      runtime: "custom",
      usage: {
        totalTokens: 2500,
        source: "estimated",
        scope: "task",
        final: false,
      },
    }),
  ];

  assert.equal(
    renderRunTraceEvents(events),
    "  tokens 1.5k: live task\n  tokens 2.5k est: estimated task\n",
  );
});

test("run trace renders plain utility tools without task events", () => {
  const events = traceEvents([
    {
      kind: "tool.call",
      timestamp: "2026-06-19T12:00:00.000Z",
      toolCallId: "call-list",
      toolName: "list_agents",
      input: {
        runtime: "codex",
      },
    },
    {
      kind: "tool.result",
      timestamp: "2026-06-19T12:00:01.000Z",
      toolCallId: "call-list",
      toolName: "list_agents",
      durationMs: 25,
      result: {
        tasks: [{ taskId: "one" }, { taskId: "two" }],
      },
    },
  ]);

  assert.equal(renderRunTraceEvents(events), "listing agents\nlisted 2 agents\n");
});

test("run trace does not suppress unrelated tool results in a larger stream", () => {
  const events = traceEvents([
    {
      kind: "tool.call",
      timestamp: "2026-06-19T12:00:00.000Z",
      toolCallId: "call-list",
      toolName: "list_agents",
      input: {},
    },
    {
      kind: "tool.result",
      timestamp: "2026-06-19T12:00:01.000Z",
      toolCallId: "call-list",
      toolName: "list_agents",
      durationMs: 25,
      result: {
        tasks: [{ taskId: "one" }],
      },
    },
    {
      kind: "tool.result",
      timestamp: "2026-06-19T12:00:02.000Z",
      toolCallId: "call-launch",
      toolName: "launch_agent",
      durationMs: 300,
      result: {
        task: {
          taskId: "task-123456",
          name: "say hello",
          runtime: "codex",
          status: "running",
          cwd: "/repo",
        },
      },
    },
  ]);

  assert.equal(
    renderRunTraceEvents(events),
    "listing agents\nlisted 1 agents\n  task task-123 started\n",
  );
});

test("run trace renders tool errors as short failures", () => {
  const events = traceEvents([
    {
      kind: "tool.error",
      timestamp: "2026-06-19T12:00:00.000Z",
      toolCallId: "call-launch",
      toolName: "launch_agent",
      durationMs: 10,
      error: "Unknown runtime.",
    },
  ]);

  assert.equal(renderRunTraceEvents(events), "launch failed: Unknown runtime.\n");
});

function traceEvents(traces: readonly ParentToolTraceEvent[]): RunStreamEvent[] {
  const stream = createRunStreamSequencer({
    runId: "run-test",
    now: () => new Date("2026-06-19T12:00:00.000Z"),
  });

  return traces.flatMap((trace) =>
    runStreamPayloadsFromParentToolTrace(trace).map((payload) => stream.create(payload)),
  );
}
