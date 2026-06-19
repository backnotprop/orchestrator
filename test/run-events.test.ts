import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunStreamSequencer,
  normalizeRunStreamError,
  reduceRunStreamEvent,
  runStreamPayloadsFromParentToolTrace,
  type RunState,
  type RunStreamEvent,
} from "@backnotprop/orchestrator-agent/run-events";
import type { ParentToolTraceEvent } from "@backnotprop/orchestrator-agent";

const fixedNow = new Date("2026-06-18T12:00:00.000Z");

test("run stream sequencer adds stable envelope fields in order", () => {
  const stream = createRunStreamSequencer({
    runId: "run-test",
    now: () => fixedNow,
  });

  const started = stream.create({
    kind: "run.started",
    sessionId: "session-test",
    cwd: "/repo",
    request: "Launch a child agent.",
  });
  const final = stream.create({
    kind: "run.final",
    sessionId: "session-test",
    output: "Done.",
  });

  assert.equal(started.schemaVersion, 1);
  assert.equal(started.seq, 1);
  assert.equal(started.timestamp, "2026-06-18T12:00:00.000Z");
  assert.equal(started.runId, "run-test");
  assert.equal(final.seq, 2);
  assert.equal(final.runId, "run-test");
});

test("parent tool traces produce enveloped tool and child task events", () => {
  const stream = createRunStreamSequencer({
    runId: "run-test",
    now: () => fixedNow,
  });
  const trace: ParentToolTraceEvent = {
    kind: "tool.result",
    timestamp: "2026-06-18T12:00:01.000Z",
    toolCallId: "call-launch",
    toolName: "launch_agent",
    durationMs: 42,
    result: {
      task: {
        taskId: "task-1",
        name: "check email",
        runtime: "custom",
        status: "running",
        cwd: "/repo",
      },
      model: "glm-5.2",
    },
  };

  const events = runStreamPayloadsFromParentToolTrace(trace).map((payload) =>
    stream.create(payload),
  );

  assert.deepEqual(
    events.map((event) => event.kind),
    ["tool.result", "task.started"],
  );
  assert.equal(events[0]?.seq, 1);
  assert.equal(events[1]?.seq, 2);
  assert.equal(events[1]?.kind === "task.started" ? events[1].taskId : "", "task-1");
  assert.equal(events[1]?.kind === "task.started" ? events[1].model : "", "glm-5.2");

  const state = reduceAll(events);
  assert.equal(state.tasks["task-1"]?.status, "running");
  assert.equal(state.tasks["task-1"]?.name, "check email");
  assert.equal(state.tasks["task-1"]?.toolCallId, "call-launch");
  assert.equal(state.tools["call-launch"]?.status, "succeeded");
});

test("read_agent progress and result update child task state", () => {
  const stream = createRunStreamSequencer({
    runId: "run-test",
    now: () => fixedNow,
  });
  const callTrace: ParentToolTraceEvent = {
    kind: "tool.call",
    timestamp: "2026-06-18T12:00:01.000Z",
    toolCallId: "call-read",
    toolName: "read_agent",
    input: {
      taskId: "task-1",
      wait: true,
    },
  };
  const progressTrace: ParentToolTraceEvent = {
    kind: "tool.progress",
    timestamp: "2026-06-18T12:00:02.000Z",
    toolCallId: "call-read",
    toolName: "read_agent",
    elapsedMs: 1_000,
    progress: {
      taskId: "task-1",
      name: "check email",
      runtime: "custom",
      status: "running",
      timeoutMs: 300_000,
      remainingMs: 299_000,
    },
  };
  const resultTrace: ParentToolTraceEvent = {
    kind: "tool.result",
    timestamp: "2026-06-18T12:00:03.000Z",
    toolCallId: "call-read",
    toolName: "read_agent",
    durationMs: 2_000,
    result: {
      retrievalStatus: "completed",
      task: {
        taskId: "task-1",
        name: "check email",
        runtime: "custom",
        status: "succeeded",
        cwd: "/repo",
      },
      output: "Inbox clean.",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
      },
    },
  };

  const events = [
    ...runStreamPayloadsFromParentToolTrace(callTrace),
    ...runStreamPayloadsFromParentToolTrace(progressTrace),
    ...runStreamPayloadsFromParentToolTrace(resultTrace),
  ].map((payload) => stream.create(payload));

  assert.deepEqual(
    events.map((event) => event.kind),
    ["tool.call", "tool.progress", "task.status", "tool.result", "task.usage", "task.finished"],
  );

  const state = reduceAll(events);
  assert.equal(state.tasks["task-1"]?.status, "succeeded");
  assert.equal(state.tasks["task-1"]?.output, "Inbox clean.");
  assert.equal(state.tasks["task-1"]?.usage?.totalTokens, 15);
  assert.equal(state.tools["call-read"]?.status, "succeeded");
  assert.equal(state.tools["call-read"]?.durationMs, 2_000);
  assert.deepEqual(state.tools["call-read"]?.input, {
    taskId: "task-1",
    wait: true,
  });
  assert.equal(state.tools["call-read"]?.startedAt, "2026-06-18T12:00:01.000Z");
});

test("run reducer records final answers and normalized errors", () => {
  const stream = createRunStreamSequencer({
    runId: "run-test",
    now: () => fixedNow,
  });
  const successEvents = [
    stream.create({
      kind: "run.started",
      sessionId: "session-test",
      cwd: "/repo",
      request: "Do work.",
    }),
    stream.create({
      kind: "run.final",
      sessionId: "session-test",
      output: "Done.",
    }),
  ];

  const success = reduceAll(successEvents);
  assert.equal(success.status, "succeeded");
  assert.equal(success.output, "Done.");
  assert.equal(success.seq, 2);

  const failure = reduceAll([
    stream.create({
      kind: "run.error",
      sessionId: "session-test",
      error: normalizeRunStreamError(new TypeError("bad run")),
    }),
  ]);
  assert.equal(failure.status, "failed");
  assert.equal(failure.error?.message, "bad run");
  assert.equal(failure.error?.name, "TypeError");
});

function reduceAll(events: readonly RunStreamEvent[]): RunState {
  return events.reduce<RunState | undefined>(
    (state, event) => reduceRunStreamEvent(state, event),
    undefined,
  )!;
}
