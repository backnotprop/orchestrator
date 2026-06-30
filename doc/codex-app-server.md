# Codex App Server Runtime

Orchestrator has two Codex runtimes:

- `codex`: the stable headless process runtime backed by `codex exec`.
- `codex-app-server`: the experimental protocol runtime backed by `codex app-server --listen stdio://`.

Use `codex` when you want the normal, stable Codex path. Use `codex-app-server`
when you specifically want to exercise the protocol runtime: provider metadata,
normalized protocol events, provider-side usage when emitted, and protocol-aware
interrupts.

```sh
orchestrator launch codex --name "inspect store" "Inspect the task store."
orchestrator launch codex-app-server --name "protocol smoke" "Reply with hello."
orchestrator ps --watch
```

The app-server runtime should feel like any other runtime through the CLI:

```sh
orchestrator ps
orchestrator ps --json --compact
orchestrator events <task-id> --agent-only
orchestrator logs <task-id>
orchestrator interrupt <task-id>
```

`events --agent-only` shows normalized Orchestrator events such as
`thread.started`, `turn.started`, `agent.message`, `agent.usage`, and
`turn.completed`. `logs` are for diagnostics such as app-server stderr. They are
not intended to be the protocol transcript.

## Live Smoke

The live Codex app-server smoke is skipped by default:

```sh
RUN_CODEX_APP_SERVER_SMOKE=1 node --experimental-strip-types --test test/codex-app-server-smoke.test.ts
```

The smoke launches `codex-app-server`, checks one exact short answer, verifies
provider metadata and normalized events, and checks usage in `ps` only when the
live provider emits usage for that run.

## Current Limits

- Each task starts its own app-server process.
- Protocol details may still change upstream.
- Usage timing is provider controlled; usage may arrive during a turn, at the end, or not at all.
- Threads are ephemeral first. Resume is not implemented.
- There is no app-server pooling yet.
- There is no public protocol custom-agent config yet.
- Goals, steering, and long-running thread control are out of scope for this runtime pass.
