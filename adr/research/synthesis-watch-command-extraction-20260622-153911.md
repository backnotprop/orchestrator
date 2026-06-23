# Synthesis: Watch Command Extraction

Date: 2026-06-22

## Summary

`watch` is the next right extraction after `read`, `logs`, and `events`.

It is related to task inspection, but it is more live-stream oriented than snapshot oriented. It should not be folded into `task-inspection.ts`; that file now owns final reads, log snapshots, event snapshots, and log follow. `watch` should get its own command module.

## Why Extract It Now

`packages/cli/src/cli.ts` still owns runtime command behavior after the recent extractions. `watch` is one of the remaining clean chunks:

- it has one command entry point
- it has one option type
- it has a small set of rendering helpers
- tests already cover its behavior
- ADR 0032 already created shared helpers that make the move easier

Moving it now continues the same cleanup direction without forcing a broader CLI rewrite.

## Boundary

The right boundary is:

```text
packages/cli/src/commands/watch.ts
```

That module should own the behavior of watching one task until exit.

`cli.ts` should continue to own parsing. This keeps the extraction narrow and consistent with the recent `read/logs/events` extraction.

## What Not To Do

Do not extract `ps --watch` in this slice. That is a different command path and uses the grouped operations view.

Do not change the watch output format. The command is already covered by CLI contract and watch/log tests.

Do not introduce a new renderer abstraction yet. The existing watch renderer is small. A larger rendering abstraction should wait until `ps`, `watch`, and eventual TUI needs are clearer.

## Expected Result

After the extraction:

- `cli.ts` loses another coherent command body
- `watch` behavior stays unchanged
- event parsing remains shared through `task-events.ts`
- appended file reading remains shared through `task-output.ts`
- future extraction of `interrupt` or `ps` remains independent

This is a small refactor with clear tests.
