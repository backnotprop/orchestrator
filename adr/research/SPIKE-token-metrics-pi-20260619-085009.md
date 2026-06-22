# Token Metrics Research: Pi

Date: 2026-06-19

## Summary

Pi has one normalized chat usage model: `Usage` on every `AssistantMessage`. It records `input`, `output`, `cacheRead`, `cacheWrite`, optional Anthropic-only `cacheWrite1h`, `totalTokens`, and a cost breakdown. The normalized message also records `api`, `provider`, `model`, optional `responseModel`, optional `responseId`, `stopReason`, and timestamp. See `/Users/ramos/oss-agents/pi/packages/ai/src/types.ts:274` and `/Users/ramos/oss-agents/pi/packages/ai/src/types.ts:299`.

Usage data normally originates from provider response metadata in `packages/ai`, not from Pi-side tokenization. Pi-side token estimates are used for compaction, branch summarization, test/faux providers, and analysis scripts, but provider-reported usage is the source of persisted model usage. Costs are computed from the selected model's pricing metadata in dollars per million tokens. See `/Users/ramos/oss-agents/pi/packages/ai/src/models.ts:39`.

Usage becomes durable when the finalized assistant message is emitted on `message_end` and persisted into session JSONL. Streaming partials can carry updated `partial.usage`, but there is no standalone `usage` event. Availability during streaming and aborts is provider-specific.

## Where Usage Is Modeled

- Chat usage is modeled by `Usage`: `input`, `output`, `cacheRead`, `cacheWrite`, optional `cacheWrite1h`, `totalTokens`, and `cost.{input,output,cacheRead,cacheWrite,total}` in `/Users/ramos/oss-agents/pi/packages/ai/src/types.ts:274`.
- `AssistantMessage` requires `usage` and carries provider/model identity plus `responseModel` and `responseId` metadata in `/Users/ramos/oss-agents/pi/packages/ai/src/types.ts:299`.
- Image generation can also expose optional `usage?: Usage` on `AssistantImages`, but this is separate from the chat agent loop in `/Users/ramos/oss-agents/pi/packages/ai/src/types.ts:335`.
- Model pricing is part of `Model.cost` in `/Users/ramos/oss-agents/pi/packages/ai/src/types.ts:579`, and built-in models are loaded from generated metadata in `/Users/ramos/oss-agents/pi/packages/ai/src/models.ts:1`.
- The generated model catalog stores per-model cost rates and context windows, for example `/Users/ramos/oss-agents/pi/packages/ai/src/models.generated.ts:16`.
- Coding-agent session stats expose aggregated `tokens`, total `cost`, and optional current `contextUsage` in `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/agent-session.ts:220`.
- Compaction entries store `tokensBefore`, not a full usage object, in `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/session-manager.ts:69`.

## Where Usage Data Originates

Provider parsers initialize usage to zero, then replace or mutate it when provider metadata arrives:

- OpenAI-compatible Chat Completions parses `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, DeepSeek-style `prompt_cache_hit_tokens`, and optional `cache_write_tokens` in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/openai-completions.ts:1026`.
- OpenAI-compatible streaming requests `stream_options: { include_usage: true }` unless compatibility disables it in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/openai-completions.ts:521`.
- OpenAI Responses, Azure OpenAI Responses, and Codex use `response.usage.input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens`, and `total_tokens` from `response.completed` in the shared parser at `/Users/ramos/oss-agents/pi/packages/ai/src/providers/openai-responses-shared.ts:494`.
- Anthropic captures early input/cache data from `message_start` and updates fields from `message_delta` in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/anthropic.ts:533` and `/Users/ramos/oss-agents/pi/packages/ai/src/providers/anthropic.ts:667`.
- Google and Vertex read `usageMetadata.promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `cachedContentTokenCount`, and `totalTokenCount` in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/google.ts:214` and `/Users/ramos/oss-agents/pi/packages/ai/src/providers/google-vertex.ts:231`.
- Bedrock reads `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheWriteInputTokens`, and `totalTokens` from metadata events in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/amazon-bedrock.ts:497`.
- Mistral reads `promptTokens`, `completionTokens`, and `totalTokens` from streamed chunk usage in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/mistral.ts:307`.
- The faux provider estimates usage locally from serialized context and output text, with session-id based cache simulation, in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/faux.ts:201`.
- OpenRouter image generation parses optional chat-completion-style image usage and computes image cost inline in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/images/openrouter.ts:74` and `/Users/ramos/oss-agents/pi/packages/ai/src/providers/images/openrouter.ts:155`.

Costs originate from model pricing metadata, not provider usage payloads. `calculateCost()` multiplies normalized token components by `model.cost` rates and has special Anthropic 1-hour cache-write handling in `/Users/ramos/oss-agents/pi/packages/ai/src/models.ts:39`. Custom model configs can provide cost rates, and missing custom costs default to zero in `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/model-registry.ts:594`.

## Runtime Flow

1. `stream()` and `complete()` resolve the registered API provider for the selected model API and return an `AssistantMessageEventStream` or its final result in `/Users/ramos/oss-agents/pi/packages/ai/src/stream.ts:40`.
2. Provider implementations create an `AssistantMessage` with zero usage, parse provider stream chunks/events, update `output.usage`, call `calculateCost()`, and end with `done` or `error`.
3. The assistant event stream exposes the final assistant message through `result()` when a `done` or `error` event arrives in `/Users/ramos/oss-agents/pi/packages/ai/src/utils/event-stream.ts:69`.
4. `agentLoop` consumes provider events, appends the partial assistant message to context on `start`, emits `message_update` for content events, then replaces it with `response.result()` and emits `message_end` in `/Users/ramos/oss-agents/pi/packages/agent/src/agent-loop.ts:313`.
5. The `Agent` class clears `streamingMessage` and appends the final message to in-memory state on `message_end` in `/Users/ramos/oss-agents/pi/packages/agent/src/agent.ts:519`.
6. Coding-agent emits extension events before persistence. A `message_end` extension can replace the finalized message in place, including usage/cost, before the session manager writes it. See `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/agent-session.ts:639` and the regression test at `/Users/ramos/oss-agents/pi/packages/coding-agent/test/suite/regressions/3982-message-end-cost-override.test.ts:14`.
7. Coding-agent persists user/assistant/tool-result `message_end` events as `SessionMessageEntry` objects in `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/agent-session.ts:507` and `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/session-manager.ts:950`.

The lower-level `packages/agent` harness mirrors the same persistence model: it appends every `message_end` to its harness session in `/Users/ramos/oss-agents/pi/packages/agent/src/harness/agent-harness.ts:510`.

## Streaming And Final Availability

The event protocol has `start`, content/thinking/tool-call events, `done`, and `error`; it does not define a separate usage event in `/Users/ramos/oss-agents/pi/packages/ai/src/types.ts:361`. Usage is available on the `partial` assistant message attached to events after a provider has updated it, and on the final `done.message` or `error.error`.

Provider timing differs:

- OpenAI-compatible Chat Completions usually reports usage in a final streamed chunk. Pi updates `output.usage` when it sees `chunk.usage` or fallback `choice.usage`, then emits the final `done` message in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/openai-completions.ts:278` and `/Users/ramos/oss-agents/pi/packages/ai/src/providers/openai-completions.ts:408`.
- OpenAI Responses updates usage on `response.completed`, so usage is effectively final-stage data in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/openai-responses-shared.ts:494`.
- Anthropic usage can become nonzero early because `message_start` includes input/cache fields, and `message_delta` updates output/cache fields. See `/Users/ramos/oss-agents/pi/packages/ai/src/providers/anthropic.ts:533` and `/Users/ramos/oss-agents/pi/packages/ai/src/providers/anthropic.ts:667`.
- Google/Vertex usage can update whenever a streamed chunk carries `usageMetadata` in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/google.ts:214`.
- Tests explicitly document abort differences: OpenAI providers, Codex, z.ai, Bedrock, and Vercel AI Gateway often have zero usage on abort because usage only arrives in the final chunk, while Anthropic and Google can send usage earlier. See `/Users/ramos/oss-agents/pi/packages/ai/test/tokens.test.ts:52`.

After compaction, current context usage is intentionally unknown until a post-compaction assistant response provides fresh usage. `getContextUsage()` returns `{ tokens: null, percent: null }` in that state in `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/agent-session.ts:2982`.

## Provider-Specific Parts

- Raw field names and streaming timing are provider-specific. The framework normalizes them into `Usage`.
- Cache semantics are provider-specific. OpenAI-compatible completions subtract cache hits and optional writes from prompt tokens in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/openai-completions.ts:1035`; OpenAI Responses subtract cached tokens but does not model cache writes in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/openai-responses-shared.ts:499`; Anthropic reads both cache-read and cache-creation fields in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/anthropic.ts:538`; Bedrock reads cache-read/cache-write metadata in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/amazon-bedrock.ts:502`.
- Anthropic is the only provider path that records `cacheWrite1h`, used to price 1-hour cache writes at 2x input cost in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/anthropic.ts:542` and `/Users/ramos/oss-agents/pi/packages/ai/src/models.ts:40`.
- Google includes reasoning/thought token cost by adding `thoughtsTokenCount` to output tokens in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/google.ts:218`.
- OpenAI Responses and OpenAI Codex can apply service-tier cost multipliers after normal cost calculation in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/openai-responses.ts:296` and `/Users/ramos/oss-agents/pi/packages/ai/src/providers/openai-codex-responses.ts:499`.
- `sessionId` and `cacheRetention` are request options that providers map to prompt-cache keys, headers, or cache-control markers. The option contract is in `/Users/ramos/oss-agents/pi/packages/ai/src/types.ts:100`; OpenAI Completions sends prompt-cache hints in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/openai-completions.ts:513`; Anthropic applies `cache_control` markers in `/Users/ramos/oss-agents/pi/packages/ai/src/providers/anthropic.ts:910`.

Framework-specific parts are the `Usage` shape, central cost calculation, model pricing registry, event protocol, agent/session persistence, session stats, compaction heuristics, and export/scripts aggregation.

## Surfaces That Consume Or Expose Usage

- AI package callers receive usage on final `AssistantMessage` from `complete()`/`stream().result()`, and serialized contexts retain it because messages are plain JSON-compatible objects. The README demonstrates reading `finalMessage.usage` in `/Users/ramos/oss-agents/pi/packages/ai/README.md:198`.
- Agent event listeners see usage on `message_update` partial messages and finalized `message_end` messages via `AgentEvent` in `/Users/ramos/oss-agents/pi/packages/agent/src/types.ts:416`.
- Proxy streams serialize only final `done`/`error` usage and restore it onto the partial assistant message in `/Users/ramos/oss-agents/pi/packages/agent/src/proxy.ts:47` and `/Users/ramos/oss-agents/pi/packages/agent/src/proxy.ts:350`.
- Coding-agent sessions persist assistant usage in session JSONL `message` entries in `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/session-manager.ts:53`.
- `AgentSession.getSessionStats()` sums assistant `usage` fields into cumulative token and cost totals in `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/agent-session.ts:2930`.
- `AgentSession.getContextUsage()` exposes current context pressure using the latest valid assistant usage plus estimates for trailing messages in `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/agent-session.ts:2975`.
- The interactive footer sums all persisted assistant entries, shows input/output/cache read/cache write, latest cache-hit rate, cost, and context percentage in `/Users/ramos/oss-agents/pi/packages/coding-agent/src/modes/interactive/components/footer.ts:83`.
- The `/session` command renders token and cost totals from `getSessionStats()` in `/Users/ramos/oss-agents/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:5376`.
- RPC exposes `get_session_stats`, and `PiClient.getSessionStats()` wraps it in `/Users/ramos/oss-agents/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:566` and `/Users/ramos/oss-agents/pi/packages/coding-agent/src/modes/rpc/rpc-client.ts:343`.
- Extensions can read current context usage through `ctx.getContextUsage()` and can read session entries through the read-only session manager in `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/extensions/types.ts:300`.
- Exported HTML recomputes token/cost header stats from saved assistant messages in `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/export-html/template.js:1324`.
- Offline scripts aggregate persisted usage: `scripts/stats.ts` sums tokens and costs from assistant entries in `/Users/ramos/oss-agents/pi/scripts/stats.ts:86`; `scripts/cost.ts` groups `usage.cost` by day/provider in `/Users/ramos/oss-agents/pi/scripts/cost.ts:92`; `scripts/session-context-stats.mjs` uses `usage.totalTokens` with a component fallback in `/Users/ramos/oss-agents/pi/scripts/session-context-stats.mjs:156`.
- Context overflow detection consumes usage for silent overflow cases, checking `message.usage.input + message.usage.cacheRead` against the model context window in `/Users/ramos/oss-agents/pi/packages/ai/src/utils/overflow.ts:136`.
- Compaction consumes usage to estimate current context tokens and records `tokensBefore`; it skips aborted/error assistant usage in `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/compaction/compaction.ts:135`.

## Gaps Or Ambiguities

- There is no separate durable metrics store or parent-run/run-id usage object. Durable usage lives on assistant messages in session entries.
- There is no explicit streaming `usage` event. Streaming consumers must inspect `partial.usage`, and final consumers should rely on `done`/`error` or `message_end`.
- Error and abort usage is not uniformly available. The code deliberately keeps zero usage when providers only report final usage and the stream aborts before that final chunk.
- `totalTokens` is normalized but not sourced the same way everywhere: some providers use native totals, some compute from components, and several fall back when native totals are absent.
- Cost accuracy depends on model pricing metadata, custom model overrides, and provider/service-tier semantics. Custom models without cost config default to zero cost, and extensions can replace finalized usage/cost before persistence.
- Compaction `tokensBefore` and branch-summary token budgets are estimates, not provider usage. They should not be aggregated as spend.
- Current context usage is unknown immediately after compaction until the next successful assistant response. This is intentional to avoid reusing stale pre-compaction usage.
- The implemented `telemetry.ts` only gates install telemetry and does not send token metrics. `/Users/ramos/oss-agents/pi/packages/agent/docs/observability.md:187` mentions a proposed `pi.ai.provider.usage` event, but the current code search did not find that implemented.
- Tool analysis scripts estimate tool-result tokens from content length, separate from provider model usage. See `/Users/ramos/oss-agents/pi/scripts/tool-stats.ts:133`.

## Implications For Orchestrator Parent Runs

- The safest aggregation point is the finalized assistant `message_end` or persisted session `message` entries. Treat `AssistantMessage.usage` as canonical once the message is final.
- Parent runs should expect missing or zero usage for aborted/error responses depending on provider. Do not assume final token counts are known until the provider stream ends.
- Use normalized fields directly: `input`, `output`, `cacheRead`, `cacheWrite`, and `cost.total`. Keep `provider`, `model`, `responseModel`, and `responseId` if attribution matters.
- Do not count compaction `tokensBefore` as model usage or cost. It is useful as a context-pressure signal only.
- For live progress, display usage as unknown or partial until final. Provider timing differences make cross-provider live token accounting unreliable.
- After a compaction boundary, avoid using kept pre-compaction assistant usage as current context size. Pi itself reports context usage as unknown until a post-compaction response arrives.
- If Orchestrator allows extensions or adapters to mutate messages, record whether usage is provider-originated or post-processed. Pi extensions can change finalized usage before persistence.

## References

- Usage and message types: `/Users/ramos/oss-agents/pi/packages/ai/src/types.ts:274`, `/Users/ramos/oss-agents/pi/packages/ai/src/types.ts:299`, `/Users/ramos/oss-agents/pi/packages/ai/src/types.ts:361`.
- Cost/model metadata: `/Users/ramos/oss-agents/pi/packages/ai/src/models.ts:39`, `/Users/ramos/oss-agents/pi/packages/ai/src/models.generated.ts:16`, `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/model-registry.ts:594`.
- Provider normalization: `/Users/ramos/oss-agents/pi/packages/ai/src/providers/openai-completions.ts:1026`, `/Users/ramos/oss-agents/pi/packages/ai/src/providers/openai-responses-shared.ts:494`, `/Users/ramos/oss-agents/pi/packages/ai/src/providers/anthropic.ts:533`, `/Users/ramos/oss-agents/pi/packages/ai/src/providers/google.ts:214`, `/Users/ramos/oss-agents/pi/packages/ai/src/providers/amazon-bedrock.ts:497`, `/Users/ramos/oss-agents/pi/packages/ai/src/providers/mistral.ts:307`.
- Agent flow and persistence: `/Users/ramos/oss-agents/pi/packages/agent/src/agent-loop.ts:313`, `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/agent-session.ts:507`, `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/session-manager.ts:950`.
- Stats and UI: `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/agent-session.ts:2930`, `/Users/ramos/oss-agents/pi/packages/coding-agent/src/modes/interactive/components/footer.ts:83`, `/Users/ramos/oss-agents/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:566`, `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/export-html/template.js:1324`.
- Compaction/context: `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/compaction/compaction.ts:135`, `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/compaction/compaction.ts:186`, `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/agent-session.ts:2975`.
