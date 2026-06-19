# Live Agent View

This describes the current CLI operations view and the direction for the future
TUI.

## Intent

Orchestrator has a live view of running agents, similar in spirit to a
Kubernetes pod watch and recent Claude-style agent status lists.

The user should be able to start multiple agents, leave them running, and watch
their progress in one place.

## Commands

```sh
orchestrator ps
orchestrator ps --all
orchestrator ps --watch
orchestrator ps --runtime codex
orchestrator ps --status running
orchestrator ps --parent <run-id>
orchestrator ps --json
```

`ps` is the grouped human view. It shows active tasks and recent finished tasks
by default. `ps --all` includes old finished tasks too.
`ps --watch` redraws the same view while agents run. `ps --json` returns the
same grouped data for scripts and future UI code.

## Shape

The live view shows one row per agent task:

```text
name              status    runtime      model          dur     tokens   started   last
review tests      running   claude-code  sonnet         2m      77.0k    22:50:42  agent.reasoning
inspect store     running   codex        gpt-5.4-mini   1m      18.4k    22:51:12  agent.message
check email       running   custom       glm-5.2        30s     -        22:51:42  stdout
```

Rows are grouped by parent run when a child was launched by `orchestrator run`.
Manual `orchestrator launch` tasks appear under `MANUAL` in human output.

Future TUI actions:

- move selection up/down;
- open one agent's events/logs/result;
- interrupt the selected agent;
- filter by runtime, status, or parent task;
- keep updating while agents run.

The TUI should consume the same core grouped view as `ps`, not parse terminal
text.

## Token Counts

Token counts should come from normalized runtime events, not from terminal log
scraping.

Each runtime adapter should extract usage when the underlying agent exposes it:

- input tokens;
- output tokens;
- cache read/write tokens, when available;
- total tokens;
- cost, when available.

Runtime adapters should append usage updates to `events.jsonl`. `ps` reads the
latest usage from the task record when present, otherwise from recent task
events.

Suggested normalized event:

```json
{
  "type": "agent_event",
  "data": {
    "kind": "agent.usage",
    "runtime": "claude-code",
    "usage": {
      "inputTokens": 12000,
      "outputTokens": 65000,
      "totalTokens": 77000
    }
  }
}
```

If a runtime cannot report tokens, the live view should show `-`. Do not fake
token counts from log length.

## Data Model Implication

Task records support optional task metrics:

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

This belongs in core task state so the CLI, parent AI agent, and future TUI all
see the same information.

## Why

This makes Orchestrator feel like a real operations surface for agents:

- users can see which agents are still working;
- long-running work feels observable instead of hidden;
- token usage and cost become visible while work is still happening;
- the future TUI has a clear first screen;
- the parent AI agent can make better decisions from the same task metrics.

## Still Future

The full TUI is still future work. It should build on the existing task store,
parent metadata, normalized task events, and grouped `ps` data.
