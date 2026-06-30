# Research Spike: Runtime Resume Across Supported Agents

Date: 2026-06-29

Sub-agents:

- Zeno: Codex exec
- Leibniz: Codex app-server
- Carson: Claude Code
- Euclid: Pi
- Carver: Custom process runtimes

## Question

How can Orchestrator programmatically resume sessions for the agent runtimes it
supports today?

## Short Answer

Resume should create a new Orchestrator task linked to an earlier task. It
should not mutate or reopen the old task.

The viable resume targets are:

- `codex`: yes, with explicit `thread_id` via `codex exec resume`.
- `claude-code`: yes, with explicit `session_id` via `claude -p --resume`.
- parent `orchestrator run` through Pi: yes, with Pi `SessionManager.open` or
  `continueRecent`.
- `codex-app-server`: yes for durable non-ephemeral sessions, but not in the
  current one-turn ephemeral executor.
- custom process runtimes: yes only as an opt-in contract where the runtime
  declares a resume command and emits an opaque session handle.
- `shell`: no generic resume.

The shared implementation idea is a resume-aware launch path:

```sh
orchestrator resume <task-id|prefix> "<next prompt>"
```

That command loads the old task, checks the runtime's resume contract, extracts
the provider/session handle, builds a new launch plan, starts a new task, and
records resume lineage.

## Runtime Matrix

| Runtime            | Resume now?                                              | Durable handle                              | Recommended first path                                  |
| ------------------ | -------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------- | ------------------- |
| `codex`            | Supported by provider, not implemented in Orchestrator   | `provider.threadId`                         | `codex exec --json resume <thread_id> <prompt>`         |
| `claude-code`      | Supported by provider, not implemented in Orchestrator   | `provider.sessionId`                        | `claude -p --resume <session-id> ... <prompt>`          |
| `codex-app-server` | Supported by protocol, blocked by current ephemeral mode | non-ephemeral `thread.id` and optional path | Add separate durable session mode before goals/steering |
| parent Pi session  | Supported by Pi SDK, not implemented in CLI              | exact session file plus session id          | `orchestrator run --session <path                       | id>`and`--continue` |
| Pi child runtime   | Possible later, not ready                                | exact Pi session file                       | Defer until concrete workflow                           |
| custom process     | Possible by contract                                     | runtime-emitted session handle              | Add opt-in config resume template and metadata event    |
| `shell`            | No                                                       | none                                        | Keep non-resumable; rerun is separate                   |

## Cross-Runtime Requirements

- Promote provider/session metadata from normalized output into task records.
- Add resume lineage to task records, such as
  `resume: { fromTaskId, rootTaskId, attempt }`.
- Add a resume-aware launch-plan builder. Existing `resume.args` metadata is
  not enough.
- Prefer explicit ids over heuristic "continue latest" behavior.
- Start resumed work as a new task so logs, events, usage, status, and
  interrupts remain clean.
- Add per-provider validation where possible. For example, Codex resumed
  `thread.started.thread_id` should match the requested thread id.
- Prevent concurrent resumes of the same provider session unless the provider
  explicitly supports it.

## Recommendation

Implement resume in this order:

1. Capture provider metadata for process runtimes. Specifically:
   - Codex `thread_id` into `provider.threadId`.
   - Claude `session_id` into `provider.sessionId`.
2. Add task resume lineage to the data model.
3. Add `orchestrator resume <task> "<prompt>"` for stable `codex` and
   `claude-code`, using explicit provider ids only.
4. Add parent Pi session resume separately through `orchestrator run --session`
   and `orchestrator run --continue`.
5. Add custom process resume as an opt-in config contract.
6. Defer Codex app-server durable sessions, steering, and goals until after the
   simple task-shaped resume flow exists.

## Source Spikes

- `adr/research/SPIKE-resume-codex-exec-20260629-185414.md`
- `adr/research/SPIKE-resume-codex-app-server-20260629-185414.md`
- `adr/research/SPIKE-resume-claude-code-20260629-185414.md`
- `adr/research/SPIKE-resume-pi-20260629-185414.md`
- `adr/research/SPIKE-resume-custom-process-20260629-185414.md`
