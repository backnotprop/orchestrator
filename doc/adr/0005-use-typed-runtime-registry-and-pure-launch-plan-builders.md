# 5. Use typed runtime registry and pure launch plan builders

Date: 2026-06-17

## Status

Accepted

## Context

Orca has a useful organizational pattern for managing multiple agent CLIs: one
canonical config table, pure startup-plan builders, derived lists, and tests
that catch drift.

Our system is different because it launches headless workers, not interactive
terminal tabs. But the organization still applies.

## Decision

Use a typed agent runtime registry as the source of truth for launchable
headless agents.

Each runtime config should define:

- runtime id and display name;
- detection command, aliases, and expected process names;
- executable and base argv;
- prompt transport: argv, flag, stdin, prompt file, SDK, or HTTP;
- output transport: stdout text, stdout JSON, JSONL events, or transcript file;
- optional output modes;
- auth ownership;
- interrupt/cancellation strategy;
- resume and steering support;
- default timeout, output limit, and isolation policy.

Build pure launch-plan functions that turn runtime config plus request data into
an argv-based `AgentLaunchPlan`. The process supervisor executes the plan; it
does not hardcode per-runtime launch branches.

## Consequences

This creates one consistent way to add or inspect supported runtimes.

Derived views should come from the registry:

- enabled runtimes;
- runtimes by executable;
- runtimes by capability;
- model-visible `launch_agent.runtime` enum values;
- CLI/TUI picker rows.

Tests should iterate the registry and verify that every enabled runtime can
produce a launch plan for a smoke-test prompt.

We should store executable and argv arrays, not shell-quoted command strings.
Only the explicit `shell` runtime may accept shell strings, and it must stay
behind an allowlist.
