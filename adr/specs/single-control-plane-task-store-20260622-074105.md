# Spec: Single Control-Plane Task Store

## Intent

Make Orchestrator feel like one control plane for agents.

The default store is machine-level. Workspaces are metadata and filters. `cwd`
is where the agent process runs.

This replaces the earlier two-mode idea where repo-local and global stores were
treated as equal product paths.

## Core Model

Use one default task store:

```text
~/.orchestrator/tasks
```

Each task records where it belongs:

```ts
type TaskLocation = {
  kind: "local" | "remote";
  workspaceRoot?: string;
  workspaceName?: string;
  cwd?: string;
  remote?: string;
  remoteTaskId?: string;
};
```

For local process agents, `workspaceRoot` and `cwd` are required.

Keep top-level `cwd` on `AgentTaskRecord` for compatibility, but views and
filters should prefer `task.location`.

## Kubernetes-Like Command Model

Default view: current workspace.

```sh
orchestrator ps
```

All workspaces:

```sh
orchestrator ps -A
orchestrator ps --all-workspaces
```

Current workspace with all history:

```sh
orchestrator ps --all
```

All workspaces with all history:

```sh
orchestrator ps -A --all
```

Do not reuse `--all` for all workspaces. It already means all task history.

## Store Resolution

Replace the current default task root:

```ts
join(options.orchestratorDir ?? join(options.workspaceRoot, ".orchestrator"), "tasks");
```

with:

```ts
join(options.orchestratorDir ?? defaultMachineOrchestratorDir(), "tasks");
```

where:

```text
defaultMachineOrchestratorDir() = ~/.orchestrator
```

`--orchestrator-dir` stays as an advanced override for tests or isolated stores.

## Workspace Resolution

Resolve workspace in this order:

1. explicit `--workspace <path>`;
2. nearest Git root from the current directory, if available;
3. current directory.

Store the resolved absolute workspace path on each new task.

If this Git-root behavior feels too implicit during implementation, start with
explicit `--workspace` plus current directory fallback, but keep the resolver as
the boundary so Git-root detection can be added without touching task logic.

## Cwd Resolution

For launch and run:

- if `--cwd` is omitted, use the resolved workspace;
- if `--cwd` is relative, resolve it against the workspace;
- if `--cwd` is absolute, use it as-is;
- persist absolute `cwd`.

Examples:

```sh
orchestrator launch codex --name "repo review" "Review this repo."
```

records:

```text
workspace = nearest repo root or cwd
cwd       = workspace
```

```sh
orchestrator launch codex \
  --workspace /repo \
  --cwd packages/api \
  --name "api review" \
  "Review the API package."
```

records:

```text
workspace = /repo
cwd       = /repo/packages/api
```

## CLI Changes

Add common task-view options:

```sh
-A
--all-workspaces
--workspace <path>
--cwd <path>
```

Meaning:

- `-A` / `--all-workspaces`: do not filter by workspace;
- `--workspace`: filter by workspace for views, or set workspace on launch;
- `--cwd`: filter by cwd for views, or set process cwd on launch;
- `--all`: keep current meaning, all task history.

Commands affected:

- `launch`
- `run --background`
- `list`
- `ps`
- `read`
- `logs`
- `events`
- `watch`
- `interrupt`

For ID-based commands, workspace filtering should not be required:

```sh
orchestrator read <id>
orchestrator logs <id>
orchestrator interrupt <id>
```

Those should resolve against the one default task store.

If a short ID is ambiguous across the machine store, return a structured error
with matching task ids, workspaces, and suggested full ids.

## Human `ps`

For current workspace, keep the output compact.

For all workspaces, show workspace and relative cwd:

```text
updated 22:11:04  18 running  93 done  4 failed  221k tok

workspace  agent        work             status   cwd              dur   tok   last       id
api        codex        server review    running  packages/server  2m    18k   reading    a6d00f1d
web        claude-code  site review      done     apps/site        47s   31k   completed  b7e14a2c
mail       custom       inbox cleanup    running  remote:mailbox   6m    -     running    c93ab8e1
```

`workspace` should render as a short label when possible:

- configured workspace name;
- directory basename;
- compact path when basenames collide.

## Compact JSON

Add location to compact task rows:

```json
{
  "id": "a6d00f1d",
  "taskId": "a6d00f1d-...",
  "runtime": "codex",
  "name": "server review",
  "status": "running",
  "location": {
    "kind": "local",
    "workspaceRoot": "/repo",
    "workspaceName": "api",
    "cwd": "/repo/packages/server"
  }
}
```

Top-level compact view should include view scope:

```json
{
  "schemaVersion": 1,
  "scope": {
    "workspaces": "current",
    "workspaceRoot": "/repo"
  }
}
```

For all workspaces:

```json
{
  "schemaVersion": 1,
  "scope": {
    "workspaces": "all"
  }
}
```

## Returned Commands

Default returned commands should no longer need `--workspace` for ID-based task
commands because the default store is the same across the machine:

```json
{
  "commands": {
    "read": {
      "args": ["read", "a6d00f1d", "--json", "--compact"]
    }
  }
}
```

View commands should preserve view scope:

```json
{
  "views": {
    "active": {
      "args": ["ps", "-A", "--json", "--compact", "--active", "--brief"]
    }
  }
}
```

If `--orchestrator-dir` is used, returned commands must include it because the
caller is not using the default machine store.

## Batch Launch

Extend batch manifests with per-task `workspace`, `cwd`, and `labels`.

Relative `cwd` resolves against that task's workspace:

```json
{
  "schemaVersion": 1,
  "defaults": {
    "runtime": "codex",
    "model": "gpt-5.4-mini"
  },
  "tasks": [
    {
      "workspace": "/repo-a",
      "cwd": "packages/api",
      "name": "api review",
      "task": "Review API package."
    },
    {
      "workspace": "/repo-b",
      "name": "docs review",
      "task": "Review docs."
    }
  ]
}
```

Batch launch should return one compact control view with all created tasks.

## Parent Agent Tools

Parent tools should keep the same simple set:

- `launch_agent`
- `list_agents`
- `read_agent`
- `read_agent_events`
- `read_agent_logs`
- `interrupt_agent`

Add optional launch fields:

```ts
{
  workspace?: string;
  cwd?: string;
  labels?: Record<string, string>;
}
```

The parent can then launch children across repos while all children remain
visible in the same task store.

## Interrupt Safety

Because the default store is machine-wide, broad interruption needs guardrails.

Allow:

```sh
orchestrator interrupt <id>
orchestrator interrupt --group <group-id>
orchestrator interrupt --parent <parent-id> --children
orchestrator interrupt --active --workspace /repo
```

For all-workspace active interruption, require `--yes`:

```sh
orchestrator interrupt -A --active --yes
```

Without `--yes`, return an error that explains the safer alternatives.

## Migration

Implementation should support old repo-local task records during the transition.

Plan:

1. Add location metadata to new task records.
2. Add machine-store resolver, but keep `--orchestrator-dir`.
3. Make new launches write to the machine store by default.
4. Make `ps` filter by current workspace metadata.
5. Add `ps -A` / `--all-workspaces`.
6. Update compact JSON and returned commands.
7. Extend batch launch and parent-agent tools with workspace/cwd.
8. Update docs and examples.

Old repo-local stores can still be inspected with:

```sh
orchestrator ps --orchestrator-dir /repo/.orchestrator
```

## Tests

Add tests for:

- default launch writes under machine store;
- task records include `location.workspaceRoot` and `location.cwd`;
- `ps` shows current workspace only;
- `ps -A` shows multiple workspaces;
- `ps --all` still means all history;
- `ps -A --all` means all workspaces and all history;
- short IDs resolve in the machine store;
- ambiguous short IDs return workspace-aware recovery;
- compact JSON includes location and scope;
- returned task commands omit `--workspace` for default store;
- returned commands include `--orchestrator-dir` for custom stores;
- batch launch supports per-task workspace/cwd;
- parent `launch_agent` can set workspace/cwd.

## Non-Goals

- Do not implement remote HTTP agents in this slice.
- Do not add a database yet.
- Do not remove `--orchestrator-dir`.
- Do not make repo-local storage a first-class product mode.
