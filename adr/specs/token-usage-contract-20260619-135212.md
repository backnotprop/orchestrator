# Token Usage Contract

Date: 2026-06-19

## Status

Draft spec.

## Intent

Orchestrator should show token usage when agents provide real data, without
pretending every agent reports usage the same way.

The core rule is simple: adapters parse messy runtime/provider output, then
Orchestrator stores and displays one normalized usage shape. Custom agents can
opt in to that same shape, but token reporting is never required.

## Current State

Orchestrator already has a small usage shape in core task records and parent run
events:

```ts
{
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
  costUsd?: number
}
```

That is enough for basic display, but not enough for the systems we researched.
It does not say whether usage is final or partial. It does not distinguish one
task from cumulative session usage. It does not preserve reasoning tokens. It
does not tell us whether usage came from the provider, the runtime, or an
estimate.

## Contract

Use this as the v1 normalized task usage shape:

```ts
type TaskUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  source?: "provider" | "runtime" | "estimated";
  scope?: "turn" | "task" | "session" | "account";
  final?: boolean;
  updatedAt: string;
};
```

Do not store raw provider payloads on `task.json` by default. Raw payloads can be
preserved in `events.jsonl` under the original normalized agent event when
needed. The durable task record should stay small and stable.

## Field Meaning

`inputTokens` means non-output model input tokens, including cacheable input
unless the source separates it.

`outputTokens` means visible model output tokens.

`reasoningTokens` means hidden reasoning/thinking tokens when the runtime
reports them.

`cacheReadTokens` and `cacheWriteTokens` mean provider-reported cache hit and
cache write counts. Do not infer them.

`totalTokens` means the reported or computed total for this usage object. If a
provider gives no total, Orchestrator may compute a simple total from known
components. If the input is cumulative session usage, `scope` must say so.

`costUsd` means USD cost only. If a runtime reports credits, quota, nano-AIU, or
an unknown unit, do not put it here.

`source` says where the count came from:

- `provider`: direct provider usage surfaced by the runtime.
- `runtime`: runtime-calculated usage based on provider usage and model data.
- `estimated`: local estimate, useful for context pressure but not billing.

`scope` says what the count describes:

- `turn`: one model response or turn.
- `task`: the whole child task.
- `session`: cumulative runtime session usage.
- `account`: account/quota usage, not task spend.

`final` is `true` when the adapter believes the count is settled for that
scope. Partial live counts should use `final: false`.

## Event Rules

Task events may include usage on `agent.usage`, `agent_event`, `result`, or
final task events, depending on the runtime adapter.

The preferred normalized event is:

```json
{
  "type": "agent.usage",
  "usage": {
    "inputTokens": 1200,
    "outputTokens": 300,
    "totalTokens": 1500,
    "source": "provider",
    "scope": "task",
    "final": true
  }
}
```

When a final result includes usage, it may use:

```json
{
  "type": "final",
  "output": "Done.",
  "usage": {
    "inputTokens": 1200,
    "outputTokens": 350,
    "totalTokens": 1550,
    "source": "provider",
    "scope": "task",
    "final": true
  }
}
```

The task record should keep the latest best task-level usage. Do not overwrite
final task usage with later account, session, or estimated context data.

## Adapter Rules

Adapters own provider/runtime parsing.

Core Orchestrator should not parse provider-specific fields like
`prompt_tokens`, `completion_tokens`, `usageMetadata`,
`cache_creation_input_tokens`, or `response.usage`. Those belong in runtime
adapters.

Codex adapter:

- Prefer final task or turn usage from structured exec/app-server events.
- Preserve the difference between latest turn usage and cumulative session
  usage.
- Do not treat account usage, rate limits, or credits as task tokens.
- Mark ambiguous cumulative values with `scope: "session"` instead of `task`.

Claude Code adapter:

- Parse Anthropic-shaped usage from stream/final output when exposed.
- Treat start/delta usage as partial until the response is complete.
- Map cache creation to `cacheWriteTokens` and cache read to
  `cacheReadTokens`.
- Keep account quota and rate-limit data out of task token totals.

Custom process agents:

- No usage output is required.
- If usage is emitted, parse only the normalized JSON contract above.
- Unknown or invalid usage should be ignored, not fatal.

Flue custom agents:

- Map Flue `PromptUsage.input` to `inputTokens`.
- Map `output` to `outputTokens`.
- Map `cacheRead` and `cacheWrite` directly.
- Map `totalTokens` directly.
- Map `cost.total` to `costUsd` only when the unit is known to be USD.
- Treat operation result usage as `scope: "task", final: true`.

OpenCode custom agents:

- Prefer normalized `LLM.Usage` or persisted message token summaries.
- Preserve reasoning tokens.
- Be careful with session aggregate fields that may lag message-level usage.

Pi parent runs:

- Prefer finalized assistant message usage.
- Do not count compaction `tokensBefore` as spend.
- Treat context usage estimates as `source: "estimated"`.

## Aggregation Rules

For `ps` and future TUI group totals, aggregate only usage with compatible
scope.

Default group token totals should include:

- `scope: "task"` usage
- `scope: "turn"` usage only if the adapter aggregates turns into task usage or
  the task has no task-level usage

Default group token totals should exclude:

- `scope: "session"` unless the whole managed task is that session and there is
  no better task usage
- `scope: "account"`
- `source: "estimated"` unless the UI explicitly labels it as estimated

If some children have known usage and others do not, show the known total and do
not imply the group is complete. A later UI can show something like `42k+` or
`42k known`; the CLI can keep showing the number and leave detailed uncertainty
to JSON output for now.

Cost aggregation should sum only `costUsd` values. Do not derive cost in core
without model pricing metadata.

## Performance Rules

Usage parsing must happen on the output/event ingestion path, not inside every
display refresh.

Runtime adapters should parse structured events as they arrive, emit normalized
usage events, and update the task record summary. `ps`, `ps --watch`, trace
rendering, and the future TUI should read that summary state instead of
re-reading and re-parsing full stdout, stderr, transcript, or event files on
each tick.

Custom process agents should only be parsed as structured JSONL when they opt
into the usage contract. Arbitrary prose logs should not be scanned for token
counts.

The durable task record should keep only the latest best usage summary. Large
raw provider payloads belong in event logs only when useful for debugging, not
in `task.json`.

Live views should be able to update smoothly with many agents by reading task
records and recent events incrementally. Any future watcher/TUI work should
avoid O(tasks \* log size) refresh loops.

## Display Rules

`ps` should continue to show a compact token column. Unknown remains `unknown`
or `-`, depending on the renderer.

Trace output may show usage events when useful:

```text
  tokens 1.5k: say hello
```

Human live views should show provider-reported running usage as a normal
updating number. The task status already tells the user the agent is still
running. Machine-readable output should keep `final: false` so software can
distinguish live usage from settled usage.

Estimated usage should still be visibly marked, because estimated tokens are
not the same as provider-reported usage.

Machine-readable output should include the full usage object.

## Implementation Plan

1. Extend core `TaskUsage` with `reasoningTokens`, `source`, `scope`, and
   `final`.
2. Extend agent `TokenUsage` and parent run stream usage with the same fields.
3. Update usage parsers to accept snake_case and camelCase for the new fields.
4. Update task event summarization so final task usage wins over partial,
   estimated, session, or account usage.
5. Tighten Codex usage extraction and mark ambiguous cumulative values
   correctly.
6. Tighten Claude Code usage extraction around Anthropic-shaped fields.
7. Add normalized custom-agent JSONL usage support.
8. Document custom usage reporting in `doc/custom-agents.md`, including a Flue
   example.
9. Update `ps`, trace rendering, and JSON output tests.

## Non-Goals

Do not build a universal tokenizer.

Do not estimate billing from text length.

Do not add model pricing tables to core in this slice.

Do not require custom agents to report tokens.

Do not merge account quota, rate limits, or credits into task usage.

## Source Research

- `adr/research/synthesis-token-metrics-across-agent-runtimes-20260619-124323.md`
- `adr/research/SPIKE-token-metrics-flue-20260619-085009.md`
- `adr/research/SPIKE-token-metrics-pi-20260619-085009.md`
- `adr/research/SPIKE-token-metrics-opencode-20260619-085009.md`
- `adr/research/SPIKE-token-metrics-codex-20260619-085009.md`
- `adr/research/SPIKE-token-metrics-claude-code-20260619-085009.md`
