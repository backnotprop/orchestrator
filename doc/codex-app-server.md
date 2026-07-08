# Codex App Server Runtime

Orchestrator has two Codex runtimes:

- `codex`: the stable headless process runtime backed by `codex exec`.
- `codex-app-server`: the protocol runtime backed by Codex app-server.

Use `codex` for short, one-shot Codex tasks where a single prompt should finish
the work. Use `codex-app-server --session` for meaningful or long-running Codex
work, especially when the task may need follow-up messages, native Codex goals,
steering while a turn is active, provider metadata, or closer observation.

`codex-app-server` has two modes:

- One-shot tasks run `codex app-server --listen stdio://` for a single task.
- `--session` tasks use an Orchestrator-managed
  `codex app-server --listen unix://<socket>` backend. Each Orchestrator
  session task is one Codex provider thread.

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
orchestrator launch codex-app-server --session --name "codex session" --json --compact --brief
orchestrator send <task-id> --wait --json --compact "Focus on failing tests first."
orchestrator goal start <task-id> --wait --json --compact "Improve performance across the app by 10%."
orchestrator goal get <task-id> --json --compact
orchestrator goal set <task-id> --status paused --json --compact
orchestrator goal clear <task-id> --json --compact
orchestrator send <task-id> --wait --json --compact "Summarize what changed."
orchestrator events <task-id> --agent-only
orchestrator logs <task-id>
orchestrator interrupt <task-id> --json --compact --reason "session complete"
```

Do not set a goal token budget by default. Native goals are open-ended provider
work, and guessing a budget upfront can stop useful work early. Use
`--token-budget` only when you intentionally want a hard cap.

For agents, the normal persistent-session recipe is:

1. Launch `codex-app-server --session`.
2. Capture the returned `taskId` or `id`.
3. Use `send --wait` for normal work in that session.
4. Use `goal start --wait` only for native Codex goals.
5. Usually omit `--token-budget` on `goal start`.
6. Use `goal get`, `goal set`, or `goal clear` to inspect or edit provider goal
   state without starting work.
7. Use another `send --wait` for follow-up work after the goal completes.
8. Interrupt the session when it is no longer needed.

Do not simulate native goals by sending prompt text. If the next step depends on
the result, use `--wait` and parse the compact JSON response.

`events --agent-only` shows normalized Orchestrator events such as
`thread.started`, `turn.started`, `agent.message`, `agent.usage`, and
`turn.completed`. `logs` are for diagnostics such as app-server stderr. They are
not intended to be the protocol transcript.

Resume uses the stored Codex `provider.threadId`. Each resume creates a new
Orchestrator task linked to the source task, while Codex app-server continues
the provider thread internally.

`launch --session` starts or reuses the Orchestrator-managed Codex app-server
backend and creates an idle persisted provider thread that can be managed like a
normal Orchestrator task. `send` can give work to an idle session, or add a
follow-up instruction while a regular turn is already running. Use `send
--wait` when you need the operation result before moving on. `goal start` starts
a native Codex goal operation on that running session. Use `goal start --wait`
when Orchestrator should wait for Codex to report a terminal goal state before
moving on. `goal get`, `goal set`, and `goal clear` inspect or edit provider
goal state. `goal set --status active` is rejected; use `goal start` when Codex
should actively work on a goal. Avoid `--token-budget` unless you deliberately
want Codex to stop at a hard token cap.

Each completed turn leaves the session running and returns it to idle. `read`
returns the latest completed operation result. Completed goal operations also
return the session to idle. `interrupt` stops that Orchestrator session task. It
does not stop the shared Codex app-server backend or unrelated session tasks.

## Live Smoke

The live Codex app-server smoke is skipped by default:

```sh
RUN_CODEX_APP_SERVER_SMOKE=1 node --experimental-strip-types --test test/codex-app-server-smoke.test.ts
```

The smoke launches `codex-app-server`, checks one exact short answer, verifies
provider metadata and normalized events, and checks usage in `ps` only when the
live provider emits usage for that run.

## Current Limits

- One-shot tasks still use their own stdio app-server process.
- `--session` tasks use an Orchestrator-managed shared app-server backend and
  one provider thread per Orchestrator task.
- Protocol details may still change upstream.
- Usage timing is provider controlled; usage may arrive during a turn, at the end, or not at all.
- Older app-server tasks created before durable threads may fail to resume.
- Native goal support starts goals on idle persistent sessions.
- There is no public backend management surface; Orchestrator starts and reuses
  the app-server backend internally.
- There is no public protocol custom-agent config yet.
