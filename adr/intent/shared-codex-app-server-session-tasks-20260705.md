# Intent: Shared Codex App Server Session Tasks

Date: 2026-07-05

We want `codex-app-server --session` to use Codex the way an application wrapper
would: one running Codex app-server process, many Codex threads, and one
Orchestrator task per managed thread.[^decision]

The product goal is simple. A human or agent should be able to start a Codex
session, send it normal work, start a native Codex goal on that same session,
read the latest result, watch normalized events, and interrupt that one session
without killing unrelated Codex sessions.[^spec]

This is different from the stable `codex` runtime and from one-shot
`codex-app-server` tasks. `codex` stays the reliable `codex exec` path. One-shot
`codex-app-server "<task>"` stays useful for protocol smoke tests. The session
path is for long-lived Codex threads that Orchestrator can keep managing through
normal CLI commands: `launch --session`, `send`, `goal`, `read`, `events`, `ps`,
and `interrupt`.

The implementation should add the missing shared-server boundary without
turning Orchestrator into a service daemon. It should connect to Codex
app-server over its Unix socket, route JSON-RPC responses and notifications by
thread or turn, store provider metadata on task records, supervise sessions as
provider-backed tasks, and keep existing task commands working against those
records.

This should not add public protocol-agent config, thread pooling knobs, a TUI,
Slack/service deployment, or Codex-specific words to the user-facing control
model. The user-facing model remains: this is a task/session; send it work,
start a goal, read the result, watch events, or stop it.

[^decision]: [ADR 56: Use shared Codex app-server for session tasks](../decisions/0056-use-shared-codex-app-server-for-session-tasks-20260705-132920.md)

[^spec]: [Spec: Shared Codex app-server thread controller](../specs/shared-codex-app-server-thread-controller-20260705-114539.md)
