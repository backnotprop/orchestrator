# SPIKE: Token Metrics in Codex Harness Transmission

Date: 2026-06-19

## Question

How are token counts (input, output, cached, reasoning, total) produced, aggregated, and transmitted from the Codex harness/runtime to agent-facing clients and extensions?

In Codex terminology, the **harness** is the host runtime (`core` session + `app-server` + UI/exec clients) that wraps the LLM turn loop. The **agent** is the model-driven turn executor; extensions and clients observe harness events rather than parsing provider streams directly.

## Method

Systematic codebase search across `/Users/ramos/oss-agents/codex/codex-rs` for:

- `TokenUsage`, `TokenCount`, `ThreadTokenUsage`, `response.completed`
- SSE/WebSocket response parsing (`codex-api`)
- Core session state and event emission (`core`)
- App-server notification mapping (`app-server`, `app-server-protocol`)
- Persistence (rollout, SQLite metadata), telemetry (OTel, analytics), and extension hooks

No web search was used.

## Findings

### 1. Canonical token schema (protocol layer)

The canonical Rust schema lives in `codex-rs/protocol/src/protocol.rs`:

| Struct                         | Fields                                                                                            | Role                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `TokenUsage` (L1995–2006)      | `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens` | Per-sampling or per-turn delta                 |
| `TokenUsageInfo` (L2009–2015)  | `total_token_usage`, `last_token_usage`, `model_context_window`                                   | Session/thread aggregate + latest context size |
| `TokenCountEvent` (L2076–2079) | `info: Option<TokenUsageInfo>`, `rate_limits: Option<RateLimitSnapshot>`                          | Harness → client event envelope                |

Key aggregation logic (`TokenUsageInfo::append_last_usage`, L2044–2047):

- `total_token_usage` is **cumulative** across the thread (`add_assign`)
- `last_token_usage` is replaced with the latest provider-reported usage snapshot
- `total_tokens` in `last_token_usage` represents **active context window size**, not a billing total

Display helpers (`TokenUsage::blended_total`, `non_cached_input`, `cached_input`) compute UI-facing totals (L2158–2165).

App-server wire types mirror this in `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`:

- `TokenUsageBreakdown` (L1311–1322): same five fields, camelCase JSON
- `ThreadTokenUsage` (L1290–1296): `{ total, last, modelContextWindow }`
- `ThreadTokenUsageUpdatedNotification` (L1281–1285): `{ threadId, turnId, tokenUsage }`, notification method `thread/tokenUsage/updated` (`common.rs` L1585)

TUI duplicates a local view model in `codex-rs/tui/src/token_usage.rs` (L11–61) and maps app-server notifications in `chatwidget.rs` (`token_usage_info_from_app_server`, L887–904).

### 2. Provider origin: `response.completed` only (no incremental usage events)

Token counts enter Codex exclusively from the OpenAI Responses API terminal event `response.completed`. There is **no** handler for mid-stream `usage` or `response.usage` delta events.

**SSE parser** — `codex-rs/codex-api/src/sse/responses.rs`:

```rust
// L102–117: ResponseCompleted + ResponseCompletedUsage
struct ResponseCompletedUsage {
    input_tokens: i64,
    input_tokens_details: Option<ResponseCompletedInputTokensDetails>,  // cached_tokens
    output_tokens: i64,
    output_tokens_details: Option<ResponseCompletedOutputTokensDetails>,  // reasoning_tokens
    total_tokens: i64,
}
```

Mapping to `TokenUsage` (L119–134):

- `cached_input_tokens` ← `input_tokens_details.cached_tokens` (default 0)
- `reasoning_output_tokens` ← `output_tokens_details.reasoning_tokens` (default 0)

Event dispatch (L393–401): `response.completed` → `ResponseEvent::Completed { response_id, token_usage, end_turn }`.

**WebSocket path** — `codex-rs/codex-api/src/endpoint/responses_websocket.rs` reuses the same `process_responses_event` logic; additionally handles `codex.rate_limits` metadata events (L693–695).

**Stream bootstrap metadata** (not token counts) — `spawn_response_stream` (L31–80) emits from HTTP headers before SSE body:

- `ResponseEvent::RateLimits` from `parse_all_rate_limits`
- `ResponseEvent::ServerModel`, `ModelsEtag`, `ServerReasoningIncluded`

### 3. Core client layer: stream mapping and telemetry

`codex-rs/core/src/client.rs` wraps the API stream in `map_response_events` (L1823–1856):

- On `ResponseEvent::Completed`, records OTel `sse_event_completed` with per-field counts (L1830–1836)
- Forwards `token_usage` unchanged to the session turn loop
- Records inference trace completion with usage (`inference_trace_attempt.record_completed`, L1838–1842)

Span attributes are stamped during turn streaming in `session/turn.rs` (L1893–1897):

- `gen_ai.usage.input_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.output_tokens`
- `codex.usage.reasoning_output_tokens`, `codex.usage.total_tokens`

`SessionTelemetry::record_responses` (`otel/src/events/session_telemetry.rs` L417–432) records the same fields on `ResponseEvent::Completed`.

### 4. Session state: production, aggregation, and deferred emission

**Recording from provider** — `session/turn.rs` sampling loop (L2132–2146):

```rust
ResponseEvent::Completed { token_usage, end_turn, .. } => {
    sess.record_token_usage_info(&turn_context, token_usage.as_ref()).await;
    should_emit_token_count = true;
    // ...
}
```

`record_token_usage_info` (`session/mod.rs` L3203–3234):

1. Updates `ContextManager.token_info` via `update_token_info_from_usage` (`context_manager/history.rs` L249–258)
2. Notifies `TokenUsageContributor` extensions **before** client notification
3. Does **not** itself emit `TokenCount` (deferred)

**Deferred `TokenCount` emission** — `turn.rs` L2283–2288:

- Emitted only after in-flight tool calls resolve (e.g. `request_user_input` must complete first)
- Also triggered by `ResponseEvent::RateLimits` (L2122–2126) so rate limits and usage ship together

`send_token_count_event` (`session/mod.rs` L3308–3315):

```rust
EventMsg::TokenCount(TokenCountEvent { info, rate_limits })
```

**Turn-level delta metrics** — at turn completion (`tasks/mod.rs` L647–721):

- Computes per-turn delta: `total_token_usage_now - token_usage_at_turn_start`
- Records OTel span fields (`codex.turn.token_usage.*`, L666–688)
- Emits histogram `codex.turn.token_usage` per token type
- Tracks `TurnTokenUsageFact` to analytics reducer

**Turn start baseline** — `tasks/mod.rs` L336–358:

- Captures `token_usage_at_turn_start` from `total_token_usage().await`
- Passes to `TurnLifecycleContributor::on_turn_start` via `TurnStartInput.token_usage_at_turn_start` (`ext/extension-api/src/contributors/turn_lifecycle.rs` L14–15)

**Local estimation fallback** — `recompute_token_usage` (`session/mod.rs` L3236–3271):

- Byte-heuristic token estimate from conversation history when provider usage unavailable (e.g. post-compaction)
- Sets `last_token_usage.total_tokens` to estimate; zeroes other fields
- Used after manual `/compact` (test: `core/tests/suite/compact.rs` L906–959)

**Active context accounting** — `context_manager/history.rs` `get_total_token_usage` (L296–309):

- Starts from `last_token_usage.total_tokens` (server-reported context size)
- Adds locally estimated tokens for items appended after last model-generated item
- Optionally re-estimates reasoning tokens when `server_reasoning_included` is false

### 5. Harness → agent/client transmission (app-server)

Core emits `EventMsg::TokenCount` on an internal event bus. The app-server maps it in `bespoke_event_handling.rs` (L916–918, L1608–1634):

```
EventMsg::TokenCount
  → ThreadTokenUsageUpdatedNotification (thread/tokenUsage/updated)
  → optional AccountRateLimitsUpdated (if rate_limits present)
```

Mapping requires `info: Some(TokenUsageInfo)`; if absent, no usage notification is sent (test L3774–3801).

**Consumers:**

| Client                 | Handler                                                              | File:line                                                |
| ---------------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| TUI                    | `ServerNotification::ThreadTokenUsageUpdated` → status line / footer | `tui/src/chatwidget/protocol.rs` L32–34                  |
| `codex exec` (JSONL)   | Stores `last_total_token_usage`, emits on `TurnCompleted`            | `exec/src/event_processor_with_jsonl_output.rs` L500–526 |
| Extension goal backend | Observes via test harness callbacks                                  | `ext/goal/tests/goal_extension_backend.rs`               |

**Replay on thread attach** — `app-server/src/request_processors/token_usage_replay.rs`:

- On resume/fork/subscribe, replays latest `TokenCount` from rollout as `ThreadTokenUsageUpdated`
- Attributes to turn via rollout position of last `TokenCount` event (L69–98)
- Connection-scoped to avoid surprising other subscribers (L31–35)

**Turn lifecycle events do NOT carry token breakdowns:**

- `TurnStartedEvent` (`protocol.rs` L1951–1965): `model_context_window` only, no token fields
- `TurnCompleteEvent` (`protocol.rs` L1933–1948): timing fields only (`duration_ms`, `time_to_first_token_ms`)
- `TurnCompletedNotification` (`app-server-protocol/.../turn.rs` L386–389): turn status + items, no embedded usage

Token metrics for a completed turn arrive via a **separate** `thread/tokenUsage/updated` notification, typically before or around `turn/completed`.

### 6. Extension / agent plugin hooks

Extensions receive token data through contributor traits, not by parsing provider SSE:

| Trait                      | Callback         | Token data                                                 | File                                             |
| -------------------------- | ---------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `TokenUsageContributor`    | `on_token_usage` | Full `TokenUsageInfo` after each `record_token_usage_info` | `ext/extension-api/src/contributors.rs` L194–207 |
| `TurnLifecycleContributor` | `on_turn_start`  | `token_usage_at_turn_start: &TokenUsage`                   | `contributors/turn_lifecycle.rs` L14–15          |
| `TurnLifecycleContributor` | `on_turn_stop`   | No token fields                                            | `contributors/turn_lifecycle.rs` L24–31          |

Goal extension uses both: turn-start baseline for accounting (`ext/goal/src/accounting.rs` L71–79) and `on_token_usage` for live updates.

**Shell hooks** (`HookStarted`/`HookCompleted`, `protocol.rs` L1525–1534) carry `HookRunSummary` only — **no token metrics**.

### 7. Telemetry and analytics (runtime-only vs persisted)

**OTel / tracing** (runtime, not in rollout):

- Per-response span attributes on `handle_responses` (`session/turn.rs` L1893–1897)
- `SessionTelemetry::record_responses` on completion (`session_telemetry.rs` L417–432)
- `sse_event_completed` structured log event (`session_telemetry.rs` L917–938) — note: 5th param is named `tool_token_count` but receives `usage.total_tokens` from `client.rs` L1835
- Turn-level histograms `codex.turn.token_usage` (`otel/src/metrics/names.rs` L30)

**Analytics** (async, aggregated at turn end):

- `TurnTokenUsageFact` with per-turn delta (`analytics/src/facts.rs` L98–102)
- Reducer merges into `codex_turn_event` params (`analytics/src/reducer.rs` L2544–2558): `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`
- Emitted only when turn profile + resolved config + completion are all available (`maybe_emit_turn_event`)

**Account-level usage** (separate from per-thread context):

- `GetAccountTokenUsage` RPC → daily/weekly/cumulative buckets (`app-server-protocol/schema/typescript/v2/GetAccountTokenUsageResponse.ts`)
- TUI `/usage` slash command fetches via `background_requests.rs` L756–759
- This is ChatGPT billing/rate-limit data, not per-turn harness transmission

### 8. Persistence: runtime vs stored

| Data                            | Persisted?     | Where                                                                           | Notes                                                                               |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `EventMsg::TokenCount`          | **Yes**        | Rollout JSONL                                                                   | `rollout/src/policy.rs` L84                                                         |
| `TokenUsageInfo` full breakdown | **Yes**        | Inside `TokenCount.info` in rollout                                             | Restored on resume via `last_token_info_from_rollout` (`session/mod.rs` L1377–1381) |
| `TurnStarted` / `TurnComplete`  | **Yes**        | Rollout                                                                         | No token breakdown fields                                                           |
| Rate limit snapshots            | **Partial**    | Latest only in session state; included in `TokenCount.rate_limits` when emitted | Merged via `set_rate_limits` (`state/session.rs` L177–182)                          |
| Per-turn OTel histograms        | **No**         | Ephemeral metrics export                                                        |                                                                                     |
| `codex_turn_event` analytics    | **No** (local) | Sent to analytics pipeline                                                      | Per-turn delta at completion                                                        |
| SQLite thread metadata          | **Partial**    | `tokens_used` = `total_token_usage.total_tokens` only                           | `state/src/extract.rs` L88–91                                                       |
| Inference trace `TokenUsage`    | **Yes**        | `rollout-trace` payloads                                                        | Simpler schema, u64 fields (`rollout-trace/src/model/conversation.rs` L186–191)     |

`ThreadHistoryBuilder` explicitly ignores `TokenCount` for turn reconstruction (`app-server-protocol/src/protocol/thread_history.rs` L371) — token state is replayed separately, not derived from turn items.

### 9. Non-provider token counting (local heuristics)

Separate from API usage transmission:

- `codex_utils_output_truncation::approx_token_count` — byte/4 heuristic for tool output truncation (`utils/output-truncation/src/lib.rs`)
- `ContextManager::estimate_token_count` — local context size estimate (`context_manager/history.rs` L130–138)
- `TokenBudget` feature injects remaining-context fragments at 25/50/75% thresholds (`session/token_budget.rs` L6–43) using `get_total_token_usage`, not provider usage

These affect model input but are **not** transmitted as `ThreadTokenUsageUpdated`.

## Data Flow

```
OpenAI Responses API
  │
  │  SSE/WS stream
  │  ├─ (headers) RateLimits, ServerModel, ReasoningIncluded
  │  ├─ output_item.*, deltas, reasoning, tool calls ...
  │  └─ response.completed { usage: { input_tokens, input_tokens_details.cached_tokens,
  │                                    output_tokens, output_tokens_details.reasoning_tokens,
  │                                    total_tokens } }
  ▼
codex-api/sse/responses.rs :: process_responses_event (L393–401)
  │  ResponseCompletedUsage → TokenUsage
  ▼
core/client.rs :: map_response_events (L1823–1856)
  │  OTel sse_event_completed + inference trace
  ▼
core/session/turn.rs :: run_sampling_request loop (L2132–2146)
  │  record_token_usage_info → ContextManager.token_info
  │  TokenUsageContributor::on_token_usage (extensions)
  │  [after tools drain] send_token_count_event
  ▼
EventMsg::TokenCount { info: TokenUsageInfo, rate_limits }
  │  ├─ rollout persistence (JSONL)
  │  └─ app-server bespoke_event_handling (L916–918)
  ▼
ServerNotification::ThreadTokenUsageUpdated
  │  { threadId, turnId, tokenUsage: { total, last, modelContextWindow } }
  ├─► TUI chatwidget (status line, context %)
  ├─► codex exec JSONL output
  └─► SDK/plugin clients via app-server WebSocket

Parallel at turn end (tasks/mod.rs L647–721):
  turn_delta = current_total - token_usage_at_turn_start
  ├─► OTel histograms (codex.turn.token_usage)
  └─► analytics TurnTokenUsageFact → codex_turn_event
```

## Schemas / Field Names

### API (`response.completed.response.usage`)

| API field                                | Codex `TokenUsage` field  |
| ---------------------------------------- | ------------------------- |
| `input_tokens`                           | `input_tokens`            |
| `input_tokens_details.cached_tokens`     | `cached_input_tokens`     |
| `output_tokens`                          | `output_tokens`           |
| `output_tokens_details.reasoning_tokens` | `reasoning_output_tokens` |
| `total_tokens`                           | `total_tokens`            |

### Internal `TokenUsageInfo`

```json
{
  "total_token_usage": { "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens" },
  "last_token_usage":    { same fields },
  "model_context_window": number | null
}
```

### App-server `thread/tokenUsage/updated` (camelCase)

```json
{
  "threadId": "...",
  "turnId": "...",
  "tokenUsage": {
    "total": { "totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens" },
    "last":  { same },
    "modelContextWindow": number | null
  }
}
```

### Analytics `codex_turn_event` (per-turn delta, snake_case)

`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens` — all `Option<i64>`, derived from turn-start baseline subtraction.

## Gaps / Unknowns

1. **No incremental streaming usage** — Codex ignores any mid-stream usage events; clients see updates only after `response.completed` (plus deferred tool-wait).
2. **`TurnComplete` lacks token fields** — consumers must correlate `thread/tokenUsage/updated` with `turn/completed` by `turnId`.
3. **`total_tokens` semantics differ by context** — in `last_token_usage` it is active context size; in turn-delta analytics it is cumulative thread growth for that turn.
4. **`sse_event_completed` parameter naming** — `tool_token_count` argument receives `total_tokens` (`client.rs` L1835); may confuse trace analysis.
5. **Account vs thread usage** — `GetAccountTokenUsage` is billing-oriented; not wired into per-turn harness events.
6. **Harness terminology** — `harness_overrides` in TUI (`app.rs` L513) refers to config overrides for the host process, not a distinct token pipeline; the token path runs through `core` session regardless.
7. **Subagent/delegate paths** — `codex_delegate.rs` forwards `EventMsg::TokenCount` (L286); full subagent token attribution not fully traced in this spike.
8. **Provider absence** — when `response.completed` has `usage: null`, no `TokenCount` with `info` is emitted; local `recompute_token_usage` may follow for compaction scenarios only.

## Implications for Gateway/Viper

1. **Intercept point** — Gateway should capture `response.completed` usage at the proxy layer (matching `ResponseCompletedUsage` shape) before Codex parses it; this is the single authoritative source for all five token dimensions.
2. **Canonical field mapping** — Align Gateway audit records with Codex's `TokenUsage` schema (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`) for cross-tool correlation.
3. **Harness event shape** — If Viper needs to mirror Codex client behavior, emit an equivalent of `TokenCountEvent` / `ThreadTokenUsageUpdated` with both `total` (cumulative) and `last` (context snapshot) breakdowns plus `model_context_window`.
4. **Timing** — Token notifications are intentionally delayed until blocking tools complete; Gateway audit should timestamp both provider `response.completed` time and harness-forward time if measuring agent-visible latency.
5. **Persistence gap** — Rollout stores full `TokenUsageInfo`; SQLite metadata stores only `tokens_used` total. Gateway should persist the full breakdown for audit parity with Codex rollout.
6. **Rate limits bundled** — Codex pairs `RateLimitSnapshot` with `TokenCount`; Gateway may want to co-locate quota state with usage in audit exchanges.
7. **Extension hook parity** — Codex extensions receive `TokenUsageInfo` via `on_token_usage` before client notification; a Viper hook could fire at the same lifecycle point (post-aggregation, pre-UI).
8. **No streaming usage assumption** — Do not design Gateway/Viper for incremental token deltas during SSE; plan for end-of-response usage blocks only, unless OpenAI adds and Codex later adopts mid-stream usage events.
