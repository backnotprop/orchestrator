# 13. Keep CLI job ergonomics lean with launch names, name-first lists, and follow logs

Date: 2026-06-17

## Status

Accepted

## Context

The CLI can already launch, list, watch, read, inspect logs/events, and
interrupt background Claude Code and Codex tasks.

That makes it useful, but the next slice should improve day-to-day use without
turning into a large operations console. The immediate pain points are:

- task IDs are UUID-first, which makes `list` hard to scan;
- task prompts are often too long to be good display labels;
- raw logs can be read after the fact, but not followed live;
- parent/child task grouping matters later, but only once the parent
  orchestrator is launching workers itself.

We should not add clever behavior just because it sounds polished. In
particular, automatic prompt summarization is likely to make bad labels, expose
prompt details in list views, and create unclear behavior when prompts are long
or similar.

## Decision

Implement the next CLI ergonomics slice as three focused changes:

1. Add optional launch names.

   ```sh
   orchestrator launch claude-code --name "review tests" --model sonnet "Review this repo..."
   ```

   Names are plain task metadata. They do not select prompts, templates, agent
   behavior, runtime behavior, or hidden recipes.

2. Make `list` name-first.

   The normal human list view should show the useful label first and the UUID
   later. If a task has no name, fall back to a short prompt summary.

   Example target shape:

   ```text
   review tests    running    claude-code    sonnet         2m ago    3f8d1f30
   cleanup store   succeeded  codex          gpt-5.4-mini   8m ago    a6d00f1d
   ```

   JSON output should keep the full task record and include the optional name.

3. Add `logs --follow`.

   ```sh
   orchestrator logs <task-id> --follow
   orchestrator logs <task-id> --stream stderr --follow
   ```

   This is the `tail -f` / `kubectl logs -f` style path for raw live output.
   Keep `watch` as the readable job-progress view and `logs --follow` as the
   raw live-output view.

Do not implement a `rename` command in this slice.

Do not implement smart auto-naming in this slice. A short prompt summary is only
a fallback display value when no explicit name exists.

Do not implement parent/child grouping in this slice. The data model may leave
room for a future parent task id, but the UX and behavior should wait until the
parent orchestrator starts launching workers.

## Consequences

This makes the CLI more useful without broadening the product surface too much.

Users and parent agents can give tasks stable labels at launch time. The list
view becomes scannable without needing to copy UUIDs as the primary identifier.
Operators can follow raw worker output when debugging without confusing that
with the higher-level `watch` command.

The cost is that names can be wrong or stale. We accept that for now rather than
adding a rename command immediately. If names become painful to correct in real
use, `rename` can be added later as a small follow-up.

This decision keeps parent/child grouping separate. Grouping is important for
the eventual parent AI orchestrator, but it should not block the simpler CLI
improvements.

References:

- [Treat subagents as durable asynchronous task sessions](0006-treat-subagents-as-durable-asynchronous-task-sessions.md)
- [Scope first release to Claude Code and Codex runtimes](0012-scope-first-release-to-claude-code-and-codex-runtimes.md)
- [Keep core frontend-independent with CLI/TUI later](0009-keep-core-frontend-independent-with-cli-tui-later.md)
