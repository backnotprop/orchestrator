# Research Spike: Managed Codex App-Server Backend

Date: 2026-07-05

## Question

Should Orchestrator require `codex app-server daemon start` for
`codex-app-server --session`, or should it manage its own
`codex app-server --listen unix://...` process?

## Finding

Orchestrator should manage its own app-server socket process.

The current implementation is too narrow because `ensureCodexAppServer` calls:

```sh
codex app-server daemon start
```

That command failed in live smoke testing with the Homebrew-installed Codex CLI.
Codex reported that the daemon requires the standalone Codex installer layout at
`~/.codex/packages/standalone/current/codex`.

Many users will have Codex installed through Homebrew or another package path.
Requiring the standalone daemon path would make `codex-app-server --session`
fail for those users even though the normal `codex app-server` command works.

## Current Orchestrator Code

Relevant files:

- `packages/core/src/tasks/executors/protocol/codex-app-server-controller.ts`
- `packages/core/src/tasks/shared-codex-app-server-session.ts`
- `test/codex-app-server-controller.test.ts`
- `test/codex-app-server-shared-session.test.ts`

Current behavior:

- Explicit socket override works through
  `ORCHESTRATOR_CODEX_APP_SERVER_SOCKET_PATH`.
- Without that socket, `ensureCodexAppServer` runs
  `codex app-server daemon start`.
- Session tasks persist provider metadata and connect to the returned Unix
  socket.
- Interrupting a session task closes that Orchestrator session task, not the
  shared app-server backend.

This means the control model is right, but backend discovery/startup is wrong.

## Codex Code Findings

Relevant Codex files:

- `~/oss-agents/codex/codex-rs/app-server/src/main.rs`
- `~/oss-agents/codex/codex-rs/app-server-transport/src/transport/mod.rs`
- `~/oss-agents/codex/codex-rs/app-server-transport/src/transport/unix_socket.rs`
- `~/oss-agents/codex/codex-rs/app-server-daemon/src/lib.rs`
- `~/oss-agents/codex/codex-rs/app-server-daemon/src/backend/pid.rs`

Codex app-server supports:

```sh
codex app-server --listen stdio://
codex app-server --listen unix://
codex app-server --listen unix://PATH
codex app-server --listen ws://IP:PORT
```

For Unix sockets:

- `unix://` resolves to Codex's default app-server control socket under
  `CODEX_HOME`.
- `unix://PATH` accepts an explicit socket path.
- Codex prepares a private socket directory.
- Codex removes the socket file on normal shutdown.
- Codex rejects an active socket path that is already in use.

The Codex daemon is a separate lifecycle wrapper. Its own pid backend starts:

```sh
codex app-server --listen unix://
```

But the daemon also checks for a standalone managed Codex binary and errors when
that path is missing. That is the part Orchestrator should not depend on.

## Product Implication

The right default is:

```sh
codex app-server --listen unix://<orchestrator-owned-socket>
```

This gives Orchestrator the same shared app-server shape without inheriting the
standalone installer requirement.

## Design Direction

Use an Orchestrator-owned backend:

1. Keep explicit socket override for tests and advanced users.
2. Resolve a short Orchestrator-owned socket path.
3. Reuse a running backend when the socket and pid are healthy.
4. Spawn `codex app-server --listen unix://PATH` when needed.
5. Wait until the socket accepts an initialized JSON-RPC connection.
6. Store backend metadata in the Orchestrator store.
7. Keep session task interrupt scoped to the Codex thread/session task, not the
   backend process.

Avoid using Codex's default `unix://` socket as the primary Orchestrator path.
It could collide with Codex Desktop, VS Code, remote-control, or another client.
An explicit Orchestrator socket is simpler and easier to reason about.

## Risks

- Unix socket path length limits mean the socket path should live under a short
  temp directory, not under an arbitrarily deep repository path.
- Concurrent `launch --session` calls need a lock so only one backend starts.
- Stale socket files and stale pid metadata must be cleaned up.
- The backend process will outlive individual session tasks. That is expected,
  but it should be visible in docs and eventually controllable.
- This does not solve long-running no-wait session operation monitoring. That is
  a separate issue.

## Recommendation

Replace daemon startup with an Orchestrator-managed Unix-socket app-server
backend. Keep daemon support out of the required path. Treat `daemon start` as a
Codex-specific managed install feature, not the Orchestrator default.
