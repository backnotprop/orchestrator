# Intent: Send messages to running Codex app-server tasks

Date: 2026-07-01

We want Orchestrator to let humans and agents send a follow-up instruction to a
running `codex-app-server` task. The user-facing shape should stay simple:

```sh
orchestrator send <task-id|prefix> "Focus on failing tests first."
```

The reason is control. A running agent should not always require a new task just
because the operator wants to narrow scope, correct direction, or add a small
instruction. Codex app-server already has the native capability through
`turn/steer`; Orchestrator should expose that as "send a message to this running
task" instead of making users learn Codex protocol terms.[^adr53]

The implementation should fit the current task model. A later CLI process cannot
directly call the live JSON-RPC client owned by a detached task runner, so the
CLI writes a file-backed control request under the task directory. The detached
runner polls that request, handles it through the live executor, writes a
response, and leaves the files behind as an audit trail.[^spec]

This should be generic at the Orchestrator boundary but narrow in runtime
support. The core API becomes `sendTaskMessage`, the CLI command becomes
`orchestrator send`, and the parent agent gets `send_agent_message`. Only
`codex-app-server` opts in first. Unsupported runtimes should fail clearly.

This does not add sockets, app-server pooling, Codex goals, public protocol
custom-agent config, service mode, or a TUI. Those are separate product
decisions. This slice should make one live-control operation real and reliable
before we widen the architecture.

[^adr53]: [ADR 53: Send messages to running Codex app-server tasks through file-backed control requests](../decisions/0053-send-messages-to-running-codex-app-server-tasks-20260630-234839.md)

[^spec]: [Spec: Send messages to running Codex app-server tasks](../specs/codex-app-server-steering-20260630-232736.md)
