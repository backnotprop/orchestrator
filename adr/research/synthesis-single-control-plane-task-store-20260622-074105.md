# Synthesis: Single Control-Plane Task Store

## Recommendation

Use one machine-level task store as the default Orchestrator control plane.

Do not make users choose between repo-local mode and global mode for normal use.
The normal model should be:

```text
one task store
many workspaces
many cwd values
many agents
```

The CLI should feel closer to Kubernetes:

```sh
orchestrator ps        # current workspace
orchestrator ps -A     # all workspaces
orchestrator logs <id>
orchestrator interrupt <id>
```

## What Changes From The Previous Spec

The archived spec said:

```sh
orchestrator ps
orchestrator ps --global
```

That creates two product modes.

The revised model is:

```sh
orchestrator ps
orchestrator ps -A
```

Both read the same default machine-level task store. The only difference is the
view filter.

## Default Store

The default task store should live under:

```text
~/.orchestrator/tasks
```

That matches the existing user-facing preference for the home dot path.

The resolver can support XDG state paths later, but the normal docs and examples
should stay simple.

## Workspace Scope

`workspace` becomes a task attribute and view filter.

Default command behavior:

- `launch` writes to the machine store and records the resolved workspace;
- `ps` filters to the current workspace;
- `ps -A` shows all workspaces;
- `read`, `logs`, `events`, `watch`, and `interrupt` operate by task id in the
  machine store;
- `--workspace <path>` filters or sets workspace metadata, not the store path.

This gives humans and agents the same control flow everywhere.

## Current Workspace Resolution

Use this resolution order:

1. explicit `--workspace`;
2. nearest Git root from the current directory, if available;
3. current directory.

That makes the common repo case work without extra flags while still allowing
monorepo packages or nested repos to opt into a different workspace.

## Cwd

`cwd` remains the execution directory.

Rules:

- if `--cwd` is omitted, use the resolved workspace;
- if `--cwd` is relative, resolve it against the workspace;
- store absolute `cwd` on the task record;
- show compact relative cwd in human views when it is inside the workspace.

## Command Names

Do not overload the existing `--all`.

Current `--all` means all task history. Keep it.

Add:

```sh
-A
--all-workspaces
```

for all workspaces.

Examples:

```sh
orchestrator ps              # current workspace, recent/default window
orchestrator ps --all        # current workspace, all history
orchestrator ps -A           # all workspaces, recent/default window
orchestrator ps -A --all     # all workspaces, all history
```

## Advanced Store Override

Keep `--orchestrator-dir`, but treat it as an advanced store override.

It should be used for:

- tests;
- isolated experiments;
- users who intentionally want a separate store.

It should not be presented as a normal repo-local workflow.

## Batch Launch

Batch launch becomes stronger under the single-store model.

A manifest can launch across many workspaces without needing multiple stores:

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "runtime": "codex",
      "workspace": "/repo-a",
      "cwd": "packages/api",
      "name": "api review",
      "task": "Review the API package."
    },
    {
      "runtime": "claude-code",
      "workspace": "/repo-b",
      "name": "migration review",
      "task": "Review migrations."
    }
  ]
}
```

## Main Result

The product becomes easier to explain:

Orchestrator is one control plane for agents. Workspaces scope what you see.
`-A` shows the whole machine.
