# Spec: Parent Agent Wait and Durable Run

Date: 2026-06-18

## Intent

Orchestrator should let the parent AI agent launch child agents and keep working
with their results. Right now the parent can launch a child and then answer
immediately. That is useful for "fire and report the task id", but not enough
for "launch a child, wait for it, then summarize what it found."

The next design should copy the useful part of Claude Code's background task
model without copying its whole Monitor system. Waiting should happen inside the
host runtime, not through model-written sleep loops or repeated manual polling.

## Research Summary

The Claude Code research found this pattern:

1. Long-running work becomes a task.
2. The task gets an id and output files.
3. The host keeps updating task state.
4. The host can notify the model when task state changes.
5. Monitor is for streaming events, not for ordinary "wait until done."

For Orchestrator, the practical first move is not a Monitor clone. It is
host-side waiting on `read_agent`.

## Current Orchestrator Shape

The current parent package exposes:

- `launch_agent`
- `list_agents`
- `read_agent`
- `read_agent_events`
- `read_agent_logs`
- `interrupt_agent`

`launch_agent` starts a child through the core task supervisor and returns a
task id. The task supervisor already writes:

- `task.json`
- `stdout.log`
- `stderr.log`
- `events.jsonl`
- `transcript.jsonl`
- `result.md`

That means the task store is already enough to support waiting. The wait code
does not need access to the live child process. It can read `task.json` until
the status becomes terminal, then read `result.md`.

## Slice 1: Add Waiting To `read_agent`

Extend the existing parent-agent read tool:

```text
read_agent(taskId, wait?, timeoutMs?, maxBytes?)
```

Purpose:

- let the parent wait for a child task to finish;
- return a bounded final result when done;
- return current task state on timeout;
- keep waiting out of model-authored bash or sleep loops.

Parameters:

```ts
{
  taskId: string
  timeoutMs?: number
  maxBytes?: number
}
```

Result:

```ts
{
  retrievalStatus: "completed" | "timeout";
  task: TaskSummary;
  output: string;
}
```

Use `retrievalStatus: "completed"` when the task reaches `succeeded`,
`failed`, `cancelled`, or `timed_out`. The task status still tells the parent
what actually happened.

Use `retrievalStatus: "timeout"` when `read_agent` stops waiting before the
child is terminal. Return the current task summary and whatever bounded output
is available.

Defaults:

- `timeoutMs`: 300000
- max `timeoutMs`: 600000
- poll interval: 250ms
- `maxBytes`: same default as `read_agent`

This deliberately keeps the tool surface small. Do not add a separate
`wait_agent` tool and do not add `launch_agent({ wait: true })` in the first
pass.

## Core Implementation

Add a core helper, likely in `packages/core/src/tasks/wait.ts`:

```ts
waitForTask(input: {
  workspaceRoot: string
  orchestratorDir?: string
  taskId: string
  timeoutMs?: number
  intervalMs?: number
}): Promise<{
  retrievalStatus: "completed" | "timeout"
  task: AgentTaskRecord
}>
```

Behavior:

- read the task record;
- if already terminal, return immediately;
- otherwise sleep inside the host process and reread `task.json`;
- stop when the task is terminal or timeout expires;
- do not throw on timeout;
- do throw for missing task or malformed task record, matching existing read
  behavior.

This helper should work when the child was launched by a detached CLI process.
It must not depend on the in-memory `runningTasks` map.

Export it from `packages/core/src/tasks/index.ts`.

## Parent Tool Implementation

In `packages/agent/src/tools.ts`:

- import `waitForTask`;
- add `wait`, `timeoutMs`, and `maxBytes` handling to `createReadAgentTool`;
- reuse `summarizeTask`;
- read bounded output with `readTaskOutput` after waiting;
- return JSON details the same way the existing tools do.

The tool prompt should be plain:

```text
read_agent reads a child agent result. Use wait: true when you need the child
agent's answer before you respond.
```

Update `packages/agent/src/instructions.ts`:

- explain `read_agent`'s `wait: true` option;
- tell the parent to use it when it needs a child result;
- tell the parent not to claim a child finished unless it has used
  `read_agent` or `list_agents` and seen a terminal status.

## Tests For Slice 1

Add focused automated tests. Do not require live Claude or Codex.

Use the existing disabled `shell` runtime with an allowlisted command.

Test cases:

1. Tool registration still exposes the lean Orchestrator tool set.
2. `read_agent({ wait: true })` waits for a fast child and returns `retrievalStatus:
"completed"` plus the child output.
3. `read_agent({ wait: true })` times out for a slow child and returns `retrievalStatus:
"timeout"` with a non-terminal task status.
4. The parent session starts with only Orchestrator tools, now including
   the updated `read_agent` contract.

This is enough to prove the behavior without spending money or relying on
provider CLIs.

## Slice 2: Make Parent Runs Durable

After `wait_agent`, make `orchestrator run` itself manageable.

Today `orchestrator run` creates a parent session, sends one prompt, prints the
last assistant text, disposes the session, and exits.

Add a way to run the parent as a task:

```sh
orchestrator run --background "Figure out what needs to change."
```

Expected output:

```text
taskId: <id>
status: running
runtime: orchestrator
```

The parent task should be readable through the existing task commands:

```sh
orchestrator list
orchestrator watch <task-id>
orchestrator read <task-id>
orchestrator logs <task-id> --follow
orchestrator interrupt <task-id>
```

Implementation approach:

- launch the parent run through the existing task supervisor when
  `--background` is used;
- use an internal CLI entrypoint like `__run-parent-task`;
- write the parent final answer to `result.md`;
- keep stdout/stderr/event capture consistent with child tasks;
- use runtime id `orchestrator` or `orchestrator-parent`;
- add optional task metadata for `sessionId` and child task ids.

This keeps the first durable parent implementation process-backed, which fits
the current supervisor. We do not need a new task engine for it.

## Parent/Child Links

When a parent launches a child, record the parent id if one exists.

Add optional fields to task records:

```ts
{
  parentTaskId?: string
  childTaskIds?: string[]
  sessionId?: string
}
```

For Slice 1, this can wait. For Slice 2, it matters because list/watch should
eventually show which children belong to a parent run.

Do not build group dashboards yet. Just persist the relationship.

## Later: Notifications

Claude Code can feed task completion notifications back into the model loop.
That is useful, but not required before `wait_agent`.

Later, Orchestrator can add:

- child-completed events addressed to a parent task;
- a compact notification injected into the parent session;
- automatic continuation after a child completes.

That is the path toward a richer always-on coordinator. It should not block the
next implementation slice.

## Later: Monitor

Keep Monitor separate.

Monitor means streaming events from a running thing. Waiting for a child agent
to complete is not Monitor.

Possible future tools:

```text
monitor_agent_events(taskId)
monitor_command(command)
```

Do not build these until the CLI/TUI needs live event streaming inside a parent
model session.

## Non-Goals

Do not add:

- hidden worker recipes;
- required structured child output;
- a new plugin system;
- a full TUI;
- token dashboard work;
- a general Monitor clone;
- model-authored sleep or poll loops.

## Expected User Experience

This should work after Slice 1:

```sh
orchestrator run \
  'Launch a Codex child using model gpt-5.4-mini. Name it "hello demo".
   Ask it to say hello in one sentence. Wait for it, then tell me what it said.'
```

Expected behavior:

1. Parent calls `launch_agent`.
2. Parent receives a child task id.
3. Parent calls `read_agent` with `wait: true`.
4. Child finishes.
5. Parent answers with the child result.

This should work after Slice 2:

```sh
orchestrator run --background "Investigate this repo and launch children as needed."
orchestrator watch <parent-task-id>
orchestrator read <parent-task-id>
```

## Open Decisions

- Should the parent runtime id be `orchestrator` or `orchestrator-parent`?
- Should `read_agent` waiting default to 5 minutes, or should it inherit the
  child task timeout when one exists?
- Should foreground `orchestrator run` also create a task record, or only
  `--background` runs at first?
- Should timeout from `wait_agent` include recent events by default, or only the
  current task summary and output tail?

## Recommended Build Order

1. Core `waitForTask`.
2. Parent `read_agent` wait option.
3. Parent instruction update.
4. Automated tests with shell runtime.
5. Live smoke test with parent launching Codex `gpt-5.4-mini`.
6. Then design/implement `orchestrator run --background`.
