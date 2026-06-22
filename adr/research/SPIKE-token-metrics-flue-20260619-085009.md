# Token Metrics Research: Flue

Date: 2026-06-19

## Summary

Flue models token and cost usage as `PromptUsage`: `input`, `output`,
`cacheRead`, `cacheWrite`, `totalTokens`, and a matching nested `cost` object.
The runtime does not independently tokenize ordinary model calls. It takes
provider-reported `Usage` from `@earendil-works/pi-ai` assistant messages,
normalizes it into Flue's public shape, and aggregates it across the work done
by a prompt/skill/task operation.

Usage is final metadata, not live token-by-token telemetry. Streaming text and
thinking deltas are live progress; the normalized `turn` event gets usage only
when a model turn ends. Prompt responses and `operation` events then expose the
aggregate usage for the enclosing operation.

Provider-specific accounting mostly lives below Flue in `pi-ai`. The important
Flue-owned exception is the Cloudflare Workers AI binding provider, which parses
OpenAI-compatible streaming usage events (`prompt_tokens`,
`completion_tokens`, `total_tokens`, cached prompt tokens) and sets per-token
cost to zero because Workers AI billing is not token-priced in that adapter.

## Where Usage Is Modeled

- Runtime public shape: `PromptUsage` is defined in
  `/Users/ramos/oss-agents/flue/packages/runtime/src/types.ts:623` with token
  fields at `:624-628` and nested cost fields at `:629-635`.
- Runtime response shapes: `PromptResponse` and `PromptResultResponse` both
  carry required `usage: PromptUsage` and selected `model` metadata in
  `/Users/ramos/oss-agents/flue/packages/runtime/src/types.ts:649-665`.
- Runtime event shapes: terminal `turn`, `compaction`, and `operation` events
  have optional `usage?: PromptUsage` in
  `/Users/ramos/oss-agents/flue/packages/runtime/src/types.ts:989-1038`.
- Session persistence: compaction entries persist optional summarization usage
  in `/Users/ramos/oss-agents/flue/packages/runtime/src/types.ts:731-743` and
  `/Users/ramos/oss-agents/flue/packages/runtime/src/session-history.ts:179-193`.
- SDK mirror: `@flue/sdk` duplicates `PromptUsage` and direct-agent
  `AgentPromptResponse` in
  `/Users/ramos/oss-agents/flue/packages/sdk/src/types.ts:24-53`.
- React UI state can store usage on `UIMessage.metadata.usage` in
  `/Users/ramos/oss-agents/flue/packages/react/src/types.ts:14-21`.

Cost semantics are explicitly delegated to the model cost table: Flue's runtime
types say `cost` is computed by `pi-ai` as per-million-token model rates times
usage, and custom/proxied providers may use non-USD units
(`/Users/ramos/oss-agents/flue/packages/runtime/src/types.ts:607-621`).

## Where Usage Data Originates

For standard HTTP providers, Flue receives usage from `@earendil-works/pi-ai`.
The runtime depends on `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`
(`/Users/ramos/oss-agents/flue/packages/runtime/package.json:66-69`), imports
`streamSimple` for normal turns
(`/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts:14-22`), and
imports `completeSimple` plus `Usage` for compaction
(`/Users/ramos/oss-agents/flue/packages/runtime/src/compaction.ts:10-22`).

The normalization boundary is small and mechanical:
`fromProviderUsage()` returns `undefined` for missing provider usage and
otherwise copies `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`,
and cost fields into Flue's `PromptUsage`
(`/Users/ramos/oss-agents/flue/packages/runtime/src/usage.ts:47-69`).
Aggregation is field-wise addition in
`/Users/ramos/oss-agents/flue/packages/runtime/src/usage.ts:26-45`.

The Cloudflare Workers AI binding provider is Flue-owned provider code. It
declares the OpenAI-compatible usage fields it understands in
`/Users/ramos/oss-agents/flue/packages/runtime/src/cloudflare/workers-ai-provider.ts:112-124`,
maps `prompt_tokens_details.cached_tokens` to `cacheRead`, subtracts cached
tokens from `input`, maps `completion_tokens` to `output`, and sets cost to zero
in `:154-168`. It requests streaming usage with
`stream_options: { include_usage: true }` in `:304-308` and applies either
top-level or choice-level usage chunks to the in-progress assistant message in
`:480-486`. Its test verifies cached-token handling in
`/Users/ramos/oss-agents/flue/packages/runtime/test/cloudflare-workers-ai-provider.test.ts:425-458`.

Model metadata comes from `pi-ai` catalog entries unless a Flue provider
registration overrides it. Registered catalog providers preserve metadata such
as cost, context window, and wire protocol
(`/Users/ramos/oss-agents/flue/packages/runtime/src/runtime/providers.ts:119-135`);
unknown custom models fall back to zero cost, zero context window, and zero max
tokens in `:316-334`.

## Runtime Flow

1. A `prompt()` call enters `runOperation('prompt', ...)` and then
   `runPromptCall()` (`/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts:676-697`,
   `:2328-2384`).
2. Each model turn emits `turn_request` and calls `streamSimple(model, context,
options)` through `emitTurnRequestAndStream()`
   (`/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts:413-437`,
   `:458-471`).
3. While the provider stream is live, message updates produce `text_delta` and
   thinking events, and stream chunks may be persisted for interrupted-turn
   recovery (`/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts:536-547`).
4. When the agent core reports `turn_end`, Flue checkpoints messages, emits
   `turn_messages`, then emits the normalized terminal `turn` event with
   `usage: fromProviderUsage(assistant?.usage)`
   (`/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts:593-635`).
5. The operation response uses `aggregateUsageSince(beforeLeafId)`, which walks
   the durable active path and sums assistant-message usage plus compaction-entry
   usage (`/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts:2061-2085`).
6. `runOperation()` emits an `operation` event with `usage` copied from the
   returned prompt/skill/task result when that result looks like `PromptUsage`
   (`/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts:1475-1508`,
   `:2509-2522`).

Durable direct-agent recovery can reconstruct a completed prompt result without
replaying provider work by reading the persisted assistant message and calling
`aggregateUsageSince(inputEntry.id)`
(`/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts:708-735`).

Compaction is part of the same accounting path. It estimates context size from
the latest assistant usage when available, then heuristics for trailing messages
(`/Users/ramos/oss-agents/flue/packages/runtime/src/compaction.ts:74-179`).
The summarization call(s) return provider usage from `completeSimple()`
(`/Users/ramos/oss-agents/flue/packages/runtime/src/compaction.ts:560-607`,
`:609-650`), which `compact()` normalizes and aggregates across one or two
summarization calls in `:672-733`. Session code persists that usage on the
compaction entry and emits it on the `compaction` event
(`/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts:1880-2018`).

## Streaming And Final Availability

Usage is available after a model turn completes:

- Live deltas are emitted during `message_update`
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts:536-547`).
- The terminal `turn` event with normalized usage is emitted at `turn_end`
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts:593-635`).
- The prompt response aggregate is returned after the operation completes
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts:2371-2380`).

The event docs match this: streaming deltas are live progress and not
authoritative state; late readers may miss earlier partial output until
`message_end` supplies the completed message
(`/Users/ramos/oss-agents/flue/apps/docs/src/content/docs/api/events-reference.md:51-65`).

`turn_request` is in-process only. It is emitted for observers and telemetry but
excluded from durable streams and HTTP stream reads
(`/Users/ramos/oss-agents/flue/packages/runtime/src/runtime/run-store.ts:149-165`;
docs at `/Users/ramos/oss-agents/flue/apps/docs/src/content/docs/api/events-reference.md:22`,
`:56`). Buffered progress events (`text_delta`, thinking events) are persisted
at most periodically for workflow streams
(`/Users/ramos/oss-agents/flue/packages/runtime/src/runtime/run-store.ts:129-147`,
`/Users/ramos/oss-agents/flue/packages/runtime/src/runtime/handle-agent.ts:729-790`).

For direct agents, `POST /agents/:name/:id?wait=result` returns the prompt
result envelope after completion
(`/Users/ramos/oss-agents/flue/packages/runtime/src/runtime/handle-agent.ts:150-180`,
`:483-499`). The SDK's `promptAgent()` exposes that as `AgentPromptResult.result`
(`/Users/ramos/oss-agents/flue/packages/sdk/src/public/invoke.ts:30-48`).
Without `wait=result`, clients observe events through Durable Streams; the SDK
stream wrapper yields typed `FlueEvent` values
(`/Users/ramos/oss-agents/flue/packages/sdk/src/public/stream.ts:57-72`).

## Provider-Specific Parts

- Standard provider token/cost details are provider-adapter behavior from
  `pi-ai`; Flue only consumes `AssistantMessage.usage`. This is visible in
  the small `fromProviderUsage()` copy layer
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/usage.ts:47-69`) and in
  `turn` event emission from `assistant?.usage`
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts:620-633`).
- Custom HTTP providers can be registered under a provider ID. Catalog provider
  IDs keep catalog cost/context metadata; unknown models get zero metadata
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/runtime/providers.ts:246-334`).
- New wire protocols can be registered by re-exporting `pi-ai`'s
  `registerApiProvider`
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/runtime/providers.ts:177-192`).
  Such providers must produce `pi-ai` assistant usage for Flue to expose it.
- Cloudflare Workers AI binding is Flue-specific. It requests usage in the
  streaming payload, parses OpenAI-compatible token fields, maps cached prompt
  tokens to `cacheRead`, leaves `cacheWrite` at zero, and reports zero cost
  because per-token cost is unknown
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/cloudflare/workers-ai-provider.ts:143-168`,
  `:304-308`, `:480-486`).
- Workers AI session affinity is sent as `x-session-affinity`, described as
  enabling prompt prefix caching, but Flue still relies on the provider's
  returned usage fields to report cache usage
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/cloudflare/workers-ai-provider.ts:325-330`).

## Surfaces That Consume Or Expose Usage

- Runtime API: `session.prompt()`, `session.skill()`, and `session.task()` return
  `PromptResponse` or `PromptResultResponse` with required `usage`
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/types.ts:649-665`). Tests
  assert prompt usage and model identity at
  `/Users/ramos/oss-agents/flue/packages/runtime/test/session-operations.test.ts:271-302`.
- Runtime events: terminal `turn`, `compaction`, and `operation` events expose
  optional usage (`/Users/ramos/oss-agents/flue/packages/runtime/src/types.ts:989-1038`).
  Structured-result retries are expected to aggregate multiple `turn` usages
  into the response usage
  (`/Users/ramos/oss-agents/flue/packages/runtime/test/structured-results.test.ts:228-264`).
- SDK: direct prompt results expose `AgentPromptResponse.usage`
  (`/Users/ramos/oss-agents/flue/packages/sdk/src/types.ts:42-53`), and stream
  events expose `turn.usage`, `compaction.usage`, and `operation.usage`
  (`/Users/ramos/oss-agents/flue/packages/sdk/src/types.ts:162-209`).
- React: `reduceTurn()` copies terminal `turn` usage and model identity into
  assistant UI message metadata
  (`/Users/ramos/oss-agents/flue/packages/react/src/agent-reducer.ts:340-361`).
- OpenTelemetry: model-turn spans export GenAI usage attributes and Flue total
  cost/total-token attributes; compaction and operation spans export Flue
  roll-up attributes
  (`/Users/ramos/oss-agents/flue/packages/opentelemetry/src/index.ts:252-280`,
  `:329-335`, `:487-512`). The README says not to sum roll-ups with nested
  model-turn leaf usage
  (`/Users/ramos/oss-agents/flue/packages/opentelemetry/README.md:56-64`).

## Gaps Or Ambiguities

- Per-turn usage is optional. If a provider does not report usage,
  `fromProviderUsage()` returns `undefined`
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/usage.ts:54-55`), terminal
  `turn`/`compaction`/`operation` event usage fields may be absent
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/types.ts:989-1038`), and
  operation aggregation falls back to the zero identity from `emptyUsage()`
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/usage.ts:14-23`,
  `/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts:2074-2085`).
- Flue does not expose a run-level usage total. `run_end` includes result/error
  state and duration, but no usage field
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/types.ts:1060-1067`).
  Run-level consumers need to aggregate `turn` events themselves or use
  operation/compaction roll-ups carefully.
- `cost` is only as reliable as the active model cost table. Flue's own docs in
  the type comment warn that custom/proxied providers may use other units
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/types.ts:615-621`), and
  unknown custom models get zero cost metadata
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/runtime/providers.ts:316-334`).
- Detailed message events are not the stable accounting surface. Docs warn that
  `message_start`/`message_end`, `turn_messages`, and `agent_end` detailed
  message payloads mirror the underlying agent library and are not yet stable;
  they also warn to count model activity from either normalized `turn` events or
  detailed message events, not both
  (`/Users/ramos/oss-agents/flue/apps/docs/src/content/docs/api/events-reference.md:65`,
  `:91-93`).
- Context-token estimation for compaction is not a general tokenizer. It uses
  latest assistant usage when available and a chars/4 heuristic otherwise
  (`/Users/ramos/oss-agents/flue/packages/runtime/src/compaction.ts:106-168`).

## Implications For Orchestrator Custom Agents

- Use terminal prompt responses when you need per-operation totals:
  `response.usage` includes all model turns, structured-result retries, and
  compaction summarization triggered inside that operation.
- For streaming integrations, wait for terminal `turn` events for per-turn
  usage and terminal `operation` events for operation roll-ups. Do not infer
  usage from `text_delta` or thinking deltas.
- Avoid double counting. `operation.usage` and `compaction.usage` are roll-ups;
  `turn.usage` is the model-turn leaf. OpenTelemetry explicitly warns not to
  sum roll-ups with nested turn spans.
- Custom providers should produce `pi-ai` `Usage` on assistant messages. If they
  do not, Flue may still return a required `response.usage`, but it will be the
  zero aggregate rather than measured provider usage.
- Register accurate model metadata for custom/proxied providers if Orchestrator
  wants meaningful cost and compaction behavior. Unknown providers/models default
  to zero cost/context metadata.
- Treat `cost` as advisory provider/model metadata, not a billing ledger.
  Cloudflare Workers AI binding reports token counts when the provider streams
  them but zero cost by design.
- HTTP stream consumers cannot see `turn_request`; in-process `observe()` or an
  exporter such as `@flue/opentelemetry` is required for request-side prompt
  forensics. Usage itself is available on terminal events served over streams.

## References

- `/Users/ramos/oss-agents/flue/packages/runtime/src/types.ts`
- `/Users/ramos/oss-agents/flue/packages/runtime/src/session.ts`
- `/Users/ramos/oss-agents/flue/packages/runtime/src/usage.ts`
- `/Users/ramos/oss-agents/flue/packages/runtime/src/compaction.ts`
- `/Users/ramos/oss-agents/flue/packages/runtime/src/runtime/providers.ts`
- `/Users/ramos/oss-agents/flue/packages/runtime/src/cloudflare/workers-ai-provider.ts`
- `/Users/ramos/oss-agents/flue/packages/runtime/src/runtime/run-store.ts`
- `/Users/ramos/oss-agents/flue/packages/runtime/src/runtime/handle-agent.ts`
- `/Users/ramos/oss-agents/flue/packages/runtime/src/runtime/agent-submissions.ts`
- `/Users/ramos/oss-agents/flue/packages/sdk/src/types.ts`
- `/Users/ramos/oss-agents/flue/packages/sdk/src/public/invoke.ts`
- `/Users/ramos/oss-agents/flue/packages/sdk/src/public/stream.ts`
- `/Users/ramos/oss-agents/flue/packages/react/src/types.ts`
- `/Users/ramos/oss-agents/flue/packages/react/src/agent-reducer.ts`
- `/Users/ramos/oss-agents/flue/packages/opentelemetry/src/index.ts`
- `/Users/ramos/oss-agents/flue/packages/opentelemetry/README.md`
- `/Users/ramos/oss-agents/flue/apps/docs/src/content/docs/api/events-reference.md`
- `/Users/ramos/oss-agents/flue/apps/docs/src/content/docs/api/agent-api.md`
- `/Users/ramos/oss-agents/flue/apps/docs/src/content/docs/sdk/agents.md`
