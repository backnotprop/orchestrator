# Intent: No-Wait Codex App-Server Session Operation Monitoring

Date: 2026-07-06

We want Codex app-server sessions to stay useful when a human or agent starts
work without waiting at the terminal.[^decision]

The expected product behavior is simple. If someone sends work to a running
Codex session, or starts a Codex goal on that session, Orchestrator should keep
watching that operation after the command returns. `ps`, `events`, `read`, and
token usage should continue to update without requiring the user or parent agent
to run another command just to wake the task up.[^spec]

This matters because a session task is meant to feel like one managed agent
session, not a loose handle to provider state. A user should be able to start a
long-running operation, leave it alone, and trust Orchestrator to record what
happened.

The implementation should update the existing session task. It should not create
a second task for the monitor. The monitor should rejoin the Codex provider
thread, listen for provider notifications, reconcile missed state through
provider reads, update normalized task state, and return the session to `idle`
when the operation completes.

CLI no-wait commands should start a detached internal monitor. Parent-agent
tools and future service or TUI hosts should call the same core monitor
in-process. That keeps one behavior across human CLI use, agent-driven use, and
future interfaces.

This does not add pooling, public protocol custom-agent config, TUI work, or a
new task model. The user-facing model remains: start a session, send it work,
start a goal, watch it, read it, or stop it.

[^decision]: [ADR 58: Monitor no-wait Codex app-server session operations](../decisions/0058-monitor-no-wait-codex-app-server-session-operations-20260705-234841.md)

[^spec]: [Spec: Codex app-server no-wait operation monitoring](../specs/codex-app-server-no-wait-operation-monitoring-20260705-211822.md)
