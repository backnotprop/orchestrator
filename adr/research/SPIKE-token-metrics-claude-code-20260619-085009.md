# Token Metrics Research: Claude Code

Date: 2026-06-19

## Summary

Claude Code is useful inspiration for how token counts should feel in a
multi-agent operations view: users can see a running agent and a token number
that updates as the agent works. The exact internal implementation is not part
of this decision record. For Orchestrator, the important product behavior is
the visible contract:

- usage can appear before a task is fully done when the provider/runtime emits
  streaming usage data;
- final usage should be persisted with the task result;
- task/subagent usage should be separate from account quota, billing, or cost;
- the UI should show one simple token number, not expose provider accounting
  details.

## Usage Shape

Claude-oriented runtimes usually expose Anthropic-shaped usage fields:
`input_tokens`, `output_tokens`, cache creation tokens, cache read tokens, and
related metadata. Those fields do not map perfectly to every runtime, so
Orchestrator should normalize only the common fields it needs for display:

- input tokens
- output tokens
- cache read tokens
- cache write tokens
- total tokens
- whether the value is an estimate
- whether the value is final

Cost, account usage, subscription limits, and provider quota are separate
concepts. They should not be mixed into the task token number shown in `ps`.

## Availability

Token data can arrive at different times:

- some runtimes emit partial usage while a response is streaming;
- some runtimes emit only final usage at task completion;
- some custom runtimes may never emit token data;
- some values may be estimated from context rather than reported by a provider.

Orchestrator should accept all of these without adding noisy labels in the
normal human view. The number should simply update when better information is
available. Machine-readable JSON can carry metadata like `estimated` and
`final` for agents that need to reason about confidence.

## Implications For Orchestrator

The runtime adapter boundary is the right place to understand provider-specific
usage events. The task store should persist normalized usage snapshots and the
raw runtime output separately.

For built-in adapters:

- Claude Code can provide live usage when its stream output includes usage
  events.
- Codex may only provide usage at turn or task completion, depending on what
  its headless output emits.
- Custom agents can provide usage by emitting supported JSONL usage/result
  events.

For display:

- `ps` should show a compact `tok` value such as `24k`.
- `ps --watch` should keep refreshing that value while the task runs.
- JSON output should include the normalized usage object when available.
- Missing usage should render as `-`, not as an error.

## Recommendation

Normalize usage at runtime adapter boundaries, persist the latest task usage,
and let views render the same field for built-in and custom agents. Do not
build a universal tokenizer or cost engine for this phase. The goal is live
operational visibility, not billing accuracy.
