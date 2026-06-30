# Synthesis: Runtime Resume And App-Server Pooling

Date: 2026-06-30

## Question

What do the last two research rounds imply for Orchestrator's next session
control work?

The two rounds were:

- Codex app-server pooling and intended use.
- Resume support across the currently supported runtimes.

## Synthesis

Do not build app-server pooling first.

Pooling is compatible with Codex app-server's architecture, but it creates a
shared-process problem: request routing, notification routing, approval
handling, per-thread cleanup, per-turn interrupt, and safe fallback behavior.
With `stdio://`, pooling also means one long-lived shared client connection. For
multiple independent clients, Codex's Unix socket or daemon path is the better
shape.

Resume is the better next product capability. It maps cleanly to
Orchestrator's existing task model if resumed work starts as a new task linked
to an earlier task. That preserves logs, events, result files, usage, status,
and cancellation semantics.

The shared model should be:

```sh
orchestrator resume <task-id|prefix> "<next prompt>"
```

That command should load the old task, extract the provider/session handle,
build a resume launch plan, start a new task, and record resume lineage.

## Runtime Conclusions

| Runtime               | Conclusion                                                                                 | First implementation path                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `codex`               | Resume is ready conceptually. Use explicit thread id.                                      | Capture `thread.started.thread_id` into `provider.threadId`, then run `codex exec --json resume <thread_id> <prompt>`. |
| `claude-code`         | Resume is ready conceptually. Use explicit session id.                                     | Capture Claude `session_id` into `provider.sessionId`, then run `claude -p --resume <session-id> ... <prompt>`.        |
| parent Pi session     | Resume should be separate from child-task resume.                                          | Add `orchestrator run --session <path                                                                                  | id>`and`orchestrator run --continue`, backed by Pi session manager APIs. |
| `codex-app-server`    | Resume/steer/goals exist in protocol but current executor uses ephemeral one-turn threads. | Defer until a durable non-ephemeral Codex session mode exists.                                                         |
| custom process agents | Resume can work only as an explicit contract.                                              | Add custom config resume templates plus a normalized metadata event that stores an opaque session handle.              |
| `shell`               | No generic resume.                                                                         | Keep non-resumable. Rerun is a separate feature.                                                                       |

## Architecture Direction

The next resume slice should not be a universal session manager. It should be a
small task-shaped extension:

1. Promote provider metadata from process runtime output into task records.
   - Codex: `provider.threadId`
   - Claude Code: `provider.sessionId`
2. Add resume lineage to task records.
   - Example: `resume: { fromTaskId, rootTaskId, attempt }`
3. Add a resume-aware launch-plan path.
4. Add `orchestrator resume <task> "<prompt>"` for stable `codex` and
   `claude-code`.
5. Use explicit provider ids only.
6. Add per-provider validation where possible.
   - Codex resumed `thread.started.thread_id` should match the requested thread
     id.
7. Add per-session locking or rejection so two resumes do not accidentally write
   to the same provider session at once.

Pi parent resume should be its own slice because it is not the same operation
as resuming a child agent task. It resumes the parent Orchestrator conversation,
not a managed child runtime.

Codex app-server durable sessions, steering, goals, and pooling should come
after simple resume. The app-server path needs a larger session model:
non-ephemeral threads, thread metadata, thread read/resume/fork, active turn
state, and eventually goal state. Pooling should remain a deliberate later
design driven by measured startup cost.

## What Not To Do

- Do not use `--last`, `--continue`, or other "latest conversation" heuristics
  as automation defaults.
- Do not mutate an old Orchestrator task when resuming. Create a new task.
- Do not make shell resumable.
- Do not make app-server pooling a prerequisite for app-server resume.
- Do not expose public protocol custom-agent config yet.
- Do not treat provider session ids as interchangeable across runtimes.

## Recommended Order

1. Provider metadata capture for process runtimes.
2. Task resume lineage.
3. `orchestrator resume` for `codex` and `claude-code`.
4. Parent Pi session resume.
5. Custom process resume contract.
6. Durable Codex app-server session mode.
7. App-server steering/goals.
8. App-server pooling only if startup cost or multi-client needs justify it.

## Source Research

- `adr/research/SPIKE-codex-app-server-pooling-intended-use-20260629-172210.md`
- `adr/research/SPIKE-runtime-resume-supported-agents-20260629-185414.md`
- `adr/research/SPIKE-resume-codex-exec-20260629-185414.md`
- `adr/research/SPIKE-resume-codex-app-server-20260629-185414.md`
- `adr/research/SPIKE-resume-claude-code-20260629-185414.md`
- `adr/research/SPIKE-resume-pi-20260629-185414.md`
- `adr/research/SPIKE-resume-custom-process-20260629-185414.md`
