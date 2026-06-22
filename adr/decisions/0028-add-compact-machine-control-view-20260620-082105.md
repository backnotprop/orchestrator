# 28. Add Compact Machine Control View

Date: 2026-06-20

## Status

Accepted

## Context

`orchestrator ps` is now the main operations view for multi-agent work. It shows
grouped parent/child tasks, status, runtime, model, duration, token usage when
available, and last activity.

`ps --json` currently returns the full grouped view that powers the human table
and future TUI. That full object is useful, but it is too large for quick
machine control. Agents and scripts often need a smaller answer: what is active,
what group is it in, and what ID should be passed to `interrupt`?

The job-control backlog identified this as the next control-path gap after short
task IDs and safer group interruption.

## Decision

Orchestrator will add a compact JSON control view as a projection of the
existing `AgentTaskPsView`.

The CLI will support:

```sh
orchestrator ps --json --compact
orchestrator ps --json --compact --active
orchestrator ps --json --compact --parent <group-id|prefix>
orchestrator ps --watch --json --compact
```

`--compact` will require `--json`. Full `ps --json` will remain unchanged for
UI and TUI consumers.

The compact view will include:

- a schema version;
- generated timestamp;
- summary counts;
- compact groups;
- compact tasks;
- short and full IDs;
- stop targets for active tasks and interruptible groups.

Core will own the projection through a pure function, for example:

```ts
compactAgentTaskPsView(view, { activeOnly });
```

The projection must reuse the existing `AgentTaskPsView`. It must not read task
files again, create a second task model, or change interruption behavior.

## Consequences

Agents and scripts get a small control surface for the common loop:

1. run `orchestrator ps --json --compact --active`;
2. inspect active tasks and groups;
3. pick a `stop` target;
4. call `orchestrator interrupt ...`.

Humans keep the existing `ps` table. The future TUI keeps the full `ps --json`
view. The compact view remains an action-oriented projection over the same task
state.

This does not add a TUI, replace `ps --json`, add a persistent group table, or
change how tasks are interrupted.
