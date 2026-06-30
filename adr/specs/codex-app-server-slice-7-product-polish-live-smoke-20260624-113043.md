# Codex App-Server Slice 7: Product Polish And Live Smoke

Date: 2026-06-24

## Intent

Make `codex-app-server` feel like a normal Orchestrator runtime. Users and
agents should be able to launch it, watch it, inspect events, read logs, read the
final answer, and understand when to use it instead of `codex`.

## Non-Goals

- Do not build app-server pooling.
- Do not add goals, steering, or thread resume.
- Do not expose generic protocol runtime config to custom agents.
- Do not replace the stable `codex` runtime.
- Do not build TUI work in this slice.

## Scope

### 1. Fake Server: Live Usage Mode

Add a fake app-server mode, likely `usage-hang` or `usage-wait`, that:

1. responds to `initialize`, `thread/start`, and `turn/start`;
2. emits `turn/started`;
3. emits `thread/tokenUsage/updated` with `last.totalTokens`;
4. stays running until interrupted.

This lets tests observe token usage while the task is active.

### 2. `ps` And `ps --watch` Token Proof

Add focused CLI coverage proving `codex-app-server` usage appears in operations
views.

Tests should assert:

- `orchestrator ps` shows the runtime row with token value in the `tok` column;
- `orchestrator ps --watch` refresh output includes the token value while the
  task is running;
- `orchestrator ps --json --compact --active` includes `tokens` for the
  `codex-app-server` task when usage has been emitted;
- cleanup uses `interrupt` so no fake server remains running.

This should use fake executable wiring like the existing app-server CLI launch
test.

### 3. Events Stay Useful

Add coverage for:

```sh
orchestrator events <task-id> --agent-only
```

Expected user-facing event names:

- `thread.started`
- `turn.started`
- `agent.usage`
- `agent.message` or `agent.message.delta`
- `turn.completed`

For interrupt scenarios, expected control events:

- `protocol.interrupt.requested`
- `protocol.interrupt.sent`
- `protocol.interrupt.settled` or `protocol.interrupt.fallback_kill`

The command surface should not require users to read raw JSON-RPC protocol
method names. Raw protocol stays in `transcript.jsonl`.

### 4. Logs Stay Understandable

Add a small assertion that normal successful `logs` output contains app-server
stderr diagnostics when present and does not contain raw protocol JSON-RPC
traffic such as `"method":"thread/start"` or `thread/tokenUsage/updated`.

Raw protocol inspection remains available through the task transcript file, not
through normal logs.

### 5. Docs

Update the user-facing docs, probably README plus a short doc if the README would
get too long.

Minimum README change under runtimes:

- `codex`: stable process runtime using `codex exec`;
- `codex-app-server`: experimental protocol runtime using
  `codex app-server --listen stdio://`;
- use `codex` for normal stable headless work;
- use `codex-app-server` when testing richer protocol events, provider metadata,
  token usage, or native app-server control;
- `codex-app-server` remains opt-in/experimental until live smoke is proven.

If a separate doc is added, link it from README.

### 6. Opt-In Live Smoke

Add `test/codex-app-server-smoke.test.ts`.

Gate it with:

```sh
RUN_CODEX_APP_SERVER_SMOKE=1
```

The first live smoke should:

1. skip by default;
2. verify Codex is available, reusing `assertCodexAvailable` if possible;
3. launch `codex-app-server` with a short exact-answer prompt;
4. wait for terminal success;
5. assert `read` returns the expected answer;
6. assert task provider metadata has `threadId` and `turnId`;
7. assert normalized app-server events exist.

Usage assertion should be soft at first:

- if usage is emitted, assert it is visible in task JSON or `ps`;
- if usage is absent, do not fail the smoke until live behavior is proven stable.

Interrupt live smoke can come later or be a second opt-in test if the first live
smoke is stable.

### 7. Bottleneck Notes

Add a short bottleneck section to the app-server docs or update the existing
protocol spec recap.

Document:

- per-task app-server startup cost;
- app-server protocol churn;
- usage event timing;
- no pooling yet;
- ephemeral threads first;
- no public protocol custom-agent config yet;
- goals and steering intentionally out of scope.

## Build Order

1. Add fake-server live-usage mode.
2. Add `ps` / `ps --watch` / compact JSON tests for active app-server usage.
3. Add events/logs tests.
4. Add docs.
5. Add opt-in live smoke.
6. Run focused tests and full `pnpm run check`.

## Acceptance Criteria

- `pnpm run check` passes with fake-server tests only.
- New live smoke is skipped unless `RUN_CODEX_APP_SERVER_SMOKE=1`.
- `codex-app-server` usage appears in `ps` when emitted.
- `codex-app-server` usage appears in `ps --watch` while a fake app-server task
  is still running.
- Compact JSON control output includes task token count when usage exists.
- `events --agent-only` shows normalized app-server events.
- `logs` do not become raw protocol transcript output.
- README or linked docs explain `codex` vs `codex-app-server`.
- Bottlenecks are documented.

## References

- `adr/research/SPIKE-codex-app-server-slice-7-product-polish-live-smoke-20260624-113043.md`
- `adr/research/synthesis-codex-app-server-slice-7-product-polish-live-smoke-20260624-113043.md`
- `adr/specs/protocol-session-adapter-20260624-054713.md`
- `adr/specs/codex-app-server-executor-20260624-084406.md`
- `adr/research/SPIKE-codex-app-server-support-20260624-045625.md`
- `doc/live-agent-view.md`
