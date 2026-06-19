# Multi-Agent Operations View

Date: 2026-06-18

## Intent

Orchestrator already has background agent tasks, a parent agent, and a stable
parent run event stream. The next product layer is the human operations surface:
one place to see many agents, grouped by the parent run that launched them,
updating live like a pod watch.

This spec breaks that work into the next rough slices.

## 1. Persist Parent-Child Linkage

### What

Child tasks launched by `orchestrator run` should remember which parent run
created them.

Add optional metadata to `AgentTaskRecord`:

```ts
type TaskParent = {
  parentRunId: string;
  parentSessionId?: string;
  parentToolCallId?: string;
};
```

Store it as:

```ts
type AgentTaskRecord = {
  // existing fields...
  parent?: TaskParent;
};
```

Also append a task event when the task is created:

```json
{
  "type": "agent_event",
  "data": {
    "kind": "task.parent",
    "parentRunId": "...",
    "parentSessionId": "...",
    "parentToolCallId": "..."
  }
}
```

### Why

The run stream currently knows `runId`, `toolCallId`, and `taskId`, but that
relationship is live-only. If a user opens a watcher after a parent run already
launched children, the watcher needs to group tasks from persisted state.

### How

- Extend `LaunchTaskInput` with optional `parent`.
- Extend `AgentTaskRecord` with optional `parent`.
- Pass parent metadata from `launch_agent` when `orchestrator run` creates a
  child task.
- Keep manual `orchestrator launch` tasks ungrouped.
- Do not infer parentage from task names or prompts.

### Done

- A child launched by the parent has `task.parent.parentRunId`.
- `orchestrator launch ...` tasks do not.
- Existing old task records still read safely with no `parent`.

## 2. Add `orchestrator ps`

### What

Add a human-first process-style view for agent tasks.

Initial command:

```sh
orchestrator ps
```

Output shape:

```text
PARENT  3133aaea  running  2 children
  name                  status     runtime      model          age    tokens   last event
  stream demo            running    codex        gpt-5.4-mini   8s     14.0k    agent.message
  api review             succeeded  claude-code  sonnet         2m     unknown  completed

PARENT  ungrouped
  name                  status     runtime      model          age    tokens   last event
  inbox clean            failed     custom       glm-5.2        3m     unknown  runtime.error
```

### Why

`list` is useful for job ids, but it is not the live operations view. `ps` should
answer: what agents exist, what are they doing, and where do they belong?

### How

- Read all task records.
- Read a bounded tail of each task's `events.jsonl`.
- Build `AgentTaskRow` values:

```ts
type AgentTaskRow = {
  taskId: string;
  name: string;
  status: TaskStatus;
  runtime: string;
  model?: string;
  ageMs: number;
  durationMs?: number;
  usage?: TaskUsage;
  lastEvent?: string;
  parentRunId?: string;
};
```

- Group rows by `parentRunId`.
- Put tasks without parent metadata under `ungrouped`.
- Keep UUIDs available, but do not make UUIDs the main visual anchor.

### Done

- `orchestrator ps` shows a grouped table.
- `--json` returns the same grouped data for scripts.
- `list` keeps its current simple behavior.

## 3. Add `orchestrator ps --watch`

### What

Add a live multi-agent view that refreshes while agents run.

Command:

```sh
orchestrator ps --watch
```

Options:

```sh
orchestrator ps --watch --interval-ms 1000
orchestrator ps --watch --status running
orchestrator ps --watch --runtime codex
orchestrator ps --watch --parent <run-id>
```

### Why

This is the “watch pods updating” experience. It should let a user start a
parent run, leave agents working, and watch the group change without tailing raw
logs.

### How

- Recompute the same `ps` view on an interval.
- Clear/redraw only when stdout is a TTY.
- If stdout is not a TTY, print snapshots separated by a simple delimiter or
  require `--json`.
- Keep the first version simple: no keyboard controls, no full TUI.
- Make Ctrl-C exit cleanly without interrupting agents.

### Done

- Running tasks update status without restarting the command.
- New tasks appear under the right parent group.
- Completed tasks remain visible long enough to understand the run.
- The command does not hide raw logs or events; it points users to those when
  needed.

## 4. Row Data, Tokens, And Last Event

### What

Rows should show useful operational fields:

- name;
- status;
- runtime;
- model, when known;
- age or duration;
- token usage, when known;
- last event;
- short task id, when needed.

### Why

The row should be scannable. A user should quickly see which agents are still
working, which failed, how expensive they look, and what they last did.

### How

Model:

- For parent-launched tasks, store requested `model` in task metadata if the
  parent supplied it.
- For direct `orchestrator launch --model`, store the requested model too.
- As fallback, derive model from runtime launch args only when reliable.

Usage:

- Continue normalizing provider usage into `agent.usage`.
- Store latest known usage on the task record later:

```ts
type TaskUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  updatedAt: string;
};
```

- Until then, compute latest usage from `events.jsonl`.
- Show `unknown` when unavailable.
- Do not estimate tokens from log length.

Last event:

- Prefer latest normalized `agent_event.data.kind`.
- Fall back to lifecycle event type: `running`, `completed`, `failed`,
  `timed_out`, etc.
- For failures, prefer a short parsed error message when available.

### Done

- Codex rows show token usage when Codex emits it.
- Claude/custom rows show `unknown` until adapters provide usage.
- Failed rows show a useful last event or short error.

## 5. Promote Provider Errors

### What

Provider errors should be promoted into task status and operation rows cleanly.

Current failed Codex example:

```text
task.status = failed
result output = raw JSONL with provider error
```

Better:

```ts
task.error = "The 'gpt-5.4-mini' model is not supported...";
lastEvent = "runtime.error";
```

### Why

Raw JSONL is useful for debugging, but humans need the actual failure message.
The watcher should show why an agent failed without forcing the user into logs.

### How

- Normalize runtime error events into `agent_event` with:

```ts
{
  kind: "runtime.error";
  message: string;
}
```

- During task finalization, if the task failed and no process-level error exists,
  use the latest normalized runtime error message as `task.error`.
- Keep raw stdout/stderr/transcript unchanged.

### Done

- Failed Codex/Claude tasks have readable `task.error` when the provider emitted
  a structured error.
- `read_agent` and `ps` can display that message.
- Raw logs remain available for full debugging.

## 6. Keep Raw And Debug Views Separate

### What

Keep these surfaces distinct:

```sh
orchestrator run --trace-tools
orchestrator run --stream-json
orchestrator logs <task-id> --follow
orchestrator events <task-id>
orchestrator ps
orchestrator ps --watch
```

### Why

Each command answers a different question:

- `--trace-tools`: what parent tools are being called right now?
- `--stream-json`: what exact machine-readable run events happened?
- `logs`: what did the child process write?
- `events`: what lifecycle/provider events did the child task record?
- `ps`: what agents exist and what is their state?
- `ps --watch`: what is changing live across agents?

### How

- Do not make `ps` parse terminal text.
- Do not make `--trace-tools` the machine API.
- Do not remove `logs` or `events` once `ps` exists.
- Keep `--stream-json` stable and boring.

### Done

- Human watcher uses task records and task events.
- Machine integrations use JSON surfaces.
- Raw debugging remains available.

## Suggested Build Order

Start with parent-child linkage.

Reason: grouping is the core of the multi-agent view. Without persisted parent
metadata, `ps --watch` can only group tasks observed during the current live
stream. That would make the watch view unreliable.

Then build:

1. `ps` static grouped table.
2. Provider error promotion.
3. `ps --watch`.
4. Row polish: model, tokens, duration, last event.
5. TUI later, using the same grouped data.

Do not start with the full TUI. Build the data model and terminal watch first.
