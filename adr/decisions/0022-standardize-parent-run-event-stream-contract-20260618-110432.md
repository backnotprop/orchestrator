# 22. Standardize Parent Run Event Stream Contract

Date: 2026-06-18

## Status

Accepted

## Context

ADR 21 decided that Orchestrator should expose both human-friendly trace output
and machine-readable JSON streams. That was directionally right, but it did not
fully define the contract.

The current implementation already has useful pieces: parent tools emit
`tool.call`, `tool.progress`, `tool.result`, and `tool.error`; `--trace-tools`
renders live activity; `--stream-json` emits JSONL; and task events already have
sequence numbers and task ids.

The remaining risk is drift. If each renderer shapes its own data, the CLI,
future TUI, plugins, and tests will start depending on different facts. Research
against Pi, Claude-style agent output, Codex, and OpenCode confirmed the same
pattern: emit structured events first, then render human output from those
events.

## Decision

Orchestrator will standardize the parent run stream as the shared contract for
live observability.

Every `orchestrator run --stream-json` event will use a common envelope:

```ts
{
  schemaVersion: 1;
  seq: number;
  timestamp: string;
  runId: string;
  kind: string;
}
```

`seq` starts at `1` for each parent run and increments by one. `runId` is stable
for the parent run. Renderers must ignore unknown event kinds instead of
crashing.

The stream will include run lifecycle events:

- `run.started`
- `run.final`
- `run.error`

It will include parent tool events:

- `tool.call`
- `tool.progress`
- `tool.result`
- `tool.error`

It will also expose child task activity when the parent launches or waits on
agents:

- `task.started`
- `task.status`
- `task.usage`, when available
- `task.finished`

Default `orchestrator run` still prints only the final answer. `--trace-tools`
is a human renderer over the stream and writes to stderr. `--trace-tools=jsonl`
stays a debugging side channel for parent tool events. `--stream-json` is the
stable machine surface for scripts, plugins, and the future TUI.

After the envelope is stable, Orchestrator will add a small reducer that turns
run events into current state. That reducer will power prettier trace output,
watch-style CLI views, tests, and the future TUI.

## Consequences

Terminal text is not the API. Programs should consume `--stream-json`, not parse
pretty output.

The future TUI can be built on the same facts as the CLI instead of inventing a
separate job model.

Parent and child activity become linkable through stable ids such as `runId`,
`toolCallId`, and `taskId`.

Token and cost display remains optional. Runtime adapters should report usage
when they can, and renderers should show `unknown` when they cannot.

This adds some event-shape discipline before more UI polish. That is intentional:
the display should improve after the stream contract is dependable.

This does not require building the TUI now. It also does not replace task
`events.jsonl`; parent run streams and child task logs remain connected but
separate views of the system.
