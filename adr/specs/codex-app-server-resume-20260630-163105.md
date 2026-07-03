# Spec: Codex App-Server Resume

Date: 2026-06-30

## Intent

Support task-shaped resume for `codex-app-server`:

```sh
orchestrator resume <codex-app-server-task> "next instruction"
```

The resumed work should be a new Orchestrator task linked to the old one. Codex
app-server should continue the same provider thread through `thread/resume`.

## Goals

- Make `codex-app-server` a resumable runtime.
- Keep the existing `orchestrator resume` command.
- Keep logs, events, result, usage, status, `ps`, `read`, `watch`, and
  `interrupt` working through existing task surfaces.
- Store the resumed task's provider `threadId` and new `turnId`.
- Prevent concurrent active tasks from writing to the same Codex thread.
- Keep old ephemeral-task failures honest and visible.

## Non-Goals

- No app-server pooling.
- No live steering of an active turn.
- No Codex goals.
- No public protocol custom-agent config.
- No resume-by-history or resume-by-path.
- No parent-agent session resume.

## User Behavior

Fresh app-server task:

```sh
orchestrator launch codex-app-server --name "api notes" "Summarize this repo."
```

Resume it later:

```sh
orchestrator resume <task-id> "Now focus only on the API package."
```

Expected behavior:

- A new task is created.
- The new task has resume lineage pointing at the source task.
- The new task uses the same Codex `threadId`.
- The new task gets a new Codex `turnId`.
- `read`, `logs`, `events`, `watch`, `ps`, and `interrupt` work normally.

If the source task was created before durable app-server threads were enabled,
Codex may reject the resume. Orchestrator should show that provider failure
clearly instead of pretending the task is resumable.

## Runtime Registry

Update `CODEX_APP_SERVER_RUNTIME`:

- `resume.supported: true`
- `capabilities.supportsResume: true`

Do not add argv resume args. This is protocol resume, not process resume.

## Launch Plan

Add a `codex-app-server` case to `buildAgentResumeLaunchPlan`.

The resume plan must:

- require `input.provider.threadId`;
- keep `executionKind: "protocol"`;
- set `resume: { provider: "codex", threadId }`;
- set `taskForProtocol: input.task`;
- not inject `resume` into process argv.

This can be implemented with either:

1. a dedicated `buildCodexAppServerResumePlan`; or
2. a small change to `baseResumePlan` so protocol resume plans preserve
   `taskForProtocol`.

Prefer the dedicated app-server branch first if it keeps process resume behavior
obvious.

## Executor

Refactor `CodexAppServerTaskExecutor` so thread setup is one small branch:

```text
initialize

if plan.resume.provider == "codex" and plan.resume.threadId exists:
  thread/resume { threadId, cwd, model?, excludeTurns: true }
  validate response thread id matches requested thread id
  update provider metadata
  append normalized thread.resumed event
else:
  thread/start { cwd, model? }
  update provider metadata
  append normalized thread.started event

turn/start { threadId, input: plan.taskForProtocol }
```

Fresh `thread/start` should omit `ephemeral`. Rely on Codex's durable default.

The executor should continue to:

- capture app-server stderr as logs;
- avoid writing raw protocol transcript as normal logs;
- normalize useful protocol notifications into agent events;
- capture final output and token usage;
- send `turn/interrupt` when interrupted.

## Conflict Detection

Update resume conflict checks so Codex provider threads are treated as the
shared resource.

Instead of only checking runtime id, active-task conflict detection should reject
another active task when:

```text
task.provider.provider == "codex"
and task.provider.threadId == resumedThreadId
```

This prevents concurrent turns against the same provider thread across both:

- `codex`
- `codex-app-server`

## Events

Normalized task events should stay useful:

- fresh task: `thread.started`, `turn.started`, `turn.completed`
- resumed task: `thread.resumed`, `turn.started`, `turn.completed`

`events --agent-only` should not become raw JSON-RPC protocol soup.

## Tests

Add deterministic tests before live smoke.

Runtime and launch-plan tests:

- `codex-app-server` reports resume support.
- resume plan requires `provider.threadId`.
- resume plan includes `resume.provider = "codex"`.
- resume plan includes `taskForProtocol`.

Fake app-server tests:

- fixture supports `thread/resume`.
- resumed executor path sends `thread/resume`, not `thread/start`.
- fresh executor path no longer sends `ephemeral: true`.
- resumed task records `threadId`, `turnId`, final output, and usage.

CLI tests:

- `orchestrator resume <codex-app-server-task>` creates a new linked task.
- active same-thread conflict blocks another Codex provider resume.
- missing provider metadata returns the existing `missing_resume_provider_id`
  style error.

Optional live smoke:

```sh
RUN_CODEX_APP_SERVER_RESUME_SMOKE=1 pnpm test -- test/codex-app-server-smoke.test.ts
```

Keep live usage assertions soft until Codex app-server live behavior is proven
stable.

## Docs

Update help/docs to say:

- `codex` is the stable process runtime using `codex exec`.
- `codex-app-server` is the protocol runtime using Codex app-server.
- `codex-app-server` supports resume only for tasks with stored
  `provider.threadId`.
- older app-server tasks created as ephemeral may fail to resume.

## Rollout

1. Update runtime metadata and launch-plan tests.
2. Stop forcing `ephemeral: true` on fresh app-server threads.
3. Add executor resume branch against the fake app-server.
4. Add CLI resume coverage.
5. Add docs and optional live smoke.

This should be one focused slice. It should not pull in pooling, goals,
steering, or public protocol configuration.
