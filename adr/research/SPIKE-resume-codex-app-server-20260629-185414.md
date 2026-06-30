# Research Spike: Resume, Steer, And Goals For Codex App-Server

Date: 2026-06-29

Sub-agent: Leibniz

## Question

Can Orchestrator programmatically resume, steer, or set goals for Codex
app-server sessions using local `codex app-server --listen stdio://`, and what
would it need to store or change?

## Short Answer

Yes, Codex app-server exposes the needed APIs. Orchestrator does not use them
yet. Its current `codex-app-server` executor starts one stdio app-server
process, creates an `ephemeral: true` thread, starts one turn, then closes the
client. That blocks durable goals and limits resume to whatever Codex persisted
elsewhere.

The smallest useful path is: add an explicit durable Codex session mode using
non-ephemeral threads, persist Codex thread metadata, use `thread/resume` plus
`turn/start` for follow-up work, add `turn/steer` only for currently running
turns, and defer cross-process live rejoin/pooling.

## Evidence With File References

- Codex app-server supports stdio JSON-RPC via
  `codex app-server --listen stdio://`; stdio is single-client and exits when
  the connection closes:
  [`main.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/main.rs:25),
  [`README.md`](/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md:20),
  [`lib.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/lib.rs:714),
  [`lib.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/lib.rs:1000).
- The protocol registers `thread/resume`, `thread/read`, `thread/fork`,
  `thread/goal/*`, `turn/start`, `turn/steer`, and `turn/interrupt`:
  [`common.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/common.rs:476),
  [`common.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/common.rs:533),
  [`common.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/common.rs:632),
  [`common.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/common.rs:799).
- `thread/resume` can resume by `thread_id`, history, or path. For non-running
  threads, precedence is history, path, then thread id. For running threads,
  `thread_id` rejoins and `path` is only a consistency check:
  [`thread.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs:310).
  The implementation rejects running resume by history and ignores overrides
  when rejoining a loaded thread:
  [`thread_processor.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/thread_processor.rs:2953).
- Goals require a materialized, non-ephemeral thread with state DB support.
  Ephemeral threads do not support goals:
  [`thread_goal_processor.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/thread_goal_processor.rs:97),
  [`thread_goal_processor.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/thread_goal_processor.rs:219).
- Goal shapes include objective, status, token budget, token usage, and elapsed
  time:
  [`thread.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs:747).
- `turn/steer` requires an active regular turn and `expectedTurnId`; it fails
  on missing active turn, turn mismatch, review turns, compact turns, or empty
  input:
  [`turn.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/turn.rs:172),
  [`turn_processor.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/turn_processor.rs:870).
- `turn/interrupt` requires the exact active thread and turn:
  [`turn.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/turn.rs:206),
  [`turn_processor.rs`](/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/turn_processor.rs:1348).
- Orchestrator's current runtime marks resume and running steer unsupported:
  [`runtimes.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/runtimes.ts:111).
- The current executor starts an app-server stdio client, initializes
  experimental API, creates an ephemeral thread, starts one turn, records
  thread/turn ids, then closes the client:
  [`codex-app-server.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:142),
  [`codex-app-server.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:227),
  [`codex-app-server.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:240),
  [`codex-app-server.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:264),
  [`codex-app-server.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:315).
- Orchestrator docs already describe these limits: one app-server process per
  task, ephemeral threads first, resume not implemented, no pooling, and
  goals/steering out of scope:
  [`doc/codex-app-server.md`](/Users/ramos/oss-agents/pi-research/doc/codex-app-server.md:46).

## Resume, Steer, And Goal Model

`thread/read` is inspection. It can include turns, but it does not attach a
live listener or make the thread runnable.

`thread/resume` is the continuation primitive. Prefer `thread_id`. After
resume, Orchestrator can call `turn/start` to append a new user turn.
`thread/fork` creates a new branch with a new thread id.

`turn/steer` is only for an active turn in the currently live session. It
appends input to that turn and must pass the current `expectedTurnId`.

`turn/interrupt` should use the active `threadId` and `turnId`, then wait for
`turn/completed` with an interrupted terminal state.

`thread/goal/set|get|clear` is not prompt text. It is persisted Codex thread
state and only works for materialized non-ephemeral threads.

## What Orchestrator Would Store

- Codex `thread.id`.
- Codex `sessionId` if surfaced.
- Latest active `turn.id`.
- Persistent `thread.path` when available.
- `cwd`, model/reasoning settings, Codex home/config identity, runtime version,
  and whether the thread is ephemeral.
- For live control: process ownership, transport endpoint, active turn status,
  and notification routing state.
- For goals: local snapshot of objective, status, token budget, tokens used,
  elapsed time, and last update, while treating Codex state DB as source of
  truth.

## Risks

- The app-server API is experimental.
- Current Orchestrator uses ephemeral threads, which block durable goals.
- Stdio is single-client and exits when closed, so running-thread rejoin is not
  available after the executor exits.
- Notification routing is nontrivial because responses, turn events, usage,
  item updates, approval requests, and goal notifications interleave.
- Steering and interrupting are race-prone because they require the exact
  active turn id.
- Path/history resume exists, but thread id is the safer key.

## Recommendation

Keep the current `codex-app-server` executor as the simple one-turn ephemeral
runtime.

Add a separate explicit durable Codex session mode that creates non-ephemeral
threads, persists Codex thread metadata, supports `thread/read`,
`thread/resume`, `thread/fork`, `turn/start`, and `turn/interrupt`.

Add `turn/steer` first only for currently running tasks in the same executor
process, where Orchestrator already has the live client, `threadId`, and
`turnId`.

Add goals only after durable non-ephemeral sessions exist. A fresh app-server
plus `thread/resume` is simpler for persisted sessions than cross-process live
rejoin/pooling.

## Unknowns

- Whether the experimental protocol shapes will remain stable.
- Whether goal features are enabled by default in all target Codex installs.
- How Orchestrator should expose multi-turn Codex sessions in its task model.
- How Codex goal statuses should map to Orchestrator task statuses.
- Whether long-lived control should use Unix sockets, a daemon, or a managed
  app-server pool.
