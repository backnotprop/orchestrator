# 30. Use single control-plane task store

Date: 2026-06-22

## Status

Accepted

## Context

Orchestrator is moving from a repo-local job runner toward one tool that can
manage many agents across many repositories, subdirectories, and eventually
remote locations.

The current code uses `workspaceRoot` for too many things: it picks the default
task store, acts as the default process `cwd`, scopes task commands, and appears
in returned command args. That made sense early, but it creates the wrong model
for machine-wide agent management.

We first considered a two-mode design: repo-local by default, with an explicit
global mode. That was archived because it forced users and agents to think in
two product models. Kubernetes gives a cleaner reference point: one control
plane, scoped default views, and an all-scope view when requested.

## Decision

Use one machine-level task store as the default Orchestrator control plane:

```text
~/.orchestrator/tasks
```

Workspaces are task metadata and view filters, not the default storage boundary.
`cwd` is the exact directory where the agent process runs.

Default command behavior:

- `launch` writes to the machine store and records the resolved workspace and
  `cwd`;
- `ps` shows the current workspace;
- `ps -A` / `ps --all-workspaces` shows all workspaces;
- `ps --all` keeps its current meaning: all task history;
- `ps -A --all` means all workspaces and all task history;
- `read`, `logs`, `events`, `watch`, and `interrupt` resolve task IDs from the
  default machine store;
- `--workspace <path>` sets or filters workspace metadata;
- `--cwd <path>` sets or filters execution directory;
- `--orchestrator-dir <path>` remains as an advanced override for tests,
  isolated stores, and explicit custom setups.

New task records should persist location metadata, including workspace and cwd.
Compact JSON should include that location and should stop repeating
`--workspace` for ID-based follow-up commands when the default machine store is
used.

Batch launch and parent-agent tools should accept per-task `workspace` and
`cwd`, so one orchestrator session can launch agents across multiple projects
while still managing them from the same store.

## Consequences

This is a medium-large boundary refactor, not a rewrite. Runtime adapters,
launch plans, process supervision, logs, events, token usage, and interruption
remain useful. The main change is separating store location from workspace and
process cwd.

The implementation should be staged:

1. add task location metadata while preserving current behavior;
2. add a machine-store resolver and keep `--orchestrator-dir`;
3. switch new launches to the machine store by default;
4. make `ps` filter by current workspace and add `-A`;
5. update compact JSON and returned command args;
6. extend batch launch and parent-agent tools with workspace/cwd;
7. update docs, examples, and tests.

Broad interruption becomes more dangerous because the default store is
machine-wide. Workspace-scoped cleanup should remain easy, but all-workspace
active interruption should require an explicit confirmation flag such as
`--yes`.

Old repo-local stores should remain inspectable through `--orchestrator-dir`,
but repo-local storage is no longer the first-class product model.
