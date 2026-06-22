# Research Spike: Machine-Level Task Store

## Question

Can Orchestrator manage agents across the whole machine instead of treating the
current workspace as the main management boundary?

The target shape is one Orchestrator installation that can manage agents across
many repositories, subdirectories, and eventually remote agent locations.

## Current Shape

The task store is workspace-scoped by default.

`packages/core/src/tasks/store.ts` defines the task root as:

```ts
join(options.orchestratorDir ?? join(options.workspaceRoot, ".orchestrator"), "tasks");
```

That means `workspaceRoot` currently does several jobs:

- picks the default task store location;
- acts as the default launch `cwd` when no `--cwd` is provided;
- tells runtime config loading where to look;
- appears in returned command args so another process can find the same store.

`AgentTaskRecord` stores `cwd`, but it does not store the original
`workspaceRoot` as first-class task metadata.

`TaskStoreOptions` is currently:

```ts
export type TaskStoreOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
};
```

Every task command uses that selected store:

- `list`
- `ps`
- `read`
- `logs`
- `events`
- `watch`
- `interrupt`

So the command is always asking: "what tasks are in this one store?"

## Current Monorepo Path

For a monorepo, the current design can work:

```sh
orchestrator launch codex \
  --workspace /repo \
  --cwd /repo/packages/api \
  --name "api review" \
  "Review the API package."
```

That keeps all tasks under `/repo/.orchestrator/tasks`, while each task can run
from a different package directory.

This solves "one repo, many packages." It does not solve "one machine, many
repos."

## Existing Escape Hatch

A caller can already pass a shared explicit store:

```sh
orchestrator launch codex \
  --workspace /repo-a \
  --orchestrator-dir ~/.orchestrator \
  "Review repo A."

orchestrator launch codex \
  --workspace /repo-b \
  --orchestrator-dir ~/.orchestrator \
  "Review repo B."
```

Because `orchestratorDir` overrides the workspace store path, both tasks land in
the same physical store.

That proves the storage layer can support a machine-level store without a new
database. But it is not a complete design:

- task records do not preserve `workspaceRoot` as metadata;
- `ps` has no repo/workspace column;
- `--workspace` still looks like the management boundary;
- returned command args get noisy;
- filtering by workspace, repo, cwd, or remote location is not first-class;
- remote task locations have no data model yet.

## Parent Agent Tools

The parent-agent tool context also carries a single `workspaceRoot` and optional
`orchestratorDir`.

`launch_agent` resolves child `cwd` from:

```ts
params.cwd ?? context.cwd ?? context.workspaceRoot;
```

Then it launches into the same task store selected by that context.

That is good for a parent agent operating inside one repo. A machine-level parent
needs the same tools to accept a target workspace/cwd per child task and still
write all tasks into one machine-level store.

## Compact Command Output

Compact JSON already returns follow-up command args. Those args include
`--workspace` and sometimes `--orchestrator-dir` so a caller can safely run the
next command from any directory.

That was the right design for workspace-scoped stores.

For a machine-level store, returned command args should carry store scope instead
of pretending one workspace is the whole boundary.

## Performance Notes

The current `ps` path scans task directories, reads `task.json`, and reads a
bounded slice of events for each visible task.

That is fine for normal repo-local use. For hundreds of active tasks across a
machine, the global view needs guardrails:

- default to active and recent tasks, not full history;
- keep `--all` explicit;
- allow filters before rendering: runtime, status, workspace, cwd, parent/group;
- avoid reading large logs/transcripts in `ps`;
- eventually persist a small task summary so watch views do less event parsing.

The first slice can still scan the global task directory. A separate index is not
required until the task count or history size proves it is needed.

## Findings

The current code is close, but the vocabulary is wrong for the next scale.

We need three separate concepts:

- **store**: where task records live;
- **workspace**: the repo/project context for config and grouping;
- **cwd**: the directory where the agent process runs.

Today, workspace is carrying all three meanings. That is the part to fix.
