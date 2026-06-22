# Token Metrics Research: OpenCode

Date: 2026-06-19

OpenCode paths below are relative to `/Users/ramos/oss-agents/opencode`.

## Summary

OpenCode has a provider-neutral usage contract in `@opencode-ai/llm`. `LLM.Usage` keeps inclusive totals (`inputTokens`, `outputTokens`, `totalTokens`) plus a non-overlapping breakdown (`nonCachedInputTokens`, cache read/write input tokens, reasoning tokens) and raw `providerMetadata` for audit/debug fields (`packages/llm/src/schema/events.ts:7`, `packages/llm/src/schema/events.ts:51`).

Provider adapters are responsible for turning raw provider stream usage into `LLM.Usage`. The framework then attaches usage to `step-finish` and `finish` events, persists a smaller assistant/session token shape, and exposes it through session APIs, UI/TUI context views, ACP usage updates, and a stats CLI.

Cost is not provider-reported in the common flow. It is derived from model catalog pricing and normalized tokens in the legacy session processor (`packages/opencode/src/session/session.ts:384`). The newer core runner's event publisher currently records normalized tokens but sets `cost: 0` on `SessionEvent.Step.Ended` (`packages/core/src/session/runner/publish-llm-event.ts:376`).

## Where Usage Is Modeled

- `LLM.Usage` is the canonical provider-neutral model. Its documented invariant is: `nonCachedInputTokens + cacheReadInputTokens + cacheWriteInputTokens = inputTokens`, and `reasoningTokens <= outputTokens` (`packages/llm/src/schema/events.ts:13`, `packages/llm/src/schema/events.ts:25`).
- `LLMEvent.stepFinish` and `LLMEvent.finish` can both carry `usage` (`packages/llm/src/schema/events.ts:183`, `packages/llm/src/schema/events.ts:192`). `LLMResponse.usage(...)` returns explicit response usage or the latest usage-bearing event (`packages/llm/src/schema/events.ts:332`, `packages/llm/src/schema/events.ts:364`).
- Session events persist a smaller token shape on `session.next.step.ended`: `input`, `output`, `reasoning`, and `cache.read/write`, plus `cost` (`packages/core/src/session/event.ts:189`).
- Assistant messages can store optional `cost` and `tokens` with the same smaller shape (`packages/core/src/session/message.ts:142`).
- Session rows store aggregate `cost`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, and `tokens_cache_write` (`packages/core/src/session/sql.ts:42`).
- Model pricing is modeled separately as `ModelV2.Cost`: input, output, cache read, cache write, with optional context-size tiers (`packages/core/src/model.ts:24`, `packages/core/src/model.ts:74`).

## Where Usage Data Originates

Provider stream payloads are the primary source:

- OpenAI Chat requests `stream_options: { include_usage: true }` (`packages/llm/src/protocols/openai-chat.ts:342`) and maps `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, and `completion_tokens_details.reasoning_tokens` (`packages/llm/src/protocols/openai-chat.ts:115`, `packages/llm/src/protocols/openai-chat.ts:378`).
- OpenAI Responses reads usage from `response.completed` / `response.incomplete` events under `response.usage` (`packages/llm/src/protocols/openai-responses.ts:165`, `packages/llm/src/protocols/openai-responses.ts:859`).
- Anthropic Messages reads `message.usage` and delta `usage`, where `input_tokens` is non-cached and cache read/write are separate (`packages/llm/src/protocols/anthropic-messages.ts:171`, `packages/llm/src/protocols/anthropic-messages.ts:556`).
- Gemini reads `usageMetadata` (`promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount`) (`packages/llm/src/protocols/gemini.ts:116`, `packages/llm/src/protocols/gemini.ts:327`).
- Bedrock Converse reads `metadata.usage`; `messageStop` carries the reason and `metadata` carries usage, so the parser holds both until halt (`packages/llm/src/protocols/bedrock-converse.ts:142`, `packages/llm/src/protocols/bedrock-converse.ts:448`).
- OpenRouter reuses OpenAI Chat parsing but may add a provider-specific `usage: { include: true }` request option from `providerOptions.openrouter.usage` (`packages/llm/src/providers/openrouter.ts:56`).

There is also an AI SDK bridge path in `packages/opencode`: it extracts `event.usage` on `finish-step` and `event.totalUsage` on `finish`, mapping AI SDK fields into `LLMEvent` usage (`packages/opencode/src/session/llm/ai-sdk.ts:44`, `packages/opencode/src/session/llm/ai-sdk.ts:87`).

Pricing originates from model catalogs/config, not responses. The core models.dev plugin maps `input`, `output`, `cache_read`, `cache_write`, and `context_over_200k` into `ModelV2.Cost` (`packages/core/src/plugin/models-dev.ts:16`). Plugin provider config can override cost fields (`packages/core/src/config/plugin/provider.ts:104`). The legacy provider service has its own models.dev-to-provider cost mapping (`packages/opencode/src/provider/provider.ts:1138`).

## Runtime Flow

Native `@opencode-ai/llm` flow:

1. `LLMClient.compile` applies cache policy, lowers the common `LLMRequest` into the route body, and prepares transport (`packages/llm/src/route/client.ts:337`).
2. `LLMClient.stream` returns provider `LLMEvent`s; `LLMClient.generate` folds them and keeps the latest usage-bearing event as `response.usage` (`packages/llm/src/route/client.ts:367`, `packages/llm/src/route/client.ts:375`).
3. `SessionRunner` builds one `LLM.request(...)`, streams it, and publishes each event through `createLLMEventPublisher` (`packages/core/src/session/runner/llm.ts:219`, `packages/core/src/session/runner/llm.ts:245`).
4. The publisher converts `LLM.Usage` into persisted session tokens: non-cached input, visible output, reasoning, cache read, cache write (`packages/core/src/session/runner/publish-llm-event.ts:17`). On `step-finish`, it publishes `SessionEvent.Step.Ended` with those tokens and `cost: 0` (`packages/core/src/session/runner/publish-llm-event.ts:376`).

Legacy/bridge flow:

1. The AI SDK bridge converts AI SDK stream parts into `LLMEvent.stepFinish` / `LLMEvent.finish` with usage (`packages/opencode/src/session/llm/ai-sdk.ts:87`).
2. `SessionProcessor` handles `step-finish`, calls `Session.getUsage(...)`, updates the assistant message, writes a `step-finish` part, and can dual-publish a V2 `SessionEvent.Step.Ended` (`packages/opencode/src/session/processor.ts:693`).
3. `Session.getUsage(...)` clamps counts, subtracts cache and reasoning from inclusive totals, chooses the applicable pricing tier by context size, and computes cost per million tokens (`packages/opencode/src/session/session.ts:384`, `packages/opencode/src/session/session.ts:409`, `packages/opencode/src/session/session.ts:427`).
4. The V1 projector detects `step-finish` parts and applies or reverses their cost/token values into the session aggregate columns (`packages/core/src/session/projector.ts:37`, `packages/core/src/session/projector.ts:91`, `packages/core/src/session/projector.ts:314`).

V2 session message projection stores `SessionEvent.Step.Ended` values on assistant messages through `SessionMessageUpdater` (`packages/core/src/session/message-updater.ts:211`). I did not find a matching V2 `SessionEvent.Step.Ended` aggregate updater for `SessionTable.cost` / token columns; the aggregate updater found in `SessionProjector` is the V1 `PartUpdated` `step-finish` path.

## Streaming And Final Availability

Usage is generally available only at the provider's terminal or near-terminal stream boundary:

- OpenAI Chat accumulates usage if any chunk contains it, stores it in parser state, then emits it on lifecycle finish (`packages/llm/src/protocols/openai-chat.ts:399`, `packages/llm/src/protocols/openai-chat.ts:449`).
- OpenAI Responses emits usage from `response.completed` / `response.incomplete`, where the parser calls `Lifecycle.finish(...)` immediately (`packages/llm/src/protocols/openai-responses.ts:859`, `packages/llm/src/protocols/openai-responses.ts:928`).
- Anthropic emits partial usage on `message_start` and authoritative totals later on `message_delta`; OpenCode right-biased merges fields (`packages/llm/src/protocols/anthropic-messages.ts:580`, `packages/llm/src/protocols/anthropic-messages.ts:642`).
- Gemini stores `usageMetadata` in parser state and emits finish on stream halt if there is a finish reason or usage (`packages/llm/src/protocols/gemini.ts:368`, `packages/llm/src/protocols/gemini.ts:388`).
- Bedrock may split reason and usage across `messageStop` and `metadata`; OpenCode emits one finish from `onHalt` after both have had a chance to arrive (`packages/llm/src/protocols/bedrock-converse.ts:564`, `packages/llm/src/protocols/bedrock-converse.ts:608`).

Intermediate text/tool deltas do not carry stable cost/session usage. Consumers should expect final token/cost values after `step-finish` / `finish` or the persisted `SessionEvent.Step.Ended`.

## Provider-Specific Parts

- Raw usage field names and semantics are provider-specific; normalization lives in protocol `mapUsage` functions.
- Cache hints are provider-specific on request lowering. The default cache policy is applied only to routes that respect inline cache hints: Anthropic Messages and Bedrock Converse (`packages/llm/src/cache-policy.ts:26`, `packages/llm/src/cache-policy.ts:39`). OpenAI/Gemini cache behavior is treated as implicit or out-of-band there.
- OpenAI Responses can carry `prompt_cache_key` through provider options (`packages/llm/src/protocols/utils/openai-options.ts:73`, `packages/llm/src/protocols/openai-responses.ts:446`). The core runner sets an OpenAI prompt cache key from the session id (`packages/core/src/session/runner/llm.ts:218`).
- Bedrock includes an unnormalized `metadata.metrics` field in its event schema, but only `metadata.usage` is mapped to `LLM.Usage` (`packages/llm/src/protocols/bedrock-converse.ts:191`, `packages/llm/src/protocols/bedrock-converse.ts:574`).
- GitHub Copilot has provider-specific adapters that map OpenAI-like usage into their own nested token shape and can preserve Copilot billing metadata such as `totalNanoAiu` (`packages/core/src/github-copilot/chat/openai-compatible-chat-language-model.ts:280`, `packages/core/src/github-copilot/responses/openai-responses-language-model.ts:1269`). The AI SDK bridge extracts `total_nano_aiu` and places it in provider metadata (`packages/opencode/src/session/llm/ai-sdk.ts:30`).

## Surfaces That Consume Or Expose Usage

- HTTP session APIs expose `Session.Info` and messages; those schemas include session aggregate cost/tokens and assistant message cost/tokens (`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:111`, `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:179`, `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:104`).
- The newer server API similarly exposes session list/get and session messages (`packages/server/src/handlers/session.ts:31`, `packages/server/src/handlers/message.ts:41`).
- The app context indicator computes total cost from assistant messages, finds the latest assistant with tokens, calculates total tokens, and derives percent from model context limit (`packages/app/src/components/session/session-context-metrics.ts:37`, `packages/app/src/components/session/session-context-metrics.ts:50`). The context tab shows totals, input/output/reasoning/cache tokens, context usage, and total cost (`packages/app/src/components/session/session-context-tab.tsx:199`).
- The app context-usage tooltip shows latest context token total/percent and session cost (`packages/app/src/components/session-context-usage.tsx:55`, `packages/app/src/components/session-context-usage.tsx:81`).
- TUI sync updates assistant message cost/tokens when `session.next.step.ended` arrives (`packages/tui/src/context/data.tsx:236`). TUI subagent/footer/sidebar views display latest assistant token totals and session cost (`packages/tui/src/routes/session/subagent-footer.tsx:33`, `packages/tui/src/feature-plugins/sidebar/context.tsx:19`).
- ACP exposes usage in two ways: prompt responses include ACP `usage` built from the assistant token shape, and `usage_update` sends used context plus cumulative assistant cost (`packages/opencode/src/acp/usage.ts:83`, `packages/opencode/src/acp/usage.ts:176`, `packages/opencode/src/acp/service.ts:814`).
- `opencode stats` aggregates session cost/tokens and per-model assistant-message usage, including cache read/write, then prints cost and token summaries (`packages/opencode/src/cli/cmd/stats.ts:163`, `packages/opencode/src/cli/cmd/stats.ts:235`, `packages/opencode/src/cli/cmd/stats.ts:312`).

## Gaps Or Ambiguities

- Native core runner cost is currently hard-coded to `0` at `SessionEvent.Step.Ended`; the implemented price calculation is in the legacy `Session.getUsage(...)` path (`packages/core/src/session/runner/publish-llm-event.ts:383`, `packages/opencode/src/session/session.ts:436`).
- V2 `SessionEvent.Step.Ended` updates assistant message cost/tokens, but I did not find a direct V2 projector path that rolls those values into `SessionTable.cost` / aggregate token columns. The aggregate updater found is driven by V1 `PartUpdated` `step-finish` parts (`packages/core/src/session/message-updater.ts:211`, `packages/core/src/session/projector.ts:314`).
- `packages/llm/src/protocols/shared.ts` has comments saying `inputTokens` / `outputTokens` are "non-cached input and visible output" (`packages/llm/src/protocols/shared.ts:76`), which conflicts with the explicit `LLM.Usage` contract and protocol mappers that pass inclusive totals (`packages/llm/src/schema/events.ts:13`, `packages/llm/src/protocols/openai-chat.ts:389`). The code behavior is inclusive totals plus separate breakdown.
- Some provider-specific fields remain only in `providerMetadata` or bridge-specific metadata. Example: Bedrock `metrics` is parsed as unknown but not normalized; Copilot `totalNanoAiu` is a special cost override in the legacy flow (`packages/llm/src/protocols/bedrock-converse.ts:194`, `packages/opencode/src/session/session.ts:435`).
- OpenTelemetry exists for AI SDK calls (`packages/opencode/src/session/llm.ts:344`), but I did not find code that explicitly exports token/cost metrics through telemetry. Usage metrics are exposed through session state/API/UI/ACP/stats instead.

## Implications For Orchestrator Custom Agents

- Treat OpenCode usage as a final-turn artifact. During streaming, tokens/cost are not stable until the provider emits terminal usage and OpenCode publishes `step-finish` / `SessionEvent.Step.Ended`.
- The best interoperability target is the normalized assistant/session token shape: non-cached input, visible output, reasoning, cache read, cache write, plus cost if available. It avoids provider field-name differences.
- For custom agents backed by OpenCode provider streams, implement provider-specific raw usage mapping at the adapter boundary, then emit the framework-neutral usage/cost shape. Do not make downstream surfaces parse `prompt_tokens`, `usageMetadata`, etc.
- Preserve raw provider metadata when possible. OpenCode uses it for provider-specific audit/billing details and bridge exceptions.
- Be careful with session-level aggregate cost/tokens if integrating with newer V2 events: message-level tokens may be present even when session aggregate fields are incomplete or zero, depending on which runtime path produced the session.

## References

- `packages/llm/src/schema/events.ts:7` - canonical `LLM.Usage`, usage-bearing LLM events, response usage fallback.
- `packages/llm/src/protocols/openai-chat.ts:115` - OpenAI Chat usage schema and mapper.
- `packages/llm/src/protocols/openai-responses.ts:165` - OpenAI Responses usage schema and terminal mapping.
- `packages/llm/src/protocols/anthropic-messages.ts:171` - Anthropic usage schema, merge, and mapper.
- `packages/llm/src/protocols/gemini.ts:116` - Gemini `usageMetadata` mapper.
- `packages/llm/src/protocols/bedrock-converse.ts:142` - Bedrock Converse usage and split terminal event handling.
- `packages/llm/src/cache-policy.ts:1` - request cache hint policy.
- `packages/core/src/session/runner/llm.ts:219` - native session runner request and stream loop.
- `packages/core/src/session/runner/publish-llm-event.ts:17` - native usage-to-session-token conversion.
- `packages/opencode/src/session/processor.ts:693` - legacy/bridge `step-finish` handling.
- `packages/opencode/src/session/session.ts:384` - legacy cost and token calculation.
- `packages/core/src/session/projector.ts:91` - session aggregate cost/token projection from V1 step-finish parts.
- `packages/app/src/components/session/session-context-metrics.ts:37` - app context usage metrics.
- `packages/opencode/src/acp/usage.ts:83` - ACP usage conversion and usage updates.
- `packages/opencode/src/cli/cmd/stats.ts:163` - stats CLI usage aggregation.
