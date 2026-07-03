# Research Spike: Codex App-Server Resume

Date: 2026-06-30

## Question

What would it take for Orchestrator to support:

```sh
orchestrator resume <codex-app-server-task> "next instruction"
```

using Codex app-server's native `thread/resume` API?

## Short Answer

This is implementable without changing Orchestrator's product model.

Codex app-server already supports `thread/resume` by `threadId`. Orchestrator
already stores `provider.threadId`, has a `resume` command, and has protocol
execution for `codex-app-server`.

The missing piece is that Orchestrator currently forces every app-server thread
to be ephemeral:

```ts
thread/start { ephemeral: true }
```

Ephemeral threads are intentionally temporary. For resume, Orchestrator must stop
forcing ephemeral threads and route resumed tasks through:

```text
initialize
thread/resume { threadId, ...overrides }
turn/start { threadId, input }
```

## Current Orchestrator State

`codex-app-server` is explicitly not resumable:

- `packages/core/src/runtime/runtimes.ts`
  - `resume.supported: false`
  - `capabilities.supportsResume: false`

`buildAgentResumeLaunchPlan` only supports:

- `codex`
- `claude-code`

`packages/core/src/runtime/launch-plan.ts` rejects every other runtime with
`unsupported_resume`.

The app-server executor always starts a fresh ephemeral thread:

- `packages/core/src/tasks/executors/protocol/codex-app-server.ts`
  - sends `thread/start`
  - passes `ephemeral: true`
  - then sends `turn/start`

The resume command already does useful shared work:

- reads the source task
- requires a terminal source task
- loads the target workspace registry
- builds a resume launch plan
- records resume lineage:
  - `fromTaskId`
  - `rootTaskId`
  - `attempt`
- blocks another active task on the same provider session

That means this should be a runtime/executor extension, not a new CLI command.

## Codex Source Findings

Codex app-server documents `thread/resume` as the way to continue an existing
conversation:

- `~/oss-agents/codex/codex-rs/app-server/README.md`
  - call `thread/start` for a fresh conversation
  - call `thread/resume` with the recorded id to continue one
  - call `turn/start` after resume to add the next instruction

The generated protocol type says `thread/resume` supports:

- `threadId`
- optional `model`
- optional `cwd`
- optional approval/sandbox/permission overrides
- optional `excludeTurns`
- optional `initialTurnsPage`

Reference:

- `~/oss-agents/codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts`
- `~/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs`

The protocol comments say to prefer `threadId` when possible. Resume can also
load by history or path, but Orchestrator should not use those first.

Codex app-server implementation:

- first checks if the thread is already running and can be rejoined
- otherwise loads the stored thread from disk by `threadId`
- returns a `ThreadResumeResponse`
- attaches a listener for resumed thread events
- can replay restored token usage after the response

Reference:

- `~/oss-agents/codex/codex-rs/app-server/src/request_processors/thread_processor.rs`

Codex default thread behavior is durable:

- `ThreadStartParams.ephemeral` is optional
- `ConfigOverrides.ephemeral` defaults to `None`
- final config resolves `ephemeral` with `unwrap_or_default()`, which means
  `false`

Reference:

- `~/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
- `~/oss-agents/codex/codex-rs/core/src/config/mod.rs`

So Orchestrator does not need a new Codex feature. It needs to stop opting into
ephemeral threads for tasks that may be resumed.

## Important Edge Cases

### A thread must be materialized

Codex tests show that resuming a just-started thread can fail before the first
turn materializes rollout storage:

- `~/oss-agents/codex/codex-rs/app-server/tests/suite/v2/thread_resume.rs`
  - resume before first user message can return `no rollout found for thread id`

This is acceptable for Orchestrator because `orchestrator resume` already
requires the source task to be terminal. A successful terminal app-server task
should have completed a turn.

Still, the error should pass through clearly.

### Do not return huge history by default

Codex `thread/resume` returns reconstructed turn history by default. It also
supports:

```json
{ "excludeTurns": true }
```

For Orchestrator's one-task-per-resumed-turn model, we probably do not need the
full prior turn list in the resume response. Codex still resumes from stored
history internally; `excludeTurns` only controls the response payload.

First implementation should likely pass `excludeTurns: true` to keep protocol
traffic small.

Tradeoff: Codex docs say `excludeTurns: true` skips restored token usage replay.
That is okay for Orchestrator's first pass because the new task should track the
new turn's token usage.

### Existing app-server tasks may not be resumable

Tasks created before this change used `ephemeral: true`. They may have
`provider.threadId`, but Codex may not be able to load them later.

The CLI should not pretend otherwise. If Codex rejects resume for an old
ephemeral task, Orchestrator should surface the provider error.

## Recommended Implementation Shape

### 1. Make new app-server tasks durable by default

Change the executor's start path from:

```ts
thread/start { ephemeral: true }
```

to either omit `ephemeral` or pass `ephemeral: false`.

Recommendation: omit it and rely on Codex's default durable behavior.

### 2. Mark `codex-app-server` as resume-supported

Update runtime config:

- `resume.supported: true`
- `capabilities.supportsResume: true`

No argv template is needed. This is protocol resume, not command-line resume.

### 3. Add a `codex-app-server` resume launch plan

Extend `buildAgentResumeLaunchPlan` with a `codex-app-server` case.

The plan should:

- require `provider.threadId`
- keep `executionKind: "protocol"`
- keep `taskForProtocol`
- set `resume: { provider: "codex", threadId }`
- not add `resume` to process args

### 4. Teach the executor to open a thread by start or resume

Refactor the current hardcoded `thread/start` block into something like:

```text
openCodexThread()
  if plan.resume.threadId:
    request thread/resume { threadId, model?, cwd?, excludeTurns: true }
    append thread.resumed event
  else:
    request thread/start { cwd, model? }
    append thread.started event
```

Then reuse the existing `turn/start`, notification handling, result capture,
usage capture, timeout, and interrupt logic.

### 5. Validate returned thread id

If Codex returns a different thread id from `thread/resume`, fail the task
clearly. Resume should continue the requested provider thread.

### 6. Update active-session conflict detection

`packages/cli/src/commands/resume.ts` currently treats active `codex` tasks with
the same `threadId` as conflicting.

Add `codex-app-server` to that same provider-thread conflict check.

### 7. Extend the fake app-server fixture

`test/fixtures/fake-codex-app-server.mjs` needs:

- `thread/resume`
- response with `thread.id`
- optional event or diagnostic distinction so tests can prove resume path was
  used

### 8. Add tests

Minimum deterministic tests:

- runtime resume plan supports `codex-app-server`
- missing `provider.threadId` fails cleanly
- executor uses `thread/resume` for a resumed app-server task
- resumed task writes final output and provider metadata
- CLI `orchestrator resume <codex-app-server-task>` creates a new linked task
- active same-thread app-server resume is rejected
- app-server launch no longer sends `ephemeral: true`

Optional live smoke:

- launch `codex-app-server`
- wait for completion
- resume it with one short instruction
- verify same `threadId`, new `turnId`, final output, and normalized events

## What Not To Do First

Do not add app-server pooling in this slice.

Do not add steering in this slice.

Do not add Codex goals in this slice.

Do not expose public protocol custom-agent config in this slice.

Those are separate capabilities. App-server resume can be a focused extension of
the existing resume command.

## Open Questions

1. Should new `codex-app-server` tasks always be durable?

   Recommendation: yes. Resume is a major reason to use app-server, and Codex's
   own default is durable.

2. Should Orchestrator pass `excludeTurns: true`?

   Recommendation: yes for the first pass. It keeps response payloads small while
   preserving model-visible resume behavior inside Codex.

3. Should old ephemeral `codex-app-server` tasks be marked non-resumable?

   Recommendation: no special migration. Try resume if `threadId` exists and
   surface Codex's provider error if the thread cannot be loaded.

## Conclusion

`codex-app-server` resume is a moderate, contained implementation. The clean
path is to keep Orchestrator's existing task-shaped resume model: every resumed
turn becomes a new Orchestrator task linked to the prior task, while Codex
continues the same provider thread internally.

The only architectural change is inside the protocol executor: it must be able
to open a Codex thread using either `thread/start` or `thread/resume`.
