# 49. Polish Codex App-Server Runtime With Live Smoke

Date: 2026-06-24

## Status

Accepted

## Context

`codex-app-server` is now implemented as the first protocol-backed runtime.
Earlier slices added the task executor boundary, JSON-RPC stdio client, Codex
app-server executor, provider metadata, normalized events, usage persistence,
and native interrupt through `turn/interrupt`.

The remaining gap is product integration. The runtime can execute, but users and
agents still need proof that it behaves like the rest of Orchestrator through
the normal commands: `launch`, `ps`, `read`, `events`, `logs`, and `interrupt`.
The current docs also do not clearly explain when to use stable `codex` versus
experimental `codex-app-server`.

Related references:

- `adr/research/SPIKE-codex-app-server-slice-7-product-polish-live-smoke-20260624-113043.md`
- `adr/research/synthesis-codex-app-server-slice-7-product-polish-live-smoke-20260624-113043.md`
- `adr/specs/codex-app-server-slice-7-product-polish-live-smoke-20260624-113043.md`
- `adr/specs/protocol-session-adapter-20260624-054713.md`
- `adr/specs/codex-app-server-executor-20260624-084406.md`

## Decision

Do a focused Slice 7 integration pass for `codex-app-server`.

This slice will:

- add a fake app-server mode that emits usage and stays running long enough for
  `ps --watch` to observe live tokens;
- prove `codex-app-server` token usage appears in `ps`, `ps --watch`, and
  compact JSON output when usage is emitted;
- prove `events --agent-only` shows normalized app-server events instead of
  making users read raw JSON-RPC traffic;
- prove normal `logs` stay diagnostic and do not become the protocol transcript;
- document `codex` as the stable `codex exec` runtime and `codex-app-server` as
  the experimental protocol runtime backed by
  `codex app-server --listen stdio://`;
- add skipped-by-default live smoke under `RUN_CODEX_APP_SERVER_SMOKE=1`;
- document current bottlenecks: per-task app-server startup, protocol churn,
  usage timing, no pooling yet, ephemeral threads, no public protocol runtime
  config, and goals/steering out of scope.

This slice will not add app-server pooling, goals, steering, thread resume,
remote app-server transport, public protocol custom-agent config, or TUI work.

## Consequences

`codex-app-server` becomes easier to trust as a real Orchestrator runtime
without expanding the architecture. The work stays centered on observable
product behavior and documentation.

The stable `codex` runtime remains the default recommendation for normal
headless Codex work. `codex-app-server` remains experimental until opt-in live
smoke confirms the real app-server behavior across local installs.

The main risks are bounded: live usage timing may vary, app-server protocol
fields may change, and per-task app-server startup may be slower than `codex
exec`. These risks will be documented instead of hidden.
