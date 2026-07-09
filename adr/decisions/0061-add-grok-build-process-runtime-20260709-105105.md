# 0061. Add Grok Build as a Process Runtime

Date: 2026-07-09

## Status

Accepted

## Context

Orchestrator already manages first-class headless process runtimes such as
Claude Code, Codex process mode, and GitHub Copilot CLI. Grok Build has a
compatible headless prompt mode through `grok -p`, model selection through
`-m`, structured output through `--output-format json` and
`--output-format streaming-json`, and provider resume through
`--resume <session-id>`.

Local probing confirmed that Grok streaming JSON emits chunked `thought` and
`text` events followed by an `end` event with `sessionId` and `requestId`.
That gives Orchestrator enough structure to store normalized task events, a
final answer, and provider metadata for resume. It also means Grok needs a
runtime-specific normalizer and result accumulator; partial `text` chunks must
not be treated as a completed task result.

Grok also exposes ACP through `grok agent stdio`, but that is a different
protocol surface. Starting with ACP would add session lifecycle, JSON-RPC,
authentication, update collection, and cancellation questions before basic
Grok orchestration is proven.

## Decision

Add `grok` as a first-class Orchestrator process runtime.

The runtime will use Grok Build's headless prompt mode:

```sh
grok --no-auto-update --output-format streaming-json -p "<task>"
```

The runtime will support launch, background management, model selection,
streaming JSON event capture, normalized final output, stored Grok `sessionId`,
and `orchestrator resume` through that stored session id.

Use streaming JSON as the default output mode. Add Grok-specific output
normalization that maps `text` chunks to message deltas, `thought` chunks to
reasoning deltas, and `end` to the final result event. Accumulate `text` chunks
internally and set the task result only when `end` arrives. Treat a stream with
chunks but no `end` as a failed task.

Keep `json` and `text` output modes available for diagnostics. The reliable
provider metadata path is the default streaming JSON mode unless the JSON
adapter is later extended to store Grok provider metadata too.

Do not implement Grok ACP in this decision. If we later want persistent Grok
sessions, live steering, or protocol-level control, add that as a separate
runtime or decision after process mode is useful.

Do not include `--always-approve`, `--no-subagents`, or `--disable-web-search`
in the built-in default. Those flags change provider behavior and should be a
separate product decision if Grok background tasks prove they need them.

## Consequences

Users and agents will be able to run Grok through the same Orchestrator
surfaces they already use for Claude Code, Codex, and Copilot:

```sh
orchestrator launch grok --name "review api" --model grok-code-fast-1 \
  "Review the API package."
orchestrator resume <task-id> "Continue from the prior result."
```

Implementation must add the built-in runtime id/config, Grok streaming JSON
normalization, Grok result accumulation, Grok provider metadata extraction,
Grok resume planning, tests, docs, help text, Orchestrator skill guidance, and
an opt-in live smoke test.

Grok token usage should not be promised until the CLI emits stable usage data.
If no usage appears in Grok events, Orchestrator should show usage as unknown
instead of estimating billing data.

The built-in `grok` runtime stays launch-shaped and small. ACP, persistent
sessions, running messages, Grok goals, provider limits, provider-specific args,
and stricter or more autonomous permission profiles remain future work.
