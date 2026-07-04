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
orchestrator resume <task-id> "Continue from the prior task."
orchestrator launch codex-app-server --session --name "codex session"
orchestrator send <task-id> --wait "Focus on failing tests first."
orchestrator goal start <task-id> --wait "Improve performance across the app by 10%."
orchestrator send <task-id> --wait "Summarize what changed."
orchestrator events <task-id> --agent-only
orchestrator logs <task-id>
orchestrator interrupt <task-id>
```

`events --agent-only` shows normalized Orchestrator events such as
`thread.started`, `turn.started`, `agent.message`, `agent.usage`, and
`turn.completed`. `logs` are for diagnostics such as app-server stderr. They are
not intended to be the protocol transcript.

Resume uses the stored Codex `provider.threadId`. Each resume creates a new
Orchestrator task linked to the source task, while Codex app-server continues
the provider thread internally.

`launch --session` starts an idle persisted app-server thread that can be
managed like a normal Orchestrator task. `send` can give work to an idle
session, or add a follow-up instruction while a regular turn is already
running. Use `send --wait` when you need the operation result before moving on.
`goal start` starts a native Codex goal operation on that running session. Use
`goal start --wait` when Orchestrator should wait for Codex to report a terminal
goal state before moving on.

Each completed turn leaves the session running and returns it to idle. `read`
returns the latest completed operation result. Completed goal operations also
return the session to idle. `interrupt` stops the whole session.

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
- Older app-server tasks created before durable threads may fail to resume.
- Native goal support currently starts goals on idle persistent sessions.
- There is no app-server pooling yet.
- There is no public protocol custom-agent config yet.
- `goal get`, `goal set`, and `goal clear` are not public CLI commands yet.
