# SPIKE: Successful Background Parent Events

Date: 2026-06-30

## Question

What remains to fully close the persisted parent-events backlog item for
successful `orchestrator run --background` executions?

## Findings

Background parent execution already has the right production path.

- `packages/cli/src/commands/run.ts` creates a managed parent task through
  `commandRunBackground`.
- The detached task runs the internal `__run-parent-task` command.
- `commandRunParentTask` calls `executeParentRun` with a `runEventSink`.
- The sink appends each `RunStreamEvent` to the parent task through
  `appendAgentTaskEvent`.
- `appendAgentTaskEvent` writes a sequenced `agent_event` into the task's
  existing `events.jsonl`.

The event stream also already has the right shape.

- `run.started`, `run.final`, and `run.error` come from `executeParentRun`.
- Parent tool trace events are converted by
  `runStreamPayloadsFromParentToolTrace`.
- `launch_agent` results produce `tool.result` plus `task.started`.
- completed `read_agent` results produce `tool.result` plus `task.finished`.

Existing coverage proves the failure path, not the successful path.

- `test/cli-run.test.ts` launches a background parent with an invalid agent dir.
- That test proves a failed background parent stores `run.error`.
- It also proves `events <parent-id> --agent-only --json` and
  `watch <parent-id> --agent-only --json` can read the persisted error event.
- It does not prove `run.started`, tool events, child task events, or
  `run.final` for a successful parent run.

The hard part is deterministic testing.

- A true CLI success path requires Pi credentials and a model call.
- That is useful as an opt-in smoke test, but it should not be required by
  `pnpm test`.
- The normal test suite needs a fake parent session that executes a predictable
  parent turn without network or credentials.

## Implementation Shape To Validate

Use a small test seam, not a fake product mode.

- Let `commands/run.ts` accept an optional parent-session factory in its command
  context.
- Production keeps using `createOrchestratorParentSession`.
- Tests can supply a fake session factory.
- The fake session should call real Orchestrator tools, not manually write event
  objects. That keeps the test honest about `launch_agent`, `read_agent`, trace
  conversion, child task creation, and final output.

The fake successful parent should:

1. receive the prompt;
2. create real Orchestrator tools with the same tool context;
3. call `launch_agent` with `runtime: "shell"` and a deterministic command;
4. call `read_agent` with `wait: true`;
5. return a final assistant text that includes the child output.

The test should then read the parent task's agent events and verify the durable
timeline contains:

- `run.started`
- `tool.call` for `launch_agent`
- `tool.result` for `launch_agent`
- `task.started`
- `tool.call` for `read_agent`
- `tool.result` for `read_agent`
- `task.finished`
- `run.final`

## Risks

- A fake session that writes events directly would only test the sink, not the
  parent tool path.
- A live-only smoke test would not protect normal CI.
- A broad product flag for fake parent sessions would leak test behavior into
  user-facing CLI behavior.

## Recommendation

Add one deterministic integration test with a private test seam in the run
command, plus an optional live smoke command for manual verification. Do not add
new event stores, new CLI flags, or a fake runtime visible to users.
