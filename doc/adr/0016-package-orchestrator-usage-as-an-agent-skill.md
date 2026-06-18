# 16. Package Orchestrator usage as an agent skill

Date: 2026-06-17

## Status

Accepted

## Context

Orchestrator will eventually have its own higher-level orchestrator agent. That
does not need to block other agents from using the Orchestrator pattern now.

The CLI is already the stable surface for launching and managing background
agent work. Any agent that can read a skill and run shell commands can learn to
use that CLI: check whether it is installed, install it when appropriate, read
`orchestrator help --json`, launch tasks, watch progress, read results, inspect
logs/events, and interrupt stale work.

This should stay small. The goal is not to package a full framework or a
prebaked orchestration recipe. The goal is to teach an agent the same practical
CLI workflow we would use ourselves.

## Decision

Package Orchestrator usage as a single portable agent skill:

```text
skills/orchestrator/SKILL.md
```

The skill teaches agents how to:

- verify or install the `orchestrator` CLI;
- use `orchestrator help --json` as the current machine-readable contract;
- launch named background tasks;
- keep and reuse `taskId`;
- inspect work with `list`, `watch`, `read`, `logs`, and `events`;
- stop stale work with `interrupt`;
- discover available runtimes instead of assuming Claude Code, Codex, or any
  custom runtime is enabled.

Also ship minimal plugin metadata:

```text
.codex-plugin/plugin.json
.agents/plugins/marketplace.json
.claude-plugin/plugin.json
.claude-plugin/marketplace.json
```

The plugin manifests point at `./skills/` and make the skill packageable for
Codex and Claude Code without adding references, scripts, assets, hooks, apps,
or MCP servers.

## Consequences

Any compatible agent can learn to use Orchestrator as a CLI-first background
agent controller before the dedicated Orchestrator agent exists.

The skill keeps the interface honest: agents should read the live CLI contract
instead of relying on stale hard-coded assumptions.

The package surface remains easy to review. There is one skill file plus small
plugin metadata for Codex and Claude Code. More packaging targets can be added
later only when they are actually needed.

The skill must stay aligned with CLI behavior. When command names, output
shapes, or install instructions change, update the skill in the same change.
