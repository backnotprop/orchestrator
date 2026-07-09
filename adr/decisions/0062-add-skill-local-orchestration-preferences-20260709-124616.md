# 0062. Add Skill-Local Orchestration Preferences

Date: 2026-07-09

## Status

Accepted

## Context

Orchestrator is most useful as a skill used by another agent. The CLI knows
which runtimes exist and how to supervise tasks, but it should not guess which
provider or model a user prefers for UI work, exploration, deep execution, or
fallbacks after usage is exhausted.

Putting those choices into core config would turn a simple task controller into
a routing engine before the routing policy is understood. Keeping them only in
conversation forces users to repeat stable preferences.

[ADR 16](0016-package-orchestrator-usage-as-an-agent-skill.md) intentionally
started with one skill file. This decision adds one functional policy file
without turning the skill into a larger framework.

## Decision

Ship `skills/orchestrator/PREFERENCES.md` beside `SKILL.md`.

The file is optional in behavior, empty by default, and written in plain
language. The Orchestrator skill reads it when invoked and uses it as routing
guidance for runtime choice, model choice, fan-out, fallback order, and
provider-limit behavior.

The current user request outranks saved preferences. Live CLI facts from
`doctor` and `limits` inform whether a preference or fallback can be used.
Unavailable limit data remains unknown.

Preferences guide the calling agent. They do not change Orchestrator core
config, automatically launch work, or add a model router to the CLI.

## Consequences

Users get persistent orchestration policy without needing a schema or a new
runtime subsystem. The same preference file contract works across compatible
agent environments.

Agents still use explicit runtime and model values at the CLI boundary.
Structured preference parsing, a preferences editor, project-specific
overrides, and autonomous cost optimization remain future decisions if real
usage requires them.
