# 1. Use Host-Side Waiting Reads for Parent Agent Coordination

Date: 2026-06-18

## Status

Accepted

## Context

Orchestrator has a Pi-backed parent AI agent and a core task runtime for
launching child agents. The parent can already call tools such as
`launch_agent`, `list_agents`, `read_agent`, `read_agent_events`,
`read_agent_logs`, and `interrupt_agent`.

The current gap is coordination. The parent can launch a child agent and return
the child task id, but it does not yet have a clean way to wait for that child
to finish before answering the user.

Research into Claude Code showed the right pattern: long-running work is owned
by the host runtime as a task. The model should not write sleep loops or poll
manually. The host waits on task state, writes logs/results, and gives the model
bounded task output when needed.

Claude Code's Monitor capability is adjacent but different. Monitor is for
streaming events from a running process. The behavior Orchestrator needs first
is simpler: wait for a child task to reach a terminal status, then read its
result.

The first spec proposed a separate `wait_agent` tool. After discussion, the
cleaner shape is to keep the tool surface smaller and add waiting behavior to
`read_agent`.

## Decision

The parent agent loop stays Pi-owned:

```text
orchestrator run "<request>"
  -> create parent AI session
  -> Pi runs model/tool/model loop
  -> parent calls Orchestrator tools
  -> Orchestrator core launches, reads, waits on, and interrupts child tasks
  -> parent answers user
```

Orchestrator will add host-side waiting to `read_agent` instead of adding a
separate `wait_agent` tool.

The parent-facing tool shape becomes:

```ts
read_agent({
  taskId: string
  wait?: boolean
  timeoutMs?: number
  maxBytes?: number
})
```

When `wait` is omitted or false, `read_agent` keeps its current behavior: read
the task's current/final output with bounds.

When `wait` is true, Orchestrator core waits inside the host process until the
task reaches a terminal status or the timeout expires. It then returns:

```ts
{
  retrievalStatus: "completed" | "timeout";
  task: TaskSummary;
  output: string;
}
```

The child task status still carries the real outcome:

- `succeeded`
- `failed`
- `cancelled`
- `timed_out`
- or a non-terminal status when the read timed out

Waiting must be implemented in core against durable task files, not against the
in-memory process map. It must work for tasks launched by detached CLI workers.

Add a core helper equivalent to:

```ts
waitForTask({
  workspaceRoot,
  orchestratorDir,
  taskId,
  timeoutMs,
  intervalMs,
});
```

This helper reads `task.json`, waits in host code, and returns the latest task
record. It does not use shell sleep, does not require provider-specific output,
and does not require the child agent to emit structured results.

The parent prompt should tell the model:

- use `launch_agent` to start child work;
- use `read_agent` with `wait: true` when the user needs the child result before
  the parent answers;
- do not claim a child is finished unless task state shows a terminal status.

Durable parent runs are the next step, not part of this immediate decision.
After this decision is implemented, Orchestrator should separately make
`orchestrator run --background` a managed task that can be watched, read, and
interrupted like child agents.

Monitor-style event streaming is also deferred. It should only be added when we
need live event streams inside a parent model session.

## Consequences

The parent agent can run the useful loop:

```text
launch_agent
read_agent({ wait: true })
answer user
```

That fixes the immediate live-test issue where the parent launched a child and
exited after reporting the task id.

The tool surface stays small. The parent does not need both `wait_agent` and
`read_agent`; it uses one read tool with an explicit wait option.

The implementation remains generic. Claude Code, Codex, and custom agents all
work the same way because the wait layer watches Orchestrator task records, not
provider-specific APIs.

The CLI and future TUI keep the same task model. Child agents remain normal
tasks with `task.json`, logs, events, transcript, and result files.

The main tradeoff is that this is not yet notification-driven. A parent must
choose to wait during a tool call. Automatic continuation after child completion
can come later, once parent runs themselves are durable tasks.
