# 8. Do not require structured worker output in V1

Date: 2026-06-17

## Status

Accepted

## Context

Subagents are coding agents, not narrow structured-output functions. Requiring
every worker to emit JSON/XML/special schemas would make the system brittle and
would not match how Claude Code's subagent/task UX works.

The orchestrator still needs structured metadata around each worker result.

## Decision

Do not require structured worker output in V1.

Worker final answers can be plain text or Markdown. The orchestrator owns the
structured envelope:

- task id;
- runtime;
- status;
- output path;
- transcript path;
- events path;
- worktree path when applicable;
- token/cost metadata when available.

Runtime output modes, such as Claude Code JSON or stream JSON, are adapter
transport details only. They do not become a public worker-output contract.

## Consequences

This keeps subagents natural and easy to swap. It also avoids overfitting V1 to
a schema before we know what the useful summaries look like.

If the parent wants a specific shape, it should say so in the worker's custom
task instructions for that launch. This is prompt guidance only, not a parser
contract.

The runtime still needs bounded output handling and result extraction. Some
adapters may use structured CLI modes internally for usage or event parsing,
but the parent agent should think in task ids, paths, statuses, and final
worker text.
