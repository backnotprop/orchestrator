# Synthesis: Codex App-Server Resume

Date: 2026-06-30

## Question

What do we need to support:

```sh
orchestrator resume <codex-app-server-task> "next instruction"
```

for tasks backed by `codex app-server --listen stdio://`?

## Synthesis

Codex app-server resume fits Orchestrator's existing task-shaped resume model.
We do not need a new command, a pooled app-server, or a broader session manager.

The user-facing model should stay:

```sh
orchestrator resume <task-id|prefix> "<next instruction>"
```

That command creates a new Orchestrator task linked to the source task. Codex
continues the same provider thread internally through `thread/resume`, and the
new Orchestrator task owns the new turn's logs, events, result, usage, status,
and cancellation behavior.

## What We Learned

Codex app-server already exposes the API we need:

- `thread/start` creates a new thread.
- `thread/resume` reopens an existing thread by `threadId`.
- `turn/start` sends the next instruction into that thread.

Orchestrator already stores the important provider id:

- `provider.threadId`

Orchestrator already has most of the product shell:

- `orchestrator resume`
- resume lineage on task records
- same-provider-session conflict checks
- protocol execution for `codex-app-server`
- provider metadata storage
- normalized events, logs, usage, and final output

The main blocker is self-inflicted: current app-server launch forces:

```text
thread/start { ephemeral: true }
```

Ephemeral Codex threads are not the right default for resumable tasks. New
`codex-app-server` tasks should stop opting into ephemeral mode.

## Recommended Direction

Make `codex-app-server` resumable as a normal runtime:

1. Stop forcing app-server threads to be ephemeral.
2. Mark `codex-app-server` as supporting provider resume.
3. Add a `codex-app-server` branch in `buildAgentResumeLaunchPlan`.
4. Teach the executor to open a Codex thread by either:
   - `thread/start`, for fresh tasks; or
   - `thread/resume`, for resumed tasks.
5. Keep `excludeTurns: true` on resume so Orchestrator does not pull large
   prior-history payloads just to start a new turn.
6. Make active same-thread checks provider-based, not runtime-id-based, so Codex
   process and Codex app-server tasks cannot accidentally run concurrent turns
   against the same provider thread.

## Important Code Detail

Process resume plans do not need a separate task payload. The prompt is carried
in argv.

Protocol resume does need it. The app-server executor reads
`plan.taskForProtocol`. Today `buildAgentLaunchPlan` sets that field for fresh
protocol launches, but `baseResumePlan` does not set it for resume plans.

The implementation must explicitly preserve the resumed prompt as
`taskForProtocol`, or `codex-app-server` resume will build a plan that cannot
send the next instruction.

## Tradeoffs

Using `threadId` is the right first path. Codex also has resume-by-history and
resume-by-path shapes, but those are not needed for Orchestrator's current task
model.

Using `excludeTurns: true` keeps protocol traffic small. The tradeoff is that
Codex may not replay prior restored usage into the response. That is acceptable
for the first implementation because Orchestrator should show usage for the new
turn it is running, not rebuild a whole historical cost ledger.

Existing `codex-app-server` tasks created with `ephemeral: true` may not resume
later. Do not hide that. If Codex rejects one, surface the provider error.

## Non-Goals

- No app-server pooling.
- No steering a running turn.
- No Codex goals.
- No public protocol custom-agent config.
- No resume-by-history or resume-by-path.
- No parent Pi session resume work in this slice.

## Confidence

High. The feature is supported by Codex app-server, and Orchestrator already has
the surrounding task and resume model. The implementation is a contained
runtime/executor extension with targeted tests.

## Source Research

- `adr/research/SPIKE-codex-app-server-resume-20260630-161114.md`
- `adr/research/synthesis-runtime-resume-and-app-server-pooling-20260630-050740.md`
- `adr/specs/protocol-session-adapter-20260624-054713.md`
- `~/oss-agents/codex/codex-rs/app-server/README.md`
- `~/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
- `~/oss-agents/codex/codex-rs/app-server/src/request_processors/thread_processor.rs`
