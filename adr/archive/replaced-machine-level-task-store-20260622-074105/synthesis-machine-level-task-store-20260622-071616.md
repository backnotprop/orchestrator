# Synthesis: Machine-Level Task Store

## Recommendation

Add an explicit machine-level task store, but do not remove repo-local stores.

The next architecture should keep both modes:

- repo-local mode: current behavior, defaulting to `<workspace>/.orchestrator`;
- global mode: one machine-level store, defaulting to `~/.orchestrator`.

The public CLI should expose this as `--global` first. Internally, model it as a
task-store scope.

This follows the existing config direction: the visible default is the dot path
at home, while XDG-style paths can be supported by the resolver for users who
prefer them.

## Core Shift

Keep `workspace` and `cwd`, but stop treating workspace as the main boundary for
all management.

The new model should be:

- `store`: the management scope;
- `workspace`: the project/repo context;
- `cwd`: the exact execution directory.

That lets one Orchestrator installation answer:

- what is running across my machine?
- what repo is each agent working in?
- what subdirectory is it running from?
- which parent run owns it?
- how do I stop one task, one group, one repo, or all active work?

## Why Not Replace Workspace Mode Immediately

Repo-local stores are still useful:

- tests and examples already assume them;
- a project can keep task state inside the repo;
- agents running inside one repo do not need global history;
- `--workspace` is already familiar as the config and project boundary.

So the safer migration is additive:

```sh
orchestrator ps
orchestrator ps --global
```

The first command keeps current behavior. The second reads the machine-level
store.

## What Needs To Be Stored

New task records should persist location metadata:

```ts
type TaskLocation =
  | {
      kind: "local";
      workspaceRoot: string;
      cwd: string;
      workspaceLabel?: string;
    }
  | {
      kind: "remote";
      remote: string;
      workspace?: string;
      cwd?: string;
      remoteTaskId?: string;
    };
```

`cwd` can remain on the task record for compatibility, but `location` becomes the
source of truth for views and filters.

## Command Shape

Global operations should be obvious:

```sh
orchestrator ps --global --watch
orchestrator ps --global --active --json --compact --brief
orchestrator launch codex --global --workspace /repo --cwd /repo/packages/api "Review API."
orchestrator read --global <task-id>
orchestrator interrupt --global --group <group-id>
```

For a machine-wide view, `--workspace` becomes a filter or launch location. It no
longer decides which store is being read.

## Batch Launch

Batch launch becomes more important in global mode. A manifest should be able to
launch tasks across several workspaces:

```json
{
  "schemaVersion": 1,
  "defaults": {
    "model": "gpt-5.4-mini"
  },
  "tasks": [
    {
      "runtime": "codex",
      "workspace": "/repo-a",
      "cwd": "/repo-a/packages/api",
      "name": "api review",
      "task": "Review the API package."
    },
    {
      "runtime": "claude-code",
      "workspace": "/repo-b",
      "cwd": "/repo-b",
      "name": "migration review",
      "task": "Review the migration plan."
    }
  ]
}
```

This is the clean way to start 20 or 300 agents without making callers loop
through many separate launches.

## Remote Agents

Remote agents should fit the same model later. The global store should keep a
local record that points at the remote task.

Do not build remote execution as part of the first machine-store slice. The first
slice should only make the task model ready for remote locations.

## Main Risk

The biggest risk is confusing command meaning.

Avoid making `--workspace` mean two different things in the same command. The
rule should be:

- without `--global`, `--workspace` selects the repo-local store;
- with `--global`, `--workspace` describes or filters task location.

That rule is simple enough for humans and agents.
