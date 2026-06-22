# SPIKE: Claude Code Token Metrics Transmission

Date: 2026-06-19

## Question

How should Orchestrator think about token counts that move from a provider
runtime into a parent agent, CLI view, persisted task record, and future TUI?

## Method

This spike summarizes Claude Code-inspired behavior from using headless and
streaming agent flows. It intentionally avoids depending on or documenting
Claude Code internals. The goal is to extract the product and protocol shape
that matters for Orchestrator.

## Findings

### 1. Runtime Output Is The First Useful Boundary

The runtime process is the first place Orchestrator can observe token data. If
the process streams usage events, Orchestrator can update live task usage. If
the process only emits usage at the end, Orchestrator can still persist final
usage after completion.

This means token support is adapter-specific at the ingestion layer, but
generic after normalization.

### 2. Live Usage And Final Usage Are Different Moments

Live usage is operational: it helps a human or parent agent see that work is
active and consuming context.

Final usage is archival: it belongs in the task record and can be shown in
`read`, `ps`, logs/events summaries, and future dashboards.

The same normalized shape can represent both. Metadata can say whether the
value is final or estimated, but the normal human display should remain simple:
just show the best token number available.

### 3. Context Usage, Task Usage, And Account Usage Are Separate

Claude-style tools expose several token-adjacent concepts:

- task or response token usage;
- current context window usage;
- session totals;
- output-token budgets;
- account, quota, or rate-limit usage;
- cost estimates.

Orchestrator should not collapse those into one field. For the agent-control
CLI, the important field is task usage: “how many tokens has this child agent
used so far?”

### 4. Parent Agents Need A Machine Surface

Human output can show `24k` in a table. Agents need the same data in JSON:

```json
{
  "usage": {
    "totalTokens": 24000,
    "estimated": false,
    "final": false
  }
}
```

That lets an agent decide whether to wait, stop, read results, or launch more
workers without parsing prose.

### 5. Custom Agents Need A Simple Emission Path

Custom process agents should not need to implement a full protocol to report
usage. JSONL result/progress events are enough:

```json
{"type":"usage","usage":{"totalTokens":12000}}
{"type":"final","text":"done","usage":{"totalTokens":18000,"final":true}}
```

Adapters can normalize richer provider shapes, but the custom-agent contract
should stay small.

## Recommendation

Keep token observation in runtime adapters, normalize into task usage, persist
the latest usage snapshot, and render the same normalized value across:

- `ps`
- `ps --watch`
- compact JSON
- `read`
- future TUI views

Do not add pricing, quota, or a universal tokenizer in this phase. The product
need is live visibility into running agents.
