# Synthesis: Managed Codex App-Server Backend

Date: 2026-07-05

## Conclusion

The shared-session architecture is right, but the startup mechanism needs to
change before release.

`codex-app-server --session` should not require `codex app-server daemon start`.
That daemon path is tied to Codex's standalone managed install. Orchestrator
should instead start and reuse a normal app-server process with:

```sh
codex app-server --listen unix://<orchestrator-owned-socket>
```

This matches Codex's public app-server transport model and works with normal CLI
installs such as Homebrew.

## What Stays

- One Codex app-server backend can own many provider threads.
- Each Orchestrator session task maps to one Codex provider thread.
- `send`, `goal`, `read`, `events`, `ps`, and `interrupt` keep using the same
  task model.
- Explicit socket override remains useful for tests and advanced users.
- One-shot `codex-app-server` over stdio remains unchanged.

## What Changes

The controller becomes responsible for backend lifecycle:

- choose a short socket path
- acquire a startup lock
- connect to an existing backend if healthy
- spawn app-server if missing
- wait for readiness
- persist backend pid/socket metadata
- recover from stale pid/socket state

The session task does not own the backend process directly. The backend is a
shared local service for that Orchestrator store.

## Preferred Boundary

Add a small backend manager under the protocol executor boundary, probably near:

```text
packages/core/src/tasks/executors/protocol/codex-app-server-controller.ts
```

or split into:

```text
packages/core/src/tasks/executors/protocol/codex-app-server-backend.ts
```

Keep the public session/task API unchanged. This should be an internal backend
startup change, not a new user-facing runtime.

## Socket Path

Use a short path under the OS temp directory, keyed by the Orchestrator store.
Do not put the socket directly under a deep workspace path.

Example shape:

```text
/tmp/orchestrator-codex-<hash>/app-server.sock
```

Persist metadata under the Orchestrator store:

```text
<orchestrator-dir>/providers/codex-app-server/backend.json
<orchestrator-dir>/providers/codex-app-server/app-server.stderr.log
<orchestrator-dir>/providers/codex-app-server/startup.lock
```

## Startup Algorithm

1. If an explicit socket path is provided, use it and do not spawn anything.
2. Read backend metadata if present.
3. If pid and socket are healthy, return that endpoint.
4. Acquire a startup lock.
5. Re-check health after acquiring the lock.
6. Remove stale socket metadata if needed.
7. Spawn:

   ```sh
   codex app-server --listen unix://<socket>
   ```

8. Redirect stdout/stderr to backend logs.
9. Wait for the socket to accept a JSON-RPC initialize handshake.
10. Persist pid, socket path, executable, and start time.
11. Return the endpoint.

## What Not To Do

- Do not require the standalone Codex installer.
- Do not use Codex's default `unix://` socket as the primary path.
- Do not make every session task start its own app-server.
- Do not expose public protocol custom-agent config in this slice.
- Do not solve no-wait operation monitoring here.

## Decision Readiness

This is ready to spec and implement as a focused compatibility and lifecycle
fix. It removes a release blocker without changing the higher-level session
model.
