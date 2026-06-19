# SPIKE: Claude Code Monitor and Background Task Capabilities

Date: 2026-06-18

## Question

How does Claude Code keep work moving after it launches long-running commands or
subagents, and what should Orchestrator copy for parent-agent runs?

This spike looked at the local Claude Code checkout at
`/Users/ramos/oss-agents/cc-open`.

## Short Answer

Claude Code does not rely on the model sleeping and polling. It pushes waiting
into the host runtime.

The pattern is:

1. Launch work as a task.
2. Give the task an id and output file.
3. Keep writing logs/transcript/progress to task state.
4. Queue a task notification when the task changes or finishes.
5. Feed that notification back into the model loop as the next input.

`Monitor` is related, but it is not the whole system. From the visible code,
Monitor is for streaming events from a running process. For one-shot "wait until
the job is done", Claude Code prefers background tasks and completion
notifications.

## Evidence

### Bash Sleeps Are Blocked

`tools/BashTool/BashTool.tsx` defines `run_in_background` and detects commands
that start with `sleep N` where `N >= 2`.

Relevant files:

- `tools/BashTool/BashTool.tsx:241`
- `tools/BashTool/BashTool.tsx:318`
- `tools/BashTool/BashTool.tsx:525`

When Monitor is enabled, a blocked sleep tells the model to run blocking work in
the background and use Monitor for streaming events like logs or polling APIs.

The Bash prompt reinforces the same behavior:

- `tools/BashTool/prompt.ts:310`

It says to use Monitor for streaming events, use `run_in_background` for
long-running work, and not poll a background task because a notification will
arrive.

### Background Shell Tasks Own Process State

`tasks/LocalShellTask/LocalShellTask.tsx` registers a background shell task,
keeps an output file, updates status, and queues a task notification when the
process completes, fails, or is killed.

Relevant files:

- `tasks/LocalShellTask/LocalShellTask.tsx:105`
- `tasks/LocalShellTask/LocalShellTask.tsx:180`

It treats `kind: "monitor"` as a display and notification variant. Monitor
completion messages are worded as a stream ending, not as a condition being met.

### The Monitor Module Is Referenced, But Not Present

The local checkout references Monitor modules behind a feature flag:

- `tools.ts:39`
- `tasks.ts:12`
- `Task.ts:6`
- `tasks/types.ts:12`

But the actual `tools/MonitorTool/MonitorTool` and
`tasks/MonitorMcpTask/MonitorMcpTask` files are not present in this checkout.
So the exact Monitor implementation cannot be verified here. The available code
still shows how Monitor is expected to fit:

- a tool named Monitor exists when `MONITOR_TOOL` is enabled;
- a `monitor_mcp` task type exists;
- local shell tasks can also be marked as monitor-like with `kind: "monitor"`;
- UI labels count monitors separately from shell commands.

### Notifications Re-Enter the Model Loop

Task notifications go through a shared command queue:

- `utils/messageQueueManager.ts:41`
- `utils/messageQueueManager.ts:142`

The model loop drains queued task notifications before the next model call:

- `query.ts:1550`

Notifications are scoped. The main session receives unscoped notifications.
Subagents only receive task notifications addressed to their own agent id.

This is the key design point. The model does not need to run `sleep`, and it
does not need to keep manually checking task state. The host runtime wakes the
conversation up with a task event.

### Background Agents Use The Same Shape

Claude Code's agent tool supports `run_in_background`:

- `tools/AgentTool/AgentTool.tsx:84`

The agent prompt tells the model it will be notified when a background agent
finishes and should not sleep or poll:

- `tools/AgentTool/prompt.ts:202`

The async agent lifecycle streams messages, updates progress, completes the
task, and queues a final notification with usage:

- `tools/AgentTool/agentToolUtils.ts:505`
- `tools/AgentTool/agentToolUtils.ts:624`

Usage includes token count, tool count, and duration when available.

### The Main Session Can Be Backgrounded Too

`tasks/LocalMainSessionTask.ts` shows a separate pattern for backgrounding the
main session itself. The task keeps running, writes an isolated transcript,
tracks token/tool progress, and sends a notification on completion.

Relevant files:

- `tasks/LocalMainSessionTask.ts:1`
- `tasks/LocalMainSessionTask.ts:94`
- `tasks/LocalMainSessionTask.ts:338`
- `tasks/LocalMainSessionTask.ts:471`

This matters for Orchestrator because our current `orchestrator run` starts a
parent AI session, waits for one parent response, prints the response, and exits.
It is not yet a durable parent task that can be watched, interrupted, or
foregrounded later.

### There Is A Host-Side Wait Primitive

`tools/TaskOutputTool/TaskOutputTool.tsx` is deprecated, but it is still useful
as a design reference. It accepts:

- `task_id`;
- `block`, default `true`;
- `timeout`, default `30000`, max `600000`.

It waits in host code until the task is no longer running or pending, then
returns task status and output.

Relevant files:

- `tools/TaskOutputTool/TaskOutputTool.tsx:30`
- `tools/TaskOutputTool/TaskOutputTool.tsx:117`
- `tools/TaskOutputTool/TaskOutputTool.tsx:172`

This is not a model-level sleep loop. It is a normal tool call that blocks in
the host runtime.

## Current Orchestrator Gap

Our parent agent currently exposes these tools:

- `launch_agent`
- `list_agents`
- `read_agent`
- `read_agent_events`
- `read_agent_logs`
- `interrupt_agent`

Relevant files:

- `packages/agent/src/tools.ts:108`
- `packages/agent/src/tools.ts:123`

`launch_agent` launches a child task in the background and returns its task id.
The parent can then choose to respond immediately, which is what happened in the
live test.

`orchestrator run` currently prompts the parent session once and prints the last
assistant text:

- `packages/cli/src/cli.ts:799`

So yes: today the parent can fire a child and exit. It does not have a clean
"wait for this child to finish, then continue" tool yet. It also is not itself
stored as a task in the Orchestrator task store.

## Recommendation

Do not build a general Monitor clone first.

Build the smaller thing Orchestrator needs:

### 1. Add `wait_agent`

Add a parent-agent tool:

```text
wait_agent(taskId, timeoutMs?)
```

Behavior:

- waits in host code until the child task reaches a terminal status;
- returns the same shape as `read_agent`: task summary plus bounded output;
- times out cleanly and returns current task status;
- does not use shell sleep;
- does not require the child agent to emit structured output.

This gives the parent the missing ability to launch a Codex or Claude child,
wait for the result, and answer the user in the same parent run.

### 2. Keep `launch_agent` Background-First

`launch_agent` should continue to return quickly. That is the core product
behavior. The parent chooses whether to:

- launch and report the task id;
- launch several agents and wait for selected ones;
- launch, inspect logs/events, and interrupt if needed.

### 3. Make Parent Runs Durable

Add a parent-task record for `orchestrator run`.

The parent task should have:

- task id;
- prompt/name;
- status;
- session id;
- transcript path;
- stdout/stderr/log paths if useful;
- child task ids launched by that parent;
- final answer.

Then the CLI can support:

```sh
orchestrator run --background "..."
orchestrator watch <parent-task-id>
orchestrator read <parent-task-id>
orchestrator interrupt <parent-task-id>
```

Foreground `orchestrator run` can still exist. The important change is that the
parent run becomes a managed task, not just a one-shot CLI call.

### 4. Add Notifications Later

After `wait_agent`, add a task notification path if we want the parent to stay
alive without blocking a tool call.

That would mean:

- child task finishes;
- Orchestrator appends a child-completed event;
- parent session receives a compact notification;
- parent model continues from that notification.

This is closer to Claude Code's behavior, but it is a bigger step than we need
for the next implementation slice.

### 5. Keep Monitor Separate

Monitor should mean "stream events from a running thing," not "wait until an
agent is done."

For Orchestrator, possible future monitor tools are:

```text
monitor_agent_events(taskId)
monitor_command(command)
```

Do not add these until we have a concrete user need. For parent-child agent
coordination, `wait_agent` is simpler and better.

## Expected Outcome

After the next slice, this should work:

1. User runs `orchestrator run "Launch a Codex mini child, wait for it, then tell
me what it said."`
2. The parent calls `launch_agent`.
3. The parent calls `wait_agent`.
4. The child finishes.
5. The parent reads the bounded result and answers.

That directly fixes the current behavior where the parent can launch a child and
exit before doing anything else.

## Open Questions

- Should `wait_agent` default to a short timeout, like 30 seconds, or a longer
  timeout that matches child task timeouts?
- Should `launch_agent` support `wait: true` as sugar, or should waiting stay a
  separate explicit tool?
- Should parent tasks live in the same task store as child agents or in a
  parent-specific store linked by task ids?
- When parent tasks are durable, do we need a `resume run` command or just
  `watch/read/interrupt` first?

## Decision Pressure

The clean next decision is:

> Add a host-side `wait_agent` tool and make parent runs durable tasks before
> attempting a full Monitor-style event streamer.

That gives Orchestrator the same practical coordination behavior without
building the larger live-monitoring system prematurely.
