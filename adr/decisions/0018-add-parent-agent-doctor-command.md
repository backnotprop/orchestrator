# 18. Add parent-agent doctor command

Date: 2026-06-18

## Status

Accepted

## Context

Orchestrator now has two surfaces:

- direct task control through `launch`, `list`, `watch`, `read`, `logs`,
  `events`, and `interrupt`;
- a parent AI agent through `orchestrator run`.

The parent agent depends on provider auth, model config, and session paths. A
failed `run` is hard to understand if the user does not know whether the issue
is missing auth, bad JSON, unusable model config, or simply using the wrong
config directory.

The default parent-agent config is Orchestrator-owned:

```text
~/.orchestrator/auth.json
~/.orchestrator/models.json
~/.orchestrator/sessions/
```

Some users may already have compatible Pi config under `~/.pi/agent`. That is
useful for live testing, but Orchestrator should not silently depend on it.

## Decision

Add a reusable doctor API in `@backnotprop/orchestrator-agent` and expose it
through the CLI:

```sh
orchestrator doctor [--agent-dir <path>] [--session-dir <path>] [--json]
```

The doctor checks:

- parent-agent config directory;
- `auth.json` presence, parseability, obvious credential shape, and provider
  names;
- `models.json` presence and parseability;
- configured parent model count when it can be inspected;
- parent session directory;
- whether a Pi config exists at `~/.pi/agent` as an explicit live-test option.

The doctor command is read-only. It must not create auth files, migrate config,
copy credentials, or mutate sessions. To keep inspection non-destructive, model
inspection uses parsed auth data with Pi's in-memory auth storage instead of
opening auth through Pi's file-backed storage.

Human output should be short and actionable. JSON output should expose the same
report for tests, scripts, and future UI surfaces.

Missing config is a warning, not an error, because the command should guide
setup before the parent agent can run. Malformed config is an error. The CLI
returns exit code 1 only for error reports.

## Consequences

Users can run one command before live testing the parent agent:

```sh
orchestrator doctor
```

If they already have Pi config, the report can suggest an explicit live test:

```sh
orchestrator doctor --agent-dir ~/.pi/agent
orchestrator run --agent-dir ~/.pi/agent "<request>"
```

This keeps the parent-agent setup debuggable without coupling Orchestrator's
default behavior to Pi's config directory.

The same doctor API can later feed a TUI or app settings screen. It should stay
focused on setup health, not become a general system diagnostics framework.
