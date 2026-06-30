# Research Spike: Resume Codex Exec Sessions

Date: 2026-06-29

Sub-agent: Zeno

## Question

Can Orchestrator programmatically resume the stable `codex exec` runtime, and
what must it persist?

## Short Answer

Yes. The stable path is explicit-id resume:

```sh
codex exec --json resume <thread_id> <prompt>
```

Orchestrator should not automate `--last`; it is selection by heuristic. The
durable key to store is Codex's JSONL `thread.started.thread_id`, not rollout
path and not primarily `sessionId`.

## Evidence With File References

- `codex exec` has a `resume` subcommand with `session_id`, `--last`, `--all`,
  image args, and optional prompt:
  [`cli.rs`](/Users/ramos/oss-agents/codex/codex-rs/exec/src/cli.rs:165),
  [`cli.rs`](/Users/ramos/oss-agents/codex/codex-rs/exec/src/cli.rs:174).
- `--json` emits JSONL. `--ephemeral` disables session persistence:
  [`cli.rs`](/Users/ramos/oss-agents/codex/codex-rs/exec/src/cli.rs:30),
  [`cli.rs`](/Users/ramos/oss-agents/codex/codex-rs/exec/src/cli.rs:63).
- Exec resume resolves a thread id, calls `ThreadResume`, then starts a turn on
  that thread:
  [`lib.rs`](/Users/ramos/oss-agents/codex/codex-rs/exec/src/lib.rs:795),
  [`lib.rs`](/Users/ramos/oss-agents/codex/codex-rs/exec/src/lib.rs:877).
- `--last` searches thread history, filters by cwd unless `--all`, and filters
  model provider for `--last`:
  [`lib.rs`](/Users/ramos/oss-agents/codex/codex-rs/exec/src/lib.rs:1450),
  [`lib.rs`](/Users/ramos/oss-agents/codex/codex-rs/exec/src/lib.rs:1567).
- JSONL exposes `thread.started { thread_id }`; the comment says it can be
  used to resume later:
  [`exec_events.rs`](/Users/ramos/oss-agents/codex/codex-rs/exec/src/exec_events.rs:39).
- Rollouts live under `~/.codex/sessions` as JSONL and resume appends to the
  existing rollout:
  [`rollout/lib.rs`](/Users/ramos/oss-agents/codex/codex-rs/rollout/src/lib.rs:21),
  [`recorder.rs`](/Users/ramos/oss-agents/codex/codex-rs/rollout/src/recorder.rs:744),
  [`recorder.rs`](/Users/ramos/oss-agents/codex/codex-rs/rollout/src/recorder.rs:1498).
- Codex's TS SDK resumes by passing `resume <threadId>` to
  `codex exec --experimental-json`:
  [`exec.ts`](/Users/ramos/oss-agents/codex/sdk/typescript/src/exec.ts:86),
  [`exec.ts`](/Users/ramos/oss-agents/codex/sdk/typescript/src/exec.ts:151),
  [`thread.ts`](/Users/ramos/oss-agents/codex/sdk/typescript/src/thread.ts:97).
- Orchestrator marks stable `codex` as resumable, but launch-plan construction
  has no resume input yet:
  [`runtimes.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/runtimes.ts:60),
  [`launch-plan.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/launch-plan.ts:24).
- Orchestrator already has `provider.threadId` fields and normalizes Codex
  `thread.started`, but the process executor only persists usage, not provider
  metadata:
  [`types.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/types.ts:47),
  [`output-adapters.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/output-adapters.ts:361),
  [`process.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/process.ts:90).

## Resume Model

A fresh `codex exec --json <prompt>` creates a Codex thread and emits
`thread.started` with `thread_id`. Codex persists the conversation as rollout
JSONL under `~/.codex/sessions/YYYY/MM/DD/...-{thread_id}.jsonl`.

A resume should invoke the same stable runtime with `resume <thread_id>`. Codex
loads the rollout, appends the new turn, and emits another JSONL stream for the
resumed turn. `--last` is intended for humans; it depends on cwd, model
provider, recency, and `--all`.

## What Orchestrator Would Store

- `provider.threadId`: required resume key from `thread.started.thread_id`.
- `runtime`: `codex`.
- `cwd` and workspace root.
- `model`, output mode, and launch args needed to rebuild the resume command.
- Relevant environment, especially `CODEX_HOME` if Orchestrator allows
  overriding it.
- Optional lineage such as `resumeOfTaskId`.
- Optional rollout path for diagnostics only.

## Risks

- `--last` can resume the wrong thread; use explicit ids only.
- `--ephemeral` sessions are not safely resumable.
- Thread/session naming is easy to mix up. Codex resume params prefer
  `thread_id`; `session_id` may exist but is not the JSONL key Orchestrator
  receives.
- Concurrent resumes of the same Codex thread could race.
- Orchestrator's current `resume.args: ["exec", "resume"]` is not enough by
  itself because the launch builder needs to place `resume <thread_id>`
  correctly among flags and prompt args.

## Recommendation

Implement explicit Codex resume support by adding a resume-aware launch path
that builds:

```sh
codex exec --skip-git-repo-check --json resume <thread_id> <prompt>
```

Promote `thread.started.thread_id` from the process JSONL adapter into
`AgentTaskRecord.provider.threadId`. On resumed launches, prefill the requested
`threadId`, verify the emitted `thread.started.thread_id` matches it, and fail
or warn on mismatch. Keep this scoped to stable `codex exec` first.

## Unknowns

- Exact CLI/API shape Orchestrator should expose for resume.
- Whether Orchestrator should add a process/exec transport value to
  `TaskProviderMetadata`.
- How to handle missing, archived, or moved Codex rollouts beyond surfacing
  Codex's error.
- Whether older Orchestrator task records should be backfilled from existing
  `events.jsonl`.
