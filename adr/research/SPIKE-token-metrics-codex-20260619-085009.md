# Token Metrics Research: Codex

Date: 2026-06-19

## Summary

Codex models token usage as token counts, not dollar cost. The main runtime metric is `TokenUsage`, with `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, and `total_tokens`. A `TokenUsageInfo` snapshot adds cumulative session usage (`total_token_usage`), latest response/context usage (`last_token_usage`), and an optional `model_context_window` (`codex-rs/protocol/src/protocol.rs:1994`, `codex-rs/protocol/src/protocol.rs:2008`).

For normal model turns, usage originates in the final Responses API `response.completed` event. The SSE/WebSocket parser maps provider `usage.input_tokens`, `usage.input_tokens_details.cached_tokens`, `usage.output_tokens`, `usage.output_tokens_details.reasoning_tokens`, and `usage.total_tokens` into `TokenUsage`, defaulting missing cached/reasoning details to `0` (`codex-rs/codex-api/src/sse/responses.rs:100`, `codex-rs/codex-api/src/sse/responses.rs:119`, `codex-rs/codex-api/src/sse/responses.rs:393`).

There are separate account-usage surfaces. `account/usage/read` fetches backend profile stats and daily token buckets from `/api/codex/profiles/me` or `/wham/profiles/me`; it is not sourced from the active turn stream (`codex-rs/backend-client/src/client.rs:312`, `codex-rs/app-server/src/request_processors/account_processor.rs:919`).

## Where Usage Is Modeled

Core protocol:

- `TokenUsage`: raw count fields for input, cached input, output, reasoning output, and total (`codex-rs/protocol/src/protocol.rs:1994`).
- `TokenUsageInfo`: cumulative total, last usage, and optional context window (`codex-rs/protocol/src/protocol.rs:2008`).
- `TokenUsageInfo::new_or_append` appends a latest usage sample into the cumulative total and stores it as `last_token_usage` (`codex-rs/protocol/src/protocol.rs:2017`, `codex-rs/protocol/src/protocol.rs:2044`).
- `TokenCountEvent` carries optional `TokenUsageInfo` plus optional rate limits. The protocol comment says optional means unknown and UIs should not display it when `None` (`codex-rs/protocol/src/protocol.rs:2075`, `codex-rs/protocol/src/protocol.rs:1262`).

App-server v2 protocol:

- `ThreadTokenUsageUpdatedNotification` carries `thread_id`, `turn_id`, and `ThreadTokenUsage` (`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:1278`).
- `ThreadTokenUsage` preserves both `total` and `last` as `TokenUsageBreakdown`, plus `model_context_window` (`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:1287`).
- `TokenUsageBreakdown` mirrors the same five count fields in camelCase on the wire (`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:1308`).

Display/helper semantics:

- `TokenUsage::cached_input`, `non_cached_input`, and `blended_total` clamp negatives and compute non-cached input plus output for display/accounting (`codex-rs/protocol/src/protocol.rs:2149`).
- The TUI keeps its own matching `TokenUsage`/`TokenUsageInfo` display model (`codex-rs/tui/src/token_usage.rs:11`).

## Where Usage Data Originates

Normal provider stream:

- `ResponseEvent::Completed` is the normalized internal event that carries `token_usage: Option<TokenUsage>` (`codex-rs/codex-api/src/common.rs:72`, `codex-rs/codex-api/src/common.rs:88`).
- Responses `response.completed` has optional `usage`; Codex maps it to `TokenUsage` if present (`codex-rs/codex-api/src/sse/responses.rs:100`, `codex-rs/codex-api/src/sse/responses.rs:393`).
- Both HTTP SSE and WebSocket paths feed events through the same `process_responses_event` parser and stop when a `Completed` event is seen (`codex-rs/codex-api/src/sse/responses.rs:513`, `codex-rs/codex-api/src/endpoint/responses_websocket.rs:727`).

Historical/restored state:

- Resume/fork seeds the in-memory session token info from the latest persisted `EventMsg::TokenCount` in the rollout, so UIs can show usage immediately after resume/fork (`codex-rs/core/src/session/mod.rs:1269`, `codex-rs/core/src/session/mod.rs:1377`).
- App-server replays the restored usage snapshot to the attaching connection only; it does not re-emit a model event to all subscribers (`codex-rs/app-server/src/request_processors/token_usage_replay.rs:29`).

Estimated/local paths:

- `recompute_token_usage` estimates the active history token count from local history/base instructions and writes it as `last_token_usage.total_tokens`; this is context-size bookkeeping, not provider-reported billing usage (`codex-rs/core/src/session/mod.rs:3236`).
- Imported external-agent sessions synthesize a `TokenCount` from estimated model-visible tokens, setting only `total_tokens` and leaving input/output breakdowns at default values (`codex-rs/external-agent-sessions/src/export.rs:152`).

Account usage:

- `GetAccountTokenUsageResponse` models backend profile summary fields and daily buckets (`codex-rs/app-server-protocol/src/protocol/v2/account.rs:309`).
- The app-server requires Codex/ChatGPT backend auth, fetches `get_token_usage_profile`, and maps profile stats/buckets into the app-server response (`codex-rs/app-server/src/request_processors/account_processor.rs:922`, `codex-rs/app-server/src/request_processors/account_processor.rs:946`).

## Runtime Flow

1. `ModelClientSession::stream` currently dispatches only `WireApi::Responses`; the legacy chat wire API is removed (`codex-rs/model-provider-info/src/lib.rs:50`, `codex-rs/core/src/client.rs:1630`).
2. The API stream parser emits normalized `ResponseEvent` values. When it sees `Completed`, `map_response_stream` records usage to telemetry/inference tracing and forwards the completed event downstream (`codex-rs/core/src/client.rs:1823`).
3. The turn loop consumes stream events. On `ResponseEvent::Completed`, it flushes assistant text, calls `sess.record_token_usage_info`, sets `should_emit_token_count`, and breaks the sampling loop (`codex-rs/core/src/session/turn.rs:2132`).
4. `record_token_usage_info` updates session state with `update_token_info_from_usage`, records auto-compact prefill when configured, and notifies extension token-usage contributors before client notification (`codex-rs/core/src/session/mod.rs:3203`).
5. After pending tool outputs drain, the turn loop emits the `TokenCount` event. The comment says this avoids progress events while a tool such as `request_user_input` is waiting on the user and still persists recorded usage before cancellation handling (`codex-rs/core/src/session/turn.rs:2283`).
6. `send_token_count_event` snapshots current `token_info` plus latest rate limits and sends `EventMsg::TokenCount`; `send_event` persists the event to rollout and sends it to clients (`codex-rs/core/src/session/mod.rs:3308`, `codex-rs/core/src/session/mod.rs:1654`).
7. The app-server converts `TokenCountEvent.info` into `ThreadTokenUsageUpdatedNotification`; if rate limits are present it also sends `AccountRateLimitsUpdated` (`codex-rs/app-server/src/bespoke_event_handling.rs:1608`).

## Streaming And Final Availability

Usage is final-response data. Output text/tool-call deltas stream earlier, but token counts are populated only when the provider emits `response.completed` with `usage` (`codex-rs/codex-api/src/sse/responses.rs:393`). If the stream closes before `response.completed`, Codex treats it as an error rather than emitting partial usage (`codex-rs/core/src/session/turn.rs:1913`, `codex-rs/codex-api/src/endpoint/responses_websocket.rs:659`).

Rate-limit snapshots can arrive before token usage; the turn loop records them but defers sending a token-count event until usage is available to avoid duplicate `TokenCount` events (`codex-rs/core/src/session/turn.rs:2122`).

Client-facing availability depends on surface:

- Core clients see `EventMsg::TokenCount` after pending tools drain (`codex-rs/core/src/session/turn.rs:2283`).
- App-server clients see `thread/tokenUsage/updated` when the `TokenCount` event has non-`None` info (`codex-rs/app-server/src/bespoke_event_handling.rs:1614`).
- Resume/fork clients may receive a replayed latest usage snapshot after the JSON-RPC response, before starting another turn (`codex-rs/app-server/src/request_processors/thread_processor.rs:2777`).
- Exec JSON/human output stores the usage notification, then attaches usage to the later turn-completed event/output (`codex-rs/exec/src/event_processor_with_jsonl_output.rs:500`, `codex-rs/exec/tests/event_processor_with_json_output.rs:1212`).

## Provider-Specific Parts

Provider-specific code selects auth, account state, base URLs, capabilities, model IDs, and whether WebSocket transport is used. It does not define a separate token usage schema (`codex-rs/model-provider/src/provider.rs:94`, `codex-rs/model-provider/src/provider.rs:148`).

Amazon Bedrock is implemented as an OpenAI-compatible Mantle endpoint and still flows through the Responses wire API (`codex-rs/model-provider/src/amazon_bedrock/mod.rs:33`, `codex-rs/model-provider/src/amazon_bedrock/mod.rs:99`).

The usage field mapping itself is Responses-specific: current code parses `input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens`, and `total_tokens` from `response.completed` (`codex-rs/codex-api/src/sse/responses.rs:111`). Searches of the active runtime paths found no current `prompt_tokens`/`completion_tokens` ingestion path; the repository rejects legacy chat wire API configs in favor of `wire_api = "responses"` (`codex-rs/model-provider-info/src/lib.rs:45`).

If a response fails with `usage_not_included`, Codex maps it to `ApiError::UsageNotIncluded`/`CodexErr::UsageNotIncluded` rather than estimating provider usage (`codex-rs/codex-api/src/sse/responses.rs:347`, `codex-rs/codex-api/src/api_bridge.rs:102`, `codex-rs/protocol/src/error.rs:124`).

## Surfaces That Consume Or Expose Usage

Core protocol and app-server:

- `EventMsg::TokenCount` is the core event and rollout-persisted record (`codex-rs/protocol/src/protocol.rs:1262`, `codex-rs/core/src/session/mod.rs:1654`).
- App-server exposes `thread/tokenUsage/updated` and generated SDK types mirror it (`codex-rs/app-server-protocol/src/protocol/common.rs:1585`, `sdk/python/src/openai_codex/generated/v2_all.py:4357`).

SDKs:

- TypeScript SDK exposes a simplified `Usage` on `turn.completed` with input, cached input, output, and reasoning output; it does not expose `total_tokens` there (`sdk/typescript/src/events.ts:20`).
- TypeScript `Thread.run` captures usage from the `turn.completed` event and returns it in the completed turn result (`sdk/typescript/src/thread.ts:114`).
- Python `_collect_turn_result` captures `ThreadTokenUsageUpdatedNotification` for the matching turn and returns the full `ThreadTokenUsage` (`sdk/python/src/openai_codex/_run.py:68`).

CLI/exec:

- Exec event model has `TurnCompletedEvent { usage }` with the four non-total fields (`codex-rs/exec/src/exec_events.rs:49`, `codex-rs/exec/src/exec_events.rs:59`).
- JSONL exec output currently builds `Usage` from `ThreadTokenUsage.total`, not `last`, so it is cumulative for the thread/session despite comments saying “during the turn” (`codex-rs/exec/src/event_processor_with_jsonl_output.rs:117`, `codex-rs/exec/src/event_processor_with_jsonl_output.rs:524`).
- Human exec output prints “tokens used” as blended total: non-cached input plus output (`codex-rs/exec/src/event_processor_with_human_output.rs:384`, `codex-rs/exec/src/event_processor_with_human_output.rs:502`).

TUI:

- TUI converts app-server `ThreadTokenUsage` back into its local token model (`codex-rs/tui/src/chatwidget.rs:887`).
- Status output uses cumulative `total_token_usage` for “Token usage” and `last_token_usage` for context-window remaining/used calculations (`codex-rs/tui/src/status/card.rs:326`, `codex-rs/tui/src/status/card.rs:337`, `codex-rs/tui/src/status/card.rs:854`).
- `/usage` renders account token activity from `GetAccountTokenUsageResponse`, not per-turn stream counts (`codex-rs/tui/src/chatwidget/tokens.rs:1`, `codex-rs/tui/src/chatwidget/tokens/chart.rs:63`).

Telemetry/analytics/extensions:

- `SessionTelemetry::record_responses` records provider response usage fields onto spans when `ResponseEvent::Completed` carries usage (`codex-rs/otel/src/events/session_telemetry.rs:417`).
- Turn lifecycle captures a token baseline at turn start and computes per-turn non-negative deltas at turn completion for span fields, histograms, and `TurnTokenUsageFact` analytics (`codex-rs/core/src/tasks/mod.rs:336`, `codex-rs/core/src/tasks/mod.rs:647`, `codex-rs/analytics/src/facts.rs:97`).
- Extension `TokenUsageContributor` callbacks run after cached usage updates and before client token-count notification; the goal extension uses this to account token budget deltas (`codex-rs/ext/extension-api/src/contributors.rs:189`, `codex-rs/ext/goal/src/extension.rs:330`).

## Gaps Or Ambiguities

- `TokenUsageInfo.total_token_usage` is cumulative session usage, while `last_token_usage.total_tokens` is used as current context-window usage. Adapters should not collapse these into one field (`codex-rs/tui/src/token_usage.rs:37`, `codex-rs/tui/src/status/card.rs:326`).
- `Session::get_total_token_usage` returns active context tokens derived from `last_token_usage.total_tokens` plus local estimated items, not the cumulative `total_token_usage` snapshot (`codex-rs/core/src/context_manager/history.rs:294`).
- Usage may be absent (`None`) on completed events or historical snapshots. Core protocol explicitly says unknown usage should not be displayed (`codex-rs/protocol/src/protocol.rs:1262`, `codex-rs/codex-api/src/sse/responses.rs:731`).
- Estimated/imported usage can have only `total_tokens` populated, with no input/output/cached/reasoning breakdown (`codex-rs/external-agent-sessions/src/export.rs:152`).
- No active cost/pricing computation was found in the inspected runtime paths. “Credits” and rate limits are separate backend/account concepts, not per-turn dollar cost.
- The TypeScript/exec simplified `Usage` omits `total_tokens`; Python/app-server expose the full total/last breakdown. This creates surface-level asymmetry (`sdk/typescript/src/events.ts:20`, `codex-rs/app-server-protocol/src/protocol/v2/thread.rs:1290`).
- Exec JSONL maps its turn-completed usage from cumulative `ThreadTokenUsage.total`, which may not mean per-turn usage despite the public type comment (`codex-rs/exec/src/event_processor_with_jsonl_output.rs:117`).

## Implications For Orchestrator Built-In Adapters

- Treat Codex token usage as an optional, final-turn metric. Do not expect token counts during streaming deltas.
- Preserve the distinction between cumulative session usage, last response/context usage, and per-turn deltas. If Orchestrator needs per-turn usage, derive it from before/after cumulative snapshots or a turn-start baseline; do not treat app-server `total` as per-turn usage, and do not assume `last` covers a whole turn with multiple model responses.
- Keep field names provider-neutral in Orchestrator (`input`, `cachedInput`, `output`, `reasoningOutput`, `total`) but map Codex from Responses API semantics.
- Support unknown/partial usage: `None` means do not display, and imported/estimated histories may only have `total_tokens`.
- Do not model cost unless another source supplies pricing. Current Codex code reports tokens, rate-limit percentages, credits, and backend account token activity, not monetary cost.
- For app-server adapters, listen for `thread/tokenUsage/updated` and correlate by `threadId`/`turnId`. Expect replayed historical updates on resume/fork and live updates near turn completion.
- For exec/SDK adapters, verify which surface is used: TypeScript `turn.completed.usage` is simplified and lacks totals; Python notification usage is full `ThreadTokenUsage`; exec JSONL may be cumulative.
- Provider adapters should normalize provider-specific final-response usage into a Codex-like structure at the provider boundary. For Responses-compatible providers, the authoritative source is `response.completed.usage`.

## References

- `/Users/ramos/oss-agents/codex/codex-rs/protocol/src/protocol.rs:1994`
- `/Users/ramos/oss-agents/codex/codex-rs/codex-api/src/sse/responses.rs:100`
- `/Users/ramos/oss-agents/codex/codex-rs/codex-api/src/common.rs:72`
- `/Users/ramos/oss-agents/codex/codex-rs/core/src/client.rs:1823`
- `/Users/ramos/oss-agents/codex/codex-rs/core/src/session/turn.rs:2132`
- `/Users/ramos/oss-agents/codex/codex-rs/core/src/session/mod.rs:3203`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs:1278`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server/src/bespoke_event_handling.rs:1608`
- `/Users/ramos/oss-agents/codex/codex-rs/backend-client/src/client.rs:312`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/account_processor.rs:919`
- `/Users/ramos/oss-agents/codex/sdk/typescript/src/events.ts:20`
- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/_run.py:68`
- `/Users/ramos/oss-agents/codex/codex-rs/tui/src/status/card.rs:326`
- `/Users/ramos/oss-agents/codex/codex-rs/exec/src/event_processor_with_jsonl_output.rs:117`
- `/Users/ramos/oss-agents/codex/codex-rs/ext/extension-api/src/contributors.rs:189`
