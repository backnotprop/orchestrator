# 50. Use Simple Task-Shaped Resume Before Pooling

Date: 2026-06-30

## Status

Accepted

Follow-up: ADR 0052 narrows the `codex-app-server` part of this decision.
App-server resume can be implemented now by making new app-server threads
durable, while pooling, steering, goals, and public protocol runtime config
remain deferred.

## Context

Recent research covered two related questions:

- whether Codex app-server should be pooled and reused across tasks;
- how Orchestrator can resume sessions across supported runtimes.

The pooling research showed that Codex app-server is built as a stateful
app/session server, but pooling creates shared-process complexity: request
routing, notification routing, approval handling, per-thread cleanup,
per-turn interrupt, and safe fallback behavior. With `stdio://`, pooling also
means keeping one shared client connection open. For multiple independent
clients, Codex's Unix socket or daemon path is a better fit than an accidental
shared stdio process.

The resume research showed that resume maps cleanly to Orchestrator's existing
task model if each resumed turn starts as a new Orchestrator task linked to an
earlier task. This keeps logs, events, result files, usage, status, and
interrupt behavior understandable.

The current runtime state is uneven:

- `codex` can resume through explicit `thread_id`, but Orchestrator does not
  yet persist that provider id into task records.
- `claude-code` can resume through explicit `session_id`, but Orchestrator does
  not yet persist that provider id into task records.
- Pi parent sessions can resume through Pi session manager APIs, but that is a
  parent-agent concern rather than child-runtime resume.
- `codex-app-server` supports resume, steering, and goals at the protocol
  level, but Orchestrator currently uses ephemeral one-turn app-server tasks.
- custom process agents can only resume if they declare a resume contract and
  emit an opaque session handle.
- `shell` has no generic resume.

References:

- `adr/research/synthesis-runtime-resume-and-app-server-pooling-20260630-050740.md`
- `adr/research/SPIKE-codex-app-server-pooling-intended-use-20260629-172210.md`
- `adr/research/SPIKE-runtime-resume-supported-agents-20260629-185414.md`
- `adr/research/SPIKE-resume-codex-exec-20260629-185414.md`
- `adr/research/SPIKE-resume-codex-app-server-20260629-185414.md`
- `adr/research/SPIKE-resume-claude-code-20260629-185414.md`
- `adr/research/SPIKE-resume-pi-20260629-185414.md`
- `adr/research/SPIKE-resume-custom-process-20260629-185414.md`

## Decision

Build simple, task-shaped resume before app-server pooling.

The first resume design will create a new Orchestrator task linked to a prior
task. It will not reopen, mutate, or append output to the old task.

The intended user shape is:

```sh
orchestrator resume <task-id|prefix> "<next prompt>"
```

That command will:

1. load the source task;
2. check whether the source runtime supports resume;
3. extract the stored provider/session handle;
4. build a runtime-specific resume launch plan;
5. start a new managed task;
6. record resume lineage, such as
   `resume: { fromTaskId, rootTaskId, attempt }`.

The first implementation targets will be stable process runtimes:

- `codex`, using explicit `provider.threadId`;
- `claude-code`, using explicit `provider.sessionId`.

Before those runtimes can resume, Orchestrator must promote provider metadata
from normalized process output into task records:

- Codex `thread.started.thread_id` becomes `provider.threadId`.
- Claude Code `session_id` becomes `provider.sessionId`.

The resume path must use explicit ids. It must not automate provider heuristics
such as "last conversation" or "continue latest" for child-runtime resume.

Parent Pi session resume is a separate slice. It should be exposed as
`orchestrator run --session <path|id>` and `orchestrator run --continue`,
backed by Pi session manager APIs. It is not the same as resuming a child task.

Custom process resume is also separate. It should be an opt-in config contract:
the custom runtime declares a resume template and emits a normalized session
handle. `shell` remains non-resumable.

Codex app-server durable sessions, steering, goals, and pooling are deferred.
App-server resume should first require a durable non-ephemeral session mode.
Pooling should only be designed later if startup cost or multi-client use
actually requires it.

## Consequences

Resume gets a small, useful product path without forcing Orchestrator into a
large shared-session architecture.

Every resumed turn remains observable through the existing task store. Users
and agents can still use the same commands: `ps`, `read`, `logs`, `events`, and
`interrupt`.

The data model needs a small extension for resume lineage and stronger provider
metadata capture. The launch-plan layer needs a real resume-aware path because
today's `resume.args` metadata is only descriptive.

Concurrency must be handled deliberately. Orchestrator should reject or lock
concurrent resumes of the same provider session unless the provider explicitly
supports safe concurrent resumes.

Codex app-server remains simple for now: one app-server task, one ephemeral
thread, one turn. Durable app-server sessions, steering, goals, and pooling are
future work after simple resume is proven.
