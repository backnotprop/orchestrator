# Spec: Managed Codex App-Server Backend

Date: 2026-07-05

## Intent

Make `codex-app-server --session` work for normal Codex installs by replacing
the `codex app-server daemon start` dependency with an Orchestrator-managed
Unix-socket app-server process.

## Scope

Implement the backend startup and reuse layer for persistent Codex sessions.

In scope:

- explicit socket override still works
- managed backend starts with `codex app-server --listen unix://PATH`
- backend is reused across multiple session tasks
- concurrent session launches do not start duplicate backends
- stale pid/socket state is recovered
- startup failures show useful logs/errors
- existing session task behavior remains unchanged

Out of scope:

- app-server pooling UI
- public protocol custom-agent config
- remote WebSocket app-server support
- no-wait operation monitoring changes
- stopping the backend automatically when the last session closes
- replacing one-shot stdio `codex-app-server`

## User Behavior

This should work without a standalone Codex install:

```sh
orchestrator launch codex-app-server --session --name "codex session" --json --compact
orchestrator send <task-id> --wait --json --compact "Say hello."
orchestrator goal start <task-id> --wait --json --compact "Finish a small goal."
orchestrator interrupt <task-id> --json --compact --reason "done"
```

Interrupting a session task stops that Orchestrator task/thread relationship. It
does not kill the shared app-server backend.

## Backend Metadata

Add an internal backend record:

```ts
type CodexAppServerBackendRecord = {
  schemaVersion: 1;
  executable: string;
  socketPath: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
};
```

Store it under:

```text
<orchestrator-dir>/providers/codex-app-server/backend.json
```

Use log files:

```text
<orchestrator-dir>/providers/codex-app-server/app-server.stdout.log
<orchestrator-dir>/providers/codex-app-server/app-server.stderr.log
```

Use a startup lock:

```text
<orchestrator-dir>/providers/codex-app-server/startup.lock
```

Use a short socket path under the OS temp directory:

```text
<tmp>/orchestrator-codex-<hash>/app-server.sock
```

The hash should be derived from the resolved Orchestrator store path. This keeps
one backend per store and avoids Unix socket path length limits.

## Controller Changes

Change `ensureCodexAppServer` so it no longer shells out to
`codex app-server daemon start` by default.

New behavior:

1. If `socketPath` is passed, return `{ socketPath, managed: false }`.
2. Resolve backend paths from `orchestratorDir` or store options.
3. Check existing backend metadata.
4. If pid is alive and socket initializes, return it.
5. Acquire the backend startup lock.
6. Re-check health.
7. Remove stale socket file and stale metadata.
8. Spawn:

   ```sh
   codex app-server --listen unix://<socketPath>
   ```

9. Detach/unref the process so it can outlive the CLI command.
10. Capture stdout/stderr to backend logs.
11. Poll the socket until `initialize` succeeds or startup times out.
12. Persist backend metadata.
13. Return `{ socketPath, pid, managed: true }`.

Extend endpoint metadata:

```ts
type CodexAppServerEndpoint = {
  socketPath: string;
  pid?: number;
  managed?: boolean;
  startedAt?: string;
  logPath?: string;
};
```

## Session Task Changes

`launchSharedCodexAppServerSessionTask` should pass enough store information to
the controller so the backend can be keyed by Orchestrator store.

Session task records should continue to store:

- provider thread id
- provider transport `unix`
- supervision kind `provider`
- socket path

Optionally include backend pid in provider supervision if useful:

```ts
supervision: {
  kind: "provider";
  provider: "codex";
  transport: "unix";
  socketPath: string;
  backendPid?: number;
  startedAt: string;
  staleAfterMs: number;
  lastVerifiedAt: string;
}
```

Do not make the session task status depend on the backend process status alone.
The session task represents one Codex thread, not the whole app-server backend.

## Health Check

Backend health should mean:

- pid is alive, if pid is known
- socket path accepts a WebSocket connection
- JSON-RPC `initialize` succeeds

If pid is alive but socket cannot initialize, treat the backend as unhealthy and
restart after acquiring the lock.

If socket exists but no process is reachable, remove it as stale.

## Errors

Startup failure should say what happened and where logs are:

```text
Failed to start Codex app-server at <socketPath>.
Run logs command or inspect <stderr-log-path>.
```

If spawning `codex` fails, include the executable name and the original spawn
message.

Do not tell users to install standalone Codex unless we have explicitly tried a
daemon path. The default path should not require it.

## Tests

Add unit/integration tests for:

- explicit socket path still bypasses backend spawn
- backend manager spawns `codex app-server --listen unix://PATH`
- backend manager reuses a healthy pid/socket
- two concurrent `ensureCodexAppServer` calls spawn one backend
- stale socket file is removed and replaced
- stale pid metadata is ignored
- startup failure returns a useful error and log path
- CLI `launch codex-app-server --session` works with a fake app-server
  executable using the managed backend path
- multiple session tasks share the same backend socket and get different
  provider thread ids

## Implementation Notes

Use `spawn`, not `execFile`, for the managed backend process.

Use `detached: true` and `child.unref()` so the app-server survives the launch
command. Redirect output to backend log files instead of inheriting stdio.

Use existing `connectCodexAppServer` for readiness checks. That keeps the
readiness test aligned with real session use.

Keep the test fake small. It only needs to bind the socket, accept initialized
JSON-RPC WebSocket connections, and support the methods used by session launch.

## Follow-Up

After this lands, separately revisit no-wait `send` and steering. The smoke test
showed that long-running no-wait session operations need a clear monitoring
story. That is separate from making backend startup work across Codex installs.
