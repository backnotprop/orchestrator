# Synthesis: Successful Background Parent Events

Date: 2026-06-30

## Summary

The implementation is mostly there. Background parent runs already can persist
normalized parent events into the parent task's event log. The missing piece is
confidence: current tests only cover a failed background parent setup. We need a
successful parent run that launches a child, waits for it, finishes, and can be
replayed later through `events` and `watch`.

## What To Build

Build the smallest verification slice.

1. Add a private parent-session factory seam to `packages/cli/src/commands/run.ts`.
   - Default stays `createOrchestratorParentSession`.
   - Tests can inject a fake session.
   - No user-facing CLI flag.

2. Add a deterministic test.
   - Use the fake session to call real `launch_agent` and `read_agent` tools.
   - Launch a shell child that prints a short result.
   - Persist the parent events through the same `runEventSink` path used by
     background parent tasks.
   - Assert `events <parent-id> --agent-only --json` returns the expected
     successful timeline.
   - Assert `watch <parent-id> --agent-only --json` can replay the same
     persisted events.

3. Keep an optional live smoke path.
   - A real `orchestrator run --background --agent-dir ~/.pi/agent ...` smoke is
     useful, but should stay opt-in because it needs credentials and a model.

## Why This Is Enough

This gives us standard-test coverage for the important product promise: a
completed background parent run remains inspectable after the fact. It tests the
real tool path, real child task creation, real read/wait behavior, real
`RunStreamEvent` conversion, and real task-event persistence.

It avoids overbuilding. We do not need a new event model, a fake CLI flag, a TUI
prototype, or a separate parent trace store.

## Open Detail

The deterministic test needs a parent task record to append events to. Prefer a
small test helper or local fixture over exporting more core store internals as
public API. Keep the seam narrow and internal to tests.
