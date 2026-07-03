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
orchestrator send <task-id> "Focus on failing tests first."
orchestrator launch codex-app-server --session --name "codex session"
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

`send` uses the live task runner. It only works while the app-server task is
still active, and it only means the running task accepted the message. Use
`read`, `watch`, or `events` to see what happens next.

`launch --session` starts an idle persisted app-server thread that can be
managed like a normal Orchestrator task. Sending new work into an idle session
and Codex goal operations are still separate follow-up slices.

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
- Idle session launch exists; idle-session work and goal operations are still follow-up work.
- There is no app-server pooling yet.
- There is no public protocol custom-agent config yet.
- Goals and broader long-running thread control are out of scope for this runtime pass.
