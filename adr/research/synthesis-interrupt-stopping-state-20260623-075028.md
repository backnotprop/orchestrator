# Interrupt Stopping State Synthesis

Date: 2026-06-23

Note: this synthesis was refined by ADR 0044. The accepted direction is
stop-request metadata with `stopping` as a derived display state, not a durable
task status.

## Summary

The current interruption model is serviceable, but it is not fully honest.
`cancelled` is written before the process has necessarily exited and before the
final result/event trail is guaranteed to exist.

The best long-term model is:

```text
running -> stopping -> cancelled
```

Use `stopping` internally as the durable status. Render it as `stopping` in
human output. Keep `cancelled` for the final stopped state.

## What This Resolves

This resolves the gap where a task appears fully stopped while shutdown work is
still happening.

It improves:

- `ps --watch`, because a user can see an agent is being stopped.
- `read --wait`, because it can wait until the task is actually done.
- parent-agent behavior, because tools can avoid treating stop-requested as
  final.
- future TUI behavior, because stopping can be shown as a clear transient state.
- token/final output reporting, because final adapter data is expected only
  after shutdown completes.

## What It Does Not Solve

It does not guarantee a process exits quickly.

It does not guarantee every runtime writes useful final output.

It does not remove the need for force-kill behavior later. A task could remain
`stopping` if a process ignores `SIGTERM` or if the supervisor crashes during
shutdown.

## Main Tradeoff

The tradeoff is contract churn.

Adding `stopping` means every status consumer must handle a new non-terminal
state:

- core task operations
- CLI read/log/events/watch/ps output
- compact JSON
- parent-agent tool summaries
- tests
- docs/help text

That is not hard, but it is real. This is more invasive than a one-second wait
patch.

## Recommended Direction

Do not add a blind post-interrupt wait as the main fix.

Add `stopping` as the real model when we are ready to change the status
contract. It should be a focused slice with tests around delayed process
shutdown.

If we want an immediate small UX patch before that, add `interrupt --wait` later
instead of always delaying `interrupt`. Default `interrupt` should stay fast,
and `--wait` should mean "return when the task is fully stopped."

## Decision Readiness

This is ready for a spec. It is not yet ready for implementation unless we are
comfortable changing the task status contract.
