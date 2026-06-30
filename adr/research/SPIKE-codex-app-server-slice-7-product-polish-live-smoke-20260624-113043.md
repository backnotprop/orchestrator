# SPIKE: Codex App-Server Slice 7 Product Polish And Live Smoke

Date: 2026-06-24

## Question

What remains to make `codex-app-server` feel integrated and reliable after the
protocol executor and interrupt hardening slices?

## Relevant Prior Specs

- `adr/specs/protocol-session-adapter-20260624-054713.md`
- `adr/specs/codex-app-server-executor-20260624-084406.md`
- `adr/research/SPIKE-codex-app-server-support-20260624-045625.md`
- `doc/live-agent-view.md`

## Current State

`codex-app-server` now exists as a protocol runtime. It starts the JSON-RPC stdio
app-server, initializes it, starts a thread and turn, stores provider metadata,
normalizes useful events, extracts result text, updates usage, and handles
interrupt through `turn/interrupt` before process-kill fallback.

The existing fake-server tests cover:

- successful turn;
- failed turn;
- empty final answer;
- usage persistence;
- provider metadata;
- normal command-path launch;
- protocol interrupt success;
- stuck interrupt request;
- missing turn id fallback;
- acknowledged interrupt that never settles;
- stop reason winning over timeout during shutdown.

## Usage And `ps`

`packages/core/src/tasks/operations.ts` already reads task events and task
records, selects the best task usage, and attaches it to `AgentTaskRow`.

`packages/cli/src/render-ps.ts` already renders per-row token usage in the `tok`
column and group/summary token totals when `row.usage.totalTokens` exists.

This means Slice 7 does not need a new token-display architecture. It needs
codex-app-server-specific coverage proving that usage emitted by the protocol
runtime appears in:

- `ps`;
- `ps --watch`;
- compact `ps --json --compact`.

The fake app-server currently emits usage and completes quickly. To test live
watch behavior, it should gain a mode that emits `thread/tokenUsage/updated` and
then waits. That lets `ps --watch` observe tokens while the task is still active.

## Events

The current executor maps useful notifications into `agent_event` records:

- `thread.started`
- `turn.started`
- `agent.item.started`
- `agent.message.delta`
- `agent.message`
- `agent.command`
- `agent.plan`
- `agent.diff`
- `agent.usage`
- `turn.completed`
- `runtime.error`
- protocol interrupt control events

Raw protocol messages are written to `transcript.jsonl`, not normal logs. That
matches the earlier spec. Slice 7 should add user-facing assertions that
`events --agent-only` shows normalized event names and not raw JSON-RPC method
names as the main interface.

## Logs

The spec says:

- `transcript.jsonl`: raw protocol notifications and important responses.
- `events.jsonl`: normalized task events.
- `stderr.log`: app-server stderr and adapter errors.
- `stdout.log`: mostly empty unless diagnostics are needed.
- `combined.log`: diagnostics, not raw JSON-RPC traffic.

Current fake-server tests check stderr for interrupt fallback behavior, but do
not yet prove that normal successful logs remain readable. Slice 7 should add a
small assertion that `logs` contains app-server stderr diagnostics and does not
become a protocol transcript dump.

## Docs

The README runtime section still says first-class targets are Claude Code and
Codex, with `shell` as local command utility. It does not explain
`codex-app-server`.

Slice 7 should document:

- `codex` is the stable process runtime backed by `codex exec`;
- `codex-app-server` is the protocol runtime backed by
  `codex app-server --listen stdio://`;
- `codex-app-server` is useful for richer protocol events, provider ids, usage,
  and native control such as `turn/interrupt`;
- it is still experimental until live smoke proves the real Codex app-server
  surface across local installs.

## Live Smoke

Existing smoke patterns:

- `test/codex-smoke.test.ts` uses `RUN_CODEX_SMOKE=1`;
- `test/claude-smoke.test.ts` uses `RUN_CLAUDE_SMOKE=1`;
- smoke tests skip by default and use short, bounded prompts.

Slice 7 should add `test/codex-app-server-smoke.test.ts` gated by:

```sh
RUN_CODEX_APP_SERVER_SMOKE=1
```

The first live smoke should stay small:

- verify `codex app-server --listen stdio://` is available through
  `orchestrator launch codex-app-server`;
- ask for one exact short answer;
- wait for terminal success;
- assert `read` returns the expected answer;
- assert provider metadata includes `threadId` and `turnId`;
- assert normalized app-server events exist;
- assert usage when emitted, but do not fail the smoke solely because usage is
  absent unless live Codex reliably emits it.

Interrupt smoke can be a second opt-in test, but should not be the first live
gate unless it proves reliable.

## Bottlenecks To Document

- Per-task app-server startup cost may be noticeable.
- The app-server protocol is still an active surface and can change.
- Token usage timing depends on when Codex emits `thread/tokenUsage/updated`.
- There is no app-server pooling yet.
- We are using ephemeral threads first.
- We are not exposing app-server protocol config as custom-agent config yet.
- Goals and steering are intentionally out of this slice.

## Recommendation

Treat Slice 7 as a product-integrity slice, not new architecture. Build small
tests and docs around the existing implementation:

1. Add fake-server live-usage mode.
2. Add `ps` / `ps --watch` token assertions for `codex-app-server`.
3. Add events/logs assertions for normalized user-facing behavior.
4. Add README or doc explanation for `codex` vs `codex-app-server`.
5. Add skipped-by-default live smoke.
6. Document bottlenecks.
