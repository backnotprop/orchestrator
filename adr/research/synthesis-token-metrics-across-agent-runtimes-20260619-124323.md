# Synthesis: Token Metrics Across Agent Runtimes

Date: 2026-06-19

## Summary

Token metrics need to be adapter-owned at the edge and normalized inside
Orchestrator.

Every researched system follows the same basic pattern:

1. Provider APIs report usage in different shapes.
2. The runtime adapter parses those provider-specific fields.
3. The framework stores a smaller normalized usage object.
4. UI/API surfaces display normalized usage, usually after a model response or
   step completes.

The main design point is not "make every runtime report tokens the same way."
That is not realistic. The right target is: adapters do the messy parsing, then
Orchestrator receives one small common usage shape with clear availability and
source semantics.

## Shared Findings

Usage is most reliable at response, step, turn, or message completion. Live text
deltas usually do not carry final usage. Some providers send partial usage early,
but timing differs enough that Orchestrator should treat live token values as
best-effort progress, not final accounting.

Provider-specific parsing is unavoidable. OpenAI-compatible providers report
fields such as `prompt_tokens`, `completion_tokens`, `input_tokens`,
`output_tokens`, and cached-token details. Anthropic reports input, output,
cache read, cache creation, and sometimes server tool usage through streaming
message events. Gemini, Bedrock, Mistral, and other providers all use their own
field names.

Cost is usually not provider truth. Pi, Flue, OpenCode, and Claude Code compute
cost locally from model pricing metadata when they report it. Codex mostly
reports token counts, account usage, rate limits, or credits, not per-turn USD
cost.

Account usage and quota are separate from task usage. Codex and Claude Code both
have account/quota surfaces that are not the same thing as per-response token
usage. Orchestrator should not mix those into task token totals.

Context pressure is also separate. Several systems estimate current context size
from the last usage-bearing model response plus local estimates for later
messages. That can be useful for UI, but it is not the same as model spend.

## System Patterns

Flue normalizes usage into `PromptUsage`, with input, output, cache read, cache
write, total tokens, and cost. It usually receives provider usage from Pi's AI
package, then aggregates usage across prompt, skill, task, and compaction
operations. Flue usage is final operation metadata, not token-by-token live
telemetry. Its Cloudflare Workers AI provider is the notable local adapter that
parses OpenAI-compatible streaming usage itself.

Pi has the broadest provider-normalization layer. It stores normalized `Usage`
on every finalized assistant message. Provider adapters update usage from raw
provider stream metadata, then Pi persists the final assistant message in
session JSONL. It also computes cost from model metadata. Pi is a strong model
for the "provider-specific at the adapter, normalized after" approach.

OpenCode has a clear provider-neutral `LLM.Usage` contract. It keeps inclusive
input/output totals plus non-overlapping cache and reasoning breakdowns.
Provider protocol adapters map raw provider usage into this shape, then session
events, APIs, UI, TUI, ACP, and stats use smaller persisted token summaries.
OpenCode also shows a useful warning: message-level usage may be more complete
than session aggregate fields depending on the runtime path.

Codex models usage as token counts, not dollar cost. It distinguishes cumulative
session usage, latest response/context usage, and app-server/account usage.
Adapters must not collapse those together. Its current provider path gets usage
from final Responses API `response.completed` events, then emits token-count
events for clients and UI.

Claude Code uses Anthropic-shaped stream usage. Input and cache counts can
arrive at `message_start`, output counts are updated later, and the higher layer
adds usage at response boundaries. It also separates model usage, context
estimates, account/quota information, and subagent/task progress usage.

## Implications For Orchestrator

Orchestrator should keep its current small normalized usage model, but extend it
carefully instead of pretending every runtime reports the same thing.

The common task usage shape should stay simple:

```ts
type TaskUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  source?: "provider" | "runtime" | "estimated" | "unknown";
  scope?: "turn" | "task" | "session" | "account";
  final?: boolean;
  raw?: unknown;
};
```

The exact field names can still be refined, but the missing ideas matter:

- `reasoningTokens` is needed for Codex, OpenCode, Gemini, and some provider
  surfaces.
- `source` prevents estimated context/token counts from looking like provider
  usage.
- `scope` prevents cumulative session usage from being mistaken for one child
  task's usage.
- `final` lets live views show partial progress without treating it as settled
  accounting.
- `raw` gives adapters a place to preserve provider-specific data without
  making the whole runtime parse it later.

## Adapter Responsibilities

Built-in adapters should own provider/runtime parsing:

- Claude Code adapter parses Claude stream/output usage into Orchestrator usage.
- Codex adapter parses Codex exec/app-server usage into Orchestrator usage.
- Pi parent-run integration can use Pi's finalized assistant message usage when
  available.
- Flue custom-agent support should expect Flue's `PromptUsage` or event usage
  and map it mechanically.
- OpenCode support should prefer normalized `LLM.Usage` or persisted message
  token summaries over raw provider fields.

Core Orchestrator should not know provider field names such as
`prompt_tokens`, `completion_tokens`, `usageMetadata`, or
`cache_creation_input_tokens`. Those belong in adapters.

Core Orchestrator should own:

- normalized task usage storage
- task/group aggregation
- display formatting
- unknown/partial/final semantics
- preserving usage on `task.usage`, `task.finished`, `ps`, `read`, and future
  TUI surfaces

## Custom Agent Contract

Custom agents should not be required to report token usage. They should work
without it and show `unknown`.

When a custom agent wants token reporting, it should emit a small normalized
event or final payload. JSONL is the cleanest first contract:

```jsonl
{"type":"usage","usage":{"inputTokens":1200,"outputTokens":300,"totalTokens":1500,"source":"provider","scope":"task","final":false}}
{"type":"final","output":"Done.","usage":{"inputTokens":1200,"outputTokens":350,"totalTokens":1550,"source":"provider","scope":"task","final":true}}
```

For Flue specifically, custom process adapters can map:

- `input` -> `inputTokens`
- `output` -> `outputTokens`
- `cacheRead` -> `cacheReadTokens`
- `cacheWrite` -> `cacheWriteTokens`
- `totalTokens` -> `totalTokens`
- `cost.total` -> `costUsd` only if the unit is known to be USD

Flue usage should usually be treated as final operation/task usage unless it is
coming from a live `turn` event.

## What Not To Do

Do not estimate tokens from text length and show them as real provider usage.
Estimates are useful for context pressure, not billing or task accounting.

Do not mix account usage, rate limits, quota, credits, or subscription usage
into task token totals.

Do not assume usage is live. Most reliable usage arrives at the end of a model
response, step, or task.

Do not assume `totalTokens` always means the same thing. In some systems it is
per response, in others it is cumulative session total, and in some imported or
estimated paths it may be the only populated field.

Do not require custom agents to know provider-specific fields. Give them a small
normalized contract.

## Recommended Next Step

Spec the Orchestrator usage contract before implementing more extraction.

The spec should decide:

- the exact `TaskUsage` fields
- whether `raw` is stored in task events, task records, or both
- how to mark partial versus final usage
- how to distinguish task, session, and account scopes
- how group aggregation handles unknown, partial, and cumulative values
- the JSONL custom-agent usage contract

After that, implementation should be adapter-by-adapter:

1. Tighten Codex extraction first, because Codex already emits structured usage
   in exec/app-server surfaces but has cumulative/per-turn ambiguity.
2. Tighten Claude Code extraction second, because usage is available but shaped
   around Anthropic streaming semantics.
3. Add the custom JSONL usage contract.
4. Add Flue example mapping in `doc/custom-agents.md`.
5. Improve `ps` and trace display only after the stored data semantics are
   settled.

## Source Spikes

- `adr/research/SPIKE-token-metrics-flue-20260619-085009.md`
- `adr/research/SPIKE-token-metrics-pi-20260619-085009.md`
- `adr/research/SPIKE-token-metrics-opencode-20260619-085009.md`
- `adr/research/SPIKE-token-metrics-codex-20260619-085009.md`
- `adr/research/SPIKE-token-metrics-claude-code-20260619-085009.md`
