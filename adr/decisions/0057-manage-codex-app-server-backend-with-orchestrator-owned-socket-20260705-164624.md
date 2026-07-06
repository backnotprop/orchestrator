# 57. Manage Codex App-Server Backend With Orchestrator-Owned Socket

Date: 2026-07-05

## Status

Accepted

## Context

`codex-app-server --session` is meant to let Orchestrator keep a Codex session
alive, send normal work into it, run native Codex goals, inspect state, and stop
the Orchestrator session task without starting a new app-server for every
operation.

The first shared-session implementation used `codex app-server daemon start` to
find or start the shared backend. Live smoke testing showed that this fails for
the Homebrew-installed Codex CLI because Codex's daemon command requires the
standalone installer layout at `~/.codex/packages/standalone/current/codex`.

That is too narrow for Orchestrator. Many users will install Codex through
Homebrew or another normal CLI path. Codex itself supports
`codex app-server --listen unix://PATH`, and Codex's own daemon ultimately uses
the same app-server Unix-socket transport. The daemon is a managed lifecycle
wrapper, not the only valid way to run a shared app-server.

## Decision

Orchestrator will manage its own Codex app-server backend for persistent session
tasks.

The default backend path for `codex-app-server --session` will be:

```sh
codex app-server --listen unix://<orchestrator-owned-socket>
```

Orchestrator will:

- keep explicit socket override support for tests and advanced users;
- choose a short Orchestrator-owned Unix socket path;
- key the backend by the Orchestrator store;
- acquire a startup lock before spawning;
- reuse a healthy backend when one already exists;
- spawn `codex app-server --listen unix://PATH` when no healthy backend exists;
- wait for the socket to accept an initialized JSON-RPC connection;
- persist backend pid, socket path, executable, and log paths;
- recover from stale pid or socket metadata;
- keep session task interruption scoped to that Orchestrator session task, not
  the shared app-server backend.

Orchestrator will not require `codex app-server daemon start` for the release
path. The Codex daemon may be supported later as an optional external backend,
but it is not the default and not required.

## Consequences

`codex-app-server --session` can work with normal Codex CLI installs, including
Homebrew, as long as `codex app-server --listen unix://PATH` is available.

The app-server backend becomes an internal shared service owned by the
Orchestrator store, while each Orchestrator session task still represents one
Codex provider thread. `send`, `goal`, `read`, `events`, `ps`, and `interrupt`
continue to operate through the existing task model.

The implementation needs a small backend lifecycle layer for startup locking,
socket path selection, stale state cleanup, readiness checks, backend logs, and
metadata persistence. This is a compatibility and reliability fix, not a new
public runtime.

This does not solve long-running no-wait `send` monitoring or steering event
replay. That remains a separate follow-up.
