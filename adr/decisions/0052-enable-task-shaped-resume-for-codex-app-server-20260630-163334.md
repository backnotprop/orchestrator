# 52. Enable Task-Shaped Resume for Codex App-Server

Date: 2026-06-30

## Status

Accepted

## Context

ADR 0050 chose simple task-shaped resume before app-server pooling. At that
time, `codex-app-server` resume was deferred because Orchestrator was creating
ephemeral one-turn app-server threads.

Follow-up research against the Codex app-server codebase showed that Codex
already supports the API we need:

- `thread/start` starts a new thread.
- `thread/resume` reopens an existing thread by `threadId`.
- `turn/start` sends the next instruction into that thread.

Orchestrator already stores `provider.threadId`, already has
`orchestrator resume`, already records resume lineage, and already has a
protocol executor for `codex-app-server`.

The main blocker is that the executor currently opts into:

```text
thread/start { ephemeral: true }
```

That makes new app-server tasks harder to resume later. Codex's default thread
behavior is durable when `ephemeral` is omitted.

References:

- `adr/research/SPIKE-codex-app-server-resume-20260630-161114.md`
- `adr/research/synthesis-codex-app-server-resume-20260630-163105.md`
- `adr/specs/codex-app-server-resume-20260630-163105.md`
- `adr/decisions/0050-use-simple-task-shaped-resume-before-pooling-20260630-051045.md`

## Decision

Make `codex-app-server` resumable through the existing task-shaped resume
model.

The user-facing command remains:

```sh
orchestrator resume <task-id|prefix> "<next instruction>"
```

For `codex-app-server`, that command will create a new Orchestrator task linked
to the source task. The new task will resume the same Codex provider thread
through:

```text
initialize
thread/resume { threadId, cwd, model?, excludeTurns: true }
turn/start { threadId, input }
```

Fresh `codex-app-server` tasks should stop forcing `ephemeral: true`. The
executor should omit `ephemeral` and rely on Codex's durable default.

The runtime registry should mark `codex-app-server` as resume-supported. The
resume launch plan must require `provider.threadId`, keep
`executionKind: "protocol"`, set `resume: { provider: "codex", threadId }`,
and preserve the next instruction as `taskForProtocol`.

Active same-thread conflict detection should be provider-thread based, not
runtime-id based. If an active task has:

```text
provider.provider == "codex"
provider.threadId == resumedThreadId
```

then another resume against that same thread should be rejected.

This decision does not add app-server pooling, running-turn steering, Codex
goals, resume-by-history, resume-by-path, parent-agent session resume, or public
protocol custom-agent config.

## Consequences

`codex-app-server` becomes a more complete Orchestrator runtime without adding
a new command or a new session model.

Every resumed app-server turn remains observable as its own managed task. Users
and agents continue using the same surfaces: `ps`, `read`, `logs`, `events`,
`watch`, and `interrupt`.

Older app-server tasks created with `ephemeral: true` may fail to resume. That
is acceptable. Orchestrator should surface the provider error clearly instead of
pretending the old task is resumable.

The launch-plan layer needs to handle protocol resume carefully. Process resume
plans carry the prompt in argv, but protocol resume plans need
`taskForProtocol`. Tests must cover that field so the executor always has the
next instruction to send.

Pooling, steering, goals, and public protocol runtime configuration remain
separate future decisions.
