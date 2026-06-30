# Synthesis: Codex App-Server Slice 7 Product Polish And Live Smoke

Date: 2026-06-24

## Summary

Slice 7 is the final integration pass for the Codex app-server runtime. The core
runtime work is already done. The remaining work is proving that the new runtime
behaves like a normal Orchestrator task from the user's point of view.

## What Is Already Done

- The runtime exists as `codex-app-server`.
- It uses the protocol executor path, not the process output adapter path.
- It stores Codex provider metadata.
- It writes normalized task events.
- It writes raw protocol transcript separately.
- It persists usage from `thread/tokenUsage/updated`.
- It marks final usage on turn completion.
- It supports native interrupt through `turn/interrupt`.
- It falls back to process kill only when protocol control does not settle.
- The fake-server suite covers the hard protocol and control paths.

## What Needs Product Proof

`ps` already has the token display machinery. The missing proof is specific:
when `codex-app-server` emits usage, the operations view should show it like any
other runtime.

`events` already has normalized events. The missing proof is that the command
surface is readable and does not force users into raw JSON-RPC protocol names.

`logs` already keeps protocol traffic out of stdout/stderr. The missing proof is
that normal app-server logs stay diagnostic, not transcript-like.

Docs currently explain Codex generally, but not the difference between `codex`
and `codex-app-server`.

Live smoke does not exist yet. It should be opt-in and minimal.

## Recommended Slice Shape

Keep the slice small:

1. Test live token visibility using a fake server that emits usage and remains
   running long enough for `ps --watch`.
2. Test normalized events and readable logs using the existing fake server.
3. Add docs for the two Codex runtimes and known limitations.
4. Add one skipped-by-default live smoke for a short final-answer run.
5. Record any protocol bottlenecks found.

Do not add protocol pooling, goals, steering, remote app-server transport, public
protocol custom-agent config, or a broader TUI in this slice.

## Decision Pressure

The important product question is not "can the protocol executor run?" It can.
The question is whether users and agents can operate it through the same
Orchestrator commands they already use: `launch`, `ps`, `read`, `events`, `logs`,
and `interrupt`.

Slice 7 should make that answer visibly yes.
